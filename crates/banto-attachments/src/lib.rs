//! Banto attachments (spec `docs/attachments-plan.md` §3): a resource-agnostic
//! file/image attachment service - metadata CRUD, on-disk storage, and image
//! thumbnail generation. Same testable, tauri/axum-free service-layer
//! pattern as `admin-template-core`'s `items.rs`/`backup.rs` (plain `cargo
//! test`, no HTTP/IPC awareness), but lives in its own crate rather than
//! `admin-template-core` because it is meant to be reused unmodified by
//! other apps in this workspace (spec §3.1: "banto-industrial 側の消費も
//! 見込まれる").
//!
//! This crate deliberately depends on nothing beyond `banto-core` + `sqlx` +
//! `tokio` + `image` + `sha2` (spec §3.1) - in particular, **no `tauri`, no
//! `axum`, no `banto-server`**. `ServerEvent` (the change-notification type
//! `items.rs` broadcasts on write) is defined in `banto-server`, which would
//! pull that whole dependency in just to emit an event this crate has no
//! other use for; wiring `resource_changed` notifications for attachment
//! uploads/deletes is left to the REST/Tauri wiring layer (spec §4 unit B),
//! which already depends on `banto-server` and owns the `AttachmentsService`
//! instance.
//!
//! The table this service reads/writes (`attachments`) is owned by the
//! consuming app's own migrations (spec §3.1 "テーブル定義はアプリが所有") -
//! see `apps/admin-template/core/migrations/0006_attachments.sql` for the
//! schema this crate requires. A caller wiring this crate into a new app
//! must ship an equivalent migration; this crate does not embed one itself.
//!
//! ## Storage layout
//!
//! Given a `base_dir` (spec §3.3: the caller passes
//! `db_path.parent().join("attachments")`, mirroring `backup.rs`'s
//! `backups/` sibling-directory convention):
//! - `{base_dir}/{id}` - the attachment body, named ONLY by its
//!   server-assigned row id. The user-supplied `file_name` is never used to
//!   build a filesystem path (path traversal defense-in-depth: even if
//!   [`validate_file_name`] had a hole, there would be nothing left in the
//!   path for it to exploit) - it is stored purely for display/
//!   `Content-Disposition` purposes.
//! - `{base_dir}/{id}.thumb.jpg` - the generated thumbnail, only present
//!   when the row's `has_thumbnail` is `1`.
//!
//! The directory is created lazily on first write, not in [`AttachmentsService::new`]
//! (same "no I/O until actually needed" convention as `backup.rs`'s
//! `backups_dir()`).

use std::path::PathBuf;
use std::time::SystemTime;

use banto_core::{BantoError, FieldError};
use image::{GenericImageView, ImageEncoder, ImageFormat};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

/// Upper bound on a single uploaded attachment (spec §3.5, §7): 25MB,
/// conservative for LAN photo-upload use. A single named constant - the
/// plan's regulated-values table (§7) calls out that changing this limit
/// must only ever require touching this one line.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

const MAX_FILE_NAME_LEN: usize = 256;
/// Long-edge size (px) thumbnails are scaled to fit within (spec §3.4).
const THUMBNAIL_MAX_EDGE: u32 = 256;
/// JPEG quality thumbnails are re-encoded at (spec §3.4).
const THUMBNAIL_JPEG_QUALITY: u8 = 80;
/// Decompression-bomb guard for thumbnail decoding: a crafted sub-25MB file
/// (e.g. a highly compressible PNG declaring enormous dimensions) must not
/// be able to force a multi-GB pixel-buffer allocation on decode. 10k×10k
/// RGBA is ~400MB, comfortably under the 512MB `max_alloc` below, and far
/// above any real photo this feature targets. Rejected images simply get no
/// thumbnail (`has_thumbnail = 0`) - the upload itself still succeeds.
const THUMBNAIL_MAX_SOURCE_EDGE: u32 = 10_000;
const THUMBNAIL_MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
/// MIME assigned to anything `image::guess_format` does not recognize as one
/// of the four supported image formats (spec §3.4: "非画像はクライアント
/// 申告に依存せず application/octet-stream とする").
const DEFAULT_MIME: &str = "application/octet-stream";

fn required_message() -> String {
    "必須項目です".to_string()
}

