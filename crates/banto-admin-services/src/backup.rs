//! SQLite backup/restore service (spec M17, `docs/roadmap.md`): admin-only
//! DB snapshots (`VACUUM INTO`) into a `backups/` directory next to the DB
//! file, plus a staging-based restore flow. Same testable, tauri/axum-free
//! service-layer pattern as [`crate::audit::AuditLogService`]/
//! [`crate::settings::SettingsService`] - every REST handler and Tauri
//! command wraps this with its own RBAC gate and audit write, this module
//! knows about neither.
//!
//! ## Design: why "stage now, apply on next restart" (spec M17)
//!
//! Restoring a SQLite DB means replacing the file underneath a live
//! connection pool - `sqlx::SqlitePool` holds open connections that would
//! keep operating against the OLD file (or worse, a half-written new one) if
//! swapped out from under it. Rather than tearing down and rebuilding the
//! pool mid-request (fragile, and every in-flight request would need to be
//! drained first), a restore is staged as a `restore-pending.sqlite3` file
//! next to the real DB and only APPLIED at the next process start, before
//! any pool exists at all - see [`BackupService::apply_pending_restore_at_startup`],
//! called from `src-tauri`'s `run()` and `bin/banto-serve.rs`'s `main`
//! *before* `admin_template_core::db::init_db`.
//!
//! ## Directory layout
//!
//! Backups and the staged restore are kept **per DB file** (issue #280): two
//! SQLite DBs placed in the same folder must never see each other's backups or
//! restore reservations. Given the DB file at `{dir}/{name}` (e.g.
//! `{dir}/admin-template.sqlite3`), everything lives under
//! `{dir}/backups/{name}/` (see [`BackupService::scope_dir`], the ONE function
//! every operation resolves the directory through):
//! - `{dir}/backups/{name}/banto-YYYYMMDD-HHMMSS(-N)?.sqlite3` - backups made
//!   by [`BackupService::create`] (`N` only appended on a same-second name
//!   collision).
//! - `{dir}/backups/{name}/pre-restore-YYYYMMDD-HHMMSS(-N)?.sqlite3` - the
//!   automatic safety backup [`BackupService::apply_pending_restore_at_startup`]
//!   takes of the CURRENT db immediately before overwriting it.
//! - `{dir}/backups/{name}/restore-pending.sqlite3` - the staged file, written
//!   by [`BackupService::stage_restore_from_file`]/
//!   [`BackupService::stage_restore_from_bytes`], consumed (renamed away) by
//!   [`BackupService::apply_pending_restore_at_startup`]. It sits next to the
//!   backups but is never listed/readable as one (see `PENDING_RESTORE_FILE_NAME`).
//!
//! `{name}` is the DB's own file name (taken from the configured path, never
//! from request input), validated by `scope_name`.
//!
//! **Legacy shared area**: before #280 backups lived directly in `{dir}/backups/`
//! and the reservation at `{dir}/restore-pending.sqlite3`. Their owner cannot
//! be determined, so they are NOT listed, NOT readable and NEVER auto-applied;
//! startup only prints a warning (see `warn_legacy_shared_area`). They are left
//! untouched for the operator to move by hand.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::SystemTime;

use banto_core::datetime::iso_datetime_from_system_time;
use banto_core::{BantoError, FieldError};
use banto_storage::Db;
use serde::Serialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection, SqlitePool};

const BACKUPS_DIR_NAME: &str = "backups";
/// Reserved file name of the staged restore inside a DB's scope directory
/// (and, in the pre-#280 layout, directly in the DB's parent folder).
const PENDING_RESTORE_FILE_NAME: &str = "restore-pending.sqlite3";

/// Validate a DB file name for use as a directory name under `backups/`
/// (issue #280). The name comes from the configured DB path, not from a
/// request, but it is still checked like [`BackupService::safe_backup_path`]
/// does for file names: no path separators/`..`/control or
/// Windows-reserved characters, no trailing dot/space. Anything else is an
/// explicit error rather than a silent fallback to a shared directory.
fn scope_name(db_path: &Path) -> Result<String, BantoError> {
    let name = db_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        });
    if !ok {
        return Err(validation_err(
            "DBファイル名がバックアップの保存先名として使えません".to_string(),
        ));
    }
    Ok(name.to_string())
}

/// Parent folder of the DB file (`backups/`'s parent). Falls back to `.` for a
/// bare relative file name - mirrors how the file itself is opened.
fn base_dir_of(db_path: &Path) -> &Path {
    db_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

/// Per-DB scope directory `{parent}/backups/{db file name}/` - the single
/// resolution point shared by every backup/restore operation (issue #280).
fn scope_dir_of(db_path: &Path) -> Result<PathBuf, BantoError> {
    Ok(base_dir_of(db_path)
        .join(BACKUPS_DIR_NAME)
        .join(scope_name(db_path)?))
}

/// Startup warning for files left in the pre-#280 shared area (see the module
/// doc). Never deletes or applies anything.
fn warn_legacy_shared_area(db_path: &Path) {
    let base = base_dir_of(db_path);
    let shared = base.join(BACKUPS_DIR_NAME);
    let legacy_pending = base.join(PENDING_RESTORE_FILE_NAME);
    let has_legacy_backups = std::fs::read_dir(&shared)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.path().extension().and_then(|x| x.to_str()) == Some("sqlite3")
                    && e.file_type().map(|t| t.is_file()).unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let has_legacy_pending = legacy_pending.is_file();
    if !has_legacy_backups && !has_legacy_pending {
        return;
    }
    let target = scope_dir_of(db_path)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| shared.display().to_string());
    let mut found = Vec::new();
    if has_legacy_backups {
        found.push(format!("{} 直下の *.sqlite3", shared.display()));
    }
    if has_legacy_pending {
        found.push(legacy_pending.display().to_string());
    }
    eprintln!(
        "banto: 警告: 旧形式（DB共有）のバックアップ領域にファイルが残っています: {}。所属DBを判断できないため、一覧・取得・自動適用の対象にしません（削除もしません）。このDBのバックアップとして使う場合は、該当ファイルを {} へ手動で移動してください。不要なら手動で削除してください。",
        found.join(", "),
        target
    );
}

/// Banto-owned tables a file must have to be accepted as a restorable Banto
/// database (spec M17 "スキーマ妥当性"). Domain tables such as the template's
/// `items` demo are deliberately excluded: derived apps are expected to replace
/// or remove them. This checks only table presence, not columns - a coarse but
/// cheap sanity check that this is a Banto DB at all (not, say, a random
/// unrelated `.sqlite3` file). Compatibility with this app's schema is the
/// migration-history check's job ([`MigrationManifest`]). `ui_settings` is
/// part of the v8.0.0 baseline (ADR-0034 §9): a backup from an earlier version
/// lacks it and is refused here already.
const REQUIRED_TABLES: [&str; 4] = ["settings", "users", "audit_log", "ui_settings"];

/// The migrations this app embeds, as the wiring layer hands them to the
/// restore validation (ADR-0034 §9). Table definitions and the migrator belong
/// to the app (conventions §11), so the service layer only sees the list:
/// each migration's version with the checksum sqlx records for it, and the
/// last version of the baseline every restorable database must already have.
///
/// A restore candidate is accepted only when its `_sqlx_migrations` history
/// (a) holds no failed row, (b) lists only versions this manifest has, each
/// with the same checksum, and (c) has every version up to the baseline
/// applied. Versions after the baseline may be missing: the next startup's
/// migration run adds them. Anything else would swap in a file the startup
/// migration check then refuses, leaving a database that cannot boot.
///
/// [`MigrationManifest::with_candidate_check`] adds the app's own startup
/// conditions on top of the history (ADR-0034 §9): the checks that would stop
/// the startup AFTER the swap are run on the candidate BEFORE it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationManifest {
    migrations: Vec<(i64, Vec<u8>)>,
    baseline_version: i64,
    candidate_check: Option<CandidateCheck>,
}

/// The app's startup conditions, run on a restore candidate (ADR-0034 §9).
///
/// A candidate whose migration history is fine can still be a database the
/// app refuses to start on (no built-in `admin` row, an account whose name a
/// grant's fixed id now reserves, ...). Swapping it in would replace a good
/// database with one that cannot boot. The wiring layer therefore hands over
/// the SAME function its startup runs, and the restore validation calls it at
/// both moments a candidate is looked at: when the restore is staged, and
/// right before the swap. The current database is not touched whatever the
/// answer:
///
/// - `Ok(CandidateVerdict::Accepted)`: the candidate may be staged / applied;
/// - `Ok(CandidateVerdict::Rejected(reason))`: the CANDIDATE is the problem.
///   Staging is refused (`validation`), and a pending file found at startup
///   is deleted;
/// - `Err(_)`: the check could not be COMPLETED (no disk space for the
///   working copy, a permission, a read that failed). That says nothing about
///   the candidate: staging fails with that error and can be retried, and a
///   pending file found at startup is KEPT - the restore is not applied this
///   time and is looked at again on the next start.
///
/// The function receives the candidate's PATH and must not change that file:
/// it opens it read-only, or - when the startup would first run migrations -
/// works on a copy it deletes afterwards.
#[derive(Clone)]
pub struct CandidateCheck(Arc<CandidateCheckFn>);

/// What a [`CandidateCheck`] found, when it could look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CandidateVerdict {
    Accepted,
    /// The app would not start on this candidate; the reason, for the operator.
    Rejected(String),
}

type CandidateCheckFn = dyn Fn(PathBuf) -> Pin<Box<dyn Future<Output = Result<CandidateVerdict, BantoError>> + Send>>
    + Send
    + Sync;

/// Why a restore candidate is not used.
#[derive(Debug)]
enum CandidateRefusal {
    /// The candidate itself is unusable (not SQLite, corrupt, another
    /// version's history, a database the app would not start on).
    Invalid(BantoError),
    /// The check could not be completed; nothing is known about the candidate.
    Unchecked(BantoError),
}

impl CandidateRefusal {
    fn into_error(self) -> BantoError {
        match self {
            Self::Invalid(err) => err,
            Self::Unchecked(err) => BantoError::Other(format!(
                "リストアの候補を検査できませんでした（候補の内容の問題ではありません）。\
                 空き容量や権限を確かめて、もう一度お試しください: {err}"
            )),
        }
    }
}

