//! REST surface for the embedded server (spec §11.1): exposes the same
//! `ItemsService` used by `src-tauri`'s `items_*` commands over HTTP, so a
//! LAN browser's `HttpDataProvider` (Phase B,
//! `packages/admin-core/src/providers/tauri.ts` is the wire contract it
//! must match) hits the exact same service layer and DB.
//!
//! ## Route table
//!
//! | Method | Path               | Body           | Response              |
//! |--------|--------------------|----------------|------------------------|
//! | GET    | `/api/auth/status`   | -              | `{initialized}` (NO auth required) |
//! | POST   | `/api/auth/setup`     | `{username,password,displayName}` | `{success,error?,token?}` (needs `allow_setup`) |
//! | POST   | `/api/auth/login`    | `{username,password}` | `{success,error?,token?}` |
//! | POST   | `/api/auth/logout`   | -              | 200                    |
//! | GET    | `/api/auth/check`    | -              | `bool`                 |
//! | GET    | `/api/auth/identity` | -              | `Identity \| null`     |
//! | POST   | `/api/auth/change-password` | `{currentPassword,newPassword}` | `{success}` (auth required) |
//! | GET    | `/api/events`        | -              | SSE stream of `ServerEvent` |
//! | POST   | `/api/items/list`    | `ListParams`   | `ListResult<Item>` (any role) |
//! | GET    | `/api/items/{id}`    | -              | `Item` (any role)      |
//! | POST   | `/api/items`         | `ItemInput`    | `Item` (editor+)        |
//! | PUT    | `/api/items/{id}`    | `ItemInput`    | `Item` (editor+)        |
//! | DELETE | `/api/items/{id}`    | -              | 204 (editor+)           |
//! | POST   | `/api/items/import`  | `ItemImportRow[]` | `ImportResult` (editor+, spec M15) |
//! | GET    | `/api/users`         | -              | `UserSummary[]` (admin) |
//! | POST   | `/api/users`         | `{username,password,displayName,role}` | `UserIdentityResponse` (admin) |
//! | PUT    | `/api/users/{id}`    | `{displayName,role}` | `UserSummary` (admin) |
//! | POST   | `/api/users/{id}/reset-password` | `{newPassword}` | `{success}` (admin) |
//! | DELETE | `/api/users/{id}`    | -              | 204 (admin)             |
//! | GET    | `/api/ui-settings/{key}` | -          | `{value: string \| null}` (any role) |
//! | PUT    | `/api/ui-settings/{key}` | `{value}`  | 204 (any role)          |
//! | POST   | `/api/audit-log/list` | `ListParams`   | `ListResult<AuditLogEntry>` (admin) |
//! | GET    | `/api/audit-log/config` | -            | `AuditSettings` (admin) |
//! | PUT    | `/api/audit-log/config` | `AuditSettings` | `AuditSettings` (admin) |
//! | POST   | `/api/backups`        | -              | `BackupInfo` (admin, spec M17) |
//! | GET    | `/api/backups`        | -              | `BackupInfo[]` (admin)  |
//! | GET    | `/api/backups/{fileName}` | -          | raw bytes, `Content-Disposition: attachment` (admin) |
//! | POST   | `/api/backups/restore?fileName=` | raw bytes (`application/octet-stream`) | 204 (admin) |
//! | POST   | `/api/backups/{fileName}/restore` | -   | 204 (admin)             |
//! | GET    | `/api/backups/pending-restore` | -      | `PendingRestoreInfo \| null` (admin) |
//! | DELETE | `/api/backups/pending-restore` | -      | 204 (admin)             |
//! | POST   | `/api/attachments/list` | `{resource,resourceId}` | `AttachmentMeta[]` (any role, spec M20) |
//! | GET    | `/api/attachments/{id}/download` | -    | raw bytes, `Content-Disposition: attachment` (any role) |
//! | GET    | `/api/attachments/{id}/thumbnail` | -   | `image/jpeg`, 404 if none (any role) |
//! | POST   | `/api/attachments?resource=&resourceId=&fileName=` | raw bytes (`application/octet-stream`) | `AttachmentMeta` (editor+) |
//! | DELETE | `/api/attachments/{id}` | -              | 204 (editor+)           |
//!
//! `/api/ui-settings/*` (spec M12 SettingsProvider migration): per-user UI
//! settings (theme/preset/dock layout), namespaced by the caller's own
//! `username` (`SettingsService::ui_get`/`ui_set` - see that module for the
//! `ui.{username}.{key}` storage key scheme). Guarded by `require_auth`
//! alone - unlike `items`/`users`, there is no role floor: a `viewer` may
//! freely read/write their OWN UI preferences, they just cannot touch
//! anyone else's (there is no way to name another user's key over this
//! wire - `username` always comes from the caller's own bearer token, never
//! a request parameter).
//!
//! `/api/auth/status` and `/api/auth/setup` are deliberately NOT behind
//! `require_auth` - the login page needs `status` before any session exists,
//! and `setup` is how the very first session gets created. `setup` is
//! additionally gated by an `allow_setup` flag (spec §8.2): the Tauri app
//! always passes `false` (desktop first-run goes through the `auth_setup`
//! Tauri command instead, spec §10), while `banto-serve` enables it via
//! `BANTO_ALLOW_SETUP=1` so this REST path is exercisable standalone.
//!
//! `POST /api/items/list` (rather than `GET` with query-string encoded
//! `ListParams`) is chosen deliberately: `ListParams` (sort/filters/
//! pagination, spec §3.2) is a nested structure, and sending it as a JSON
//! body makes the wire shape byte-for-byte identical to what
//! `DataProvider.getList`'s `HttpDataProvider` implementation (Phase B)
//! sends, with no query-string (de)serialization layer to keep in sync.
//!
//! Every `/api/*` route requires the `X-Banto-Client: banto` header
//! (`banto_server::csrf`) and, except for the auth routes themselves, a
//! valid bearer token (`banto_server::auth::require_auth`).
//!
//! ## RBAC (spec M10, `docs/roadmap.md`)
//!
//! On top of `require_auth` (valid session, any role), mutating `items`
//! routes and all `/api/users` routes are additionally gated by
//! [`require_role_at_least`]: it re-resolves the bearer token to an
//! [`Identity`], parses `Identity.role` into [`Role`], and rejects with
//! `403 { "kind": "forbidden" }` (`banto_core::ErrorBody::Forbidden`) if the
//! caller's role is not at least the route's minimum. `viewer` can read
//! (`items` list/get); `editor` and up can also write; only `admin` can
//! manage other accounts.
//!
//! ## Audit log (spec M14, `docs/roadmap.md`)
//!
//! Every mutating handler above (`items`/`users` create/update/delete,
//! password reset, self-service password change) records a
//! `crate::audit::AuditEntry` to [`crate::audit::AuditLogService`] once its
//! underlying service call has already succeeded (`origin: "rest"`);
//! [`require_role_at_least`] records `action: "denied"` when an
//! authenticated caller's role is too low; [`audited_credential_verifier`]
//! records `login`/`login_failed`; [`audit_logout_middleware`] records
//! `logout`; and `auth_setup_handler` records `setup`. Read routes
//! (`list`/`get`) are never audited. The trail itself is only readable via
//! `POST /api/audit-log/list`, `admin`-only.
//!
//! `POST /api/items/import` (spec M15) is a partial exception to "once its
//! underlying service call has already succeeded": [`ItemsService::import`]
//! itself never fails on bad ROW data (an all-or-nothing rollback is a
//! successful `Ok(ImportResult)` with `errors` populated, spec M15 design
//! decision - see that method's doc comment), so [`items_import`] always
//! records exactly one `action: "import"` entry - `result: "ok"` with a
//! `{created,updated}` summary when `errors` is empty, `result: "failed"`
//! with an `{errorCount}` summary when the batch was rolled back. It only
//! skips the audit write the way every other handler does: when the
//! service call returns `Err` outright (e.g. the row-count limit), which
//! `?`-propagates straight to a `422` before this handler's audit code runs.
//!
//! `/api/backups/*` (spec M17): `admin`-only, guarded the same way
//! `/api/users/*`/`/api/audit-log/*` are. `POST /api/backups` records
//! `action: "backup"`; either restore-staging route records
//! `action: "restore_staged"`; `DELETE /api/backups/pending-restore` records
//! `action: "restore_cancelled"` - all `resource: "backups"`. Reads (`GET
//! /api/backups`, the per-file download, `GET .../pending-restore`) are
//! never audited, same "read routes are never audited" convention as
//! everywhere else in this module. `action: "restore_applied"` is
//! deliberately NEVER recorded from here - a staged restore is only ever
//! APPLIED at the next process start, before any REST router (or pool) even
//! exists yet (spec M17: "稼働中のプールの差し替えはしない") - see
//! `crate::backup::BackupService::apply_pending_restore_at_startup`'s doc
//! comment and its callers in `src-tauri`'s `run()`/`bin/banto-serve.rs`'s
//! `main`, which record that entry themselves once a fresh `AuditLogService`
//! exists. `POST /api/backups/restore`'s request body is raw bytes
//! (`Content-Type: application/octet-stream`), not JSON or multipart - this
//! workspace has no multipart dependency (spec M17 design decision:
//! "依存追加はしない") - with the uploaded file's original name passed as a
//! `?fileName=` query parameter purely for the audit `detail`/error
//! messages, never as a filesystem path (the actual bytes are always staged
//! under the service's own fixed `restore-pending.sqlite3` name - see
//! `crate::backup::BackupService::stage_restore_from_bytes`).
//!
//! `/api/attachments/*` (spec `docs/attachments-plan.md` §3.5, M20 unit B):
//! same read/write RBAC split as `items` (`viewer`+ read, `editor`+ write),
//! backed by `banto_attachments::AttachmentsService`. Upload is raw `Bytes`
//! with metadata on the query string, same "no multipart dependency" design
//! as `/api/backups/restore` above; `?fileName=` here IS actually used
//! (as display/`Content-Disposition` text, never a filesystem path - see
//! `banto_attachments`'s module doc comment). `POST /api/attachments`
//! records `action: "create"`, `DELETE /api/attachments/{id}` records
//! `action: "delete"`, both `resource: "attachments"` with
//! `{fileName,sizeBytes,parentResource,parentId}` detail. Reads (`list`/
//! `download`/`thumbnail`) are never audited. `AttachmentsService` itself
//! has no `ServerEvent`/`banto-server` awareness (a deliberate crate
//! boundary - see that crate's module doc comment), so
//! [`attachments_upload`]/[`attachments_delete`] broadcast
//! `ServerEvent::ResourceChanged { resource: "attachments" }` directly,
//! reusing the same `broadcast::Sender` [`api_router`] already threads
//! through for SSE.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment, MAX_ATTACHMENT_BYTES};
use banto_core::{BantoError, ErrorBody, ListParams, ListResult};
use banto_server::{
    auth_routes, require_auth, require_banto_client_header, sse_route, ApiError, AuthState,
    Identity, ServerEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::str::FromStr;
use tokio::sync::broadcast;

use crate::audit::{AuditEntry, AuditLogService};
use crate::backup::{BackupInfo, BackupService, PendingRestoreInfo};
use crate::items::{ImportResult, Item, ItemImportRow, ItemInput, ItemsService};
use crate::settings::{AuditSettings, SettingsService};
use crate::users::{Role, UserIdentity, UserSummary, UsersService};

/// Request-body size cap for `POST /api/backups/restore` (spec M17: "サイズ
/// 上限（例256MB）を設ける"). Applied via `DefaultBodyLimit` on
/// [`backups_router`] - axum's own built-in default is 2MB
/// (`axum::extract::DefaultBodyLimit`), far too small for an uploaded DB
/// backup.
const MAX_RESTORE_UPLOAD_BYTES: usize = 256 * 1024 * 1024;

/// Slack added on top of `banto_attachments::MAX_ATTACHMENT_BYTES` for
/// [`attachments_write_router`]'s `DefaultBodyLimit` (spec
/// `docs/attachments-plan.md` §3.5): the limit that actually matters is the
/// service-layer check in `AttachmentsService::upload` (which returns a
/// `Validation` error, `422`), not this one - this only needs to be
/// comfortably above `MAX_ATTACHMENT_BYTES` so a request AT the real limit
/// is never rejected by axum's transport-level cap before the service layer
/// even sees it. 1MB of slack is far more than the difference between a
/// file's raw bytes and its (non-existent, this route has no envelope)
/// wire overhead.
const ATTACHMENT_BODY_LIMIT_SLACK_BYTES: usize = 1024 * 1024;

/// Resolve the caller's [`Identity`] from its bearer token, best-effort
/// (spec M14): every audit-recording call site needs "who did this", and
/// every one of them runs AFTER `require_auth`/`require_role_at_least` has
/// already proven the token valid, so this should always resolve - `None`
/// here is a defensive fallback (e.g. the token expired in the instant
/// between the guard and the handler running), not an expected path. Shared
/// by the items/users write handlers below; auth-flow events (login/setup/
/// logout) resolve their own actor differently since they run before or
/// without a caller session.
fn actor_identity(headers: &HeaderMap, auth: &AuthState) -> Option<Identity> {
    bearer_token(headers).and_then(|token| auth.identity_for(token))
}

/// Record a successful write (spec M14: create/update/delete/password_reset
/// etc.) once the service call it follows has already succeeded. Resolves
/// the actor from the same bearer token `require_auth`/`require_role_at_least`
/// validated - see [`actor_identity`]. `origin` is always `"rest"` at every
/// call site in this module (the REST layer); kept as a parameter rather
/// than hardcoded only so this helper reads the same as the audit
/// entry it builds.
async fn record_write(
    audit: &AuditLogService,
    auth: &AuthState,
    headers: &HeaderMap,
    action: &str,
    resource: &str,
    entity_id: &str,
    detail: Option<serde_json::Value>,
) {
    let identity = actor_identity(headers, auth);
    audit
        .record(AuditEntry {
            actor_username: identity.as_ref().map(|i| i.id.as_str()),
            actor_role: identity.as_ref().map(|i| i.role.as_str()),
            action,
            resource,
            entity_id: Some(entity_id),
            detail,
            origin: "rest",
            result: "ok",
        })
        .await;
}

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
/// しない").
#[derive(Clone)]
struct ItemsWriteState {
    items: ItemsService,
    audit: AuditLogService,
    auth: AuthState,
}

async fn items_create(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    let item = state.items.create(input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "items",
        &item.id.to_string(),
        Some(json!({ "name": item.name })),
    )
    .await;
    Ok(Json(item))
}

async fn items_update(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    let item = state.items.update(id, input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        "items",
        &item.id.to_string(),
        Some(json!({ "name": item.name })),
    )
    .await;
    Ok(Json(item))
}

async fn items_delete(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    state.items.delete(id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        "items",
        &id.to_string(),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/items/import` (spec M15): bulk create/update, `editor`+
/// (same `ItemsWriteState`/`RoleGuard` as `items_create`/`update`/`delete`
/// above). Unlike those, a single `action: "import"` audit entry is written
/// here directly (not via [`record_write`], which always writes
/// `result: "ok"` against a single concrete `entity_id`) - see this module's
/// doc comment ("Audit log" section) for why the result/detail depend on
/// whether [`ItemsService::import`] rolled the batch back.
async fn items_import(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Json(rows): Json<Vec<ItemImportRow>>,
) -> Result<Json<ImportResult>, ApiError> {
    let result = state.items.import(rows).await?;
    let identity = actor_identity(&headers, &state.auth);
    let (result_tag, detail) = if result.errors.is_empty() {
        (
            "ok",
            json!({ "created": result.created, "updated": result.updated }),
        )
    } else {
        ("failed", json!({ "errorCount": result.errors.len() }))
    };
    state
        .audit
        .record(AuditEntry {
            actor_username: identity.as_ref().map(|i| i.id.as_str()),
            actor_role: identity.as_ref().map(|i| i.role.as_str()),
            action: "import",
            resource: "items",
            entity_id: None,
            detail: Some(detail),
            origin: "rest",
            result: result_tag,
        })
        .await;
    Ok(Json(result))
}

/// `State` for [`require_role_at_least`]: the `AuthState` needed to resolve
/// a bearer token back to an [`Identity`], the minimum [`Role`] the guarded
/// routes require, the `resource` name to tag a denial with (spec M14), and
/// the `AuditLogService` to record that denial to.
#[derive(Clone)]
struct RoleGuard {
    auth: AuthState,
    min: Role,
    resource: &'static str,
    audit: AuditLogService,
}

fn forbidden_response() -> Response {
    (StatusCode::FORBIDDEN, Json(ErrorBody::Forbidden)).into_response()
}

/// Axum middleware (spec M10 RBAC): stacked *after* `require_auth` on a
/// router, so a request has already been proven to carry a valid bearer
/// token by the time this runs. Re-resolves that token to an [`Identity`],
/// parses `Identity.role`, and rejects with `403
/// { "kind": "forbidden" }` unless the caller's role is at least
/// `guard.min`. Attach via
/// `middleware::from_fn_with_state(RoleGuard { auth, min, resource, audit }, require_role_at_least)`.
///
/// A missing/invalid token at this point (the identity lookup failing) means
/// `require_auth` did not actually run first - treated as `Forbidden` rather
/// than panicking, so a misconfigured router fails closed instead of open.
/// Spec M14: a denial is only recorded to the audit log when there IS a
/// resolved identity whose role is simply too low - the defensive
/// missing-token case above is not a meaningful RBAC decision to audit (it
/// means the router itself is misconfigured, not that a real user got
/// rejected).
async fn require_role_at_least(
    State(guard): State<RoleGuard>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let identity = bearer_token(req.headers()).and_then(|token| guard.auth.identity_for(token));
    let role = identity
        .as_ref()
        .and_then(|identity| Role::from_str(&identity.role).ok());

    match role {
        Some(role) if role.at_least(guard.min) => next.run(req).await,
        _ => {
            if let Some(identity) = &identity {
                let method = req.method().as_str().to_string();
                let path = req.uri().path().to_string();
                guard
                    .audit
                    .record(AuditEntry {
                        actor_username: Some(&identity.id),
                        actor_role: Some(&identity.role),
                        action: "denied",
                        resource: guard.resource,
                        entity_id: None,
                        detail: Some(json!({ "method": method, "path": path })),
                        origin: "rest",
                        result: "denied",
                    })
                    .await;
            }
            forbidden_response()
        }
    }
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
fn items_write_router(items: ItemsService, audit: AuditLogService, auth: AuthState) -> Router {
    let state = ItemsWriteState {
        items,
        audit: audit.clone(),
        auth: auth.clone(),
    };
    Router::new()
        .route("/api/items", post(items_create))
        .route(
            "/api/items/{id}",
            axum::routing::put(items_update).delete(items_delete),
        )
        .route("/api/items/import", post(items_import))
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
fn items_router(items: ItemsService, audit: AuditLogService, auth: AuthState) -> Router {
    items_read_router(items.clone(), auth.clone()).merge(items_write_router(items, audit, auth))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserIdentityResponse {
    id: i64,
    username: String,
    display_name: String,
    role: Role,
}

impl From<UserIdentity> for UserIdentityResponse {
    fn from(identity: UserIdentity) -> Self {
        Self {
            id: identity.id,
            username: identity.username,
            display_name: identity.display_name,
            role: identity.role,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUserRequest {
    username: String,
    password: String,
    display_name: String,
    role: Role,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateUserRequest {
    display_name: String,
    role: Role,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetPasswordRequest {
    new_password: String,
}

#[derive(Debug, Serialize)]
struct ResetPasswordResponse {
    success: bool,
}

/// State for the `/api/users/*` handlers: `UsersService` for the CRUD
/// itself, `AuthState` so `users_delete` can resolve the acting caller's
/// numeric row id from its bearer token (spec M10's self-deletion guard,
/// see `UsersService::delete_user`'s doc comment), and `AuditLogService`
/// (spec M14) so every mutation here records a `create`/`update`/
/// `password_reset`/`delete` entry once it has already succeeded.
#[derive(Clone)]
struct UsersAdminState {
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
}

/// Resolve the [`UserIdentity`] of the caller making this request, from its
/// bearer token. `require_auth`/`require_role_at_least` have already proven
/// the token is valid and `admin`-roled by the time a `/api/users/*` handler
/// runs, so this should always succeed - `Unauthorized` here is a defensive
/// fallback (e.g. the account was deleted by another admin between the
/// token being issued and this request), not an expected path.
async fn acting_user(
    headers: &HeaderMap,
    auth: &AuthState,
    users: &UsersService,
) -> Result<UserIdentity, BantoError> {
    let username = bearer_token(headers)
        .and_then(|token| auth.identity_for(token))
        .map(|identity| identity.id);
    let Some(username) = username else {
        return Err(BantoError::Unauthorized);
    };
    users
        .get_by_username(&username)
        .await?
        .ok_or(BantoError::Unauthorized)
}

async fn users_list(
    State(state): State<UsersAdminState>,
) -> Result<Json<Vec<UserSummary>>, ApiError> {
    Ok(Json(state.users.list_users().await?))
}

async fn users_create(
    State(state): State<UsersAdminState>,
    headers: HeaderMap,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<UserIdentityResponse>, ApiError> {
    let identity = state
        .users
        .create_user(
            &body.username,
            &body.password,
            &body.display_name,
            body.role,
        )
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "users",
        &identity.id.to_string(),
        Some(json!({ "username": identity.username, "role": identity.role })),
    )
    .await;
    Ok(Json(identity.into()))
}

async fn users_update(
    State(state): State<UsersAdminState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<Json<UserSummary>, ApiError> {
    let updated = state
        .users
        .update_user(id, &body.display_name, body.role)
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        "users",
        &id.to_string(),
        Some(json!({ "role": updated.role })),
    )
    .await;
    Ok(Json(updated))
}

async fn users_reset_password(
    State(state): State<UsersAdminState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<ResetPasswordResponse>, ApiError> {
    state.users.reset_password(id, &body.new_password).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "password_reset",
        "users",
        &id.to_string(),
        None,
    )
    .await;
    Ok(Json(ResetPasswordResponse { success: true }))
}

async fn users_delete(
    State(state): State<UsersAdminState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let acting = acting_user(&headers, &state.auth, &state.users).await?;
    state.users.delete_user(id, acting.id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        "users",
        &id.to_string(),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `/api/users/*` (spec M10): `admin`-only account management. Guarded the
/// same way `items_write_router` is (`require_auth` then
/// `require_role_at_least`), just with `Role::Admin` as the floor.
fn users_router(users: UsersService, audit: AuditLogService, auth: AuthState) -> Router {
    let state = UsersAdminState {
        users,
        auth: auth.clone(),
        audit: audit.clone(),
    };
    Router::new()
        .route("/api/users", get(users_list).post(users_create))
        .route(
            "/api/users/{id}",
            axum::routing::put(users_update).delete(users_delete),
        )
        .route("/api/users/{id}/reset-password", post(users_reset_password))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "users",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// State shared by `/api/auth/status`, `/api/auth/setup` and
/// `/api/auth/change-password` (see [`extra_auth_router`]): these need both
/// `UsersService` (the credential store, spec §8.2) and `AuthState` (to
/// issue a token on `setup`'s implicit login, and to resolve the calling
/// account on `change-password`), neither of which `banto_server::auth`
/// knows about on its own.
#[derive(Clone)]
struct UsersAuthState {
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    allow_setup: bool,
}

#[derive(Debug, Serialize)]
struct AuthStatusResponse {
    initialized: bool,
}

async fn auth_status_handler(
    State(state): State<UsersAuthState>,
) -> Result<Json<AuthStatusResponse>, ApiError> {
    let initialized = state.users.is_initialized().await?;
    Ok(Json(AuthStatusResponse { initialized }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    username: String,
    password: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
struct SetupResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

/// `POST /api/auth/setup`: creates the first account, then behaves like a
/// successful login (spec §8.2/§3.3). Three distinct outcomes:
/// - `allow_setup` is `false` -> `403` with a plain `{kind,message}` body
///   (not the `{success,error?}` shape below - this is a server
///   configuration rejection, not a "try again" outcome).
/// - `UsersService::setup_first_user` returns `BantoError::Validation` (bad
///   username/password) -> `422` with `field_errors`, same convention as
///   `items_create` (spec: form fields should be able to map these).
/// - Anything else (already initialized, storage error) -> `200` with
///   `{success:false,error}`, mirroring `login_handler`'s "expected,
///   retryable failure" convention.
async fn auth_setup_handler(
    State(state): State<UsersAuthState>,
    Json(body): Json<SetupRequest>,
) -> Result<Response, ApiError> {
    if !state.allow_setup {
        let message = "このサーバーでは初期セットアップが許可されていません".to_string();
        return Ok((StatusCode::FORBIDDEN, Json(ErrorBody::Other { message })).into_response());
    }

    match state
        .users
        .setup_first_user(&body.username, &body.password, &body.display_name)
        .await
    {
        Ok(identity) => {
            let identity = Identity {
                id: identity.username,
                name: identity.display_name,
                role: identity.role.to_string(),
            };
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&identity.id),
                    actor_role: Some(&identity.role),
                    action: "setup",
                    resource: "auth",
                    entity_id: None,
                    detail: None,
                    origin: "rest",
                    result: "ok",
                })
                .await;
            let token = state.auth.issue_token(identity);
            Ok(Json(SetupResponse {
                success: true,
                error: None,
                token: Some(token),
            })
            .into_response())
        }
        Err(err @ BantoError::Validation { .. }) => Err(ApiError(err)),
        Err(other) => Ok(Json(SetupResponse {
            success: false,
            error: Some(other.to_string()),
            token: None,
        })
        .into_response()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

#[derive(Debug, Serialize)]
struct ChangePasswordResponse {
    success: bool,
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// `POST /api/auth/change-password`: authenticated via the same bearer
/// token as every other guarded route, but implemented as a plain handler
/// (not `require_auth` middleware) since it also needs the token's bound
/// `Identity` to know *which* account to update - `require_auth` only
/// proves the token is valid, it does not thread the identity through.
async fn auth_change_password_handler(
    State(state): State<UsersAuthState>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Json<ChangePasswordResponse>, ApiError> {
    let identity = bearer_token(&headers).and_then(|token| state.auth.identity_for(token));
    let Some(identity) = identity else {
        return Err(ApiError(BantoError::Unauthorized));
    };

    state
        .users
        .change_password(&identity.id, &body.current_password, &body.new_password)
        .await?;
    // Spec M14: a self-service password change is a security event (it is
    // also what naturally invalidates an M11 autologin credential), so it IS
    // audited - `entity_id` is the caller's own numeric row id (matching the
    // other `users` entries), recovered from the username since the bearer
    // token only carries the latter. `detail` stays `None`: neither the old
    // nor the new password (nor any hash) may ever be recorded.
    let entity_id = state
        .users
        .get_by_username(&identity.id)
        .await
        .ok()
        .flatten()
        .map(|user| user.id.to_string());
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&identity.id),
            actor_role: Some(&identity.role),
            action: "password_change",
            resource: "users",
            entity_id: entity_id.as_deref(),
            detail: None,
            origin: "rest",
            result: "ok",
        })
        .await;
    Ok(Json(ChangePasswordResponse { success: true }))
}

fn extra_auth_router(
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    allow_setup: bool,
) -> Router {
    let state = UsersAuthState {
        users,
        auth,
        audit,
        allow_setup,
    };
    Router::new()
        .route("/api/auth/status", get(auth_status_handler))
        .route("/api/auth/setup", post(auth_setup_handler))
        .route(
            "/api/auth/change-password",
            post(auth_change_password_handler),
        )
        .with_state(state)
}

/// State for the `/api/ui-settings/*` handlers (spec M12): `SettingsService`
/// for the per-user key/value store itself, plus `AuthState` to resolve the
/// caller's own `username` from the bearer token `require_auth` already
/// validated (same pattern as [`UsersAuthState`]/[`acting_user`] above).
#[derive(Clone)]
struct UiSettingsState {
    settings: SettingsService,
    auth: AuthState,
}

#[derive(Debug, Serialize)]
struct UiSettingValueResponse {
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UiSettingSetRequest {
    value: String,
}

/// Resolve the calling session's `username` (spec convention: bearer-token
/// `Identity.id` IS the username, see `banto_server::auth::Identity`'s doc
/// comment) from its bearer token. `require_auth` has already proven the
/// token valid by the time a `/api/ui-settings/*` handler runs, so this
/// should always succeed; `Unauthorized` here is a defensive fallback (e.g.
/// the token expired between `require_auth` and this handler running), not
/// an expected path - mirrors [`acting_user`] above.
fn acting_username(headers: &HeaderMap, auth: &AuthState) -> Result<String, BantoError> {
    bearer_token(headers)
        .and_then(|token| auth.identity_for(token))
        .map(|identity| identity.id)
        .ok_or(BantoError::Unauthorized)
}

async fn ui_settings_get(
    State(state): State<UiSettingsState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<UiSettingValueResponse>, ApiError> {
    let username = acting_username(&headers, &state.auth)?;
    let value = state.settings.ui_get(&username, &key).await?;
    Ok(Json(UiSettingValueResponse { value }))
}

async fn ui_settings_set(
    State(state): State<UiSettingsState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<UiSettingSetRequest>,
) -> Result<StatusCode, ApiError> {
    let username = acting_username(&headers, &state.auth)?;
    state.settings.ui_set(&username, &key, &body.value).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `/api/ui-settings/*` (spec M12): `require_auth` only, no
/// [`require_role_at_least`] floor - see this module's doc comment for why
/// (every route here only ever touches the caller's OWN namespaced keys).
fn ui_settings_router(settings: SettingsService, auth: AuthState) -> Router {
    let state = UiSettingsState {
        settings,
        auth: auth.clone(),
    };
    Router::new()
        .route(
            "/api/ui-settings/{key}",
            get(ui_settings_get).put(ui_settings_set),
        )
        .with_state(state)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

// --- M14: audit log ---------------------------------------------------------

/// Wraps `UsersService::verify` as the async credential verifier
/// `banto_server::AuthState::new` expects (spec §8.2), additionally
/// recording a `login`/`login_failed` audit entry for every attempt (spec
/// M14). Shared by `banto-serve` (the standalone REST dev server) and
/// `src-tauri`'s embedded LAN server auth state - both are `origin: "rest"`
/// sessions (the Tauri webview's OWN session goes through the `auth_login`
/// command instead, which records its own login/login_failed entries with
/// `origin: "tauri"`).
pub fn audited_credential_verifier(
    users: UsersService,
    audit: AuditLogService,
) -> impl Fn(String, String) -> futures_util::future::BoxFuture<'static, Option<Identity>>
       + Send
       + Sync
       + 'static {
    move |username: String, password: String| {
        let users = users.clone();
        let audit = audit.clone();
        Box::pin(async move {
            match users.verify(&username, &password).await {
                Ok(Some(identity)) => {
                    audit
                        .record(AuditEntry {
                            actor_username: Some(&identity.username),
                            actor_role: Some(identity.role.as_str()),
                            action: "login",
                            resource: "auth",
                            entity_id: None,
                            detail: None,
                            origin: "rest",
                            result: "ok",
                        })
                        .await;
                    Some(Identity {
                        id: identity.username,
                        name: identity.display_name,
                        role: identity.role.to_string(),
                    })
                }
                _ => {
                    audit
                        .record(AuditEntry {
                            actor_username: Some(&username),
                            actor_role: None,
                            action: "login_failed",
                            resource: "auth",
                            entity_id: None,
                            detail: None,
                            origin: "rest",
                            result: "failed",
                        })
                        .await;
                    None
                }
            }
        })
    }
}

/// State for [`audit_logout_middleware`]: needs `AuthState` to resolve the
/// logging-out session's identity BEFORE the token is invalidated, plus
/// `AuditLogService` to record it (spec M14).
#[derive(Clone)]
struct LogoutAuditState {
    auth: AuthState,
    audit: AuditLogService,
}

/// Wraps the WHOLE `banto_server::auth_routes` sub-router (login/logout/
/// check/identity) rather than adding a competing `/api/auth/logout` route
/// of its own (spec M14): `axum::Router::merge` panics if two routers both
/// register the same path+method, and `banto_server::auth_routes` bundles
/// all four routes into one `Router` with no way to omit just `logout` - so
/// this instead inspects each request's path/method, resolving the caller's
/// identity (before the real handler invalidates the token) only when the
/// request IS the logout route, letting `next` run the real handler
/// completely unmodified either way, then recording the `logout` entry
/// after.
///
/// `POST /api/auth/login`'s own login/login_failed events are NOT recorded
/// here - see [`audited_credential_verifier`], which records those from
/// inside the credential-verifier closure instead (simpler: no need to peek
/// at the response body to learn success/failure).
async fn audit_logout_middleware(
    State(state): State<LogoutAuditState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let is_logout =
        req.method() == axum::http::Method::POST && req.uri().path() == "/api/auth/logout";
    let identity = if is_logout {
        actor_identity(req.headers(), &state.auth)
    } else {
        None
    };

    let response = next.run(req).await;

    if is_logout {
        state
            .audit
            .record(AuditEntry {
                actor_username: identity.as_ref().map(|i| i.id.as_str()),
                actor_role: identity.as_ref().map(|i| i.role.as_str()),
                action: "logout",
                resource: "auth",
                entity_id: None,
                detail: None,
                origin: "rest",
                result: "ok",
            })
            .await;
    }

    response
}

/// State for the `/api/audit-log/*` handlers (spec M14): `AuditLogService`
/// for the read/write itself, `SettingsService` for the retention-policy
/// config endpoints (and the list route's opportunistic prune), plus
/// `AuthState` so `audit_config_apply` can resolve the calling actor (via
/// [`actor_identity`]) for its own `settings_change` audit entry, same as
/// the items/users write handlers' `record_write` helper.
#[derive(Clone)]
struct AuditLogState {
    audit: AuditLogService,
    settings: SettingsService,
    auth: AuthState,
}

/// `POST /api/audit-log/list` (spec M14, `admin`-only): filtered/sorted/
/// paginated read of the audit trail (spec: read routes themselves are
/// never audited, only mutations/denials/auth events are). Also
/// opportunistically prunes (spec: "list実行時に軽く") before answering -
/// best-effort, a prune failure must never block an admin from viewing
/// existing entries, so its result is discarded. There is deliberately no
/// separate background pruning task: this plus a once-at-startup prune
/// (`bin/banto-serve.rs`'s `main`/`src-tauri`'s `run()`) is judged
/// sufficient - the audit-log viewer is an admin-only, infrequently-visited
/// page, and each prune is a couple of indexed `DELETE`s, not an expensive
/// scan.
async fn audit_log_list(
    State(state): State<AuditLogState>,
    Json(params): Json<ListParams>,
) -> Result<Json<ListResult<crate::audit::AuditLogEntry>>, ApiError> {
    if let Ok(config) = state.settings.audit_config().await {
        let _ = state
            .audit
            .prune(config.retention_days, config.retention_rows)
            .await;
    }
    Ok(Json(state.audit.list(params).await?))
}

/// `GET /api/audit-log/config` (spec M14, `admin`-only): current retention
/// policy - read-only, so unlike `audit_config_apply` this records nothing
/// (spec: read routes are never audited).
async fn audit_config_get(
    State(state): State<AuditLogState>,
) -> Result<Json<AuditSettings>, ApiError> {
    Ok(Json(state.settings.audit_config().await?))
}

/// `PUT /api/audit-log/config` (spec M14, `admin`-only): persist a new
/// retention policy (days and/or row-count cap; either may be `null` for
/// "unlimited" on that dimension, see [`crate::settings::AuditSettings`]),
/// mirroring `src-tauri`'s `audit_config_apply` command - same
/// `settings_change`/`settings` audit entry shape, just `origin: "rest"` and
/// the actor resolved from the bearer token (`actor_identity`) instead of
/// from Tauri's session mutex.
async fn audit_config_apply(
    State(state): State<AuditLogState>,
    headers: HeaderMap,
    Json(config): Json<AuditSettings>,
) -> Result<Json<AuditSettings>, ApiError> {
    state.settings.set_audit_config(&config).await?;
    let identity = actor_identity(&headers, &state.auth);
    state
        .audit
        .record(AuditEntry {
            actor_username: identity.as_ref().map(|i| i.id.as_str()),
            actor_role: identity.as_ref().map(|i| i.role.as_str()),
            action: "settings_change",
            resource: "settings",
            entity_id: None,
            detail: Some(serde_json::json!({
                "retentionDays": config.retention_days,
                "retentionRows": config.retention_rows,
            })),
            origin: "rest",
            result: "ok",
        })
        .await;
    Ok(Json(state.settings.audit_config().await?))
}

/// `/api/audit-log/*` (spec M14): `admin`-only, guarded the same way
/// `users_router` is (`require_auth` then `require_role_at_least`).
fn audit_log_router(audit: AuditLogService, settings: SettingsService, auth: AuthState) -> Router {
    let state = AuditLogState {
        audit: audit.clone(),
        settings,
        auth: auth.clone(),
    };
    Router::new()
        .route("/api/audit-log/list", post(audit_log_list))
        .route(
            "/api/audit-log/config",
            get(audit_config_get).put(audit_config_apply),
        )
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "audit_log",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

// --- M17: SQLite backup/restore ---------------------------------------------

/// State for the `/api/backups/*` handlers (spec M17): `BackupService` for
/// the operation itself, plus `AuditLogService`/`AuthState` so
/// `backups_create_handler`/`backups_restore_from_upload`/
/// `backups_restore_from_existing`/`backups_cancel_pending` can each record
/// their own audit entry once the underlying service call has already
/// succeeded (same pattern as `ItemsWriteState`/`UsersAdminState`). Read
/// handlers (`backups_list`/`backups_download`/`backups_pending_status`)
/// also take this state (rather than a narrower read-only one) purely to
/// avoid a second near-identical struct - they simply never touch `audit`.
#[derive(Clone)]
struct BackupsState {
    backup: BackupService,
    audit: AuditLogService,
    auth: AuthState,
}

async fn backups_create_handler(
    State(state): State<BackupsState>,
    headers: HeaderMap,
) -> Result<Json<BackupInfo>, ApiError> {
    let info = state.backup.create().await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "backup",
        "backups",
        &info.file_name,
        Some(json!({ "sizeBytes": info.size_bytes })),
    )
    .await;
    Ok(Json(info))
}

async fn backups_list_handler(
    State(state): State<BackupsState>,
) -> Result<Json<Vec<BackupInfo>>, ApiError> {
    Ok(Json(state.backup.list().await?))
}

/// `GET /api/backups/{fileName}` (spec M17): LAN download. Not audited -
/// same "read routes are never audited" convention as everywhere else (see
/// this module's doc comment).
async fn backups_download_handler(
    State(state): State<BackupsState>,
    Path(file_name): Path<String>,
) -> Result<Response, ApiError> {
    let bytes = state.backup.read(&file_name).await?;
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{file_name}\""),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|err| ApiError(BantoError::Other(err.to_string())))?;
    Ok(response)
}

#[derive(Debug, Deserialize)]
struct RestoreUploadQuery {
    #[serde(rename = "fileName")]
    file_name: Option<String>,
}

/// `POST /api/backups/restore?fileName=` (spec M17): stage a restore from a
/// raw uploaded file. `fileName` (if present) is ONLY ever used for the
/// audit `detail` - the uploaded bytes are always staged under
/// `BackupService`'s own fixed `restore-pending.sqlite3` name, never under
/// the client-supplied name (see this module's doc comment).
async fn backups_restore_from_upload(
    State(state): State<BackupsState>,
    headers: HeaderMap,
    Query(query): Query<RestoreUploadQuery>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    state.backup.stage_restore_from_bytes(&body).await?;
    let identity = actor_identity(&headers, &state.auth);
    state
        .audit
        .record(AuditEntry {
            actor_username: identity.as_ref().map(|i| i.id.as_str()),
            actor_role: identity.as_ref().map(|i| i.role.as_str()),
            action: "restore_staged",
            resource: "backups",
            entity_id: None,
            detail: Some(json!({ "source": "upload", "fileName": query.file_name })),
            origin: "rest",
            result: "ok",
        })
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/backups/{fileName}/restore` (spec M17): stage a restore from
/// an existing backup already in `backups/`.
async fn backups_restore_from_existing(
    State(state): State<BackupsState>,
    headers: HeaderMap,
    Path(file_name): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.backup.stage_restore_from_file(&file_name).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "restore_staged",
        "backups",
        &file_name,
        Some(json!({ "source": "existing", "fileName": file_name })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn backups_pending_status(
    State(state): State<BackupsState>,
) -> Json<Option<PendingRestoreInfo>> {
    Json(state.backup.pending_restore().await)
}

async fn backups_cancel_pending(
    State(state): State<BackupsState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    state.backup.cancel_pending_restore().await?;
    let identity = actor_identity(&headers, &state.auth);
    state
        .audit
        .record(AuditEntry {
            actor_username: identity.as_ref().map(|i| i.id.as_str()),
            actor_role: identity.as_ref().map(|i| i.role.as_str()),
            action: "restore_cancelled",
            resource: "backups",
            entity_id: None,
            detail: None,
            origin: "rest",
            result: "ok",
        })
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `/api/backups/*` (spec M17): `admin`-only, guarded the same way
/// `users_router`/`audit_log_router` are. `DefaultBodyLimit::max` raises the
/// upload route's body cap from axum's 2MB default to
/// [`MAX_RESTORE_UPLOAD_BYTES`] - applied to the whole router (the other
/// routes here have no meaningful request body, so this is harmless for
/// them).
fn backups_router(backup: BackupService, audit: AuditLogService, auth: AuthState) -> Router {
    let state = BackupsState {
        backup,
        audit: audit.clone(),
        auth: auth.clone(),
    };
    Router::new()
        .route(
            "/api/backups",
            post(backups_create_handler).get(backups_list_handler),
        )
        .route("/api/backups/restore", post(backups_restore_from_upload))
        .route(
            "/api/backups/pending-restore",
            get(backups_pending_status).delete(backups_cancel_pending),
        )
        .route("/api/backups/{fileName}", get(backups_download_handler))
        .route(
            "/api/backups/{fileName}/restore",
            post(backups_restore_from_existing),
        )
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_RESTORE_UPLOAD_BYTES,
        ))
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "backups",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

// --- M20: attachments -------------------------------------------------------

/// `POST /api/attachments/list` request body (spec §3.5): `{resource,
/// resourceId}` - deliberately its own tiny struct rather than two loose
/// `Query`/`Path` extractors, mirroring why `items_list` takes a JSON body
/// too (a record's `(resource, resourceId)` pair is conceptually one
/// value, not two independent path segments).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentsListRequest {
    resource: String,
    resource_id: String,
}

async fn attachments_list(
    State(attachments): State<AttachmentsService>,
    Json(params): Json<AttachmentsListRequest>,
) -> Result<Json<Vec<AttachmentMeta>>, ApiError> {
    Ok(Json(
        attachments
            .list_for_record(&params.resource, &params.resource_id)
            .await?,
    ))
}

/// RFC 5987 `attr-char` set: the characters `filename*=UTF-8''...` may carry
/// unescaped. Everything else (including every non-ASCII byte) is
/// percent-encoded. No dependency added for this - the alphabet is small
/// and fixed, spec convention (this workspace does not add a dependency for
/// something a dozen lines of code can do, see `banto_attachments`'s own
/// `image`-dependency doc comment for the contrasting case where it does).
fn is_rfc5987_attr_char(byte: u8) -> bool {
    matches!(byte,
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
        | b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
}

fn rfc5987_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if is_rfc5987_attr_char(*byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Build a `Content-Disposition: attachment` header value carrying BOTH an
/// ASCII-safe `filename=` (for clients that only understand the legacy
/// form) and an RFC 5987 `filename*=UTF-8''...` (for everything else,
/// including any non-ASCII original name - spec §3.3: `file_name` is
/// user-supplied display text, never a filesystem path, but it still needs
/// to survive round-tripping through an HTTP header safely). The ASCII
/// fallback replaces anything non-ASCII, a quote, a backslash, or a control
/// character with `_` - it only has to be SOME safe placeholder, since a
/// `filename*`-aware client (which is effectively all of them) prefers the
/// RFC 5987 form anyway.
fn content_disposition_header_value(file_name: &str) -> String {
    let ascii_fallback: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii() && c != '"' && c != '\\' && !c.is_control() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ascii_fallback = if ascii_fallback.is_empty() {
        "attachment".to_string()
    } else {
        ascii_fallback
    };
    format!(
        "attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{}",
        rfc5987_encode(file_name)
    )
}

/// `GET /api/attachments/{id}/download` (spec §3.5): full attachment body.
/// `mime` is always the server-detected value from `AttachmentsService::upload`
/// (spec §3.4), never client-supplied. Not audited - "read routes are never
/// audited" (see this module's doc comment).
async fn attachments_download(
    State(attachments): State<AttachmentsService>,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let (meta, bytes) = attachments.read_body(id).await?;
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, meta.mime)
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            content_disposition_header_value(&meta.file_name),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|err| ApiError(BantoError::Other(err.to_string())))?;
    Ok(response)
}

/// `GET /api/attachments/{id}/thumbnail` (spec §3.5): JPEG thumbnail bytes,
/// or a `NotFound` (-> `404`) when the attachment has none -
/// `AttachmentsService::read_thumbnail`'s doc comment covers why "no such
/// attachment" and "attachment exists but has no thumbnail" are not
/// distinguished here.
async fn attachments_thumbnail(
    State(attachments): State<AttachmentsService>,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let bytes = attachments.read_thumbnail(id).await?;
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "image/jpeg")
        .body(axum::body::Body::from(bytes))
        .map_err(|err| ApiError(BantoError::Other(err.to_string())))?;
    Ok(response)
}

/// Read-only `attachments` routes (spec §3.5: `viewer` and up, same RBAC
/// floor as `items_read_router`).
fn attachments_read_router(attachments: AttachmentsService, auth: AuthState) -> Router {
    Router::new()
        .route("/api/attachments/list", post(attachments_list))
        .route("/api/attachments/{id}/download", get(attachments_download))
        .route(
            "/api/attachments/{id}/thumbnail",
            get(attachments_thumbnail),
        )
        .with_state(attachments)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// State for the `attachments` WRITE handlers (spec §3.5): `AttachmentsService`
/// for the mutation itself, `AuditLogService`/`AuthState` for the same
/// once-the-mutation-succeeded audit-record pattern every other write
/// handler in this module uses, and `events` (spec: `banto_attachments` has
/// no `ServerEvent` awareness by design - see this module's doc comment) so
/// [`attachments_upload`]/[`attachments_delete`] can broadcast
/// `ResourceChanged` themselves.
#[derive(Clone)]
struct AttachmentsWriteState {
    attachments: AttachmentsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
}

/// Broadcast `ServerEvent::ResourceChanged { resource: "attachments" }`
/// (spec §3.5 mirrors `ItemsService::notify_changed`'s "no receiver is not
/// an error" convention - `send` returning `Err` just means nobody is
/// currently subscribed).
fn notify_attachments_changed(events: &broadcast::Sender<ServerEvent>) {
    let _ = events.send(ServerEvent::ResourceChanged {
        resource: "attachments".to_string(),
    });
}

fn attachment_audit_detail(meta: &AttachmentMeta) -> serde_json::Value {
    json!({
        "fileName": meta.file_name,
        "sizeBytes": meta.size_bytes,
        "parentResource": meta.resource,
        "parentId": meta.resource_id,
    })
}

/// `POST /api/attachments?resource=&resourceId=&fileName=` query parameters
/// (spec §3.5). Metadata rides the query string, not the body, since the
/// body is the raw file bytes (same "no multipart dependency" shape as
/// `POST /api/backups/restore`'s `?fileName=`, see this module's doc
/// comment) - unlike that route, `fileName` here is load-bearing (it
/// becomes `AttachmentMeta.file_name`), not just an audit-detail string.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadQuery {
    resource: String,
    resource_id: String,
    file_name: String,
}

async fn attachments_upload(
    State(state): State<AttachmentsWriteState>,
    headers: HeaderMap,
    Query(query): Query<AttachmentUploadQuery>,
    body: Bytes,
) -> Result<Json<AttachmentMeta>, ApiError> {
    let created_by = actor_identity(&headers, &state.auth).map(|identity| identity.id);
    let meta = state
        .attachments
        .upload(NewAttachment {
            resource: query.resource,
            resource_id: query.resource_id,
            file_name: query.file_name,
            created_by,
            bytes: body.to_vec(),
        })
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "attachments",
        &meta.id.to_string(),
        Some(attachment_audit_detail(&meta)),
    )
    .await;
    notify_attachments_changed(&state.events);
    Ok(Json(meta))
}

async fn attachments_delete(
    State(state): State<AttachmentsWriteState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let meta = state.attachments.delete(id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        "attachments",
        &id.to_string(),
        Some(attachment_audit_detail(&meta)),
    )
    .await;
    notify_attachments_changed(&state.events);
    Ok(StatusCode::NO_CONTENT)
}

/// Mutating `attachments` routes (spec §3.5: `editor` and up, same RBAC
/// floor as `items_write_router`). `DefaultBodyLimit::max` caps the upload
/// route at `MAX_ATTACHMENT_BYTES` (+ [`ATTACHMENT_BODY_LIMIT_SLACK_BYTES`]);
/// the other route here (`DELETE`) has no meaningful request body, so this
/// is harmless for it (same reasoning as [`backups_router`]'s limit layer).
fn attachments_write_router(
    attachments: AttachmentsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    let state = AttachmentsWriteState {
        attachments,
        audit: audit.clone(),
        auth: auth.clone(),
        events,
    };
    Router::new()
        .route("/api/attachments", post(attachments_upload))
        .route(
            "/api/attachments/{id}",
            axum::routing::delete(attachments_delete),
        )
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_ATTACHMENT_BYTES + ATTACHMENT_BODY_LIMIT_SLACK_BYTES,
        ))
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Editor,
                resource: "attachments",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// `/api/attachments/*` (spec §3.5): merges the read (any role) and write
/// (`editor`+) sub-routers, mirroring [`items_router`].
fn attachments_router(
    attachments: AttachmentsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    attachments_read_router(attachments.clone(), auth.clone()).merge(attachments_write_router(
        attachments,
        audit,
        auth,
        events,
    ))
}

/// Compose the full `/api/*` router (spec §11.1): auth routes (login/
/// logout/check/identity from `banto_server` - wrapped with an audit-log
/// hook for `logout`, spec M14 - plus status/setup/change-password here
/// since those need `UsersService`), SSE events, the `items` CRUD routes
/// (RBAC-split read/write, spec M10), the `admin`-only `users` management
/// routes (spec M10), the `admin`-only `audit-log` viewer (spec M14), the
/// `admin`-only `backups` routes (spec M17), the `attachments` CRUD routes
/// (RBAC-split read/write, spec `docs/attachments-plan.md` §3.5 M20 unit
/// B), and the per-user `ui-settings` routes (spec M12), all behind the
/// CSRF header check. Mount the result *before*
/// `banto_server::static_files::static_router` so `/api/*` takes priority
/// over the SPA fallback.
// Each parameter is a distinct, already-cloneable service handle threaded
// through from `main()`/tests (no natural subset to bundle into a struct
// without adding an indirection layer with a single call site); simpler to
// allow this than to invent a "Services" struct for one function.
#[allow(clippy::too_many_arguments)]
pub fn api_router(
    items: ItemsService,
    users: UsersService,
    settings: SettingsService,
    audit: AuditLogService,
    backup: BackupService,
    attachments: AttachmentsService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
    allow_setup: bool,
) -> Router {
    let audited_auth_routes = auth_routes(auth.clone()).layer(middleware::from_fn_with_state(
        LogoutAuditState {
            auth: auth.clone(),
            audit: audit.clone(),
        },
        audit_logout_middleware,
    ));

    Router::new()
        .merge(audited_auth_routes)
        .merge(extra_auth_router(
            users.clone(),
            auth.clone(),
            audit.clone(),
            allow_setup,
        ))
        .merge(sse_route(auth.clone(), events.clone()))
        .merge(items_router(items, audit.clone(), auth.clone()))
        .merge(users_router(users, audit.clone(), auth.clone()))
        .merge(audit_log_router(
            audit.clone(),
            settings.clone(),
            auth.clone(),
        ))
        .merge(backups_router(backup, audit.clone(), auth.clone()))
        .merge(attachments_router(attachments, audit, auth.clone(), events))
        .merge(ui_settings_router(settings, auth))
        .layer(middleware::from_fn(require_banto_client_header))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_memory;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use banto_core::{BantoError, FilterOp, FilterState, Pagination, SortDirection, SortState};
    use serde_json::json;
    use std::path::PathBuf;
    use tempfile::tempdir;
    use tower::ServiceExt;

    const CLIENT_HEADER: (&str, &str) = ("X-Banto-Client", "banto");

    /// A `BackupService` for router helpers that do not exercise
    /// `/api/backups/*` at all (the overwhelming majority of this module's
    /// tests) - `BackupService::new` only stores its arguments, so an
    /// on-disk path that is never actually written to is harmless. Tests
    /// that DO exercise backups use [`router_with_role_tokens_and_backup`]
    /// instead, which points at a real, writable temp directory AND (unlike
    /// every other helper here) a real on-disk pool - see that function's
    /// doc comment for why the pool matters too.
    fn unused_backup_service(pool: sqlx::SqlitePool) -> BackupService {
        BackupService::new(
            PathBuf::from("unused-in-tests").join("admin-template.sqlite3"),
            pool,
        )
    }

    /// An `AttachmentsService` for router helpers that never exercise
    /// `/api/attachments/*` - same "never actually written to" reasoning as
    /// [`unused_backup_service`]. Tests that DO exercise attachments use
    /// [`router_with_role_tokens_and_attachments`] instead, which points at
    /// a real, writable temp directory.
    fn unused_attachments_service(pool: sqlx::SqlitePool) -> AttachmentsService {
        AttachmentsService::new(pool, PathBuf::from("unused-in-tests").join("attachments"))
    }

    fn demo_auth() -> AuthState {
        AuthState::new(|u: String, p: String| {
            Box::pin(async move {
                if u == "admin" && p == "admin" {
                    Some(Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                        role: "admin".to_string(),
                    })
                } else {
                    None
                }
            })
        })
    }

    /// Router + one bearer token per role (admin/editor/viewer), for the
    /// RBAC tests below (spec M10). Unlike [`demo_auth_with_roles`] (whose
    /// login verifier is independent of any `UsersService`), the three
    /// accounts here are REAL rows in the same `UsersService`/pool the
    /// router's `/api/users/*` routes operate on - required so
    /// `users_delete`'s `acting_user` lookup (by the token's username) can
    /// actually resolve the admin account performing the delete in
    /// `admin_can_create_list_update_reset_password_and_delete_users`
    /// below.
    async fn router_with_role_tokens() -> (Router, String, String, String) {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = unused_backup_service(pool.clone());
        let attachments = unused_attachments_service(pool.clone());
        let audit = AuditLogService::new(pool);

        users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .expect("setup_first_user");
        users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create editor");
        users
            .create_user("viewer", "password123", "閲覧者", Role::Viewer)
            .await
            .expect("create viewer");

        let verify_users = users.clone();
        let auth = AuthState::new(move |u: String, p: String| {
            let users = verify_users.clone();
            Box::pin(async move {
                match users.verify(&u, &p).await {
                    Ok(Some(identity)) => Some(Identity {
                        id: identity.username,
                        name: identity.display_name,
                        role: identity.role.to_string(),
                    }),
                    _ => None,
                }
            })
        });

        let admin_token = auth
            .login("admin", "password123")
            .await
            .expect("admin login");
        let editor_token = auth
            .login("editor", "password123")
            .await
            .expect("editor login");
        let viewer_token = auth
            .login("viewer", "password123")
            .await
            .expect("viewer login");
        (
            api_router(
                items,
                users,
                settings,
                audit,
                backup,
                attachments,
                auth,
                tx,
                false,
            ),
            admin_token,
            editor_token,
            viewer_token,
        )
    }

    async fn router_with_token() -> (Router, String) {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = unused_backup_service(pool.clone());
        let attachments = unused_attachments_service(pool.clone());
        let audit = AuditLogService::new(pool);
        let auth = demo_auth();
        let token = auth
            .login("admin", "admin")
            .await
            .expect("login should succeed");
        (
            api_router(
                items,
                users,
                settings,
                audit,
                backup,
                attachments,
                auth,
                tx,
                false,
            ),
            token,
        )
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn items_list_supports_sort_filter_and_pagination() {
        let (router, token) = router_with_token().await;

        // Seed a few rows through the same router (create is guarded too).
        for (name, price, stock) in [("Alpha", 90, 1), ("Beta", 200, 2), ("Gamma", 300, 3)] {
            let response = router
                .clone()
                .oneshot(
                    HttpRequest::post("/api/items")
                        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                        .header("Authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({ "name": name, "price": price, "stock": stock }).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let params = ListParams {
            sort: vec![SortState {
                field: "price".to_string(),
                direction: SortDirection::Asc,
            }],
            filters: vec![FilterState {
                field: "price".to_string(),
                op: FilterOp::Gte,
                value: json!(0),
            }],
            pagination: Some(Pagination {
                offset: 0,
                limit: 1,
            }),
        };
        let response = router
            .oneshot(
                HttpRequest::post("/api/items/list")
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&params).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["rows"][0]["name"], "Alpha");
        assert_eq!(json["rows"][0]["price"], 90);
        assert_eq!(json["totalCount"], 3);
    }

    #[tokio::test]
    async fn items_get_missing_id_returns_404_not_found_shape() {
        let (router, token) = router_with_token().await;
        let response = router
            .oneshot(
                HttpRequest::get("/api/items/999")
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "not_found");
        assert_eq!(json["resource"], "items");
        assert_eq!(json["id"], "999");
    }

    #[tokio::test]
    async fn items_create_validation_failure_is_422_with_field_errors() {
        let (router, token) = router_with_token().await;
        let response = router
            .oneshot(
                HttpRequest::post("/api/items")
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "name": "", "price": 1, "stock": 1 }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "validation");
        assert_eq!(json["field_errors"][0]["field"], "name");
    }

    #[tokio::test]
    async fn items_update_and_delete_round_trip() {
        let (router, token) = router_with_token().await;
        let create_response = router
            .clone()
            .oneshot(
                HttpRequest::post("/api/items")
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "name": "Before", "price": 10, "stock": 1 }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = body_json(create_response).await;
        let id = created["id"].as_i64().unwrap();

        let update_response = router
            .clone()
            .oneshot(
                HttpRequest::put(format!("/api/items/{id}"))
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "name": "After", "price": 20, "stock": 2 }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(update_response.status(), StatusCode::OK);
        let updated = body_json(update_response).await;
        assert_eq!(updated["name"], "After");

        let delete_response = router
            .oneshot(
                HttpRequest::delete(format!("/api/items/{id}"))
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn items_routes_are_guarded_without_token() {
        let (router, _token) = router_with_token().await;
        let response = router
            .oneshot(
                HttpRequest::post("/api/items/list")
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("content-type", "application/json")
                    .body(Body::from(json!(ListParams::default()).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "unauthorized");
    }

    #[tokio::test]
    async fn missing_csrf_header_is_forbidden_even_with_a_token() {
        let (router, token) = router_with_token().await;
        let response = router
            .oneshot(
                HttpRequest::get("/api/auth/check")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn update_via_rest_is_observable_on_the_event_channel() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = unused_backup_service(pool.clone());
        let attachments = unused_attachments_service(pool.clone());
        let audit = AuditLogService::new(pool);
        let auth = demo_auth();
        let token = auth.login("admin", "admin").await.unwrap();
        let router = api_router(
            items,
            users,
            settings,
            audit,
            backup,
            attachments,
            auth,
            tx,
            false,
        );

        let create_response = router
            .clone()
            .oneshot(
                HttpRequest::post("/api/items")
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "name": "Before", "price": 10, "stock": 1 }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = body_json(create_response).await;
        rx.try_recv().expect("create should emit an event");
        let id = created["id"].as_i64().unwrap();

        router
            .oneshot(
                HttpRequest::put(format!("/api/items/{id}"))
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "name": "After", "price": 20, "stock": 2 }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let event = rx.try_recv().expect("update should emit an event");
        assert!(matches!(event, ServerEvent::ResourceChanged { resource } if resource == "items"));
    }

    /// Sanity check that `BantoError` variants used elsewhere still map the
    /// way this module's tests assume (guards against silent drift if
    /// `banto_core::error` changes).
    #[test]
    fn error_kind_used_in_tests_matches_banto_core() {
        let err = BantoError::NotFound {
            resource: "items".to_string(),
            id: "1".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&err).unwrap()["kind"],
            json!("not_found")
        );
    }

    async fn router_with_setup(allow_setup: bool) -> Router {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = unused_backup_service(pool.clone());
        let attachments = unused_attachments_service(pool.clone());
        let audit = AuditLogService::new(pool);
        let auth = demo_auth();
        api_router(
            items,
            users,
            settings,
            audit,
            backup,
            attachments,
            auth,
            tx,
            allow_setup,
        )
    }

    fn get(path: &str) -> HttpRequest<Body> {
        HttpRequest::get(path)
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .body(Body::empty())
            .unwrap()
    }

    fn post_json(path: &str, body: serde_json::Value) -> HttpRequest<Body> {
        HttpRequest::post(path)
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn auth_status_reports_uninitialized_before_any_setup() {
        let router = router_with_setup(true).await;
        let response = router.oneshot(get("/api/auth/status")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["initialized"], false);
    }

    #[tokio::test]
    async fn auth_status_needs_no_bearer_token() {
        // Same assertion as above, phrased to make explicit that omitting
        // Authorization entirely (not just an invalid token) still gets a
        // 200, not a 401 - the login page calls this before any session
        // exists.
        let router = router_with_setup(true).await;
        let request = HttpRequest::get("/api/auth/status")
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_setup_is_forbidden_when_allow_setup_is_false() {
        let router = router_with_setup(false).await;
        let response = router
            .oneshot(post_json(
                "/api/auth/setup",
                json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn auth_setup_creates_account_and_the_token_works_for_guarded_routes() {
        let router = router_with_setup(true).await;

        let setup_response = router
            .clone()
            .oneshot(post_json(
                "/api/auth/setup",
                json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
            ))
            .await
            .unwrap();
        assert_eq!(setup_response.status(), StatusCode::OK);
        let setup_json = body_json(setup_response).await;
        assert_eq!(setup_json["success"], true);
        let token = setup_json["token"].as_str().expect("token").to_string();

        // `initialized` should now be true.
        let status_response = router
            .clone()
            .oneshot(get("/api/auth/status"))
            .await
            .unwrap();
        assert_eq!(body_json(status_response).await["initialized"], true);

        // And the freshly-issued token should work on a guarded route.
        let list_request = HttpRequest::post("/api/items/list")
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(json!(ListParams::default()).to_string()))
            .unwrap();
        let list_response = router.oneshot(list_request).await.unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_setup_rejects_short_password_with_422_validation() {
        let router = router_with_setup(true).await;
        let response = router
            .oneshot(post_json(
                "/api/auth/setup",
                json!({ "username": "owner", "password": "short", "displayName": "オーナー" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "validation");
        assert_eq!(json["field_errors"][0]["field"], "password");
    }

    #[tokio::test]
    async fn auth_setup_second_call_returns_success_false_already_initialized() {
        let router = router_with_setup(true).await;
        let first = post_json(
            "/api/auth/setup",
            json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
        );
        router.clone().oneshot(first).await.unwrap();

        let second = post_json(
            "/api/auth/setup",
            json!({ "username": "someone-else", "password": "password123", "displayName": "誰か" }),
        );
        let response = router.oneshot(second).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["success"], false);
        assert!(json["error"].as_str().unwrap().contains("初期化"));
    }

    async fn setup_and_get_token(router: &Router) -> String {
        let response = router
            .clone()
            .oneshot(post_json(
                "/api/auth/setup",
                json!({ "username": "owner", "password": "password123", "displayName": "オーナー" }),
            ))
            .await
            .unwrap();
        body_json(response).await["token"]
            .as_str()
            .expect("token")
            .to_string()
    }

    #[tokio::test]
    async fn auth_change_password_requires_a_bearer_token() {
        let router = router_with_setup(true).await;
        setup_and_get_token(&router).await;

        let response = router
            .oneshot(post_json(
                "/api/auth/change-password",
                json!({ "currentPassword": "password123", "newPassword": "newpassword1" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn auth_change_password_rejects_wrong_current_password() {
        let router = router_with_setup(true).await;
        let token = setup_and_get_token(&router).await;

        let request = HttpRequest::post("/api/auth/change-password")
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "currentPassword": "not-the-password", "newPassword": "newpassword1" })
                    .to_string(),
            ))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["field_errors"][0]["field"], "currentPassword");
    }

    /// Builds a router whose `/api/auth/login` verifier is backed by the
    /// SAME `UsersService`/pool as `/api/auth/setup` and
    /// `/api/auth/change-password` - mirrors how `banto-serve`/`src-tauri`
    /// wire things in production (unlike `router_with_setup` above, whose
    /// `demo_auth()` login verifier is intentionally independent, matching
    /// the other tests in this module that only care about items/CSRF
    /// behavior). Also returns the `AuditLogService` sharing the router's
    /// pool, so M14 tests can assert on what got recorded.
    async fn router_with_real_login(allow_setup: bool) -> (Router, AuditLogService) {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = unused_backup_service(pool.clone());
        let attachments = unused_attachments_service(pool.clone());
        let audit = AuditLogService::new(pool);
        let auth = AuthState::new(audited_credential_verifier(users.clone(), audit.clone()));
        (
            api_router(
                items,
                users,
                settings,
                audit.clone(),
                backup,
                attachments,
                auth,
                tx,
                allow_setup,
            ),
            audit,
        )
    }

    #[tokio::test]
    async fn auth_change_password_success_then_relogin_with_new_password() {
        let (router, _audit) = router_with_real_login(true).await;
        let token = setup_and_get_token(&router).await;

        let change_request = HttpRequest::post("/api/auth/change-password")
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "currentPassword": "password123", "newPassword": "newpassword1" })
                    .to_string(),
            ))
            .unwrap();
        let change_response = router.clone().oneshot(change_request).await.unwrap();
        assert_eq!(change_response.status(), StatusCode::OK);
        assert_eq!(body_json(change_response).await["success"], true);

        // The old password must no longer work.
        let old_login = router
            .clone()
            .oneshot(post_json(
                "/api/auth/login",
                json!({ "username": "owner", "password": "password123" }),
            ))
            .await
            .unwrap();
        assert_eq!(body_json(old_login).await["success"], false);

        // The new password must work.
        let new_login = router
            .oneshot(post_json(
                "/api/auth/login",
                json!({ "username": "owner", "password": "newpassword1" }),
            ))
            .await
            .unwrap();
        let json = body_json(new_login).await;
        assert_eq!(json["success"], true);
        assert!(json["token"].as_str().is_some());
    }

    // --- M10 RBAC ----------------------------------------------------------

    fn put_json(path: &str, token: &str, body: serde_json::Value) -> HttpRequest<Body> {
        HttpRequest::put(path)
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn post_json_auth(path: &str, token: &str, body: serde_json::Value) -> HttpRequest<Body> {
        HttpRequest::post(path)
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn get_auth(path: &str, token: &str) -> HttpRequest<Body> {
        HttpRequest::get(path)
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    fn delete_auth(path: &str, token: &str) -> HttpRequest<Body> {
        HttpRequest::delete(path)
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn viewer_can_list_and_get_items() {
        let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

        let list_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items/list",
                &viewer,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);

        let get_response = router
            .oneshot(get_auth("/api/items/999", &viewer))
            .await
            .unwrap();
        // Not the point of this test (no such item), but it proves the
        // request got PAST the role guard and into the handler.
        assert_eq!(get_response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn viewer_cannot_create_items_forbidden_with_forbidden_kind() {
        let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

        let response = router
            .oneshot(post_json_auth(
                "/api/items",
                &viewer,
                json!({ "name": "Nope", "price": 1, "stock": 1 }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "forbidden");
    }

    #[tokio::test]
    async fn viewer_cannot_update_or_delete_items() {
        let (router, admin, _editor, viewer) = router_with_role_tokens().await;

        // Seed one item as admin so there is something to try updating.
        let create_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items",
                &admin,
                json!({ "name": "Seed", "price": 10, "stock": 1 }),
            ))
            .await
            .unwrap();
        let id = body_json(create_response).await["id"].as_i64().unwrap();

        let update_response = router
            .clone()
            .oneshot(put_json(
                &format!("/api/items/{id}"),
                &viewer,
                json!({ "name": "Changed", "price": 20, "stock": 2 }),
            ))
            .await
            .unwrap();
        assert_eq!(update_response.status(), StatusCode::FORBIDDEN);

        let delete_response = router
            .oneshot(delete_auth(&format!("/api/items/{id}"), &viewer))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn editor_can_create_update_and_delete_items() {
        let (router, _admin, editor, _viewer) = router_with_role_tokens().await;

        let create_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items",
                &editor,
                json!({ "name": "Editable", "price": 10, "stock": 1 }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let id = body_json(create_response).await["id"].as_i64().unwrap();

        let update_response = router
            .clone()
            .oneshot(put_json(
                &format!("/api/items/{id}"),
                &editor,
                json!({ "name": "Edited", "price": 20, "stock": 2 }),
            ))
            .await
            .unwrap();
        assert_eq!(update_response.status(), StatusCode::OK);

        let delete_response = router
            .oneshot(delete_auth(&format!("/api/items/{id}"), &editor))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn only_admin_can_list_users() {
        let (router, admin, editor, viewer) = router_with_role_tokens().await;

        for (token, expected) in [
            (&admin, StatusCode::OK),
            (&editor, StatusCode::FORBIDDEN),
            (&viewer, StatusCode::FORBIDDEN),
        ] {
            let response = router
                .clone()
                .oneshot(get_auth("/api/users", token))
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "token role mismatch");
        }
    }

    #[tokio::test]
    async fn non_admin_users_write_routes_are_forbidden_with_forbidden_kind() {
        let (router, _admin, editor, _viewer) = router_with_role_tokens().await;

        let response = router
            .oneshot(post_json_auth(
                "/api/users",
                &editor,
                json!({
                    "username": "newperson",
                    "password": "password123",
                    "displayName": "New Person",
                    "role": "viewer"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "forbidden");
    }

    #[tokio::test]
    async fn admin_can_create_list_update_reset_password_and_delete_users() {
        let (router, admin, _editor, _viewer) = router_with_role_tokens().await;

        let create_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/users",
                &admin,
                json!({
                    "username": "newperson",
                    "password": "password123",
                    "displayName": "New Person",
                    "role": "editor"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let created = body_json(create_response).await;
        assert_eq!(created["role"], "editor");
        let id = created["id"].as_i64().unwrap();

        let list_response = router
            .clone()
            .oneshot(get_auth("/api/users", &admin))
            .await
            .unwrap();
        let list = body_json(list_response).await;
        assert!(list.as_array().unwrap().iter().any(|u| u["id"] == id));

        let update_response = router
            .clone()
            .oneshot(put_json(
                &format!("/api/users/{id}"),
                &admin,
                json!({ "displayName": "Updated Person", "role": "viewer" }),
            ))
            .await
            .unwrap();
        assert_eq!(update_response.status(), StatusCode::OK);
        assert_eq!(body_json(update_response).await["role"], "viewer");

        let reset_response = router
            .clone()
            .oneshot(post_json_auth(
                &format!("/api/users/{id}/reset-password"),
                &admin,
                json!({ "newPassword": "resetpassword1" }),
            ))
            .await
            .unwrap();
        assert_eq!(reset_response.status(), StatusCode::OK);
        assert_eq!(body_json(reset_response).await["success"], true);

        let delete_response = router
            .oneshot(delete_auth(&format!("/api/users/{id}"), &admin))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn users_routes_are_unauthorized_without_a_token() {
        let (router, _admin, _editor, _viewer) = router_with_role_tokens().await;
        let response = router.oneshot(get("/api/users")).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // --- M12 per-user UI settings ------------------------------------------

    fn put_ui_setting(key: &str, token: &str, value: &str) -> HttpRequest<Body> {
        put_json(
            &format!("/api/ui-settings/{key}"),
            token,
            json!({ "value": value }),
        )
    }

    #[tokio::test]
    async fn ui_settings_round_trip_via_rest() {
        let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

        // Unset key reads back as {"value": null}.
        let response = router
            .clone()
            .oneshot(get_auth("/api/ui-settings/theme", &viewer))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(body_json(response).await["value"].is_null());

        // PUT then GET round-trips - and note this is the VIEWER role:
        // writing your own UI settings needs no role floor (unlike
        // `settings_set`/`/api/users`).
        let put_response = router
            .clone()
            .oneshot(put_ui_setting("theme", &viewer, "glass"))
            .await
            .unwrap();
        assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

        let response = router
            .oneshot(get_auth("/api/ui-settings/theme", &viewer))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["value"], "glass");
    }

    #[tokio::test]
    async fn ui_settings_are_isolated_per_user() {
        let (router, admin, editor, _viewer) = router_with_role_tokens().await;

        let put_response = router
            .clone()
            .oneshot(put_ui_setting("theme", &admin, "glass"))
            .await
            .unwrap();
        assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

        // The admin's value must NOT be visible to the editor's session -
        // each account reads its own `ui.{username}.*` namespace.
        let response = router
            .clone()
            .oneshot(get_auth("/api/ui-settings/theme", &editor))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(body_json(response).await["value"].is_null());

        // And the admin still sees their own value.
        let response = router
            .oneshot(get_auth("/api/ui-settings/theme", &admin))
            .await
            .unwrap();
        assert_eq!(body_json(response).await["value"], "glass");
    }

    #[tokio::test]
    async fn ui_settings_reject_an_invalid_key_with_422_validation() {
        let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

        // `%20` decodes to a space in the path param - an invalid key char.
        let response = router
            .clone()
            .oneshot(put_ui_setting("bad%20key!", &viewer, "x"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "validation");
        assert_eq!(json["field_errors"][0]["field"], "key");

        let response = router
            .oneshot(get_auth("/api/ui-settings/bad%20key!", &viewer))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn ui_settings_routes_are_unauthorized_without_a_token() {
        let (router, _admin, _editor, _viewer) = router_with_role_tokens().await;

        let response = router
            .clone()
            .oneshot(get("/api/ui-settings/theme"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = router
            .oneshot(post_json(
                "/api/ui-settings/theme",
                json!({ "value": "glass" }),
            ))
            .await
            .unwrap();
        // POST is not a registered method on this route, but the request
        // must still die at `require_auth` (401), not reach any handler.
        assert!(
            response.status() == StatusCode::UNAUTHORIZED
                || response.status() == StatusCode::METHOD_NOT_ALLOWED
        );
    }

    // --- M14 Audit -----------------------------------------------------------

    /// Like `router_with_role_tokens`, but also returns the `AuditLogService`
    /// sharing the router's pool (so these tests can query
    /// `/api/audit-log/list` as the admin token and assert on what got
    /// recorded), and wires the login verifier through
    /// [`audited_credential_verifier`] so login events are actually recorded
    /// - `router_with_role_tokens`'s own verifier predates M14 and stays a
    ///   plain credential check since none of ITS callers care about audit
    ///   events.
    async fn router_with_role_tokens_and_audit() -> (Router, AuditLogService, String, String, String)
    {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = unused_backup_service(pool.clone());
        let attachments = unused_attachments_service(pool.clone());
        let audit = AuditLogService::new(pool);

        users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .expect("setup_first_user");
        users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create editor");
        users
            .create_user("viewer", "password123", "閲覧者", Role::Viewer)
            .await
            .expect("create viewer");

        let auth = AuthState::new(audited_credential_verifier(users.clone(), audit.clone()));
        let admin_token = auth
            .login("admin", "password123")
            .await
            .expect("admin login");
        let editor_token = auth
            .login("editor", "password123")
            .await
            .expect("editor login");
        let viewer_token = auth
            .login("viewer", "password123")
            .await
            .expect("viewer login");

        let router = api_router(
            items,
            users,
            settings,
            audit.clone(),
            backup,
            attachments,
            auth,
            tx,
            false,
        );
        (router, audit, admin_token, editor_token, viewer_token)
    }

    /// Like `router_with_role_tokens_and_audit`, but for the M17
    /// `/api/backups/*` (and, since both need a real writable temp
    /// directory, M20 `/api/attachments/*`) tests, which need services that
    /// ACTUALLY WORK end to end (create/list/read/stage a real file), not
    /// [`unused_backup_service`]/[`unused_attachments_service`]'s
    /// placeholders. Two things every other helper in this module gets to
    /// skip:
    /// - The router's own pool must be a real ON-DISK sqlite file, not
    ///   `:memory:` (`migrate_memory()`) - `VACUUM INTO` (which
    ///   `BackupService::create` uses) silently writes nothing when its
    ///   SOURCE connection is `:memory:` (see `crate::backup`'s test module
    ///   doc comment for the empirically-verified reason).
    /// - The returned `tempfile::TempDir` guard must be kept alive by the
    ///   caller for as long as the router is in use - dropping it deletes
    ///   the directory `backups/`/`restore-pending.sqlite3`/`attachments/`
    ///   live in.
    async fn router_with_role_tokens_and_backup(
    ) -> (Router, tempfile::TempDir, String, String, String) {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("admin-template.sqlite3");
        let pool = banto_storage::connect_sqlite(&db_path)
            .await
            .expect("connect_sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrate");

        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = BackupService::new(db_path, pool.clone());
        let attachments = AttachmentsService::new(pool.clone(), dir.path().join("attachments"));
        let audit = AuditLogService::new(pool);

        users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .expect("setup_first_user");
        users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create editor");
        users
            .create_user("viewer", "password123", "閲覧者", Role::Viewer)
            .await
            .expect("create viewer");

        let auth = AuthState::new(audited_credential_verifier(users.clone(), audit.clone()));
        let admin_token = auth
            .login("admin", "password123")
            .await
            .expect("admin login");
        let editor_token = auth
            .login("editor", "password123")
            .await
            .expect("editor login");
        let viewer_token = auth
            .login("viewer", "password123")
            .await
            .expect("viewer login");

        let router = api_router(
            items,
            users,
            settings,
            audit,
            backup,
            attachments,
            auth,
            tx,
            false,
        );
        (router, dir, admin_token, editor_token, viewer_token)
    }

    /// (a) `/api/audit-log/list` is admin-only: 200 for admin, 403 for
    /// editor/viewer.
    #[tokio::test]
    async fn audit_log_list_is_admin_only() {
        let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

        let admin_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        assert_eq!(admin_response.status(), StatusCode::OK);

        for token in [&editor, &viewer] {
            let response = router
                .clone()
                .oneshot(post_json_auth(
                    "/api/audit-log/list",
                    token,
                    json!(ListParams::default()),
                ))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "token role mismatch"
            );
        }
    }

    #[tokio::test]
    async fn audit_log_list_requires_a_token() {
        let (router, _audit, _admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;
        let response = router
            .oneshot(post_json(
                "/api/audit-log/list",
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    /// `GET /api/audit-log/config` is admin-only: 200 (with the default
    /// retention policy) for admin, 403 for editor/viewer.
    #[tokio::test]
    async fn audit_config_get_is_admin_only() {
        let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

        let admin_response = router
            .clone()
            .oneshot(get_auth("/api/audit-log/config", &admin))
            .await
            .unwrap();
        assert_eq!(admin_response.status(), StatusCode::OK);
        let body = body_json(admin_response).await;
        assert_eq!(body["retentionDays"], 90);
        assert_eq!(body["retentionRows"], 100_000);

        for token in [&editor, &viewer] {
            let response = router
                .clone()
                .oneshot(get_auth("/api/audit-log/config", token))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "token role mismatch"
            );
        }
    }

    /// `PUT /api/audit-log/config` (admin) persists the new policy - a
    /// following `GET` reflects it - and records a `settings_change` audit
    /// entry (spec M14: settings mutations are audited, unlike the read-only
    /// `GET`). `editor`/`viewer` are rejected with 403 and the policy is left
    /// untouched.
    #[tokio::test]
    async fn audit_config_apply_persists_and_is_admin_only() {
        let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

        for token in [&editor, &viewer] {
            let response = router
                .clone()
                .oneshot(put_json(
                    "/api/audit-log/config",
                    token,
                    json!({ "retentionDays": 30, "retentionRows": 5000 }),
                ))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "token role mismatch"
            );
        }

        let apply_response = router
            .clone()
            .oneshot(put_json(
                "/api/audit-log/config",
                &admin,
                json!({ "retentionDays": 30, "retentionRows": 5000 }),
            ))
            .await
            .unwrap();
        assert_eq!(apply_response.status(), StatusCode::OK);
        let applied = body_json(apply_response).await;
        assert_eq!(applied["retentionDays"], 30);
        assert_eq!(applied["retentionRows"], 5000);

        let get_response = router
            .clone()
            .oneshot(get_auth("/api/audit-log/config", &admin))
            .await
            .unwrap();
        let refetched = body_json(get_response).await;
        assert_eq!(refetched["retentionDays"], 30);
        assert_eq!(refetched["retentionRows"], 5000);

        let list_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(list_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        let entry = rows
            .iter()
            .find(|r| r["action"] == "settings_change" && r["resource"] == "settings")
            .unwrap_or_else(|| panic!("expected a settings_change/settings entry, got {rows:?}"));
        assert_eq!(entry["actorUsername"], "admin");
        assert_eq!(entry["origin"], "rest");
        assert_eq!(entry["result"], "ok");
    }

    /// (b) A successful item creation is recorded.
    #[tokio::test]
    async fn item_create_is_recorded_in_the_audit_log() {
        let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;

        let create_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items",
                &admin,
                json!({ "name": "Widget", "price": 10, "stock": 1 }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let id = body_json(create_response).await["id"].as_i64().unwrap();

        let list_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(list_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        let entry = rows
            .iter()
            .find(|r| r["action"] == "create" && r["resource"] == "items")
            .unwrap_or_else(|| panic!("expected a create/items entry, got {rows:?}"));
        assert_eq!(entry["actorUsername"], "admin");
        assert_eq!(entry["actorRole"], "admin");
        assert_eq!(entry["entityId"], id.to_string().as_str());
        assert_eq!(entry["origin"], "rest");
        assert_eq!(entry["result"], "ok");
    }

    /// A successful item delete is recorded too (not just create) - a quick
    /// sanity check that every mutation, not just the first one wired up, is
    /// covered.
    #[tokio::test]
    async fn item_delete_is_recorded_in_the_audit_log() {
        let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;

        let create_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items",
                &admin,
                json!({ "name": "Doomed", "price": 1, "stock": 1 }),
            ))
            .await
            .unwrap();
        let id = body_json(create_response).await["id"].as_i64().unwrap();

        router
            .clone()
            .oneshot(delete_auth(&format!("/api/items/{id}"), &admin))
            .await
            .unwrap();

        let list_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(list_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        assert!(
            rows.iter().any(|r| r["action"] == "delete"
                && r["resource"] == "items"
                && r["entityId"] == id.to_string().as_str()),
            "expected a delete/items entry, got {rows:?}"
        );
    }

    /// (c) A viewer's rejected write is recorded as `denied`.
    #[tokio::test]
    async fn viewer_write_denial_is_recorded_as_denied() {
        let (router, _audit, admin, _editor, viewer) = router_with_role_tokens_and_audit().await;

        let response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items",
                &viewer,
                json!({ "name": "Nope", "price": 1, "stock": 1 }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let list_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(list_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        let entry = rows
            .iter()
            .find(|r| r["action"] == "denied" && r["resource"] == "items")
            .unwrap_or_else(|| panic!("expected a denied/items entry, got {rows:?}"));
        assert_eq!(entry["actorUsername"], "viewer");
        assert_eq!(entry["actorRole"], "viewer");
        assert_eq!(entry["result"], "denied");
    }

    /// `users` create/reset-password entries must never leak the plaintext
    /// password into `detail` (spec M14's hard rule - see
    /// `crate::audit`'s module doc comment).
    #[tokio::test]
    async fn users_create_audit_entry_never_contains_the_password() {
        let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;

        router
            .clone()
            .oneshot(post_json_auth(
                "/api/users",
                &admin,
                json!({
                    "username": "newperson",
                    "password": "supersecret1",
                    "displayName": "New Person",
                    "role": "viewer"
                }),
            ))
            .await
            .unwrap();

        let list_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(list_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        let entry = rows
            .iter()
            .find(|r| r["action"] == "create" && r["resource"] == "users")
            .expect("expected a create/users entry");
        assert_eq!(entry["actorUsername"], "admin");
        let detail = entry["detail"].as_str().expect("detail should be set");
        assert!(
            !detail.contains("supersecret1"),
            "audit detail must never contain the password: {detail}"
        );
        assert!(detail.contains("newperson"));
    }

    /// (d) A failed login attempt is recorded as `login_failed`. Uses
    /// `router_with_real_login` (not `router_with_role_tokens_and_audit`)
    /// since it wires `/api/auth/login` through the same
    /// `audited_credential_verifier` production code path.
    #[tokio::test]
    async fn login_failure_is_recorded_as_login_failed() {
        let (router, audit) = router_with_real_login(true).await;
        setup_and_get_token(&router).await; // creates the "owner" admin account

        let response = router
            .oneshot(post_json(
                "/api/auth/login",
                json!({ "username": "owner", "password": "wrong-password" }),
            ))
            .await
            .unwrap();
        assert_eq!(body_json(response).await["success"], false);

        let result = audit.list(ListParams::default()).await.unwrap();
        let entry = result
            .rows
            .iter()
            .find(|r| r.action == "login_failed")
            .unwrap_or_else(|| panic!("expected a login_failed entry, got {:?}", result.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("owner"));
        assert_eq!(entry.actor_role, None);
        assert_eq!(entry.result, "failed");
    }

    #[tokio::test]
    async fn login_success_is_recorded_as_login() {
        let (router, audit) = router_with_real_login(true).await;
        setup_and_get_token(&router).await;

        router
            .clone()
            .oneshot(post_json(
                "/api/auth/login",
                json!({ "username": "owner", "password": "password123" }),
            ))
            .await
            .unwrap();

        let result = audit.list(ListParams::default()).await.unwrap();
        assert!(
            result
                .rows
                .iter()
                .any(|r| r.action == "login" && r.actor_username.as_deref() == Some("owner")),
            "expected a login entry, got {:?}",
            result.rows
        );
    }

    #[tokio::test]
    async fn logout_is_recorded() {
        let (router, audit) = router_with_real_login(true).await;
        let token = setup_and_get_token(&router).await;

        router
            .oneshot(
                HttpRequest::post("/api/auth/logout")
                    .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let result = audit.list(ListParams::default()).await.unwrap();
        assert!(
            result
                .rows
                .iter()
                .any(|r| r.action == "logout" && r.actor_username.as_deref() == Some("owner")),
            "expected a logout entry, got {:?}",
            result.rows
        );
    }

    #[tokio::test]
    async fn setup_is_recorded() {
        let (router, audit) = router_with_real_login(true).await;
        setup_and_get_token(&router).await;

        let result = audit.list(ListParams::default()).await.unwrap();
        assert!(
            result
                .rows
                .iter()
                .any(|r| r.action == "setup" && r.actor_username.as_deref() == Some("owner")),
            "expected a setup entry, got {:?}",
            result.rows
        );
    }

    /// Spec M14 (coordinator review): a self-service password change is a
    /// security event and must be recorded as `password_change` (actor =
    /// entity = the caller) - and the entry must never carry the password.
    #[tokio::test]
    async fn change_password_is_recorded_as_password_change() {
        let (router, audit) = router_with_real_login(true).await;
        let token = setup_and_get_token(&router).await;

        let change_request = HttpRequest::post("/api/auth/change-password")
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "currentPassword": "password123", "newPassword": "newpassword1" })
                    .to_string(),
            ))
            .unwrap();
        let response = router.oneshot(change_request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let result = audit.list(ListParams::default()).await.unwrap();
        let entry = result
            .rows
            .iter()
            .find(|r| r.action == "password_change")
            .unwrap_or_else(|| panic!("expected a password_change entry, got {:?}", result.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("owner"));
        assert_eq!(entry.actor_role.as_deref(), Some("admin"));
        assert_eq!(entry.resource, "users");
        // `setup_first_user` creates the very first row -> id 1.
        assert_eq!(entry.entity_id.as_deref(), Some("1"));
        assert_eq!(entry.origin, "rest");
        assert_eq!(entry.result, "ok");
        assert_eq!(entry.detail, None, "detail must never carry the password");
    }

    // --- M15: CSV import -----------------------------------------------------

    /// `editor` can import: a mixed create+update batch succeeds, and
    /// exactly ONE `action: "import"` audit entry is recorded (spec M15:
    /// "件数サマリ付き1件記録"), with a `{created,updated}` summary detail
    /// and no `entityId` (the entry represents the whole batch, not one
    /// row).
    #[tokio::test]
    async fn editor_can_import_items_and_it_is_recorded_as_one_audit_entry() {
        let (router, _audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;

        let create_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items",
                &admin,
                json!({ "name": "Existing", "price": 10, "stock": 1 }),
            ))
            .await
            .unwrap();
        let existing_id = body_json(create_response).await["id"].as_i64().unwrap();

        let import_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items/import",
                &editor,
                json!([
                    { "id": existing_id, "name": "Updated", "price": 20, "stock": 2 },
                    { "id": null, "name": "Brand New", "price": 30, "stock": 3 }
                ]),
            ))
            .await
            .unwrap();
        assert_eq!(import_response.status(), StatusCode::OK);
        let body = body_json(import_response).await;
        assert_eq!(body["created"], 1);
        assert_eq!(body["updated"], 1);
        assert_eq!(body["errors"], json!([]));

        let list_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(list_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        let import_entries: Vec<_> = rows.iter().filter(|r| r["action"] == "import").collect();
        assert_eq!(
            import_entries.len(),
            1,
            "expected exactly one import entry, got {rows:?}"
        );
        let entry = import_entries[0];
        assert_eq!(entry["actorUsername"], "editor");
        assert_eq!(entry["resource"], "items");
        assert_eq!(entry["entityId"], serde_json::Value::Null);
        assert_eq!(entry["origin"], "rest");
        assert_eq!(entry["result"], "ok");
        let detail: serde_json::Value =
            serde_json::from_str(entry["detail"].as_str().expect("detail should be set")).unwrap();
        assert_eq!(detail, json!({ "created": 1, "updated": 1 }));
    }

    /// `viewer` cannot import (spec M15: editor+ only, same `RoleGuard` as
    /// the other `items` write routes).
    #[tokio::test]
    async fn viewer_cannot_import_items_forbidden_with_forbidden_kind() {
        let (router, _audit, _admin, _editor, viewer) = router_with_role_tokens_and_audit().await;

        let response = router
            .oneshot(post_json_auth(
                "/api/items/import",
                &viewer,
                json!([{ "id": null, "name": "Nope", "price": 1, "stock": 1 }]),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "forbidden");
    }

    /// A batch with a per-row validation error is rolled back entirely - the
    /// valid row in the same batch must NOT land in the DB either - and is
    /// recorded as a single `result: "failed"` audit entry summarizing the
    /// error count (spec M15).
    #[tokio::test]
    async fn items_import_validation_error_rolls_back_and_is_recorded_as_failed() {
        let (router, _audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;

        let import_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items/import",
                &editor,
                json!([
                    { "id": null, "name": "Valid", "price": 10, "stock": 1 },
                    { "id": null, "name": "", "price": 1, "stock": 1 }
                ]),
            ))
            .await
            .unwrap();
        assert_eq!(import_response.status(), StatusCode::OK);
        let body = body_json(import_response).await;
        assert_eq!(body["created"], 0);
        assert_eq!(body["updated"], 0);
        assert_eq!(body["errors"][0]["row"], 1);

        // Nothing from the batch was committed, including the otherwise
        // valid first row (spec M15: all-or-nothing).
        let list_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/items/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        assert_eq!(body_json(list_response).await["totalCount"], 0);

        let audit_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(audit_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        let entry = rows
            .iter()
            .find(|r| r["action"] == "import")
            .unwrap_or_else(|| panic!("expected an import entry, got {rows:?}"));
        assert_eq!(entry["result"], "failed");
        assert_eq!(entry["actorUsername"], "editor");
        let detail: serde_json::Value =
            serde_json::from_str(entry["detail"].as_str().expect("detail should be set")).unwrap();
        assert_eq!(detail, json!({ "errorCount": 1 }));
    }

    // --- M17: SQLite backup/restore -------------------------------------------

    fn post_bytes_auth(path: &str, token: &str, bytes: Vec<u8>) -> HttpRequest<Body> {
        HttpRequest::post(path)
            .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
            .header("Authorization", format!("Bearer {token}"))
            .header("content-type", "application/octet-stream")
            .body(Body::from(bytes))
            .unwrap()
    }

    async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    /// admin can create a backup, see it in the list, and download the exact
    /// same bytes back (spec M17: "バックアップファイルが作成・ダウンロード
    /// でき"). `POST /api/backups` is recorded as `action: "backup"`.
    #[tokio::test]
    async fn admin_can_create_list_and_download_backups() {
        let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

        let create_response = router
            .clone()
            .oneshot(post_bytes_auth("/api/backups", &admin, Vec::new()))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let created = body_json(create_response).await;
        let file_name = created["fileName"].as_str().expect("fileName").to_string();
        assert!(created["sizeBytes"].as_u64().unwrap() > 0);

        let list_response = router
            .clone()
            .oneshot(get_auth("/api/backups", &admin))
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let listed = body_json(list_response).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["fileName"], file_name);

        let download_response = router
            .oneshot(get_auth(&format!("/api/backups/{file_name}"), &admin))
            .await
            .unwrap();
        assert_eq!(download_response.status(), StatusCode::OK);
        let disposition = download_response
            .headers()
            .get(axum::http::header::CONTENT_DISPOSITION)
            .expect("Content-Disposition header")
            .to_str()
            .unwrap()
            .to_string();
        assert!(disposition.contains("attachment"));
        assert!(disposition.contains(&file_name));
        let bytes = body_bytes(download_response).await;
        assert_eq!(&bytes[0..16], b"SQLite format 3\0");
    }

    /// `editor`/`viewer` cannot reach ANY `/api/backups/*` route (spec M17:
    /// "admin以外は全API 403") - checked against both a read route (`GET
    /// /api/backups`) and a write route (`POST /api/backups`).
    #[tokio::test]
    async fn editor_and_viewer_cannot_access_backups_routes() {
        let (router, _dir, _admin, editor, viewer) = router_with_role_tokens_and_backup().await;

        for token in [&editor, &viewer] {
            let list_response = router
                .clone()
                .oneshot(get_auth("/api/backups", token))
                .await
                .unwrap();
            assert_eq!(list_response.status(), StatusCode::FORBIDDEN);
            let json = body_json(list_response).await;
            assert_eq!(json["kind"], "forbidden");

            let create_response = router
                .clone()
                .oneshot(post_bytes_auth("/api/backups", token, Vec::new()))
                .await
                .unwrap();
            assert_eq!(create_response.status(), StatusCode::FORBIDDEN);
        }
    }

    /// Uploading garbage bytes to `/api/backups/restore` must be rejected
    /// (spec M17: "壊れたファイルのリストアが検証で拒否される") - `Validation`
    /// maps to `422` (`banto_server::response::status_for`), and no pending
    /// restore is left staged.
    #[tokio::test]
    async fn restore_upload_of_garbage_bytes_is_rejected_as_validation() {
        let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

        let response = router
            .clone()
            .oneshot(post_bytes_auth(
                "/api/backups/restore",
                &admin,
                b"not a sqlite file".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "validation");

        let pending_response = router
            .oneshot(get_auth("/api/backups/pending-restore", &admin))
            .await
            .unwrap();
        assert_eq!(body_json(pending_response).await, serde_json::Value::Null);
    }

    /// Full stage-from-existing-backup -> cancel round trip (spec M17),
    /// asserting both the `pending-restore` status endpoint AND the
    /// `restore_staged`/`restore_cancelled` audit entries it records.
    #[tokio::test]
    async fn stage_restore_from_existing_backup_then_cancel_is_recorded_in_the_audit_log() {
        let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

        let create_response = router
            .clone()
            .oneshot(post_bytes_auth("/api/backups", &admin, Vec::new()))
            .await
            .unwrap();
        let file_name = body_json(create_response).await["fileName"]
            .as_str()
            .unwrap()
            .to_string();

        let stage_response = router
            .clone()
            .oneshot(post_bytes_auth(
                &format!("/api/backups/{file_name}/restore"),
                &admin,
                Vec::new(),
            ))
            .await
            .unwrap();
        assert_eq!(stage_response.status(), StatusCode::NO_CONTENT);

        let pending_response = router
            .clone()
            .oneshot(get_auth("/api/backups/pending-restore", &admin))
            .await
            .unwrap();
        let pending = body_json(pending_response).await;
        assert!(pending["sizeBytes"].as_u64().unwrap() > 0);

        let cancel_response = router
            .clone()
            .oneshot(delete_auth("/api/backups/pending-restore", &admin))
            .await
            .unwrap();
        assert_eq!(cancel_response.status(), StatusCode::NO_CONTENT);

        let pending_after_cancel = router
            .clone()
            .oneshot(get_auth("/api/backups/pending-restore", &admin))
            .await
            .unwrap();
        assert_eq!(
            body_json(pending_after_cancel).await,
            serde_json::Value::Null
        );

        let audit_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(audit_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();
        assert!(
            rows.iter()
                .any(|r| r["action"] == "backup" && r["resource"] == "backups"),
            "expected a backup entry, got {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|r| r["action"] == "restore_staged" && r["resource"] == "backups"),
            "expected a restore_staged entry, got {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|r| r["action"] == "restore_cancelled" && r["resource"] == "backups"),
            "expected a restore_cancelled entry, got {rows:?}"
        );
    }

    // --- M20: attachments -------------------------------------------------------

    /// Full upload -> list -> download -> thumbnail(404, non-image) -> delete
    /// round trip (spec `docs/attachments-plan.md` §3.5/§5): `editor` writes,
    /// `viewer` reads. Also checks the `Content-Disposition` header carries
    /// both the ASCII `filename=` and RFC 5987 `filename*=` forms.
    #[tokio::test]
    async fn editor_can_upload_list_download_and_delete_an_attachment() {
        let (router, _dir, _admin, editor, viewer) = router_with_role_tokens_and_backup().await;
        let bytes = b"hello attachment".to_vec();

        let upload_response = router
            .clone()
            .oneshot(post_bytes_auth(
                "/api/attachments?resource=items&resourceId=42&fileName=notes.txt",
                &editor,
                bytes.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(upload_response.status(), StatusCode::OK);
        let created = body_json(upload_response).await;
        assert_eq!(created["resource"], "items");
        assert_eq!(created["resourceId"], "42");
        assert_eq!(created["fileName"], "notes.txt");
        assert_eq!(created["mime"], "application/octet-stream");
        assert_eq!(created["sizeBytes"].as_u64().unwrap() as usize, bytes.len());
        assert_eq!(created["hasThumbnail"], false);
        assert_eq!(created["createdBy"], "editor");
        let id = created["id"].as_i64().unwrap();

        let list_response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/attachments/list",
                &viewer,
                json!({ "resource": "items", "resourceId": "42" }),
            ))
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let listed = body_json(list_response).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], id);

        let download_response = router
            .clone()
            .oneshot(get_auth(
                &format!("/api/attachments/{id}/download"),
                &viewer,
            ))
            .await
            .unwrap();
        assert_eq!(download_response.status(), StatusCode::OK);
        let disposition = download_response
            .headers()
            .get(axum::http::header::CONTENT_DISPOSITION)
            .expect("Content-Disposition header")
            .to_str()
            .unwrap()
            .to_string();
        assert!(disposition.contains("attachment"));
        assert!(disposition.contains("filename=\"notes.txt\""));
        assert!(disposition.contains("filename*=UTF-8''notes.txt"));
        let downloaded = body_bytes(download_response).await;
        assert_eq!(downloaded, bytes);

        // Non-image upload: no thumbnail generated, so this 404s (spec §3.5).
        let thumbnail_response = router
            .clone()
            .oneshot(get_auth(
                &format!("/api/attachments/{id}/thumbnail"),
                &viewer,
            ))
            .await
            .unwrap();
        assert_eq!(thumbnail_response.status(), StatusCode::NOT_FOUND);

        let delete_response = router
            .clone()
            .oneshot(delete_auth(&format!("/api/attachments/{id}"), &editor))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

        let list_after_delete = router
            .oneshot(post_json_auth(
                "/api/attachments/list",
                &viewer,
                json!({ "resource": "items", "resourceId": "42" }),
            ))
            .await
            .unwrap();
        let listed_after = body_json(list_after_delete).await;
        assert_eq!(listed_after.as_array().unwrap().len(), 0);
    }

    /// `viewer` cannot upload or delete attachments (spec §3.5: `editor`+
    /// write floor) - both are rejected `403` with `{"kind":"forbidden"}`,
    /// same shape as every other RBAC-guarded write route in this module.
    #[tokio::test]
    async fn viewer_cannot_upload_or_delete_attachments_forbidden_with_forbidden_kind() {
        let (router, _dir, _admin, _editor, viewer) = router_with_role_tokens_and_backup().await;

        let upload_response = router
            .clone()
            .oneshot(post_bytes_auth(
                "/api/attachments?resource=items&resourceId=1&fileName=a.txt",
                &viewer,
                b"x".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(upload_response.status(), StatusCode::FORBIDDEN);
        let json = body_json(upload_response).await;
        assert_eq!(json["kind"], "forbidden");

        let delete_response = router
            .oneshot(delete_auth("/api/attachments/1", &viewer))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::FORBIDDEN);
    }

    /// `POST /api/attachments/list` needs a bearer token, same as every
    /// other `require_auth`-guarded route (spec §3.5: `viewer`+, but
    /// AUTHENTICATED viewer+, not anonymous).
    #[tokio::test]
    async fn attachments_list_route_requires_a_token() {
        let (router, _dir, _admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;
        let response = router
            .oneshot(post_json(
                "/api/attachments/list",
                json!({ "resource": "items", "resourceId": "1" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    /// Downloading/thumbnailing an id that does not exist is a plain `404`
    /// (spec §3.5), same `NotFound` -> `404` mapping every other resource
    /// uses (`banto_server::response::status_for`).
    #[tokio::test]
    async fn nonexistent_attachment_download_and_thumbnail_are_404() {
        let (router, _dir, _admin, _editor, viewer) = router_with_role_tokens_and_backup().await;

        let download_response = router
            .clone()
            .oneshot(get_auth("/api/attachments/999/download", &viewer))
            .await
            .unwrap();
        assert_eq!(download_response.status(), StatusCode::NOT_FOUND);

        let thumbnail_response = router
            .oneshot(get_auth("/api/attachments/999/thumbnail", &viewer))
            .await
            .unwrap();
        assert_eq!(thumbnail_response.status(), StatusCode::NOT_FOUND);
    }

    /// A body over `MAX_ATTACHMENT_BYTES` but still under the router's
    /// `DefaultBodyLimit` (spec §7: 25MB cap, one constant) reaches
    /// `AttachmentsService::upload`'s own size check and is rejected as a
    /// `422` `Validation` error - the same "service-layer limit, not just a
    /// transport-layer one" shape `banto_attachments`'s own crate tests
    /// exercise directly (`upload_rejects_bytes_over_the_max_size`).
    #[tokio::test]
    async fn oversized_attachment_upload_is_rejected_as_validation() {
        let (router, _dir, _admin, editor, _viewer) = router_with_role_tokens_and_backup().await;
        let bytes = vec![0u8; MAX_ATTACHMENT_BYTES + 1];

        let response = router
            .oneshot(post_bytes_auth(
                "/api/attachments?resource=items&resourceId=1&fileName=huge.bin",
                &editor,
                bytes,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let json = body_json(response).await;
        assert_eq!(json["kind"], "validation");
    }

    /// A body beyond even the router's `DefaultBodyLimit` (spec §3.5: cap +
    /// [`ATTACHMENT_BODY_LIMIT_SLACK_BYTES`] slack) never reaches the
    /// handler at all - axum itself rejects it with `413 Payload Too Large`,
    /// the transport-layer counterpart to the service-layer `422` above.
    #[tokio::test]
    async fn attachment_upload_beyond_the_body_limit_is_rejected_with_413() {
        let (router, _dir, _admin, editor, _viewer) = router_with_role_tokens_and_backup().await;
        let bytes = vec![0u8; MAX_ATTACHMENT_BYTES + ATTACHMENT_BODY_LIMIT_SLACK_BYTES + 1];

        let response = router
            .oneshot(post_bytes_auth(
                "/api/attachments?resource=items&resourceId=1&fileName=huge.bin",
                &editor,
                bytes,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// Upload/delete each record exactly one audit entry (spec §3.5:
    /// `action: "create"`/`"delete"`, `resource: "attachments"`, detail
    /// `{fileName,sizeBytes,parentResource,parentId}`) - same "once the
    /// service call has already succeeded" convention as `items`/`backups`.
    #[tokio::test]
    async fn attachment_upload_and_delete_are_recorded_in_the_audit_log() {
        let (router, _dir, admin, editor, _viewer) = router_with_role_tokens_and_backup().await;

        let upload_response = router
            .clone()
            .oneshot(post_bytes_auth(
                "/api/attachments?resource=items&resourceId=7&fileName=photo.bin",
                &editor,
                b"binary".to_vec(),
            ))
            .await
            .unwrap();
        let id = body_json(upload_response).await["id"].as_i64().unwrap();

        router
            .clone()
            .oneshot(delete_auth(&format!("/api/attachments/{id}"), &editor))
            .await
            .unwrap();

        let audit_response = router
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                &admin,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        let rows = body_json(audit_response).await["rows"].clone();
        let rows = rows.as_array().unwrap();

        let create_entry = rows
            .iter()
            .find(|r| r["action"] == "create" && r["resource"] == "attachments")
            .unwrap_or_else(|| panic!("expected a create entry, got {rows:?}"));
        assert_eq!(create_entry["actorUsername"], "editor");
        let create_detail: serde_json::Value = serde_json::from_str(
            create_entry["detail"]
                .as_str()
                .expect("detail should be set"),
        )
        .unwrap();
        assert_eq!(create_detail["fileName"], "photo.bin");
        assert_eq!(create_detail["parentResource"], "items");
        assert_eq!(create_detail["parentId"], "7");

        let delete_entry = rows
            .iter()
            .find(|r| r["action"] == "delete" && r["resource"] == "attachments")
            .unwrap_or_else(|| panic!("expected a delete entry, got {rows:?}"));
        let delete_detail: serde_json::Value = serde_json::from_str(
            delete_entry["detail"]
                .as_str()
                .expect("detail should be set"),
        )
        .unwrap();
        assert_eq!(delete_detail["fileName"], "photo.bin");
    }

    /// Upload/delete each broadcast `ServerEvent::ResourceChanged { resource:
    /// "attachments" }` (spec §3.5) - `AttachmentsService` itself has no
    /// `ServerEvent` awareness (see this module's doc comment), so this
    /// checks the handler-level wiring directly, mirroring `items`'s own
    /// `update_via_rest_is_observable_on_the_event_channel`.
    #[tokio::test]
    async fn attachment_upload_and_delete_are_observable_on_the_event_channel() {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, mut rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool.clone());
        let settings = SettingsService::new(pool.clone());
        let backup = unused_backup_service(pool.clone());
        let dir = tempdir().expect("tempdir");
        let attachments = AttachmentsService::new(pool.clone(), dir.path().join("attachments"));
        let audit = AuditLogService::new(pool);
        let auth = demo_auth();
        let token = auth.login("admin", "admin").await.unwrap();
        let router = api_router(
            items,
            users,
            settings,
            audit,
            backup,
            attachments,
            auth,
            tx,
            false,
        );

        let upload_response = router
            .clone()
            .oneshot(post_bytes_auth(
                "/api/attachments?resource=items&resourceId=1&fileName=note.txt",
                &token,
                b"hello".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(upload_response.status(), StatusCode::OK);
        rx.try_recv().expect("upload should emit an event");
        let id = body_json(upload_response).await["id"].as_i64().unwrap();

        router
            .oneshot(delete_auth(&format!("/api/attachments/{id}"), &token))
            .await
            .unwrap();
        let event = rx.try_recv().expect("delete should emit an event");
        assert!(
            matches!(event, ServerEvent::ResourceChanged { resource } if resource == "attachments")
        );
    }
}
