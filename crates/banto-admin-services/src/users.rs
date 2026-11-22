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

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::sync::OnceLock;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use banto_core::{BantoError, FieldError};
use banto_storage::Db;
use serde::Serialize;

// AssertSqlSafe (throughout this file): the only interpolated fragments in
// the `format!`-built statements are `dialect.placeholder(n)` /
// `dialect.now_expr()` (internally generated from the `Dialect` enum, never
// caller input) and, occasionally, a hardcoded literal like `'admin'`. Every
// actual value - username, password hash, display name, role, id - is always
// passed via `.bind(...)`, never interpolated into the SQL text.

pub use crate::permissions::{
    PermissionCatalog, PermissionDiff, PermissionEntry, PermissionKey, SessionPermissions,
};

const MIN_USERNAME_LEN: usize = 1;
/// Longest username (in chars) an account can be created with. Public so the
/// login path can bound what it echoes into the audit log (Issue #278).
pub const MAX_USERNAME_LEN: usize = 32;
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

/// A new `users.account_uid` (ADR-0034 §1): 128 bits from the OS random
/// source, as 32 lowercase hex characters. Generated once when an account is
/// created and never changed or reused. Not a secret - it names whose UI
/// memory is whose, and is used for neither authentication nor authorization.
fn new_account_uid() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

/// Could [`UsersService::verify`] ever accept this account - whatever the
/// password? The name must be one it looks up (not empty, not longer than
/// [`MAX_USERNAME_LEN`]) and the stored hash one [`verify_password`] can
/// check: a PHC string whose algorithm, version and parameters argon2 accepts
/// and which carries a salt that decodes to at least argon2's minimum length
/// and an output of at least its minimum length - everything
/// `verify_password` needs before it computes and compares. Nothing is verified here; this only tells a
/// usable credential from a damaged one.
///
/// The ONE definition of "an administrator that can log in": startup, the
/// restore check and the lock-down ask it through
/// [`UsersService::has_admin`], and the last-administrator guard of a
/// demotion or a deletion asks it inside its write transaction
/// ([`another_admin_can_log_in`]).
fn can_log_in(username: &str, hash: Option<&str>) -> bool {
    let len = username.chars().count();
    if len == 0 || len > MAX_USERNAME_LEN {
        return false;
    }
    let Some(Ok(parsed)) = hash.map(PasswordHash::new) else {
        return false;
    };
    argon2::Algorithm::try_from(parsed.algorithm).is_ok()
        && parsed
            .version
            .is_none_or(|version| argon2::Version::try_from(version).is_ok())
        && argon2::Params::try_from(&parsed).is_ok()
        // The verifier decodes the salt and refuses one shorter than argon2's
        // minimum; the output has a minimum length too.
        && parsed.salt.is_some_and(|salt| {
            let mut decoded = [0u8; password_hash::Salt::MAX_LENGTH];
            salt.decode_b64(&mut decoded)
                .is_ok_and(|bytes| bytes.len() >= argon2::MIN_SALT_LEN)
        })
        && parsed
            .hash
            .is_some_and(|output| output.len() >= argon2::Params::MIN_OUTPUT_LEN)
}

// Is there an administrator account OTHER than `$id` that can log in
// ([`can_log_in`])? Read on the write transaction of a demotion / deletion,
// under its lock, so the answer holds until the write commits. Expanded for
// each backend (the statement binds nothing, so it is the same text).
macro_rules! another_admin_can_log_in {
    ($tx:expr, $id:expr) => {{
        let admins: Vec<(i64, String, Option<String>)> = sqlx::query_as(
            "SELECT id, username, password_hash FROM users \
             WHERE role = 'admin' AND kind = 'account'",
        )
        .fetch_all($tx)
        .await
        .map_err(banto_storage::storage_error)?;
        admins
            .iter()
            .any(|(id, username, hash)| *id != $id && can_log_in(username, hash.as_deref()))
    }};
}

/// [`verify_password`] on tokio's blocking pool (Issue #279). An argon2id
/// verification is tens of milliseconds of pure CPU; running it inline in an
/// `async fn` pins an async worker thread for that long, so a handful of
/// concurrent logins would stall every other request. A panicked/cancelled
/// blocking task is reported as "no match".
async fn verify_password_blocking(password: &str, hash: &str) -> bool {
    let password = password.to_owned();
    let hash = hash.to_owned();
    tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false)
}

/// Bound an externally supplied username before it is written to the audit
/// log (Issue #278). Accounts cannot be created with more than
/// [`MAX_USERNAME_LEN`] chars, so anything longer is by definition not a real
/// account and only exists to bloat the log. Longer values are cut on a char
/// (UTF-8) boundary to `MAX_USERNAME_LEN` chars in total, the last being `…`
/// so the truncation is visible; shorter values are returned unchanged.
pub fn bound_username_for_audit(username: &str) -> std::borrow::Cow<'_, str> {
    if username.chars().count() <= MAX_USERNAME_LEN {
        return std::borrow::Cow::Borrowed(username);
    }
    let mut out: String = username.chars().take(MAX_USERNAME_LEN - 1).collect();
    out.push('…');
    std::borrow::Cow::Owned(out)
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
    // `.` is the separator of the per-user UI setting key
    // (`ui.{username}.{key}`), so a name containing it could collide with
    // another user's key. Only *new* names go through here (setup/create);
    // accounts that predate this rule keep working everywhere else.
    if trimmed.contains('.') {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "username".to_string(),
                message: "ユーザー名に「.」は使えません".to_string(),
            }],
        });
    }
    Ok(trimmed.to_string())
}

/// Identity of a verified/created user. Spec §3.3's wire `Identity` carries
/// only `id`/`name`; this carries the full row needed by the REST/Tauri
/// command layers (e.g. `username`, to look the account back up for
/// `change_password`).
///
/// `auth_epoch` (Issue #204) is the account's authentication epoch as read in
/// the same statement as the rest of the row. A session records it (together
/// with `id`) when it is established, and is ended as soon as the stored
/// value differs - see [`UsersService`]'s "Session revocation" section.
#[derive(Debug, Clone, PartialEq)]
pub struct UserIdentity {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: Role,
    pub auth_epoch: i64,
}

/// What a `users` row is (ADR-0034 §2, column `users.kind`). Whether a row is
/// the built-in one is decided by this, never by its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UserKind {
    /// A person's account: has a password, logs in, is counted.
    Account,
    /// The built-in `admin` the baseline migration inserts: no password, never
    /// logs in, cannot be changed or deleted. Shown in the management list as
    /// one read-only row, counted nowhere.
    Builtin,
}

impl UserKind {
    pub fn as_str(self) -> &'static str {
        match self {
            UserKind::Account => "account",
            UserKind::Builtin => "builtin",
        }
    }
}

impl FromStr for UserKind {
    type Err = BantoError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "account" => Ok(UserKind::Account),
            "builtin" => Ok(UserKind::Builtin),
            other => Err(BantoError::Other(format!(
                "不明なユーザー種別です: {other}"
            ))),
        }
    }
}

/// Username of the built-in row (ADR-0034 §2). Fixed: the row cannot be
/// renamed. Used to WRITE the audit actor of a session marked
/// `audit_as_builtin_admin` and to reserve the name - never to decide whether
/// a row or a session is the built-in one (that is `kind`, and the mark).
pub const BUILTIN_ADMIN_USERNAME: &str = "admin";

/// Usernames an account may not take (ADR-0034 §4), compared ignoring case:
/// the built-in `admin` - always, the service layer adds it itself - plus the
/// fixed identity ids of the grants the app registers, which only the wiring
/// layer knows (`GrantRegistry::identity_ids`) and hands over through
/// [`UsersService::with_reserved_usernames`].
///
/// Reserving a name is about telling actors apart in the audit log and the
/// user list. It is never evidence of what a session is (conventions §10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservedUsernames {
    /// Lowercased.
    names: std::collections::BTreeSet<String>,
}

impl Default for ReservedUsernames {
    fn default() -> Self {
        Self::new(std::iter::empty::<&str>())
    }
}

impl ReservedUsernames {
    /// `names`: what the wiring reserves on top of `admin` (the grants'
    /// fixed identity ids). `admin` is always included.
    pub fn new<S: AsRef<str>>(names: impl IntoIterator<Item = S>) -> Self {
        let mut names: std::collections::BTreeSet<String> = names
            .into_iter()
            .map(|name| name.as_ref().trim().to_lowercase())
            .filter(|name| !name.is_empty())
            .collect();
        names.insert(BUILTIN_ADMIN_USERNAME.to_string());
        Self { names }
    }

    /// Is `username` reserved? Both sides are lowercased here, in Rust: the
    /// `users.username` uniqueness stays case-sensitive and no database
    /// collation is relied on.
    pub fn contains(&self, username: &str) -> bool {
        self.names.contains(&username.trim().to_lowercase())
    }

    /// The reserved names, lowercased, in order.
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.names.iter().map(String::as_str)
    }
}

fn reserved_username_error() -> BantoError {
    BantoError::Validation {
        field_errors: vec![FieldError {
            field: "username".to_string(),
            message: "このユーザー名は予約されているため使えません".to_string(),
        }],
    }
}

/// What the startup check found (ADR-0034 §2/§3): the id of the built-in
/// row, which the wiring keeps to write `actor_id` for the sessions marked
/// `audit_as_builtin_admin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupUsers {
    pub builtin_admin_id: i64,
}

/// Refusal of every write aimed at the built-in row (ADR-0034 §2).
/// `Forbidden` (403): an explicit refusal of the operation, not a failure of
/// the server. (The management screen never offers these operations on the
/// built-in row; only a hand-made request gets here.)
fn builtin_user_error() -> BantoError {
    BantoError::Forbidden
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
    /// `account`, or `builtin` for the one read-only built-in row
    /// (ADR-0034 §2). The screen offers no edit/delete/password action on a
    /// built-in row; the service refuses them either way.
    pub kind: UserKind,
    pub created_at: String,
    /// Row version for optimistic locking (Issue #651, migration 0012): bumped
    /// by every display-name/role update, untouched by password changes. A
    /// client sends back the version it read; a mismatch is
    /// `BantoError::Conflict`.
    pub version: i64,
}

/// What [`UsersService::update_user_with_permissions`] did (Issue #697): the
/// row before and after, the account's stored permissions after the write
/// (sorted, unregistered keys included) and what the write granted and
/// revoked. `#[non_exhaustive]`: built only here, read by the wiring.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct UserUpdate {
    pub previous: UserSummary,
    pub updated: UserSummary,
    pub permissions: Vec<PermissionKey>,
    pub permission_diff: PermissionDiff,
}

/// Wire shape of a freshly created account (`users_create`'s REST body and
/// Tauri return value, spec M10): everything [`UserIdentity`] carries except
/// `auth_epoch`, which must never reach the wire - hence this type instead
/// of a `Serialize` derive on `UserIdentity`. No `created_at` (unlike
/// [`UserSummary`]): `UsersService::create_user` does not read it back from
/// the DB, only the row it just inserted.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserIdentityView {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: Role,
}

impl From<UserIdentity> for UserIdentityView {
    fn from(identity: UserIdentity) -> Self {
        Self {
            id: identity.id,
            username: identity.username,
            display_name: identity.display_name,
            role: identity.role,
        }
    }
}

