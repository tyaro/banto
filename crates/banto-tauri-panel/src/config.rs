//! What an app can set about its panel windows, and the id / label / route
//! rules derived from it (ADR-0037). Pure - no Tauri type.

use std::fmt;
use std::path::PathBuf;

use crate::reveal::{RevealOn, DEFAULT_REVEAL_TIMEOUT_MS, MAX_REVEAL_TIMEOUT_MS};

/// Longest panel id accepted.
pub const MAX_PANEL_ID_LEN: usize = 64;
/// Placeholder in [`PanelConfig::route`] that the panel id replaces.
pub const ROUTE_ID_PLACEHOLDER: &str = "{id}";
/// File name of the geometry memory under the app's data dir (the default
/// when [`PanelConfig::store_path`] is `None`).
pub const DEFAULT_STORE_FILE: &str = "panel-windows.json";

/// Why a panel id was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PanelIdError {
    Empty,
    TooLong,
    /// Something other than ASCII letters, digits, `-` and `_`.
    InvalidCharacter,
}

impl fmt::Display for PanelIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PanelIdError::Empty => write!(f, "panel id is empty"),
            PanelIdError::TooLong => {
                write!(f, "panel id is longer than {MAX_PANEL_ID_LEN} characters")
            }
            PanelIdError::InvalidCharacter => write!(
                f,
                "panel id may only contain ASCII letters, digits, '-' and '_'"
            ),
        }
    }
}

impl std::error::Error for PanelIdError {}

/// Why a [`PanelConfig`] was refused by [`PanelConfig::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// `label_prefix` is empty: every window would look like a panel's.
    EmptyLabelPrefix,
    /// `label_prefix` has something other than ASCII letters, digits, `-`
    /// and `_` (Tauri would refuse the labels).
    InvalidLabelPrefix,
    /// `main_label` is empty.
    EmptyMainLabel,
    /// `main_label` starts with `label_prefix`: the main window could not be
    /// told from a panel's.
    MainLabelHasPanelPrefix,
    /// `background` is not `#rrggbb` (see [`parse_background`]).
    InvalidBackground,
    /// `reveal_timeout_ms` is over [`MAX_REVEAL_TIMEOUT_MS`]: a window whose
    /// page never reports its load would stay invisible that long.
    RevealTimeoutTooLong,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::EmptyLabelPrefix => write!(f, "label_prefix is empty"),
            ConfigError::InvalidLabelPrefix => write!(
                f,
                "label_prefix may only contain ASCII letters, digits, '-' and '_'"
            ),
            ConfigError::EmptyMainLabel => write!(f, "main_label is empty"),
            ConfigError::MainLabelHasPanelPrefix => {
                write!(f, "main_label starts with label_prefix")
            }
            ConfigError::InvalidBackground => {
                write!(f, "background must be a colour like \"#rrggbb\"")
            }
            ConfigError::RevealTimeoutTooLong => write!(
                f,
                "reveal_timeout_ms must be at most {MAX_REVEAL_TIMEOUT_MS}"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Why a window background colour was refused by [`parse_background`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundError {
    /// Not `#rrggbb`: no leading `#`, not 7 characters, or a character that
    /// is not a hex digit.
    InvalidFormat,
}

impl fmt::Display for BackgroundError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackgroundError::InvalidFormat => {
                write!(f, "background must be a colour like \"#rrggbb\"")
            }
        }
    }
}

impl std::error::Error for BackgroundError {}

/// Reads a window background colour, `"#rrggbb"` (hex digits of either
/// case), as `(red, green, blue)`. Nothing else is accepted - no alpha, no
/// short form, no colour name: WebView2 (Windows) only knows an alpha of 0 or
/// 255, so the plugin always builds an opaque colour, and one fixed shape is
/// all the frontend needs to send (Issue #1015).
pub fn parse_background(value: &str) -> Result<(u8, u8, u8), BackgroundError> {
    let hex = value
        .strip_prefix('#')
        .ok_or(BackgroundError::InvalidFormat)?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(BackgroundError::InvalidFormat);
    }
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16);
    match (channel(0), channel(2), channel(4)) {
        (Ok(r), Ok(g), Ok(b)) => Ok((r, g, b)),
        _ => Err(BackgroundError::InvalidFormat),
    }
}

