use super::*;

/// Per-row byte budget backing the import route's `DefaultBodyLimit` (set on
/// `/api/items/import` alone in `items_write_router`) (spec M15 / M-review 2026-08 M-14). Same two-tier
/// reasoning as `ATTACHMENT_BODY_LIMIT_SLACK_BYTES`: the limit that actually
/// matters is the service-layer row-count check in `ItemsService::import`
/// (`crate::items::MAX_IMPORT_ROWS`, which returns a `422` `Validation`
/// error), NOT this transport cap. This only needs to sit comfortably above
/// the largest spec-valid `MAX_IMPORT_ROWS`-row JSON payload so a request AT
/// the row-count limit reaches the service layer (a `200`/`422`) instead of
/// being rejected by axum's 2MB transport default (a `413`) first. A single
/// spec-valid row is at most ~230 wire bytes (a 40-char name, three small
/// integers, a `null` id); 1KiB/row is a comfortable round budget over that.
const IMPORT_BODY_LIMIT_BYTES_PER_ROW: usize = 1024;

async fn items_list(
    State(items): State<ItemsService>,
    Json(params): Json<ListParams>,
) -> Result<Json<ListResult<Item>>, ApiError> {
    Ok(Json(items.list(params).await?))
}

async fn items_get(
    State(items): State<ItemsService>,
    Path(id): Path<i64>,
) -> Result<Json<Item>, ApiError> {
    Ok(Json(items.get(id).await?))
}

/// State for the `items` WRITE handlers (spec M14): `ItemsService` for the
/// mutation itself, plus `AuditLogService`/`AuthState` so each handler can
/// record a `create`/`update`/`delete` entry once the mutation has already
/// succeeded (read handlers - `items_list`/`items_get` above - stay on the
/// plain `State<ItemsService>` they always had; spec M14: "読み取り系は記録
/// しない"). `attachments` is M20 unit C's demo wiring (spec
/// `docs/design/attachments-plan.md` §3.8): `items_delete` uses it to clean up any
/// attachments left pointing at the now-gone record.
#[derive(Clone)]
struct ItemsWriteState {
    items: ItemsService,
    audit: AuditLogService,
    auth: AuthState,
    attachments: AttachmentsService,
}

async fn items_create(
    State(state): State<ItemsWriteState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    let item = state.items.create(input).await?;
    record_write(
        &state.audit,
        &actor,
        "create",
        "items",
        Some(&item.id.to_string()),
        Some(crate::items::item_create_detail(&item)),
    )
    .await;
    Ok(Json(item))
}

async fn items_update(
    State(state): State<ItemsWriteState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Path(id): Path<i64>,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    let (previous, item) = state.items.update_returning_previous(id, input).await?;
    record_write(
        &state.audit,
        &actor,
        "update",
        "items",
        Some(&item.id.to_string()),
        Some(crate::items::item_update_detail(&previous, &item)),
    )
    .await;
    Ok(Json(item))
}

/// `DELETE /api/items/{id}?version=N` (Issue #638): the optional `version`
/// is the optimistic-lock check (a different stored version is a `409`
/// `conflict`, nothing deleted); without it the delete overwrites as before.
/// A query string, not a body, since this route had no body and some
/// clients/proxies drop a DELETE body. The Tauri `items_delete` command takes
/// the same `version` argument.
///
/// Paths are spelled out (`serde::Deserialize`, `axum::extract::Query`,
/// `banto_core::BantoError`): `pnpm scaffold` drops those imports from
/// `rest/mod.rs` when it removes attachments, and this file must still build.
#[derive(Debug, Default, serde::Deserialize)]
struct ItemsDeleteQuery {
    version: Option<i64>,
}

