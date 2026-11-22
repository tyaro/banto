//! Unit tests for the Tauri command layer (split out of `lib.rs`, Issue #820).
//!
//! Loaded by `#[cfg(test)] mod tests;` in `lib.rs`; private items stay
//! reachable through `use super::*`.

use super::*;

// Issue #793: `server_apply` with writes of the stopped listener still
// running (`src/tests/server_writes.rs`).
mod server_writes;

/// [`auth_config_apply_with_permissions_body`] without permissions,
/// returning just the settings (most tests do not care about them).
async fn auth_config_apply_body(
    state: &AppState,
    disabled: bool,
    disabled_role: &str,
) -> Result<AuthSettings, BantoError> {
    Ok(
        auth_config_apply_with_permissions_body(state, disabled, disabled_role, None)
            .await?
            .settings,
    )
}

use std::path::PathBuf;

impl AppState {
    /// Install `session` as if a session-changing command had written it
    /// (advancing `seq`, Issue #260 I-11).
    fn set_session_for_test(&self, session: Option<DesktopSession>) {
        let mut slot = self.auth.lock().expect("auth mutex poisoned");
        slot.session = session;
        slot.seq += 1;
    }
}

/// A minimal [`AppState`] over an in-memory DB, no running server, and a
/// dummy REST verifier - just enough state to exercise command bodies
/// (like [`change_own_password`]) that only touch the service handles.
async fn app_state() -> AppState {
    let pool = admin_template_core::db::init_db_memory()
        .await
        .expect("init_db_memory");
    let events = event_channel();
    AppState {
        // [scaffold:items] begin
        items: ItemsService::new(pool.clone()).with_events(events.clone()),
        // [scaffold:items] end
        resources: AppResources::new(&pool, &events),
        auth: Mutex::new(AuthSlot::default()),
        firewall_change_running: std::sync::atomic::AtomicBool::new(false),
        auth_config_lock: AsyncMutex::new(()),
        auth_io: AuthIo::production(
            &UsersService::new(pool.clone()),
            &SettingsService::new(pool.clone()),
        ),
        users: UsersService::new(pool.clone()),
        settings: SettingsService::new(pool.clone()),
        events,
        // Issue #204: the production wiring, so cross-transport tests
        // exercise the same session re-check the embedded server uses.
        rest_auth: user_auth_state(
            UsersService::new(pool.clone()),
            AuditLogService::new(pool.clone()),
        ),
        server: AsyncMutex::new(ServerSlot::new(None, None)),
        reach_check: ReachCheckState::new(),
        audit: AuditLogService::new(pool.clone()),
        backup: BackupService::new(
            PathBuf::from("unused-in-tests").join("admin-template.sqlite3"),
            pool.clone(),
        ),
        system_info: SystemInfoService::new(pool.clone()),
        // ADR-0013: no probe wired in this minimal test state - these
        // tests exercise command bodies that never touch `metrics`.
        metrics: None,
        attachments: AttachmentsService::new(
            pool,
            PathBuf::from("unused-in-tests").join("attachments"),
        ),
        attachments_dir: PathBuf::from("unused-in-tests").join("attachments"),
        exports_dir: PathBuf::from("unused-in-tests").join("exports"),
        started_at: std::time::Instant::now(),
    }
}

/// Like [`app_state`], but backed by a REAL on-disk db in a fresh temp
/// directory rather than `:memory:` - required for the M17 backup tests
/// below, since `BackupService::create`'s `VACUUM INTO` silently writes
/// nothing when its source pool is `:memory:` (see
/// `admin_template_core::backup`'s test module doc comment for the
/// empirically-verified reason). The returned `TempDir` guard must be
/// kept alive by the caller for as long as `AppState` is still in use.
async fn app_state_with_tempdir() -> (AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = app_state_in(&dir).await;
    (state, dir)
}

/// The [`AppState`] of [`app_state_with_tempdir`], over the DB file in
/// `dir`. Every call opens its OWN pool on that file, so two states built
/// from the same `dir` stand for two app processes sharing one database
/// (Issue #204's cross-process session tests).
async fn app_state_in(dir: &tempfile::TempDir) -> AppState {
    let db_path = dir.path().join("admin-template.sqlite3");
    let pool = admin_template_core::db::init_db(&db_path)
        .await
        .expect("init_db");
    let events = event_channel();
    AppState {
        // [scaffold:items] begin
        items: ItemsService::new(pool.clone()).with_events(events.clone()),
        // [scaffold:items] end
        resources: AppResources::new(&pool, &events),
        auth: Mutex::new(AuthSlot::default()),
        firewall_change_running: std::sync::atomic::AtomicBool::new(false),
        auth_config_lock: AsyncMutex::new(()),
        auth_io: AuthIo::production(
            &UsersService::new(pool.clone()),
            &SettingsService::new(pool.clone()),
        ),
        users: UsersService::new(pool.clone()),
        settings: SettingsService::new(pool.clone()),
        events,
        // Issue #204: the production wiring, so cross-transport tests
        // exercise the same session re-check the embedded server uses.
        rest_auth: user_auth_state(
            UsersService::new(pool.clone()),
            AuditLogService::new(pool.clone()),
        ),
        server: AsyncMutex::new(ServerSlot::new(None, None)),
        reach_check: ReachCheckState::new(),
        audit: AuditLogService::new(pool.clone()),
        backup: BackupService::new(db_path, pool.clone())
            .with_migrations(admin_template_core::db::sqlite_migration_manifest()),
        system_info: SystemInfoService::new(pool.clone()),
        metrics: None,
        attachments: AttachmentsService::new(pool, dir.path().join("attachments")),
        attachments_dir: dir.path().join("attachments"),
        exports_dir: dir.path().join("exports"),
        started_at: std::time::Instant::now(),
    }
}

/// Spec M14: the Tauri-side self-service password change must be
/// recorded as `password_change` (actor = entity = the caller), and the
/// entry's `detail` must never carry the password.
#[tokio::test]
async fn change_own_password_is_recorded_as_password_change() {
    let state = app_state().await;
    let owner = state
        .users
        .setup_first_user("owner", "password123", "オーナー")
        .await
        .expect("setup_first_user");
    let owner_id = owner.id;
    state.set_session_for_test(Some(DesktopSession::Account(owner)));

    change_own_password(&state, "password123", "newpassword1")
        .await
        .expect("change_own_password should succeed");

    let result = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = result
        .rows
        .iter()
        .find(|r| r.action == "password_change")
        .unwrap_or_else(|| panic!("expected a password_change entry, got {:?}", result.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("owner"));
    assert_eq!(entry.actor_role.as_deref(), Some("admin"));
    assert_eq!(entry.resource, "users");
    assert_eq!(
        entry.entity_id.as_deref(),
        Some(owner_id.to_string().as_str())
    );
    assert_eq!(entry.origin, "tauri");
    assert_eq!(entry.result, "ok");
    assert_eq!(entry.detail, None, "detail must never carry the password");
}

/// A FAILED password change (wrong current password) must record
/// nothing - only the success path is a completed security event.
#[tokio::test]
async fn failed_change_own_password_records_nothing() {
    let state = app_state().await;
    let owner = state
        .users
        .setup_first_user("owner", "password123", "オーナー")
        .await
        .expect("setup_first_user");
    state.set_session_for_test(Some(DesktopSession::Account(owner)));

    change_own_password(&state, "not-the-password", "newpassword1")
        .await
        .expect_err("wrong current password should fail");

    let result = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    assert!(
        result.rows.iter().all(|r| r.action != "password_change"),
        "a failed change must not be recorded as password_change: {:?}",
        result.rows
    );
}

// [scaffold:items] begin
// --- M15: CSV import -----------------------------------------------------
//
// D1-d/PR-D2: the whole M15 suite exercises `items_import_body`, so it is
// items-only and travels with the `items` remover.

/// `editor` can import; a mixed create+update batch succeeds and is
/// recorded as exactly ONE `action: "import"` audit entry (spec M15:
/// "件数サマリ付き1件記録"), with a `{created,updated}` summary detail
/// and no `entityId`.
#[tokio::test]
async fn items_import_records_one_audit_entry_on_success() {
    let state = app_state().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));

    let existing = state
        .items
        .create(ItemInput {
            name: "Existing".to_string(),
            price: 10,
            stock: 1,
            version: None,
        })
        .await
        .expect("seed create");

    let result = items_import_body(
        &state,
        vec![
            ItemImportRow {
                id: Some(existing.id),
                name: "Updated".to_string(),
                price: 20,
                stock: 2,
            },
            ItemImportRow {
                id: None,
                name: "Brand New".to_string(),
                price: 30,
                stock: 3,
            },
        ],
    )
    .await
    .expect("items_import_body should succeed");
    assert_eq!(result.created, 1);
    assert_eq!(result.updated, 1);
    assert!(result.errors.is_empty());

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entries: Vec<_> = audit.rows.iter().filter(|r| r.action == "import").collect();
    assert_eq!(
        entries.len(),
        1,
        "expected exactly one import entry, got {:?}",
        audit.rows
    );
    let entry = entries[0];
    assert_eq!(entry.actor_username.as_deref(), Some("editor"));
    assert_eq!(entry.actor_role.as_deref(), Some("editor"));
    assert_eq!(entry.resource, "items");
    assert_eq!(entry.entity_id, None);
    assert_eq!(entry.origin, "tauri");
    assert_eq!(entry.result, "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail should be set")).unwrap();
    assert_eq!(detail, serde_json::json!({ "created": 1, "updated": 1 }));
}

/// A per-row validation error rolls the whole batch back - including the
/// otherwise-valid row in the same batch - and is recorded as a single
/// `result: "failed"` entry summarizing the error count (spec M15).
#[tokio::test]
async fn items_import_validation_error_rolls_back_and_is_recorded_as_failed() {
    let state = app_state().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));

    // `app_state()` is backed by `init_db_memory` (spec §12), which
    // seeds 1,000 demo rows - capture that baseline rather than
    // asserting an absolute `0` below, since this test cares about "did
    // the import add anything", not "is the table empty".
    let before = state
        .items
        .list(ListParams::default())
        .await
        .expect("list")
        .total_count;

    let result = items_import_body(
        &state,
        vec![
            ItemImportRow {
                id: None,
                name: "Valid".to_string(),
                price: 10,
                stock: 1,
            },
            ItemImportRow {
                id: None,
                name: "".to_string(), // fails validation
                price: 1,
                stock: 1,
            },
        ],
    )
    .await
    .expect("items_import_body should return Ok with row errors, not Err");
    assert_eq!(result.created, 0);
    assert_eq!(result.updated, 0);
    assert_eq!(result.errors.len(), 1);

    let list = state.items.list(ListParams::default()).await.expect("list");
    assert_eq!(
        list.total_count, before,
        "a rolled-back import must not leave partial rows"
    );

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "import")
        .unwrap_or_else(|| panic!("expected an import entry, got {:?}", audit.rows));
    assert_eq!(entry.result, "failed");
    assert_eq!(entry.actor_username.as_deref(), Some("editor"));
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail should be set")).unwrap();
    assert_eq!(detail, serde_json::json!({ "errorCount": 1 }));
}

/// `viewer` cannot import (spec M15: editor+ only, same `require_role`
/// floor as `items_create`/`update`/`delete`).
#[tokio::test]
async fn viewer_cannot_import_items() {
    let state = app_state().await;
    let viewer = state
        .users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(viewer)));
    let before = state
        .items
        .list(ListParams::default())
        .await
        .expect("list")
        .total_count;

    let err = items_import_body(
        &state,
        vec![ItemImportRow {
            id: None,
            name: "Nope".to_string(),
            price: 1,
            stock: 1,
        }],
    )
    .await
    .unwrap_err();
    assert!(matches!(err, BantoError::Forbidden));

    let list = state.items.list(ListParams::default()).await.expect("list");
    assert_eq!(
        list.total_count, before,
        "a forbidden import must not touch the table"
    );
}
// [scaffold:items] end

// --- M17: SQLite backup/restore -------------------------------------------

/// `admin` can create a backup, and it is recorded as `action: "backup"`
/// with `entityId` = the created file name (spec M17).
#[tokio::test]
async fn backups_create_records_a_backup_audit_entry() {
    let (state, _dir) = app_state_with_tempdir().await;
    let admin = state
        .users
        .create_user("manager", "password123", "管理者", Role::Admin)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(admin)));

    let info = backups_create_body(&state)
        .await
        .expect("backups_create_body should succeed");
    assert!(info.file_name.starts_with("banto-"));
    assert!(info.size_bytes > 0);

    let listed = state.backup.list().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].file_name, info.file_name);

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "backup")
        .unwrap_or_else(|| panic!("expected a backup entry, got {:?}", audit.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("manager"));
    assert_eq!(entry.resource, "backups");
    assert_eq!(entry.entity_id.as_deref(), Some(info.file_name.as_str()));
    assert_eq!(entry.origin, "tauri");
    assert_eq!(entry.result, "ok");
}

/// A `viewer` cannot create a backup (spec M17: "admin以外は全API 403"
/// on the Tauri side too).
#[tokio::test]
async fn viewer_cannot_create_backups() {
    let (state, _dir) = app_state_with_tempdir().await;
    let viewer = state
        .users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(viewer)));

    let err = backups_create_body(&state).await.unwrap_err();
    assert!(matches!(err, BantoError::Forbidden));
    assert!(state.backup.list().await.unwrap().is_empty());
}

/// Stage a restore from an existing backup, then confirm it shows up as
/// pending - the round trip `backups_create` -> `backups_stage_restore`
/// -> `backups_pending` (spec M17), plus the `restore_staged` audit
/// entry.
#[tokio::test]
async fn stage_restore_then_pending_reports_it() {
    let (state, _dir) = app_state_with_tempdir().await;
    let admin = state
        .users
        .create_user("manager", "password123", "管理者", Role::Admin)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(admin)));

    let info = backups_create_body(&state).await.expect("create");
    assert!(state.backup.pending_restore().await.is_none());

    backups_stage_restore_body(&state, &info.file_name)
        .await
        .expect("stage_restore should succeed");

    let pending = state
        .backup
        .pending_restore()
        .await
        .expect("should now be pending");
    assert!(pending.size_bytes > 0);

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "restore_staged")
        .unwrap_or_else(|| panic!("expected a restore_staged entry, got {:?}", audit.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("manager"));
    assert_eq!(entry.resource, "backups");
    assert_eq!(entry.origin, "tauri");
    assert_eq!(entry.result, "ok");

    backups_cancel_restore_body(&state)
        .await
        .expect("cancel_restore should succeed");
    assert!(state.backup.pending_restore().await.is_none());

    let audit_after_cancel = state.audit.list(ListParams::default()).await.unwrap();
    assert!(
        audit_after_cancel
            .rows
            .iter()
            .any(|r| r.action == "restore_cancelled"),
        "expected a restore_cancelled entry, got {:?}",
        audit_after_cancel.rows
    );
}

// [scaffold:items] begin
/// Issue #638: [`items_delete_body`] with a stale `version` answers a
/// `Conflict`, deletes nothing and records nothing - the same as REST's
/// `DELETE /api/items/{id}?version=N` (conventions section 1); the
/// matching version deletes and records as usual.
#[tokio::test]
async fn items_delete_with_a_stale_version_conflicts_without_an_audit_row() {
    let state = app_state().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));
    let item = state
        .items
        .create(ItemInput {
            name: "Locked".to_string(),
            price: 1,
            stock: 1,
            version: None,
        })
        .await
        .expect("seed item");

    let result = items_delete_body(&state, item.id, Some(2)).await;
    assert!(
        matches!(result, Err(BantoError::Conflict { .. })),
        "{result:?}"
    );
    assert!(state.items.get(item.id).await.is_ok(), "row must remain");
    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    assert!(
        !audit
            .rows
            .iter()
            .any(|r| r.action == "delete" && r.resource == "items"),
        "a conflict must not be recorded: {:?}",
        audit.rows
    );

    items_delete_body(&state, item.id, Some(1))
        .await
        .expect("matching version deletes");
}

/// [`items_delete_body`] records the removed values in its audit detail.
#[tokio::test]
async fn items_delete_is_recorded_as_delete() {
    let state = app_state().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));
    let item = state
        .items
        .create(ItemInput {
            name: "Doomed".to_string(),
            price: 1,
            stock: 1,
            version: None,
        })
        .await
        .expect("seed item");

    items_delete_body(&state, item.id, None)
        .await
        .expect("delete should succeed");

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "delete" && r.resource == "items")
        .unwrap_or_else(|| panic!("expected a delete/items entry, got {:?}", audit.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("editor"));
    assert_eq!(entry.actor_role.as_deref(), Some("editor"));
    assert_eq!(
        entry.entity_id.as_deref(),
        Some(item.id.to_string().as_str())
    );
    assert_eq!(entry.origin, "tauri");
    assert_eq!(entry.result, "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail")).unwrap();
    assert_eq!(detail["name"], "Doomed");
    assert_eq!(
        detail["changes"],
        serde_json::json!([
            { "field": "name", "before": "Doomed", "after": null },
            { "field": "price", "before": 1, "after": null },
            { "field": "stock", "before": 1, "after": null }
        ])
    );
    assert!(detail.get("attachmentsRemoved").is_none());
}

// --- Issue #713: bulk delete (+ the viewer denial of a single delete) ---

/// An `AppState` whose session is a fresh account of `role`.
async fn app_state_as(role: Role) -> AppState {
    let state = app_state().await;
    let user = state
        .users
        .create_user("actor", "password123", "操作者", role)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(user)));
    state
}

async fn seed_item(state: &AppState, name: &str) -> Item {
    state
        .items
        .create(ItemInput {
            name: name.to_string(),
            price: 1,
            stock: 1,
            version: None,
        })
        .await
        .expect("seed item")
}

async fn items_total(state: &AppState) -> u64 {
    state
        .items
        .list(ListParams::default())
        .await
        .expect("list")
        .total_count
}

async fn audit_rows_for(state: &AppState, action: &str) -> Vec<serde_json::Value> {
    state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows
        .iter()
        .filter(|r| r.action == action && r.resource == "items")
        .map(|r| serde_json::to_value(r).expect("audit row"))
        .collect()
}

fn bulk_ids(items: &[(i64, Option<i64>)]) -> admin_template_core::items::BulkDeleteTarget {
    admin_template_core::items::BulkDeleteTarget::Ids {
        items: items
            .iter()
            .map(|&(id, version)| admin_template_core::items::BulkDeleteItem { id, version })
            .collect(),
    }
}

/// `viewer` cannot delete (editor+): `Forbidden`, the row stays, and the
/// refusal is one `denied` audit row - REST's `RoleGuard` twin.
#[tokio::test]
async fn viewer_cannot_delete_items() {
    let state = app_state_as(Role::Viewer).await;
    let item = seed_item(&state, "Kept").await;

    let err = items_delete_body(&state, item.id, Some(1))
        .await
        .unwrap_err();
    assert!(matches!(err, BantoError::Forbidden));
    assert!(state.items.get(item.id).await.is_ok(), "row must remain");
    let denied = audit_rows_for(&state, "denied").await;
    assert_eq!(denied.len(), 1, "{denied:?}");
    assert_eq!(denied[0]["actorUsername"], "actor");
    assert_eq!(denied[0]["actorRole"], "viewer");
    assert_eq!(denied[0]["origin"], "tauri");
    assert_eq!(denied[0]["result"], "denied");
    assert!(audit_rows_for(&state, "delete").await.is_empty());
}

/// `viewer` cannot bulk-delete either: same refusal, same `denied` row.
#[tokio::test]
async fn viewer_cannot_bulk_delete_items() {
    let state = app_state_as(Role::Viewer).await;
    let item = seed_item(&state, "Kept").await;
    let before = items_total(&state).await;

    let err = items_bulk_delete_body(&state, bulk_ids(&[(item.id, Some(1))]))
        .await
        .unwrap_err();
    assert!(matches!(err, BantoError::Forbidden));
    assert_eq!(items_total(&state).await, before);
    let denied = audit_rows_for(&state, "denied").await;
    assert_eq!(denied.len(), 1, "{denied:?}");
    assert_eq!(denied[0]["actorUsername"], "actor");
    assert_eq!(denied[0]["result"], "denied");
    assert!(audit_rows_for(&state, "bulk_delete").await.is_empty());
}

/// `editor` deletes the named rows; the whole request is ONE
/// `bulk_delete` entry with the same detail shape as REST's.
#[tokio::test]
async fn items_bulk_delete_by_ids_records_one_audit_entry() {
    let state = app_state_as(Role::Editor).await;
    let a = seed_item(&state, "A").await;
    let b = seed_item(&state, "B").await;
    let before = items_total(&state).await;

    let result = items_bulk_delete_body(&state, bulk_ids(&[(a.id, Some(1)), (b.id, Some(1))]))
        .await
        .expect("bulk delete should succeed");
    assert_eq!(result.deleted, 2);
    assert_eq!(items_total(&state).await, before - 2);

    let entries = audit_rows_for(&state, "bulk_delete").await;
    assert_eq!(entries.len(), 1, "{entries:?}");
    let entry = &entries[0];
    assert_eq!(entry["actorUsername"], "actor");
    assert_eq!(entry["actorRole"], "editor");
    assert_eq!(entry["origin"], "tauri");
    assert_eq!(entry["result"], "ok");
    assert!(entry["entityId"].is_null());
    let detail: serde_json::Value =
        serde_json::from_str(entry["detail"].as_str().expect("detail")).unwrap();
    assert_eq!(
        detail,
        serde_json::json!({ "mode": "ids", "count": 2, "ids": [a.id, b.id] })
    );
    assert!(
        audit_rows_for(&state, "delete").await.is_empty(),
        "no per-row delete entries"
    );
}

/// One stale version (or one missing id) refuses the whole request:
/// `Conflict`, nothing deleted, nothing audited.
#[tokio::test]
async fn items_bulk_delete_with_a_stale_version_deletes_nothing() {
    let state = app_state_as(Role::Editor).await;
    let a = seed_item(&state, "A").await;
    let b = seed_item(&state, "B").await;
    let before = items_total(&state).await;

    for target in [
        bulk_ids(&[(a.id, Some(1)), (b.id, Some(7))]),
        bulk_ids(&[(a.id, Some(1)), (i64::MAX, Some(1))]),
    ] {
        let result = items_bulk_delete_body(&state, target).await;
        assert!(
            matches!(result, Err(BantoError::Conflict { .. })),
            "{result:?}"
        );
        assert_eq!(items_total(&state).await, before);
    }
    assert!(audit_rows_for(&state, "bulk_delete").await.is_empty());
}

