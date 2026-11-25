//! Issue #938 (config-draft-publish-design §7, S4): the `config_*` commands -
//! the Tauri twins of `/api/config/*`. Same gates
//! (`admin_template_core::rest::config_drafts_access`), same audit rows and
//! same events as the REST router; only `origin` differs (conventions §1).
//! The rules of the service and of the router are tested where they live
//! (`banto-admin-services`, `banto-server`); here: the guards, what each
//! command records and announces, who holds a lock, and the two paths side
//! by side on one database.

use super::*;
use serde_json::json;

const TARGET: &str = CONFIG_TEST_TARGET;

/// [`app_state`]: its `config_drafts` has one registered target,
/// [`TARGET`] (`config_drafts_for_tests!` - what a derived app registers in
/// `admin_template_core::config_targets`; the template registers none),
/// seeded on the tables of the real migration. No session yet.
async fn config_state() -> AppState {
    app_state().await
}

/// [`config_state`] whose session is a fresh account `name` of `role`.
async fn config_state_as(name: &str, role: Role) -> AppState {
    let state = config_state().await;
    login_as(&state, name, role).await;
    state
}

/// Create the account and make it the desktop session.
async fn login_as(state: &AppState, name: &str, role: Role) -> UserIdentity {
    let user = state
        .users
        .create_user(name, REVOCATION_PASSWORD, name, role)
        .await
        .expect("create_user");
    state.set_session_for_test(Some(DesktopSession::Account(user.clone())));
    user
}

/// The audit rows of `resource: "config"`, oldest first, with the detail
/// parsed.
async fn config_audit(state: &AppState) -> Vec<(AuditRow, serde_json::Value)> {
    let mut rows = state
        .audit
        .list(ListParams::default())
        .await
        .expect("audit list")
        .rows;
    rows.retain(|row| row.resource == "config");
    rows.sort_by_key(|row| row.id);
    rows.into_iter()
        .map(|row| {
            let detail = row
                .detail
                .as_deref()
                .map(|text| serde_json::from_str(text).expect("detail json"))
                .unwrap_or(serde_json::Value::Null);
            (row, detail)
        })
        .collect()
}

type AuditRow = admin_template_core::audit::AuditLogEntry;

/// The resources announced on `events` since the receiver was made / last
/// drained.
fn announced(events: &mut broadcast::Receiver<ServerEvent>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(ServerEvent::ResourceChanged { resource }) = events.try_recv() {
        out.push(resource);
    }
    out
}

/// Lock, then save `value` as the first draft; returns the draft's revision.
async fn start_draft(state: &AppState, value: serde_json::Value) -> String {
    let published = config_get_body(state, TARGET)
        .await
        .expect("state")
        .published
        .revision;
    config_lock_acquire_body(state, TARGET).await.expect("lock");
    config_draft_put_body(state, TARGET, &value, "0", Some(&published))
        .await
        .expect("save the draft")
        .revision
}

/// One call of every command, as `(name, duty's route, result)`. The
/// arguments are plausible but stale - a caller that passes the guards gets
/// a conflict or a field error, never a write.
async fn call_every_command(state: &AppState) -> Vec<(&'static str, Result<(), BantoError>)> {
    let value = json!({"limit": 9});
    vec![
        ("config_list", config_list_body(state).await.map(drop)),
        ("config_get", config_get_body(state, TARGET).await.map(drop)),
        (
            "config_diff",
            config_diff_body(state, TARGET, Some(0)).await.map(drop),
        ),
        (
            "config_history_list",
            config_history_list_body(state, TARGET, None, None)
                .await
                .map(drop),
        ),
        (
            "config_history_get",
            config_history_get_body(state, TARGET, 0).await.map(drop),
        ),
        (
            "config_lock_extend",
            config_lock_extend_body(state, TARGET, "stale")
                .await
                .map(drop),
        ),
        (
            "config_lock_release",
            config_lock_release_body(state, TARGET, "stale").await,
        ),
        (
            "config_draft_put",
            config_draft_put_body(state, TARGET, &value, "stale", None)
                .await
                .map(drop),
        ),
        (
            "config_draft_rebase",
            config_draft_rebase_body(state, TARGET, "stale", "stale")
                .await
                .map(drop),
        ),
        (
            "config_draft_discard",
            config_draft_discard_body(state, TARGET, "stale")
                .await
                .map(drop),
        ),
        (
            "config_publish",
            config_publish_body(state, TARGET, "stale", None)
                .await
                .map(drop),
        ),
        (
            "config_revert",
            config_revert_body(state, TARGET, 0, "stale", None)
                .await
                .map(drop),
        ),
        (
            "config_unlock",
            config_unlock_body(state, TARGET, "stale").await,
        ),
        // Last: the only one of these calls that would write when let through.
        (
            "config_lock_acquire",
            config_lock_acquire_body(state, TARGET).await.map(drop),
        ),
    ]
}

