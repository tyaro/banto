//! Issue #938 (config-draft-publish-design §7, S4): `/api/config/*` as THIS
//! app mounts it ([`config_router`]) - the gates of [`config_drafts_access`],
//! the CSRF layer, and the tables of the real migration
//! (`0016_config_drafts.sql`). The router's own rules (conflicts, locks,
//! every audit detail) are tested where it lives
//! (`banto-server`'s `routes/config_drafts/tests.rs`); the Tauri twins in
//! `src-tauri`'s `tests/config_drafts.rs`.

use super::*;
use banto_admin_services::config_drafts::{ConfigTarget, ConfigTargetRegistry};

const TARGET: &str = "plc.line1";
const BASE: &str = "/api/config/plc.line1";

struct Bench {
    router: Router,
    admin: String,
    editor: String,
    viewer: String,
    audit: AuditLogService,
    events: broadcast::Receiver<ServerEvent>,
}

/// `config_router` over the real migrations, with the production
/// `user_auth_state` (a session carries its account's stamp, which the
/// router needs to tell lock holders apart) and one session per role.
/// `targets` stands for what a derived app registers in
/// `crate::config_targets`.
async fn bench_with(targets: ConfigTargetRegistry) -> Bench {
    let pool = migrate_memory().await.expect("migrate_memory");
    let users = reserved_users(&pool);
    let audit = AuditLogService::new(pool.clone());
    for (name, role) in [
        ("manager", Role::Admin),
        ("editor", Role::Editor),
        ("viewer", Role::Viewer),
    ] {
        users
            .create_user(name, "password123", name, role)
            .await
            .expect("create user");
    }
    let auth = user_auth_state(users, audit.clone());
    let mut tokens = Vec::new();
    for name in ["manager", "editor", "viewer"] {
        tokens.push(auth.login(name, "password123").await.expect("login"));
    }
    let service = ConfigDraftsService::new(pool, targets);
    service.ensure_targets().await.expect("ensure targets");
    let (tx, events) = broadcast::channel(64);
    Bench {
        router: config_router(service, audit.clone(), auth, tx),
        admin: tokens.remove(0),
        editor: tokens.remove(0),
        viewer: tokens.remove(0),
        audit,
        events,
    }
}

/// One target, `plc.line1`, with a secret path.
async fn bench() -> Bench {
    let target = ConfigTarget::new(TARGET, json!({"limit": 1, "secret": "s0"}), &["/secret"])
        .expect("target");
    bench_with(
        ConfigTargetRegistry::empty()
            .register(target)
            .expect("register"),
    )
    .await
}

impl Bench {
    async fn call(&self, request: HttpRequest<Body>) -> (StatusCode, serde_json::Value) {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, body)
    }

    /// The audit rows of `resource: "config"`, oldest first.
    async fn config_audit(&self) -> Vec<banto_admin_services::audit::AuditLogEntry> {
        let mut rows = self
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list")
            .rows;
        rows.retain(|row| row.resource == "config");
        rows.sort_by_key(|row| row.id);
        rows
    }

    /// The resources announced since the last call.
    fn announced(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(ServerEvent::ResourceChanged { resource }) = self.events.try_recv() {
            out.push(resource);
        }
        out
    }
}