fn io_err(context: &str, err: std::io::Error) -> BantoError {
    BantoError::Other(format!("{context}: {err}"))
}

fn storage_error(err: sqlx::Error) -> BantoError {
    BantoError::Storage(err.to_string())
}

fn not_found(err: sqlx::Error, id: i64) -> BantoError {
    match err {
        sqlx::Error::RowNotFound => BantoError::NotFound {
            resource: "attachments".to_string(),
            id: id.to_string(),
        },
        other => storage_error(other),
    }
}

/// One row of the `attachments` table (spec §3.2), wire-shaped camelCase for
/// the frontend. Field names on the Rust side deliberately match the DB
/// column names 1:1 (unlike `items.rs`'s `Item`, which needs an explicit
/// `#[sqlx(rename = ...)]` in one spot) so `sqlx::FromRow`'s default
/// column-name-equals-field-name mapping just works without any per-field
/// annotations.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: i64,
    pub resource: String,
    pub resource_id: String,
    pub file_name: String,
    pub mime: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub has_thumbnail: bool,
    pub created_at: String,
    pub created_by: Option<String>,
}

const SELECT_COLUMNS: &str = "id, resource, resource_id, file_name, mime, size_bytes, sha256, \
     has_thumbnail, created_at, created_by";

/// Input to [`AttachmentsService::upload`]. `bytes` is the raw file body;
/// `mime` is deliberately NOT a field here - see [`AttachmentsService::upload`]'s
/// doc comment for why any client-declared MIME is ignored outright rather
/// than accepted as a hint.
#[derive(Debug, Clone)]
pub struct NewAttachment {
    pub resource: String,
    pub resource_id: String,
    pub file_name: String,
    pub created_by: Option<String>,
    pub bytes: Vec<u8>,
}

/// Reject a `file_name` that is empty, too long, contains control
/// characters, or could be (mis)used as a path component (spec §3.3/§5:
/// "パストラバーサル対策"). Collects every violation rather than
/// short-circuiting on the first, mirroring `admin-template-core::items`'s
/// `validate_item_input` convention.
fn validate_file_name(file_name: &str) -> Result<(), BantoError> {
    let mut errors: Vec<FieldError> = Vec::new();

    if file_name.is_empty() {
        errors.push(FieldError {
            field: "fileName".to_string(),
            message: required_message(),
        });
        return Err(BantoError::Validation {
            field_errors: errors,
        });
    }

    if file_name.chars().count() > MAX_FILE_NAME_LEN {
        errors.push(FieldError {
            field: "fileName".to_string(),
            message: format!("{MAX_FILE_NAME_LEN}文字以内で入力してください"),
        });
    }
    if file_name.chars().any(|c| c.is_control()) {
        errors.push(FieldError {
            field: "fileName".to_string(),
            message: "制御文字を含めることはできません".to_string(),
        });
    }
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        errors.push(FieldError {
            field: "fileName".to_string(),
            message: "パス区切り文字や\"..\"を含めることはできません".to_string(),
        });
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(BantoError::Validation {
            field_errors: errors,
        })
    }
}

/// Reject empty or over-limit bytes (spec §3.5/§5/§7: 25MB/file).
fn validate_bytes(bytes: &[u8]) -> Result<(), BantoError> {
    if bytes.is_empty() {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "file".to_string(),
                message: required_message(),
            }],
        });
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "file".to_string(),
                message: format!(
                    "ファイルサイズは{}MB以内にしてください",
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                ),
            }],
        });
    }
    Ok(())
}

/// Detect the true MIME type from magic bytes (spec §3.4: "クライアント申告
/// MIME は信用しない"). Anything `image::guess_format` does not resolve to
/// one of the four supported image formats becomes [`DEFAULT_MIME`] -
/// including formats `image` itself can detect (e.g. BMP) but this service
/// does not treat as a thumbnail-able image (spec: "image クレートの安定
/// サポート範囲" is JPEG/PNG/WebP/GIF only, per the crate's enabled codec
/// features).
fn detect_mime(bytes: &[u8]) -> String {
    match image::guess_format(bytes) {
        Ok(ImageFormat::Jpeg) => "image/jpeg".to_string(),
        Ok(ImageFormat::Png) => "image/png".to_string(),
        Ok(ImageFormat::WebP) => "image/webp".to_string(),
        Ok(ImageFormat::Gif) => "image/gif".to_string(),
        _ => DEFAULT_MIME.to_string(),
    }
}

