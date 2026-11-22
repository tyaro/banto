//! Issue #793 / ADR-0035: `server_apply` when the listener it stops still has
//! writes running after the wait. They cannot be cancelled, so no listener
//! may start under the requested settings next to them - and which way out
//! is safe depends on the direction of the change:
//!
//! - widening or equal: the switch fails, nothing is saved, the previous
//!   listener is back;
//! - narrowing: the previous listener does NOT come back, the settings are
//!   saved, and the remaining writes are in the audit row.
//!
//! The direction itself is `banto_server::restoring_previous_stays_within`
//! (unit-tested there, mixed changes included); these tests cover what the
//! apply does with it. A write is held on the live listener the same way the
//! layer counts a request (`RunningServer::hold_write_for_test`).

use super::*;

const HELD: &str = "POST /api/users";

/// Counts one write as running on the live listener until the result is
/// dropped.
async fn hold_write(state: &AppState) -> impl Send + 'static {
    let slot = state.server.lock().await;
    slot.live
        .as_ref()
        .expect("a live listener")
        .server
        .hold_write_for_test(HELD)
        .expect("the listener accepts writes")
}

fn remaining_writes_of(detail: &serde_json::Value) -> serde_json::Value {
    detail["remainingWrites"].clone()
}

fn one_held_write() -> serde_json::Value {
    serde_json::json!({ "count": 1, "operations": [HELD] })
}

/// Another port (equal exposure) and public viewing turned on (wider): the
/// switch fails, nothing is saved, the previous listener serves again.
#[tokio::test]
async fn a_widening_or_equal_change_fails_and_keeps_the_previous_configuration() {
    let state = admin_app_state().await;
    let port_a = free_port();
    apply(&state, true, port_a, false).await.expect("apply A");
    let held = hold_write(&state).await;

    // Equal: only the port changes.
    let port_b = free_port();
    assert!(apply(&state, true, port_b, false).await.is_err());
    let status = server_status_body(&state).await.expect("status");
    assert!(status.running);
    assert_eq!((status.port, status.viewer_public), (port_a, false));
    assert_eq!(status.live.as_ref().map(|live| live.port), Some(port_a));
    assert!(answers_http(port_a).await, "the previous listener is back");
    assert!(port_is_free(port_b), "nothing was started on the new port");
    assert_eq!(
        status.apply_failure,
        Some(ServerApplyFailure {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port: port_b,
            reason: ServerApplyFailureReason::WritesRemaining,
            previous: PreviousServerOutcome::Restored,
        })
    );
    let entries = settings_change_entries(&state).await;
    let failed: Vec<_> = entries
        .iter()
        .filter(|(result, _)| result == "failed")
        .collect();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].1["saved"], false);
    assert_eq!(failed[0].1["restoredPrevious"], true);
    assert_eq!(remaining_writes_of(&failed[0].1), one_held_write());

    // Wider: public viewing turned on. The held write is still tracked
    // although the listener it belonged to is gone.
    assert!(apply(&state, true, port_a, true).await.is_err());
    let status = server_status_body(&state).await.expect("status");
    assert!(status.running);
    assert!(!status.viewer_public, "public viewing was not saved");
    assert!(answers_http(port_a).await);

    // Once the write is done, the same change goes through.
    drop(held);
    let status = apply(&state, true, port_b, true).await.expect("apply B");
    assert_eq!((status.port, status.viewer_public), (port_b, true));
    assert_eq!(status.apply_failure, None);
    assert!(answers_http(port_b).await);

    stop_running_server(&state).await;
}

/// Turning the server off is narrowing: it stays off, the setting is saved,
/// the remaining write is in the audit row - and nothing may be started next
/// to that write afterwards.
#[tokio::test]
async fn disabling_the_server_stays_closed_and_records_the_remaining_writes() {
    let state = admin_app_state().await;
    let port = free_port();
    apply(&state, true, port, false).await.expect("apply on");
    let held = hold_write(&state).await;

    let status = apply(&state, false, port, false)
        .await
        .expect("turning the server off succeeds");
    assert!(!status.enabled, "saved");
    assert!(!status.running);
    assert_eq!(status.live, None);
    assert_eq!(status.apply_failure, None);
    assert!(port_is_free(port), "the listener did not come back");
    let entries = settings_change_entries(&state).await;
    let recorded = entries
        .iter()
        .find(|(result, detail)| result == "ok" && detail["serverEnabled"] == false)
        .expect("the change is audited");
    assert_eq!(remaining_writes_of(&recorded.1), one_held_write());

    // Turning it on again while that write runs is refused; nothing saved.
    assert!(apply(&state, true, port, false).await.is_err());
    let status = server_status_body(&state).await.expect("status");
    assert!(!status.enabled);
    assert!(!status.running);
    assert_eq!(
        status
            .apply_failure
            .map(|failure| (failure.reason, failure.previous)),
        Some((
            ServerApplyFailureReason::WritesRemaining,
            PreviousServerOutcome::None
        ))
    );
    assert!(port_is_free(port));

    drop(held);
    let status = apply(&state, true, port, false).await.expect("apply on");
    assert!(status.running);
    assert_eq!(status.apply_failure, None);

    stop_running_server(&state).await;
}

