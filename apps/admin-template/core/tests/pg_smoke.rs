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
use admin_template_core::items::{
    BulkDeleteItem, BulkDeleteTarget, ImportResult, ItemImportRow, ItemInput, ItemsService,
};
use admin_template_core::settings::SettingsService;
use admin_template_core::users::{Role, UserKind, UsersService};
use banto_core::ListParams;
use std::path::PathBuf;

mod ui_settings_cases;

/// Drop every table and helper function this app owns (plus sqlx's migration
/// bookkeeping) so the smoke test starts from a clean schema even if a
/// previous run left state behind. `CASCADE` also drops the identity sequences. Uses the public
/// `connect_postgres` helper to get a raw pool for the DDL.
async fn reset_schema(url: &str) {
    let pool = banto_storage::connect_postgres(url)
        .await
        .expect("connect for schema reset");
    for stmt in [
        "DROP TABLE IF EXISTS attachments, audit_log, ui_settings, user_permissions, users, settings, items CASCADE",
        "DROP FUNCTION IF EXISTS banto_audit_parent_detail(TEXT, TEXT)",
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

    // v8.0.0 baseline rebuild (ADR-0034 §9, plan §4.1): a v7.11.0 database is
    // refused with the explicit message before any new migration touches it.
    a_v7_database_is_refused_on_postgres(&url).await;
    reset_schema(&url).await;

    // migrations-postgres + deterministic 1,000-row seed.
    let db = init_db_from_target(&url)
        .await
        .expect("init_db_from_target should run migrations-postgres and seed");
    the_baseline_schema_holds_on_postgres(&db).await;
    the_first_boot_seed_runs_once_on_postgres(&db).await;
    // ADR-0034 §7/§10: the first administrator comes from the offline CLI
    // (never started database -> CLI -> start -> login), beside the built-in row.
    let existing = the_first_admin_cli_on_postgres(&url, &db).await;
    assert_eq!(existing.auth_epoch, 0);
    period_filter_uses_the_collate_c_index(&url).await;

    // --- items: seed count, create, update, list, delete ---------------------
    // The `updated_at` date is bound from the app side (local date), so pin it
    // and check it round-trips through the TEXT column unchanged.
    let items = ItemsService::new(db.clone()).with_today(|| "2031-02-03".to_string());

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
            version: None,
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
    assert_eq!(created.updated_at, "2031-02-03");

    let updated = items
        .update(
            created.id,
            ItemInput {
                name: "テスト商品(改)".to_string(),
                price: 200,
                stock: 3,
                version: None,
            },
        )
        .await
        .expect("items update");
    assert_eq!(updated.price, 200);
    assert_eq!(updated.stock, 3);
    // Issue #638: migration 0011's BIGINT `version` - 1 on create, +1 per
    // update; a stale version is a Conflict (the FOR UPDATE read path).
    assert_eq!(created.version, 1);
    assert_eq!(updated.version, 2);
    let stale = items
        .update(
            created.id,
            ItemInput {
                name: "古い版".to_string(),
                price: 1,
                stock: 1,
                version: Some(1),
            },
        )
        .await;
    assert!(
        matches!(stale, Err(banto_core::BantoError::Conflict { .. })),
        "stale update must conflict, got {stale:?}"
    );
    let stale_delete = items.delete_returning_previous(created.id, Some(1)).await;
    assert!(
        matches!(stale_delete, Err(banto_core::BantoError::Conflict { .. })),
        "stale delete must conflict, got {stale_delete:?}"
    );

    let removed_item = items
        .delete_returning_previous(created.id, Some(2))
        .await
        .expect("items delete returning previous");
    assert_eq!(
        removed_item, updated,
        "the RETURNING row uses TEXT updated_at"
    );
    let after_delete = items
        .list(ListParams::default())
        .await
        .expect("items list after delete");
    assert_eq!(after_delete.total_count, 1_000);

    // --- items bulk delete (Issue #713): the Postgres arm of the transaction --
    // (FOR UPDATE read of the ids, then a chunked `DELETE ... WHERE id IN`).
    // Leaves the table at the 1,000 seeded rows again.
    let mut bulk = Vec::new();
    for name in ["一括A", "一括B", "一括C"] {
        bulk.push(
            items
                .create(ItemInput {
                    name: name.to_string(),
                    price: 1,
                    stock: 1,
                    version: None,
                })
                .await
                .expect("create bulk row"),
        );
    }
    let ids_target = |last_version: i64| BulkDeleteTarget::Ids {
        items: vec![
            BulkDeleteItem {
                id: bulk[0].id,
                version: Some(1),
            },
            BulkDeleteItem {
                id: bulk[1].id,
                version: Some(last_version),
            },
        ],
    };
    let stale_bulk = items.bulk_delete(&ids_target(9)).await;
    assert!(
        matches!(stale_bulk, Err(banto_core::BantoError::Conflict { .. })),
        "a stale version must refuse the whole bulk delete, got {stale_bulk:?}"
    );
    assert!(
        items.get(bulk[0].id).await.is_ok(),
        "the bulk delete is all-or-nothing"
    );
    assert_eq!(
        items.bulk_delete(&ids_target(1)).await.expect("bulk ids"),
        vec![bulk[0].id, bulk[1].id]
    );
    assert_eq!(
        items
            .bulk_delete(&BulkDeleteTarget::Ids {
                items: vec![BulkDeleteItem {
                    id: bulk[2].id,
                    version: Some(1),
                }],
            })
            .await
            .expect("bulk single id"),
        vec![bulk[2].id]
    );
    let after_bulk = items
        .list(ListParams::default())
        .await
        .expect("items list after bulk delete");
    assert_eq!(after_bulk.total_count, 1_000);

    // --- items import: round-trip + all-or-nothing rollback (spec M15) --------
    // Exercises `import_apply_postgres` - the hand-written Postgres mirror of
    // the SQLite transaction body that no other test or CI path reached
    // (M-review 2026-08 M-12). Both of its branches (commit / rollback) run
    // here against real Postgres.
    //
    // Round-trip: two INSERTs (`id: None`) plus one UPDATE of a seeded row
    // (ids 1..=1000) commit together.
    let import_ok = items
        .import(vec![
            ItemImportRow {
                id: None,
                name: "取込A".to_string(),
                price: 111,
                stock: 1,
            },
            ItemImportRow {
                id: None,
                name: "取込B".to_string(),
                price: 222,
                stock: 2,
            },
            ItemImportRow {
                id: Some(1),
                name: "既存1(改)".to_string(),
                price: 333,
                stock: 3,
            },
        ])
        .await
        .expect("items import (round-trip)");
    assert_eq!(
        import_ok,
        ImportResult {
            created: 2,
            updated: 1,
            errors: Vec::new(),
        }
    );
    let after_import = items
        .list(ListParams::default())
        .await
        .expect("items list after import");
    assert_eq!(
        after_import.total_count, 1_002,
        "the two INSERTs in the batch committed"
    );
    let seeded_one = items.get(1).await.expect("get updated seed row");
    assert_eq!(
        seeded_one.price, 333,
        "the UPDATE in the same batch committed too"
    );

    // All-or-nothing rollback: a batch whose second row UPDATEs a NON-existent
    // id (so `rows_affected == 0`) must roll the WHOLE thing back - the
    // otherwise-valid INSERT before it must NOT land, and `import` returns
    // `Ok(ImportResult { errors })`, not `Err`. NOTE: the trigger has to be a
    // missing-id UPDATE, not a bad-value row - validation runs BEFORE any
    // transaction opens, so a validation error never reaches
    // `import_apply_postgres`'s rollback branch.
    let import_rollback = items
        .import(vec![
            ItemImportRow {
                id: None,
                name: "巻き戻るはず".to_string(),
                price: 999,
                stock: 9,
            },
            ItemImportRow {
                id: Some(10_000_000),
                name: "存在しないid".to_string(),
                price: 1,
                stock: 1,
            },
        ])
        .await
        .expect("items import rollback returns Ok(with errors), never Err");
    assert_eq!(import_rollback.created, 0);
    assert_eq!(import_rollback.updated, 0);
    assert_eq!(
        import_rollback.errors.len(),
        1,
        "only the missing-id row is an error"
    );
    assert_eq!(
        import_rollback.errors[0].row, 1,
        "0-based index of the failing row"
    );
    let after_rollback = items
        .list(ListParams::default())
        .await
        .expect("items list after rollback");
    assert_eq!(
        after_rollback.total_count, 1_002,
        "the valid INSERT in the rolled-back batch must not have landed"
    );

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

    // --- users: auth_epoch (Issue #204, migration 0007) ---------------------
    // The Postgres arms of the epoch writes: `CASE WHEN role = $2` reuses a
    // text parameter, and `RETURNING auth_epoch` decodes BIGINT -> i64.
    assert_eq!(identity.auth_epoch, 0);
    let epoch = |users: UsersService| async move {
        users
            .get_by_username("alice")
            .await
            .expect("users get_by_username")
            .expect("alice exists")
            .auth_epoch
    };
    users
        .update_user(identity.id, "Alice A.", Role::Editor)
        .await
        .expect("users update_user (name only)");
    assert_eq!(epoch(users.clone()).await, 0, "a name edit keeps sessions");
    users
        .update_user(identity.id, "Alice A.", Role::Viewer)
        .await
        .expect("users update_user (role)");
    assert_eq!(epoch(users.clone()).await, 1, "a role change ends sessions");
    let changed = users
        .change_password("alice", "correct horse battery", "battery staple horse")
        .await
        .expect("users change_password");
    assert_eq!(changed, 2);
    users
        .reset_password(identity.id, "reset horse battery")
        .await
        .expect("users reset_password");
    assert_eq!(epoch(users.clone()).await, 3);
    let verified = users
        .verify("alice", "reset horse battery")
        .await
        .expect("users verify")
        .expect("alice verifies with the reset password");
    assert_eq!(verified.auth_epoch, 3);
    // Issue #651 (migration 0012): the BIGINT `version` decodes into i64, two
    // updates took it 1 -> 3 (the password changes above left it alone), and a
    // stale version conflicts inside the write transaction.
    //
    // Issue #697 (migration 0013): grant two permissions (version 3 -> 4),
    // read them back through the session read, the admin listing and the
    // update path, then let the delete below cascade them away.
    let catalog = admin_template_core::users::PermissionCatalog::empty()
        .register("equipment.operate", "perm.operate", "perm.operate_desc")
        .unwrap()
        .register("alarm.ack", "perm.ack", "perm.ack_desc")
        .unwrap();
    let perm_users = users.clone().with_permission_catalog(catalog);
    let key = |raw: &str| admin_template_core::users::PermissionKey::parse(raw).unwrap();
    let diff = perm_users
        .set_permissions(
            identity.id,
            &[key("equipment.operate"), key("alarm.ack")],
            Some(3),
            "smoke-admin",
        )
        .await
        .expect("set_permissions on postgres");
    assert_eq!(diff.added.len(), 2);
    assert!(perm_users
        .session_permissions(identity.id)
        .await
        .unwrap()
        .has(&key("alarm.ack")));
    // The catalog-less service holds none (unregistered = not held), but the
    // stored rows are listed.
    assert!(users
        .session_permissions(identity.id)
        .await
        .unwrap()
        .is_empty());
    let listed = users
        .list_users()
        .await
        .unwrap()
        .into_iter()
        .find(|u| u.id == identity.id)
        .unwrap();
    assert_eq!(listed.version, 4);
    assert_eq!(
        users.permissions_by_user().await.unwrap().get(&identity.id),
        Some(&vec![key("alarm.ack"), key("equipment.operate")])
    );
    let unknown = perm_users
        .set_permissions(identity.id, &[key("other.thing")], Some(4), "smoke-admin")
        .await;
    assert!(
        matches!(unknown, Err(banto_core::BantoError::Validation { .. })),
        "{unknown:?}"
    );
    let outcome = perm_users
        .update_user_with_permissions(
            identity.id,
            "Alice A.",
            Role::Viewer,
            Some(&[key("equipment.operate"), key("alarm.ack")]),
            Some(4),
            "smoke-admin",
        )
        .await
        .expect("update_user_with_permissions on postgres");
    assert!(outcome.permission_diff.is_empty());
    assert_eq!(outcome.updated.version, 5);

    let stale = users
        .delete_user_checked_returning_previous(identity.id, Some(existing.id), Some(1))
        .await;
    assert!(
        matches!(stale, Err(banto_core::BantoError::Conflict { .. })),
        "stale version must conflict: {stale:?}"
    );
    let removed_user = users
        .delete_user_checked_returning_previous(identity.id, Some(existing.id), Some(5))
        .await
        .expect("users delete returning previous");
    assert_eq!(removed_user.version, 5);

    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_permissions WHERE user_id = $1")
        .bind(identity.id)
        .fetch_one(db.as_postgres().unwrap())
        .await
        .unwrap();
    assert_eq!(left, 0, "ON DELETE CASCADE on postgres");
    assert_eq!(removed_user.username, "alice");
    assert_eq!(removed_user.display_name, "Alice A.");
    assert_eq!(removed_user.role, Role::Viewer);
    assert!(
        !removed_user.created_at.is_empty(),
        "created_at decodes as TEXT"
    );

    // --- settings: set + get -------------------------------------------------
    let settings = SettingsService::new(db.clone());
    settings
        .set("smoke.key", "smoke.value")
        .await
        .expect("settings set");
    let got = settings.get("smoke.key").await.expect("settings get");
    assert_eq!(got.as_deref(), Some("smoke.value"));
    // `set_auth_config` writes its four keys in ONE transaction (`set_many`,
    // freshness audit of #266 P2-3): the round trip on PostgreSQL.
    let mut auth = settings.auth_config().await.expect("auth config");
    auth.disabled = true;
    auth.disabled_role = Role::Viewer;
    settings
        .set_auth_config(&auth)
        .await
        .expect("set_auth_config");
    let auth = settings.auth_config().await.expect("auth config again");
    assert!(auth.disabled);
    assert_eq!(auth.disabled_role, Role::Viewer);
    let disabled_catalog = admin_template_core::users::PermissionCatalog::empty()
        .register("alarm.ack", "perm.ack", "perm.ack_desc")
        .unwrap();
    settings
        .set_auth_disabled_permissions(&["alarm.ack".to_string()], &disabled_catalog)
        .await
        .expect("auth.disabled_permissions write on postgres");
    assert_eq!(
        settings.auth_disabled_permissions().await.unwrap(),
        vec![key("alarm.ack")]
    );

    // --- audit: record, list, prune (both branches) --------------------------
    let audit = AuditLogService::new(db.clone());
    for i in 0..3 {
        audit
            .try_record(AuditEntry {
                actor_username: Some("alice"),
                actor_id: None,
                actor_role: Some("editor"),
                actor_kind: None,
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

    audit_snapshot_boundary_on_postgres(&audit, &db).await;
    audit_related_record_history_on_postgres(&audit, &db).await;

    concurrent_admin_removals_on_postgres(&url).await;
    ui_settings_conditional_writes_on_postgres(&url).await;
    // [scaffold:config-drafts] begin
    config_drafts_on_postgres(&db).await;
    // [scaffold:config-drafts] end

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

async fn audit_related_record_history_on_postgres(audit: &AuditLogService, db: &banto_storage::Db) {
    use banto_core::{FilterOp, FilterState, Pagination, SortDirection, SortState};
    use serde_json::json;

    // Audit entity IDs are TEXT. Namespace this fixture so later smoke
    // additions cannot accidentally enter the same record history.
    const TARGET_ID: &str = "pg-hist-42";
    for (resource, entity_id, detail) in [
        ("items", TARGET_ID, None),
        (
            "attachments",
            "pg-hist-a101",
            Some(json!({ "parentResource": "items", "parentId": TARGET_ID, "fileName": "a.txt" })),
        ),
        (
            "attachments",
            "pg-hist-a102",
            Some(json!({ "parentResource": "items", "parentId": "pg-hist-420" })),
        ),
        (
            "attachments",
            "pg-hist-a103",
            Some(json!({ "parentResource": "items", "parentId": 42 })),
        ),
        (
            "attachments",
            "pg-hist-a105",
            Some(json!({ "parentResource": "items", "parentId": "\u{0000}" })),
        ),
        (
            "attachments",
            "pg-hist-a106",
            Some(
                json!({ "parentResource": "items", "parentId": TARGET_ID, "fileName": "\u{0000}" }),
            ),
        ),
        (
            "attachments",
            "pg-hist-a107",
            Some(json!({ "parentResource": "items", "parentId": 42.5 })),
        ),
    ] {
        audit
            .try_record(AuditEntry {
                actor_username: Some("alice"),
                actor_id: None,
                actor_role: Some("editor"),
                actor_kind: None,
                action: "create",
                resource,
                entity_id: Some(entity_id),
                detail,
                origin: "rest",
                result: "ok",
            })
            .await
            .expect("record related history fixture");
    }
    let pool = db.as_postgres().expect("PostgreSQL history pool");
    sqlx::query("INSERT INTO audit_log (action, resource, entity_id, detail, origin) VALUES ('create', 'attachments', 'pg-hist-a104', 'not-json', 'rest')")
        .execute(pool)
        .await
        .expect("malformed historical detail");
    let params = ListParams {
        pagination: Some(Pagination {
            offset: 0,
            limit: 50,
        }),
        sort: vec![SortState {
            field: "id".into(),
            direction: SortDirection::Desc,
        }],
        filters: vec![
            FilterState {
                field: "recordResource".into(),
                op: FilterOp::Eq,
                value: json!("items"),
            },
            FilterState {
                field: "recordId".into(),
                op: FilterOp::Eq,
                value: json!(TARGET_ID),
            },
        ],
        ..Default::default()
    };
    let history = audit
        .list_as_of(params, None)
        .await
        .expect("related history list");
    assert_eq!(history.total_count, 2);
    assert_eq!(history.rows[0].resource, "attachments");
    assert_eq!(history.rows[0].entity_id.as_deref(), Some("pg-hist-a101"));
    assert_eq!(history.rows[1].resource, "items");
    let nul_detail_row: String = sqlx::query_scalar(
        "SELECT record_resource FROM audit_log WHERE resource = 'attachments' AND entity_id = 'pg-hist-a106'",
    )
    .fetch_one(pool)
    .await
    .expect("NUL detail row falls back to its direct resource");
    assert_eq!(nul_detail_row, "attachments");
    let numeric_parent_row: String = sqlx::query_scalar(
        "SELECT record_resource FROM audit_log WHERE resource = 'attachments' AND entity_id = 'pg-hist-a103'",
    )
    .fetch_one(pool)
    .await
    .expect("numeric parent id row falls back to its direct resource");
    assert_eq!(numeric_parent_row, "attachments");

    let sorted = audit
        .list(ListParams {
            sort: vec![SortState {
                field: "recordResource".into(),
                direction: SortDirection::Asc,
            }],
            ..Default::default()
        })
        .await
        .expect("sort by record scope without filters");
    assert!(sorted.total_count >= 4);

    let mut tx = pool.begin().await.expect("begin history EXPLAIN");
    sqlx::query("SET LOCAL enable_seqscan = off")
        .execute(&mut *tx)
        .await
        .expect("disable seqscan");
    let plan: Vec<String> = sqlx::query_scalar(
        "EXPLAIN SELECT id FROM (SELECT * FROM audit_log WHERE id <= 1000000) AS audit_log \
         WHERE record_resource = 'items' AND record_id = 'pg-hist-42'",
    )
    .fetch_all(&mut *tx)
    .await
    .expect("explain record scope");
    assert!(
        plan.join("\n").contains("idx_audit_log_record_scope"),
        "record history should use its scope index: {plan:?}"
    );
}

// Issue #248: `list_as_of` on PostgreSQL - the boundary pins the set across
// blocks (rows recorded between two blocks stay out, the count stays), rows
// sharing one `ts` keep one order across `OFFSET` blocks in both directions
// (`ORDER BY` ends with `id`), and an omitted boundary keeps `list`'s result.
// Runs inside the smoke test (shared schema, see the note below).
async fn audit_snapshot_boundary_on_postgres(audit: &AuditLogService, db: &banto_storage::Db) {
    use banto_core::{Pagination, SortDirection, SortState};

    let record = |n: usize| async move {
        for _ in 0..n {
            audit
                .try_record(AuditEntry {
                    actor_username: Some("alice"),
                    actor_id: None,
                    actor_role: Some("admin"),
                    actor_kind: None,
                    action: "create",
                    resource: "items",
                    entity_id: None,
                    detail: None,
                    origin: "rest",
                    result: "ok",
                })
                .await
                .expect("audit try_record");
        }
    };
    let page = |offset: u64, direction: SortDirection| ListParams {
        pagination: Some(Pagination { offset, limit: 3 }),
        sort: vec![SortState {
            field: "ts".to_string(),
            direction,
        }],
        ..Default::default()
    };
    let ids = |list: &admin_template_core::audit::AuditLogList| -> Vec<i64> {
        list.rows.iter().map(|r| r.id).collect()
    };

    record(5).await;
    let pool = db.as_postgres().expect("a PostgreSQL handle");
    sqlx::query("UPDATE audit_log SET ts = '2026-09-29 12:00:00+00'")
        .execute(pool)
        .await
        .expect("same ts for every row");
    let all = audit.list(ListParams::default()).await.expect("audit list");
    let mut all_ids: Vec<i64> = all.rows.iter().map(|r| r.id).collect();
    all_ids.sort();
    assert_eq!(all_ids.len(), 6);
    let max_id = *all_ids.last().unwrap();

    let first = audit
        .list_as_of(page(0, SortDirection::Desc), None)
        .await
        .expect("first block");
    assert_eq!(
        first.as_of_id, max_id,
        "an omitted boundary is the newest id"
    );
    assert_eq!(first.total_count, 6);

    // Two rows recorded between the blocks (same second as the rest).
    record(2).await;
    sqlx::query("UPDATE audit_log SET ts = '2026-09-29 12:00:00+00'")
        .execute(pool)
        .await
        .expect("same ts for the new rows");

    let second = audit
        .list_as_of(page(3, SortDirection::Desc), Some(first.as_of_id))
        .await
        .expect("second block");
    assert_eq!(second.as_of_id, first.as_of_id);
    assert_eq!(second.total_count, 6, "the pinned count is unchanged");
    let mut seen = ids(&first);
    seen.extend(ids(&second));
    let mut expected_desc = all_ids.clone();
    expected_desc.reverse();
    assert_eq!(seen, expected_desc, "no duplicate, no gap, id DESC on ties");

    let mut seen_asc = Vec::new();
    for offset in [0, 3] {
        let block = audit
            .list_as_of(page(offset, SortDirection::Asc), Some(first.as_of_id))
            .await
            .expect("ascending block");
        seen_asc.extend(ids(&block));
    }
    assert_eq!(seen_asc, all_ids, "id ASC on ties");

    let fresh = audit
        .list_as_of(page(0, SortDirection::Desc), None)
        .await
        .expect("fresh generation");
    assert_eq!(fresh.total_count, 8);
    assert_eq!(fresh.as_of_id, max_id + 2);
    let old = audit
        .list(page(0, SortDirection::Desc))
        .await
        .expect("list without a boundary");
    assert_eq!(old.total_count, fresh.total_count);
    assert_eq!(old.rows, fresh.rows);

    // Issue #248 review: a row with a lower id committing late (+1) and a
    // prune of the same size (-1) leave the pinned count unchanged while the
    // set changed - the block after the edge repeats a row. Reproduced with a
    // real open transaction: IDENTITY hands out ids outside transactions, so
    // the row inserted in `late` gets a lower id than the one committed
    // after it. Only the deletion epoch tells the two reads apart.
    let by_id_desc = |offset: u64| ListParams {
        pagination: Some(Pagination { offset, limit: 2 }),
        sort: vec![SortState {
            field: "id".to_string(),
            direction: SortDirection::Desc,
        }],
        ..Default::default()
    };
    let mut late = pool.begin().await.expect("begin the late writer");
    sqlx::query(
        "INSERT INTO audit_log (action, resource, origin) VALUES ('create', 'items', 'rest')",
    )
    .execute(&mut *late)
    .await
    .expect("insert in the late transaction");
    record(1).await;

    let first = audit
        .list_as_of(by_id_desc(0), None)
        .await
        .expect("first block before the late commit");
    let before = audit
        .list(ListParams::default())
        .await
        .expect("count before the late commit")
        .total_count;
    assert_eq!(first.total_count, before);

    late.commit().await.expect("the late writer commits");
    let pruned = audit
        .prune(None, Some(before as i64))
        .await
        .expect("another tab's unbounded read prunes");
    assert_eq!(pruned, 1);

    let second = audit
        .list_as_of(by_id_desc(2), Some(first.as_of_id))
        .await
        .expect("second block after the late commit and the prune");
    assert_eq!(
        second.total_count, first.total_count,
        "the count alone cannot see the change"
    );
    assert_eq!(
        second.rows[0].id, first.rows[1].id,
        "the edge row repeats: the set shifted"
    );
    assert_ne!(
        second.deletion_epoch, first.deletion_epoch,
        "the deletion epoch catches it"
    );
}

const V7_USERS: &str = include_str!("fixtures/v7.11.0/postgres-0003_users.sql");
const V7_AUDIT_LOG: &str = include_str!("fixtures/v7.11.0/postgres-0005_audit_log.sql");

/// Plan §4.1 / §9.1 on PostgreSQL: a database built by the v7.11.0 migrations
/// (0001-0013, with the original `0003`/`0005`) stops at startup with the
/// explicit message, and `0014` has not been applied to it.
async fn a_v7_database_is_refused_on_postgres(url: &str) {
    use sqlx::migrate::Migration;
    use sqlx::SqlSafeStr;

    let pool = banto_storage::connect_postgres(url)
        .await
        .expect("connect for the v7 schema");
    let mut v7 = sqlx::migrate!("./migrations-postgres");
    v7.migrations = v7
        .migrations
        .iter()
        .filter(|m| m.version < 14)
        .map(|m| {
            let old = match m.version {
                3 => V7_USERS,
                5 => V7_AUDIT_LOG,
                _ => return m.clone(),
            };
            Migration::new(
                m.version,
                m.description.clone(),
                m.migration_type,
                sqlx::AssertSqlSafe(old).into_sql_str(),
                m.no_tx,
            )
        })
        .collect::<Vec<_>>()
        .into();
    v7.run(&pool).await.expect("the v7.11.0 schema");
    sqlx::query(
        "INSERT INTO users (username, password_hash, display_name, role) \
         VALUES ('existing', 'unused', 'Existing', 'admin')",
    )
    .execute(&pool)
    .await
    .expect("a v7 account");

    let err = init_db_from_target(url)
        .await
        .expect_err("a v7 database is refused");
    let message = err.to_string();
    assert!(message.contains("v8.0.0 より前の版"), "{message}");
    assert!(message.contains("DB を作り直してください"), "{message}");

    let ui_settings: Option<String> = sqlx::query_scalar("SELECT to_regclass('ui_settings')::text")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ui_settings, None, "0014 was not applied");
    let kind_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.columns \
         WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'kind'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kind_columns, 0, "the users table is unchanged");
    let applied: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(applied, 13);

    // A mismatch that is not the known v7 history is not called "pre-v8": it
    // names the migration and does not suggest recreating the database.
    sqlx::query("UPDATE _sqlx_migrations SET checksum = '\\x00' WHERE version = 3")
        .execute(&pool)
        .await
        .unwrap();
    let message = init_db_from_target(url)
        .await
        .expect_err("an unexplained mismatch stops the start")
        .to_string();
    assert!(!message.contains("v8.0.0 より前"), "{message}");
    assert!(message.contains("migration 3 の内容"), "{message}");
    assert!(message.contains("DB は変更していません"), "{message}");
    pool.close().await;
}

/// Plan §4.1 on PostgreSQL: a new database has exactly one built-in `admin`,
/// the CHECKs refuse a malformed row, a second built-in row cannot exist, and
/// `ui_settings` rows are tied to their owner. Leaves the tables as it found
/// them (only the built-in row).
async fn the_baseline_schema_holds_on_postgres(db: &banto_storage::Db) {
    let pool = db.as_postgres().expect("postgres handle");
    type Row = (String, String, String, Option<String>, Option<String>);
    let rows: Vec<Row> =
        sqlx::query_as("SELECT username, kind, role, password_hash, account_uid FROM users")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![(
            "admin".to_string(),
            "builtin".to_string(),
            "admin".to_string(),
            None,
            None
        )]
    );
    for (what, sql) in [
        (
            "a second built-in row",
            "INSERT INTO users (username, display_name, kind) VALUES ('admin2', 'x', 'builtin')",
        ),
        (
            "an account without account_uid",
            "INSERT INTO users (username, password_hash, display_name) VALUES ('a', 'h', 'x')",
        ),
        (
            "an account without a password hash",
            "INSERT INTO users (username, display_name, account_uid) VALUES ('a', 'x', 'u1')",
        ),
        (
            "a built-in row with a password hash",
            "INSERT INTO users (username, password_hash, display_name, kind) \
             VALUES ('b', 'h', 'x', 'builtin')",
        ),
        (
            "a built-in row with an account_uid",
            "INSERT INTO users (username, display_name, kind, account_uid) \
             VALUES ('b', 'x', 'builtin', 'u1')",
        ),
    ] {
        assert!(sqlx::query(sql).execute(pool).await.is_err(), "{what}");
    }

    let users = UsersService::new(db.clone());
    assert!(!users.has_admin().await.unwrap());
    assert!(users.verify("admin", "admin").await.unwrap().is_none());
    let listed = users.list_users().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].kind, UserKind::Builtin);
    let builtin_id = listed[0].id;
    assert!(users
        .update_user(builtin_id, "x", Role::Viewer)
        .await
        .is_err());
    assert!(users
        .reset_password(builtin_id, "password123")
        .await
        .is_err());
    assert!(users.delete_user(builtin_id, None).await.is_err());
    assert_eq!(users.list_users().await.unwrap(), listed);

    // ui_settings: an account's row needs the matching user_id and goes away
    // with the account; a synthetic owner has none.
    let op = users
        .create_user("uiowner", "password123", "UI", Role::Viewer)
        .await
        .unwrap();
    let insert = "INSERT INTO ui_settings (owner, key, value, revision, user_id) \
                  VALUES ($1, 'k', 'v', 'r', $2)";
    for (owner, user_id, ok) in [
        (format!("acct:{}", op.id), Some(op.id), true),
        ("local".to_string(), None, true),
        (format!("acct:{}", op.id), None, false),
        ("local".to_string(), Some(op.id), false),
        ("acct:999999".to_string(), Some(999_999), false),
    ] {
        let result = sqlx::query(insert)
            .bind(&owner)
            .bind(user_id)
            .execute(pool)
            .await;
        assert_eq!(result.is_ok(), ok, "owner {owner:?} user_id {user_id:?}");
    }
    // Deleted with plain SQL so this fixture leaves only the built-in row.
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(op.id)
        .execute(pool)
        .await
        .unwrap();
    let owners: Vec<String> = sqlx::query_scalar("SELECT owner FROM ui_settings ORDER BY owner")
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(owners, ["local"]);
    sqlx::query("DELETE FROM ui_settings")
        .execute(pool)
        .await
        .unwrap();
}

