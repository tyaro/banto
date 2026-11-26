//! The cases of config-draft-publish-design §6 that need a publish (T2, T3,
//! T4, T7, T8) and the two that need two connections ("the same snapshot",
//! "two connections publish at once"), written ONCE and run on both backends
//! (T11):
//!
//! - SQLite: a database in a file with two separate pools (`:memory:` cannot
//!   do this - every pool would be its own database);
//! - PostgreSQL: two pools on a schema of its own. Skipped unless
//!   `BANTO_TEST_PG_URL` is set; CI's `app-postgres` job runs them
//!   (`cargo test -p banto-admin-services --features postgres pg_config_drafts`).
//!
//! Every case takes a [`Bench`]: service `a` and service `b` are the same
//! service on different pools, so no statement of one shares a connection
//! with a statement of the other.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use super::tests::{alice, bob, conflict, validation_field, START_MS, TARGET, TTL_MS};
use super::*;
use crate::audit::diff::diff_paths;

pub(super) struct Bench {
    pub a: ConfigDraftsService,
    pub b: ConfigDraftsService,
    /// The pool of `a`, for looking at the tables directly.
    pub db: Db,
    pub clock: Arc<AtomicI64>,
    /// The validator refuses a `limit` below this (it starts at `i64::MIN`:
    /// everything passes). Moving it stands for "the validator changed".
    pub min_limit: Arc<AtomicI64>,
}

impl Bench {
    /// Two services on two pools of the same database, with one clock and
    /// one registry: `plc.line1`, default `{"limit": 1}`, the secret path
    /// `/secret`, and the validator above. Seeds the target.
    pub async fn start(first: Db, second: Db) -> Self {
        let min_limit = Arc::new(AtomicI64::new(i64::MIN));
        let min = min_limit.clone();
        let target = ConfigTarget::new(TARGET, json!({"limit": 1}), &["/secret"])
            .unwrap()
            .with_validator(
                move |value| match value.get("limit").and_then(Value::as_i64) {
                    Some(limit) if limit < min.load(Ordering::SeqCst) => Err(vec![FieldError {
                        field: "limit".to_string(),
                        message: "too small".to_string(),
                    }]),
                    _ => Ok(()),
                },
            );
        let targets = ConfigTargetRegistry::empty().register(target).unwrap();
        let clock = Arc::new(AtomicI64::new(START_MS));
        let service = |db: Db| {
            let read = clock.clone();
            ConfigDraftsService::new(db, targets.clone())
                .with_clock(move || read.load(Ordering::SeqCst))
        };
        let (a, b) = (service(first.clone()), service(second));
        a.ensure_targets().await.expect("ensure targets");
        Self {
            a,
            b,
            db: first,
            clock,
            min_limit,
        }
    }

    async fn count(&self, table: &str) -> i64 {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .fetch_one(pool)
                    .await
            }
        }
        .unwrap()
    }

    async fn exec(&self, sql: &str) {
        match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
                .execute(pool)
                .await
                .map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
                .execute(pool)
                .await
                .map(|_| ()),
        }
        .unwrap()
    }

    /// Everything a failed write must leave alone: the published row, the
    /// draft, the lock, and how many history rows there are.
    async fn picture(&self) -> (ConfigState, i64) {
        (
            self.a.state(TARGET, &alice()).await.unwrap(),
            self.count("config_history").await,
        )
    }
}