/// More than `MAX_BULK_DELETE_ROWS` (or no target at all) is
/// `BadRequest`: nothing deleted, nothing audited.
#[tokio::test]
async fn items_bulk_delete_over_the_limit_or_empty_is_bad_request() {
    let state = app_state_as(Role::Editor).await;
    let before = items_total(&state).await;
    let over = admin_template_core::items::MAX_BULK_DELETE_ROWS as i64 + 1;
    let too_many: Vec<(i64, Option<i64>)> = (1..=over).map(|id| (id, Some(1))).collect();

    for target in [bulk_ids(&too_many), bulk_ids(&[])] {
        let result = items_bulk_delete_body(&state, target).await;
        assert!(
            matches!(result, Err(BantoError::BadRequest(_))),
            "{result:?}"
        );
    }
    assert_eq!(items_total(&state).await, before);
    assert!(audit_rows_for(&state, "bulk_delete").await.is_empty());
}
// [scaffold:items] end

#[tokio::test]
async fn users_create_and_delete_record_values_via_tauri() {
    let state = admin_app_state().await;
    let created = users_create_body(&state, "target", "password123", "Target", Role::Editor)
        .await
        .unwrap();
    users_delete_body(&state, created.id, None).await.unwrap();
    let rows = state.audit.list(ListParams::default()).await.unwrap().rows;
    for (action, before, after) in [
        (
            "create",
            serde_json::json!(null),
            serde_json::json!("Target"),
        ),
        (
            "delete",
            serde_json::json!("Target"),
            serde_json::json!(null),
        ),
    ] {
        let entry = rows
            .iter()
            .find(|r| {
                r.action == action
                    && r.resource == "users"
                    && r.entity_id.as_deref() == Some(created.id.to_string().as_str())
            })
            .unwrap();
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().unwrap()).unwrap();
        assert_eq!(detail["username"], "target");
        assert!(detail["changes"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!({
                "field": "displayName", "before": before, "after": after
            })));
        assert!(!entry.detail.as_deref().unwrap().contains("password123"));
    }
}

/// Issue #651: [`users_update_body`] / [`users_delete_body`] with a stale
/// `version` answer a `Conflict`, change nothing and record nothing - the
/// same as REST (conventions section 1); the matching version applies.
#[tokio::test]
async fn users_update_and_delete_with_a_stale_version_conflict_without_audit() {
    let state = admin_app_state().await;
    let created = users_create_body(&state, "target", "password123", "Target", Role::Editor)
        .await
        .unwrap();
    let updated = users_update_body(&state, created.id, "改", Role::Editor, Some(1), None)
        .await
        .unwrap();
    assert_eq!(updated.user.version, 2);

    let stale = users_update_body(&state, created.id, "遅", Role::Viewer, Some(1), None).await;
    assert!(
        matches!(stale, Err(BantoError::Conflict { .. })),
        "{stale:?}"
    );
    let stale = users_delete_body(&state, created.id, Some(1)).await;
    assert!(
        matches!(stale, Err(BantoError::Conflict { .. })),
        "{stale:?}"
    );

    let rows = state.audit.list(ListParams::default()).await.unwrap().rows;
    let mine = |action: &str| {
        rows.iter()
            .filter(|r| {
                r.action == action
                    && r.resource == "users"
                    && r.entity_id.as_deref() == Some(created.id.to_string().as_str())
            })
            .count()
    };
    assert_eq!((mine("update"), mine("delete")), (1, 0));

    users_delete_body(&state, created.id, Some(2))
        .await
        .expect("matching version deletes");
}

/// [`auth_config_apply_with_permissions_body`]'s normal (non-escape-hatch) path records a
/// `settings_change`/`settings` entry attributed to the admin, with an
/// `{authDisabled}` detail (M-review 2026-08 M-5).
#[tokio::test]
async fn auth_config_apply_is_recorded_as_settings_change() {
    let state = app_state().await;
    let admin = state
        .users
        .setup_first_user("manager", "password123", "管理者")
        .await
        .expect("setup_first_user");
    state.set_session_for_test(Some(DesktopSession::Account(admin)));

    auth_config_apply_body(&state, true, "viewer")
        .await
        .expect("auth_config_apply should succeed");

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "settings_change" && r.resource == "settings")
        .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("manager"));
    assert_eq!(entry.actor_role.as_deref(), Some("admin"));
    assert_eq!(entry.entity_id, None);
    assert_eq!(entry.origin, "tauri");
    assert_eq!(entry.result, "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail present"))
            .expect("detail is json");
    assert_eq!(detail, serde_json::json!({ "authDisabled": true }));
}

/// [`auth_config_apply_with_permissions_body`]'s bootstrap window (choiapp-feedback-2026-09
/// §5): with ZERO accounts and no session, enabling no-login mode from
/// the first-run setup screen succeeds, records the `settings_change`
/// with no actor, synthesizes the same "local" session `run()`'s
/// bootstrap would, and records its synthetic `login` entry.
#[tokio::test]
async fn auth_config_apply_bootstrap_window_enables_and_synthesizes_session() {
    let state = app_state().await;

    let config = auth_config_apply_body(&state, true, "admin")
        .await
        .expect("bootstrap-window apply should succeed with zero users");
    assert!(config.disabled);

    let session = state
        .auth
        .lock()
        .expect("auth mutex poisoned")
        .session
        .clone()
        .expect("a synthetic session should exist without a restart");
    let DesktopSession::AuthDisabledLocal(session) = session else {
        panic!("the bootstrap window must install the synthetic kind, got {session:?}");
    };
    assert_eq!(session.username, "local");
    assert_eq!(session.role, Role::Admin);

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let change = audit
        .rows
        .iter()
        .find(|r| r.action == "settings_change" && r.resource == "settings")
        .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
    assert_eq!(change.actor_username, None, "nobody exists yet");
    let login = audit
        .rows
        .iter()
        .find(|r| r.action == "login" && r.resource == "auth")
        .unwrap_or_else(|| panic!("expected a synthetic login entry, got {:?}", audit.rows));
    assert_eq!(login.actor_username.as_deref(), Some("local"));
    let detail: serde_json::Value =
        serde_json::from_str(login.detail.as_deref().expect("detail present"))
            .expect("detail is json");
    assert_eq!(detail, serde_json::json!({ "mode": "auth_disabled" }));
}

/// The bootstrap window closes the moment the first account exists
/// (choiapp-feedback-2026-09 §5): once initialized, a session-less call
/// is `Unauthorized` again, exactly as before the window existed.
#[tokio::test]
async fn auth_config_apply_bootstrap_window_closes_once_initialized() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("manager", "password123", "管理者")
        .await
        .expect("setup_first_user");

    let err = auth_config_apply_body(&state, true, "admin")
        .await
        .expect_err("a session-less apply must be rejected once initialized");
    assert!(matches!(err, BantoError::Unauthorized));
}

/// [`autologin_enable_body`] records a `settings_change`/`settings` entry
/// with an `{autologinEnabled,username}` detail (M-review 2026-08 M-5).
/// Installs the in-memory keyring first so `keyring_store::set_password`
/// does not hit the OS secret service on a headless CI runner (the Linux
/// leg has no D-Bus/secret-service).
#[tokio::test]
async fn autologin_enable_is_recorded_as_settings_change() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let state = app_state().await;
    let admin = state
        .users
        .setup_first_user("manager", "password123", "管理者")
        .await
        .expect("setup_first_user");
    state.set_session_for_test(Some(DesktopSession::Account(admin)));

    autologin_enable_body(&state, "manager", "password123")
        .await
        .expect("autologin_enable should succeed");

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "settings_change" && r.resource == "settings")
        .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("manager"));
    assert_eq!(entry.entity_id, None);
    assert_eq!(entry.result, "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail present"))
            .expect("detail is json");
    assert_eq!(
        detail,
        serde_json::json!({ "autologinEnabled": true, "username": "manager" })
    );
}

/// [`autologin_disable_body`] records a `settings_change`/`settings` entry
/// with an `{autologinEnabled:false}` detail (M-review 2026-08 M-5). No
/// keyring is touched: with `autologin_username` unset the delete is
/// skipped.
#[tokio::test]
async fn autologin_disable_is_recorded_as_settings_change() {
    let state = app_state().await;
    let admin = state
        .users
        .setup_first_user("manager", "password123", "管理者")
        .await
        .expect("setup_first_user");
    state.set_session_for_test(Some(DesktopSession::Account(admin)));

    autologin_disable_body(&state)
        .await
        .expect("autologin_disable should succeed");

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "settings_change" && r.resource == "settings")
        .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("manager"));
    assert_eq!(entry.entity_id, None);
    assert_eq!(entry.result, "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail present"))
            .expect("detail is json");
    assert_eq!(detail, serde_json::json!({ "autologinEnabled": false }));
}

// --- M20: attachments command tests -----------------------------------
// scaffold.mjs (`removeAttachmentsFromLibRs`) cuts this whole block for
// the minimal/standard presets, exactly as it removes the attachments
// commands themselves. These tests reference ONLY `attachments_*_body`
// (also removed by scaffold), so nothing survives the cut - keep it that
// way if you add more here.

/// [`attachments_upload_body`] records a `create`/`attachments` entry with
/// the `{fileName,sizeBytes,parentResource,parentId}` detail (M-review
/// 2026-08 M-5). Uses a real temp attachments dir so the upload can write.
#[tokio::test]
async fn attachments_upload_is_recorded_as_create() {
    let (state, _dir) = app_state_with_tempdir().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));

    let meta = attachments_upload_body(
        &state,
        "items".to_string(),
        "1".to_string(),
        "note.txt".to_string(),
        b"hello attachment".to_vec(),
    )
    .await
    .expect("upload should succeed");

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "create" && r.resource == "attachments")
        .unwrap_or_else(|| panic!("expected a create/attachments entry, got {:?}", audit.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("editor"));
    assert_eq!(
        entry.entity_id.as_deref(),
        Some(meta.id.to_string().as_str())
    );
    assert_eq!(entry.origin, "tauri");
    assert_eq!(entry.result, "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail present"))
            .expect("detail is json");
    assert_eq!(
        detail,
        serde_json::json!({
            "fileName": "note.txt",
            "sizeBytes": 16,
            "parentResource": "items",
            "parentId": "1"
        })
    );
}

#[tokio::test]
async fn attachments_upload_rejects_untrusted_or_missing_parent() {
    let (state, dir) = app_state_with_tempdir().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));
    for (resource, resource_id) in [
        ("users", "1"),
        ("items", "999999"),
        ("items", "bad"),
        ("items", "01"),
    ] {
        let result = attachments_upload_body(
            &state,
            resource.to_string(),
            resource_id.to_string(),
            "note.txt".to_string(),
            b"hello".to_vec(),
        )
        .await;
        if resource == "items" && resource_id == "999999" {
            assert!(
                matches!(result, Err(BantoError::NotFound { .. })),
                "{resource}/{resource_id}"
            );
        } else {
            assert!(
                matches!(result, Err(BantoError::BadRequest(_))),
                "{resource}/{resource_id}"
            );
        }
    }
    let audit = state.audit.list(ListParams::default()).await.unwrap();
    assert!(audit
        .rows
        .iter()
        .all(|row| !(row.resource == "attachments" && row.action == "create")));
    let attachment_dir = dir.path().join("attachments");
    assert!(
        !attachment_dir.exists() || std::fs::read_dir(attachment_dir).unwrap().next().is_none(),
        "rejected uploads must not write an attachment body"
    );
}

/// Issue #285: a failed `has_thumbnail` flag update (injected with a SQLite
/// trigger) must not fail the upload - the body is stored, so the command
/// still records the success audit entry and broadcasts the change event.
#[tokio::test]
async fn attachments_upload_survives_a_thumbnail_flag_update_failure() {
    let (state, dir) = app_state_with_tempdir().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));
    // A second connection to the same DB file; the trigger lives in the file.
    let injector = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.path().join("admin-template.sqlite3")),
    )
    .await
    .expect("connect injector");
    sqlx::query(
        "CREATE TRIGGER fail_thumb BEFORE UPDATE OF has_thumbnail ON attachments              BEGIN SELECT RAISE(ABORT, 'injected'); END",
    )
    .execute(&injector)
    .await
    .expect("create trigger");
    let mut rx = state.events.subscribe();

    // 1x1 PNG: decodable, so a thumbnail is generated before the flag
    // update is attempted.
    let png: Vec<u8> = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x64,
        0x60, 0xF8, 0xCF, 0x50, 0x0F, 0x00, 0x02, 0x87, 0x01, 0x80, 0xEB, 0x47, 0xBA, 0x92, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let meta = attachments_upload_body(
        &state,
        "items".to_string(),
        "1".to_string(),
        "p.png".to_string(),
        png,
    )
    .await
    .expect("upload must succeed despite the flag update failing");
    assert_eq!(meta.mime, "image/png");
    assert!(!meta.has_thumbnail);

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    assert!(
        audit
            .rows
            .iter()
            .any(|r| r.action == "create" && r.resource == "attachments" && r.result == "ok"),
        "expected a successful create entry, got {:?}",
        audit.rows
    );
    let event = rx.try_recv().expect("upload should emit an event");
    assert!(
        matches!(event, ServerEvent::ResourceChanged { resource } if resource == "attachments")
    );
}

/// [`attachments_delete_body`] records a `delete`/`attachments` entry with
/// the deleted meta's detail (M-review 2026-08 M-5). Seeds one attachment
/// via [`attachments_upload_body`] (transitively exercising its happy
/// path).
#[tokio::test]
async fn attachments_delete_is_recorded_as_delete() {
    let (state, _dir) = app_state_with_tempdir().await;
    let editor = state
        .users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(editor)));
    let meta = attachments_upload_body(
        &state,
        "items".to_string(),
        "1".to_string(),
        "note.txt".to_string(),
        b"hello attachment".to_vec(),
    )
    .await
    .expect("seed upload");

    attachments_delete_body(&state, meta.id)
        .await
        .expect("delete should succeed");

    let audit = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list");
    let entry = audit
        .rows
        .iter()
        .find(|r| r.action == "delete" && r.resource == "attachments")
        .unwrap_or_else(|| panic!("expected a delete/attachments entry, got {:?}", audit.rows));
    assert_eq!(
        entry.entity_id.as_deref(),
        Some(meta.id.to_string().as_str())
    );
    assert_eq!(entry.result, "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail present"))
            .expect("detail is json");
    assert_eq!(
        detail,
        serde_json::json!({
            "fileName": "note.txt",
            "sizeBytes": 16,
            "parentResource": "items",
            "parentId": "1"
        })
    );
    let history = state
        .audit
        .list(ListParams {
            filters: vec![
                banto_core::FilterState {
                    field: "recordResource".into(),
                    op: banto_core::FilterOp::Eq,
                    value: serde_json::json!("items"),
                },
                banto_core::FilterState {
                    field: "recordId".into(),
                    op: banto_core::FilterOp::Eq,
                    value: serde_json::json!("1"),
                },
            ],
            ..Default::default()
        })
        .await
        .expect("parent record history");
    assert_eq!(
        history
            .rows
            .iter()
            .filter(|row| row.resource == "attachments")
            .count(),
        2
    );
}
// --- end M20 attachments command tests ---------------------------------

// --- Issue #204: session revocation across transports and processes ----
//
// Two (or three) `AppState`s over ONE on-disk DB, each with its own pool,
// stand for separate app processes. One of them also serves the REST
// account routes (a real TCP server, driven with plain HTTP/1.1 so this
// crate needs no HTTP client dependency).

use banto_server::routes::{extra_auth_router, users_router};
use banto_server::{auth_routes, start, GrantRegistry, GrantSpec, LoginOutcome};

const REVOCATION_PASSWORD: &str = "password123";

#[derive(Clone, Copy, Debug)]
enum AccountChange {
    Delete,
    Demote,
    PasswordChange,
    PasswordReset,
}

const ALL_CHANGES: [AccountChange; 4] = [
    AccountChange::Delete,
    AccountChange::Demote,
    AccountChange::PasswordChange,
    AccountChange::PasswordReset,
];

/// `operator` (admin), `bystander` (editor, never affected) and `target`
/// (admin, the account changed; its id is returned), in the DB behind
/// `state`.
async fn seed_revocation_accounts(state: &AppState) -> i64 {
    state
        .users
        .setup_first_user("operator", REVOCATION_PASSWORD, "操作者")
        .await
        .expect("setup_first_user");
    state
        .users
        .create_user("bystander", REVOCATION_PASSWORD, "無関係", Role::Editor)
        .await
        .expect("create bystander");
    state
        .users
        .create_user("target", REVOCATION_PASSWORD, "対象", Role::Admin)
        .await
        .expect("create target")
        .id
}

/// The webview session `auth_login` establishes (same verify + store).
async fn desktop_login(state: &AppState, username: &str) {
    let user = state
        .users
        .verify(username, REVOCATION_PASSWORD)
        .await
        .unwrap()
        .expect("valid credentials");
    state.set_session_for_test(Some(DesktopSession::Account(user)));
}

/// A LAN session on `state`'s embedded-server auth state.
async fn rest_token(state: &AppState, username: &str, remember: bool) -> String {
    match state
        .rest_auth
        .login_rate_limited(None, username, REVOCATION_PASSWORD, remember)
        .await
    {
        LoginOutcome::Success(token) => token,
        other => panic!("REST login of {username} failed: {other:?}"),
    }
}

/// The account routes of the embedded server, on an OS-picked port.
async fn serve_account_routes(state: &AppState) -> RunningServer {
    let router = users_router(
        state.users.clone(),
        state.audit.clone(),
        state.rest_auth.clone(),
    )
    .merge(extra_auth_router(
        state.users.clone(),
        state.rest_auth.clone(),
        state.audit.clone(),
        false,
        {
            let mut grants = GrantRegistry::new();
            grants
                .register(GrantSpec::public_viewer(state.settings.clone()))
                .unwrap();
            std::sync::Arc::new(grants)
        },
        None,
    ))
    .merge(auth_routes(state.rest_auth.clone()));
    start(
        ServerConfig {
            bind: "127.0.0.1".to_string(),
            port: 0,
        },
        router,
    )
    .await
    .expect("start test server")
}

/// One HTTP/1.1 request; returns (status, raw body).
async fn http(
    server: &RunningServer,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let addr = server.local_addr();
    let body = body.map(|value| value.to_string()).unwrap_or_default();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
         X-Banto-Client: banto\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(&body);
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.expect("read");
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("malformed response: {text}"));
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    (status, body)
}

async fn rest_session_is_live(server: &RunningServer, token: &str) -> bool {
    let (status, body) = http(server, "GET", "/api/auth/check", Some(token), None).await;
    assert_eq!(status, 200, "check: {body}");
    body.contains("true")
}

fn assert_unauthorized<T: std::fmt::Debug>(result: Result<T, BantoError>, what: &str) {
    match result {
        Err(BantoError::Unauthorized) => {}
        other => panic!("{what}: expected Unauthorized, got {other:?}"),
    }
}

/// The target's desktop session in `state` must be gone: guarded
/// commands refuse it (the issue's scenario: creating an admin), and the
/// cached session is cleared.
async fn assert_desktop_session_ended(state: &AppState, change: AccountChange) {
    assert_unauthorized(
        users_create_body(
            state,
            "intruder",
            REVOCATION_PASSWORD,
            "侵入者",
            Role::Admin,
        )
        .await,
        &format!("{change:?}: users_create from the old desktop session"),
    );
    assert_unauthorized(
        require_role(state, Role::Viewer, "items").await,
        &format!("{change:?}: any role from the old desktop session"),
    );
    assert!(
        state
            .auth
            .lock()
            .expect("auth mutex poisoned")
            .session
            .is_none(),
        "{change:?}: the ended desktop session must be cleared"
    );
    assert!(state
        .users
        .get_by_username("intruder")
        .await
        .unwrap()
        .is_none());
}

/// The target's LAN sessions (regular + Remember me) must be refused.
async fn assert_lan_sessions_ended(
    server: &RunningServer,
    tokens: [&str; 2],
    change: AccountChange,
) {
    for (label, token) in ["regular", "remember-me"].into_iter().zip(tokens) {
        let intruder = serde_json::json!({
            "username": format!("intruder-{label}"),
            "password": REVOCATION_PASSWORD,
            "displayName": "侵入者",
            "role": "admin",
        });
        let (status, _) = http(server, "POST", "/api/users", Some(token), Some(intruder)).await;
        assert_eq!(status, 401, "{change:?}: the {label} LAN session");
        assert!(
            !rest_session_is_live(server, token).await,
            "{change:?}: the {label} LAN session must report logged out"
        );
    }
}

/// A change made from a DESKTOP (Tauri command bodies) ends the
/// account's desktop session in another process and its LAN sessions.
#[tokio::test]
async fn desktop_changes_end_the_accounts_other_desktop_and_lan_sessions() {
    for change in ALL_CHANGES {
        let dir = tempfile::tempdir().expect("tempdir");
        let operator_desktop = app_state_in(&dir).await;
        let target_desktop = app_state_in(&dir).await;
        let target_id = seed_revocation_accounts(&operator_desktop).await;
        desktop_login(&operator_desktop, "operator").await;
        desktop_login(&target_desktop, "target").await;
        let server = serve_account_routes(&operator_desktop).await;
        let target_regular = rest_token(&operator_desktop, "target", false).await;
        let target_remembered = rest_token(&operator_desktop, "target", true).await;
        let bystander = rest_token(&operator_desktop, "bystander", true).await;
        assert!(require_role(&target_desktop, Role::Admin, "users")
            .await
            .is_ok());
        assert!(rest_session_is_live(&server, &target_remembered).await);

        let self_service_desktop = match change {
            AccountChange::Delete => {
                users_delete_body(&operator_desktop, target_id, None)
                    .await
                    .unwrap();
                None
            }
            AccountChange::Demote => {
                users_update_body(
                    &operator_desktop,
                    target_id,
                    "対象",
                    Role::Viewer,
                    None,
                    None,
                )
                .await
                .unwrap();
                None
            }
            AccountChange::PasswordReset => {
                users_reset_password_body(&operator_desktop, target_id, "resetpassword1")
                    .await
                    .unwrap();
                None
            }
            AccountChange::PasswordChange => {
                // The target changes it from a THIRD desktop process.
                let own = app_state_in(&dir).await;
                desktop_login(&own, "target").await;
                change_own_password(&own, REVOCATION_PASSWORD, "newpassword1")
                    .await
                    .unwrap();
                Some(own)
            }
        };

        assert_desktop_session_ended(&target_desktop, change).await;
        assert_lan_sessions_ended(&server, [&target_regular, &target_remembered], change).await;
        assert!(
            require_role(&operator_desktop, Role::Admin, "users")
                .await
                .is_ok(),
            "{change:?}: the operator's desktop session must survive"
        );
        assert!(
            rest_session_is_live(&server, &bystander).await,
            "{change:?}: the bystander's LAN session must survive"
        );
        if let Some(own) = self_service_desktop {
            assert!(
                require_role(&own, Role::Admin, "users").await.is_ok(),
                "{change:?}: the desktop that changed the password keeps its session"
            );
        }
        server.stop().await;
    }
}

