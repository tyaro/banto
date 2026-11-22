use std::sync::Arc;

use super::*;
use crate::auth::MaybePeerAddr;
use crate::grant::{grant_router, GrantKind, GrantRegistry};

/// Extension point for app-specific `GET /api/auth/status` fields
/// (`docs/design/viewer-public-plan.md` §3.1-2). The returned map is flattened into
/// the status response alongside `grants`, so an adopter
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

/// State shared by `/api/auth/status` and `/api/auth/change-password` (see
/// [`extra_auth_router`]): these need `UsersService` (the credential store,
/// spec §8.2), `AuthState` (to resolve the calling account on
/// `change-password`) and the [`GrantRegistry`] (`status` reports which
/// grant kinds may be issued to this peer, ADR-0017) - none of which
/// [`crate::auth`] knows about on its own.
#[derive(Clone)]
struct UsersAuthState {
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    registry: Arc<GrantRegistry>,
    status_extras: Option<AuthStatusExtras>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResponse {
    /// Which grant kinds this server would issue to THIS peer right now
    /// (ADR-0017): `{ publicViewer: bool, <appKind>: bool, ... }`, from
    /// [`GrantRegistry::availability`] - the same judgment the issuing route
    /// repeats, read live on every request (toggling 閲覧公開 in the settings
    /// screen takes effect without a restart). A kind whose condition fails
    /// is `false`; the login screen reads a missing kind as `false` too.
    grants: std::collections::BTreeMap<GrantKind, bool>,
    /// App-supplied extra fields, flattened into the same JSON object (see
    /// [`AuthStatusExtras`]). Empty for the template itself.
    #[serde(flatten)]
    extras: serde_json::Map<String, serde_json::Value>,
}

/// `GET /api/auth/status`: `{ grants, ...extras }`. It reads no account
/// state: there is no "initialized" any more - a new database is usable as
/// soon as its migrations have run (ADR-0034 §5). The per-kind grant judgment
/// is fail-closed to `false`.
async fn auth_status_handler(
    State(state): State<UsersAuthState>,
    MaybePeerAddr(peer): MaybePeerAddr,
) -> Result<Json<AuthStatusResponse>, ApiError> {
    let grants = state.registry.availability(peer).await;
    let extras = state
        .status_extras
        .as_ref()
        .map(|hook| hook())
        .unwrap_or_default();
    Ok(Json(AuthStatusResponse { grants, extras }))
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
    // ADR-0034 section 3: the actor of the session validated just above,
    // for the denial row and the success row alike.
    let actor = state.auth.audit_actor(&session);
    let identity = session.identity;
    // ADR-0017 (conventions §6): a grant session is never a credential
    // owner, even when a real account happens to share its display label.
    if session.grant.is_some() {
        record_as(
            &state.audit,
            Some(&actor),
            "rest",
            "password_change",
            "users",
            None,
            None,
            "denied",
        )
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
    // other `users` entries). `detail` stays `None`: neither the old nor the
    // new password (nor any hash) may ever be recorded.
    //
    // Issue #793 S2: the id is the one the session was validated with for
    // THIS request (its stamp), taken before the change - not a read made
    // after the commit, which loses the id when the account is deleted, or
    // the store does not answer, in between. Only a state without a session
    // lookup (no stamp) still reads it by username.
    let entity_id = match session.stamp {
        Some(stamp) => Some(stamp.account_id.to_string()),
        None => state
            .users
            .get_by_username(&identity.id)
            .await
            .ok()
            .flatten()
            .map(|user| user.id.to_string()),
    };
    record_write(
        &state.audit,
        &actor,
        "password_change",
        "users",
        entity_id.as_deref(),
        None,
    )
    .await;
    Ok(Json(ChangePasswordResponse { success: true }))
}

/// `/api/auth/{status,change-password}` plus the grant issuing route
/// `POST /api/auth/grant/{kind}` ([`grant_router`], ADR-0017): the auth
/// routes that need more than a token - a `UsersService` (the credential
/// store) and/or the [`GrantRegistry`] - on top of the token-only
/// login/logout/check/identity routes [`crate::auth_routes`] already
/// provides. Merged by the app's `api_router`, inside its CSRF layer.
///
/// `registry` holds every grant kind the app issues (the template registers
/// `GrantSpec::public_viewer(settings)` only); `status` reports
/// `availability(peer)` as `grants` and the grant route issues from it. An
/// app that has copied this router instead merges `grant_router` itself and
/// puts `availability(peer)` on its own status (ADR-0017 移行手順).
///
/// `status_extras` (optional, [`AuthStatusExtras`]) lets an adopter add
/// app-specific fields to `GET /api/auth/status`; the template passes
/// `None`.
pub fn extra_auth_router(
    users: UsersService,
    auth: AuthState,
    audit: AuditLogService,
    registry: Arc<GrantRegistry>,
    status_extras: Option<AuthStatusExtras>,
) -> Router {
    let state = UsersAuthState {
        users,
        auth: auth.clone(),
        audit,
        registry: registry.clone(),
        status_extras,
    };
    Router::new()
        .route("/api/auth/status", get(auth_status_handler))
        .route(
            "/api/auth/change-password",
            post(auth_change_password_handler),
        )
        .with_state(state)
        .merge(grant_router(auth, registry))
}