fn stamp(comment: Option<&'static str>) -> PublishStamp<'static> {
    PublishStamp {
        actor_username: "alice",
        actor_id: Some(1),
        actor_kind: "account",
        origin: "rest",
        comment,
    }
}

/// Acquire and create the draft from what is published now; gives the
/// draft's revision.
async fn start_draft(svc: &ConfigDraftsService, editor: &ConfigEditor, value: Value) -> String {
    svc.lock_acquire(TARGET, editor).await.unwrap();
    let published = svc.published(TARGET).await.unwrap();
    svc.draft_put(
        TARGET,
        editor,
        &value,
        CONFIG_DRAFT_ABSENT_REVISION,
        Some(&published.revision),
    )
    .await
    .unwrap()
    .revision
}

/// Draft `value` and publish it.
async fn publish_value(
    svc: &ConfigDraftsService,
    editor: &ConfigEditor,
    value: Value,
) -> PublishOutcome {
    let revision = start_draft(svc, editor, value).await;
    svc.publish(TARGET, editor, &revision, &stamp(None))
        .await
        .unwrap()
}

// --- T2: the version conflict, and the rebase that resolves it ---

pub(super) async fn stale_base_then_rebase(bench: &Bench) {
    let a = alice();
    let v1 = publish_value(&bench.a, &a, json!({"limit": 10})).await;
    assert_eq!((v1.version, v1.previous_version), (1, 0));

    let draft = start_draft(&bench.a, &a, json!({"limit": 20})).await;
    // the published value moves on under the draft (a revert, on the other
    // connection)
    let reverted = bench
        .b
        .revert(TARGET, &a, 0, &v1.revision, &stamp(None))
        .await
        .unwrap();
    assert_eq!(reverted.version, 2);

    let before = bench.picture().await;
    let current = conflict(
        bench.a.publish(TARGET, &a, &draft, &stamp(None)).await,
        "stale_base",
    );
    assert_eq!(current["baseVersion"], 1);
    assert_eq!(
        current["published"],
        json!({"version": 2, "revision": reverted.revision})
    );
    assert_eq!(bench.picture().await, before, "a refused publish wrote");

    // rebase: the published revision that was checked is no longer current
    let current = conflict(
        bench.a.draft_rebase(TARGET, &a, &draft, &v1.revision).await,
        "published_changed",
    );
    assert_eq!(current["published"]["version"], 2);
    // ... or the draft is not the one that was checked
    conflict(
        bench
            .a
            .draft_rebase(TARGET, &a, &"f".repeat(32), &reverted.revision)
            .await,
        "draft_changed",
    );
    assert_eq!(bench.picture().await, before, "a refused rebase wrote");

    let rebased = bench
        .a
        .draft_rebase(TARGET, &a, &draft, &reverted.revision)
        .await
        .unwrap();
    assert_eq!(rebased.base_version, 2);
    assert_ne!(rebased.revision, draft, "a rebase makes a new revision");
    let state = bench.a.state(TARGET, &a).await.unwrap();
    let now = state.draft.expect("the draft is kept");
    assert_eq!(
        (now.value, now.base_version, now.revision.as_str()),
        (json!({"limit": 20}), 2, rebased.revision.as_str())
    );
    assert_eq!(state.published.version, 2, "a rebase publishes nothing");

    // the publish screen opened before the rebase holds the old revision
    conflict(
        bench.a.publish(TARGET, &a, &draft, &stamp(None)).await,
        "draft_changed",
    );
    let v3 = bench
        .a
        .publish(TARGET, &a, &rebased.revision, &stamp(None))
        .await
        .unwrap();
    assert_eq!((v3.version, v3.previous_version), (3, 2));
    assert_eq!(
        bench.a.published(TARGET).await.unwrap().value,
        json!({"limit": 20})
    );

    // the first save of a new draft: the screen was opened before version 3
    bench.a.lock_acquire(TARGET, &a).await.unwrap();
    conflict(
        bench
            .a
            .draft_put(
                TARGET,
                &a,
                &json!({"limit": 30}),
                CONFIG_DRAFT_ABSENT_REVISION,
                Some(&reverted.revision),
            )
            .await,
        "published_changed",
    );
}

// --- T3: an old revision is a conflict in every write ---

pub(super) async fn old_revisions_are_conflicts(bench: &Bench) {
    let a = alice();
    let initial = bench.a.published(TARGET).await.unwrap();
    let v1 = publish_value(&bench.a, &a, json!({"limit": 10})).await;
    assert_ne!(v1.revision, initial.revision);

    let first = start_draft(&bench.a, &a, json!({"limit": 20})).await;
    let second = bench
        .a
        .draft_put(TARGET, &a, &json!({"limit": 30}), &first, None)
        .await
        .unwrap();
    // save with the old ifRevision
    conflict(
        bench
            .a
            .draft_put(TARGET, &a, &json!({"limit": 99}), &first, None)
            .await,
        "draft_changed",
    );
    // publish with the old ifDraftRevision
    let before = bench.picture().await;
    let current = conflict(
        bench.b.publish(TARGET, &a, &first, &stamp(None)).await,
        "draft_changed",
    );
    assert_eq!(current["revision"], second.revision.as_str());
    // revert with the old ifPublishedRevision
    let current = conflict(
        bench
            .b
            .revert(TARGET, &a, 0, &initial.revision, &stamp(None))
            .await,
        "published_changed",
    );
    assert_eq!(
        current["published"],
        json!({"version": 1, "revision": v1.revision})
    );
    assert_eq!(bench.picture().await, before);

    let v2 = bench
        .a
        .publish(TARGET, &a, &second.revision, &stamp(None))
        .await
        .unwrap();
    conflict(
        bench
            .a
            .revert(TARGET, &a, 0, &v1.revision, &stamp(None))
            .await,
        "published_changed",
    );
    let v3 = bench
        .a
        .revert(TARGET, &a, 0, &v2.revision, &stamp(None))
        .await
        .unwrap();
    // every publish makes a new revision, and the read returns that row whole
    let published = bench.b.published(TARGET).await.unwrap();
    assert_eq!(
        (published.version, published.revision, published.value),
        (3, v3.revision, initial.value)
    );
}

// --- T4: the lock rules, with publish / revert / rebase in them ---

pub(super) async fn lock_rules_cover_publish_and_revert(bench: &Bench) {
    let (a, b) = (alice(), bob());
    let v1 = publish_value(&bench.a, &a, json!({"limit": 10})).await;
    let state = bench.a.state(TARGET, &a).await.unwrap();
    assert!(
        state.draft.is_none() && state.lock.is_none(),
        "a publish removes the draft and the lock"
    );

    let lock = bench.a.lock_acquire(TARGET, &a).await.unwrap();
    let current = conflict(bench.b.lock_acquire(TARGET, &b).await, "lock_held");
    assert_eq!(current["lock"]["holderName"], "alice");
    assert_eq!(current["lock"]["expiresAtMs"], START_MS + TTL_MS);
    conflict(
        bench
            .b
            .draft_put(
                TARGET,
                &b,
                &json!({"limit": 2}),
                CONFIG_DRAFT_ABSENT_REVISION,
                Some(&v1.revision),
            )
            .await,
        "lock_required",
    );
    let draft = bench
        .a
        .draft_put(
            TARGET,
            &a,
            &json!({"limit": 20}),
            CONFIG_DRAFT_ABSENT_REVISION,
            Some(&v1.revision),
        )
        .await
        .unwrap()
        .revision;

    // bob knows every revision and the lease (the state shows them), and
    // still cannot publish, revert, rebase, extend or release
    let before = bench.picture().await;
    conflict(
        bench.b.publish(TARGET, &b, &draft, &stamp(None)).await,
        "lock_held",
    );
    conflict(
        bench
            .b
            .revert(TARGET, &b, 0, &v1.revision, &stamp(None))
            .await,
        "lock_held",
    );
    conflict(
        bench.b.draft_rebase(TARGET, &b, &draft, &v1.revision).await,
        "lock_required",
    );
    conflict(
        bench.b.lock_extend(TARGET, &b, &lock.lease).await,
        "lock_required",
    );
    bench.b.lock_release(TARGET, &b, &lock.lease).await.unwrap();
    assert_eq!(bench.picture().await, before);

    // alice's second tab takes the lock again: the first tab's lease is old
    let tab2 = bench.b.lock_acquire(TARGET, &a).await.unwrap();
    assert_ne!(tab2.lease, lock.lease);
    conflict(
        bench.a.lock_extend(TARGET, &a, &lock.lease).await,
        "lock_required",
    );
    bench.a.lock_release(TARGET, &a, &lock.lease).await.unwrap();
    let held = bench.a.state(TARGET, &a).await.unwrap().lock.unwrap();
    assert_eq!(held.lease, tab2.lease);

    // 1 ms before the expiry bob is still refused; at the expiry the lock is
    // the same as no lock, and bob may publish the draft
    bench.clock.store(held.expires_at_ms - 1, Ordering::SeqCst);
    conflict(
        bench.b.publish(TARGET, &b, &draft, &stamp(None)).await,
        "lock_held",
    );
    bench.clock.store(held.expires_at_ms, Ordering::SeqCst);
    let v2 = bench
        .b
        .publish(TARGET, &b, &draft, &stamp(None))
        .await
        .unwrap();
    assert_eq!(v2.version, 2);
    assert_eq!(bench.count("config_drafts").await, 0);
    assert_eq!(bench.count("config_locks").await, 0);

    // the holder may revert, and keeps the lock and the draft
    let draft = start_draft(&bench.a, &a, json!({"limit": 30})).await;
    let v3 = bench
        .a
        .revert(TARGET, &a, 1, &v2.revision, &stamp(None))
        .await
        .unwrap();
    assert_eq!(v3.version, 3);
    let state = bench.a.state(TARGET, &a).await.unwrap();
    assert!(state.lock_is_mine);
    assert_eq!(state.draft.unwrap().revision, draft);
}

// --- T7: a publish is all or nothing ---

pub(super) async fn publish_is_all_or_nothing(bench: &Bench) {
    let a = alice();
    let draft = start_draft(&bench.a, &a, json!({"limit": 2, "secret": "s3cr3t"})).await;

    // the validator refuses the value
    bench.min_limit.store(5, Ordering::SeqCst);
    let before = bench.picture().await;
    assert_eq!(
        validation_field(bench.a.publish(TARGET, &a, &draft, &stamp(None)).await),
        "limit"
    );
    assert_eq!(bench.picture().await, before);
    bench.min_limit.store(i64::MIN, Ordering::SeqCst);

    // a failure in the middle: the history already has the next version, so
    // the INSERT of step 6 fails after every check passed
    bench
        .exec(&format!(
            "INSERT INTO config_history (target, version, value, kind) \
             VALUES ('{TARGET}', 1, '{{}}', 'publish')"
        ))
        .await;
    let before = bench.picture().await;
    let failed = bench.a.publish(TARGET, &a, &draft, &stamp(None)).await;
    assert!(matches!(failed, Err(BantoError::Storage(_))), "{failed:?}");
    assert_eq!(bench.picture().await, before);
    assert_eq!(bench.count("config_drafts").await, 1);
    assert_eq!(bench.count("config_locks").await, 1);
    bench
        .exec(&format!(
            "DELETE FROM config_history WHERE target = '{TARGET}' AND version = 1"
        ))
        .await;

    // a draft equal to the published value makes no version
    let same = bench
        .a
        .draft_put(TARGET, &a, &json!({"limit": 1}), &draft, None)
        .await
        .unwrap();
    let before = bench.picture().await;
    let refused = bench
        .a
        .publish(TARGET, &a, &same.revision, &stamp(None))
        .await;
    assert!(
        matches!(refused, Err(BantoError::BadRequest(_))),
        "{refused:?}"
    );
    assert_eq!(bench.picture().await, before);

    // and the publish that goes through writes all four tables
    let value = json!({"limit": 2, "secret": "s3cr3t"});
    let draft = bench
        .a
        .draft_put(TARGET, &a, &value, &same.revision, None)
        .await
        .unwrap();
    let done = bench
        .a
        .publish(TARGET, &a, &draft.revision, &stamp(Some("  first  ")))
        .await
        .unwrap();
    assert_eq!((done.version, done.previous_version), (1, 0));
    assert_eq!(done.kind, ConfigHistoryKind::Publish);
    assert_eq!(done.comment.as_deref(), Some("first"));
    let published = bench.b.published(TARGET).await.unwrap();
    let newest = bench.b.history_entry(TARGET, 1).await.unwrap();
    assert_eq!(published.value, value);
    assert_eq!(
        newest.value, published.value,
        "published = the newest history row"
    );
    assert_eq!(newest.previous_value, Some(json!({"limit": 1})));
    assert_eq!(newest.entry.published_at, published.published_at);
    assert_eq!(done.published_at, published.published_at);
    assert_eq!(done.revision, published.revision);
    assert_eq!(bench.count("config_history").await, 2);
    assert_eq!(bench.count("config_drafts").await, 0);
    assert_eq!(bench.count("config_locks").await, 0);

    // the secret is in neither diff: not in the answer, not in the audit
    // detail, not in the history's diff
    for text in [
        serde_json::to_string(&done).unwrap(),
        publish_audit_detail(&done).to_string(),
        json!(newest.changes).to_string(),
    ] {
        assert!(!text.contains("s3cr3t"), "{text}");
        assert!(
            text.contains(r#"{"field":"/secret","masked":true}"#),
            "{text}"
        );
    }
    assert_eq!(
        publish_audit_detail(&done),
        json!({
            "version": 1,
            "previousVersion": 0,
            "comment": "first",
            "changes": [
                {"field": "/limit", "before": 1, "after": 2},
                {"field": "/secret", "masked": true},
            ],
        })
    );
}

// --- T8: a revert adds a version and removes nothing ---

pub(super) async fn revert_adds_a_version(bench: &Bench) {
    let a = alice();
    publish_value(&bench.a, &a, json!({"limit": 10})).await;
    publish_value(&bench.a, &a, json!({"limit": 20})).await;
    let v3 = publish_value(&bench.a, &a, json!({"limit": 30})).await;
    assert_eq!(v3.version, 3);
    let draft = start_draft(&bench.a, &a, json!({"limit": 40})).await;

    let v4 = bench
        .b
        .revert(TARGET, &a, 1, &v3.revision, &stamp(Some("back to 10")))
        .await
        .unwrap();
    assert_eq!((v4.version, v4.previous_version), (4, 3));
    assert_eq!(v4.kind, ConfigHistoryKind::Revert);
    assert_eq!(v4.reverted_to, Some(1));
    assert_eq!(
        v4.changes,
        diff_paths(&json!({"limit": 30}), &json!({"limit": 10}), &[])
    );
    assert_eq!(publish_audit_detail(&v4)["revertedTo"], 1);

    let published = bench.a.published(TARGET).await.unwrap();
    assert_eq!(
        (published.version, &published.value),
        (4, &json!({"limit": 10}))
    );
    assert_eq!(
        bench.a.history_entry(TARGET, 1).await.unwrap().value,
        published.value
    );
    let made = bench.a.history_entry(TARGET, 4).await.unwrap();
    assert_eq!(made.value, published.value);
    assert_eq!(made.previous_value, Some(json!({"limit": 30})));

    // 5 rows, versions 0..=4, none removed
    assert_eq!(bench.count("config_history").await, 5);
    let history = bench.a.history(TARGET, None, 10).await.unwrap();
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.version, entry.kind.as_str(), entry.reverted_to))
            .collect::<Vec<_>>(),
        vec![
            (4, "revert", Some(1)),
            (3, "publish", None),
            (2, "publish", None),
            (1, "publish", None),
            (0, "initial", None),
        ]
    );
    assert_eq!(
        (
            history[0].actor_username.as_deref(),
            history[0].actor_id,
            history[0].actor_kind.as_deref(),
            history[0].origin.as_deref(),
            history[0].comment.as_deref(),
        ),
        (
            Some("alice"),
            Some(1),
            Some("account"),
            Some("rest"),
            Some("back to 10")
        )
    );
    assert_eq!(history[0].published_at, published.published_at);
    assert_eq!(
        (
            history[4].actor_username.as_deref(),
            history[4].origin.as_deref()
        ),
        (None, None),
        "nobody published version 0"
    );
    // pages
    let page = bench.a.history(TARGET, Some(3), 2).await.unwrap();
    assert_eq!(
        page.iter().map(|entry| entry.version).collect::<Vec<_>>(),
        vec![2, 1]
    );

    // the draft is kept, with its old base: its publish needs a rebase
    let state = bench.a.state(TARGET, &a).await.unwrap();
    assert_eq!(state.draft.as_ref().unwrap().revision, draft);
    conflict(
        bench.a.publish(TARGET, &a, &draft, &stamp(None)).await,
        "stale_base",
    );

    // the validator of NOW decides: version 2's value (20) no longer passes
    bench.min_limit.store(25, Ordering::SeqCst);
    let before = bench.picture().await;
    assert_eq!(
        validation_field(
            bench
                .a
                .revert(TARGET, &a, 2, &v4.revision, &stamp(None))
                .await
        ),
        "limit"
    );
    assert_eq!(bench.picture().await, before);
    bench.min_limit.store(i64::MIN, Ordering::SeqCst);

    // the same value as now, the current version, a version that is not there
    let same = bench
        .a
        .revert(TARGET, &a, 1, &v4.revision, &stamp(None))
        .await;
    assert!(matches!(same, Err(BantoError::BadRequest(_))), "{same:?}");
    for to_version in [4, 9, -1] {
        assert_eq!(
            validation_field(
                bench
                    .a
                    .revert(TARGET, &a, to_version, &v4.revision, &stamp(None))
                    .await
            ),
            "toVersion"
        );
    }
    assert_eq!(bench.picture().await, before);
}

