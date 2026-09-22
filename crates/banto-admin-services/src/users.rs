//! Local credential store (spec §8.2): a `users` table in the app's SQLite
//! settings DB, with argon2id password hashes. Replaces the fixed
//! admin/admin demo credential check that used to live on `AppState` in
//! `src-tauri` (see that crate's former TODO).
//!
//! Moved from `admin-template-core::users` to this crate in theme C PR-C2
//! (docs/template-scope.md §7 移行順 ②): `UsersService` is domain-agnostic
//! (identical for any app regardless of which resources it has) and is the
//! RBAC-central service, so it belongs in the shared crate rather than in
//! code every adopter copies. `admin-template-core` re-exports it (`lib.rs`)
//! so existing `admin_template_core::users::*` paths keep resolving unchanged:
//! the location changed, not the REST/Tauri exposure (conventions §1
//! 両経路対称は不変).
//!
//! Design note (spec §8.2 mentions `keyring` for credentials): keyring is a
//! *client-side, single-user* OS credential store, which does not fit a
//! multi-user LAN-server app where any device on the network - not just the
//! machine running the desktop app - needs to authenticate against the same
//! account database. Argon2id hashes stored in the same SQLite settings DB
//! the rest of the app already uses cover both the desktop-only case and the
//! LAN-server case with one mechanism. `keyring` remains a good option later
//! for CLIENT-side bearer-token storage (i.e. the LAN browser/desktop
//! caching its *own* login token more securely than `sessionStorage`), which
//! is an orthogonal concern from where the account database itself lives.

use std::str::FromStr;
use std::sync::OnceLock;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use banto_core::{BantoError, FieldError};
use banto_storage::Db;
use serde::Serialize;

const MIN_USERNAME_LEN: usize = 1;
const MAX_USERNAME_LEN: usize = 32;
const MIN_PASSWORD_LEN: usize = 8;

/// Account role (spec M10 RBAC): re-exported from [`crate::rbac`], where the
/// definition lives. `Role` moved to this crate ahead of `users` in theme C
/// PR-C1 (docs/template-scope.md §7 移行順 ①, because `SettingsService`'s
/// `AuthSettings.disabled_role` needed it); PR-C2 (移行順 ②) brought `users`
/// into the same crate, and `Role` was deliberately left in [`crate::rbac`]
/// rather than folded back in here - the type has no `users`-specific
/// dependency and both settings and users use it, so keeping it in one shared
/// module (re-exported from both call sites) is the minimal-churn placement.
/// This re-export keeps `banto_admin_services::users::Role` (hence
/// `admin_template_core::users::Role`, via the app's re-export) resolving
/// unchanged for the REST role-guard middleware and the Tauri `require_role`
/// call sites. See [`crate::rbac`] for the definition and its unit tests.
pub use crate::rbac::Role;

fn password_too_short_message() -> String {
    "パスワードは8文字以上で入力してください".to_string()
}

fn hash_password(password: &str) -> Result<String, BantoError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| BantoError::Other(format!("パスワードのハッシュ化に失敗しました: {err}")))
}

fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// A valid argon2id PHC hash of an arbitrary fixed password, computed once
/// per process. Used only as the comparison target for the dummy verify in
/// `UsersService::verify` below, so an unknown username still "pays" the
/// argon2 cost before returning `None` - see that method's doc comment.
fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        hash_password("banto-dummy-verify-target-password")
            .expect("hashing a fixed password should never fail")
    })
}

fn validate_password_len(password: &str, field: &str) -> Result<(), BantoError> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: field.to_string(),
                message: password_too_short_message(),
            }],
        });
    }
    Ok(())
}

fn validate_username(username: &str) -> Result<String, BantoError> {
    let trimmed = username.trim();
    let len = trimmed.chars().count();
    if !(MIN_USERNAME_LEN..=MAX_USERNAME_LEN).contains(&len) {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "username".to_string(),
                message: format!("{MIN_USERNAME_LEN}〜{MAX_USERNAME_LEN}文字で入力してください"),
            }],
        });
    }
    Ok(trimmed.to_string())
}