/// A change made over REST (the embedded LAN server) ends the account's
/// desktop session - in another process - and its other LAN sessions.
#[tokio::test]
async fn lan_changes_end_the_accounts_desktop_and_other_lan_sessions() {
    for change in ALL_CHANGES {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = app_state_in(&dir).await;
        let target_desktop = app_state_in(&dir).await;
        let target_id = seed_revocation_accounts(&host).await;
        desktop_login(&host, "bystander").await;
        desktop_login(&target_desktop, "target").await;
        let server = serve_account_routes(&host).await;
        let operator = rest_token(&host, "operator", false).await;
        let target_regular = rest_token(&host, "target", false).await;
        let target_remembered = rest_token(&host, "target", true).await;

        let survivor = match change {
            AccountChange::Delete => {
                let path = format!("/api/users/{target_id}");
                let (status, _) = http(&server, "DELETE", &path, Some(&operator), None).await;
                assert_eq!(status, 204);
                None
            }
            AccountChange::Demote => {
                let path = format!("/api/users/{target_id}");
                let body = serde_json::json!({ "displayName": "対象", "role": "viewer" });
                let (status, _) = http(&server, "PUT", &path, Some(&operator), Some(body)).await;
                assert_eq!(status, 200);
                None
            }
            AccountChange::PasswordReset => {
                let path = format!("/api/users/{target_id}/reset-password");
                let body = serde_json::json!({ "newPassword": "resetpassword1" });
                let (status, _) = http(&server, "POST", &path, Some(&operator), Some(body)).await;
                assert_eq!(status, 200);
                None
            }
            AccountChange::PasswordChange => {
                let device = rest_token(&host, "target", false).await;
                let body = serde_json::json!({
                    "currentPassword": REVOCATION_PASSWORD,
                    "newPassword": "newpassword1",
                });
                let (status, _) = http(
                    &server,
                    "POST",
                    "/api/auth/change-password",
                    Some(&device),
                    Some(body),
                )
                .await;
                assert_eq!(status, 200);
                Some(device)
            }
        };

        assert_desktop_session_ended(&target_desktop, change).await;
        assert_lan_sessions_ended(&server, [&target_regular, &target_remembered], change).await;
        assert!(
            require_role(&host, Role::Viewer, "items").await.is_ok(),
            "{change:?}: the bystander's desktop session must survive"
        );
        assert!(
            rest_session_is_live(&server, &operator).await,
            "{change:?}: the operator's LAN session must survive"
        );
        if let Some(device) = survivor {
            assert!(
                rest_session_is_live(&server, &device).await,
                "{change:?}: the LAN session that changed the password keeps working"
            );
        }
        server.stop().await;
    }
}

/// A display-name edit is not a revocation, and the desktop session
/// picks up the new name from the DB (not the login-time copy).
#[tokio::test]
async fn desktop_session_follows_a_display_name_edit_without_ending() {
    let dir = tempfile::tempdir().expect("tempdir");
    let operator_desktop = app_state_in(&dir).await;
    let target_desktop = app_state_in(&dir).await;
    let target_id = seed_revocation_accounts(&operator_desktop).await;
    desktop_login(&operator_desktop, "operator").await;
    desktop_login(&target_desktop, "target").await;

    users_update_body(
        &operator_desktop,
        target_id,
        "対象（改名）",
        Role::Admin,
        None,
        None,
    )
    .await
    .unwrap();

    let current = require_role(&target_desktop, Role::Admin, "users")
        .await
        .expect("the session survives");
    assert_eq!(current.display_name, "対象（改名）");
}

/// Review of #230: a check whose read was in flight while this session's
/// own password change committed and re-bound it must not report it as
/// ended. The read is "held" by running `current_session`'s two halves
/// with the change in between: snapshot (epoch 0) -> change + re-bind
/// (epoch 1) -> read (epoch 1) -> settle.
#[tokio::test]
async fn a_desktop_session_rebound_while_its_check_was_in_flight_stays_valid() {
    let dir = tempfile::tempdir().expect("tempdir");
    let changer = app_state_in(&dir).await;
    let other = app_state_in(&dir).await;
    seed_revocation_accounts(&changer).await;
    desktop_login(&changer, "target").await;
    desktop_login(&other, "target").await;
    let snapshot = |state: &AppState| {
        let (session, seq) = read_slot(state);
        (session.expect("a session"), seq)
    };
    let (changer_before, changer_seq) = snapshot(&changer);
    let (other_before, other_seq) = snapshot(&other);

    change_own_password(&changer, REVOCATION_PASSWORD, "newpassword1")
        .await
        .expect("password change");

    // Issue #260: the re-bind advanced the slot's `seq`, so the settle
    // writes nothing and reports `Stale`; the ordinary commands'
    // `current_session` still takes the re-bound session as valid.
    let fresh = read_session_source(&changer, &changer_before)
        .await
        .unwrap();
    match settle_session(&changer, &changer_before, fresh, changer_seq) {
        Settled::Stale {
            valid_now: Some(DesktopSession::Account(user)),
        } => assert_eq!(user.auth_epoch, 1),
        other => panic!("the re-bound session must stay valid, got {other:?}"),
    }
    assert!(require_role(&changer, Role::Admin, "users").await.is_ok());

    // The same interleaving for a session that was NOT re-bound: the
    // store's new epoch is not adopted on its behalf.
    let fresh = read_session_source(&other, &other_before).await.unwrap();
    assert!(matches!(
        settle_session(&other, &other_before, fresh, other_seq),
        Settled::Settled { session: None, .. }
    ));
    assert!(other
        .auth
        .lock()
        .expect("auth mutex poisoned")
        .session
        .is_none());
}

/// Re-creating a deleted account under the same username (a new row id,
/// epoch 0 again) must not revive the old account's desktop session.
#[tokio::test]
async fn a_recreated_account_does_not_inherit_the_old_desktop_session() {
    let dir = tempfile::tempdir().expect("tempdir");
    let operator_desktop = app_state_in(&dir).await;
    let target_desktop = app_state_in(&dir).await;
    let target_id = seed_revocation_accounts(&operator_desktop).await;
    desktop_login(&operator_desktop, "operator").await;
    desktop_login(&target_desktop, "target").await;

    users_delete_body(&operator_desktop, target_id, None)
        .await
        .unwrap();
    users_create_body(
        &operator_desktop,
        "target",
        REVOCATION_PASSWORD,
        "別人",
        Role::Admin,
    )
    .await
    .unwrap();

    assert_unauthorized(
        require_role(&target_desktop, Role::Viewer, "items").await,
        "the old session of a re-created username",
    );
}

/// The synthetic auth-disabled session has no `users` row: it works with no
/// accounts at all, and is checked against the mode instead.
#[tokio::test]
async fn the_auth_disabled_local_session_lives_only_while_the_mode_is_on() {
    let state = app_state().await;
    let enable = |disabled: bool| {
        let settings = state.settings.clone();
        async move {
            let config = settings.auth_config().await.unwrap();
            settings
                .set_auth_config(&AuthSettings { disabled, ..config })
                .await
                .unwrap();
        }
    };
    enable(true).await;
    state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(UserIdentity {
        id: LOCAL_SESSION_ID,
        username: "local".to_string(),
        display_name: "ローカルユーザー".to_string(),
        role: Role::Admin,
        auth_epoch: 0,
    })));
    assert!(require_role(&state, Role::Admin, "settings").await.is_ok());

    // ...but only while auth-disabled mode is on: turning it off ends
    // the synthetic session on the next command.
    enable(false).await;
    assert_unauthorized(
        require_role(&state, Role::Viewer, "settings").await,
        "the local session after auth-disabled mode was turned off",
    );
    assert!(state
        .auth
        .lock()
        .expect("auth mutex poisoned")
        .session
        .is_none());
}

/// A `users` row that happens to have the synthetic session's display id
/// (0) is still an account: validated, and revoked when it changes.
#[tokio::test]
async fn an_account_with_id_zero_is_still_revalidated() {
    let state = app_state().await;
    seed_revocation_accounts(&state).await;
    let mut user = state
        .users
        .verify("target", REVOCATION_PASSWORD)
        .await
        .unwrap()
        .unwrap();
    user.id = LOCAL_SESSION_ID;
    state.set_session_for_test(Some(DesktopSession::Account(user)));
    assert_unauthorized(
        require_role(&state, Role::Viewer, "items").await,
        "an account session whose id does not match its row",
    );
}

// --- Issue #260: the session slot's seq and compare-and-set ------------
//
// docs/design/session-controller-design.md §4.3/§8.3: the command BODIES are
// driven with their slow `.await` (verify / first-user setup / auth-mode
// read) held at an injected gate, so the completion order is fixed by
// the test, not by the scheduler.

use tokio::sync::oneshot;

const SLOT_PASSWORD: &str = "password123";

/// The test's end of a one-shot gate: `entered` resolves once the held
/// command reached the injected `.await`; sending on `release` lets it
/// continue.
struct Hold {
    entered: oneshot::Receiver<()>,
    release: oneshot::Sender<()>,
}

type GateSlot = Arc<Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>>;

fn gate() -> (GateSlot, Hold) {
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    (
        Arc::new(Mutex::new(Some((entered_tx, release_rx)))),
        Hold {
            entered: entered_rx,
            release: release_tx,
        },
    )
}

/// The FIRST caller through `gate` stops here until released; later
/// callers pass straight through.
async fn pass_gate(gate: &GateSlot) {
    let taken = gate.lock().expect("gate mutex").take();
    if let Some((entered, release)) = taken {
        let _ = entered.send(());
        let _ = release.await;
    }
}

/// Hold the first `auth_login` verification of `state`.
fn hold_verify(state: &mut AppState) -> Hold {
    let (slot, hold) = gate();
    let users = state.users.clone();
    state.auth_io.verify = Arc::new(move |username, password| {
        let slot = slot.clone();
        let users = users.clone();
        Box::pin(async move {
            pass_gate(&slot).await;
            users.verify(&username, &password).await
        })
    });
    hold
}

/// Hold the first `auth_setup` account creation of `state`.
fn hold_setup(state: &mut AppState) -> Hold {
    let (slot, hold) = gate();
    let users = state.users.clone();
    state.auth_io.setup_first_user = Arc::new(move |username, password, display_name| {
        let slot = slot.clone();
        let users = users.clone();
        Box::pin(async move {
            pass_gate(&slot).await;
            users
                .setup_first_user(&username, &password, &display_name)
                .await
        })
    });
    hold
}

/// Hold the first `auth_logout` auth-mode read of `state`.
fn hold_auth_mode(state: &mut AppState) -> Hold {
    let (slot, hold) = gate();
    let settings = state.settings.clone();
    state.auth_io.auth_mode = Arc::new(move || {
        let slot = slot.clone();
        let settings = settings.clone();
        Box::pin(async move {
            pass_gate(&slot).await;
            settings.auth_config().await
        })
    });
    hold
}

/// Hold the `nth` (1-based) auth-mode read of `state` - whichever command
/// makes it - either before the settings read (`after_read: false`, the
/// held read sees what is stored when it is released) or after it
/// (`true`, the held command carries the value read BEFORE the hold).
fn hold_auth_mode_call(state: &mut AppState, nth: usize, after_read: bool) -> Hold {
    let (slot, hold) = gate();
    let settings = state.settings.clone();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    state.auth_io.auth_mode = Arc::new(move || {
        let (slot, settings, calls) = (slot.clone(), settings.clone(), calls.clone());
        Box::pin(async move {
            let this = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if this != nth {
                return settings.auth_config().await;
            }
            if after_read {
                let config = settings.auth_config().await;
                pass_gate(&slot).await;
                config
            } else {
                pass_gate(&slot).await;
                settings.auth_config().await
            }
        })
    });
    hold
}

fn is_local(session: &Option<DesktopSession>) -> bool {
    matches!(session, Some(DesktopSession::AuthDisabledLocal(user)) if user.username == "local")
}

async fn audit_action_count(state: &AppState, action: &str) -> usize {
    state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows
        .iter()
        .filter(|row| row.action == action)
        .count()
}

/// Poll `$fut` until the command reaches its gate (it must not finish
/// first).
macro_rules! run_until_held {
    ($fut:expr, $hold:expr) => {{
        tokio::select! {
            biased;
            out = &mut $fut => panic!("finished before reaching the gate: {out:?}"),
            _ = &mut $hold.entered => {}
        }
    }};
}

fn is_account(session: &Option<DesktopSession>, username: &str) -> bool {
    matches!(session, Some(DesktopSession::Account(user)) if user.username == username)
}

/// S-16: a login whose verification is overtaken by a completed logout
/// must not revive a session (design §1.3 order 1).
#[tokio::test]
async fn s16_a_slow_login_does_not_undo_a_completed_logout() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("b", SLOT_PASSWORD, "B")
        .await
        .unwrap();
    let mut hold = hold_verify(&mut state);

    let login = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string());
    tokio::pin!(login);
    run_until_held!(login, hold);

    let logout = logout_body(&state).await.expect("logout");
    assert_eq!(logout.seq, 1, "a logout of no session still advances seq");
    hold.release.send(()).unwrap();
    let result = login.await.expect("login");

    assert!(!result.success);
    assert!(result.superseded);
    assert_eq!(result.seq, 1);
    assert_eq!(read_slot(&state), (None, 1));
    assert_eq!(audit_action_count(&state, "login").await, 1, "verified");
    assert_eq!(audit_action_count(&state, "logout").await, 0);
}

/// S-16 (wiring): the login must compare against the seq read BEFORE its
/// first `.await` - any seq advance while it is held makes it superseded.
#[tokio::test]
async fn s16_login_reads_seq_before_its_first_await() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("b", SLOT_PASSWORD, "B")
        .await
        .unwrap();
    let mut hold = hold_verify(&mut state);

    let login = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string());
    tokio::pin!(login);
    run_until_held!(login, hold);

    let (_, seq) = read_slot(&state);
    assert_eq!(cas_session(&state, seq, None), (true, seq + 1));
    hold.release.send(()).unwrap();
    let result = login.await.expect("login");

    assert!(result.superseded);
    assert_eq!(read_slot(&state), (None, seq + 1));
}

/// S-16 (control): the same login with nothing in between installs the
/// session and advances seq; a failed login leaves the slot alone.
#[tokio::test]
async fn s16_an_uncontested_login_installs_and_advances_seq() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("b", SLOT_PASSWORD, "B")
        .await
        .unwrap();

    let result = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");

    assert!(result.success);
    assert!(!result.superseded);
    assert_eq!(result.seq, 1);
    let (session, seq) = read_slot(&state);
    assert_eq!(seq, 1);
    assert!(is_account(&session, "b"));

    let failed = login_body(&state, "b".to_string(), "wrong-password".to_string())
        .await
        .expect("login");
    assert!(!failed.success);
    assert!(!failed.superseded);
    assert_eq!(failed.seq, 1, "a failed login does not touch the slot");
}

/// S-17: a logout whose settings read is overtaken by a completed login
/// must not clear that login's session, and records no `logout`.
#[tokio::test]
async fn s17_a_slow_logout_does_not_clear_a_later_login() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("b", SLOT_PASSWORD, "B")
        .await
        .unwrap();
    let mut hold = hold_auth_mode(&mut state);

    let logout = logout_body(&state);
    tokio::pin!(logout);
    run_until_held!(logout, hold);

    let login = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    assert!(login.success);
    hold.release.send(()).unwrap();
    let result = logout.await.expect("logout");

    assert_eq!(
        result.seq, login.seq,
        "the overtaken logout changes nothing"
    );
    let (session, seq) = read_slot(&state);
    assert_eq!(seq, login.seq);
    assert!(is_account(&session, "b"));
    assert_eq!(audit_action_count(&state, "logout").await, 0);
}

/// S-17 (wiring): the logout compares against the seq read before its
/// first `.await` - a re-bind while it is held (even to the same
/// account) keeps the session.
#[tokio::test]
async fn s17_logout_reads_seq_before_its_first_await() {
    let mut state = app_state().await;
    let a = state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(a.clone())));
    let mut hold = hold_auth_mode(&mut state);

    let logout = logout_body(&state);
    tokio::pin!(logout);
    run_until_held!(logout, hold);

    let (_, seq) = read_slot(&state);
    let rebound = Some(DesktopSession::Account(a));
    assert_eq!(cas_session(&state, seq, rebound.clone()), (true, seq + 1));
    hold.release.send(()).unwrap();
    let result = logout.await.expect("logout");

    assert_eq!(result.seq, seq + 1);
    assert_eq!(read_slot(&state), (rebound, seq + 1));
}

/// S-17 (control): an uncontested logout clears, advances seq, and is
/// audited.
#[tokio::test]
async fn s17_an_uncontested_logout_clears_and_advances_seq() {
    let state = app_state().await;
    let a = state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(a)));

    let result = logout_body(&state).await.expect("logout");

    assert_eq!(result.seq, 2);
    assert_eq!(read_slot(&state), (None, 2));
    assert_eq!(audit_action_count(&state, "logout").await, 1);
}

/// S-18: `auth_setup` overtaken by a completed logout: the account is
/// created, the session is not installed.
#[tokio::test]
async fn s18_a_slow_setup_does_not_undo_a_completed_logout() {
    let mut state = app_state().await;
    let mut hold = hold_setup(&mut state);

    let setup = setup_body(
        &state,
        "b".to_string(),
        SLOT_PASSWORD.to_string(),
        "B".to_string(),
    );
    tokio::pin!(setup);
    run_until_held!(setup, hold);

    logout_body(&state).await.expect("logout");
    hold.release.send(()).unwrap();
    let result = setup.await.expect("setup");

    assert!(!result.success);
    assert!(result.superseded);
    assert_eq!(read_slot(&state), (None, 1));
    assert!(state.users.is_initialized().await.unwrap());
    assert!(state.users.get_by_username("b").await.unwrap().is_some());
}

/// S-19: a logout overtaken by a completed `auth_setup` keeps the setup's
/// session.
#[tokio::test]
async fn s19_a_slow_logout_does_not_clear_a_later_setup() {
    let mut state = app_state().await;
    let mut hold = hold_auth_mode(&mut state);

    let logout = logout_body(&state);
    tokio::pin!(logout);
    run_until_held!(logout, hold);

    let setup = setup_body(
        &state,
        "b".to_string(),
        SLOT_PASSWORD.to_string(),
        "B".to_string(),
    )
    .await
    .expect("setup");
    assert!(setup.success);
    hold.release.send(()).unwrap();
    let result = logout.await.expect("logout");

    assert_eq!(result.seq, setup.seq);
    assert!(is_account(&read_slot(&state).0, "b"));
}

/// S-54: re-resolving the same session - including after a display-name
/// edit (a refresh of the same binding) - never advances seq.
#[tokio::test]
async fn s54_resolving_the_same_session_does_not_advance_seq() {
    let state = app_state().await;
    let a = state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");

    for _ in 0..3 {
        let answer = resolve_body(&state).await.expect("resolve");
        assert!(!answer.stale);
        assert_eq!((answer.checked, answer.current), (login.seq, login.seq));
        assert_eq!(answer.kind, Some("account"));
        assert_eq!(answer.identity.expect("active").name, "A");
    }

    state
        .users
        .update_user(a.id, "A（改名）", Role::Admin)
        .await
        .unwrap();
    let answer = resolve_body(&state).await.expect("resolve");
    assert!(!answer.stale);
    assert_eq!((answer.checked, answer.current), (login.seq, login.seq));
    assert_eq!(answer.identity.expect("still active").name, "A（改名）");
    assert_eq!(read_slot(&state).1, login.seq);
}

/// S-64: a role change advances `auth_epoch` (ADR-0014), so the next
/// resolve reports no session and advances seq (the clear) - unlike the
/// display-name refresh of S-54.
#[tokio::test]
async fn s64_a_role_change_resolves_to_none_and_advances_seq() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("owner", SLOT_PASSWORD, "オーナー")
        .await
        .unwrap();
    let a = state
        .users
        .create_user("a", SLOT_PASSWORD, "A", Role::Editor)
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    assert!(resolve_body(&state).await.unwrap().identity.is_some());

    state
        .users
        .update_user(a.id, "A", Role::Viewer)
        .await
        .unwrap();
    let answer = resolve_body(&state).await.expect("resolve");

    assert!(!answer.stale);
    assert!(answer.identity.is_none(), "not the new role's session");
    assert_eq!(answer.kind, None);
    assert_eq!(answer.checked, login.seq);
    assert_eq!(answer.current, login.seq + 1, "this call cleared it");
    assert_eq!(read_slot(&state), (None, login.seq + 1));
}

/// S-77 (Rust half): a settle whose slot was re-bound after its entry
/// read writes nothing and reports `Stale`; `auth_resolve` of no session
/// answers `checked == current`.
#[tokio::test]
async fn s77_a_settle_overtaken_by_a_rebind_writes_nothing() {
    let state = app_state().await;
    let empty = resolve_body(&state).await.expect("resolve");
    assert!(empty.identity.is_none() && !empty.stale);
    assert_eq!((empty.checked, empty.current), (0, 0));

    let a = state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(a)));
    let (cached, seq_at_entry) = read_slot(&state);
    let cached = cached.unwrap();
    let fresh = read_session_source(&state, &cached).await.unwrap();
    // Another command re-binds the slot while the read was "in flight".
    assert!(cas_session(&state, seq_at_entry, None).0);

    assert!(matches!(
        settle_session(&state, &cached, fresh, seq_at_entry),
        Settled::Stale { valid_now: None }
    ));
    assert_eq!(read_slot(&state), (None, seq_at_entry + 1));
}

