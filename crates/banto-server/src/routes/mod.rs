//! Domain-agnostic REST routers (docs/template-scope.md §7 移行順 ④, theme C
//! PR-C4): the `/api/auth/*` extras, `/api/users/*`, `/api/audit-log/*`,
//! `/api/backups/*`, `/api/ui-settings/*` and `/api/config/*` (Issue #938)
//! sub-routers, plus the RBAC/audit
//! wiring helpers they share with the app's own routers.
//!
//! These used to live in `admin-template-core::rest` - i.e. in the surface a
//! template adopter copies and then owns forever. Nothing here mentions
//! `items` (or any other app resource), so it is exactly the slice that
//! should be a dependency instead: an adopter keeps `/api/items/*` and the
//! `api_router` assembly (the `.merge()` calls) and gets everything below
//! for free.
//!
//! The routers are pure wiring: they take already-built
//! [`banto_admin_services`] service handles plus this crate's
//! [`AuthState`] and return `Router<()>` (handlers close
//! over their state - see this crate's module doc comment), so the app's
//! `api_router` can `.merge()` them without state-type conflicts. The
//! services themselves stay axum-free (conventions §2); authorization
//! ([`RoleGuard`]/[`require_role_at_least`], spec M10; the per-user
//! [`PermissionGuard`]/[`require_permission`], Issue #697) and audit
//! recording ([`record_write`], spec M14) are added here.
//!
//! ## Both-paths symmetry (conventions §1)
//!
//! The route table these routers implement is documented in
//! `admin-template-core::rest`'s module doc comment (the artifact §1 names
//! as the REST side of the Tauri⇔REST correspondence table), and
//! `scripts/verify-architecture.mjs` rule 8 cross-checks that doc against
//! the actual `.route("…")` declarations here as well as in the app's
//! `rest/` directory. Moving a router between the two directories is
//! therefore invisible to that check by design - what must never change is
//! the method+path+role floor of each route.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
pub use banto_admin_services::audit::AuditActor;
use banto_admin_services::audit::{AuditEntry, AuditLogService};
use banto_admin_services::backup::{BackupInfo, BackupService, PendingRestoreInfo};
use banto_admin_services::permissions::{PermissionEntry, PermissionKey};
use banto_admin_services::settings::{AuditSettings, SettingsService};
use banto_admin_services::users::{
    Role, UserIdentity, UserIdentityView, UserSummary, UsersService,
};
use banto_core::{BantoError, ErrorBody, ListParams};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::str::FromStr;

use crate::{
    require_auth, ApiError, AuthState, AuthenticatedSession, Identity, SessionAccount,
    SessionPermissions, SessionStamp, SessionValidation,
};

mod audit;
mod auth;
mod backups;
mod config_drafts;
mod system_info;
mod ui_settings;
mod users;

pub use audit::{
    audit_log_router, audit_logout_middleware, audited_credential_verifier, user_auth_state,
    user_permission_reader, user_session_lookup, LogoutAuditState,
};
pub use auth::{extra_auth_router, AuthStatusExtras};
pub use backups::backups_router;
pub use config_drafts::{
    config_changed_event, config_draft_changed_event, config_drafts_router, ConfigDraftsAccess,
    ConfigDraftsGate, DEFAULT_CONFIG_HISTORY_PAGE,
};
pub use system_info::{system_info_router, MetricsProbe, SystemInfo, SystemMetrics};
pub use ui_settings::ui_settings_router;
pub use users::{
    list_users_with_permissions, permission_catalog_entries, users_router, UserWithPermissions,
};

/// Extract the raw bearer token from an `Authorization: Bearer …` header.
/// Every RBAC/audit helper below starts here; the app's own routers
/// (`items`/`attachments`) take the guard's `Extension<AuditActor>` and call
/// [`record_write`] instead.
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// The audit actor of a session the guards did NOT hand over (ADR-0034
/// section 3): validates the request's bearer token NOW and attributes the
/// session it finds ([`AuthState::audit_actor`]).
///
/// Almost nothing needs this. A handler behind [`require_auth`] takes the
/// snapshot the guard made - `Extension<AuditActor>` - and passes it to
/// [`record_write`]; that snapshot is the session that was AUTHORIZED, and it
/// is still there after the session ended. This function is for the few
/// places that run without a guard (the logout hook reads the actor BEFORE
/// the handler drops the token). `None` when there is no valid session.
pub fn actor_for_token(headers: &HeaderMap, auth: &AuthState) -> Option<AuditActor> {
    let session = bearer_token(headers).and_then(|token| auth.session_for(token))?;
    Some(auth.audit_actor(&session))
}

/// Record one audit row attributed to `actor` (`None` = no actor: the four
/// actor columns are NULL) through `origin` (`"rest"`, `"tauri"`, `"mcp"`,
/// ...) with an explicit `result` (`"ok"`, `"denied"`, `"failed"`). The one
/// builder behind [`record_write_as`] / [`record_denied_as`], and what a
/// handler calls directly when its row fits neither (an import that failed, a
/// refusal that is not a role decision). Every channel - REST, the desktop
/// commands, an app's own - writes its rows through these, so the columns
/// cannot drift (conventions section 1).
#[allow(clippy::too_many_arguments)]
pub async fn record_as(
    audit: &AuditLogService,
    actor: Option<&AuditActor>,
    origin: &str,
    action: &str,
    resource: &str,
    entity_id: Option<&str>,
    detail: Option<serde_json::Value>,
    result: &str,
) {
    audit
        .record(AuditEntry::by(
            actor, origin, action, resource, entity_id, detail, result,
        ))
        .await;
}

