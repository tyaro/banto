//! Window geometry of a pop-out panel and the "is it still on a screen?"
//! judgement (ADR-0037). Pure: no Tauri type appears here, so the rules are
//! unit-tested in CI's headless build.
//!
//! All values are **physical pixels** in the desktop's coordinate space (what
//! Tauri's `outer_position` / `inner_size` / `Monitor::position` /
//! `Monitor::size` report). Physical, not logical, because a logical value
//! only has a meaning together with one monitor's scale factor, and the
//! window may be restored onto a different monitor than the main window's.

use serde::{Deserialize, Serialize};

/// Height of the strip at the top of the window that must be reachable
/// (roughly a title bar): the part a user grabs to move the window back.
const TITLE_STRIP_HEIGHT: i32 = 32;
/// How much of that strip must lie on one monitor, horizontally.
const MIN_VISIBLE_WIDTH: i64 = 100;
/// A window's outer position may sit a few pixels outside its monitor
/// (Windows reports the invisible resize border; a snapped or maximised
/// window is at about -8). Tolerated above and to the sides, not below.
const EDGE_TOLERANCE: i32 = 16;
/// Smaller than this is not a size a user chose (a minimised window reports
/// `0x0` on some platforms).
const MIN_PLAUSIBLE_SIZE: u32 = 50;
/// Larger than this is not a real window either (guards a corrupt file).
const MAX_PLAUSIBLE_SIZE: u32 = 32_768;
/// Windows parks a minimised window at `(-32000, -32000)`.
const MINIMIZED_SENTINEL: i32 = -32_000;

/// Where a panel window was and how large (outer position, inner size).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl PanelGeometry {
    /// `false` for values that are not a window a user placed: a minimised
    /// window's sentinel position, or a zero / absurd size. Such a value is
    /// neither remembered nor restored.
    pub fn is_plausible(&self) -> bool {
        let size_ok = |v: u32| (MIN_PLAUSIBLE_SIZE..=MAX_PLAUSIBLE_SIZE).contains(&v);
        size_ok(self.width)
            && size_ok(self.height)
            && self.x > MINIMIZED_SENTINEL
            && self.y > MINIMIZED_SENTINEL
    }
}

/// One monitor's rectangle in the desktop's coordinate space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Whether a window at `geometry` could still be seen and grabbed on one of
/// `monitors`: its top strip must lie inside a monitor vertically, and at
/// least [`MIN_VISIBLE_WIDTH`] pixels of it (or the whole window, if
/// narrower) horizontally. With no monitor known the answer is `false` (the
/// caller then falls back to the default placement).
pub fn is_on_screen(geometry: &PanelGeometry, monitors: &[MonitorRect]) -> bool {
    if !geometry.is_plausible() {
        return false;
    }
    let left = i64::from(geometry.x);
    let right = left + i64::from(geometry.width);
    let top = i64::from(geometry.y);
    let needed = MIN_VISIBLE_WIDTH.min(i64::from(geometry.width));

    monitors.iter().any(|m| {
        let m_left = i64::from(m.x);
        let m_right = m_left + i64::from(m.width);
        let m_top = i64::from(m.y);
        let m_bottom = m_top + i64::from(m.height);

        let overlap = right.min(m_right) - left.max(m_left);
        let strip_inside = top >= m_top - i64::from(EDGE_TOLERANCE)
            && top + i64::from(TITLE_STRIP_HEIGHT) <= m_bottom;
        overlap >= needed && strip_inside
    })
}

/// The geometry to restore a panel window to: the remembered one if it is
/// still on a screen, otherwise `None` (= open at the default position and
/// size - a monitor was unplugged, the resolution changed, ...).
pub fn restorable(saved: Option<PanelGeometry>, monitors: &[MonitorRect]) -> Option<PanelGeometry> {
    saved.filter(|g| is_on_screen(g, monitors))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: MonitorRect = MonitorRect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    /// A second monitor to the LEFT of the primary (negative coordinates).
    const LEFT: MonitorRect = MonitorRect {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
    };

    fn geom(x: i32, y: i32, width: u32, height: u32) -> PanelGeometry {
        PanelGeometry {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn window_inside_a_monitor_is_on_screen() {
        assert!(is_on_screen(&geom(100, 100, 560, 420), &[PRIMARY]));
    }

    #[test]
    fn window_on_the_second_monitor_is_on_screen_only_while_it_is_attached() {
        let g = geom(-1500, 200, 560, 420);
        assert!(is_on_screen(&g, &[PRIMARY, LEFT]));
        assert!(!is_on_screen(&g, &[PRIMARY]));
        assert_eq!(restorable(Some(g), &[PRIMARY, LEFT]), Some(g));
        assert_eq!(restorable(Some(g), &[PRIMARY]), None);
    }

    #[test]
    fn nothing_saved_restores_nothing() {
        assert_eq!(restorable(None, &[PRIMARY]), None);
    }

    #[test]
    fn no_monitor_known_is_off_screen() {
        assert!(!is_on_screen(&geom(100, 100, 560, 420), &[]));
    }

    #[test]
    fn a_sliver_at_the_right_edge_is_off_screen() {
        // Only 50px of the title strip is on the monitor.
        assert!(!is_on_screen(&geom(1870, 100, 560, 420), &[PRIMARY]));
        // 100px is enough.
        assert!(is_on_screen(&geom(1820, 100, 560, 420), &[PRIMARY]));
    }

    #[test]
    fn a_window_spanning_two_monitors_counts_the_better_one() {
        // 60px on LEFT, 500px on PRIMARY.
        assert!(is_on_screen(&geom(-60, 100, 560, 420), &[LEFT, PRIMARY]));
    }

    #[test]
    fn title_strip_below_or_above_the_monitor_is_off_screen() {
        assert!(!is_on_screen(&geom(100, 1070, 560, 420), &[PRIMARY]));
        assert!(!is_on_screen(&geom(100, -200, 560, 420), &[PRIMARY]));
    }

    #[test]
    fn the_resize_border_overhang_is_tolerated() {
        // A snapped / maximised window on Windows sits at about (-8, -8).
        assert!(is_on_screen(&geom(-8, -8, 1936, 1056), &[PRIMARY]));
    }

    #[test]
    fn a_window_narrower_than_the_minimum_must_be_fully_visible_horizontally() {
        assert!(is_on_screen(&geom(10, 10, 80, 80), &[PRIMARY]));
        assert!(!is_on_screen(&geom(1900, 10, 80, 80), &[PRIMARY]));
    }

    #[test]
    fn minimised_or_degenerate_values_are_not_plausible() {
        assert!(!geom(-32000, -32000, 560, 420).is_plausible());
        assert!(!geom(100, 100, 0, 0).is_plausible());
        assert!(!geom(100, 100, 560, 10).is_plausible());
        assert!(!geom(100, 100, 100_000, 420).is_plausible());
        assert!(geom(100, 100, 560, 420).is_plausible());
        assert!(!is_on_screen(&geom(100, 100, 0, 0), &[PRIMARY]));
    }

    #[test]
    fn extreme_values_do_not_overflow() {
        assert!(!is_on_screen(
            &geom(i32::MAX, i32::MAX, 32_768, 32_768),
            &[PRIMARY]
        ));
        assert!(!is_on_screen(
            &geom(i32::MIN + 1, i32::MIN + 1, 560, 420),
            &[PRIMARY]
        ));
    }
}