/// Without a session every command is `Unauthorized`, and nothing is
/// recorded (conventions §1: a request without a session is not audited).
#[tokio::test]
async fn every_config_command_needs_a_session() {
    let state = config_state().await;
    let mut events = state.events.subscribe();

    let results = call_every_command(&state).await;
    assert_eq!(results.len(), 14);
    for (name, result) in results {
        assert!(
            matches!(result, Err(BantoError::Unauthorized)),
            "{name}: {result:?}"
        );
    }
    assert!(config_audit(&state).await.is_empty());
    assert!(announced(&mut events).is_empty());
}

/// The template's gates: all four duties need `admin`. An editor and a
/// viewer are refused by EVERY command with `Forbidden` and ONE `denied`
/// row each (`resource: "config"`, `origin: "tauri"`, no detail), and
/// nothing is written or announced - the twin of
/// `rest::tests::config_drafts::only_an_admin_passes_the_templates_gates`.
#[tokio::test]
async fn only_an_admin_passes_the_templates_gates() {
    for (name, role) in [("editor", Role::Editor), ("viewer", Role::Viewer)] {
        let state = config_state_as(name, role).await;
        let mut events = state.events.subscribe();

        let results = call_every_command(&state).await;
        for (command, result) in &results {
            assert!(
                matches!(result, Err(BantoError::Forbidden)),
                "{name} {command}: {result:?}"
            );
        }

        let rows = config_audit(&state).await;
        assert_eq!(rows.len(), results.len(), "one denied row per refusal");
        for (row, detail) in &rows {
            assert_eq!(row.action, "denied");
            assert_eq!(row.actor_username.as_deref(), Some(name));
            assert_eq!(row.origin, "tauri");
            assert_eq!(detail, &serde_json::Value::Null);
        }
        assert!(announced(&mut events).is_empty());

        // Nothing was locked or drafted (read with the service: the session
        // may not).
        let state_now = state
            .config_drafts
            .state(
                TARGET,
                &ConfigEditor {
                    holder: "nobody".to_string(),
                    name: "nobody".to_string(),
                },
            )
            .await
            .expect("state");
        assert!(state_now.draft.is_none() && state_now.lock.is_none());
    }
}