fn is_thumbnailable_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode `bytes`, scale to fit within `THUMBNAIL_MAX_EDGE` on the long edge
/// (never upscales - spec §3.4: "長辺256pxに縮小"), composite any alpha
/// channel onto a white background, and re-encode as JPEG at
/// `THUMBNAIL_JPEG_QUALITY`. Returns `None` on ANY failure (corrupt/
/// truncated image data, zero-dimension image, encode failure) rather than
/// propagating an error - by design (spec §3.4): a bad thumbnail must never
/// fail the attachment upload itself, only leave `has_thumbnail = 0`.
fn make_thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    // Explicit decode limits instead of `image::load_from_memory` (which
    // only carries the crate-default 512MB alloc cap, with NO dimension
    // cap): see THUMBNAIL_MAX_SOURCE_EDGE's doc comment. The limits are
    // enforced by the decoder before the pixel buffer is allocated.
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(THUMBNAIL_MAX_SOURCE_EDGE);
    limits.max_image_height = Some(THUMBNAIL_MAX_SOURCE_EDGE);
    limits.max_alloc = Some(THUMBNAIL_MAX_DECODE_ALLOC);
    reader.limits(limits);
    let decoded = reader.decode().ok()?;
    let (width, height) = decoded.dimensions();
    if width == 0 || height == 0 {
        return None;
    }

    let scaled = if width.max(height) > THUMBNAIL_MAX_EDGE {
        decoded.resize(
            THUMBNAIL_MAX_EDGE,
            THUMBNAIL_MAX_EDGE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        decoded
    };

    // Composite onto white (spec §3.4: "アルファは白地に合成") - JPEG has no
    // alpha channel, so this happens before encoding rather than relying on
    // the encoder to do something reasonable with it.
    let rgba = scaled.to_rgba8();
    let mut canvas = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let alpha = f32::from(a) / 255.0;
        let blend = |channel: u8| -> u8 {
            (f32::from(channel) * alpha + 255.0 * (1.0 - alpha)).round() as u8
        };
        canvas.put_pixel(x, y, image::Rgb([blend(r), blend(g), blend(b)]));
    }

    let mut out = Vec::new();
    let encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, THUMBNAIL_JPEG_QUALITY);
    encoder
        .write_image(
            canvas.as_raw(),
            canvas.width(),
            canvas.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(out)
}

/// Howard Hinnant's `civil_from_days` algorithm
/// (http://howardhinnant.github.io/date_algorithms.html) - the same
/// dependency-free date conversion `admin-template-core::db` uses for its
/// seed data / `backup.rs`'s timestamps (spec: no `chrono`/`time` crate
/// anywhere in this workspace). Ported here rather than shared because this
/// crate cannot depend on `admin-template-core` (that dependency would run
/// the wrong way - `admin-template-core` is meant to depend on THIS crate).
fn civil_date_from_days_since_epoch(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// `SystemTime` -> `"YYYY-MM-DDTHH:MM:SSZ"` (UTC, ISO 8601). Used for
/// `attachments.created_at` - same no-`chrono` convention as
/// `backup.rs::iso_datetime_from_system_time`, just with a `T`/`Z` ISO 8601
/// separator/suffix instead of that module's `"YYYY-MM-DD HH:MM:SS"` (spec
/// §3.2 explicitly calls for ISO 8601 here).
fn iso_datetime_from_system_time(time: SystemTime) -> String {
    let secs = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_date_from_days_since_epoch(days);
    let h = secs_of_day / 3600;
    let min = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}Z")
}

/// Service layer for the generic `attachments` table (spec §3.1-§3.4).
/// `Clone` is cheap: `SqlitePool` is `Arc`-backed and `PathBuf` is only ever
/// read from, matching `ItemsService`/`BackupService`'s `Clone` convention.
#[derive(Clone)]
pub struct AttachmentsService {
    pool: SqlitePool,
    base_dir: PathBuf,
}

