//! App-layer PostgreSQL smoke test (V2 "PostgreSQL アプリ全体対応", PR3).
//!
//! This is the first place the whole app service stack is exercised against a
//! real PostgreSQL server: `init_db_from_target` runs `migrations-postgres` +
//! the demo seed, then the four core services (`items`/`users`/`settings`/
//! `audit`) perform representative CRUD. It proves the strict-typed Postgres
//! DDL and the service layer's Postgres enum-dispatch arms actually work
//! end-to-end - not just that they compile (which PR2 already guaranteed).
//!
//! Gated two ways so it never breaks a PostgreSQL-less build:
//! - The whole file is `#![cfg(feature = "postgres")]`, so a default
//!   (SQLite-only) build does not even compile it.
//! - At runtime it early-returns unless `BANTO_TEST_PG_URL` is set, so a local
//!   `cargo test --features postgres` with no server still passes. CI's
//!   `app-postgres` job sets the env var against a `postgres:16` service
//!   container (mirroring the existing `storage-postgres` job).
#![cfg(feature = "postgres")]

use admin_template_core::audit::{AuditEntry, AuditLogService};
use admin_template_core::backup::BackupService;
use admin_template_core::db::init_db_from_target;
use admin_template_core::items::{ItemInput, ItemsService};
use admin_template_core::settings::SettingsService;
use admin_template_core::users::{Role, UsersService};
use banto_core::ListParams;
use std::path::PathBuf;

/// Drop every table this app owns (plus sqlx's migration bookkeeping) so the
/// smoke test starts from a clean schema even if a previous run left state
/// behind. `CASCADE` also drops the identity sequences. Uses the public
/// `connect_postgres` helper to get a raw pool for the DDL.
async fn reset_schema(url: &str) {
    let pool = banto_storage::connect_postgres(url)
        .await
        .expect("connect for schema reset");
    for stmt in [
        "DROP TABLE IF EXISTS attachments, audit_log, users, settings, items CASCADE",
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(stmt)
            .execute(&pool)
            .await
            .expect("drop for reset");
    }
    pool.close().await;
}

#[tokio::test]
async fn app_layer_crud_round_trips_on_postgres() {
    let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
        eprintln!("pg_smoke: BANTO_TEST_PG_URL unset - skipping (no PostgreSQL server)");
        return;
    };

    reset_schema(&url).await;

    // migrations-postgres + deterministic 1,000-row seed.
    let db = init_db_from_target(&url)
        .await
        .expect("init_db_from_target should run migrations-postgres and seed");

    // --- items: seed count, create, update, list, delete ---------------------
    let items = ItemsService::new(db.clone());

    let seeded = items
        .list(ListParams::default())
        .await
        .expect("items list after seed");
    assert_eq!(
        seeded.total_count, 1_000,
        "seed should insert exactly 1,000 rows"
    );

    // A create must land AFTER the seeded ids (the identity sequence was
    // advanced past the explicit 1..=1000 seed), proving id order == insertion
    // order still holds.
    let created = items
        .create(ItemInput {
            name: "テスト商品".to_string(),
            price: 123,
            stock: 7,
        })
        .await
        .expect("items create");
    assert!(
        created.id > 1_000,
        "new id must be past the seed, got {}",
        created.id
    );
    assert_eq!(created.price, 123);
    assert_eq!(
        created.updated_at.len(),
        10,
        "updated_at is a YYYY-MM-DD date"
    );

    let updated = items
        .update(
            created.id,
            ItemInput {
                name: "テスト商品(改)".to_string(),
                price: 200,
                stock: 3,
            },
        )
        .await
        .expect("items update");
    assert_eq!(updated.price, 200);
    assert_eq!(updated.stock, 3);

    items.delete(created.id).await.expect("items delete");
    let after_delete = items
        .list(ListParams::default())
        .await
        .expect("items list after delete");
    assert_eq!(after_delete.total_count, 1_000);

    // --- users: create + list ------------------------------------------------
    let users = UsersService::new(db.clone());
    let identity = users
        .create_user("alice", "correct horse battery", "Alice", Role::Editor)
        .await
        .expect("users create_user");
    assert_eq!(identity.username, "alice");
    let listed_users = users.list_users().await.expect("users list");
    assert!(
        listed_users.iter().any(|u| u.username == "alice"),
        "created user should appear in list"
    );

    // --- settings: set + get -------------------------------------------------
    let settings = SettingsService::new(db.clone());
    settings
        .set("smoke.key", "smoke.value")
        .await
        .expect("settings set");
    let got = settings.get("smoke.key").await.expect("settings get");
    assert_eq!(got.as_deref(), Some("smoke.value"));

    // --- audit: record, list, prune (both branches) --------------------------
    let audit = AuditLogService::new(db.clone());
    for i in 0..3 {
        audit
            .try_record(AuditEntry {
                actor_username: Some("alice"),
                actor_role: Some("editor"),
                action: "create",
                resource: "items",
                entity_id: Some(&i.to_string()),
                detail: None,
                origin: "rest",
                result: "ok",
            })
            .await
            .expect("audit try_record");
    }
    let audit_rows = audit.list(ListParams::default()).await.expect("audit list");
    assert_eq!(audit_rows.total_count, 3, "three audit rows recorded");

    // retention_days > 0 exercises the `ts::timestamptz < NOW() - interval`
    // Postgres path; our entries are "now", so a 1-day cutoff deletes nothing
    // (the point is that the TEXT->timestamptz cast does not error).
    let deleted_by_age = audit
        .prune(Some(1), None)
        .await
        .expect("audit prune by age");
    assert_eq!(deleted_by_age, 0);

    // retention_rows keeps only the newest row, deleting the two oldest by id
    // (id order == insertion order via IDENTITY).
    let deleted_by_rows = audit
        .prune(None, Some(1))
        .await
        .expect("audit prune by rows");
    assert_eq!(deleted_by_rows, 2);
    let remaining = audit
        .list(ListParams::default())
        .await
        .expect("audit list after prune");
    assert_eq!(remaining.total_count, 1);

    // --- backup: SQLite-only, so every op must Err (never panic) on Postgres --
    // V2 owner decision D3 (PR4): backup/restore is a SQLite-only feature.
    // Against a Postgres handle each public operation returns `Err` instead of
    // the old `sqlite_pool()` `expect` panic. The `db_path` here is irrelevant
    // (the backend gate fires before any filesystem access), so a placeholder
    // name is fine.
    let backup = BackupService::new(PathBuf::from("banto-unused.sqlite3"), db.clone());
    assert!(
        backup.create().await.is_err(),
        "backup create must error on Postgres, not panic"
    );
    assert!(
        backup.list().await.is_err(),
        "backup list must error on Postgres"
    );
    assert!(
        backup.read("banto-anything.sqlite3").await.is_err(),
        "backup read must error on Postgres"
    );
    assert!(
        backup
            .stage_restore_from_file("banto-anything.sqlite3")
            .await
            .is_err(),
        "stage_restore_from_file must error on Postgres"
    );
    assert!(
        backup.stage_restore_from_bytes(b"anything").await.is_err(),
        "stage_restore_from_bytes must error on Postgres"
    );
    assert!(
        backup.cancel_pending_restore().await.is_err(),
        "cancel_pending_restore must error on Postgres"
    );
    assert!(
        backup.pending_restore().await.is_none(),
        "pending_restore reports nothing staged on Postgres"
    );
}
