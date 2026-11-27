//! When a panel window is shown (Issue #1024). A panel window is built
//! hidden and shown once its page is there: a screen reader reads a document
//! as soon as its window has the focus, and a window shown while the page was
//! still loading was read as the loading document ("undefined" and the page's
//! URL, on NVDA).
//!
//! "There" is the app's choice ([`RevealOn`]): the page finished loading, or
//! the page said that it has drawn something. The second one is for a page
//! that draws itself after the load (a single-page app): its document is
//! still empty when the load finishes, and a screen reader handed an empty
//! document reads the same "undefined" and URL.
//!
//! The decision is kept here, pure (no Tauri), so it can be tested: the
//! plugin only reports what happened ([`RevealSignal`]) and shows the window
//! when [`Reveal::signal`] answers `true` - which it does exactly once.

use std::sync::Mutex;
use std::time::Duration;

use crate::config::validate_panel_id;

/// Default for [`crate::PanelConfig::reveal_timeout_ms`]: how long a panel
/// window waits for its page before it is shown anyway.
pub const DEFAULT_REVEAL_TIMEOUT_MS: u64 = 3_000;

/// Upper bound of [`crate::PanelConfig::reveal_timeout_ms`]. The timeout is
/// the way out for a page that never reports its load; a larger value would
/// leave such a window invisible for longer than anybody waits.
pub const MAX_REVEAL_TIMEOUT_MS: u64 = 60_000;

/// What a panel window, built hidden, waits for before it is shown
/// ([`crate::PanelConfig::reveal_on`]). Whichever it is, the window is shown
/// after [`crate::PanelConfig::reveal_timeout_ms`] at the latest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RevealOn {
    /// The page finished loading (the webview's own report). Needs nothing
    /// from the page. Right for a page whose document has its content when
    /// the load ends; a page that draws itself afterwards is shown empty.
    #[default]
    PageLoad,
    /// The page told the plugin that it has drawn its first content, by
    /// emitting [`crate::PANEL_READY_EVENT`] with its panel id
    /// (`@banto/admin-core`'s `notifyPanelReady`). The finished load alone
    /// does not show the window. A page that never tells is shown when the
    /// timeout is over - so with this value the page MUST tell.
    Ready,
}

/// What the plugin has seen happen to a window it built hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevealSignal {
    /// The window is where it belongs: the remembered position and size have
    /// been applied (or there was nothing to restore).
    Placed,
    /// The page finished loading. A page reports it again on every later
    /// full load; those are ignored.
    Loaded,
    /// The page told that it has drawn its first content
    /// ([`crate::PANEL_READY_EVENT`]). A page may tell more than once.
    Ready,
    /// The wait for the page is over (no report came, or the load failed
    /// without one): the window is shown whatever its page is doing.
    TimedOut,
}

#[derive(Debug, Default)]
struct RevealState {
    placed: bool,
    /// What the window waits for ([`RevealOn`]) has happened, or the wait
    /// for it has been given up.
    ready: bool,
    shown: bool,
}

/// Decides when a window built hidden is shown: once it is placed AND its
/// page is there (loaded or drawn, as [`RevealOn`] says - or the wait timed
/// out) - in whichever order the two arrive, since the page's report comes
/// on another thread than the one that places the window - and never a
/// second time.
#[derive(Debug, Default)]
pub struct Reveal {
    on: RevealOn,
    state: Mutex<RevealState>,
}

impl Reveal {
    /// `on`: which of the page's two reports this window waits for. The
    /// other one is ignored ([`RevealOn::Ready`] does not show on a finished
    /// load; [`RevealOn::PageLoad`] does not need the page to tell).
    pub fn new(on: RevealOn) -> Self {
        Self {
            on,
            state: Mutex::default(),
        }
    }

    /// Takes one signal. `true` = show (and focus) the window now. Answers
    /// `true` at most once for the life of the value, so two callers racing
    /// (the page's report and the timeout) cannot both show the window.
    pub fn signal(&self, signal: RevealSignal) -> bool {
        // A poisoned lock still holds a usable state (three flags).
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        match signal {
            RevealSignal::Placed => state.placed = true,
            RevealSignal::Loaded => state.ready |= self.on == RevealOn::PageLoad,
            RevealSignal::Ready => state.ready |= self.on == RevealOn::Ready,
            RevealSignal::TimedOut => state.ready = true,
        }
        if state.shown || !state.placed || !state.ready {
            return false;
        }
        state.shown = true;
        true
    }
}

/// The wait before a window is shown without its page's report. `None` = do
/// not wait at all (`reveal_timeout_ms` is 0): the window is shown as soon
/// as it is placed, as it was before #1024.
pub fn reveal_timeout(timeout_ms: u64) -> Option<Duration> {
    (timeout_ms > 0).then(|| Duration::from_millis(timeout_ms))
}

