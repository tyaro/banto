use super::*;
use crate::db::migrate_memory;
use axum::body::Body;
use axum::http::Request as HttpRequest;
use banto_core::{BantoError, FilterOp, FilterState, Pagination, SortDirection, SortState};
use serde_json::json;
use std::path::PathBuf;
use tempfile::tempdir;
use tower::ServiceExt;

const CLIENT_HEADER: (&str, &str) = ("X-Banto-Client", "banto");

/// A `BackupService` for router helpers that do not exercise
/// `/api/backups/*` at all (the overwhelming majority of this module's
/// tests) - `BackupService::new` only stores its arguments, so an
/// on-disk path that is never actually written to is harmless. Tests
/// that DO exercise backups use [`router_with_role_tokens_and_backup`]
/// instead, which points at a real, writable temp directory AND (unlike
/// every other helper here) a real on-disk pool - see that function's
/// doc comment for why the pool matters too.
fn unused_backup_service(pool: sqlx::SqlitePool) -> BackupService {
    BackupService::new(
        PathBuf::from("unused-in-tests").join("admin-template.sqlite3"),
        pool,
    )
}

/// An `AttachmentsService` for router helpers that never exercise
/// `/api/attachments/*` - same "never actually written to" reasoning as
/// [`unused_backup_service`]. Tests that DO exercise attachments use
/// [`router_with_role_tokens_and_attachments`] instead, which points at
/// a real, writable temp directory.
fn unused_attachments_service(pool: sqlx::SqlitePool) -> AttachmentsService {
    AttachmentsService::new(pool, PathBuf::from("unused-in-tests").join("attachments"))
}

fn demo_auth() -> AuthState {
    AuthState::new(|u: String, p: String| {
        Box::pin(async move {
            if u == "admin" && p == "admin" {
                Some(Identity {
                    id: "admin".to_string(),
                    name: "管理者".to_string(),
                    role: "admin".to_string(),
                })
            } else {
                None
            }
        })
    })
}

/// Router + one bearer token per role (admin/editor/viewer), for the
/// RBAC tests below (spec M10). Unlike [`demo_auth_with_roles`] (whose
/// login verifier is independent of any `UsersService`), the three
/// accounts here are REAL rows in the same `UsersService`/pool the
/// router's `/api/users/*` routes operate on - required so
/// `users_delete`'s `acting_user` lookup (by the token's username) can
/// actually resolve the admin account performing the delete in
/// `admin_can_create_list_update_reset_password_and_delete_users`
/// below.
async fn router_with_role_tokens() -> (Router, String, String, String) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let items = ItemsService::new(pool.clone()).with_events(tx.clone());
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let attachments = unused_attachments_service(pool.clone());
    let audit = AuditLogService::new(pool);

    users
        .setup_first_user("admin", "password123", "管理者")
        .await
        .expect("setup_first_user");
    users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create editor");
    users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create viewer");

    let verify_users = users.clone();
    let auth = AuthState::new(move |u: String, p: String| {
        let users = verify_users.clone();
        Box::pin(async move {
            match users.verify(&u, &p).await {
                Ok(Some(identity)) => Some(Identity {
                    id: identity.username,
                    name: identity.display_name,
                    role: identity.role.to_string(),
                }),
                _ => None,
            }
        })
    });

    let admin_token = auth
        .login("admin", "password123")
        .await
        .expect("admin login");
    let editor_token = auth
        .login("editor", "password123")
        .await
        .expect("editor login");
    let viewer_token = auth
        .login("viewer", "password123")
        .await
        .expect("viewer login");
    (
        api_router(
            items,
            users,
            settings,
            audit,
            backup,
            attachments,
            auth,
            tx,
            false,
        ),
        admin_token,
        editor_token,
        viewer_token,
    )
}

