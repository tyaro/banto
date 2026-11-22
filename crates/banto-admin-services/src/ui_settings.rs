//! Per-owner UI settings with conditional writes (Issue #786,
//! downstream-requests-2026-11-plan §4.4, ADR-0034 §8).
//!
//! The values live in the `ui_settings` table (the app's
//! `0014_ui_settings.sql`), not in the generic `settings` key/value table.
//! One row per (owner, key):
//!
//! - **owner** ([`UiSettingsOwner`]): `acct:<users.id>` for an account,
//!   `grant:<kind>` for a grant session, `local` for the desktop's no-login
//!   session. An account's rows also carry `user_id`, and the table's foreign
//!   key (`ON DELETE CASCADE`) ties them to the account: deleting the account
//!   removes them, and a write that arrives after the delete is refused
//!   instead of leaving an orphan. A new account with a reused username has a
//!   new `users.id`, so it never reads the previous account's values.
//! - **revision**: a random string this layer makes on EVERY write
//!   ([`new_revision`]). It is not a counter: after a backup is restored, or a
//!   row is deleted and written again, a counter would come back to a number
//!   an open tab still holds, and that tab's conditional write would silently
//!   overwrite a different value. "No row" is the fixed
//!   [`UI_SETTING_ABSENT_REVISION`] (`"0"`).
//!
//! **The check and the write are ONE statement.** Reading the revision and
//! then writing would let two writers that read the same revision both pass
//! (PostgreSQL's default isolation level does not stop that):
//!
//! - `if_revision` = a revision: `UPDATE ... WHERE owner, key, revision`;
//!   zero rows changed = conflict.
//! - `if_revision` = `"0"`: `INSERT ... ON CONFLICT DO NOTHING`; zero rows
//!   inserted = conflict (the primary key lets one of two inserts in).
//! - no `if_revision`: unconditional upsert, one statement (the last write
//!   wins - what a settings screen wants).
//! - only on a conflict the current row is read afterwards and returned in
//!   [`BantoError::Conflict`]'s `current` as `{ value, revision }`
//!   (`value: null`, `revision: "0"` when it is gone by then).
//!
//! Like every service here this one knows nothing about sessions, RBAC or
//! HTTP (conventions §2): the wiring turns its session into a
//! [`UiSettingsOwner`]. The methods are on [`SettingsService`] so the wiring
//! keeps passing the one handle it already has.

use argon2::password_hash::rand_core::{OsRng, RngCore};
use banto_core::BantoError;
use banto_storage::Db;
use serde::Serialize;

use crate::settings::{validate_ui_key, validate_ui_value, SettingsService};

/// The revision that means "no row" (`GET` of a key that was never written or
/// was deleted; `ifRevision` of a write that must create the row). A stored
/// row never has it ([`new_revision`] makes 32 hex characters).
pub const UI_SETTING_ABSENT_REVISION: &str = "0";

/// Longest `if_revision` accepted. Revisions are 32 characters; anything
/// longer cannot be one, and is refused before it reaches the database.
const MAX_IF_REVISION_LEN: usize = 64;

const CONFLICT_MESSAGE: &str = "この設定は別の画面で変更されています";

/// Whose UI settings a call reads or writes. Built by the wiring from the
/// session it authorized - from the session's VARIANT (account / grant /
/// no-login), never from its name (conventions §10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiSettingsOwner {
    /// An account, by its `users.id`. The row is tied to the account by the
    /// table's foreign key.
    Account(i64),
    /// A grant session, by its kind (ADR-0034 §8): every session of the kind
    /// shares the values. Also for a grant whose audit rows are attributed to
    /// the built-in `admin` - the values are not the `admin`'s.
    Grant(String),
    /// The desktop's no-login session.
    Local,
}

impl UiSettingsOwner {
    /// The `ui_settings.owner` column.
    fn key(&self) -> String {
        match self {
            UiSettingsOwner::Account(id) => format!("acct:{id}"),
            UiSettingsOwner::Grant(kind) => format!("grant:{kind}"),
            UiSettingsOwner::Local => "local".to_string(),
        }
    }

    /// The `ui_settings.user_id` column: the account's id, NULL otherwise
    /// (the table's CHECK keeps it in step with [`UiSettingsOwner::key`]).
    fn user_id(&self) -> Option<i64> {
        match self {
            UiSettingsOwner::Account(id) => Some(*id),
            UiSettingsOwner::Grant(_) | UiSettingsOwner::Local => None,
        }
    }
}

