//! Where attachment bodies live on disk for a given DB connection target
//! (Issue #208).
//!
//! Before #208 every caller derived the directory as
//! `Path::new(db_target).parent().join("attachments")` regardless of the
//! backend. That is right for a SQLite file (the directory sits next to the
//! DB file, spec `docs/attachments-plan.md` §3.3), but a PostgreSQL
//! connection URL is not a path: the "parent" of
//! `postgres://user:pass@host:5432/banto_a` is `postgres://user:pass@host:5432`,
//! so
//! - two databases on the same server (`/banto_a`, `/banto_b`) shared one
//!   directory, and since bodies are named only by the per-database row id,
//!   the second database's attachment `1` overwrote the first's;
//! - changing the password moved the directory, so the same database lost
//!   sight of its existing attachments;
//! - the connection credentials ended up inside a filesystem path.
//!
//! The rules now:
//! - **SQLite**: unchanged - `{db file's parent}/attachments`.
//! - **PostgreSQL**: an explicit root directory is REQUIRED (the caller reads
//!   it from its own configuration - `banto-serve` uses
//!   `BANTO_ATTACHMENTS_DIR`); there is deliberately no default, because the
//!   only thing a default could be derived from is the process's working
//!   directory, which is exactly the kind of silently-moving location this
//!   issue is about. Under the root, each database gets its own
//!   subdirectory named by [`postgres_storage_key`]: host + port + database
//!   name, never the user name or password. So two databases never share a
//!   directory, and rotating credentials does not move it.
//!
//! [`legacy_base_dir`] keeps the pre-#208 derivation, only so a caller can
//! find files written by an older version and hand them to
//! [`crate::AttachmentsService::import_legacy_files`].

use std::path::{Path, PathBuf};

use banto_core::BantoError;
#[cfg(feature = "postgres")]
use sha2::{Digest, Sha256};

/// Upper bound on the human-readable part of [`postgres_storage_key`], so a
/// long socket path / database name cannot push the directory name past
/// common filesystem limits (255 bytes). The hash suffix keeps keys distinct
/// even when two targets truncate to the same prefix.
#[cfg(feature = "postgres")]
const MAX_READABLE_KEY_LEN: usize = 80;

/// `{db file's parent}/attachments` - the SQLite layout (spec §3.3), falling
/// back to a relative `attachments` when the path has no parent. Identical to
/// the pre-#208 expression.
pub fn sqlite_base_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .map(|parent| parent.join("attachments"))
        .unwrap_or_else(|| PathBuf::from("attachments"))
}

/// The directory an older version derived from `db_target` - for a
/// PostgreSQL URL, a relative path that embeds the connection credentials.
/// Use it only to locate files to import; never store anything there.
pub fn legacy_base_dir(db_target: &str) -> PathBuf {
    sqlite_base_dir(Path::new(db_target))
}

/// Where attachment bodies for `db_target` belong.
///
/// - `is_postgres == false`: [`sqlite_base_dir`]; `postgres_root` is ignored
///   (the caller should tell the operator so, see `banto-serve`).
/// - `is_postgres == true`: `{postgres_root}/{postgres_storage_key(db_target)}`,
///   or an error if `postgres_root` is `None`.
///
/// The error messages never contain `db_target` (it carries credentials).
pub fn base_dir_for_target(
    db_target: &str,
    is_postgres: bool,
    postgres_root: Option<&Path>,
) -> Result<PathBuf, BantoError> {
    if !is_postgres {
        return Ok(sqlite_base_dir(Path::new(db_target)));
    }
    let Some(root) = postgres_root else {
        return Err(BantoError::Other(
            "PostgreSQL を使うときは添付ファイルの保存先を明示してください（banto-serve では環境変数 BANTO_ATTACHMENTS_DIR）"
                .to_string(),
        ));
    };
    Ok(root.join(postgres_storage_key(db_target)?))
}