/// Record a successful write (spec M14) attributed to `actor` through
/// `origin`. `result` is `"ok"`.
pub async fn record_write_as(
    audit: &AuditLogService,
    actor: Option<&AuditActor>,
    origin: &str,
    action: &str,
    resource: &str,
    entity_id: Option<&str>,
    detail: Option<serde_json::Value>,
) {
    record_as(
        audit, actor, origin, action, resource, entity_id, detail, "ok",
    )
    .await;
}

/// Record an RBAC denial (spec M14) in the shape [`require_role_at_least`]
/// writes: `action` `"denied"`, no `entity_id`, `result` `"denied"`. The
/// caller supplies the `detail` (REST: `{ "method", "path" }`; the desktop
/// commands: none).
pub async fn record_denied_as(
    audit: &AuditLogService,
    actor: &AuditActor,
    origin: &str,
    resource: &str,
    detail: Option<serde_json::Value>,
) {
    record_as(
        audit,
        Some(actor),
        origin,
        "denied",
        resource,
        None,
        detail,
        "denied",
    )
    .await;
}

/// Record a failed login (spec M14): `action` `"login_failed"`, `result`
/// `"failed"`. There is no session, so there is no actor - only the name
/// that was TRIED goes into `actor_username` (bounded, Issue #278: it is
/// attacker-supplied), with `actor_id` / `actor_role` / `actor_kind` NULL.
/// `detail` says how it was tried when that is not the login form (the
/// desktop autologin: `{ "via": "autologin" }`); never a password.
pub async fn record_login_failed_as(
    audit: &AuditLogService,
    origin: &str,
    username: &str,
    detail: Option<serde_json::Value>,
) {
    let bounded = banto_admin_services::users::bound_username_for_audit(username);
    audit
        .record(AuditEntry {
            actor_username: Some(&bounded),
            ..AuditEntry::by(None, origin, "login_failed", "auth", None, detail, "failed")
        })
        .await;
}

/// Record a successful REST write (spec M14: create/update/delete/
/// password_reset etc.) once the service call it follows has succeeded.
/// `actor` is the snapshot [`require_auth`] made when it authorized the
/// request - a handler takes it with `Extension<AuditActor>` (ADR-0034
/// section 3). `origin` is `"rest"`; another channel uses [`record_write_as`].
///
/// v8.0.0: this used to take the `AuthState` and the request headers and look
/// the bearer token up again here, AFTER the write - a session that ended
/// while the write ran left a row with no actor. It no longer reads anything.
pub async fn record_write(
    audit: &AuditLogService,
    actor: &AuditActor,
    action: &str,
    resource: &str,
    entity_id: Option<&str>,
    detail: Option<serde_json::Value>,
) {
    record_write_as(
        audit,
        Some(actor),
        "rest",
        action,
        resource,
        entity_id,
        detail,
    )
    .await;
}

