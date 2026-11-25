//! Issue #935 S3 (design `docs/design/sse-stream-design.md` §7):
//! `docs/recipes/app-sse-stream.md` shows server code that must work when
//! copied. The code of the recipe's Rust block lives in `sse_recipe/plant.rs`
//! (compiled here) and `the_recipe_shows_the_code_that_is_tested` fails when
//! the two drift apart. The rest drives that code from OUTSIDE the crate,
//! through its router: the `PermissionGuard` layer refuses a caller without
//! the permission (and the refusal is audited), a caller with it gets the
//! stream, and every cycle of the producer is a value with a new stamp.

#[path = "sse_recipe/plant.rs"]
mod plant;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use banto_admin_services::audit::AuditLogService;
use banto_admin_services::permissions::PermissionKey;
use banto_core::ListParams;
use banto_server::{
    AuthState, Identity, SessionAccount, SessionPermissions, SessionStamp, SessionValidation,
};
use banto_storage::Db;
use http_body_util::BodyExt;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt;

const PATH: &str = "/api/plant/stream";

/// In-memory SQLite with the `audit_log` columns the service writes.
async fn audit_service() -> AuditLogService {
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

/// `alice` (password `"pw"`), holding exactly `held`.
fn auth_holding(held: BTreeSet<PermissionKey>) -> AuthState {
    let account = SessionAccount {
        identity: Identity {
            id: "alice".to_string(),
            name: "Alice".to_string(),
            role: "admin".to_string(),
            account_id: None,
        },
        stamp: SessionStamp {
            account_id: 1,
            auth_epoch: 0,
        },
    };
    let held = Arc::new(Mutex::new(held));
    let (for_login, for_lookup) = (account.clone(), account);
    AuthState::new(
        move |user: String, password: String| {
            let identity =
                (user == "alice" && password == "pw").then(|| for_login.identity.clone());
            Box::pin(async move { identity })
        },
        SessionValidation::lookup(move |_user: String| {
            let account = for_lookup.clone();
            Box::pin(async move { Ok(Some(account)) })
        }),
    )
    .with_permission_reader(move |_account_id: i64| {
        let held = held.lock().unwrap().clone();
        Box::pin(async move { Ok(SessionPermissions::new(held)) })
    })
}

async fn get_stream(router: Router, token: &str) -> axum::response::Response {
    router
        .oneshot(
            Request::builder()
                .uri(PATH)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

/// The `madeAt` of the next `values` event of `body`.
async fn next_made_at(body: &mut Body) -> u64 {
    let mut received = String::new();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("a frame within 5 s")
            .expect("the stream is still open")
            .expect("a readable frame");
        if let Some(data) = frame.data_ref() {
            received.push_str(&String::from_utf8_lossy(data));
        }
        if let Some(at) = received.find("event: values\ndata: ") {
            let rest = &received[at + "event: values\ndata: ".len()..];
            if let Some(end) = rest.find('\n') {
                let json: serde_json::Value = serde_json::from_str(&rest[..end]).unwrap();
                return json["madeAt"].as_u64().expect("a madeAt stamp");
            }
        }
    }
}

#[tokio::test]
async fn a_caller_without_the_permission_is_refused_and_audited() {
    let audit = audit_service().await;
    let auth = auth_holding(BTreeSet::new());
    let token = auth.login("alice", "pw").await.expect("alice logs in");
    let router = plant::plant_router(
        plant::spawn_producer(Duration::from_millis(50)),
        audit.clone(),
        auth,
    );

    let response = get_stream(router, &token).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let rows = audit.list(ListParams::default()).await.unwrap().rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].action.as_str(), rows[0].resource.as_str()),
        ("denied", "plant")
    );
}

#[tokio::test]
async fn a_caller_with_the_permission_gets_a_new_stamp_every_cycle() {
    let audit = audit_service().await;
    let auth = auth_holding(BTreeSet::from([
        PermissionKey::parse(plant::PLANT_VIEW).unwrap()
    ]));
    let token = auth.login("alice", "pw").await.expect("alice logs in");
    let router = plant::plant_router(
        plant::spawn_producer(Duration::from_millis(50)),
        audit,
        auth,
    );

    let response = get_stream(router, &token).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    let mut body = response.into_body();
    // The first event is the last value made (a re-send of it on every
    // reconnect); the producer then makes a value with a newer stamp.
    let first = next_made_at(&mut body).await;
    let mut latest = first;
    for _ in 0..10 {
        latest = next_made_at(&mut body).await;
        if latest > first {
            break;
        }
    }
    assert!(latest > first, "the producer's cycles carry new stamps");
}

/// The block of `docs/recipes/app-sse-stream.md` that starts with `marker`
/// (its first line), without that line.
fn recipe_block(recipe: &str, marker: &str) -> String {
    let start = recipe
        .find(&format!("```rust\n{marker}\n"))
        .unwrap_or_else(|| panic!("the recipe has no Rust block marked {marker:?}"));
    let body = &recipe[start + "```rust\n".len() + marker.len() + 1..];
    body[..body.find("\n```").expect("the block is closed")].to_string()
}

#[test]
fn the_recipe_shows_the_code_that_is_tested() {
    let recipe = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/recipes/app-sse-stream.md"
    ))
    .expect("the recipe exists");
    let shown = recipe_block(&recipe, "// apps/<アプリ>/core/src/rest/plant.rs");
    let tested = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/sse_recipe/plant.rs"
    ))
    .unwrap();
    assert_eq!(
        shown.replace("\r\n", "\n").trim_end(),
        tested.replace("\r\n", "\n").trim_end(),
        "the recipe's Rust block and tests/sse_recipe/plant.rs must be the same text"
    );
}
