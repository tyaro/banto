//! App settings storage (spec §12.1 `SettingsProvider` role): a
//! `key`/`value` table in the local SQLite settings DB, plus a typed view
//! over the embedded-server settings (spec §11.4's LAN-access toggle +
//! bind/port fields).

use banto_core::BantoError;
use sqlx::SqlitePool;

const KEY_SERVER_ENABLED: &str = "server.enabled";
const KEY_SERVER_BIND: &str = "server.bind";
const KEY_SERVER_PORT: &str = "server.port";

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
    pub async fn set_server_config(&self, config: &ServerSettings) -> Result<(), BantoError> {
        self.set(
            KEY_SERVER_ENABLED,
            if config.enabled { "true" } else { "false" },
        )
        .await?;
        self.set(KEY_SERVER_BIND, &config.bind).await?;
        self.set(KEY_SERVER_PORT, &config.port.to_string()).await?;
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
}
