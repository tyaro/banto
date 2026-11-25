//! Service-level cases of config-draft-publish-design §6 on SQLite
//! (`:memory:`, or a file where a case needs a second pool): T1 (seeding,
//! the version counter), T3 (the draft's revisions), T4-T6 (the lock), T10
//! (input), and the reads and shapes S1b added. T9 (the diff) is in
//! `audit/diff.rs`. The cases that need a publish on BOTH backends (T2, T3,
//! T4, T7, T8, T11) are in `cases.rs`.

use std::sync::atomic::{AtomicI64, Ordering};

use super::*;

/// The four tables, SQLite form (design §4.5). MUST be kept in sync with the
/// app's `migrations-sqlite/0016_config_drafts.sql` once the wiring adds it
/// (design §7, S4).
pub(super) const DDL: [&str; 4] = [
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

pub(super) const TARGET: &str = "plc.line1";
pub(super) const START_MS: i64 = 1_000_000;
pub(super) const TTL_MS: i64 = 300_000;

struct Fixture {
    svc: ConfigDraftsService,
    db: Db,
    clock: Arc<AtomicI64>,
}

impl Fixture {
    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn set(&self, ms: i64) {
        self.clock.store(ms, Ordering::SeqCst);
    }

    async fn state(&self, viewer: &ConfigEditor) -> ConfigState {
        self.svc.state(TARGET, viewer).await.unwrap()
    }

    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(self.db.as_sqlite().unwrap())
            .await
            .unwrap()
    }

    /// Move the published row on without a publish (only the row the
    /// draft rules look at).
    async fn bump_published(&self) {
        sqlx::query(
            "UPDATE config_published SET version = version + 1, revision = 'moved' WHERE target = ?",
        )
        .bind(TARGET)
        .execute(self.db.as_sqlite().unwrap())
        .await
        .unwrap();
    }
}

fn registry(default: Value) -> ConfigTargetRegistry {
    ConfigTargetRegistry::empty()
        .register(ConfigTarget::new(TARGET, default, &[]).unwrap())
        .unwrap()
}

fn with_test_clock(svc: ConfigDraftsService) -> (ConfigDraftsService, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(START_MS));
    let read = clock.clone();
    (svc.with_clock(move || read.load(Ordering::SeqCst)), clock)
}

async fn fixture_with(targets: ConfigTargetRegistry) -> Fixture {
    let db = Db::connect_sqlite_memory().await.expect("connect");
    for sql in DDL {
        sqlx::query(sql)
            .execute(db.as_sqlite().expect("sqlite handle"))
            .await
            .expect("create table");
    }
    let (svc, clock) = with_test_clock(ConfigDraftsService::new(db.clone(), targets));
    svc.ensure_targets().await.expect("ensure targets");
    Fixture { svc, db, clock }
}

async fn fixture() -> Fixture {
    fixture_with(registry(json!({"limit": 1}))).await
}

/// A database in a file with TWO pools: the service's, and `other`, which
/// stands for another transaction that holds the write (SQLite has one
/// writer for the whole file). `:memory:` cannot do this - every pool would
/// be its own database.
struct WaitFixture {
    f: Fixture,
    other: Db,
    _dir: tempfile::TempDir,
}

async fn wait_fixture() -> WaitFixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("config.db");
    let db = Db::connect_sqlite(&path).await.expect("connect");
    let other = Db::connect_sqlite(&path)
        .await
        .expect("connect the other pool");
    for sql in DDL {
        sqlx::query(sql)
            .execute(db.as_sqlite().expect("sqlite handle"))
            .await
            .expect("create table");
    }
    let (svc, clock) = with_test_clock(ConfigDraftsService::new(
        db.clone(),
        registry(json!({"limit": 1})),
    ));
    svc.ensure_targets().await.expect("ensure targets");
    WaitFixture {
        f: Fixture { svc, db, clock },
        other,
        _dir: dir,
    }
}

impl WaitFixture {
    /// Start `call` (a write of the service) while the other pool holds the
    /// writer, so it waits in `BEGIN IMMEDIATE`; move the clock to
    /// `during_wait_ms` WHILE it waits; let go and return what the call
    /// answers. The call was made at the clock's earlier value and runs at
    /// the later one.
    async fn run_after_wait<T, Fut>(
        &self,
        during_wait_ms: i64,
        call: impl FnOnce(ConfigDraftsService) -> Fut,
    ) -> T
    where
        Fut: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let held = self
            .other
            .as_sqlite()
            .unwrap()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect("hold the writer");
        let waiting = tokio::spawn(call(self.f.svc.clone()));
        // Long enough for the call to reach the wait (it has nothing else to
        // do first), far below SQLite's busy timeout.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!waiting.is_finished(), "the call must be waiting");
        self.f.set(during_wait_ms);
        held.rollback().await.expect("let go of the writer");
        waiting.await.expect("join")
    }
}

pub(super) fn alice() -> ConfigEditor {
    ConfigEditor {
        holder: "acct:1".to_string(),
        name: "alice".to_string(),
    }
}

pub(super) fn bob() -> ConfigEditor {
    ConfigEditor {
        holder: "acct:2".to_string(),
        name: "bob".to_string(),
    }
}

/// The `current` of a conflict with the expected reason.
pub(super) fn conflict<T: fmt::Debug>(result: Result<T, BantoError>, reason: &str) -> Value {
    match result {
        Err(BantoError::Conflict {
            current: Some(current),
            ..
        }) => {
            assert_eq!(current["reason"], reason, "{current}");
            current
        }
        other => panic!("expected a {reason} conflict, got {other:?}"),
    }
}

pub(super) fn validation_field<T: fmt::Debug>(result: Result<T, BantoError>) -> String {
    match result {
        Err(BantoError::Validation { field_errors }) => field_errors[0].field.clone(),
        other => panic!("expected a validation error, got {other:?}"),
    }
}

/// Acquire and create the draft; returns (lease, draft revision).
async fn start_draft(f: &Fixture, editor: &ConfigEditor, value: Value) -> (String, String) {
    let lock = f.svc.lock_acquire(TARGET, editor).await.unwrap();
    let published = f.svc.published(TARGET).await.unwrap();
    let saved = f
        .svc
        .draft_put(
            TARGET,
            editor,
            &value,
            CONFIG_DRAFT_ABSENT_REVISION,
            Some(&published.revision),
        )
        .await
        .unwrap();
    (lock.lease, saved.revision)
}

// --- T1: seeding ---