/// A directory name that identifies one PostgreSQL database independently of
/// the credentials used to reach it: `pg_{host}_{port}_{database}` with
/// anything outside `[A-Za-z0-9_-]` replaced by `_` (dots too, so no part of
/// the name can read as `.`/`..`), followed by the first 16 hex digits of a
/// SHA-256 over the unsanitized parts (so sanitizing or truncating can never
/// make two databases collide).
///
/// Parsed with sqlx's own [`sqlx::postgres::PgConnectOptions`], so the parts
/// are exactly the ones the connection itself uses - including `?host=` /
/// `?port=` / `?dbname=` query parameters, Unix socket hosts, and the libpq
/// defaults (`PGHOST`/`PGPORT`/`PGDATABASE`). When the URL names no database,
/// PostgreSQL connects to the database named after the user, so that is the
/// database name used here too.
///
/// The host is lower-cased (DNS names are case-insensitive) but otherwise
/// taken as written: `localhost` and `127.0.0.1` are different keys. The
/// database name keeps its case (PostgreSQL identifiers can be
/// case-sensitive).
#[cfg(feature = "postgres")]
pub fn postgres_storage_key(url: &str) -> Result<String, BantoError> {
    use std::str::FromStr;

    // The sqlx error is dropped on purpose: parse errors may quote parts of
    // the URL.
    let options = sqlx::postgres::PgConnectOptions::from_str(url).map_err(|_| {
        BantoError::Other(
            "PostgreSQL の接続先を解釈できないため、添付ファイルの保存先を決められません"
                .to_string(),
        )
    })?;
    let host = match options.get_socket() {
        Some(socket) => socket.to_string_lossy().into_owned(),
        None => options.get_host().to_ascii_lowercase(),
    };
    let port = options.get_port();
    let database = options
        .get_database()
        .unwrap_or_else(|| options.get_username());

    let mut hasher = Sha256::new();
    // Length-prefixed so `("a_b", "c")` and `("a", "b_c")` hash differently.
    for part in [host.as_str(), &port.to_string(), database] {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let hash: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();

    let readable: String = format!("{host}_{port}_{database}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(MAX_READABLE_KEY_LEN)
        .collect();
    Ok(format!("pg_{readable}_{hash}"))
}

/// Without the `postgres` feature there is no PostgreSQL backend to store
/// attachments for; say so instead of guessing a directory.
#[cfg(not(feature = "postgres"))]
pub fn postgres_storage_key(_url: &str) -> Result<String, BantoError> {
    Err(BantoError::Other(
        "このビルドは PostgreSQL に対応していません（feature `postgres` が無効）".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_layout_is_unchanged() {
        // (db target, expected base dir) - the pre-#208 expression's results.
        let cases = [
            ("./banto-dev.sqlite3", PathBuf::from("./attachments")),
            ("banto.sqlite3", PathBuf::from("attachments")),
            (
                "/var/lib/banto/app.sqlite3",
                PathBuf::from("/var/lib/banto/attachments"),
            ),
            ("", PathBuf::from("attachments")),
        ];
        for (target, expected) in cases {
            assert_eq!(
                base_dir_for_target(target, false, None).unwrap(),
                expected,
                "target {target:?}"
            );
            // An explicit root does not move SQLite attachments.
            assert_eq!(
                base_dir_for_target(target, false, Some(Path::new("/elsewhere"))).unwrap(),
                expected,
                "target {target:?} with a root"
            );
            assert_eq!(legacy_base_dir(target), expected);
        }
    }

    #[test]
    fn postgres_without_a_root_is_an_error_that_does_not_leak_the_url() {
        let url = "postgres://someone:s3cret-pass@db.example:5432/banto_a";
        let err = base_dir_for_target(url, true, None).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("BANTO_ATTACHMENTS_DIR"), "{text}");
        assert!(!text.contains("s3cret-pass"), "{text}");
        assert!(!text.contains("someone"), "{text}");
    }

    #[cfg(feature = "postgres")]
    mod postgres {
        use super::*;

        fn key(url: &str) -> String {
            postgres_storage_key(url).unwrap()
        }

        #[test]
        fn different_databases_on_one_server_get_different_directories() {
            let root = Path::new("/srv/banto-attachments");
            let a = base_dir_for_target(
                "postgres://review_user:example_password@localhost:5432/banto_a",
                true,
                Some(root),
            )
            .unwrap();
            let b = base_dir_for_target(
                "postgres://review_user:example_password@localhost:5432/banto_b",
                true,
                Some(root),
            )
            .unwrap();
            assert_ne!(a, b);
            assert!(a.starts_with(root) && b.starts_with(root));
        }

        #[test]
        fn credentials_do_not_change_the_key() {
            let base = key("postgres://review_user:example_password@localhost:5432/banto_a");
            for same in [
                "postgres://review_user:rotated_password@localhost:5432/banto_a",
                "postgres://other_user:other@localhost:5432/banto_a",
                "postgres://localhost:5432/banto_a",
                "postgresql://review_user:example_password@LOCALHOST:5432/banto_a",
                "postgres://localhost:5432/banto_a?user=x&password=y",
                "postgres://localhost/banto_a",
            ] {
                assert_eq!(key(same), base, "{same}");
            }
        }

        #[test]
        fn host_port_and_database_each_change_the_key() {
            let base = key("postgres://u:p@localhost:5432/banto_a");
            for different in [
                "postgres://u:p@localhost:5432/banto_b",
                "postgres://u:p@localhost:5433/banto_a",
                "postgres://u:p@db.example:5432/banto_a",
                "postgres://u:p@localhost:5432/Banto_A",
                "postgres://u:p@localhost:5432/banto_a?port=6000",
                "postgres://u:p@localhost:5432/banto_a?dbname=other",
            ] {
                assert_ne!(key(different), base, "{different}");
            }
        }

        #[test]
        fn key_is_a_single_safe_path_component_without_credentials() {
            for url in [
                "postgres://review_user:example_password@localhost:5432/banto_a",
                "postgres://u:p%2Fq@[::1]:5432/we%20ird%2F..%5Cname",
                "postgres://u:p@localhost/banto?host=/var/run/postgresql",
                "postgres://u:p@localhost:5432/CON",
            ] {
                let k = key(url);
                assert!(k.starts_with("pg_"), "{k}");
                assert!(
                    k.chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')),
                    "{k}"
                );
                assert!(!k.contains(".."), "{k}");
                assert!(!k.contains("password") && !k.contains("review_user"), "{k}");
                assert_eq!(Path::new(&k).components().count(), 1, "{k}");
                assert!(k.len() <= 3 + MAX_READABLE_KEY_LEN + 1 + 16, "{k}");
            }
        }

        #[test]
        fn a_database_less_url_uses_the_user_named_database() {
            // PostgreSQL connects to the database named after the user.
            assert_eq!(
                key("postgres://banto:pw@localhost:5432"),
                key("postgres://other:pw@localhost:5432/banto")
            );
        }

        #[test]
        fn unparsable_url_is_an_error_that_does_not_leak_the_url() {
            let err = postgres_storage_key("postgres://u:s3cret@host:notaport/db").unwrap_err();
            assert!(!err.to_string().contains("s3cret"));
        }
    }
}