impl AttachmentsService {
    /// `base_dir` is NOT created here (see this module's doc comment) - the
    /// caller is expected to pass `db_path.parent().join("attachments")`
    /// (spec §3.3), mirroring `BackupService::new`'s `db_path`-in,
    /// derive-everything-else shape, except this service takes the already-
    /// derived directory directly since it has no other use for `db_path`
    /// itself.
    pub fn new(pool: SqlitePool, base_dir: PathBuf) -> Self {
        Self { pool, base_dir }
    }

    fn body_path(&self, id: i64) -> PathBuf {
        self.base_dir.join(id.to_string())
    }

    fn thumbnail_path(&self, id: i64) -> PathBuf {
        self.base_dir.join(format!("{id}.thumb.jpg"))
    }

    /// All attachments for one record, newest first (spec §3.5: `POST
    /// /api/attachments/list` uses this).
    pub async fn list_for_record(
        &self,
        resource: &str,
        resource_id: &str,
    ) -> Result<Vec<AttachmentMeta>, BantoError> {
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM attachments WHERE resource = ? AND resource_id = ? \
             ORDER BY created_at DESC, id DESC"
        );
        sqlx::query_as::<_, AttachmentMeta>(&sql)
            .bind(resource)
            .bind(resource_id)
            .fetch_all(&self.pool)
            .await
            .map_err(storage_error)
    }

    pub async fn get(&self, id: i64) -> Result<AttachmentMeta, BantoError> {
        let sql = format!("SELECT {SELECT_COLUMNS} FROM attachments WHERE id = ?");
        sqlx::query_as::<_, AttachmentMeta>(&sql)
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(|err| not_found(err, id))
    }

    /// Store a new attachment (spec §3.2-§3.4):
    /// 1. Validate `file_name`/`bytes` (empty, over `MAX_ATTACHMENT_BYTES`,
    ///    unsafe file name).
    /// 2. Hash the bytes (`sha256`) and detect the true MIME from magic
    ///    bytes - any client-declared MIME is ignored outright, never even
    ///    accepted as a parameter, so there is no path by which a caller
    ///    could smuggle a spoofed MIME through this API at all.
    /// 3. Insert the metadata row (`has_thumbnail = 0`) to obtain the
    ///    server-assigned id.
    /// 4. Write the body to `{base_dir}/{id}`. On failure, the just-inserted
    ///    row is deleted before returning the error - an attachment row must
    ///    never outlive its body file (spec §5: this is exercised as
    ///    "delete がファイルも消すこと"'s mirror image at write time).
    /// 5. If the detected MIME is one of the four supported image formats,
    ///    best-effort generate a thumbnail (spec: decode failure on a
    ///    corrupt image does not fail the upload, `has_thumbnail` just stays
    ///    `0`) and flip `has_thumbnail` to `1` on success.
    pub async fn upload(&self, input: NewAttachment) -> Result<AttachmentMeta, BantoError> {
        validate_file_name(&input.file_name)?;
        validate_bytes(&input.bytes)?;

        let sha256 = sha256_hex(&input.bytes);
        let mime = detect_mime(&input.bytes);
        let created_at = iso_datetime_from_system_time(SystemTime::now());

        let sql = format!(
            "INSERT INTO attachments \
             (resource, resource_id, file_name, mime, size_bytes, sha256, has_thumbnail, created_at, created_by) \
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) \
             RETURNING {SELECT_COLUMNS}"
        );
        let mut meta = sqlx::query_as::<_, AttachmentMeta>(&sql)
            .bind(&input.resource)
            .bind(&input.resource_id)
            .bind(&input.file_name)
            .bind(&mime)
            .bind(input.bytes.len() as i64)
            .bind(&sha256)
            .bind(&created_at)
            .bind(&input.created_by)
            .fetch_one(&self.pool)
            .await
            .map_err(storage_error)?;

        if let Err(write_err) = self.write_body(meta.id, &input.bytes).await {
            // The row must not outlive its body file - best-effort cleanup;
            // if even the delete fails, the original write error is still
            // what the caller needs to see.
            let _ = sqlx::query("DELETE FROM attachments WHERE id = ?")
                .bind(meta.id)
                .execute(&self.pool)
                .await;
            return Err(write_err);
        }

        if is_thumbnailable_mime(&mime) {
            if let Some(thumb_bytes) = make_thumbnail(&input.bytes) {
                if self.write_thumbnail(meta.id, &thumb_bytes).await.is_ok() {
                    sqlx::query("UPDATE attachments SET has_thumbnail = 1 WHERE id = ?")
                        .bind(meta.id)
                        .execute(&self.pool)
                        .await
                        .map_err(storage_error)?;
                    meta.has_thumbnail = true;
                }
                // A thumbnail write failure is swallowed the same way a
                // decode failure is (spec §3.4): the attachment itself was
                // already stored successfully above, so this is not a
                // reason to fail the whole upload.
            }
        }

        Ok(meta)
    }

    async fn write_body(&self, id: i64, bytes: &[u8]) -> Result<(), BantoError> {
        tokio::fs::create_dir_all(&self.base_dir)
            .await
            .map_err(|err| io_err("添付ファイル保存用ディレクトリの作成に失敗しました", err))?;
        tokio::fs::write(self.body_path(id), bytes)
            .await
            .map_err(|err| io_err("添付ファイルの書き込みに失敗しました", err))
    }

    async fn write_thumbnail(&self, id: i64, bytes: &[u8]) -> Result<(), BantoError> {
        tokio::fs::create_dir_all(&self.base_dir)
            .await
            .map_err(|err| io_err("添付ファイル保存用ディレクトリの作成に失敗しました", err))?;
        tokio::fs::write(self.thumbnail_path(id), bytes)
            .await
            .map_err(|err| io_err("サムネイルの書き込みに失敗しました", err))
    }

    /// Metadata + body bytes for one attachment (spec §3.5: REST download).
    pub async fn read_body(&self, id: i64) -> Result<(AttachmentMeta, Vec<u8>), BantoError> {
        let meta = self.get(id).await?;
        let bytes = tokio::fs::read(self.body_path(id)).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                BantoError::NotFound {
                    resource: "attachments".to_string(),
                    id: id.to_string(),
                }
            } else {
                io_err("添付ファイルの読み取りに失敗しました", err)
            }
        })?;
        Ok((meta, bytes))
    }

    /// Thumbnail bytes for one attachment (spec §3.5). `NotFound` both when
    /// the row itself does not exist and when `has_thumbnail = 0` (spec §3.4:
    /// "無ければ404") - callers cannot distinguish "no such attachment" from
    /// "attachment exists but has no thumbnail" from this error alone, which
    /// is intentional: both render the same "no thumbnail to show" UI state.
    pub async fn read_thumbnail(&self, id: i64) -> Result<Vec<u8>, BantoError> {
        let meta = self.get(id).await?;
        if !meta.has_thumbnail {
            return Err(BantoError::NotFound {
                resource: "attachments".to_string(),
                id: id.to_string(),
            });
        }
        tokio::fs::read(self.thumbnail_path(id))
            .await
            .map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    BantoError::NotFound {
                        resource: "attachments".to_string(),
                        id: id.to_string(),
                    }
                } else {
                    io_err("サムネイルの読み取りに失敗しました", err)
                }
            })
    }

    /// Delete one attachment: the metadata row first, then its file(s)
    /// (spec §3.3: "削除はメタデータ行 -> ファイルの順"). A file-delete
    /// failure is logged and swallowed, never returned as an error - an
    /// orphaned file is not fatal (spec: "孤児ファイルは致命でない"), unlike
    /// an orphaned METADATA row (which is what the ordering here avoids).
    /// Returns the deleted row for the caller's audit log entry.
    pub async fn delete(&self, id: i64) -> Result<AttachmentMeta, BantoError> {
        let meta = self.get(id).await?;

        let result = sqlx::query("DELETE FROM attachments WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(storage_error)?;
        if result.rows_affected() == 0 {
            // Raced with a concurrent delete between the `get` above and
            // here - treat it the same as "already gone".
            return Err(BantoError::NotFound {
                resource: "attachments".to_string(),
                id: id.to_string(),
            });
        }

        if let Err(err) = tokio::fs::remove_file(self.body_path(id)).await {
            if err.kind() != std::io::ErrorKind::NotFound {
                eprintln!("banto-attachments: failed to delete body file for id {id}: {err}");
            }
        }
        if meta.has_thumbnail {
            if let Err(err) = tokio::fs::remove_file(self.thumbnail_path(id)).await {
                if err.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "banto-attachments: failed to delete thumbnail file for id {id}: {err}"
                    );
                }
            }
        }

        Ok(meta)
    }

    /// Delete every attachment belonging to one record (spec §3.8: items
    /// deletion cleans up its attachments). Returns the number of rows
    /// deleted. Built on [`AttachmentsService::delete`] (same row-then-file
    /// ordering per attachment, one at a time) rather than a bulk `DELETE`
    /// followed by a directory scan - record-scoped attachment counts are
    /// small in practice, and reusing `delete` keeps there being exactly one
    /// place that knows how to safely remove one attachment.
    pub async fn delete_for_record(
        &self,
        resource: &str,
        resource_id: &str,
    ) -> Result<u64, BantoError> {
        let ids: Vec<i64> =
            sqlx::query_scalar("SELECT id FROM attachments WHERE resource = ? AND resource_id = ?")
                .bind(resource)
                .bind(resource_id)
                .fetch_all(&self.pool)
                .await
                .map_err(storage_error)?;

        let mut deleted = 0u64;
        for id in ids {
            match self.delete(id).await {
                Ok(_) => deleted += 1,
                Err(BantoError::NotFound { .. }) => {
                    // Raced with a concurrent delete of the same row; not
                    // this call's problem.
                }
                Err(err) => return Err(err),
            }
        }
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A migrated, on-disk SQLite pool + fresh temp `base_dir` (NOT
    /// `:memory:` for the pool - unlike `items.rs`'s tests, this crate has
    /// no `admin-template-core::db::migrate_memory` to depend on, since that
    /// would be a backwards dependency (this crate is meant to be depended
    /// ON by `admin-template-core`, not the reverse). `:memory:` is fine
    /// here regardless (no `VACUUM INTO` involved, unlike `backup.rs`'s
    /// tests) - only the base_dir needs to be a real temp directory, since
    /// that is what attachment bodies/thumbnails are actually written to.
    ///
    /// The schema below MUST be kept in sync with
    /// `apps/admin-template/core/migrations/0006_attachments.sql` - this
    /// crate cannot depend on that app crate's migrations, so it re-states
    /// the same `CREATE TABLE`/`CREATE INDEX` here instead.
    async fn service() -> (AttachmentsService, tempfile::TempDir) {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::query(
            "CREATE TABLE attachments (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                resource      TEXT    NOT NULL,
                resource_id   TEXT    NOT NULL,
                file_name     TEXT    NOT NULL,
                mime          TEXT    NOT NULL,
                size_bytes    INTEGER NOT NULL,
                sha256        TEXT    NOT NULL,
                has_thumbnail INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT    NOT NULL,
                created_by    TEXT
            )",
        )
        .execute(&pool)
        .await
        .expect("create attachments table");
        sqlx::query("CREATE INDEX idx_attachments_record ON attachments(resource, resource_id)")
            .execute(&pool)
            .await
            .expect("create index");

        let dir = tempfile::tempdir().expect("tempdir");
        let base_dir = dir.path().join("attachments");
        (AttachmentsService::new(pool, base_dir), dir)
    }

    fn new_attachment(
        resource: &str,
        resource_id: &str,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> NewAttachment {
        NewAttachment {
            resource: resource.to_string(),
            resource_id: resource_id.to_string(),
            file_name: file_name.to_string(),
            created_by: Some("tester".to_string()),
            bytes,
        }
    }

    /// A tiny `width`x`height` solid-color PNG, encoded in-memory via
    /// `image` itself - a real, decodable image fixture without checking in
    /// a binary test asset.
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([200, 100, 50, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .expect("encode png fixture");
        out
    }

    // --- upload / list / read round trip ------------------------------------

    #[tokio::test]
    async fn upload_list_read_body_round_trips_a_non_image_file() {
        let (svc, _dir) = service().await;
        let bytes = b"hello, this is a plain text attachment".to_vec();

        let created = svc
            .upload(new_attachment("items", "42", "notes.txt", bytes.clone()))
            .await
            .expect("upload should succeed");
        assert_eq!(created.resource, "items");
        assert_eq!(created.resource_id, "42");
        assert_eq!(created.file_name, "notes.txt");
        assert_eq!(created.mime, DEFAULT_MIME);
        assert_eq!(created.size_bytes as usize, bytes.len());
        assert_eq!(created.sha256, sha256_hex(&bytes));
        assert!(!created.has_thumbnail);
        assert!(!created.created_at.is_empty());

        let listed = svc.list_for_record("items", "42").await.unwrap();
        assert_eq!(listed, vec![created.clone()]);

        let (meta, read_bytes) = svc.read_body(created.id).await.unwrap();
        assert_eq!(meta, created);
        assert_eq!(read_bytes, bytes);
    }

    #[tokio::test]
    async fn list_for_record_is_newest_first_and_scoped_to_the_record() {
        let (svc, _dir) = service().await;
        let a = svc
            .upload(new_attachment("items", "1", "a.txt", b"a".to_vec()))
            .await
            .unwrap();
        let b = svc
            .upload(new_attachment("items", "1", "b.txt", b"b".to_vec()))
            .await
            .unwrap();
        svc.upload(new_attachment("items", "2", "other.txt", b"c".to_vec()))
            .await
            .unwrap();

        let listed = svc.list_for_record("items", "1").await.unwrap();
        assert_eq!(listed.len(), 2);
        // Newest (highest id, since these all land in the same second)
        // first.
        assert_eq!(listed[0].id, b.id);
        assert_eq!(listed[1].id, a.id);
    }

    #[tokio::test]
    async fn get_missing_id_is_not_found() {
        let (svc, _dir) = service().await;
        let err = svc.get(999).await.unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "attachments" && id == "999")
        );
    }

    // --- image thumbnails ----------------------------------------------------

    #[tokio::test]
    async fn small_image_upload_generates_a_thumbnail() {
        let (svc, _dir) = service().await;
        let png = png_bytes(64, 64);

        let created = svc
            .upload(new_attachment("items", "1", "photo.png", png))
            .await
            .unwrap();
        assert_eq!(created.mime, "image/png");
        assert!(created.has_thumbnail);

        let thumb = svc.read_thumbnail(created.id).await.unwrap();
        // JPEG magic bytes: FF D8 FF.
        assert_eq!(&thumb[0..3], &[0xFF, 0xD8, 0xFF]);

        let decoded = image::load_from_memory(&thumb).expect("thumbnail must decode");
        let (w, h) = decoded.dimensions();
        assert!(w.max(h) <= THUMBNAIL_MAX_EDGE);
    }

    #[tokio::test]
    async fn oversized_image_is_shrunk_to_the_long_edge_limit() {
        let (svc, _dir) = service().await;
        let png = png_bytes(1000, 400); // long edge 1000 >> 256

        let created = svc
            .upload(new_attachment("items", "1", "big.png", png))
            .await
            .unwrap();
        assert!(created.has_thumbnail);

        let thumb = svc.read_thumbnail(created.id).await.unwrap();
        let decoded = image::load_from_memory(&thumb).unwrap();
        let (w, h) = decoded.dimensions();
        assert_eq!(w, THUMBNAIL_MAX_EDGE); // long edge scaled down to exactly the cap
        assert!(h < 400); // aspect ratio preserved, short edge shrunk proportionally
    }

    #[tokio::test]
    async fn non_image_upload_has_no_thumbnail() {
        let (svc, _dir) = service().await;
        let created = svc
            .upload(new_attachment(
                "items",
                "1",
                "data.bin",
                b"not an image at all".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(created.mime, DEFAULT_MIME);
        assert!(!created.has_thumbnail);

        let err = svc.read_thumbnail(created.id).await.unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[tokio::test]
    async fn corrupt_image_upload_succeeds_without_a_thumbnail() {
        let (svc, _dir) = service().await;
        // Real PNG magic bytes, followed by garbage - passes magic-byte
        // detection (so `mime` is set) but fails to actually decode.
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0u8; 32]);

        let created = svc
            .upload(new_attachment("items", "1", "broken.png", bytes))
            .await
            .expect("a corrupt image must still upload successfully");
        assert_eq!(created.mime, "image/png");
        assert!(!created.has_thumbnail);
    }

    // --- validation ------------------------------------------------------------

    #[tokio::test]
    async fn upload_rejects_empty_bytes() {
        let (svc, _dir) = service().await;
        let err = svc
            .upload(new_attachment("items", "1", "empty.txt", Vec::new()))
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
    }

    #[tokio::test]
    async fn upload_rejects_bytes_over_the_max_size() {
        let (svc, _dir) = service().await;
        let bytes = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        let err = svc
            .upload(new_attachment("items", "1", "huge.bin", bytes))
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
    }

    #[tokio::test]
    async fn upload_rejects_unsafe_file_names() {
        let (svc, _dir) = service().await;
        for bad in [
            "../secret.txt",
            "a/b.txt",
            "a\\b.txt",
            "..",
            "a\u{0007}b.txt",
        ] {
            let err = svc
                .upload(new_attachment("items", "1", bad, b"x".to_vec()))
                .await
                .unwrap_err();
            assert!(
                matches!(err, BantoError::Validation { .. }),
                "expected Validation for file_name {bad:?}, got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn upload_rejects_empty_file_name() {
        let (svc, _dir) = service().await;
        let err = svc
            .upload(new_attachment("items", "1", "", b"x".to_vec()))
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
    }

    #[tokio::test]
    async fn upload_rejects_file_name_over_256_chars() {
        let (svc, _dir) = service().await;
        let long_name = format!("{}.txt", "a".repeat(300));
        let err = svc
            .upload(new_attachment("items", "1", &long_name, b"x".to_vec()))
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
    }

    // --- delete ------------------------------------------------------------

    #[tokio::test]
    async fn delete_removes_the_row_and_its_files() {
        let (svc, _dir) = service().await;
        let created = svc
            .upload(new_attachment("items", "1", "photo.png", png_bytes(64, 64)))
            .await
            .unwrap();
        assert!(svc.body_path(created.id).exists());
        assert!(svc.thumbnail_path(created.id).exists());

        let deleted = svc.delete(created.id).await.expect("delete should succeed");
        assert_eq!(deleted, created);

        assert!(!svc.body_path(created.id).exists());
        assert!(!svc.thumbnail_path(created.id).exists());
        let err = svc.get(created.id).await.unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[tokio::test]
    async fn delete_missing_id_is_not_found() {
        let (svc, _dir) = service().await;
        let err = svc.delete(999).await.unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[tokio::test]
    async fn delete_for_record_removes_only_that_records_attachments() {
        let (svc, _dir) = service().await;
        svc.upload(new_attachment("items", "1", "a.txt", b"a".to_vec()))
            .await
            .unwrap();
        svc.upload(new_attachment("items", "1", "b.txt", b"b".to_vec()))
            .await
            .unwrap();
        svc.upload(new_attachment("items", "2", "c.txt", b"c".to_vec()))
            .await
            .unwrap();

        let count = svc.delete_for_record("items", "1").await.unwrap();
        assert_eq!(count, 2);
        assert!(svc.list_for_record("items", "1").await.unwrap().is_empty());
        assert_eq!(svc.list_for_record("items", "2").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delete_for_record_with_no_attachments_is_zero() {
        let (svc, _dir) = service().await;
        let count = svc.delete_for_record("items", "999").await.unwrap();
        assert_eq!(count, 0);
    }

    // --- ISO 8601 formatter --------------------------------------------------

    #[test]
    fn iso_datetime_formats_known_values() {
        assert_eq!(
            iso_datetime_from_system_time(SystemTime::UNIX_EPOCH),
            "1970-01-01T00:00:00Z"
        );
        assert_eq!(
            iso_datetime_from_system_time(
                SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(86_400 + 3661)
            ),
            "1970-01-02T01:01:01Z"
        );
        // 2024-02-29 00:00:00Z is a leap-day boundary: 19782 days since
        // epoch (2024 is divisible by 4 and not by 100).
        assert_eq!(
            iso_datetime_from_system_time(
                SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(19_782 * 86_400)
            ),
            "2024-02-29T00:00:00Z"
        );
        // 2000-02-29 is a leap-day boundary in a century year that IS
        // divisible by 400 (so still a leap year, unlike 1900/2100).
        assert_eq!(
            iso_datetime_from_system_time(
                SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(11_016 * 86_400)
            ),
            "2000-02-29T00:00:00Z"
        );
    }
}
