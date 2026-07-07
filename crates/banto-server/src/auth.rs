//! Token-based authentication for the embedded server (spec §11.2).
//!
//! There is no secure-cookie story for a plain-HTTP LAN server, so the
//! bearer token is handed back in the login response body and the frontend
//! is responsible for attaching `Authorization: Bearer <token>` on every
//! subsequent request (mirrors `HttpDataProvider`'s planned wire contract,
//! spec §3.2/§11.1).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_core::ErrorBody;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identity returned by `GET /api/auth/identity` (spec §3.3). Mirrors
/// `packages/admin-core/src/provider.ts::Identity`.
///
/// Convention: `id` is the account's `username` (not a numeric row id) -
/// both the REST layer (`admin-template-core::rest`) and the `src-tauri`
/// adapter rely on this to recover "which account is this session for"
/// (e.g. for `change-password`) from nothing but the `Identity` a session
/// is keyed on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
}

/// Verifies a `username`/`password` pair against whatever credential store
/// the app crate wires in (spec §8.2), asynchronously (a real store is a
/// database lookup + password hash verification, both of which may need to
/// `.await`). Returns the session [`Identity`] on success.
///
/// Boxed owned-`String` arguments (rather than `&str` + a lifetime) keep
/// this object-safe/`'static` without extra lifetime plumbing: the request
/// body the credentials come from is already owned by the time a handler
/// calls this.
pub type CredentialVerifier =
    Arc<dyn Fn(String, String) -> BoxFuture<'static, Option<Identity>> + Send + Sync>;

struct Inner {
    tokens: RwLock<HashMap<String, Identity>>,
    verify_credentials: CredentialVerifier,
}

/// Shared, cloneable auth state: an in-memory map of valid bearer tokens to
/// the [`Identity`] that logged in with them, plus an injected async
/// credential verifier. Cloning is cheap (`Arc` handle).
#[derive(Clone)]
pub struct AuthState {
    inner: Arc<Inner>,
}

impl AuthState {
    /// Build a new [`AuthState`]. `verify_credentials` decides whether a
    /// `username`/`password` pair may log in and, if so, which [`Identity`]
    /// the resulting session belongs to.
    pub fn new(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                tokens: RwLock::new(HashMap::new()),
                verify_credentials: Arc::new(verify_credentials),
            }),
        }
    }

    /// Verify credentials and, on success, mint and store a new uuid-v4
    /// bearer token bound to the returned identity. Returns `None` on bad
    /// credentials.
    pub async fn login(&self, username: &str, password: &str) -> Option<String> {
        let identity =
            (self.inner.verify_credentials)(username.to_string(), password.to_string()).await?;
        Some(self.issue_token(identity))
    }

    /// Mint and store a new bearer token for an already-verified `identity`,
    /// without going through `verify_credentials` again. Used by callers
    /// that just created/authenticated an account through some other path
    /// (e.g. the REST `/api/auth/setup` handler, right after
    /// `UsersService::setup_first_user` succeeds) and want to log the new
    /// session in immediately, the same way `login` would.
    pub fn issue_token(&self, identity: Identity) -> String {
        let token = Uuid::new_v4().to_string();
        self.inner
            .tokens
            .write()
            .expect("auth token lock poisoned")
            .insert(token.clone(), identity);
        token
    }

    /// Is `token` a currently-valid bearer token?
    pub fn verify(&self, token: &str) -> bool {
        self.inner
            .tokens
            .read()
            .expect("auth token lock poisoned")
            .contains_key(token)
    }

    /// Invalidate `token` (idempotent: logging out twice is not an error).
    pub fn logout(&self, token: &str) {
        self.inner
            .tokens
            .write()
            .expect("auth token lock poisoned")
            .remove(token);
    }

    /// The [`Identity`] bound to `token`, or `None` if it is not a
    /// currently-valid token. Exposed (beyond what the `/api/auth/*` routes
    /// below need) so other routers built in the app crate - e.g.
    /// `admin-template-core::rest`'s `/api/auth/change-password` - can
    /// recover "which account is this request for" from the same bearer
    /// token `require_auth` already validated.
    pub fn identity_for(&self, token: &str) -> Option<Identity> {
        self.inner
            .tokens
            .read()
            .expect("auth token lock poisoned")
            .get(token)
            .cloned()
    }
}

fn unauthorized_response() -> Response {
    (StatusCode::UNAUTHORIZED, Json(ErrorBody::Unauthorized)).into_response()
}