// --- "the same snapshot": a diff's changes belong to its revisions ---

pub(super) async fn reads_are_one_snapshot(bench: &Bench) {
    const ROUNDS: i64 = 25;
    let a = alice();
    // revision -> value, for every published and draft revision ever made
    let known: Arc<Mutex<HashMap<String, Value>>> = Arc::default();
    let initial = bench.a.published(TARGET).await.unwrap();
    known
        .lock()
        .unwrap()
        .insert(initial.revision.clone(), initial.value.clone());

    // the other connection keeps saving and publishing
    let writer = tokio::spawn({
        let (svc, a, known) = (bench.b.clone(), a.clone(), known.clone());
        async move {
            let note = |revision: &str, value: &Value| {
                known
                    .lock()
                    .unwrap()
                    .insert(revision.to_string(), value.clone());
            };
            for n in 1..=ROUNDS {
                let value = json!({"n": n, "step": 1});
                let first = start_draft(&svc, &a, value.clone()).await;
                note(&first, &value);
                let value = json!({"n": n, "step": 2});
                let second = svc
                    .draft_put(TARGET, &a, &value, &first, None)
                    .await
                    .unwrap();
                note(&second.revision, &value);
                let done = svc
                    .publish(TARGET, &a, &second.revision, &stamp(None))
                    .await
                    .unwrap();
                note(&done.revision, &value);
            }
        }
    });

    let (mut diffs, mut states, mut published) = (Vec::new(), Vec::new(), Vec::new());
    while !writer.is_finished() {
        match bench.a.diff(TARGET, None).await {
            Ok(diff) => diffs.push(diff),
            Err(BantoError::NotFound { .. }) => {} // between two drafts
            Err(other) => panic!("diff: {other:?}"),
        }
        states.push(bench.a.state(TARGET, &a).await.unwrap());
        published.push(bench.a.published(TARGET).await.unwrap());
        tokio::task::yield_now().await;
    }
    writer.await.unwrap();

    let known = known.lock().unwrap().clone();
    assert!(!diffs.is_empty(), "the reader never saw a draft");
    for diff in &diffs {
        // the changes are the diff of exactly the two values the answer's
        // revisions name ...
        let from = &known[&diff.published_revision];
        let to = &known[diff.draft_revision.as_ref().unwrap()];
        assert_eq!(diff.changes, diff_paths(from, to, &[]), "{diff:?}");
        // ... and the two rows are from the same moment: here every draft is
        // started from what is published, so a draft next to a NEWER
        // published row is a moment that never was
        assert_eq!(diff.base_version, Some(diff.published_version), "{diff:?}");
    }
    for state in &states {
        assert_eq!(known[&state.published.revision], state.published.value);
        if let Some(draft) = &state.draft {
            assert_eq!(known[&draft.revision], draft.value);
            assert_eq!(draft.base_version, state.published.version, "{state:?}");
        }
    }
    for row in &published {
        assert_eq!(known[&row.revision], row.value, "{row:?}");
    }

    // the marks of the diff that was shown are the conditions that pass; the
    // marks of the diff before it are refused
    let first = start_draft(&bench.a, &a, json!({"n": 100})).await;
    let shown_before = bench.b.diff(TARGET, None).await.unwrap();
    assert_eq!(shown_before.draft_revision.as_deref(), Some(first.as_str()));
    bench
        .a
        .draft_put(TARGET, &a, &json!({"n": 101}), &first, None)
        .await
        .unwrap();
    let shown = bench.b.diff(TARGET, None).await.unwrap();
    conflict(
        bench
            .a
            .publish(
                TARGET,
                &a,
                shown_before.draft_revision.as_ref().unwrap(),
                &stamp(None),
            )
            .await,
        "draft_changed",
    );
    let done = bench
        .a
        .publish(
            TARGET,
            &a,
            shown.draft_revision.as_ref().unwrap(),
            &stamp(None),
        )
        .await
        .unwrap();
    assert_eq!(done.changes, shown.changes);
    assert_eq!(done.previous_version, shown.published_version);

    // the same for "published -> version N" and the revert
    let to_initial = bench.b.diff(TARGET, Some(0)).await.unwrap();
    assert_eq!(
        (
            to_initial.published_revision.as_str(),
            to_initial.to_version
        ),
        (done.revision.as_str(), Some(0))
    );
    assert_eq!(
        to_initial.changes,
        diff_paths(&json!({"n": 101}), &initial.value, &[])
    );
    conflict(
        bench
            .a
            .revert(TARGET, &a, 0, &shown.published_revision, &stamp(None))
            .await,
        "published_changed",
    );
    let reverted = bench
        .a
        .revert(TARGET, &a, 0, &to_initial.published_revision, &stamp(None))
        .await
        .unwrap();
    assert_eq!(reverted.changes, to_initial.changes);
    let missing = bench.b.diff(TARGET, Some(999)).await;
    assert!(
        matches!(missing, Err(BantoError::NotFound { .. })),
        "{missing:?}"
    );
}

