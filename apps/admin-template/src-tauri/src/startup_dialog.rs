//! Tells the user why the desktop app refused to start (Issue #975).
//!
//! The release build on Windows uses `windows_subsystem = "windows"`, so it
//! has no console: the "起動できません" line on stderr goes nowhere and the
//! window simply never appears. On Windows a native message box is shown
//! before the process exits; other platforms keep the stderr line only.
//! No log file is written (decision on #975).

/// Title of the message box.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const DIALOG_TITLE: &str = "banto - 起動できません";

/// Body of the message box: the reason (which already carries what to do
/// next, e.g. the `create-admin` hint) as is. Pure, so it can be tested.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn dialog_message(reason: &str) -> String {
    format!("banto を起動できませんでした。\n\n{}", reason.trim())
}

/// UTF-16, NUL-terminated, for the wide Win32 APIs. An interior NUL would
/// cut the text short, so it is replaced by a space.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn to_wide_nul(text: &str) -> Vec<u16> {
    text.chars()
        .map(|c| if c == '\0' { ' ' } else { c })
        .collect::<String>()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

/// Shows the message box (blocks until it is closed). No-op off Windows.
#[cfg(windows)]
pub(crate) fn show_startup_refused(reason: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title = to_wide_nul(DIALOG_TITLE);
    let body = to_wide_nul(&dialog_message(reason));
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call;
    // a null owner window is allowed.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
pub(crate) fn show_startup_refused(_reason: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_keeps_reason_and_trims() {
        let m = dialog_message("  管理者がいません。create-admin を実行してください。\n");
        assert!(m.starts_with("banto を起動できませんでした。"));
        assert!(m.ends_with("create-admin を実行してください。"));
    }

    #[test]
    fn wide_is_utf16_nul_terminated() {
        let w = to_wide_nul("あA😀");
        assert_eq!(w.last(), Some(&0));
        assert_eq!(String::from_utf16(&w[..w.len() - 1]).unwrap(), "あA😀");
        assert_eq!(w.iter().filter(|&&u| u == 0).count(), 1);
    }

    #[test]
    fn wide_replaces_interior_nul() {
        let w = to_wide_nul("a\0b");
        assert_eq!(w, vec![b'a' as u16, b' ' as u16, b'b' as u16, 0]);
    }
}
