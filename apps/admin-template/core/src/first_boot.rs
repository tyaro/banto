//! First-boot settings seed (display-preset-plan.md D1-a, Issue #190 prep):
//! a generic mechanism, empty by default, so behavior does not change for
//! today's template. A derived app (or a future `scripts/scaffold.mjs
//! --preset display`, plan §3.2) fills [`FIRST_BOOT_SETTINGS`] with the
//! pairs it wants applied on a genuinely fresh database - e.g.
//! `("auth.disabled", "true")`, `("server.viewer_public", "true")` for a
//! kiosk/display app that should be usable the moment it is copied, with no
//! setup screen.
//!
//! This module only ever WRITES through [`SettingsService::seed_first_boot`]
//! (conventions §2: no tauri/axum/RBAC knowledge here), and only on the first
//! start of a new database: the seed leaves a marker row, and a database that
//! has the marker is left untouched (ADR-0034 §5).

use banto_core::BantoError;

use crate::settings::SettingsService;

/// App-level hook: the `(key, value)` pairs to seed on a fresh install.
/// Empty by default (today's behavior: no seed). A derived app edits this
/// list directly; `scripts/scaffold.mjs --preset display` (plan §3.2)
/// reverses it to a non-empty default in the scaffolded copy only - the
/// template itself always ships with an empty list.
///
/// Wrapped in scaffold-anchor markers so the preset's editor can swap the
/// list body without needing a fuzzy diff.
// [scaffold:first-boot-settings] begin
pub const FIRST_BOOT_SETTINGS: &[(&str, &str)] = &[];
// [scaffold:first-boot-settings] end

/// Seed [`FIRST_BOOT_SETTINGS`] into `settings` on the first start of a new
/// database (ADR-0034 §5). Returns `Ok(true)` if this call ran the seed,
/// `Ok(false)` if the database was already seeded.
///
/// "Already seeded" is a marker row the seed writes in the same transaction
/// as the pairs ([`SettingsService::seed_first_boot`]), not "the table has
/// rows": a migration may insert settings before the first start, and the
/// seed must still run then (its values win over the migration's). The
/// marker is written even when the list is empty, so a database that has
/// started once is never seeded by a later version of the app.
///
/// Called once at startup, after the migrations and before any
/// `auth_config`/`server_config` read, by both entry points
/// (`bin/banto-serve.rs` and `src-tauri/src/lib.rs` `run()`), so a seeded
/// `auth.disabled = true` (say) takes effect on the very first launch rather
/// than one launch late.
pub async fn seed_first_boot_settings(settings: &SettingsService) -> Result<bool, BantoError> {
    settings.seed_first_boot(FIRST_BOOT_SETTINGS).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A database with the real migrations applied (0001-0014), unseeded.
    async fn service() -> SettingsService {
        SettingsService::new(crate::db::migrate_memory().await.expect("migrate"))
    }

    const DISPLAY_SEED: &[(&str, &str)] = &[
        ("auth.disabled", "true"),
        ("auth.disabled_role", "viewer"),
        ("server.enabled", "true"),
        ("server.bind", "0.0.0.0"),
        ("server.viewer_public", "true"),
    ];

    /// ADR-0034 §10 (C1): on a database the real migrations built, the display
    /// preset's seed is written, and public viewing is on.
    #[tokio::test]
    async fn the_display_seed_is_written_on_a_freshly_migrated_database() {
        let settings = service().await;
        assert!(settings.seed_first_boot(DISPLAY_SEED).await.unwrap());
        let server = settings.server_config().await.unwrap();
        assert!(server.enabled);
        assert!(server.viewer_public);
        assert_eq!(server.bind, "0.0.0.0");
        assert!(settings.auth_config().await.unwrap().disabled);
    }

    /// A row that exists before the first start (a migration's default, say)
    /// does not stop the seed, and the seed's value wins.
    #[tokio::test]
    async fn the_seed_runs_over_existing_rows_and_its_values_win() {
        let settings = service().await;
        settings.set("auth.disabled", "false").await.unwrap();
        settings.set("unrelated.key", "kept").await.unwrap();
        assert!(settings.seed_first_boot(DISPLAY_SEED).await.unwrap());
        assert_eq!(
            settings.get("auth.disabled").await.unwrap().as_deref(),
            Some("true")
        );
        assert_eq!(
            settings.get("unrelated.key").await.unwrap().as_deref(),
            Some("kept")
        );
    }

    /// The second start writes nothing: a setting the user changed stays.
    #[tokio::test]
    async fn the_second_start_does_not_put_a_changed_setting_back() {
        let settings = service().await;
        assert!(settings.seed_first_boot(DISPLAY_SEED).await.unwrap());
        settings.set("server.viewer_public", "false").await.unwrap();
        assert!(!settings.seed_first_boot(DISPLAY_SEED).await.unwrap());
        assert_eq!(
            settings
                .get("server.viewer_public")
                .await
                .unwrap()
                .as_deref(),
            Some("false")
        );
    }

    /// An app with no seed writes no setting, and a later version that gains a
    /// seed list does not apply it to this (already started) database.
    #[tokio::test]
    async fn an_empty_seed_writes_no_setting_and_closes_the_first_boot() {
        let settings = service().await;
        assert!(settings.seed_first_boot(&[]).await.unwrap());
        assert_eq!(settings.get("auth.disabled").await.unwrap(), None);
        assert_eq!(settings.get("server.enabled").await.unwrap(), None);
        assert!(!settings.seed_first_boot(DISPLAY_SEED).await.unwrap());
        assert_eq!(settings.get("auth.disabled").await.unwrap(), None);
    }

    // `scripts/scaffold.mjs --preset display` swaps this test for one that
    // checks the display defaults; keep its text in step with that script.
    #[tokio::test]
    async fn seed_first_boot_settings_writes_no_setting_with_todays_empty_const() {
        let settings = service().await;
        let wrote = seed_first_boot_settings(&settings).await.unwrap();
        assert!(wrote);
        assert_eq!(settings.get("server.viewer_public").await.unwrap(), None);
    }
}
