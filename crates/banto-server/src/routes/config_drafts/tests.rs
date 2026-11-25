//! REST cases of config-draft-publish-design §6: T12 (the four gates, the
//! refusals), T13 (the `409` bodies, reason by reason) and T14 (the audit
//! rows, the events, no secret in any of them). The service's own behaviour
//! is covered in `banto-admin-services`; here the service is real (SQLite
//! `:memory:`) and only the wiring is looked at.

use super::*;
use axum::body::Body;
use axum::http::Request;
use banto_admin_services::config_drafts::{ConfigTarget, ConfigTargetRegistry};
use banto_storage::Db;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt;

const TARGET: &str = "plc.line1";
const BASE: &str = "/api/config/plc.line1";

/// The tables the two services write. The config tables re-state the app's
/// `migrations-sqlite/0016_config_drafts.sql` (design §4.5) and MUST be kept
/// in sync with it (`verify:architecture`'s `config-drafts-ddl-copies`
/// compares them).
const DDL: [&str; 6] = [
    "CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        actor_username TEXT, actor_id INTEGER, actor_role TEXT, actor_kind TEXT,
        action TEXT NOT NULL, resource TEXT NOT NULL,
        entity_id TEXT, detail TEXT,
        origin TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'ok'
    )",
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE config_published (
        target       TEXT PRIMARY KEY,
        value        TEXT NOT NULL,
        version      INTEGER NOT NULL,
        revision     TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT (datetime('now'))
    )",
    "CREATE TABLE config_history (
        target         TEXT NOT NULL,
        version        INTEGER NOT NULL,
        value          TEXT NOT NULL,
        kind           TEXT NOT NULL,
        reverted_to    INTEGER,
        actor_username TEXT,
        actor_id       INTEGER,
        actor_kind     TEXT,
        origin         TEXT,
        comment        TEXT,
        published_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (target, version)
    )",
    "CREATE TABLE config_drafts (
        target       TEXT PRIMARY KEY,
        value        TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        revision     TEXT NOT NULL,
        updated_by   TEXT NOT NULL,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )",
    "CREATE TABLE config_locks (
        target         TEXT PRIMARY KEY,
        holder         TEXT NOT NULL,
        holder_name    TEXT NOT NULL,
        lease          TEXT NOT NULL,
        acquired_at_ms INTEGER NOT NULL,
        expires_at_ms  INTEGER NOT NULL
    )",
];

/// `(username, users.id, role, permissions)`. The permissions only matter to
/// a [`ConfigDraftsGate::Permission`].
const ACCOUNTS: [(&str, i64, &str, &[&str]); 9] = [
    ("admin-user", 1, "admin", &[]),
    ("other-admin", 2, "admin", &[]),
    ("editor-user", 3, "editor", &[]),
    ("viewer-user", 4, "viewer", &[]),
    ("reader", 10, "viewer", &["config.read"]),
    // every duty but the one the others depend on
    (
        "no-read",
        11,
        "viewer",
        &["config.edit", "config.publish", "config.unlock"],
    ),
    ("drafter", 12, "viewer", &["config.read", "config.edit"]),
    (
        "publisher",
        13,
        "viewer",
        &["config.read", "config.publish"],
    ),
    ("unlocker", 14, "viewer", &["config.read", "config.unlock"]),
];

fn key(raw: &str) -> PermissionKey {
    PermissionKey::parse(raw).unwrap()
}

fn account(username: &str) -> Option<SessionAccount> {
    ACCOUNTS
        .iter()
        .find(|(name, ..)| *name == username)
        .map(|(name, id, role, _)| SessionAccount {
            identity: Identity {
                id: name.to_string(),
                name: format!("{name} (display)"),
                role: role.to_string(),
                account_id: None,
            },
            stamp: SessionStamp {
                account_id: *id,
                auth_epoch: 0,
            },
        })
}

fn auth_state() -> AuthState {
    let held: HashMap<i64, BTreeSet<PermissionKey>> = ACCOUNTS
        .iter()
        .map(|(_, id, _, keys)| (*id, keys.iter().map(|k| key(k)).collect()))
        .collect();
    AuthState::new(
        |_u: String, _p: String| Box::pin(async { None }),
        SessionValidation::lookup(|username: String| {
            Box::pin(async move { Ok(account(&username)) })
        }),
    )
    .with_permission_reader(move |account_id: i64| {
        let keys = held.get(&account_id).cloned().unwrap_or_default();
        Box::pin(async move { Ok(SessionPermissions::new(keys)) })
    })
}

/// One permission per duty.
fn permission_access() -> ConfigDraftsAccess {
    ConfigDraftsAccess {
        read: ConfigDraftsGate::Permission(key("config.read")),
        edit: ConfigDraftsGate::Permission(key("config.edit")),
        publish: ConfigDraftsGate::Permission(key("config.publish")),
        unlock: ConfigDraftsGate::Permission(key("config.unlock")),
    }
}

/// An audit row as the cases compare it.
#[derive(Debug, Clone, PartialEq)]
struct AuditRow {
    actor: Option<String>,
    action: String,
    resource: String,
    entity_id: Option<String>,
    detail: Option<Value>,
    origin: String,
    result: String,
}

