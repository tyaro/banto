//! The checks that stop a startup, and the same checks run on a restore
//! candidate before it is swapped in (ADR-0034 §2/§4/§9).
//!
//! Both entry points - `bin/banto-serve.rs` and `src-tauri`'s `run()` - call
//! [`check`] once the migrations and the first-boot seed have run. A database
//! that fails it is refused with a message that names the cause; nothing is
//! repaired silently.
//!
//! A restore replaces the database file across a restart, so a backup that
//! fails the same checks would leave an app that cannot boot - with the good
//! database already gone. [`sqlite_restore_manifest`] therefore hands the
//! restore validation this module's [`check`] too: it runs when a restore is
//! staged and again right before the swap, and a refused candidate leaves the
//! current database untouched.
//!
//! A PR that adds a startup-stopping condition adds it to [`check`] - one
//! function, so the two places cannot drift (ADR-0034 §9).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use banto_core::BantoError;
use banto_storage::Db;

use crate::backup::{CandidateCheck, CandidateVerdict, MigrationManifest};
use crate::settings::SettingsService;
use crate::users::{ReservedUsernames, StartupUsers, UsersService};

/// The account names this app reserves on top of the built-in `admin`
/// (ADR-0034 §4): the fixed identity id of every grant it registers
/// ([`crate::rest::grant_registry`] - the one list both servers issue from).
/// A derived app that adds a grant there reserves its id here without
/// touching this function.
pub fn reserved_usernames(settings: &SettingsService) -> ReservedUsernames {
    ReservedUsernames::new(crate::rest::grant_registry(settings.clone()).identity_ids())
}

/// Everything that must hold for this app to start on `db` (read-only):
///
/// - exactly one built-in `admin` row (ADR-0034 §2);
/// - no account named like a reserved name - the built-in `admin` or a
///   grant's fixed id, ignoring case (ADR-0034 §4). Creating one is refused,
///   so this finds only an account that existed before a grant with the same
///   fixed id was added to the app.
///
/// Returns what the wiring needs afterwards: the built-in row's id, for
/// `AuthState::with_builtin_admin_id` and the desktop commands' audit actor.
pub async fn check(db: &Db) -> Result<StartupUsers, BantoError> {
    let settings = SettingsService::new(db.clone());
    UsersService::new(db.clone())
        .with_reserved_usernames(reserved_usernames(&settings))
        .check_startup()
        .await
}

/// [`crate::db::sqlite_migration_manifest`] plus [`check`] as the candidate
/// check (ADR-0034 §9): what both entry points pass to
/// `BackupService::with_migrations` and `apply_pending_restore_at_startup`.
pub fn sqlite_restore_manifest() -> MigrationManifest {
    crate::db::sqlite_migration_manifest()
        .with_candidate_check(CandidateCheck::new(check_restore_candidate))
}

/// Run [`check`] on a restore candidate the way the next startup would see
/// it: on a COPY, after the migrations. A candidate may lack migrations a
/// derived app added after the baseline (the restore validation allows
/// that); the startup applies them before it checks, so this does too. The
/// candidate itself is never opened for writing, and the copy is deleted
/// whatever the outcome.
///
/// The answer separates the two ways this can end without an acceptance
/// (see [`CandidateCheck`]): `Rejected` when the CANDIDATE would not start
/// (a migration fails on it, or [`check`] refuses it), `Err` when the check
/// itself could not be completed (the copy could not be made or opened, a
/// read failed) - which says nothing about the candidate.
async fn check_restore_candidate(candidate: PathBuf) -> Result<CandidateVerdict, BantoError> {
    let copy = working_copy_path(&candidate);
    let result = match tokio::fs::copy(&candidate, &copy).await {
        Ok(_) => check_working_copy(&copy).await,
        Err(err) => Err(BantoError::Other(format!(
            "リストア候補の検査用コピーを作れませんでした: {err}"
        ))),
    };
    // Whatever happened - a copy that stopped half-way included.
    for path in [copy.clone(), sidecar(&copy, "-wal"), sidecar(&copy, "-shm")] {
        let _ = tokio::fs::remove_file(path).await;
    }
    result
}