/// A stored UI setting as REST and the desktop commands return it:
/// `{ value, revision }`; `value: null` and `revision: "0"` when there is no
/// row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UiSetting {
    pub value: Option<String>,
    pub revision: String,
}

impl UiSetting {
    fn absent() -> Self {
        Self {
            value: None,
            revision: UI_SETTING_ABSENT_REVISION.to_string(),
        }
    }
}

/// The answer to a write: the row's revision now (`"0"` after a delete).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UiSettingRevision {
    pub revision: String,
}

/// A new revision: 128 bits from the OS random source as 32 lowercase hex
/// characters. Not a secret; it only has to differ from every revision the
/// row had before, across deletes and restores.
fn new_revision() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_if_revision(if_revision: Option<&str>) -> Result<(), BantoError> {
    match if_revision {
        Some(revision) if revision.is_empty() || revision.len() > MAX_IF_REVISION_LEN => {
            Err(BantoError::Validation {
                field_errors: vec![banto_core::FieldError {
                    field: "ifRevision".to_string(),
                    message: format!("ifRevision は1〜{MAX_IF_REVISION_LEN}文字で指定してください"),
                }],
            })
        }
        _ => Ok(()),
    }
}

/// A write for an account that no longer exists is the same refusal as a
/// request without a session, not a storage error (plan §4.4): the delete
/// committed first, so the session behind the write is gone too.
fn write_error(err: sqlx::Error) -> BantoError {
    let foreign_key = err
        .as_database_error()
        .is_some_and(|db| db.is_foreign_key_violation());
    if foreign_key {
        BantoError::Unauthorized
    } else {
        banto_storage::storage_error(err)
    }
}

impl SettingsService {
    /// Read `owner`'s UI setting `key`. No row = `value: None`, revision
    /// [`UI_SETTING_ABSENT_REVISION`].
    pub async fn ui_get(
        &self,
        owner: &UiSettingsOwner,
        key: &str,
    ) -> Result<UiSetting, BantoError> {
        validate_ui_key(key)?;
        self.ui_read(&owner.key(), key).await
    }

    /// Write `owner`'s UI setting `key` and return its new revision.
    ///
    /// `if_revision`: `None` = unconditional; `Some("0")` = only when there is
    /// no row; `Some(revision)` = only when the row still has that revision.
    /// A failed condition is [`BantoError::Conflict`] whose `current` is the
    /// row as it is now (`{ value, revision }`). An account that no longer
    /// exists is [`BantoError::Unauthorized`]. See the module doc for why
    /// each case is a single statement.
    pub async fn ui_put(
        &self,
        owner: &UiSettingsOwner,
        key: &str,
        value: &str,
        if_revision: Option<&str>,
    ) -> Result<UiSettingRevision, BantoError> {
        validate_ui_key(key)?;
        validate_ui_value(value)?;
        validate_if_revision(if_revision)?;
        let db = self.db();
        let dialect = db.dialect();
        let p = |n| dialect.placeholder(n);
        let now = now_sql(db);
        let owner_key = owner.key();
        let user_id = owner.user_id();
        let revision = new_revision();

        let written = match if_revision {
            Some(expected) if expected != UI_SETTING_ABSENT_REVISION => {
                // AssertSqlSafe (here and below): only placeholders and the
                // dialect's fixed "now" expression are interpolated; every
                // value is bound.
                let sql = format!(
                    "UPDATE ui_settings SET value = {}, revision = {}, updated_at = {now} \
                     WHERE owner = {} AND key = {} AND revision = {}",
                    p(1),
                    p(2),
                    p(3),
                    p(4),
                    p(5),
                );
                match db {
                    Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(value)
                        .bind(&revision)
                        .bind(&owner_key)
                        .bind(key)
                        .bind(expected)
                        .execute(pool)
                        .await
                        .map(|done| done.rows_affected()),
                    #[cfg(feature = "postgres")]
                    Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(value)
                        .bind(&revision)
                        .bind(&owner_key)
                        .bind(key)
                        .bind(expected)
                        .execute(pool)
                        .await
                        .map(|done| done.rows_affected()),
                }
            }
            condition => {
                // `Some("0")`: the row must not exist. `None`: last write wins.
                let on_conflict = if condition.is_some() {
                    "DO NOTHING".to_string()
                } else {
                    format!(
                        "DO UPDATE SET value = excluded.value, revision = excluded.revision, \
                         updated_at = {now}"
                    )
                };
                let sql = format!(
                    "INSERT INTO ui_settings (owner, key, value, revision, user_id) \
                     VALUES ({}, {}, {}, {}, {}) ON CONFLICT (owner, key) {on_conflict}",
                    p(1),
                    p(2),
                    p(3),
                    p(4),
                    p(5),
                );
                match db {
                    Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(&owner_key)
                        .bind(key)
                        .bind(value)
                        .bind(&revision)
                        .bind(user_id)
                        .execute(pool)
                        .await
                        .map(|done| done.rows_affected()),
                    #[cfg(feature = "postgres")]
                    Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                        .bind(&owner_key)
                        .bind(key)
                        .bind(value)
                        .bind(&revision)
                        .bind(user_id)
                        .execute(pool)
                        .await
                        .map(|done| done.rows_affected()),
                }
            }
        }
        .map_err(write_error)?;

        if written == 0 {
            return Err(self.ui_conflict(&owner_key, key).await?);
        }
        Ok(UiSettingRevision { revision })
    }

