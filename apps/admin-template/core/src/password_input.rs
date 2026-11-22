//! Password entry for `banto-serve create-admin` (Issue #866, ADR-0002).
//!
//! From a terminal the typed password must not be echoed; from a pipe or a
//! file it is read as one plain line, exactly as before (CI and scripts rely
//! on that). The reading is split from the echo switch so the line handling is
//! testable without a terminal: [`read_password_line`] works on any `BufRead`,
//! [`EchoOff`] is the only part that touches the console / termios.
//!
//! The terminal control is a small `unsafe` FFI surface kept in this one file,
//! over crates that are already in the build (`windows-sys`, `libc`), instead
//! of adding `rpassword` (see the PR for the comparison).

use std::io::{self, BufRead, IsTerminal};

/// Reads one line and strips the trailing `\r\n` / `\n` (only those; spaces
/// are part of the password). EOF yields an empty string.
pub fn read_password_line<R: BufRead>(input: &mut R) -> io::Result<String> {
    let mut line = String::new();
    input.read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Judges the two entries of a terminal session.
pub fn confirmation_matches(first: &str, second: &str) -> bool {
    first == second
}

/// Whether stdin is an interactive terminal (echo can and should be turned off).
pub fn stdin_is_terminal() -> bool {
    io::stdin().is_terminal()
}

/// Reads one password line from the terminal with echo off, then prints the
/// newline the user's Enter key could not show. Call only when
/// [`stdin_is_terminal`] is true.
pub fn read_password_hidden() -> io::Result<String> {
    let guard = EchoOff::new()?;
    let result = read_password_line(&mut io::stdin().lock());
    drop(guard);
    eprintln!();
    result
}

/// Restores the previous console / terminal mode on drop.
struct EchoOff {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(windows)]
    saved: u32,
    #[cfg(unix)]
    saved: libc::termios,
}

#[cfg(windows)]
impl EchoOff {
    fn new() -> io::Result<Self> {
        use windows_sys::Win32::System::Console::{
            GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_ECHO_INPUT, STD_INPUT_HANDLE,
        };
        // SAFETY: plain Win32 calls on the process's own stdin handle; `saved`
        // is a valid out pointer for the duration of the call.
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            let mut saved = 0u32;
            if GetConsoleMode(handle, &mut saved) == 0 {
                return Err(io::Error::last_os_error());
            }
            if SetConsoleMode(handle, saved & !ENABLE_ECHO_INPUT) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { handle, saved })
        }
    }
}

#[cfg(windows)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Console::SetConsoleMode;
        // SAFETY: restores the mode read in `new` on the same handle.
        unsafe {
            SetConsoleMode(self.handle, self.saved);
        }
    }
}

#[cfg(unix)]
impl EchoOff {
    fn new() -> io::Result<Self> {
        // SAFETY: `termios` is plain data; `tcgetattr`/`tcsetattr` get a valid
        // pointer for the duration of the call, on fd 0 (stdin).
        unsafe {
            let mut saved: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut saved) != 0 {
                return Err(io::Error::last_os_error());
            }
            let mut quiet = saved;
            quiet.c_lflag &= !libc::ECHO;
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &quiet) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { saved })
        }
    }
}

#[cfg(unix)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        // SAFETY: restores the attributes read in `new`.
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &self.saved);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn pipe_path_reads_the_first_line_only() {
        let mut input = Cursor::new("s3cret pass\nignored\n");
        assert_eq!(read_password_line(&mut input).unwrap(), "s3cret pass");
    }

    #[test]
    fn crlf_is_stripped_but_spaces_are_kept() {
        let mut input = Cursor::new(" pw with spaces \r\n");
        assert_eq!(read_password_line(&mut input).unwrap(), " pw with spaces ");
    }

    #[test]
    fn no_trailing_newline_and_eof_are_handled() {
        assert_eq!(read_password_line(&mut Cursor::new("abc")).unwrap(), "abc");
        assert_eq!(read_password_line(&mut Cursor::new("")).unwrap(), "");
    }

    #[test]
    fn confirmation_must_match_exactly() {
        assert!(confirmation_matches("a b", "a b"));
        assert!(!confirmation_matches("abc", "abd"));
        assert!(!confirmation_matches("abc", "abc "));
    }
}