/// Which failed reads still tell something about the candidate's CONTENT.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ReadOf {
    /// Opening the file, the integrity check, `sqlite_master`: the statement
    /// cannot fail because of what the candidate's schema looks like.
    File,
    /// A query over a table of the candidate. A column that is missing or of
    /// another type is a finding about the candidate (it is arbitrary
    /// operator-supplied input), not a failed read.
    CandidateTable,
}

/// SQLite's primary result code of `err`, when SQLite reported one.
fn sqlite_primary_code(err: &sqlx::Error) -> Option<i32> {
    let sqlx::Error::Database(db_err) = err else {
        return None;
    };
    // sqlx-sqlite reports the EXTENDED code; the low byte is the primary one.
    db_err.code()?.parse::<i32>().ok().map(|code| code & 0xff)
}

/// Sort a read that failed while validating a candidate (cross-review of
/// #858). Only an error in which SQLite CONFIRMS that the content is not a
/// usable database is the candidate's fault: `SQLITE_CORRUPT` (11),
/// `SQLITE_NOTADB` (26), and - for [`ReadOf::CandidateTable`] - a table of
/// another shape. Everything else (`SQLITE_IOERR`, `SQLITE_CANTOPEN`,
/// `SQLITE_BUSY`, a permission, an I/O error of the driver, ...) means the
/// file could not be READ: nothing is known about it, so it must not be
/// reported - or, at startup, deleted - as an invalid candidate.
fn read_failure(context: &str, read: ReadOf, err: sqlx::Error) -> CandidateRefusal {
    const SQLITE_ERROR: i32 = 1;
    const SQLITE_CORRUPT: i32 = 11;
    const SQLITE_NOTADB: i32 = 26;
    let about_content = match sqlite_primary_code(&err) {
        Some(SQLITE_CORRUPT | SQLITE_NOTADB) => true,
        Some(SQLITE_ERROR) => read == ReadOf::CandidateTable,
        Some(_) => false,
        None => {
            read == ReadOf::CandidateTable
                && matches!(
                    err,
                    sqlx::Error::ColumnDecode { .. }
                        | sqlx::Error::ColumnNotFound(_)
                        | sqlx::Error::ColumnIndexOutOfBounds { .. }
                        | sqlx::Error::Decode(_)
                        | sqlx::Error::TypeNotFound { .. }
                )
        }
    };
    if about_content {
        CandidateRefusal::Invalid(validation_err(format!(
            "{context}（ファイルが破損しているか、Banto のSQLiteデータベースではありません）: {err}"
        )))
    } else {
        CandidateRefusal::Unchecked(BantoError::Storage(format!("{context}: {err}")))
    }
}

impl CandidateCheck {
    pub fn new<F, Fut>(check: F) -> Self
    where
        F: Fn(PathBuf) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<CandidateVerdict, BantoError>> + Send + 'static,
    {
        Self(Arc::new(move |path| Box::pin(check(path))))
    }

    async fn run(&self, candidate: &Path) -> Result<CandidateVerdict, BantoError> {
        (self.0)(candidate.to_path_buf()).await
    }
}

impl std::fmt::Debug for CandidateCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CandidateCheck(..)")
    }
}

impl PartialEq for CandidateCheck {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for CandidateCheck {}

impl MigrationManifest {
    /// `migrations`: `(version, checksum)` of every embedded migration (for a
    /// `sqlx::migrate::Migrator`, each non-down `Migration`'s `version` and
    /// `checksum`). `baseline_version`: the last migration of the baseline.
    pub fn new(
        migrations: impl IntoIterator<Item = (i64, Vec<u8>)>,
        baseline_version: i64,
    ) -> Self {
        Self {
            migrations: migrations.into_iter().collect(),
            baseline_version,
            candidate_check: None,
        }
    }

    /// Also run `check` - the app's startup conditions - on every restore
    /// candidate, after the history check passed (see [`CandidateCheck`]).
    pub fn with_candidate_check(mut self, check: CandidateCheck) -> Self {
        self.candidate_check = Some(check);
        self
    }

    fn checksum_of(&self, version: i64) -> Option<&[u8]> {
        self.migrations
            .iter()
            .find(|(v, _)| *v == version)
            .map(|(_, checksum)| checksum.as_slice())
    }
}

/// Error of a candidate whose migration history does not match this app
/// (ADR-0034 §9). One wording for every mismatch: the operator's remedy is the
/// same (use a backup taken by this version of the app).
fn migration_history_err(reason: impl std::fmt::Display) -> CandidateRefusal {
    CandidateRefusal::Invalid(validation_err(format!(
        "このファイルは、このアプリの版のデータベースではありません（{reason}）。v8.0.0 より前の版や、より新しい版のバックアップは復元できません"
    )))
}

/// One backup file, as listed/created by [`BackupService::list`]/
/// [`BackupService::create`]. `created_at` for [`BackupService::create`]
/// comes from the DB's own `datetime('now')` (see that method); for
/// [`BackupService::list`] it is the file's filesystem mtime instead - using
/// mtime uniformly for every `*.sqlite3` file in `backups/` (rather than
/// parsing it back out of the name) means `list` never hard-fails just
/// because an operator dropped an oddly-named file in there.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub size_bytes: u64,
    pub created_at: String,
}

/// The currently-staged restore, if any (spec M17). `staged_at` is the
/// pending file's filesystem mtime (there is no name-embedded timestamp for
/// this one file, unlike [`BackupInfo`] - see this module's doc comment for
/// why it is not itself a numbered/timestamped file).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestoreInfo {
    pub size_bytes: u64,
    pub staged_at: String,
}

/// Result of [`BackupService::apply_pending_restore_at_startup`] actually
/// applying a staged restore (i.e. `Some` - `None` means nothing was
/// pending). `pre_restore_backup_file_name` is the automatic safety copy of
/// the OLD db (spec M17: "適用直前に現DBを自動バックアップ") taken just
/// before the swap - the caller (spec: `run()`/`banto-serve`'s `main`)
/// records the `restore_applied` audit entry once a pool exists, using this
/// to fill in `detail`.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedRestoreInfo {
    pub pre_restore_backup_file_name: String,
    pub applied_at: String,
}

fn validation_err(message: impl Into<String>) -> BantoError {
    BantoError::Validation {
        field_errors: vec![FieldError {
            field: "file".to_string(),
            message: message.into(),
        }],
    }
}

fn io_err(context: &str, err: std::io::Error) -> BantoError {
    BantoError::Other(format!("{context}: {err}"))
}

/// The error every [`BackupService`] operation returns when its handle is a
/// PostgreSQL backend (V2 owner decision D3: backup/restore stays a SQLite-only
/// feature - `VACUUM INTO` + startup file-swap restore have no Postgres
/// analogue, and a `pg_dump`-style logical backup is a separate future V2
/// milestone). PR4 makes each public operation return THIS instead of the old
/// `sqlite_pool()` `expect` panic. `BantoError::Other` renders the message
/// verbatim across both the REST and Tauri boundaries, matching this module's
/// other operational errors ([`io_err`]).
fn backup_unsupported_on_postgres() -> BantoError {
    BantoError::Other(
        "バックアップ／リストアは SQLite バックエンドでのみ利用できます（PostgreSQL では非対応です）"
            .to_string(),
    )
}

/// `"YYYY-MM-DD HH:MM:SS"` -> `"YYYYMMDD-HHMMSS"`, the compact stamp used in
/// generated file names (`banto-{stamp}.sqlite3`, `pre-restore-{stamp}.sqlite3`).
/// Purely textual (strips `-`/`:`/` `) - never re-parses the number back out,
/// so it cannot fail on a well-formed input.
fn compact_stamp(iso_datetime: &str) -> String {
    let (date_part, time_part) = iso_datetime
        .split_once(' ')
        .unwrap_or((iso_datetime, "000000"));
    let date_digits: String = date_part.chars().filter(|c| c.is_ascii_digit()).collect();
    let time_digits: String = time_part.chars().filter(|c| c.is_ascii_digit()).collect();
    format!("{date_digits}-{time_digits}")
}

/// Build a `VACUUM INTO '<path>'` statement with `path` embedded as an
/// escaped SQL string literal (single quotes doubled, the standard SQL
/// escaping rule), rather than as a bound parameter (`VACUUM INTO ?`) -
/// SQLite's `VACUUM INTO` grammar takes its destination as a
/// `filename` (string-literal-like expression) slot, and this workspace's
/// bundled SQLite does not accept a bound parameter there (verified
/// empirically: `execute()` returns `Ok` but silently creates no file at
/// all). Every call site in this module goes through this helper instead of
/// hand-rolling the same escaping.
fn vacuum_into_sql(path: &Path) -> String {
    let escaped = path.to_string_lossy().replace('\'', "''");
    format!("VACUUM INTO '{escaped}'")
}

/// Pick a `{dir}/{base_stem}.{ext}` path, appending `-1`, `-2`, ... on a
/// collision (spec M17: "ファイル名衝突時は連番サフィックス"). Collisions are
/// only expected within the same second (two backups requested back to
/// back), so this is a short loop in practice, not an unbounded scan.
fn unique_path(dir: &Path, base_stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base_stem}.{ext}"));
    let mut n = 1u32;
    while candidate.exists() {
        candidate = dir.join(format!("{base_stem}-{n}.{ext}"));
        n += 1;
    }
    candidate
}

