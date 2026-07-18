use super::*;

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
pub(super) struct LogoutAuditState {
    pub(super) auth: AuthState,
    pub(super) audit: AuditLogService,
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
pub(super) async fn audit_logout_middleware(
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
pub(super) fn audit_log_router(
    audit: AuditLogService,
    settings: SettingsService,
    auth: AuthState,
) -> Router {
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
