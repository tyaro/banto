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
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

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

/// Asks for the password twice on the terminal. Echo is turned off BEFORE the
/// first prompt is shown and restored only after the second line is read, so
/// nothing typed in between can appear (a type-ahead right after the prompt
/// included). If echo cannot be turned off this fails without reading: a
/// plain-text fallback would break the promise the prompt makes.
///
/// Ctrl+C (and, on Unix, SIGTERM / SIGHUP) restores the terminal too, then
/// ends the process the usual way.
pub fn read_password_twice_hidden(
    first_prompt: &str,
    second_prompt: &str,
) -> io::Result<(String, String)> {
    let guard = EchoOff::new()?;
    let mut stdin = io::stdin().lock();
    eprint!("{first_prompt}");
    let first = read_password_line(&mut stdin);
    eprintln!();
    let first = first?;
    eprint!("{second_prompt}");
    let second = read_password_line(&mut stdin);
    eprintln!();
    drop(guard);
    Ok((first, second?))
}

/// Set while an [`EchoOff`] exists. The saved mode and the interrupt handlers
/// are process-wide, so a second concurrent guard is refused instead of racing.
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Restores the previous console / terminal mode on drop (and from the
/// interrupt handler, which `Drop` cannot cover: the default Ctrl+C action
/// ends the process without unwinding).
struct EchoOff {
    #[cfg(unix)]
    old_handlers: [libc::sighandler_t; UNIX_SIGNALS.len()],
}

fn claim() -> io::Result<()> {
    if ACTIVE.swap(true, AtomicOrdering::SeqCst) {
        return Err(io::Error::other(
            "端末の入力の非表示は同時に 2 つ使えません",
        ));
    }
    Ok(())
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleCtrlHandler, SetConsoleMode, CTRL_BREAK_EVENT,
        CTRL_CLOSE_EVENT, CTRL_C_EVENT, ENABLE_ECHO_INPUT, STD_INPUT_HANDLE,
    };

    static HANDLE_BITS: AtomicUsize = AtomicUsize::new(0);
    static SAVED_MODE: AtomicU32 = AtomicU32::new(0);

    fn restore() {
        let handle = HANDLE_BITS.load(Ordering::SeqCst) as HANDLE;
        // SAFETY: the handle is the process's stdin handle stored by `echo_off`.
        unsafe {
            SetConsoleMode(handle, SAVED_MODE.load(Ordering::SeqCst));
        }
    }

    /// Runs on a thread the system starts. Returns FALSE (0) so the next handler,
    /// the default one that ends the process, still runs.
    unsafe extern "system" fn on_ctrl(ctrl_type: u32) -> i32 {
        if matches!(
            ctrl_type,
            CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT
        ) {
            restore();
        }
        0
    }

    pub fn echo_off() -> std::io::Result<()> {
        // SAFETY: plain Win32 calls on the process's own stdin handle; `saved`
        // is a valid out pointer for the duration of the call.
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            let mut saved = 0u32;
            if GetConsoleMode(handle, &mut saved) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            HANDLE_BITS.store(handle as usize, Ordering::SeqCst);
            SAVED_MODE.store(saved, Ordering::SeqCst);
            // Registered before the mode changes so an interrupt in between
            // is covered.
            if SetConsoleCtrlHandler(Some(on_ctrl), 1) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if SetConsoleMode(handle, saved & !ENABLE_ECHO_INPUT) == 0 {
                let err = std::io::Error::last_os_error();
                SetConsoleCtrlHandler(Some(on_ctrl), 0);
                return Err(err);
            }
        }
        Ok(())
    }

    pub fn echo_restore() {
        restore();
        // SAFETY: removes the handler added in `echo_off`.
        unsafe {
            SetConsoleCtrlHandler(Some(on_ctrl), 0);
        }
    }
}

#[cfg(windows)]
impl EchoOff {
    fn new() -> io::Result<Self> {
        claim()?;
        if let Err(err) = win::echo_off() {
            ACTIVE.store(false, AtomicOrdering::SeqCst);
            return Err(err);
        }
        Ok(Self {})
    }
}

#[cfg(windows)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        win::echo_restore();
        ACTIVE.store(false, AtomicOrdering::SeqCst);
    }
}

#[cfg(unix)]
const UNIX_SIGNALS: [libc::c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

#[cfg(unix)]
static mut SAVED_TERMIOS: std::mem::MaybeUninit<libc::termios> = std::mem::MaybeUninit::uninit();

/// Restores the terminal, then re-raises the signal with its default action.
/// Only async-signal-safe calls (`tcsetattr`, `signal`, `raise`).
#[cfg(unix)]
extern "C" fn on_signal(sig: libc::c_int) {
    // SAFETY: `SAVED_TERMIOS` is written once in `EchoOff::new` before this
    // handler is installed and not touched again until it is removed.
    unsafe {
        let saved = std::ptr::addr_of!(SAVED_TERMIOS);
        libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, (*saved).as_ptr());
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

#[cfg(unix)]
impl EchoOff {
    fn new() -> io::Result<Self> {
        claim()?;
        let result = Self::enter();
        if result.is_err() {
            ACTIVE.store(false, AtomicOrdering::SeqCst);
        }
        result
    }

    fn enter() -> io::Result<Self> {
        // SAFETY: `termios` is plain data; `tcgetattr`/`tcsetattr` get a valid
        // pointer for the duration of the call, on fd 0 (stdin). `claim()` made
        // this the only guard, so the statics are written without a race, and
        // the handlers are installed after the statics they read are set.
        unsafe {
            let mut saved: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut saved) != 0 {
                return Err(io::Error::last_os_error());
            }
            (*std::ptr::addr_of_mut!(SAVED_TERMIOS)).write(saved);
            let mut old_handlers = [libc::SIG_DFL; UNIX_SIGNALS.len()];
            let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
            for (i, sig) in UNIX_SIGNALS.into_iter().enumerate() {
                let old = libc::signal(sig, handler);
                if old == libc::SIG_ERR {
                    let err = io::Error::last_os_error();
                    // Put back only what was installed so far.
                    for (done, old) in UNIX_SIGNALS.into_iter().zip(old_handlers).take(i) {
                        libc::signal(done, old);
                    }
                    return Err(err);
                }
                old_handlers[i] = old;
            }
            let guard = Self { old_handlers };
            let mut quiet = saved;
            quiet.c_lflag &= !libc::ECHO;
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &quiet) != 0 {
                // `guard` drops here and restores the handlers (and the flag).
                return Err(io::Error::last_os_error());
            }
            Ok(guard)
        }
    }
}

#[cfg(unix)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        // SAFETY: restores the attributes saved in `new` and the old handlers.
        unsafe {
            let saved = std::ptr::addr_of!(SAVED_TERMIOS);
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, (*saved).as_ptr());
            for (old, sig) in self.old_handlers.iter().zip(UNIX_SIGNALS) {
                libc::signal(sig, *old);
            }
        }
        ACTIVE.store(false, AtomicOrdering::SeqCst);
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
    fn a_second_concurrent_guard_is_refused() {
        claim().unwrap();
        assert!(claim().is_err());
        ACTIVE.store(false, AtomicOrdering::SeqCst);
        claim().unwrap();
        ACTIVE.store(false, AtomicOrdering::SeqCst);
    }

    #[test]
    fn confirmation_must_match_exactly() {
        assert!(confirmation_matches("a b", "a b"));
        assert!(!confirmation_matches("abc", "abd"));
        assert!(!confirmation_matches("abc", "abc "));
    }
}