// --- two connections publish at once: one goes through, one version ---

pub(super) async fn two_connections_publish_at_once(bench: &Bench) {
    let a = alice();
    let who = stamp(None);
    let mut version = 0;

    // the same draft from two connections (two tabs of the lock's holder)
    for round in 1..=5 {
        let draft = start_draft(&bench.a, &a, json!({"limit": 100 + round})).await;
        let (first, second) = tokio::join!(
            bench.a.publish(TARGET, &a, &draft, &who),
            bench.b.publish(TARGET, &a, &draft, &who),
        );
        let (won, lost) = match (first, second) {
            (Ok(won), Err(lost)) | (Err(lost), Ok(won)) => (won, lost),
            other => panic!("exactly one publish must go through: {other:?}"),
        };
        version += 1;
        assert_eq!((won.version, won.previous_version), (version, version - 1));
        // the one that lost found the draft already published
        assert!(matches!(lost, BantoError::NotFound { .. }), "{lost:?}");
        let published = bench.a.published(TARGET).await.unwrap();
        assert_eq!(
            (published.version, published.revision, published.value),
            (version, won.revision, json!({"limit": 100 + round}))
        );
        assert_eq!(bench.count("config_history").await, version + 1);
    }

    // two reverts with the same condition
    let seen = bench.a.published(TARGET).await.unwrap();
    let (first, second) = tokio::join!(
        bench.a.revert(TARGET, &a, 0, &seen.revision, &who),
        bench.b.revert(TARGET, &a, 1, &seen.revision, &who),
    );
    let lost = match (first, second) {
        (Ok(_), Err(lost)) | (Err(lost), Ok(_)) => lost,
        other => panic!("exactly one revert must go through: {other:?}"),
    };
    conflict::<()>(Err(lost), "published_changed");
    version += 1;

    // a publish against a revert: whichever is second sees the other's
    // version
    let draft = start_draft(&bench.a, &a, json!({"limit": 500})).await;
    let seen = bench.a.published(TARGET).await.unwrap();
    assert_eq!(seen.version, version);
    let (published, reverted) = tokio::join!(
        bench.a.publish(TARGET, &a, &draft, &who),
        bench.b.revert(TARGET, &a, 2, &seen.revision, &who),
    );
    match (published, reverted) {
        (Ok(_), lost @ Err(_)) => {
            conflict(lost, "published_changed");
        }
        (lost @ Err(_), Ok(_)) => {
            conflict(lost, "stale_base");
        }
        other => panic!("exactly one write must go through: {other:?}"),
    }
    version += 1;

    let now = bench.a.published(TARGET).await.unwrap();
    assert_eq!(
        now.version, version,
        "one version per write that went through"
    );
    assert_eq!(bench.count("config_history").await, version + 1);
    assert_eq!(
        bench.a.history_entry(TARGET, version).await.unwrap().value,
        now.value
    );
}