/// Cross-review of PR #960: the read gate and the duty's gate are decided on
/// ONE authorization. A slot re-bound while that authorization is being read
/// refuses the command (`Unauthorized`) - it is not decided again as the
/// session the slot holds by then, whichever way the two sessions differ:
///
/// - an admin's publish overtaken by ANOTHER admin's session: nothing is
///   published, recorded or announced as either of them;
/// - a viewer's command overtaken by an admin's session: it does not pass as
///   the admin, and no `denied` row is written for a subject that was not
///   decided on.
#[tokio::test]
async fn a_session_replaced_during_the_authorization_refuses_the_command() {
    let mut state = config_state_as("manager", Role::Admin).await;
    let draft = start_draft(&state, json!({"limit": 5})).await;
    let other = state
        .users
        .create_user("other", REVOCATION_PASSWORD, "other", Role::Admin)
        .await
        .expect("create_user");
    let mut events = state.events.subscribe();

    let mut hold = hold_permissions(&mut state);
    {
        let publish = config_publish_body(&state, TARGET, &draft, None);
        tokio::pin!(publish);
        tokio::select! {
            biased;
            out = &mut publish => panic!("finished before the permissions read: {:?}", out.map(drop)),
            _ = &mut hold.entered => {}
        }
        state.set_session_for_test(Some(DesktopSession::Account(other)));
        hold.release.send(()).unwrap();
        let result = publish.await.map(drop);
        assert!(
            matches!(result, Err(BantoError::Unauthorized)),
            "{result:?}"
        );
    }
    assert!(config_audit(&state).await.is_empty());
    assert!(announced(&mut events).is_empty());
    // The new session is an admin: its own command passes, and sees that
    // nothing was published (the draft is still there, at its revision).
    let seen = config_get_body(&state, TARGET).await.expect("state");
    assert_eq!(seen.draft.expect("the draft is kept").revision, draft);

    // The other way round: a viewer's command, overtaken by an admin.
    let mut state = config_state_as("watcher", Role::Viewer).await;
    let admin = state
        .users
        .create_user("manager", REVOCATION_PASSWORD, "manager", Role::Admin)
        .await
        .expect("create_user");
    let mut hold = hold_permissions(&mut state);
    {
        let list = config_list_body(&state);
        tokio::pin!(list);
        tokio::select! {
            biased;
            out = &mut list => panic!("finished before the permissions read: {:?}", out.map(drop)),
            _ = &mut hold.entered => {}
        }
        state.set_session_for_test(Some(DesktopSession::Account(admin)));
        hold.release.send(()).unwrap();
        let result = list.await.map(drop);
        assert!(
            matches!(result, Err(BantoError::Unauthorized)),
            "{result:?}"
        );
    }
    assert!(
        config_audit(&state).await.is_empty(),
        "neither the viewer nor the admin was decided on"
    );
}

/// The whole flow as an admin: lock -> save -> diff -> publish -> history ->
/// revert. What is recorded and announced is what the REST handlers record
/// and announce, with `origin: "tauri"`.
#[tokio::test]
async fn a_draft_is_published_and_reverted_through_the_commands() {
    let state = config_state_as("manager", Role::Admin).await;
    let mut events = state.events.subscribe();

    let draft = start_draft(&state, json!({"limit": 5, "secret": "s1"})).await;
    let diff = config_diff_body(&state, TARGET, None).await.expect("diff");
    assert_eq!(diff.draft_revision.as_deref(), Some(draft.as_str()));
    assert_eq!(diff.changes.len(), 2);
    assert_eq!(
        announced(&mut events),
        vec![format!("config-draft:{TARGET}"); 2],
        "the lock and the save"
    );
    assert!(
        config_audit(&state).await.is_empty(),
        "locks and draft saves are not audited"
    );

    let outcome = config_publish_body(&state, TARGET, &draft, Some("first"))
        .await
        .expect("publish");
    assert_eq!((outcome.version, outcome.previous_version), (1, 0));
    assert_eq!(announced(&mut events), vec![format!("config:{TARGET}")]);

    let history = config_history_list_body(&state, TARGET, None, None)
        .await
        .expect("history");
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].actor_username.as_deref(), Some("manager"));
    assert_eq!(history[0].origin.as_deref(), Some("tauri"));
    assert_eq!(history[0].comment.as_deref(), Some("first"));
    let detail = config_history_get_body(&state, TARGET, 1)
        .await
        .expect("history entry");
    assert_eq!(
        detail.previous_value,
        Some(json!({"limit": 1, "secret": "s0"}))
    );

    let to_initial = config_diff_body(&state, TARGET, Some(0))
        .await
        .expect("diff to a version");
    assert_eq!(to_initial.to_version, Some(0));
    let reverted = config_revert_body(&state, TARGET, 0, &outcome.revision, None)
        .await
        .expect("revert");
    assert_eq!((reverted.version, reverted.reverted_to), (2, Some(0)));
    assert_eq!(announced(&mut events), vec![format!("config:{TARGET}")]);
    assert_eq!(
        state
            .config_drafts
            .published(TARGET)
            .await
            .expect("published")
            .value,
        json!({"limit": 1, "secret": "s0"})
    );

    let rows = config_audit(&state).await;
    assert_eq!(
        rows.iter()
            .map(|(row, _)| row.action.as_str())
            .collect::<Vec<_>>(),
        ["publish", "revert"]
    );
    // The detail is the service's own, for both.
    assert_eq!(rows[0].1, publish_audit_detail(&outcome));
    assert_eq!(rows[1].1, publish_audit_detail(&reverted));
    for (row, detail) in &rows {
        assert_eq!(row.entity_id.as_deref(), Some(TARGET));
        assert_eq!(row.actor_username.as_deref(), Some("manager"));
        assert_eq!(row.actor_kind.as_deref(), Some(ACTOR_KIND_ACCOUNT));
        assert_eq!(row.origin, "tauri");
        assert_eq!(row.result, "ok");
        let text = detail.to_string();
        assert!(
            !text.contains("s0") && !text.contains("s1"),
            "a secret value in the audit detail: {text}"
        );
    }
}

