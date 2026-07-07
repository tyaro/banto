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
//! | POST   | `/api/items/list`    | `ListParams`   | `ListResult<Item>`     |
//! | GET    | `/api/items/{id}`    | -              | `Item`                 |
//! | POST   | `/api/items`         | `ItemInput`    | `Item`                 |
//! | PUT    | `/api/items/{id}`    | `ItemInput`    | `Item`                 |
//! | DELETE | `/api/items/{id}`    | -              | 204                    |
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

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_core::{BantoError, ErrorBody, ListParams, ListResult};
use banto_server::{
    auth_routes, require_auth, require_banto_client_header, sse_route, ApiError, AuthState,
    Identity, ServerEvent,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::items::{Item, ItemInput, ItemsService};
use crate::users::UsersService;

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

async fn items_create(
    State(items): State<ItemsService>,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    Ok(Json(items.create(input).await?))
}

async fn items_update(
    State(items): State<ItemsService>,
    Path(id): Path<i64>,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    Ok(Json(items.update(id, input).await?))
}

async fn items_delete(
    State(items): State<ItemsService>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    items.delete(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn items_router(items: ItemsService, auth: AuthState) -> Router {
    Router::new()
        .route("/api/items/list", post(items_list))
        .route("/api/items", post(items_create))
        .route(
            "/api/items/{id}",
            get(items_get).put(items_update).delete(items_delete),
        )
        .with_state(items)
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
            };
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
    Ok(Json(ChangePasswordResponse { success: true }))
}

fn extra_auth_router(users: UsersService, auth: AuthState, allow_setup: bool) -> Router {
    let state = UsersAuthState {
        users,
        auth,
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

/// Compose the full `/api/*` router (spec §11.1): auth routes (login/
/// logout/check/identity from `banto_server`, plus status/setup/
/// change-password here since those need `UsersService`), SSE events, and
/// the `items` CRUD routes, all behind the CSRF header check. Mount the
/// result *before* `banto_server::static_files::static_router` so `/api/*`
/// takes priority over the SPA fallback.
pub fn api_router(
    items: ItemsService,
    users: UsersService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
    allow_setup: bool,
) -> Router {
    Router::new()
        .merge(auth_routes(auth.clone()))
        .merge(extra_auth_router(users, auth.clone(), allow_setup))
        .merge(sse_route(auth.clone(), events))
        .merge(items_router(items, auth))
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
    use tower::ServiceExt;

    const CLIENT_HEADER: (&str, &str) = ("X-Banto-Client", "banto");

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

    async fn router_with_token() -> (Router, String) {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool);
        let auth = demo_auth();
        let token = auth
            .login("admin", "admin")
            .await
            .expect("login should succeed");
        (api_router(items, users, auth, tx, false), token)
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
        let users = UsersService::new(pool);
        let auth = demo_auth();
        let token = auth.login("admin", "admin").await.unwrap();
        let router = api_router(items, users, auth, tx, false);

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
        let users = UsersService::new(pool);
        let auth = demo_auth();
        api_router(items, users, auth, tx, allow_setup)
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
    /// behavior).
    async fn router_with_real_login(allow_setup: bool) -> Router {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool.clone()).with_events(tx.clone());
        let users = UsersService::new(pool);
        let verify_users = users.clone();
        let auth = AuthState::new(move |u: String, p: String| {
            let users = verify_users.clone();
            Box::pin(async move {
                match users.verify(&u, &p).await {
                    Ok(Some(identity)) => Some(Identity {
                        id: identity.username,
                        name: identity.display_name,
                    }),
                    _ => None,
                }
            })
        });
        api_router(items, users, auth, tx, allow_setup)
    }

    #[tokio::test]
    async fn auth_change_password_success_then_relogin_with_new_password() {
        let router = router_with_real_login(true).await;
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
}