async fn router_with_token() -> (Router, String) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let items = ItemsService::new(pool.clone()).with_events(tx.clone());
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let attachments = unused_attachments_service(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();
    let token = auth
        .login("admin", "admin")
        .await
        .expect("login should succeed");
    (
        api_router(
            items,
            users,
            settings,
            audit,
            backup,
            attachments,
            auth,
            tx,
            false,
        ),
        token,
    )
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
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let attachments = unused_attachments_service(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();
    let token = auth.login("admin", "admin").await.unwrap();
    let router = api_router(
        items,
        users,
        settings,
        audit,
        backup,
        attachments,
        auth,
        tx,
        false,
    );

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
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let attachments = unused_attachments_service(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();
    api_router(
        items,
        users,
        settings,
        audit,
        backup,
        attachments,
        auth,
        tx,
        allow_setup,
    )
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
/// behavior). Also returns the `AuditLogService` sharing the router's
/// pool, so M14 tests can assert on what got recorded.
async fn router_with_real_login(allow_setup: bool) -> (Router, AuditLogService) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let items = ItemsService::new(pool.clone()).with_events(tx.clone());
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let attachments = unused_attachments_service(pool.clone());
    let audit = AuditLogService::new(pool);
    let auth = AuthState::new(audited_credential_verifier(users.clone(), audit.clone()));
    (
        api_router(
            items,
            users,
            settings,
            audit.clone(),
            backup,
            attachments,
            auth,
            tx,
            allow_setup,
        ),
        audit,
    )
}

#[tokio::test]
async fn auth_change_password_success_then_relogin_with_new_password() {
    let (router, _audit) = router_with_real_login(true).await;
    let token = setup_and_get_token(&router).await;

    let change_request = HttpRequest::post("/api/auth/change-password")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "currentPassword": "password123", "newPassword": "newpassword1" }).to_string(),
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

// --- M10 RBAC ----------------------------------------------------------

fn put_json(path: &str, token: &str, body: serde_json::Value) -> HttpRequest<Body> {
    HttpRequest::put(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn post_json_auth(path: &str, token: &str, body: serde_json::Value) -> HttpRequest<Body> {
    HttpRequest::post(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn get_auth(path: &str, token: &str) -> HttpRequest<Body> {
    HttpRequest::get(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn delete_auth(path: &str, token: &str) -> HttpRequest<Body> {
    HttpRequest::delete(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn viewer_can_list_and_get_items() {
    let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

    let list_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items/list",
            &viewer,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);

    let get_response = router
        .oneshot(get_auth("/api/items/999", &viewer))
        .await
        .unwrap();
    // Not the point of this test (no such item), but it proves the
    // request got PAST the role guard and into the handler.
    assert_eq!(get_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn viewer_cannot_create_items_forbidden_with_forbidden_kind() {
    let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

    let response = router
        .oneshot(post_json_auth(
            "/api/items",
            &viewer,
            json!({ "name": "Nope", "price": 1, "stock": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "forbidden");
}

#[tokio::test]
async fn viewer_cannot_update_or_delete_items() {
    let (router, admin, _editor, viewer) = router_with_role_tokens().await;

    // Seed one item as admin so there is something to try updating.
    let create_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items",
            &admin,
            json!({ "name": "Seed", "price": 10, "stock": 1 }),
        ))
        .await
        .unwrap();
    let id = body_json(create_response).await["id"].as_i64().unwrap();

    let update_response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/items/{id}"),
            &viewer,
            json!({ "name": "Changed", "price": 20, "stock": 2 }),
        ))
        .await
        .unwrap();
    assert_eq!(update_response.status(), StatusCode::FORBIDDEN);

    let delete_response = router
        .oneshot(delete_auth(&format!("/api/items/{id}"), &viewer))
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn editor_can_create_update_and_delete_items() {
    let (router, _admin, editor, _viewer) = router_with_role_tokens().await;

    let create_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items",
            &editor,
            json!({ "name": "Editable", "price": 10, "stock": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let id = body_json(create_response).await["id"].as_i64().unwrap();

    let update_response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/items/{id}"),
            &editor,
            json!({ "name": "Edited", "price": 20, "stock": 2 }),
        ))
        .await
        .unwrap();
    assert_eq!(update_response.status(), StatusCode::OK);

    let delete_response = router
        .oneshot(delete_auth(&format!("/api/items/{id}"), &editor))
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn only_admin_can_list_users() {
    let (router, admin, editor, viewer) = router_with_role_tokens().await;

    for (token, expected) in [
        (&admin, StatusCode::OK),
        (&editor, StatusCode::FORBIDDEN),
        (&viewer, StatusCode::FORBIDDEN),
    ] {
        let response = router
            .clone()
            .oneshot(get_auth("/api/users", token))
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "token role mismatch");
    }
}

#[tokio::test]
async fn non_admin_users_write_routes_are_forbidden_with_forbidden_kind() {
    let (router, _admin, editor, _viewer) = router_with_role_tokens().await;

    let response = router
        .oneshot(post_json_auth(
            "/api/users",
            &editor,
            json!({
                "username": "newperson",
                "password": "password123",
                "displayName": "New Person",
                "role": "viewer"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "forbidden");
}

#[tokio::test]
async fn admin_can_create_list_update_reset_password_and_delete_users() {
    let (router, admin, _editor, _viewer) = router_with_role_tokens().await;

    let create_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/users",
            &admin,
            json!({
                "username": "newperson",
                "password": "password123",
                "displayName": "New Person",
                "role": "editor"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let created = body_json(create_response).await;
    assert_eq!(created["role"], "editor");
    let id = created["id"].as_i64().unwrap();

    let list_response = router
        .clone()
        .oneshot(get_auth("/api/users", &admin))
        .await
        .unwrap();
    let list = body_json(list_response).await;
    assert!(list.as_array().unwrap().iter().any(|u| u["id"] == id));

    let update_response = router
        .clone()
        .oneshot(put_json(
            &format!("/api/users/{id}"),
            &admin,
            json!({ "displayName": "Updated Person", "role": "viewer" }),
        ))
        .await
        .unwrap();
    assert_eq!(update_response.status(), StatusCode::OK);
    assert_eq!(body_json(update_response).await["role"], "viewer");

    let reset_response = router
        .clone()
        .oneshot(post_json_auth(
            &format!("/api/users/{id}/reset-password"),
            &admin,
            json!({ "newPassword": "resetpassword1" }),
        ))
        .await
        .unwrap();
    assert_eq!(reset_response.status(), StatusCode::OK);
    assert_eq!(body_json(reset_response).await["success"], true);

    let delete_response = router
        .oneshot(delete_auth(&format!("/api/users/{id}"), &admin))
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn users_routes_are_unauthorized_without_a_token() {
    let (router, _admin, _editor, _viewer) = router_with_role_tokens().await;
    let response = router.oneshot(get("/api/users")).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// --- M12 per-user UI settings ------------------------------------------

fn put_ui_setting(key: &str, token: &str, value: &str) -> HttpRequest<Body> {
    put_json(
        &format!("/api/ui-settings/{key}"),
        token,
        json!({ "value": value }),
    )
}

#[tokio::test]
async fn ui_settings_round_trip_via_rest() {
    let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

    // Unset key reads back as {"value": null}.
    let response = router
        .clone()
        .oneshot(get_auth("/api/ui-settings/theme", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_json(response).await["value"].is_null());

    // PUT then GET round-trips - and note this is the VIEWER role:
    // writing your own UI settings needs no role floor (unlike
    // `settings_set`/`/api/users`).
    let put_response = router
        .clone()
        .oneshot(put_ui_setting("theme", &viewer, "glass"))
        .await
        .unwrap();
    assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

    let response = router
        .oneshot(get_auth("/api/ui-settings/theme", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["value"], "glass");
}

#[tokio::test]
async fn ui_settings_are_isolated_per_user() {
    let (router, admin, editor, _viewer) = router_with_role_tokens().await;

    let put_response = router
        .clone()
        .oneshot(put_ui_setting("theme", &admin, "glass"))
        .await
        .unwrap();
    assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

    // The admin's value must NOT be visible to the editor's session -
    // each account reads its own `ui.{username}.*` namespace.
    let response = router
        .clone()
        .oneshot(get_auth("/api/ui-settings/theme", &editor))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_json(response).await["value"].is_null());

    // And the admin still sees their own value.
    let response = router
        .oneshot(get_auth("/api/ui-settings/theme", &admin))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["value"], "glass");
}

#[tokio::test]
async fn ui_settings_reject_an_invalid_key_with_422_validation() {
    let (router, _admin, _editor, viewer) = router_with_role_tokens().await;

    // `%20` decodes to a space in the path param - an invalid key char.
    let response = router
        .clone()
        .oneshot(put_ui_setting("bad%20key!", &viewer, "x"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "validation");
    assert_eq!(json["field_errors"][0]["field"], "key");

    let response = router
        .oneshot(get_auth("/api/ui-settings/bad%20key!", &viewer))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn ui_settings_routes_are_unauthorized_without_a_token() {
    let (router, _admin, _editor, _viewer) = router_with_role_tokens().await;

    let response = router
        .clone()
        .oneshot(get("/api/ui-settings/theme"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = router
        .oneshot(post_json(
            "/api/ui-settings/theme",
            json!({ "value": "glass" }),
        ))
        .await
        .unwrap();
    // POST is not a registered method on this route, but the request
    // must still die at `require_auth` (401), not reach any handler.
    assert!(
        response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::METHOD_NOT_ALLOWED
    );
}

// --- M14 Audit -----------------------------------------------------------

/// Like `router_with_role_tokens`, but also returns the `AuditLogService`
/// sharing the router's pool (so these tests can query
/// `/api/audit-log/list` as the admin token and assert on what got
/// recorded), and wires the login verifier through
/// [`audited_credential_verifier`] so login events are actually recorded
/// - `router_with_role_tokens`'s own verifier predates M14 and stays a
///   plain credential check since none of ITS callers care about audit
///   events.
async fn router_with_role_tokens_and_audit() -> (Router, AuditLogService, String, String, String) {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, _rx) = broadcast::channel(16);
    let items = ItemsService::new(pool.clone()).with_events(tx.clone());
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let attachments = unused_attachments_service(pool.clone());
    let audit = AuditLogService::new(pool);

    users
        .setup_first_user("admin", "password123", "管理者")
        .await
        .expect("setup_first_user");
    users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create editor");
    users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create viewer");

    let auth = AuthState::new(audited_credential_verifier(users.clone(), audit.clone()));
    let admin_token = auth
        .login("admin", "password123")
        .await
        .expect("admin login");
    let editor_token = auth
        .login("editor", "password123")
        .await
        .expect("editor login");
    let viewer_token = auth
        .login("viewer", "password123")
        .await
        .expect("viewer login");

    let router = api_router(
        items,
        users,
        settings,
        audit.clone(),
        backup,
        attachments,
        auth,
        tx,
        false,
    );
    (router, audit, admin_token, editor_token, viewer_token)
}

/// Like `router_with_role_tokens_and_audit`, but for the M17
/// `/api/backups/*` (and, since both need a real writable temp
/// directory, M20 `/api/attachments/*`) tests, which need services that
/// ACTUALLY WORK end to end (create/list/read/stage a real file), not
/// [`unused_backup_service`]/[`unused_attachments_service`]'s
/// placeholders. Two things every other helper in this module gets to
/// skip:
/// - The router's own pool must be a real ON-DISK sqlite file, not
///   `:memory:` (`migrate_memory()`) - `VACUUM INTO` (which
///   `BackupService::create` uses) silently writes nothing when its
///   SOURCE connection is `:memory:` (see `crate::backup`'s test module
///   doc comment for the empirically-verified reason).
/// - The returned `tempfile::TempDir` guard must be kept alive by the
///   caller for as long as the router is in use - dropping it deletes
///   the directory `backups/`/`restore-pending.sqlite3`/`attachments/`
///   live in.
async fn router_with_role_tokens_and_backup() -> (Router, tempfile::TempDir, String, String, String)
{
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("admin-template.sqlite3");
    let pool = banto_storage::connect_sqlite(&db_path)
        .await
        .expect("connect_sqlite");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrate");

    let (tx, _rx) = broadcast::channel(16);
    let items = ItemsService::new(pool.clone()).with_events(tx.clone());
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = BackupService::new(db_path, pool.clone());
    let attachments = AttachmentsService::new(pool.clone(), dir.path().join("attachments"));
    let audit = AuditLogService::new(pool);

    users
        .setup_first_user("admin", "password123", "管理者")
        .await
        .expect("setup_first_user");
    users
        .create_user("editor", "password123", "編集者", Role::Editor)
        .await
        .expect("create editor");
    users
        .create_user("viewer", "password123", "閲覧者", Role::Viewer)
        .await
        .expect("create viewer");

    let auth = AuthState::new(audited_credential_verifier(users.clone(), audit.clone()));
    let admin_token = auth
        .login("admin", "password123")
        .await
        .expect("admin login");
    let editor_token = auth
        .login("editor", "password123")
        .await
        .expect("editor login");
    let viewer_token = auth
        .login("viewer", "password123")
        .await
        .expect("viewer login");

    let router = api_router(
        items,
        users,
        settings,
        audit,
        backup,
        attachments,
        auth,
        tx,
        false,
    );
    (router, dir, admin_token, editor_token, viewer_token)
}

/// (a) `/api/audit-log/list` is admin-only: 200 for admin, 403 for
/// editor/viewer.
#[tokio::test]
async fn audit_log_list_is_admin_only() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

    let admin_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(admin_response.status(), StatusCode::OK);

    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(post_json_auth(
                "/api/audit-log/list",
                token,
                json!(ListParams::default()),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "token role mismatch"
        );
    }
}

#[tokio::test]
async fn audit_log_list_requires_a_token() {
    let (router, _audit, _admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;
    let response = router
        .oneshot(post_json(
            "/api/audit-log/list",
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// `GET /api/audit-log/config` is admin-only: 200 (with the default
/// retention policy) for admin, 403 for editor/viewer.
#[tokio::test]
async fn audit_config_get_is_admin_only() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

    let admin_response = router
        .clone()
        .oneshot(get_auth("/api/audit-log/config", &admin))
        .await
        .unwrap();
    assert_eq!(admin_response.status(), StatusCode::OK);
    let body = body_json(admin_response).await;
    assert_eq!(body["retentionDays"], 90);
    assert_eq!(body["retentionRows"], 100_000);

    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(get_auth("/api/audit-log/config", token))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "token role mismatch"
        );
    }
}

/// `PUT /api/audit-log/config` (admin) persists the new policy - a
/// following `GET` reflects it - and records a `settings_change` audit
/// entry (spec M14: settings mutations are audited, unlike the read-only
/// `GET`). `editor`/`viewer` are rejected with 403 and the policy is left
/// untouched.
#[tokio::test]
async fn audit_config_apply_persists_and_is_admin_only() {
    let (router, _audit, admin, editor, viewer) = router_with_role_tokens_and_audit().await;

    for token in [&editor, &viewer] {
        let response = router
            .clone()
            .oneshot(put_json(
                "/api/audit-log/config",
                token,
                json!({ "retentionDays": 30, "retentionRows": 5000 }),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "token role mismatch"
        );
    }

    let apply_response = router
        .clone()
        .oneshot(put_json(
            "/api/audit-log/config",
            &admin,
            json!({ "retentionDays": 30, "retentionRows": 5000 }),
        ))
        .await
        .unwrap();
    assert_eq!(apply_response.status(), StatusCode::OK);
    let applied = body_json(apply_response).await;
    assert_eq!(applied["retentionDays"], 30);
    assert_eq!(applied["retentionRows"], 5000);

    let get_response = router
        .clone()
        .oneshot(get_auth("/api/audit-log/config", &admin))
        .await
        .unwrap();
    let refetched = body_json(get_response).await;
    assert_eq!(refetched["retentionDays"], 30);
    assert_eq!(refetched["retentionRows"], 5000);

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let entry = rows
        .iter()
        .find(|r| r["action"] == "settings_change" && r["resource"] == "settings")
        .unwrap_or_else(|| panic!("expected a settings_change/settings entry, got {rows:?}"));
    assert_eq!(entry["actorUsername"], "admin");
    assert_eq!(entry["origin"], "rest");
    assert_eq!(entry["result"], "ok");
}

/// (b) A successful item creation is recorded.
#[tokio::test]
async fn item_create_is_recorded_in_the_audit_log() {
    let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;

    let create_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items",
            &admin,
            json!({ "name": "Widget", "price": 10, "stock": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let id = body_json(create_response).await["id"].as_i64().unwrap();

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let entry = rows
        .iter()
        .find(|r| r["action"] == "create" && r["resource"] == "items")
        .unwrap_or_else(|| panic!("expected a create/items entry, got {rows:?}"));
    assert_eq!(entry["actorUsername"], "admin");
    assert_eq!(entry["actorRole"], "admin");
    assert_eq!(entry["entityId"], id.to_string().as_str());
    assert_eq!(entry["origin"], "rest");
    assert_eq!(entry["result"], "ok");
}

/// A successful item delete is recorded too (not just create) - a quick
/// sanity check that every mutation, not just the first one wired up, is
/// covered.
#[tokio::test]
async fn item_delete_is_recorded_in_the_audit_log() {
    let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;

    let create_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items",
            &admin,
            json!({ "name": "Doomed", "price": 1, "stock": 1 }),
        ))
        .await
        .unwrap();
    let id = body_json(create_response).await["id"].as_i64().unwrap();

    router
        .clone()
        .oneshot(delete_auth(&format!("/api/items/{id}"), &admin))
        .await
        .unwrap();

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    assert!(
        rows.iter().any(|r| r["action"] == "delete"
            && r["resource"] == "items"
            && r["entityId"] == id.to_string().as_str()),
        "expected a delete/items entry, got {rows:?}"
    );
}

/// (c) A viewer's rejected write is recorded as `denied`.
#[tokio::test]
async fn viewer_write_denial_is_recorded_as_denied() {
    let (router, _audit, admin, _editor, viewer) = router_with_role_tokens_and_audit().await;

    let response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items",
            &viewer,
            json!({ "name": "Nope", "price": 1, "stock": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let entry = rows
        .iter()
        .find(|r| r["action"] == "denied" && r["resource"] == "items")
        .unwrap_or_else(|| panic!("expected a denied/items entry, got {rows:?}"));
    assert_eq!(entry["actorUsername"], "viewer");
    assert_eq!(entry["actorRole"], "viewer");
    assert_eq!(entry["result"], "denied");
}

/// `users` create/reset-password entries must never leak the plaintext
/// password into `detail` (spec M14's hard rule - see
/// `crate::audit`'s module doc comment).
#[tokio::test]
async fn users_create_audit_entry_never_contains_the_password() {
    let (router, _audit, admin, _editor, _viewer) = router_with_role_tokens_and_audit().await;

    router
        .clone()
        .oneshot(post_json_auth(
            "/api/users",
            &admin,
            json!({
                "username": "newperson",
                "password": "supersecret1",
                "displayName": "New Person",
                "role": "viewer"
            }),
        ))
        .await
        .unwrap();

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let entry = rows
        .iter()
        .find(|r| r["action"] == "create" && r["resource"] == "users")
        .expect("expected a create/users entry");
    assert_eq!(entry["actorUsername"], "admin");
    let detail = entry["detail"].as_str().expect("detail should be set");
    assert!(
        !detail.contains("supersecret1"),
        "audit detail must never contain the password: {detail}"
    );
    assert!(detail.contains("newperson"));
}

/// (d) A failed login attempt is recorded as `login_failed`. Uses
/// `router_with_real_login` (not `router_with_role_tokens_and_audit`)
/// since it wires `/api/auth/login` through the same
/// `audited_credential_verifier` production code path.
#[tokio::test]
async fn login_failure_is_recorded_as_login_failed() {
    let (router, audit) = router_with_real_login(true).await;
    setup_and_get_token(&router).await; // creates the "owner" admin account

    let response = router
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": "owner", "password": "wrong-password" }),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(response).await["success"], false);

    let result = audit.list(ListParams::default()).await.unwrap();
    let entry = result
        .rows
        .iter()
        .find(|r| r.action == "login_failed")
        .unwrap_or_else(|| panic!("expected a login_failed entry, got {:?}", result.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("owner"));
    assert_eq!(entry.actor_role, None);
    assert_eq!(entry.result, "failed");
}

#[tokio::test]
async fn login_success_is_recorded_as_login() {
    let (router, audit) = router_with_real_login(true).await;
    setup_and_get_token(&router).await;

    router
        .clone()
        .oneshot(post_json(
            "/api/auth/login",
            json!({ "username": "owner", "password": "password123" }),
        ))
        .await
        .unwrap();

    let result = audit.list(ListParams::default()).await.unwrap();
    assert!(
        result
            .rows
            .iter()
            .any(|r| r.action == "login" && r.actor_username.as_deref() == Some("owner")),
        "expected a login entry, got {:?}",
        result.rows
    );
}

#[tokio::test]
async fn logout_is_recorded() {
    let (router, audit) = router_with_real_login(true).await;
    let token = setup_and_get_token(&router).await;

    router
        .oneshot(
            HttpRequest::post("/api/auth/logout")
                .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let result = audit.list(ListParams::default()).await.unwrap();
    assert!(
        result
            .rows
            .iter()
            .any(|r| r.action == "logout" && r.actor_username.as_deref() == Some("owner")),
        "expected a logout entry, got {:?}",
        result.rows
    );
}

#[tokio::test]
async fn setup_is_recorded() {
    let (router, audit) = router_with_real_login(true).await;
    setup_and_get_token(&router).await;

    let result = audit.list(ListParams::default()).await.unwrap();
    assert!(
        result
            .rows
            .iter()
            .any(|r| r.action == "setup" && r.actor_username.as_deref() == Some("owner")),
        "expected a setup entry, got {:?}",
        result.rows
    );
}

/// Spec M14 (coordinator review): a self-service password change is a
/// security event and must be recorded as `password_change` (actor =
/// entity = the caller) - and the entry must never carry the password.
#[tokio::test]
async fn change_password_is_recorded_as_password_change() {
    let (router, audit) = router_with_real_login(true).await;
    let token = setup_and_get_token(&router).await;

    let change_request = HttpRequest::post("/api/auth/change-password")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "currentPassword": "password123", "newPassword": "newpassword1" }).to_string(),
        ))
        .unwrap();
    let response = router.oneshot(change_request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let result = audit.list(ListParams::default()).await.unwrap();
    let entry = result
        .rows
        .iter()
        .find(|r| r.action == "password_change")
        .unwrap_or_else(|| panic!("expected a password_change entry, got {:?}", result.rows));
    assert_eq!(entry.actor_username.as_deref(), Some("owner"));
    assert_eq!(entry.actor_role.as_deref(), Some("admin"));
    assert_eq!(entry.resource, "users");
    // `setup_first_user` creates the very first row -> id 1.
    assert_eq!(entry.entity_id.as_deref(), Some("1"));
    assert_eq!(entry.origin, "rest");
    assert_eq!(entry.result, "ok");
    assert_eq!(entry.detail, None, "detail must never carry the password");
}

// --- M15: CSV import -----------------------------------------------------

/// `editor` can import: a mixed create+update batch succeeds, and
/// exactly ONE `action: "import"` audit entry is recorded (spec M15:
/// "件数サマリ付き1件記録"), with a `{created,updated}` summary detail
/// and no `entityId` (the entry represents the whole batch, not one
/// row).
#[tokio::test]
async fn editor_can_import_items_and_it_is_recorded_as_one_audit_entry() {
    let (router, _audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;

    let create_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items",
            &admin,
            json!({ "name": "Existing", "price": 10, "stock": 1 }),
        ))
        .await
        .unwrap();
    let existing_id = body_json(create_response).await["id"].as_i64().unwrap();

    let import_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items/import",
            &editor,
            json!([
                { "id": existing_id, "name": "Updated", "price": 20, "stock": 2 },
                { "id": null, "name": "Brand New", "price": 30, "stock": 3 }
            ]),
        ))
        .await
        .unwrap();
    assert_eq!(import_response.status(), StatusCode::OK);
    let body = body_json(import_response).await;
    assert_eq!(body["created"], 1);
    assert_eq!(body["updated"], 1);
    assert_eq!(body["errors"], json!([]));

    let list_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(list_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let import_entries: Vec<_> = rows.iter().filter(|r| r["action"] == "import").collect();
    assert_eq!(
        import_entries.len(),
        1,
        "expected exactly one import entry, got {rows:?}"
    );
    let entry = import_entries[0];
    assert_eq!(entry["actorUsername"], "editor");
    assert_eq!(entry["resource"], "items");
    assert_eq!(entry["entityId"], serde_json::Value::Null);
    assert_eq!(entry["origin"], "rest");
    assert_eq!(entry["result"], "ok");
    let detail: serde_json::Value =
        serde_json::from_str(entry["detail"].as_str().expect("detail should be set")).unwrap();
    assert_eq!(detail, json!({ "created": 1, "updated": 1 }));
}

/// `viewer` cannot import (spec M15: editor+ only, same `RoleGuard` as
/// the other `items` write routes).
#[tokio::test]
async fn viewer_cannot_import_items_forbidden_with_forbidden_kind() {
    let (router, _audit, _admin, _editor, viewer) = router_with_role_tokens_and_audit().await;

    let response = router
        .oneshot(post_json_auth(
            "/api/items/import",
            &viewer,
            json!([{ "id": null, "name": "Nope", "price": 1, "stock": 1 }]),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "forbidden");
}

/// A batch with a per-row validation error is rolled back entirely - the
/// valid row in the same batch must NOT land in the DB either - and is
/// recorded as a single `result: "failed"` audit entry summarizing the
/// error count (spec M15).
#[tokio::test]
async fn items_import_validation_error_rolls_back_and_is_recorded_as_failed() {
    let (router, _audit, admin, editor, _viewer) = router_with_role_tokens_and_audit().await;

    let import_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items/import",
            &editor,
            json!([
                { "id": null, "name": "Valid", "price": 10, "stock": 1 },
                { "id": null, "name": "", "price": 1, "stock": 1 }
            ]),
        ))
        .await
        .unwrap();
    assert_eq!(import_response.status(), StatusCode::OK);
    let body = body_json(import_response).await;
    assert_eq!(body["created"], 0);
    assert_eq!(body["updated"], 0);
    assert_eq!(body["errors"][0]["row"], 1);

    // Nothing from the batch was committed, including the otherwise
    // valid first row (spec M15: all-or-nothing).
    let list_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/items/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    assert_eq!(body_json(list_response).await["totalCount"], 0);

    let audit_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(audit_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    let entry = rows
        .iter()
        .find(|r| r["action"] == "import")
        .unwrap_or_else(|| panic!("expected an import entry, got {rows:?}"));
    assert_eq!(entry["result"], "failed");
    assert_eq!(entry["actorUsername"], "editor");
    let detail: serde_json::Value =
        serde_json::from_str(entry["detail"].as_str().expect("detail should be set")).unwrap();
    assert_eq!(detail, json!({ "errorCount": 1 }));
}

// --- M17: SQLite backup/restore -------------------------------------------

fn post_bytes_auth(path: &str, token: &str, bytes: Vec<u8>) -> HttpRequest<Body> {
    HttpRequest::post(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(bytes))
        .unwrap()
}

async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

/// admin can create a backup, see it in the list, and download the exact
/// same bytes back (spec M17: "バックアップファイルが作成・ダウンロード
/// でき"). `POST /api/backups` is recorded as `action: "backup"`.
#[tokio::test]
async fn admin_can_create_list_and_download_backups() {
    let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

    let create_response = router
        .clone()
        .oneshot(post_bytes_auth("/api/backups", &admin, Vec::new()))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let created = body_json(create_response).await;
    let file_name = created["fileName"].as_str().expect("fileName").to_string();
    assert!(created["sizeBytes"].as_u64().unwrap() > 0);

    let list_response = router
        .clone()
        .oneshot(get_auth("/api/backups", &admin))
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let listed = body_json(list_response).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["fileName"], file_name);

    let download_response = router
        .oneshot(get_auth(&format!("/api/backups/{file_name}"), &admin))
        .await
        .unwrap();
    assert_eq!(download_response.status(), StatusCode::OK);
    let disposition = download_response
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .expect("Content-Disposition header")
        .to_str()
        .unwrap()
        .to_string();
    assert!(disposition.contains("attachment"));
    assert!(disposition.contains(&file_name));
    let bytes = body_bytes(download_response).await;
    assert_eq!(&bytes[0..16], b"SQLite format 3\0");
}

/// `editor`/`viewer` cannot reach ANY `/api/backups/*` route (spec M17:
/// "admin以外は全API 403") - checked against both a read route (`GET
/// /api/backups`) and a write route (`POST /api/backups`).
#[tokio::test]
async fn editor_and_viewer_cannot_access_backups_routes() {
    let (router, _dir, _admin, editor, viewer) = router_with_role_tokens_and_backup().await;

    for token in [&editor, &viewer] {
        let list_response = router
            .clone()
            .oneshot(get_auth("/api/backups", token))
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::FORBIDDEN);
        let json = body_json(list_response).await;
        assert_eq!(json["kind"], "forbidden");

        let create_response = router
            .clone()
            .oneshot(post_bytes_auth("/api/backups", token, Vec::new()))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::FORBIDDEN);
    }
}

/// Uploading garbage bytes to `/api/backups/restore` must be rejected
/// (spec M17: "壊れたファイルのリストアが検証で拒否される") - `Validation`
/// maps to `422` (`banto_server::response::status_for`), and no pending
/// restore is left staged.
#[tokio::test]
async fn restore_upload_of_garbage_bytes_is_rejected_as_validation() {
    let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

    let response = router
        .clone()
        .oneshot(post_bytes_auth(
            "/api/backups/restore",
            &admin,
            b"not a sqlite file".to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "validation");

    let pending_response = router
        .oneshot(get_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    assert_eq!(body_json(pending_response).await, serde_json::Value::Null);
}

/// Full stage-from-existing-backup -> cancel round trip (spec M17),
/// asserting both the `pending-restore` status endpoint AND the
/// `restore_staged`/`restore_cancelled` audit entries it records.
#[tokio::test]
async fn stage_restore_from_existing_backup_then_cancel_is_recorded_in_the_audit_log() {
    let (router, _dir, admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;

    let create_response = router
        .clone()
        .oneshot(post_bytes_auth("/api/backups", &admin, Vec::new()))
        .await
        .unwrap();
    let file_name = body_json(create_response).await["fileName"]
        .as_str()
        .unwrap()
        .to_string();

    let stage_response = router
        .clone()
        .oneshot(post_bytes_auth(
            &format!("/api/backups/{file_name}/restore"),
            &admin,
            Vec::new(),
        ))
        .await
        .unwrap();
    assert_eq!(stage_response.status(), StatusCode::NO_CONTENT);

    let pending_response = router
        .clone()
        .oneshot(get_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    let pending = body_json(pending_response).await;
    assert!(pending["sizeBytes"].as_u64().unwrap() > 0);

    let cancel_response = router
        .clone()
        .oneshot(delete_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    assert_eq!(cancel_response.status(), StatusCode::NO_CONTENT);

    let pending_after_cancel = router
        .clone()
        .oneshot(get_auth("/api/backups/pending-restore", &admin))
        .await
        .unwrap();
    assert_eq!(
        body_json(pending_after_cancel).await,
        serde_json::Value::Null
    );

    let audit_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(audit_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();
    assert!(
        rows.iter()
            .any(|r| r["action"] == "backup" && r["resource"] == "backups"),
        "expected a backup entry, got {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|r| r["action"] == "restore_staged" && r["resource"] == "backups"),
        "expected a restore_staged entry, got {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|r| r["action"] == "restore_cancelled" && r["resource"] == "backups"),
        "expected a restore_cancelled entry, got {rows:?}"
    );
}

// --- M20: attachments -------------------------------------------------------

/// Full upload -> list -> download -> thumbnail(404, non-image) -> delete
/// round trip (spec `docs/attachments-plan.md` §3.5/§5): `editor` writes,
/// `viewer` reads. Also checks the `Content-Disposition` header carries
/// both the ASCII `filename=` and RFC 5987 `filename*=` forms.
#[tokio::test]
async fn editor_can_upload_list_download_and_delete_an_attachment() {
    let (router, _dir, _admin, editor, viewer) = router_with_role_tokens_and_backup().await;
    let bytes = b"hello attachment".to_vec();

    let upload_response = router
        .clone()
        .oneshot(post_bytes_auth(
            "/api/attachments?resource=items&resourceId=42&fileName=notes.txt",
            &editor,
            bytes.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(upload_response.status(), StatusCode::OK);
    let created = body_json(upload_response).await;
    assert_eq!(created["resource"], "items");
    assert_eq!(created["resourceId"], "42");
    assert_eq!(created["fileName"], "notes.txt");
    assert_eq!(created["mime"], "application/octet-stream");
    assert_eq!(created["sizeBytes"].as_u64().unwrap() as usize, bytes.len());
    assert_eq!(created["hasThumbnail"], false);
    assert_eq!(created["createdBy"], "editor");
    let id = created["id"].as_i64().unwrap();

    let list_response = router
        .clone()
        .oneshot(post_json_auth(
            "/api/attachments/list",
            &viewer,
            json!({ "resource": "items", "resourceId": "42" }),
        ))
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let listed = body_json(list_response).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], id);

    let download_response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/attachments/{id}/download"),
            &viewer,
        ))
        .await
        .unwrap();
    assert_eq!(download_response.status(), StatusCode::OK);
    let disposition = download_response
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .expect("Content-Disposition header")
        .to_str()
        .unwrap()
        .to_string();
    assert!(disposition.contains("attachment"));
    assert!(disposition.contains("filename=\"notes.txt\""));
    assert!(disposition.contains("filename*=UTF-8''notes.txt"));
    let downloaded = body_bytes(download_response).await;
    assert_eq!(downloaded, bytes);

    // Non-image upload: no thumbnail generated, so this 404s (spec §3.5).
    let thumbnail_response = router
        .clone()
        .oneshot(get_auth(
            &format!("/api/attachments/{id}/thumbnail"),
            &viewer,
        ))
        .await
        .unwrap();
    assert_eq!(thumbnail_response.status(), StatusCode::NOT_FOUND);

    let delete_response = router
        .clone()
        .oneshot(delete_auth(&format!("/api/attachments/{id}"), &editor))
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

    let list_after_delete = router
        .oneshot(post_json_auth(
            "/api/attachments/list",
            &viewer,
            json!({ "resource": "items", "resourceId": "42" }),
        ))
        .await
        .unwrap();
    let listed_after = body_json(list_after_delete).await;
    assert_eq!(listed_after.as_array().unwrap().len(), 0);
}

/// `viewer` cannot upload or delete attachments (spec §3.5: `editor`+
/// write floor) - both are rejected `403` with `{"kind":"forbidden"}`,
/// same shape as every other RBAC-guarded write route in this module.
#[tokio::test]
async fn viewer_cannot_upload_or_delete_attachments_forbidden_with_forbidden_kind() {
    let (router, _dir, _admin, _editor, viewer) = router_with_role_tokens_and_backup().await;

    let upload_response = router
        .clone()
        .oneshot(post_bytes_auth(
            "/api/attachments?resource=items&resourceId=1&fileName=a.txt",
            &viewer,
            b"x".to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(upload_response.status(), StatusCode::FORBIDDEN);
    let json = body_json(upload_response).await;
    assert_eq!(json["kind"], "forbidden");

    let delete_response = router
        .oneshot(delete_auth("/api/attachments/1", &viewer))
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::FORBIDDEN);
}

/// `POST /api/attachments/list` needs a bearer token, same as every
/// other `require_auth`-guarded route (spec §3.5: `viewer`+, but
/// AUTHENTICATED viewer+, not anonymous).
#[tokio::test]
async fn attachments_list_route_requires_a_token() {
    let (router, _dir, _admin, _editor, _viewer) = router_with_role_tokens_and_backup().await;
    let response = router
        .oneshot(post_json(
            "/api/attachments/list",
            json!({ "resource": "items", "resourceId": "1" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// Downloading/thumbnailing an id that does not exist is a plain `404`
/// (spec §3.5), same `NotFound` -> `404` mapping every other resource
/// uses (`banto_server::response::status_for`).
#[tokio::test]
async fn nonexistent_attachment_download_and_thumbnail_are_404() {
    let (router, _dir, _admin, _editor, viewer) = router_with_role_tokens_and_backup().await;

    let download_response = router
        .clone()
        .oneshot(get_auth("/api/attachments/999/download", &viewer))
        .await
        .unwrap();
    assert_eq!(download_response.status(), StatusCode::NOT_FOUND);

    let thumbnail_response = router
        .oneshot(get_auth("/api/attachments/999/thumbnail", &viewer))
        .await
        .unwrap();
    assert_eq!(thumbnail_response.status(), StatusCode::NOT_FOUND);
}

/// A body over `MAX_ATTACHMENT_BYTES` but still under the router's
/// `DefaultBodyLimit` (spec §7: 25MB cap, one constant) reaches
/// `AttachmentsService::upload`'s own size check and is rejected as a
/// `422` `Validation` error - the same "service-layer limit, not just a
/// transport-layer one" shape `banto_attachments`'s own crate tests
/// exercise directly (`upload_rejects_bytes_over_the_max_size`).
#[tokio::test]
async fn oversized_attachment_upload_is_rejected_as_validation() {
    let (router, _dir, _admin, editor, _viewer) = router_with_role_tokens_and_backup().await;
    let bytes = vec![0u8; MAX_ATTACHMENT_BYTES + 1];

    let response = router
        .oneshot(post_bytes_auth(
            "/api/attachments?resource=items&resourceId=1&fileName=huge.bin",
            &editor,
            bytes,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["kind"], "validation");
}

/// A body beyond even the router's `DefaultBodyLimit` (spec §3.5: cap +
/// [`ATTACHMENT_BODY_LIMIT_SLACK_BYTES`] slack) never reaches the
/// handler at all - axum itself rejects it with `413 Payload Too Large`,
/// the transport-layer counterpart to the service-layer `422` above.
#[tokio::test]
async fn attachment_upload_beyond_the_body_limit_is_rejected_with_413() {
    let (router, _dir, _admin, editor, _viewer) = router_with_role_tokens_and_backup().await;
    let bytes = vec![0u8; MAX_ATTACHMENT_BYTES + ATTACHMENT_BODY_LIMIT_SLACK_BYTES + 1];

    let response = router
        .oneshot(post_bytes_auth(
            "/api/attachments?resource=items&resourceId=1&fileName=huge.bin",
            &editor,
            bytes,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

/// Upload/delete each record exactly one audit entry (spec §3.5:
/// `action: "create"`/`"delete"`, `resource: "attachments"`, detail
/// `{fileName,sizeBytes,parentResource,parentId}`) - same "once the
/// service call has already succeeded" convention as `items`/`backups`.
#[tokio::test]
async fn attachment_upload_and_delete_are_recorded_in_the_audit_log() {
    let (router, _dir, admin, editor, _viewer) = router_with_role_tokens_and_backup().await;

    let upload_response = router
        .clone()
        .oneshot(post_bytes_auth(
            "/api/attachments?resource=items&resourceId=7&fileName=photo.bin",
            &editor,
            b"binary".to_vec(),
        ))
        .await
        .unwrap();
    let id = body_json(upload_response).await["id"].as_i64().unwrap();

    router
        .clone()
        .oneshot(delete_auth(&format!("/api/attachments/{id}"), &editor))
        .await
        .unwrap();

    let audit_response = router
        .oneshot(post_json_auth(
            "/api/audit-log/list",
            &admin,
            json!(ListParams::default()),
        ))
        .await
        .unwrap();
    let rows = body_json(audit_response).await["rows"].clone();
    let rows = rows.as_array().unwrap();

    let create_entry = rows
        .iter()
        .find(|r| r["action"] == "create" && r["resource"] == "attachments")
        .unwrap_or_else(|| panic!("expected a create entry, got {rows:?}"));
    assert_eq!(create_entry["actorUsername"], "editor");
    let create_detail: serde_json::Value = serde_json::from_str(
        create_entry["detail"]
            .as_str()
            .expect("detail should be set"),
    )
    .unwrap();
    assert_eq!(create_detail["fileName"], "photo.bin");
    assert_eq!(create_detail["parentResource"], "items");
    assert_eq!(create_detail["parentId"], "7");

    let delete_entry = rows
        .iter()
        .find(|r| r["action"] == "delete" && r["resource"] == "attachments")
        .unwrap_or_else(|| panic!("expected a delete entry, got {rows:?}"));
    let delete_detail: serde_json::Value = serde_json::from_str(
        delete_entry["detail"]
            .as_str()
            .expect("detail should be set"),
    )
    .unwrap();
    assert_eq!(delete_detail["fileName"], "photo.bin");
}

/// Upload/delete each broadcast `ServerEvent::ResourceChanged { resource:
/// "attachments" }` (spec §3.5) - `AttachmentsService` itself has no
/// `ServerEvent` awareness (see this module's doc comment), so this
/// checks the handler-level wiring directly, mirroring `items`'s own
/// `update_via_rest_is_observable_on_the_event_channel`.
#[tokio::test]
async fn attachment_upload_and_delete_are_observable_on_the_event_channel() {
    let pool = migrate_memory().await.expect("migrate_memory");
    let (tx, mut rx) = broadcast::channel(16);
    let items = ItemsService::new(pool.clone()).with_events(tx.clone());
    let users = UsersService::new(pool.clone());
    let settings = SettingsService::new(pool.clone());
    let backup = unused_backup_service(pool.clone());
    let dir = tempdir().expect("tempdir");
    let attachments = AttachmentsService::new(pool.clone(), dir.path().join("attachments"));
    let audit = AuditLogService::new(pool);
    let auth = demo_auth();
    let token = auth.login("admin", "admin").await.unwrap();
    let router = api_router(
        items,
        users,
        settings,
        audit,
        backup,
        attachments,
        auth,
        tx,
        false,
    );

    let upload_response = router
        .clone()
        .oneshot(post_bytes_auth(
            "/api/attachments?resource=items&resourceId=1&fileName=note.txt",
            &token,
            b"hello".to_vec(),
        ))
        .await
        .unwrap();
    assert_eq!(upload_response.status(), StatusCode::OK);
    rx.try_recv().expect("upload should emit an event");
    let id = body_json(upload_response).await["id"].as_i64().unwrap();

    router
        .oneshot(delete_auth(&format!("/api/attachments/{id}"), &token))
        .await
        .unwrap();
    let event = rx.try_recv().expect("delete should emit an event");
    assert!(
        matches!(event, ServerEvent::ResourceChanged { resource } if resource == "attachments")
    );
}
