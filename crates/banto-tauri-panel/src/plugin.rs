//! The Tauri half (ADR-0037): the plugin, its commands (`open`, `list`, `close`) and
//! its event handling. Wiring only - every rule (which id is valid, which label is a
//! panel's, where the window goes, what the file holds) is decided by the
//! pure modules, which is where the tests are. CI's headless job does not
//! build this file; `tauri-check.yml` compiles and lints it, and the
//! behaviour is checked on a real desktop (the PR's checklist).

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, Runtime, State,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::config::{validate_panel_id, PanelConfig, DEFAULT_STORE_FILE};
use crate::geometry::{restorable, MonitorRect, PanelGeometry};
use crate::store::GeometryStore;
use crate::PANEL_CLOSED_EVENT;

/// The plugin's name: the frontend invokes `plugin:banto-tauri-panel|open`
/// (and `|list`, `|close`) and the capability file allows
/// `banto-tauri-panel:allow-open` (and `allow-list`, `allow-close`). Must equal
/// `links` in Cargo.toml (Tauri derives the ACL's plugin name from it).
pub const PLUGIN_NAME: &str = "banto-tauri-panel";

struct PanelState {
    config: PanelConfig,
    /// `None` when the memory is off, or no place to keep it was found.
    store: Mutex<Option<GeometryStore>>,
    /// Windows this plugin built: label -> panel id. Only these are focused,
    /// remembered, announced and closed with the main window; a window of
    /// the app that merely shares the prefix is not ours.
    windows: Mutex<HashMap<String, String>>,
}

impl PanelState {
    fn track(&self, label: &str, id: &str) {
        let mut guard = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(label.to_string(), id.to_string());
    }

    fn is_tracked(&self, label: &str) -> bool {
        let guard = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        guard.contains_key(label)
    }

    fn id_of(&self, label: &str) -> Option<String> {
        let guard = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(label).cloned()
    }

    fn untrack(&self, label: &str) {
        let mut guard = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(label);
    }

    fn tracked_labels(&self) -> Vec<String> {
        let guard = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        guard.keys().cloned().collect()
    }

    /// The panel ids of the tracked windows, sorted (the map has no order).
    fn tracked_ids(&self) -> Vec<String> {
        let guard = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<String> = guard.values().cloned().collect();
        ids.sort();
        ids
    }

    fn saved(&self, id: &str) -> Option<PanelGeometry> {
        let guard = self.store.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|store| store.get(id))
    }

    fn remember(&self, id: &str, geometry: PanelGeometry) {
        let mut guard = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(store) = guard.as_mut() {
            store.set(id, geometry);
        }
    }

    /// Best effort: a failed write only loses this session's memory.
    fn persist(&self) {
        let mut guard = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(store) = guard.as_mut() {
            if let Err(err) = store.save() {
                eprintln!(
                    "banto-tauri-panel: could not save {}: {err}",
                    store.path().display()
                );
            }
        }
    }
}