/// Turning public viewing off while the server stays enabled is narrowing
/// too: the previous listener (which served under public viewing) does not
/// come back, the new setting is saved, and the listener starts only with a
/// later apply, after the write is done.
#[tokio::test]
async fn a_narrowing_change_that_still_needs_a_listener_saves_and_stays_closed() {
    let state = admin_app_state().await;
    let port = free_port();
    apply(&state, true, port, true)
        .await
        .expect("apply with public viewing");
    let held = hold_write(&state).await;

    assert!(
        apply(&state, true, port, false).await.is_err(),
        "the result says that writes remain"
    );
    let status = server_status_body(&state).await.expect("status");
    assert!(status.enabled);
    assert!(!status.viewer_public, "the narrower setting is saved");
    assert!(!status.running, "the listener is not brought back");
    assert!(port_is_free(port));
    assert_eq!(
        status.apply_failure,
        Some(ServerApplyFailure {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port,
            reason: ServerApplyFailureReason::WritesRemaining,
            previous: PreviousServerOutcome::LeftClosed,
        })
    );
    let entries = settings_change_entries(&state).await;
    let recorded = entries
        .iter()
        .find(|(result, detail)| result == "ok" && detail["viewerPublic"] == false)
        .expect("the saved change is audited");
    assert_eq!(recorded.1["listening"], false);
    assert_eq!(remaining_writes_of(&recorded.1), one_held_write());

    // Still running: applying again does not start anything either.
    assert!(apply(&state, true, port, false).await.is_err());
    assert!(port_is_free(port));

    drop(held);
    let status = apply(&state, true, port, false).await.expect("apply again");
    assert!(status.running);
    assert!(!status.viewer_public);
    assert_eq!(status.apply_failure, None);
    assert!(answers_http(port).await);

    stop_running_server(&state).await;
}

/// Review of PR #829: when it is the SAVE of the narrower settings that
/// fails while a write remains, the previous listener must not come back
/// either (it served under public viewing). Result: closed, not saved.
#[tokio::test]
async fn a_narrowing_change_whose_save_fails_does_not_bring_the_listener_back() {
    let state = admin_app_state().await;
    let port = free_port();
    // 閲覧公開 ON makes disabling auth below legal while LAN is enabled.
    apply(&state, true, port, true)
        .await
        .expect("apply with public viewing");
    let held = hold_write(&state).await;

    let applying = apply(&state, true, port, false);
    tokio::pin!(applying);
    // Drive the apply until it has stopped the listener (it then waits for
    // the held write before it gets to the save).
    loop {
        tokio::select! {
            biased;
            result = &mut applying => panic!("finished before the save could be made to fail: {result:?}"),
            () = tokio::time::sleep(std::time::Duration::from_millis(10)) => {
                if port_is_free(port) {
                    break;
                }
            }
        }
    }
    // The final re-validation refuses LAN without 閲覧公開 once auth is
    // disabled, so the save of the narrower settings fails.
    let mut auth = state.settings.auth_config().await.unwrap();
    auth.disabled = true;
    state.settings.set_auth_config(&auth).await.expect("auth");

    assert!(applying.await.is_err());
    let status = server_status_body(&state).await.expect("status");
    assert!(!status.running, "the public listener is not reopened");
    assert_eq!(status.live, None);
    assert!(port_is_free(port));
    assert!(status.viewer_public, "the narrower setting was not saved");
    assert_eq!(
        status.apply_failure,
        Some(ServerApplyFailure {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port,
            reason: ServerApplyFailureReason::SaveFailed,
            previous: PreviousServerOutcome::LeftClosed,
        })
    );
    let entries = settings_change_entries(&state).await;
    let failed: Vec<_> = entries
        .iter()
        .filter(|(result, _)| result == "failed")
        .collect();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].1["saved"], false);
    assert_eq!(failed[0].1["restoredPrevious"], false);
    assert_eq!(failed[0].1["listening"], false);
    assert_eq!(remaining_writes_of(&failed[0].1), one_held_write());

    drop(held);
}

#[test]
fn the_new_failure_codes_serialize_in_camel_case() {
    assert_eq!(
        serde_json::to_value(ServerApplyFailureReason::WritesRemaining).unwrap(),
        "writesRemaining"
    );
    assert_eq!(
        serde_json::to_value(PreviousServerOutcome::LeftClosed).unwrap(),
        "leftClosed"
    );
}
