//! Keeps two desktop processes off one data folder (Issue #1028).
//!
//! Two guards, both taken before any window or database exists (the plugin's
//! `setup` runs inside `tauri::Builder::build`, ahead of the windows and of
//! the app's own `setup` closure):
//!
//! 1. **Single instance** - the same app (`identifier`) at the same version
//!    starts once. A second start asks the running one to bring its main
//!    window to the front and exits with code 0.
//! 2. **Data folder lock** - a different version (or a debug build next to
//!    an installed one) may run at the same time as far as guard 1 goes, but
//!    it shares the data folder, so the database is exclusive: whoever does
//!    not get the lock shows the startup dialog and exits with code 1 before
//!    the database (and a staged restore) is touched.
//!
//! Both are OS file locks (`std::fs::File::try_lock`, no extra crate) on
//! files in the app data dir, held until the process ends: the OS drops them
//! with the handle, so a crashed process never leaves a stale lock. The data
//! dir comes from the `identifier`, so a renamed app (`scripts/rename.mjs`)
//! gets its own keys without touching this file.
//!
//! The "come to the front" request travels over a loopback TCP port the
//! first instance listens on; the port and a random token sit in a file next
//! to the lock (see [`Endpoint`]). `tauri-plugin-single-instance` is not
//! used: its key is the `identifier` alone and cannot carry the version, and
//! it would add crates (conventions §3).

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime};

/// File name of the database inside the app data dir. The one place the
/// desktop app spells it (`run()` joins it too).
pub(crate) const DB_FILE_NAME: &str = "admin-template.sqlite3";

/// How long a second start keeps trying to reach the first one (the first
/// may still be writing its endpoint file).
const ACTIVATE_ATTEMPTS: u32 = 15;
const ACTIVATE_RETRY_WAIT: Duration = Duration::from_millis(200);
/// Per-connection limit, both sides.
const ACTIVATE_IO_TIMEOUT: Duration = Duration::from_secs(1);

const ACTIVATE_VERB: &str = "activate";
const ACTIVATE_OK: &str = "ok";

// ---------------------------------------------------------------------------
// Keys and paths (pure)
// ---------------------------------------------------------------------------

/// The single-instance key: `identifier` + version, plus `-dev` for a debug
/// build. Only `[A-Za-z0-9._+-]` survives (anything else becomes `_`), so the
/// key is safe as part of a file name.
///
/// `-dev`: `pnpm tauri dev` has the same identifier and version as the
/// installed app. Without the suffix a dev start would only bring the
/// installed app to the front and exit, which looks like `tauri dev` dying
/// for no reason; with it the dev start goes on to the data folder lock and
/// says why it cannot run.
pub(crate) fn single_instance_key(identifier: &str, version: &str, debug_build: bool) -> String {
    let clean = |text: &str| -> String {
        text.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    let mut key = format!("{}-v{}", clean(identifier), clean(version));
    if debug_build {
        key.push_str("-dev");
    }
    key
}

/// Lock file of the single-instance guard, in the app data dir.
pub(crate) fn single_instance_lock_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join(format!("single-instance-{key}.lock"))
}

/// Where the running instance publishes its [`Endpoint`]. A file of its
/// own: on Windows the locked file cannot be read through another handle.
pub(crate) fn single_instance_endpoint_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join(format!("single-instance-{key}.port"))
}

/// Lock file of the data folder guard: next to the database, its file name
/// plus `.lock` (`admin-template.sqlite3.lock`). Not a name SQLite uses
/// (`-journal` / `-wal` / `-shm`), and not `*.sqlite3`, which the backup
/// code lists.
pub(crate) fn data_lock_path(db_path: &Path) -> PathBuf {
    let mut name = db_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".lock");
    db_path.with_file_name(name)
}

/// What the second process tells the user when the data folder is taken.
pub(crate) fn data_in_use_message(data_dir: &Path) -> String {
    format!(
        "データフォルダ {} は、起動中の別のプロセス（このアプリの別の版、または開発用の起動）が使っています。\
         同じデータベースを 2 つから同時には開けないため、起動を止めました。\
         起動中のアプリを終了してから、もう一度起動してください。",
        data_dir.display()
    )
}

