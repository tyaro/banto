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
//!
//! Register it in the app's `tauri::Builder`:
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(banto_tauri_panel::init())
//!     // or: banto_tauri_panel::Builder::new().route("tags/panel/{id}").build()
//! ```
//!
//! and allow its one command in the capability file
//! (`"banto-tauri-panel:allow-open"`). The frontend calls it through
//! `@banto/admin-core`'s `openPanelWindow`.
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
//! What the panel window draws, and how it holds its session, stays in the
//! app.

pub mod config;
pub mod geometry;
pub mod store;

#[cfg(feature = "tauri")]
mod plugin;

pub use config::{validate_panel_id, PanelConfig, PanelIdError};
pub use geometry::{is_on_screen, restorable, MonitorRect, PanelGeometry};
pub use store::GeometryStore;

#[cfg(feature = "tauri")]
pub use plugin::{init, Builder, PLUGIN_NAME};

/// Tauri event the main window receives when a panel window is gone. The
/// payload is the panel id (a string). Mirrored by `@banto/admin-core`'s
/// `PANEL_CLOSED_EVENT`.
pub const PANEL_CLOSED_EVENT: &str = "banto://panel-closed";
