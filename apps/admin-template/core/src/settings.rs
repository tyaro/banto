//! App settings storage (spec §12.1 `SettingsProvider` role): a
//! `key`/`value` table in the local SQLite settings DB, plus a typed view
//! over the embedded-server settings (spec §11.4's LAN-access toggle +
//! bind/port fields).

use std::str::FromStr;

use banto_core::BantoError;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::users::Role;

const KEY_SERVER_ENABLED: &str = "server.enabled";
const KEY_SERVER_BIND: &str = "server.bind";
const KEY_SERVER_PORT: &str = "server.port";
const KEY_AUTH_DISABLED: &str = "auth.disabled";
const KEY_AUTH_DISABLED_ROLE: &str = "auth.disabled_role";
const KEY_AUTOLOGIN_ENABLED: &str = "auth.autologin.enabled";
const KEY_AUTOLOGIN_USERNAME: &str = "auth.autologin.username";

/// Embedded-server settings (spec §11.2, §11.4): whether LAN access is
/// enabled, and the bind address/port. Defaults to disabled,
/// localhost-only - "attack surface zero" until the user opts in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSettings {
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: "127.0.0.1".to_string(),
            port: 8721,
        }
    }
}

/// Auth-mode settings (spec M11): the "ログイン不要モード" (auth-disabled)
/// toggle + its synthetic-identity role, and the desktop "自動ログイン"
/// (autologin) opt-in + which account it targets. Defaults to today's
/// behavior (a real login screen, no autologin) so an existing DB with none
/// of these keys set behaves exactly as before M11.
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

/// Generic key/value settings store, backed by the `settings` table
/// (migration `0002_settings.sql`). Shares the same sqlite pool as
/// [`crate::items::ItemsService`] (spec §12.1: app settings live in the
/// local SQLite settings DB alongside/instead of a separate file).
pub struct SettingsService {
    pool: SqlitePool,
}