/// S-47 / S-67: auth-disabled mode's synthetic session resolves as
/// `kind: "local"` with the mode's CURRENT role, and its logout is a
/// no-op that does not advance seq.
#[tokio::test]
async fn s47_s67_the_auth_disabled_session_resolves_local_and_logout_keeps_seq() {
    let state = app_state().await;
    let set_mode = |role: Role| {
        let settings = state.settings.clone();
        async move {
            let config = settings.auth_config().await.unwrap();
            settings
                .set_auth_config(&AuthSettings {
                    disabled: true,
                    disabled_role: role,
                    ..config
                })
                .await
                .unwrap();
        }
    };
    set_mode(Role::Viewer).await;
    state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(UserIdentity {
        id: LOCAL_SESSION_ID,
        username: "local".to_string(),
        display_name: "ローカルユーザー".to_string(),
        role: Role::Viewer,
        auth_epoch: 0,
    })));
    let (_, seq) = read_slot(&state);

    let answer = resolve_body(&state).await.expect("resolve");
    assert_eq!(answer.kind, Some("local"));
    assert_eq!(answer.identity.expect("active").role, "viewer");
    set_mode(Role::Editor).await;
    let answer = resolve_body(&state).await.expect("resolve");
    assert_eq!(answer.kind, Some("local"));
    assert_eq!(answer.identity.expect("active").role, "editor");
    assert_eq!((answer.checked, answer.current), (seq, seq));

    let logout = logout_body(&state).await.expect("logout");
    assert_eq!(logout.seq, seq, "S-67: the no-op does not advance seq");
    assert!(read_slot(&state).0.is_some());
}

/// S-68: a self-service password change re-binds the session and
/// advances seq; the result carries the new seq.
#[tokio::test]
async fn s68_change_password_rebinds_and_advances_seq() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");

    let result = change_own_password(&state, SLOT_PASSWORD, "newpassword1")
        .await
        .expect("change password");

    assert_eq!(result.seq, login.seq + 1);
    let (session, seq) = read_slot(&state);
    assert_eq!(seq, result.seq);
    assert!(matches!(session, Some(DesktopSession::Account(ref u)) if u.auth_epoch == 1));
    let answer = resolve_body(&state).await.expect("resolve");
    assert_eq!((answer.checked, answer.current), (result.seq, result.seq));
    assert!(answer.identity.is_some());
}

/// Poll `$fut` (which must not finish) until `$cond` holds. The session
/// DB runs on its own worker thread, so between polls this sleeps the
/// test thread briefly to let that I/O complete.
macro_rules! drive_until {
    ($fut:expr, $cond:expr) => {{
        let mut reached = false;
        for _ in 0..5_000 {
            if $cond {
                reached = true;
                break;
            }
            tokio::select! {
                biased;
                out = &mut $fut => panic!("finished early: {out:?}"),
                _ = tokio::task::yield_now() => {}
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(reached, "the condition never held");
    }};
}

/// Poll `$fut` for a while and assert it is still pending (waiting on
/// `auth_config_lock`).
macro_rules! assert_stays_pending {
    ($fut:expr) => {{
        for _ in 0..30 {
            tokio::select! {
                biased;
                out = &mut $fut => panic!("expected to wait, but finished: {out:?}"),
                _ = tokio::task::yield_now() => {}
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }};
}

/// Hold the first `auth_config_apply` of `state` right AFTER its settings
/// save (the apply still holds `auth_config_lock`).
fn hold_after_save(state: &mut AppState) -> Hold {
    let (slot, hold) = gate();
    let settings = state.settings.clone();
    state.auth_io.save_auth_config = Arc::new(move |config, permissions| {
        let (slot, settings) = (slot.clone(), settings.clone());
        Box::pin(async move {
            settings
                .set_auth_config_and_disabled_permissions(&config, permissions.as_deref())
                .await?;
            pass_gate(&slot).await;
            Ok(())
        })
    });
    hold
}

/// Auth-mode reads for a logout that races an `apply(true)`: the FIRST
/// read returns what is stored (`disabled = false`) and then stores
/// `disabled = true` - an apply(true) that completed right after it -
/// and the SECOND read (the logout's post-clear re-read, under
/// `auth_config_lock`) is held before reading. Later reads pass.
fn mode_turned_on_after_first_read_and_reread_held(state: &mut AppState) -> Hold {
    let (slot, hold) = gate();
    let settings = state.settings.clone();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    state.auth_io.auth_mode = Arc::new(move || {
        let (slot, settings, calls) = (slot.clone(), settings.clone(), calls.clone());
        Box::pin(async move {
            match calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                0 => {
                    let config = settings.auth_config().await?;
                    settings
                        .set_auth_config(&AuthSettings {
                            disabled: true,
                            ..config.clone()
                        })
                        .await?;
                    Ok(config)
                }
                1 => {
                    pass_gate(&slot).await;
                    settings.auth_config().await
                }
                _ => settings.auth_config().await,
            }
        })
    });
    hold
}

/// S-67 / PR #264 review P1 (i): `auth_config_apply` starts (the slot
/// empty - the first-run 「ログインなしで使い始める」), a logout clears the
/// empty slot meanwhile (advancing `seq`, `disabled` still false), and
/// only then does the apply save and reach its final lock. The install
/// is conditioned on the slot being empty, NOT on `seq` being unchanged
/// since the apply's entry - so the APPLY installs the synthetic session
/// (asserted before the logout, waiting on `auth_config_lock` for its
/// re-read, is polled again; its re-read then installs nothing).
#[tokio::test]
async fn s67_config_apply_installs_local_after_a_logout_advanced_seq() {
    let mut state = app_state().await;
    // Call 1 = the apply's `currently_disabled` read (held before it,
    // with `auth_config_lock` held).
    let mut hold = hold_auth_mode_call(&mut state, 1, false);

    let apply = auth_config_apply_body(&state, true, "admin");
    tokio::pin!(apply);
    run_until_held!(apply, hold);

    let logout = logout_body(&state);
    tokio::pin!(logout);
    drive_until!(logout, read_slot(&state) == (None, 1));
    assert_stays_pending!(logout);
    hold.release.send(()).unwrap();
    let config = apply.await.expect("apply");

    assert!(config.disabled);
    assert!(state.settings.auth_config().await.unwrap().disabled);
    let (session, seq) = read_slot(&state);
    assert!(is_local(&session), "the apply installed: {session:?}");
    assert_eq!(seq, 2, "the install advanced seq once");

    let result = logout.await.expect("logout");
    assert_eq!(result.seq, 2, "the logout's re-read did not install again");
    assert_eq!(read_slot(&state).1, 2);
    assert_eq!(audit_action_count(&state, "login").await, 1);
}

/// S-67 / PR #264 review P1 (ii), updated by the owner review of #266
/// P1: a logout reads the OLD `disabled = false` and is held;
/// `auth_config_apply` then switches the mode on while A's session is
/// still there - and re-binds it to the synthetic session right away
/// (`seq` + 1). The logout resumes: its compare-and-set no longer holds,
/// so it changes nothing. Disabled mode never ends with no session, nor
/// with A's.
#[tokio::test]
async fn s67_a_logout_that_read_the_old_mode_is_overtaken_by_the_apply_rebind() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    assert!(login.success);
    // Call 1 = the logout's first mode read (held AFTER reading false).
    let mut hold = hold_auth_mode_call(&mut state, 1, true);

    let logout = logout_body(&state);
    tokio::pin!(logout);
    run_until_held!(logout, hold);

    let config = auth_config_apply_body(&state, true, "editor")
        .await
        .expect("apply");
    assert!(config.disabled);
    assert!(
        is_local(&read_slot(&state).0),
        "the apply re-bound A's session"
    );
    hold.release.send(()).unwrap();
    let result = logout.await.expect("logout");

    let (session, seq) = read_slot(&state);
    let Some(DesktopSession::AuthDisabledLocal(local)) = session else {
        panic!("expected the synthetic session: {session:?}")
    };
    assert_eq!(local.role, Role::Editor);
    assert_eq!(local.id, LOCAL_SESSION_ID);
    assert_eq!(
        seq,
        login.seq + 1,
        "the rebind only; the logout wrote nothing"
    );
    assert_eq!(result.seq, seq, "the logout reports the final seq");
    assert_eq!(
        audit_action_count(&state, "logout").await,
        1,
        "A's session end by the rebind (reason auth_disabled), none by the logout"
    );
    assert_eq!(
        audit_action_count(&state, "login").await,
        2,
        "A's login + one synthetic login"
    );
}

/// The audit rows for `action` (any order), as `(actor, detail)`.
async fn audit_rows(state: &AppState, action: &str) -> Vec<(Option<String>, Option<String>)> {
    state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows
        .into_iter()
        .filter(|row| row.action == action)
        .map(|row| (row.actor_username, row.detail))
        .collect()
}

/// S-94 (owner review of #266 P1, design §5.3): an admin signed in with an
/// account turns auth-disabled mode on from the settings screen. The
/// apply re-binds the slot to the synthetic session with the new role in
/// the same step as the save (`seq` + 1), and records the account's
/// session end (`logout`, reason `auth_disabled`) and the synthetic
/// `login`. `auth_resolve` then answers `kind: "local"` with that role -
/// `auth.disabled == true` never goes with an account session.
#[tokio::test]
async fn s94_config_apply_true_rebinds_an_account_session_to_local() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("manager", SLOT_PASSWORD, "Admin")
        .await
        .unwrap();
    let login = login_body(&state, "manager".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    assert!(login.success);
    assert!(is_account(&read_slot(&state).0, "manager"));

    let config = auth_config_apply_body(&state, true, "viewer")
        .await
        .expect("apply");
    assert!(config.disabled);

    let (session, seq) = read_slot(&state);
    let Some(DesktopSession::AuthDisabledLocal(local)) = session else {
        panic!("expected the synthetic session: {session:?}")
    };
    assert_eq!(local.role, Role::Viewer);
    assert_eq!(seq, login.seq + 1, "Account -> Local advances seq once");

    let logouts = audit_rows(&state, "logout").await;
    assert_eq!(logouts.len(), 1);
    assert_eq!(logouts[0].0.as_deref(), Some("manager"));
    let detail: serde_json::Value =
        serde_json::from_str(logouts[0].1.as_deref().expect("detail")).unwrap();
    assert_eq!(detail, serde_json::json!({ "reason": "auth_disabled" }));
    let logins = audit_rows(&state, "login").await;
    assert_eq!(logins.len(), 2, "the admin's login + the synthetic login");
    assert!(
        logins
            .iter()
            .any(|(actor, detail)| actor.as_deref() == Some("local")
                && detail
                    .as_deref()
                    .is_some_and(|d| d.contains("auth_disabled"))),
        "{logins:?}"
    );
    assert_eq!(audit_action_count(&state, "settings_change").await, 1);

    let answer = resolve_body(&state).await.expect("resolve");
    assert_eq!(answer.kind, Some("local"));
    assert_eq!(answer.identity.expect("active").role, "viewer");
    assert_eq!((answer.checked, answer.current), (seq, seq));
}

/// S-94/S-96: applying `disabled = true` again while the synthetic
/// session is already there: with the same role nothing is written and
/// `seq` does not move; with another role the role is written and `seq`
/// advances (an authorization-context change, re-review of #266 P1). No
/// session audit either way (the apply's `settings_change` records it).
#[tokio::test]
async fn s96_config_apply_true_again_keeps_seq_for_the_same_role_and_advances_it_for_another() {
    let state = app_state().await;
    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("first apply (bootstrap window)");
    let (session, seq) = read_slot(&state);
    assert!(is_local(&session));
    let logins = audit_action_count(&state, "login").await;

    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("same apply");
    assert_eq!(
        read_slot(&state),
        (session, seq),
        "same role: nothing written"
    );

    auth_config_apply_body(&state, true, "editor")
        .await
        .expect("role change");
    let (session, seq_after) = read_slot(&state);
    assert_eq!(seq_after, seq + 1, "another role: seq advances");
    let Some(DesktopSession::AuthDisabledLocal(local)) = session else {
        panic!("{session:?}")
    };
    assert_eq!(local.role, Role::Editor);
    assert_eq!(audit_action_count(&state, "login").await, logins);
    assert_eq!(audit_action_count(&state, "logout").await, 0);
    assert_eq!(audit_action_count(&state, "settings_change").await, 3);
}

/// S-96 (re-review of #266 P1): an `auth_resolve` of Local(admin) reads
/// the slot and the store (role admin) and is held; the role is changed
/// to viewer meanwhile; the held resolve then settles. The role change
/// advanced `seq`, so the settle is `Stale` and writes nothing - it does
/// not put admin back over viewer - and the next resolve answers viewer.
/// The steps are `resolve_body`'s own, run one by one (as in S-77).
#[tokio::test]
async fn s96_a_resolve_that_read_the_old_local_role_does_not_write_it_back() {
    let state = app_state().await;
    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("bootstrap-window apply");

    // The old resolve: slot and store read (admin), then held.
    let (cached, seq_at_entry) = read_slot(&state);
    let cached = cached.expect("Local(admin)");
    let fresh = read_session_source(&state, &cached).await.unwrap();
    assert!(matches!(
        &fresh,
        Some(DesktopSession::AuthDisabledLocal(local)) if local.role == Role::Admin
    ));

    auth_config_apply_body(&state, true, "viewer")
        .await
        .expect("role change");
    assert_eq!(read_slot(&state).1, seq_at_entry + 1);

    assert!(matches!(
        settle_session(&state, &cached, fresh, seq_at_entry),
        Settled::Stale { .. }
    ));
    let Some(DesktopSession::AuthDisabledLocal(local)) = read_slot(&state).0 else {
        panic!("expected Local")
    };
    assert_eq!(local.role, Role::Viewer, "admin was not written back");

    let answer = resolve_body(&state).await.expect("resolve");
    assert!(!answer.stale);
    assert_eq!(answer.kind, Some("local"));
    assert_eq!(answer.identity.expect("active").role, "viewer");
}

#[tokio::test]
async fn login_notice_tauri_admin_write_and_viewer_denial() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("manager", SLOT_PASSWORD, "Admin")
        .await
        .unwrap();
    state
        .users
        .create_user("viewer", SLOT_PASSWORD, "Viewer", Role::Viewer)
        .await
        .unwrap();
    let viewer = state
        .users
        .get_by_username("viewer")
        .await
        .unwrap()
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(viewer)));
    assert!(matches!(
        login_notice_set_body(&state, "denied").await,
        Err(BantoError::Forbidden)
    ));
    assert_eq!(state.settings.login_notice().await.unwrap(), "");

    let admin = state
        .users
        .get_by_username("manager")
        .await
        .unwrap()
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(admin.clone())));
    assert_eq!(
        login_notice_set_body(&state, "  Service tonight  ")
            .await
            .unwrap(),
        "Service tonight"
    );
    assert_eq!(
        state.settings.login_notice().await.unwrap(),
        "Service tonight"
    );
    let rows = state.audit.list(ListParams::default()).await.unwrap().rows;
    let success = rows
        .iter()
        .find(|row| {
            row.resource == "settings" && row.action == "settings_change" && row.result == "ok"
        })
        .unwrap();
    let detail: serde_json::Value =
        serde_json::from_str(success.detail.as_deref().unwrap()).unwrap();
    assert_eq!(detail, serde_json::json!({ "key": "login.notice" }));
    assert!(rows
        .iter()
        .any(|row| row.resource == "settings" && row.result == "denied"));
}

/// S-103 (freshness audit of #266, P2-2): the generic `settings_set`
/// refuses the `auth.` keys (only `auth_config_apply` / `autologin_*`
/// write them, with the session re-bind); other keys still work.
#[tokio::test]
async fn s103_settings_set_refuses_auth_keys() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("manager", SLOT_PASSWORD, "Admin")
        .await
        .unwrap();
    let admin = state
        .users
        .get_by_username("manager")
        .await
        .unwrap()
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(admin.clone())));
    let before = read_slot(&state);
    for key in [
        "auth.disabled",
        "auth.disabled_role",
        "auth.autologin.enabled",
    ] {
        let result = settings_set_body(&state, &admin, key.to_string(), "true".to_string()).await;
        assert!(
            matches!(result, Err(BantoError::BadRequest(_))),
            "{key}: {result:?}"
        );
    }
    assert!(!state.settings.auth_config().await.unwrap().disabled);
    assert_eq!(read_slot(&state), before);
    settings_set_body(
        &state,
        &admin,
        "audit.retention_days".to_string(),
        "30".to_string(),
    )
    .await
    .expect("a non-auth key");
}

/// Replace `auth_config_apply`'s save with one that stores only
/// `auth.disabled` and then fails (a save interrupted part-way).
fn save_fails_after_the_mode(state: &mut AppState) {
    let settings = state.settings.clone();
    state.auth_io.save_auth_config = Arc::new(move |config, _permissions| {
        let settings = settings.clone();
        Box::pin(async move {
            settings
                .set(
                    "auth.disabled",
                    if config.disabled { "true" } else { "false" },
                )
                .await?;
            Err(BantoError::Storage("disk full (test)".to_string()))
        })
    });
}

/// S-104 (freshness audit of #266, P2-3): a save that stored the mode and
/// then failed still leaves the session following what is stored -
/// apply(true) over an account session re-binds it to Local; apply(false)
/// over Local ends it - and the error is reported.
#[tokio::test]
async fn s104_a_save_failing_part_way_still_rebinds_the_session_to_what_is_stored() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("manager", SLOT_PASSWORD, "Admin")
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(
        state
            .users
            .get_by_username("manager")
            .await
            .unwrap()
            .unwrap(),
    )));
    save_fails_after_the_mode(&mut state);
    let (_, seq) = read_slot(&state);

    let result = auth_config_apply_body(&state, true, "admin").await;
    assert!(matches!(result, Err(BantoError::Storage(_))), "{result:?}");
    assert!(state.settings.auth_config().await.unwrap().disabled);
    let (session, seq_on) = read_slot(&state);
    assert!(is_local(&session), "follows disabled = true: {session:?}");
    assert_eq!(seq_on, seq + 1);

    let result = auth_config_apply_body(&state, false, "admin").await;
    assert!(result.is_err());
    assert!(!state.settings.auth_config().await.unwrap().disabled);
    assert_eq!(
        read_slot(&state),
        (None, seq_on + 1),
        "follows disabled = false"
    );
}

/// S-102 (freshness audit of #266, P3-2): a check that read Local(admin)
/// and is overtaken by apply(true, viewer) reports, for the ordinary
/// commands, the slot's CURRENT session (viewer) - not its older read.
#[tokio::test]
async fn s102_a_stale_settle_reports_the_slot_value_not_the_older_read() {
    let state = app_state().await;
    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("enable (bootstrap window)");
    let (cached, seq_at_entry) = read_slot(&state);
    let cached = cached.expect("Local(admin)");
    let fresh = read_session_source(&state, &cached).await.unwrap();

    auth_config_apply_body(&state, true, "viewer")
        .await
        .expect("role change");

    let Settled::Stale {
        valid_now: Some(DesktopSession::AuthDisabledLocal(local)),
    } = settle_session(&state, &cached, fresh, seq_at_entry)
    else {
        panic!("expected Stale with the current Local session")
    };
    assert_eq!(local.role, Role::Viewer);
}

/// Hardening (freshness audit of #266, P2-2): `false -> true` advances
/// `seq` even if the slot somehow already holds Local with that role.
#[tokio::test]
async fn s98_turning_the_mode_on_always_advances_seq() {
    let state = app_state().await;
    state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(local_identity(
        Role::Admin,
    ))));
    let (_, seq) = read_slot(&state);
    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("enable");
    assert_eq!(read_slot(&state).1, seq + 1);
}

/// S-98 (re-review of #266 P1): between `auth_config_apply`'s save and
/// its rebind, another `auth_resolve` (B) reads the new role from the
/// store and refreshes the slot to it - without advancing `seq` (a
/// settle's refresh never does, I-23). The rebind then finds the new role
/// already there, but the role DID change in this apply (decided from
/// the settings before the save), so it still advances `seq`. An even
/// older resolve (A) that had read the old role therefore settles
/// `Stale` and does not write admin back.
#[tokio::test]
async fn s98_a_role_change_advances_seq_even_if_a_settle_refreshed_the_slot_first() {
    let mut state = app_state().await;
    // Local(admin): the mode on with role admin, and its synthetic session.
    let config = state.settings.auth_config().await.unwrap();
    state
        .settings
        .set_auth_config(&AuthSettings {
            disabled: true,
            disabled_role: Role::Admin,
            ..config
        })
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(local_identity(
        Role::Admin,
    ))));
    let mut hold = hold_after_save(&mut state);

    // Resolve A: slot and store read (admin), then held.
    let (cached_a, seq_n) = read_slot(&state);
    let cached_a = cached_a.expect("Local(admin)");
    let fresh_a = read_session_source(&state, &cached_a).await.unwrap();

    // apply(true, viewer): held after its save, before its rebind.
    let apply = auth_config_apply_body(&state, true, "viewer");
    tokio::pin!(apply);
    run_until_held!(apply, hold);

    // Resolve B runs whole: it reads viewer from the store and refreshes.
    let b = resolve_body(&state).await.expect("resolve B");
    assert_eq!(b.identity.expect("active").role, "viewer");
    assert_eq!((b.checked, b.current), (seq_n, seq_n), "a refresh: no seq");
    assert_eq!(read_slot(&state).1, seq_n);

    hold.release.send(()).unwrap();
    apply.await.expect("apply");
    assert_eq!(
        read_slot(&state).1,
        seq_n + 1,
        "the role change advanced seq anyway"
    );

    assert!(matches!(
        settle_session(&state, &cached_a, fresh_a, seq_n),
        Settled::Stale { .. }
    ));
    let Some(DesktopSession::AuthDisabledLocal(local)) = read_slot(&state).0 else {
        panic!("expected Local")
    };
    assert_eq!(local.role, Role::Viewer, "admin was not written back");
}