struct Bench {
    router: Router,
    auth: AuthState,
    db: Db,
    events: broadcast::Receiver<ServerEvent>,
}

impl Bench {
    fn token(&self, username: &str) -> String {
        self.auth
            .issue_account_token(account(username).expect("a known account"), false)
    }

    /// Every audit row, oldest first.
    async fn audit_rows(&self) -> Vec<AuditRow> {
        type Row = (
            Option<String>,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
        );
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT actor_username, action, resource, entity_id, detail, origin, result
             FROM audit_log ORDER BY id",
        )
        .fetch_all(self.db.as_sqlite().unwrap())
        .await
        .unwrap();
        rows.into_iter()
            .map(
                |(actor, action, resource, entity_id, detail, origin, result)| AuditRow {
                    actor,
                    action,
                    resource,
                    entity_id,
                    detail: detail.map(|text| serde_json::from_str(&text).unwrap()),
                    origin,
                    result,
                },
            )
            .collect()
    }

    /// The `resource` of every event sent since the last call.
    fn drain_events(&mut self) -> Vec<String> {
        let mut seen = Vec::new();
        loop {
            match self.events.try_recv() {
                Ok(ServerEvent::ResourceChanged { resource }) => seen.push(resource),
                Ok(other) => panic!("unexpected event {other:?}"),
                Err(TryRecvError::Empty) => return seen,
                Err(err) => panic!("event channel: {err:?}"),
            }
        }
    }

    /// `(status, body as JSON, body as text)`. An empty body is `null`.
    async fn call(
        &self,
        token: Option<&str>,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value, String) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(body) => request
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        let value = serde_json::from_str(&text).unwrap_or(Value::Null);
        (status, value, text)
    }

    /// A call that must succeed; its JSON body.
    async fn ok(&self, token: &str, method: &str, path: &str, body: Option<Value>) -> Value {
        let (status, value, text) = self.call(Some(token), method, path, body).await;
        assert!(status.is_success(), "{method} {path}: {status} {text}");
        value
    }

    /// A call that must be a `409`; its whole body, after the shape every
    /// conflict shares was checked (T13).
    async fn conflict(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
        reason: &str,
    ) -> Value {
        let (status, value, text) = self.call(Some(token), method, path, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {path}: {text}");
        assert_eq!(value["kind"], "conflict", "{text}");
        assert!(value["message"].is_string(), "{text}");
        assert_eq!(value["current"]["reason"], reason, "{text}");
        // neither the holder's key nor a lease is in a conflict
        assert!(!text.contains("acct:") && !text.contains("lease"), "{text}");
        value
    }

    /// Acquire the lock and save a first draft: `(lease, draft revision)`.
    async fn start_draft(&self, token: &str, value: Value) -> (String, String) {
        let lock = self.ok(token, "POST", &format!("{BASE}/lock"), None).await;
        let state = self.ok(token, "GET", BASE, None).await;
        let saved = self
            .ok(
                token,
                "PUT",
                &format!("{BASE}/draft"),
                Some(json!({
                    "value": value,
                    "ifRevision": "0",
                    "ifPublishedRevision": state["published"]["revision"],
                })),
            )
            .await;
        (
            lock["lease"].as_str().unwrap().to_string(),
            saved["revision"].as_str().unwrap().to_string(),
        )
    }

    async fn publish(&self, token: &str, revision: &str) -> Value {
        self.ok(
            token,
            "POST",
            &format!("{BASE}/publish"),
            Some(json!({ "ifDraftRevision": revision })),
        )
        .await
    }
}

async fn bench_with(access: ConfigDraftsAccess, default: Value, masked: &[&str]) -> Bench {
    bench_on(auth_state(), access, default, masked).await
}

async fn bench_on(
    auth: AuthState,
    access: ConfigDraftsAccess,
    default: Value,
    masked: &[&str],
) -> Bench {
    let db = Db::connect_sqlite_memory().await.expect("in-memory sqlite");
    for sql in DDL {
        sqlx::query(sql)
            .execute(db.as_sqlite().expect("sqlite handle"))
            .await
            .expect("create table");
    }
    let targets = ConfigTargetRegistry::empty()
        .register(ConfigTarget::new(TARGET, default, masked).unwrap())
        .unwrap();
    let service = ConfigDraftsService::new(db.clone(), targets);
    service.ensure_targets().await.expect("ensure targets");
    let audit = AuditLogService::new(db.clone());
    let (tx, events) = broadcast::channel(64);
    let router = config_drafts_router(service, access, audit, auth.clone(), tx);
    Bench {
        router,
        auth,
        db,
        events,
    }
}

async fn bench() -> Bench {
    bench_with(ConfigDraftsAccess::default(), json!({ "limit": 1 }), &[]).await
}

