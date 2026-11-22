//! The first administrator of a headless install, and the way back into a
//! database that cannot start (ADR-0034 §7): create an administrator account
//! and require login, in one transaction.
//!
//! A new database starts in no-login mode with no account. The desktop app
//! enters it with the local session and creates accounts from user
//! management. `banto-serve` has no local session - in no-login mode the REST
//! side is read-only and logs nobody in (ADR-0034 §6) - so its first
//! administrator is created here, offline, by someone who can reach the
//! database: `banto-serve create-admin`. Never over the network.
//!
//! The same call repairs a database the startup check refuses for its auth
//! settings (`auth.disabled` missing or unreadable, login required with no
//! administrator): it runs BEFORE that check and leaves the mode
//! login-required with an administrator that can log in.
//!
//! This lives in the core crate, as one function, so `banto-serve` only
//! parses arguments. The desktop executable does not carry it (ADR-0034 §7);
//! a derived app may call it from an executable of its own.

use std::path::Path;

use banto_core::BantoError;
use banto_storage::Db;

use crate::audit::{AuditEntry, ACTOR_KIND_CLI};
use crate::backup::BackupService;
use crate::first_boot::FIRST_BOOT_SETTINGS;
use crate::settings::SettingsService;
use crate::users::{user_create_detail, Role, UserIdentity, UsersService, BUILTIN_ADMIN_USERNAME};

/// `origin` of the audit rows this module writes.
const ORIGIN_CLI: &str = "cli";

/// The account to create. The password is never taken from a command line
/// (process lists and shell histories keep those): `banto-serve` reads it from
/// standard input.
#[derive(Clone, Copy)]
pub struct NewAdmin<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub display_name: &'a str,
}

/// What [`create_admin_and_require_login`] did.
#[derive(Debug, Clone)]
pub struct CreatedAdmin {
    pub user: UserIdentity,
    /// The first-boot seed was written by this call (the database had never
    /// been started).
    pub seeded: bool,
}

/// Create an administrator account on the database `target` names (a SQLite
/// path or a `postgres://` URL - `BANTO_DB`'s value) and require login.
///
/// Order (ADR-0034 §5/§7):
///
/// 1. A staged restore stops it, with nothing written. Applying it would
///    throw away what the operator asked for here; ignoring it would let the
///    next start apply it and throw away the account and the lock-down. The
///    operator decides which comes first.
/// 2. The migrations (the same call a start makes), so a new database works.
/// 3. ONE transaction ([`create_admin_and_require_login_on`]).
///
/// Run it with the app and the server stopped: a running process keeps its
/// sessions in memory, and nothing here can end them.
pub async fn create_admin_and_require_login(
    target: &str,
    admin: NewAdmin<'_>,
) -> Result<CreatedAdmin, BantoError> {
    if !crate::db::is_postgres_url(target) {
        refuse_a_pending_restore(Path::new(target))?;
    }
    let db = crate::db::init_db_from_target(target).await?;
    let result = create_admin_and_require_login_on(&db, FIRST_BOOT_SETTINGS, admin).await;
    // Close before the process (or a test) moves on: Windows keeps an open
    // SQLite file locked.
    if let Some(pool) = db.as_sqlite() {
        pool.close().await;
    }
    result
}

/// The staged restore of the SQLite database at `db_path`, if there is one, as
/// the error that stops the CLI (ADR-0034 §7). The file is only looked for -
/// never opened, applied or removed.
fn refuse_a_pending_restore(db_path: &Path) -> Result<(), BantoError> {
    let pending = BackupService::pending_restore_file(db_path)?;
    match pending.try_exists() {
        Ok(false) => Ok(()),
        Ok(true) => Err(BantoError::Other(format!(
            "予約されたリストアがあります（{}）。何も変更していません。\
             先にリストアを適用する（アプリまたはサーバーを一度起動する）か、\
             このファイルを消してから、もう一度実行してください",
            pending.display()
        ))),
        Err(err) => Err(BantoError::Other(format!(
            "予約されたリストアの有無を確かめられませんでした（{}）: {err}。何も変更していません",
            pending.display()
        ))),
    }
}