/// Identity of a verified/created user. Spec §3.3's wire `Identity` carries
/// only `id`/`name`; this carries the full row needed by the REST/Tauri
/// command layers (e.g. `username`, to look the account back up for
/// `change_password`).
#[derive(Debug, Clone, PartialEq)]
pub struct UserIdentity {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: Role,
}

/// Public listing of an account (spec M10's user-management screen):
/// everything the admin grid needs, deliberately NOT `password_hash`. Unlike
/// [`UserIdentity`] this derives `Serialize` since it is returned directly
/// over the wire (REST JSON body / Tauri command return value) rather than
/// only used internally.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: Role,
    pub created_at: String,
}

/// Local credential store (spec §8.2): argon2id password hashes in the
/// `users` table (migration `0003_users.sql`). No seed user - the app starts
/// "uninitialized" and the first run walks through `setup_first_user`.
///
/// `Clone` is cheap (`Db` is an `Arc`-backed connection handle), matching
/// `ItemsService`/`SettingsService`.
#[derive(Clone)]
pub struct UsersService {
    db: Db,
}

// Issue #207 / roadmap M10: the last-admin predicate and its write must
// share a database lock, including across independently constructed pools.
// SQLx owns the transaction so errors and cancellation roll it back. The
// body is expanded for each concrete backend without a generic SQL layer.
macro_rules! with_users_write_transaction {
    ($db:expr, |$tx:ident| $body:block) => {{
        match $db {
            Db::Sqlite(pool) => {
                // Reserve the writer BEFORE reading; a deferred transaction
                // could read a snapshot that another writer invalidates.
                let mut $tx = pool
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .map_err(banto_storage::storage_error)?;
                let result = $body;
                $tx.commit().await.map_err(banto_storage::storage_error)?;
                result
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut $tx = pool
                    .begin_with("BEGIN ISOLATION LEVEL READ COMMITTED")
                    .await
                    .map_err(banto_storage::storage_error)?;
                // Lock before reading either role or count. This conflicts
                // with other user writes but allows ordinary readers. An
                // explicit isolation level keeps a pool's repeatable-read
                // default from pinning a snapshot before a lock wait ends.
                sqlx::query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
                    .execute(&mut *$tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
                let result = $body;
                $tx.commit().await.map_err(banto_storage::storage_error)?;
                result
            }
        }
    }};
}

/// Validate the locked snapshot (spec M10's last-admin condition). An
/// update to admin cannot remove an admin; a delete always potentially can.
fn ensure_admin_removal_allowed(
    id: i64,
    state: Option<(String, i64)>,
    removes_admin: bool,
) -> Result<(), BantoError> {
    let Some((role, admin_count)) = state else {
        return Err(BantoError::NotFound {
            resource: "users".to_string(),
            id: id.to_string(),
        });
    };
    if Role::from_str(&role)?.is_admin() && removes_admin && admin_count <= 1 {
        return Err(BantoError::Other(
            "最後の管理者を降格・削除することはできません".to_string(),
        ));
    }
    Ok(())
}

impl UsersService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Has *any* account been created yet? Used by the login page (spec
    /// §3.3/§8.2) to decide between the first-run setup form and the normal
    /// login form.
    pub async fn is_initialized(&self) -> Result<bool, BantoError> {
        const SQL: &str = "SELECT COUNT(*) FROM users";
        let count: i64 = match &self.db {
            Db::Sqlite(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
        }
        .map_err(banto_storage::storage_error)?;
        Ok(count > 0)
    }

    /// Create the very first account. Only succeeds while the `users` table
    /// is empty - once any account exists, this always fails with
    /// `BantoError::Other`, regardless of the requested username (spec:
    /// "first run is uninitialized", not "create if missing").
    pub async fn setup_first_user(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
    ) -> Result<UserIdentity, BantoError> {
        if self.is_initialized().await? {
            return Err(BantoError::Other("既に初期化されています".to_string()));
        }

        let username = validate_username(username)?;
        validate_password_len(password, "password")?;
        let display_name = display_name.trim();
        let hash = hash_password(password)?;

        // The very first account is always `admin` (spec M10): there is no
        // one else yet to have assigned it a lesser role, and the app needs
        // at least one admin to exist to manage everyone else.
        let dialect = self.db.dialect();
        // AssertSqlSafe (here and throughout this file): the only
        // interpolated fragments in these `format!`-built statements are
        // `dialect.placeholder(n)`/`dialect.now_expr()` (internally
        // generated from the `Dialect` enum, never caller input) and,
        // occasionally, a hardcoded literal like `'admin'`. Every actual
        // value - username, password hash, display name, role, id - is
        // always passed via `.bind(...)`, never interpolated into the SQL
        // text.
        let sql = format!(
            "INSERT INTO users (username, password_hash, display_name, role) VALUES ({}, {}, {}, {}) \
             RETURNING id",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.placeholder(4),
        );
        let id: i64 = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(&username)
                    .bind(&hash)
                    .bind(display_name)
                    .bind(Role::Admin.as_str())
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(&username)
                    .bind(&hash)
                    .bind(display_name)
                    .bind(Role::Admin.as_str())
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;

        Ok(UserIdentity {
            id,
            username,
            display_name: display_name.to_string(),
            role: Role::Admin,
        })
    }

    /// Verify a username/password pair. `Ok(None)` (rather than an error)
    /// covers both "no such user" and "wrong password" - the caller must not
    /// distinguish the two (standard login-form hygiene: do not tell an
    /// attacker which part was wrong).
    ///
    /// Timing note: on an unknown username we still run a dummy argon2
    /// verify against a fixed hash before returning `None`, so "unknown
    /// user" and "wrong password" take roughly the same amount of time -
    /// a best-effort mitigation (argon2's cost dominates either way), not a
    /// constant-time guarantee.
    pub async fn verify(
        &self,
        username: &str,
        password: &str,
    ) -> Result<Option<UserIdentity>, BantoError> {
        // AssertSqlSafe: see the note in `setup_first_user` above.
        let sql = format!(
            "SELECT id, password_hash, display_name, role FROM users WHERE username = {}",
            self.db.dialect().placeholder(1)
        );
        let row: Option<(i64, String, String, String)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(username)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(username)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;

        match row {
            Some((id, hash, display_name, role)) => {
                if verify_password(password, &hash) {
                    Ok(Some(UserIdentity {
                        id,
                        username: username.to_string(),
                        display_name,
                        role: Role::from_str(&role)?,
                    }))
                } else {
                    Ok(None)
                }
            }
            None => {
                let _ = verify_password(password, dummy_hash());
                Ok(None)
            }
        }
    }

    /// Verify `current`, then update the account's password to `new`
    /// (validated the same way as `setup_first_user`'s password, but with
    /// field name `newPassword` so the Tauri/REST layers can map the error
    /// straight onto the change-password form's second input).
    pub async fn change_password(
        &self,
        username: &str,
        current: &str,
        new: &str,
    ) -> Result<(), BantoError> {
        // AssertSqlSafe: see the note in `setup_first_user` above.
        let select_sql = format!(
            "SELECT id, password_hash FROM users WHERE username = {}",
            self.db.dialect().placeholder(1)
        );
        let row: Option<(i64, String)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(select_sql))
                    .bind(username)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(select_sql))
                    .bind(username)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;

        let wrong_current = || BantoError::Validation {
            field_errors: vec![FieldError {
                field: "currentPassword".to_string(),
                message: "現在のパスワードが違います".to_string(),
            }],
        };

        let Some((id, hash)) = row else {
            // Same dummy-verify timing note as `verify()` above.
            let _ = verify_password(current, dummy_hash());
            return Err(wrong_current());
        };

        if !verify_password(current, &hash) {
            return Err(wrong_current());
        }

        validate_password_len(new, "newPassword")?;
        let new_hash = hash_password(new)?;

        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `setup_first_user` above.
        let update_sql = format!(
            "UPDATE users SET password_hash = {}, updated_at = {} WHERE id = {}",
            dialect.placeholder(1),
            dialect.now_expr(),
            dialect.placeholder(2),
        );
        match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(update_sql))
                .bind(&new_hash)
                .bind(id)
                .execute(pool)
                .await
                .map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(update_sql))
                .bind(&new_hash)
                .bind(id)
                .execute(pool)
                .await
                .map(|_| ()),
        }
        .map_err(banto_storage::storage_error)?;

        Ok(())
    }

    // --- M10: user management (admin-only CRUD + RBAC) -------------------

    /// All accounts, for the admin user-management grid (spec M10).
    /// `password_hash` deliberately never leaves this module - see
    /// [`UserSummary`].
    pub async fn list_users(&self) -> Result<Vec<UserSummary>, BantoError> {
        const SQL: &str =
            "SELECT id, username, display_name, role, created_at FROM users ORDER BY id";
        let rows: Vec<(i64, String, String, String, String)> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
        }
        .map_err(banto_storage::storage_error)?;

        rows.into_iter()
            .map(|(id, username, display_name, role, created_at)| {
                Ok(UserSummary {
                    id,
                    username,
                    display_name,
                    role: Role::from_str(&role)?,
                    created_at,
                })
            })
            .collect()
    }

    /// Look up an account's full identity by username, without verifying a
    /// password. Used by the REST layer to recover the acting caller's
    /// numeric row id (needed by [`UsersService::delete_user`]'s
    /// self-deletion guard) from a bearer token's `Identity.id`, which
    /// carries the *username* (spec convention, see
    /// `banto_server::auth::Identity`'s doc comment), not the row id.
    pub async fn get_by_username(
        &self,
        username: &str,
    ) -> Result<Option<UserIdentity>, BantoError> {
        // AssertSqlSafe: see the note in `setup_first_user` above.
        let sql = format!(
            "SELECT id, display_name, role FROM users WHERE username = {}",
            self.db.dialect().placeholder(1)
        );
        let row: Option<(i64, String, String)> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(username)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(username)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;

        match row {
            Some((id, display_name, role)) => Ok(Some(UserIdentity {
                id,
                username: username.to_string(),
                display_name,
                role: Role::from_str(&role)?,
            })),
            None => Ok(None),
        }
    }

    /// Create an additional account (spec M10; distinct from
    /// [`UsersService::setup_first_user`], which only ever runs once and
    /// always assigns `admin`). Validates the same way `setup_first_user`
    /// does, plus a friendly `BantoError::Validation` on a duplicate
    /// username (rather than surfacing the raw UNIQUE-constraint storage
    /// error to the admin form).
    pub async fn create_user(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
        role: Role,
    ) -> Result<UserIdentity, BantoError> {
        let username = validate_username(username)?;
        validate_password_len(password, "password")?;
        let display_name = display_name.trim();

        // AssertSqlSafe: see the note in `setup_first_user` above.
        let exists_sql = format!(
            "SELECT id FROM users WHERE username = {}",
            self.db.dialect().placeholder(1)
        );
        let existing: Option<i64> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(exists_sql))
                    .bind(&username)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(exists_sql))
                    .bind(&username)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        if existing.is_some() {
            return Err(BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "username".to_string(),
                    message: "このユーザー名は既に使用されています".to_string(),
                }],
            });
        }

        let hash = hash_password(password)?;
        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `setup_first_user` above.
        let insert_sql = format!(
            "INSERT INTO users (username, password_hash, display_name, role) VALUES ({}, {}, {}, {}) \
             RETURNING id",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.placeholder(4),
        );
        let id: i64 = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(insert_sql))
                    .bind(&username)
                    .bind(&hash)
                    .bind(display_name)
                    .bind(role.as_str())
                    .fetch_one(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(insert_sql))
                    .bind(&username)
                    .bind(&hash)
                    .bind(display_name)
                    .bind(role.as_str())
                    .fetch_one(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;

        Ok(UserIdentity {
            id,
            username,
            display_name: display_name.to_string(),
            role,
        })
    }

    /// Update an account's `display_name`/`role` (spec M10; password
    /// changes go through [`UsersService::change_password`] (self-service)
    /// or [`UsersService::reset_password`] (admin) instead). Refuses to
    /// demote the last `admin` account.
    pub async fn update_user(
        &self,
        id: i64,
        display_name: &str,
        role: Role,
    ) -> Result<UserSummary, BantoError> {
        let display_name = display_name.trim();

        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `setup_first_user` above.
        let sql = format!(
            "UPDATE users SET display_name = {}, role = {}, updated_at = {} WHERE id = {} \
             RETURNING id, username, display_name, role, created_at",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.now_expr(),
            dialect.placeholder(3),
        );
        let guard_sql = format!(
            "SELECT role, (SELECT COUNT(*) FROM users WHERE role = 'admin') \
             FROM users WHERE id = {}",
            dialect.placeholder(1),
        );
        let row: Option<(i64, String, String, String, String)> =
            with_users_write_transaction!(&self.db, |tx| {
                let state: Option<(String, i64)> =
                    sqlx::query_as(sqlx::AssertSqlSafe(guard_sql))
                        .bind(id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                ensure_admin_removal_allowed(id, state, !role.is_admin())?;
                sqlx::query_as(sqlx::AssertSqlSafe(sql))
                    .bind(display_name)
                    .bind(role.as_str())
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?
            });

        let Some((row_id, username, display_name, role_str, created_at)) = row else {
            return Err(BantoError::NotFound {
                resource: "users".to_string(),
                id: id.to_string(),
            });
        };

        Ok(UserSummary {
            id: row_id,
            username,
            display_name,
            role: Role::from_str(&role_str)?,
            created_at,
        })
    }

    /// Admin-initiated password reset (spec M10): unlike
    /// [`UsersService::change_password`], does not require the account's
    /// current password - this is an administrative action on someone
    /// else's account, not self-service.
    pub async fn reset_password(&self, id: i64, new_password: &str) -> Result<(), BantoError> {
        validate_password_len(new_password, "newPassword")?;
        let hash = hash_password(new_password)?;

        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note in `setup_first_user` above.
        let sql = format!(
            "UPDATE users SET password_hash = {}, updated_at = {} WHERE id = {}",
            dialect.placeholder(1),
            dialect.now_expr(),
            dialect.placeholder(2),
        );
        let rows_affected = match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&hash)
                .bind(id)
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&hash)
                .bind(id)
                .execute(pool)
                .await
                .map(|r| r.rows_affected()),
        }
        .map_err(banto_storage::storage_error)?;

        if rows_affected == 0 {
            return Err(BantoError::NotFound {
                resource: "users".to_string(),
                id: id.to_string(),
            });
        }
        Ok(())
    }

    /// Delete account `id` (spec M10). Refuses two cases with a
    /// `BantoError`, both guards the M10 completion criteria call out
    /// explicitly: deleting the last `admin`, and an account deleting
    /// itself (`acting_user_id`, the caller's own numeric row id, is
    /// resolved by the REST/Tauri layer before calling this - see
    /// [`UsersService::get_by_username`] for the REST side, which only has
    /// the caller's username from the session token).
    pub async fn delete_user(&self, id: i64, acting_user_id: i64) -> Result<(), BantoError> {
        if id == acting_user_id {
            return Err(BantoError::Other(
                "自分自身を削除することはできません".to_string(),
            ));
        }

        // AssertSqlSafe: see the note in `setup_first_user` above.
        let sql = format!(
            "DELETE FROM users WHERE id = {}",
            self.db.dialect().placeholder(1)
        );
        let guard_sql = format!(
            "SELECT role, (SELECT COUNT(*) FROM users WHERE role = 'admin') \
             FROM users WHERE id = {}",
            self.db.dialect().placeholder(1),
        );
        let rows_affected = with_users_write_transaction!(&self.db, |tx| {
            let state: Option<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(guard_sql))
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?;
            ensure_admin_removal_allowed(id, state, true)?;
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?
                .rows_affected()
        });
        if rows_affected == 0 {
            return Err(BantoError::NotFound {
                resource: "users".to_string(),
                id: id.to_string(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An in-memory SQLite handle with the `users` table (including the M10
    /// `role` column) created inline. This crate owns no migrations
    /// (conventions §11: table definitions belong to the app); the DDL below
    /// MUST be kept in sync with the app's `0003_users.sql` +
    /// `0004_user_roles.sql` (the `role` column that `0004` adds is folded
    /// into the `CREATE TABLE` here). Same pattern `settings`/`audit` use to
    /// avoid a backwards dependency on the app crate's `db::migrate_memory`
    /// (conventions §"逆依存禁止").
    async fn service() -> UsersService {
        let db = Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite");
        sqlx::query(
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer'))
            )",
        )
        .execute(
            db.as_sqlite()
                .expect("service tests run on a SQLite handle"),
        )
        .await
        .expect("create users table");
        UsersService::new(db)
    }

    #[tokio::test]
    async fn is_initialized_is_false_on_a_fresh_db() {
        let svc = service().await;
        assert!(!svc.is_initialized().await.unwrap());
    }

    #[tokio::test]
    async fn setup_first_user_then_verify_round_trips() {
        let svc = service().await;
        let created = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .expect("setup should succeed");
        assert_eq!(created.username, "owner");
        assert_eq!(created.display_name, "オーナー");

        assert!(svc.is_initialized().await.unwrap());

        let identity = svc
            .verify("owner", "password123")
            .await
            .unwrap()
            .expect("verify should succeed with the right password");
        assert_eq!(identity.username, "owner");
    }

    #[tokio::test]
    async fn verify_wrong_password_is_none() {
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        assert!(svc
            .verify("owner", "wrong-password")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn verify_unknown_user_is_none() {
        let svc = service().await;
        assert!(svc.verify("nobody", "whatever1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn setup_first_user_can_only_run_once() {
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let err = svc
            .setup_first_user("someone-else", "password123", "誰か")
            .await
            .unwrap_err();
        match err {
            BantoError::Other(message) => assert_eq!(message, "既に初期化されています"),
            other => panic!("expected Other, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn setup_first_user_rejects_short_password() {
        let svc = service().await;
        let err = svc
            .setup_first_user("owner", "short", "オーナー")
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "password");
                assert_eq!(
                    field_errors[0].message,
                    "パスワードは8文字以上で入力してください"
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn setup_first_user_rejects_blank_username() {
        let svc = service().await;
        let err = svc
            .setup_first_user("   ", "password123", "オーナー")
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
    }

    #[tokio::test]
    async fn duplicate_username_on_a_future_create_path_is_a_storage_error() {
        // `setup_first_user` itself can only ever run once (see the test
        // above); this exercises the UNIQUE constraint directly, standing in
        // for any future "add another user" path that would otherwise hit
        // the same constraint.
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let hash = hash_password("password123").unwrap();
        let pool = svc
            .db
            .as_sqlite()
            .expect("service tests run on a SQLite handle");
        let err = sqlx::query(
            "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)",
        )
        .bind("owner")
        .bind(&hash)
        .bind("Duplicate")
        .execute(pool)
        .await
        .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("unique"));
    }

    #[tokio::test]
    async fn change_password_happy_path() {
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        svc.change_password("owner", "password123", "newpassword1")
            .await
            .expect("change_password should succeed");

        assert!(svc.verify("owner", "password123").await.unwrap().is_none());
        assert!(svc.verify("owner", "newpassword1").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn change_password_rejects_wrong_current_password() {
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let err = svc
            .change_password("owner", "not-the-password", "newpassword1")
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "currentPassword");
                assert_eq!(field_errors[0].message, "現在のパスワードが違います");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn change_password_rejects_short_new_password() {
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let err = svc
            .change_password("owner", "password123", "short")
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "newPassword");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn hash_then_verify_round_trips() {
        let hash = hash_password("hunter2hunter").unwrap();
        assert!(verify_password("hunter2hunter", &hash));
        assert!(!verify_password("wrong", &hash));
    }

    // --- Role: unit tests live in `crate::rbac` alongside the `Role`
    //     definition (theme C PR-C1). -----------------------------------------

    // --- M10 user management CRUD -----------------------------------------

    #[tokio::test]
    async fn setup_first_user_is_always_admin() {
        let svc = service().await;
        let created = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        assert_eq!(created.role, Role::Admin);

        let identity = svc
            .verify("owner", "password123")
            .await
            .unwrap()
            .expect("verify should succeed");
        assert_eq!(identity.role, Role::Admin);
    }

    #[tokio::test]
    async fn create_list_update_reset_password_and_delete_round_trip() {
        let svc = service().await;
        let owner = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();

        let created = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .expect("create_user should succeed");
        assert_eq!(created.role, Role::Editor);

        let listed = svc.list_users().await.unwrap();
        assert_eq!(listed.len(), 2);
        let listed_editor = listed
            .iter()
            .find(|u| u.username == "editor1")
            .expect("editor1 should be listed");
        assert_eq!(listed_editor.role, Role::Editor);
        assert_eq!(listed_editor.display_name, "編集者1");

        let updated = svc
            .update_user(created.id, "編集者1改", Role::Viewer)
            .await
            .expect("update_user should succeed");
        assert_eq!(updated.display_name, "編集者1改");
        assert_eq!(updated.role, Role::Viewer);

        svc.reset_password(created.id, "resetpassword1")
            .await
            .expect("reset_password should succeed");
        assert!(svc
            .verify("editor1", "password123")
            .await
            .unwrap()
            .is_none());
        assert!(svc
            .verify("editor1", "resetpassword1")
            .await
            .unwrap()
            .is_some());

        svc.delete_user(created.id, owner.id)
            .await
            .expect("delete_user should succeed");
        assert_eq!(svc.list_users().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_user_rejects_duplicate_username() {
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let err = svc
            .create_user("owner", "password123", "別オーナー", Role::Editor)
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "username");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn update_user_rejects_demoting_the_last_admin() {
        let svc = service().await;
        let owner = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();

        let err = svc
            .update_user(owner.id, "オーナー", Role::Editor)
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Other(_)));

        // Once a second admin exists, the first can be demoted.
        svc.create_user("owner2", "password123", "オーナー2", Role::Admin)
            .await
            .unwrap();
        let demoted = svc
            .update_user(owner.id, "オーナー", Role::Editor)
            .await
            .expect("demotion should succeed once another admin exists");
        assert_eq!(demoted.role, Role::Editor);
    }

    #[tokio::test]
    async fn update_user_allows_demoting_a_non_last_admin() {
        let svc = service().await;
        let owner = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        svc.create_user("owner2", "password123", "オーナー2", Role::Admin)
            .await
            .unwrap();

        let demoted = svc
            .update_user(owner.id, "オーナー", Role::Viewer)
            .await
            .expect("demoting one of two admins should succeed");
        assert_eq!(demoted.role, Role::Viewer);
    }

    #[tokio::test]
    async fn delete_user_rejects_deleting_the_last_admin() {
        let svc = service().await;
        let owner = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();

        // `editor1` deletes `owner` (the only admin) - must be rejected.
        let err = svc.delete_user(owner.id, editor.id).await.unwrap_err();
        assert!(matches!(err, BantoError::Other(_)));
        assert_eq!(svc.list_users().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn delete_user_rejects_self_deletion() {
        let svc = service().await;
        let owner = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        svc.create_user("owner2", "password123", "オーナー2", Role::Admin)
            .await
            .unwrap();

        // Even though a second admin exists, `owner` may not delete itself.
        let err = svc.delete_user(owner.id, owner.id).await.unwrap_err();
        assert!(matches!(err, BantoError::Other(_)));
        assert_eq!(svc.list_users().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn delete_user_missing_id_is_not_found() {
        let svc = service().await;
        let owner = svc
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let err = svc.delete_user(999, owner.id).await.unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "users" && id == "999")
        );
    }

    #[tokio::test]
    async fn get_by_username_finds_and_misses() {
        let svc = service().await;
        svc.setup_first_user("owner", "password123", "オーナー")
            .await
            .unwrap();
        let found = svc
            .get_by_username("owner")
            .await
            .unwrap()
            .expect("owner should be found");
        assert_eq!(found.role, Role::Admin);
        assert!(svc.get_by_username("nobody").await.unwrap().is_none());
    }

    // Issue #207 / roadmap M10: two independent service pools must serialize
    // the last-admin check with the write, including mixed update/delete calls.
    async fn concurrent_admin_removals(delete_first: bool, delete_second: bool) {
        use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("users.sqlite3"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let first_pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options.clone())
            .await
            .unwrap();
        let second_pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        // Same app-owned schema as service(); no hashing is needed because
        // these fixtures exercise management operations, never authentication.
        sqlx::query(
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer'))
            )",
        )
        .execute(&first_pool)
        .await
        .unwrap();
        let first = UsersService::new(Db::Sqlite(first_pool.clone()));
        let second = UsersService::new(Db::Sqlite(second_pool.clone()));

        for _ in 0..3 {
            sqlx::query("DELETE FROM users")
                .execute(&first_pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO users (id, username, password_hash, display_name, role) VALUES
                 (1, 'owner1', 'unused', 'Original 1', 'admin'),
                 (2, 'owner2', 'unused', 'Original 2', 'admin')",
            )
            .execute(&first_pool)
            .await
            .unwrap();
            let before = first.list_users().await.unwrap();
            let barrier = tokio::sync::Barrier::new(2);
            async fn mutate(
                svc: &UsersService,
                barrier: &tokio::sync::Barrier,
                id: i64,
                delete: bool,
            ) -> Result<(), BantoError> {
                barrier.wait().await;
                if delete {
                    svc.delete_user(id, 3 - id).await
                } else {
                    svc.update_user(id, "Changed", Role::Viewer)
                        .await
                        .map(|_| ())
                }
            }
            let (a, b) = tokio::time::timeout(Duration::from_secs(15), async {
                tokio::join!(
                    mutate(&first, &barrier, 1, delete_first),
                    mutate(&second, &barrier, 2, delete_second)
                )
            })
            .await
            .expect("concurrent operations must finish without leaked locks");
            assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
            let (refused_id, error) = if let Err(error) = a {
                (1, error)
            } else {
                (2, b.unwrap_err())
            };
            match error {
                BantoError::Other(message) => {
                    assert_eq!(message, "最後の管理者を降格・削除することはできません");
                }
                other => panic!("expected last-admin refusal, got {other:?}"),
            }
            let after = first.list_users().await.unwrap();
            assert_eq!(after.iter().filter(|user| user.role.is_admin()).count(), 1);
            assert_eq!(
                after.iter().find(|user| user.id == refused_id),
                before.iter().find(|user| user.id == refused_id),
                "a refused operation must leave the entire public row unchanged"
            );
            // Reusing the connection after the refusal also verifies rollback
            // releases its transaction lock rather than leaking it into the pool.
            tokio::time::timeout(
                Duration::from_secs(5),
                second.update_user(refused_id, "Still admin", Role::Admin),
            )
            .await
            .expect("refusal must release the write lock")
            .unwrap();
        }
        first_pool.close().await;
        second_pool.close().await;
    }

    #[tokio::test]
    async fn concurrent_demotions_preserve_one_sqlite_admin() {
        concurrent_admin_removals(false, false).await;
    }

    #[tokio::test]
    async fn concurrent_deletions_preserve_one_sqlite_admin() {
        concurrent_admin_removals(true, true).await;
    }

    #[tokio::test]
    async fn concurrent_demotion_and_deletion_preserve_one_sqlite_admin() {
        concurrent_admin_removals(false, true).await;
    }
}
