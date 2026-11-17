//! Domain-agnostic REST routers (docs/template-scope.md §7 移行順 ④, theme C
//! PR-C4): the `/api/auth/*` extras, `/api/users/*`, `/api/audit-log/*`,
//! `/api/backups/*` and `/api/ui-settings/*` sub-routers, plus the RBAC/audit
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
//! ([`RoleGuard`]/[`require_role_at_least`], spec M10) and audit recording
//! ([`record_write`], spec M14) are added here.
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
use banto_admin_services::audit::{AuditEntry, AuditLogService};
use banto_admin_services::backup::{BackupInfo, BackupService, PendingRestoreInfo};
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
    SessionStamp, SessionValidation,
};

mod audit;
mod auth;
mod backups;
mod system_info;
mod ui_settings;
mod users;

pub use audit::{
    audit_log_router, audit_logout_middleware, audited_credential_verifier, user_auth_state,
    user_session_lookup, LogoutAuditState,
};
pub use auth::{extra_auth_router, AuthStatusExtras};
pub use backups::backups_router;
pub use system_info::{system_info_router, MetricsProbe, SystemInfo, SystemMetrics};
pub use ui_settings::ui_settings_router;
pub use users::users_router;

/// Extract the raw bearer token from an `Authorization: Bearer …` header.
/// Every RBAC/audit helper below starts here; the app's own routers
/// (`items`/`attachments`) reach for [`actor_identity`]/[`record_write`]
/// instead, which wrap this.
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// Resolve the caller's [`Identity`] from its bearer token, best-effort
/// (spec M14): every audit-recording call site needs "who did this", and
/// every one of them runs AFTER `require_auth`/[`require_role_at_least`] has
/// already proven the token valid, so this should always resolve - `None`
/// here is a defensive fallback (e.g. the token expired in the instant
/// between the guard and the handler running), not an expected path. Shared
/// by the users/backups write handlers here and by the app's own
/// `items`/`attachments` write handlers; auth-flow events (login/setup/
/// logout) resolve their own actor differently since they run before or
/// without a caller session.
pub fn actor_identity(headers: &HeaderMap, auth: &AuthState) -> Option<Identity> {
    bearer_token(headers).and_then(|token| auth.identity_for(token))
}

/// Who an audit row is attributed to: the `actor_username` / `actor_role`
/// columns. [`record_write`] builds one from the session's [`Identity`]; a
/// non-session principal (an API key, an MCP tool) builds its own and calls
/// [`record_write_as`] / [`record_denied_as`] with the `origin` of its
/// channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditActor<'a> {
    pub username: &'a str,
    pub role: &'a str,
}

impl<'a> From<&'a Identity> for AuditActor<'a> {
    fn from(identity: &'a Identity) -> Self {
        Self {
            username: &identity.id,
            role: &identity.role,
        }
    }
}

/// Record a successful write (spec M14) attributed to `actor` through
/// `origin` (`"rest"`, `"mcp"`, `"tauri"`, ...). `result` is `"ok"`. `actor`
/// is `None` for a write with no resolvable principal: both actor columns
/// are then NULL, as [`record_write`] has always done. The shared builder
/// behind [`record_write`] so every channel writes the same column values.
pub async fn record_write_as(
    audit: &AuditLogService,
    actor: Option<AuditActor<'_>>,
    origin: &str,
    action: &str,
    resource: &str,
    entity_id: Option<&str>,
    detail: Option<serde_json::Value>,
) {
    audit
        .record(AuditEntry {
            actor_username: actor.map(|a| a.username),
            actor_role: actor.map(|a| a.role),
            action,
            resource,
            entity_id,
            detail,
            origin,
            result: "ok",
        })
        .await;
}

/// Record an RBAC denial (spec M14) in the shape [`require_role_at_least`]
/// writes: `action` `"denied"`, no `entity_id`, `result` `"denied"`. The
/// caller supplies the `detail` (REST: `{ "method", "path" }`).
pub async fn record_denied_as(
    audit: &AuditLogService,
    actor: AuditActor<'_>,
    origin: &str,
    resource: &str,
    detail: serde_json::Value,
) {
    audit
        .record(AuditEntry {
            actor_username: Some(actor.username),
            actor_role: Some(actor.role),
            action: "denied",
            resource,
            entity_id: None,
            detail: Some(detail),
            origin,
            result: "denied",
        })
        .await;
}