#[tokio::test]
async fn ensure_targets_seeds_version_0_once() {
    let f = fixture().await;
    let first = f.svc.published(TARGET).await.unwrap();
    assert_eq!(first.version, 0);
    assert_eq!(first.value, json!({"limit": 1}));
    assert_eq!(first.revision.len(), 32);
    let history: (i64, String, String) =
        sqlx::query_as("SELECT version, value, kind FROM config_history WHERE target = ?")
            .bind(TARGET)
            .fetch_one(f.db.as_sqlite().unwrap())
            .await
            .unwrap();
    assert_eq!(history.0, 0);
    assert_eq!(history.2, "initial");
    // the published value is the latest history row's value
    assert_eq!(
        serde_json::from_str::<Value>(&history.1).unwrap(),
        first.value
    );

    // again: nothing is made again
    f.svc.ensure_targets().await.unwrap();
    assert_eq!(f.svc.published(TARGET).await.unwrap(), first);
    assert_eq!(f.count("config_history").await, 1);

    // another default in the code (and one more target): the published value
    // stays, only the new target is seeded
    let targets = registry(json!({"limit": 99}))
        .register(ConfigTarget::new("simple", json!({"on": true}), &[]).unwrap())
        .unwrap();
    let changed = ConfigDraftsService::new(f.db.clone(), targets);
    changed.ensure_targets().await.unwrap();
    assert_eq!(changed.published(TARGET).await.unwrap(), first);
    let simple = changed.published("simple").await.unwrap();
    assert_eq!((simple.version, simple.value), (0, json!({"on": true})));
    assert_eq!(f.count("config_history").await, 2);
    assert_eq!(f.count("config_published").await, 2);
}

#[tokio::test]
async fn a_registered_target_without_its_row_is_not_a_404() {
    let f = fixture().await;
    let targets = registry(json!({}))
        .register(ConfigTarget::new("late", json!({}), &[]).unwrap())
        .unwrap();
    // `ensure_targets` not called for the new registry
    let svc = ConfigDraftsService::new(f.db.clone(), targets);
    assert!(matches!(
        svc.published("late").await,
        Err(BantoError::Other(_))
    ));
    assert!(matches!(
        svc.state("late", &alice()).await,
        Err(BantoError::Other(_))
    ));
    assert!(matches!(
        svc.lock_acquire("late", &alice()).await,
        Err(BantoError::Other(_))
    ));
    assert_eq!(f.count("config_locks").await, 0);
}

// --- T3: revisions (the draft's share) ---

#[derive(Debug, PartialEq, serde::Deserialize)]
struct Limits {
    limit: i64,
}

#[tokio::test]
async fn published_as_is_the_same_row_as_published() {
    let f = fixture().await;
    let raw = f.svc.published(TARGET).await.unwrap();
    let typed = f.svc.published_as::<Limits>(TARGET).await.unwrap();
    assert_eq!(typed.value, Limits { limit: 1 });
    assert_eq!(
        (typed.version, typed.revision, typed.published_at),
        (raw.version, raw.revision, raw.published_at)
    );

    // a type the value does not fit: an error that does not quote the value
    #[derive(Debug, serde::Deserialize)]
    struct Other {
        #[allow(dead_code)]
        limit: String,
    }
    let Err(BantoError::Other(message)) = f.svc.published_as::<Other>(TARGET).await else {
        panic!("expected an error");
    };
    assert!(message.contains(TARGET) && !message.contains("integer"));
}

#[tokio::test]
async fn draft_save_needs_the_current_revision() {
    let f = fixture().await;
    let a = alice();
    let published = f.svc.published(TARGET).await.unwrap();
    f.svc.lock_acquire(TARGET, &a).await.unwrap();

    // no draft yet: a revision that is not "0" does not create one
    let current = conflict(
        f.svc
            .draft_put(TARGET, &a, &json!({"limit": 2}), "abc", None)
            .await,
        "draft_changed",
    );
    assert_eq!(current["revision"], CONFIG_DRAFT_ABSENT_REVISION);
    assert_eq!(current["draft"], Value::Null);
    assert_eq!(f.count("config_drafts").await, 0);

    // the creating save must say which published revision it saw
    assert_eq!(
        validation_field(
            f.svc
                .draft_put(TARGET, &a, &json!({"limit": 2}), "0", None)
                .await
        ),
        "ifPublishedRevision"
    );

    let first = f
        .svc
        .draft_put(
            TARGET,
            &a,
            &json!({"limit": 2}),
            "0",
            Some(&published.revision),
        )
        .await
        .unwrap();
    assert_eq!(first.base_version, 0);
    assert_eq!(first.revision.len(), 32);

    // "0" again: the draft exists now
    let current = conflict(
        f.svc
            .draft_put(
                TARGET,
                &a,
                &json!({"limit": 3}),
                "0",
                Some(&published.revision),
            )
            .await,
        "draft_changed",
    );
    assert_eq!(current["revision"], first.revision);
    assert_eq!(current["draft"]["value"], json!({"limit": 2}));
    assert_eq!(current["draft"]["baseVersion"], 0);

    // the next save moves the revision; the old one no longer writes
    let second = f
        .svc
        .draft_put(TARGET, &a, &json!({"limit": 3}), &first.revision, None)
        .await
        .unwrap();
    assert_ne!(second.revision, first.revision);
    assert_eq!(second.base_version, 0);
    let current = conflict(
        f.svc
            .draft_put(TARGET, &a, &json!({"limit": 4}), &first.revision, None)
            .await,
        "draft_changed",
    );
    assert_eq!(current["revision"], second.revision);

    let state = f.state(&a).await;
    let draft = state.draft.unwrap();
    assert_eq!(draft.value, json!({"limit": 3}));
    assert_eq!(draft.revision, second.revision);
    assert_eq!(draft.updated_by, "alice");
    // the published value is untouched by all of it
    assert_eq!(state.published, published);
    assert_eq!(f.count("config_history").await, 1);
}

#[tokio::test]
async fn first_save_is_refused_when_published_moved_on() {
    let f = fixture().await;
    let a = alice();
    let seen = f.svc.published(TARGET).await.unwrap();
    f.svc.lock_acquire(TARGET, &a).await.unwrap();
    f.bump_published().await;

    let current = conflict(
        f.svc
            .draft_put(TARGET, &a, &json!({"limit": 2}), "0", Some(&seen.revision))
            .await,
        "published_changed",
    );
    assert_eq!(
        current["published"],
        json!({"version": 1, "revision": "moved"})
    );
    assert_eq!(f.count("config_drafts").await, 0);

    // with the revision of what is published now, the base is that version
    let saved = f
        .svc
        .draft_put(TARGET, &a, &json!({"limit": 2}), "0", Some("moved"))
        .await
        .unwrap();
    assert_eq!(saved.base_version, 1);
    // a later save does not look at the published revision again
    f.bump_published().await;
    let again = f
        .svc
        .draft_put(TARGET, &a, &json!({"limit": 5}), &saved.revision, None)
        .await
        .unwrap();
    assert_eq!(again.base_version, 1);
}