/// Every route, by duty. The bodies are only good enough to get past the
/// extractors: these cases look at the gates, not at the outcome.
fn routes() -> Vec<(&'static str, &'static str, String, Option<Value>)> {
    let lease = json!({ "lease": "x" });
    vec![
        ("read", "GET", "/api/config".to_string(), None),
        ("read", "GET", BASE.to_string(), None),
        ("read", "GET", format!("{BASE}/diff"), None),
        ("read", "GET", format!("{BASE}/history"), None),
        ("read", "GET", format!("{BASE}/history/0"), None),
        ("edit", "POST", format!("{BASE}/lock"), None),
        ("edit", "PUT", format!("{BASE}/lock"), Some(lease)),
        ("edit", "DELETE", format!("{BASE}/lock?lease=x"), None),
        (
            "edit",
            "PUT",
            format!("{BASE}/draft"),
            Some(json!({ "value": {}, "ifRevision": "x" })),
        ),
        ("edit", "DELETE", format!("{BASE}/draft?ifRevision=x"), None),
        (
            "edit",
            "POST",
            format!("{BASE}/draft/rebase"),
            Some(json!({ "ifRevision": "x", "ifPublishedRevision": "x" })),
        ),
        (
            "publish",
            "POST",
            format!("{BASE}/publish"),
            Some(json!({ "ifDraftRevision": "x" })),
        ),
        (
            "publish",
            "POST",
            format!("{BASE}/revert"),
            Some(json!({ "toVersion": 0, "ifPublishedRevision": "x" })),
        ),
        (
            "unlock",
            "POST",
            format!("{BASE}/unlock"),
            Some(json!({ "ifLease": "x" })),
        ),
    ]
}

fn refused(status: StatusCode) -> bool {
    status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED
}

/// The `denied` row of a refused `method path` by `actor`.
fn denied_row(actor: &str, method: &str, path: &str) -> AuditRow {
    AuditRow {
        actor: Some(actor.to_string()),
        action: "denied".to_string(),
        resource: "config".to_string(),
        entity_id: None,
        detail: Some(json!({ "method": method, "path": path.split('?').next().unwrap() })),
        origin: "rest".to_string(),
        result: "denied".to_string(),
    }
}

// --- T12: the gates ---------------------------------------------------------