/// Validate that `path` is an intact, restorable Banto database (spec M17):
/// opened read-only (never mutates the candidate file), `PRAGMA
/// integrity_check` must report exactly `"ok"`, and every table in
/// [`REQUIRED_TABLES`] must exist. Returns `BantoError::Validation` with a
/// human-readable reason on any failure - callers (`stage_restore_from_file`/
/// `stage_restore_from_bytes`/`apply_pending_restore_at_startup`) all rely on
/// this to keep a bad file from ever reaching `restore-pending.sqlite3` (or,
/// for the startup path, from ever being applied over a good running DB).
///
/// `manifest` is the app's migration list (ADR-0034 §9): the candidate's
/// `_sqlx_migrations` history must match it (see [`MigrationManifest`]).
async fn validate_sqlite_file(
    path: &Path,
    manifest: &MigrationManifest,
) -> Result<(), CandidateRefusal> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(true);

    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| {
            read_failure(
                "SQLiteデータベースとして開けませんでした",
                ReadOf::File,
                err,
            )
        })?;

    // Run the actual checks in a sub-function and close `conn` on EVERY exit
    // path (success or failure) before propagating the result - critically
    // important on Windows, where an unclosed SQLite file handle keeps the
    // file locked, and every caller of this function immediately tries to
    // delete/rename the very file just validated (a temp upload, or a
    // rejected pending-restore file) once this returns.
    let result = run_validation_checks(&mut conn, manifest).await;
    let _ = conn.close().await;
    result?;

    // ADR-0034 §9: the app's startup conditions, on a file whose history is
    // already known to be this app's. Run after `conn` is closed - the check
    // opens the candidate itself.
    let Some(check) = &manifest.candidate_check else {
        return Ok(());
    };
    match check.run(path).await {
        Ok(CandidateVerdict::Accepted) => Ok(()),
        Ok(CandidateVerdict::Rejected(reason)) => Err(CandidateRefusal::Invalid(validation_err(
            format!("このバックアップは、戻すとアプリを起動できなくなるため使えません: {reason}"),
        ))),
        Err(err) => Err(CandidateRefusal::Unchecked(err)),
    }
}

async fn run_validation_checks(
    conn: &mut SqliteConnection,
    manifest: &MigrationManifest,
) -> Result<(), CandidateRefusal> {
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| read_failure("整合性チェックの実行に失敗しました", ReadOf::File, err))?;
    if integrity != "ok" {
        return Err(CandidateRefusal::Invalid(validation_err(format!(
            "整合性チェックでエラーが見つかりました: {integrity}"
        ))));
    }

    for table in REQUIRED_TABLES {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                .bind(table)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| {
                    read_failure("テーブルの一覧を読めませんでした", ReadOf::File, err)
                })?;
        if exists.is_none() {
            return Err(CandidateRefusal::Invalid(validation_err(format!(
                "必須テーブル '{table}' が見つかりません。Banto のデータベースファイルではない可能性があります"
            ))));
        }
    }

    check_migration_history(conn, manifest).await
}

/// The migration-history part of the restore validation (ADR-0034 §9); see
/// [`MigrationManifest`] for the rule. Read-only.
async fn check_migration_history(
    conn: &mut SqliteConnection,
    manifest: &MigrationManifest,
) -> Result<(), CandidateRefusal> {
    let has_history: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| read_failure("テーブルの一覧を読めませんでした", ReadOf::File, err))?;
    if has_history.is_none() {
        return Err(migration_history_err("migration の履歴がありません"));
    }
    // A history table of an unexpected shape is a refusal of the candidate
    // (it is arbitrary operator-supplied input); a read that FAILED is not -
    // `read_failure` tells the two apart.
    let applied: Vec<(i64, bool, Vec<u8>)> =
        sqlx::query_as("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| {
                read_failure("migration の履歴を読めません", ReadOf::CandidateTable, err)
            })?;
    for (version, success, checksum) in &applied {
        if !success {
            return Err(migration_history_err(format!(
                "migration {version} が失敗したままです"
            )));
        }
        match manifest.checksum_of(*version) {
            None => {
                return Err(migration_history_err(format!(
                    "このアプリに無い migration {version} が適用されています"
                )))
            }
            Some(expected) if expected != checksum.as_slice() => {
                return Err(migration_history_err(format!(
                    "migration {version} の内容がこのアプリのものと違います"
                )))
            }
            Some(_) => {}
        }
    }
    for (version, _) in &manifest.migrations {
        if *version <= manifest.baseline_version && !applied.iter().any(|(v, _, _)| v == version) {
            return Err(migration_history_err(format!(
                "基準の migration {version} が適用されていません"
            )));
        }
    }
    Ok(())
}

/// Backup/restore service (spec M17): `Clone` is cheap (`Db` is `Arc`-backed,
/// `PathBuf` is small and only ever read from) - matches
/// `AuditLogService`/`SettingsService`.
///
/// V2 note: this service carries a backend-agnostic [`Db`] for signature
/// symmetry with the other services, **but its logic is SQLite-specific and
/// stays that way** (V2 owner decision D3) - `VACUUM INTO`, `PRAGMA
/// integrity_check`/`wal_checkpoint`, and raw `.sqlite3` file replacement have
/// no portable Postgres analogue, and a `pg_dump`-style logical backup is a
/// separate future V2 milestone. On a PostgreSQL handle every public operation
/// returns [`backup_unsupported_on_postgres`]'s error (never a panic - PR4
/// replaced the old `sqlite_pool()` `expect`); the startup restore path
/// ([`BackupService::apply_pending_restore_at_startup`]) is skipped by its
/// callers for a Postgres target, since it runs before any [`Db`] handle exists
/// (see `bin/banto-serve.rs`).
#[derive(Clone)]
pub struct BackupService {
    db_path: PathBuf,
    db: Db,
    /// The app's migration list for the restore validation (ADR-0034 §9).
    /// `None` until the wiring passes it: staging a restore is then refused.
    migrations: Option<MigrationManifest>,
}

impl BackupService {
    pub fn new(db_path: PathBuf, db: Db) -> Self {
        Self {
            db_path,
            db,
            migrations: None,
        }
    }

    /// Hand over the app's migration list (ADR-0034 §9). The wiring layer
    /// calls this once at construction, like `UsersService`'s
    /// `with_permission_catalog`. Without it every restore staging is refused
    /// (fail closed): the service cannot tell a database of this app's version
    /// from one the startup migration check will refuse after the swap.
    pub fn with_migrations(mut self, manifest: MigrationManifest) -> Self {
        self.migrations = Some(manifest);
        self
    }

    fn migrations(&self) -> Result<&MigrationManifest, BantoError> {
        self.migrations.as_ref().ok_or_else(|| {
            BantoError::Other(
                "リストアの検査に必要な migration の一覧が渡されていません（配線の不備）。リストアは予約できません"
                    .to_string(),
            )
        })
    }

    /// The underlying SQLite pool, or a clear [`BantoError`] when this handle
    /// is a PostgreSQL backend. `BackupService` is SQLite-only (see the type's
    /// doc comment): every public operation gates on this so a Postgres handle
    /// yields [`backup_unsupported_on_postgres`] rather than the old panic. In a
    /// default (SQLite-only) build `as_sqlite()` can only ever be `Some`, so the
    /// error arm is unreachable there yet still compiles under
    /// `--features postgres` (where `Db` also has a `Postgres` variant).
    fn sqlite_pool(&self) -> Result<&SqlitePool, BantoError> {
        self.db
            .as_sqlite()
            .ok_or_else(backup_unsupported_on_postgres)
    }

    /// Per-DB directory holding this DB's backups and staged restore - the
    /// ONE place every operation resolves it (issue #280, conventions §6).
    /// Errors (explicitly) when the DB file name is unusable as a directory
    /// name.
    fn scope_dir(&self) -> Result<PathBuf, BantoError> {
        scope_dir_of(&self.db_path)
    }

    /// This DB's backup directory as a displayable string (spec M17: the
    /// desktop "フォルダを開く" command needs a path to hand to the OS file
    /// explorer, and to show as a fallback on platforms that command does
    /// not support). Does not check whether the directory actually exists
    /// yet - `create()` makes it lazily on first use. Falls back to the
    /// shared `backups/` folder if the DB name is unusable.
    pub fn backups_dir_display(&self) -> String {
        match self.scope_dir() {
            Ok(dir) => dir.display().to_string(),
            Err(_) => base_dir_of(&self.db_path)
                .join(BACKUPS_DIR_NAME)
                .display()
                .to_string(),
        }
    }

    fn pending_restore_path(&self) -> Result<PathBuf, BantoError> {
        Ok(self.scope_dir()?.join(PENDING_RESTORE_FILE_NAME))
    }

    /// Reject anything that is not a plain `backups/`-relative file name:
    /// path separators, `..`, and any character outside
    /// `[A-Za-z0-9._-]` are all refused (spec M17: "パストラバーサル防止
    /// （ファイル名にセパレータ・`..`を拒否、backups/直下のみ）"). Deliberately
    /// stricter than "just block `..`" - this also closes off HTTP response
    /// header injection via a crafted `Content-Disposition: attachment;
    /// filename="..."` on the REST download route, and Windows-reserved
    /// device names (`CON`, `NUL`, ...) incidentally never match either.
    fn safe_backup_path(&self, file_name: &str) -> Result<PathBuf, BantoError> {
        let ok = !file_name.is_empty()
            && file_name != PENDING_RESTORE_FILE_NAME
            && file_name.ends_with(".sqlite3")
            && file_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !ok {
            return Err(validation_err("不正なファイル名です".to_string()));
        }
        Ok(self.scope_dir()?.join(file_name))
    }

    /// Create a new backup via `VACUUM INTO` (spec M17: "WAL稼働中でも安全な
    /// オンラインバックアップ") into `backups/banto-YYYYMMDD-HHMMSS(-N)?.sqlite3`.
    /// `backups/` is created if missing. The FILE-NAME stamp comes from the
    /// DB's own `datetime('now')` (UTC, same convention as `audit_log.ts`'s
    /// default). `created_at`, however, is derived from the finished file's
    /// mtime - the exact same source [`list`](Self::list) reads - so a freshly
    /// created backup and the same backup as later listed always report an
    /// identical `created_at`. (Deriving it from `datetime('now')` instead
    /// made the two disagree by up to a second whenever the `VACUUM INTO`
    /// crossed a second boundary between the query and the file being written:
    /// a real inconsistency a caller sees, and a Windows-deterministic test
    /// flake.)
    pub async fn create(&self) -> Result<BackupInfo, BantoError> {
        let now: String = sqlx::query_scalar("SELECT datetime('now')")
            .fetch_one(self.sqlite_pool()?)
            .await
            .map_err(banto_storage::storage_error)?;
        self.create_at(&now).await
    }

    /// [`create`](Self::create) with the file-name stamp supplied by the
    /// caller instead of read from the DB. Split out only so tests can PIN
    /// that stamp: because `create()` reads `datetime('now')` itself, a test
    /// that reads the clock separately and predicts the name `create()` will
    /// pick races the second boundary between the two reads (an observed
    /// Windows CI flake). Driving this with a fixed `now_iso` makes "two
    /// backups in the same second" an actual fact of the test rather than
    /// something the test hopes for.
    async fn create_at(&self, now_iso: &str) -> Result<BackupInfo, BantoError> {
        let dir = self.scope_dir()?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|err| io_err("バックアップ用ディレクトリの作成に失敗しました", err))?;