impl SettingsService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Read a single setting by key, or `None` if it has never been set.
    pub async fn get(&self, key: &str) -> Result<Option<String>, BantoError> {
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(banto_storage::storage_error)
    }

    /// Upsert a single setting.
    pub async fn set(&self, key: &str, value: &str) -> Result<(), BantoError> {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await
        .map_err(banto_storage::storage_error)?;
        Ok(())
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

        Ok(ServerSettings {
            enabled,
            bind,
            port,
        })
    }

    /// Persist the embedded-server settings as individual keys
    /// (`server.enabled`/`server.bind`/`server.port`).
    ///
    /// Refuses to enable LAN access while auth-disabled mode is on (spec
    /// M11: auth-disabled mode is v1-scoped to the Tauri window only - it
    /// must never be combined with an unauthenticated LAN-exposed server).
    /// See [`SettingsService::set_auth_config`] for the mirror-image guard.
    pub async fn set_server_config(&self, config: &ServerSettings) -> Result<(), BantoError> {
        if config.enabled && self.auth_config().await?.disabled {
            return Err(BantoError::Other(
                "認証無効モード中はLANアクセスを有効化できません".to_string(),
            ));
        }

        self.set(
            KEY_SERVER_ENABLED,
            if config.enabled { "true" } else { "false" },
        )
        .await?;
        self.set(KEY_SERVER_BIND, &config.bind).await?;
        self.set(KEY_SERVER_PORT, &config.port.to_string()).await?;
        Ok(())
    }

    /// Read the auth-mode settings (spec M11), falling back to
    /// [`AuthSettings::default`] for any key that has not been set yet, and
    /// falling back the same way for `auth.disabled_role` specifically if it
    /// holds a value [`Role::from_str`] does not recognize (e.g. a future
    /// downgrade, or a hand-edited DB) - a corrupt role value degrades to the
    /// safe default (`admin`) rather than failing the whole read.
    pub async fn auth_config(&self) -> Result<AuthSettings, BantoError> {
        let defaults = AuthSettings::default();

        let disabled = self
            .get(KEY_AUTH_DISABLED)
            .await?
            .map(|value| value == "true")
            .unwrap_or(defaults.disabled);
        let disabled_role = self
            .get(KEY_AUTH_DISABLED_ROLE)
            .await?
            .and_then(|value| Role::from_str(&value).ok())
            .unwrap_or(defaults.disabled_role);
        let autologin_enabled = self
            .get(KEY_AUTOLOGIN_ENABLED)
            .await?
            .map(|value| value == "true")
            .unwrap_or(defaults.autologin_enabled);
        // "" is the sentinel for "unset" (see set_auth_config below) - a real
        // username is never empty (UsersService enforces a minimum length),
        // so this cannot collide with an actual configured username.
        let autologin_username = self.get(KEY_AUTOLOGIN_USERNAME).await?.filter(|value| !value.is_empty());

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
    /// enabled (mirror image of [`SettingsService::set_server_config`]'s
    /// guard) - both directions are checked so whichever settings screen the
    /// user acts on second is the one that catches the conflict.
    pub async fn set_auth_config(&self, config: &AuthSettings) -> Result<(), BantoError> {
        if config.disabled && self.server_config().await?.enabled {
            return Err(BantoError::Other(
                "LANアクセスが有効な間は認証無効モードを有効化できません".to_string(),
            ));
        }

        self.set(
            KEY_AUTH_DISABLED,
            if config.disabled { "true" } else { "false" },
        )
        .await?;
        self.set(KEY_AUTH_DISABLED_ROLE, config.disabled_role.as_str())
            .await?;
        self.set(
            KEY_AUTOLOGIN_ENABLED,
            if config.autologin_enabled {
                "true"
            } else {
                "false"
            },
        )
        .await?;
        self.set(
            KEY_AUTOLOGIN_USERNAME,
            config.autologin_username.as_deref().unwrap_or(""),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_memory;

    async fn service() -> SettingsService {
        let pool = migrate_memory().await.expect("migrate_memory");
        SettingsService::new(pool)
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
    async fn set_twice_overwrites_via_upsert() {
        let svc = service().await;
        svc.set("theme", "dark").await.unwrap();
        svc.set("theme", "light").await.unwrap();
        assert_eq!(svc.get("theme").await.unwrap(), Some("light".to_string()));
    }

    #[tokio::test]
    async fn server_config_defaults_when_unset() {
        let svc = service().await;
        let config = svc.server_config().await.unwrap();
        assert_eq!(config, ServerSettings::default());
        assert!(!config.enabled);
        assert_eq!(config.bind, "127.0.0.1");
        assert_eq!(config.port, 8721);
    }

    #[tokio::test]
    async fn server_config_round_trips_through_set() {
        let svc = service().await;
        let config = ServerSettings {
            enabled: true,
            bind: "0.0.0.0".to_string(),
            port: 9000,
        };
        svc.set_server_config(&config).await.unwrap();
        assert_eq!(svc.server_config().await.unwrap(), config);
    }

    // --- Auth-mode settings (spec M11) -------------------------------------

    #[tokio::test]
    async fn auth_config_defaults_when_unset() {
        let svc = service().await;
        let config = svc.auth_config().await.unwrap();
        assert_eq!(config, AuthSettings::default());
        assert!(!config.disabled);
        assert_eq!(config.disabled_role, Role::Admin);
        assert!(!config.autologin_enabled);
        assert_eq!(config.autologin_username, None);
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
    async fn auth_config_falls_back_to_default_role_on_an_invalid_stored_value() {
        let svc = service().await;
        // Simulate a corrupt/hand-edited DB value bypassing the typed setter.
        svc.set(KEY_AUTH_DISABLED_ROLE, "not-a-role").await.unwrap();
        let config = svc.auth_config().await.unwrap();
        assert_eq!(config.disabled_role, Role::Admin);
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
}