/// S-99 (re-review of #266 P1): an `auth_resolve` that read Local(admin)
/// and `disabled = true` is held; `auth_config_apply(false)` then ends the
/// synthetic session in the same step as its save (`None`, `seq` + 1) and
/// records its end (`logout`, reason `auth_enabled`). The held resolve
/// settles `Stale` (it does not confirm `local` under `disabled = false`),
/// and the next resolve answers `none`.
#[tokio::test]
async fn s99_config_apply_false_ends_local_at_once_and_an_old_resolve_is_stale() {
    let state = app_state().await;
    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("enable (bootstrap window)");
    let (cached, seq_n) = read_slot(&state);
    let cached = cached.expect("Local(admin)");
    let fresh = read_session_source(&state, &cached).await.unwrap();
    assert!(fresh.is_some(), "read while the mode was on");

    auth_config_apply_body(&state, false, "admin")
        .await
        .expect("disable");
    assert_eq!(read_slot(&state), (None, seq_n + 1));
    let logouts = audit_rows(&state, "logout").await;
    assert_eq!(logouts.len(), 1);
    assert_eq!(logouts[0].0.as_deref(), Some("local"));
    let detail: serde_json::Value =
        serde_json::from_str(logouts[0].1.as_deref().expect("detail")).unwrap();
    assert_eq!(detail, serde_json::json!({ "reason": "auth_enabled" }));

    assert!(matches!(
        settle_session(&state, &cached, fresh, seq_n),
        Settled::Stale { .. }
    ));
    assert_eq!(read_slot(&state), (None, seq_n + 1));
    let answer = resolve_body(&state).await.expect("resolve");
    assert!(answer.identity.is_none());
    assert!(!answer.stale);
    assert_eq!((answer.checked, answer.current), (seq_n + 1, seq_n + 1));
}

/// S-99: re-saving `disabled = false` (the mode already off) touches
/// nothing: `seq` unchanged, no session audit.
#[tokio::test]
async fn s99_config_apply_false_again_is_a_no_op_for_the_session() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("manager", SLOT_PASSWORD, "Admin")
        .await
        .unwrap();
    let login = login_body(&state, "manager".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    assert!(login.success);
    let before = read_slot(&state);

    auth_config_apply_body(&state, false, "admin")
        .await
        .expect("re-save false");
    assert_eq!(read_slot(&state), before);
    assert!(is_account(&before.0, "manager"));
    assert_eq!(audit_action_count(&state, "logout").await, 0);
}

/// S-94/S-95: a login starts (reads `seq = N`) and is held in its
/// password check; the mode is switched on meanwhile (the admin's account
/// session re-bound to Local, `seq = N + 1`); the login then completes.
/// Its install checks the mode under `auth_config_lock` and refuses - no
/// account session in auth-disabled mode (and its compare-and-set would
/// not hold either). The synthetic session stays; `seq` does not move.
#[tokio::test]
async fn s95_a_login_whose_check_was_overtaken_by_apply_true_is_refused() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("manager", SLOT_PASSWORD, "Admin")
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(
        state
            .users
            .get_by_username("manager")
            .await
            .unwrap()
            .unwrap(),
    )));
    let (_, seq_before) = read_slot(&state);
    let mut hold = hold_verify(&mut state);

    let login = login_body(&state, "manager".to_string(), SLOT_PASSWORD.to_string());
    tokio::pin!(login);
    run_until_held!(login, hold);

    auth_config_apply_body(&state, true, "viewer")
        .await
        .expect("apply");
    assert_eq!(read_slot(&state).1, seq_before + 1);
    hold.release.send(()).unwrap();
    let result = login.await.expect("login");

    assert!(!result.success);
    assert!(!result.superseded, "refused by the mode, not a lost race");
    assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
    let (session, seq) = read_slot(&state);
    assert!(
        is_local(&session),
        "Local is not turned back into the account: {session:?}"
    );
    assert_eq!(seq, seq_before + 1);
    assert_eq!(result.seq, seq);
}

/// S-95: `auth_login` while auth-disabled mode is on is refused before the
/// password check: the slot stays Local, `seq` does not move, and nothing
/// is recorded (no credential was checked).
#[tokio::test]
async fn s95_login_in_auth_disabled_mode_is_refused_before_the_check() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("manager", SLOT_PASSWORD, "Admin")
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(
        state
            .users
            .get_by_username("manager")
            .await
            .unwrap()
            .unwrap(),
    )));
    auth_config_apply_body(&state, true, "editor")
        .await
        .expect("apply");
    let before = read_slot(&state);
    let logins = audit_action_count(&state, "login").await;

    let result = login_body(&state, "manager".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");

    assert!(!result.success);
    assert!(!result.superseded);
    assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
    assert_eq!(result.seq, before.1);
    assert_eq!(read_slot(&state), before);
    assert!(is_local(&before.0));
    assert_eq!(audit_action_count(&state, "login").await, logins);
    assert_eq!(audit_action_count(&state, "login_failed").await, 0);
}

/// S-95: `auth_setup` while auth-disabled mode is on (the first-run
/// 「ログインなしで使い始める」 already chosen) is refused on entry and
/// creates no account.
#[tokio::test]
async fn s95_setup_in_auth_disabled_mode_creates_no_account() {
    let state = app_state().await;
    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("bootstrap-window apply");
    let before = read_slot(&state);
    assert!(is_local(&before.0));

    let result = setup_body(
        &state,
        "b".to_string(),
        SLOT_PASSWORD.to_string(),
        "B".to_string(),
    )
    .await
    .expect("setup");

    assert!(!result.success);
    assert!(!result.superseded);
    assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
    assert_eq!(read_slot(&state), before);
    assert!(
        !state.users.is_initialized().await.unwrap(),
        "no account created"
    );
    assert_eq!(audit_action_count(&state, "setup").await, 0);
}

/// S-95: the mode is switched on (bootstrap window: no account yet, no
/// session) while `auth_setup` is creating the first account. The account
/// exists afterwards (created before the switch), but its session is not
/// installed: the synthetic session stays, as with a superseded setup.
#[tokio::test]
async fn s95_a_setup_overtaken_by_apply_true_keeps_the_account_but_installs_nothing() {
    let mut state = app_state().await;
    let mut hold = hold_setup(&mut state);

    let setup = setup_body(
        &state,
        "b".to_string(),
        SLOT_PASSWORD.to_string(),
        "B".to_string(),
    );
    tokio::pin!(setup);
    run_until_held!(setup, hold);

    auth_config_apply_body(&state, true, "admin")
        .await
        .expect("bootstrap-window apply");
    let after_apply = read_slot(&state);
    assert!(is_local(&after_apply.0));
    hold.release.send(()).unwrap();
    let result = setup.await.expect("setup");

    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
    assert_eq!(read_slot(&state), after_apply);
    assert!(state.users.get_by_username("b").await.unwrap().is_some());
    assert_eq!(audit_action_count(&state, "setup").await, 1);
}

/// PR #264 review P1 / re-review P2: a logout whose first read saw
/// `disabled = false` (and after which the mode was switched on) clears
/// A and re-reads the mode under `auth_config_lock`; an
/// `auth_config_apply(true)` started meanwhile waits for that lock. The
/// logout installs the synthetic session, and the apply - seeing it -
/// does not install again: one `seq` step, one synthetic `login`.
#[tokio::test]
async fn s67_config_apply_and_logout_install_local_only_once() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    let mut hold = mode_turned_on_after_first_read_and_reread_held(&mut state);

    let logout = logout_body(&state);
    tokio::pin!(logout);
    run_until_held!(logout, hold);
    assert_eq!(read_slot(&state), (None, login.seq + 1), "A is cleared");

    let apply = auth_config_apply_body(&state, true, "admin");
    tokio::pin!(apply);
    assert_stays_pending!(apply);
    hold.release.send(()).unwrap();
    let result = logout.await.expect("logout");
    assert!(is_local(&read_slot(&state).0), "the logout installed");
    assert_eq!(result.seq, login.seq + 2);
    apply.await.expect("apply");

    let (session, seq) = read_slot(&state);
    assert!(is_local(&session), "{session:?}");
    assert_eq!(seq, login.seq + 2, "installed once");
    assert_eq!(
        audit_action_count(&state, "login").await,
        2,
        "A's login + one synthetic login"
    );
}

/// PR #264 re-review P2 (a): `apply(true)` has saved and is still inside
/// its decision (held after the save, `auth_config_lock` held) when an
/// `apply(false)` starts. The second apply waits for the first to finish
/// - it cannot save `false` between the first one's save and its install
/// - so the install is based on the value still stored, and the final
/// `disabled = false` is saved after it. Since S-99 that `apply(false)`
/// ends the local session itself, in the same step as its save.
#[tokio::test]
async fn config_apply_true_then_false_are_serialized_by_the_auth_config_lock() {
    let mut state = app_state().await;
    let mut hold = hold_after_save(&mut state);

    let apply_on = auth_config_apply_body(&state, true, "admin");
    tokio::pin!(apply_on);
    run_until_held!(apply_on, hold);

    let apply_off = auth_config_apply_body(&state, false, "admin");
    tokio::pin!(apply_off);
    assert_stays_pending!(apply_off);
    assert!(
        state.settings.auth_config().await.unwrap().disabled,
        "apply(false) is waiting: it has not saved"
    );
    assert_eq!(read_slot(&state), (None, 0));

    hold.release.send(()).unwrap();
    apply_on.await.expect("apply(true)");
    assert!(
        is_local(&read_slot(&state).0),
        "installed under disabled = true"
    );
    let config = apply_off.await.expect("apply(false)");

    assert!(!config.disabled);
    assert!(!state.settings.auth_config().await.unwrap().disabled);
    assert_eq!(read_slot(&state), (None, 2), "apply(false) ended it (S-99)");
    let answer = resolve_body(&state).await.expect("resolve");
    assert!(answer.identity.is_none());
    assert_eq!((answer.checked, answer.current), (2, 2));
    assert!(current_session(&state).await.unwrap().is_none());
}

/// #294 review: `server_apply`'s save waits for `auth_config_lock`, and
/// re-validates against the auth settings stored by then, so an
/// auth-disabled save that won the lock makes a LAN-on / viewer_public-off
/// save fail instead of producing the forbidden combination.
#[tokio::test]
async fn server_config_save_is_serialized_with_auth_config_and_revalidated() {
    let state = app_state().await;
    let config = ServerSettings {
        enabled: true,
        bind: "127.0.0.1".to_string(),
        port: 9123,
        viewer_public: false,
    };
    let before = state.settings.server_config().await.unwrap();

    let guard = state.auth_config_lock.lock().await;
    let save = save_server_config_locked(&state, &config);
    tokio::pin!(save);
    assert_stays_pending!(save);
    assert_eq!(
        state.settings.server_config().await.unwrap(),
        before,
        "the save waits for auth_config_lock"
    );
    state
        .settings
        .set_auth_config(&AuthSettings {
            disabled: true,
            ..AuthSettings::default()
        })
        .await
        .unwrap();
    drop(guard);
    assert!(save.await.is_err(), "re-validated after the lock");
    assert_eq!(state.settings.server_config().await.unwrap(), before);
}

/// PR #264 re-review P2 (b): a logout's post-clear re-read sees
/// `disabled = true` and is held (under `auth_config_lock`); an
/// `apply(false)` started then waits for the logout's install to finish
/// before it saves. Final: `disabled = false`, and the local session the
/// logout installed under `true` is ended by that `apply(false)` (S-99).
#[tokio::test]
async fn s67_a_logout_reread_and_a_later_apply_false_are_serialized() {
    let mut state = app_state().await;
    state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    let mut hold = mode_turned_on_after_first_read_and_reread_held(&mut state);

    let logout = logout_body(&state);
    tokio::pin!(logout);
    run_until_held!(logout, hold);

    let apply_off = auth_config_apply_body(&state, false, "admin");
    tokio::pin!(apply_off);
    assert_stays_pending!(apply_off);
    assert!(
        state.settings.auth_config().await.unwrap().disabled,
        "apply(false) is waiting: it has not saved"
    );
    hold.release.send(()).unwrap();
    let result = logout.await.expect("logout");
    assert!(
        is_local(&read_slot(&state).0),
        "installed under disabled = true"
    );
    assert_eq!(result.seq, login.seq + 2);
    apply_off.await.expect("apply(false)");

    assert!(!state.settings.auth_config().await.unwrap().disabled);
    assert_eq!(
        read_slot(&state),
        (None, login.seq + 3),
        "apply(false) ended it (S-99)"
    );
    let answer = resolve_body(&state).await.expect("resolve");
    assert!(answer.identity.is_none());
    assert_eq!(answer.current, answer.checked);
}

/// PR #264 review P1: a logout whose re-read of the mode fails still
/// succeeds (the clear has happened) and installs nothing.
#[tokio::test]
async fn s67_a_logout_whose_mode_reread_fails_still_succeeds() {
    let mut state = app_state().await;
    let a = state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::Account(a)));
    let settings = state.settings.clone();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    state.auth_io.auth_mode = Arc::new(move || {
        let (settings, calls) = (settings.clone(), calls.clone());
        Box::pin(async move {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                settings.auth_config().await
            } else {
                Err(BantoError::Storage("injected".to_string()))
            }
        })
    });

    let result = logout_body(&state).await.expect("logout still succeeds");

    assert_eq!(result.seq, 2);
    assert_eq!(read_slot(&state), (None, 2));
    assert_eq!(audit_action_count(&state, "logout").await, 1);
}

/// Supplementary (design §8.3, not order-fixing): login and logout
/// started together, both having read seq before either proceeds past
/// its injected `.await`, end in exactly one of the two consistent
/// states.
#[tokio::test]
async fn concurrent_login_and_logout_end_in_one_of_two_consistent_states() {
    for _ in 0..3 {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("b", SLOT_PASSWORD, "B")
            .await
            .unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let (verify_barrier, users) = (barrier.clone(), state.users.clone());
        state.auth_io.verify = Arc::new(move |username, password| {
            let (barrier, users) = (verify_barrier.clone(), users.clone());
            Box::pin(async move {
                barrier.wait().await;
                users.verify(&username, &password).await
            })
        });
        let (mode_barrier, settings) = (barrier.clone(), state.settings.clone());
        // Only the logout's FIRST mode read meets the login at the
        // barrier - a logout that cleared re-reads the mode (PR #264
        // review P1), and that second read has no partner.
        let first_read = Arc::new(std::sync::atomic::AtomicBool::new(true));
        state.auth_io.auth_mode = Arc::new(move || {
            let (barrier, settings, first_read) =
                (mode_barrier.clone(), settings.clone(), first_read.clone());
            Box::pin(async move {
                if first_read.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    barrier.wait().await;
                }
                settings.auth_config().await
            })
        });

        let (login, logout) = tokio::join!(
            login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string()),
            logout_body(&state)
        );
        let (login, logout) = (login.unwrap(), logout.unwrap());
        match read_slot(&state).0 {
            None => assert!(login.superseded, "logged out, so the login was superseded"),
            Some(_) => {
                assert!(login.success);
                assert_eq!(logout.seq, login.seq, "the logout was a no-op");
            }
        }
    }
}

/// S-55 (Rust half): a password change from a session that was revoked
/// meanwhile clears the slot (advancing `seq`) and THEN fails with
/// `Unauthorized` - the one error kind returned after a slot write, which
/// the TS provider therefore treats as "the revision may have changed".
#[tokio::test]
async fn s55_change_password_on_a_revoked_session_advances_seq_then_fails_unauthorized() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("owner", SLOT_PASSWORD, "オーナー")
        .await
        .unwrap();
    let a = state
        .users
        .create_user("a", SLOT_PASSWORD, "A", Role::Editor)
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");
    state
        .users
        .update_user(a.id, "A", Role::Viewer)
        .await
        .unwrap();

    let result = change_own_password(&state, SLOT_PASSWORD, "newpassword1").await;

    assert!(
        matches!(result, Err(BantoError::Unauthorized)),
        "{result:?}"
    );
    assert_eq!(read_slot(&state), (None, login.seq + 1));
}

/// S-55 (Rust half): a wrong current password is a `Validation` error
/// returned without touching the slot.
#[tokio::test]
async fn s55_change_password_with_a_wrong_current_password_leaves_seq() {
    let state = app_state().await;
    state
        .users
        .setup_first_user("a", SLOT_PASSWORD, "A")
        .await
        .unwrap();
    let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
        .await
        .expect("login");

    let result = change_own_password(&state, "wrong-password", "newpassword1").await;

    assert!(
        matches!(result, Err(BantoError::Validation { .. })),
        "{result:?}"
    );
    assert_eq!(read_slot(&state).1, login.seq);
    assert!(read_slot(&state).0.is_some());
}

// ----- `server_apply_body` (#287 / #288 / #294 review) -----
//
// Everything runs on loopback with ports picked by `free_port` and released
// before use; ordering is made deterministic by port occupation and by
// holding `auth_config_lock`, never by sleeping.

/// A currently free loopback port (released again), in 25000-29999 and
/// never the same one twice in this process. Ports the OS picks
/// (`127.0.0.1:0`) can be handed out again to a test running in parallel
/// once released, so a test asserting "this port is free / answers" could
/// see another test's listener (Issue #459 review of the server tests).
/// [`occupy_port_outside_ephemeral_range`] stays below 25000.
fn free_port() -> u16 {
    static NEXT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
    let start = (std::process::id() % 1_000) as u16 * 5;
    for _ in 0..5_000 {
        let offset = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let port = 25_000 + (start + offset) % 5_000;
        if port_is_free(port) {
            return port;
        }
    }
    panic!("no free port in 25000-29999");
}

/// Whether something answers HTTP on `127.0.0.1:port` (any status).
async fn answers_http(port: u16) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
        return false;
    };
    let request = format!(
        "GET /api/auth/check HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Connection: close\r\nX-Banto-Client: banto\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response).await;
    String::from_utf8_lossy(&response).starts_with("HTTP/1.1 ")
}

/// Whether `port` can be bound again, i.e. no listener holds it.
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// A state whose desktop session is the first (admin) account.
async fn admin_app_state() -> AppState {
    let state = app_state().await;
    let admin = state
        .users
        .setup_first_user("manager", "password123", "管理者")
        .await
        .expect("setup_first_user");
    state.set_session_for_test(Some(DesktopSession::Account(admin)));
    state
}

/// Stop the server `server_apply_body` left running (if any).
async fn stop_running_server(state: &AppState) {
    let live = state.server.lock().await.live.take();
    if let Some(live) = live {
        live.server.stop().await;
    }
}

async fn apply(
    state: &AppState,
    enabled: bool,
    port: u16,
    viewer_public: bool,
) -> Result<ServerStatusResult, BantoError> {
    server_apply_body(state, enabled, "127.0.0.1".to_string(), port, viewer_public).await
}

async fn settings_change_entries(state: &AppState) -> Vec<(String, serde_json::Value)> {
    state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows
        .into_iter()
        .filter(|r| r.action == "settings_change" && r.resource == "settings")
        .map(|r| {
            let detail = r
                .detail
                .map(|d| serde_json::from_str(&d).expect("detail json"))
                .unwrap_or(serde_json::Value::Null);
            (r.result, detail)
        })
        .collect()
}

/// Normal apply: the server runs on the new port, the settings are
/// saved and the success is audited.
#[tokio::test]
async fn server_apply_starts_saves_and_audits() {
    let state = admin_app_state().await;
    let port = free_port();

    let status = apply(&state, true, port, false).await.expect("apply");

    assert!(status.running);
    assert_eq!(status.port, port);
    let saved = state.settings.server_config().await.unwrap();
    assert_eq!(
        (saved.enabled, saved.bind.as_str(), saved.port),
        (true, "127.0.0.1", port)
    );
    assert!(state.server.lock().await.live.is_some());
    assert!(answers_http(port).await);
    let entries = settings_change_entries(&state).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].0, "ok");
    assert_eq!(entries[0].1["port"], port);

    stop_running_server(&state).await;
}

/// #287: the new port is taken by someone else. The apply fails, the
/// saved settings stay on the old port, the old server is back and still
/// answers, and the failure is audited as `saved: false` /
/// `restoredPrevious: true`.
#[tokio::test]
async fn server_apply_port_in_use_restores_the_previous_server() {
    let state = admin_app_state().await;
    let port_a = free_port();
    apply(&state, true, port_a, false).await.expect("apply A");
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").expect("occupy");
    let port_b = occupied.local_addr().unwrap().port();

    let result = apply(&state, true, port_b, false).await;

    assert!(result.is_err(), "{result:?}");
    assert_eq!(state.settings.server_config().await.unwrap().port, port_a);
    assert!(state.server.lock().await.live.is_some());
    assert!(answers_http(port_a).await, "old server must be restored");
    let entries = settings_change_entries(&state).await;
    let failed: Vec<_> = entries.iter().filter(|(r, _)| r == "failed").collect();
    assert_eq!(failed.len(), 1, "{entries:?}");
    assert_eq!(failed[0].1["saved"], false);
    assert_eq!(failed[0].1["restoredPrevious"], true);
    assert_eq!(failed[0].1["port"], port_b);

    drop(occupied);
    stop_running_server(&state).await;
}

// ----- `bind_saved_server_at_launch` (launch-time port fallback) -----

/// Occupy a loopback port in 20000-24899 whose next port is free. The
/// fallback binds the ports right behind the occupied one; doing that
/// next to an OS-picked port would take the port the OS hands out next
/// (Windows allocates them sequentially) and break a test running in
/// parallel. Both OS ephemeral ranges (Windows 49152+, Linux 32768+) are
/// well above this range, and it stays below `free_port()`'s 25000+ (with
/// room for the `PORT_FALLBACK_SPAN` ports behind it).
fn occupy_port_outside_ephemeral_range() -> std::net::TcpListener {
    let start = 20_000 + (std::process::id() % 900) as u16 * 5;
    for base in (start..24_900).step_by(7).chain((20_000..start).step_by(7)) {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", base)) {
            if port_is_free(base + 1) {
                return listener;
            }
        }
    }
    panic!("no free port pair in 20000-24899");
}

async fn save_enabled_server_config(state: &AppState, port: u16) -> ServerSettings {
    let saved = ServerSettings {
        enabled: true,
        bind: "127.0.0.1".to_string(),
        port,
        viewer_public: false,
    };
    state
        .settings
        .set_server_config(&saved)
        .await
        .expect("save server config");
    saved
}

