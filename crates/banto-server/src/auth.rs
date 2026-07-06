//! Token-based authentication for the embedded server (spec §11.2).
//!
//! There is no secure-cookie story for a plain-HTTP LAN server, so the
//! bearer token is handed back in the login response body and the frontend
//! is responsible for attaching `Authorization: Bearer <token>` on every
//! subsequent request (mirrors `HttpDataProvider`'s planned wire contract,
//! spec §3.2/§11.1).

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_core::ErrorBody;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identity returned by `GET /api/auth/identity` (spec §3.3). Mirrors
/// `packages/admin-core/src/provider.ts::Identity`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
}

type CredentialChecker = Box<dyn Fn(&str, &str) -> bool + Send + Sync>;

struct Inner {
    tokens: RwLock<HashSet<String>>,
    check_credentials: CredentialChecker,
    identity: Identity,
}

/// Shared, cloneable auth state: an in-memory set of valid bearer tokens
/// plus an injected credential checker. Cloning is cheap (`Arc` handle).
#[derive(Clone)]
pub struct AuthState {
    inner: Arc<Inner>,
}

impl AuthState {
    /// Build a new [`AuthState`]. `check_credentials` decides whether a
    /// `username`/`password` pair may log in; `identity` is the identity
    /// returned to every authenticated session (the template has a single
    /// demo account, matching `src-tauri`'s `auth_identity` command).
    pub fn new(
        check_credentials: impl Fn(&str, &str) -> bool + Send + Sync + 'static,
        identity: Identity,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                tokens: RwLock::new(HashSet::new()),
                check_credentials: Box::new(check_credentials),
                identity,
            }),
        }
    }

    /// Verify credentials and, on success, mint and store a new uuid-v4
    /// bearer token. Returns `None` on bad credentials.
    pub fn login(&self, username: &str, password: &str) -> Option<String> {
        if (self.inner.check_credentials)(username, password) {
            let token = Uuid::new_v4().to_string();
            self.inner
                .tokens
                .write()
                .expect("auth token lock poisoned")
                .insert(token.clone());
            Some(token)
        } else {
            None
        }
    }

    /// Is `token` a currently-valid bearer token?
    pub fn verify(&self, token: &str) -> bool {
        self.inner
            .tokens
            .read()
            .expect("auth token lock poisoned")
            .contains(token)
    }

    /// Invalidate `token` (idempotent: logging out twice is not an error).
    pub fn logout(&self, token: &str) {
        self.inner
            .tokens
            .write()
            .expect("auth token lock poisoned")
            .remove(token);
    }

    fn identity(&self) -> Identity {
        self.inner.identity.clone()
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
    match auth.login(&body.username, &body.password) {
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
    let identity = bearer_token(&req)
        .filter(|token| auth.verify(token))
        .map(|_| auth.identity());
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
        AuthState::new(
            |u, p| u == "admin" && p == "admin",
            Identity {
                id: "admin".to_string(),
                name: "管理者".to_string(),
            },
        )
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
        let token = auth.login("admin", "admin").expect("login should succeed");
        assert!(auth.verify(&token));
        auth.logout(&token);
        assert!(!auth.verify(&token));
    }
}