/// A panel id comes from the webview and ends up in a window label, in the
/// route the window loads and as a key of the geometry file. Only ASCII
/// letters, digits, `-` and `_` pass, so it can never change the route's
/// shape (`../`, `?`, `#`), break Tauri's label rules, or name anything but
/// one panel (conventions §6: user input is not used as a path).
pub fn validate_panel_id(id: &str) -> Result<(), PanelIdError> {
    if id.is_empty() {
        return Err(PanelIdError::Empty);
    }
    if id.len() > MAX_PANEL_ID_LEN {
        return Err(PanelIdError::TooLong);
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(PanelIdError::InvalidCharacter);
    }
    Ok(())
}

/// Settings of the panel windows. `Default` is the template's behaviour:
/// route `panel/{id}`, main window `main`, labels `panel-<id>`, 560x420
/// (minimum 320x240), geometry remembered, closed together with the main
/// window.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelConfig {
    /// Route of a panel window inside the app's frontend, with
    /// [`ROUTE_ID_PLACEHOLDER`] where the id goes. A leading `/` is ignored.
    pub route: String,
    /// Label of the main window: it receives `banto://panel-closed`, and
    /// closing it closes the panels (if [`Self::close_with_main`]).
    pub main_label: String,
    /// A panel window's label is this prefix + the panel id. The app's
    /// capability file must list `<prefix>*` under `windows` if the panel
    /// windows call any command.
    pub label_prefix: String,
    /// Default inner size (logical pixels) when nothing is remembered or the
    /// remembered place is off screen.
    pub default_size: (f64, f64),
    /// Minimum inner size (logical pixels).
    pub min_size: (f64, f64),
    /// Remember each panel's position and size and reopen it there.
    pub remember_geometry: bool,
    /// Close the panel windows when the main window is closed.
    pub close_with_main: bool,
    /// Where the geometry memory is kept. `None` = `panel-windows.json` in
    /// the app's data dir.
    pub store_path: Option<PathBuf>,
    /// Background colour (`"#rrggbb"`) a panel window is built with, for the
    /// moment before its page is drawn (otherwise the webview is white for
    /// about 2 seconds, which stands out in a dark theme). `None` = the
    /// webview's own default. A colour the frontend passes to `open` wins over
    /// this one (Issue #1015).
    pub background: Option<String>,
    /// What a panel window, built hidden, waits for before it is shown
    /// (Issue #1024; see [`crate::reveal`]). Default
    /// [`RevealOn::PageLoad`]: the page finished loading, nothing is asked
    /// of the page. [`RevealOn::Ready`] waits for the page to tell that it
    /// has drawn (`@banto/admin-core`'s `notifyPanelReady`) - for a page that
    /// draws itself after the load; a page that does not tell is only shown
    /// when [`Self::reveal_timeout_ms`] is over.
    pub reveal_on: RevealOn,
    /// How long (milliseconds) a panel window, built hidden, waits for its
    /// page ([`Self::reveal_on`]) before it is shown anyway - the way out for
    /// a page that never reports (Issue #1024; see [`crate::reveal`]).
    /// `0` = do not wait: the window is shown as soon as it is placed. At
    /// most [`MAX_REVEAL_TIMEOUT_MS`].
    pub reveal_timeout_ms: u64,
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self {
            route: format!("panel/{ROUTE_ID_PLACEHOLDER}"),
            main_label: "main".to_string(),
            label_prefix: "panel-".to_string(),
            default_size: (560.0, 420.0),
            min_size: (320.0, 240.0),
            remember_geometry: true,
            close_with_main: true,
            store_path: None,
            background: None,
            reveal_on: RevealOn::PageLoad,
            reveal_timeout_ms: DEFAULT_REVEAL_TIMEOUT_MS,
        }
    }
}