/// The saved port is in use at launch: the server binds a port right
/// behind it, `server.port` is updated to that port, the change is audited
/// as a system `settings_change` (no actor), and the notice carries both
/// ports. A later `server_apply` clears the notice.
#[tokio::test]
async fn launch_with_saved_port_in_use_falls_back_saves_audits_and_reports() {
    let state = admin_app_state().await;
    let occupied = occupy_port_outside_ephemeral_range();
    let port = occupied.local_addr().unwrap().port();
    let saved = save_enabled_server_config(&state, port).await;

    let (bound, notice) = bind_saved_server_at_launch(&state.settings, &state.audit, &saved).await;

    let bound = bound.expect("a neighbouring port is bound");
    let chosen = bound.local_addr().port();
    assert_ne!(chosen, port);
    assert!(
        (port + 1..=port.saturating_add(banto_server::PORT_FALLBACK_SPAN)).contains(&chosen),
        "{chosen} must be right behind {port}"
    );
    assert_eq!(bound.local_addr().ip().to_string(), "127.0.0.1");
    assert_eq!(
        notice,
        Some(ServerPortNotice::Fallback {
            requested_port: port,
            port: chosen,
            saved: true,
        })
    );
    let stored = state.settings.server_config().await.unwrap();
    assert_eq!((stored.port, stored.bind.as_str()), (chosen, "127.0.0.1"));
    let rows = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows;
    let entry = rows
        .iter()
        .find(|r| r.action == "settings_change")
        .expect("system settings_change entry");
    assert_eq!(entry.result, "ok");
    assert_eq!(entry.actor_username, None);
    let detail: serde_json::Value =
        serde_json::from_str(entry.detail.as_deref().expect("detail")).unwrap();
    assert_eq!(detail["previousPort"], port);
    assert_eq!(detail["port"], chosen);
    assert_eq!(detail["reason"], "portInUse");
    assert_eq!(detail["saved"], true);

    // Release the listener; the user's own apply clears the notice.
    drop(bound);
    state.server.lock().await.port_notice = notice;
    let status = apply(&state, true, free_port(), false)
        .await
        .expect("apply");
    assert_eq!(status.port_notice, None);
    assert_eq!(state.server.lock().await.port_notice, None);

    drop(occupied);
    stop_running_server(&state).await;
}

/// A free saved port is bound as-is: no notice, nothing saved or audited.
#[tokio::test]
async fn launch_with_saved_port_free_binds_it_without_a_notice() {
    let state = admin_app_state().await;
    let port = free_port();
    let saved = save_enabled_server_config(&state, port).await;

    let (bound, notice) = bind_saved_server_at_launch(&state.settings, &state.audit, &saved).await;

    assert_eq!(bound.expect("bound").local_addr().port(), port);
    assert_eq!(notice, None);
    assert!(settings_change_entries(&state).await.is_empty());
}

/// A failure other than "in use" (an address this machine does not have)
/// tries no other port and reports nothing.
#[tokio::test]
async fn launch_bind_failure_other_than_in_use_does_not_fall_back() {
    let state = admin_app_state().await;
    let saved = ServerSettings {
        enabled: true,
        bind: "192.0.2.1".to_string(),
        port: free_port(),
        viewer_public: false,
    };

    let (bound, notice) = bind_saved_server_at_launch(&state.settings, &state.audit, &saved).await;

    assert!(bound.is_none());
    assert_eq!(notice, None);
    assert!(settings_change_entries(&state).await.is_empty());
}

/// The notice reaches the frontend as codes + ports only (the text is
/// built from messages/{en,ja}.json there, conventions §13).
#[test]
fn server_port_notice_serializes_as_tagged_camel_case() {
    assert_eq!(
        serde_json::to_value(ServerPortNotice::Fallback {
            requested_port: 8721,
            port: 8722,
            saved: true,
        })
        .unwrap(),
        serde_json::json!({
            "kind": "fallback",
            "requestedPort": 8721,
            "port": 8722,
            "saved": true,
        })
    );
    assert_eq!(
        serde_json::to_value(ServerPortNotice::Exhausted {
            requested_port: 8721,
            last_port: 8740,
            all_in_use: false,
        })
        .unwrap(),
        serde_json::json!({
            "kind": "exhausted",
            "requestedPort": 8721,
            "lastPort": 8740,
            "allInUse": false,
        })
    );
}

/// #288: with `auth.disabled` stored, enabling the LAN server without
/// 閲覧公開 is refused BEFORE anything is stopped; with 閲覧公開 it works.
#[tokio::test]
async fn server_apply_refuses_lan_without_viewer_public_when_auth_disabled() {
    let state = admin_app_state().await;
    let port_a = free_port();
    // Running with 閲覧公開 ON makes disabling auth legal.
    apply(&state, true, port_a, true).await.expect("apply A");
    let mut auth = state.settings.auth_config().await.unwrap();
    auth.disabled = true;
    state.settings.set_auth_config(&auth).await.expect("auth");
    let before = state.settings.server_config().await.unwrap();

    let result = apply(&state, true, free_port(), false).await;

    assert!(result.is_err(), "{result:?}");
    assert!(
        state.server.lock().await.live.is_some(),
        "nothing was stopped"
    );
    assert!(answers_http(port_a).await);
    assert_eq!(state.settings.server_config().await.unwrap(), before);

    let status = apply(&state, true, port_a, true).await.expect("viewer ON");
    assert!(status.running);
    assert!(answers_http(port_a).await);

    stop_running_server(&state).await;
}

/// #294 review: an `auth.disabled = true` save that lands while the apply
/// is waiting for `auth_config_lock` (after its bind) is seen by the
/// apply's final validation. The apply fails, the stored `server.*` is
/// unchanged and the new port is released again.
#[tokio::test]
async fn server_apply_is_serialized_with_auth_config_writes() {
    let state = admin_app_state().await;
    let before = state.settings.server_config().await.unwrap();
    let port = free_port();
    let guard = state.auth_config_lock.lock().await;

    let applying = apply(&state, true, port, false);
    tokio::pin!(applying);
    // The listener is bound => the apply is at its save, which needs the
    // lock we hold.
    drive_until!(applying, !port_is_free(port));
    assert_stays_pending!(applying);
    assert_eq!(state.settings.server_config().await.unwrap(), before);

    let mut auth = state.settings.auth_config().await.unwrap();
    auth.disabled = true;
    state.settings.set_auth_config(&auth).await.expect("auth");
    drop(guard);
    let result = applying.await;

    assert!(result.is_err(), "{result:?}");
    assert_eq!(state.settings.server_config().await.unwrap(), before);
    assert!(state.server.lock().await.live.is_none());
    assert!(port_is_free(port), "the new listener must be released");
}

/// 閲覧公開 OFF on apply revokes the viewer-public grant tokens issued
/// before (ADR-0017: `revoke_grant_tokens` after the save).
#[tokio::test]
async fn server_apply_with_viewer_public_off_revokes_public_viewer_tokens() {
    let state = admin_app_state().await;
    let spec = GrantSpec::public_viewer(state.settings.clone());
    let token = state
        .rest_auth
        .issue_grant_token(&spec, state.rest_auth.grant_generation(&spec.kind))
        .expect("issued");
    assert!(state.rest_auth.verify(&token));

    apply(&state, true, free_port(), false)
        .await
        .expect("apply");

    assert!(!state.rest_auth.verify(&token));
    stop_running_server(&state).await;
}

/// `enabled = false` stops the running server (its port is released) and
/// saves `enabled = false`.
#[tokio::test]
async fn server_apply_disabled_stops_the_running_server() {
    let state = admin_app_state().await;
    let port = free_port();
    apply(&state, true, port, false).await.expect("start");
    assert!(answers_http(port).await);

    let status = apply(&state, false, port, false).await.expect("stop");

    assert!(!status.running);
    // Issue #459: stopped = no live listener, no URL/QR, no failure.
    assert_eq!(status.live, None);
    assert!(status.urls.is_empty() && status.qr_svgs.is_empty());
    assert_eq!(status.apply_failure, None);
    assert_eq!(status.generation, 2);
    assert!(state.server.lock().await.live.is_none());
    assert!(!state.settings.server_config().await.unwrap().enabled);
    assert!(port_is_free(port));
}

/// A non-admin is refused and nothing changes.
#[tokio::test]
async fn server_apply_is_admin_only() {
    let state = app_state().await;
    let viewer = state
        .users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(viewer)));
    let before = state.settings.server_config().await.unwrap();
    let port = free_port();

    let err = apply(&state, true, port, false).await.unwrap_err();

    assert!(matches!(err, BantoError::Forbidden), "{err:?}");
    assert_eq!(state.settings.server_config().await.unwrap(), before);
    assert!(state.server.lock().await.live.is_none());
    assert!(port_is_free(port));
    assert!(settings_change_entries(&state).await.is_empty());
}

// ----- Issue #459: `server.*` writes and the live status snapshot -----

/// The generic `settings_set` refuses every `server.` key (a bad request,
/// not audited - like the `auth.` refusal), the saved settings and the
/// live listener stay as they were, and `server_apply` still writes them.
#[tokio::test]
async fn settings_set_refuses_server_keys_but_server_apply_still_writes_them() {
    let state = admin_app_state().await;
    let actor = current_actor(&state).await;
    let port_a = free_port();
    apply(&state, true, port_a, false).await.expect("apply A");
    let before = state.settings.server_config().await.unwrap();
    let audited_before = settings_change_entries(&state).await.len();

    for (key, value) in [
        ("server.port", "1"),
        ("server.bind", "0.0.0.0"),
        ("server.enabled", "false"),
        ("server.viewer_public", "true"),
        ("server.future_key", "x"),
    ] {
        let result = settings_set_body(&state, &actor, key.to_string(), value.to_string()).await;
        assert!(
            matches!(result, Err(BantoError::BadRequest(_))),
            "{key}: {result:?}"
        );
    }

    assert_eq!(state.settings.server_config().await.unwrap(), before);
    assert_eq!(settings_change_entries(&state).await.len(), audited_before);
    let status = server_status_body(&state).await.expect("status");
    assert_eq!(status.port, port_a);
    assert_eq!(status.live.map(|live| live.port), Some(port_a));

    let port_b = free_port();
    let status = apply(&state, true, port_b, false).await.expect("apply B");
    assert_eq!(state.settings.server_config().await.unwrap().port, port_b);
    assert_eq!(status.live.map(|live| live.port), Some(port_b));
    assert!(answers_http(port_b).await);

    stop_running_server(&state).await;
}

/// The account of the admin session [`admin_app_state`] set up.
async fn current_actor(state: &AppState) -> UserIdentity {
    require_role(state, Role::Admin, "settings")
        .await
        .expect("admin session")
}

/// Issue #219: the executable path (local information) and the platform
/// code reach only an admin - they ride on the admin-gated status, so
/// viewer / editor / no session get no status at all (see
/// [`server_status_is_admin_only`]) and an admin gets both.
#[tokio::test]
async fn server_status_reports_the_executable_path_only_to_an_admin() {
    let state = app_state().await;
    assert!(matches!(
        server_status_body(&state).await,
        Err(BantoError::Unauthorized)
    ));
    for (name, role) in [("viewer", Role::Viewer), ("editor", Role::Editor)] {
        let user = state
            .users
            .create_user(name, "password123", name, role)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(user)));
        assert!(
            matches!(server_status_body(&state).await, Err(BantoError::Forbidden)),
            "{name}"
        );
    }

    let state = admin_app_state().await;
    let status = server_status_body(&state).await.expect("status");
    let expected = std::env::current_exe()
        .expect("current_exe")
        .into_os_string()
        .into_string()
        .ok();
    assert!(expected.is_some(), "the test binary path is UTF-8");
    assert_eq!(status.executable_path, expected);
    assert_eq!(status.platform, std::env::consts::OS);
    let value = serde_json::to_value(&status).unwrap();
    assert_eq!(value["executablePath"], serde_json::json!(expected));
    assert_eq!(value["platform"], std::env::consts::OS);
}

/// `server_status` keeps refusing viewer / editor / no session.
#[tokio::test]
async fn server_status_is_admin_only() {
    let state = app_state().await;
    assert!(matches!(
        server_status_body(&state).await,
        Err(BantoError::Unauthorized)
    ));
    for (name, role) in [("viewer", Role::Viewer), ("editor", Role::Editor)] {
        let user = state
            .users
            .create_user(name, "password123", name, role)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(user)));
        let result = server_status_body(&state).await;
        assert!(
            matches!(result, Err(BantoError::Forbidden)),
            "{name}: {result:?}"
        );
    }
}

// ----- reach check (Issue #219 stage 1 / PR-C2, lan-reach-check-design) -----

/// The LAN address the tests pretend this PC's NIC has (TEST-NET-1), and
/// another device on the LAN (TEST-NET-3) - neither is this machine's, so
/// the outcome does not depend on the host the tests run on.
const REACH_LAN_HOST: &str = "192.0.2.10";
const REACH_PEER: &str = "203.0.113.7";

/// The live listener's real addresses plus the pretended NIC's.
fn reach_lan_addrs(bind: &str) -> Vec<std::net::Ipv4Addr> {
    let mut addrs = lan_addrs_for_bind(bind);
    addrs.push(REACH_LAN_HOST.parse().expect("ip"));
    addrs
}

/// An issuance whose "own addresses" are the pretended NIC's.
fn reach_issue(
    store: &ReachCheckState,
    generation: u64,
    target: ReachTarget,
) -> Result<ReachIssue, ReachIssueError> {
    store.issue_with_local_addrs(
        generation,
        target,
        vec![REACH_LAN_HOST.parse().expect("ip")],
    )
}

/// An issuance that must not run (refused before the store).
fn unreachable_reach_issue(
    _: &ReachCheckState,
    _: u64,
    _: ReachTarget,
) -> Result<ReachIssue, ReachIssueError> {
    panic!("the reach-check store must not be touched");
}

async fn issue_reach(state: &AppState) -> ReachCheckIssueResult {
    reach_check_issue_body(state, REACH_LAN_HOST, reach_lan_addrs, reach_issue)
        .await
        .expect("reach_check_issue")
}

/// `(generation, token)` of an `issued` answer (the token from the URL
/// fragment, the only place it is handed out).
fn issued_token(result: &ReachCheckIssueResult) -> (u64, String) {
    match result {
        ReachCheckIssueResult::Issued {
            generation, url, ..
        } => {
            let (_, token) = url.split_once("#t=").expect("token in the fragment");
            (*generation, token.to_string())
        }
        other => panic!("not issued: {other:?}"),
    }
}

/// `POST /api/reach-check` from [`REACH_PEER`] to the listener of
/// `generation` on `port`, through the issued URL's `Host`.
fn check_from_another_device(
    state: &AppState,
    generation: u64,
    port: u16,
    token: &str,
) -> banto_server::CheckOutcome {
    let peer = std::net::SocketAddr::new(REACH_PEER.parse().expect("ip"), 40_000);
    let host = format!("{REACH_LAN_HOST}:{port}");
    state
        .reach_check
        .check(Some(peer), generation, port, Some(&host), token)
}

/// `POST /api/reach-check` to the listener on `127.0.0.1:port` with the
/// given `Host`; the raw HTTP response.
async fn post_reach_check(port: u16, host: &str, token: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let body = serde_json::json!({ "token": token }).to_string();
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\
         X-Banto-Client: banto\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n\r\n{body}",
        banto_server::reach_check::REACH_CHECK_PATH,
        body.len()
    );
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response).await;
    String::from_utf8_lossy(&response).into_owned()
}

/// No session / viewer / editor are refused before the store is
/// touched: no token is made, nothing is read.
#[tokio::test]
async fn reach_check_commands_are_admin_only() {
    let state = app_state().await;
    assert!(matches!(
        reach_check_issue_body(
            &state,
            REACH_LAN_HOST,
            reach_lan_addrs,
            unreachable_reach_issue
        )
        .await,
        Err(BantoError::Unauthorized)
    ));
    assert!(matches!(
        reach_check_status_body(&state).await,
        Err(BantoError::Unauthorized)
    ));
    for (name, role) in [("viewer", Role::Viewer), ("editor", Role::Editor)] {
        let user = state
            .users
            .create_user(name, "password123", name, role)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(user)));
        let issued = reach_check_issue_body(
            &state,
            REACH_LAN_HOST,
            reach_lan_addrs,
            unreachable_reach_issue,
        )
        .await;
        assert!(
            matches!(issued, Err(BantoError::Forbidden)),
            "{name}: {issued:?}"
        );
        let status = reach_check_status_body(&state).await;
        assert!(
            matches!(status, Err(BantoError::Forbidden)),
            "{name}: {status:?}"
        );
    }
    assert_eq!(state.reach_check.status().last_issue, None);
}

/// Nothing is issued while nothing serves, for a loopback-only or an
/// unsupported listener, or for a host that is not a live URL candidate
/// (loopback included) - each answers its code, the store is untouched.
#[tokio::test]
async fn reach_check_issue_refuses_without_a_lan_url_for_the_host() {
    fn no_urls(_: &str) -> Vec<std::net::Ipv4Addr> {
        Vec::new()
    }
    let state = admin_app_state().await;
    let refused = |reason| ReachCheckIssueResult::Refused {
        generation: 0,
        reason,
    };
    assert_eq!(
        reach_check_issue_body(
            &state,
            REACH_LAN_HOST,
            reach_lan_addrs,
            unreachable_reach_issue
        )
        .await
        .unwrap(),
        refused(ReachCheckRefusal::NotListening)
    );

    let port = free_port();
    let applied = apply(&state, true, port, false).await.expect("apply");
    let refused = |reason| ReachCheckIssueResult::Refused {
        generation: applied.generation,
        reason,
    };
    let cases: [(&str, LanAddrsFor, ReachCheckRefusal); 4] = [
        // The real candidates of a 127.0.0.1 listener: loopback only.
        (
            REACH_LAN_HOST,
            lan_addrs_for_bind,
            ReachCheckRefusal::LoopbackOnly,
        ),
        (REACH_LAN_HOST, no_urls, ReachCheckRefusal::UnsupportedBind),
        (
            "192.0.2.99",
            reach_lan_addrs,
            ReachCheckRefusal::UnknownHost,
        ),
        ("127.0.0.1", reach_lan_addrs, ReachCheckRefusal::UnknownHost),
    ];
    for (host, urls, reason) in cases {
        assert_eq!(
            reach_check_issue_body(&state, host, urls, unreachable_reach_issue)
                .await
                .unwrap(),
            refused(reason),
            "{host}"
        );
    }
    assert_eq!(state.reach_check.status().last_issue, None);

    stop_running_server(&state).await;
}

/// Issue -> another device posts the token -> `recorded`, and
/// `reach_check_status` shows the record for the live listener.
#[tokio::test]
async fn reach_check_issue_then_another_device_is_recorded() {
    let state = admin_app_state().await;
    let port = free_port();
    let applied = apply(&state, true, port, false).await.expect("apply");

    let issued = issue_reach(&state).await;
    let (generation, token) = issued_token(&issued);
    assert_eq!(generation, applied.generation);
    let ReachCheckIssueResult::Issued { url, qr_svg, .. } = &issued else {
        unreachable!();
    };
    assert_eq!(
        url,
        &format!("http://{REACH_LAN_HOST}:{port}/reach#t={token}")
    );
    assert!(qr_svg.starts_with("<?xml") || qr_svg.contains("<svg"));

    assert_eq!(
        check_from_another_device(&state, generation, port, &token),
        banto_server::CheckOutcome::Recorded
    );
    let status = reach_check_status_body(&state).await.expect("status");
    assert_eq!(status.generation, applied.generation);
    let last = status.last_issue.expect("last issue");
    assert_eq!(last.outcome, banto_server::ReachOutcome::Recorded);
    assert_eq!((last.host.as_str(), last.port), (REACH_LAN_HOST, port));
    assert_eq!(status.records.len(), 1);
    let record = &status.records[0];
    assert_eq!(record.peer_ip.to_string(), REACH_PEER);
    assert_eq!((record.host.as_str(), record.port), (REACH_LAN_HOST, port));
    assert_eq!(status.self_access_at_ms, None);

    stop_running_server(&state).await;
}

/// Design §3.5: `server_apply` changes the listener -> the issued token
/// is unusable (on the new listener and on the old one) and the last
/// issuance is gone (old results are not carried over).
#[tokio::test]
async fn server_apply_revokes_the_issued_reach_check_token() {
    let state = admin_app_state().await;
    let port_a = free_port();
    apply(&state, true, port_a, false).await.expect("apply A");
    let (generation_a, token) = issued_token(&issue_reach(&state).await);

    let port_b = free_port();
    let applied = apply(&state, true, port_b, false).await.expect("apply B");
    assert_eq!(applied.generation, generation_a + 1);

    let status = reach_check_status_body(&state).await.expect("status");
    assert_eq!(status.generation, applied.generation);
    assert_eq!(status.last_issue, None);
    for (generation, port) in [(applied.generation, port_b), (generation_a, port_a)] {
        assert_eq!(
            check_from_another_device(&state, generation, port, &token),
            banto_server::CheckOutcome::Unusable,
            "generation {generation}, port {port}"
        );
    }
    assert!(reach_check_status_body(&state)
        .await
        .expect("status")
        .records
        .is_empty());

    stop_running_server(&state).await;
}

/// Design review: an apply that fails and restores the previous listener
/// still starts a new generation - the old token is unusable, and a
/// token issued afterwards is checked by the RESTORED listener's router
/// (same generation as the store) and recorded on the old port.
#[tokio::test]
async fn reach_check_after_a_failed_apply_works_on_the_restored_listener() {
    let state = admin_app_state().await;
    let port_a = free_port();
    apply(&state, true, port_a, false).await.expect("apply A");
    let (generation_a, old_token) = issued_token(&issue_reach(&state).await);
    let port_b = free_port();
    let occupied = std::net::TcpListener::bind(("127.0.0.1", port_b)).expect("occupy");

    assert!(apply(&state, true, port_b, false).await.is_err());
    let server = server_status_body(&state).await.expect("server status");
    assert_eq!(server.live.as_ref().map(|live| live.port), Some(port_a));
    assert_eq!(server.generation, generation_a + 1);
    assert_eq!(
        check_from_another_device(&state, server.generation, port_a, &old_token),
        banto_server::CheckOutcome::Unusable
    );
    assert_eq!(
        reach_check_status_body(&state)
            .await
            .expect("status")
            .last_issue,
        None
    );

    let (generation, token) = issued_token(&issue_reach(&state).await);
    assert_eq!(generation, server.generation);
    // Through the restored listener itself: from this PC (loopback) the
    // router answers `selfAccess` only when its own generation and port
    // match the token's (a router left on the old generation would answer
    // `unusable`); a self access does not consume the token.
    let response = post_reach_check(port_a, &format!("{REACH_LAN_HOST}:{port_a}"), &token).await;
    assert!(response.contains("\"selfAccess\""), "{response}");
    assert_eq!(
        check_from_another_device(&state, generation, port_a, &token),
        banto_server::CheckOutcome::Recorded
    );
    let status = reach_check_status_body(&state).await.expect("status");
    assert_eq!(status.records.len(), 1);
    assert_eq!(status.records[0].port, port_a);

    drop(occupied);
    stop_running_server(&state).await;
}