// --- #953 review: `published_at` is the time of the write, not of the wait ---

/// A publish that waits for the published row's lock records when it ran
/// (after the wait), not when its transaction began; the published row, the
/// history row and the answer carry the same text. On SQLite only the
/// sameness is checked. The lock is released only after the publish is seen
/// waiting for it (`pg_stat_activity`), so the order does not depend on timing.
pub(super) async fn published_at_is_the_write_time(bench: &Bench) {
    let a = alice();
    let revision = start_draft(&bench.a, &a, json!({"limit": 30})).await;
    let outcome = match &bench.db {
        #[cfg(feature = "postgres")]
        Db::Postgres(pool) => {
            let (locked_tx, locked_rx) = tokio::sync::oneshot::channel::<()>();
            let holder = async {
                let mut tx = pool.begin().await.unwrap();
                sqlx::query("SELECT 1 FROM config_published WHERE target = $1 FOR UPDATE")
                    .bind(TARGET)
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
                let holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
                locked_tx.send(()).unwrap();
                // Release only once the writer is waiting on the row lock
                // (not after a fixed sleep that a slow machine could beat);
                // a bounded poll, and the test fails when it never waits.
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                loop {
                    let waiting: i64 = sqlx::query_scalar(
                        "SELECT count(*) FROM pg_stat_activity                          WHERE wait_event_type = 'Lock' AND pid <> $1                            AND datname = current_database()                            AND query LIKE '%config_published%FOR UPDATE%'",
                    )
                    .bind(holder_pid)
                    .fetch_one(pool)
                    .await
                    .unwrap();
                    if waiting > 0 {
                        break;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the publish never started waiting for the row lock"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                let released: String = sqlx::query_scalar("SELECT clock_timestamp()::text")
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
                tx.commit().await.unwrap();
                released
            };
            let writer = async {
                locked_rx.await.unwrap();
                bench
                    .b
                    .publish(TARGET, &a, &revision, &stamp(None))
                    .await
                    .unwrap()
            };
            let (released, outcome) = tokio::join!(holder, writer);
            let later: bool = sqlx::query_scalar("SELECT $1::timestamptz >= $2::timestamptz")
                .bind(&outcome.published_at)
                .bind(&released)
                .fetch_one(pool)
                .await
                .unwrap();
            assert!(
                later,
                "published_at {} is before the lock was released at {released}",
                outcome.published_at
            );
            outcome
        }
        _ => bench
            .a
            .publish(TARGET, &a, &revision, &stamp(None))
            .await
            .unwrap(),
    };
    let published = bench.a.published(TARGET).await.unwrap();
    assert_eq!(published.published_at, outcome.published_at);
    let history = bench.a.history(TARGET, None, 10).await.unwrap();
    assert_eq!(history[0].published_at, outcome.published_at);
}

// --- the runs ---

/// The four tables, PostgreSQL form (design §4.5). MUST be kept in sync with
/// the app's `migrations-postgres/0016_config_drafts.sql`, like `tests::DDL`
/// for SQLite (`verify:architecture`'s `config-drafts-ddl-copies` compares
/// them).
#[cfg(feature = "postgres")]
const PG_DDL: [&str; 4] = [
    "CREATE TABLE config_published (
        target       TEXT PRIMARY KEY,
        value        TEXT NOT NULL,
        version      BIGINT NOT NULL,
        revision     TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT (now()::text)
    )",
    "CREATE TABLE config_history (
        target         TEXT NOT NULL,
        version        BIGINT NOT NULL,
        value          TEXT NOT NULL,
        kind           TEXT NOT NULL,
        reverted_to    BIGINT,
        actor_username TEXT,
        actor_id       BIGINT,
        actor_kind     TEXT,
        origin         TEXT,
        comment        TEXT,
        published_at   TEXT NOT NULL DEFAULT (now()::text),
        PRIMARY KEY (target, version)
    )",
    "CREATE TABLE config_drafts (
        target       TEXT PRIMARY KEY,
        value        TEXT NOT NULL,
        base_version BIGINT NOT NULL,
        revision     TEXT NOT NULL,
        updated_by   TEXT NOT NULL,
        updated_at   TEXT NOT NULL DEFAULT (now()::text)
    )",
    "CREATE TABLE config_locks (
        target         TEXT PRIMARY KEY,
        holder         TEXT NOT NULL,
        holder_name    TEXT NOT NULL,
        lease          TEXT NOT NULL,
        acquired_at_ms BIGINT NOT NULL,
        expires_at_ms  BIGINT NOT NULL
    )",
];