fn bearer_token(req: &Request) -> Option<&str> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// Axum middleware: reject the request with `401 { "kind": "unauthorized" }`
/// (banto-core's [`ErrorBody`]) unless `Authorization: Bearer <token>`
/// carries a currently-valid token. Apply with
/// `middleware::from_fn_with_state(auth_state, require_auth)` so the guarded
/// router does not need `AuthState` as its own `State` type (this keeps
/// composition with other routers/state simple, spec §11 rest.rs).
pub async fn require_auth(State(auth): State<AuthState>, req: Request, next: Next) -> Response {
    match bearer_token(&req) {
        Some(token) if auth.verify(token) => next.run(req).await,
        _ => unauthorized_response(),
    }
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct LoginResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

async fn login_handler(
    State(auth): State<AuthState>,
    Json(body): Json<LoginRequest>,
) -> Json<LoginResponse> {
    match auth.login(&body.username, &body.password).await {
        Some(token) => Json(LoginResponse {
            success: true,
            error: None,
            token: Some(token),
        }),
        None => Json(LoginResponse {
            success: false,
            error: Some("ユーザー名またはパスワードが違います".to_string()),
            token: None,
        }),
    }
}

async fn logout_handler(State(auth): State<AuthState>, req: Request) -> StatusCode {
    if let Some(token) = bearer_token(&req) {
        auth.logout(token);
    }
    StatusCode::OK
}

async fn check_handler(State(auth): State<AuthState>, req: Request) -> Json<bool> {
    let ok = bearer_token(&req).is_some_and(|token| auth.verify(token));
    Json(ok)
}

async fn identity_handler(State(auth): State<AuthState>, req: Request) -> Json<Option<Identity>> {
    let identity = bearer_token(&req).and_then(|token| auth.identity_for(token));
    Json(identity)
}

/// Build the `/api/auth/*` routes (spec §11, mirrors `src-tauri`'s
/// `auth_login`/`auth_logout`/`auth_check`/`auth_identity` commands and
/// `packages/admin-core/src/provider.ts::AuthProvider`):
///
/// - `POST /api/auth/login` — `{ username, password }` -> `{ success, error?, token? }`.
///   The token travels in the JSON body (not a cookie) since a LAN HTTP
///   server has no secure-cookie story; the frontend stores it and attaches
///   it as `Authorization: Bearer <token>` on every other request.
/// - `POST /api/auth/logout` — invalidates the bearer token on the request.
/// - `GET /api/auth/check` — `bool`, whether the bearer token is valid.
/// - `GET /api/auth/identity` — `Identity | null`.
///
/// First-run account setup (`GET /api/auth/status`, `POST /api/auth/setup`)
/// and `POST /api/auth/change-password` are NOT here: those need the app
/// crate's `UsersService` directly, so they are composed alongside this
/// router in `admin-template-core::rest::api_router` instead (this crate
/// stays resource/credential-store-agnostic).
pub fn auth_routes(auth: AuthState) -> Router {
    Router::new()
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/check", get(check_handler))
        .route("/api/auth/identity", get(identity_handler))
        .with_state(auth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn demo_auth() -> AuthState {
        AuthState::new(|u: String, p: String| {
            Box::pin(async move {
                if u == "admin" && p == "admin" {
                    Some(Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                    })
                } else {
                    None
                }
            })
        })
    }

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn login_wrong_credentials_returns_success_false() {
        let router = auth_routes(demo_auth());
        let response = router
            .oneshot(
                HttpRequest::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"nope"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["success"], false);
        assert!(json["token"].is_null());
    }

    #[tokio::test]
    async fn login_right_credentials_returns_token() {
        let router = auth_routes(demo_auth());
        let response = router
            .oneshot(
                HttpRequest::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"admin"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let json = body_json(response).await;
        assert_eq!(json["success"], true);
        assert!(json["token"].as_str().is_some());
    }

    #[tokio::test]
    async fn logout_invalidates_token() {
        let auth = demo_auth();
        let token = auth
            .login("admin", "admin")
            .await
            .expect("login should succeed");
        assert!(auth.verify(&token));
        auth.logout(&token);
        assert!(!auth.verify(&token));
    }

    #[tokio::test]
    async fn identity_for_returns_the_identity_bound_to_the_token() {
        let auth = demo_auth();
        let token = auth
            .login("admin", "admin")
            .await
            .expect("login should succeed");
        let identity = auth.identity_for(&token).expect("identity should exist");
        assert_eq!(identity.id, "admin");
        assert_eq!(identity.name, "管理者");
    }

    #[tokio::test]
    async fn identity_for_is_none_for_an_invalid_token() {
        let auth = demo_auth();
        assert!(auth.identity_for("not-a-real-token").is_none());
    }

    #[tokio::test]
    async fn issue_token_logs_in_without_calling_verify_credentials() {
        let auth = demo_auth();
        let token = auth.issue_token(Identity {
            id: "owner".to_string(),
            name: "オーナー".to_string(),
        });
        assert!(auth.verify(&token));
        assert_eq!(auth.identity_for(&token).unwrap().id, "owner");
    }
}
