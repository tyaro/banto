//! The conditional-write cases of the per-owner UI settings (Issue #786,
//! downstream-requests-2026-11-plan §4.4), written once and run on both
//! dialects: `ui_settings_sqlite.rs` (a real file, the real migrations) and
//! `pg_smoke.rs` (PostgreSQL, CI only).
//!
//! Every case takes TWO `SettingsService` handles built on SEPARATE pools of
//! the same database, so a pass is the database's doing (one statement that
//! checks and writes, the primary key, the foreign key) and not an accident
//! of one connection serializing its own statements.

use admin_template_core::settings::SettingsService;
use admin_template_core::ui_settings::{UiSettingsOwner, UI_SETTING_ABSENT_REVISION};
use admin_template_core::users::{Role, UsersService};
use banto_core::BantoError;

/// A grant kind nothing else uses, so the cases own their rows.
fn case_owner() -> UiSettingsOwner {
    UiSettingsOwner::Grant("uiSettingsCases".to_string())
}

fn conflict_current(result: Result<impl std::fmt::Debug, BantoError>) -> serde_json::Value {
    match result {
        Err(BantoError::Conflict { current, .. }) => current.expect("a conflict carries the row"),
        other => panic!("expected Conflict, got {other:?}"),
    }
}

/// Runs every case. `a` and `b` are on separate pools; `users` creates and
/// deletes the accounts the foreign-key cases need (and removes them again).
pub async fn run_all(a: &SettingsService, b: &SettingsService, users: &UsersService) {
    two_conditional_updates_from_one_revision(a, b).await;
    two_inserts_of_a_missing_row(a, b).await;
    a_row_written_again_after_a_delete(a, b).await;
    an_account_that_does_not_exist(a, b).await;
    account_delete_and_put_in_both_orders(a, b, users).await;
    account_delete_racing_a_put(b, users).await;
}

/// Two conditional writes that both read the SAME revision: exactly one
/// passes, the other is told `conflict` with the winner's row.
async fn two_conditional_updates_from_one_revision(a: &SettingsService, b: &SettingsService) {
    let owner = case_owner();
    let key = "cases.update";
    for round in 0..20 {
        let base = a.ui_put(&owner, key, "base", None).await.unwrap();
        let (from_a, from_b) = tokio::join!(
            a.ui_put(&owner, key, "from-a", Some(&base.revision)),
            b.ui_put(&owner, key, "from-b", Some(&base.revision)),
        );
        let (winner_value, winner, loser) = match (from_a, from_b) {
            (Ok(won), lost @ Err(_)) => ("from-a", won, lost),
            (lost @ Err(_), Ok(won)) => ("from-b", won, lost),
            (Ok(_), Ok(_)) => panic!("round {round}: both conditional updates passed"),
            (Err(x), Err(y)) => panic!("round {round}: neither passed: {x:?} / {y:?}"),
        };
        assert_eq!(
            conflict_current(loser),
            serde_json::json!({ "value": winner_value, "revision": winner.revision }),
            "round {round}"
        );
        let stored = b.ui_get(&owner, key).await.unwrap();
        assert_eq!(stored.value.as_deref(), Some(winner_value));
        assert_eq!(stored.revision, winner.revision);
    }
    a.ui_delete(&owner, key, None).await.unwrap();
}

/// Two `ifRevision: "0"` writes of a row that does not exist: exactly one
/// creates it.
async fn two_inserts_of_a_missing_row(a: &SettingsService, b: &SettingsService) {
    let owner = case_owner();
    let key = "cases.insert";
    for round in 0..20 {
        let (from_a, from_b) = tokio::join!(
            a.ui_put(&owner, key, "from-a", Some(UI_SETTING_ABSENT_REVISION)),
            b.ui_put(&owner, key, "from-b", Some(UI_SETTING_ABSENT_REVISION)),
        );
        let (winner_value, winner, loser) = match (from_a, from_b) {
            (Ok(won), lost @ Err(_)) => ("from-a", won, lost),
            (lost @ Err(_), Ok(won)) => ("from-b", won, lost),
            (Ok(_), Ok(_)) => panic!("round {round}: both inserts passed"),
            (Err(x), Err(y)) => panic!("round {round}: neither passed: {x:?} / {y:?}"),
        };
        assert_eq!(
            conflict_current(loser),
            serde_json::json!({ "value": winner_value, "revision": winner.revision }),
            "round {round}"
        );
        // Unconditional: gone for the next round.
        b.ui_delete(&owner, key, None).await.unwrap();
    }
}

