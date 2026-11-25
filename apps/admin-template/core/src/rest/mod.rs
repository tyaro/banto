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
//! | GET    | `/api/auth/status`   | -              | `{grants}` (NO auth required) |
//! | POST   | `/api/auth/grant/{kind}` | -          | `{success,token}` (NO auth required; 404 unless `kind` is registered, 403 unless its condition holds - `publicViewer` = `server.viewer_public`, ADR-0017) |
//! | POST   | `/api/reach-check`   | `{token}`      | `{result}` (NO auth required, never a session; Tauri embedded server only - `banto_server::reach_check`, Issue #219) |
//! | POST   | `/api/auth/login`    | `{username,password}` | `{success,error?,token?}` |
//! | POST   | `/api/auth/logout`   | -              | 200                    |
//! | GET    | `/api/auth/check`    | -              | `bool`                 |
//! | GET    | `/api/auth/identity` | -              | `Identity \| null` (`permissions` included, #697) |
//! | POST   | `/api/auth/change-password` | `{currentPassword,newPassword}` | `{success}` (auth required) |
//! | GET    | `/api/events`        | -              | SSE stream of `ServerEvent` |
//! | GET    | `/api/login-notice`  | -              | `{notice}` (NO auth required) |
//! | PUT    | `/api/login-notice`  | `{notice}`     | `{notice}` (admin) |
// [scaffold:items] begin (Route table doc rows)
//! | POST   | `/api/items/list`    | `ListParams`   | `ListResult<Item>` (any role) |
//! | GET    | `/api/items/{id}`    | -              | `Item` (any role)      |
//! | POST   | `/api/items`         | `ItemInput`    | `Item` (editor+)        |
//! | PUT    | `/api/items/{id}`    | `ItemInput`    | `Item` (editor+)        |
//! | DELETE | `/api/items/{id}`    | -              | 204 (editor+)           |
//! | POST   | `/api/items/import`  | `ItemImportRow[]` | `ImportResult` (editor+, spec M15) |
//! | POST   | `/api/items/bulk-delete` | `{ kind: "ids", items }` | `{ deleted }` (editor+, Issue #713) |
// [scaffold:items] end
// [banto:add-resource:route-table]
//! | GET    | `/api/users`         | -              | `UserSummary[]` (admin) |
//! | POST   | `/api/users`         | `{username,password,displayName,role}` | `UserIdentityView` (admin) |
//! | PUT    | `/api/users/{id}`    | `{displayName,role,version?,permissions?}` | `UserSummary` (admin; stale `version` -> 409, #651; unknown permission -> 422, #697) |
//! | POST   | `/api/users/{id}/reset-password` | `{newPassword}` | `{success}` (admin) |
//! | DELETE | `/api/users/{id}?version=` | -        | 204 (admin; stale `version` -> 409, #651) |
//! | GET    | `/api/permissions`   | -              | `PermissionEntry[]` (admin; the app's catalog, #697) |
//! | GET    | `/api/ui-settings/{key}` | -          | `{value: string \| null, revision}` (any role; `revision` is `"0"` when nothing is stored, #786) |
//! | PUT    | `/api/ui-settings/{key}` | `{value,ifRevision?}` | `{revision}` (any role; stale `ifRevision` -> 409 with `current: {value,revision}`, #786) |
//! | DELETE | `/api/ui-settings/{key}?ifRevision=` | - | `{revision: "0"}` (any role; stale `ifRevision` -> 409, #786) |
//! | POST   | `/api/audit-log/list?asOfId=` | `ListParams` | `AuditLogList` (`ListResult` + `asOfId`/`deletionEpoch`, admin; #248) |
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
// [scaffold:config-drafts] begin (Route table doc rows)
//! | GET    | `/api/config`        | -              | `ConfigTargetSummary[]` (admin; no values, #938) |
//! | GET    | `/api/config/{target}` | -            | `ConfigState` (`{target,published,draft,lock,lockIsMine}`, admin) |
//! | GET    | `/api/config/{target}/diff?toVersion=` | - | `ConfigDiff` (admin; published -> draft, or -> that version) |
//! | GET    | `/api/config/{target}/history?before=&limit=` | - | `ConfigHistoryEntry[]` (admin; newest first, no values) |
//! | GET    | `/api/config/{target}/history/{version}` | - | `ConfigHistoryDetail` (admin) |
//! | POST   | `/api/config/{target}/lock` | -       | `ConfigLock` (admin; a new lease) |
//! | PUT    | `/api/config/{target}/lock` | `{lease}` | `ConfigLock` (admin; expired -> 409) |
//! | DELETE | `/api/config/{target}/lock?lease=` | - | 204 (admin) |
//! | PUT    | `/api/config/{target}/draft` | `{value,ifRevision,ifPublishedRevision?}` | `ConfigDraftSaved` (admin; not audited) |
//! | POST   | `/api/config/{target}/draft/rebase` | `{ifRevision,ifPublishedRevision}` | `ConfigDraftSaved` (admin; not audited) |
//! | DELETE | `/api/config/{target}/draft?ifRevision=` | - | `{revision: "0"}` (admin) |
//! | POST   | `/api/config/{target}/publish` | `{ifDraftRevision,comment?}` | `PublishOutcome` (admin) |
//! | POST   | `/api/config/{target}/revert` | `{toVersion,ifPublishedRevision,comment?}` | `PublishOutcome` (admin) |
//! | POST   | `/api/config/{target}/unlock` | `{ifLease}` | 204 (admin) |
// [scaffold:config-drafts] end
//!
//! ## Where each router lives (theme C PR-C4, docs/template-scope.md §7 移行順 ④)
//!
//! There is no generic global `/api/settings/{key}` route. The only generic
//! settings endpoint is `/api/ui-settings/{key}`, which writes to the caller's
//! own rows of `ui_settings`; it cannot replace `login.notice`.
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
//!   [`require_role_at_least`], [`record_write`],
//!   `banto_server::routes::recheck_role_at_least`) come from there too.
//!
//! [`api_router`] below is the assembly: it owns the `.merge()` order,
//! the CSRF layer, and nothing else.
//!
//! `/api/ui-settings/*` (spec M12 SettingsProvider migration, Issue #786):
//! per-owner UI settings (theme/preset/dock layout) in the `ui_settings`
//! table, owned by the caller's own session - an account by its `users.id`,
//! a grant session by its kind (`banto_admin_services::ui_settings`, plan
//! §4.4, ADR-0034 §8). `GET` answers `{ value, revision }`; `PUT`
//! (`{ value, ifRevision? }`) and `DELETE` (`?ifRevision=`) answer
//! `{ revision }` and, when `ifRevision` no longer matches, `409` with the
//! `conflict` body whose `current` is the stored `{ value, revision }`.
//! Guarded by `require_auth` alone - unlike `items`/`users`, there is no
//! role floor: a `viewer` may freely read/write their OWN UI preferences,
//! they just cannot touch anyone else's (there is no way to name another
//! owner over this wire - the owner always comes from the session the
//! caller's own bearer token resolved to, never a request parameter).
// [scaffold:config-drafts] begin (doc)
//!
//! `/api/config/*` (Issue #938, `docs/design/config-draft-publish-design.md`
//! §4.9-§4.11): edit a draft of a config target, publish it, go back to an
//! earlier version. The router is `banto_server::routes::config_drafts_router`
//! and is NOT assembled by [`api_router`]: [`config_router`] mounts it, and
//! the two servers merge that next to `api_router` (like
//! [`resources_router`]), so the option comes off without touching
//! [`Services`]. Its four gates are [`config_drafts_access`] - the ONE value
//! both the router and `src-tauri`'s `config_*` commands judge by. The
//! template registers no target (`crate::config_targets`), so the list is
//! empty and every `{target}` is `404` until a derived app registers one.
//! Audited (`resource: "config"`): `publish`, `revert`, `unlock` and a
//! `discard` that removed a draft; saving a draft and the lock calls are not.
// [scaffold:config-drafts] end
//!
//! `/api/auth/status` and `/api/auth/grant/{kind}` are deliberately NOT
//! behind `require_auth` - the login page needs `status` before any session
//! exists, and `grant/{kind}` is how a credential-less session (ADR-0017)
//! obtains its first token. There is no route that creates the first account
//! (ADR-0034 §5/§7): a new database starts in no-login mode, where this
//! surface is read-only and logs nobody in, and the first administrator of a
//! headless install is created offline by `banto-serve create-admin`.
//! `grant/{kind}` carries its own gate instead of a bearer token, the
//! registered `GrantSpec`'s condition: the template registers only the viewer-public
//! kind, whose condition is the `server.viewer_public` setting, so
//! `grant/publicViewer` returns `403 { "kind": "forbidden" }` unless 閲覧公開
//! is explicitly on (Issue #189, ADR-0012, `docs/design/viewer-public-plan.md`
//! §2.2; `banto-serve` seeds the setting via `BANTO_VIEWER_PUBLIC=1`), and
//! any other kind is `404`. The token a grant returns is an ordinary bearer
//! token for the spec's fixed identity (`{ id: "public", role: "viewer" }`
//! for viewer-public), so everything after that point - `require_auth`,
//! [`require_role_at_least`], the audit trail - treats it exactly like any
//! other session of that role, and a mutating request made with a viewer
//! grant is rejected `403` and recorded as `denied` with actor `public`.
//! Issuance itself is not audited (see `banto_server::grant`).
//!
//! `POST /api/reach-check` (Issue #219 stage 1,
//! `docs/design/lan-reach-check-design.md`) is the other route outside
//! `require_auth`, and it is NOT assembled by [`api_router`]: `src-tauri`'s
//! `start_embedded_server` merges `banto_server::reach_check_router` next to
//! it, bound to that listener's generation and port (`banto-serve` has no
//! screen to issue tokens and does not mount it). It checks a one-time token
//! the administrator's screen issued, records that another device reached
//! the listener, and answers `{ "result": "<code>" }` only - it never issues a
//! session, so every other route stays `401` afterwards. It carries its own
//! `X-Banto-Client` check because it sits outside this router's CSRF layer.
//! Neither issuance nor reach is audited (an uncredentialed route must not
//! amplify the audit log, conventions §1 / Issue #278).
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
//! `logout`. Read routes
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
//! `/api/attachments/*` (spec `docs/design/attachments-plan.md` §3.5, M20 unit B):
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
    audit_log_router, audit_logout_middleware, backups_router, extra_auth_router, record_write,
    require_role_at_least, system_info_router, ui_settings_router, users_router, AuditActor,
    LogoutAuditState, MetricsProbe, RoleGuard,
};
use banto_server::{
    auth_routes, require_auth, require_banto_client_header, sse_route, ApiError, AuthState,
    GrantRegistry, GrantSpec, ServerEvent,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::broadcast;
// [scaffold:config-drafts] begin
use banto_admin_services::config_drafts::ConfigDraftsService;
use banto_server::routes::{config_drafts_router, ConfigDraftsAccess, ConfigDraftsGate};
// [scaffold:config-drafts] end

use crate::audit::AuditLogService;
use crate::backup::BackupService;
use crate::resources::AppResources;
// [scaffold:items] begin
use crate::items::{ImportResult, Item, ItemImportRow, ItemInput, ItemsService};
// [scaffold:items] end
use crate::settings::SettingsService;
use crate::system_info::SystemInfoService;
use crate::users::{Role, UsersService};

mod attachments;
mod login_notice;
// [scaffold:items] begin
mod items;
// [scaffold:items] end
// [banto:add-resource:rest-mod]
#[cfg(test)]
mod tests;

// Theme C PR-C4 (docs/template-scope.md §7 移行順 ④): re-exported so
// `admin_template_core::rest::audited_credential_verifier` - the path
// `bin/banto-serve.rs` and `src-tauri`'s `run()` already use - keeps
// resolving unchanged now that the function itself lives in
// `banto_server::routes::audit`.
pub use banto_server::routes::audited_credential_verifier;
// Issue #204: the REST `AuthState` with session revocation wired in
// (`audited_credential_verifier` + the per-request account re-check).
// `bin/banto-serve.rs` and `src-tauri`'s `run()` build their state with it.
pub use banto_server::routes::user_auth_state;

use attachments::attachments_router;
use login_notice::login_notice_router;
// [scaffold:items] begin
use items::items_router;
// [scaffold:items] end

/// Slack added on top of `banto_attachments::MAX_ATTACHMENT_BYTES` for
/// [`attachments_write_router`]'s `DefaultBodyLimit` (spec
/// `docs/design/attachments-plan.md` §3.5): the limit that actually matters is the
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
    // [scaffold:items] begin
    pub items: ItemsService,
    // [scaffold:items] end
    pub users: UsersService,
    pub settings: SettingsService,
    pub audit: AuditLogService,
    pub backup: BackupService,
    pub attachments: AttachmentsService,
    pub system_info: SystemInfoService,
    /// CPU/memory probe (ADR-0013, Issue #185), or `None` when the
    /// `system-metrics` feature is off (or the host platform is
    /// unsupported) - the app layer builds the `Some` case, see
    /// `bin/banto-serve.rs`/`src-tauri`'s `start_embedded_server`. This
    /// struct/`api_router` do not know about the `sysinfo` feature at all;
    /// they only pass the already-type-erased closure through to
    /// [`system_info_router`].
    pub metrics: Option<MetricsProbe>,
}

