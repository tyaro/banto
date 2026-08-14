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
//! | GET    | `/api/system/info`   | -              | `SystemInfo` (admin, M-review 2026-08 §2.4) |
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
//! ## Where each router lives (theme C PR-C4, docs/template-scope.md §7 移行順 ④)
//!
//! The table above stays here - it is the artifact conventions §1 designates
//! as the REST side of the Tauri⇔REST correspondence table, and
//! `scripts/verify-architecture.mjs` rule 8 anchors on it. The router
//! IMPLEMENTATIONS, however, are split by who owns them:
//!
//! - App-specific, and therefore this crate's: `items` (`/api/items/*`,
//!   the demo resource a template adopter replaces) and `attachments`
//!   (`/api/attachments/*`, M20 - `resource`/`resourceId` are app data).
//! - Domain-agnostic, and therefore `banto_server::routes`: the
//!   `/api/auth/*` extras, `/api/users/*`, `/api/audit-log/*`,
//!   `/api/backups/*` and `/api/ui-settings/*`. Identical in every adopter,
//!   so they are a dependency rather than copied code. The RBAC/audit
//!   helpers the app's own routers use ([`RoleGuard`],
//!   [`require_role_at_least`], [`record_write`], [`actor_identity`]) come
//!   from there too.
//!
//! [`api_router`] below is the assembly: it owns the `.merge()` order,
//! the CSRF layer, and nothing else.
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
//! [`banto_server::Identity`], parses `Identity.role` into [`Role`], and rejects with
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
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment, MAX_ATTACHMENT_BYTES};
use banto_core::{BantoError, ListParams, ListResult};
use banto_server::routes::{
    actor_identity, audit_log_router, audit_logout_middleware, backups_router, extra_auth_router,
    record_write, require_role_at_least, system_info_router, ui_settings_router, users_router,
    LogoutAuditState, RoleGuard,
};
use banto_server::{
    auth_routes, require_auth, require_banto_client_header, sse_route, ApiError, AuthState,
    ServerEvent,
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;

use crate::audit::{AuditEntry, AuditLogService};
use crate::backup::BackupService;
use crate::items::{ImportResult, Item, ItemImportRow, ItemInput, ItemsService};
use crate::settings::SettingsService;
use crate::system_info::SystemInfoService;
use crate::users::{Role, UsersService};

mod attachments;
mod items;
#[cfg(test)]
mod tests;

// Theme C PR-C4 (docs/template-scope.md §7 移行順 ④): re-exported so
// `admin_template_core::rest::audited_credential_verifier` - the path
// `bin/banto-serve.rs` and `src-tauri`'s `run()` already use - keeps
// resolving unchanged now that the function itself lives in
// `banto_server::routes::audit`.
pub use banto_server::routes::audited_credential_verifier;

use attachments::attachments_router;
use items::items_router;

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

/// The already-cloneable service handles [`api_router`] threads into its
/// route builders (spec §11.1). Bundled into one struct (M-review 2026-08
/// M-13) so adding a service is a single field here rather than a new
/// positional parameter rippled through every `api_router` call site
/// (`bin/banto-serve.rs`, `src-tauri`'s `start_embedded_server`, and the
/// six `rest::tests` router helpers). `scaffold.mjs`'s attachments remover
/// likewise drops one named field instead of a position-dependent argument
/// slot. Every field is an independent handle over the same pool - no
/// ordering or lifetime relationship between them, so the caller may build
/// this in any order.
pub struct Services {
    pub items: ItemsService,
    pub users: UsersService,
    pub settings: SettingsService,
    pub audit: AuditLogService,
    pub backup: BackupService,
    pub attachments: AttachmentsService,
    pub system_info: SystemInfoService,
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
pub fn api_router(
    services: Services,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
    allow_setup: bool,
) -> Router {
    let Services {
        items,
        users,
        settings,
        audit,
        backup,
        attachments,
        system_info,
    } = services;

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
        .merge(items_router(
            items,
            audit.clone(),
            auth.clone(),
            attachments.clone(),
        ))
        .merge(users_router(users, audit.clone(), auth.clone()))
        .merge(audit_log_router(
            audit.clone(),
            settings.clone(),
            auth.clone(),
        ))
        .merge(backups_router(backup, audit.clone(), auth.clone()))
        .merge(system_info_router(system_info, auth.clone(), audit.clone()))
        .merge(attachments_router(attachments, audit, auth.clone(), events))
        .merge(ui_settings_router(settings, auth))
        .layer(middleware::from_fn(require_banto_client_header))
}