/// ADR-0034 §5 on PostgreSQL: the seed's marker is taken at the start of the
/// transaction, so two starts on the same unseeded database cannot both seed.
/// The second waits for the first; after the first's ROLLBACK it seeds, after
/// the first's COMMIT it writes nothing - not even over a setting that was
/// changed in between. Leaves `settings` as the migrations left it (no marker).
async fn the_first_boot_seed_runs_once_on_postgres(db: &banto_storage::Db) {
    use admin_template_core::settings::seed_first_boot_postgres;
    use std::time::Duration;

    const SEED: &[(&str, &str)] = &[("server.viewer_public", "true")];
    let pool = db.as_postgres().expect("postgres handle").clone();
    let settings = SettingsService::new(db.clone());
    assert_eq!(
        settings.get("first_boot.seeded").await.unwrap(),
        None,
        "never started"
    );

    // First start fails after the seed: the waiting second start then seeds.
    let mut first = pool.begin().await.unwrap();
    assert!(seed_first_boot_postgres(&mut first, SEED).await.unwrap());
    let waiting = {
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut second = pool.begin().await.unwrap();
            let wrote = seed_first_boot_postgres(&mut second, SEED).await.unwrap();
            second.commit().await.unwrap();
            wrote
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !waiting.is_finished(),
        "the second start waits for the first"
    );
    first.rollback().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .expect("the second start is released")
            .unwrap(),
        "after a rollback the marker is gone and the second start seeds"
    );
    assert_eq!(
        settings
            .get("server.viewer_public")
            .await
            .unwrap()
            .as_deref(),
        Some("true")
    );

    // Start over: the first start commits, the waiting one writes nothing.
    sqlx::query("DELETE FROM settings WHERE key IN ('first_boot.seeded', 'server.viewer_public')")
        .execute(&pool)
        .await
        .unwrap();
    let mut first = pool.begin().await.unwrap();
    assert!(seed_first_boot_postgres(&mut first, SEED).await.unwrap());
    sqlx::query("UPDATE settings SET value = 'false' WHERE key = 'server.viewer_public'")
        .execute(&mut *first)
        .await
        .unwrap();
    let waiting = {
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut second = pool.begin().await.unwrap();
            let wrote = seed_first_boot_postgres(&mut second, SEED).await.unwrap();
            second.commit().await.unwrap();
            wrote
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !waiting.is_finished(),
        "the second start waits for the first"
    );
    first.commit().await.unwrap();
    assert!(
        !tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .expect("the second start is released")
            .unwrap(),
        "after a commit the second start does not seed"
    );
    assert_eq!(
        settings
            .get("server.viewer_public")
            .await
            .unwrap()
            .as_deref(),
        Some("false"),
        "the committed settings are not written again"
    );
    assert!(!settings.seed_first_boot(SEED).await.unwrap());

    sqlx::query("DELETE FROM settings WHERE key IN ('first_boot.seeded', 'server.viewer_public')")
        .execute(&pool)
        .await
        .unwrap();
}

