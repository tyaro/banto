//! App settings storage (spec §12.1 `SettingsProvider` role): a
//! `key`/`value` table in the local SQLite settings DB, plus a typed view
//! over the embedded-server settings (spec §11.4's LAN-access toggle +
//! bind/port fields).
//!
//! Moved from `admin-template-core::settings` to this crate in theme C PR-C1
//! (docs/template-scope.md §7 移行順 ①): the logic is domain-agnostic
//! (identical for any app regardless of which resources it has), so it
//! belongs in the shared crate rather than in code every adopter copies.

use std::str::FromStr;

use banto_core::{BantoError, FieldError};
use banto_storage::Db;
use serde::{Deserialize, Serialize};

use crate::permissions::{PermissionCatalog, PermissionKey};
use crate::rbac::Role;
use crate::users::UsersService;

const KEY_SERVER_ENABLED: &str = "server.enabled";
const KEY_SERVER_BIND: &str = "server.bind";
const KEY_SERVER_PORT: &str = "server.port";
const KEY_SERVER_VIEWER_PUBLIC: &str = "server.viewer_public";
const KEY_AUTH_DISABLED: &str = "auth.disabled";
const KEY_AUTH_DISABLED_ROLE: &str = "auth.disabled_role";
const KEY_AUTH_DISABLED_PERMISSIONS: &str = "auth.disabled_permissions";
const KEY_AUTOLOGIN_ENABLED: &str = "auth.autologin.enabled";
const KEY_AUTOLOGIN_USERNAME: &str = "auth.autologin.username";
const KEY_AUDIT_RETENTION_DAYS: &str = "audit.retention_days";
const KEY_AUDIT_RETENTION_ROWS: &str = "audit.retention_rows";
const KEY_LOGIN_NOTICE: &str = "login.notice";
/// Marker row of the first-boot seed (ADR-0034 §5): present once the seed has
/// run on this database. Written in the same transaction as the seeded rows,
/// and restored with the database (a backup of a seeded database is not
/// seeded again).
const KEY_FIRST_BOOT_SEEDED: &str = "first_boot.seeded";

const SEED_UPSERT_SQLITE: &str = "INSERT INTO settings (key, value) VALUES (?, ?) \
     ON CONFLICT(key) DO UPDATE SET value = excluded.value";
#[cfg(feature = "postgres")]
const SEED_UPSERT_POSTGRES: &str = "INSERT INTO settings (key, value) VALUES ($1, $2) \
     ON CONFLICT(key) DO UPDATE SET value = excluded.value";
/// Taking the marker: inserts it, or does nothing when it is already there.
/// One row affected = this transaction is the one that seeds.
const SEED_TAKE_MARKER_SQLITE: &str =
    "INSERT INTO settings (key, value) VALUES (?, 'true') ON CONFLICT(key) DO NOTHING";
#[cfg(feature = "postgres")]
const SEED_TAKE_MARKER_POSTGRES: &str =
    "INSERT INTO settings (key, value) VALUES ($1, 'true') ON CONFLICT(key) DO NOTHING";

/// The first-boot seed on a SQLite connection that is inside the caller's
/// transaction (ADR-0034 §5): take the marker row first, and only the
/// transaction that got it upserts the pairs (a seeded value wins over a row a
/// migration inserted). `Ok(true)` when it wrote, `Ok(false)` when the
/// database was already seeded.
///
/// The marker is taken with one conflict-free INSERT at the start, not read
/// and written at the end: two starts on the same unseeded database cannot
/// both seed. The second one waits on the first's row; when the first commits
/// it sees the marker and writes nothing (settings changed in between stay),
/// and when the first rolls back the marker goes with it and the second seeds.
///
/// Takes the connection, not the service, so a caller that must write more in
/// the same transaction (the headless first-account CLI, ADR-0034 §7) calls
/// this first and then writes its own rows: a setting can never be written
/// before the seed on a database that has no marker yet.
pub async fn seed_first_boot_sqlite(
    conn: &mut sqlx::SqliteConnection,
    pairs: &[(&str, &str)],
) -> Result<bool, BantoError> {
    let taken = sqlx::query(SEED_TAKE_MARKER_SQLITE)
        .bind(KEY_FIRST_BOOT_SEEDED)
        .execute(&mut *conn)
        .await
        .map_err(banto_storage::storage_error)?
        .rows_affected();
    if taken == 0 {
        return Ok(false);
    }
    for (key, value) in pairs {
        sqlx::query(SEED_UPSERT_SQLITE)
            .bind(*key)
            .bind(*value)
            .execute(&mut *conn)
            .await
            .map_err(banto_storage::storage_error)?;
    }
    Ok(true)
}

/// PostgreSQL twin of [`seed_first_boot_sqlite`] (same contract). Under READ
/// COMMITTED the `ON CONFLICT DO NOTHING` insert waits for a concurrent
/// transaction that inserted the same key, then inserts nothing if that one
/// committed.
#[cfg(feature = "postgres")]
pub async fn seed_first_boot_postgres(
    conn: &mut sqlx::PgConnection,
    pairs: &[(&str, &str)],
) -> Result<bool, BantoError> {
    let taken = sqlx::query(SEED_TAKE_MARKER_POSTGRES)
        .bind(KEY_FIRST_BOOT_SEEDED)
        .execute(&mut *conn)
        .await
        .map_err(banto_storage::storage_error)?
        .rows_affected();
    if taken == 0 {
        return Ok(false);
    }
    for (key, value) in pairs {
        sqlx::query(SEED_UPSERT_POSTGRES)
            .bind(*key)
            .bind(*value)
            .execute(&mut *conn)
            .await
            .map_err(banto_storage::storage_error)?;
    }
    Ok(true)
}
pub const MAX_LOGIN_NOTICE_CHARS: usize = 200;

fn invalid_login_notice_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{061C}'
                | '\u{180E}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E007F}'
        )
}

/// Default audit-log retention (spec M14): 90 days / 100,000 rows. There is
/// deliberately no "audit enabled" toggle - the audit trail is a standard
/// part of the template (spec: "監査ログを標準装備する"), only its retention
/// is configurable.
const DEFAULT_AUDIT_RETENTION_DAYS: i64 = 90;
const DEFAULT_AUDIT_RETENTION_ROWS: i64 = 100_000;

/// `0以下は「無制限」として None 扱い` (spec M14): normalizes a parsed
/// retention value so a non-positive number always reads back as "no
/// limit" on this dimension, both right after `set_audit_config` and on any
/// later read.
fn normalize_retention(value: i64) -> Option<i64> {
    if value > 0 {
        Some(value)
    } else {
        None
    }
}

/// Shared by [`SettingsService::audit_config`]'s two fields: an unset key
/// falls back to `default`; a set-but-corrupt (non-numeric) value ALSO falls
/// back to `default` (same convention as `auth_config`'s `disabled_role`
/// fallback); a set, parseable value is normalized (see
/// [`normalize_retention`]) - notably a value of `"0"` here means "the user
/// explicitly chose unlimited", which must NOT fall back to `default`.
fn parse_retention(raw: Option<String>, default: Option<i64>) -> Option<i64> {
    match raw {
        Some(value) => value
            .parse::<i64>()
            .map(normalize_retention)
            .unwrap_or(default),
        None => default,
    }
}

/// Max length (in `char`s) of a per-user UI-settings `key` (spec M12).
const MAX_UI_KEY_LEN: usize = 64;
/// Max length (in bytes) of a per-user UI-settings `value` (spec M12): a
/// dock-layout JSON blob is the largest expected payload; 64KB is generous
/// headroom over that while still bounding the row size.
const MAX_UI_VALUE_LEN: usize = 64 * 1024;