// The transaction of `create_admin_and_require_login_on`, expanded for each
// backend without a generic SQL layer.
macro_rules! in_one_transaction {
    ($tx:ident, $users:expr, $seed:expr, $admin:expr,
     seed: $seed_fn:path, create: $create:ident, require_login: $require_login:path,
     record: $record:path) => {{
        // 1. The first-boot seed, when this database has never started. It
        //    must come first: written later (by the next start), it would put
        //    a preset's `auth.disabled = true` back over the lock-down below.
        let seeded = $seed_fn(&mut $tx, $seed).await?;
        // 2. The account, through the same validation as user management.
        let user = $users
            .$create(
                &mut $tx,
                $admin.username,
                $admin.password,
                $admin.display_name,
                Role::Admin,
            )
            .await?;
        // 3. Require login. The same key the seed may have just written: the
        //    later write wins, the seed's other keys stay.
        $require_login(&mut $tx).await?;
        // 4. The audit rows, as the built-in `admin` acting through the CLI.
        //    Found by `kind`; a database without the row (edited directly) is
        //    not this call's to repair - the rows then carry no id, and the
        //    next start refuses the database for it.
        let builtin_admin_id: Option<i64> =
            sqlx::query_scalar("SELECT id FROM users WHERE kind = 'builtin' ORDER BY id LIMIT 1")
                .fetch_optional(&mut *$tx)
                .await
                .map_err(banto_storage::storage_error)?;
        let entity_id = user.id.to_string();
        let entry = |action: &'static str, resource: &'static str| AuditEntry {
            actor_username: Some(BUILTIN_ADMIN_USERNAME),
            actor_id: builtin_admin_id,
            actor_role: Some(Role::Admin.as_str()),
            actor_kind: Some(ACTOR_KIND_CLI),
            action,
            resource,
            entity_id: None,
            detail: None,
            origin: ORIGIN_CLI,
            result: "ok",
        };
        $record(
            &mut $tx,
            &AuditEntry {
                entity_id: Some(&entity_id),
                detail: Some(user_create_detail(&user)),
                ..entry("create", "users")
            },
        )
        .await?;
        $record(
            &mut $tx,
            &AuditEntry {
                detail: Some(serde_json::json!({ "authDisabled": false })),
                ..entry("settings_change", "settings")
            },
        )
        .await?;
        $tx.commit().await.map_err(banto_storage::storage_error)?;
        Ok(CreatedAdmin { user, seeded })
    }};
}