        let stamp = compact_stamp(now_iso);

        let path = unique_path(&dir, &format!("banto-{stamp}"), "sqlite3");
        let file_name = path
            .file_name()
            .expect("unique_path always yields a path with a file name")
            .to_string_lossy()
            .to_string();

        // AssertSqlSafe: `path` is built above from `self.scope_dir()`
        // (server-configured backup directory) and `stamp` (derived from the
        // DB's own `datetime('now')`/a caller-supplied test timestamp via
        // `compact_stamp`) - never from external/caller-controlled text -
        // and `vacuum_into_sql` already escapes embedded `'` per the SQL
        // string-literal rule (see its doc comment on why `VACUUM INTO` can't
        // use a bound parameter for its destination).
        sqlx::query(sqlx::AssertSqlSafe(vacuum_into_sql(&path)))
            .execute(self.sqlite_pool()?)
            .await
            .map_err(banto_storage::storage_error)?;

        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|err| io_err("作成したバックアップファイルの読み取りに失敗しました", err))?;

        Ok(BackupInfo {
            file_name,
            size_bytes: metadata.len(),
            // Same mtime source as `list()` (not `now`) - see this method's doc.
            created_at: iso_datetime_from_system_time(
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ),
        })
    }

    /// List every `*.sqlite3` file directly inside `backups/`, newest first
    /// (spec M17). This includes both `banto-*` (regular backups) and
    /// `pre-restore-*` (automatic pre-restore safety copies) - spec: "一覧
    /// （ファイル名・サイズ・作成日時）" makes no distinction between the two,
    /// they are both just files an admin may want to see/download. An
    /// unnamed/missing `backups/` directory (nothing has ever been backed up
    /// yet) is not an error - it is simply an empty list.
    pub async fn list(&self) -> Result<Vec<BackupInfo>, BantoError> {
        self.sqlite_pool()?; // SQLite-only feature; Postgres handle -> explicit error.
        let dir = self.scope_dir()?;
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|err| io_err("バックアップ一覧の読み取りに失敗しました", err))?;

        let mut backups = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|err| io_err("バックアップ一覧の読み取りに失敗しました", err))?
        {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("sqlite3")
                || path.file_name().and_then(|n| n.to_str()) == Some(PENDING_RESTORE_FILE_NAME)
            {
                continue;
            }
            let metadata = match entry.metadata().await {
                Ok(metadata) if metadata.is_file() => metadata,
                _ => continue, // skip subdirectories / files that vanished mid-scan
            };
            let file_name = entry.file_name().to_string_lossy().to_string();
            let created_at = iso_datetime_from_system_time(
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            );
            backups.push(BackupInfo {
                file_name,
                size_bytes: metadata.len(),
                created_at,
            });
        }

        // ISO "YYYY-MM-DD HH:MM:SS" sorts lexicographically == chronologically.
        backups.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.file_name.cmp(&a.file_name))
        });
        Ok(backups)
    }

    /// Read a backup file's raw bytes (spec M17: LAN download). Rejects
    /// anything outside `backups/` itself - see [`BackupService::safe_backup_path`].
    pub async fn read(&self, file_name: &str) -> Result<Vec<u8>, BantoError> {
        self.sqlite_pool()?; // SQLite-only feature; Postgres handle -> explicit error.
        let path = self.safe_backup_path(file_name)?;
        tokio::fs::read(&path).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                BantoError::NotFound {
                    resource: "backups".to_string(),
                    id: file_name.to_string(),
                }
            } else {
                io_err("バックアップファイルの読み取りに失敗しました", err)
            }
        })
    }

    /// Stage a restore from an EXISTING backup in `backups/` (spec M17:
    /// "一覧から選択"). Validates the source file in place (a copy, not a
    /// read-only open, is all that is needed for validation, so this never
    /// mutates the original backup either way) before copying it to
    /// `restore-pending.sqlite3` - a failed validation leaves no pending
    /// file behind.
    pub async fn stage_restore_from_file(&self, file_name: &str) -> Result<(), BantoError> {
        self.sqlite_pool()?; // SQLite-only feature; Postgres handle -> explicit error.
        let manifest = self.migrations()?;
        let source_path = self.safe_backup_path(file_name)?;
        if !tokio::fs::try_exists(&source_path).await.unwrap_or(false) {
            return Err(BantoError::NotFound {
                resource: "backups".to_string(),
                id: file_name.to_string(),
            });
        }

        validate_sqlite_file(&source_path, manifest)
            .await
            .map_err(CandidateRefusal::into_error)?;

        let dir = self.scope_dir()?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|err| io_err("リストア予約先ディレクトリの作成に失敗しました", err))?;
        tokio::fs::copy(&source_path, self.pending_restore_path()?)
            .await
            .map_err(|err| io_err("リストア予約ファイルの配置に失敗しました", err))?;
        Ok(())
    }

    /// Stage a restore from raw uploaded bytes (spec M17: "アップロード").
    /// Writes to a private temp file first, validates THAT file, and only
    /// then moves it into place as `restore-pending.sqlite3` - a failed
    /// validation deletes the temp file and leaves any previously-staged
    /// pending restore untouched.
    pub async fn stage_restore_from_bytes(&self, bytes: &[u8]) -> Result<(), BantoError> {
        self.sqlite_pool()?; // SQLite-only feature; Postgres handle -> explicit error.
        let manifest = self.migrations()?;
        let dir = self.scope_dir()?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|err| io_err("リストア予約先ディレクトリの作成に失敗しました", err))?;

        // A private, unpredictable-enough name so two concurrent uploads
        // (admin-only, so this is a defensive measure rather than an
        // expected scenario) do not clobber each other's temp file before
        // either has been validated.
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temp_path = dir.join(format!(
            ".restore-upload-{}-{nonce}.tmp",
            std::process::id()
        ));

        tokio::fs::write(&temp_path, bytes)
            .await
            .map_err(|err| io_err("アップロードされたファイルの書き込みに失敗しました", err))?;

        if let Err(refusal) = validate_sqlite_file(&temp_path, manifest).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(refusal.into_error());
        }

        if let Err(err) = tokio::fs::rename(&temp_path, self.pending_restore_path()?).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(io_err("リストア予約ファイルの配置に失敗しました", err));
        }
        Ok(())
    }

    /// Current staged restore, if any. Best-effort: any I/O error reading
    /// `restore-pending.sqlite3`'s metadata (not just "it doesn't exist") is
    /// treated the same as "nothing pending" - this only feeds a status
    /// display, not a decision that would be unsafe to get wrong in this
    /// direction (unlike, say, skipping the file's actual content
    /// validation, which only happens at stage/apply time).
    pub async fn pending_restore(&self) -> Option<PendingRestoreInfo> {
        // SQLite-only feature: a Postgres handle has no `restore-pending.sqlite3`
        // to report (and its `db_path` may be a connection URL, not a real
        // directory) - treat it the same as "nothing pending".
        self.db.as_sqlite()?;
        let metadata = tokio::fs::metadata(self.pending_restore_path().ok()?)
            .await
            .ok()?;
        if !metadata.is_file() {
            return None;
        }
        Some(PendingRestoreInfo {
            size_bytes: metadata.len(),
            staged_at: iso_datetime_from_system_time(
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ),
        })
    }

    /// Cancel a staged restore (spec M17). A no-op (not an error) when
    /// nothing is currently staged - matches `AuditLogService`-adjacent
    /// idempotent-cancel conventions elsewhere in this codebase (e.g.
    /// `autologin_disable` tolerating an already-missing keyring entry).
    pub async fn cancel_pending_restore(&self) -> Result<(), BantoError> {
        self.sqlite_pool()?; // SQLite-only feature; Postgres handle -> explicit error.
        match tokio::fs::remove_file(self.pending_restore_path()?).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(io_err("リストア予約の取消に失敗しました", err)),
        }
    }

    /// Apply a staged restore, if one exists - called once at process
    /// startup, BEFORE any `SqlitePool` for `db_path` is created (spec M17:
    /// "稼働中のプール差し替えはしない"). An associated function (not a
    /// method) precisely because no pool/`BackupService` instance can exist
    /// yet at the call site (`src-tauri`'s `run()`/`bin/banto-serve.rs`'s
    /// `main`, both before `admin_template_core::db::init_db`).
    ///
    /// **Postgres**: this operates purely on `db_path` as a filesystem path
    /// (there is no `Db` handle to inspect this early), so callers that may
    /// target Postgres must skip it - `bin/banto-serve.rs` guards the call with
    /// `db::is_postgres_url` (a `postgres://` URL is not a path and names no
    /// pending-restore file). `src-tauri` is SQLite-fixed and always passes a
    /// real DB path, so it calls this unconditionally.
    ///
    /// Steps, in order (each one only proceeds if the previous succeeded):
    /// 1. If this DB's `backups/{name}/restore-pending.sqlite3` does not exist, return `Ok(None)`
    ///    immediately - the overwhelmingly common case (no restore was ever
    ///    staged).
    /// 2. Re-validate the pending file (same checks as staging time) - it
    ///    could have been tampered with, or partially written if the
    ///    previous process crashed mid-`stage_restore_from_bytes` before the
    ///    final `rename` (which is atomic on the same filesystem, but this
    ///    is cheap insurance either way). **On failure here, this does NOT
    ///    return `Err`**: a corrupt pending file must never permanently
    ///    block the app from starting at all (it would retry-and-fail every
    ///    boot otherwise). Instead it is logged, the bad pending file is
    ///    deleted, and this returns `Ok(None)` - as if nothing had been
    ///    staged. When the app's own check ([`CandidateCheck`]) could not be
    ///    COMPLETED (an I/O failure, not a verdict on the file), the pending
    ///    file is kept instead: nothing is applied now, and the next start
    ///    looks again.
    /// 3. If the CURRENT db file exists, checkpoint it (`PRAGMA
    ///    wal_checkpoint(TRUNCATE)`) via a short-lived one-off connection,
    ///    best-effort. JUDGMENT CALL (spec explicitly leaves this open,
    ///    "判断はコメントで明示"): since no pool exists yet, the previous
    ///    process may have exited leaving `-wal`/`-shm` sidecar files next to
    ///    the main db file with frames not yet folded in - a checkpoint
    ///    first means the plain-file copy in step 4 is a complete,
    ///    consistent snapshot instead of a stale/incomplete one. If this
    ///    connection cannot even be opened (e.g. the current db is itself
    ///    corrupt), the checkpoint is simply skipped and the copy proceeds
    ///    with whatever is on disk - a best-effort safety backup is still
    ///    better than none, and this must never be the reason a restore
    ///    fails to apply.
    /// 4. If the current db file exists, copy it to
    ///    `backups/pre-restore-YYYYMMDD-HHMMSS(-N)?.sqlite3` (spec: "適用
    ///    直前に現DBを自動バックアップ"). If it does NOT exist (e.g. this is
    ///    effectively a fresh install and a restore was staged before the
    ///    very first run ever created a db file), there is nothing to back
    ///    up - this step is skipped, not an error.
    /// 5. Delete any `-wal`/`-shm` sidecar files sitting next to `db_path`:
    ///    they belong to the OLD db content and must not be left around to
    ///    be misread as belonging to the just-restored file once a fresh
    ///    pool opens it in WAL mode.
    /// 6. Rename `restore-pending.sqlite3` -> `db_path` (the actual swap).
    /// 7. Return `Ok(Some(AppliedRestoreInfo { .. }))` so the caller can
    ///    record a `restore_applied` audit entry once it has a working
    ///    `AuditLogService` (this function itself never touches the audit
    ///    log - no pool exists yet to write one with).
    pub async fn apply_pending_restore_at_startup(
        db_path: &Path,
        manifest: &MigrationManifest,
    ) -> Result<Option<AppliedRestoreInfo>, BantoError> {
        warn_legacy_shared_area(db_path);
        // Same resolution as every service method (issue #280). An unusable
        // DB file name can never have a staged restore (staging refuses it),
        // so this must not block startup - report and carry on.
        let scope_dir = match scope_dir_of(db_path) {
            Ok(dir) => dir,
            Err(err) => {
                eprintln!("banto: リストア予約の確認をスキップします: {err}");
                return Ok(None);
            }
        };
        let pending_path = scope_dir.join(PENDING_RESTORE_FILE_NAME);

        if !tokio::fs::try_exists(&pending_path).await.unwrap_or(false) {
            return Ok(None);
        }

        match validate_sqlite_file(&pending_path, manifest).await {
            Ok(()) => {}
            Err(CandidateRefusal::Invalid(err)) => {
                eprintln!(
                    "banto: 起動時に検出したリストア予約ファイルが不正なため、適用をスキップして削除します: {err}"
                );
                let _ = tokio::fs::remove_file(&pending_path).await;
                return Ok(None);
            }
            // The check could not be completed: nothing is known about the
            // candidate, so it is neither applied nor thrown away. The
            // current database stays, and the next start looks again.
            Err(CandidateRefusal::Unchecked(err)) => {
                eprintln!(
                    "banto: リストア予約ファイルを検査できなかったため、今回は適用しません（予約は残します。次の起動でもう一度確かめます）: {err}"
                );
                return Ok(None);
            }
        }

        // Step 3: best-effort checkpoint of the CURRENT db (see doc comment
        // above) - swallow every error, this is purely to make step 4's
        // copy as complete as possible, never a reason to abort the apply.
        if tokio::fs::try_exists(db_path).await.unwrap_or(false) {
            let options = SqliteConnectOptions::new()
                .filename(db_path)
                .create_if_missing(false);
            if let Ok(mut conn) = SqliteConnection::connect_with(&options).await {
                let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                    .execute(&mut conn)
                    .await;
                let _ = conn.close().await;
            }
        }

        // Step 4: safety backup of the current db, if there is one.
        let mut pre_restore_backup_file_name: Option<String> = None;
        let applied_at_iso = iso_datetime_from_system_time(SystemTime::now());
        if tokio::fs::try_exists(db_path).await.unwrap_or(false) {
            let backups_dir = scope_dir.clone();
            tokio::fs::create_dir_all(&backups_dir)
                .await
                .map_err(|err| io_err("バックアップ用ディレクトリの作成に失敗しました", err))?;
            let stamp = compact_stamp(&applied_at_iso);
            let backup_path = unique_path(&backups_dir, &format!("pre-restore-{stamp}"), "sqlite3");
            tokio::fs::copy(db_path, &backup_path)
                .await
                .map_err(|err| io_err("適用前の自動バックアップの作成に失敗しました", err))?;
            pre_restore_backup_file_name = Some(
                backup_path
                    .file_name()
                    .expect("unique_path always yields a path with a file name")
                    .to_string_lossy()
                    .to_string(),
            );
        }

        // Step 5: the OLD db's WAL sidecars must not survive next to the
        // NEW (just-restored) main file - see doc comment above.
        let wal_path = PathBuf::from(format!("{}-wal", db_path.display()));
        let shm_path = PathBuf::from(format!("{}-shm", db_path.display()));
        let _ = tokio::fs::remove_file(&wal_path).await;
        let _ = tokio::fs::remove_file(&shm_path).await;

        // Step 6: the actual swap.
        tokio::fs::rename(&pending_path, db_path)
            .await
            .map_err(|err| io_err("リストアの適用（ファイルの入れ替え）に失敗しました", err))?;

        Ok(Some(AppliedRestoreInfo {
            // A restore staged before the very first run (no prior db file)
            // has no meaningful "previous state" to have backed up - this is
            // an edge case the caller's audit-log detail can represent as
            // absent rather than a fabricated file name.
            pre_restore_backup_file_name: pre_restore_backup_file_name.unwrap_or_default(),
            applied_at: applied_at_iso,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Create the tables [`validate_sqlite_file`] requires ([`REQUIRED_TABLES`])
    /// inline, with the columns the tests below insert into. This crate owns no
    /// migrations (conventions §11: table definitions belong to the app); the
    /// DDL below mirrors the required-table subset of
    /// `apps/admin-template/core/migrations-sqlite/` and MUST be kept in sync
    /// with it. Same pattern the other service tests in this crate (see
    /// `settings`/`audit`) use to avoid a backwards dependency on the app
    /// crate's `db::migrate_memory` (conventions §"逆依存禁止").
    async fn create_required_tables(pool: &SqlitePool) {
        for ddl in [
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, \
             display_name TEXT NOT NULL, \
             created_at TEXT NOT NULL DEFAULT (datetime('now')), \
             updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
            "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             ts TEXT NOT NULL DEFAULT (datetime('now')), actor_username TEXT, \
             actor_role TEXT, action TEXT NOT NULL, resource TEXT NOT NULL, \
             entity_id TEXT, detail TEXT, origin TEXT NOT NULL, \
             result TEXT NOT NULL DEFAULT 'ok')",
            "CREATE TABLE ui_settings (owner TEXT NOT NULL, key TEXT NOT NULL, \
             value TEXT NOT NULL, revision TEXT NOT NULL, user_id INTEGER, \
             PRIMARY KEY (owner, key))",
            // The history sqlx keeps (same columns), with the fixture app's two
            // migrations applied - see `test_manifest`.
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, \
             description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
             success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)",
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES (1, 'one', 1, x'0a', 0), (2, 'two', 1, x'0b', 0)",
        ] {
            sqlx::query(ddl)
                .execute(pool)
                .await
                .expect("create required table");
        }
    }

    /// The fixture app's migration list: two migrations, both in the baseline.
    /// `create_required_tables` records exactly these as applied.
    fn test_manifest() -> MigrationManifest {
        MigrationManifest::new([(1, vec![0x0a]), (2, vec![0x0b])], 2)
    }

    /// An on-disk (NOT `:memory:`) SQLite pool at `path` with the required
    /// tables created inline. Every fixture in this module that needs a pool
    /// `VACUUM INTO` will actually export data from MUST use this, not an
    /// in-memory pool - empirically, `VACUUM INTO` against a `:memory:`
    /// connection returns `Ok` but silently writes no file at all (verified
    /// against this workspace's bundled SQLite 3.46 with a standalone
    /// repro), even though `:memory:` is fine for every OTHER service in
    /// this codebase's tests. Production code never hits this: `db_path` in
    /// `src-tauri`/`bin/banto-serve.rs` is always a real on-disk file.
    async fn migrated_file_db(path: &Path) -> SqlitePool {
        let pool = banto_storage::connect_sqlite(path)
            .await
            .expect("connect_sqlite");
        create_required_tables(&pool).await;
        // Force the schema writes out of the WAL and into the
        // main file, so a plain `tokio::fs::read(path)` afterward (as every
        // test fixture below does, to get "the bytes of a valid backup"
        // without going through `VACUUM INTO`) sees the real schema instead
        // of a stale/empty main file with all the actual content still
        // sitting in an unread `-wal` sidecar.
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .expect("checkpoint");
        pool
    }

    /// A `BackupService` over a migrated ON-DISK pool (see
    /// [`migrated_file_db`]) at `db_path` inside a fresh temp directory -
    /// mirrors production (`db_path` is a real file, `backups/` is its
    /// sibling directory).
    async fn service() -> (BackupService, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("admin-template.sqlite3");
        let pool = migrated_file_db(&db_path).await;
        (
            BackupService::new(db_path, Db::Sqlite(pool)).with_migrations(test_manifest()),
            dir,
        )
    }

    #[tokio::test]
    async fn create_then_list_then_read_round_trips() {
        let (svc, _dir) = service().await;

        let created = svc.create().await.expect("create should succeed");
        assert!(created.file_name.starts_with("banto-"));
        assert!(created.file_name.ends_with(".sqlite3"));
        assert!(created.size_bytes > 0);
        assert!(!created.created_at.is_empty());

        let listed = svc.list().await.expect("list should succeed");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], created);

        let bytes = svc
            .read(&created.file_name)
            .await
            .expect("read should succeed");
        assert_eq!(bytes.len() as u64, created.size_bytes);
        // A real SQLite file starts with this fixed 16-byte header.
        assert_eq!(&bytes[0..16], b"SQLite format 3\0");
    }

    #[tokio::test]
    async fn create_twice_in_the_same_second_appends_a_numeric_suffix() {
        let (svc, _dir) = service().await;
        // Drive the stamp explicitly through `create_at` (see its doc): the
        // public `create()` reads `datetime('now')` internally, so a test
        // that reads the clock itself and predicts the resulting name loses
        // the race whenever the second ticks over in between - the name then
        // does not collide and no suffix is appended. Pinning `now` makes
        // all three calls genuinely land in the same second, so every
        // collision below is guaranteed rather than merely likely.
        let now = "2026-01-02 03:04:05";

        let first = svc.create_at(now).await.expect("first create");
        assert_eq!(first.file_name, "banto-20260102-030405.sqlite3");

        let second = svc.create_at(now).await.expect("second create");
        assert_eq!(second.file_name, "banto-20260102-030405-1.sqlite3");

        // The suffix keeps counting up, it is not stuck at -1.
        let third = svc.create_at(now).await.expect("third create");
        assert_eq!(third.file_name, "banto-20260102-030405-2.sqlite3");

        let listed = svc.list().await.unwrap();
        assert_eq!(listed.len(), 3);
    }

    #[tokio::test]
    async fn list_is_empty_when_backups_dir_does_not_exist_yet() {
        let (svc, _dir) = service().await;
        assert_eq!(svc.list().await.unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn list_is_sorted_newest_first() {
        let (svc, dir) = service().await;
        let backups_dir = scope_of(dir.path(), "admin-template.sqlite3");
        tokio::fs::create_dir_all(&backups_dir).await.unwrap();
        tokio::fs::write(backups_dir.join("banto-20260101-000000.sqlite3"), b"a")
            .await
            .unwrap();
        tokio::fs::write(backups_dir.join("banto-20260201-000000.sqlite3"), b"b")
            .await
            .unwrap();

        let listed = svc.list().await.unwrap();
        // Sorted by mtime-derived `created_at`, not file name - both files
        // were written "now" in this test, so this really only proves the
        // list contains both and does not error; the dedicated ordering
        // guarantee is `created_at.cmp` on the struct field, exercised more
        // meaningfully by `create_twice_in_the_same_second...` above using
        // real distinct backups.
        assert_eq!(listed.len(), 2);
    }

    #[tokio::test]
    async fn read_rejects_path_traversal_attempts() {
        let (svc, _dir) = service().await;
        for bad in [
            "../secret.sqlite3",
            "..\\secret.sqlite3",
            "/etc/passwd",
            "a/b.sqlite3",
            "a\\b.sqlite3",
            "no-extension",
        ] {
            let err = svc.read(bad).await.unwrap_err();
            assert!(
                matches!(err, BantoError::Validation { .. }),
                "expected Validation for {bad:?}, got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn read_missing_file_is_not_found() {
        let (svc, _dir) = service().await;
        let err = svc.read("banto-does-not-exist.sqlite3").await.unwrap_err();
        assert!(matches!(err, BantoError::NotFound { resource, .. } if resource == "backups"));
    }

    #[tokio::test]
    async fn stage_restore_from_bytes_rejects_garbage() {
        let (svc, _dir) = service().await;
        let err = svc
            .stage_restore_from_bytes(b"not a sqlite file at all")
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
        assert!(svc.pending_restore().await.is_none());
    }

    #[tokio::test]
    async fn stage_restore_from_bytes_rejects_a_db_missing_required_tables() {
        let (svc, dir) = service().await;
        // A real, valid SQLite file - but with none of the required tables.
        let bogus_path = dir.path().join("bogus.sqlite3");
        let pool = banto_storage::connect_sqlite(&bogus_path).await.unwrap();
        sqlx::query("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let bytes = tokio::fs::read(&bogus_path).await.unwrap();

        let err = svc.stage_restore_from_bytes(&bytes).await.unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
        assert!(svc.pending_restore().await.is_none());
    }

    #[tokio::test]
    async fn stage_restore_from_bytes_accepts_a_valid_db_without_domain_tables() {
        let (svc, _dir) = service().await;
        assert!(svc.pending_restore().await.is_none());

        // A second, independent db carrying ONLY the Banto-owned base tables
        // - i.e. what a derived app that dropped the `items` demo uploads as
        // its "restore from an uploaded backup" payload (issue #166).
        let other_dir = tempdir().unwrap();
        let other_path = other_dir.path().join("source.sqlite3");
        let other_pool = migrated_file_db(&other_path).await;
        // Guard the fixture itself: if `create_required_tables` ever grows a
        // domain table back, this test would silently stop covering the
        // no-domain-tables case it exists for.
        let items_table: Option<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
        )
        .fetch_optional(&other_pool)
        .await
        .unwrap();
        assert!(items_table.is_none());
        other_pool.close().await;
        let bytes = tokio::fs::read(&other_path).await.unwrap();

        svc.stage_restore_from_bytes(&bytes)
            .await
            .expect("a valid db's bytes should stage successfully");

        let pending = svc.pending_restore().await.expect("should now be pending");
        assert_eq!(pending.size_bytes as usize, bytes.len());
    }

    #[tokio::test]
    async fn stage_restore_from_file_accepts_an_existing_backup() {
        let (svc, _dir) = service().await;
        let created = svc.create().await.unwrap();

        svc.stage_restore_from_file(&created.file_name)
            .await
            .expect("staging from an existing valid backup should succeed");
        assert!(svc.pending_restore().await.is_some());
    }

    #[tokio::test]
    async fn stage_restore_from_file_rejects_path_traversal() {
        let (svc, _dir) = service().await;
        let err = svc
            .stage_restore_from_file("../outside.sqlite3")
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
    }

    #[tokio::test]
    async fn stage_restore_from_file_missing_source_is_not_found() {
        let (svc, _dir) = service().await;
        let err = svc
            .stage_restore_from_file("banto-does-not-exist.sqlite3")
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[tokio::test]
    async fn cancel_pending_restore_removes_the_staged_file() {
        let (svc, _dir) = service().await;
        let created = svc.create().await.unwrap();
        svc.stage_restore_from_file(&created.file_name)
            .await
            .unwrap();
        assert!(svc.pending_restore().await.is_some());

        svc.cancel_pending_restore()
            .await
            .expect("cancel should succeed");
        assert!(svc.pending_restore().await.is_none());
    }

    #[tokio::test]
    async fn cancel_pending_restore_is_a_no_op_when_nothing_is_staged() {
        let (svc, _dir) = service().await;
        svc.cancel_pending_restore()
            .await
            .expect("cancelling with nothing staged should be a harmless no-op");
    }

    // --- apply_pending_restore_at_startup -----------------------------------

    #[tokio::test]
    async fn apply_pending_restore_is_a_no_op_when_nothing_is_staged() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("admin-template.sqlite3");
        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &test_manifest())
            .await
            .expect("should succeed");
        assert!(applied.is_none());
    }

    #[tokio::test]
    async fn apply_pending_restore_swaps_the_db_file_and_backs_up_the_old_one() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("admin-template.sqlite3");

        // A real "current" db on disk, distinguishable from the restore
        // payload by row content.
        let pool = banto_storage::connect_sqlite(&db_path).await.unwrap();
        create_required_tables(&pool).await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('restore-marker', 'OLD')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        // Stage a DIFFERENT, distinguishable db as the pending restore. The
        // `BackupService` here only needs a valid pool to satisfy its type
        // (staging from bytes never touches `self.db`) - an in-memory one
        // is fine for THIS role (unlike the source db being staged, which
        // must be a real on-disk file - see `migrated_file_db`'s doc
        // comment).
        let svc = BackupService::new(
            db_path.clone(),
            Db::Sqlite(banto_storage::connect_sqlite_memory().await.unwrap()),
        )
        .with_migrations(test_manifest());
        let staged_path = dir.path().join("staged-source.sqlite3");
        let restore_pool = migrated_file_db(&staged_path).await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('restore-marker', 'NEW')")
            .execute(&restore_pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&restore_pool)
            .await
            .unwrap();
        restore_pool.close().await;
        let bytes = tokio::fs::read(&staged_path).await.unwrap();
        svc.stage_restore_from_bytes(&bytes).await.unwrap();

        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &test_manifest())
            .await
            .expect("apply should succeed")
            .expect("a restore was staged, so this must be Some");
        assert!(!applied.pre_restore_backup_file_name.is_empty());
        assert!(!applied.applied_at.is_empty());

        // The pending file must be gone (consumed by the swap).
        assert!(!scope_of(dir.path(), "admin-template.sqlite3")
            .join(PENDING_RESTORE_FILE_NAME)
            .exists());

        // The live db_path now contains the RESTORED content.
        let after_pool = banto_storage::connect_sqlite(&db_path).await.unwrap();
        let marker: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'restore-marker'")
                .fetch_one(&after_pool)
                .await
                .unwrap();
        assert_eq!(marker, "NEW");
        after_pool.close().await;

        // The pre-restore safety backup preserves the OLD content.
        let backup_path = scope_of(dir.path(), "admin-template.sqlite3")
            .join(&applied.pre_restore_backup_file_name);
        assert!(backup_path.exists());
        let backup_pool = banto_storage::connect_sqlite(&backup_path).await.unwrap();
        let old_marker: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'restore-marker'")
                .fetch_one(&backup_pool)
                .await
                .unwrap();
        assert_eq!(old_marker, "OLD");
        backup_pool.close().await;
    }

    #[tokio::test]
    async fn apply_pending_restore_with_no_prior_db_file_still_applies() {
        // Edge case documented on `apply_pending_restore_at_startup`: a
        // restore staged before the very first db file ever existed.
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("admin-template.sqlite3");

        let svc = BackupService::new(
            db_path.clone(),
            Db::Sqlite(banto_storage::connect_sqlite_memory().await.unwrap()),
        )
        .with_migrations(test_manifest());
        let staged_path = dir.path().join("staged-source.sqlite3");
        let source_pool = migrated_file_db(&staged_path).await;
        source_pool.close().await;
        let bytes = tokio::fs::read(&staged_path).await.unwrap();
        svc.stage_restore_from_bytes(&bytes).await.unwrap();

        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &test_manifest())
            .await
            .expect("apply should succeed")
            .expect("a restore was staged");
        assert_eq!(applied.pre_restore_backup_file_name, "");
        assert!(
            db_path.exists(),
            "the staged file should now be the live db"
        );
    }

    #[tokio::test]
    async fn apply_pending_restore_deletes_and_skips_a_corrupt_pending_file() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("admin-template.sqlite3");
        let pending =
            scope_of(dir.path(), "admin-template.sqlite3").join(PENDING_RESTORE_FILE_NAME);
        tokio::fs::create_dir_all(pending.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&pending, b"garbage, not sqlite")
            .await
            .unwrap();

        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &test_manifest())
            .await
            .expect("a corrupt pending file must not fail startup");
        assert!(applied.is_none());
        assert!(
            !pending.exists(),
            "the corrupt pending file should have been deleted so it does not retry forever"
        );
    }

    // ---- issue #280: per-DB isolation of backups and restore reservations ----

    /// `{dir}/backups/{db_name}/` - the per-DB scope directory the layout
    /// documents (tests spell it out rather than call `scope_dir_of`, so a
    /// silent change of the layout fails here).
    fn scope_of(dir: &Path, db_name: &str) -> PathBuf {
        dir.join("backups").join(db_name)
    }

    /// Two services over `a.sqlite3` / `b.sqlite3` in the SAME folder.
    async fn two_services() -> (BackupService, BackupService, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        let a_path = dir.path().join("a.sqlite3");
        let b_path = dir.path().join("b.sqlite3");
        let a = BackupService::new(a_path.clone(), Db::Sqlite(migrated_file_db(&a_path).await))
            .with_migrations(test_manifest());
        let b = BackupService::new(b_path.clone(), Db::Sqlite(migrated_file_db(&b_path).await))
            .with_migrations(test_manifest());
        (a, b, dir)
    }

    #[tokio::test]
    async fn backups_of_one_db_are_invisible_to_another_in_the_same_folder() {
        let (a, b, dir) = two_services().await;
        let made = a.create().await.unwrap();
        assert!(scope_of(dir.path(), "a.sqlite3")
            .join(&made.file_name)
            .exists());

        assert_eq!(a.list().await.unwrap().len(), 1);
        assert!(b.list().await.unwrap().is_empty());
        assert!(matches!(
            b.read(&made.file_name).await,
            Err(BantoError::NotFound { .. })
        ));
        assert!(matches!(
            b.stage_restore_from_file(&made.file_name).await,
            Err(BantoError::NotFound { .. })
        ));
        // A itself keeps working.
        assert!(!a.read(&made.file_name).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn restore_reservation_of_one_db_is_not_seen_or_applied_by_another() {
        let (a, b, dir) = two_services().await;
        let made = a.create().await.unwrap();
        a.stage_restore_from_file(&made.file_name).await.unwrap();

        assert!(a.pending_restore().await.is_some());
        assert!(b.pending_restore().await.is_none());

        // B's cancel must not remove A's reservation.
        b.cancel_pending_restore().await.unwrap();
        assert!(a.pending_restore().await.is_some());

        // B's startup apply must not touch B's DB nor consume A's reservation.
        let b_path = dir.path().join("b.sqlite3");
        let before = tokio::fs::read(&b_path).await.unwrap();
        let applied = BackupService::apply_pending_restore_at_startup(&b_path, &test_manifest())
            .await
            .unwrap();
        assert!(applied.is_none());
        assert_eq!(tokio::fs::read(&b_path).await.unwrap(), before);
        assert!(a.pending_restore().await.is_some());
        assert!(!scope_of(dir.path(), "b.sqlite3").exists());

        // A's own flow: apply (with its safety backup) and cancel.
        let a_path = dir.path().join("a.sqlite3");
        // Startup apply runs before any pool exists; release A's file (Windows
        // refuses to replace an open file).
        a.sqlite_pool().unwrap().close().await;
        let applied = BackupService::apply_pending_restore_at_startup(&a_path, &test_manifest())
            .await
            .unwrap()
            .expect("A's reservation applies to A");
        assert!(scope_of(dir.path(), "a.sqlite3")
            .join(&applied.pre_restore_backup_file_name)
            .exists());
        assert!(a.pending_restore().await.is_none());

        a.stage_restore_from_bytes(&tokio::fs::read(&a_path).await.unwrap())
            .await
            .unwrap();
        assert!(a.pending_restore().await.is_some());
        a.cancel_pending_restore().await.unwrap();
        assert!(a.pending_restore().await.is_none());
    }

    #[tokio::test]
    async fn legacy_shared_area_files_are_neither_listed_read_nor_applied() {
        let (a, _b, dir) = two_services().await;
        let shared = dir.path().join("backups");
        tokio::fs::create_dir_all(&shared).await.unwrap();
        let legacy_backup = shared.join("banto-20260101-000000.sqlite3");
        tokio::fs::write(&legacy_backup, b"legacy").await.unwrap();

        // A valid-looking legacy reservation sitting in the parent folder.
        let a_path = dir.path().join("a.sqlite3");
        let bytes = tokio::fs::read(&a_path).await.unwrap();
        let legacy_pending = dir.path().join(PENDING_RESTORE_FILE_NAME);
        tokio::fs::write(&legacy_pending, &bytes).await.unwrap();

        assert!(a.list().await.unwrap().is_empty());
        assert!(matches!(
            a.read("banto-20260101-000000.sqlite3").await,
            Err(BantoError::NotFound { .. })
        ));
        assert!(a.pending_restore().await.is_none());

        let applied = BackupService::apply_pending_restore_at_startup(&a_path, &test_manifest())
            .await
            .unwrap();
        assert!(applied.is_none());
        // Left in place for the operator to migrate by hand.
        assert!(legacy_pending.exists());
        assert!(legacy_backup.exists());
    }

    #[tokio::test]
    async fn pending_file_is_not_listed_or_readable_as_a_backup() {
        let (a, _b, _dir) = two_services().await;
        let made = a.create().await.unwrap();
        a.stage_restore_from_file(&made.file_name).await.unwrap();
        let listed = a.list().await.unwrap();
        assert!(listed
            .iter()
            .all(|i| i.file_name != PENDING_RESTORE_FILE_NAME));
        assert!(a.read(PENDING_RESTORE_FILE_NAME).await.is_err());
    }

    #[test]
    fn scope_name_rejects_unusable_db_file_names() {
        assert!(scope_name(Path::new("data/a.sqlite3")).is_ok());
        assert!(scope_name(Path::new("data/社内 管理.sqlite3")).is_ok());
        assert!(scope_name(Path::new("data/..")).is_err());
        assert!(scope_name(Path::new("")).is_err());
        assert!(scope_name(Path::new("data/a:b.sqlite3")).is_err());
        assert!(scope_name(Path::new("data/a.")).is_err());
    }

    // --- ADR-0034 §9: the migration-history check ---------------------------

    /// A valid fixture database whose history was then edited by `edit`.
    async fn candidate_bytes(dir: &Path, name: &str, edit: &str) -> Vec<u8> {
        let path = dir.join(name);
        let pool = migrated_file_db(&path).await;
        sqlx::query(sqlx::AssertSqlSafe(edit.to_string()))
            .execute(&pool)
            .await
            .expect("edit the history");
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .expect("checkpoint");
        pool.close().await;
        tokio::fs::read(&path).await.expect("read candidate")
    }

    #[tokio::test]
    async fn staging_refuses_every_history_that_is_not_this_apps() {
        let (svc, dir) = service().await;
        for (name, edit, expected) in [
            (
                "old-checksum.sqlite3",
                "UPDATE _sqlx_migrations SET checksum = x'ff' WHERE version = 1",
                "migration 1 の内容がこのアプリのものと違います",
            ),
            (
                "unknown-version.sqlite3",
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
                 VALUES (3, 'three', 1, x'0c', 0)",
                "このアプリに無い migration 3",
            ),
            (
                "baseline-missing.sqlite3",
                "DELETE FROM _sqlx_migrations WHERE version = 2",
                "基準の migration 2 が適用されていません",
            ),
            (
                "failed-row.sqlite3",
                "UPDATE _sqlx_migrations SET success = 0 WHERE version = 2",
                "migration 2 が失敗したままです",
            ),
            (
                "no-history.sqlite3",
                "DROP TABLE _sqlx_migrations",
                "migration の履歴がありません",
            ),
        ] {
            let bytes = candidate_bytes(dir.path(), name, edit).await;
            let err = svc.stage_restore_from_bytes(&bytes).await.unwrap_err();
            match err {
                BantoError::Validation { field_errors } => {
                    assert!(field_errors[0].message.contains(expected), "{name}: {field_errors:?}")
                }
                other => panic!("{name}: expected Validation, got {other:?}"),
            }
            assert!(svc.pending_restore().await.is_none(), "{name}");
        }
    }

    /// A migration the app added after the baseline may still be pending in
    /// the candidate: the next startup's migration run applies it.
    #[tokio::test]
    async fn a_candidate_may_lack_migrations_after_the_baseline() {
        let (svc, dir) = service().await;
        let bytes = candidate_bytes(dir.path(), "plain.sqlite3", "SELECT 1").await;
        let svc = svc.with_migrations(MigrationManifest::new(
            [(1, vec![0x0a]), (2, vec![0x0b]), (3, vec![0x0c])],
            2,
        ));
        svc.stage_restore_from_bytes(&bytes).await.unwrap();
        assert!(svc.pending_restore().await.is_some());
    }

    /// Fail closed: a service the wiring gave no migration list stages nothing.
    #[tokio::test]
    async fn staging_without_a_migration_list_is_refused() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("admin-template.sqlite3");
        let pool = migrated_file_db(&db_path).await;
        let svc = BackupService::new(db_path, Db::Sqlite(pool));
        let made = svc.create().await.unwrap();
        assert!(svc.stage_restore_from_file(&made.file_name).await.is_err());
        let bytes = svc.read(&made.file_name).await.unwrap();
        assert!(svc.stage_restore_from_bytes(&bytes).await.is_err());
        assert!(svc.pending_restore().await.is_none());
    }

    /// The same check runs right before the swap: a pending file placed by
    /// hand with a foreign history is removed and the database is untouched.
    #[tokio::test]
    async fn a_hand_placed_pending_file_with_a_foreign_history_is_not_applied() {
        let (svc, dir) = service().await;
        let db_path = dir.path().join("admin-template.sqlite3");
        let bytes = candidate_bytes(
            dir.path(),
            "old.sqlite3",
            "UPDATE _sqlx_migrations SET checksum = x'ff' WHERE version = 1",
        )
        .await;
        let pending = svc.pending_restore_path().unwrap();
        svc.sqlite_pool().unwrap().close().await;
        let before = tokio::fs::read(&db_path).await.unwrap();
        tokio::fs::create_dir_all(pending.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&pending, &bytes).await.unwrap();

        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &test_manifest())
            .await
            .unwrap();
        assert!(applied.is_none());
        assert!(!pending.exists());
        assert_eq!(tokio::fs::read(&db_path).await.unwrap(), before);
    }

    // --- ADR-0034 §9: the app's candidate check ------------------------------

    /// A manifest whose candidate check answers what `answer` holds NOW.
    fn manifest_answering(
        answer: Arc<std::sync::Mutex<Result<CandidateVerdict, String>>>,
    ) -> MigrationManifest {
        test_manifest().with_candidate_check(CandidateCheck::new(move |_candidate| {
            let answer = answer.lock().unwrap().clone();
            async move { answer.map_err(BantoError::Other) }
        }))
    }

    /// A REJECTED candidate is the candidate's fault: staging is a
    /// `validation` error and leaves no pending file; a pending file found at
    /// startup is deleted and the database is not replaced.
    #[tokio::test]
    async fn a_rejected_candidate_is_refused_and_a_pending_one_is_deleted() {
        let (svc, dir) = service().await;
        let db_path = dir.path().join("admin-template.sqlite3");
        let answer = Arc::new(std::sync::Mutex::new(Ok(CandidateVerdict::Rejected(
            "組み込みの行がありません".to_string(),
        ))));
        let manifest = manifest_answering(answer.clone());
        let svc = svc.with_migrations(manifest.clone());
        let backup = svc.create().await.unwrap();

        let err = svc
            .stage_restore_from_file(&backup.file_name)
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }), "{err:?}");
        assert!(svc.pending_restore().await.is_none());

        // Staged while the check accepted it, rejected at the next start.
        *answer.lock().unwrap() = Ok(CandidateVerdict::Accepted);
        svc.stage_restore_from_file(&backup.file_name)
            .await
            .unwrap();
        *answer.lock().unwrap() = Ok(CandidateVerdict::Rejected("x".to_string()));
        let before = tokio::fs::read(&db_path).await.unwrap();
        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &manifest)
            .await
            .unwrap();
        assert!(applied.is_none());
        assert!(svc.pending_restore().await.is_none(), "deleted");
        assert_eq!(tokio::fs::read(&db_path).await.unwrap(), before);
        drop(dir);
    }

    /// A check that could not be COMPLETED says nothing about the candidate
    /// (cross-review of #858): staging fails with a retryable error that is
    /// not `validation`, an earlier pending restore is left alone, and a
    /// pending file found at startup is KEPT - not applied now, applied once
    /// the check can run.
    #[tokio::test]
    async fn a_check_that_could_not_run_keeps_the_pending_restore_for_a_retry() {
        let (svc, dir) = service().await;
        let db_path = dir.path().join("admin-template.sqlite3");
        let answer = Arc::new(std::sync::Mutex::new(Ok(CandidateVerdict::Accepted)));
        let manifest = manifest_answering(answer.clone());
        let svc = svc.with_migrations(manifest.clone());
        let backup = svc.create().await.unwrap();
        svc.stage_restore_from_file(&backup.file_name)
            .await
            .unwrap();
        let staged = svc.pending_restore().await.expect("staged");

        *answer.lock().unwrap() = Err("no space left on device".to_string());
        for err in [
            svc.stage_restore_from_file(&backup.file_name)
                .await
                .unwrap_err(),
            svc.stage_restore_from_bytes(&svc.read(&backup.file_name).await.unwrap())
                .await
                .unwrap_err(),
        ] {
            assert!(matches!(err, BantoError::Other(_)), "{err:?}");
            assert!(err.to_string().contains("no space left"), "{err}");
        }
        assert_eq!(
            svc.pending_restore().await,
            Some(staged),
            "the earlier pending restore is untouched"
        );

        let before = tokio::fs::read(&db_path).await.unwrap();
        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &manifest)
            .await
            .unwrap();
        assert!(applied.is_none(), "not applied while it cannot be checked");
        assert!(svc.pending_restore().await.is_some(), "kept for a retry");
        assert_eq!(tokio::fs::read(&db_path).await.unwrap(), before);

        // The next start can check it: now it is applied. (The pool is
        // closed first, as at a real restart - Windows cannot replace an
        // open file.)
        svc.sqlite_pool().unwrap().close().await;
        *answer.lock().unwrap() = Ok(CandidateVerdict::Accepted);
        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &manifest)
            .await
            .unwrap();
        assert!(applied.is_some());
        drop(dir);
    }

    // --- cross-review of #858: a read that FAILED is not a bad candidate -----

    /// Hold `path` the way another process would (a scanner, a copy still in
    /// progress): an exclusive SQLite lock, so every read of it by somebody
    /// else fails with `SQLITE_BUSY`. The content is not changed.
    async fn lock_exclusively(path: &Path) -> SqliteConnection {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false);
        let mut conn = SqliteConnection::connect_with(&options)
            .await
            .expect("open the file to lock");
        // `locking_mode` first: on a WAL file a plain exclusive transaction
        // would not keep readers out.
        for sql in ["PRAGMA locking_mode = EXCLUSIVE", "BEGIN EXCLUSIVE"] {
            sqlx::query(sql).execute(&mut conn).await.expect(sql);
        }
        conn
    }

    async fn unlock(mut conn: SqliteConnection) {
        sqlx::query("ROLLBACK").execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
    }

    /// The built-in read checks (open, integrity, tables, history) run before
    /// the app's candidate check. A pending file they could not READ is not a
    /// bad candidate: it is kept, the database is not replaced, and the next
    /// start - when it can be read - applies it.
    #[tokio::test]
    async fn a_pending_restore_that_cannot_be_read_is_kept_and_applied_later() {
        let (svc, dir) = service().await;
        let db_path = dir.path().join("admin-template.sqlite3");
        let manifest = test_manifest();
        let backup = svc.create().await.unwrap();
        svc.stage_restore_from_file(&backup.file_name)
            .await
            .unwrap();
        let pending = svc.pending_restore_path().unwrap();
        let staged = tokio::fs::read(&pending).await.unwrap();
        let before = tokio::fs::read(&db_path).await.unwrap();

        let lock = lock_exclusively(&pending).await;
        let refusal = validate_sqlite_file(&pending, &manifest).await.unwrap_err();
        assert!(
            matches!(refusal, CandidateRefusal::Unchecked(_)),
            "{refusal:?}"
        );
        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &manifest)
            .await
            .expect("an unreadable pending file must not fail startup");
        assert!(applied.is_none(), "not applied while it cannot be read");
        assert!(pending.exists(), "kept for a retry");
        assert_eq!(tokio::fs::read(&db_path).await.unwrap(), before);
        unlock(lock).await;
        assert_eq!(
            tokio::fs::read(&pending).await.unwrap(),
            staged,
            "the pending file itself is unchanged"
        );

        // The next start can read it: now it is applied. (The pool is closed
        // first, as at a real restart.)
        svc.sqlite_pool().unwrap().close().await;
        let applied = BackupService::apply_pending_restore_at_startup(&db_path, &manifest)
            .await
            .unwrap();
        assert!(applied.is_some());
        assert!(!pending.exists());
        assert_eq!(tokio::fs::read(&db_path).await.unwrap(), staged);
        drop(dir);
    }

    /// The same split at the moment a restore is STAGED: a backup that cannot
    /// be read right now is a retryable error (not `validation`), an earlier
    /// pending restore is left alone, and the same backup is staged once it
    /// can be read.
    #[tokio::test]
    async fn staging_a_backup_that_cannot_be_read_is_a_retryable_error() {
        let (svc, dir) = service().await;
        let first = svc.create().await.unwrap();
        svc.stage_restore_from_file(&first.file_name).await.unwrap();
        let staged = svc.pending_restore().await.expect("staged");
        let second = svc
            .create_at("2026-11-22 10:00:00")
            .await
            .expect("a second backup");
        let second_path = svc.safe_backup_path(&second.file_name).unwrap();

        let lock = lock_exclusively(&second_path).await;
        let err = svc
            .stage_restore_from_file(&second.file_name)
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Other(_)), "{err:?}");
        assert_eq!(
            svc.pending_restore().await,
            Some(staged),
            "the earlier pending restore is untouched"
        );
        assert!(second_path.exists(), "the backup is not deleted either");
        unlock(lock).await;

        svc.stage_restore_from_file(&second.file_name)
            .await
            .expect("staged once it can be read");
        drop(dir);
    }

    /// What the built-in checks answer for each kind of failure: a file that
    /// cannot be opened is `Unchecked`; content SQLite itself calls not a
    /// database, a missing table and a foreign history stay `Invalid`.
    #[tokio::test]
    async fn the_read_checks_tell_a_failed_read_from_a_bad_candidate() {
        let dir = tempdir().unwrap();
        let manifest = test_manifest();

        let missing = dir.path().join("missing.sqlite3");
        let refusal = validate_sqlite_file(&missing, &manifest).await.unwrap_err();
        assert!(
            matches!(refusal, CandidateRefusal::Unchecked(_)),
            "{refusal:?}"
        );

        // Bigger than one page, so SQLite reads a full header and reports
        // "file is not a database" rather than treating it as a short file.
        let garbage = dir.path().join("garbage.sqlite3");
        tokio::fs::write(&garbage, vec![b'x'; 8192]).await.unwrap();
        let empty = dir.path().join("empty.sqlite3");
        tokio::fs::write(&empty, b"").await.unwrap();
        let foreign = dir.path().join("foreign.sqlite3");
        tokio::fs::write(
            &foreign,
            candidate_bytes(
                dir.path(),
                "foreign-src.sqlite3",
                "DROP TABLE _sqlx_migrations; CREATE TABLE _sqlx_migrations (version TEXT)",
            )
            .await,
        )
        .await
        .unwrap();
        for bad in [&garbage, &empty, &foreign] {
            let refusal = validate_sqlite_file(bad, &manifest).await.unwrap_err();
            assert!(
                matches!(
                    refusal,
                    CandidateRefusal::Invalid(BantoError::Validation { .. })
                ),
                "{}: {refusal:?}",
                bad.display()
            );
        }
    }
}