/// Opens panel `id` in its own window, or brings the window to the front if
/// it is already open. `async` on purpose: creating a window from a
/// synchronous command deadlocks on Windows.
///
/// Not a mutating operation in the sense of conventions §1 (no data is
/// written, nothing is audited): it is desktop integration, with no REST
/// twin - the same class as the template's former `panel_open`.
#[tauri::command]
async fn open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PanelState>,
    id: String,
    title: String,
) -> Result<(), String> {
    validate_panel_id(&id).map_err(|err| err.to_string())?;
    let config = &state.config;
    let label = config.label_for(&id);

    if let Some(window) = app.get_webview_window(&label) {
        if !state.is_tracked(&label) {
            // A window of the app's own with this label: not ours to focus.
            return Err(format!("window label {label} is already in use"));
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let restore = if config.remember_geometry {
        let monitors: Vec<MonitorRect> = app
            .available_monitors()
            .map(|monitors| {
                monitors
                    .iter()
                    .map(|m| MonitorRect {
                        x: m.position().x,
                        y: m.position().y,
                        width: m.size().width,
                        height: m.size().height,
                    })
                    .collect()
            })
            .unwrap_or_default();
        restorable(state.saved(&id), &monitors)
    } else {
        None
    };

    let mut builder =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(config.route_for(&id).into()))
            .title(title)
            .inner_size(config.default_size.0, config.default_size.1)
            .min_inner_size(config.min_size.0, config.min_size.1);
    if restore.is_some() {
        // Built hidden, moved, then shown: the window never flashes at the
        // default place first. Position before size, so the size is applied
        // on the monitor (and scale factor) the window ends up on.
        builder = builder.visible(false);
    }
    let window = builder.build().map_err(|err| err.to_string())?;
    state.track(&label, &id);

    if let Some(geometry) = restore {
        let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
        let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

/// The ids of the panels whose window is open right now - the windows this
/// plugin built and has not yet seen destroyed. The frontend asks when the
/// main window starts (or is reloaded) to tell a panel that is still out in
/// its window from one whose window went away with the last run
/// (`@banto/admin-core`'s `createPanelPopOut`, Issue #1013).
///
/// Read-only, like `open` outside conventions §1: no data is written, there
/// is no REST twin.
#[tauri::command]
fn list(state: State<'_, PanelState>) -> Vec<String> {
    state.tracked_ids()
}

/// Closes the window of panel `id`, if this plugin has one open. Answers
/// `true` when a window was closed and `false` when there was none (never
/// opened, or already gone) - an unknown id is not an error, the caller only
/// wants the window not to be there. Only windows this plugin built are
/// closed; an app window that merely has the label is left alone (`false`).
///
/// For the frontend that puts the panel back into the dock by itself (a
/// layout reset: `@banto/admin-core`'s `createPanelPopOut(...).closeWindows`,
/// Issue #1021). The window goes the usual way from there: its geometry is
/// kept and the main window still gets `banto://panel-closed` - `true` tells
/// the caller that this notice is on its way, so it can tell it from one of a
/// window the user closed.
///
/// `destroy`, not `close`: nothing in a panel can veto it (the same as when
/// the main window closes). `async` like `open`: window work from a
/// synchronous command can deadlock on Windows.
///
/// Like `open` outside conventions §1: no data is written, there is no REST
/// twin.
#[tauri::command]
async fn close<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PanelState>,
    id: String,
) -> Result<bool, String> {
    validate_panel_id(&id).map_err(|err| err.to_string())?;
    let label = state.config.label_for(&id);
    if !state.is_tracked(&label) {
        return Ok(false);
    }
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    window.destroy().map_err(|err| err.to_string())?;
    Ok(true)
}

/// Takes the window's current place into the memory. Skipped while the
/// window is hidden (the restore above is still moving it), minimised,
/// maximised or fullscreen - none of those is a place to reopen at.
fn record<R: Runtime>(app: &AppHandle<R>, state: &PanelState, label: &str, id: &str) {
    if !state.config.remember_geometry {
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if !window.is_visible().unwrap_or(true)
        || window.is_minimized().unwrap_or(false)
        || window.is_maximized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    state.remember(
        id,
        PanelGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
    );
}

fn on_window_event<R: Runtime>(app: &AppHandle<R>, label: &str, event: &WindowEvent) {
    let Some(state) = app.try_state::<PanelState>() else {
        return;
    };
    let config = &state.config;

    // Only windows this plugin built (`validate` keeps the main label out
    // of that set).
    if let Some(id) = state.id_of(label) {
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => record(app, &state, label, &id),
            WindowEvent::Destroyed => {
                state.untrack(label);
                state.persist();
                // Best effort: the main window may already be gone (the app
                // is closing) - then nobody needs the notice.
                let _ = app.emit_to(config.main_label.as_str(), PANEL_CLOSED_EVENT, id);
            }
            _ => {}
        }
        return;
    }

    if label == config.main_label
        && config.close_with_main
        && matches!(event, WindowEvent::Destroyed)
    {
        // Written here as well: the app may exit before the panels'
        // own `Destroyed` events are delivered.
        state.persist();
        for other in state.tracked_labels() {
            if let Some(window) = app.get_webview_window(&other) {
                // `destroy`, not `close`: nothing in a panel can veto it.
                let _ = window.destroy();
            }
        }
    }
}

/// Configures the plugin. Every setter has the template's behaviour as its
/// default ([`PanelConfig::default`]).
#[derive(Debug, Clone, Default)]
pub struct Builder {
    config: PanelConfig,
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts from a whole [`PanelConfig`].
    pub fn config(mut self, config: PanelConfig) -> Self {
        self.config = config;
        self
    }

    /// Route of a panel window, `{id}` replaced by the panel id (default
    /// `panel/{id}`).
    pub fn route(mut self, route: impl Into<String>) -> Self {
        self.config.route = route.into();
        self
    }

    /// Label of the main window (default `main`).
    pub fn main_label(mut self, label: impl Into<String>) -> Self {
        self.config.main_label = label.into();
        self
    }

    /// Prefix of the panel windows' labels (default `panel-`).
    pub fn label_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.config.label_prefix = prefix.into();
        self
    }

    /// Default inner size in logical pixels (default 560x420).
    pub fn default_size(mut self, width: f64, height: f64) -> Self {
        self.config.default_size = (width, height);
        self
    }

    /// Minimum inner size in logical pixels (default 320x240).
    pub fn min_size(mut self, width: f64, height: f64) -> Self {
        self.config.min_size = (width, height);
        self
    }

    /// Remember position and size per panel id (default on).
    pub fn remember_geometry(mut self, on: bool) -> Self {
        self.config.remember_geometry = on;
        self
    }

    /// Close the panel windows with the main window (default on).
    pub fn close_with_main(mut self, on: bool) -> Self {
        self.config.close_with_main = on;
        self
    }

    /// Where the geometry memory is kept (default: `panel-windows.json` in
    /// the app's data dir).
    pub fn store_path(mut self, path: impl Into<std::path::PathBuf>) -> Self {
        self.config.store_path = Some(path.into());
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let config = self.config;
        PluginBuilder::new(PLUGIN_NAME)
            .invoke_handler(tauri::generate_handler![open, list, close])
            .setup(move |app, _api| {
                // A bad configuration stops the app at start-up with the
                // reason (an `Err`, not a panic).
                config.validate()?;
                let store = if config.remember_geometry {
                    config
                        .store_path
                        .clone()
                        .or_else(|| {
                            app.path()
                                .app_data_dir()
                                .ok()
                                .map(|dir| dir.join(DEFAULT_STORE_FILE))
                        })
                        .map(GeometryStore::load)
                } else {
                    None
                };
                app.manage(PanelState {
                    config,
                    store: Mutex::new(store),
                    windows: Mutex::new(HashMap::new()),
                });
                Ok(())
            })
            .on_event(|app, event| {
                if let RunEvent::WindowEvent { label, event, .. } = event {
                    on_window_event(app, label, event);
                }
            })
            .build()
    }
}

/// The plugin with the default settings.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}