/// The lock could not even be tried (not "someone else has it").
pub(crate) fn data_lock_error_message(lock_path: &Path, err: &io::Error) -> String {
    format!(
        "データフォルダのロックファイル {} を確保できません: {err}",
        lock_path.display()
    )
}

/// Same key already running, but it did not answer the "come to the front"
/// request.
pub(crate) fn already_running_message() -> String {
    "このアプリはすでに起動していますが、起動中の窓を前に出せませんでした。\
     タスクバーから起動中の窓を選んでください。見つからないときは、\
     タスクマネージャーで起動中のプロセスを終了してから、もう一度起動してください。"
        .to_string()
}

// ---------------------------------------------------------------------------
// File lock
// ---------------------------------------------------------------------------

/// An exclusive OS lock on a file, held as long as this value lives. Keep it
/// until the process ends; the OS releases it with the handle, also on a
/// crash.
#[derive(Debug)]
pub(crate) struct FileLock {
    _file: File,
}

/// Result of one non-blocking attempt.
#[derive(Debug)]
pub(crate) enum LockAttempt {
    Acquired(FileLock),
    /// Another handle (another process, normally) holds it.
    Held,
}

/// Creates the file if needed and tries to lock it, without waiting.
/// `Err` = the attempt itself failed (cannot create the file, the file
/// system has no locks); "someone else has it" is `Ok(LockAttempt::Held)`.
pub(crate) fn try_lock_file(path: &Path) -> io::Result<LockAttempt> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(LockAttempt::Acquired(FileLock { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(LockAttempt::Held),
        Err(TryLockError::Error(err)) => Err(err),
    }
}

// ---------------------------------------------------------------------------
// "Come to the front" channel
// ---------------------------------------------------------------------------

/// Where the running instance listens (127.0.0.1 only) and the token a
/// request must carry. The token keeps other local users (who cannot read
/// this user's data dir) from poking the window; the request can do nothing
/// but raise it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Endpoint {
    pub(crate) port: u16,
    pub(crate) token: String,
}

impl Endpoint {
    /// File form: the port, a line break, the token.
    pub(crate) fn to_file_text(&self) -> String {
        format!("{}\n{}\n", self.port, self.token)
    }

    /// `None` for anything that is not exactly a port line and a token line
    /// (a half-written or foreign file).
    pub(crate) fn parse(text: &str) -> Option<Endpoint> {
        let mut lines = text.lines();
        let port: u16 = lines.next()?.trim().parse().ok()?;
        let token = lines.next()?.trim();
        if port == 0 || !is_token(token) || lines.any(|l| !l.trim().is_empty()) {
            return None;
        }
        Some(Endpoint {
            port,
            token: token.to_string(),
        })
    }
}

fn is_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 128 unpredictable bits as hex, from std's per-process random hasher keys
/// (seeded by the OS). No random-number crate is a dependency of this crate;
/// the token only gates "raise the window".
fn new_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let part = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", part(), part())
}

/// The request line a second start sends.
pub(crate) fn activation_request(token: &str) -> String {
    format!("{ACTIVATE_VERB} {token}\n")
}