/// A bench on a SQLite database in a file, with two separate pools.
async fn sqlite_bench() -> (Bench, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("config.db");
    let first = Db::connect_sqlite(&path).await.expect("connect");
    let second = Db::connect_sqlite(&path)
        .await
        .expect("connect the other pool");
    for sql in super::tests::DDL {
        sqlx::query(sql)
            .execute(first.as_sqlite().expect("sqlite handle"))
            .await
            .expect("create table");
    }
    (Bench::start(first, second).await, dir)
}

/// A bench on a PostgreSQL schema of its own (selected through
/// `search_path`, the pattern of `audit`'s `pg_scoped`), with two separate
/// pools; and the handle that drops the schema afterwards.
#[cfg(feature = "postgres")]
async fn pg_bench(url: &str, schema: &str) -> (Bench, Db) {
    let admin = Db::connect_postgres(url).await.unwrap();
    for sql in [
        format!("DROP SCHEMA IF EXISTS {schema} CASCADE"),
        format!("CREATE SCHEMA {schema}"),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(admin.as_postgres().unwrap())
            .await
            .unwrap();
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    let scoped = format!("{url}{sep}options=-c%20search_path%3D{schema}");
    let first = Db::connect_postgres(&scoped).await.unwrap();
    let second = Db::connect_postgres(&scoped).await.unwrap();
    for ddl in PG_DDL {
        sqlx::query(ddl)
            .execute(first.as_postgres().unwrap())
            .await
            .unwrap();
    }
    (Bench::start(first, second).await, admin)
}

/// One test per case and backend. The PostgreSQL ones are all under
/// `pg_config_drafts` (the name CI filters by).
macro_rules! on_both_backends {
    ($($case:ident),+ $(,)?) => {
        mod sqlite_two_pools {
            $(
                #[tokio::test]
                async fn $case() {
                    let (bench, _dir) = super::sqlite_bench().await;
                    super::$case(&bench).await;
                }
            )+
        }

        #[cfg(feature = "postgres")]
        mod pg_config_drafts {
            /// Numbers the schemas of this process's tests.
            static NEXT_SCHEMA: std::sync::atomic::AtomicUsize =
                std::sync::atomic::AtomicUsize::new(0);

            $(
                #[tokio::test]
                async fn $case() {
                    let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
                        return;
                    };
                    // Unique per test and process (PostgreSQL cuts a name at
                    // 63 bytes, so not the case's whole name).
                    let schema = format!(
                        "banto_938_{}_{}",
                        std::process::id(),
                        NEXT_SCHEMA.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    );
                    let (bench, admin) = super::pg_bench(&url, &schema).await;
                    super::$case(&bench).await;
                    sqlx::query(sqlx::AssertSqlSafe(format!(
                        "DROP SCHEMA IF EXISTS {schema} CASCADE"
                    )))
                    .execute(admin.as_postgres().unwrap())
                    .await
                    .unwrap();
                }
            )+
        }
    };
}

on_both_backends!(
    stale_base_then_rebase,
    old_revisions_are_conflicts,
    lock_rules_cover_publish_and_revert,
    publish_is_all_or_nothing,
    revert_adds_a_version,
    reads_are_one_snapshot,
    two_connections_publish_at_once,
    published_at_is_the_write_time,
);