/// `action, resource, actor_id, actor_username, actor_kind, origin` of an audit row.
type CliAuditRow = (
    String,
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
    String,
);

/// ADR-0034 §5/§7/§10 on PostgreSQL (the display preset's seed): a database
/// that has never started does not start headless; the CLI seeds, creates the
/// administrator, requires login and writes the audit rows in ONE transaction;
/// the next start does not put the seed's `auth.disabled = true` back; the
/// account logs in. A failed run leaves nothing - not even the seed marker.
///
/// Leaves the account (`existing`, admin) and `auth.disabled = false`; the
/// seed's other rows, the marker and the audit rows are removed again.
async fn the_first_admin_cli_on_postgres(
    url: &str,
    db: &banto_storage::Db,
) -> admin_template_core::users::UserIdentity {
    use admin_template_core::first_account::{
        create_admin_and_require_login, create_admin_and_require_login_on, NewAdmin,
    };
    use admin_template_core::startup::{self, Wiring};

    const DISPLAY_SEED: &[(&str, &str)] = &[
        ("auth.disabled", "true"),
        ("auth.disabled_role", "viewer"),
        ("server.enabled", "true"),
        ("server.bind", "0.0.0.0"),
        ("server.viewer_public", "true"),
    ];
    let headless = Wiring::Headless {
        seed_viewer_public: false,
    };
    let pool = db.as_postgres().expect("postgres handle").clone();
    let settings = SettingsService::new(db.clone());
    let users = UsersService::new(db.clone());

    // A new database: no login (0015), so this server would not listen.
    let fresh = settings.auth_config().await.expect("0015 wrote the mode");
    assert!(fresh.disabled);
    assert_eq!(fresh.disabled_role, Role::Admin);
    let err = startup::check(db, headless).await.unwrap_err();
    assert!(err.to_string().contains("create-admin"), "{err}");
    startup::check(db, Wiring::Desktop)
        .await
        .expect("the desktop app starts on a new database");

    // A failed run (a reserved name, refused after the seed was written in the
    // same transaction) leaves no account, no lock-down and no marker.
    let err = create_admin_and_require_login_on(
        db,
        DISPLAY_SEED,
        NewAdmin {
            username: "Admin",
            password: "password123",
            display_name: "x",
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(err, banto_core::BantoError::Validation { .. }),
        "{err}"
    );
    assert_eq!(settings.get("first_boot.seeded").await.unwrap(), None);
    assert!(settings.auth_config().await.unwrap().disabled);
    assert!(!settings.server_config().await.unwrap().viewer_public);
    assert!(!users.has_admin().await.unwrap());

    // The CLI on the never-started database.
    let created = create_admin_and_require_login_on(
        db,
        DISPLAY_SEED,
        NewAdmin {
            username: "existing",
            password: "password123",
            display_name: "Existing",
        },
    )
    .await
    .expect("create-admin");
    assert!(created.seeded);
    assert_eq!(created.user.role, Role::Admin);

    // The next start: the seed finds its marker, the check passes, login works.
    assert!(!settings.seed_first_boot(DISPLAY_SEED).await.unwrap());
    let started = startup::check(db, headless).await.expect("starts now");
    assert!(!started.auth.disabled, "the lock-down stayed over the seed");
    let server = settings.server_config().await.unwrap();
    assert!(server.viewer_public && server.enabled);
    assert!(users
        .verify("existing", "password123")
        .await
        .unwrap()
        .is_some());
    let rows: Vec<CliAuditRow> = sqlx::query_as(
        "SELECT action, resource, actor_id, actor_username, actor_kind, origin \
             FROM audit_log WHERE origin = 'cli' ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(
        (rows[0].0.as_str(), rows[0].1.as_str()),
        ("create", "users")
    );
    assert_eq!(
        (rows[1].0.as_str(), rows[1].1.as_str()),
        ("settings_change", "settings")
    );
    for row in &rows {
        assert_eq!(row.2, Some(started.users.builtin_admin_id));
        assert_eq!(row.3.as_deref(), Some("admin"));
        assert_eq!(row.4.as_deref(), Some("cli"));
    }

    // The whole entry point (`BANTO_DB` = this URL) on the started database:
    // it seeds nothing, and a duplicate name writes nothing.
    let err = create_admin_and_require_login(
        url,
        NewAdmin {
            username: "existing",
            password: "password123",
            display_name: "again",
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(err, banto_core::BantoError::Validation { .. }),
        "{err}"
    );

    // Back to what the rest of this smoke test expects.
    for sql in [
        "TRUNCATE audit_log RESTART IDENTITY",
        "DELETE FROM settings WHERE key = 'first_boot.seeded' OR key LIKE 'server.%'",
        "UPDATE settings SET value = 'admin' WHERE key = 'auth.disabled_role'",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    created.user
}

/// Issue #786 / plan §4.4 on PostgreSQL: the shared conditional-write cases
/// (`ui_settings_cases`, also run on SQLite by `ui_settings_sqlite.rs`) on two
/// SEPARATE pools - under the default READ COMMITTED level a read followed by
/// an unconditional write would let both of two writers through, so this is
/// what shows the check and the write are one statement. Kept in this smoke
/// test for the same reason as the case below (the schema is shared). Leaves
/// no account and no `ui_settings` row behind.
async fn ui_settings_conditional_writes_on_postgres(url: &str) {
    use banto_storage::Db;

    let first = Db::connect_postgres(url).await.unwrap();
    let second = Db::connect_postgres(url).await.unwrap();
    let a = SettingsService::new(first.clone());
    let b = SettingsService::new(second.clone());
    let users = UsersService::new(first.clone());

    ui_settings_cases::run_all(&a, &b, &users).await;

    let pool = first.as_postgres().unwrap();
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ui_settings")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(left, 0, "a ui_settings row was left behind");
    let accounts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username LIKE 'uicase%'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(accounts, 0);
    pool.close().await;
    second.as_postgres().unwrap().close().await;
}
// [scaffold:config-drafts] begin

/// Issue #938 (config-draft-publish-design §7, S4) on the REAL PostgreSQL
/// migration (`migrations-postgres/0016_config_drafts.sql`): the wiring's
/// `open_config_drafts`, then one target through seed -> lock -> draft ->
/// publish -> revert. The rules themselves (conflicts, locks, two
/// connections) run on a copy of these tables in `banto-admin-services`
/// (`pg_config_drafts`); this is what shows the app's own migration is the
/// schema the service writes. Leaves no row behind.
async fn config_drafts_on_postgres(db: &banto_storage::Db) {
    use admin_template_core::config_drafts::{
        ConfigDraftsService, ConfigEditor, ConfigTarget, ConfigTargetRegistry, PublishStamp,
        CONFIG_DRAFT_ABSENT_REVISION,
    };
    use serde_json::json;

    // What the servers call at startup: the template registers no target.
    let wired = admin_template_core::open_config_drafts(db)
        .await
        .expect("open_config_drafts on the migrated schema");
    assert!(wired.list().await.expect("list").is_empty());

    const TARGET: &str = "pgsmoke.config";
    let targets = ConfigTargetRegistry::empty()
        .register(ConfigTarget::new(TARGET, json!({"limit": 1}), &[]).expect("target"))
        .expect("register");
    let service = ConfigDraftsService::new(db.clone(), targets);
    service.ensure_targets().await.expect("seed the target");
    service
        .ensure_targets()
        .await
        .expect("seeding twice is fine");

    let editor = ConfigEditor {
        holder: "acct:1".to_string(),
        name: "pgsmoke".to_string(),
    };
    let stamp = PublishStamp {
        actor_username: "pgsmoke",
        actor_id: Some(1),
        actor_kind: "account",
        origin: "rest",
        comment: Some("pg smoke"),
    };
    let state = service.state(TARGET, &editor).await.expect("state");
    assert_eq!(state.published.version, 0);
    assert!(state.draft.is_none() && state.lock.is_none());

    service.lock_acquire(TARGET, &editor).await.expect("lock");
    let saved = service
        .draft_put(
            TARGET,
            &editor,
            &json!({"limit": 2}),
            CONFIG_DRAFT_ABSENT_REVISION,
            Some(&state.published.revision),
        )
        .await
        .expect("save the draft");
    assert!(saved.validation.is_empty());
    let published = service
        .publish(TARGET, &editor, &saved.revision, &stamp)
        .await
        .expect("publish");
    assert_eq!((published.version, published.previous_version), (1, 0));
    let reverted = service
        .revert(TARGET, &editor, 0, &published.revision, &stamp)
        .await
        .expect("revert");
    assert_eq!((reverted.version, reverted.reverted_to), (2, Some(0)));
    assert_eq!(
        service.published(TARGET).await.expect("published").value,
        json!({"limit": 1})
    );
    let history = service.history(TARGET, None, 10).await.expect("history");
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.version, entry.kind.as_str()))
            .collect::<Vec<_>>(),
        vec![(2, "revert"), (1, "publish"), (0, "initial")]
    );
    assert_eq!(history[0].actor_id, Some(1));
    let listed = service.list().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].version, 2);

    let pool = db.as_postgres().unwrap();
    for table in [
        "config_locks",
        "config_drafts",
        "config_history",
        "config_published",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table}")))
            .execute(pool)
            .await
            .expect("clean up");
    }
}
// [scaffold:config-drafts] end