/// Design §3.9: the token appears only in the issued URL's fragment - not
/// in the rest of the answer, its `Debug`, the status, or the audit log.
#[tokio::test]
async fn reach_check_answers_hold_the_token_only_in_the_url_fragment() {
    let state = admin_app_state().await;
    let port = free_port();
    apply(&state, true, port, false).await.expect("apply");
    let audit_before = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit")
        .total_count;

    let issued = issue_reach(&state).await;
    let (generation, token) = issued_token(&issued);
    let json = serde_json::to_string(&issued).expect("json");
    assert_eq!(json.matches(token.as_str()).count(), 1, "{json}");
    let value = serde_json::to_value(&issued).expect("json");
    assert_eq!(value["status"], "issued");
    let url = value["url"].as_str().expect("url");
    let (base, fragment) = url.split_once('#').expect("fragment");
    assert!(!base.contains(token.as_str()));
    assert_eq!(fragment, format!("t={token}"));
    for key in ["generation", "issueId", "qrSvg", "expiresInMs"] {
        assert!(value.get(key).is_some(), "{key}: {value}");
    }
    assert!(!format!("{issued:?}").contains(token.as_str()));

    check_from_another_device(&state, generation, port, &token);
    let status = serde_json::to_string(&reach_check_status_body(&state).await.expect("status"))
        .expect("json");
    assert!(!status.contains(token.as_str()), "{status}");
    // Neither the issuance nor the reach is audited (design D8).
    let entries = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit");
    assert_eq!(entries.total_count, audit_before);

    stop_running_server(&state).await;
}

/// The refusal codes and the issued shape are camelCase on the wire.
#[test]
fn reach_check_refusal_serializes_as_a_code() {
    let value = serde_json::to_value(ReachCheckIssueResult::Refused {
        generation: 4,
        reason: ReachCheckRefusal::LocalAddressesUnavailable,
    })
    .expect("json");
    assert_eq!(
        value,
        serde_json::json!({
            "status": "refused",
            "generation": 4,
            "reason": "localAddressesUnavailable",
        })
    );
}

/// A probe that must not run (the gate refused before the read).
fn unreachable_probe(
    _: &firewall_status::RuleNames,
) -> Result<String, firewall_status::UnknownReason> {
    panic!("the firewall must not be read");
}

/// Issue #219 PR-B: the firewall read is admin-only like `server_status`
/// - no session / viewer / editor are refused before anything is read
/// (no PowerShell runs for them).
#[tokio::test]
async fn firewall_rule_status_is_admin_only() {
    let state = app_state().await;
    assert!(matches!(
        firewall_rule_status_body(&state, "com.example.banto", unreachable_probe).await,
        Err(BantoError::Unauthorized)
    ));
    for (name, role) in [("viewer", Role::Viewer), ("editor", Role::Editor)] {
        let user = state
            .users
            .create_user(name, "password123", name, role)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(user)));
        let result =
            firewall_rule_status_body(&state, "com.example.banto", unreachable_probe).await;
        assert!(
            matches!(result, Err(BantoError::Forbidden)),
            "{name}: {result:?}"
        );
    }
}

/// The probe gets the names derived from the app identifier, and the
/// result is compared with the live listener and executable of the same
/// snapshot (its `generation`), not the saved settings.
#[tokio::test]
async fn firewall_rule_status_compares_with_the_live_snapshot() {
    fn probe(names: &firewall_status::RuleNames) -> Result<String, firewall_status::UnknownReason> {
        assert_eq!(names.program, "com.example.banto.lan.tcp.program");
        assert_eq!(names.port, "com.example.banto.lan.tcp.port");
        assert_eq!(names.group, "com.example.banto");
        let rule = r#"{"s":"present","enabled":"True","direction":"Inbound","action":"Allow","protocol":"TCP","profile":"Private","program":"Any","localPort":["1"],"remoteAddress":["LocalSubnet"],"source":"PersistentStore","sourceType":"Local"}"#;
        Ok(format!(
            r#"{{"program":{{"local":{{"s":"missing"}},"effective":{{"s":"missing"}}}},"port":{{"local":{rule},"effective":{rule}}},"group":0}}"#
        ))
    }
    let state = admin_app_state().await;
    let port = free_port();
    let applied = apply(&state, true, port, false).await.expect("apply");
    // A saved value that disagrees with the live listener is not used.
    state
        .settings
        .set("server.port", &free_port().to_string())
        .await
        .unwrap();

    let status = firewall_rule_status_body(&state, "com.example.banto", probe)
        .await
        .expect("status");

    assert_eq!(status.generation, applied.generation);
    assert_eq!(status.expected.port, Some(port));
    assert_eq!(status.expected.executable_path, applied.executable_path);
    assert_eq!(status.program, firewall_status::FirewallRuleCheck::Missing);
    match &status.port {
        firewall_status::FirewallRuleCheck::Present { mismatches, .. } => {
            // The rule says port 1; the live port is another one.
            assert_eq!(mismatches, &vec![firewall_status::FirewallField::LocalPort]);
        }
        other => panic!("{other:?}"),
    }
    stop_running_server(&state).await;
}

/// An identifier outside Tauri's alphabet reads nothing and reports
/// `unknown`, never `missing`.
#[tokio::test]
async fn firewall_rule_status_refuses_an_invalid_identifier() {
    let state = admin_app_state().await;
    let status = firewall_rule_status_body(&state, "x'; calc; '", unreachable_probe)
        .await
        .expect("status");
    let unknown = firewall_status::FirewallRuleCheck::Unknown {
        reason: firewall_status::UnknownReason::InvalidIdentifier,
    };
    assert_eq!(status.program, unknown);
    assert_eq!(status.port, unknown);
    assert_eq!(status.expected.port, None);
}

// --- firewall_rule_change (Issue #219 stage 2, ADR-0021 E2) -----------

const FW_HELPER: &str = r"C:\Program Files\Banto Admin\admin-template-fw-elev.exe";

type FwCheck = fn() -> Result<admin_template_fw_elev::placement::Placement, &'static str>;
type FwLaunch = fn(&std::path::Path, &[&str]) -> Result<u32, elevated_launch::LaunchError>;

fn fw_placement_ok() -> Result<admin_template_fw_elev::placement::Placement, &'static str> {
    Ok(admin_template_fw_elev::placement::Placement {
        helper_exe: FW_HELPER.into(),
        main_exe: r"C:\Program Files\Banto Admin\admin-template.exe".into(),
    })
}

fn fw_placement_unreachable() -> Result<admin_template_fw_elev::placement::Placement, &'static str>
{
    panic!("the placement must not be checked");
}

fn fw_placement_reparse() -> Result<admin_template_fw_elev::placement::Placement, &'static str> {
    Err("reparsePoint")
}

fn fw_launch_unreachable(
    _: &std::path::Path,
    _: &[&str],
) -> Result<u32, elevated_launch::LaunchError> {
    panic!("the helper must not be started");
}

fn fw_probe_failed(
    _: &firewall_status::RuleNames,
) -> Result<String, firewall_status::UnknownReason> {
    Err(firewall_status::UnknownReason::QueryFailed)
}

fn fw_deps(check: FwCheck, launch: FwLaunch) -> FirewallChangeDeps {
    FirewallChangeDeps {
        check,
        launch,
        probe: fw_probe_failed,
    }
}

async fn fw_current_target(state: &AppState) -> firewall_change::FirewallChangeTarget {
    firewall_change::FirewallChangeTarget {
        executable_path: current_executable_path(),
        generation: state.server.lock().await.generation,
    }
}

async fn fw_change(
    state: &AppState,
    identifier: &str,
    operation: firewall_change::FirewallChangeOperation,
    target: &firewall_change::FirewallChangeTarget,
    check: FwCheck,
    launch: FwLaunch,
) -> Result<firewall_change::FirewallChangeResult, BantoError> {
    firewall_rule_change_body(state, identifier, operation, target, fw_deps(check, launch)).await
}

/// The `firewall_change` rows as `(resource, entity_id, result, detail)`.
async fn fw_audit_rows(
    state: &AppState,
) -> Vec<(String, Option<String>, String, serde_json::Value)> {
    state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows
        .into_iter()
        .filter(|row| row.action == "firewall_change")
        .map(|row| {
            let detail = row
                .detail
                .map(|d| serde_json::from_str(&d).expect("detail json"))
                .unwrap_or(serde_json::Value::Null);
            (row.resource, row.entity_id, row.result, detail)
        })
        .collect()
}

/// Decision 12: admin-only. No session is refused unaudited, a lower
/// role is refused with `denied` - and neither reaches the placement
/// check or the helper.
#[tokio::test]
async fn firewall_rule_change_is_admin_only() {
    let state = app_state().await;
    let target = fw_current_target(&state).await;
    let allow = firewall_change::FirewallChangeOperation::Allow;
    let id = admin_template_fw_elev::IDENTIFIER;
    assert!(matches!(
        fw_change(
            &state,
            id,
            allow,
            &target,
            fw_placement_unreachable,
            fw_launch_unreachable
        )
        .await,
        Err(BantoError::Unauthorized)
    ));
    for (name, role) in [("viewer", Role::Viewer), ("editor", Role::Editor)] {
        let user = state
            .users
            .create_user(name, "password123", name, role)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(user)));
        let result = fw_change(
            &state,
            id,
            allow,
            &target,
            fw_placement_unreachable,
            fw_launch_unreachable,
        )
        .await;
        assert!(
            matches!(result, Err(BantoError::Forbidden)),
            "{name}: {result:?}"
        );
    }
    let denied: Vec<_> = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows
        .into_iter()
        .filter(|row| row.action == "denied")
        .map(|row| row.resource)
        .collect();
    assert_eq!(denied, vec!["firewall", "firewall"]);
    assert!(fw_audit_rows(&state).await.is_empty());
}

/// Decision 8: a refused placement starts nothing (no UAC prompt) and is
/// audited as a precondition failure with its code.
#[tokio::test]
async fn firewall_rule_change_refused_placement_starts_nothing() {
    let state = admin_app_state().await;
    let target = fw_current_target(&state).await;
    let result = fw_change(
        &state,
        admin_template_fw_elev::IDENTIFIER,
        firewall_change::FirewallChangeOperation::Allow,
        &target,
        fw_placement_reparse,
        fw_launch_unreachable,
    )
    .await
    .expect("result");
    assert_eq!(
        result.outcome,
        firewall_change::FirewallChangeOutcome::Precondition
    );
    assert_eq!(result.refusal, Some("reparsePoint"));
    assert_eq!(result.exit_code, None);
    assert!(!result.stale);
    assert_eq!(result.status.generation, target.generation);
    assert_eq!(
        fw_audit_rows(&state).await,
        vec![(
            "firewall".to_string(),
            Some(format!(
                "{}.lan.tcp.program",
                admin_template_fw_elev::IDENTIFIER
            )),
            "failed".to_string(),
            serde_json::json!({
                "operation": "allow",
                "outcome": "precondition",
                "stale": false,
                "refusal": "reparsePoint",
            }),
        )]
    );
}

/// An app identifier other than the helper's built-in one is refused
/// before the placement is even read.
#[tokio::test]
async fn firewall_rule_change_refuses_another_identifier() {
    let state = admin_app_state().await;
    let target = fw_current_target(&state).await;
    let result = fw_change(
        &state,
        "com.example.banto",
        firewall_change::FirewallChangeOperation::Remove,
        &target,
        fw_placement_unreachable,
        fw_launch_unreachable,
    )
    .await
    .expect("result");
    assert_eq!(
        result.outcome,
        firewall_change::FirewallChangeOutcome::Precondition
    );
    assert_eq!(result.refusal, Some("identifierMismatch"));
    assert_eq!(fw_audit_rows(&state).await.len(), 1);
}

/// Decision 13: a target other than the current one (another generation
/// or another exe path) starts nothing and asks to confirm again; nothing
/// was attempted, so nothing is audited.
#[tokio::test]
async fn firewall_rule_change_refuses_a_target_that_changed() {
    let state = admin_app_state().await;
    let current = fw_current_target(&state).await;
    for target in [
        firewall_change::FirewallChangeTarget {
            generation: current.generation + 1,
            ..current.clone()
        },
        firewall_change::FirewallChangeTarget {
            executable_path: Some(r"C:\elsewhere\admin-template.exe".into()),
            ..current.clone()
        },
    ] {
        let result = fw_change(
            &state,
            admin_template_fw_elev::IDENTIFIER,
            firewall_change::FirewallChangeOperation::Allow,
            &target,
            fw_placement_ok,
            fw_launch_unreachable,
        )
        .await
        .expect("result");
        assert_eq!(
            result.outcome,
            firewall_change::FirewallChangeOutcome::TargetChanged
        );
        // The fresh read the screen confirms again with.
        assert_eq!(result.status.generation, current.generation);
    }
    assert!(fw_audit_rows(&state).await.is_empty());
}

/// The checked helper is started with the operation as its only
/// argument; exit 0 is `done` (not "reachable"), audited `ok`, and the
/// answer carries the re-read.
#[tokio::test]
async fn firewall_rule_change_starts_the_checked_helper() {
    fn launch(exe: &std::path::Path, args: &[&str]) -> Result<u32, elevated_launch::LaunchError> {
        assert_eq!(exe, std::path::Path::new(FW_HELPER));
        assert_eq!(args, ["firewall-remove"]);
        Ok(0)
    }
    let state = admin_app_state().await;
    let target = fw_current_target(&state).await;
    let result = fw_change(
        &state,
        admin_template_fw_elev::IDENTIFIER,
        firewall_change::FirewallChangeOperation::Remove,
        &target,
        fw_placement_ok,
        launch,
    )
    .await
    .expect("result");
    assert_eq!(result.outcome, firewall_change::FirewallChangeOutcome::Done);
    assert_eq!(result.exit_code, Some(0));
    assert!(!result.stale);
    assert_eq!(
        result.status.program,
        firewall_status::FirewallRuleCheck::Unknown {
            reason: firewall_status::UnknownReason::QueryFailed
        }
    );
    let rows = fw_audit_rows(&state).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].2, "ok");
    assert_eq!(
        rows[0].3,
        serde_json::json!({
            "operation": "remove",
            "outcome": "done",
            "stale": false,
            "exitCode": 0,
        })
    );
}

/// A declined UAC prompt (`ERROR_CANCELLED`) is `cancelled`, audited as
/// failed; a helper's conflict (exit 4) likewise.
#[tokio::test]
async fn firewall_rule_change_records_cancel_and_failures() {
    fn cancelled(_: &std::path::Path, _: &[&str]) -> Result<u32, elevated_launch::LaunchError> {
        Err(elevated_launch::LaunchError::ShellExecute(
            elevated_launch::ERROR_CANCELLED,
        ))
    }
    fn conflict(_: &std::path::Path, _: &[&str]) -> Result<u32, elevated_launch::LaunchError> {
        Ok(4)
    }
    let state = admin_app_state().await;
    let target = fw_current_target(&state).await;
    for (launch, outcome) in [
        (
            cancelled as FwLaunch,
            firewall_change::FirewallChangeOutcome::Cancelled,
        ),
        (
            conflict as FwLaunch,
            firewall_change::FirewallChangeOutcome::Conflict,
        ),
    ] {
        let result = fw_change(
            &state,
            admin_template_fw_elev::IDENTIFIER,
            firewall_change::FirewallChangeOperation::Allow,
            &target,
            fw_placement_ok,
            launch,
        )
        .await
        .expect("result");
        assert_eq!(result.outcome, outcome);
    }
    let mut rows: Vec<_> = fw_audit_rows(&state)
        .await
        .into_iter()
        .map(|(_, _, result, detail)| {
            (result, detail["outcome"].clone(), detail["osError"].clone())
        })
        .collect();
    rows.sort_by_key(|row| row.1.to_string());
    assert_eq!(
        rows,
        vec![
            ("failed".to_string(), "cancelled".into(), 1223.into()),
            (
                "failed".to_string(),
                "conflict".into(),
                serde_json::Value::Null
            ),
        ]
    );
}