impl PanelConfig {
    /// Checks the settings that would make the plugin act on windows it did
    /// not create. The plugin calls it in `setup`, so a bad configuration
    /// stops the app at start-up instead of misbehaving later.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.label_prefix.is_empty() {
            return Err(ConfigError::EmptyLabelPrefix);
        }
        if !self
            .label_prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ConfigError::InvalidLabelPrefix);
        }
        if self.main_label.is_empty() {
            return Err(ConfigError::EmptyMainLabel);
        }
        if self.main_label.starts_with(self.label_prefix.as_str()) {
            return Err(ConfigError::MainLabelHasPanelPrefix);
        }
        if let Some(background) = &self.background {
            parse_background(background).map_err(|_| ConfigError::InvalidBackground)?;
        }
        if self.reveal_timeout_ms > MAX_REVEAL_TIMEOUT_MS {
            return Err(ConfigError::RevealTimeoutTooLong);
        }
        Ok(())
    }

    /// Label of the window that shows panel `id`.
    pub fn label_for(&self, id: &str) -> String {
        format!("{}{id}", self.label_prefix)
    }

    /// The panel id of a window label, or `None` if the label is not a panel
    /// window's (wrong prefix, or what follows is not a valid id).
    pub fn panel_id_from_label<'a>(&self, label: &'a str) -> Option<&'a str> {
        if self.label_prefix.is_empty() {
            return None;
        }
        let id = label.strip_prefix(self.label_prefix.as_str())?;
        validate_panel_id(id).ok()?;
        Some(id)
    }

    /// The frontend route of panel `id` (no leading `/`, as
    /// `tauri::WebviewUrl::App` takes it). The id must already be validated.
    pub fn route_for(&self, id: &str) -> String {
        self.route
            .trim_start_matches('/')
            .replace(ROUTE_ID_PLACEHOLDER, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_ids_pass() {
        for id in ["memo", "categoryStock", "low-stock_2", "A1"] {
            assert_eq!(validate_panel_id(id), Ok(()), "{id}");
        }
        assert_eq!(validate_panel_id(&"a".repeat(MAX_PANEL_ID_LEN)), Ok(()));
    }

    #[test]
    fn ids_that_could_change_the_route_or_label_are_refused() {
        assert_eq!(validate_panel_id(""), Err(PanelIdError::Empty));
        assert_eq!(
            validate_panel_id(&"a".repeat(MAX_PANEL_ID_LEN + 1)),
            Err(PanelIdError::TooLong)
        );
        for id in [
            "../login", "a/b", "a\\b", "a?b=1", "a#b", "a b", "a.b", "a:b", "メモ", "a%2Fb",
        ] {
            assert_eq!(
                validate_panel_id(id),
                Err(PanelIdError::InvalidCharacter),
                "{id}"
            );
        }
    }

    #[test]
    fn default_config_matches_the_template() {
        let c = PanelConfig::default();
        assert_eq!(c.route_for("memo"), "panel/memo");
        assert_eq!(c.label_for("memo"), "panel-memo");
        assert_eq!(c.main_label, "main");
        assert!(c.remember_geometry);
        assert!(c.close_with_main);
        assert_eq!(c.store_path, None);
        assert_eq!(c.background, None);
        assert_eq!(c.reveal_on, RevealOn::PageLoad);
        assert_eq!(c.reveal_timeout_ms, 3_000);
    }

    #[test]
    fn a_reveal_timeout_that_would_hide_the_window_too_long_is_refused() {
        let with = |reveal_timeout_ms: u64| PanelConfig {
            reveal_timeout_ms,
            ..PanelConfig::default()
        };
        assert_eq!(with(0).validate(), Ok(()));
        assert_eq!(with(MAX_REVEAL_TIMEOUT_MS).validate(), Ok(()));
        assert_eq!(
            with(MAX_REVEAL_TIMEOUT_MS + 1).validate(),
            Err(ConfigError::RevealTimeoutTooLong)
        );
    }

    #[test]
    fn background_is_read_as_rgb() {
        assert_eq!(parse_background("#000000"), Ok((0, 0, 0)));
        assert_eq!(parse_background("#ffffff"), Ok((255, 255, 255)));
        assert_eq!(parse_background("#1A2b3C"), Ok((0x1a, 0x2b, 0x3c)));
    }

    #[test]
    fn background_of_any_other_shape_is_refused() {
        for value in [
            "",
            "#",
            "000000",
            "#fff",
            "#12345",
            "#1234567",
            "#12345678",
            "#gggggg",
            "#12 456",
            "red",
            "rgb(0,0,0)",
            "#+12345",
            " #123456",
            "#123456 ",
            "#ｆｆｆｆｆｆ",
        ] {
            assert_eq!(
                parse_background(value),
                Err(BackgroundError::InvalidFormat),
                "{value:?}"
            );
        }
    }

    #[test]
    fn a_bad_default_background_is_refused_by_validate() {
        let with = |background: Option<&str>| PanelConfig {
            background: background.map(str::to_string),
            ..PanelConfig::default()
        };
        assert_eq!(with(None).validate(), Ok(()));
        assert_eq!(with(Some("#1e1e2e")).validate(), Ok(()));
        assert_eq!(
            with(Some("dark")).validate(),
            Err(ConfigError::InvalidBackground)
        );
    }

    #[test]
    fn route_template_is_filled_and_a_leading_slash_dropped() {
        let c = PanelConfig {
            route: "/tags/panel/{id}".to_string(),
            ..PanelConfig::default()
        };
        assert_eq!(c.route_for("watch"), "tags/panel/watch");
    }

    #[test]
    fn label_round_trips_to_the_id() {
        let c = PanelConfig::default();
        assert_eq!(c.panel_id_from_label(&c.label_for("memo")), Some("memo"));
        // The id itself may contain the separator.
        assert_eq!(c.panel_id_from_label("panel-low-stock"), Some("low-stock"));
    }

    #[test]
    fn default_config_is_valid() {
        assert_eq!(PanelConfig::default().validate(), Ok(()));
    }

    #[test]
    fn configs_that_would_confuse_windows_are_refused() {
        let with = |prefix: &str, main: &str| PanelConfig {
            label_prefix: prefix.to_string(),
            main_label: main.to_string(),
            ..PanelConfig::default()
        };
        assert_eq!(
            with("", "main").validate(),
            Err(ConfigError::EmptyLabelPrefix)
        );
        assert_eq!(
            with("panel/", "main").validate(),
            Err(ConfigError::InvalidLabelPrefix)
        );
        assert_eq!(
            with("panel-", "").validate(),
            Err(ConfigError::EmptyMainLabel)
        );
        assert_eq!(
            with("panel-", "panel-main").validate(),
            Err(ConfigError::MainLabelHasPanelPrefix)
        );
        assert_eq!(
            with("m", "main").validate(),
            Err(ConfigError::MainLabelHasPanelPrefix)
        );
        assert_eq!(with("panel-", "shell").validate(), Ok(()));
    }

    #[test]
    fn other_windows_are_not_panels() {
        let c = PanelConfig::default();
        assert_eq!(c.panel_id_from_label("main"), None);
        assert_eq!(c.panel_id_from_label("panel-"), None);
        assert_eq!(c.panel_id_from_label("panel-a/b"), None);
        assert_eq!(c.panel_id_from_label("xpanel-memo"), None);
        let no_prefix = PanelConfig {
            label_prefix: String::new(),
            ..PanelConfig::default()
        };
        assert_eq!(no_prefix.panel_id_from_label("main"), None);
    }
}