/// Whether `line` is the request for `token`. Compares every byte whatever
/// the input.
pub(crate) fn is_activation_request(line: &str, token: &str) -> bool {
    let Some(given) = line
        .trim_end_matches(['\r', '\n'])
        .strip_prefix(ACTIVATE_VERB)
        .and_then(|rest| rest.strip_prefix(' '))
    else {
        return false;
    };
    let (given, expected) = (given.as_bytes(), token.as_bytes());
    given.len() == expected.len()
        && given
            .iter()
            .zip(expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Reads one short line (at most 128 bytes).
fn read_line(stream: &mut TcpStream) -> io::Result<String> {
    let mut buf = Vec::with_capacity(64);
    let mut byte = [0u8; 1];
    while buf.len() < 128 {
        if stream.read(&mut byte)? == 0 || byte[0] == b'\n' {
            break;
        }
        buf.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Answers one connection: `true` if it carried the right request.
fn answer(stream: &mut TcpStream, token: &str) -> io::Result<bool> {
    stream.set_read_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    let line = read_line(stream)?;
    if !is_activation_request(&line, token) {
        return Ok(false);
    }
    stream.write_all(format!("{ACTIVATE_OK}\n").as_bytes())?;
    Ok(true)
}

/// Binds the loopback listener of the running instance. Port 0: the OS
/// picks a free one.
pub(crate) fn bind_activation_listener() -> io::Result<(TcpListener, Endpoint)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let endpoint = Endpoint {
        port: listener.local_addr()?.port(),
        token: new_token(),
    };
    Ok((listener, endpoint))
}

/// Serves requests until the process ends (blocks; run it on a thread of its
/// own). `on_activate` runs once per valid request.
pub(crate) fn serve_activation(listener: TcpListener, token: String, on_activate: impl Fn()) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        if matches!(answer(&mut stream, &token), Ok(true)) {
            on_activate();
        }
    }
}

/// Asks the instance at `endpoint` to come to the front. `Ok(true)` = it
/// said yes; `Ok(false)` = something else answered on that port.
pub(crate) fn request_activation(endpoint: &Endpoint) -> io::Result<bool> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = TcpStream::connect_timeout(&addr, ACTIVATE_IO_TIMEOUT)?;
    stream.set_read_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    stream.write_all(activation_request(&endpoint.token).as_bytes())?;
    Ok(read_line(&mut stream)?.trim() == ACTIVATE_OK)
}

/// Publishes the endpoint: written to a temporary file, then renamed, so a
/// reader never sees half of it. Owner-only on Unix.
pub(crate) fn write_endpoint_file(path: &Path, endpoint: &Endpoint) -> io::Result<()> {
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(endpoint.to_file_text().as_bytes())?;
    drop(file);
    std::fs::rename(&tmp, path)
}

/// Reads the endpoint file and asks once.
fn activate_once(endpoint_path: &Path) -> bool {
    std::fs::read_to_string(endpoint_path)
        .ok()
        .and_then(|text| Endpoint::parse(&text))
        .is_some_and(|endpoint| matches!(request_activation(&endpoint), Ok(true)))
}