/// Validates a UI-settings `key` (spec M12): `[A-Za-z0-9._-]{1,64}`. The
/// values themselves live in `ui_settings` ([`crate::ui_settings`]).
pub(crate) fn validate_ui_key(key: &str) -> Result<(), BantoError> {
    let ok = !key.is_empty()
        && key.chars().count() <= MAX_UI_KEY_LEN
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "key".to_string(),
                message: format!(
                    "キーは英数字・`.`・`_`・`-` のみ、1〜{MAX_UI_KEY_LEN}文字で指定してください"
                ),
            }],
        })
    }
}

pub(crate) fn validate_ui_value(value: &str) -> Result<(), BantoError> {
    if value.len() > MAX_UI_VALUE_LEN {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "value".to_string(),
                message: format!("値は{}KB以内で指定してください", MAX_UI_VALUE_LEN / 1024),
            }],
        });
    }
    Ok(())
}

/// Embedded-server settings (spec §11.2, §11.4): whether LAN access is
/// enabled, and the bind address/port. Defaults to disabled,
/// localhost-only - "attack surface zero" until the user opts in.
///
/// `viewer_public` (Issue #189, `docs/design/viewer-public-plan.md` §2.3, ADR-0012)
/// is the "閲覧公開" opt-in: when ON, a LAN client may mint a
/// `viewer`-role synthetic session without logging in
/// (`POST /api/auth/grant/publicViewer`, ADR-0017). It defaults to `false`, so an existing
/// install behaves exactly as before. It is deliberately part of the SERVER
/// settings rather than the auth settings: it describes what the LAN
/// surface exposes, and it is what relaxes the auth-disabled/LAN
/// exclusivity guard below.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSettings {
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
    pub viewer_public: bool,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: "127.0.0.1".to_string(),
            port: 8721,
            viewer_public: false,
        }
    }
}

/// Auth-mode settings (spec M11): the "ログイン不要モード" (auth-disabled)
/// toggle + its synthetic-identity role, and the desktop "自動ログイン"
/// (autologin) opt-in + which account it targets.
///
/// `disabled` and (while it is on) `disabled_role` are never defaulted when
/// they are read: a new database gets both from a migration, a save writes
/// both, and [`SettingsService::auth_config`] refuses a database where one is
/// missing or unreadable (ADR-0034 §5). [`Default`] is only a value to build
/// a save from.
///
/// Deliberately does NOT carry the autologin password: that lives only in
/// the OS keyring (`src-tauri`'s `keyring_store` module), never in this
/// SQLite settings DB (spec M11: "設定DBには保存しない").
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSettings {
    pub disabled: bool,
    pub disabled_role: Role,
    pub autologin_enabled: bool,
    pub autologin_username: Option<String>,
}

impl Default for AuthSettings {
    fn default() -> Self {
        Self {
            disabled: false,
            disabled_role: Role::Admin,
            autologin_enabled: false,
            autologin_username: None,
        }
    }
}

/// Audit-log retention settings (spec M14): a days cap and/or a row-count
/// cap for [`crate::audit::AuditLogService::prune`]. `None` on either field
/// means unlimited on that dimension (see [`normalize_retention`]).
/// Defaults to 90 days / 100,000 rows - generous enough not to surprise a
/// fresh install, bounded enough that the table does not grow forever with
/// no configuration at all.
///
/// `Deserialize` (in addition to `Serialize`) is needed from M14 Phase B: the
/// REST layer's `PUT /api/audit-log/config` (`admin_template_core::rest::audit_config_apply`)
/// decodes the request body straight into this type rather than a bespoke
/// request struct - it is a plain two-field settings value with no fields
/// that must never round-trip over the wire (unlike `AuthSettings`, which
/// deliberately has no password field to begin with).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditSettings {
    pub retention_days: Option<i64>,
    pub retention_rows: Option<i64>,
}

impl Default for AuditSettings {
    fn default() -> Self {
        Self {
            retention_days: Some(DEFAULT_AUDIT_RETENTION_DAYS),
            retention_rows: Some(DEFAULT_AUDIT_RETENTION_ROWS),
        }
    }
}

/// Generic key/value settings store, backed by the `settings` table
/// (migration `0002_settings.sql`). Shares the same sqlite pool as
/// `admin_template_core::items::ItemsService` (spec §12.1: app settings live
/// in the local SQLite settings DB alongside/instead of a separate file).
///
/// `Clone` is cheap (`Db` is an `Arc`-backed connection handle), matching
/// `ItemsService`/`UsersService` - needed since M12, when the REST layer's
/// `/api/ui-settings/*` router started carrying its own handle.
#[derive(Clone)]
pub struct SettingsService {
    db: Db,
}

/// Is this auth-mode / LAN-server combination legal? The single source of
/// truth shared by [`SettingsService::set_server_config`],
/// [`SettingsService::set_auth_config`] and the desktop app's startup check
/// (Issue #288 - the startup guard had drifted from the save-time rule).
///
/// "認証無効 + LAN 有効" is only allowed with 閲覧公開 (`viewer_public`) on
/// (spec M11 + Issue #189 / ADR-0012). Every other combination is legal.
pub fn auth_server_combination_allowed(
    auth_disabled: bool,
    server_enabled: bool,
    viewer_public: bool,
) -> bool {
    !(auth_disabled && server_enabled && !viewer_public)
}

/// The refusal of "require login" while no administrator account exists
/// (ADR-0034 §6). One message for the settings save and the wirings.
pub fn lockdown_needs_an_admin() -> BantoError {
    BantoError::Validation {
        field_errors: vec![FieldError {
            field: "disabled".to_string(),
            message: "ログイン必須にするには、先に管理者のアカウントを作ってください".to_string(),
        }],
    }
}

/// A stored auth-mode key that cannot be used (ADR-0034 §5). The remedy is the
/// same for every cause, so it is written once here.
fn broken_auth_setting(cause: &str) -> BantoError {
    BantoError::Other(format!(
        "{cause}。この DB は直接書き換えられたか、壊れている可能性があります。\
         banto-serve の create-admin で管理者を作ってログイン必須に直すか、\
         バックアップから戻してください"
    ))
}

/// Write "login is required" on a SQLite connection that is inside the
/// caller's transaction (the headless first-account CLI, ADR-0034 §7). The
/// caller has created an administrator account in the same transaction, which
/// is what [`SettingsService::set_auth_config`] checks before it writes this.
pub async fn require_login_on_sqlite(conn: &mut sqlx::SqliteConnection) -> Result<(), BantoError> {
    sqlx::query(SEED_UPSERT_SQLITE)
        .bind(KEY_AUTH_DISABLED)
        .bind("false")
        .execute(&mut *conn)
        .await
        .map_err(banto_storage::storage_error)?;
    Ok(())
}

/// PostgreSQL twin of [`require_login_on_sqlite`].
#[cfg(feature = "postgres")]
pub async fn require_login_on_postgres(conn: &mut sqlx::PgConnection) -> Result<(), BantoError> {
    sqlx::query(SEED_UPSERT_POSTGRES)
        .bind(KEY_AUTH_DISABLED)
        .bind("false")
        .execute(&mut *conn)
        .await
        .map_err(banto_storage::storage_error)?;
    Ok(())
}