/// Record a successful write (spec M14: create/update/delete/password_reset
/// etc.) once the service call it follows has already succeeded. Resolves
/// the actor from the same bearer token `require_auth`/[`require_role_at_least`]
/// validated - see [`actor_identity`]. `origin` is `"rest"`; a caller with
/// another principal or channel uses [`record_write_as`].
pub async fn record_write(
    audit: &AuditLogService,
    auth: &AuthState,
    headers: &HeaderMap,
    action: &str,
    resource: &str,
    entity_id: Option<&str>,
    detail: Option<serde_json::Value>,
) {
    let identity = actor_identity(headers, auth);
    record_write_as(
        audit,
        identity.as_ref().map(AuditActor::from),
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
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let validated = req.extensions().get::<AuthenticatedSession>().cloned();
    let session = match validated {
        Some(session) => Some(session),
        // Owned token: a borrow of `req` held across the `.await` would make
        // this middleware's future `!Send`.
        None => match bearer_token(req.headers()).map(str::to_owned) {
            Some(token) => match guard.auth.authenticate(&token).await {
                Ok(session) => session,
                Err(err) => return ApiError(err).into_response(),
            },
            None => None,
        },
    };
    let identity = session.map(|session| session.identity);
    let role = identity
        .as_ref()
        .and_then(|identity| Role::from_str(&identity.role).ok());

    match role {
        Some(role) if role.at_least(guard.min) => next.run(req).await,
        _ => {
            if let Some(identity) = &identity {
                let method = req.method().as_str().to_string();
                let path = req.uri().path().to_string();
                record_denied_as(
                    &guard.audit,
                    AuditActor::from(identity),
                    "rest",
                    guard.resource,
                    json!({ "method": method, "path": path }),
                )
                .await;
            }
            forbidden_response()
        }
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
                actor_username TEXT, actor_role TEXT,
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

    #[tokio::test]
    async fn record_write_as_writes_the_given_actor_and_origin() {
        let audit = service().await;
        let actor = AuditActor {
            username: "ci-key（abc123）",
            role: "api_key",
        };
        record_write_as(
            &audit,
            Some(actor),
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
        assert_eq!(r.actor_role.as_deref(), Some("api_key"));
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
        assert_eq!(rows[0].actor_role, None);
        assert_eq!(rows[0].origin, "rest");
        assert_eq!(rows[0].result, "ok");
    }

    #[tokio::test]
    async fn record_denied_as_writes_the_denied_shape() {
        let audit = service().await;
        record_denied_as(
            &audit,
            AuditActor {
                username: "bob",
                role: "viewer",
            },
            "mcp",
            "users",
            json!({ "method": "POST", "path": "/api/users" }),
        )
        .await;
        let rows = rows(&audit).await;
        let r = &rows[0];
        assert_eq!(r.actor_username.as_deref(), Some("bob"));
        assert_eq!(r.actor_role.as_deref(), Some("viewer"));
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

    #[tokio::test]
    async fn record_write_resolves_the_session_actor_with_rest_origin() {
        let audit = service().await;
        let auth = AuthState::new(
            |_u: String, _p: String| Box::pin(async { None }),
            SessionValidation::DisabledNoRevocation,
        );
        let token = auth.issue_token(Identity {
            id: "alice".into(),
            name: "Alice".into(),
            role: "admin".into(),
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        record_write(&audit, &auth, &headers, "delete", "items", Some("3"), None).await;
        record_write(
            &audit,
            &auth,
            &HeaderMap::new(),
            "delete",
            "items",
            None,
            None,
        )
        .await;
        let rows = rows(&audit).await;
        assert_eq!(rows.len(), 2);
        let with = rows.iter().find(|r| r.entity_id.is_some()).unwrap();
        assert_eq!(with.actor_username.as_deref(), Some("alice"));
        assert_eq!(with.actor_role.as_deref(), Some("admin"));
        assert_eq!((with.origin.as_str(), with.result.as_str()), ("rest", "ok"));
        let without = rows.iter().find(|r| r.entity_id.is_none()).unwrap();
        assert_eq!(without.actor_username, None);
        assert_eq!(without.actor_role, None);
    }
}