/// Local credential store (spec §8.2): argon2id password hashes in the
/// `users` table (migration `0003_users.sql`). A new database holds no account:
/// it starts in no-login mode, and accounts are created from user management
/// or by the headless CLI (ADR-0034 §5/§7).
///
/// `Clone` is cheap (`Db` is an `Arc`-backed connection handle), matching
/// `ItemsService`/`SettingsService`.
///
/// ## Session revocation (Issue #204)
///
/// Sessions (REST bearer tokens and the Tauri webview's session alike) are
/// bound to `(id, auth_epoch)` and re-checked against this table on every
/// request/command, so the account's CURRENT row is what authorizes. Three
/// writes end every existing session of an account, each by incrementing
/// `auth_epoch` in the same `UPDATE` that makes the change (never a separate
/// read-then-write, so a concurrent change cannot be overwritten with a stale
/// epoch):
///
/// - [`UsersService::update_user`] when the role actually changes (a
///   display-name-only edit keeps sessions);
/// - [`UsersService::change_password`] (returns the new epoch, so the caller
///   can keep only the session that made the change);
/// - [`UsersService::reset_password`].
///
/// [`UsersService::delete_user`] needs no epoch: the row is gone, and ids are
/// never reused (`AUTOINCREMENT` / identity column), so a later account with
/// the same username cannot inherit a deleted account's sessions.
#[derive(Clone)]
pub struct UsersService {
    db: Db,
    /// The permissions the app registered (Issue #697). Empty unless the app
    /// calls [`UsersService::with_permission_catalog`].
    catalog: PermissionCatalog,
    /// Names an account may not take (ADR-0034 §4). `admin` alone unless the
    /// wiring calls [`UsersService::with_reserved_usernames`].
    reserved: ReservedUsernames,
}

/// A new account's validated name and trimmed display name.
struct NewAccount {
    username: String,
    display_name: String,
}

// The duplicate check and the INSERT of `UsersService::create_user`, expanded
// for each executor (a pool, or a connection inside the caller's
// transaction) without a generic SQL layer. `$exec` is evaluated twice.
macro_rules! insert_account {
    ($exec:expr, $dialect:expr, $new:expr, $password:expr, $role:expr) => {{
        let dialect = $dialect;
        let exists_sql = format!(
            "SELECT id FROM users WHERE username = {}",
            dialect.placeholder(1)
        );
        let existing: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(exists_sql))
            .bind(&$new.username)
            .fetch_optional($exec)
            .await
            .map_err(banto_storage::storage_error)?;
        if existing.is_some() {
            return Err(BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "username".to_string(),
                    message: "このユーザー名は既に使用されています".to_string(),
                }],
            });
        }

        let hash = hash_password($password)?;
        let insert_sql = format!(
            "INSERT INTO users (username, password_hash, display_name, role, account_uid) \
             VALUES ({}, {}, {}, {}, {}) \
             RETURNING id, auth_epoch",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.placeholder(4),
            dialect.placeholder(5),
        );
        let account_uid = new_account_uid();
        let (id, auth_epoch): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(insert_sql))
            .bind(&$new.username)
            .bind(&hash)
            .bind(&$new.display_name)
            .bind($role.as_str())
            .bind(&account_uid)
            .fetch_one($exec)
            .await
            .map_err(banto_storage::storage_error)?;

        Ok(UserIdentity {
            id,
            username: $new.username,
            display_name: $new.display_name,
            role: $role,
            auth_epoch,
        })
    }};
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
///
/// `state` is the target's role and whether ANOTHER administrator account
/// can log in ([`another_admin_can_log_in`]). Counting rows is not enough
/// (cross-review of PR #865): with one damaged administrator row and one
/// good one, removing the good one would leave an install nobody can log in
/// to administer - the same condition the startup refuses.
fn ensure_admin_removal_allowed(
    id: i64,
    state: Option<(String, bool)>,
    removes_admin: bool,
) -> Result<(), BantoError> {
    let Some((role, another_admin_can_log_in)) = state else {
        return Err(BantoError::NotFound {
            resource: "users".to_string(),
            id: id.to_string(),
        });
    };
    if Role::from_str(&role)?.is_admin() && removes_admin && !another_admin_can_log_in {
        return Err(BantoError::Other(
            "最後の管理者を降格・削除することはできません".to_string(),
        ));
    }
    Ok(())
}

/// The `SET version = ...` expression of an account update (Issue #651): +1,
/// but back to 1 at `i64::MAX` instead of overflowing (same as items, #638).
const VERSION_BUMP: &str = "CASE WHEN version < 9223372036854775807 THEN version + 1 ELSE 1 END";

/// The conflict message (Issue #651). The client shows its own text; this is
/// the fallback `ProviderError.message`.
const CONFLICT_MESSAGE: &str = "他の人が先にこのアカウントを変更しました";

/// Guard row of an update/delete: `(role, admin count, id, username,
/// display_name, created_at, version, kind)`, read inside the write
/// transaction. The admin count is of accounts only: the built-in row is not
/// a way in, so it must not let the last human admin be removed.
type GuardRow = (String, i64, i64, String, String, String, i64, String);

/// Columns of [`GuardRow`], with the account-admin count.
const GUARD_COLUMNS: &str =
    "role, (SELECT COUNT(*) FROM users WHERE role = 'admin' AND kind = 'account'), \
     id, username, display_name, created_at, version, kind";

/// Refuse a write whose target is the built-in row (ADR-0034 §2). The SQL of
/// each write also carries `kind = 'account'`; this is the explicit answer.
fn ensure_account_row(guard: &GuardRow) -> Result<(), BantoError> {
    match UserKind::from_str(&guard.7)? {
        UserKind::Account => Ok(()),
        UserKind::Builtin => Err(builtin_user_error()),
    }
}

/// The guard row as the public row it was before the write.
fn guard_summary(g: &GuardRow) -> Result<UserSummary, BantoError> {
    Ok(UserSummary {
        id: g.2,
        username: g.3.clone(),
        display_name: g.4.clone(),
        role: Role::from_str(&g.0)?,
        kind: UserKind::from_str(&g.7)?,
        created_at: g.5.clone(),
        version: g.6,
    })
}

/// Stored permission strings -> keys, sorted. A malformed value (only a
/// hand-edited DB can hold one: every write path validates) is skipped, the
/// same "degrade, do not fail the read" stance as an unregistered key.
fn stored_keys(rows: Vec<String>) -> Vec<PermissionKey> {
    let set: BTreeSet<PermissionKey> = rows
        .iter()
        .filter_map(|raw| PermissionKey::parse(raw))
        .collect();
    set.into_iter().collect()
}

/// What a permission write does (Issue #697): `desired` replaces `before`.
/// Every desired key must be registered in `catalog` or already held (a key
/// the app stopped registering may be sent back to keep it); anything else
/// is a `Validation` error on `permissions`.
fn permission_write_plan(
    catalog: &PermissionCatalog,
    before: &[PermissionKey],
    desired: &BTreeSet<PermissionKey>,
) -> Result<PermissionDiff, BantoError> {
    if let Some(unknown) = desired
        .iter()
        .find(|key| !catalog.contains(key) && !before.contains(key))
    {
        return Err(crate::permissions::unknown_permission(unknown));
    }
    Ok(PermissionDiff::between(
        &before.iter().cloned().collect(),
        desired,
    ))
}

/// The `{ "field": "permissions", "added": [...], "removed": [...] }` entry
/// of an audit `changes` list (Issue #697, user-permissions-plan §7), put in
/// field-name order like [`crate::audit::diff::diff_changes`] sorts. Nothing
/// is added when nothing changed.
fn push_permissions_change(changes: &mut Vec<serde_json::Value>, diff: &PermissionDiff) {
    if diff.is_empty() {
        return;
    }
    changes.push(serde_json::json!({
        "field": "permissions",
        "added": diff.added,
        "removed": diff.removed,
    }));
    changes.sort_by(|a, b| {
        a["field"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["field"].as_str().unwrap_or_default())
    });
}

/// Optimistic-lock check (Issue #651): `expected` is the version the client
/// read (`None` = no check, the old overwrite). Any other value than the
/// stored one - including 0, a negative or a future version - is a
/// `Conflict` carrying the current row.
fn check_version(expected: Option<i64>, current: &UserSummary) -> Result<(), BantoError> {
    match expected {
        Some(version) if version != current.version => Err(BantoError::Conflict {
            message: CONFLICT_MESSAGE.to_string(),
            current: serde_json::to_value(current).ok(),
        }),
        _ => Ok(()),
    }
}

/// Audit `detail` for a `users` update (Issue #597): `{ username, role,
/// changes }`. Both the REST and the Tauri wiring call this so the two routes
/// record the same shape (conventions section 1). `role` stays for readers of
/// the old shape; `username` names the target. `UserSummary` has no secret
/// column, but the secret names are still masked in case a field is added
/// later (conventions section 5). `username` cannot change and `createdAt` is
/// a stamp, and `version` is the optimistic-lock counter (Issue #651, not a
/// user edit), so all three are ignored.
pub fn user_update_detail(before: &UserSummary, after: &UserSummary) -> serde_json::Value {
    let changes = crate::audit::diff::diff_changes(
        &serde_json::to_value(before).unwrap_or_default(),
        &serde_json::to_value(after).unwrap_or_default(),
        &["password", "passwordHash", "authEpoch"],
        &["id", "username", "createdAt", "version"],
    );
    serde_json::json!({ "username": after.username, "role": after.role, "changes": changes })
}

/// [`user_update_detail`] plus the permission change of the same update
/// (Issue #697, user-permissions-plan §7): one more `changes` entry,
/// `{ "field": "permissions", "added": [...], "removed": [...] }`, in
/// field-name order with the others; nothing is added when `permissions` is
/// empty. The REST and Tauri wiring both call this one function, so their
/// audit rows are the same. Keys only - no secret is involved.
pub fn user_update_detail_with_permissions(
    before: &UserSummary,
    after: &UserSummary,
    permissions: &PermissionDiff,
) -> serde_json::Value {
    let mut detail = user_update_detail(before, after);
    if let Some(changes) = detail["changes"].as_array_mut() {
        push_permissions_change(changes, permissions);
    }
    detail
}

/// The public fields of a new user; credentials and auth state never enter
/// the audit payload. Both transports use this function.
pub fn user_create_detail(user: &UserIdentity) -> serde_json::Value {
    let changes = crate::audit::diff::diff_changes(
        &serde_json::json!({}),
        &serde_json::json!({
            "displayName": user.display_name,
            "role": user.role,
        }),
        &["password", "passwordHash", "authEpoch"],
        &[],
    );
    serde_json::json!({ "username": user.username, "role": user.role, "changes": changes })
}

pub fn user_delete_detail(user: &UserSummary) -> serde_json::Value {
    let changes = crate::audit::diff::diff_changes(
        &serde_json::json!({
            "displayName": user.display_name,
            "role": user.role,
        }),
        &serde_json::json!({}),
        &["password", "passwordHash", "authEpoch"],
        &[],
    );
    serde_json::json!({ "username": user.username, "role": user.role, "changes": changes })
}