    /// Delete `owner`'s UI setting `key`; a later read answers revision
    /// `"0"`. `if_revision` as for [`SettingsService::ui_put`]: `None`
    /// deletes whatever is there (nothing there is fine too), a revision
    /// deletes only that revision (one statement), `"0"` only asserts that
    /// there is no row. A row written again after the delete has a new
    /// revision, so a revision read before the delete never matches it.
    pub async fn ui_delete(
        &self,
        owner: &UiSettingsOwner,
        key: &str,
        if_revision: Option<&str>,
    ) -> Result<UiSettingRevision, BantoError> {
        validate_ui_key(key)?;
        validate_if_revision(if_revision)?;
        let owner_key = owner.key();
        let absent = UiSettingRevision {
            revision: UI_SETTING_ABSENT_REVISION.to_string(),
        };

        if if_revision == Some(UI_SETTING_ABSENT_REVISION) {
            // Nothing to write: the caller says there is no row. A row that
            // exists is the conflict.
            let current = self.ui_read(&owner_key, key).await?;
            return if current.value.is_none() {
                Ok(absent)
            } else {
                Err(conflict(current))
            };
        }

        let db = self.db();
        let dialect = db.dialect();
        let mut sql = format!(
            "DELETE FROM ui_settings WHERE owner = {} AND key = {}",
            dialect.placeholder(1),
            dialect.placeholder(2),
        );
        if if_revision.is_some() {
            sql.push_str(&format!(" AND revision = {}", dialect.placeholder(3)));
        }
        let deleted = match db {
            Db::Sqlite(pool) => {
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(&owner_key)
                    .bind(key);
                if let Some(expected) = if_revision {
                    query = query.bind(expected);
                }
                query.execute(pool).await.map(|done| done.rows_affected())
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(&owner_key)
                    .bind(key);
                if let Some(expected) = if_revision {
                    query = query.bind(expected);
                }
                query.execute(pool).await.map(|done| done.rows_affected())
            }
        }
        .map_err(banto_storage::storage_error)?;

        if deleted == 0 && if_revision.is_some() {
            return Err(self.ui_conflict(&owner_key, key).await?);
        }
        Ok(absent)
    }

    /// The conflict error of a write whose condition failed, with the row as
    /// it is now (read AFTER the failed statement - only this path reads).
    async fn ui_conflict(&self, owner_key: &str, key: &str) -> Result<BantoError, BantoError> {
        Ok(conflict(self.ui_read(owner_key, key).await?))
    }

    async fn ui_read(&self, owner_key: &str, key: &str) -> Result<UiSetting, BantoError> {
        let db = self.db();
        let dialect = db.dialect();
        let sql = format!(
            "SELECT value, revision FROM ui_settings WHERE owner = {} AND key = {}",
            dialect.placeholder(1),
            dialect.placeholder(2),
        );
        let row: Option<(String, String)> = match db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(owner_key)
                    .bind(key)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(owner_key)
                    .bind(key)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        Ok(match row {
            Some((value, revision)) => UiSetting {
                value: Some(value),
                revision,
            },
            None => UiSetting::absent(),
        })
    }
}

