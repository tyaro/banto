//! Pop-out panel windows for a Banto app's Tauri shell (ADR-0037, Issue
//! #1006): a dock panel becomes a real OS window, and the app does not have
//! to rebuild the behaviour around it.
//!
//! - **open / focus**: one window per panel id; opening an id that is already
//!   open only brings its window to the front.
//! - **closed notice**: when a panel window is gone, the main window gets
//!   `banto://panel-closed` with the panel id, so the frontend can put the
//!   panel back into the dock (`@banto/admin-core`'s `listenPanelClosed`).
//! - **geometry memory**: position and size are remembered per panel id and
//!   restored on the next open; a remembered place that is no longer on any
//!   monitor falls back to the default placement.
//! - **close with the main window**: closing the main window closes the
//!   panel windows (their geometry stays remembered).
//! - **list**: the ids of the panels whose window is open right now, so the
//!   frontend can put back a panel whose window went away while nobody was
//!   listening (`@banto/admin-core`'s `createPanelPopOut` asks on `connect()`).
//! - **close**: closes the window of a panel id (only a window this plugin
//!   built), for a frontend that has put the panel back into the dock itself -
//!   a layout reset (`createPanelPopOut(...).closeWindows`, Issue #1021).
//! - **background**: `open` takes an optional `background` (`"#rrggbb"`) that
//!   the window is built with, so a window opened in a dark theme is not
//!   white until its page is drawn (Issue #1015). `Builder::background` sets
//!   a default for calls that pass none.
//!
//! Register it in the app's `tauri::Builder`:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(banto_tauri_panel::init())
//!     // or: banto_tauri_panel::Builder::new().route("tags/panel/{id}").build()
//! ```
//!
//! and allow its commands in the capability file
//! (`"banto-tauri-panel:allow-open"`, `"banto-tauri-panel:allow-list"`,
//! `"banto-tauri-panel:allow-close"`). The frontend calls them through
//! `@banto/admin-core`'s `openPanelWindow` / `listPanelWindows` /
//! `closePanelWindow` (`createPanelPopOut` uses all three).
//!
//! # Two halves
//!
//! The crate is split so that everything with a rule in it can be tested
//! where Tauri cannot be built (CI's headless containers):
//!
//! - [`config`], [`geometry`], [`store`] - pure (std + serde). Built and
//!   tested with `--no-default-features`.
//! - `plugin` (feature `tauri`, on by default) - the wiring only: it asks
//!   Tauri for windows / monitors / events and hands the values to the pure
//!   half. Covered by code review, `tauri-check.yml` (compile + clippy) and a
//!   check on a real desktop.
//!
//! The plugin only touches windows it built itself (it tracks their labels);
//! an app window that merely shares the prefix is never focused, remembered
//! or closed. A bad configuration ([`PanelConfig::validate`]: empty prefix,
//! main label starting with the prefix, ...) makes the plugin's `setup`
//! return an error, so the app stops at start-up with the reason (no panic).
//!
//! What the panel window draws, and how it holds its session, stays in the
//! app.

pub mod config;
pub mod geometry;
pub mod store;

#[cfg(feature = "tauri")]
mod plugin;

pub use config::{
    parse_background, validate_panel_id, BackgroundError, ConfigError, PanelConfig, PanelIdError,
};
pub use geometry::{is_on_screen, restorable, MonitorRect, PanelGeometry};
pub use store::GeometryStore;

#[cfg(feature = "tauri")]
pub use plugin::{init, Builder, PLUGIN_NAME};

/// Tauri event the main window receives when a panel window is gone. The
/// payload is the panel id (a string). Mirrored by `@banto/admin-core`'s
/// `PANEL_CLOSED_EVENT`.
pub const PANEL_CLOSED_EVENT: &str = "banto://panel-closed";
