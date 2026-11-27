//! When a panel window is shown (Issue #1024). A panel window is built
//! hidden and shown once its page has finished loading: a screen reader reads
//! a document as soon as its window has the focus, and a window shown while
//! the page was still loading was read as the loading document ("undefined"
//! and the page's URL, on NVDA).
//!
//! The decision is kept here, pure (no Tauri), so it can be tested: the
//! plugin only reports what happened ([`RevealSignal`]) and shows the window
//! when [`Reveal::signal`] answers `true` - which it does exactly once.

use std::sync::Mutex;
use std::time::Duration;

/// Default for [`crate::PanelConfig::reveal_timeout_ms`]: how long a panel
/// window waits for its page before it is shown anyway.
pub const DEFAULT_REVEAL_TIMEOUT_MS: u64 = 3_000;

/// Upper bound of [`crate::PanelConfig::reveal_timeout_ms`]. The timeout is
/// the way out for a page that never reports its load; a larger value would
/// leave such a window invisible for longer than anybody waits.
pub const MAX_REVEAL_TIMEOUT_MS: u64 = 60_000;

/// What the plugin has seen happen to a window it built hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevealSignal {
    /// The window is where it belongs: the remembered position and size have
    /// been applied (or there was nothing to restore).
    Placed,
    /// The page finished loading. A page reports it again on every later
    /// full load; those are ignored.
    Loaded,
    /// The wait for the page is over (no report came, or the load failed
    /// without one): the window is shown whatever its page is doing.
    TimedOut,
}

#[derive(Debug, Default)]
struct RevealState {
    placed: bool,
    /// The page is loaded, or the wait for it has been given up.
    ready: bool,
    shown: bool,
}

/// Decides when a window built hidden is shown: once it is placed AND its
/// page is loaded (or the wait timed out) - in whichever order the two
/// arrive, since the page's report comes on another thread than the one
/// that places the window - and never a second time.
#[derive(Debug, Default)]
pub struct Reveal {
    state: Mutex<RevealState>,
}

impl Reveal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes one signal. `true` = show (and focus) the window now. Answers
    /// `true` at most once for the life of the value, so two callers racing
    /// (the page's report and the timeout) cannot both show the window.
    pub fn signal(&self, signal: RevealSignal) -> bool {
        // A poisoned lock still holds a usable state (three flags).
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        match signal {
            RevealSignal::Placed => state.placed = true,
            RevealSignal::Loaded | RevealSignal::TimedOut => state.ready = true,
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

#[cfg(test)]
mod tests {
    use super::*;
    use RevealSignal::{Loaded, Placed, TimedOut};

    fn answers(signals: &[RevealSignal]) -> Vec<bool> {
        let reveal = Reveal::new();
        signals.iter().map(|s| reveal.signal(*s)).collect()
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
            let reveal = Arc::new(Reveal::new());
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