/// A row deleted and written again does not accept a revision from before
/// the delete - for a write or for another delete.
async fn a_row_written_again_after_a_delete(a: &SettingsService, b: &SettingsService) {
    let owner = case_owner();
    let key = "cases.recreate";
    let before = a.ui_put(&owner, key, "before", None).await.unwrap();
    let deleted = b
        .ui_delete(&owner, key, Some(&before.revision))
        .await
        .unwrap();
    assert_eq!(deleted.revision, UI_SETTING_ABSENT_REVISION);
    assert_eq!(
        a.ui_get(&owner, key).await.unwrap().revision,
        UI_SETTING_ABSENT_REVISION
    );

    let again = b
        .ui_put(&owner, key, "again", Some(UI_SETTING_ABSENT_REVISION))
        .await
        .unwrap();
    assert_ne!(again.revision, before.revision);
    let expected = serde_json::json!({ "value": "again", "revision": again.revision });
    assert_eq!(
        conflict_current(a.ui_put(&owner, key, "stale", Some(&before.revision)).await),
        expected
    );
    assert_eq!(
        conflict_current(a.ui_delete(&owner, key, Some(&before.revision)).await),
        expected
    );
    a.ui_delete(&owner, key, Some(&again.revision))
        .await
        .unwrap();
}

/// No `users` row, no `ui_settings` row: the foreign key refuses it on every
/// connection, as "no session" - not as a storage error.
async fn an_account_that_does_not_exist(a: &SettingsService, b: &SettingsService) {
    let ghost = UiSettingsOwner::Account(9_000_000_042);
    for svc in [a, b] {
        for if_revision in [None, Some(UI_SETTING_ABSENT_REVISION)] {
            let result = svc.ui_put(&ghost, "cases.ghost", "v", if_revision).await;
            assert!(
                matches!(result, Err(BantoError::Unauthorized)),
                "ifRevision {if_revision:?}: {result:?}"
            );
        }
        let read = svc.ui_get(&ghost, "cases.ghost").await.unwrap();
        assert_eq!(read.value, None);
    }
}

async fn new_account(users: &UsersService, username: &str) -> i64 {
    users
        .create_user(username, "ui-settings-cases-pw", username, Role::Viewer)
        .await
        .unwrap_or_else(|err| panic!("create {username}: {err:?}"))
        .id
}

/// Deleting an account and writing its setting, in both orders, on separate
/// connections: no row is left either way.
async fn account_delete_and_put_in_both_orders(
    a: &SettingsService,
    b: &SettingsService,
    users: &UsersService,
) {
    // The PUT first: the delete takes the row with it.
    let id = new_account(users, "uicaseputfirst").await;
    let owner = UiSettingsOwner::Account(id);
    let written = b.ui_put(&owner, "cases.owned", "v", None).await.unwrap();
    assert_eq!(
        a.ui_get(&owner, "cases.owned").await.unwrap().revision,
        written.revision
    );
    users.delete_user(id, None).await.unwrap();
    for svc in [a, b] {
        assert_eq!(svc.ui_get(&owner, "cases.owned").await.unwrap().value, None);
    }

    // The delete first: a PUT accepted before it cannot create the row.
    for if_revision in [
        None,
        Some(UI_SETTING_ABSENT_REVISION),
        Some(written.revision.as_str()),
    ] {
        let result = b.ui_put(&owner, "cases.owned", "late", if_revision).await;
        assert!(
            matches!(
                result,
                Err(BantoError::Unauthorized | BantoError::Conflict { .. })
            ),
            "ifRevision {if_revision:?}: {result:?}"
        );
        assert_eq!(a.ui_get(&owner, "cases.owned").await.unwrap().value, None);
    }
}

/// The same, raced: whichever commits first, the account's row is gone once
/// both are done, and the PUT is either stored-then-removed or refused.
async fn account_delete_racing_a_put(b: &SettingsService, users: &UsersService) {
    for round in 0..6 {
        let id = new_account(users, &format!("uicaserace{round}")).await;
        let owner = UiSettingsOwner::Account(id);
        // Half the rounds start with a row, half create it in the race.
        if round % 2 == 0 {
            b.ui_put(&owner, "cases.race", "seed", None).await.unwrap();
        }
        let (deleted, put) = tokio::join!(
            users.delete_user(id, None),
            b.ui_put(&owner, "cases.race", "racing", None),
        );
        deleted.unwrap_or_else(|err| panic!("round {round}: delete failed: {err:?}"));
        assert!(
            matches!(put, Ok(_) | Err(BantoError::Unauthorized)),
            "round {round}: {put:?}"
        );
        assert_eq!(
            b.ui_get(&owner, "cases.race").await.unwrap().value,
            None,
            "round {round}: a row outlived its account"
        );
    }
}