static FW_STALE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static FW_STALE_RELEASE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Decision 13: no lock is held while the helper runs (an apply can
/// advance the generation meanwhile), and a generation that moved makes
/// the result `stale`.
#[tokio::test]
async fn firewall_rule_change_marks_a_result_stale_when_the_generation_moved() {
    use std::sync::atomic::Ordering;
    fn launch(_: &std::path::Path, _: &[&str]) -> Result<u32, elevated_launch::LaunchError> {
        FW_STALE_STARTED.store(true, Ordering::SeqCst);
        while !FW_STALE_RELEASE.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(0)
    }
    let state = admin_app_state().await;
    let target = fw_current_target(&state).await;
    let change = fw_change(
        &state,
        admin_template_fw_elev::IDENTIFIER,
        firewall_change::FirewallChangeOperation::Allow,
        &target,
        fw_placement_ok,
        launch,
    );
    let bump = async {
        while !FW_STALE_STARTED.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        // Would never get the lock if the change held it while waiting.
        state.server.lock().await.generation += 1;
        FW_STALE_RELEASE.store(true, Ordering::SeqCst);
    };
    let (result, ()) = tokio::join!(change, bump);
    let result = result.expect("result");
    assert_eq!(result.outcome, firewall_change::FirewallChangeOutcome::Done);
    assert!(result.stale);
    assert_eq!(result.status.generation, target.generation + 1);
    let rows = fw_audit_rows(&state).await;
    assert_eq!(rows[0].3["stale"], true);
}

static FW_BUSY_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static FW_BUSY_RELEASE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// An overlapping change in the same process starts nothing (no check, no
/// launch) and is not audited; once the first ends, the next goes through.
#[tokio::test]
async fn firewall_rule_change_answers_busy_while_another_change_runs() {
    use firewall_change::{FirewallChangeOperation::Allow, FirewallChangeOutcome};
    use std::sync::atomic::Ordering;
    fn launch(_: &std::path::Path, _: &[&str]) -> Result<u32, elevated_launch::LaunchError> {
        FW_BUSY_STARTED.store(true, Ordering::SeqCst);
        while !FW_BUSY_RELEASE.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(0)
    }
    let state = admin_app_state().await;
    let target = fw_current_target(&state).await;
    let id = admin_template_fw_elev::IDENTIFIER;
    let first = fw_change(&state, id, Allow, &target, fw_placement_ok, launch);
    let second = async {
        while !FW_BUSY_STARTED.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        let busy = fw_change(
            &state,
            id,
            Allow,
            &target,
            fw_placement_unreachable,
            fw_launch_unreachable,
        )
        .await;
        FW_BUSY_RELEASE.store(true, Ordering::SeqCst);
        busy
    };
    let (first, busy) = tokio::join!(first, second);
    assert_eq!(first.expect("first").outcome, FirewallChangeOutcome::Done);
    assert_eq!(busy.expect("busy").outcome, FirewallChangeOutcome::Busy);
    assert_eq!(fw_audit_rows(&state).await.len(), 1);

    let next = fw_change(&state, id, Allow, &target, fw_placement_ok, |_, _| Ok(0)).await;
    assert_eq!(next.expect("next").outcome, FirewallChangeOutcome::Done);
    assert_eq!(fw_audit_rows(&state).await.len(), 2);
}

/// Early returns (a refused check, a moved target) release the guard.
#[tokio::test]
async fn firewall_rule_change_releases_the_guard_on_early_returns() {
    use firewall_change::{FirewallChangeOperation::Allow, FirewallChangeOutcome};
    let state = admin_app_state().await;
    let target = fw_current_target(&state).await;
    let id = admin_template_fw_elev::IDENTIFIER;

    let refused = fw_change(
        &state,
        id,
        Allow,
        &target,
        fw_placement_reparse,
        fw_launch_unreachable,
    )
    .await;
    assert_eq!(
        refused.expect("refused").outcome,
        FirewallChangeOutcome::Precondition
    );

    let moved = firewall_change::FirewallChangeTarget {
        executable_path: target.executable_path.clone(),
        generation: target.generation + 1,
    };
    let changed = fw_change(
        &state,
        id,
        Allow,
        &moved,
        fw_placement_ok,
        fw_launch_unreachable,
    )
    .await;
    assert_eq!(
        changed.expect("changed").outcome,
        FirewallChangeOutcome::TargetChanged
    );

    let done = fw_change(&state, id, Allow, &target, fw_placement_ok, |_, _| Ok(0)).await;
    assert_eq!(done.expect("done").outcome, FirewallChangeOutcome::Done);
}

/// The status reports the listener that is serving (its `local_addr`),
/// apart from the saved settings: a saved value that disagrees with the
/// live listener does not leak into `live` / the URLs.
#[tokio::test]
async fn server_status_reports_the_live_listener_apart_from_the_saved_settings() {
    let state = admin_app_state().await;
    let port_a = free_port();
    let applied = apply(&state, true, port_a, false).await.expect("apply A");
    // Not reachable through IPC any more; stands for any disagreement
    // (e.g. a launch-time fallback whose save failed).
    let port_b = free_port();
    state
        .settings
        .set("server.port", &port_b.to_string())
        .await
        .unwrap();
    state.settings.set("server.bind", "0.0.0.0").await.unwrap();

    let status = server_status_body(&state).await.expect("status");

    assert!(status.running);
    assert_eq!((status.bind.as_str(), status.port), ("0.0.0.0", port_b));
    assert_eq!(
        status.live,
        Some(ServerListener {
            bind: "127.0.0.1".to_string(),
            port: port_a,
        })
    );
    assert_eq!(status.urls, vec![format!("http://127.0.0.1:{port_a}")]);
    assert_eq!(status.qr_svgs.len(), 1);
    assert_eq!(status.generation, applied.generation);

    stop_running_server(&state).await;
}

/// A status read that starts while an apply is in progress waits for the
/// whole apply (the apply holds `state.server` through its save) and then
/// reports the new settings with the new listener - never the old saved
/// values with the new listener or the other way round.
#[tokio::test]
async fn server_status_during_an_apply_sees_the_whole_apply() {
    let state = admin_app_state().await;
    let port_a = free_port();
    let first = apply(&state, true, port_a, false).await.expect("apply A");
    let port_b = free_port();
    let guard = state.auth_config_lock.lock().await;

    // B also turns 閲覧公開 on: a status that read the saved settings
    // before the apply's save would report it off with B's listener.
    let applying = apply(&state, true, port_b, true);
    tokio::pin!(applying);
    // B is bound (A already stopped): the apply waits at its save.
    drive_until!(applying, !port_is_free(port_b));
    let reading = server_status_body(&state);
    tokio::pin!(reading);
    assert_stays_pending!(reading);
    let saved = state.settings.server_config().await.unwrap();
    assert_eq!((saved.port, saved.viewer_public), (port_a, false));

    drop(guard);
    let (applied, read) = tokio::join!(applying, reading);
    let applied = applied.expect("apply B");
    let read = read.expect("status");

    assert_eq!((read.port, read.viewer_public), (port_b, true));
    assert_eq!(read.live.as_ref().map(|live| live.port), Some(port_b));
    assert_eq!(read.urls, vec![format!("http://127.0.0.1:{port_b}")]);
    assert_eq!(read.generation, first.generation + 1);
    assert_eq!(read.generation, applied.generation);

    stop_running_server(&state).await;
}

/// A port conflict on apply: the previous listener is back on its port,
/// and the status says so (`portInUse` / `restored`) until the next
/// successful apply clears it.
#[tokio::test]
async fn server_status_reports_a_port_conflict_and_the_restored_listener() {
    let state = admin_app_state().await;
    let port_a = free_port();
    apply(&state, true, port_a, false).await.expect("apply A");
    let port_b = free_port();
    let occupied = std::net::TcpListener::bind(("127.0.0.1", port_b)).expect("occupy");

    assert!(apply(&state, true, port_b, false).await.is_err());
    let status = server_status_body(&state).await.expect("status");

    assert!(status.running);
    assert_eq!(status.port, port_a, "nothing was saved");
    assert_eq!(status.live.as_ref().map(|live| live.port), Some(port_a));
    assert!(answers_http(port_a).await);
    assert_eq!(
        status.apply_failure,
        Some(ServerApplyFailure {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port: port_b,
            reason: ServerApplyFailureReason::PortInUse,
            previous: PreviousServerOutcome::Restored,
        })
    );
    assert_eq!(status.generation, 2);

    drop(occupied);
    let status = apply(&state, true, free_port(), false)
        .await
        .expect("apply C");
    assert_eq!(status.apply_failure, None);
    assert_eq!(status.generation, 3);

    stop_running_server(&state).await;
}

/// The apply fails after the old listener was stopped, and the old port
/// was taken in the meantime: nothing serves, the saved settings still
/// say enabled on the old port, and the status reports
/// `saveFailed` / `restoreFailed` (no URL to show).
#[tokio::test]
async fn server_status_reports_a_failed_restore() {
    let state = admin_app_state().await;
    let port_a = free_port();
    // 閲覧公開 ON makes disabling auth below legal while LAN is enabled.
    apply(&state, true, port_a, true).await.expect("apply A");
    let port_b = free_port();
    let guard = state.auth_config_lock.lock().await;

    let applying = apply(&state, true, port_b, false);
    tokio::pin!(applying);
    drive_until!(applying, !port_is_free(port_b));
    // A was stopped before B was bound; take it so the restore fails.
    let occupied = std::net::TcpListener::bind(("127.0.0.1", port_a)).expect("occupy A");
    // The final re-validation refuses LAN without 閲覧公開 once auth is
    // disabled, so the save fails.
    let mut auth = state.settings.auth_config().await.unwrap();
    auth.disabled = true;
    state.settings.set_auth_config(&auth).await.expect("auth");
    drop(guard);

    assert!(applying.await.is_err());
    let status = server_status_body(&state).await.expect("status");

    assert!(!status.running);
    assert_eq!(status.live, None);
    assert!(status.urls.is_empty());
    assert!(status.enabled);
    assert_eq!(status.port, port_a);
    assert_eq!(
        status
            .apply_failure
            .as_ref()
            .map(|f| (f.reason, f.previous)),
        Some((
            ServerApplyFailureReason::SaveFailed,
            PreviousServerOutcome::RestoreFailed
        ))
    );
    let entries = settings_change_entries(&state).await;
    let failed: Vec<_> = entries.iter().filter(|(r, _)| r == "failed").collect();
    assert_eq!(failed.len(), 1, "{entries:?}");
    assert_eq!(failed[0].1["restoredPrevious"], false);
    assert!(port_is_free(port_b), "the new listener was released");

    drop(occupied);
}

/// The new status fields reach the frontend as camelCase codes and values
/// only (conventions §13), matching `serverAdmin.ts::ServerStatus`.
#[test]
fn server_status_serializes_live_generation_and_apply_failure() {
    let slot = ServerSlot {
        live: None,
        generation: 3,
        port_notice: None,
        apply_failure: Some(ServerApplyFailure {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port: 8722,
            reason: ServerApplyFailureReason::PortInUse,
            previous: PreviousServerOutcome::RestoreFailed,
        }),
        leftover_writes: LeftoverWrites::default(),
        write_budget: WriteBudget::default(),
    };
    let value = serde_json::to_value(build_status(&ServerSettings::default(), &slot)).unwrap();
    assert_eq!(value["live"], serde_json::Value::Null);
    assert_eq!(value["running"], false);
    assert_eq!(value["urls"], serde_json::json!([]));
    assert_eq!(value["generation"], 3);
    // Issue #558: nothing serving, nothing connected.
    assert_eq!(value["sseConnections"], 0);
    assert_eq!(
        value["applyFailure"],
        serde_json::json!({
            "enabled": true,
            "bind": "127.0.0.1",
            "port": 8722,
            "reason": "portInUse",
            "previous": "restoreFailed",
        })
    );
    assert_eq!(
        serde_json::to_value(ServerListener {
            bind: "0.0.0.0".to_string(),
            port: 8721,
        })
        .unwrap(),
        serde_json::json!({ "bind": "0.0.0.0", "port": 8721 })
    );
    for (outcome, code) in [
        (PreviousServerOutcome::None, "none"),
        (PreviousServerOutcome::Restored, "restored"),
    ] {
        assert_eq!(serde_json::to_value(outcome).unwrap(), code);
    }
    for (reason, code) in [
        (ServerApplyFailureReason::BindFailed, "bindFailed"),
        (ServerApplyFailureReason::SaveFailed, "saveFailed"),
    ] {
        assert_eq!(serde_json::to_value(reason).unwrap(), code);
    }
}

// --- Issue #697: per-user permissions on the Tauri path -----------------

fn perm(raw: &str) -> PermissionKey {
    PermissionKey::parse(raw).unwrap()
}

/// [`admin_app_state`] whose `UsersService` registers two test
/// permissions (the template's catalog is empty), plus a viewer `op`.
async fn permission_app_state() -> (AppState, UserIdentity) {
    let mut state = admin_app_state().await;
    state.users = state.users.clone().with_permission_catalog(
        admin_template_core::users::PermissionCatalog::empty()
            .register("equipment.operate", "perm.operate", "perm.operate_desc")
            .unwrap()
            .register("alarm.ack", "perm.ack", "perm.ack_desc")
            .unwrap(),
    );
    let op = state
        .users
        .create_user("op", REVOCATION_PASSWORD, "Op", Role::Viewer)
        .await
        .unwrap();
    (state, op)
}

/// The Tauri twin of the REST test: `users_update` with `permissions`
/// grants and revokes in the same write (one version bump, one `update`
/// audit row with the `permissions` entry), rejects malformed /
/// unregistered keys as `validation` with nothing written, and the
/// target's NEXT command sees the change through [`require_permission`]
/// without a new login (read from the store per command). A refusal is
/// `Forbidden` + `denied` (detail `None`), whatever the role.
#[tokio::test]
async fn users_update_permissions_and_require_permission_on_the_tauri_path() {
    let (state, op) = permission_app_state().await;
    let operate = perm("equipment.operate");

    // The admin itself does not hold it.
    assert!(matches!(
        require_permission(&state, &operate, "equipment").await,
        Err(BantoError::Forbidden)
    ));

    let updated = users_update_body(
        &state,
        op.id,
        "Op",
        Role::Viewer,
        Some(1),
        Some(&["equipment.operate".to_string()]),
    )
    .await
    .unwrap();
    let wire = serde_json::to_value(&updated).unwrap();
    assert_eq!(wire["version"], 2);
    assert_eq!(
        wire["permissions"],
        serde_json::json!(["equipment.operate"])
    );
    assert_eq!(wire["username"], "op");

    for bad in ["Not A Key", "other.thing"] {
        let err = users_update_body(
            &state,
            op.id,
            "Renamed",
            Role::Viewer,
            Some(2),
            Some(&[bad.to_string()]),
        )
        .await
        .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "permissions")
            }
            other => panic!("{bad}: expected Validation, got {other:?}"),
        }
    }

    // The list carries the permissions next to each row, like REST.
    let list = serde_json::to_value(users_list_body(&state).await.unwrap()).unwrap();
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["username"] == "op")
        .unwrap()
        .clone();
    assert_eq!(row["permissions"], serde_json::json!(["equipment.operate"]));

    // The viewer's own session: allowed now, and the identity shows it.
    desktop_login(&state, "op").await;
    let me = require_permission(&state, &operate, "equipment")
        .await
        .unwrap();
    assert_eq!(me.username, "op");
    let identity = auth_identity_body(&state).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&identity).unwrap()["permissions"],
        serde_json::json!(["equipment.operate"])
    );
    let (_, held) = session_permissions(&state).await.unwrap().unwrap();
    assert!(held.has(&operate));
    // Unregistered key: never held.
    assert!(matches!(
        require_permission(&state, &perm("not.registered"), "equipment").await,
        Err(BantoError::Forbidden)
    ));

    // Revoked by the admin while the viewer's session lives on: the next
    // command is refused, the session itself stays.
    state
        .users
        .set_permissions(op.id, &[], None, "admin")
        .await
        .unwrap();
    assert!(matches!(
        require_permission(&state, &operate, "equipment").await,
        Err(BantoError::Forbidden)
    ));
    assert!(current_session(&state).await.unwrap().is_some());

    // No session: Unauthorized, not audited.
    state.set_session_for_test(None);
    assert!(matches!(
        require_permission(&state, &operate, "equipment").await,
        Err(BantoError::Unauthorized)
    ));

    let rows = state.audit.list(ListParams::default()).await.unwrap().rows;
    let denied: Vec<_> = rows
        .iter()
        .filter(|r| r.action == "denied" && r.resource == "equipment")
        .map(|r| {
            (
                r.actor_username.clone().unwrap(),
                r.origin.clone(),
                r.detail.clone(),
            )
        })
        .collect();
    assert_eq!(denied.len(), 3, "{denied:?}");
    assert!(denied
        .iter()
        .all(|(_, origin, detail)| origin == "tauri" && detail.is_none()));
    let updates: Vec<serde_json::Value> = rows
        .iter()
        .filter(|r| r.action == "update" && r.resource == "users")
        .map(|r| serde_json::from_str(r.detail.as_deref().unwrap()).unwrap())
        .collect();
    assert_eq!(updates.len(), 1, "the rejected updates left no row");
    assert!(updates[0]["changes"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!({
            "field": "permissions", "added": ["equipment.operate"], "removed": []
        })));
}

/// `permissions_catalog` is admin-only, like REST's `GET /api/permissions`;
/// the template's own catalog is empty.
#[tokio::test]
async fn permissions_catalog_is_admin_only() {
    assert!(admin_template_core::permission_catalog().is_empty());
    let (state, _op) = permission_app_state().await;
    let entries = permissions_catalog_body(&state).await.unwrap();
    assert_eq!(
        entries.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
        ["equipment.operate", "alarm.ack"]
    );
    desktop_login(&state, "op").await;
    assert!(matches!(
        permissions_catalog_body(&state).await,
        Err(BantoError::Forbidden)
    ));
}

/// Auth-disabled mode (owner decision §8-4): no permission by default;
/// `auth.disabled_permissions` gives the synthetic session the registered
/// ones, read per command.
#[tokio::test]
async fn the_auth_disabled_session_holds_only_the_configured_permissions() {
    let (state, _op) = permission_app_state().await;
    state
        .settings
        .set_auth_config(&AuthSettings {
            disabled: true,
            disabled_role: Role::Viewer,
            ..AuthSettings::default()
        })
        .await
        .unwrap();
    state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(local_identity(
        Role::Viewer,
    ))));
    let ack = perm("alarm.ack");
    assert!(matches!(
        require_permission(&state, &ack, "alarm").await,
        Err(BantoError::Forbidden)
    ));
    state
        .settings
        .set_auth_disabled_permissions(&["alarm.ack".to_string()], state.users.permission_catalog())
        .await
        .unwrap();
    let me = require_permission(&state, &ack, "alarm").await.unwrap();
    assert_eq!(me.id, LOCAL_SESSION_ID);
    let identity = auth_identity_body(&state).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&identity).unwrap()["permissions"],
        serde_json::json!(["alarm.ack"])
    );
}

/// Settings-change audit details of `state`, oldest first.
async fn settings_change_details(state: &AppState) -> Vec<serde_json::Value> {
    let rows = state.audit.list(ListParams::default()).await.unwrap().rows;
    rows.iter()
        .filter(|r| r.action == "settings_change" && r.resource == "settings")
        .map(|r| serde_json::from_str(r.detail.as_deref().unwrap()).unwrap())
        .collect()
}

/// Issue #697 PR-2b: `auth_config_apply` carries the auth-disabled mode's
/// permissions. They are saved with the role (one decision under
/// `auth_config_lock`), the answer carries them (`disabledPermissions`),
/// the synthetic session holds them on its next command, the audit
/// detail gets the `{ added, removed }` diff, and the slot's `seq`
/// advances (the webview re-reads the session's `permissions`).
#[tokio::test]
async fn auth_config_apply_saves_the_modes_permissions_with_a_diff_audit() {
    let (state, _op) = permission_app_state().await;
    let ack = perm("alarm.ack");

    let view = auth_config_apply_with_permissions_body(
        &state,
        true,
        "viewer",
        Some(&["alarm.ack".to_string()]),
    )
    .await
    .unwrap();
    let wire = serde_json::to_value(&view).unwrap();
    assert_eq!(wire["disabled"], true);
    assert_eq!(wire["disabledRole"], "viewer");
    assert_eq!(
        wire["disabledPermissions"],
        serde_json::json!(["alarm.ack"])
    );
    // The synthetic session (now installed) holds it.
    assert!(require_permission(&state, &ack, "alarm").await.is_ok());
    let seq_after_grant = read_slot(&state).1;

    // Omitted = unchanged (a client that does not know the field), and
    // the unchanged permissions do not advance `seq` on their own.
    let view = auth_config_apply_with_permissions_body(&state, true, "viewer", None)
        .await
        .unwrap();
    assert_eq!(view.disabled_permissions, ["alarm.ack"]);
    assert_eq!(read_slot(&state).1, seq_after_grant);
    // The same set again: no diff, no `seq` change.
    auth_config_apply_with_permissions_body(
        &state,
        true,
        "viewer",
        Some(&["alarm.ack".to_string()]),
    )
    .await
    .unwrap();
    assert_eq!(read_slot(&state).1, seq_after_grant);

    // Swap one for another: the mode and role stay, `seq` advances.
    auth_config_apply_with_permissions_body(
        &state,
        true,
        "viewer",
        Some(&["equipment.operate".to_string()]),
    )
    .await
    .unwrap();
    assert!(read_slot(&state).1 > seq_after_grant);
    assert!(matches!(
        require_permission(&state, &ack, "alarm").await,
        Err(BantoError::Forbidden)
    ));
    // Clearing is `Some([])`.
    let view = auth_config_apply_with_permissions_body(&state, true, "viewer", Some(&[]))
        .await
        .unwrap();
    assert!(view.disabled_permissions.is_empty());

    let details = settings_change_details(&state).await;
    assert_eq!(details.len(), 5, "{details:?}");
    assert_eq!(
        details[0],
        serde_json::json!({
            "authDisabled": true,
            "authDisabledPermissions": { "added": ["alarm.ack"], "removed": [] }
        })
    );
    // No change, no `authDisabledPermissions`.
    assert_eq!(details[1], serde_json::json!({ "authDisabled": true }));
    assert_eq!(details[2], serde_json::json!({ "authDisabled": true }));
    assert_eq!(
        details[3]["authDisabledPermissions"],
        serde_json::json!({ "added": ["equipment.operate"], "removed": ["alarm.ack"] })
    );
    assert_eq!(
        details[4]["authDisabledPermissions"],
        serde_json::json!({ "added": [], "removed": ["equipment.operate"] })
    );
}

/// PR #703 cross-review P1: mode, role and permissions are ONE save, and
/// the session is re-bound right after it with no `.await` in between.
/// While the apply is held right after that save: the store already has
/// the mode AND the permissions together (never one without the other),
/// the slot is still the old one (the rebind has not happened), and a
/// concurrent resolve settles against the stored state; once released the
/// session holds the permission and `seq` has advanced.
#[tokio::test]
async fn apply_with_permissions_is_one_save_then_rebinds_without_a_gap() {
    let (mut state, _op) = permission_app_state().await;
    let ack = perm("alarm.ack");
    let mut hold = hold_after_save(&mut state);
    let seq_before = read_slot(&state).1;

    let wanted = ["alarm.ack".to_string()];
    let apply = auth_config_apply_with_permissions_body(&state, true, "viewer", Some(&wanted));
    tokio::pin!(apply);
    run_until_held!(apply, hold);

    // One transaction: both are stored, or (before the save) neither.
    assert!(state.settings.auth_config().await.unwrap().disabled);
    assert_eq!(
        state
            .settings
            .auth_disabled_permissions()
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(read_slot(&state).1, seq_before, "not re-bound yet");

    hold.release.send(()).unwrap();
    let view = apply.await.expect("apply");
    assert_eq!(view.disabled_permissions, ["alarm.ack"]);
    assert!(read_slot(&state).1 > seq_before);
    assert!(is_local(&read_slot(&state).0));
    assert!(require_permission(&state, &ack, "alarm").await.is_ok());
}

/// PR #703 review (P2): the mode and the permissions are saved together,
/// so a failed save leaves the stored permissions as they were (the
/// injected save is the production one, made to fail).
#[tokio::test]
async fn failed_save_leaves_the_modes_permissions_unchanged() {
    let (mut state, _op) = permission_app_state().await;
    auth_config_apply_with_permissions_body(
        &state,
        true,
        "viewer",
        Some(&["alarm.ack".to_string()]),
    )
    .await
    .unwrap();
    state.auth_io.save_auth_config = Arc::new(|_config, _permissions| {
        Box::pin(async { Err(BantoError::Storage("disk full (test)".to_string())) })
    });
    let err = auth_config_apply_with_permissions_body(
        &state,
        true,
        "viewer",
        Some(&["equipment.operate".to_string()]),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, BantoError::Storage(_)), "{err:?}");
    let stored = state.settings.auth_disabled_permissions().await.unwrap();
    assert_eq!(
        stored.iter().map(ToString::to_string).collect::<Vec<_>>(),
        ["alarm.ack"]
    );
}

/// An unregistered or malformed key is `validation` on `permissions`
/// with nothing written (mode, role, permissions, audit); a non-admin
/// account session is `Forbidden` before the catalog is consulted; the
/// template's empty catalog refuses any key but accepts `[]`.
#[tokio::test]
async fn auth_config_apply_refuses_unregistered_permissions_and_non_admins() {
    let (state, _op) = permission_app_state().await;
    for bad in ["nope.unknown", "Not A Key", ""] {
        let err = auth_config_apply_with_permissions_body(
            &state,
            true,
            "viewer",
            Some(&["alarm.ack".to_string(), bad.to_string()]),
        )
        .await
        .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "permissions", "{bad}")
            }
            other => panic!("expected validation for {bad:?}, got {other:?}"),
        }
    }
    assert!(!state.settings.auth_config().await.unwrap().disabled);
    assert!(state
        .settings
        .auth_disabled_permissions()
        .await
        .unwrap()
        .is_empty());
    assert!(settings_change_details(&state).await.is_empty());

    // A viewer account (mode off) cannot, whatever it asks for.
    desktop_login(&state, "op").await;
    assert!(matches!(
        auth_config_apply_with_permissions_body(
            &state,
            false,
            "admin",
            Some(&["alarm.ack".to_string()])
        )
        .await,
        Err(BantoError::Forbidden)
    ));

    // The template: empty catalog.
    let state = admin_app_state().await;
    assert!(auth_config_apply_with_permissions_body(
        &state,
        true,
        "viewer",
        Some(&["alarm.ack".to_string()])
    )
    .await
    .is_err());
    let view = auth_config_apply_with_permissions_body(&state, true, "viewer", Some(&[]))
        .await
        .unwrap();
    assert!(view.disabled_permissions.is_empty());
}

/// The saved list is read back by `auth_config_get`'s view without the
/// keys the app no longer registers (they are not held, plan §4).
#[tokio::test]
async fn auth_disabled_permissions_view_hides_unregistered_leftovers() {
    let (state, _op) = permission_app_state().await;
    state
        .settings
        .set("auth.disabled_permissions", "alarm.ack,old.gone")
        .await
        .unwrap();
    assert_eq!(
        auth_disabled_permissions_view(&state).await.unwrap(),
        ["alarm.ack"]
    );
    let wire = serde_json::to_value(AuthSettingsView {
        settings: AuthSettings::default(),
        disabled_permissions: vec!["alarm.ack".to_string()],
    })
    .unwrap();
    assert_eq!(wire["disabled"], false);
    assert_eq!(wire["disabledRole"], "admin");
    assert_eq!(
        wire["disabledPermissions"],
        serde_json::json!(["alarm.ack"])
    );
}

// `pnpm banto add resource` writes each new resource's command tests
// above this line (denied + audited, the Tauri half of conventions
// section 1).
// [banto:add-resource:tauri-tests]