// Issue #207 / roadmap M10: keep this in the existing smoke test so no other
// test resets the shared schema while these concurrent transactions are live.
async fn concurrent_admin_removals_on_postgres(url: &str) {
    use banto_core::BantoError;
    use banto_storage::Db;
    use sqlx::postgres::PgPoolOptions;
    use std::time::Duration;

    // Separate pools rule out a service-local mutex masquerading as DB locking.
    // A stricter session default verifies that the service explicitly selects
    // READ COMMITTED, so a lock waiter sees the preceding writer's commit.
    let options = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET default_transaction_isolation = 'repeatable read'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        });
    let first_pool = options.clone().connect(url).await.unwrap();
    let second_pool = options.connect(url).await.unwrap();
    let control = banto_storage::connect_postgres(url).await.unwrap();
    let first = UsersService::new(Db::Postgres(first_pool.clone()));
    let second = UsersService::new(Db::Postgres(second_pool.clone()));

    for (delete_first, delete_second) in [(false, false), (true, true), (false, true)] {
        sqlx::query("DELETE FROM users WHERE kind = 'account'")
            .execute(&control)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, role, account_uid) VALUES
             ('owner1', '$argon2id$v=19$m=65536,t=2,p=1$gZiV/M1gPc22ElAH/Jh1Hw$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno', 'Original 1', 'admin', 'uid-owner1'),
             ('owner2', '$argon2id$v=19$m=65536,t=2,p=1$gZiV/M1gPc22ElAH/Jh1Hw$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno', 'Original 2', 'admin', 'uid-owner2')",
        )
        .execute(&control)
        .await
        .unwrap();
        let before = first.list_users().await.unwrap();
        let first_id = before
            .iter()
            .find(|user| user.username == "owner1")
            .unwrap()
            .id;
        let second_id = before
            .iter()
            .find(|user| user.username == "owner2")
            .unwrap()
            .id;
        let mut gate = control.begin().await.unwrap();
        sqlx::query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *gate)
            .await
            .unwrap();

        let launch = |svc: UsersService, id, actor_id, delete| {
            tokio::spawn(async move {
                if delete {
                    svc.delete_user(id, Some(actor_id)).await
                } else {
                    svc.update_user(id, "Changed", Role::Viewer)
                        .await
                        .map(|_| ())
                }
            })
        };
        let a = launch(first.clone(), first_id, second_id, delete_first);
        let b = launch(second.clone(), second_id, first_id, delete_second);
        // The gate allows SELECTs but blocks mutations. In the old code both
        // calls pass the count check before waiting at their writes; with the
        // fix both wait before their protected reads. Observe real lock waits,
        // rather than assuming an arbitrary sleep was enough to reach them.
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let waiting: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM pg_locks
                     WHERE relation = 'users'::regclass AND NOT granted",
                )
                .fetch_one(&control)
                .await
                .unwrap();
                if waiting == 2 {
                    break;
                }
                assert!(
                    !a.is_finished() && !b.is_finished(),
                    "operations must wait for the gate"
                );
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both concurrent operations must reach the database lock gate");
        gate.commit().await.unwrap();
        let (a, b) = tokio::time::timeout(Duration::from_secs(15), async {
            let (a, b) = tokio::join!(a, b);
            (a.unwrap(), b.unwrap())
        })
        .await
        .expect("both operations must complete once the gate opens");
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let (refused_id, error) = if let Err(error) = a {
            (first_id, error)
        } else {
            (second_id, b.unwrap_err())
        };
        match error {
            BantoError::Other(message) => {
                assert_eq!(message, "最後の管理者を降格・削除することはできません");
            }
            other => panic!("expected last-admin refusal, got {other:?}"),
        }
        let after = first.list_users().await.unwrap();
        assert_eq!(
            after
                .iter()
                .filter(|user| user.role.is_admin() && user.kind == UserKind::Account)
                .count(),
            1
        );
        assert_eq!(
            after.iter().find(|user| user.id == refused_id),
            before.iter().find(|user| user.id == refused_id),
            "a refused operation must preserve its display name and role"
        );
        tokio::time::timeout(
            Duration::from_secs(5),
            second.update_user(refused_id, "Still admin", Role::Admin),
        )
        .await
        .expect("refusal must release its transaction lock")
        .unwrap();
    }
    first_pool.close().await;
    second_pool.close().await;
    control.close().await;
}