fn conflict(current: UiSetting) -> BantoError {
    BantoError::Conflict {
        message: CONFLICT_MESSAGE.to_string(),
        current: Some(serde_json::json!({
            "value": current.value,
            "revision": current.revision,
        })),
    }
}

/// The `updated_at` expression of each dialect (the column's own default in
/// `0014_ui_settings.sql`).
fn now_sql(db: &Db) -> &'static str {
    match db {
        Db::Sqlite(_) => "datetime('now')",
        #[cfg(feature = "postgres")]
        Db::Postgres(_) => "now()::text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `users` (only what the foreign key needs) and `ui_settings`. The
    /// `ui_settings` DDL MUST be kept in sync with the app's
    /// `migrations-sqlite/0014_ui_settings.sql`; the app's own tests run the
    /// same cases against the real migrations, on separate connections.
    async fn service() -> SettingsService {
        let db = Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite");
        for sql in [
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL)",
            "CREATE TABLE ui_settings (
                owner      TEXT NOT NULL,
                key        TEXT NOT NULL,
                value      TEXT NOT NULL,
                revision   TEXT NOT NULL,
                user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (owner, key),
                CONSTRAINT ui_settings_owner_matches_user CHECK (
                    (user_id IS NULL AND owner NOT LIKE 'acct:%')
                    OR (user_id IS NOT NULL AND owner = 'acct:' || CAST(user_id AS TEXT))
                )
            )",
        ] {
            sqlx::query(sql)
                .execute(db.as_sqlite().expect("sqlite handle"))
                .await
                .expect("create table");
        }
        SettingsService::new(db)
    }

    async fn add_user(svc: &SettingsService, username: &str) -> i64 {
        sqlx::query("INSERT INTO users (username) VALUES (?)")
            .bind(username)
            .execute(svc.db().as_sqlite().unwrap())
            .await
            .unwrap()
            .last_insert_rowid()
    }

    async fn delete_user(svc: &SettingsService, id: i64) {
        sqlx::query("DELETE FROM users WHERE id = ?")
            .bind(id)
            .execute(svc.db().as_sqlite().unwrap())
            .await
            .unwrap();
    }

    async fn row_count(svc: &SettingsService) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM ui_settings")
            .fetch_one(svc.db().as_sqlite().unwrap())
            .await
            .unwrap()
    }

    fn conflict_current(err: BantoError) -> serde_json::Value {
        match err {
            BantoError::Conflict { current, .. } => current.expect("conflict carries the row"),
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_missing_key_reads_as_null_with_revision_zero() {
        let svc = service().await;
        let read = svc.ui_get(&UiSettingsOwner::Local, "theme").await.unwrap();
        assert_eq!(read.value, None);
        assert_eq!(read.revision, "0");
    }

    #[tokio::test]
    async fn an_unconditional_put_overwrites_and_changes_the_revision() {
        let svc = service().await;
        let owner = UiSettingsOwner::Local;
        let first = svc.ui_put(&owner, "theme", "standard", None).await.unwrap();
        let second = svc.ui_put(&owner, "theme", "glass", None).await.unwrap();
        assert_ne!(first.revision, second.revision);
        assert_ne!(second.revision, "0");
        let read = svc.ui_get(&owner, "theme").await.unwrap();
        assert_eq!(read.value.as_deref(), Some("glass"));
        assert_eq!(read.revision, second.revision);
    }

    #[tokio::test]
    async fn owners_do_not_see_each_other() {
        let svc = service().await;
        let alice = UiSettingsOwner::Account(add_user(&svc, "alice").await);
        let bob = UiSettingsOwner::Account(add_user(&svc, "bob").await);
        let grant = UiSettingsOwner::Grant("publicViewer".to_string());
        svc.ui_put(&alice, "theme", "glass", None).await.unwrap();
        svc.ui_put(&bob, "theme", "standard", None).await.unwrap();
        svc.ui_put(&grant, "theme", "kiosk", None).await.unwrap();
        svc.ui_put(&UiSettingsOwner::Local, "theme", "local", None)
            .await
            .unwrap();
        for (owner, expected) in [
            (&alice, "glass"),
            (&bob, "standard"),
            (&grant, "kiosk"),
            (&UiSettingsOwner::Local, "local"),
        ] {
            let read = svc.ui_get(owner, "theme").await.unwrap();
            assert_eq!(read.value.as_deref(), Some(expected));
        }
    }

    #[tokio::test]
    async fn a_conditional_put_passes_once_per_revision() {
        let svc = service().await;
        let owner = UiSettingsOwner::Local;
        let base = svc.ui_put(&owner, "memo", "v1", None).await.unwrap();

        let winner = svc
            .ui_put(&owner, "memo", "v2", Some(&base.revision))
            .await
            .unwrap();
        // The same revision again: the row moved on.
        let current = conflict_current(
            svc.ui_put(&owner, "memo", "v3", Some(&base.revision))
                .await
                .unwrap_err(),
        );
        assert_eq!(
            current,
            serde_json::json!({ "value": "v2", "revision": winner.revision })
        );
        assert_eq!(
            svc.ui_get(&owner, "memo").await.unwrap().value.as_deref(),
            Some("v2")
        );
    }

    #[tokio::test]
    async fn revision_zero_creates_the_row_only_once() {
        let svc = service().await;
        let owner = UiSettingsOwner::Local;
        let created = svc
            .ui_put(&owner, "memo", "first", Some("0"))
            .await
            .unwrap();
        let current = conflict_current(
            svc.ui_put(&owner, "memo", "second", Some("0"))
                .await
                .unwrap_err(),
        );
        assert_eq!(
            current,
            serde_json::json!({ "value": "first", "revision": created.revision })
        );
    }

    #[tokio::test]
    async fn a_conditional_put_on_a_missing_row_conflicts_with_revision_zero() {
        let svc = service().await;
        let current = conflict_current(
            svc.ui_put(&UiSettingsOwner::Local, "memo", "v", Some("abc"))
                .await
                .unwrap_err(),
        );
        assert_eq!(
            current,
            serde_json::json!({ "value": null, "revision": "0" })
        );
        assert_eq!(
            row_count(&svc).await,
            0,
            "a failed condition writes nothing"
        );
    }

    #[tokio::test]
    async fn delete_removes_the_row_and_old_revisions_never_match_a_new_one() {
        let svc = service().await;
        let owner = UiSettingsOwner::Local;
        let before = svc.ui_put(&owner, "memo", "v1", None).await.unwrap();

        let deleted = svc.ui_delete(&owner, "memo", None).await.unwrap();
        assert_eq!(deleted.revision, "0");
        assert_eq!(svc.ui_get(&owner, "memo").await.unwrap().revision, "0");

        // Written again: the revision read before the delete does not pass.
        let recreated = svc.ui_put(&owner, "memo", "v2", Some("0")).await.unwrap();
        assert_ne!(recreated.revision, before.revision);
        let current = conflict_current(
            svc.ui_put(&owner, "memo", "stale", Some(&before.revision))
                .await
                .unwrap_err(),
        );
        assert_eq!(
            current,
            serde_json::json!({ "value": "v2", "revision": recreated.revision })
        );
        let current = conflict_current(
            svc.ui_delete(&owner, "memo", Some(&before.revision))
                .await
                .unwrap_err(),
        );
        assert_eq!(current["value"], "v2");
        assert_eq!(row_count(&svc).await, 1);
    }

    #[tokio::test]
    async fn a_conditional_delete_checks_the_revision() {
        let svc = service().await;
        let owner = UiSettingsOwner::Local;
        let first = svc.ui_put(&owner, "memo", "v1", None).await.unwrap();
        let second = svc.ui_put(&owner, "memo", "v2", None).await.unwrap();

        assert!(matches!(
            svc.ui_delete(&owner, "memo", Some(&first.revision)).await,
            Err(BantoError::Conflict { .. })
        ));
        // "0" = "there is no row": a row that exists is the conflict.
        let current = conflict_current(svc.ui_delete(&owner, "memo", Some("0")).await.unwrap_err());
        assert_eq!(current["revision"], second.revision.as_str());

        svc.ui_delete(&owner, "memo", Some(&second.revision))
            .await
            .unwrap();
        assert_eq!(row_count(&svc).await, 0);
        // Nothing there: unconditional and "0" both succeed, a revision conflicts.
        svc.ui_delete(&owner, "memo", None).await.unwrap();
        svc.ui_delete(&owner, "memo", Some("0")).await.unwrap();
        let current = conflict_current(
            svc.ui_delete(&owner, "memo", Some(&second.revision))
                .await
                .unwrap_err(),
        );
        assert_eq!(
            current,
            serde_json::json!({ "value": null, "revision": "0" })
        );
    }

    #[tokio::test]
    async fn an_account_that_does_not_exist_cannot_own_a_row() {
        let svc = service().await;
        let ghost = UiSettingsOwner::Account(4242);
        for if_revision in [None, Some("0")] {
            let err = svc
                .ui_put(&ghost, "theme", "glass", if_revision)
                .await
                .unwrap_err();
            assert!(
                matches!(err, BantoError::Unauthorized),
                "expected Unauthorized, got {err:?}"
            );
        }
        assert_eq!(row_count(&svc).await, 0);
    }

    #[tokio::test]
    async fn deleting_the_account_removes_its_rows_in_either_order() {
        let svc = service().await;
        // PUT, then the delete: the cascade removes the row.
        let id = add_user(&svc, "alice").await;
        let owner = UiSettingsOwner::Account(id);
        let written = svc.ui_put(&owner, "theme", "glass", None).await.unwrap();
        delete_user(&svc, id).await;
        assert_eq!(row_count(&svc).await, 0);

        // The delete, then a PUT that was accepted before it: refused, in
        // every form, and nothing is left behind.
        for if_revision in [None, Some("0"), Some(written.revision.as_str())] {
            let result = svc.ui_put(&owner, "theme", "late", if_revision).await;
            assert!(
                matches!(
                    result,
                    Err(BantoError::Unauthorized | BantoError::Conflict { .. })
                ),
                "ifRevision {if_revision:?}: got {result:?}"
            );
        }
        assert_eq!(row_count(&svc).await, 0);
    }

    /// The regression the previous storage (`ui.{username}.{key}`) had: a new
    /// account with the SAME username read the deleted account's values.
    #[tokio::test]
    async fn a_recreated_account_with_the_same_name_reads_nothing_of_the_old_one() {
        let svc = service().await;
        let old = add_user(&svc, "alice").await;
        svc.ui_put(
            &UiSettingsOwner::Account(old),
            "dock.dashboard",
            "old",
            None,
        )
        .await
        .unwrap();
        delete_user(&svc, old).await;

        let new = add_user(&svc, "alice").await;
        assert_ne!(new, old, "users.id is not reused (AUTOINCREMENT)");
        let read = svc
            .ui_get(&UiSettingsOwner::Account(new), "dock.dashboard")
            .await
            .unwrap();
        assert_eq!(read, UiSetting::absent());
    }

    #[tokio::test]
    async fn keys_values_and_if_revision_are_validated() {
        let svc = service().await;
        let owner = UiSettingsOwner::Local;
        let field = |err: BantoError| match err {
            BantoError::Validation { field_errors } => field_errors[0].field.clone(),
            other => panic!("expected Validation, got {other:?}"),
        };
        assert_eq!(
            field(svc.ui_get(&owner, "not a key!").await.unwrap_err()),
            "key"
        );
        assert_eq!(
            field(svc.ui_put(&owner, "a/b", "v", None).await.unwrap_err()),
            "key"
        );
        assert_eq!(
            field(svc.ui_delete(&owner, "a/b", None).await.unwrap_err()),
            "key"
        );
        let too_big = "x".repeat(64 * 1024 + 1);
        assert_eq!(
            field(
                svc.ui_put(&owner, "dock", &too_big, None)
                    .await
                    .unwrap_err()
            ),
            "value"
        );
        let at_max = "x".repeat(64 * 1024);
        svc.ui_put(&owner, "dock", &at_max, None).await.unwrap();
        for bad in ["", &"r".repeat(65)] {
            assert_eq!(
                field(
                    svc.ui_put(&owner, "dock", "v", Some(bad))
                        .await
                        .unwrap_err()
                ),
                "ifRevision"
            );
            assert_eq!(
                field(svc.ui_delete(&owner, "dock", Some(bad)).await.unwrap_err()),
                "ifRevision"
            );
        }
    }

    #[test]
    fn a_revision_is_never_the_absent_one() {
        let a = new_revision();
        let b = new_revision();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_ne!(a, UI_SETTING_ABSENT_REVISION);
    }
}