async fn check_working_copy(copy: &Path) -> Result<CandidateVerdict, BantoError> {
    let db = Db::connect_sqlite(copy).await?;
    let result = match crate::db::migrate(&db).await {
        Ok(()) => verdict_of(check(&db).await.map(|_| ())),
        // A migration that does not apply to the candidate is the
        // candidate's problem (ADR-0034 §9).
        Err(err) => Ok(CandidateVerdict::Rejected(err.to_string())),
    };
    // Close before the caller deletes the file (Windows keeps an open SQLite
    // file locked).
    if let Some(pool) = db.as_sqlite() {
        pool.close().await;
    }
    result
}

/// [`check`]'s result as a verdict: a storage error means the database could
/// not be READ (the check is incomplete); every other refusal is a finding
/// about its content.
fn verdict_of(result: Result<(), BantoError>) -> Result<CandidateVerdict, BantoError> {
    match result {
        Ok(()) => Ok(CandidateVerdict::Accepted),
        Err(err @ BantoError::Storage(_)) => Err(err),
        Err(err) => Ok(CandidateVerdict::Rejected(err.to_string())),
    }
}

fn working_copy_path(candidate: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!(".restore-check-{}-{nonce}.tmp", std::process::id());
    match candidate.parent() {
        Some(dir) => dir.join(name),
        None => PathBuf::from(name),
    }
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::BackupService;
    use crate::users::Role;

    async fn migrated(path: &Path) -> Db {
        let db = Db::connect_sqlite(path).await.unwrap();
        crate::db::migrate(&db).await.unwrap();
        db
    }

    async fn close(db: Db) {
        db.as_sqlite().unwrap().close().await;
    }

    async fn exec(db: &Db, sql: &'static str) {
        sqlx::query(sql)
            .execute(db.as_sqlite().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_new_database_passes_and_reports_the_builtin_row() {
        let db = crate::db::migrate_memory().await.unwrap();
        let found = check(&db).await.unwrap();
        let id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE kind = 'builtin'")
            .fetch_one(db.as_sqlite().unwrap())
            .await
            .unwrap();
        assert_eq!(found.builtin_admin_id, id);
    }

    #[tokio::test]
    async fn a_database_without_the_builtin_row_is_refused() {
        let db = crate::db::migrate_memory().await.unwrap();
        exec(&db, "DELETE FROM users WHERE kind = 'builtin'").await;
        let err = check(&db).await.unwrap_err();
        assert!(err.to_string().contains("組み込みのユーザー"), "{err}");
    }

    /// The template's one grant is viewer-public, fixed id `public`: an
    /// account of that name (any case) that predates the reservation stops
    /// the startup, and the message names it.
    #[tokio::test]
    async fn an_account_named_like_a_grant_id_is_refused() {
        let db = crate::db::migrate_memory().await.unwrap();
        // What `create_user` now refuses: written the way an older version
        // (or a derived app before it added the grant) would have left it.
        exec(
            &db,
            "INSERT INTO users (username, password_hash, display_name, role, account_uid) \
             VALUES ('Public', 'x', 'p', 'viewer', 'uid-1')",
        )
        .await;
        let err = check(&db).await.unwrap_err();
        assert!(err.to_string().contains("Public"), "{err}");

        let users = UsersService::new(db.clone())
            .with_reserved_usernames(reserved_usernames(&SettingsService::new(db.clone())));
        for name in ["public", "PUBLIC", "Admin"] {
            let err = users
                .create_user(name, "password123", "x", Role::Viewer)
                .await
                .unwrap_err();
            assert!(
                matches!(err, BantoError::Validation { .. }),
                "{name}: {err}"
            );
        }
    }

    /// ADR-0034 §9 regression: a v8 candidate whose history and
    /// `integrity_check` are fine but which would stop the startup is refused
    /// when staged AND right before the swap, the current database's bytes do
    /// not change, and the app still starts on it afterwards.
    #[tokio::test]
    async fn a_candidate_that_could_not_start_is_refused_before_the_swap() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.sqlite3");
        let db = migrated(&db_path).await;
        let backup = BackupService::new(db_path.clone(), db.clone())
            .with_migrations(sqlite_restore_manifest());

        for (label, breakage) in [
            ("no builtin row", "DELETE FROM users WHERE kind = 'builtin'"),
            (
                "a builtin row that is not admin",
                "UPDATE users SET username = 'root' WHERE kind = 'builtin'",
            ),
            (
                "a builtin row whose role is not admin",
                "UPDATE users SET role = 'viewer' WHERE kind = 'builtin'",
            ),
            (
                "an account named like a grant id",
                "INSERT INTO users (username, password_hash, display_name, role, account_uid) \
                 VALUES ('public', 'x', 'p', 'viewer', 'uid-1')",
            ),
        ] {
            let candidate_path = dir.path().join("candidate.sqlite3");
            let candidate = migrated(&candidate_path).await;
            exec(&candidate, breakage).await;
            exec(&candidate, "PRAGMA wal_checkpoint(TRUNCATE)").await;
            close(candidate).await;
            let bytes = tokio::fs::read(&candidate_path).await.unwrap();
            tokio::fs::remove_file(&candidate_path).await.unwrap();

            // (1) Staging refuses it and leaves no pending file.
            let err = backup.stage_restore_from_bytes(&bytes).await.unwrap_err();
            assert!(
                matches!(err, BantoError::Validation { .. }),
                "{label}: {err}"
            );
            assert!(backup.pending_restore().await.is_none(), "{label}");

            // (2) Placed by hand as the pending file (the offline recovery
            // path): the startup does not apply it and the database is
            // byte-identical.
            let pending = dir
                .path()
                .join("backups")
                .join("app.sqlite3")
                .join("restore-pending.sqlite3");
            tokio::fs::create_dir_all(pending.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(&pending, &bytes).await.unwrap();
            exec(&db, "PRAGMA wal_checkpoint(TRUNCATE)").await;
            let before = tokio::fs::read(&db_path).await.unwrap();
            let applied = BackupService::apply_pending_restore_at_startup(
                &db_path,
                &sqlite_restore_manifest(),
            )
            .await
            .unwrap();
            assert!(applied.is_none(), "{label}");
            assert!(
                !pending.exists(),
                "{label}: the bad pending file is removed"
            );
            assert_eq!(tokio::fs::read(&db_path).await.unwrap(), before, "{label}");

            // No working copy is left behind.
            let mut entries = tokio::fs::read_dir(pending.parent().unwrap())
                .await
                .unwrap();
            while let Some(entry) = entries.next_entry().await.unwrap() {
                let name = entry.file_name().to_string_lossy().to_string();
                assert!(!name.starts_with(".restore-check-"), "{label}: {name}");
            }
        }

        // (3) The current database still passes the startup check.
        check(&db).await.unwrap();
        close(db).await;
    }

    /// A storage error is "could not look", not a finding about the candidate.
    #[test]
    fn only_a_content_finding_rejects_the_candidate() {
        assert_eq!(verdict_of(Ok(())).unwrap(), CandidateVerdict::Accepted);
        assert_eq!(
            verdict_of(Err(BantoError::Other("組み込みの行がありません".into()))).unwrap(),
            CandidateVerdict::Rejected("組み込みの行がありません".into())
        );
        assert!(matches!(
            verdict_of(Err(BantoError::Storage("disk I/O error".into()))),
            Err(BantoError::Storage(_))
        ));
    }

    /// A candidate that cannot be copied is not judged: `Err`, not a
    /// rejection, and no working copy is left behind.
    #[tokio::test]
    async fn a_candidate_that_cannot_be_copied_is_not_judged() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone.sqlite3");
        assert!(check_restore_candidate(missing).await.is_err());
        let mut entries = tokio::fs::read_dir(dir.path()).await.unwrap();
        assert!(entries.next_entry().await.unwrap().is_none());
    }

    /// The same check accepts a healthy candidate, and the swap goes through.
    #[tokio::test]
    async fn a_healthy_candidate_is_staged_and_applied() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.sqlite3");
        let db = migrated(&db_path).await;
        let backup = BackupService::new(db_path.clone(), db.clone())
            .with_migrations(sqlite_restore_manifest());
        let info = backup.create().await.unwrap();
        backup
            .stage_restore_from_file(&info.file_name)
            .await
            .unwrap();
        assert!(backup.pending_restore().await.is_some());
        close(db).await;

        let applied =
            BackupService::apply_pending_restore_at_startup(&db_path, &sqlite_restore_manifest())
                .await
                .unwrap();
        assert!(applied.is_some());
        let db = migrated(&db_path).await;
        check(&db).await.unwrap();
        close(db).await;
    }
}