impl SettingsService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The handle, for this crate's other `impl SettingsService` blocks
    /// ([`crate::ui_settings`]).
    pub(crate) fn db(&self) -> &Db {
        &self.db
    }

    /// Public login-screen notice. This dedicated key prevents an unauthenticated
    /// reader from requesting arbitrary (possibly secret) settings keys.
    pub async fn login_notice(&self) -> Result<String, BantoError> {
        Ok(self.get(KEY_LOGIN_NOTICE).await?.unwrap_or_default())
    }

    /// Save only bounded, single-line public text. The UI renders it as text.
    pub async fn set_login_notice(&self, value: &str) -> Result<String, BantoError> {
        let notice = value.trim();
        if notice.chars().count() > MAX_LOGIN_NOTICE_CHARS
            || notice.chars().any(invalid_login_notice_char)
        {
            return Err(BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "notice".to_string(),
                    message: format!(
                        "お知らせは改行なし・{MAX_LOGIN_NOTICE_CHARS}文字以内で指定してください"
                    ),
                }],
            });
        }
        self.set_unchecked(KEY_LOGIN_NOTICE, notice).await?;
        Ok(notice.to_string())
    }

    /// Read a single setting by key, or `None` if it has never been set.
    pub async fn get(&self, key: &str) -> Result<Option<String>, BantoError> {
        // AssertSqlSafe: only `dialect.placeholder(1)` is interpolated
        // (internal enum, never caller input); `key` is bound below.
        let sql = format!(
            "SELECT value FROM settings WHERE key = {}",
            self.db.dialect().placeholder(1)
        );
        match &self.db {
            Db::Sqlite(pool) => {
                sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql))
                    .bind(key)
                    .fetch_optional(pool)
                    .await
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql))
                    .bind(key)
                    .fetch_optional(pool)
                    .await
            }
        }
        .map_err(banto_storage::storage_error)
    }

    /// Upsert a single setting. The public login notice uses its dedicated
    /// validated method instead.
    ///
    /// `ON CONFLICT(key) DO UPDATE SET value = excluded.value` is valid in both
    /// dialects (the `excluded` pseudo-table is standard in SQLite and
    /// Postgres alike), so only the placeholders differ between backends.
    pub async fn set(&self, key: &str, value: &str) -> Result<(), BantoError> {
        if key == KEY_LOGIN_NOTICE {
            return Err(BantoError::BadRequest(
                "login.notice must be written with set_login_notice".to_string(),
            ));
        }
        self.set_unchecked(key, value).await
    }

    async fn set_unchecked(&self, key: &str, value: &str) -> Result<(), BantoError> {
        let dialect = self.db.dialect();
        // AssertSqlSafe: only `dialect.placeholder(n)` is interpolated
        // (internal enum, never caller input); `key`/`value` are bound below.
        let sql = format!(
            "INSERT INTO settings (key, value) VALUES ({}, {}) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            dialect.placeholder(1),
            dialect.placeholder(2),
        );
        // `.map(|_| ())` in each arm so the two backend query-result types
        // unify (the result itself is unused - an upsert always affects one
        // row).
        match &self.db {
            Db::Sqlite(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(key)
                .bind(value)
                .execute(pool)
                .await
                .map(|_| ()),
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(key)
                .bind(value)
                .execute(pool)
                .await
                .map(|_| ()),
        }
        .map_err(banto_storage::storage_error)?;
        Ok(())
    }

    /// Upsert several keys in ONE transaction: either every pair is stored or
    /// none is (freshness audit of #266, P2-3 - `set_auth_config` must not
    /// leave `auth.disabled` saved and `auth.disabled_role` not, since the
    /// desktop app re-binds its session from what it saved).
    pub async fn set_many(&self, pairs: &[(&str, &str)]) -> Result<(), BantoError> {
        if pairs.iter().any(|(key, _)| *key == KEY_LOGIN_NOTICE) {
            return Err(BantoError::BadRequest(
                "login.notice must be written with set_login_notice".to_string(),
            ));
        }
        let dialect = self.db.dialect();
        // AssertSqlSafe: only `dialect.placeholder(n)` is interpolated
        // (internal enum, never caller input); keys/values are bound below.
        let sql = format!(
            "INSERT INTO settings (key, value) VALUES ({}, {}) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            dialect.placeholder(1),
            dialect.placeholder(2),
        );
        match &self.db {
            Db::Sqlite(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                for (key, value) in pairs {
                    sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
                        .bind(*key)
                        .bind(*value)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                for (key, value) in pairs {
                    sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
                        .bind(*key)
                        .bind(*value)
                        .execute(&mut *tx)
                        .await
                        .map_err(banto_storage::storage_error)?;
                }
                tx.commit().await.map_err(banto_storage::storage_error)?;
            }
        }
        Ok(())
    }

    /// Run the first-boot seed in its own transaction (ADR-0034 §5): the
    /// startup path of both wirings. `pairs` are written once, on the first
    /// start of a new database, together with the marker row; every later
    /// start writes nothing, so a setting the user changed is never put back.
    /// An empty `pairs` still writes the marker: a database that has started
    /// once is never seeded later, even if the app gains a seed list in an
    /// update. `Ok(true)` when this call wrote the seed.
    ///
    /// A pair may not name the login notice (same rule as [`Self::set`]).
    pub async fn seed_first_boot(&self, pairs: &[(&str, &str)]) -> Result<bool, BantoError> {
        if pairs.iter().any(|(key, _)| *key == KEY_LOGIN_NOTICE) {
            return Err(BantoError::BadRequest(
                "login.notice must be written with set_login_notice".to_string(),
            ));
        }
        match &self.db {
            Db::Sqlite(pool) => {
                // BEGIN IMMEDIATE: the seed is a write from its first statement,
                // so take the write lock up front instead of upgrading later.
                let mut tx = pool
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .map_err(banto_storage::storage_error)?;
                let wrote = seed_first_boot_sqlite(&mut tx, pairs).await?;
                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(wrote)
            }
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => {
                let mut tx = pool.begin().await.map_err(banto_storage::storage_error)?;
                let wrote = seed_first_boot_postgres(&mut tx, pairs).await?;
                tx.commit().await.map_err(banto_storage::storage_error)?;
                Ok(wrote)
            }
        }
    }

    /// Is the `settings` table completely empty (no rows at all, not even
    /// one key)? Used by the app-level first-boot seed
    /// (`admin_template_core::first_boot::seed_first_boot_settings`,
    /// display-preset-plan.md D1-a) to detect "this is a genuinely fresh
    /// install" without hardcoding any particular key name here - the
    /// service layer stays app-agnostic (conventions §2) while still giving
    /// the app a reliable one-shot signal.
    pub async fn is_empty(&self) -> Result<bool, BantoError> {
        const SQL: &str = "SELECT COUNT(*) FROM settings";
        let count: i64 = match &self.db {
            Db::Sqlite(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
            #[cfg(feature = "postgres")]
            Db::Postgres(pool) => sqlx::query_scalar(SQL).fetch_one(pool).await,
        }
        .map_err(banto_storage::storage_error)?;
        Ok(count == 0)
    }

    /// Read the embedded-server settings, falling back to
    /// [`ServerSettings::default`] for any key that has not been set yet
    /// (e.g. on a fresh database).
    pub async fn server_config(&self) -> Result<ServerSettings, BantoError> {
        let defaults = ServerSettings::default();

        let enabled = self
            .get(KEY_SERVER_ENABLED)
            .await?
            .map(|value| value == "true")
            .unwrap_or(defaults.enabled);
        let bind = self.get(KEY_SERVER_BIND).await?.unwrap_or(defaults.bind);
        let port = self
            .get(KEY_SERVER_PORT)
            .await?
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(defaults.port);
        let viewer_public = self
            .get(KEY_SERVER_VIEWER_PUBLIC)
            .await?
            .map(|value| value == "true")
            .unwrap_or(defaults.viewer_public);

        Ok(ServerSettings {
            enabled,
            bind,
            port,
            viewer_public,
        })
    }

    /// The auth-disabled / LAN exclusivity check of
    /// [`Self::set_server_config`], without saving anything. Lets a caller
    /// that must act on the config BEFORE persisting it (the desktop app's
    /// `server_apply` saves only after the new listener is up, Issue #287)
    /// refuse an illegal combination up front - before it stops a running
    /// server.
    pub async fn validate_server_config(&self, config: &ServerSettings) -> Result<(), BantoError> {
        if !auth_server_combination_allowed(
            self.auth_config().await?.disabled,
            config.enabled,
            config.viewer_public,
        ) {
            return Err(BantoError::Other(
                "認証無効モード中は、閲覧公開を有効にした場合のみLANアクセスを有効化できます"
                    .to_string(),
            ));
        }
        Ok(())
    }

    /// Persist the embedded-server settings as individual keys
    /// (`server.enabled`/`server.bind`/`server.port`/`server.viewer_public`).
    ///
    /// Refuses to enable LAN access while auth-disabled mode is on UNLESS
    /// 閲覧公開 (`viewer_public`) is also on (spec M11 + Issue #189,
    /// `docs/design/viewer-public-plan.md` §2.3). The original M11 rule
    /// (2026-07-08「LAN 側を無認証公開しない」) existed to keep the WRITE
    /// surface off an unauthenticated LAN; `viewer_public` opens only the
    /// READ surface, through a `viewer`-role synthetic session that still
    /// goes through the normal `require_auth` + `RoleGuard` + audit path
    /// (ADR-0012), so the combination is explicitly allowed. With
    /// `viewer_public` OFF the exclusivity is unchanged. See
    /// [`SettingsService::set_auth_config`] for the mirror-image guard.
    pub async fn set_server_config(&self, config: &ServerSettings) -> Result<(), BantoError> {
        self.validate_server_config(config).await?;

        // One transaction (#287): all four keys or none, so a DB failure
        // part-way never leaves e.g. `server.enabled` saved with the old port.
        let port = config.port.to_string();
        self.set_many(&[
            (
                KEY_SERVER_ENABLED,
                if config.enabled { "true" } else { "false" },
            ),
            (KEY_SERVER_BIND, config.bind.as_str()),
            (KEY_SERVER_PORT, port.as_str()),
            (
                KEY_SERVER_VIEWER_PUBLIC,
                if config.viewer_public {
                    "true"
                } else {
                    "false"
                },
            ),
        ])
        .await
    }

    /// Read the auth-mode settings (spec M11).
    ///
    /// `auth.disabled` must be stored as `true` or `false`, and while it is
    /// `true`, `auth.disabled_role` must be a known role. Anything else is an
    /// error, never a default (ADR-0034 §5): a missing key must not decide
    /// whether the app asks for a login, and an unreadable role must not turn
    /// into an admin session. A new database gets both keys from a migration
    /// and every save writes both, so this only fails on a database that was
    /// edited directly or is damaged. Both wirings call this at startup and
    /// stop on an error (`admin_template_core::startup::check`).
    ///
    /// The autologin keys keep their defaults: they only matter with a real
    /// account and a keyring entry.
    pub async fn auth_config(&self) -> Result<AuthSettings, BantoError> {
        let defaults = AuthSettings::default();

        let disabled = match self.get(KEY_AUTH_DISABLED).await?.as_deref() {
            Some("true") => true,
            Some("false") => false,
            Some(_) => {
                return Err(broken_auth_setting(
                    "設定 auth.disabled の値が true / false ではありません",
                ))
            }
            None => return Err(broken_auth_setting("設定 auth.disabled がありません")),
        };
        let stored_role = self.get(KEY_AUTH_DISABLED_ROLE).await?;
        let disabled_role = match stored_role.as_deref().map(Role::from_str) {
            Some(Ok(role)) => role,
            // Login is required: the role builds no session, so an unreadable
            // one stops nothing. The next save writes it again.
            _ if !disabled => defaults.disabled_role,
            Some(Err(_)) => {
                return Err(broken_auth_setting(
                    "設定 auth.disabled_role の値が知らないロールです",
                ))
            }
            None => {
                return Err(broken_auth_setting(
                    "ログインなしの設定なのに、設定 auth.disabled_role がありません",
                ))
            }
        };
        let autologin_enabled = self
            .get(KEY_AUTOLOGIN_ENABLED)
            .await?
            .map(|value| value == "true")
            .unwrap_or(defaults.autologin_enabled);
        // "" is the sentinel for "unset" (see set_auth_config below) - a real
        // username is never empty (UsersService enforces a minimum length),
        // so this cannot collide with an actual configured username.
        let autologin_username = self
            .get(KEY_AUTOLOGIN_USERNAME)
            .await?
            .filter(|value| !value.is_empty());

        Ok(AuthSettings {
            disabled,
            disabled_role,
            autologin_enabled,
            autologin_username,
        })
    }

    /// Persist the auth-mode settings (spec M11).
    ///
    /// Refuses to turn auth-disabled mode ON while LAN access is currently
    /// enabled, UNLESS 閲覧公開 (`ServerSettings::viewer_public`) is also on
    /// (mirror image of [`SettingsService::set_server_config`]'s guard,
    /// Issue #189 / `docs/design/viewer-public-plan.md` §2.3) - both directions are
    /// checked so whichever settings screen the user acts on second is the
    /// one that catches the conflict, and so the two can never disagree on
    /// whether a given combination is legal.
    ///
    /// Refuses to turn the mode OFF (require login) while no administrator
    /// account exists (ADR-0034 §6): nobody could log in to manage the app.
    pub async fn set_auth_config(&self, config: &AuthSettings) -> Result<(), BantoError> {
        self.set_auth_config_and_disabled_permissions(config, None)
            .await
    }

    /// [`Self::set_auth_config`] plus the mode's permissions (Issue #697,
    /// [`Self::auth_disabled_permissions`]) in the SAME transaction: the four
    /// auth keys and, only when `permissions` is `Some`, the permissions key
    /// are written by one `set_many`, so a failure never leaves a new mode
    /// with the old permissions (PR #703 review). The combination guard runs
    /// first, so a refused combination writes nothing - permissions included.
    /// The keys are already validated against the catalog by the caller
    /// (they are `PermissionKey`s); `None` leaves the stored permissions as
    /// they are.
    pub async fn set_auth_config_and_disabled_permissions(
        &self,
        config: &AuthSettings,
        permissions: Option<&[PermissionKey]>,
    ) -> Result<(), BantoError> {
        let server = self.server_config().await?;
        if !auth_server_combination_allowed(config.disabled, server.enabled, server.viewer_public) {
            return Err(BantoError::Other(
                "LANアクセスが有効な間は、閲覧公開が有効な場合のみ認証無効モードを有効化できます"
                    .to_string(),
            ));
        }
        // ADR-0034 §6: login may be required only while an administrator
        // account can log in. The last administrator can never be removed
        // (the guard holds in no-login mode too), so one that exists here
        // still exists when the keys are written.
        if !config.disabled && !UsersService::new(self.db.clone()).has_admin().await? {
            return Err(lockdown_needs_an_admin());
        }

        // One transaction (freshness audit of #266, P2-3): all keys or
        // none, so a failure part-way never leaves a mode saved that the
        // desktop app's session re-bind did not follow.
        let formatted = permissions.map(format_disabled_permissions);
        let mut pairs: Vec<(&str, &str)> = vec![
            (
                KEY_AUTH_DISABLED,
                if config.disabled { "true" } else { "false" },
            ),
            (KEY_AUTH_DISABLED_ROLE, config.disabled_role.as_str()),
            (
                KEY_AUTOLOGIN_ENABLED,
                if config.autologin_enabled {
                    "true"
                } else {
                    "false"
                },
            ),
            (
                KEY_AUTOLOGIN_USERNAME,
                config.autologin_username.as_deref().unwrap_or(""),
            ),
        ];
        if let Some(value) = &formatted {
            pairs.push((KEY_AUTH_DISABLED_PERMISSIONS, value));
        }
        self.set_many(&pairs).await
    }

    /// The permissions of auth-disabled mode's synthetic session (Issue #697,
    /// user-permissions-plan §5 / §8-4), stored as
    /// `auth.disabled_permissions` next to `auth.disabled_role`. Kept apart
    /// from [`AuthSettings`] on purpose: that struct is built with struct
    /// literals by derived apps, so a new field there would break them
    /// (owner decision §8-7).
    ///
    /// None by default (never set = a login-free desktop holds no
    /// permission). Stored as a comma-separated list (a key never contains a
    /// comma); the read keeps only well-formed keys, sorted and deduplicated,
    /// so a hand-edited value degrades to fewer permissions instead of a
    /// failed read - the same stance as `auth.disabled_role`. Whether each
    /// key is still registered is the session builder's question
    /// ([`PermissionCatalog::effective`]).
    pub async fn auth_disabled_permissions(&self) -> Result<Vec<PermissionKey>, BantoError> {
        Ok(self
            .get(KEY_AUTH_DISABLED_PERMISSIONS)
            .await?
            .map(|value| parse_disabled_permissions(&value))
            .unwrap_or_default())
    }

    /// Replace auth-disabled mode's permissions (Issue #697,
    /// [`Self::auth_disabled_permissions`]). Every entry must be a
    /// well-formed key that `catalog` registers; anything else is a
    /// `Validation` error on `permissions` with nothing written (the same
    /// rule as a user's permissions). Returns the saved keys, sorted.
    ///
    /// Like [`Self::set_auth_config`] this is an `auth.` key: the desktop
    /// app's generic `settings_set` refuses it ([`Self::is_auth_key`]), so it
    /// is written only here, under the app's auth-mode lock.
    pub async fn set_auth_disabled_permissions(
        &self,
        permissions: &[String],
        catalog: &PermissionCatalog,
    ) -> Result<Vec<PermissionKey>, BantoError> {
        let keys: Vec<PermissionKey> = catalog.validate(permissions)?.into_iter().collect();
        self.set(
            KEY_AUTH_DISABLED_PERMISSIONS,
            &format_disabled_permissions(&keys),
        )
        .await?;
        Ok(keys)
    }

    /// Is `key` one of the auth-mode keys only [`Self::set_auth_config`] may
    /// write (the `auth.` namespace)? The desktop app's generic
    /// `settings_set` refuses them (freshness audit of #266, P2-2): a raw
    /// write would bypass its session re-bind and lock.
    pub fn is_auth_key(key: &str) -> bool {
        key.starts_with("auth.")
    }

    /// Is `key` one of the embedded-server keys (the `server.` namespace)?
    /// The desktop app's generic `settings_set` refuses them (Issue #459):
    /// they are written only through [`Self::set_server_config`] (by
    /// `server_apply`, which replaces the listener under its server lock, and
    /// by the launch-time port fallback), so a raw write could otherwise
    /// leave the saved settings disagreeing with the listener that is running.
    pub fn is_server_key(key: &str) -> bool {
        key.starts_with("server.")
    }

    /// Read the audit-log retention settings (spec M14), falling back to
    /// [`AuditSettings::default`] for any key that has never been set. See
    /// [`parse_retention`] for how a stored value maps to `Option<i64>`.
    pub async fn audit_config(&self) -> Result<AuditSettings, BantoError> {
        let defaults = AuditSettings::default();

        let retention_days = parse_retention(
            self.get(KEY_AUDIT_RETENTION_DAYS).await?,
            defaults.retention_days,
        );
        let retention_rows = parse_retention(
            self.get(KEY_AUDIT_RETENTION_ROWS).await?,
            defaults.retention_rows,
        );

        Ok(AuditSettings {
            retention_days,
            retention_rows,
        })
    }

    /// Persist the audit-log retention settings (spec M14). `None` is
    /// written back as `"0"` - [`parse_retention`] treats a stored `0` (or
    /// any non-positive value) as unlimited on read, so this round-trips
    /// correctly without a separate "is this key even set" sentinel (unlike
    /// [`SettingsService::set_auth_config`]'s `autologin_username`, which
    /// uses `""` because `0` is not a meaningful username).
    pub async fn set_audit_config(&self, config: &AuditSettings) -> Result<(), BantoError> {
        self.set(
            KEY_AUDIT_RETENTION_DAYS,
            &config.retention_days.unwrap_or(0).to_string(),
        )
        .await?;
        self.set(
            KEY_AUDIT_RETENTION_ROWS,
            &config.retention_rows.unwrap_or(0).to_string(),
        )
        .await?;
        Ok(())
    }
}

/// `auth.disabled_permissions` -> keys (Issue #697): sorted, duplicates and
/// malformed entries dropped.
fn parse_disabled_permissions(stored: &str) -> Vec<PermissionKey> {
    let keys: std::collections::BTreeSet<PermissionKey> = stored
        .split(',')
        .filter_map(|raw| PermissionKey::parse(raw.trim()))
        .collect();
    keys.into_iter().collect()
}

fn format_disabled_permissions(keys: &[PermissionKey]) -> String {
    keys.iter()
        .map(PermissionKey::as_str)
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    #[test]
    fn auth_server_combination_truth_table() {
        // (auth_disabled, server_enabled, viewer_public) -> allowed
        for (auth_disabled, server_enabled, viewer_public, allowed) in [
            (false, false, false, true),
            (false, false, true, true),
            (false, true, false, true),
            (false, true, true, true),
            (true, false, false, true),
            (true, false, true, true),
            // The one refused combination: unauthenticated LAN write surface.
            (true, true, false, false),
            // Issue #288: allowed with 閲覧公開.
            (true, true, true, true),
        ] {
            assert_eq!(
                auth_server_combination_allowed(auth_disabled, server_enabled, viewer_public),
                allowed,
                "auth_disabled={auth_disabled} server_enabled={server_enabled} viewer_public={viewer_public}"
            );
        }
    }

    #[tokio::test]
    async fn save_time_guards_agree_with_the_shared_rule() {
        let server = |enabled, viewer_public| ServerSettings {
            enabled,
            viewer_public,
            ..ServerSettings::default()
        };
        let auth = |disabled| AuthSettings {
            disabled,
            ..AuthSettings::default()
        };
        // viewer_public off: auth-disabled + LAN is refused from both sides.
        let svc = service().await;
        svc.set_auth_config(&auth(true)).await.unwrap();
        assert!(svc.set_server_config(&server(true, false)).await.is_err());
        let svc = service().await;
        svc.set_server_config(&server(true, false)).await.unwrap();
        assert!(svc.set_auth_config(&auth(true)).await.is_err());
        // viewer_public on: allowed from both sides, and re-readable (what
        // the startup check sees after a restart).
        let svc = service().await;
        svc.set_auth_config(&auth(true)).await.unwrap();
        svc.set_server_config(&server(true, true)).await.unwrap();
        let (a, s) = (
            svc.auth_config().await.unwrap(),
            svc.server_config().await.unwrap(),
        );
        assert!(auth_server_combination_allowed(
            a.disabled,
            s.enabled,
            s.viewer_public
        ));
    }

    #[tokio::test]
    async fn set_server_config_round_trips_all_four_keys() {
        let svc = service().await;
        let cfg = ServerSettings {
            enabled: true,
            bind: "0.0.0.0".to_string(),
            port: 9123,
            viewer_public: true,
        };
        svc.set_server_config(&cfg).await.unwrap();
        assert_eq!(svc.server_config().await.unwrap(), cfg);
    }

    use super::*;

    /// An in-memory SQLite handle with the `settings` table created inline.
    /// This crate owns no migrations (conventions §11: table definitions
    /// belong to the app); the DDL below MUST be kept in sync with
    /// `apps/admin-template/core/migrations-sqlite/0002_settings.sql`. Same
    /// pattern `banto-attachments` uses to avoid a backwards dependency on
    /// the app crate's `db::migrate_memory` (conventions §"逆依存禁止").
    ///
    /// The database is in the login-required state: `auth.disabled = false`
    /// and one administrator account (what the mode needs, ADR-0034 §6).
    /// [`bare_service`] is the same tables with no rows.
    async fn service() -> SettingsService {
        let svc = bare_service().await;
        add_admin_account(&svc).await;
        svc.set(KEY_AUTH_DISABLED, "false").await.unwrap();
        svc
    }

    async fn bare_service() -> SettingsService {
        let db = Db::connect_sqlite_memory()
            .await
            .expect("connect in-memory sqlite");
        for sql in [
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            // The columns "require login" reads (ADR-0034 §6).
            "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL DEFAULT 'someone', \
             password_hash TEXT, role TEXT NOT NULL, kind TEXT NOT NULL)",
        ] {
            sqlx::query(sql)
                .execute(
                    db.as_sqlite()
                        .expect("service tests run on a SQLite handle"),
                )
                .await
                .expect("create table");
        }
        SettingsService::new(db)
    }

    /// An administrator account: what "require login" needs (ADR-0034 §6).
    async fn add_admin_account(svc: &SettingsService) {
        // A PHC string the verifier can check (what "can log in" means).
        sqlx::query(
            "INSERT INTO users (role, kind, password_hash) VALUES ('admin', 'account', \
             '$argon2id$v=19$m=65536,t=2,p=1$gZiV/M1gPc22ElAH/Jh1Hw$CWOrkoo7oJBQ/iyh7uJ0LO2aLEfrHwTWllSAxT0zRno')",
        )
            .execute(svc.db.as_sqlite().expect("sqlite"))
            .await
            .expect("insert admin");
    }

    /// Issue #697: `auth.disabled_permissions` defaults to none, saving
    /// validates against the catalog, and a hand-edited value keeps only its
    /// well-formed keys (sorted, deduped) instead of failing the read.
    #[tokio::test]
    async fn auth_disabled_permissions_default_validate_and_degrade() {
        let svc = service().await;
        assert!(svc.auth_disabled_permissions().await.unwrap().is_empty());
        assert!(SettingsService::is_auth_key("auth.disabled_permissions"));

        let catalog = PermissionCatalog::empty()
            .register("equipment.operate", "a", "b")
            .unwrap()
            .register("alarm.ack", "c", "d")
            .unwrap();
        let saved = svc
            .set_auth_disabled_permissions(
                &["equipment.operate".into(), "alarm.ack".into()],
                &catalog,
            )
            .await
            .unwrap();
        let names = |keys: &[PermissionKey]| -> Vec<String> {
            keys.iter().map(ToString::to_string).collect()
        };
        assert_eq!(names(&saved), ["alarm.ack", "equipment.operate"]);
        assert_eq!(
            names(&svc.auth_disabled_permissions().await.unwrap()),
            ["alarm.ack", "equipment.operate"]
        );

        // Unregistered or malformed: Validation, nothing written.
        for bad in ["other.thing", "BAD"] {
            match svc
                .set_auth_disabled_permissions(&[bad.to_string()], &catalog)
                .await
            {
                Err(BantoError::Validation { field_errors }) => {
                    assert_eq!(field_errors[0].field, "permissions")
                }
                other => panic!("{bad}: expected Validation, got {other:?}"),
            }
        }
        assert_eq!(svc.auth_disabled_permissions().await.unwrap().len(), 2);

        // A hand-edited value degrades.
        svc.set(
            "auth.disabled_permissions",
            "equipment.operate, BAD,,alarm.ack,alarm.ack",
        )
        .await
        .unwrap();
        assert_eq!(
            names(&svc.auth_disabled_permissions().await.unwrap()),
            ["alarm.ack", "equipment.operate"]
        );

        // An empty list round-trips as empty.
        svc.set_auth_disabled_permissions(&[], &catalog)
            .await
            .unwrap();
        assert!(svc.auth_disabled_permissions().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn get_missing_key_is_none() {
        let svc = service().await;
        assert_eq!(svc.get("nope").await.unwrap(), None);
    }

    #[tokio::test]
    async fn set_then_get_round_trips() {
        let svc = service().await;
        svc.set("theme", "dark").await.unwrap();
        assert_eq!(svc.get("theme").await.unwrap(), Some("dark".to_string()));
    }

    #[tokio::test]
    async fn login_notice_is_public_text_with_a_single_bounded_line() {
        let svc = service().await;
        assert_eq!(svc.login_notice().await.unwrap(), "");
        assert_eq!(
            svc.set_login_notice("  Maintenance tonight  ")
                .await
                .unwrap(),
            "Maintenance tonight"
        );
        assert_eq!(svc.login_notice().await.unwrap(), "Maintenance tonight");
        assert!(matches!(
            svc.set(KEY_LOGIN_NOTICE, "first\nsecond").await,
            Err(BantoError::BadRequest(_))
        ));
        assert!(matches!(
            svc.set_many(&[("theme", "dark"), (KEY_LOGIN_NOTICE, "first\nsecond")])
                .await,
            Err(BantoError::BadRequest(_))
        ));
        assert_eq!(svc.get("theme").await.unwrap(), None);
        for invalid in [
            "first\nsecond".to_string(),
            "first\u{2028}second".to_string(),
            "first\u{202E}second".to_string(),
            "first\u{200B}second".to_string(),
            "first\u{061C}second".to_string(),
            "first\u{180E}second".to_string(),
            "first\u{2060}second".to_string(),
            "first\u{00AD}second".to_string(),
            "first\u{206A}second".to_string(),
            "first\u{FFF9}second".to_string(),
            "first\u{E0041}second".to_string(),
            "x".repeat(MAX_LOGIN_NOTICE_CHARS + 1),
        ] {
            assert!(matches!(
                svc.set_login_notice(&invalid).await,
                Err(BantoError::Validation { .. })
            ));
        }
        assert_eq!(svc.login_notice().await.unwrap(), "Maintenance tonight");
    }

    #[tokio::test]
    async fn set_twice_overwrites_via_upsert() {
        let svc = service().await;
        svc.set("theme", "dark").await.unwrap();
        svc.set("theme", "light").await.unwrap();
        assert_eq!(svc.get("theme").await.unwrap(), Some("light".to_string()));
    }

    #[tokio::test]
    async fn is_empty_true_on_a_fresh_table() {
        let svc = bare_service().await;
        assert!(svc.is_empty().await.unwrap());
    }

    #[tokio::test]
    async fn is_empty_false_after_any_set() {
        let svc = service().await;
        svc.set("theme", "dark").await.unwrap();
        assert!(!svc.is_empty().await.unwrap());
    }

    #[tokio::test]
    async fn server_config_defaults_when_unset() {
        let svc = service().await;
        let config = svc.server_config().await.unwrap();
        assert_eq!(config, ServerSettings::default());
        assert!(!config.enabled);
        assert_eq!(config.bind, "127.0.0.1");
        assert_eq!(config.port, 8721);
        assert!(!config.viewer_public);
    }

    #[tokio::test]
    async fn server_config_round_trips_through_set() {
        let svc = service().await;
        let config = ServerSettings {
            enabled: true,
            bind: "0.0.0.0".to_string(),
            port: 9000,
            viewer_public: true,
        };
        svc.set_server_config(&config).await.unwrap();
        assert_eq!(svc.server_config().await.unwrap(), config);
    }

    // --- Auth-mode settings (spec M11) -------------------------------------

    #[tokio::test]
    async fn auth_config_refuses_a_missing_or_unreadable_mode() {
        let svc = bare_service().await;
        // No `auth.disabled` at all: an error, not "login required" and not
        // "no login" (ADR-0034 §5).
        let err = svc.auth_config().await.unwrap_err();
        assert!(err.to_string().contains("auth.disabled"), "{err}");

        svc.set(KEY_AUTH_DISABLED, "yes").await.unwrap();
        let err = svc.auth_config().await.unwrap_err();
        assert!(err.to_string().contains("true / false"), "{err}");

        // Login required: the autologin keys keep their defaults.
        svc.set(KEY_AUTH_DISABLED, "false").await.unwrap();
        let config = svc.auth_config().await.unwrap();
        assert_eq!(config, AuthSettings::default());
    }

    #[tokio::test]
    async fn auth_config_round_trips_through_set() {
        let svc = service().await;
        let config = AuthSettings {
            disabled: true,
            disabled_role: Role::Viewer,
            autologin_enabled: true,
            autologin_username: Some("kiosk".to_string()),
        };
        svc.set_auth_config(&config).await.unwrap();
        assert_eq!(svc.auth_config().await.unwrap(), config);
    }

    #[tokio::test]
    async fn auth_config_round_trips_when_autologin_username_is_cleared() {
        let svc = service().await;
        svc.set_auth_config(&AuthSettings {
            disabled: false,
            disabled_role: Role::Admin,
            autologin_enabled: true,
            autologin_username: Some("kiosk".to_string()),
        })
        .await
        .unwrap();

        // Disabling autologin and clearing the username should round-trip
        // back to `None`, not an empty-string username.
        svc.set_auth_config(&AuthSettings::default()).await.unwrap();
        let config = svc.auth_config().await.unwrap();
        assert_eq!(config.autologin_username, None);
    }

    #[tokio::test]
    async fn auth_config_refuses_an_unreadable_role_only_in_no_login_mode() {
        let svc = bare_service().await;
        // No-login mode builds a session from the role: missing or unknown is
        // an error, never an admin session (ADR-0034 §5).
        svc.set(KEY_AUTH_DISABLED, "true").await.unwrap();
        let err = svc.auth_config().await.unwrap_err();
        assert!(err.to_string().contains("auth.disabled_role"), "{err}");
        // Simulate a corrupt/hand-edited DB value bypassing the typed setter.
        svc.set(KEY_AUTH_DISABLED_ROLE, "not-a-role").await.unwrap();
        let err = svc.auth_config().await.unwrap_err();
        assert!(err.to_string().contains("auth.disabled_role"), "{err}");

        // Login required: the role builds nothing, so it stops nothing.
        svc.set(KEY_AUTH_DISABLED, "false").await.unwrap();
        let config = svc.auth_config().await.unwrap();
        assert!(!config.disabled);
        assert_eq!(config.disabled_role, Role::Admin);
    }

    /// ADR-0034 §6: login can be required only once an administrator account
    /// exists; nothing is written when it is refused.
    #[tokio::test]
    async fn set_auth_config_refuses_requiring_login_without_an_admin_account() {
        let svc = bare_service().await;
        svc.set_auth_config(&AuthSettings {
            disabled: true,
            ..AuthSettings::default()
        })
        .await
        .expect("no-login mode needs no account");

        let err = svc
            .set_auth_config(&AuthSettings::default())
            .await
            .unwrap_err();
        match err {
            BantoError::Validation { field_errors } => {
                assert_eq!(field_errors[0].field, "disabled");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
        assert!(svc.auth_config().await.unwrap().disabled, "nothing written");

        // An editor is not enough.
        sqlx::query(
            "INSERT INTO users (role, kind, password_hash) VALUES \
             ('editor', 'account', 'x'), ('admin', 'builtin', NULL), ('admin', 'account', 'damaged')",
        )
        .execute(svc.db.as_sqlite().unwrap())
        .await
        .unwrap();
        svc.set_auth_config(&AuthSettings::default())
            .await
            .unwrap_err();

        add_admin_account(&svc).await;
        svc.set_auth_config(&AuthSettings::default()).await.unwrap();
        assert!(!svc.auth_config().await.unwrap().disabled);
    }

    /// Freshness audit of #266 (P2-3): `set_many` stores every pair (one
    /// transaction), and `is_auth_key` marks the `auth.` namespace.
    #[tokio::test]
    async fn set_many_stores_every_pair_and_auth_keys_are_marked() {
        let svc = service().await;
        svc.set_many(&[("a.one", "1"), ("a.two", "2")])
            .await
            .unwrap();
        assert_eq!(svc.get("a.one").await.unwrap().as_deref(), Some("1"));
        assert_eq!(svc.get("a.two").await.unwrap().as_deref(), Some("2"));
        assert!(SettingsService::is_auth_key("auth.disabled"));
        assert!(SettingsService::is_auth_key("auth.autologin.username"));
        assert!(!SettingsService::is_auth_key("audit.retention_days"));
        // Issue #459: the `server.` namespace, and nothing that merely
        // contains or resembles it.
        assert!(SettingsService::is_server_key("server.port"));
        assert!(SettingsService::is_server_key("server.viewer_public"));
        assert!(!SettingsService::is_server_key("serverless"));
        assert!(!SettingsService::is_server_key("ui.admin.server.port"));
    }

    #[tokio::test]
    async fn set_server_config_rejects_enabling_lan_while_auth_is_disabled() {
        let svc = service().await;
        svc.set_auth_config(&AuthSettings {
            disabled: true,
            ..AuthSettings::default()
        })
        .await
        .unwrap();

        let err = svc
            .set_server_config(&ServerSettings {
                enabled: true,
                ..ServerSettings::default()
            })
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Other(_)));

        // The rejected write must not have taken effect.
        assert!(!svc.server_config().await.unwrap().enabled);
    }

    #[tokio::test]
    async fn set_server_config_allows_disabling_lan_while_auth_is_disabled() {
        // The exclusivity guard only blocks turning LAN access ON while
        // auth-disabled mode is active - turning it OFF (or leaving it off)
        // must always be allowed, otherwise a user could get stuck unable to
        // ever persist `enabled: false`.
        let svc = service().await;
        svc.set_auth_config(&AuthSettings {
            disabled: true,
            ..AuthSettings::default()
        })
        .await
        .unwrap();

        svc.set_server_config(&ServerSettings::default())
            .await
            .expect("disabling (or leaving disabled) LAN access should always be allowed");
    }

    #[tokio::test]
    async fn set_auth_config_and_permissions_writes_both_and_none_keeps_permissions() {
        let svc = service().await;
        let auth = |disabled| AuthSettings {
            disabled,
            ..AuthSettings::default()
        };
        let keys = [
            PermissionKey::parse("equipment.operate").unwrap(),
            PermissionKey::parse("alarm.ack").unwrap(),
        ];
        svc.set_auth_config_and_disabled_permissions(&auth(true), Some(&keys))
            .await
            .unwrap();
        assert!(svc.auth_config().await.unwrap().disabled);
        assert_eq!(svc.auth_disabled_permissions().await.unwrap().len(), 2);
        // None = the stored permissions are untouched.
        svc.set_auth_config_and_disabled_permissions(&auth(false), None)
            .await
            .unwrap();
        assert!(!svc.auth_config().await.unwrap().disabled);
        assert_eq!(svc.auth_disabled_permissions().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn set_auth_config_and_permissions_writes_nothing_when_combination_refused() {
        let svc = service().await;
        svc.set_server_config(&ServerSettings {
            enabled: true,
            ..ServerSettings::default()
        })
        .await
        .unwrap();
        let keys = [PermissionKey::parse("equipment.operate").unwrap()];
        let refused = svc
            .set_auth_config_and_disabled_permissions(
                &AuthSettings {
                    disabled: true,
                    ..AuthSettings::default()
                },
                Some(&keys),
            )
            .await;
        assert!(refused.is_err());
        assert!(!svc.auth_config().await.unwrap().disabled);
        assert!(svc.auth_disabled_permissions().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn set_auth_config_rejects_disabling_auth_while_lan_is_enabled() {
        let svc = service().await;
        svc.set_server_config(&ServerSettings {
            enabled: true,
            ..ServerSettings::default()
        })
        .await
        .unwrap();

        let err = svc
            .set_auth_config(&AuthSettings {
                disabled: true,
                ..AuthSettings::default()
            })
            .await
            .unwrap_err();
        assert!(matches!(err, BantoError::Other(_)));

        // The rejected write must not have taken effect.
        assert!(!svc.auth_config().await.unwrap().disabled);
    }

    // --- 閲覧公開 (viewer_public) exclusivity matrix ------------------------
    //
    // Issue #189 / `docs/design/viewer-public-plan.md` §2.3: the three
    // `auth.disabled` × `server.enabled` × `viewer_public` combinations, each
    // asserted from BOTH directions (`set_server_config` and
    // `set_auth_config`) so no state is reachable through only one of the two
    // settings screens.

    #[tokio::test]
    async fn set_server_config_allows_enabling_lan_while_auth_is_disabled_when_viewer_public() {
        // Combination 2 (auth.disabled + server.enabled + viewerPublic ON),
        // approached from the server side: the standard shape of a
        // display-only app.
        let svc = service().await;
        svc.set_auth_config(&AuthSettings {
            disabled: true,
            ..AuthSettings::default()
        })
        .await
        .unwrap();

        svc.set_server_config(&ServerSettings {
            enabled: true,
            viewer_public: true,
            ..ServerSettings::default()
        })
        .await
        .expect("閲覧公開 ON should permit LAN access while auth-disabled mode is on");

        let config = svc.server_config().await.unwrap();
        assert!(config.enabled);
        assert!(config.viewer_public);
    }

    #[tokio::test]
    async fn set_auth_config_allows_disabling_auth_while_lan_is_enabled_when_viewer_public() {
        // Combination 2, approached from the auth side (mirror image of the
        // test above): the same end state must be reachable either way.
        let svc = service().await;
        svc.set_server_config(&ServerSettings {
            enabled: true,
            viewer_public: true,
            ..ServerSettings::default()
        })
        .await
        .unwrap();

        svc.set_auth_config(&AuthSettings {
            disabled: true,
            ..AuthSettings::default()
        })
        .await
        .expect("閲覧公開 ON should permit auth-disabled mode while LAN access is on");

        assert!(svc.auth_config().await.unwrap().disabled);
    }

    #[tokio::test]
    async fn viewer_public_with_auth_enabled_is_allowed_from_both_directions() {
        // Combination 3 (!auth.disabled + server.enabled + viewerPublic ON):
        // a normal login-based deployment that additionally allows anonymous
        // read-only viewing. Nothing guards this, but it is asserted so a
        // future guard cannot tighten it by accident.
        let svc = service().await;
        svc.set_server_config(&ServerSettings {
            enabled: true,
            viewer_public: true,
            ..ServerSettings::default()
        })
        .await
        .expect("viewer_public with auth enabled should always be allowed");

        svc.set_auth_config(&AuthSettings::default())
            .await
            .expect("leaving auth enabled should always be allowed");

        let config = svc.server_config().await.unwrap();
        assert!(config.enabled && config.viewer_public);
        assert!(!svc.auth_config().await.unwrap().disabled);
    }

    #[tokio::test]
    async fn set_server_config_still_rejects_enabling_lan_while_auth_is_disabled_without_viewer_public(
    ) {
        // Combination 1 (viewerPublic OFF) is unchanged from the 2026-07-08
        // decision - spelled out here next to the ON cases so the matrix is
        // readable in one place, and asserting the NEW error message.
        let svc = service().await;
        svc.set_auth_config(&AuthSettings {
            disabled: true,
            ..AuthSettings::default()
        })
        .await
        .unwrap();

        let err = svc
            .set_server_config(&ServerSettings {
                enabled: true,
                viewer_public: false,
                ..ServerSettings::default()
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Other(message) => assert!(message.contains("閲覧公開")),
            other => panic!("expected Other, got {other:?}"),
        }
        assert!(!svc.server_config().await.unwrap().enabled);
    }

    #[tokio::test]
    async fn set_auth_config_still_rejects_disabling_auth_while_lan_is_enabled_without_viewer_public(
    ) {
        // Combination 1, the other direction.
        let svc = service().await;
        svc.set_server_config(&ServerSettings {
            enabled: true,
            viewer_public: false,
            ..ServerSettings::default()
        })
        .await
        .unwrap();

        let err = svc
            .set_auth_config(&AuthSettings {
                disabled: true,
                ..AuthSettings::default()
            })
            .await
            .unwrap_err();
        match err {
            BantoError::Other(message) => assert!(message.contains("閲覧公開")),
            other => panic!("expected Other, got {other:?}"),
        }
        assert!(!svc.auth_config().await.unwrap().disabled);
    }

    #[tokio::test]
    async fn viewer_public_can_be_enabled_while_lan_access_is_off() {
        // The guard only looks at `enabled`, so `viewer_public` may be turned
        // on ahead of (or without) LAN access - the shape
        // `admin-template-core`'s REST tests use to exercise
        // `POST /api/auth/grant/publicViewer` over `tower::oneshot` without
        // binding a socket.
        let svc = service().await;
        svc.set_server_config(&ServerSettings {
            enabled: false,
            viewer_public: true,
            ..ServerSettings::default()
        })
        .await
        .expect("viewer_public without LAN access should be allowed");
        assert!(svc.server_config().await.unwrap().viewer_public);
    }

    #[tokio::test]
    async fn set_auth_config_allows_non_disabling_changes_while_lan_is_enabled() {
        // Only `disabled: true` is guarded - autologin settings (and
        // `disabled: false`) must be freely settable regardless of LAN
        // state.
        let svc = service().await;
        svc.set_server_config(&ServerSettings {
            enabled: true,
            ..ServerSettings::default()
        })
        .await
        .unwrap();

        svc.set_auth_config(&AuthSettings {
            disabled: false,
            disabled_role: Role::Admin,
            autologin_enabled: true,
            autologin_username: Some("kiosk".to_string()),
        })
        .await
        .expect("non-disabling auth config changes should not be blocked by LAN state");
    }

    // --- Audit-log retention settings (spec M14) ---------------------------

    #[tokio::test]
    async fn audit_config_defaults_when_unset() {
        let svc = service().await;
        let config = svc.audit_config().await.unwrap();
        assert_eq!(config, AuditSettings::default());
        assert_eq!(config.retention_days, Some(90));
        assert_eq!(config.retention_rows, Some(100_000));
    }

    #[tokio::test]
    async fn audit_config_round_trips_through_set() {
        let svc = service().await;
        let config = AuditSettings {
            retention_days: Some(30),
            retention_rows: Some(5_000),
        };
        svc.set_audit_config(&config).await.unwrap();
        assert_eq!(svc.audit_config().await.unwrap(), config);
    }

    #[tokio::test]
    async fn audit_config_none_round_trips_as_unlimited() {
        let svc = service().await;
        svc.set_audit_config(&AuditSettings {
            retention_days: None,
            retention_rows: None,
        })
        .await
        .unwrap();
        let config = svc.audit_config().await.unwrap();
        assert_eq!(config.retention_days, None);
        assert_eq!(config.retention_rows, None);
    }

    #[tokio::test]
    async fn audit_config_treats_a_stored_zero_as_unlimited_not_the_default() {
        // A directly-stored "0" (bypassing the typed setter) must NOT fall
        // back to the default (90/100_000) - it means the user explicitly
        // chose unlimited, which is a real, distinct value from "unset".
        let svc = service().await;
        svc.set(KEY_AUDIT_RETENTION_DAYS, "0").await.unwrap();
        let config = svc.audit_config().await.unwrap();
        assert_eq!(config.retention_days, None);
        assert_eq!(config.retention_rows, Some(100_000)); // untouched key still defaults
    }

    #[tokio::test]
    async fn audit_config_falls_back_to_default_on_a_corrupt_stored_value() {
        let svc = service().await;
        svc.set(KEY_AUDIT_RETENTION_DAYS, "not-a-number")
            .await
            .unwrap();
        let config = svc.audit_config().await.unwrap();
        assert_eq!(config.retention_days, Some(90));
    }
}