/// The default access: every route needs `admin`. A lower role is `403` with
/// ONE `denied` row per request; no session is `401` and is not audited.
#[tokio::test]
async fn by_default_every_route_needs_admin_and_a_refusal_is_audited_once() {
    let mut b = bench().await;
    let admin = b.token("admin-user");
    let mut expected = Vec::new();
    for (_, method, path, body) in routes() {
        let (status, ..) = b.call(None, method, &path, body.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
        for user in ["editor-user", "viewer-user"] {
            let token = b.token(user);
            let (status, value, _) = b.call(Some(&token), method, &path, body.clone()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{user} {method} {path}");
            assert_eq!(value, json!({ "kind": "forbidden" }));
            expected.push(denied_row(user, method, &path));
        }
    }
    assert_eq!(b.audit_rows().await, expected);
    // a refusal changes nothing, so nothing is announced
    assert!(b.drain_events().is_empty());

    // admin gets past both gates on every route (what the route then
    // answers is the service's business)
    for (_, method, path, body) in routes() {
        let (status, _, text) = b.call(Some(&admin), method, &path, body).await;
        assert!(!refused(status), "admin {method} {path}: {status} {text}");
    }
}

/// One permission per duty: a session passes exactly the duties it holds -
/// as long as it also holds `read`. The role is not looked at.
#[tokio::test]
async fn each_duty_has_its_own_gate() {
    let b = bench_with(permission_access(), json!({ "limit": 1 }), &[]).await;
    for (user, duties) in [
        ("reader", vec!["read"]),
        ("drafter", vec!["read", "edit"]),
        ("publisher", vec!["read", "publish"]),
        ("unlocker", vec!["read", "unlock"]),
        // the role alone opens nothing
        ("admin-user", vec![]),
    ] {
        let token = b.token(user);
        let before = b.audit_rows().await.len();
        let mut denials = 0;
        for (duty, method, path, body) in routes() {
            let (status, _, text) = b.call(Some(&token), method, &path, body).await;
            if duties.contains(&duty) {
                assert!(!refused(status), "{user} {method} {path}: {status} {text}");
            } else {
                assert_eq!(status, StatusCode::FORBIDDEN, "{user} {method} {path}");
                denials += 1;
            }
        }
        // one `denied` row per refusal, all of them this user's
        let rows = b.audit_rows().await;
        let new: Vec<_> = rows[before..]
            .iter()
            .filter(|row| row.action == "denied")
            .collect();
        assert_eq!(new.len(), denials, "{user}");
        assert!(new.iter().all(|row| row.actor.as_deref() == Some(user)));
    }
}

/// `read` is a condition of the other three (design §4.9): a session that
/// holds edit, publish and unlock but not read is refused everywhere, by the
/// read gate - before a handler could answer with the draft (a `409`'s
/// `current`) or a diff.
#[tokio::test]
async fn without_read_no_duty_is_open_and_no_value_leaks() {
    let b = bench_with(permission_access(), json!({ "limit": 1 }), &[]).await;
    // a draft whose value must not reach the session below
    let drafter = b.token("drafter");
    let (lease, revision) = b
        .start_draft(&drafter, json!({ "limit": 2, "note": "s3cret-draft" }))
        .await;
    let before = b.audit_rows().await.len();

    let token = b.token("no-read");
    // requests that WOULD answer with values if a handler ran: a save with a
    // stale revision (`draft_changed` carries the draft), a publish (the
    // diff), an unlock of the lease that is really there
    let mut calls = routes();
    calls.push((
        "edit",
        "PUT",
        format!("{BASE}/draft"),
        Some(json!({ "value": { "limit": 9 }, "ifRevision": "stale" })),
    ));
    calls.push((
        "publish",
        "POST",
        format!("{BASE}/publish"),
        Some(json!({ "ifDraftRevision": revision })),
    ));
    calls.push((
        "unlock",
        "POST",
        format!("{BASE}/unlock"),
        Some(json!({ "ifLease": lease })),
    ));
    let mut expected = Vec::new();
    for (_, method, path, body) in calls {
        let (status, _, text) = b.call(Some(&token), method, &path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(text, r#"{"kind":"forbidden"}"#);
        expected.push(denied_row("no-read", method, &path));
    }
    // exactly one row per refusal: the read gate's, the duty's gate never ran
    assert_eq!(b.audit_rows().await[before..], expected);
    // and nothing happened: the draft and the lock are as they were
    let state = b.ok(&drafter, "GET", BASE, None).await;
    assert_eq!(state["draft"]["revision"], revision.as_str());
    assert_eq!(state["lock"]["lease"], lease.as_str());
    assert_eq!(state["published"]["version"], 0);
}

/// A role floor and a permission can be mixed over the duties.
#[tokio::test]
async fn a_role_floor_and_a_permission_can_be_mixed() {
    let access = ConfigDraftsAccess {
        read: ConfigDraftsGate::Role(Role::Viewer),
        edit: ConfigDraftsGate::Role(Role::Editor),
        publish: ConfigDraftsGate::Permission(key("config.publish")),
        unlock: ConfigDraftsGate::Role(Role::Admin),
    };
    let b = bench_with(access, json!({ "limit": 1 }), &[]).await;
    let pass = |user: &str, duty: &str| match duty {
        "read" => true,
        "edit" => matches!(user, "editor-user" | "admin-user"),
        "publish" => user == "publisher",
        _ => user == "admin-user",
    };
    for user in ["viewer-user", "editor-user", "admin-user", "publisher"] {
        let token = b.token(user);
        for (duty, method, path, body) in routes() {
            let (status, ..) = b.call(Some(&token), method, &path, body).await;
            assert_eq!(!refused(status), pass(user, duty), "{user} {method} {path}");
        }
    }
}

/// The editor is the session's account row; a session without one (an
/// `AuthState` without a session lookup issues such tokens) cannot hold a
/// lock and is refused like no session - although its role passes the gates.
/// The routes that need no editor still answer.
#[tokio::test]
async fn a_session_without_an_account_row_cannot_edit() {
    let auth = AuthState::new(
        |_u: String, _p: String| Box::pin(async { None }),
        SessionValidation::DisabledNoRevocation,
    );
    let mut b = bench_on(
        auth,
        ConfigDraftsAccess::default(),
        json!({ "limit": 1 }),
        &[],
    )
    .await;
    let token = b.auth.issue_token(Identity {
        id: "ghost".to_string(),
        name: "ghost".to_string(),
        role: "admin".to_string(),
        account_id: None,
    });
    let (status, ..) = b.call(Some(&token), "GET", "/api/config", None).await;
    assert_eq!(status, StatusCode::OK);
    for (method, path, body) in [
        ("GET", BASE.to_string(), None),
        ("POST", format!("{BASE}/lock"), None),
        (
            "POST",
            format!("{BASE}/revert"),
            Some(json!({ "toVersion": 0, "ifPublishedRevision": "x" })),
        ),
    ] {
        let (status, value, _) = b.call(Some(&token), method, &path, body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
        assert_eq!(value, json!({ "kind": "unauthorized" }));
    }
    assert!(b.audit_rows().await.is_empty());
    assert!(b.drain_events().is_empty());
    let locks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM config_locks")
        .fetch_one(b.db.as_sqlite().unwrap())
        .await
        .unwrap();
    assert_eq!(locks, 0);
}

// --- T13: the 409 bodies ----------------------------------------------------

#[tokio::test]
async fn every_conflict_is_409_with_its_reason_in_current() {
    let b = bench().await;
    let (alice, bob) = (b.token("admin-user"), b.token("other-admin"));
    let lock_path = format!("{BASE}/lock");
    let draft_path = format!("{BASE}/draft");

    // lock_required: a save without the lock
    let first_save =
        json!({ "value": { "limit": 2 }, "ifRevision": "0", "ifPublishedRevision": "x" });
    let body = b
        .conflict(
            &alice,
            "PUT",
            &draft_path,
            Some(first_save),
            "lock_required",
        )
        .await;
    assert_eq!(body["current"]["lock"], Value::Null);

    // published_changed: the first save names a published revision that is
    // not the current one; `current.published` has no value
    let lock = b.ok(&alice, "POST", &lock_path, None).await;
    let published = b.ok(&alice, "GET", BASE, None).await["published"].clone();
    let body = b
        .conflict(
            &alice,
            "PUT",
            &draft_path,
            Some(
                json!({ "value": { "limit": 2 }, "ifRevision": "0", "ifPublishedRevision": "old" }),
            ),
            "published_changed",
        )
        .await;
    assert_eq!(
        body["current"]["published"],
        json!({ "version": 0, "revision": published["revision"] })
    );

    // lock_held: someone else's acquire, save-less publish and unlock with a
    // lease that is not the lock's. `current.lock` names the holder and the
    // times only.
    let body = b
        .conflict(&bob, "POST", &lock_path, None, "lock_held")
        .await;
    assert_eq!(
        body["current"]["lock"],
        json!({
            "holderName": "admin-user",
            "acquiredAtMs": lock["acquiredAtMs"],
            "expiresAtMs": lock["expiresAtMs"],
        })
    );
    b.conflict(
        &bob,
        "POST",
        &format!("{BASE}/unlock"),
        Some(json!({ "ifLease": "not-the-lease" })),
        "lock_held",
    )
    .await;

    // draft_changed: a save with a revision that is not the draft's.
    // `current.draft` is the draft as it is now (which is why the edit
    // routes are behind the read gate).
    let saved = b
        .ok(
            &alice,
            "PUT",
            &draft_path,
            Some(json!({
                "value": { "limit": 2 },
                "ifRevision": "0",
                "ifPublishedRevision": published["revision"],
            })),
        )
        .await;
    let revision = saved["revision"].as_str().unwrap();
    let body = b
        .conflict(
            &alice,
            "PUT",
            &draft_path,
            Some(json!({ "value": { "limit": 3 }, "ifRevision": "stale" })),
            "draft_changed",
        )
        .await;
    assert_eq!(body["current"]["revision"], revision);
    assert_eq!(body["current"]["draft"]["value"], json!({ "limit": 2 }));
    b.conflict(
        &alice,
        "POST",
        &format!("{BASE}/publish"),
        Some(json!({ "ifDraftRevision": "stale" })),
        "draft_changed",
    )
    .await;
    b.conflict(
        &alice,
        "DELETE",
        &format!("{draft_path}?ifRevision=stale"),
        None,
        "draft_changed",
    )
    .await;
    // while alice holds the lock, bob cannot publish her draft
    b.conflict(
        &bob,
        "POST",
        &format!("{BASE}/publish"),
        Some(json!({ "ifDraftRevision": revision })),
        "lock_held",
    )
    .await;

    // published_changed: a revert that names an old published revision
    b.publish(&alice, revision).await;
    b.conflict(
        &alice,
        "POST",
        &format!("{BASE}/revert"),
        Some(json!({ "toVersion": 0, "ifPublishedRevision": published["revision"] })),
        "published_changed",
    )
    .await;

    // stale_base: the published value moved (a revert) after the draft was
    // started
    let (lease, revision) = b.start_draft(&alice, json!({ "limit": 5 })).await;
    let now = b.ok(&alice, "GET", BASE, None).await["published"].clone();
    // ... which bob cannot do while alice holds the lock
    b.conflict(
        &bob,
        "POST",
        &format!("{BASE}/revert"),
        Some(json!({ "toVersion": 0, "ifPublishedRevision": now["revision"] })),
        "lock_held",
    )
    .await;
    b.ok(
        &alice,
        "POST",
        &format!("{BASE}/revert"),
        Some(json!({ "toVersion": 0, "ifPublishedRevision": now["revision"] })),
    )
    .await;
    let body = b
        .conflict(
            &alice,
            "POST",
            &format!("{BASE}/publish"),
            Some(json!({ "ifDraftRevision": revision })),
            "stale_base",
        )
        .await;
    assert_eq!(body["current"]["published"]["version"], 2);

    // lock_required: extend / release with a lease that is not the lock's,
    // and an extend after the release (never a new acquire)
    b.conflict(
        &alice,
        "PUT",
        &lock_path,
        Some(json!({ "lease": "another-tab" })),
        "lock_required",
    )
    .await;
    let (status, ..) = b
        .call(
            Some(&alice),
            "DELETE",
            &format!("{lock_path}?lease={lease}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    b.conflict(
        &alice,
        "PUT",
        &lock_path,
        Some(json!({ "lease": lease })),
        "lock_required",
    )
    .await;

    // a conflict is not an audited write
    let actions: Vec<_> = b.audit_rows().await.into_iter().map(|r| r.action).collect();
    assert_eq!(actions, ["publish", "revert"]);
}

/// Not conflicts: an unknown target is `404`, a missing condition is a field
/// error - and neither is audited or announced.
#[tokio::test]
async fn an_unknown_target_and_a_missing_condition_are_not_conflicts() {
    let mut b = bench().await;
    let admin = b.token("admin-user");
    for (method, path, body) in [
        ("GET", "/api/config/nope".to_string(), None),
        ("POST", "/api/config/nope/lock".to_string(), None),
        (
            "POST",
            "/api/config/nope/publish".to_string(),
            Some(json!({ "ifDraftRevision": "x" })),
        ),
    ] {
        let (status, value, _) = b.call(Some(&admin), method, &path, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
        assert_eq!(value["kind"], "not_found");
    }
    b.ok(&admin, "POST", &format!("{BASE}/lock"), None).await;
    b.drain_events();
    for path in [format!("{BASE}/lock"), format!("{BASE}/draft")] {
        let (status, value, _) = b.call(Some(&admin), "DELETE", &path, None).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}");
        assert_eq!(value["kind"], "validation");
    }
    assert!(b.audit_rows().await.is_empty());
    assert!(b.drain_events().is_empty());
}

// --- T14: audit rows and events ---------------------------------------------

/// The whole of an editing session: which calls write an audit row, and
/// which event each call sends - one per call.
#[tokio::test]
async fn publish_and_revert_write_one_audit_row_and_send_one_event() {
    let mut b = bench().await;
    let (alice, bob) = (b.token("admin-user"), b.token("other-admin"));
    let draft_event = vec![format!("config-draft:{TARGET}")];
    let published_event = vec![format!("config:{TARGET}")];

    // lock, save, extend, rebase: announced to the editing screens, not
    // audited
    let lock = b.ok(&alice, "POST", &format!("{BASE}/lock"), None).await;
    assert_eq!(b.drain_events(), draft_event);
    let state = b.ok(&alice, "GET", BASE, None).await;
    let published_revision = state["published"]["revision"].clone();
    let saved = b
        .ok(
            &alice,
            "PUT",
            &format!("{BASE}/draft"),
            Some(json!({
                "value": { "limit": 2 },
                "ifRevision": "0",
                "ifPublishedRevision": published_revision,
            })),
        )
        .await;
    assert_eq!(b.drain_events(), draft_event);
    assert_eq!(saved["baseVersion"], 0);
    assert_eq!(saved["validation"], json!([]));
    b.ok(
        &alice,
        "PUT",
        &format!("{BASE}/lock"),
        Some(json!({ "lease": lock["lease"] })),
    )
    .await;
    assert_eq!(b.drain_events(), draft_event);
    let rebased = b
        .ok(
            &alice,
            "POST",
            &format!("{BASE}/draft/rebase"),
            Some(json!({
                "ifRevision": saved["revision"],
                "ifPublishedRevision": published_revision,
            })),
        )
        .await;
    assert_eq!(b.drain_events(), draft_event);
    // reads: neither
    for path in ["/api/config".to_string(), format!("{BASE}/diff")] {
        b.ok(&alice, "GET", &path, None).await;
    }
    assert!(b.drain_events().is_empty());
    assert!(b.audit_rows().await.is_empty());

    // a publish that fails changes nothing: no row, no event
    b.conflict(
        &alice,
        "POST",
        &format!("{BASE}/publish"),
        Some(json!({ "ifDraftRevision": saved["revision"] })),
        "draft_changed",
    )
    .await;
    assert!(b.drain_events().is_empty());
    assert!(b.audit_rows().await.is_empty());

    // publish: one row, one event
    let done = b
        .ok(
            &alice,
            "POST",
            &format!("{BASE}/publish"),
            Some(
                json!({ "ifDraftRevision": rebased["revision"], "comment": "  raise the limit  " }),
            ),
        )
        .await;
    assert_eq!(b.drain_events(), published_event);
    assert_eq!(done["version"], 1);
    assert_eq!(done["previousVersion"], 0);
    let changes = json!([{ "field": "/limit", "before": 1, "after": 2 }]);
    assert_eq!(done["changes"], changes);
    let publish_row = AuditRow {
        actor: Some("admin-user".to_string()),
        action: "publish".to_string(),
        resource: "config".to_string(),
        entity_id: Some(TARGET.to_string()),
        detail: Some(json!({
            "version": 1,
            "previousVersion": 0,
            "comment": "raise the limit",
            "changes": changes,
        })),
        origin: "rest".to_string(),
        result: "ok".to_string(),
    };
    assert_eq!(b.audit_rows().await, std::slice::from_ref(&publish_row));

    // revert (by someone else: the publish gave the lock back with the
    // draft): one row, one event
    let state = b.ok(&bob, "GET", BASE, None).await;
    assert_eq!(state["draft"], Value::Null);
    let back = b
        .ok(
            &bob,
            "POST",
            &format!("{BASE}/revert"),
            Some(json!({
                "toVersion": 0,
                "ifPublishedRevision": state["published"]["revision"],
            })),
        )
        .await;
    assert_eq!(b.drain_events(), published_event);
    assert_eq!(back["version"], 2);
    let revert_row = AuditRow {
        actor: Some("other-admin".to_string()),
        action: "revert".to_string(),
        detail: Some(json!({
            "version": 2,
            "previousVersion": 1,
            "revertedTo": 0,
            "changes": [{ "field": "/limit", "before": 2, "after": 1 }],
        })),
        ..publish_row.clone()
    };
    assert_eq!(b.audit_rows().await, [publish_row, revert_row]);

    // the history names the same actors as the audit rows, and where from
    let history = b.ok(&alice, "GET", &format!("{BASE}/history"), None).await;
    let who: Vec<_> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            json!([
                entry["version"],
                entry["kind"],
                entry["actorUsername"],
                entry["actorId"],
                entry["actorKind"],
                entry["origin"],
                entry["comment"],
            ])
        })
        .collect();
    assert_eq!(
        who,
        [
            json!([2, "revert", "other-admin", 2, "account", "rest", null]),
            json!([
                1,
                "publish",
                "admin-user",
                1,
                "account",
                "rest",
                "raise the limit"
            ]),
            json!([0, "initial", null, null, null, null, null]),
        ]
    );
    let page = b
        .ok(
            &alice,
            "GET",
            &format!("{BASE}/history?before=2&limit=1"),
            None,
        )
        .await;
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert_eq!(page[0]["version"], 1);
}

/// Discard and unlock are audited (design §4.8); a discard that found no
/// draft is not.
#[tokio::test]
async fn discard_and_unlock_are_audited_and_announced() {
    let mut b = bench().await;
    let (alice, bob) = (b.token("admin-user"), b.token("other-admin"));
    let draft_event = vec![format!("config-draft:{TARGET}")];
    let (lease, revision) = b.start_draft(&alice, json!({ "limit": 2 })).await;
    b.drain_events();

    // bob removes the lock he saw; the draft stays
    let seen = b.ok(&bob, "GET", BASE, None).await;
    assert_eq!(
        seen["lock"],
        json!({
            "holderName": "admin-user",
            "lease": lease,
            "acquiredAtMs": seen["lock"]["acquiredAtMs"],
            "expiresAtMs": seen["lock"]["expiresAtMs"],
        })
    );
    assert_eq!(seen["lockIsMine"], false);
    let (status, _, text) = b
        .call(
            Some(&bob),
            "POST",
            &format!("{BASE}/unlock"),
            Some(json!({ "ifLease": lease })),
        )
        .await;
    assert_eq!((status, text.as_str()), (StatusCode::NO_CONTENT, ""));
    assert_eq!(b.drain_events(), draft_event);
    let unlock_row = AuditRow {
        actor: Some("other-admin".to_string()),
        action: "unlock".to_string(),
        resource: "config".to_string(),
        entity_id: Some(TARGET.to_string()),
        // the holder's key is in the audit log only
        detail: Some(json!({ "holder": "acct:1", "holderName": "admin-user" })),
        origin: "rest".to_string(),
        result: "ok".to_string(),
    };
    assert_eq!(b.audit_rows().await, std::slice::from_ref(&unlock_row));

    // bob takes the lock and discards alice's draft
    b.ok(&bob, "POST", &format!("{BASE}/lock"), None).await;
    b.drain_events();
    let gone = b
        .ok(
            &bob,
            "DELETE",
            &format!("{BASE}/draft?ifRevision={revision}"),
            None,
        )
        .await;
    assert_eq!(gone, json!({ "revision": "0" }));
    assert_eq!(b.drain_events(), draft_event);
    let discard_row = AuditRow {
        action: "discard".to_string(),
        detail: Some(json!({ "baseVersion": 0 })),
        ..unlock_row.clone()
    };
    assert_eq!(b.audit_rows().await, [unlock_row, discard_row]);

    // "there is no draft" on no draft: nothing was discarded
    b.ok(&bob, "DELETE", &format!("{BASE}/draft?ifRevision=0"), None)
        .await;
    assert!(b.drain_events().is_empty());
    assert_eq!(b.audit_rows().await.len(), 2);
}

/// T9's "a parent that holds a secret", through REST: the diff's answer, the
/// publish's answer, the history entry's diff and the audit detail never
/// hold the secret's value. (The state and the history entry's `value` do -
/// they are the config itself, behind the read gate.)
#[tokio::test]
async fn no_secret_reaches_a_diff_a_publish_answer_or_the_audit_log() {
    let mut b = bench_with(
        ConfigDraftsAccess::default(),
        json!({ "limit": 1, "devices": [{ "name": "a", "token": "t0ken-old" }] }),
        &["/devices/0/token", "/auth/password"],
    )
    .await;
    let admin = b.token("admin-user");
    let steps = [
        // the secret inside an array changes; an object holding a secret is
        // added whole
        json!({
            "limit": 2,
            "devices": [{ "name": "a", "token": "t0ken-new" }],
            "auth": { "user": "u", "password": "t0ken-added" },
        }),
        // the array becomes a string (a type change); the object is removed
        json!({ "limit": 2, "devices": "t0ken-as-text" }),
        // and back to an array
        json!({ "limit": 3, "devices": [{ "name": "b", "token": "t0ken-again" }] }),
    ];
    let mut leaks = Vec::new();
    for (index, value) in steps.into_iter().enumerate() {
        let (_, revision) = b.start_draft(&admin, value).await;
        let (_, diff, diff_text) = b
            .call(Some(&admin), "GET", &format!("{BASE}/diff"), None)
            .await;
        assert!(
            diff["changes"]
                .as_array()
                .unwrap()
                .contains(&json!({ "field": "/devices", "masked": true })),
            "{diff_text}"
        );
        let (status, _, publish_text) = b
            .call(
                Some(&admin),
                "POST",
                &format!("{BASE}/publish"),
                Some(json!({ "ifDraftRevision": revision })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{publish_text}");
        let entry = b
            .ok(
                &admin,
                "GET",
                &format!("{BASE}/history/{}", index + 1),
                None,
            )
            .await;
        // what a revert to the first version would change
        let (_, _, back_text) = b
            .call(
                Some(&admin),
                "GET",
                &format!("{BASE}/diff?toVersion=0"),
                None,
            )
            .await;
        leaks.extend([
            diff_text,
            publish_text,
            entry["changes"].to_string(),
            back_text,
        ]);
    }
    let rows = b.audit_rows().await;
    assert_eq!(rows.len(), 3);
    for row in &rows {
        let detail = row.detail.as_ref().unwrap();
        assert!(
            detail["changes"]
                .as_array()
                .unwrap()
                .contains(&json!({ "field": "/devices", "masked": true })),
            "{detail}"
        );
        leaks.push(detail.to_string());
    }
    leaks.extend(b.drain_events());
    for text in &leaks {
        assert!(!text.contains("t0ken"), "{text}");
    }
    // the first step's added object is masked whole in the audit row
    let added = &rows[0].detail.as_ref().unwrap()["changes"];
    assert!(
        added
            .as_array()
            .unwrap()
            .contains(&json!({ "field": "/auth", "masked": true })),
        "{added}"
    );
}

/// The audit `changes` are the cut ones: a publish that changes more paths
/// than the audit keeps answers with all of them, and records the limit.
#[tokio::test]
async fn the_audit_detail_is_cut_while_the_answer_is_not() {
    let b = bench().await;
    let admin = b.token("admin-user");
    let mut value = serde_json::Map::new();
    for index in 0..300 {
        value.insert(format!("k{index:03}"), json!(index));
    }
    let (_, revision) = b.start_draft(&admin, Value::Object(value)).await;
    let done = b.publish(&admin, &revision).await;
    // 300 keys added, `limit` removed
    assert_eq!(done["changes"].as_array().unwrap().len(), 301);
    let rows = b.audit_rows().await;
    assert_eq!(rows.len(), 1);
    let detail = rows[0].detail.as_ref().unwrap();
    assert_eq!(detail["changesTruncated"], true);
    assert!(detail["changes"].as_array().unwrap().len() <= 100);
}

/// A grant session edits as `grant:<kind>`: its lock is not an account's.
#[tokio::test]
async fn a_grant_session_holds_the_lock_as_its_kind() {
    let b = bench().await;
    let spec = crate::grant::GrantSpec::new(
        crate::grant::GrantKind::new("commissioning").unwrap(),
        Identity {
            id: "commissioning".to_string(),
            name: "Commissioning".to_string(),
            role: "admin".to_string(),
            account_id: None,
        },
        std::sync::Arc::new(|| Box::pin(async { Ok(true) })),
    );
    let grant = b
        .auth
        .issue_grant_token(&spec, b.auth.grant_generation(&spec.kind))
        .expect("grant token");
    let lock = b.ok(&grant, "POST", &format!("{BASE}/lock"), None).await;
    assert_eq!(lock["holderName"], "commissioning");
    assert_eq!(b.ok(&grant, "GET", BASE, None).await["lockIsMine"], true);
    let admin = b.token("admin-user");
    assert_eq!(b.ok(&admin, "GET", BASE, None).await["lockIsMine"], false);
    let holder: String = sqlx::query_scalar("SELECT holder FROM config_locks")
        .fetch_one(b.db.as_sqlite().unwrap())
        .await
        .unwrap();
    assert_eq!(holder, "grant:commissioning");
}

/// A release that removes nothing (an old tab's late release, after the same
/// account took the lock again) is still `204`, but the lock stays and no
/// event is sent.
#[tokio::test]
async fn a_stale_lease_release_is_204_without_an_event() {
    let mut b = bench().await;
    let alice = b.token("admin-user");
    let lock_path = format!("{BASE}/lock");
    let old = b.ok(&alice, "POST", &lock_path, None).await["lease"]
        .as_str()
        .unwrap()
        .to_string();
    let new = b.ok(&alice, "POST", &lock_path, None).await["lease"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(old, new);
    b.drain_events();

    let (status, ..) = b
        .call(
            Some(&alice),
            "DELETE",
            &format!("{lock_path}?lease={old}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(b.drain_events().is_empty());
    let locks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM config_locks")
        .fetch_one(b.db.as_sqlite().unwrap())
        .await
        .unwrap();
    assert_eq!(locks, 1);

    // the current lease does remove it, and announces it once
    let (status, ..) = b
        .call(
            Some(&alice),
            "DELETE",
            &format!("{lock_path}?lease={new}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(b.drain_events(), [format!("config-draft:{TARGET}")]);
}