fn request(
    method: &str,
    path: &str,
    token: &str,
    body: Option<serde_json::Value>,
) -> HttpRequest<Body> {
    let builder = HttpRequest::builder()
        .method(method)
        .uri(path)
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .header("Authorization", format!("Bearer {token}"));
    match body {
        Some(body) => builder
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

/// The template registers no target: the list is empty and a target is 404
/// (after the guards), on the tables of the real migration.
#[tokio::test]
async fn the_template_registers_no_target() {
    assert!(crate::config_targets().is_empty());
    let bench = bench_with(crate::config_targets()).await;

    let (status, body) = bench.call(get_auth("/api/config", &bench.admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([]));

    let (status, body) = bench.call(get_auth(BASE, &bench.admin)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["kind"], "not_found");
}

/// `crate::open_config_drafts` (what both servers call at startup) works on
/// a migrated database and seeds what `config_targets` registers - nothing,
/// in the template - and can be called again.
#[tokio::test]
async fn open_config_drafts_seeds_the_registered_targets_on_the_real_migration() {
    let pool = migrate_memory().await.expect("migrate_memory");
    let service = crate::open_config_drafts(&pool).await.expect("open");
    assert!(service.list().await.expect("list").is_empty());
    crate::open_config_drafts(&pool).await.expect("open again");
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM config_published")
        .fetch_one(pool.as_sqlite().unwrap())
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

/// The router sits behind the same CSRF header check as `api_router`, and a
/// request without a session is 401 and not audited.
#[tokio::test]
async fn config_routes_need_the_client_header_and_a_session() {
    let bench = bench().await;

    let without_header = HttpRequest::builder()
        .uri("/api/config")
        .header("Authorization", format!("Bearer {}", bench.admin))
        .body(Body::empty())
        .unwrap();
    let (status, _) = bench.call(without_header).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let without_token = HttpRequest::builder()
        .uri("/api/config")
        .header(CLIENT_HEADER.0, CLIENT_HEADER.1)
        .body(Body::empty())
        .unwrap();
    let (status, _) = bench.call(without_token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    assert!(bench.config_audit().await.is_empty());
}

/// The template's gates ([`config_drafts_access`]): all four duties need
/// `admin`. An editor or a viewer is refused on a route of every duty with
/// `403 forbidden` and ONE `denied` row (`resource: "config"`), and nothing
/// is written or announced.
#[tokio::test]
async fn only_an_admin_passes_the_templates_gates() {
    let mut bench = bench().await;
    let routes = [
        ("GET", "/api/config".to_string(), None),
        ("GET", BASE.to_string(), None),
        ("POST", format!("{BASE}/lock"), None),
        (
            "PUT",
            format!("{BASE}/draft"),
            Some(json!({"value": {"limit": 2}, "ifRevision": "0", "ifPublishedRevision": "x"})),
        ),
        (
            "POST",
            format!("{BASE}/publish"),
            Some(json!({"ifDraftRevision": "x"})),
        ),
        (
            "POST",
            format!("{BASE}/revert"),
            Some(json!({"toVersion": 0, "ifPublishedRevision": "x"})),
        ),
        (
            "POST",
            format!("{BASE}/unlock"),
            Some(json!({"ifLease": "x"})),
        ),
    ];
    let mut refused = 0;
    for (who, token) in [("editor", &bench.editor), ("viewer", &bench.viewer)] {
        for (method, path, body) in &routes {
            let (status, answer) = bench.call(request(method, path, token, body.clone())).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{who} {method} {path}");
            assert_eq!(answer["kind"], "forbidden", "{who} {method} {path}");
            refused += 1;
        }
    }

    let rows = bench.config_audit().await;
    assert_eq!(rows.len(), refused, "one denied row per refusal");
    assert!(rows
        .iter()
        .all(|row| row.action == "denied" && row.origin == "rest"));
    assert_eq!(rows[0].actor_username.as_deref(), Some("editor"));
    assert!(bench.announced().is_empty());

    // The admin's view: nothing was locked or drafted.
    let (status, state) = bench.call(get_auth(BASE, &bench.admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["draft"], serde_json::Value::Null);
    assert_eq!(state["lock"], serde_json::Value::Null);
    assert_eq!(state["published"]["version"], 0);
}

/// The whole flow over REST on the real migration: lock -> save a draft ->
/// diff -> publish -> history -> revert. The audit rows are `publish` and
/// `revert` (`origin: "rest"`, the admin's snapshot, no secret value), and
/// the events name only the target.
#[tokio::test]
async fn a_draft_is_published_and_reverted_on_the_real_migration() {
    let mut bench = bench().await;
    let admin = bench.admin.clone();

    let (_, state) = bench.call(get_auth(BASE, &admin)).await;
    let published_revision = state["published"]["revision"].as_str().unwrap().to_string();

    let (status, lock) = bench
        .call(request("POST", &format!("{BASE}/lock"), &admin, None))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(lock["holderName"], "manager");

    let (status, saved) = bench
        .call(request(
            "PUT",
            &format!("{BASE}/draft"),
            &admin,
            Some(json!({
                "value": {"limit": 5, "secret": "s1"},
                "ifRevision": "0",
                "ifPublishedRevision": published_revision,
            })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["baseVersion"], 0);
    let draft_revision = saved["revision"].as_str().unwrap().to_string();

    let (status, diff) = bench.call(get_auth(&format!("{BASE}/diff"), &admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(diff["draftRevision"], draft_revision);
    assert_eq!(diff["changes"].as_array().unwrap().len(), 2);

    assert_eq!(
        bench.announced(),
        vec![format!("config-draft:{TARGET}"); 2],
        "the lock and the save, nothing else"
    );
    assert!(
        bench.config_audit().await.is_empty(),
        "locks and draft saves are not audited"
    );

    let (status, outcome) = bench
        .call(request(
            "POST",
            &format!("{BASE}/publish"),
            &admin,
            Some(json!({"ifDraftRevision": draft_revision, "comment": "first"})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{outcome}");
    assert_eq!(outcome["kind"], "publish");
    assert_eq!(outcome["version"], 1);
    assert_eq!(bench.announced(), vec![format!("config:{TARGET}")]);

    let (status, history) = bench
        .call(get_auth(&format!("{BASE}/history"), &admin))
        .await;
    assert_eq!(status, StatusCode::OK);
    let history = history.as_array().unwrap().clone();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["version"], 1);
    assert_eq!(history[0]["actorUsername"], "manager");
    assert_eq!(history[0]["origin"], "rest");
    assert_eq!(history[1]["kind"], "initial");

    let (status, reverted) = bench
        .call(request(
            "POST",
            &format!("{BASE}/revert"),
            &admin,
            Some(json!({
                "toVersion": 0,
                "ifPublishedRevision": outcome["revision"],
            })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{reverted}");
    assert_eq!(reverted["kind"], "revert");
    assert_eq!(reverted["version"], 2);
    assert_eq!(reverted["revertedTo"], 0);
    assert_eq!(bench.announced(), vec![format!("config:{TARGET}")]);

    let (_, state) = bench.call(get_auth(BASE, &admin)).await;
    assert_eq!(
        state["published"]["value"],
        json!({"limit": 1, "secret": "s0"})
    );
    assert_eq!(state["published"]["version"], 2);

    let rows = bench.config_audit().await;
    assert_eq!(
        rows.iter()
            .map(|row| row.action.as_str())
            .collect::<Vec<_>>(),
        ["publish", "revert"]
    );
    for row in &rows {
        assert_eq!(row.entity_id.as_deref(), Some(TARGET));
        assert_eq!(row.actor_username.as_deref(), Some("manager"));
        assert_eq!(row.origin, "rest");
        assert_eq!(row.result, "ok");
        let detail = row.detail.as_ref().expect("detail").to_string();
        assert!(
            !detail.contains("s0") && !detail.contains("s1"),
            "a secret value in the audit detail: {detail}"
        );
    }
}