/// `State` for [`require_role_at_least`]: the [`AuthState`] needed to resolve
/// a bearer token back to an [`Identity`], the minimum [`Role`] the guarded
/// routes require, the `resource` name to tag a denial with (spec M14), and
/// the [`AuditLogService`] to record that denial to.
#[derive(Clone)]
pub struct RoleGuard {
    pub auth: AuthState,
    pub min: Role,
    pub resource: &'static str,
    pub audit: AuditLogService,
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
///
/// Issue #204: the role comes from the [`AuthenticatedSession`] that
/// `require_auth` validated for THIS request (the account's current role,
/// re-read from the account store when a session lookup is installed). If
/// that is missing, the token is validated here the same way rather than
/// trusting the identity cached on it at login.
pub async fn require_role_at_least(
    State(guard): State<RoleGuard>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let session = match guarded_session(&guard.auth, &req).await {
        Ok(session) => session,
        Err(err) => return ApiError(err).into_response(),
    };
    let Some(session) = session else {
        return forbidden_response();
    };
    // ADR-0034 section 3: one snapshot, for the denial row below and for the
    // handler's success row alike.
    let actor = guarded_actor(&guard.auth, &mut req, &session);
    match Role::from_str(&session.identity.role) {
        Ok(role) if role.at_least(guard.min) => next.run(req).await,
        _ => deny(&guard.audit, guard.resource, &actor, denied_detail(&req)).await,
    }
}

/// Decide the role floor AGAIN, for a handler that waited on the client after
/// its guards ran (Issue #793 S2).
///
/// [`require_auth`] and [`require_role_at_least`] decide when the request's
/// HEAD arrives. For an ordinary write that is the moment the write starts:
/// the layer that detaches writes hands over a body of up to 2 MiB before the
/// guards run, so nothing the client does can stretch the time between the
/// decision and the write. A LARGER body is streamed to the handler instead
/// (a backup upload, a big attachment): the guards have passed, and the
/// handler then waits for the rest of the body for as long as the client
/// cares to take. An account that was deleted, demoted or re-keyed during
/// that wait - or a session that was logged out - must not get its write
/// done by finishing the upload afterwards. Such a handler calls this FIRST
/// (its body extractor has already run by then) and writes only on `Ok`.
///
/// The rule is per ROUTE, not per body: a route whose `DefaultBodyLimit` is
/// raised past 2 MiB (an upload, a bulk import) calls this for every
/// request, small bodies included, so it has one rule. Raise the limit on
/// that route's `MethodRouter` alone
/// (`post(handler).layer(DefaultBodyLimit::max(..))`), never on the whole
/// router - the other writes there do not call this and must keep the
/// default, under which the layer receives their body before the guards.
///
/// "As of now" is exact: [`AuthState::authenticate`] settles the token's
/// presence, expiry and stamp under one lock AFTER the account lookup
/// returned, so a session that ended while the lookup was in flight is
/// `Unauthorized` here.
///
/// The verdicts are the guards' own: no valid session -> `Unauthorized`
/// (401, not audited); a role below `min` -> the `denied` audit row for
/// `resource` with `detail` (REST: `{ method, path }`) and `Forbidden` (403);
/// the account store failing to answer -> that error (the session is kept).
/// `Ok` is the session as of NOW - attribute the write's audit row to its
/// actor ([`AuthState::audit_actor`], then [`record_write`]) rather than
/// looking the token up once more.
///
/// The Tauri commands need no twin: a command receives its arguments (the
/// file bytes included) before `require_role` runs, so there is no wait
/// between its decision and its write.
pub async fn recheck_role_at_least(
    auth: &AuthState,
    audit: &AuditLogService,
    headers: &HeaderMap,
    min: Role,
    resource: &str,
    detail: serde_json::Value,
) -> Result<AuthenticatedSession, BantoError> {
    let Some(token) = bearer_token(headers) else {
        return Err(BantoError::Unauthorized);
    };
    let Some(session) = auth.authenticate(token).await? else {
        return Err(BantoError::Unauthorized);
    };
    let role = Role::from_str(&session.identity.role).ok();
    if role.is_some_and(|role| role.at_least(min)) {
        return Ok(session);
    }
    record_denied_as(
        audit,
        &auth.audit_actor(&session),
        "rest",
        resource,
        Some(detail),
    )
    .await;
    Err(BantoError::Forbidden)
}

/// The session a guard decides on (Issue #204): the one `require_auth`
/// validated for THIS request, or - when that is missing - the token
/// validated here the same way, never the identity cached on the token at
/// login. `Ok(None)` = no session (the guard refuses without auditing);
/// `Err` = the account store could not answer.
fn guarded_session(
    auth: &AuthState,
    req: &axum::extract::Request,
) -> impl std::future::Future<Output = Result<Option<AuthenticatedSession>, BantoError>> + Send + 'static
{
    // Owned values only: a borrow of `req` held across the `.await` would
    // make the middleware's future `!Send`.
    let validated = req.extensions().get::<AuthenticatedSession>().cloned();
    let token = bearer_token(req.headers()).map(str::to_owned);
    let auth = auth.clone();
    async move {
        match validated {
            Some(session) => Ok(Some(session)),
            None => match token {
                Some(token) => auth.authenticate(&token).await,
                None => Ok(None),
            },
        }
    }
}

/// The audit actor of the session a guard decided on (ADR-0034 section 3):
/// the snapshot `require_auth` put into THIS request's extensions, or - when
/// that is missing (the guard was stacked without `require_auth`) - the one
/// made here from `session`, which is then put into the extensions so the
/// handler behind the guard finds it too.
fn guarded_actor(
    auth: &AuthState,
    req: &mut axum::extract::Request,
    session: &AuthenticatedSession,
) -> AuditActor {
    if let Some(actor) = req.extensions().get::<AuditActor>() {
        return actor.clone();
    }
    let actor = auth.audit_actor(session);
    req.extensions_mut().insert(actor.clone());
    actor
}

/// The session and its per-user permissions a permission guard decides on
/// (Issue #697): the [`SessionPermissions`] `require_auth` put into THIS
/// request's extensions, or - when that is missing - the ones read here
/// from the request's bearer token as one authorization
/// ([`AuthState::authenticate_with_permissions`], so a guard stacked without
/// `require_auth` is held to the auth mode's generation to the end of the
/// permissions read too, ADR-0034 section 6). Never anything the client sent.
fn guarded_permissions(
    auth: &AuthState,
    req: &axum::extract::Request,
) -> impl std::future::Future<
    Output = Result<Option<(AuthenticatedSession, SessionPermissions)>, BantoError>,
> + Send
       + 'static {
    // Both, or neither: `require_auth` inserts the two together, after its
    // authorization was complete.
    let cached = req
        .extensions()
        .get::<AuthenticatedSession>()
        .cloned()
        .zip(req.extensions().get::<SessionPermissions>().cloned());
    let token = bearer_token(req.headers()).map(str::to_owned);
    let auth = auth.clone();
    async move {
        match (cached, token) {
            (Some(cached), _) => Ok(Some(cached)),
            (None, Some(token)) => auth.authenticate_with_permissions(&token).await,
            (None, None) => Ok(None),
        }
    }
}

/// `{ method, path }` of a refused request: the `detail` of its `denied`
/// audit row (REST only; conventions §1 allows the Tauri side's `None`).
fn denied_detail(req: &axum::extract::Request) -> serde_json::Value {
    json!({ "method": req.method().as_str(), "path": req.uri().path() })
}

/// A guard's refusal of a session: `403 forbidden` and the `denied` audit row
/// (spec M14), `detail` `{ method, path }`, attributed to the snapshot the
/// guard decided on. Shared by [`require_role_at_least`] and
/// [`require_permission`] so a role refusal and a permission refusal record
/// the same shape. (No session at all is refused without a row.)
async fn deny(
    audit: &AuditLogService,
    resource: &str,
    actor: &AuditActor,
    detail: serde_json::Value,
) -> Response {
    record_denied_as(audit, actor, "rest", resource, Some(detail)).await;
    forbidden_response()
}

/// `State` for [`require_permission`] (Issue #697, user-permissions-plan §5):
/// like [`RoleGuard`], but the floor is a per-user permission instead of a
/// role. The Tauri twin is `src-tauri`'s `require_permission(state,
/// permission, resource)`; `scripts/verify-architecture.mjs` rule 8 checks
/// that a guarded pair uses the same permission on both paths.
#[derive(Clone)]
pub struct PermissionGuard {
    pub auth: AuthState,
    pub permission: PermissionKey,
    pub resource: &'static str,
    pub audit: AuditLogService,
}

