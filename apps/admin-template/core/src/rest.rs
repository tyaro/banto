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
//! | POST   | `/api/auth/login`    | `{username,password}` | `{success,error?,token?}` |
//! | POST   | `/api/auth/logout`   | -              | 200                    |
//! | GET    | `/api/auth/check`    | -              | `bool`                 |
//! | GET    | `/api/auth/identity` | -              | `Identity \| null`     |
//! | GET    | `/api/events`        | -              | SSE stream of `ServerEvent` |
//! | POST   | `/api/items/list`    | `ListParams`   | `ListResult<Item>`     |
//! | GET    | `/api/items/{id}`    | -              | `Item`                 |
//! | POST   | `/api/items`         | `ItemInput`    | `Item`                 |
//! | PUT    | `/api/items/{id}`    | `ItemInput`    | `Item`                 |
//! | DELETE | `/api/items/{id}`    | -              | 204                    |
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
use axum::http::StatusCode;
use axum::middleware;
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_core::{ListParams, ListResult};
use banto_server::{
    auth_routes, require_auth, require_banto_client_header, sse_route, ApiError, AuthState,
    ServerEvent,
};
use tokio::sync::broadcast;

use crate::items::{Item, ItemInput, ItemsService};

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

/// Compose the full `/api/*` router (spec §11.1): auth routes, SSE events,
/// and the `items` CRUD routes, all behind the CSRF header check. Mount the
/// result *before* `banto_server::static_files::static_router` so `/api/*`
/// takes priority over the SPA fallback.
pub fn api_router(
    items: ItemsService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    Router::new()
        .merge(auth_routes(auth.clone()))
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
    use banto_server::Identity;
    use serde_json::json;
    use tower::ServiceExt;

    const CLIENT_HEADER: (&str, &str) = ("X-Banto-Client", "banto");

    fn demo_auth() -> AuthState {
        AuthState::new(
            |u, p| u == "admin" && p == "admin",
            Identity {
                id: "admin".to_string(),
                name: "管理者".to_string(),
            },
        )
    }

    async fn router_with_token() -> (Router, String) {
        let pool = migrate_memory().await.expect("migrate_memory");
        let (tx, _rx) = broadcast::channel(16);
        let items = ItemsService::new(pool).with_events(tx.clone());
        let auth = demo_auth();
        let token = auth.login("admin", "admin").expect("login should succeed");
        (api_router(items, auth, tx), token)
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
        let items = ItemsService::new(pool).with_events(tx.clone());
        let auth = demo_auth();
        let token = auth.login("admin", "admin").unwrap();
        let router = api_router(items, auth, tx);

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
}