impl UsersService {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            catalog: PermissionCatalog::empty(),
            reserved: ReservedUsernames::default(),
        }
    }

    /// Reserve `reserved` for account names (ADR-0034 §4): creating an
    /// account under one of them is refused, ignoring case. The wiring layer
    /// passes the fixed identity ids of the grants it registers; `admin` is
    /// reserved whether or not this is called.
    pub fn with_reserved_usernames(mut self, reserved: ReservedUsernames) -> Self {
        self.reserved = reserved;
        self
    }

    /// The reserved account names in effect.
    pub fn reserved_usernames(&self) -> &ReservedUsernames {
        &self.reserved
    }

    fn ensure_username_not_reserved(&self, username: &str) -> Result<(), BantoError> {
        if self.reserved.contains(username) {
            return Err(reserved_username_error());
        }
        Ok(())
    }

    /// The checks that stop a startup (ADR-0034 §2/§4), read-only. Both
    /// wirings call this once the migrations have run, and the restore
    /// validation calls the SAME function on a candidate before anything is
    /// swapped (ADR-0034 §9), so a backup that could not boot is refused
    /// while the current database is still in place.
    ///
    /// 1. Exactly one built-in row exists (`kind = 'builtin'`), and it is the
    ///    `admin` the baseline migration inserted: username exactly `admin`,
    ///    role `admin`. The row is FOUND by `kind`; its name and role are then
    ///    checked, because the audit log writes that row's id under the name
    ///    `admin` and the schema does not pin either column. Anything else
    ///    only happens through a direct edit of the database; it is reported,
    ///    never repaired.
    /// 2. No account (`kind = 'account'`) has a reserved name, ignoring case.
    ///    Creating one is refused, so this only finds an account that existed
    ///    before a grant with the same fixed id was added to the app.
    pub async fn check_startup(&self) -> Result<StartupUsers, BantoError> {
        const SQL: &str = "SELECT id, username, kind, role FROM users ORDER BY id";
        let rows: Vec<(i64, String, String, String)> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
        }
        .map_err(banto_storage::storage_error)?;

        let mut builtin_rows = Vec::new();
        let mut collisions = Vec::new();
        for (id, username, kind, role) in rows {
            match UserKind::from_str(&kind)? {
                UserKind::Builtin => builtin_rows.push((id, username, role)),
                UserKind::Account => {
                    if self.reserved.contains(&username) {
                        collisions.push(username);
                    }
                }
            }
        }
        const EDITED: &str = "この DB は直接書き換えられた可能性があります。\
             バックアップから戻すか、DB を作り直してください";
        let builtin_admin_id = match builtin_rows.as_slice() {
            [(id, username, role)] => {
                if username != BUILTIN_ADMIN_USERNAME || role != Role::Admin.as_str() {
                    return Err(BantoError::Other(format!(
                        "組み込みのユーザーの行が admin ではありません（username: {username}、role: {role}）。{EDITED}"
                    )));
                }
                *id
            }
            [] => {
                return Err(BantoError::Other(format!(
                    "組み込みのユーザー admin の行がありません。{EDITED}"
                )))
            }
            _ => {
                return Err(BantoError::Other(format!(
                    "組み込みのユーザーの行が 2 つ以上あります。{EDITED}"
                )))
            }
        };
        if !collisions.is_empty() {
            return Err(BantoError::Other(format!(
                "予約されたユーザー名と同じ名前のアカウントがあります: {}。\
                 この名前は組み込みのユーザーか、ログインなしのセッション（grant）の固定 id に使われています。\
                 そのアカウントを別の名前で作り直すか、grant の固定 id を変えてください",
                collisions.join(", ")
            )));
        }
        Ok(StartupUsers { builtin_admin_id })
    }

    /// Use `catalog` as the registered permissions (Issue #697,
    /// user-permissions-plan §3-3): what a permission write accepts and what
    /// [`UsersService::session_permissions`] keeps. The app builds it once at
    /// startup; the template keeps the empty one.
    pub fn with_permission_catalog(mut self, catalog: PermissionCatalog) -> Self {
        self.catalog = catalog;
        self
    }

    /// The registered permissions (`GET /api/permissions` /
    /// `permissions_catalog`, and the filter of the auth-disabled mode's
    /// `auth.disabled_permissions`).
    pub fn permission_catalog(&self) -> &PermissionCatalog {
        &self.catalog
    }

    /// `SELECT permission FROM user_permissions WHERE user_id = $1`, sorted.
    fn permissions_sql(&self) -> String {
        format!(
            "SELECT permission FROM user_permissions WHERE user_id = {} ORDER BY permission",
            self.db.dialect().placeholder(1)
        )
    }

    /// The permissions stored for account `user_id` (Issue #697,
    /// user-permissions-plan §5), sorted - including keys the catalog no
    /// longer registers (the admin screen shows those as "未登録"). An
    /// unknown id reads as no permissions. Authorization uses
    /// [`UsersService::session_permissions`] instead, which keeps registered
    /// keys only.
    pub async fn permissions_of(&self, user_id: i64) -> Result<Vec<PermissionKey>, BantoError> {
        // AssertSqlSafe: only `dialect.placeholder(n)` is interpolated.
        let sql = self.permissions_sql();
        let rows: Vec<String> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_all(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_all(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        Ok(stored_keys(rows))
    }

    /// What a session of account `user_id` is authorized with (Issue #697,
    /// user-permissions-plan §4-§5): the stored permissions the catalog
    /// registers. Read per request (REST `require_auth`) or per command
    /// (Tauri `require_permission`), so a revoked key stops working on the
    /// next request without touching `auth_epoch`. An unknown id holds none.
    pub async fn session_permissions(
        &self,
        user_id: i64,
    ) -> Result<SessionPermissions, BantoError> {
        // Nothing registered = nothing held: skip the read (the template).
        if self.catalog.is_empty() {
            return Ok(SessionPermissions::none());
        }
        let stored = self.permissions_of(user_id).await?;
        Ok(SessionPermissions::new(self.catalog.effective(&stored)))
    }

    /// Every account's stored permissions in one read (Issue #697), keyed by
    /// account id, each sorted - including keys the catalog no longer
    /// registers, like [`UsersService::permissions_of`]. Accounts without
    /// any are absent. For the user list (`GET /api/users` / `users_list`).
    pub async fn permissions_by_user(
        &self,
    ) -> Result<BTreeMap<i64, Vec<PermissionKey>>, BantoError> {
        const PERMS_SQL: &str =
            "SELECT user_id, permission FROM user_permissions ORDER BY user_id, permission";
        let rows: Vec<(i64, String)> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_as(PERMS_SQL).fetch_all(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_as(PERMS_SQL).fetch_all(pool).await,
        }
        .map_err(banto_storage::storage_error)?;
        let mut held: BTreeMap<i64, Vec<String>> = BTreeMap::new();
        for (user_id, permission) in rows {
            held.entry(user_id).or_default().push(permission);
        }
        Ok(held
            .into_iter()
            .map(|(user_id, raw)| (user_id, stored_keys(raw)))
            .collect())
    }

    /// Replace the permissions of account `user_id` with `permissions`
    /// (Issue #697, user-permissions-plan §5) and return what changed.
    ///
    /// - Every key must be registered in the catalog, or already be held (a
    ///   key the app stopped registering may be sent back to keep it; leaving
    ///   it out revokes it). Anything else is a `Validation` error on
    ///   `permissions`, with nothing written.
    /// - `expected_version` is the account row's optimistic lock (Issue #651):
    ///   `Some` and different from the stored version is
    ///   `BantoError::Conflict` carrying the current row; `None` overwrites.
    /// - A real change bumps `users.version`, so another admin's edit of the
    ///   same account conflicts; an unchanged set writes nothing. It does NOT
    ///   advance `auth_epoch`: sessions stay, and their next request re-reads
    ///   the permissions (user-permissions-plan §3-4).
    /// - `actor` (the granting admin's username) is stored as `granted_by` of
    ///   the newly granted rows; the history is the audit log's job.
    ///
    /// Like every service here this does not authorize the caller
    /// (conventions §2). A user update that also changes permissions uses
    /// [`UsersService::update_user_with_permissions`], so both writes share
    /// one transaction and one version bump.
    pub async fn set_permissions(
        &self,
        user_id: i64,
        permissions: &[PermissionKey],
        expected_version: Option<i64>,
        actor: &str,
    ) -> Result<PermissionDiff, BantoError> {
        let desired: BTreeSet<PermissionKey> = permissions.iter().cloned().collect();
        let dialect = self.db.dialect();
        // AssertSqlSafe (all statements below): only `dialect` output and the
        // `VERSION_BUMP` constant are interpolated; values are bound.
        // The admin-count column of `GuardRow` is not needed here; `CAST(.. AS
        // BIGINT)` because a bare `0` is INT4 on PostgreSQL and the row decodes
        // it as `i64` (the other guards put a `COUNT(*)`, already BIGINT).
        let guard_sql = format!(
            "SELECT role, CAST(0 AS BIGINT), id, username, display_name, created_at, version, kind \
             FROM users WHERE id = {}",
            dialect.placeholder(1),
        );
        let perms_sql = self.permissions_sql();
        let delete_sql = self.permission_delete_sql();
        let insert_sql = self.permission_insert_sql();
        let bump_sql = format!(
            "UPDATE users SET version = {VERSION_BUMP}, updated_at = {} \
             WHERE id = {} AND kind = 'account'",
            dialect.now_expr(),
            dialect.placeholder(1),
        );
        let catalog = &self.catalog;
        let diff: PermissionDiff = with_users_write_transaction!(&self.db, |tx| {
            let guard: Option<GuardRow> = sqlx::query_as(sqlx::AssertSqlSafe(guard_sql))
                .bind(user_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?;
            let Some(guard) = guard else {
                return Err(BantoError::NotFound {
                    resource: "users".to_string(),
                    id: user_id.to_string(),
                });
            };
            let stored: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(perms_sql))
                .bind(user_id)
                .fetch_all(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?;
            let before = stored_keys(stored);
            ensure_account_row(&guard)?;
            check_version(expected_version, &guard_summary(&guard)?)?;
            let diff = permission_write_plan(catalog, &before, &desired)?;
            for key in &diff.removed {
                sqlx::query(sqlx::AssertSqlSafe(delete_sql.clone()))
                    .bind(user_id)
                    .bind(key.as_str())
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
            }
            for key in &diff.added {
                sqlx::query(sqlx::AssertSqlSafe(insert_sql.clone()))
                    .bind(user_id)
                    .bind(key.as_str())
                    .bind(actor)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
            }
            if !diff.is_empty() {
                sqlx::query(sqlx::AssertSqlSafe(bump_sql))
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(banto_storage::storage_error)?;
            }
            diff
        });
        Ok(diff)
    }

    fn permission_delete_sql(&self) -> String {
        let dialect = self.db.dialect();
        format!(
            "DELETE FROM user_permissions WHERE user_id = {} AND permission = {}",
            dialect.placeholder(1),
            dialect.placeholder(2),
        )
    }

    fn permission_insert_sql(&self) -> String {
        format!(
            "INSERT INTO user_permissions (user_id, permission, granted_by) VALUES ({})",
            self.db.dialect().placeholders(3),
        )
    }

    /// Does at least one `admin` account exist? A derived app that lets an
    /// admin-equivalent grant (ADR-0017, e.g. banto-hub's commissioning mode)
    /// administer the install uses this as the guard before closing that
    /// grant ("lock-down"): without a real admin, closing it would leave the
    /// install with no administrator at all. Requiring login (`auth.disabled`
    /// off) has the same guard (ADR-0034 §6): "some account exists" is not
    /// enough (an install may hold only editors/viewers).
    ///
    /// "Exists" means "could log in": the row's name is one the verifier
    /// looks up and its stored hash is one the verifier can check
    /// ([`can_log_in`]). A row whose hash was damaged or edited by hand is an
    /// administrator nobody can become, so it does not count - at startup, in
    /// the restore check and at the lock-down alike (they all ask here). The
    /// password itself is not checked.
    pub async fn has_admin(&self) -> Result<bool, BantoError> {
        // Accounts only: the built-in `admin` row cannot log in.
        const SQL: &str =
            "SELECT username, password_hash FROM users WHERE role = 'admin' AND kind = 'account'";
        let rows: Vec<(String, Option<String>)> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
        }
        .map_err(banto_storage::storage_error)?;
        Ok(rows
            .iter()
            .any(|(username, hash)| can_log_in(username, hash.as_deref())))
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
        // Issue #278: no account can have a username longer than
        // MAX_USERNAME_LEN, so skip the lookup (and never bind an attacker-
        // sized string) but still pay the dummy argon2 cost, keeping this
        // indistinguishable from an unknown username.
        if username.chars().count() > MAX_USERNAME_LEN {
            let _ = verify_password_blocking(password, dummy_hash()).await;
            return Ok(None);
        }
        // Accounts only (ADR-0034 §2): the built-in `admin` has no password
        // and is not a row to verify against. It falls into the `None` arm
        // below - the same dummy hash verification as an unknown username, so
        // the response time does not tell the two apart.
        // AssertSqlSafe: see the note at the top of this file.
        let sql = format!(
            "SELECT id, password_hash, display_name, role, auth_epoch FROM users \
             WHERE username = {} AND kind = 'account'",
            self.db.dialect().placeholder(1)
        );
        let row: Option<(i64, String, String, String, i64)> = match &self.db {
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
            Some((id, hash, display_name, role, auth_epoch)) => {
                if verify_password_blocking(password, &hash).await {
                    Ok(Some(UserIdentity {
                        id,
                        username: username.to_string(),
                        display_name,
                        role: Role::from_str(&role)?,
                        auth_epoch,
                    }))
                } else {
                    Ok(None)
                }
            }
            None => {
                let _ = verify_password_blocking(password, dummy_hash()).await;
                Ok(None)
            }
        }
    }

    /// Verify `current`, then update the account's password to `new`
    /// (validated the same way as `create_user`'s password, but with
    /// field name `newPassword` so the Tauri/REST layers can map the error
    /// straight onto the change-password form's second input).
    ///
    /// Issue #204: the same `UPDATE` increments `auth_epoch`, which ends
    /// every existing session of the account; the new epoch is returned so
    /// the caller can re-bind just the session that made the change (see
    /// the "Session revocation" section on [`UsersService`]). The `UPDATE`
    /// also requires the hash it verified against to still be current, so
    /// a password changed or reset in between is not silently overwritten
    /// (reported as a wrong current password, which it now is).
    pub async fn change_password(
        &self,
        username: &str,
        current: &str,
        new: &str,
    ) -> Result<i64, BantoError> {
        // AssertSqlSafe: see the note at the top of this file.
        // Accounts only (ADR-0034 §2): the built-in row has no password to
        // change, and answers like an unknown username.
        let select_sql = format!(
            "SELECT id, password_hash FROM users WHERE username = {} AND kind = 'account'",
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
        // AssertSqlSafe: see the note at the top of this file.
        let update_sql = format!(
            "UPDATE users SET password_hash = {}, auth_epoch = auth_epoch + 1, updated_at = {} \
             WHERE id = {} AND password_hash = {} AND kind = 'account' RETURNING auth_epoch",
            dialect.placeholder(1),
            dialect.now_expr(),
            dialect.placeholder(2),
            dialect.placeholder(3),
        );
        let new_epoch: Option<i64> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(update_sql))
                    .bind(&new_hash)
                    .bind(id)
                    .bind(&hash)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(update_sql))
                    .bind(&new_hash)
                    .bind(id)
                    .bind(&hash)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;

        // No row: the account was deleted, or its password changed after the
        // verification above. Either way the supplied current password is no
        // longer the account's password.
        new_epoch.ok_or_else(wrong_current)
    }

    // --- M10: user management (admin-only CRUD + RBAC) -------------------

    /// All accounts, for the admin user-management grid (spec M10).
    /// `password_hash` deliberately never leaves this module - see
    /// [`UserSummary`].
    /// The kind of the row `id`, or `None` when there is no such row.
    async fn kind_of(&self, id: i64) -> Result<Option<UserKind>, BantoError> {
        // AssertSqlSafe: see the note at the top of this file.
        let sql = format!(
            "SELECT kind FROM users WHERE id = {}",
            self.db.dialect().placeholder(1)
        );
        let kind: Option<String> = match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)?;
        kind.as_deref().map(UserKind::from_str).transpose()
    }

    pub async fn list_users(&self) -> Result<Vec<UserSummary>, BantoError> {
        const SQL: &str = "SELECT id, username, display_name, role, created_at, version, kind \
             FROM users ORDER BY id";
        let rows: Vec<(i64, String, String, String, String, i64, String)> = match &self.db {
            Db::Sqlite(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_as(SQL).fetch_all(pool).await,
        }
        .map_err(banto_storage::storage_error)?;

        rows.into_iter()
            .map(
                |(id, username, display_name, role, created_at, version, kind)| {
                    Ok(UserSummary {
                        id,
                        username,
                        display_name,
                        role: Role::from_str(&role)?,
                        kind: UserKind::from_str(&kind)?,
                        created_at,
                        version,
                    })
                },
            )
            .collect()
    }

    /// Look up an account's full identity by username, without verifying a
    /// password. Used by the REST layer to recover the acting caller's
    /// numeric row id (needed by [`UsersService::delete_user`]'s
    /// self-deletion guard) from a bearer token's `Identity.id`, which
    /// carries the *username* (spec convention, see
    /// `banto_server::auth::Identity`'s doc comment), not the row id.
    ///
    /// Also the per-request session re-check (Issue #204): the REST session
    /// lookup (`banto_server::routes::user_session_lookup`) and the Tauri
    /// `require_role` compare the returned `id`/`auth_epoch` with the ones
    /// the session was established under and authorize with the returned
    /// (current) `role`. One indexed lookup on the `UNIQUE` `username`.
    pub async fn get_by_username(
        &self,
        username: &str,
    ) -> Result<Option<UserIdentity>, BantoError> {
        // AssertSqlSafe: see the note at the top of this file.
        let sql = format!(
            "SELECT id, display_name, role, auth_epoch FROM users \
             WHERE username = {} AND kind = 'account'",
            self.db.dialect().placeholder(1)
        );
        let row: Option<(i64, String, String, i64)> = match &self.db {
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
            Some((id, display_name, role, auth_epoch)) => Ok(Some(UserIdentity {
                id,
                username: username.to_string(),
                display_name,
                role: Role::from_str(&role)?,
                auth_epoch,
            })),
            None => Ok(None),
        }
    }

    /// Create an account (spec M10). Validates the name (reserved names
    /// included) and the password, and answers a duplicate username with a
    /// friendly `BantoError::Validation` (rather than surfacing the raw
    /// UNIQUE-constraint storage error to the admin form).
    pub async fn create_user(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
        role: Role,
    ) -> Result<UserIdentity, BantoError> {
        let new = self.validate_new_account(username, password, display_name)?;
        let dialect = self.db.dialect();
        match &self.db {
            Db::Sqlite(pool) => insert_account!(pool, dialect, new, password, role),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => insert_account!(pool, dialect, new, password, role),
        }
    }

    /// [`Self::create_user`] on a SQLite connection that is inside the
    /// caller's transaction: the same validation and the same INSERT, for a
    /// caller that must commit the account together with other rows (the
    /// headless first-account CLI, ADR-0034 §7). Nothing is written when it
    /// fails.
    pub async fn create_user_on_sqlite(
        &self,
        conn: &mut sqlx::SqliteConnection,
        username: &str,
        password: &str,
        display_name: &str,
        role: Role,
    ) -> Result<UserIdentity, BantoError> {
        let new = self.validate_new_account(username, password, display_name)?;
        insert_account!(
            &mut *conn,
            banto_storage::Dialect::Sqlite,
            new,
            password,
            role
        )
    }

    /// PostgreSQL twin of [`Self::create_user_on_sqlite`].
    #[cfg(feature = "postgres")]
    pub async fn create_user_on_postgres(
        &self,
        conn: &mut sqlx::PgConnection,
        username: &str,
        password: &str,
        display_name: &str,
        role: Role,
    ) -> Result<UserIdentity, BantoError> {
        let new = self.validate_new_account(username, password, display_name)?;
        insert_account!(
            &mut *conn,
            banto_storage::Dialect::Postgres,
            new,
            password,
            role
        )
    }

    /// The checks of a new account that need no database: the name's shape,
    /// the reserved names, the password's length.
    fn validate_new_account(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
    ) -> Result<NewAccount, BantoError> {
        let username = validate_username(username)?;
        self.ensure_username_not_reserved(&username)?;
        validate_password_len(password, "password")?;
        Ok(NewAccount {
            username,
            display_name: display_name.trim().to_string(),
        })
    }

    /// Update an account's `display_name`/`role` (spec M10; password
    /// changes go through [`UsersService::change_password`] (self-service)
    /// or [`UsersService::reset_password`] (admin) instead). Refuses to
    /// demote the last `admin` account.
    ///
    /// Issue #204: a role change increments `auth_epoch`, ending the
    /// account's existing sessions; a display-name-only update does not.
    /// Whether the role changed is decided by the `UPDATE` itself (SQL `SET`
    /// expressions see the row's pre-update values), not by a separate read.
    pub async fn update_user(
        &self,
        id: i64,
        display_name: &str,
        role: Role,
    ) -> Result<UserSummary, BantoError> {
        self.update_user_returning_previous(id, display_name, role)
            .await
            .map(|(_, updated)| updated)
    }

    /// [`UsersService::update_user`] that also returns the row as it was
    /// before the update, as `(previous, updated)` (Issue #597, for the audit
    /// record's `detail.changes`; see [`user_update_detail`]). The previous row
    /// is read by the guard `SELECT` that already runs inside the write
    /// transaction, so the two rows are consistent and no extra read is added.
    /// No `FOR UPDATE` is needed: `with_users_write_transaction!` takes the
    /// writer before that read (SQLite `BEGIN IMMEDIATE`; PostgreSQL a
    /// self-conflicting `SHARE ROW EXCLUSIVE` table lock under `READ
    /// COMMITTED`), so concurrent user writes are serialized and the previous
    /// row is the last committed one, never a stale one.
    /// The last-admin check and the `auth_epoch` handling are those of
    /// [`UsersService::update_user`].
    pub async fn update_user_returning_previous(
        &self,
        id: i64,
        display_name: &str,
        role: Role,
    ) -> Result<(UserSummary, UserSummary), BantoError> {
        self.update_user_checked_returning_previous(id, display_name, role, None)
            .await
    }

    /// [`UsersService::update_user_returning_previous`] with the optimistic
    /// lock (Issue #651): `expected_version` is the [`UserSummary::version`]
    /// the client read. `Some` and different from the stored one is
    /// `BantoError::Conflict` (carrying the current row) with nothing
    /// written; `None` overwrites as before. The check runs on the row the
    /// guard `SELECT` reads inside the write transaction, so two concurrent
    /// updates carrying the same version cannot both succeed. Every
    /// successful update bumps the version; password changes do not.
    pub async fn update_user_checked_returning_previous(
        &self,
        id: i64,
        display_name: &str,
        role: Role,
        expected_version: Option<i64>,
    ) -> Result<(UserSummary, UserSummary), BantoError> {
        let outcome = self
            .update_user_with_permissions(id, display_name, role, None, expected_version, "")
            .await?;
        Ok((outcome.previous, outcome.updated))
    }

    /// [`UsersService::update_user_checked_returning_previous`] that can also
    /// replace the account's permissions (Issue #697, user-permissions-plan
    /// §6: the permissions ride on the user update, `PUT /api/users/{id}` /
    /// `users_update`). `permissions: None` leaves them as they are (a client
    /// that does not know about permissions keeps working); `Some` replaces
    /// them by the rules of [`UsersService::set_permissions`], in the SAME
    /// transaction as the row update - one version check, one version bump,
    /// and a rejected permission writes nothing at all. `actor` is the
    /// granting admin's username (`granted_by`); unused when `permissions` is
    /// `None`.
    ///
    /// The returned [`UserUpdate`] carries the stored permissions after the
    /// write and what changed, for the response and
    /// [`user_update_detail_with_permissions`].
    pub async fn update_user_with_permissions(
        &self,
        id: i64,
        display_name: &str,
        role: Role,
        permissions: Option<&[PermissionKey]>,
        expected_version: Option<i64>,
        actor: &str,
    ) -> Result<UserUpdate, BantoError> {
        let display_name = display_name.trim();
        let desired: Option<BTreeSet<PermissionKey>> =
            permissions.map(|keys| keys.iter().cloned().collect());
        let perms_sql = self.permissions_sql();
        let delete_sql = self.permission_delete_sql();
        let insert_sql = self.permission_insert_sql();
        let catalog = &self.catalog;

        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note at the top of this file.
        let sql = format!(
            "UPDATE users SET display_name = {}, \
             auth_epoch = auth_epoch + CASE WHEN role = {} THEN 0 ELSE 1 END, \
             role = {}, updated_at = {}, version = {VERSION_BUMP} \
             WHERE id = {} AND kind = 'account' \
             RETURNING id, username, display_name, role, created_at, version",
            dialect.placeholder(1),
            dialect.placeholder(2),
            dialect.placeholder(3),
            dialect.now_expr(),
            dialect.placeholder(4),
        );
        let guard_sql = format!(
            "SELECT {GUARD_COLUMNS} FROM users WHERE id = {}",
            dialect.placeholder(1),
        );
        type Guard = GuardRow;
        type Updated = (i64, String, String, String, String, i64);
        type Rows = (
            Option<Guard>,
            Option<Updated>,
            Vec<PermissionKey>,
            Vec<PermissionKey>,
        );
        let rows: Rows = with_users_write_transaction!(&self.db, |tx| {
            let guard: Option<Guard> = sqlx::query_as(sqlx::AssertSqlSafe(guard_sql))
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?;
            // The permissions before the write (Issue #697), for the
            // returned rows and the audit diff. A missing row has none.
            let before = if guard.is_some() {
                let stored: Vec<String> =
                    sqlx::query_scalar(sqlx::AssertSqlSafe(perms_sql.clone()))
                        .bind(id)
                        .fetch_all(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                stored_keys(stored)
            } else {
                Vec::new()
            };
            // A missing row stays NotFound (below) even with a version.
            if let Some(g) = guard.as_ref() {
                ensure_account_row(g)?;
                check_version(expected_version, &guard_summary(g)?)?;
            }
            let another_admin = another_admin_can_log_in!(&mut *tx, id);
            ensure_admin_removal_allowed(
                id,
                guard.as_ref().map(|g| (g.0.clone(), another_admin)),
                !role.is_admin(),
            )?;
            let updated: Option<Updated> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
                .bind(display_name)
                .bind(role.as_str())
                .bind(role.as_str())
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?;
            let mut after = before.clone();
            if let (Some(desired), Some(_)) = (desired.as_ref(), updated.as_ref()) {
                let diff = permission_write_plan(catalog, &before, desired)?;
                for key in &diff.removed {
                    sqlx::query(sqlx::AssertSqlSafe(delete_sql.clone()))
                        .bind(id)
                        .bind(key.as_str())
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                for key in &diff.added {
                    sqlx::query(sqlx::AssertSqlSafe(insert_sql.clone()))
                        .bind(id)
                        .bind(key.as_str())
                        .bind(actor)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                after = desired.iter().cloned().collect();
            }
            (guard, updated, before, after)
        });

        let (
            Some(guard),
            Some((row_id, username, display_name, role_str, created_at, version)),
            before,
            after,
        ) = rows
        else {
            return Err(BantoError::NotFound {
                resource: "users".to_string(),
                id: id.to_string(),
            });
        };

        let previous = guard_summary(&guard)?;
        let updated = UserSummary {
            id: row_id,
            username,
            display_name,
            role: Role::from_str(&role_str)?,
            kind: UserKind::Account,
            created_at,
            version,
        };
        let permission_diff = PermissionDiff::between(
            &before.iter().cloned().collect(),
            &after.iter().cloned().collect(),
        );
        Ok(UserUpdate {
            previous,
            updated,
            permissions: after,
            permission_diff,
        })
    }

    /// Admin-initiated password reset (spec M10): unlike
    /// [`UsersService::change_password`], does not require the account's
    /// current password - this is an administrative action on someone
    /// else's account, not self-service.
    ///
    /// Issue #204: also increments `auth_epoch`, ending every existing
    /// session of the account (including the caller's own, when an admin
    /// resets their own password through this administrative path).
    pub async fn reset_password(&self, id: i64, new_password: &str) -> Result<(), BantoError> {
        validate_password_len(new_password, "newPassword")?;
        // The built-in row never gets a password (ADR-0034 §2): refused here
        // by name of its kind, and the UPDATE below cannot touch it either.
        if self.kind_of(id).await? == Some(UserKind::Builtin) {
            return Err(builtin_user_error());
        }
        let hash = hash_password(new_password)?;

        let dialect = self.db.dialect();
        // AssertSqlSafe: see the note at the top of this file.
        let sql = format!(
            "UPDATE users SET password_hash = {}, auth_epoch = auth_epoch + 1, updated_at = {} \
             WHERE id = {} AND kind = 'account'",
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
    ///
    /// `acting_user_id` is `None` ONLY for a caller that has no row of its
    /// own by construction - a validated grant session (ADR-0017 §3, e.g. a
    /// derived app's admin-equivalent commissioning grant). The caller
    /// decides that from the authenticated session's provenance, never
    /// from a failed row lookup (an account session whose row cannot be
    /// found is `Unauthorized`, not `None`). Only the self-deletion check is
    /// skipped then; the last-admin guard applies unchanged.
    pub async fn delete_user(
        &self,
        id: i64,
        acting_user_id: Option<i64>,
    ) -> Result<(), BantoError> {
        self.delete_user_returning_previous(id, acting_user_id)
            .await
            .map(|_| ())
    }

    /// Delete and return the removed public row from the same guarded write.
    pub async fn delete_user_returning_previous(
        &self,
        id: i64,
        acting_user_id: Option<i64>,
    ) -> Result<UserSummary, BantoError> {
        self.delete_user_checked_returning_previous(id, acting_user_id, None)
            .await
    }

    /// [`UsersService::delete_user_returning_previous`] with the optimistic
    /// lock (Issue #651): `Some(version)` different from the stored one is
    /// `BantoError::Conflict` (carrying the current row) with nothing
    /// deleted. The row is read inside the same write transaction as the
    /// delete.
    pub async fn delete_user_checked_returning_previous(
        &self,
        id: i64,
        acting_user_id: Option<i64>,
        expected_version: Option<i64>,
    ) -> Result<UserSummary, BantoError> {
        if acting_user_id == Some(id) {
            return Err(BantoError::Other(
                "自分自身を削除することはできません".to_string(),
            ));
        }

        // AssertSqlSafe: see the note at the top of this file.
        let sql = format!(
            "DELETE FROM users WHERE id = {} AND kind = 'account' \
             RETURNING id, username, display_name, role, created_at, version",
            self.db.dialect().placeholder(1)
        );
        let guard_sql = format!(
            "SELECT {GUARD_COLUMNS} FROM users WHERE id = {}",
            self.db.dialect().placeholder(1),
        );
        type Deleted = (i64, String, String, String, String, i64);
        let deleted: Option<UserSummary> = with_users_write_transaction!(&self.db, |tx| {
            let guard: Option<GuardRow> = sqlx::query_as(sqlx::AssertSqlSafe(guard_sql))
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?;
            // A missing row stays NotFound (below) even with a version.
            if let Some(g) = guard.as_ref() {
                ensure_account_row(g)?;
                check_version(expected_version, &guard_summary(g)?)?;
            }
            let another_admin = another_admin_can_log_in!(&mut *tx, id);
            ensure_admin_removal_allowed(id, guard.map(|g| (g.0, another_admin)), true)?;
            let row: Option<Deleted> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(banto_storage::storage_error)?;
            // Convert before commit: an unexpected role must roll the delete back,
            // never leave a deleted user with a failed, unaudited response.
            row.map(|(id, username, display_name, role, created_at, version)| {
                Ok(UserSummary {
                    id,
                    username,
                    display_name,
                    role: Role::from_str(&role)?,
                    kind: UserKind::Account,
                    created_at,
                    version,
                })
            })
            .transpose()?
        });
        deleted.ok_or_else(|| BantoError::NotFound {
            resource: "users".to_string(),
            id: id.to_string(),
        })
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
                password_hash TEXT,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
                auth_epoch INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'builtin')),
                account_uid TEXT UNIQUE,
                CHECK ((kind = 'builtin') = (password_hash IS NULL)),
                CHECK ((kind = 'builtin') = (account_uid IS NULL))
            )",
        )
        .execute(
            db.as_sqlite()
                .expect("service tests run on a SQLite handle"),
        )
        .await
        .expect("create users table");
        for sql in [BUILTIN_INDEX_SQL, BUILTIN_ROW_SQL] {
            sqlx::query(sql)
                .execute(db.as_sqlite().unwrap())
                .await
                .expect("built-in row");
        }
        sqlx::query(PERMISSIONS_DDL)
            .execute(db.as_sqlite().unwrap())
            .await
            .expect("create user_permissions table");
        UsersService::new(db)
    }

    /// The accounts of the management list (the built-in row left out).
    async fn list_accounts(svc: &UsersService) -> Vec<UserSummary> {
        svc.list_users()
            .await
            .unwrap()
            .into_iter()
            .filter(|user| user.kind == UserKind::Account)
            .collect()
    }

    /// The built-in row of [`service`]'s database.
    async fn builtin_row(svc: &UsersService) -> UserSummary {
        svc.list_users()
            .await
            .unwrap()
            .into_iter()
            .find(|user| user.kind == UserKind::Builtin)
            .expect("the built-in row")
    }

    /// What the app's `0003_users.sql` / `0014_ui_settings.sql` add around the
    /// built-in `admin` (ADR-0034 §2). MUST be kept in sync with them.
    const BUILTIN_INDEX_SQL: &str =
        "CREATE UNIQUE INDEX idx_users_single_builtin ON users(kind) WHERE kind = 'builtin'";
    const BUILTIN_ROW_SQL: &str = "INSERT INTO users (username, display_name, role, kind) \
         VALUES ('admin', 'admin', 'admin', 'builtin')";

    /// `user_permissions` (Issue #697). MUST be kept in sync with the app's
    /// `migrations-sqlite/0013_user_permissions.sql`.
    const PERMISSIONS_DDL: &str = "CREATE TABLE user_permissions (
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                permission TEXT    NOT NULL,
                granted_by TEXT    NOT NULL,
                granted_at TEXT    NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, permission)
            )";

    #[tokio::test]
    async fn create_delete_details_exclude_credentials_and_return_removed_row() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "owner-secret-password", "Owner", Role::Admin)
            .await
            .unwrap();
        let target = svc
            .create_user("editor", "editor-secret-password", "Editor", Role::Editor)
            .await
            .unwrap();
        let created = user_create_detail(&target);
        assert_eq!(created["username"], "editor");
        assert_eq!(
            created["changes"],
            serde_json::json!([
                { "field": "displayName", "before": null, "after": "Editor" },
                { "field": "role", "before": null, "after": "editor" }
            ])
        );
        let removed = svc
            .delete_user_returning_previous(target.id, Some(owner.id))
            .await
            .unwrap();
        let deleted = user_delete_detail(&removed);
        assert_eq!(deleted["username"], "editor");
        assert_eq!(
            deleted["changes"],
            serde_json::json!([
                { "field": "displayName", "before": "Editor", "after": null },
                { "field": "role", "before": "editor", "after": null }
            ])
        );
        for detail in [created, deleted] {
            assert!(detail.get("parentResource").is_none());
            assert!(detail.get("parentId").is_none());
            let serialized = detail.to_string();
            assert!(!serialized.contains("secret-password"));
            assert!(!serialized.contains("authEpoch"));
            assert!(!serialized.contains("passwordHash"));
        }
        assert!(matches!(
            svc.delete_user_returning_previous(target.id, Some(owner.id))
                .await,
            Err(BantoError::NotFound { .. })
        ));
    }

    /// Cross-review of PR #865: an administrator row whose stored hash the
    /// verifier cannot check is not an administrator that can log in.
    #[tokio::test]
    async fn has_admin_needs_a_hash_the_verifier_can_check() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        assert!(svc.has_admin().await.unwrap());
        let pool = svc.db.as_sqlite().unwrap();
        for broken in [
            "",
            "not-a-hash",
            "$argon2id$v=19$m=19456,t=2,p=1$",
            // An unknown version, parameters argon2 refuses, no salt.
            "$argon2id$v=99$m=65536,t=2,p=1$gZiV/M1gPc22ElAH/Jh1Hw$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno",
            "$argon2id$v=19$m=1,t=0,p=0$gZiV/M1gPc22ElAH/Jh1Hw$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno",
            // A salt that decodes to fewer bytes than argon2 accepts ("salt"),
            // and an output shorter than its minimum.
            "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno",
            "$argon2id$v=19$m=65536,t=2,p=1$gZiV/M1gPc22ElAH/Jh1Hw$QUI",
            // Another scheme's PHC string: parses, but argon2 cannot verify it.
            "$pbkdf2-sha256$i=600000$c29tZXNhbHQ$QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo",
        ] {
            sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
                .bind(broken)
                .bind(owner.id)
                .execute(pool)
                .await
                .unwrap();
            assert!(!svc.has_admin().await.unwrap(), "{broken:?}");
            assert!(svc.verify("owner", "password123").await.unwrap().is_none());
        }
        // A second administrator with a usable hash counts again.
        svc.create_user("second", "password123", "x", Role::Admin)
            .await
            .unwrap();
        assert!(svc.has_admin().await.unwrap());
    }

    /// Cross-review of PR #865: the last-administrator guard asks the same
    /// question as the startup. With a damaged administrator row next to a
    /// good one, the good one cannot be demoted or deleted (the damaged row
    /// is no way in); the damaged one can, and once a second good
    /// administrator exists the first may go.
    #[tokio::test]
    async fn the_last_admin_guard_counts_only_admins_that_can_log_in() {
        let svc = service().await;
        let good = svc
            .create_user("good", "password123", "x", Role::Admin)
            .await
            .unwrap();
        let damaged = svc
            .create_user("damaged", "password123", "x", Role::Admin)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET password_hash = 'not-a-hash' WHERE id = ?")
            .bind(damaged.id)
            .execute(svc.db.as_sqlite().unwrap())
            .await
            .unwrap();
        assert!(svc.has_admin().await.unwrap());

        svc.update_user(good.id, "x", Role::Editor)
            .await
            .expect_err("demoting the only administrator that can log in");
        svc.delete_user(good.id, None)
            .await
            .expect_err("deleting the only administrator that can log in");
        assert!(svc.has_admin().await.unwrap());

        // The damaged row is not what keeps the install administrable.
        svc.delete_user(damaged.id, None).await.unwrap();
        let second = svc
            .create_user("second", "password123", "x", Role::Admin)
            .await
            .unwrap();
        svc.update_user(good.id, "x", Role::Editor).await.unwrap();
        svc.delete_user(second.id, None)
            .await
            .expect_err("now `second` is the last one");
        assert!(svc.has_admin().await.unwrap());
    }

    #[tokio::test]
    async fn has_admin_counts_only_admin_accounts() {
        // ADR-0017 §3 / B3: the lock-down guard of an admin-equivalent grant.
        let svc = service().await;
        assert!(!svc.has_admin().await.unwrap());
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        assert!(svc.has_admin().await.unwrap());
        // Demoting the only admin is refused, so has_admin stays true...
        assert!(svc
            .update_user(owner.id, "オーナー", Role::Editor)
            .await
            .is_err());
        assert!(svc.has_admin().await.unwrap());
        // ...and an install of editors/viewers only is initialized but has no admin.
        let second = svc
            .create_user("owner2", "password123", "オーナー2", Role::Admin)
            .await
            .unwrap();
        svc.update_user(owner.id, "オーナー", Role::Editor)
            .await
            .unwrap();
        assert!(svc.has_admin().await.unwrap());
        svc.delete_user(second.id, Some(owner.id))
            .await
            .unwrap_err(); // last admin
        assert!(svc.has_admin().await.unwrap());
    }

    #[tokio::test]
    async fn delete_user_without_an_acting_id_skips_only_the_self_check() {
        // A grant session (ADR-0017 §3): no row of its own, so no self
        // check - but the last-admin guard is unchanged.
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();
        let err = svc.delete_user(owner.id, None).await.unwrap_err();
        assert!(matches!(err, BantoError::Other(_)), "{err:?}");
        svc.delete_user(editor.id, None).await.unwrap();
        assert_eq!(list_accounts(&svc).await.len(), 1);
    }

    #[tokio::test]
    async fn verify_wrong_password_is_none() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
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
    async fn verify_oversized_username_is_none_like_an_unknown_user() {
        let svc = service().await;
        let huge = "a".repeat(64 * 1024);
        assert!(svc.verify(&huge, "whatever1").await.unwrap().is_none());
    }

    #[test]
    fn bound_username_for_audit_keeps_short_names_and_cuts_long_ones_on_a_char_boundary() {
        let exact = "a".repeat(MAX_USERNAME_LEN);
        assert_eq!(bound_username_for_audit(&exact), exact);
        assert_eq!(bound_username_for_audit("山田"), "山田");

        let long = "あ".repeat(1000);
        let bounded = bound_username_for_audit(&long);
        assert_eq!(bounded.chars().count(), MAX_USERNAME_LEN);
        assert!(bounded.ends_with('…'));
        assert!(bounded.starts_with("ああ"));
    }

    #[tokio::test]
    async fn create_user_rejects_short_password() {
        let svc = service().await;
        let err = svc
            .create_user("owner", "short", "オーナー", Role::Admin)
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
    async fn create_user_rejects_blank_username() {
        let svc = service().await;
        let err = svc
            .create_user("   ", "password123", "オーナー", Role::Admin)
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
    }

    #[tokio::test]
    async fn create_user_rejects_username_with_dot() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let err = svc
            .create_user("a.b", "password123", "別オーナー", Role::Editor)
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
    async fn verify_succeeds_for_a_preexisting_username_with_dot() {
        let svc = service().await;
        let hash = hash_password("password123").unwrap();
        sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, account_uid) \
             VALUES (?, ?, ?, 'fixture-uid')",
        )
        .bind("old.user")
        .bind(hash)
        .bind("旧アカウント")
        .execute(svc.db.as_sqlite().expect("sqlite"))
        .await
        .unwrap();
        let id = svc.verify("old.user", "password123").await.unwrap();
        assert_eq!(id.expect("login works").username, "old.user");
    }

    #[tokio::test]
    async fn duplicate_username_on_a_future_create_path_is_a_storage_error() {
        // This exercises the UNIQUE constraint directly (a write that skips
        // `create_user`'s own duplicate check).
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let hash = hash_password("password123").unwrap();
        let pool = svc
            .db
            .as_sqlite()
            .expect("service tests run on a SQLite handle");
        let err = sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, account_uid) \
             VALUES (?, ?, ?, 'fixture-uid')",
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
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
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
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
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
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
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
    async fn create_list_update_reset_password_and_delete_round_trip() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();

        let created = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .expect("create_user should succeed");
        assert_eq!(created.role, Role::Editor);

        let listed = list_accounts(&svc).await;
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

        svc.delete_user(created.id, Some(owner.id))
            .await
            .expect("delete_user should succeed");
        assert_eq!(list_accounts(&svc).await.len(), 1);
    }

    #[tokio::test]
    async fn create_user_rejects_duplicate_username() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
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
            .create_user("owner", "password123", "オーナー", Role::Admin)
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
            .create_user("owner", "password123", "オーナー", Role::Admin)
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

    // --- Issue #651: optimistic lock (version) ------------------------------

    #[tokio::test]
    async fn user_version_starts_at_1_and_each_update_bumps_it() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();
        let version_of = |users: Vec<UserSummary>| {
            users
                .into_iter()
                .find(|u| u.id == editor.id)
                .unwrap()
                .version
        };
        assert_eq!(version_of(svc.list_users().await.unwrap()), 1);

        let (prev, next) = svc
            .update_user_checked_returning_previous(editor.id, "A", Role::Editor, Some(1))
            .await
            .unwrap();
        assert_eq!((prev.version, next.version), (1, 2));
        // The old (unchecked) entry point bumps too.
        let next = svc.update_user(editor.id, "B", Role::Editor).await.unwrap();
        assert_eq!(next.version, 3);
        // `version` never appears in the audit diff.
        let (prev, next) = svc
            .update_user_returning_previous(editor.id, "B", Role::Editor)
            .await
            .unwrap();
        assert_eq!(next.version, 4);
        assert_eq!(
            user_update_detail(&prev, &next)["changes"],
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn update_with_a_stale_version_conflicts_with_the_current_row_and_writes_nothing() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();
        svc.update_user_checked_returning_previous(editor.id, "先", Role::Editor, Some(1))
            .await
            .unwrap();

        let err = svc
            .update_user_checked_returning_previous(editor.id, "後", Role::Viewer, Some(1))
            .await
            .unwrap_err();
        let BantoError::Conflict { current, .. } = err else {
            panic!("expected Conflict, got {err:?}");
        };
        let current = current.expect("conflict carries the current row");
        assert_eq!(current["displayName"], "先");
        assert_eq!(current["version"], 2);
        assert!(current.get("authEpoch").is_none());

        let row = svc
            .list_users()
            .await
            .unwrap()
            .into_iter()
            .find(|u| u.id == editor.id)
            .unwrap();
        assert_eq!(
            (row.display_name.as_str(), row.role, row.version),
            ("先", Role::Editor, 2)
        );
        // A role demotion that conflicted did not move auth_epoch either.
        let identity = svc.get_by_username("editor1").await.unwrap().unwrap();
        assert_eq!(identity.auth_epoch, 0);

        // 0 / negative / future versions are conflicts too; None overwrites.
        for v in [0, -1, 99] {
            assert!(matches!(
                svc.update_user_checked_returning_previous(editor.id, "x", Role::Editor, Some(v))
                    .await,
                Err(BantoError::Conflict { .. })
            ));
        }
        svc.update_user_checked_returning_previous(editor.id, "強制", Role::Editor, None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn password_changes_do_not_bump_the_user_version() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();
        svc.reset_password(editor.id, "another-password-1")
            .await
            .unwrap();
        svc.change_password("editor1", "another-password-1", "third-password-12")
            .await
            .unwrap();
        let row = svc
            .list_users()
            .await
            .unwrap()
            .into_iter()
            .find(|u| u.id == editor.id)
            .unwrap();
        assert_eq!(row.version, 1);
    }

    #[tokio::test]
    async fn delete_with_a_stale_version_conflicts_and_keeps_the_row() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();
        svc.update_user(editor.id, "改", Role::Editor)
            .await
            .unwrap();

        let err = svc
            .delete_user_checked_returning_previous(editor.id, Some(owner.id), Some(1))
            .await
            .unwrap_err();
        let BantoError::Conflict { current, .. } = err else {
            panic!("expected Conflict, got {err:?}");
        };
        assert_eq!(current.unwrap()["version"], 2);
        assert_eq!(list_accounts(&svc).await.len(), 2);

        let removed = svc
            .delete_user_checked_returning_previous(editor.id, Some(owner.id), Some(2))
            .await
            .unwrap();
        assert_eq!(removed.version, 2);
        assert_eq!(list_accounts(&svc).await.len(), 1);
        // A missing row is NotFound, not a conflict, even with a version.
        assert!(matches!(
            svc.delete_user_checked_returning_previous(editor.id, Some(owner.id), Some(2))
                .await,
            Err(BantoError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn the_last_admin_guard_still_applies_with_a_matching_version() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        assert!(svc
            .update_user_checked_returning_previous(owner.id, "オーナー", Role::Viewer, Some(1))
            .await
            .is_err());
        assert!(svc
            .delete_user_checked_returning_previous(owner.id, None, Some(1))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn update_user_returning_previous_gives_before_and_after_and_detail() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();

        // display name only
        let (prev, next) = svc
            .update_user_returning_previous(editor.id, "編集者1改", Role::Editor)
            .await
            .unwrap();
        assert_eq!(prev.display_name, "編集者1");
        assert_eq!(next.display_name, "編集者1改");
        let detail = user_update_detail(&prev, &next);
        assert_eq!(detail["username"], "editor1");
        assert!(detail.get("parentResource").is_none());
        assert!(detail.get("parentId").is_none());
        assert_eq!(detail["role"], "editor");
        assert_eq!(
            detail["changes"],
            serde_json::json!([
                { "field": "displayName", "before": "編集者1", "after": "編集者1改" }
            ])
        );

        // role change
        let (prev, next) = svc
            .update_user_returning_previous(editor.id, "編集者1改", Role::Viewer)
            .await
            .unwrap();
        assert_eq!(
            user_update_detail(&prev, &next)["changes"],
            serde_json::json!([{ "field": "role", "before": "editor", "after": "viewer" }])
        );

        // no change -> empty
        let (prev, next) = svc
            .update_user_returning_previous(editor.id, "編集者1改", Role::Viewer)
            .await
            .unwrap();
        assert_eq!(
            user_update_detail(&prev, &next)["changes"],
            serde_json::json!([])
        );

        // guard still applies; missing row -> NotFound
        assert!(svc
            .update_user_returning_previous(owner.id, "オーナー", Role::Viewer)
            .await
            .is_err());
        let err = svc
            .update_user_returning_previous(9999, "x", Role::Viewer)
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::NotFound { .. }));
    }

    #[tokio::test]
    async fn delete_user_rejects_deleting_the_last_admin() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();

        // `editor1` deletes `owner` (the only admin) - must be rejected.
        let err = svc
            .delete_user(owner.id, Some(editor.id))
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Other(_)));
        assert_eq!(list_accounts(&svc).await.len(), 2);
    }

    #[tokio::test]
    async fn delete_user_rejects_self_deletion() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        svc.create_user("owner2", "password123", "オーナー2", Role::Admin)
            .await
            .unwrap();

        // Even though a second admin exists, `owner` may not delete itself.
        let err = svc.delete_user(owner.id, Some(owner.id)).await.unwrap_err();
        assert!(matches!(err, BantoError::Other(_)));
        assert_eq!(list_accounts(&svc).await.len(), 2);
    }

    #[tokio::test]
    async fn delete_user_missing_id_is_not_found() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let err = svc.delete_user(999, Some(owner.id)).await.unwrap_err();
        assert!(
            matches!(err, BantoError::NotFound { resource, id } if resource == "users" && id == "999")
        );
    }

    #[tokio::test]
    async fn get_by_username_finds_and_misses() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
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

    // --- Issue #204: auth_epoch (session revocation) ------------------------

    async fn epoch_of(svc: &UsersService, username: &str) -> i64 {
        svc.get_by_username(username)
            .await
            .unwrap()
            .expect("account exists")
            .auth_epoch
    }

    #[tokio::test]
    async fn new_accounts_start_at_epoch_zero_everywhere_they_are_read() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();
        assert_eq!((owner.auth_epoch, editor.auth_epoch), (0, 0));
        let verified = svc.verify("editor1", "password123").await.unwrap().unwrap();
        assert_eq!(verified.auth_epoch, 0);
        assert_eq!(verified.id, editor.id);
    }

    #[tokio::test]
    async fn role_change_password_change_and_reset_each_advance_the_epoch() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();

        // Display-name-only edit: sessions survive.
        svc.update_user(editor.id, "改名", Role::Editor)
            .await
            .unwrap();
        assert_eq!(epoch_of(&svc, "editor1").await, 0);

        // Demotion and promotion are both role changes.
        svc.update_user(editor.id, "改名", Role::Viewer)
            .await
            .unwrap();
        assert_eq!(epoch_of(&svc, "editor1").await, 1);
        svc.update_user(editor.id, "改名", Role::Admin)
            .await
            .unwrap();
        assert_eq!(epoch_of(&svc, "editor1").await, 2);

        // Self-service change returns the epoch it wrote.
        let returned = svc
            .change_password("editor1", "password123", "newpassword1")
            .await
            .unwrap();
        assert_eq!(returned, 3);
        assert_eq!(epoch_of(&svc, "editor1").await, 3);

        svc.reset_password(editor.id, "resetpassword1")
            .await
            .unwrap();
        assert_eq!(epoch_of(&svc, "editor1").await, 4);
        let verified = svc
            .verify("editor1", "resetpassword1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(verified.auth_epoch, 4);
    }

    #[tokio::test]
    async fn refused_updates_and_failed_password_changes_keep_the_epoch() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        // Last-admin refusal rolls back, epoch included.
        svc.update_user(owner.id, "オーナー", Role::Viewer)
            .await
            .unwrap_err();
        svc.change_password("owner", "wrong-password", "newpassword1")
            .await
            .unwrap_err();
        svc.change_password("owner", "password123", "short")
            .await
            .unwrap_err();
        assert_eq!(epoch_of(&svc, "owner").await, 0);
    }

    #[tokio::test]
    async fn epoch_changes_leave_other_accounts_untouched() {
        let svc = service().await;
        svc.create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let editor = svc
            .create_user("editor1", "password123", "編集者1", Role::Editor)
            .await
            .unwrap();
        svc.update_user(editor.id, "編集者1", Role::Viewer)
            .await
            .unwrap();
        svc.reset_password(editor.id, "resetpassword1")
            .await
            .unwrap();
        assert_eq!(epoch_of(&svc, "owner").await, 0);
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
                password_hash TEXT,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
                auth_epoch INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'builtin')),
                account_uid TEXT UNIQUE,
                CHECK ((kind = 'builtin') = (password_hash IS NULL)),
                CHECK ((kind = 'builtin') = (account_uid IS NULL))
            )",
        )
        .execute(&first_pool)
        .await
        .unwrap();
        sqlx::query(PERMISSIONS_DDL)
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
                "INSERT INTO users (id, username, password_hash, display_name, role, account_uid) VALUES
                 (1, 'owner1', '$argon2id$v=19$m=65536,t=2,p=1$gZiV/M1gPc22ElAH/Jh1Hw$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno', 'Original 1', 'admin', 'uid-1'),
                 (2, 'owner2', '$argon2id$v=19$m=65536,t=2,p=1$gZiV/M1gPc22ElAH/Jh1Hw$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno', 'Original 2', 'admin', 'uid-2')",
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
                    svc.delete_user(id, Some(3 - id)).await
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

    // --- Issue #697: per-user permissions -----------------------------------

    fn key(raw: &str) -> PermissionKey {
        PermissionKey::parse(raw).unwrap()
    }

    fn test_catalog() -> PermissionCatalog {
        PermissionCatalog::empty()
            .register("equipment.operate", "perm.operate", "perm.operate_desc")
            .unwrap()
            .register("alarm.ack", "perm.ack", "perm.ack_desc")
            .unwrap()
    }

    /// An owner (admin) and an operator (viewer) on a service with the test
    /// catalog.
    async fn permission_fixture() -> (UsersService, UserIdentity, UserIdentity) {
        let svc = service().await.with_permission_catalog(test_catalog());
        let owner = svc
            .create_user("owner", "owner-secret-password", "Owner", Role::Admin)
            .await
            .unwrap();
        let operator = svc
            .create_user("operator", "operator-password", "Operator", Role::Viewer)
            .await
            .unwrap();
        assert!(svc.permissions_of(operator.id).await.unwrap().is_empty());
        (svc, owner, operator)
    }

    async fn summary_of(svc: &UsersService, id: i64) -> UserSummary {
        svc.list_users()
            .await
            .unwrap()
            .into_iter()
            .find(|u| u.id == id)
            .unwrap()
    }

    #[tokio::test]
    async fn set_permissions_grants_and_revokes_with_a_diff_and_a_version_bump() {
        let (svc, _owner, op) = permission_fixture().await;
        let diff = svc
            .set_permissions(op.id, &[key("equipment.operate")], Some(1), "owner")
            .await
            .unwrap();
        assert_eq!(diff.added, vec![key("equipment.operate")]);
        assert!(diff.removed.is_empty());
        assert_eq!(summary_of(&svc, op.id).await.version, 2);
        let granted_by: String = sqlx::query_scalar(
            "SELECT granted_by FROM user_permissions WHERE user_id = ? AND permission = ?",
        )
        .bind(op.id)
        .bind("equipment.operate")
        .fetch_one(svc.db.as_sqlite().unwrap())
        .await
        .unwrap();
        assert_eq!(granted_by, "owner");

        // Replace: one removed, one added; the role is untouched and the
        // sessions are kept (no auth_epoch change).
        let diff = svc
            .set_permissions(op.id, &[key("alarm.ack")], Some(2), "owner")
            .await
            .unwrap();
        assert_eq!(
            (diff.added, diff.removed),
            (vec![key("alarm.ack")], vec![key("equipment.operate")])
        );
        let me = svc.get_by_username("operator").await.unwrap().unwrap();
        assert_eq!(me.role, Role::Viewer);
        assert_eq!(me.auth_epoch, op.auth_epoch);
        let session = svc.session_permissions(op.id).await.unwrap();
        assert!(session.has(&key("alarm.ack")));
        assert!(!session.has(&key("equipment.operate")));
        assert_eq!(
            svc.permissions_of(op.id).await.unwrap(),
            vec![key("alarm.ack")]
        );
        let by_user = svc.permissions_by_user().await.unwrap();
        assert_eq!(by_user.get(&op.id), Some(&vec![key("alarm.ack")]));
        assert!(!by_user.contains_key(&_owner.id));

        // The same set again changes nothing and does not bump the version.
        let diff = svc
            .set_permissions(op.id, &[key("alarm.ack")], None, "owner")
            .await
            .unwrap();
        assert!(diff.is_empty());
        assert_eq!(summary_of(&svc, op.id).await.version, 3);
    }

    #[tokio::test]
    async fn set_permissions_rejects_unknown_keys_and_stale_versions_writing_nothing() {
        let (svc, _owner, op) = permission_fixture().await;
        match svc
            .set_permissions(op.id, &[key("other.thing")], None, "owner")
            .await
        {
            Err(BantoError::Validation { field_errors }) => {
                assert_eq!(field_errors[0].field, "permissions")
            }
            other => panic!("expected Validation, got {other:?}"),
        }
        match svc
            .set_permissions(op.id, &[key("alarm.ack")], Some(7), "owner")
            .await
        {
            Err(BantoError::Conflict { current, .. }) => {
                assert_eq!(current.unwrap()["version"], 1)
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
        assert!(svc.permissions_of(op.id).await.unwrap().is_empty());
        assert_eq!(summary_of(&svc, op.id).await.version, 1);
        assert!(matches!(
            svc.set_permissions(9999, &[], None, "owner").await,
            Err(BantoError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn unregistered_stored_keys_are_not_held_but_can_be_kept_or_dropped() {
        let (svc, _owner, op) = permission_fixture().await;
        svc.set_permissions(op.id, &[key("alarm.ack")], None, "owner")
            .await
            .unwrap();
        // The app stops registering `alarm.ack`.
        let narrowed = svc.clone().with_permission_catalog(
            PermissionCatalog::empty()
                .register("equipment.operate", "a", "b")
                .unwrap(),
        );
        assert!(
            narrowed
                .session_permissions(op.id)
                .await
                .unwrap()
                .is_empty(),
            "an unregistered key is not held"
        );
        // Still stored, and listed for the admin screen.
        assert_eq!(
            narrowed.permissions_of(op.id).await.unwrap(),
            vec![key("alarm.ack")]
        );
        // Sending it back keeps it; leaving it out drops it.
        let kept = narrowed
            .set_permissions(
                op.id,
                &[key("alarm.ack"), key("equipment.operate")],
                None,
                "owner",
            )
            .await
            .unwrap();
        assert_eq!(kept.added, vec![key("equipment.operate")]);
        assert!(kept.removed.is_empty());
        let dropped = narrowed
            .set_permissions(op.id, &[key("equipment.operate")], None, "owner")
            .await
            .unwrap();
        assert_eq!(dropped.removed, vec![key("alarm.ack")]);
    }

    #[tokio::test]
    async fn update_with_permissions_is_one_write_with_one_version_bump_and_an_audit_entry() {
        let (svc, _owner, op) = permission_fixture().await;
        svc.set_permissions(op.id, &[key("alarm.ack")], None, "owner")
            .await
            .unwrap();
        // `None` leaves the permissions as they are.
        let out = svc
            .update_user_with_permissions(op.id, "Op", Role::Viewer, None, Some(2), "owner")
            .await
            .unwrap();
        assert_eq!(out.permissions, vec![key("alarm.ack")]);
        assert!(out.permission_diff.is_empty());
        assert_eq!(out.updated.version, 3);
        assert_eq!(
            user_update_detail_with_permissions(&out.previous, &out.updated, &out.permission_diff)
                ["changes"],
            serde_json::json!([{ "field": "displayName", "before": "Operator", "after": "Op" }])
        );

        // `Some` replaces them in the same write: one bump.
        let out = svc
            .update_user_with_permissions(
                op.id,
                "Op",
                Role::Editor,
                Some(&[key("equipment.operate")]),
                Some(3),
                "owner",
            )
            .await
            .unwrap();
        assert_eq!(out.updated.version, 4);
        assert_eq!(out.permissions, vec![key("equipment.operate")]);
        assert_eq!(
            user_update_detail_with_permissions(&out.previous, &out.updated, &out.permission_diff)
                ["changes"],
            serde_json::json!([
                {
                    "field": "permissions",
                    "added": ["equipment.operate"],
                    "removed": ["alarm.ack"]
                },
                { "field": "role", "before": "viewer", "after": "editor" }
            ])
        );
        // The existing detail function is unchanged: no permissions entry.
        assert_eq!(
            user_update_detail(&out.previous, &out.updated)["changes"],
            serde_json::json!([{ "field": "role", "before": "viewer", "after": "editor" }])
        );

        // A rejected permission rolls the whole update back.
        let err = svc
            .update_user_with_permissions(
                op.id,
                "Renamed",
                Role::Editor,
                Some(&[key("not.registered")]),
                Some(4),
                "owner",
            )
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }));
        let row = summary_of(&svc, op.id).await;
        assert_eq!((row.display_name.as_str(), row.version), ("Op", 4));
        assert_eq!(
            svc.permissions_of(op.id).await.unwrap(),
            vec![key("equipment.operate")]
        );

        // A stale version is the same conflict as before.
        match svc
            .update_user_with_permissions(op.id, "X", Role::Editor, Some(&[]), Some(1), "owner")
            .await
        {
            Err(BantoError::Conflict { current, .. }) => {
                assert_eq!(current.unwrap()["version"], 4)
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn deleting_a_user_cascades_its_permissions() {
        let (svc, owner, op) = permission_fixture().await;
        svc.set_permissions(
            op.id,
            &[key("alarm.ack"), key("equipment.operate")],
            None,
            "owner",
        )
        .await
        .unwrap();
        svc.delete_user_returning_previous(op.id, Some(owner.id))
            .await
            .unwrap();
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_permissions")
            .fetch_one(svc.db.as_sqlite().unwrap())
            .await
            .unwrap();
        assert_eq!(left, 0, "ON DELETE CASCADE removes the rows");
    }

    // --- ADR-0034 §2: the built-in `admin` row -------------------------------

    /// ADR-0034 §10 (C1): the management list returns the built-in row as one
    /// read-only row; the counts and `has_admin` leave it out, and the first
    /// setup and ordinary creation work on a database that has only that row.
    #[tokio::test]
    async fn the_builtin_row_is_listed_but_never_counted() {
        let svc = service().await;
        let builtin = builtin_row(&svc).await;
        assert_eq!(builtin.username, "admin");
        assert_eq!(builtin.role, Role::Admin);
        assert_eq!(
            serde_json::to_value(&builtin).unwrap()["kind"],
            serde_json::json!("builtin")
        );
        assert!(!svc.has_admin().await.unwrap());
        assert!(svc.get_by_username("admin").await.unwrap().is_none());

        let first = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .expect("an account is created beside the built-in row");
        assert_ne!(first.id, builtin.id);
        assert!(svc.has_admin().await.unwrap());
        svc.create_user("viewer1", "password123", "閲覧者", Role::Viewer)
            .await
            .expect("ordinary creation works");
        let listed = svc.list_users().await.unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(list_accounts(&svc).await.len(), 2);
        assert_eq!(
            serde_json::to_value(&list_accounts(&svc).await[0]).unwrap()["kind"],
            serde_json::json!("account")
        );
    }

    /// ADR-0034 §2: the built-in row cannot log in - not with any password,
    /// and not even if a password hash were somehow asked for by name.
    #[tokio::test]
    async fn the_builtin_row_cannot_log_in_or_change_its_password() {
        let svc = service().await;
        for password in ["", "admin", "password123"] {
            assert!(svc.verify("admin", password).await.unwrap().is_none());
        }
        let err = svc
            .change_password("admin", "admin", "new-password-1")
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }), "{err:?}");
    }

    /// ADR-0034 §2: update (rename/role), password reset, permission grants
    /// and delete all refuse the built-in row, and leave it as it was.
    #[tokio::test]
    async fn every_write_aimed_at_the_builtin_row_is_refused() {
        let catalog = PermissionCatalog::empty()
            .register("alarm.ack", "a", "b")
            .unwrap();
        let svc = service().await.with_permission_catalog(catalog);
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let before = builtin_row(&svc).await;
        let refused = |err: BantoError| {
            assert!(
                matches!(err, BantoError::Forbidden),
                "expected the built-in refusal, got {err:?}"
            )
        };

        refused(
            svc.update_user(before.id, "改名", Role::Viewer)
                .await
                .unwrap_err(),
        );
        refused(
            svc.reset_password(before.id, "password123")
                .await
                .unwrap_err(),
        );
        let key = PermissionKey::parse("alarm.ack").unwrap();
        refused(
            svc.set_permissions(before.id, std::slice::from_ref(&key), None, "owner")
                .await
                .unwrap_err(),
        );
        refused(
            svc.update_user_with_permissions(
                before.id,
                "admin",
                Role::Admin,
                Some(std::slice::from_ref(&key)),
                None,
                "owner",
            )
            .await
            .unwrap_err(),
        );
        refused(
            svc.delete_user(before.id, Some(owner.id))
                .await
                .unwrap_err(),
        );
        refused(svc.delete_user(before.id, None).await.unwrap_err());

        assert_eq!(builtin_row(&svc).await, before);
        assert!(svc.permissions_of(before.id).await.unwrap().is_empty());
        assert!(svc.verify("admin", "password123").await.unwrap().is_none());
    }

    /// The last-admin guard counts accounts only (ADR-0034 §2): with the
    /// built-in row present, the one human admin still cannot be removed.
    #[tokio::test]
    async fn the_builtin_row_does_not_count_as_the_last_admin() {
        let svc = service().await;
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        assert!(svc.delete_user(owner.id, None).await.is_err());
        assert!(svc
            .update_user(owner.id, "オーナー", Role::Viewer)
            .await
            .is_err());
        assert_eq!(list_accounts(&svc).await.len(), 1);
    }

    /// ADR-0034 §1: every created account gets its own `account_uid` (128
    /// bits, hex); neither a rename nor a role change touches it, and a name
    /// used again gets a new one.
    #[tokio::test]
    async fn an_account_uid_is_assigned_at_creation_and_never_reused() {
        let svc = service().await;
        let pool = svc.db.as_sqlite().unwrap().clone();
        let uid_of = |id: i64| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>(
                    "SELECT account_uid FROM users WHERE id = ?",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .expect("an account has an account_uid")
            }
        };
        let owner = svc
            .create_user("owner", "password123", "オーナー", Role::Admin)
            .await
            .unwrap();
        let first = svc
            .create_user("op", "password123", "Op", Role::Editor)
            .await
            .unwrap();
        let owner_uid = uid_of(owner.id).await;
        let first_uid = uid_of(first.id).await;
        assert_ne!(owner_uid, first_uid);
        for uid in [&owner_uid, &first_uid] {
            assert_eq!(uid.len(), 32, "{uid}");
            assert!(uid.chars().all(|c| c.is_ascii_hexdigit()), "{uid}");
        }

        svc.update_user(first.id, "Op 2", Role::Viewer)
            .await
            .unwrap();
        svc.reset_password(first.id, "password456").await.unwrap();
        assert_eq!(uid_of(first.id).await, first_uid);

        svc.delete_user(first.id, Some(owner.id)).await.unwrap();
        let again = svc
            .create_user("op", "password123", "Op", Role::Editor)
            .await
            .unwrap();
        assert_ne!(uid_of(again.id).await, first_uid);
    }

    // --- ADR-0034 section 4: reserved names and the startup check ------------

    /// `admin` is reserved by the service itself, the wiring adds the
    /// grants' fixed ids; both are compared ignoring case, at the first-run
    /// setup and at `create_user`. Other names are untouched.
    #[tokio::test]
    async fn reserved_usernames_are_refused_ignoring_case() {
        let plain = service().await;
        for name in ["Admin", "ADMIN", " admin "] {
            let err = plain
                .create_user(name, "password123", "x", Role::Viewer)
                .await
                .unwrap_err();
            assert!(
                matches!(err, BantoError::Validation { .. }),
                "{name}: {err:?}"
            );
        }
        let err = plain
            .create_user("ADMIN", "password123", "x", Role::Admin)
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Validation { .. }), "{err:?}");
        // Without the wiring's list, a grant's id is an ordinary name.
        plain
            .create_user("public", "password123", "x", Role::Viewer)
            .await
            .expect("not reserved by the service itself");

        let wired = service()
            .await
            .with_reserved_usernames(ReservedUsernames::new(["public", "Commissioning"]));
        for name in ["public", "Public", "COMMISSIONING", "admin"] {
            let err = wired
                .create_user(name, "password123", "x", Role::Viewer)
                .await
                .unwrap_err();
            assert!(
                matches!(err, BantoError::Validation { .. }),
                "{name}: {err:?}"
            );
        }
        wired
            .create_user("publican", "password123", "x", Role::Viewer)
            .await
            .expect("only an exact name is reserved");
        assert_eq!(
            wired.reserved_usernames().iter().collect::<Vec<_>>(),
            vec!["admin", "commissioning", "public"]
        );
    }

    /// The startup check reports the built-in row's id (read by `kind`), and
    /// stops on a missing built-in row or on an account that has a reserved
    /// name - the case of a grant added after the account was created.
    #[tokio::test]
    async fn check_startup_finds_the_builtin_row_and_reserved_name_collisions() {
        let svc = service().await;
        let builtin = builtin_row(&svc).await;
        assert_eq!(
            svc.check_startup().await.unwrap(),
            StartupUsers {
                builtin_admin_id: builtin.id
            }
        );

        // An account created before the app registered a grant with its name.
        svc.create_user("Kiosk", "password123", "x", Role::Viewer)
            .await
            .unwrap();
        svc.check_startup()
            .await
            .expect("the name is not reserved yet");
        let with_grant = svc
            .clone()
            .with_reserved_usernames(ReservedUsernames::new(["kiosk"]));
        let err = with_grant.check_startup().await.unwrap_err();
        assert!(err.to_string().contains("Kiosk"), "{err}");

        // A built-in row that is not `admin` / role `admin` (the schema pins
        // neither): reported with what was found, never corrected.
        let pool = svc.db.as_sqlite().expect("sqlite test service");
        for (edit, undo, found) in [
            (
                "UPDATE users SET username = 'root' WHERE kind = 'builtin'",
                "UPDATE users SET username = 'admin' WHERE kind = 'builtin'",
                "root",
            ),
            (
                "UPDATE users SET username = 'Admin' WHERE kind = 'builtin'",
                "UPDATE users SET username = 'admin' WHERE kind = 'builtin'",
                "Admin",
            ),
            (
                "UPDATE users SET role = 'viewer' WHERE kind = 'builtin'",
                "UPDATE users SET role = 'admin' WHERE kind = 'builtin'",
                "viewer",
            ),
        ] {
            sqlx::query(edit).execute(pool).await.unwrap();
            let err = svc.check_startup().await.unwrap_err();
            assert!(err.to_string().contains(found), "{edit}: {err}");
            sqlx::query(undo).execute(pool).await.unwrap();
        }
        svc.check_startup().await.expect("restored by the test");

        // No built-in row: reported, never repaired.
        sqlx::query("DELETE FROM users WHERE kind = 'builtin'")
            .execute(pool)
            .await
            .unwrap();
        let err = svc.check_startup().await.unwrap_err();
        assert!(err.to_string().contains("組み込みのユーザー"), "{err}");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE kind = 'builtin'")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "the check writes nothing");
    }
}