#[tokio::test]
async fn discard_needs_the_current_revision_and_keeps_the_lock() {
    let f = fixture().await;
    let a = alice();
    let (_lease, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    let expires = f.state(&a).await.lock.unwrap().expires_at_ms;
    f.advance(1_000);

    conflict(
        f.svc.draft_discard(TARGET, &a, "stale").await,
        "draft_changed",
    );
    // "0" says "there is no draft" - there is one
    conflict(f.svc.draft_discard(TARGET, &a, "0").await, "draft_changed");
    assert_eq!(f.count("config_drafts").await, 1);

    let gone = f.svc.draft_discard(TARGET, &a, &revision).await.unwrap();
    assert_eq!(gone.revision, CONFIG_DRAFT_ABSENT_REVISION);
    let state = f.state(&a).await;
    assert!(state.draft.is_none());
    assert!(state.lock_is_mine);
    // the discard did not move the expiry
    assert_eq!(state.lock.unwrap().expires_at_ms, expires);

    // nothing there: "0" is fine, a revision is not
    f.svc.draft_discard(TARGET, &a, "0").await.unwrap();
    let current = conflict(
        f.svc.draft_discard(TARGET, &a, &revision).await,
        "draft_changed",
    );
    assert_eq!(current["revision"], "0");

    // a draft made again has a new revision
    let published = f.svc.published(TARGET).await.unwrap();
    let again = f
        .svc
        .draft_put(
            TARGET,
            &a,
            &json!({"limit": 2}),
            "0",
            Some(&published.revision),
        )
        .await
        .unwrap();
    assert_ne!(again.revision, revision);
}

#[tokio::test]
async fn the_validator_is_reported_but_does_not_stop_a_save() {
    let target = ConfigTarget::new(TARGET, json!({"limit": 1}), &[])
        .unwrap()
        .with_validator(|value| {
            if value["limit"].as_i64().is_some_and(|limit| limit > 0) {
                Ok(())
            } else {
                Err(vec![FieldError {
                    field: "/limit".to_string(),
                    message: "must be positive".to_string(),
                }])
            }
        });
    let f = fixture_with(ConfigTargetRegistry::empty().register(target).unwrap()).await;
    let a = alice();
    let published = f.svc.published(TARGET).await.unwrap();
    f.svc.lock_acquire(TARGET, &a).await.unwrap();
    let bad = f
        .svc
        .draft_put(
            TARGET,
            &a,
            &json!({"limit": -1}),
            "0",
            Some(&published.revision),
        )
        .await
        .unwrap();
    assert_eq!(bad.validation.len(), 1);
    assert_eq!(bad.validation[0].field, "/limit");
    assert_eq!(f.state(&a).await.draft.unwrap().value, json!({"limit": -1}));
    let good = f
        .svc
        .draft_put(TARGET, &a, &json!({"limit": 5}), &bad.revision, None)
        .await
        .unwrap();
    assert!(good.validation.is_empty());
}

// --- T4: two people, two tabs ---

#[tokio::test]
async fn another_person_cannot_take_write_extend_or_release() {
    let f = fixture().await;
    let (a, b) = (alice(), bob());
    let (lease, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    let before = f.state(&a).await;
    assert!(before.lock_is_mine);

    let current = conflict(f.svc.lock_acquire(TARGET, &b).await, "lock_held");
    assert_eq!(current["lock"]["holderName"], "alice");
    assert_eq!(current["lock"]["expiresAtMs"], START_MS + TTL_MS);
    // the conflict does not hand out the lease
    assert!(current["lock"].get("lease").is_none());

    let current = conflict(
        f.svc
            .draft_put(TARGET, &b, &json!({"limit": 9}), &revision, None)
            .await,
        "lock_required",
    );
    assert_eq!(current["lock"]["holderName"], "alice");
    conflict(
        f.svc.draft_discard(TARGET, &b, &revision).await,
        "lock_required",
    );

    // bob can read alice's lease in the state; it does not let him act
    let seen = f.state(&b).await;
    assert!(!seen.lock_is_mine);
    assert_eq!(seen.lock.as_ref().unwrap().lease, lease);
    f.advance(1_000);
    conflict(f.svc.lock_extend(TARGET, &b, &lease).await, "lock_required");
    f.svc.lock_release(TARGET, &b, &lease).await.unwrap();

    // nothing of alice's changed
    let after = f.state(&a).await;
    assert_eq!(after, before);
}

#[tokio::test]
async fn an_old_tab_cannot_release_or_extend_the_newer_tabs_lock() {
    let f = fixture().await;
    let a = alice();
    let tab1 = f.svc.lock_acquire(TARGET, &a).await.unwrap();
    f.advance(1_000);
    let tab2 = f.svc.lock_acquire(TARGET, &a).await.unwrap();
    assert_ne!(tab2.lease, tab1.lease);
    assert_eq!(tab2.expires_at_ms, START_MS + 1_000 + TTL_MS);

    f.advance(1_000);
    // late calls from tab 1
    f.svc.lock_release(TARGET, &a, &tab1.lease).await.unwrap();
    let current = conflict(
        f.svc.lock_extend(TARGET, &a, &tab1.lease).await,
        "lock_required",
    );
    assert_eq!(current["lock"]["holderName"], "alice");
    assert_eq!(f.state(&a).await.lock.unwrap(), tab2);

    // tab 2's own lease works; the lease stays the same
    let extended = f.svc.lock_extend(TARGET, &a, &tab2.lease).await.unwrap();
    assert_eq!(extended.lease, tab2.lease);
    assert_eq!(extended.acquired_at_ms, tab2.acquired_at_ms);
    assert_eq!(extended.expires_at_ms, START_MS + 2_000 + TTL_MS);
    assert_eq!(f.state(&a).await.lock.unwrap(), extended);

    f.svc.lock_release(TARGET, &a, &tab2.lease).await.unwrap();
    assert!(f.state(&a).await.lock.is_none());
    assert_eq!(f.count("config_locks").await, 0);
}

#[tokio::test]
async fn extend_after_expiry_does_not_take_the_lock_again() {
    let f = fixture().await;
    let a = alice();
    let lock = f.svc.lock_acquire(TARGET, &a).await.unwrap();
    f.set(lock.expires_at_ms);
    let current = conflict(
        f.svc.lock_extend(TARGET, &a, &lock.lease).await,
        "lock_required",
    );
    assert_eq!(current["lock"], Value::Null);
    let state = f.state(&a).await;
    assert!(state.lock.is_none() && !state.lock_is_mine);
    // a late release of the expired lock still removes the row (it is hers)
    f.svc.lock_release(TARGET, &a, &lock.lease).await.unwrap();
    assert_eq!(f.count("config_locks").await, 0);
}

// --- T5: the expiry ---

#[tokio::test]
async fn lock_expires_exactly_at_its_expiry() {
    let f = fixture().await;
    let (a, b) = (alice(), bob());
    let (_lease, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    // the save moved the expiry to now + ttl (same instant here)
    let expires = f.state(&a).await.lock.unwrap().expires_at_ms;
    assert_eq!(expires, START_MS + TTL_MS);

    // 1 ms before: valid
    f.set(expires - 1);
    assert!(f.state(&a).await.lock_is_mine);
    conflict(f.svc.lock_acquire(TARGET, &b).await, "lock_held");

    // at the expiry: gone
    f.set(expires);
    assert!(f.state(&a).await.lock.is_none());
    let current = conflict(
        f.svc
            .draft_put(TARGET, &a, &json!({"limit": 3}), &revision, None)
            .await,
        "lock_required",
    );
    assert_eq!(current["lock"], Value::Null);
    conflict(
        f.svc.draft_discard(TARGET, &a, &revision).await,
        "lock_required",
    );

    // after: bob takes it, alice's save still fails (now it names bob)
    f.set(expires + 1);
    let taken = f.svc.lock_acquire(TARGET, &b).await.unwrap();
    assert_eq!(taken.holder, "acct:2");
    assert_eq!(taken.expires_at_ms, expires + 1 + TTL_MS);
    let current = conflict(
        f.svc
            .draft_put(TARGET, &a, &json!({"limit": 3}), &revision, None)
            .await,
        "lock_required",
    );
    assert_eq!(current["lock"]["holderName"], "bob");
    // the draft alice left is still there, unchanged
    let draft = f.state(&b).await.draft.unwrap();
    assert_eq!(
        (draft.value, draft.revision),
        (json!({"limit": 2}), revision)
    );
}

#[tokio::test]
async fn saving_the_draft_extends_the_lock() {
    let f = fixture().await;
    let a = alice();
    let (lease, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    f.advance(200_000);
    let saved = f
        .svc
        .draft_put(TARGET, &a, &json!({"limit": 3}), &revision, None)
        .await
        .unwrap();
    assert_eq!(saved.lock.expires_at_ms, START_MS + 200_000 + TTL_MS);
    assert_eq!(saved.lock.lease, lease);
    // past the first expiry, still held
    f.set(START_MS + TTL_MS + 1);
    let state = f.state(&a).await;
    assert!(state.lock_is_mine);
    assert_eq!(state.lock.unwrap(), saved.lock);
}

/// The clock is read when the write RUNS (after the wait for the writer),
/// not when it was called: a lock that expired during the wait is expired.
#[tokio::test]
async fn a_write_that_waited_past_the_expiry_sees_the_lock_expired() {
    let w = wait_fixture().await;
    let f = &w.f;
    let (a, b) = (alice(), bob());
    let (lease, revision) = start_draft(f, &a, json!({"limit": 2})).await;
    let expires = f.state(&a).await.lock.unwrap().expires_at_ms;
    assert_eq!(expires, START_MS + TTL_MS);

    // extend: called 1 ms before the expiry, runs at the expiry
    f.set(expires - 1);
    let extended = w
        .run_after_wait(expires, {
            let (a, lease) = (a.clone(), lease.clone());
            |svc| async move { svc.lock_extend(TARGET, &a, &lease).await }
        })
        .await;
    assert_eq!(conflict(extended, "lock_required")["lock"], Value::Null);
    // the expired lease was not revived
    assert!(f.state(&a).await.lock.is_none());

    // save and discard: the same
    f.set(expires - 1);
    let saved = w
        .run_after_wait(expires, {
            let (a, revision) = (a.clone(), revision.clone());
            |svc| async move {
                svc.draft_put(TARGET, &a, &json!({"limit": 3}), &revision, None)
                    .await
            }
        })
        .await;
    conflict(saved, "lock_required");
    f.set(expires - 1);
    let discarded = w
        .run_after_wait(expires, {
            let (a, revision) = (a.clone(), revision.clone());
            |svc| async move { svc.draft_discard(TARGET, &a, &revision).await }
        })
        .await;
    conflict(discarded, "lock_required");
    let draft = f.state(&a).await.draft.unwrap();
    assert_eq!(
        (draft.value, draft.revision),
        (json!({"limit": 2}), revision)
    );

    // acquire, the other way round: alice's lock was valid when bob called
    // and expired when his write ran - he gets it, dated at the later time
    f.set(expires - 1);
    conflict(f.svc.lock_acquire(TARGET, &b).await, "lock_held");
    let taken = w
        .run_after_wait(expires, {
            let b = b.clone();
            |svc| async move { svc.lock_acquire(TARGET, &b).await }
        })
        .await
        .unwrap();
    assert_eq!(taken.holder, "acct:2");
    assert_eq!(
        (taken.acquired_at_ms, taken.expires_at_ms),
        (expires, expires + TTL_MS)
    );

    // the administrator's release reports the lock as it is when it runs:
    // bob's lock expires during the wait, so the conflict names nobody
    f.set(expires + TTL_MS - 1);
    let released = w
        .run_after_wait(expires + TTL_MS, |svc| async move {
            svc.lock_force_release(TARGET, "not-the-lease").await
        })
        .await;
    assert_eq!(conflict(released, "lock_held")["lock"], Value::Null);
}

/// A write that waited but still runs before the expiry succeeds, and the
/// new expiry counts from the time it ran (the same time that judged it).
#[tokio::test]
async fn a_write_that_waited_extends_from_the_time_it_ran() {
    let w = wait_fixture().await;
    let f = &w.f;
    let a = alice();
    let (lease, revision) = start_draft(f, &a, json!({"limit": 2})).await;

    let extended = w
        .run_after_wait(START_MS + 1_000, {
            let (a, lease) = (a.clone(), lease.clone());
            |svc| async move { svc.lock_extend(TARGET, &a, &lease).await }
        })
        .await
        .unwrap();
    assert_eq!(extended.expires_at_ms, START_MS + 1_000 + TTL_MS);

    let saved = w
        .run_after_wait(START_MS + 2_000, {
            let a = a.clone();
            |svc| async move {
                svc.draft_put(TARGET, &a, &json!({"limit": 3}), &revision, None)
                    .await
            }
        })
        .await
        .unwrap();
    assert_eq!(saved.lock.expires_at_ms, START_MS + 2_000 + TTL_MS);
    assert_eq!(f.state(&a).await.lock.unwrap(), saved.lock);
}

/// An extension never replaces the expiry with an earlier one, even when
/// the clock stepped back between two writes.
#[tokio::test]
async fn an_extension_never_moves_the_expiry_backwards() {
    let f = fixture().await;
    let a = alice();
    let (lease, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    f.set(START_MS + 100_000);
    let newest = f.svc.lock_extend(TARGET, &a, &lease).await.unwrap();
    assert_eq!(newest.expires_at_ms, START_MS + 100_000 + TTL_MS);

    f.set(START_MS + 50_000);
    let again = f.svc.lock_extend(TARGET, &a, &lease).await.unwrap();
    assert_eq!(again, newest);
    let saved = f
        .svc
        .draft_put(TARGET, &a, &json!({"limit": 3}), &revision, None)
        .await
        .unwrap();
    assert_eq!(saved.lock, newest);
    assert_eq!(f.state(&a).await.lock.unwrap(), newest);
}

#[tokio::test]
async fn lock_ttl_is_kept_within_its_bounds() {
    let f = fixture().await;
    let a = alice();
    for (ttl, expected_ms) in [
        (Duration::from_secs(60), 60_000),
        (Duration::from_millis(1), 1_000),
        (Duration::from_secs(86_400), 3_600_000),
    ] {
        let svc = f.svc.clone().with_lock_ttl(ttl);
        let lock = svc.lock_acquire(TARGET, &a).await.unwrap();
        assert_eq!(lock.expires_at_ms - lock.acquired_at_ms, expected_ms);
    }
}

// --- T6: the administrator's release ---

#[tokio::test]
async fn force_release_removes_only_the_lock_that_was_seen() {
    let f = fixture().await;
    let (a, b) = (alice(), bob());
    let (lease, revision) = start_draft(&f, &a, json!({"limit": 2})).await;

    // a lease that is not the row's: nothing is removed
    let current = conflict(
        f.svc.lock_force_release(TARGET, "not-the-lease").await,
        "lock_held",
    );
    assert_eq!(current["lock"]["holderName"], "alice");
    assert!(f.state(&a).await.lock_is_mine);

    let removed = f.svc.lock_force_release(TARGET, &lease).await.unwrap();
    assert_eq!(removed.holder, "acct:1");
    assert_eq!(removed.holder_name, "alice");
    assert_eq!(removed.lease, lease);

    // the draft stays; alice can no longer write it; bob can take over
    let state = f.state(&a).await;
    assert!(state.lock.is_none());
    assert_eq!(state.draft.as_ref().unwrap().revision, revision);
    conflict(
        f.svc
            .draft_put(TARGET, &a, &json!({"limit": 3}), &revision, None)
            .await,
        "lock_required",
    );
    f.svc.lock_acquire(TARGET, &b).await.unwrap();
    f.svc
        .draft_put(TARGET, &b, &json!({"limit": 7}), &revision, None)
        .await
        .unwrap();
    let draft = f.state(&b).await.draft.unwrap();
    assert_eq!(draft.value, json!({"limit": 7}));
    assert_eq!(draft.updated_by, "bob");
    assert_eq!(draft.base_version, 0);

    // the lease the administrator saw is gone: releasing it again must not
    // remove bob's lock
    let current = conflict(f.svc.lock_force_release(TARGET, &lease).await, "lock_held");
    assert_eq!(current["lock"]["holderName"], "bob");
    assert!(f.state(&b).await.lock_is_mine);
}

#[tokio::test]
async fn force_release_with_no_lock_is_a_conflict_with_no_holder() {
    let f = fixture().await;
    let current = conflict(
        f.svc.lock_force_release(TARGET, "anything").await,
        "lock_held",
    );
    assert_eq!(current["lock"], Value::Null);
}

// --- T10: input ---

#[tokio::test]
async fn unknown_target_is_not_found_everywhere() {
    let f = fixture().await;
    let a = alice();
    let value = json!({});
    let not_found = |result: Result<(), BantoError>| match result {
        Err(BantoError::NotFound { resource, id }) => {
            assert_eq!((resource.as_str(), id.as_str()), ("config", "nope"));
        }
        other => panic!("expected not found, got {other:?}"),
    };
    not_found(f.svc.published("nope").await.map(drop));
    not_found(f.svc.published_as::<Value>("nope").await.map(drop));
    not_found(f.svc.state("nope", &a).await.map(drop));
    not_found(f.svc.lock_acquire("nope", &a).await.map(drop));
    not_found(f.svc.lock_extend("nope", &a, "x").await.map(drop));
    not_found(f.svc.lock_release("nope", &a, "x").await);
    not_found(f.svc.lock_force_release("nope", "x").await.map(drop));
    not_found(
        f.svc
            .draft_put("nope", &a, &value, "0", Some("x"))
            .await
            .map(drop),
    );
    not_found(f.svc.draft_discard("nope", &a, "0").await.map(drop));
    let who = stamp(None);
    not_found(f.svc.draft_rebase("nope", &a, "x", "x").await.map(drop));
    not_found(f.svc.publish("nope", &a, "x", &who).await.map(drop));
    not_found(f.svc.revert("nope", &a, 0, "x", &who).await.map(drop));
    not_found(f.svc.diff("nope", None).await.map(drop));
    not_found(f.svc.diff("nope", Some(0)).await.map(drop));
    not_found(f.svc.history("nope", None, 10).await.map(drop));
    not_found(f.svc.history_entry("nope", 0).await.map(drop));

    // a target whose rows exist but that is not registered any more
    sqlx::query("INSERT INTO config_published (target, value, version, revision) VALUES ('old', '{}', 3, 'r')")
        .execute(f.db.as_sqlite().unwrap())
        .await
        .unwrap();
    assert!(matches!(
        f.svc.published("old").await,
        Err(BantoError::NotFound { .. })
    ));
    // a long unknown key is cut in the answer
    let long = "x".repeat(500);
    let Err(BantoError::NotFound { id, .. }) = f.svc.published(&long).await else {
        panic!("expected not found");
    };
    assert_eq!(id.len(), MAX_CONFIG_TARGET_KEY_LEN);
}

#[tokio::test]
async fn value_must_be_an_object_within_the_size_limit() {
    let f = fixture().await;
    let a = alice();
    let published = f.svc.published(TARGET).await.unwrap();
    f.svc.lock_acquire(TARGET, &a).await.unwrap();
    let put = |value: Value| {
        let (svc, a, revision) = (f.svc.clone(), a.clone(), published.revision.clone());
        async move {
            svc.draft_put(TARGET, &a, &value, "0", Some(&revision))
                .await
        }
    };

    for bad in [json!([1]), json!("text"), json!(1), json!(null)] {
        assert_eq!(validation_field(put(bad).await), "value");
    }
    // {"k":"<n bytes>"} is n + 8 bytes
    let sized = |bytes: usize| json!({"k": "a".repeat(bytes - 8)});
    assert_eq!(
        validation_field(put(sized(MAX_CONFIG_VALUE_BYTES + 1)).await),
        "value"
    );
    assert_eq!(f.count("config_drafts").await, 0);
    put(sized(MAX_CONFIG_VALUE_BYTES)).await.unwrap();

    // empty and overlong conditions are refused before the database
    assert_eq!(
        validation_field(f.svc.draft_put(TARGET, &a, &json!({}), "", None).await),
        "ifRevision"
    );
    assert_eq!(
        validation_field(f.svc.draft_discard(TARGET, &a, &"r".repeat(65)).await),
        "ifRevision"
    );
    assert_eq!(
        validation_field(f.svc.draft_put(TARGET, &a, &json!({}), "0", Some("")).await),
        "ifPublishedRevision"
    );
    assert_eq!(
        validation_field(f.svc.lock_extend(TARGET, &a, "").await),
        "lease"
    );
    assert_eq!(
        validation_field(f.svc.lock_release(TARGET, &a, "").await),
        "lease"
    );
    assert_eq!(
        validation_field(f.svc.lock_force_release(TARGET, "").await),
        "ifLease"
    );
}

#[test]
fn target_registration_rejects_bad_input() {
    for key in ["plc", "plc.line1", "a_b.c2", &"a".repeat(64)] {
        assert!(ConfigTarget::new(key, json!({}), &[]).is_ok(), "{key}");
    }
    for key in [
        "",
        "Plc",
        "1plc",
        "plc.",
        ".plc",
        "plc..line",
        "plc-line",
        "plc line",
        &"a".repeat(65),
    ] {
        assert!(ConfigTarget::new(key, json!({}), &[]).is_err(), "{key}");
    }
    // the default: an object, within the size limit
    assert!(ConfigTarget::new("plc", json!([]), &[]).is_err());
    assert!(ConfigTarget::new("plc", json!(null), &[]).is_err());
    let big = json!({"k": "a".repeat(MAX_CONFIG_VALUE_BYTES)});
    assert!(ConfigTarget::new("plc", big, &[]).is_err());
    // masked paths are JSON Pointers
    assert!(ConfigTarget::new("plc", json!({}), &["/auth/token"]).is_ok());
    assert!(ConfigTarget::new("plc", json!({}), &["auth.token"]).is_err());
    assert!(ConfigTarget::new("plc", json!({}), &[""]).is_err());
    // ... with the escapes of RFC 6901 only: `~0` is `~`, `~1` is `/`
    for path in ["/", "/a~0b", "/a~1b", "/~0~1", "/a/~01", "/a.b/c d"] {
        assert!(
            ConfigTarget::new("plc", json!({}), &[path]).is_ok(),
            "{path}"
        );
    }
    for path in ["/a~", "/~", "/a~2", "/a~b", "/a~/b", "/a/~~0", "/ok/~1/~x"] {
        assert!(
            ConfigTarget::new("plc", json!({}), &["/fine", path]).is_err(),
            "{path}"
        );
    }
    // a well-formed escape is a mask that works: the key `a/b~c`
    let escaped = ConfigTarget::new("plc", json!({}), &["/a~1b~0c"]).unwrap();
    let masks: Vec<&str> = escaped.masked_paths().iter().map(String::as_str).collect();
    let changes = crate::audit::diff::diff_paths(
        &json!({"a/b~c": "RAW-ONE"}),
        &json!({"a/b~c": "RAW-TWO"}),
        &masks,
    );
    assert_eq!(changes, vec![json!({"field": "/a~1b~0c", "masked": true})]);

    let registry = ConfigTargetRegistry::empty()
        .register(ConfigTarget::new("b", json!({}), &["/x"]).unwrap())
        .unwrap()
        .register(ConfigTarget::new("a", json!({}), &[]).unwrap())
        .unwrap();
    // registration order, and no duplicates
    let keys: Vec<&str> = registry.targets().iter().map(ConfigTarget::key).collect();
    assert_eq!(keys, vec!["b", "a"]);
    assert_eq!(registry.get("b").unwrap().masked_paths(), ["/x"]);
    assert!(registry
        .register(ConfigTarget::new("a", json!({}), &[]).unwrap())
        .is_err());
}

#[tokio::test]
async fn wire_shape_is_camel_case_without_the_holder_key() {
    let f = fixture().await;
    let a = alice();
    start_draft(&f, &a, json!({"limit": 2})).await;
    let wire = serde_json::to_value(f.state(&a).await).unwrap();
    assert_eq!(wire["target"], TARGET);
    assert_eq!(wire["lockIsMine"], true);
    assert!(wire["published"]["publishedAt"].is_string());
    assert_eq!(wire["draft"]["baseVersion"], 0);
    assert_eq!(wire["draft"]["updatedBy"], "alice");
    assert_eq!(wire["lock"]["holderName"], "alice");
    assert!(wire["lock"]["lease"].is_string());
    assert_eq!(wire["lock"]["expiresAtMs"], START_MS + TTL_MS);
    assert!(wire["lock"].get("holder").is_none());
}

// --- S1b on SQLite only: the list, the shapes, the inputs ---
// (what must hold on both backends is in `cases.rs`)

fn stamp(comment: Option<&str>) -> PublishStamp<'_> {
    PublishStamp {
        actor_username: "alice",
        actor_id: Some(1),
        actor_kind: "account",
        origin: "tauri",
        comment,
    }
}

/// Draft `value` and publish it.
async fn publish_value(f: &Fixture, editor: &ConfigEditor, value: Value) -> PublishOutcome {
    let (_, revision) = start_draft(f, editor, value).await;
    f.svc
        .publish(TARGET, editor, &revision, &stamp(None))
        .await
        .unwrap()
}

#[tokio::test]
async fn every_publish_is_the_next_version() {
    let f = fixture().await;
    let a = alice();
    for version in 1..=4 {
        let done = publish_value(&f, &a, json!({"limit": version * 10})).await;
        assert_eq!(
            (done.version, done.previous_version),
            (version, version - 1)
        );
    }
    assert_eq!(f.count("config_history").await, 5);
    // seeding again does not touch a target that has versions
    f.svc.ensure_targets().await.unwrap();
    assert_eq!(f.svc.published(TARGET).await.unwrap().version, 4);
    assert_eq!(f.count("config_history").await, 5);
}

#[tokio::test]
async fn a_publish_that_waited_judges_the_lock_at_the_time_it_ran() {
    let w = wait_fixture().await;
    let f = &w.f;
    let (a, b) = (alice(), bob());
    let (_, revision) = start_draft(f, &a, json!({"limit": 2})).await;
    let expires = f.state(&a).await.lock.unwrap().expires_at_ms;

    // bob calls 1 ms before alice's lock expires: refused if it ran then ...
    f.set(expires - 1);
    conflict(
        f.svc.publish(TARGET, &b, &revision, &stamp(None)).await,
        "lock_held",
    );
    // ... but it waits for the writer until the expiry, and runs then
    let done = w
        .run_after_wait(expires, {
            let (b, revision) = (b.clone(), revision.clone());
            |svc| async move { svc.publish(TARGET, &b, &revision, &stamp(None)).await }
        })
        .await
        .unwrap();
    assert_eq!(done.version, 1);
}

#[tokio::test]
async fn list_gives_every_registered_target_in_order() {
    let targets = ConfigTargetRegistry::empty()
        .register(ConfigTarget::new("zeta", json!({"z": 1}), &[]).unwrap())
        .unwrap()
        .register(ConfigTarget::new(TARGET, json!({"limit": 1}), &[]).unwrap())
        .unwrap();
    let f = fixture_with(targets).await;
    let a = alice();
    // a row of a key that is not registered any more is left out
    sqlx::query("INSERT INTO config_published (target, value, version, revision) VALUES ('old', '{}', 3, 'r')")
        .execute(f.db.as_sqlite().unwrap())
        .await
        .unwrap();

    let list = f.svc.list().await.unwrap();
    assert_eq!(
        list.iter()
            .map(|row| (row.target.as_str(), row.version))
            .collect::<Vec<_>>(),
        vec![("zeta", 0), (TARGET, 0)]
    );
    assert!(list
        .iter()
        .all(|row| row.draft.is_none() && row.lock.is_none()));

    let (lease, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    let list = f.svc.list().await.unwrap();
    assert!(list[0].draft.is_none() && list[0].lock.is_none());
    let published = f.svc.published(TARGET).await.unwrap();
    assert_eq!(
        (list[1].revision.as_str(), list[1].published_at.as_str()),
        (published.revision.as_str(), published.published_at.as_str())
    );
    let draft = list[1].draft.as_ref().unwrap();
    assert_eq!(
        (
            draft.base_version,
            draft.revision.as_str(),
            draft.updated_by.as_str()
        ),
        (0, revision.as_str(), "alice")
    );
    assert_eq!(list[1].lock.as_ref().unwrap().lease, lease);
    // no values in the list
    let wire = serde_json::to_value(&list[1]).unwrap();
    assert!(wire.get("value").is_none() && wire["draft"].get("value").is_none());
    assert_eq!(wire["draft"]["baseVersion"], 0);
    assert_eq!(wire["lock"]["holderName"], "alice");
    assert!(wire["lock"].get("holder").is_none());

    // an expired lock is no lock; the draft stays
    f.advance(TTL_MS);
    let list = f.svc.list().await.unwrap();
    assert!(list[1].lock.is_none() && list[1].draft.is_some());
}

#[tokio::test]
async fn list_fails_when_a_registered_target_was_not_seeded() {
    let db = Db::connect_sqlite_memory().await.unwrap();
    for sql in DDL {
        sqlx::query(sql)
            .execute(db.as_sqlite().unwrap())
            .await
            .unwrap();
    }
    let svc = ConfigDraftsService::new(db, registry(json!({})));
    let Err(BantoError::Other(message)) = svc.list().await else {
        panic!("expected the startup error");
    };
    assert!(message.contains("ensure_targets"), "{message}");
}

#[tokio::test]
async fn the_diff_masks_secrets_and_names_what_it_compared() {
    let targets = ConfigTargetRegistry::empty()
        .register(
            ConfigTarget::new(
                TARGET,
                json!({"limit": 1, "devices": [{"name": "a", "token": "t0ken-old"}]}),
                &["/devices/0/token"],
            )
            .unwrap(),
        )
        .unwrap();
    let f = fixture_with(targets).await;
    let a = alice();
    // no draft: nothing to compare
    let missing = f.svc.diff(TARGET, None).await;
    assert!(
        matches!(&missing, Err(BantoError::NotFound { resource, .. }) if resource == "config_draft"),
        "{missing:?}"
    );

    let value = json!({"limit": 2, "devices": [{"name": "a", "token": "t0ken-new"}]});
    let (_, revision) = start_draft(&f, &a, value).await;
    let published = f.svc.published(TARGET).await.unwrap();
    let diff = f.svc.diff(TARGET, None).await.unwrap();
    assert_eq!(
        serde_json::to_value(&diff).unwrap(),
        json!({
            "target": TARGET,
            "publishedVersion": 0,
            "publishedRevision": published.revision,
            "draftRevision": revision,
            "baseVersion": 0,
            "changes": [
                // the array holds the secret, so the whole entry is masked
                {"field": "/devices", "masked": true},
                {"field": "/limit", "before": 1, "after": 2},
            ],
        })
    );

    let done = f
        .svc
        .publish(TARGET, &a, &revision, &stamp(None))
        .await
        .unwrap();
    // published -> version 0: what a revert to 0 would change
    let back = f.svc.diff(TARGET, Some(0)).await.unwrap();
    let wire = serde_json::to_value(&back).unwrap();
    assert_eq!(wire["publishedRevision"], done.revision.as_str());
    assert_eq!(wire["toVersion"], 0);
    assert!(wire.get("draftRevision").is_none() && wire.get("baseVersion").is_none());
    assert_eq!(
        wire["changes"],
        json!([
            {"field": "/devices", "masked": true},
            {"field": "/limit", "before": 2, "after": 1},
        ])
    );
    // the current version against itself: nothing
    assert!(f
        .svc
        .diff(TARGET, Some(1))
        .await
        .unwrap()
        .changes
        .is_empty());
    // the secret is in no diff, and not in the outcome or the audit detail
    for text in [
        serde_json::to_string(&diff).unwrap(),
        wire.to_string(),
        serde_json::to_string(&done).unwrap(),
        publish_audit_detail(&done).to_string(),
        json!(f.svc.history_entry(TARGET, 1).await.unwrap().changes).to_string(),
    ] {
        assert!(!text.contains("t0ken"), "{text}");
    }
}

#[tokio::test]
async fn the_audit_detail_is_cut_and_the_answer_is_not() {
    let f = fixture().await;
    let a = alice();
    let mut value = serde_json::Map::new();
    for n in 0..110 {
        value.insert(format!("k{n:03}"), json!("x".repeat(1500)));
    }
    let done = publish_value(&f, &a, Value::Object(value)).await;
    // the answer: every change (110 added keys + /limit removed), whole
    assert_eq!(done.changes.len(), 111);
    assert_eq!(done.changes[0]["after"].as_str().unwrap().len(), 1500);
    // the audit detail: within the audit limits, and it says it was cut
    let detail = publish_audit_detail(&done);
    assert_eq!(detail["changesTruncated"], true);
    let changes = serde_json::to_string(&detail["changes"]).unwrap();
    assert!(
        changes.len() <= crate::audit::diff::MAX_PATH_CHANGES_BYTES,
        "{}",
        changes.len()
    );
    assert!(detail.get("comment").is_none() && detail.get("revertedTo").is_none());
    // the wire shape of the answer has no audit copy
    let wire = serde_json::to_value(&done).unwrap();
    let mut keys: Vec<_> = wire.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "changes",
            "kind",
            "previousVersion",
            "publishedAt",
            "revision",
            "target",
            "version"
        ]
    );
    assert_eq!(wire["kind"], "publish");
}

#[tokio::test]
async fn history_wire_shape_and_page_size() {
    let f = fixture().await;
    let a = alice();
    let (_, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    f.svc
        .publish(TARGET, &a, &revision, &stamp(Some("first change")))
        .await
        .unwrap();

    let detail = serde_json::to_value(f.svc.history_entry(TARGET, 1).await.unwrap()).unwrap();
    assert_eq!(detail["version"], 1);
    assert_eq!(detail["kind"], "publish");
    assert_eq!(detail["revertedTo"], Value::Null);
    assert_eq!(detail["actorUsername"], "alice");
    assert_eq!(detail["actorId"], 1);
    assert_eq!(detail["actorKind"], "account");
    assert_eq!(detail["origin"], "tauri");
    assert_eq!(detail["comment"], "first change");
    assert!(detail["publishedAt"].is_string());
    assert_eq!(detail["value"], json!({"limit": 2}));
    assert_eq!(detail["previousValue"], json!({"limit": 1}));
    assert_eq!(
        detail["changes"],
        json!([{"field": "/limit", "before": 1, "after": 2}])
    );
    // version 0 has nothing before it
    let initial = f.svc.history_entry(TARGET, 0).await.unwrap();
    assert_eq!(initial.entry.kind, ConfigHistoryKind::Initial);
    assert!(initial.previous_value.is_none() && initial.changes.is_empty());
    let missing = f.svc.history_entry(TARGET, 2).await;
    assert!(
        matches!(&missing, Err(BantoError::NotFound { resource, id })
            if resource == "config_version" && id == "plc.line1/2"),
        "{missing:?}"
    );

    // limit: 0 is 1, and a page is never over the maximum
    assert_eq!(f.svc.history(TARGET, None, 0).await.unwrap().len(), 1);
    let rows = i64::from(MAX_CONFIG_HISTORY_PAGE) + 20;
    for version in 2..rows {
        sqlx::query(
            "INSERT INTO config_history (target, version, value, kind) VALUES (?, ?, '{}', 'publish')",
        )
        .bind(TARGET)
        .bind(version)
        .execute(f.db.as_sqlite().unwrap())
        .await
        .unwrap();
    }
    let page = f.svc.history(TARGET, None, u32::MAX).await.unwrap();
    assert_eq!(page.len(), MAX_CONFIG_HISTORY_PAGE as usize);
    assert_eq!(page[0].version, rows - 1);
    let next = f
        .svc
        .history(TARGET, Some(page.last().unwrap().version), u32::MAX)
        .await
        .unwrap();
    assert_eq!(
        (next.len(), next[0].version, next.last().unwrap().version),
        (20, 19, 0)
    );
    // a kind this code does not know is a damaged row, not a guess
    sqlx::query("UPDATE config_history SET kind = 'merge' WHERE version = 5")
        .execute(f.db.as_sqlite().unwrap())
        .await
        .unwrap();
    assert!(matches!(
        f.svc.history(TARGET, Some(6), 1).await,
        Err(BantoError::Storage(_))
    ));
}

#[tokio::test]
async fn publish_and_revert_check_their_input() {
    let f = fixture().await;
    let a = alice();
    // no draft
    let missing = f.svc.publish(TARGET, &a, "x", &stamp(None)).await;
    assert!(
        matches!(&missing, Err(BantoError::NotFound { resource, id })
            if resource == "config_draft" && id == TARGET),
        "{missing:?}"
    );
    let (_, revision) = start_draft(&f, &a, json!({"limit": 2})).await;
    let published = f.svc.published(TARGET).await.unwrap();
    let long = "x".repeat(MAX_CONFIG_COMMENT_CHARS + 1);
    assert_eq!(
        validation_field(f.svc.publish(TARGET, &a, "", &stamp(None)).await),
        "ifDraftRevision"
    );
    assert_eq!(
        validation_field(
            f.svc
                .publish(TARGET, &a, &revision, &stamp(Some(&long)))
                .await
        ),
        "comment"
    );
    assert_eq!(
        validation_field(
            f.svc
                .revert(TARGET, &a, 0, &published.revision, &stamp(Some(&long)))
                .await
        ),
        "comment"
    );
    assert_eq!(
        validation_field(f.svc.revert(TARGET, &a, 0, "", &stamp(None)).await),
        "ifPublishedRevision"
    );
    assert_eq!(
        validation_field(f.svc.draft_rebase(TARGET, &a, "", "x").await),
        "ifRevision"
    );
    assert_eq!(
        validation_field(f.svc.draft_rebase(TARGET, &a, "x", "").await),
        "ifPublishedRevision"
    );
    assert_eq!(f.count("config_history").await, 1);

    // a comment at the limit goes through; a blank one is no comment
    let at_limit = "あ".repeat(MAX_CONFIG_COMMENT_CHARS);
    let done = f
        .svc
        .publish(TARGET, &a, &revision, &stamp(Some(&at_limit)))
        .await
        .unwrap();
    assert_eq!(done.comment.as_deref(), Some(at_limit.as_str()));
    let back = f
        .svc
        .revert(TARGET, &a, 0, &done.revision, &stamp(Some("   ")))
        .await
        .unwrap();
    assert_eq!(back.comment, None);
    let entry = f.svc.history_entry(TARGET, 2).await.unwrap().entry;
    assert_eq!((entry.comment, entry.reverted_to), (None, Some(0)));
}

#[tokio::test]
async fn a_rebase_extends_the_lock_and_reports_the_validator() {
    let targets = ConfigTargetRegistry::empty()
        .register(
            ConfigTarget::new(TARGET, json!({"limit": 1}), &[])
                .unwrap()
                .with_validator(|value| match value["limit"].as_i64() {
                    Some(limit) if limit > 100 => Err(vec![FieldError {
                        field: "limit".to_string(),
                        message: "too large".to_string(),
                    }]),
                    _ => Ok(()),
                }),
        )
        .unwrap();
    let f = fixture_with(targets).await;
    let a = alice();
    let (lease, revision) = start_draft(&f, &a, json!({"limit": 500})).await;
    f.bump_published().await;
    f.advance(1_000);
    let rebased = f
        .svc
        .draft_rebase(TARGET, &a, &revision, "moved")
        .await
        .unwrap();
    assert_eq!(rebased.base_version, 1);
    assert_eq!(rebased.validation[0].field, "limit");
    assert_eq!(
        (rebased.lock.lease.as_str(), rebased.lock.expires_at_ms),
        (lease.as_str(), START_MS + 1_000 + TTL_MS)
    );
    assert_eq!(
        f.state(&a).await.lock.unwrap().expires_at_ms,
        START_MS + 1_000 + TTL_MS
    );
    // after the expiry: no rebase
    f.advance(TTL_MS);
    conflict(
        f.svc
            .draft_rebase(TARGET, &a, &rebased.revision, "moved")
            .await,
        "lock_required",
    );
}