/// Discard is audited only when a draft was discarded; a lock release that
/// removed nothing announces nothing; `lease` / `ifRevision` left out is the
/// service's field error (as REST's missing query condition).
#[tokio::test]
async fn discard_and_release_record_and_announce_only_what_changed() {
    let state = config_state_as("manager", Role::Admin).await;
    let mut events = state.events.subscribe();

    // "There is no draft" confirmed: nothing changes, nothing is recorded.
    let lock = config_lock_acquire_body(&state, TARGET)
        .await
        .expect("lock");
    assert_eq!(announced(&mut events).len(), 1);
    let none = config_draft_discard_body(&state, TARGET, "0")
        .await
        .expect("discard of nothing");
    assert_eq!(none.revision, "0");
    assert!(config_audit(&state).await.is_empty());
    assert!(announced(&mut events).is_empty());

    // The condition left out: a field error, on both commands.
    assert!(matches!(
        config_draft_discard_body(&state, TARGET, "").await,
        Err(BantoError::Validation { .. })
    ));
    assert!(matches!(
        config_lock_release_body(&state, TARGET, "").await,
        Err(BantoError::Validation { .. })
    ));

    // A real draft discarded: one `discard` row and one event.
    let published = config_get_body(&state, TARGET)
        .await
        .expect("state")
        .published
        .revision;
    let saved = config_draft_put_body(&state, TARGET, &json!({"limit": 7}), "0", Some(&published))
        .await
        .expect("save");
    assert_eq!(announced(&mut events).len(), 1);
    let discarded = config_draft_discard_body(&state, TARGET, &saved.revision)
        .await
        .expect("discard");
    let rows = config_audit(&state).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.action, "discard");
    assert_eq!(rows[0].0.origin, "tauri");
    assert_eq!(Some(rows[0].1.clone()), discard_audit_detail(&discarded));
    assert_eq!(
        announced(&mut events),
        vec![format!("config-draft:{TARGET}")]
    );

    // A stale lease removes nothing: success, no event. The real one does.
    config_lock_release_body(&state, TARGET, "not-the-lease")
        .await
        .expect("a stale release is not an error");
    assert!(announced(&mut events).is_empty());
    config_lock_release_body(&state, TARGET, &lock.lease)
        .await
        .expect("release");
    assert_eq!(
        announced(&mut events),
        vec![format!("config-draft:{TARGET}")]
    );
    assert_eq!(
        config_audit(&state).await.len(),
        1,
        "a release is not audited"
    );
}

