use super::*;

/// Extension point for app-specific `GET /api/auth/status` fields
/// (`docs/viewer-public-plan.md` §3.1-2). The returned map is flattened into
/// the status response alongside `initialized`/`viewerPublic`, so an adopter
/// that needs to tell its login screen something extra (a tenant name, a
/// branding flag, ...) can do it without wrapping this router in a
/// response-rewriting layer of its own.
///
/// Synchronous on purpose: `status` is the very first request a cold login
/// screen makes, and every field the template itself needs is already read
/// inside the handler - an app-supplied hook that wants to `.await` should
/// keep its own cached value and read it here instead of turning this route
/// into an arbitrary async fan-out.
pub type AuthStatusExtras =
    std::sync::Arc<dyn Fn() -> serde_json::Map<String, serde_json::Value> + Send + Sync>;

/// State shared by `/api/auth/status`, `/api/auth/setup`,
/// `/api/auth/public-viewer` and `/api/auth/change-password` (see
/// [`extra_auth_router`]): these need `UsersService` (the credential store,
/// spec §8.2), `AuthState` (to issue a token on `setup`'s implicit login and
/// on the public-viewer route, and to resolve the calling account on
/// `change-password`) and `SettingsService` (the live `server.viewer_public`
/// flag, Issue #189) - none of which [`crate::auth`] knows about on its own.
#[derive(Clone)]
struct UsersAuthState {
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    allow_setup: bool,
    settings: SettingsService,
    status_extras: Option<AuthStatusExtras>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResponse {
    initialized: bool,
    /// Whether this server hands out synthetic `viewer` sessions to LAN
    /// clients that have not logged in (Issue #189). Read live from
    /// `SettingsService` on every request - toggling 閲覧公開 in the settings
    /// screen takes effect without a server restart, and the Tauri and
    /// banto-serve hosts behave identically because both read the same key.
    viewer_public: bool,
    /// App-supplied extra fields, flattened into the same JSON object (see
    /// [`AuthStatusExtras`]). Empty for the template itself.
    #[serde(flatten)]
    extras: serde_json::Map<String, serde_json::Value>,
}

async fn auth_status_handler(
    State(state): State<UsersAuthState>,
) -> Result<Json<AuthStatusResponse>, ApiError> {
    let initialized = state.users.is_initialized().await?;
    let viewer_public = state.settings.server_config().await?.viewer_public;
    let extras = state
        .status_extras
        .as_ref()
        .map(|hook| hook())
        .unwrap_or_default();
    Ok(Json(AuthStatusResponse {
        initialized,
        viewer_public,
        extras,
    }))
}

#[derive(Debug, Serialize)]
struct PublicViewerResponse {
    success: bool,
    token: String,
}

/// `POST /api/auth/public-viewer` (Issue #189, ADR-0012,
/// `docs/viewer-public-plan.md` §2.2): hand an un-authenticated LAN client a
/// bearer token for the fixed synthetic `viewer` identity, so a wall display
/// or tablet can read without a login. Like every `/api/*` route it still
/// requires the `X-Banto-Client` header (`crate::csrf`); unlike almost every
/// other one it requires no bearer token, which is the entire point - it is
/// how the first token is obtained.
///
/// `403 { "kind": "forbidden" }` unless `server.viewer_public` is ON. The
/// flag is read from `SettingsService` on every call rather than captured at
/// router-build time, so turning 閲覧公開 off takes effect immediately
/// (already-issued tokens keep working until they expire or the admin
/// restarts the server - the flag gates ISSUANCE, and revoking live sessions
/// is deliberately out of scope for v1).
///
/// Deliberately NOT audited (`docs/viewer-public-plan.md` §2.2): this is not
/// a credential check, and a tablet re-issuing on every page reload would
/// bury the audit log in `login` entries. What matters for the trail is what
/// a public session then tries to DO - and that is unchanged: the existing
/// `RoleGuard` records a `denied` entry (actor `public`) for any mutating
/// request made with this token.
async fn auth_public_viewer_handler(
    State(state): State<UsersAuthState>,
) -> Result<Json<PublicViewerResponse>, ApiError> {
    if !state.settings.server_config().await?.viewer_public {
        return Err(ApiError(BantoError::Forbidden));
    }
    let token = state.auth.issue_public_viewer_token();
    Ok(Json(PublicViewerResponse {
        success: true,
        token,
    }))
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
        Ok(user) => {
            // Issue #204: bound to the new account's stamp, so the session
            // is accepted by a lookup-enabled `AuthState` (and ends like
            // any other once the account changes).
            let account = super::audit::session_account(&user);
            let identity = account.identity.clone();
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
            let token = state.auth.issue_account_token(account, false);
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

/// `POST /api/auth/change-password`: authenticated via the same bearer
/// token as every other guarded route, but implemented as a plain handler
/// (not `require_auth` middleware) since it also needs the token's bound
/// `Identity` to know *which* account to update - `require_auth` only
/// proves the token is valid, it does not thread the identity through.
///
/// Issue #204: the token is validated with [`AuthState::authenticate`] (a
/// deleted/re-keyed account's session is `401`, not a password change).
/// The change advances the account's epoch, ending every session of it -
/// other devices, the other transport's session, "Remember me" tokens - and
/// then re-binds only THIS token to the new epoch
/// ([`AuthState::rotate_session_epoch`]): the caller just proved the current
/// password, so it keeps working, while anything that might have been
/// obtained with the old password does not.
async fn auth_change_password_handler(
    State(state): State<UsersAuthState>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Json<ChangePasswordResponse>, ApiError> {
    let Some(token) = bearer_token(&headers) else {
        return Err(ApiError(BantoError::Unauthorized));
    };
    let Some(session) = state.auth.authenticate(token).await? else {
        return Err(ApiError(BantoError::Unauthorized));
    };
    let identity = session.identity;
    // #209, conventions §6: synthetic sessions are never credential owners,
    // even when a real account happens to share the "public" display label.
    if session.public_viewer {
        state
            .audit
            .record(AuditEntry {
                actor_username: Some(&identity.id),
                actor_role: Some(&identity.role),
                action: "password_change",
                resource: "users",
                entity_id: None,
                detail: None,
                origin: "rest",
                result: "denied",
            })
            .await;
        return Err(ApiError(BantoError::Forbidden));
    }

    let new_epoch = state
        .users
        .change_password(&identity.id, &body.current_password, &body.new_password)
        .await?;
    // Re-bind only when this change was the ONLY one since the session was
    // validated (`UsersService` advances the epoch by one per change): if a
    // role change interleaved, the session must end like every other one.
    // A `false` from the compare-and-set (revoked meanwhile) is likewise
    // left as is - the password change itself did succeed.
    if let Some(stamp) = session.stamp {
        if new_epoch == stamp.auth_epoch + 1 {
            state.auth.rotate_session_epoch(token, stamp, new_epoch);
        }
    }
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

/// `/api/auth/{status,setup,public-viewer,change-password}`: the auth routes
/// that need more than a token - a `UsersService` (the credential store)
/// and/or the live `SettingsService` - on top of the token-only
/// login/logout/check/identity routes [`crate::auth_routes`] already
/// provides. Merged by the app's `api_router`.
///
/// `status_extras` (optional, [`AuthStatusExtras`]) lets an adopter add
/// app-specific fields to `GET /api/auth/status`; the template passes
/// `None`.
pub fn extra_auth_router(
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    allow_setup: bool,
    settings: SettingsService,
    status_extras: Option<AuthStatusExtras>,
) -> Router {
    let state = UsersAuthState {
        users,
        auth,
        audit,
        allow_setup,
        settings,
        status_extras,
    };
    Router::new()
        .route("/api/auth/status", get(auth_status_handler))
        .route("/api/auth/setup", post(auth_setup_handler))
        .route("/api/auth/public-viewer", post(auth_public_viewer_handler))
        .route(
            "/api/auth/change-password",
            post(auth_change_password_handler),
        )
        .with_state(state)
}