/// A second start: keeps asking the running instance for a short while.
pub(crate) fn activate_running_instance(endpoint_path: &Path) -> bool {
    for attempt in 0..ACTIVATE_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(ACTIVATE_RETRY_WAIT);
        }
        if activate_once(endpoint_path) {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/// The locks of this process, in Tauri's managed state so they live until
/// the process ends. `run()`'s `setup` refuses to open the database without
/// it.
pub(crate) struct InstanceGuards {
    /// `None` when the single-instance lock could not be tried at all (the
    /// data folder lock still protects the database).
    _single_instance: Option<FileLock>,
    _data: FileLock,
}

/// Label of the window a second start brings to the front (the config's one
/// window has no explicit label, so Tauri names it `main`).
const MAIN_WINDOW_LABEL: &str = "main";

fn raise_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    // Not there yet (still starting): nothing to raise, it will appear.
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Takes the single-instance lock, or hands over to the running instance
/// and exits.
fn guard_single_instance<R: Runtime>(
    app: &tauri::AppHandle<R>,
    data_dir: &Path,
) -> Option<FileLock> {
    let key = single_instance_key(
        &app.config().identifier,
        &app.package_info().version.to_string(),
        cfg!(debug_assertions),
    );
    let lock_path = single_instance_lock_path(data_dir, &key);
    let endpoint_path = single_instance_endpoint_path(data_dir, &key);
    let lock = match try_lock_file(&lock_path) {
        Ok(LockAttempt::Acquired(lock)) => lock,
        Ok(LockAttempt::Held) => {
            if activate_running_instance(&endpoint_path) {
                println!("banto: すでに起動しています。起動中の窓を前に出しました");
                std::process::exit(0);
            }
            crate::exit_startup_refused(already_running_message());
        }
        Err(err) => {
            // Not a reason to refuse the start: the data folder lock below
            // is the guard that protects the database.
            eprintln!(
                "banto: 二重起動の検査用のロック {} を確保できません（検査なしで続けます）: {err}",
                lock_path.display()
            );
            return None;
        }
    };
    // Without the listener a second start cannot raise this window; it then
    // shows `already_running_message` instead.
    match bind_activation_listener() {
        Ok((listener, endpoint)) => {
            if let Err(err) = write_endpoint_file(&endpoint_path, &endpoint) {
                eprintln!(
                    "banto: 二重起動の連絡先 {} を書けません: {err}",
                    endpoint_path.display()
                );
            }
            let handle = app.clone();
            let token = endpoint.token;
            if let Err(err) = std::thread::Builder::new()
                .name("banto-single-instance".into())
                .spawn(move || serve_activation(listener, token, || raise_main_window(&handle)))
            {
                eprintln!("banto: 二重起動の連絡用のスレッドを起動できません: {err}");
            }
        }
        Err(err) => eprintln!("banto: 二重起動の連絡用のポートを開けません: {err}"),
    }
    Some(lock)
}

/// The plugin that takes both guards. Register it on the builder before
/// anything that reads or writes the data folder.
pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("instance-guard")
        .setup(|app, _api| {
            let data_dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(err) => crate::exit_startup_refused(format_args!(
                    "データフォルダの場所を決められません: {err}"
                )),
            };
            if let Err(err) = std::fs::create_dir_all(&data_dir) {
                crate::exit_startup_refused(format_args!(
                    "データフォルダ {} を作れません: {err}",
                    data_dir.display()
                ));
            }
            let single_instance = guard_single_instance(app, &data_dir);
            let lock_path = data_lock_path(&data_dir.join(DB_FILE_NAME));
            let data = match try_lock_file(&lock_path) {
                Ok(LockAttempt::Acquired(lock)) => lock,
                Ok(LockAttempt::Held) => {
                    crate::exit_startup_refused(data_in_use_message(&data_dir))
                }
                Err(err) => crate::exit_startup_refused(data_lock_error_message(&lock_path, &err)),
            };
            app.manage(InstanceGuards {
                _single_instance: single_instance,
                _data: data,
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn key_has_identifier_version_and_dev_suffix() {
        assert_eq!(
            single_instance_key("dev.banto.admin", "9.3.0", false),
            "dev.banto.admin-v9.3.0"
        );
        assert_eq!(
            single_instance_key("dev.banto.admin", "9.3.0", true),
            "dev.banto.admin-v9.3.0-dev"
        );
    }

    #[test]
    fn key_differs_by_identifier_version_and_build() {
        let base = single_instance_key("com.example.a", "1.0.0", false);
        assert_ne!(base, single_instance_key("com.example.b", "1.0.0", false));
        assert_ne!(base, single_instance_key("com.example.a", "1.0.1", false));
        assert_ne!(base, single_instance_key("com.example.a", "1.0.0", true));
    }

    #[test]
    fn key_is_safe_as_a_file_name() {
        let key = single_instance_key("com/ex:ample\\app", "1.0.0-rc.1+build 5", false);
        assert_eq!(key, "com_ex_ample_app-v1.0.0-rc.1+build_5");
    }

    #[test]
    fn paths_sit_in_the_data_dir() {
        let dir = Path::new("data");
        assert_eq!(
            single_instance_lock_path(dir, "k"),
            dir.join("single-instance-k.lock")
        );
        assert_eq!(
            single_instance_endpoint_path(dir, "k"),
            dir.join("single-instance-k.port")
        );
        assert_eq!(
            data_lock_path(&dir.join(DB_FILE_NAME)),
            dir.join("admin-template.sqlite3.lock")
        );
    }

    #[test]
    fn messages_name_the_folder_and_the_remedy() {
        let m = data_in_use_message(Path::new("the-data-dir"));
        assert!(m.contains("the-data-dir"));
        assert!(m.contains("終了してから"));
        let e = data_lock_error_message(Path::new("x.lock"), &io::Error::other("boom"));
        assert!(e.contains("x.lock") && e.contains("boom"));
        assert!(already_running_message().contains("すでに起動"));
    }

    #[test]
    fn second_lock_is_refused_until_the_first_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.lock");
        let first = match try_lock_file(&path).unwrap() {
            LockAttempt::Acquired(lock) => lock,
            LockAttempt::Held => panic!("the first attempt must get the lock"),
        };
        assert!(matches!(try_lock_file(&path).unwrap(), LockAttempt::Held));
        // What a process end does: the handle goes away, the lock with it.
        drop(first);
        assert!(matches!(
            try_lock_file(&path).unwrap(),
            LockAttempt::Acquired(_)
        ));
    }

    #[test]
    fn locks_on_different_files_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        let a = try_lock_file(&single_instance_lock_path(dir.path(), "app-v1")).unwrap();
        let b = try_lock_file(&single_instance_lock_path(dir.path(), "app-v2")).unwrap();
        assert!(matches!(a, LockAttempt::Acquired(_)));
        assert!(matches!(b, LockAttempt::Acquired(_)));
    }

    #[test]
    fn lock_in_a_missing_folder_is_an_error_not_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("a.lock");
        assert!(try_lock_file(&path).is_err());
    }

    #[test]
    fn endpoint_round_trips_and_rejects_garbage() {
        let endpoint = Endpoint {
            port: 51234,
            token: "0123456789abcdef0123456789abcdef".to_string(),
        };
        assert_eq!(
            Endpoint::parse(&endpoint.to_file_text()),
            Some(endpoint.clone())
        );
        assert_eq!(Endpoint::parse(""), None);
        assert_eq!(Endpoint::parse("51234\n"), None);
        assert_eq!(
            Endpoint::parse("0\n0123456789abcdef0123456789abcdef\n"),
            None
        );
        assert_eq!(
            Endpoint::parse("port\n0123456789abcdef0123456789abcdef\n"),
            None
        );
        assert_eq!(Endpoint::parse("51234\nshort\n"), None);
        assert_eq!(
            Endpoint::parse("51234\n0123456789abcdef0123456789abcdef\nextra\n"),
            None
        );
    }

    #[test]
    fn tokens_are_hex_and_differ() {
        let (a, b) = (new_token(), new_token());
        assert!(is_token(&a) && is_token(&b));
        assert_ne!(a, b);
    }

    #[test]
    fn request_matches_only_its_token() {
        let token = "0123456789abcdef0123456789abcdef";
        assert!(is_activation_request(&activation_request(token), token));
        assert!(is_activation_request(
            &format!("activate {token}\r\n"),
            token
        ));
        assert!(!is_activation_request("activate\n", token));
        assert!(!is_activation_request(
            &format!("activate  {token}\n"),
            token
        ));
        assert!(!is_activation_request(&format!("raise {token}\n"), token));
        assert!(!is_activation_request(
            "activate 0123456789abcdef0123456789abcdee\n",
            token
        ));
        assert!(!is_activation_request(
            &format!("activate {token}0\n"),
            token
        ));
    }

    /// A listener on a thread, counting the valid requests.
    fn serving() -> (Endpoint, Arc<AtomicUsize>) {
        let (listener, endpoint) = bind_activation_listener().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let (token, counter) = (endpoint.token.clone(), count.clone());
        std::thread::spawn(move || {
            serve_activation(listener, token, || {
                counter.fetch_add(1, Ordering::SeqCst);
            })
        });
        (endpoint, count)
    }

    #[test]
    fn running_instance_is_activated_through_the_endpoint_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = single_instance_endpoint_path(dir.path(), "k");
        let (endpoint, count) = serving();
        write_endpoint_file(&path, &endpoint).unwrap();
        assert!(activate_once(&path));
        assert!(activate_once(&path));
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn wrong_token_does_not_activate() {
        let (endpoint, count) = serving();
        let wrong = Endpoint {
            port: endpoint.port,
            token: "f".repeat(32),
        };
        assert!(!matches!(request_activation(&wrong), Ok(true)));
        // The listener still serves the right one afterwards.
        assert!(matches!(request_activation(&endpoint), Ok(true)));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_or_stale_endpoint_file_does_not_activate() {
        let dir = tempfile::tempdir().unwrap();
        let path = single_instance_endpoint_path(dir.path(), "k");
        assert!(!activate_once(&path));
        // A port nobody listens on any more (bound, then closed).
        let (listener, endpoint) = bind_activation_listener().unwrap();
        drop(listener);
        write_endpoint_file(&path, &endpoint).unwrap();
        assert!(!activate_once(&path));
        std::fs::write(&path, "not an endpoint").unwrap();
        assert!(!activate_once(&path));
    }
}