/// A lock belongs to the ACCOUNT (`acct:<users.id>`), so another account
/// cannot write the draft, and an admin removes the lock with `config_unlock`
/// - audited with the service's detail (the holder's key and name).
#[tokio::test]
async fn another_accounts_lock_blocks_until_it_is_unlocked() {
    let state = config_state_as("alice", Role::Admin).await;
    let draft = start_draft(&state, json!({"limit": 3})).await;
    let alice_lock = config_get_body(&state, TARGET)
        .await
        .expect("state")
        .lock
        .expect("alice's lock");
    let alice = state.users.verify("alice", REVOCATION_PASSWORD).await;
    let alice_id = alice.expect("verify").expect("alice").id;

    login_as(&state, "bob", Role::Admin).await;
    let seen = config_get_body(&state, TARGET).await.expect("state");
    assert!(!seen.lock_is_mine);
    assert_eq!(
        seen.lock.as_ref().map(|lock| lock.holder_name.as_str()),
        Some("alice")
    );
    assert!(matches!(
        config_lock_acquire_body(&state, TARGET).await,
        Err(BantoError::Conflict { .. })
    ));
    assert!(matches!(
        config_publish_body(&state, TARGET, &draft, None).await,
        Err(BantoError::Conflict { .. })
    ));
    assert!(
        config_audit(&state).await.is_empty(),
        "a conflict is not audited"
    );

    let mut events = state.events.subscribe();
    config_unlock_body(&state, TARGET, &alice_lock.lease)
        .await
        .expect("unlock");
    assert_eq!(
        announced(&mut events),
        vec![format!("config-draft:{TARGET}")]
    );
    let rows = config_audit(&state).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.action, "unlock");
    assert_eq!(rows[0].0.actor_username.as_deref(), Some("bob"));
    assert_eq!(
        rows[0].1,
        json!({"holder": format!("acct:{alice_id}"), "holderName": "alice"})
    );

    // The draft stayed; bob takes the lock and publishes it.
    config_lock_acquire_body(&state, TARGET)
        .await
        .expect("bob's lock");
    let outcome = config_publish_body(&state, TARGET, &draft, None)
        .await
        .expect("publish");
    assert_eq!(outcome.version, 1);
}

/// The no-login session (ADR-0034): its lock holder is `local` (shown as
/// `local`), while the audit row and the history name the built-in `admin`
/// with kind `local` - the same split as the UI settings' owner.
#[tokio::test]
async fn the_no_login_session_edits_as_local_and_is_audited_as_the_builtin_admin() {
    let state = config_state().await;
    start_in_no_login_mode(&state, Role::Admin).await;

    let draft = start_draft(&state, json!({"limit": 4})).await;
    let seen = config_get_body(&state, TARGET).await.expect("state");
    assert!(seen.lock_is_mine);
    let lock = seen.lock.expect("the local session's lock");
    assert_eq!(lock.holder_name, "local");
    assert_eq!(seen.draft.expect("draft").updated_by, "local");

    config_publish_body(&state, TARGET, &draft, None)
        .await
        .expect("publish");
    let rows = config_audit(&state).await;
    assert_eq!(rows.len(), 1);
    let row = &rows[0].0;
    assert_eq!(row.action, "publish");
    assert_eq!(row.actor_id, Some(state.builtin_admin_id));
    assert_eq!(row.actor_kind.as_deref(), Some(ACTOR_KIND_LOCAL));
    let history = config_history_list_body(&state, TARGET, None, None)
        .await
        .expect("history");
    assert_eq!(history[0].actor_username, row.actor_username);
    assert_eq!(history[0].actor_id, row.actor_id);
    assert_eq!(history[0].actor_kind.as_deref(), Some(ACTOR_KIND_LOCAL));

    // The no-login mode as a viewer: refused like any viewer.
    let viewer = config_state().await;
    start_in_no_login_mode(&viewer, Role::Viewer).await;
    assert!(matches!(
        config_list_body(&viewer).await,
        Err(BantoError::Forbidden)
    ));
}