async fn items_delete(
    State(state): State<ItemsWriteState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Path(id): Path<i64>,
    query: Result<axum::extract::Query<ItemsDeleteQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<StatusCode, ApiError> {
    // A malformed `version` (`?version=abc`) answers the usual `ErrorBody`
    // (`bad_request`), not axum's plain-text rejection.
    let axum::extract::Query(query) =
        query.map_err(|err| banto_core::BantoError::BadRequest(err.body_text()))?;
    let item = state
        .items
        .delete_returning_previous(id, query.version)
        .await?;
    // M20 unit C demo wiring (attachments-plan §3.8): sweep up any attachments left
    // pointing at the now-deleted record (best-effort).
    let sweep = crate::attachment_wiring::sweep_item_attachments(&state.attachments, id).await;
    record_write(
        &state.audit,
        &actor,
        "delete",
        "items",
        Some(&id.to_string()),
        Some(crate::items::item_delete_detail(&item, sweep)),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/items/bulk-delete` (Issue #713): delete many items in one
/// all-or-nothing transaction, `editor`+ (same `ItemsWriteState`/`RoleGuard`
/// as the other write routes). The body is a
/// [`crate::items::BulkDeleteTarget`] (`{ kind: "ids", items }`, each item an
/// `{ id, version? }`), the answer `{ deleted }`. A stale version or a missing
/// id is a `409` `conflict` with nothing deleted and - like a single delete's conflict -
/// nothing audited. A success writes ONE `action: "bulk_delete"` entry
/// (no `entity_id`; detail: [`crate::items::item_bulk_delete_detail`]), not
/// one per row. The Tauri `items_bulk_delete` command takes the same target.
async fn items_bulk_delete(
    State(state): State<ItemsWriteState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Json(target): Json<crate::items::BulkDeleteTarget>,
) -> Result<Json<crate::items::BulkDeleteResult>, ApiError> {
    let deleted = state.items.bulk_delete(&target).await?;
    // Bulk twin of the items_delete sweep (attachments-plan §3.8): remove the
    // attachments left pointing at the now-deleted records (best-effort).
    let sweep =
        crate::attachment_wiring::sweep_items_attachments(&state.attachments, &deleted).await;
    let detail = crate::items::item_bulk_delete_detail(&target, &deleted, sweep);
    record_write(
        &state.audit,
        &actor,
        "bulk_delete",
        "items",
        None,
        Some(detail),
    )
    .await;
    Ok(Json(crate::items::BulkDeleteResult {
        deleted: deleted.len(),
    }))
}

/// `POST /api/items/import` (spec M15): bulk create/update, `editor`+
/// (same `ItemsWriteState`/`RoleGuard` as `items_create`/`update`/`delete`
/// above). Unlike those, a single `action: "import"` audit entry is written
/// through `record_as` (not [`record_write`], which always writes
/// `result: "ok"` against a single concrete `entity_id`) - see this module's
/// doc comment ("Audit log" section) for why the result/detail depend on
/// whether [`ItemsService::import`] rolled the batch back.
///
/// Issue #793 S2: this route accepts a body over 2 MiB (its own
/// `DefaultBodyLimit` in `items_write_router`), and such a body is streamed
/// to this handler after the guards have passed, for as long as the client
/// takes. So the role floor is decided again once the rows are in
/// (`banto_server::routes::recheck_role_at_least`, for every body size), the
/// import runs only when it passes, and the audit row is attributed to the
/// session that check returned - not looked up again after the write.
async fn items_import(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Json(rows): Json<Vec<ItemImportRow>>,
) -> Result<Json<ImportResult>, ApiError> {
    let session = banto_server::routes::recheck_role_at_least(
        &state.auth,
        &state.audit,
        &headers,
        Role::Editor,
        "items",
        json!({ "method": "POST", "path": "/api/items/import" }),
    )
    .await?;
    // ADR-0034 section 3: the actor of the session re-validated just above.
    let actor = state.auth.audit_actor(&session);
    let result = state.items.import(rows).await?;
    let (result_tag, detail) = if result.errors.is_empty() {
        (
            "ok",
            json!({ "created": result.created, "updated": result.updated }),
        )
    } else {
        ("failed", json!({ "errorCount": result.errors.len() }))
    };
    banto_server::routes::record_as(
        &state.audit,
        Some(&actor),
        "rest",
        "import",
        "items",
        None,
        Some(detail),
        result_tag,
    )
    .await;
    Ok(Json(result))
}

/// Read-only `items` routes (spec M10: `viewer` and up - i.e. any
/// authenticated role, `require_auth` alone is sufficient).
fn items_read_router(items: ItemsService, auth: AuthState) -> Router {
    Router::new()
        .route("/api/items/list", post(items_list))
        .route("/api/items/{id}", get(items_get))
        .with_state(items)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Mutating `items` routes (spec M10: `editor` and up). Layered
/// `require_role_at_least` first, `require_auth` second, so middleware
/// executes `require_auth` THEN `require_role_at_least` (axum layers run
/// outside-in from the last one added) - a request must have a valid
/// session before its role is even considered.
///
/// `DefaultBodyLimit::max` raises the body cap of `/api/items/import` ALONE
/// past axum's 2MB default to `MAX_IMPORT_ROWS * IMPORT_BODY_LIMIT_BYTES_PER_ROW`
/// (spec M-review 2026-08 M-14), so a spec-valid import payload AT the
/// row-count limit reaches the service layer (a `422` row-count error)
/// instead of being rejected by the transport cap (a `413`) first - same
/// two-tier reasoning as `attachments_write_router`/`backups_router`.
///
/// The raised cap is on that one route on purpose (Issue #793 S2,
/// conventions section 1): a body over 2 MiB is streamed to its handler
/// AFTER the guards have passed, so a route that accepts one must decide the
/// role again once the body is in (`items_import` does). The other routes
/// here keep the 2 MiB default, so the layer that detaches writes receives
/// their whole body BEFORE the guards run and they need no second check. Do
/// not raise the cap of another route without adding that check to it.
fn items_write_router(
    items: ItemsService,
    audit: AuditLogService,
    auth: AuthState,
    attachments: AttachmentsService,
) -> Router {
    let state = ItemsWriteState {
        items,
        audit: audit.clone(),
        auth: auth.clone(),
        attachments,
    };
    Router::new()
        .route("/api/items", post(items_create))
        .route(
            "/api/items/{id}",
            axum::routing::put(items_update).delete(items_delete),
        )
        .route(
            "/api/items/import",
            post(items_import).layer(axum::extract::DefaultBodyLimit::max(
                crate::items::MAX_IMPORT_ROWS * IMPORT_BODY_LIMIT_BYTES_PER_ROW,
            )),
        )
        .route("/api/items/bulk-delete", post(items_bulk_delete))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Editor,
                resource: "items",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// `/api/items/*` (spec M10): merges the read (any role) and write
/// (`editor`+) sub-routers, which share the same `/api/items/{id}` path
/// split across HTTP methods.
pub(super) fn items_router(
    items: ItemsService,
    audit: AuditLogService,
    auth: AuthState,
    attachments: AttachmentsService,
) -> Router {
    items_read_router(items.clone(), auth.clone()).merge(items_write_router(
        items,
        audit,
        auth,
        attachments,
    ))
}