/// Reads the payload of [`crate::PANEL_READY_EVENT`] as Tauri hands it over
/// (JSON text): the panel id of the page that tells it is drawn. `None` for
/// anything that is not a JSON string holding a valid panel id - such a
/// notice shows no window.
pub fn ready_panel_id(payload: &str) -> Option<String> {
    let id: String = serde_json::from_str(payload).ok()?;
    validate_panel_id(&id).ok()?;
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use RevealSignal::{Loaded, Placed, Ready, TimedOut};

    fn answers_on(on: RevealOn, signals: &[RevealSignal]) -> Vec<bool> {
        let reveal = Reveal::new(on);
        signals.iter().map(|s| reveal.signal(*s)).collect()
    }

    /// The default: shown on the finished load.
    fn answers(signals: &[RevealSignal]) -> Vec<bool> {
        answers_on(RevealOn::PageLoad, signals)
    }

    fn answers_ready(signals: &[RevealSignal]) -> Vec<bool> {
        answers_on(RevealOn::Ready, signals)
    }

    #[test]
    fn the_default_waits_for_the_finished_load() {
        assert_eq!(RevealOn::default(), RevealOn::PageLoad);
        let reveal = Reveal::default();
        assert!(!reveal.signal(Placed));
        assert!(reveal.signal(Loaded));
    }

    #[test]
    fn waiting_for_the_page_to_tell_a_finished_load_does_not_show() {
        // The load of a page that draws itself afterwards ends on an empty
        // document; that is what must not get the focus.
        assert_eq!(answers_ready(&[Placed, Loaded]), [false, false]);
        assert_eq!(
            answers_ready(&[Loaded, Placed, Loaded]),
            [false, false, false]
        );
    }

    #[test]
    fn waiting_for_the_page_to_tell_its_notice_shows() {
        assert_eq!(
            answers_ready(&[Placed, Loaded, Ready]),
            [false, false, true]
        );
        // The notice alone is enough (no finished load was seen).
        assert_eq!(answers_ready(&[Placed, Ready]), [false, true]);
        // Told before the window is placed: shown when it is.
        assert_eq!(answers_ready(&[Ready, Placed]), [false, true]);
    }

    #[test]
    fn waiting_for_the_page_to_tell_never_shows_twice() {
        assert_eq!(
            answers_ready(&[Placed, Ready, Ready, Loaded, TimedOut]),
            [false, true, false, false, false]
        );
        assert_eq!(
            answers_ready(&[Placed, TimedOut, Ready]),
            [false, true, false]
        );
    }

    #[test]
    fn the_timeout_shows_a_window_whose_page_never_told() {
        assert_eq!(
            answers_ready(&[Placed, Loaded, TimedOut]),
            [false, false, true]
        );
        // No wait configured: shown as soon as it is placed.
        assert_eq!(answers_ready(&[TimedOut, Placed]), [false, true]);
    }

    #[test]
    fn waiting_for_the_load_a_notice_from_the_page_is_ignored() {
        // An app that did not ask for it behaves as before, whatever its
        // page emits.
        assert_eq!(answers(&[Placed, Ready]), [false, false]);
        assert_eq!(answers(&[Placed, Ready, Loaded]), [false, false, true]);
    }

    #[test]
    fn the_notice_names_a_panel_id_as_a_json_string() {
        assert_eq!(ready_panel_id(r#""memo""#), Some("memo".to_string()));
        assert_eq!(ready_panel_id(r#""kpi_2-a""#), Some("kpi_2-a".to_string()));
        for bad in [
            "",
            "memo",
            "null",
            "42",
            r#"{"id":"memo"}"#,
            r#"["memo"]"#,
            r#""""#,
            r#""../main""#,
            r#""a b""#,
        ] {
            assert_eq!(ready_panel_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn shown_when_the_page_has_loaded_after_the_window_was_placed() {
        assert_eq!(answers(&[Placed, Loaded]), [false, true]);
    }

    #[test]
    fn a_page_that_loads_before_the_window_is_placed_waits_for_the_place() {
        // The restore must come first: position, size, then show.
        assert_eq!(answers(&[Loaded, Placed]), [false, true]);
    }

    #[test]
    fn the_timeout_shows_a_window_whose_page_never_reported() {
        assert_eq!(answers(&[Placed, TimedOut]), [false, true]);
    }

    #[test]
    fn never_shown_twice() {
        // The page's report and the timeout both arrive, in either order;
        // a page reports further loads later.
        assert_eq!(answers(&[Placed, Loaded, TimedOut]), [false, true, false]);
        assert_eq!(answers(&[Placed, TimedOut, Loaded]), [false, true, false]);
        assert_eq!(
            answers(&[Placed, Loaded, Loaded, Loaded, Placed]),
            [false, true, false, false, false]
        );
    }

    #[test]
    fn nothing_is_shown_before_it_is_placed() {
        assert_eq!(answers(&[Loaded, TimedOut, Loaded]), [false, false, false]);
        // No wait configured: the plugin gives up the wait first, and the
        // window is shown as soon as it is placed.
        assert_eq!(answers(&[TimedOut, Placed]), [false, true]);
    }

    #[test]
    fn racing_signals_show_the_window_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        for _ in 0..50 {
            let reveal = Arc::new(Reveal::default());
            let shown = Arc::new(AtomicUsize::new(0));
            reveal.signal(Placed);
            let threads: Vec<_> = [Loaded, TimedOut, Loaded, TimedOut]
                .into_iter()
                .map(|signal| {
                    let (reveal, shown) = (reveal.clone(), shown.clone());
                    std::thread::spawn(move || {
                        if reveal.signal(signal) {
                            shown.fetch_add(1, Ordering::SeqCst);
                        }
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }
            assert_eq!(shown.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn the_timeout_is_read_from_milliseconds_and_zero_means_no_wait() {
        assert_eq!(reveal_timeout(0), None);
        assert_eq!(
            reveal_timeout(DEFAULT_REVEAL_TIMEOUT_MS),
            Some(Duration::from_secs(3))
        );
    }
}