/// Axum middleware (Issue #697): stacked after `require_auth`, lets the
/// request through only when the caller's session holds `guard.permission`
/// (the request's [`SessionPermissions`], see [`crate::require_auth`]). The
/// role is not looked at - an admin
/// without the permission is refused, a viewer with it passes (combine with a
/// [`RoleGuard`] when both are wanted). A permission the app does not
/// register is never held (the session's permissions are filtered by the
/// catalog when they are read), so guarding with one refuses everybody.
/// The refusal is exactly [`require_role_at_least`]'s: `403 forbidden`, and a
/// `denied` audit row with `detail` `{ method, path }` when there is an
/// identity (none without a session). Attach via
/// `middleware::from_fn_with_state(PermissionGuard { auth, permission, resource, audit }, require_permission)`.
/// For a decision finer than a route (e.g. per equipment), a handler takes
/// `Extension<SessionPermissions>` and calls [`SessionPermissions::has`].
pub async fn require_permission(
    State(guard): State<PermissionGuard>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let session = match guarded_permissions(&guard.auth, &req).await {
        Ok(session) => session,
        Err(err) => return ApiError(err).into_response(),
    };
    let Some((session, permissions)) = session else {
        return forbidden_response();
    };
    let actor = guarded_actor(&guard.auth, &mut req, &session);
    if permissions.has(&guard.permission) {
        next.run(req).await
    } else {
        deny(&guard.audit, guard.resource, &actor, denied_detail(&req)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use banto_admin_services::audit::AuditLogEntry;
    use banto_storage::Db;

    /// In-memory SQLite with the `audit_log` columns the service writes
    /// (same DDL as the service's own tests; the app owns the migrations).
    async fn service() -> AuditLogService {
        let db = Db::connect_sqlite_memory().await.expect("in-memory sqlite");
        let pool = db.as_sqlite().expect("sqlite handle");
        sqlx::query(
            "CREATE TABLE audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL DEFAULT (datetime('now')),
                actor_username TEXT, actor_id INTEGER, actor_role TEXT, actor_kind TEXT,
                action TEXT NOT NULL, resource TEXT NOT NULL,
                entity_id TEXT, detail TEXT,
                origin TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'ok'
            )",
        )
        .execute(pool)
        .await
        .expect("create audit_log");
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(pool)
            .await
            .expect("create settings");
        AuditLogService::new(db)
    }

    async fn rows(audit: &AuditLogService) -> Vec<AuditLogEntry> {
        audit
            .list(ListParams::default())
            .await
            .expect("list audit")
            .rows
    }

    fn api_key_actor() -> AuditActor {
        AuditActor {
            username: "ci-key（abc123）".to_string(),
            id: None,
            role: "api_key".to_string(),
            kind: "apikey".to_string(),
        }
    }

    #[tokio::test]
    async fn record_write_as_writes_the_given_actor_and_origin() {
        let audit = service().await;
        record_write_as(
            &audit,
            Some(&api_key_actor()),
            "mcp",
            "update",
            "items",
            Some("7"),
            Some(json!({ "k": 1 })),
        )
        .await;
        let rows = rows(&audit).await;
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.actor_username.as_deref(), Some("ci-key（abc123）"));
        assert_eq!(r.actor_id, None);
        assert_eq!(r.actor_role.as_deref(), Some("api_key"));
        assert_eq!(r.actor_kind.as_deref(), Some("apikey"));
        assert_eq!(r.origin, "mcp");
        assert_eq!(r.result, "ok");
        assert_eq!(r.action, "update");
        assert_eq!(r.resource, "items");
        assert_eq!(r.entity_id.as_deref(), Some("7"));
        assert_eq!(r.detail.as_deref(), Some(r#"{"k":1}"#));
    }

    #[tokio::test]
    async fn record_write_as_without_actor_leaves_actor_columns_null() {
        let audit = service().await;
        record_write_as(&audit, None, "rest", "create", "items", None, None).await;
        let rows = rows(&audit).await;
        assert_eq!(rows[0].actor_username, None);
        assert_eq!(rows[0].actor_id, None);
        assert_eq!(rows[0].actor_role, None);
        assert_eq!(rows[0].actor_kind, None);
        assert_eq!(rows[0].origin, "rest");
        assert_eq!(rows[0].result, "ok");
    }

    #[tokio::test]
    async fn record_denied_as_writes_the_denied_shape() {
        let audit = service().await;
        record_denied_as(
            &audit,
            &AuditActor::account("bob", 4, "viewer"),
            "mcp",
            "users",
            Some(json!({ "method": "POST", "path": "/api/users" })),
        )
        .await;
        let rows = rows(&audit).await;
        let r = &rows[0];
        assert_eq!(r.actor_username.as_deref(), Some("bob"));
        assert_eq!(r.actor_id, Some(4));
        assert_eq!(r.actor_role.as_deref(), Some("viewer"));
        assert_eq!(r.actor_kind.as_deref(), Some("account"));
        assert_eq!(r.action, "denied");
        assert_eq!(r.resource, "users");
        assert_eq!(r.entity_id, None);
        assert_eq!(r.origin, "mcp");
        assert_eq!(r.result, "denied");
        assert_eq!(
            r.detail.as_deref(),
            Some(r#"{"method":"POST","path":"/api/users"}"#)
        );
    }

    /// A failed login has no actor: only the bounded name that was tried.
    #[tokio::test]
    async fn record_login_failed_as_keeps_the_tried_name_and_no_actor() {
        let audit = service().await;
        record_login_failed_as(&audit, "tauri", "mallory", None).await;
        record_login_failed_as(&audit, "rest", &"x".repeat(500), None).await;
        let rows = rows(&audit).await;
        let r = rows.iter().find(|r| r.origin == "tauri").unwrap();
        assert_eq!(r.actor_username.as_deref(), Some("mallory"));
        assert_eq!((r.actor_id, r.actor_role.clone()), (None, None));
        assert_eq!(r.actor_kind, None);
        assert_eq!(
            (r.action.as_str(), r.resource.as_str(), r.result.as_str()),
            ("login_failed", "auth", "failed")
        );
        let long = rows.iter().find(|r| r.origin == "rest").unwrap();
        assert!(long.actor_username.as_ref().unwrap().chars().count() < 500);
    }

    // --- ADR-0034 section 3: the audit actor is the guard's snapshot ---------

    const BUILTIN_ADMIN_ID: i64 = 1;

    fn grant_spec(kind: &str, id: &str, role: &str, marked: bool) -> crate::grant::GrantSpec {
        let mut spec = crate::grant::GrantSpec::new(
            crate::grant::GrantKind::new(kind).unwrap(),
            Identity {
                id: id.to_string(),
                name: id.to_string(),
                role: role.to_string(),
                account_id: None,
            },
            std::sync::Arc::new(|| Box::pin(async { Ok(true) })),
        );
        spec.audit_as_builtin_admin = marked;
        spec
    }

    fn issue_grant(auth: &AuthState, spec: &crate::grant::GrantSpec) -> String {
        auth.issue_grant_token(spec, auth.grant_generation(&spec.kind))
            .expect("grant token")
    }

    /// Account `editor-user` (id 3) plus whatever grants the test issues.
    fn actor_auth() -> AuthState {
        AuthState::new(
            |_u: String, _p: String| Box::pin(async { None }),
            SessionValidation::lookup(|username: String| {
                Box::pin(async move {
                    Ok(match username.as_str() {
                        "editor-user" => Some(account(3, "editor")),
                        "viewer-user" => Some(account(5, "viewer")),
                        _ => None,
                    })
                })
            }),
        )
        .with_builtin_admin_id(BUILTIN_ADMIN_ID)
    }

    /// A write route (`editor` floor) whose handler records with the
    /// snapshot it was handed. `before_record` runs between the guard and the
    /// audit write - where a real handler does its work.
    fn actor_routes(
        auth: &AuthState,
        audit: &AuditLogService,
        before_record: impl Fn() + Clone + Send + Sync + 'static,
    ) -> Router {
        let handler_audit = audit.clone();
        Router::new()
            .route(
                "/api/equipment/{id}/start",
                post(move |axum::Extension(actor): axum::Extension<AuditActor>| {
                    let audit = handler_audit.clone();
                    let before_record = before_record.clone();
                    async move {
                        before_record();
                        record_write(&audit, &actor, "update", "equipment", Some("1"), None).await;
                        "started"
                    }
                }),
            )
            .layer(middleware::from_fn_with_state(
                RoleGuard {
                    auth: auth.clone(),
                    min: Role::Editor,
                    resource: "equipment",
                    audit: audit.clone(),
                },
                require_role_at_least,
            ))
            .layer(middleware::from_fn_with_state(auth.clone(), require_auth))
    }

    /// `(actor_username, actor_id, actor_role, actor_kind, result)` per row.
    type ActorColumns = (
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        String,
    );

    async fn actor_columns(audit: &AuditLogService) -> Vec<ActorColumns> {
        let mut rows = rows(audit).await;
        rows.sort_by_key(|r| r.id);
        rows.into_iter()
            .map(|r| {
                (
                    r.actor_username,
                    r.actor_id,
                    r.actor_role,
                    r.actor_kind,
                    r.result,
                )
            })
            .collect()
    }

    fn columns(
        username: &str,
        id: Option<i64>,
        role: &str,
        kind: &str,
        result: &str,
    ) -> ActorColumns {
        (
            Some(username.to_string()),
            id,
            Some(role.to_string()),
            Some(kind.to_string()),
            result.to_string(),
        )
    }

    /// The three attributions (ADR-0034 section 3), success and denial alike:
    /// a marked grant is the built-in `admin` with the built-in row's id and
    /// its OWN role; an unmarked grant keeps its fixed id and has no
    /// `actor_id`; an account is itself. `actor_kind` tells two marked grants
    /// apart, which the actor alone cannot.
    #[tokio::test]
    async fn the_audit_actor_follows_the_mark_for_success_and_denial() {
        let audit = service().await;
        let auth = actor_auth();
        let router = actor_routes(&auth, &audit, || {});

        let commissioning = grant_spec("commissioning", "commissioning", "admin", true);
        let panel = grant_spec("panel", "panel", "editor", true);
        let marked_viewer = grant_spec("kiosk", "kiosk", "viewer", true);
        let public = grant_spec("publicViewer", "public", "viewer", false);

        for spec in [&commissioning, &panel] {
            let token = issue_grant(&auth, spec);
            assert_eq!(call(&router, Some(&token)).await, StatusCode::OK);
        }
        for spec in [&marked_viewer, &public] {
            let token = issue_grant(&auth, spec);
            assert_eq!(call(&router, Some(&token)).await, StatusCode::FORBIDDEN);
        }
        let editor = auth.issue_account_token(account(3, "editor"), false);
        assert_eq!(call(&router, Some(&editor)).await, StatusCode::OK);
        let viewer = auth.issue_account_token(account(5, "viewer"), false);
        assert_eq!(call(&router, Some(&viewer)).await, StatusCode::FORBIDDEN);

        let admin = Some(BUILTIN_ADMIN_ID);
        assert_eq!(
            actor_columns(&audit).await,
            vec![
                columns("admin", admin, "admin", "grant:commissioning", "ok"),
                columns("admin", admin, "editor", "grant:panel", "ok"),
                columns("admin", admin, "viewer", "grant:kiosk", "denied"),
                columns("public", None, "viewer", "grant:publicViewer", "denied"),
                columns("editor-user", Some(3), "editor", "account", "ok"),
                columns("viewer-user", Some(5), "viewer", "account", "denied"),
            ]
        );
    }

    /// The row is attributed to the session that was AUTHORIZED, even when
    /// that session ends before the row is written (logout, or the grant
    /// being revoked, while the handler worked). Nothing reads the token
    /// again - and no row carries the token.
    #[tokio::test]
    async fn the_audit_actor_survives_the_session_ending_after_authorization() {
        let audit = service().await;
        let auth = actor_auth();

        let editor = auth.issue_account_token(account(3, "editor"), false);
        let commissioning = grant_spec("commissioning", "commissioning", "admin", true);
        let grant = issue_grant(&auth, &commissioning);

        let ending = auth.clone();
        let (editor_token, kind) = (editor.clone(), commissioning.kind.clone());
        let router = actor_routes(&auth, &audit, move || {
            ending.logout(&editor_token);
            ending.revoke_grant_tokens(&kind);
        });

        assert_eq!(call(&router, Some(&editor)).await, StatusCode::OK);
        assert!(
            !auth.verify(&editor),
            "the session ended inside the handler"
        );
        // The grant was revoked by the first request already; issue a new one.
        assert_eq!(call(&router, Some(&grant)).await, StatusCode::UNAUTHORIZED);
        let grant = issue_grant(&auth, &commissioning);
        assert_eq!(call(&router, Some(&grant)).await, StatusCode::OK);
        assert!(!auth.verify(&grant));

        assert_eq!(
            actor_columns(&audit).await,
            vec![
                columns("editor-user", Some(3), "editor", "account", "ok"),
                columns(
                    "admin",
                    Some(BUILTIN_ADMIN_ID),
                    "admin",
                    "grant:commissioning",
                    "ok"
                ),
            ]
        );
        for row in rows(&audit).await {
            let text = serde_json::to_string(&row).unwrap();
            assert!(!text.contains(&editor) && !text.contains(&grant), "{text}");
        }
    }

    /// The mark never reaches the wire: `identity` is `Identity & { kind }`.
    #[tokio::test]
    async fn the_mark_is_not_serialized() {
        let auth = actor_auth();
        let token = issue_grant(
            &auth,
            &grant_spec("commissioning", "commissioning", "admin", true),
        );
        let session = auth.authenticate(&token).await.unwrap().unwrap();
        assert!(session.audit_as_builtin_admin);
        assert_eq!(
            serde_json::to_value(&session).unwrap(),
            json!({
                "id": "commissioning",
                "name": "commissioning",
                "role": "admin",
                "kind": "commissioning"
            })
        );
    }

    /// A guard stacked without `require_auth` still hands the handler the
    /// snapshot it decided on.
    #[tokio::test]
    async fn a_role_guard_without_require_auth_still_provides_the_actor() {
        let audit = service().await;
        let auth = actor_auth();
        let handler_audit = audit.clone();
        let router = Router::new()
            .route(
                "/api/equipment/{id}/start",
                post(move |axum::Extension(actor): axum::Extension<AuditActor>| {
                    let audit = handler_audit.clone();
                    async move {
                        record_write(&audit, &actor, "update", "equipment", None, None).await;
                    }
                }),
            )
            .layer(middleware::from_fn_with_state(
                RoleGuard {
                    auth: auth.clone(),
                    min: Role::Editor,
                    resource: "equipment",
                    audit: audit.clone(),
                },
                require_role_at_least,
            ));
        let editor = auth.issue_account_token(account(3, "editor"), false);
        assert_eq!(call(&router, Some(&editor)).await, StatusCode::OK);
        assert_eq!(call(&router, None).await, StatusCode::FORBIDDEN);
        assert_eq!(
            actor_columns(&audit).await,
            vec![columns("editor-user", Some(3), "editor", "account", "ok")]
        );
    }

    // --- ADR-0034 section 6: a permission guard without `require_auth` ------

    /// A `PermissionGuard` stacked WITHOUT `require_auth` authorizes by
    /// itself (lookup, then the permissions read). A mode switch that
    /// completes while the permissions are read ends that authorization:
    /// the guard answers as for no session (`403`, its existing answer), the
    /// handler does not run, and nothing is audited (there is no
    /// session to attribute a refusal to).
    #[tokio::test]
    async fn a_standalone_permission_guard_is_held_to_the_auth_mode_generation() {
        use crate::AuthMode;

        let audit = service().await;
        let slot: std::sync::Arc<std::sync::Mutex<Option<AuthState>>> = Default::default();
        let reader_slot = slot.clone();
        let auth = AuthState::new(
            |_u: String, _p: String| Box::pin(async { None }),
            SessionValidation::lookup(|_username: String| {
                Box::pin(async { Ok(Some(account(1, "viewer"))) })
            }),
        )
        .with_permission_reader(move |_account_id: i64| {
            let switcher = reader_slot.lock().unwrap().clone();
            Box::pin(async move {
                if let Some(auth) = switcher {
                    auth.switch_auth_mode(AuthMode::NoLogin);
                    auth.switch_auth_mode(AuthMode::LoginRequired);
                }
                Ok(SessionPermissions::new(
                    [key("equipment.operate")].into_iter().collect(),
                ))
            })
        });
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler_ran = ran.clone();
        let router = Router::new()
            .route(
                "/api/equipment/{id}/start",
                post(move || {
                    let ran = handler_ran.clone();
                    async move {
                        ran.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        "started"
                    }
                }),
            )
            .layer(middleware::from_fn_with_state(
                PermissionGuard {
                    auth: auth.clone(),
                    permission: key("equipment.operate"),
                    resource: "equipment",
                    audit: audit.clone(),
                },
                require_permission,
            ));

        // Without a switch the guard passes on its own.
        let token = auth.issue_account_token(account(1, "viewer"), false);
        assert_eq!(call(&router, Some(&token)).await, StatusCode::OK);

        *slot.lock().unwrap() = Some(auth.clone());
        assert_eq!(call(&router, Some(&token)).await, StatusCode::FORBIDDEN);
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(rows(&audit).await.is_empty());
    }

    // --- Issue #697: PermissionGuard -----------------------------------------

    fn key(raw: &str) -> PermissionKey {
        PermissionKey::parse(raw).unwrap()
    }

    /// Account `id` (also the stamp's `account_id`): username `{role}-user`.
    fn account(id: i64, role: &str) -> SessionAccount {
        SessionAccount {
            identity: Identity {
                id: format!("{role}-user"),
                name: role.to_string(),
                role: role.to_string(),
                account_id: None,
            },
            stamp: SessionStamp {
                account_id: id,
                auth_epoch: 0,
            },
        }
    }

    /// An `AuthState` whose lookup knows a viewer (id 1, holds
    /// `equipment.operate`) and an admin (id 2, holds `alarm.ack`), with a
    /// permission reader over a map the test can change.
    fn permission_auth(
        held: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<i64, Vec<&'static str>>>>,
    ) -> AuthState {
        let auth = AuthState::new(
            |_u: String, _p: String| Box::pin(async { None }),
            SessionValidation::lookup(|username: String| {
                Box::pin(async move {
                    Ok(match username.as_str() {
                        "viewer-user" => Some(account(1, "viewer")),
                        "admin-user" => Some(account(2, "admin")),
                        _ => None,
                    })
                })
            }),
        );
        auth.with_permission_reader(move |account_id: i64| {
            let keys: std::collections::BTreeSet<PermissionKey> = held
                .lock()
                .unwrap()
                .get(&account_id)
                .map(|keys| keys.iter().map(|k| key(k)).collect())
                .unwrap_or_default();
            Box::pin(async move { Ok(SessionPermissions::new(keys)) })
        })
    }

    async fn call(router: &Router, token: Option<&str>) -> StatusCode {
        use tower::ServiceExt;
        let mut request = axum::http::Request::post("/api/equipment/1/start");
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        router
            .clone()
            .oneshot(request.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn require_permission_ignores_the_role_and_audits_a_refusal_like_a_role_guard() {
        let audit = service().await;
        let held = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::from([
            (1, vec!["equipment.operate"]),
            (2, vec!["alarm.ack"]),
        ])));
        let auth = permission_auth(held.clone());
        let router = Router::new()
            .route(
                "/api/equipment/{id}/start",
                post(
                    |axum::Extension(permissions): axum::Extension<SessionPermissions>| async move {
                        // The extractor sees the same permissions the guard did.
                        assert!(permissions.has(&key("equipment.operate")));
                        "started"
                    },
                ),
            )
            .layer(middleware::from_fn_with_state(
                PermissionGuard {
                    auth: auth.clone(),
                    permission: key("equipment.operate"),
                    resource: "equipment",
                    audit: audit.clone(),
                },
                require_permission,
            ))
            .layer(middleware::from_fn_with_state(auth.clone(), require_auth));

        // A viewer holding the permission passes; an admin without it does not.
        let viewer = auth.issue_account_token(account(1, "viewer"), false);
        let admin = auth.issue_account_token(account(2, "admin"), false);
        assert_eq!(call(&router, Some(&viewer)).await, StatusCode::OK);
        assert_eq!(call(&router, Some(&admin)).await, StatusCode::FORBIDDEN);
        // No session: 401 from require_auth, nothing audited.
        assert_eq!(call(&router, None).await, StatusCode::UNAUTHORIZED);

        let rows = rows(&audit).await;
        assert_eq!(rows.len(), 1, "only the admin's refusal is audited");
        let r = &rows[0];
        assert_eq!(r.actor_username.as_deref(), Some("admin-user"));
        assert_eq!(r.actor_role.as_deref(), Some("admin"));
        assert_eq!((r.action.as_str(), r.result.as_str()), ("denied", "denied"));
        assert_eq!(
            (r.resource.as_str(), r.origin.as_str()),
            ("equipment", "rest")
        );
        assert_eq!(
            r.detail.as_deref(),
            Some(r#"{"method":"POST","path":"/api/equipment/1/start"}"#)
        );

        // Revoking takes effect on the next request (read per request), with
        // the session itself kept.
        held.lock().unwrap().insert(1, vec![]);
        assert_eq!(call(&router, Some(&viewer)).await, StatusCode::FORBIDDEN);
        assert!(auth.verify(&viewer));
    }

    // --- Issue #793 S2: recheck_role_at_least ---------------------------------

    /// What the account store answers for the account (id 3) in the recheck
    /// tests: its role, `None` = the account is gone, `Err` = the store does
    /// not answer.
    type StoreAnswer = std::sync::Arc<std::sync::Mutex<Result<Option<&'static str>, ()>>>;

    fn recheck_auth(answer: StoreAnswer) -> AuthState {
        AuthState::new(
            |_u: String, _p: String| Box::pin(async { None }),
            SessionValidation::lookup(move |_username: String| {
                let answer = *answer.lock().unwrap();
                Box::pin(async move {
                    match answer {
                        Ok(role) => Ok(role.map(|role| account(3, role))),
                        Err(()) => Err(BantoError::Other("store down".into())),
                    }
                })
            }),
        )
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        headers
    }

    async fn recheck(
        auth: &AuthState,
        audit: &AuditLogService,
        headers: &HeaderMap,
    ) -> Result<AuthenticatedSession, BantoError> {
        recheck_role_at_least(
            auth,
            audit,
            headers,
            Role::Editor,
            "attachments",
            json!({ "method": "POST", "path": "/api/attachments" }),
        )
        .await
    }

    #[tokio::test]
    async fn recheck_passes_a_session_that_still_has_the_role() {
        let audit = service().await;
        let answer: StoreAnswer = std::sync::Arc::new(std::sync::Mutex::new(Ok(Some("editor"))));
        let auth = recheck_auth(answer);
        let token = auth.issue_account_token(account(3, "editor"), false);

        let session = recheck(&auth, &audit, &bearer(&token)).await.unwrap();
        assert_eq!(session.identity.id, "editor-user");
        assert_eq!(session.identity.role, "editor");
        assert!(rows(&audit).await.is_empty(), "a pass records nothing");
    }

    /// The role is the account's role NOW, not the one the guards saw: too
    /// low is the guards' own refusal (403 + the `denied` row).
    #[tokio::test]
    async fn recheck_refuses_a_role_that_dropped_below_the_floor_and_audits_it() {
        let audit = service().await;
        let answer: StoreAnswer = std::sync::Arc::new(std::sync::Mutex::new(Ok(Some("editor"))));
        let auth = recheck_auth(answer.clone());
        let token = auth.issue_account_token(account(3, "editor"), false);
        // The guards passed (as an editor) ...
        assert!(auth.authenticate(&token).await.unwrap().is_some());
        // ... then the store reports a viewer under the same stamp.
        *answer.lock().unwrap() = Ok(Some("viewer"));

        let err = recheck(&auth, &audit, &bearer(&token)).await.unwrap_err();
        assert!(matches!(err, BantoError::Forbidden), "{err:?}");
        let rows = rows(&audit).await;
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.actor_username.as_deref(), Some("viewer-user"));
        assert_eq!(r.actor_role.as_deref(), Some("viewer"));
        assert_eq!((r.action.as_str(), r.result.as_str()), ("denied", "denied"));
        assert_eq!(
            (r.resource.as_str(), r.origin.as_str()),
            ("attachments", "rest")
        );
        assert_eq!(
            r.detail.as_deref(),
            Some(r#"{"method":"POST","path":"/api/attachments"}"#)
        );
    }

    /// A session that ended while the handler waited - logged out, or its
    /// account deleted - is `Unauthorized`, and (like `require_auth`) leaves
    /// no audit row.
    #[tokio::test]
    async fn recheck_refuses_a_session_that_ended_and_records_nothing() {
        let audit = service().await;
        let answer: StoreAnswer = std::sync::Arc::new(std::sync::Mutex::new(Ok(Some("editor"))));
        let auth = recheck_auth(answer.clone());

        // Logged out.
        let token = auth.issue_account_token(account(3, "editor"), false);
        auth.logout(&token);
        let err = recheck(&auth, &audit, &bearer(&token)).await.unwrap_err();
        assert!(matches!(err, BantoError::Unauthorized), "{err:?}");

        // The account is gone.
        let token = auth.issue_account_token(account(3, "editor"), false);
        *answer.lock().unwrap() = Ok(None);
        let err = recheck(&auth, &audit, &bearer(&token)).await.unwrap_err();
        assert!(matches!(err, BantoError::Unauthorized), "{err:?}");
        assert!(!auth.verify(&token), "the session is revoked");

        // No token at all.
        let err = recheck(&auth, &audit, &HeaderMap::new()).await.unwrap_err();
        assert!(matches!(err, BantoError::Unauthorized), "{err:?}");

        assert!(rows(&audit).await.is_empty());
    }

    /// The store failing to answer is neither a pass nor a revocation.
    #[tokio::test]
    async fn recheck_fails_without_revoking_when_the_store_does_not_answer() {
        let audit = service().await;
        let answer: StoreAnswer = std::sync::Arc::new(std::sync::Mutex::new(Err(())));
        let auth = recheck_auth(answer);
        let token = auth.issue_account_token(account(3, "editor"), false);

        let err = recheck(&auth, &audit, &bearer(&token)).await.unwrap_err();
        assert!(matches!(err, BantoError::Other(_)), "{err:?}");
        assert!(auth.verify(&token), "the session is kept");
        assert!(rows(&audit).await.is_empty());
    }

    #[tokio::test]
    async fn session_permissions_are_none_for_grants_unstamped_sessions_and_without_a_reader() {
        let held = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::from([(
            1,
            vec!["equipment.operate"],
        )])));
        let auth = permission_auth(held);
        let viewer = auth.issue_account_token(account(1, "viewer"), false);
        let session = auth.authenticate(&viewer).await.unwrap().unwrap();
        assert!(auth
            .session_permissions(&session)
            .await
            .unwrap()
            .has(&key("equipment.operate")));

        // The same session seen as a grant: never any.
        let grant = AuthenticatedSession {
            grant: Some(crate::grant::GrantKind::new("viewer-public").unwrap()),
            ..session.clone()
        };
        assert!(auth.session_permissions(&grant).await.unwrap().is_empty());
        // No account stamp: none.
        let unstamped = AuthenticatedSession {
            stamp: None,
            ..session.clone()
        };
        assert!(auth
            .session_permissions(&unstamped)
            .await
            .unwrap()
            .is_empty());
        // No reader installed: none.
        let plain = AuthState::new(
            |_u: String, _p: String| Box::pin(async { None }),
            SessionValidation::DisabledNoRevocation,
        );
        assert!(plain
            .session_permissions(&session)
            .await
            .unwrap()
            .is_empty());
    }
}