/// Migration 0009's expression index must be the very expression
/// `banto-storage`'s PostgreSQL `between` generates
/// (`CAST(col AS TEXT) COLLATE "C"`), or the planner cannot use it. With
/// sequential scans disabled the planner takes any usable index, so an
/// expression mismatch shows up as a `Seq Scan` in the plan.
async fn period_filter_uses_the_collate_c_index(url: &str) {
    let pool = banto_storage::connect_postgres(url)
        .await
        .expect("connect for EXPLAIN");
    let mut conn = pool.acquire().await.expect("acquire for EXPLAIN");
    sqlx::query("ANALYZE items")
        .execute(&mut *conn)
        .await
        .expect("analyze items");
    sqlx::query("SET enable_seqscan = off")
        .execute(&mut *conn)
        .await
        .expect("disable seqscan");
    let plan: Vec<String> = sqlx::query_scalar(
        "EXPLAIN SELECT id FROM items \
         WHERE CAST(updated_at AS TEXT) COLLATE \"C\" >= $1 \
         AND CAST(updated_at AS TEXT) COLLATE \"C\" < $2",
    )
    .bind("2020-01-01")
    .bind("2020-01-02")
    .fetch_all(&mut *conn)
    .await
    .expect("explain between");
    let plan = plan.join("\n");
    assert!(
        plan.contains("idx_items_updated_at"),
        "between on items.updated_at should use idx_items_updated_at:\n{plan}"
    );
    drop(conn);
    pool.close().await;
}