/// ADR-0017: the grant kinds this app issues without credentials - THE list,
/// read by [`api_router`] (which issues them) and by
/// [`crate::startup::reserved_usernames`] (which reserves their fixed ids as
/// account names, ADR-0034 §4).
///
/// The template has exactly one - viewer-public (`server.viewer_public`, read
/// live on every request so the settings screen's toggle takes effect without
/// a restart). `GET /api/auth/status` reports its availability as
/// `grants.publicViewer` and `POST /api/auth/grant/publicViewer` issues it.
///
/// A derived app registers its own kinds here (e.g. a commissioning grant
/// with `require_loopback_peer: true`), and decides per kind whether its
/// sessions are recorded in the audit log as the built-in `admin`'s
/// (`GrantSpec::audit_as_builtin_admin`, ADR-0034 §3). A fixed id added here
/// must not be the name of an existing account: the next startup stops with
/// a message naming it ([`crate::startup::check`]).
pub fn grant_registry(settings: SettingsService) -> GrantRegistry {
    let mut grants = GrantRegistry::new();
    grants
        .register(GrantSpec::public_viewer(settings))
        .expect("the viewer-public grant registers on an empty registry");
    grants
}

/// Compose the full `/api/*` router (spec §11.1): auth routes (login/
/// logout/check/identity from `banto_server` - wrapped with an audit-log
/// hook for `logout`, spec M14 - plus status/change-password here
/// since those need `UsersService`), SSE events, the `items` CRUD routes
/// (RBAC-split read/write, spec M10), the `admin`-only `users` management
/// routes (spec M10), the `admin`-only `audit-log` viewer (spec M14), the
/// `admin`-only `backups` routes (spec M17), the `attachments` CRUD routes
/// (RBAC-split read/write, spec `docs/design/attachments-plan.md` §3.5 M20 unit
/// B), and the per-user `ui-settings` routes (spec M12), all behind the
/// CSRF header check. Mount the result *before*
/// `banto_server::static_files::static_router` so `/api/*` takes priority
/// over the SPA fallback.
pub fn api_router(
    services: Services,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    let Services {
        // [scaffold:items] begin
        items,
        // [scaffold:items] end
        users,
        settings,
        audit,
        backup,
        attachments,
        system_info,
        metrics,
    } = services;

    let audited_auth_routes = auth_routes(auth.clone()).layer(middleware::from_fn_with_state(
        LogoutAuditState {
            auth: auth.clone(),
            audit: audit.clone(),
        },
        audit_logout_middleware,
    ));

    // `None` extras - the template itself adds no app-specific `status`
    // fields (`banto_server::AuthStatusExtras` is the hook an adopter fills
    // in here).
    let grants = grant_registry(settings.clone());

    Router::new()
        .merge(audited_auth_routes)
        .merge(extra_auth_router(
            users.clone(),
            auth.clone(),
            audit.clone(),
            Arc::new(grants),
            None,
        ))
        .merge(sse_route(auth.clone(), events.clone()))
        // [scaffold:items] begin
        .merge(items_router(
            items.clone(),
            audit.clone(),
            auth.clone(),
            attachments.clone(),
        ))
        // [scaffold:items] end
        .merge(users_router(users, audit.clone(), auth.clone()))
        .merge(audit_log_router(
            audit.clone(),
            settings.clone(),
            auth.clone(),
        ))
        .merge(backups_router(backup, audit.clone(), auth.clone()))
        .merge(system_info_router(
            system_info,
            auth.clone(),
            audit.clone(),
            metrics,
        ))
        .merge(login_notice_router(
            settings.clone(),
            audit.clone(),
            auth.clone(),
        ))
        .merge(attachments_router(
            attachments,
            items,
            audit,
            auth.clone(),
            events,
        ))
        .merge(ui_settings_router(settings, auth))
        .layer(middleware::from_fn(require_banto_client_header))
}

