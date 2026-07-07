//! Local credential store (spec §8.2): a `users` table in the app's SQLite
//! settings DB, with argon2id password hashes. Replaces the fixed
//! admin/admin demo credential check that used to live on `AppState` in
//! `src-tauri` (see that crate's former TODO).
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

use std::sync::OnceLock;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use banto_core::{BantoError, FieldError};
use sqlx::SqlitePool;

const MIN_USERNAME_LEN: usize = 1;
const MAX_USERNAME_LEN: usize = 32;
const MIN_PASSWORD_LEN: usize = 8;

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
    if len < MIN_USERNAME_LEN || len > MAX_USERNAME_LEN {
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
}

/// Local credential store (spec §8.2): argon2id password hashes in the
/// `users` table (migration `0003_users.sql`). No seed user - the app starts
/// "uninitialized" and the first run walks through `setup_first_user`.
///
/// `Clone` is cheap (`SqlitePool` is an `Arc`-backed handle), matching
/// `ItemsService`/`SettingsService`.
#[derive(Clone)]
pub struct UsersService {
    pool: SqlitePool,
}

impl UsersService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Has *any* account been created yet? Used by the login page (spec
    /// §3.3/§8.2) to decide between the first-run setup form and the normal
    /// login form.
    pub async fn is_initialized(&self) -> Result<bool, BantoError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await
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

        let id: i64 = sqlx::query_scalar(
            "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?) \
             RETURNING id",
        )
        .bind(&username)
        .bind(&hash)
        .bind(display_name)
        .fetch_one(&self.pool)
        .await
        .map_err(banto_storage::storage_error)?;

        Ok(UserIdentity {
            id,
            username,
            display_name: display_name.to_string(),
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
        let row: Option<(i64, String, String)> =
            sqlx::query_as("SELECT id, password_hash, display_name FROM users WHERE username = ?")
                .bind(username)
                .fetch_optional(&self.pool)
                .await
                .map_err(banto_storage::storage_error)?;

        match row {
            Some((id, hash, display_name)) => {
                if verify_password(password, &hash) {
                    Ok(Some(UserIdentity {
                        id,
                        username: username.to_string(),
                        display_name,
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
        let row: Option<(i64, String)> =
            sqlx::query_as("SELECT id, password_hash FROM users WHERE username = ?")
                .bind(username)
                .fetch_optional(&self.pool)
                .await
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

        sqlx::query(
            "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&new_hash)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(banto_storage::storage_error)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_memory;

    async fn service() -> UsersService {
        let pool = migrate_memory().await.expect("migrate_memory");
        UsersService::new(pool)
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
        let err = sqlx::query(
            "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)",
        )
        .bind("owner")
        .bind(&hash)
        .bind("Duplicate")
        .execute(&svc.pool)
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
}