/// The one transaction (ADR-0034 §7), on a database whose migrations have
/// run: the first-boot seed and its marker when the database has none yet
/// (the same function a start uses, with `seed` - the app's
/// `FIRST_BOOT_SETTINGS`), the administrator account, `auth.disabled = false`,
/// and the audit rows. Any failure leaves nothing: no account, no lock-down,
/// no seed marker - the next start, or the next run of this, seeds.
///
/// There is deliberately no "account only" and no "lock-down only": neither
/// half is a state the app should be left in. On a database that already
/// requires login, the mode is rewritten with the same value (the recovery
/// use).
pub async fn create_admin_and_require_login_on(
    db: &Db,
    seed: &[(&str, &str)],
    admin: NewAdmin<'_>,
) -> Result<CreatedAdmin, BantoError> {
    let settings = SettingsService::new(db.clone());
    // The same reserved names as the running app (ADR-0034 §4).
    let users = UsersService::new(db.clone())
        .with_reserved_usernames(crate::startup::reserved_usernames(&settings));
    match db {
        Db::Sqlite(pool) => {
            // BEGIN IMMEDIATE: a write from the first statement.
            let mut tx = pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(banto_storage::storage_error)?;
            in_one_transaction!(
                tx, users, seed, admin,
                seed: crate::settings::seed_first_boot_sqlite,
                create: create_user_on_sqlite,
                require_login: crate::settings::require_login_on_sqlite,
                record: crate::audit::record_on_sqlite
            )
        }
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => {
            let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
            in_one_transaction!(
                tx, users, seed, admin,
                seed: crate::settings::seed_first_boot_postgres,
                create: create_user_on_postgres,
                require_login: crate::settings::require_login_on_postgres,
                record: crate::audit::record_on_postgres
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::startup::{self, Wiring};

    const OWNER: NewAdmin<'static> = NewAdmin {
        username: "owner",
        password: "password123",
        display_name: "オーナー",
    };

    /// What the display preset seeds (`scripts/scaffold.mjs`).
    const DISPLAY_SEED: &[(&str, &str)] = &[
        ("auth.disabled", "true"),
        ("auth.disabled_role", "viewer"),
        ("server.enabled", "true"),
        ("server.bind", "0.0.0.0"),
        ("server.viewer_public", "true"),
    ];

    async fn count(db: &Db, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(db.as_sqlite().unwrap())
            .await
            .unwrap()
    }

    /// ADR-0034 §10 "ヘッドレスの道筋": a new database does not start headless,
    /// the CLI creates the account, the lock-down and the audit rows at once,
    /// and then it starts and the account logs in.
    #[tokio::test]
    async fn a_new_database_gets_its_first_admin_and_requires_login() {
        let db = crate::db::migrate_memory().await.unwrap();
        let headless = Wiring::Headless {
            viewer_public_forced: false,
        };
        let err = startup::check(&db, headless).await.unwrap_err();
        assert!(err.to_string().contains("create-admin"), "{err}");

        let created = create_admin_and_require_login_on(&db, &[], OWNER)
            .await
            .unwrap();
        assert!(created.seeded, "never started: the marker is taken here");
        assert_eq!(created.user.role, Role::Admin);

        let started = startup::check(&db, headless).await.unwrap();
        assert!(!started.auth.disabled);
        let users = UsersService::new(db.clone());
        assert!(users
            .verify("owner", "password123")
            .await
            .unwrap()
            .is_some());

        // The two rows, as the built-in `admin` through the CLI.
        let rows: Vec<(String, String, Option<i64>, String, String, String)> = sqlx::query_as(
            "SELECT action, resource, actor_id, actor_username, actor_kind, origin \
             FROM audit_log ORDER BY id",
        )
        .fetch_all(db.as_sqlite().unwrap())
        .await
        .unwrap();
        let builtin = started.users.builtin_admin_id;
        assert_eq!(
            rows,
            vec![
                (
                    "create".to_string(),
                    "users".to_string(),
                    Some(builtin),
                    "admin".to_string(),
                    "cli".to_string(),
                    "cli".to_string()
                ),
                (
                    "settings_change".to_string(),
                    "settings".to_string(),
                    Some(builtin),
                    "admin".to_string(),
                    "cli".to_string(),
                    "cli".to_string()
                ),
            ]
        );
        // No secret in the trail.
        let details: Vec<Option<String>> = sqlx::query_scalar("SELECT detail FROM audit_log")
            .fetch_all(db.as_sqlite().unwrap())
            .await
            .unwrap();
        assert!(details.iter().flatten().all(|d| !d.contains("password123")));
    }

    /// ADR-0034 §10 "起動より先の CLI と初回の seed" (the display preset): on a
    /// database that has never started, the CLI seeds first, so the next
    /// start does not put the preset's `auth.disabled = true` back over the
    /// lock-down - and the preset's other keys are there.
    #[tokio::test]
    async fn the_cli_before_the_first_start_keeps_the_lock_down_over_the_seed() {
        let db = crate::db::migrate_memory().await.unwrap();
        let settings = SettingsService::new(db.clone());
        let created = create_admin_and_require_login_on(&db, DISPLAY_SEED, OWNER)
            .await
            .unwrap();
        assert!(created.seeded);

        // The next start: its seed finds the marker and writes nothing.
        assert!(!settings.seed_first_boot(DISPLAY_SEED).await.unwrap());
        let started = startup::check(
            &db,
            Wiring::Headless {
                viewer_public_forced: false,
            },
        )
        .await
        .unwrap();
        assert!(!started.auth.disabled, "the lock-down stayed");
        let server = settings.server_config().await.unwrap();
        assert!(server.viewer_public && server.enabled);
        assert_eq!(server.bind, "0.0.0.0");
        assert!(UsersService::new(db.clone())
            .verify("owner", "password123")
            .await
            .unwrap()
            .is_some());

        // On a started database the CLI seeds nothing (a second admin).
        let second = create_admin_and_require_login_on(
            &db,
            DISPLAY_SEED,
            NewAdmin {
                username: "second",
                ..OWNER
            },
        )
        .await
        .unwrap();
        assert!(!second.seeded);
        assert!(!settings.auth_config().await.unwrap().disabled);
    }

    /// A failure part-way leaves nothing: no account, no lock-down, no seed
    /// marker, no audit row (ADR-0034 §7).
    #[tokio::test]
    async fn a_failed_run_leaves_nothing_behind() {
        let db = crate::db::migrate_memory().await.unwrap();
        let settings = SettingsService::new(db.clone());
        for bad in [
            // Reserved (ADR-0034 §4): refused after the seed was written.
            NewAdmin {
                username: "Admin",
                ..OWNER
            },
            NewAdmin {
                username: "public",
                ..OWNER
            },
            NewAdmin {
                password: "short",
                ..OWNER
            },
        ] {
            let err = create_admin_and_require_login_on(&db, DISPLAY_SEED, bad)
                .await
                .unwrap_err();
            assert!(matches!(err, BantoError::Validation { .. }), "{err}");
        }
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM users WHERE kind = 'account'").await,
            0
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM audit_log").await, 0);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM settings WHERE key = 'first_boot.seeded'"
            )
            .await,
            0,
            "the marker went with the rollback"
        );
        let auth = settings.auth_config().await.unwrap();
        assert!(auth.disabled, "still the migration's no-login default");
        assert_eq!(auth.disabled_role, Role::Admin, "the seed's role is gone");
        assert!(!settings.server_config().await.unwrap().viewer_public);

        // The next run seeds and succeeds.
        let created = create_admin_and_require_login_on(&db, DISPLAY_SEED, OWNER)
            .await
            .unwrap();
        assert!(created.seeded);
    }

    /// ADR-0034 §10 "設定の異常": the databases a start refuses for their auth
    /// settings are repaired by the CLI.
    #[tokio::test]
    async fn the_cli_repairs_a_database_the_startup_refuses() {
        for breakage in [
            "DELETE FROM settings WHERE key = 'auth.disabled'",
            "UPDATE settings SET value = 'maybe' WHERE key = 'auth.disabled'",
            "DELETE FROM settings WHERE key = 'auth.disabled_role'",
            "UPDATE settings SET value = 'root' WHERE key = 'auth.disabled_role'",
            // Login required, no administrator.
            "UPDATE settings SET value = 'false' WHERE key = 'auth.disabled'",
        ] {
            let db = crate::db::migrate_memory().await.unwrap();
            sqlx::query(breakage)
                .execute(db.as_sqlite().unwrap())
                .await
                .unwrap();
            for wiring in [
                Wiring::Desktop,
                Wiring::Headless {
                    viewer_public_forced: true,
                },
            ] {
                startup::check(&db, wiring)
                    .await
                    .expect_err(&format!("{breakage} / {wiring:?}"));
            }
            create_admin_and_require_login_on(&db, &[], OWNER)
                .await
                .unwrap();
            for wiring in [
                Wiring::Desktop,
                Wiring::Headless {
                    viewer_public_forced: false,
                },
            ] {
                let started = startup::check(&db, wiring)
                    .await
                    .unwrap_or_else(|err| panic!("{breakage} / {wiring:?}: {err}"));
                assert!(!started.auth.disabled);
            }
        }
    }

    /// ADR-0034 §10 "CLI と予約された復元": with a staged restore the CLI
    /// writes nothing and says so; the pending file and the database are
    /// untouched. Without one, the same call works on a new file.
    #[tokio::test]
    async fn a_pending_restore_stops_the_cli_with_nothing_written() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.sqlite3");
        let target = db_path.to_str().unwrap();
        // A started database (so the file exists and can be compared).
        let db = crate::db::init_db(&db_path).await.unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(db.as_sqlite().unwrap())
            .await
            .unwrap();
        db.as_sqlite().unwrap().close().await;
        let before = tokio::fs::read(&db_path).await.unwrap();

        let pending = BackupService::pending_restore_file(&db_path).unwrap();
        tokio::fs::create_dir_all(pending.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&pending, b"a staged restore")
            .await
            .unwrap();

        let err = create_admin_and_require_login(target, OWNER)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("予約されたリストア"), "{err}");
        assert_eq!(tokio::fs::read(&db_path).await.unwrap(), before);
        assert_eq!(
            tokio::fs::read(&pending).await.unwrap(),
            b"a staged restore"
        );

        tokio::fs::remove_file(&pending).await.unwrap();
        let created = create_admin_and_require_login(target, OWNER).await.unwrap();
        assert_eq!(created.user.username, "owner");
    }

    /// ADR-0034 §10 (C2b, 3): a new FILE, never started - CLI, then a start
    /// (migrations, seed, check), then the account logs in.
    #[tokio::test]
    async fn cli_then_start_then_login_on_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("fresh.sqlite3");
        create_admin_and_require_login(db_path.to_str().unwrap(), OWNER)
            .await
            .unwrap();

        let db = crate::db::init_db(&db_path).await.unwrap();
        let settings = SettingsService::new(db.clone());
        assert!(
            !crate::first_boot::seed_first_boot_settings(&settings)
                .await
                .unwrap(),
            "the start does not seed again"
        );
        let started = startup::check(
            &db,
            Wiring::Headless {
                viewer_public_forced: false,
            },
        )
        .await
        .unwrap();
        assert!(!started.auth.disabled);
        assert!(UsersService::new(db.clone())
            .verify("owner", "password123")
            .await
            .unwrap()
            .is_some());
        db.as_sqlite().unwrap().close().await;
    }
}