/// The routes of the resources added by `pnpm banto add resource`
/// (docs/recipes/add-resource.md, Issue #715), behind the same CSRF header
/// check as [`api_router`]. Kept apart from `api_router` so a new resource
/// does not change [`Services`] and its call sites: the two servers
/// (`bin/banto-serve.rs`, `src-tauri`'s `start_embedded_server`) merge this
/// next to `api_router`. Each generated `<name>_router` layers its own
/// `require_auth` / `RoleGuard`, like `items_router`. Empty until the first
/// resource is added.
pub fn resources_router(
    resources: AppResources,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    // Nothing reads these until the first resource is added.
    let _ = (&resources, &audit, &auth);
    Router::new()
        // [banto:add-resource:rest-routers]
        .layer(middleware::from_fn(require_banto_client_header))
}
// [scaffold:config-drafts] begin

/// Who may do what on `/api/config/*` (design §4.9): the ONE value both
/// paths judge by - [`config_router`] hands it to the REST router, and
/// `src-tauri`'s `require_config` applies the same gates to the `config_*`
/// commands (conventions §1). All four duties are written out (never
/// `ConfigDraftsAccess::default()`): `verify:architecture` rule 8 reads the
/// role floors and the permissions of the two paths from this literal.
///
/// `read` is also a condition of the other three. A derived app that
/// separates "who edits" from "who publishes" registers permissions
/// (`crate::permission_catalog`) and writes e.g.
/// `edit: ConfigDraftsGate::Permission(perms::config_edit())`; rule 8 then
/// wants the pairs in `PERMISSION_PAIRS` (and the `role` of the `DUAL_PATH` /
/// `ROLE_READ` rows to match the role gates).
pub fn config_drafts_access() -> ConfigDraftsAccess {
    ConfigDraftsAccess {
        read: ConfigDraftsGate::Role(Role::Admin),
        edit: ConfigDraftsGate::Role(Role::Admin),
        publish: ConfigDraftsGate::Role(Role::Admin),
        unlock: ConfigDraftsGate::Role(Role::Admin),
    }
}

/// `/api/config/*` (Issue #938, design §4.11), behind the same CSRF header
/// check as [`api_router`]. Kept apart from `api_router` (like
/// [`resources_router`]) so the option does not change [`Services`] and its
/// call sites: the two servers (`bin/banto-serve.rs`, `src-tauri`'s
/// `start_embedded_server`) merge this next to `api_router`. `service` is the
/// one `crate::open_config_drafts` built at startup; `events` is the sender
/// `/api/events` is fed from. The layers inside
/// (`require_auth` -> the read gate -> the duty's gate) are
/// `config_drafts_router`'s own.
pub fn config_router(
    service: ConfigDraftsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    config_drafts_router(service, config_drafts_access(), audit, auth, events)
        .layer(middleware::from_fn(require_banto_client_header))
}
// [scaffold:config-drafts] end
