//! Per-owner UI settings on SQLite (Issue #786,
//! downstream-requests-2026-11-plan §4.4): the shared conditional-write
//! cases on two separate pools of one database file with the real
//! migrations, plus what only SQLite has - the per-connection foreign-key
//! switch (plan §9) and backup / restore. The PostgreSQL run of the shared
//! cases is in `pg_smoke.rs`.

mod ui_settings_cases;

use admin_template_core::backup::BackupService;
use admin_template_core::db::{init_db, sqlite_migration_manifest};
use admin_template_core::settings::SettingsService;
use admin_template_core::ui_settings::{UiSettingsOwner, UI_SETTING_ABSENT_REVISION};
use admin_template_core::users::{Role, UsersService};
use banto_core::BantoError;

async fn account_rows(db: &banto_storage::Db) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM ui_settings WHERE user_id IS NOT NULL")
        .fetch_one(db.as_sqlite().unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn conditional_writes_hold_across_connections_on_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("admin-template.sqlite3");
    // Two pools on the same file: no statement of one shares a connection
    // with a statement of the other.
    let first = init_db(&path).await.unwrap();
    let second = init_db(&path).await.unwrap();
    let a = SettingsService::new(first.clone());
    let b = SettingsService::new(second.clone());
    let users = UsersService::new(first.clone());

    ui_settings_cases::run_all(&a, &b, &users).await;

    assert_eq!(account_rows(&first).await, 0, "a row outlived its account");
    first.as_sqlite().unwrap().close().await;
    second.as_sqlite().unwrap().close().await;
}

/// Plan §9 "SQLite の外部キーが全部の接続で有効か": SQLite enforces foreign
/// keys per CONNECTION, so one pooled connection without the switch would
/// let an orphan row in. Hold several connections of the pool at once and
/// check each, then write through each.
#[tokio::test]
async fn foreign_keys_are_enforced_on_every_pooled_connection() {
    let dir = tempfile::tempdir().unwrap();
    let db = init_db(dir.path().join("admin-template.sqlite3"))
        .await
        .unwrap();
    let pool = db.as_sqlite().unwrap();

    let mut held = Vec::new();
    for _ in 0..6 {
        held.push(pool.acquire().await.unwrap());
    }
    for (index, connection) in held.iter_mut().enumerate() {
        let on: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut **connection)
            .await
            .unwrap();
        assert_eq!(on, 1, "connection {index} does not enforce foreign keys");
        let orphan = sqlx::query(
            "INSERT INTO ui_settings (owner, key, value, revision, user_id) \
             VALUES ('acct:9000000042', 'k', 'v', 'r', 9000000042)",
        )
        .execute(&mut **connection)
        .await;
        let refused = orphan
            .as_ref()
            .err()
            .and_then(|err| err.as_database_error())
            .is_some_and(|err| err.is_foreign_key_violation());
        assert!(refused, "connection {index}: {orphan:?}");
    }
    drop(held);
    assert_eq!(account_rows(&db).await, 0);
    pool.close().await;
}

/// Plan §4.4: a revision is random, so one obtained AFTER a backup was taken
/// does not match anything in the restored database - not the row as it was
/// in the backup, not a row written after the restore. (A counter would come
/// back to the same number, and the open tab would overwrite a different
/// value.) A revision read BEFORE the backup came back together with its
/// value, and still passes.
#[tokio::test]
async fn a_revision_from_after_the_backup_conflicts_after_the_restore() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("admin-template.sqlite3");
    let db = init_db(&db_path).await.unwrap();
    let users = UsersService::new(db.clone());
    let kept = users
        .create_user("kept", "restore-case-pw", "Kept", Role::Admin)
        .await
        .unwrap();
    let owner = UiSettingsOwner::Account(kept.id);
    let settings = SettingsService::new(db.clone());

    let in_backup = settings
        .ui_put(&owner, "dashboard.memo", "in the backup", None)
        .await
        .unwrap();
    let backup = BackupService::new(db_path.clone(), db.clone())
        .with_migrations(sqlite_migration_manifest());
    let info = backup.create().await.unwrap();

    // After the backup: one row changes, one row is created. A tab reads both.
    let after_backup = settings
        .ui_put(
            &owner,
            "dashboard.memo",
            "after the backup",
            Some(&in_backup.revision),
        )
        .await
        .unwrap();
    let created_after = settings
        .ui_put(
            &owner,
            "dock.dashboard",
            "created after the backup",
            Some(UI_SETTING_ABSENT_REVISION),
        )
        .await
        .unwrap();

    // Restore.
    backup
        .stage_restore_from_file(&info.file_name)
        .await
        .unwrap();
    db.as_sqlite().unwrap().close().await;
    drop((settings, users, backup, db));
    BackupService::apply_pending_restore_at_startup(&db_path, &sqlite_migration_manifest())
        .await
        .unwrap()
        .expect("the staged restore is applied");
    let restored = init_db(&db_path).await.unwrap();
    let settings = SettingsService::new(restored.clone());

    // The tab's revisions are from after the backup: neither passes.
    let stale = settings
        .ui_put(
            &owner,
            "dashboard.memo",
            "from the tab",
            Some(&after_backup.revision),
        )
        .await;
    match stale {
        Err(BantoError::Conflict { current, .. }) => assert_eq!(
            current.unwrap(),
            serde_json::json!({ "value": "in the backup", "revision": in_backup.revision })
        ),
        other => panic!("expected Conflict, got {other:?}"),
    }
    let gone = settings
        .ui_put(
            &owner,
            "dock.dashboard",
            "from the tab",
            Some(&created_after.revision),
        )
        .await;
    match gone {
        Err(BantoError::Conflict { current, .. }) => assert_eq!(
            current.unwrap(),
            serde_json::json!({ "value": null, "revision": "0" })
        ),
        other => panic!("expected Conflict, got {other:?}"),
    }
    // ...also once the row exists again.
    let recreated = settings
        .ui_put(
            &owner,
            "dock.dashboard",
            "written after the restore",
            Some(UI_SETTING_ABSENT_REVISION),
        )
        .await
        .unwrap();
    assert_ne!(recreated.revision, created_after.revision);
    assert!(matches!(
        settings
            .ui_put(
                &owner,
                "dock.dashboard",
                "from the tab",
                Some(&created_after.revision)
            )
            .await,
        Err(BantoError::Conflict { .. })
    ));

    // The revision that was in the backup is the restored row's: it passes.
    settings
        .ui_put(
            &owner,
            "dashboard.memo",
            "same row",
            Some(&in_backup.revision),
        )
        .await
        .unwrap();
    restored.as_sqlite().unwrap().close().await;
}