/// The two paths on ONE database and ONE service, as the app wires them
/// (`config_router` with the state's own handles): the same account holds
/// the same lock from the window and from a LAN browser, and a publish from
/// each path leaves audit rows that differ in `origin` only.
#[tokio::test]
async fn rest_and_tauri_share_the_lock_the_gates_and_the_audit_shape() {
    let state = config_state().await;
    login_as(&state, "manager", Role::Admin).await;
    login_as(&state, "editor", Role::Editor).await;
    desktop_login(&state, "manager").await;
    let server = start(
        ServerConfig {
            bind: "127.0.0.1".to_string(),
            port: 0,
        },
        config_router(
            state.config_drafts.clone(),
            state.audit.clone(),
            state.rest_auth.clone(),
            state.events.clone(),
        ),
    )
    .await
    .expect("start test server");
    let manager = rest_token(&state, "manager", false).await;
    let editor = rest_token(&state, "editor", false).await;
    let base = format!("/api/config/{TARGET}");
    let rest =
        |method: &'static str, path: String, token: String, body: Option<serde_json::Value>| {
            let server = &server;
            async move {
                let (status, text) = http(server, method, &path, Some(&token), body).await;
                let json = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
                (status, json)
            }
        };

    // The lock taken in the window is the same account's lock over REST.
    let draft = start_draft(&state, json!({"limit": 2})).await;
    let (status, seen) = rest("GET", base.clone(), manager.clone(), None).await;
    assert_eq!(status, 200, "{seen}");
    assert_eq!(seen["lockIsMine"], true);
    assert_eq!(seen["lock"]["holderName"], "manager");
    assert_eq!(seen["draft"]["revision"], draft);

    // Publish 1 from the window (it gives the lock back), publish 2 over REST
    // - and the lock taken over REST is the window's too.
    let first = config_publish_body(&state, TARGET, &draft, Some("same comment"))
        .await
        .expect("publish from the window");
    let (status, lock) = rest("POST", format!("{base}/lock"), manager.clone(), None).await;
    assert_eq!(status, 200, "{lock}");
    assert!(
        config_get_body(&state, TARGET)
            .await
            .expect("state")
            .lock_is_mine
    );
    let (status, saved) = rest(
        "PUT",
        format!("{base}/draft"),
        manager.clone(),
        Some(json!({
            "value": {"limit": 3},
            "ifRevision": "0",
            "ifPublishedRevision": first.revision,
        })),
    )
    .await;
    assert_eq!(status, 200, "{saved}");
    let (status, second) = rest(
        "POST",
        format!("{base}/publish"),
        manager.clone(),
        Some(json!({"ifDraftRevision": saved["revision"], "comment": "same comment"})),
    )
    .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["version"], 2);

    // The editor is refused on both paths, one `denied` row each.
    let (status, refused) = rest("GET", base.clone(), editor, None).await;
    assert_eq!(status, 403, "{refused}");
    desktop_login(&state, "editor").await;
    assert!(matches!(
        config_get_body(&state, TARGET).await,
        Err(BantoError::Forbidden)
    ));

    let rows = config_audit(&state).await;
    assert_eq!(
        rows.iter()
            .map(|(row, _)| (row.action.as_str(), row.origin.as_str()))
            .collect::<Vec<_>>(),
        [
            ("publish", "tauri"),
            ("publish", "rest"),
            ("denied", "rest"),
            ("denied", "tauri"),
        ]
    );
    let (tauri, rest_row) = (&rows[0], &rows[1]);
    for (a, b) in [
        (&tauri.0.actor_username, &rest_row.0.actor_username),
        (&tauri.0.actor_role, &rest_row.0.actor_role),
        (&tauri.0.actor_kind, &rest_row.0.actor_kind),
        (&tauri.0.entity_id, &rest_row.0.entity_id),
    ] {
        assert_eq!(a, b);
    }
    assert_eq!(tauri.0.actor_id, rest_row.0.actor_id);
    assert_eq!(tauri.0.resource, rest_row.0.resource);
    assert_eq!(tauri.0.result, rest_row.0.result);
    // The same keys in the detail (the versions and the changed paths differ).
    let keys = |detail: &serde_json::Value| {
        detail
            .as_object()
            .expect("an object")
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(keys(&tauri.1), keys(&rest_row.1));
    assert_eq!(tauri.1["comment"], rest_row.1["comment"]);
    // The denied rows name the same resource and actor.
    assert_eq!(rows[2].0.actor_username, rows[3].0.actor_username);
    assert_eq!(rows[2].0.resource, rows[3].0.resource);

    // And the history tells the two origins apart.
    desktop_login(&state, "manager").await;
    let history = config_history_list_body(&state, TARGET, None, None)
        .await
        .expect("history");
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.version, entry.origin.as_deref()))
            .collect::<Vec<_>>(),
        [(2, Some("rest")), (1, Some("tauri")), (0, None)]
    );
    server.stop().await;
}
