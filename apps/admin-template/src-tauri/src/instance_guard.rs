//! Keeps two desktop processes off one data folder (Issue #1028).
//!
//! Two guards, both taken before any window or database exists (the plugin's
//! `setup` runs inside `tauri::Builder::build`, ahead of the windows and of
//! the app's own `setup` closure):
//!
//! 1. **Single instance** - the same app (`identifier`) at the same version
//!    starts once. A second start asks the running one to bring its main
//!    window to the front and exits with code 0 - only when the running one
//!    answers that it did (see "Order" below).
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
//! A build from before #1028 takes neither lock, so nothing here keeps it
//! off the database: stop every old build before the first start of a new
//! one (same as `banto-serve`, which does not take the lock either).
//!
//! # Order
//!
//! single-instance lock -> data folder lock -> check the single-instance
//! lock again ([`reguard_single_instance`]) -> replace the old endpoint file
//! by the own one (listener, then the file) and start serving -> tidy the
//! single-instance files of other keys (see "Leftover files").
//!
//! Everything after the data folder lock is done by one process at a time,
//! and only that process touches endpoint files: a start that is going to be
//! refused removes nothing, so it cannot take away the endpoint of the
//! process that runs. A start that is refused at the data folder lock asks
//! the endpoint of its own key once more before the dialog
//! ([`activate_data_holder`]): if the process that has the database is of
//! the same key after all, its window comes to the front.
//!
//! The endpoint is published only by a process that already holds the
//! database, so "the running one answered" never comes from a process that
//! is about to give up on the data folder lock. And the listener answers
//! `ok` only when the main window exists and was raised; while the window is
//! still being built it answers `notready`. A second start therefore keeps
//! retrying for [`ACTIVATE_WAIT`]: each round it tries the single-instance
//! lock again (the first one may have gone away - then this start goes on as
//! a normal one) and asks again. No `ok` in that time = the "already
//! running" dialog, exit code 1.
//!
//! # Leftover files
//!
//! The lock files stay behind when a process ends (only the locks go), and
//! each version has a single-instance file of its own, so they would pile
//! up over the updates (#1046). Nobody removes its own file: a start that
//! still has the old file open could lock it after the removal while the
//! next start locks a new file under the same name, and two processes would
//! each think they are the instance of that key. Instead the process that
//! holds the data folder lock removes the files of *other* keys, and only
//! those it can lock at that moment - see [`remove_other_keys_files`] for
//! why that is safe. A start of another key that was caught by the removal
//! with the old file open finds out once it has the data folder lock, and
//! moves its lock to the file that is at the path now
//! ([`reguard_single_instance`]).
//!
//! The "come to the front" request travels over a loopback TCP port the
//! first instance listens on; the port and a random token sit in a file next
//! to the lock (see [`Endpoint`]). `tauri-plugin-single-instance` is not
//! used: its key is the `identifier`, and its optional `semver` feature only
//! adds the SemVer-compatible part of the version (`1.2.x` and `1.3.0` would
//! still collide), while #1028 lets any two different versions run side by
//! side; it would also add crates (conventions §3).

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime};

/// File name of the database inside the app data dir. The one place the
/// desktop app spells it (`run()` joins it too).
pub(crate) const DB_FILE_NAME: &str = "admin-template.sqlite3";

/// How long a second start keeps trying to get `ok` from the first one.
///
/// The first one publishes its endpoint only after the data folder lock and
/// answers `ok` only once its main window exists; the window is created in
/// `tauri::Builder::build` right after the plugins' `setup`, so the gap is
/// normally well under a second. 8 seconds leaves room for a cold start
/// (WebView2 not yet loaded, antivirus scanning the new executable) without
/// keeping a double click waiting noticeably longer than a slow start does
/// anyway. A first one that never gets a window (it is showing a startup
/// dialog, or hangs) ends this wait with the "already running" dialog.
const ACTIVATE_WAIT: Duration = Duration::from_secs(8);
const ACTIVATE_RETRY_WAIT: Duration = Duration::from_millis(200);
/// Per-connection limit, both sides.
const ACTIVATE_IO_TIMEOUT: Duration = Duration::from_secs(1);

const ACTIVATE_VERB: &str = "activate";
/// The main window exists and was brought to the front.
const ACTIVATE_OK: &str = "ok";
/// The request was valid, but there is no main window to raise (yet).
const ACTIVATE_NOT_READY: &str = "notready";

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
    let mut key = single_instance_key_prefix(identifier);
    key.push_str(&clean_key_part(version));
    if debug_build {
        key.push_str("-dev");
    }
    key
}

/// What every key of this `identifier` starts with, whatever the version
/// and the build: the part [`remove_other_keys_files`] matches on.
pub(crate) fn single_instance_key_prefix(identifier: &str) -> String {
    format!("{}-v", clean_key_part(identifier))
}

fn clean_key_part(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

const SINGLE_INSTANCE_FILE_PREFIX: &str = "single-instance-";
const SINGLE_INSTANCE_LOCK_SUFFIX: &str = ".lock";

/// Lock file of the single-instance guard, in the app data dir.
pub(crate) fn single_instance_lock_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join(format!(
        "{SINGLE_INSTANCE_FILE_PREFIX}{key}{SINGLE_INSTANCE_LOCK_SUFFIX}"
    ))
}

/// Where the running instance publishes its [`Endpoint`]. A file of its
/// own: on Windows the locked file cannot be read through another handle.
pub(crate) fn single_instance_endpoint_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join(format!("{SINGLE_INSTANCE_FILE_PREFIX}{key}.port"))
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

/// Makes sure the single-instance lock of this process is on the file that
/// is at `lock_path` *now*. Returns the lock to keep and whether it is a new
/// one. **Call it only while this process holds the data folder lock.**
///
/// Why: a process of another key that holds the data folder lock removes
/// free lock files ([`remove_other_keys_files`]). A start that had the file
/// open at that moment locks the removed file. Usually it is refused at the
/// data folder lock; if the remover has ended by then, it is not, and it
/// would run with a lock nobody else can see.
///
/// How: lock the path through a second handle (the file is created if it
/// is gone).
///
/// - It works: no lock was on the file at the path, so `held` is on another
///   (removed) file. The new lock is kept and `held` is closed.
/// - It is refused: some handle has the lock on the file at the path.
///   Normally that is `held` itself - `File::try_lock` is `LockFileEx` on
///   Windows (per handle) and `flock` on Unix (per open file description),
///   so a second handle of the same process is refused like anyone else's.
///   `held` stays.
/// - It cannot be tried (on a file system without POSIX delete the name of a
///   removed file cannot be opened while handles are open): `held` stays.
///
/// No second process of this key runs next to this one, whatever the
/// outcome: this process has the data folder lock, so every other start -
/// also one that holds a single-instance lock of this key on some file - is
/// refused there, before it publishes an endpoint or opens the database. And
/// the lock kept here stays good for the life of this process: files are
/// removed only under the data folder lock, which is not free again before
/// this process ends.
///
/// One case looks like "refused, it is mine" and is not: `held` is on a
/// removed file, and another start of this key has just locked the new file
/// and is on its way to being refused at the data folder lock (or shows that
/// dialog). Telling the two apart needs the file identity, which std does
/// not give on Windows without `unsafe`. Nothing lasting comes of it: later
/// starts get the free lock on the path, are refused at the data folder lock
/// and then raise this window through [`activate_data_holder`].
pub(crate) fn reguard_single_instance(held: FileLock, lock_path: &Path) -> (FileLock, bool) {
    match try_lock_file(lock_path) {
        // `held` is dropped here: the old handle is closed after the new
        // lock is in place.
        Ok(LockAttempt::Acquired(fresh)) => (fresh, true),
        Ok(LockAttempt::Held) | Err(_) => (held, false),
    }
}

/// Removes the single-instance files (`.lock` and `.port`) of the other
/// keys of this app - other versions, or the other build kind - that nobody
/// holds (#1046). Returns how many lock files went. Best effort: whatever
/// cannot be listed, opened, locked or removed stays.
///
/// **Call it only while this process holds the data folder lock**, and never
/// for a start that is being refused. `own_key` is never touched.
///
/// A file goes only when its lock could be taken right now, and it is
/// removed while that lock is held. Why this cannot break a guard:
///
/// - Nobody runs under that key: a running process would hold the lock.
/// - A start of that key may have opened the file just before and lock it
///   just after; the next start of that key then creates a new file and
///   locks that one, so for a moment two starts each believe they are the
///   instance of that key. Both go on to the data folder lock, which this
///   process holds, so both are refused: neither publishes an endpoint, and
///   neither opens the database. Starts that come after them only ever see
///   the new file. That is the difference to a refused start removing its
///   own file (the first shape of #1046): there the remover is about to
///   exit, and the start left with the removed file is of the *same* key
///   and may be the one that stays.
/// - A second start of that key that is waiting in [`acquire_or_activate`]
///   opens the path again each round, so it moves to the new file too.
/// - The own key is skipped, so the same-version hand-over (#1029) never
///   meets a removed file through this function. Two processes never run it
///   at once either: it needs the data folder lock.
///
/// - That other start may still get the data folder lock later: the OS
///   held it up between opening (or locking) the old file and trying the
///   data folder lock, and this process has ended in the meantime - killed
///   or closed by the user, it makes no difference. It then holds a lock on
///   a file that is no longer at the path. It notices right after the data
///   folder lock ([`reguard_single_instance`]) and locks the file that is
///   at the path now, so the next start of its key meets a held lock and
///   raises its window as ever.
///
/// What is left:
///
/// - A version from before the re-check (#1046) does not do it. If such a
///   start is caught as above, later starts of its key get the "data folder
///   in use" dialog instead of raising its window, until it is restarted.
/// - One start of that key can be between its single-instance lock (on the
///   new file) and its exit at the very moment of the re-check; see
///   [`reguard_single_instance`]. Later starts still raise the window
///   ([`activate_data_holder`]); only that one start may show the dialog.
///
/// The database stays exclusive in every case.
///
/// Windows: std opens files with `FILE_SHARE_DELETE`, so the removal works
/// while handles are open.
pub(crate) fn remove_other_keys_files(data_dir: &Path, key_prefix: &str, own_key: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(key) = name.to_str().and_then(|name| {
            name.strip_prefix(SINGLE_INSTANCE_FILE_PREFIX)?
                .strip_suffix(SINGLE_INSTANCE_LOCK_SUFFIX)
        }) else {
            continue;
        };
        if key == own_key || !key.starts_with(key_prefix) {
            continue;
        }
        let lock_path = entry.path();
        // No `create`: a file that went away in the meantime stays away.
        let Ok(file) = OpenOptions::new().read(true).write(true).open(&lock_path) else {
            continue;
        };
        if file.try_lock().is_err() {
            continue;
        }
        // Its endpoint first: only a process that holds the data folder
        // lock publishes one, so this one is stale.
        let _ = std::fs::remove_file(single_instance_endpoint_path(data_dir, key));
        match std::fs::remove_file(&lock_path) {
            Ok(()) => removed += 1,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => eprintln!(
                "banto: ほかの版の二重起動の検査用のロック {} を消せません: {err}",
                lock_path.display()
            ),
        }
        // The lock goes with `file`, after the removal.
    }
    removed
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

/// The reply line to a valid request: `ok` only when the window was raised.
pub(crate) fn activation_reply(raised: bool) -> &'static str {
    if raised {
        ACTIVATE_OK
    } else {
        ACTIVATE_NOT_READY
    }
}

/// Whether a reply line says the window was raised. Anything else
/// (`notready`, nothing, another program on that port) is a no.
pub(crate) fn is_activation_ok(reply: &str) -> bool {
    reply.trim() == ACTIVATE_OK
}

/// Answers one connection. A valid request runs `on_activate` first and
/// reports its result, so `ok` is never sent for a window that is not
/// there. Anything else gets no reply and does not run it.
fn answer(stream: &mut TcpStream, token: &str, on_activate: &impl Fn() -> bool) -> io::Result<()> {
    stream.set_read_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    let line = read_line(stream)?;
    if !is_activation_request(&line, token) {
        return Ok(());
    }
    let reply = activation_reply(on_activate());
    stream.write_all(format!("{reply}\n").as_bytes())
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
/// own). `on_activate` runs once per valid request and returns whether the
/// main window was there and was raised.
pub(crate) fn serve_activation(
    listener: TcpListener,
    token: String,
    on_activate: impl Fn() -> bool,
) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let _ = answer(&mut stream, &token, &on_activate);
    }
}

/// Sends the request to `endpoint` and returns the reply line.
fn ask_activation(endpoint: &Endpoint) -> io::Result<String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = TcpStream::connect_timeout(&addr, ACTIVATE_IO_TIMEOUT)?;
    stream.set_read_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(ACTIVATE_IO_TIMEOUT))?;
    stream.write_all(activation_request(&endpoint.token).as_bytes())?;
    read_line(&mut stream)
}

/// Asks the instance at `endpoint` to come to the front. `Ok(true)` = it
/// raised its window; `Ok(false)` = it has no window yet, or something else
/// answered on that port.
pub(crate) fn request_activation(endpoint: &Endpoint) -> io::Result<bool> {
    Ok(is_activation_ok(&ask_activation(endpoint)?))
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

/// How a start stands towards other starts of the same key.
#[derive(Debug)]
pub(crate) enum SingleInstance {
    /// Nobody else holds the key (any more): this process is the instance.
    /// Go on with a normal start and keep the lock.
    First(FileLock),
    /// The running instance raised its main window: exit quietly.
    Activated,
    /// Someone holds the key, but nobody said `ok` within the wait.
    NoAnswer,
}

/// Takes the single-instance lock, or hands over to whoever holds it.
///
/// Each round: try the lock (so a holder that went away - it lost the data
/// folder lock, the user closed its startup dialog - makes this start the
/// first one), then ask the holder to raise its window. Rounds repeat every
/// `retry` until `wait` has passed; there is always at least one.
/// `Err` = the lock itself could not be tried.
pub(crate) fn acquire_or_activate(
    lock_path: &Path,
    endpoint_path: &Path,
    wait: Duration,
    retry: Duration,
) -> io::Result<SingleInstance> {
    let deadline = Instant::now() + wait;
    loop {
        if let LockAttempt::Acquired(lock) = try_lock_file(lock_path)? {
            return Ok(SingleInstance::First(lock));
        }
        if activate_once(endpoint_path) {
            return Ok(SingleInstance::Activated);
        }
        if Instant::now() >= deadline {
            return Ok(SingleInstance::NoAnswer);
        }
        std::thread::sleep(retry);
    }
}

/// What a start that was refused at the data folder lock learned from the
/// endpoint of its own key.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DataHolder {
    /// The process that has the database is of this key and raised its main
    /// window: exit quietly.
    Raised,
    /// It is of this key, but had no window to raise within the wait.
    NoWindow,
    /// Nobody answers for this key: another key has the database.
    OtherKey,
}

/// For a start that did not get the data folder lock: asks the endpoint of
/// its own key, in case the process that has the database is of the same
/// key although this start was not stopped at the single-instance lock.
/// That happens when the running process could not put its single-instance
/// lock on the file at the path (see [`reguard_single_instance`]), or when
/// this start could not try the lock at all.
///
/// Only a process that holds the data folder lock publishes an endpoint, and
/// only such a process removes one, so an endpoint that answers with the
/// token of this key is the process that has the database. A leftover file
/// of an earlier run answers nothing (or something else does, without the
/// token): `OtherKey` at once, no waiting. Rounds repeat every `retry` only
/// while the answer is `notready` (the same-key process is still building
/// its window), until `wait` has passed.
pub(crate) fn activate_data_holder(
    endpoint_path: &Path,
    wait: Duration,
    retry: Duration,
) -> DataHolder {
    let deadline = Instant::now() + wait;
    loop {
        let reply = std::fs::read_to_string(endpoint_path)
            .ok()
            .and_then(|text| Endpoint::parse(&text))
            .and_then(|endpoint| ask_activation(&endpoint).ok());
        match reply.as_deref().map(str::trim) {
            Some(ACTIVATE_OK) => return DataHolder::Raised,
            Some(ACTIVATE_NOT_READY) => {}
            _ => return DataHolder::OtherKey,
        }
        if Instant::now() >= deadline {
            return DataHolder::NoWindow;
        }
        std::thread::sleep(retry);
    }
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
    _single_instance: Option<SingleInstanceHold>,
    _data: FileLock,
}

/// Label of the window a second start brings to the front (the config's one
/// window has no explicit label, so Tauri names it `main`).
const MAIN_WINDOW_LABEL: &str = "main";

/// Brings the main window to the front. `false` = there is no main window
/// (this process is still starting), or it could not be shown: the second
/// start must not report success then.
fn raise_main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return false;
    };
    // Not minimized is not a failure of the raise.
    let _ = window.unminimize();
    window.show().is_ok() && window.set_focus().is_ok()
}

/// The single-instance lock of this process. Checked again once the data
/// folder lock is held ([`SingleInstanceHold::reguarded`]).
struct SingleInstanceHold {
    _lock: FileLock,
}

impl SingleInstanceHold {
    /// See [`reguard_single_instance`]. Only with the data folder lock held.
    fn reguarded(self, lock_path: &Path) -> Self {
        let (lock, replaced) = reguard_single_instance(self._lock, lock_path);
        if replaced {
            println!(
                "banto: 二重起動の検査用のロック {} が起動の途中で片付けられていたため、取り直しました",
                lock_path.display()
            );
        }
        Self { _lock: lock }
    }
}

/// Takes the single-instance lock, or hands over to the running instance
/// and exits. `None` = the lock could not be tried (no check, no endpoint).
///
/// The endpoint file of an earlier holder is left alone here: this start may
/// still be refused at the data folder lock, and then the file may belong to
/// the process that runs (see "Order" in the module doc).
fn guard_single_instance(lock_path: &Path, endpoint_path: &Path) -> Option<SingleInstanceHold> {
    let lock =
        match acquire_or_activate(lock_path, endpoint_path, ACTIVATE_WAIT, ACTIVATE_RETRY_WAIT) {
            Ok(SingleInstance::First(lock)) => lock,
            Ok(SingleInstance::Activated) => {
                println!("banto: すでに起動しています。起動中の窓を前に出しました");
                std::process::exit(0);
            }
            Ok(SingleInstance::NoAnswer) => crate::exit_startup_refused(already_running_message()),
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
    Some(SingleInstanceHold { _lock: lock })
}

/// Opens the listener, writes the endpoint file and starts serving. Call it
/// only once the data folder lock is held: from here on a second start may
/// get `ok` and exit, so this process must be the one that stays.
///
/// Without the listener a second start cannot raise this window; it then
/// shows `already_running_message` instead.
///
/// The endpoint file of an earlier holder (it crashed, or was closed) goes
/// first, so it is not left behind when the own one cannot be published.
/// Until then a second start may read it: nothing answers there with that
/// token, so it just asks again in the next round.
fn publish_endpoint<R: Runtime>(app: &tauri::AppHandle<R>, endpoint_path: &Path) {
    if let Err(err) = std::fs::remove_file(endpoint_path) {
        if err.kind() != io::ErrorKind::NotFound {
            eprintln!(
                "banto: 古い二重起動の連絡先 {} を消せません: {err}",
                endpoint_path.display()
            );
        }
    }
    match bind_activation_listener() {
        Ok((listener, endpoint)) => {
            if let Err(err) = write_endpoint_file(endpoint_path, &endpoint) {
                eprintln!(
                    "banto: 二重起動の連絡先 {} を書けません: {err}",
                    endpoint_path.display()
                );
            }
            let handle = app.clone();
            let token = endpoint.token;
            if let Err(err) = std::thread::Builder::new()
                .name("banto-single-instance".into())
                .spawn(move || {
                    serve_activation(listener, token, move || raise_main_window(&handle))
                })
            {
                eprintln!("banto: 二重起動の連絡用のスレッドを起動できません: {err}");
            }
        }
        Err(err) => eprintln!("banto: 二重起動の連絡用のポートを開けません: {err}"),
    }
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
            let identifier = &app.config().identifier;
            let key = single_instance_key(
                identifier,
                &app.package_info().version.to_string(),
                cfg!(debug_assertions),
            );
            let single_lock_path = single_instance_lock_path(&data_dir, &key);
            let endpoint_path = single_instance_endpoint_path(&data_dir, &key);
            let single_instance = guard_single_instance(&single_lock_path, &endpoint_path);
            let lock_path = data_lock_path(&data_dir.join(DB_FILE_NAME));
            let data = match try_lock_file(&lock_path) {
                Ok(LockAttempt::Acquired(lock)) => lock,
                Ok(LockAttempt::Held) => {
                    // The holder may be of this key after all (see
                    // `activate_data_holder`).
                    match activate_data_holder(&endpoint_path, ACTIVATE_WAIT, ACTIVATE_RETRY_WAIT) {
                        DataHolder::Raised => {
                            println!("banto: すでに起動しています。起動中の窓を前に出しました");
                            std::process::exit(0);
                        }
                        DataHolder::NoWindow => {
                            crate::exit_startup_refused(already_running_message())
                        }
                        DataHolder::OtherKey => {
                            crate::exit_startup_refused(data_in_use_message(&data_dir))
                        }
                    }
                }
                Err(err) => crate::exit_startup_refused(data_lock_error_message(&lock_path, &err)),
            };
            // From here on this process is the one that stays. Its
            // single-instance lock may be on a file that another key's
            // process removed while this start was under way: put it on the
            // file at the path before anyone is told to rely on it.
            let single_instance = single_instance.map(|hold| hold.reguarded(&single_lock_path));
            // Only now, with the database secured (see "Order" in the
            // module doc).
            if single_instance.is_some() {
                publish_endpoint(app, &endpoint_path);
            }
            // Only with the data folder lock held, and never on a path that
            // refuses the start (see the function's doc).
            remove_other_keys_files(&data_dir, &single_instance_key_prefix(identifier), &key);
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

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

    /// The files a run of `key` leaves behind: the lock file (unlocked) and
    /// an endpoint file.
    fn leftover_files(dir: &Path, key: &str) -> (PathBuf, PathBuf) {
        let lock_path = single_instance_lock_path(dir, key);
        let endpoint_path = single_instance_endpoint_path(dir, key);
        drop(try_lock_file(&lock_path).unwrap());
        std::fs::write(&endpoint_path, "1\n").unwrap();
        (lock_path, endpoint_path)
    }

    const APP: &str = "dev.banto.admin";

    fn key_of(version: &str) -> String {
        single_instance_key(APP, version, false)
    }

    fn tidy(dir: &Path, own_version: &str) -> usize {
        remove_other_keys_files(dir, &single_instance_key_prefix(APP), &key_of(own_version))
    }

    #[test]
    fn free_files_of_other_keys_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (old_lock, old_endpoint) = leftover_files(dir.path(), &key_of("9.2.0"));
        let (dev_lock, dev_endpoint) =
            leftover_files(dir.path(), &single_instance_key(APP, "9.3.0", true));
        // A refused start leaves a lock file only.
        let refused_lock = single_instance_lock_path(dir.path(), &key_of("9.1.0"));
        drop(try_lock_file(&refused_lock).unwrap());
        assert_eq!(tidy(dir.path(), "9.3.0"), 3);
        for gone in [
            &old_lock,
            &old_endpoint,
            &dev_lock,
            &dev_endpoint,
            &refused_lock,
        ] {
            assert!(!gone.exists(), "{} must be gone", gone.display());
        }
        // The names are free again: that key starts as usual.
        assert!(matches!(
            try_lock_file(&old_lock).unwrap(),
            LockAttempt::Acquired(_)
        ));
    }

    #[test]
    fn held_files_of_other_keys_stay() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = single_instance_lock_path(dir.path(), &key_of("9.2.0"));
        let endpoint_path = single_instance_endpoint_path(dir.path(), &key_of("9.2.0"));
        let LockAttempt::Acquired(held) = try_lock_file(&lock_path).unwrap() else {
            panic!("the first lock must be acquired");
        };
        std::fs::write(&endpoint_path, "1\n").unwrap();
        assert_eq!(tidy(dir.path(), "9.3.0"), 0);
        assert!(lock_path.exists());
        assert!(endpoint_path.exists());
        // Still the same lock: the holder was not disturbed.
        assert!(matches!(
            try_lock_file(&lock_path).unwrap(),
            LockAttempt::Held
        ));
        drop(held);
        assert_eq!(tidy(dir.path(), "9.3.0"), 1);
        assert!(!lock_path.exists());
        assert!(!endpoint_path.exists());
    }

    #[test]
    fn own_key_and_unrelated_files_stay() {
        let dir = tempfile::tempdir().unwrap();
        // Own key: free (as in a start whose lock could not be tried) ...
        let (own_lock, own_endpoint) = leftover_files(dir.path(), &key_of("9.3.0"));
        // ... another app's key, the data folder lock, and look-alikes.
        let (foreign_lock, foreign_endpoint) = leftover_files(
            dir.path(),
            &single_instance_key("com.example.other", "1.0.0", false),
        );
        let data_lock = data_lock_path(&dir.path().join(DB_FILE_NAME));
        drop(try_lock_file(&data_lock).unwrap());
        let others = [
            dir.path().join(DB_FILE_NAME),
            dir.path().join("single-instance-.lock"),
            dir.path().join(format!("{}.lock", key_of("9.2.0"))),
            dir.path()
                .join(format!("single-instance-{}.lock.bak", key_of("9.2.0"))),
        ];
        for path in &others {
            std::fs::write(path, "").unwrap();
        }
        assert_eq!(tidy(dir.path(), "9.3.0"), 0);
        for kept in [
            &own_lock,
            &own_endpoint,
            &foreign_lock,
            &foreign_endpoint,
            &data_lock,
        ]
        .into_iter()
        .chain(&others)
        {
            assert!(kept.exists(), "{} must stay", kept.display());
        }
        // Held by this process, the own file stays as well.
        let LockAttempt::Acquired(_own) = try_lock_file(&own_lock).unwrap() else {
            panic!("the own lock must be acquired");
        };
        assert_eq!(tidy(dir.path(), "9.3.0"), 0);
        assert!(own_lock.exists());
    }

    #[test]
    fn tidying_a_missing_folder_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(tidy(&dir.path().join("missing"), "9.3.0"), 0);
    }

    /// The race of the #1046 review: version 9.2.0 is started twice while
    /// 9.3.0 (which holds the data folder lock) removes the 9.2.0 file. One
    /// 9.2.0 start has the old file open and locks it after the removal,
    /// the other one locks the new file of the same name.
    #[test]
    fn starts_of_another_key_that_race_the_removal_are_both_refused() {
        let dir = tempfile::tempdir().unwrap();
        let data_lock = data_lock_path(&dir.path().join(DB_FILE_NAME));
        let old_key = key_of("9.2.0");
        let (lock_path, endpoint_path) = leftover_files(dir.path(), &old_key);

        // 9.3.0 is the running one.
        let LockAttempt::Acquired(running) = try_lock_file(&data_lock).unwrap() else {
            panic!("the data folder lock must be acquired");
        };
        // First 9.2.0 start: has opened the file, has not locked it yet.
        let early = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        assert_eq!(tidy(dir.path(), "9.3.0"), 1);
        assert!(!lock_path.exists());
        // It now locks the removed file; the second start locks a new one.
        early.try_lock().unwrap();
        let LockAttempt::Acquired(late) = try_lock_file(&lock_path).unwrap() else {
            panic!("the new file must be lockable");
        };
        // Both think they are the 9.2.0 instance - and both are stopped at
        // the data folder lock, before the endpoint and the database.
        assert!(matches!(
            try_lock_file(&data_lock).unwrap(),
            LockAttempt::Held
        ));
        assert!(matches!(
            try_lock_file(&data_lock).unwrap(),
            LockAttempt::Held
        ));
        assert!(!endpoint_path.exists());
        // 9.3.0 tidies again (a later start of it would): the new file is
        // held, so it stays.
        assert_eq!(tidy(dir.path(), "9.3.0"), 0);
        assert!(lock_path.exists());

        // The refused starts exit, then 9.3.0 does: its data folder lock
        // goes. From here on 9.2.0 behaves as ever: one start is the
        // instance, the next one raises its window.
        drop(early);
        drop(late);
        drop(running);
        let first = acquire_or_activate(&lock_path, &endpoint_path, Duration::ZERO, RETRY).unwrap();
        let SingleInstance::First(_first) = first else {
            panic!("the first 9.2.0 start must be the instance");
        };
        let LockAttempt::Acquired(_data) = try_lock_file(&data_lock).unwrap() else {
            panic!("the data folder lock must be free again");
        };
        // 9.2.0 tidies in its turn; its own file stays.
        remove_other_keys_files(dir.path(), &single_instance_key_prefix(APP), &old_key);
        let (endpoint, asked) = serving();
        write_endpoint_file(&endpoint_path, &endpoint).unwrap();
        let second =
            acquire_or_activate(&lock_path, &endpoint_path, Duration::ZERO, RETRY).unwrap();
        assert!(matches!(second, SingleInstance::Activated));
        assert!(asked.recv_timeout(CALLBACK_WAIT).unwrap());
    }

    /// Same-key starts side by side while another key's file is removed
    /// again and again: the own key keeps exactly one holder, and every
    /// other start gets `Held` (the hand-over path), never a second lock.
    #[test]
    fn same_key_starts_keep_one_holder_while_other_keys_are_tidied() {
        let dir = tempfile::tempdir().unwrap();
        let own_lock = single_instance_lock_path(dir.path(), &key_of("9.3.0"));
        let old_lock = single_instance_lock_path(dir.path(), &key_of("9.2.0"));
        let LockAttempt::Acquired(_running) = try_lock_file(&own_lock).unwrap() else {
            panic!("the first lock must be acquired");
        };
        let stop = AtomicBool::new(false);
        // Counts the workers that have tried the lock at least once, so a
        // few CPUs cannot let `stop` come before some worker ever ran.
        let tried = AtomicUsize::new(0);
        let failures = std::sync::Mutex::new(Vec::<String>::new());
        std::thread::scope(|scope| {
            // Starts of the other key come and go ...
            let other = scope.spawn(|| {
                while !stop.load(Ordering::SeqCst) {
                    // `Err` is fine here: on a file system without POSIX
                    // delete, a name that is being removed cannot be opened.
                    let _ = try_lock_file(&old_lock);
                }
            });
            // ... and second starts of the own key.
            let second_starts: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        let mut held = 0;
                        loop {
                            // A failure is recorded, not panicked on, so the
                            // first try always counts and `stop` still comes.
                            let outcome = match try_lock_file(&own_lock) {
                                Ok(LockAttempt::Held) => None,
                                Ok(LockAttempt::Acquired(_)) => {
                                    Some("a second start acquired the lock".to_string())
                                }
                                Err(error) => Some(format!("the lock attempt failed: {error}")),
                            };
                            if held == 0 {
                                tried.fetch_add(1, Ordering::SeqCst);
                            }
                            if let Some(reason) = outcome {
                                failures.lock().unwrap().push(reason);
                                break;
                            }
                            held += 1;
                            if stop.load(Ordering::SeqCst) {
                                break;
                            }
                        }
                        held
                    })
                })
                .collect();
            for _ in 0..200 {
                tidy(dir.path(), "9.3.0");
            }
            // Wait until every worker tried once, but never forever: a
            // failed worker has counted itself too, and a stuck one runs
            // into the deadline. `stop` comes before any join or assert.
            let deadline = Instant::now() + Duration::from_secs(10);
            while tried.load(Ordering::SeqCst) < second_starts.len() && Instant::now() < deadline {
                std::thread::yield_now();
            }
            stop.store(true, Ordering::SeqCst);
            other.join().unwrap();
            let held: Vec<_> = second_starts
                .into_iter()
                .map(|start| start.join().unwrap())
                .collect();
            let failures = failures.lock().unwrap();
            assert!(failures.is_empty(), "same-key starts failed: {failures:?}");
            assert!(
                held.iter().all(|&count| count > 0),
                "every worker must hold-check once, got {held:?}"
            );
        });
        assert!(own_lock.exists());
    }

    /// What `init` does once the data folder lock is held.
    fn reguard(held: FileLock, lock_path: &Path) -> (FileLock, bool) {
        reguard_single_instance(held, lock_path)
    }

    /// The second point of the #1046 review: 9.2.0 is held up by the OS with
    /// the old file open, 9.3.0 removes that file and ends, and 9.2.0 goes
    /// on and gets the data folder lock. It must end up with its lock on
    /// the file at the path, so the next 9.2.0 start is handed over.
    #[test]
    fn start_left_with_a_removed_file_moves_its_lock_to_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let data_lock = data_lock_path(&dir.path().join(DB_FILE_NAME));
        let old_key = key_of("9.2.0");
        let (lock_path, endpoint_path) = leftover_files(dir.path(), &old_key);

        // 9.3.0 is the running one.
        let LockAttempt::Acquired(running) = try_lock_file(&data_lock).unwrap() else {
            panic!("the data folder lock must be acquired");
        };
        // The 9.2.0 start has opened the file and is held up there. It
        // goes on in a thread of its own once 9.3.0 has ended.
        let early = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        let (resume, resumed) = mpsc::channel::<()>();
        let (started, has_started) = mpsc::channel::<bool>();
        let (stop, stopped) = mpsc::channel::<()>();
        let old_version = {
            let (lock_path, data_lock, endpoint_path) =
                (lock_path.clone(), data_lock.clone(), endpoint_path.clone());
            std::thread::spawn(move || {
                resumed.recv().unwrap();
                // Locks the removed file: "I am the 9.2.0 instance".
                early.try_lock().unwrap();
                let held = FileLock { _file: early };
                let LockAttempt::Acquired(_data) = try_lock_file(&data_lock).unwrap() else {
                    panic!("9.2.0 must get the data folder lock after 9.3.0 ended");
                };
                let (_single, replaced) = reguard(held, &lock_path);
                let (endpoint, asked) = serving();
                write_endpoint_file(&endpoint_path, &endpoint).unwrap();
                started.send(replaced).unwrap();
                // Runs (keeps both locks) until the test is done.
                stopped.recv().unwrap();
                asked.try_recv().unwrap_or(false)
            })
        };
        // 9.3.0 removes the file of 9.2.0 and is closed by the user.
        assert_eq!(tidy(dir.path(), "9.3.0"), 1);
        assert!(!lock_path.exists());
        drop(running);
        resume.send(()).unwrap();
        assert!(
            has_started.recv_timeout(CALLBACK_WAIT).unwrap(),
            "the lock must have been taken anew on the path"
        );
        assert!(lock_path.exists());

        // The next 9.2.0 start is stopped at the single-instance lock and
        // raises the window of the running one.
        assert!(matches!(
            try_lock_file(&lock_path).unwrap(),
            LockAttempt::Held
        ));
        let second =
            acquire_or_activate(&lock_path, &endpoint_path, Duration::ZERO, RETRY).unwrap();
        assert!(matches!(second, SingleInstance::Activated));
        stop.send(()).unwrap();
        assert!(old_version.join().unwrap(), "the window must be raised");
        // 9.2.0 has ended: its lock on the path is gone with it.
        assert!(matches!(
            try_lock_file(&lock_path).unwrap(),
            LockAttempt::Acquired(_)
        ));
    }

    /// The usual start: the file was not removed, so the second handle is
    /// refused by the own lock (also inside one process) and nothing changes.
    #[test]
    fn untouched_lock_is_kept_by_the_recheck() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = single_instance_lock_path(dir.path(), &key_of("9.3.0"));
        let LockAttempt::Acquired(held) = try_lock_file(&lock_path).unwrap() else {
            panic!("the first lock must be acquired");
        };
        let (kept, replaced) = reguard(held, &lock_path);
        assert!(!replaced);
        assert!(matches!(
            try_lock_file(&lock_path).unwrap(),
            LockAttempt::Held
        ));
        // It is the one lock on that file: gone with it.
        drop(kept);
        assert!(matches!(
            try_lock_file(&lock_path).unwrap(),
            LockAttempt::Acquired(_)
        ));
    }

    /// The case the re-check cannot see: the lock of the running process is
    /// on a removed file, and another start of its key holds the new file
    /// (on its way to being refused). The running one keeps its lock; later
    /// starts are refused at the data folder lock and then raise its window
    /// through the endpoint, which no refused start removes.
    #[test]
    fn start_refused_at_the_data_lock_still_raises_a_same_key_window() {
        let dir = tempfile::tempdir().unwrap();
        let data_lock = data_lock_path(&dir.path().join(DB_FILE_NAME));
        let key = key_of("9.2.0");
        let (lock_path, endpoint_path) = leftover_files(dir.path(), &key);

        // The running 9.2.0: lock on a file that is removed afterwards.
        let LockAttempt::Acquired(held) = try_lock_file(&lock_path).unwrap() else {
            panic!("the first lock must be acquired");
        };
        std::fs::remove_file(&lock_path).unwrap();
        // Another 9.2.0 start has the new file when the running one checks.
        let LockAttempt::Acquired(passing) = try_lock_file(&lock_path).unwrap() else {
            panic!("the new file must be lockable");
        };
        let LockAttempt::Acquired(_data) = try_lock_file(&data_lock).unwrap() else {
            panic!("the data folder lock must be acquired");
        };
        let (_held, replaced) = reguard(held, &lock_path);
        assert!(!replaced);
        let (endpoint, asked) = serving();
        write_endpoint_file(&endpoint_path, &endpoint).unwrap();
        // That start is refused and exits.
        drop(passing);

        // A later start: first at the single-instance lock ...
        let later = acquire_or_activate(&lock_path, &endpoint_path, Duration::ZERO, RETRY).unwrap();
        let SingleInstance::First(_later) = later else {
            panic!("nobody holds the file at the path");
        };
        // ... refused at the data folder lock, with the endpoint still there.
        assert!(matches!(
            try_lock_file(&data_lock).unwrap(),
            LockAttempt::Held
        ));
        assert_eq!(
            activate_data_holder(&endpoint_path, Duration::ZERO, RETRY),
            DataHolder::Raised
        );
        assert!(asked.recv_timeout(CALLBACK_WAIT).unwrap());
    }

    #[test]
    fn data_holder_of_another_key_is_told_apart_without_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let endpoint_path = single_instance_endpoint_path(dir.path(), "k");
        let long = Duration::from_secs(60);
        let started = Instant::now();
        // No endpoint file at all.
        assert_eq!(
            activate_data_holder(&endpoint_path, long, RETRY),
            DataHolder::OtherKey
        );
        // A leftover file of an earlier run: nobody listens there.
        let (listener, endpoint) = bind_activation_listener().unwrap();
        drop(listener);
        write_endpoint_file(&endpoint_path, &endpoint).unwrap();
        assert_eq!(
            activate_data_holder(&endpoint_path, long, RETRY),
            DataHolder::OtherKey
        );
        // Someone listens, but not for this token.
        let (live, asked) = serving();
        let wrong = Endpoint {
            port: live.port,
            token: new_token(),
        };
        write_endpoint_file(&endpoint_path, &wrong).unwrap();
        assert_eq!(
            activate_data_holder(&endpoint_path, long, RETRY),
            DataHolder::OtherKey
        );
        assert!(asked.try_recv().is_err());
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn data_holder_of_the_same_key_is_asked_until_its_window_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let endpoint_path = single_instance_endpoint_path(dir.path(), "k");
        let ready = Arc::new(AtomicBool::new(false));
        let (endpoint, asked) = serving_with(ready.clone());
        write_endpoint_file(&endpoint_path, &endpoint).unwrap();
        // No window within the wait.
        assert_eq!(
            activate_data_holder(&endpoint_path, Duration::ZERO, RETRY),
            DataHolder::NoWindow
        );
        assert!(!asked.recv_timeout(CALLBACK_WAIT).unwrap());
        // The window comes while this start keeps asking.
        let flip = std::thread::spawn(move || {
            while !asked.recv_timeout(CALLBACK_WAIT).unwrap() {
                ready.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(
            activate_data_holder(&endpoint_path, Duration::from_secs(30), RETRY),
            DataHolder::Raised
        );
        flip.join().unwrap();
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

    #[test]
    fn reply_is_ok_only_when_the_window_was_raised() {
        assert_eq!(activation_reply(true), "ok");
        assert_eq!(activation_reply(false), "notready");
        assert!(is_activation_ok("ok"));
        assert!(is_activation_ok("ok\r"));
        assert!(is_activation_ok(activation_reply(true)));
        assert!(!is_activation_ok(activation_reply(false)));
        assert!(!is_activation_ok(""));
        assert!(!is_activation_ok("okay"));
        assert!(!is_activation_ok("OK"));
    }

    /// A listener on a thread, sending one message per valid request; its
    /// callback answers what `window_ready` holds at that moment (the
    /// stand-in for "the main window exists") and sends that same value, so
    /// a test sees which answer (`ok` or `notready`) each request got. Tests
    /// wait on the channel instead of reading a counter.
    fn serving_with(window_ready: Arc<AtomicBool>) -> (Endpoint, mpsc::Receiver<bool>) {
        let (listener, endpoint) = bind_activation_listener().unwrap();
        let (tx, rx) = mpsc::channel();
        let token = endpoint.token.clone();
        std::thread::spawn(move || {
            serve_activation(listener, token, move || {
                let ready = window_ready.load(Ordering::SeqCst);
                let _ = tx.send(ready);
                ready
            })
        });
        (endpoint, rx)
    }

    /// A listener whose window is there.
    fn serving() -> (Endpoint, mpsc::Receiver<bool>) {
        serving_with(Arc::new(AtomicBool::new(true)))
    }

    const CALLBACK_WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn running_instance_is_activated_through_the_endpoint_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = single_instance_endpoint_path(dir.path(), "k");
        let (endpoint, activated) = serving();
        write_endpoint_file(&path, &endpoint).unwrap();
        assert!(activate_once(&path));
        assert!(activate_once(&path));
        assert!(activated.recv_timeout(CALLBACK_WAIT).unwrap());
        assert!(activated.recv_timeout(CALLBACK_WAIT).unwrap());
        assert!(activated.try_recv().is_err());
    }

    #[test]
    fn wrong_token_does_not_activate() {
        let (endpoint, activated) = serving();
        let wrong = Endpoint {
            port: endpoint.port,
            token: "f".repeat(32),
        };
        assert!(!matches!(request_activation(&wrong), Ok(true)));
        // The listener still serves the right one afterwards.
        assert!(matches!(request_activation(&endpoint), Ok(true)));
        // Requests are served one at a time, so once the right one's
        // callback ran, the wrong one has been answered (without one).
        assert!(activated.recv_timeout(CALLBACK_WAIT).unwrap());
        assert!(activated.try_recv().is_err());
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
    #[test]
    fn no_window_yet_is_not_a_success() {
        let ready = Arc::new(AtomicBool::new(false));
        let (endpoint, asked) = serving_with(ready.clone());
        // Valid request, callback ran, but the answer is not `ok`.
        assert!(matches!(request_activation(&endpoint), Ok(false)));
        assert!(!asked.recv_timeout(CALLBACK_WAIT).unwrap());
        // Same listener, once the window is there.
        ready.store(true, Ordering::SeqCst);
        assert!(matches!(request_activation(&endpoint), Ok(true)));
        assert!(asked.recv_timeout(CALLBACK_WAIT).unwrap());
        assert!(asked.try_recv().is_err());
    }

    const RETRY: Duration = Duration::from_millis(20);

    #[test]
    fn free_key_makes_this_start_the_first_one() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = single_instance_lock_path(dir.path(), "k");
        let endpoint_path = single_instance_endpoint_path(dir.path(), "k");
        // A leftover endpoint of a live listener is not even asked.
        let (endpoint, asked) = serving();
        write_endpoint_file(&endpoint_path, &endpoint).unwrap();
        let got = acquire_or_activate(&lock_path, &endpoint_path, Duration::ZERO, RETRY).unwrap();
        assert!(matches!(got, SingleInstance::First(_)));
        assert!(asked.try_recv().is_err());
    }

    #[test]
    fn held_key_with_a_window_is_activated() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = single_instance_lock_path(dir.path(), "k");
        let endpoint_path = single_instance_endpoint_path(dir.path(), "k");
        let LockAttempt::Acquired(_held) = try_lock_file(&lock_path).unwrap() else {
            panic!("the first lock must be acquired");
        };
        let (endpoint, asked) = serving();
        write_endpoint_file(&endpoint_path, &endpoint).unwrap();
        let got = acquire_or_activate(&lock_path, &endpoint_path, Duration::ZERO, RETRY).unwrap();
        assert!(matches!(got, SingleInstance::Activated));
        assert!(asked.recv_timeout(CALLBACK_WAIT).unwrap());
    }

    #[test]
    fn held_key_is_retried_until_the_window_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = single_instance_lock_path(dir.path(), "k");
        let endpoint_path = single_instance_endpoint_path(dir.path(), "k");
        let LockAttempt::Acquired(_held) = try_lock_file(&lock_path).unwrap() else {
            panic!("the first lock must be acquired");
        };
        // The first one: no endpoint yet, then an endpoint without a window,
        // then the window - which appears only after one `notready` went
        // out, so the order does not depend on timing.
        let ready = Arc::new(AtomicBool::new(false));
        let (endpoint, asked) = serving_with(ready.clone());
        let first = std::thread::spawn({
            let endpoint_path = endpoint_path.clone();
            move || {
                std::thread::sleep(RETRY * 3);
                write_endpoint_file(&endpoint_path, &endpoint).unwrap();
                // The first request found no window: it got `notready`.
                assert!(!asked.recv_timeout(CALLBACK_WAIT).unwrap());
                ready.store(true, Ordering::SeqCst);
                asked
            }
        });
        let got = acquire_or_activate(&lock_path, &endpoint_path, CALLBACK_WAIT, RETRY).unwrap();
        assert!(matches!(got, SingleInstance::Activated));
        // Requests between the store and the one that got `ok` may still
        // have read `false`; the last one answered is the `ok`.
        let asked = first.join().unwrap();
        let rest: Vec<bool> = asked.try_iter().collect();
        assert_eq!(rest.last(), Some(&true));
    }

    #[test]
    fn held_key_that_never_gets_a_window_is_no_answer() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = single_instance_lock_path(dir.path(), "k");
        let endpoint_path = single_instance_endpoint_path(dir.path(), "k");
        let LockAttempt::Acquired(_held) = try_lock_file(&lock_path).unwrap() else {
            panic!("the first lock must be acquired");
        };
        // No endpoint at all (the first one has not secured the database).
        let got = acquire_or_activate(&lock_path, &endpoint_path, RETRY * 3, RETRY).unwrap();
        assert!(matches!(got, SingleInstance::NoAnswer));
        // An endpoint, but never a window.
        let (endpoint, asked) = serving_with(Arc::new(AtomicBool::new(false)));
        write_endpoint_file(&endpoint_path, &endpoint).unwrap();
        let got = acquire_or_activate(&lock_path, &endpoint_path, RETRY * 3, RETRY).unwrap();
        assert!(matches!(got, SingleInstance::NoAnswer));
        // It was asked more than once before giving up.
        assert!(!asked.recv_timeout(CALLBACK_WAIT).unwrap());
        assert!(!asked.recv_timeout(CALLBACK_WAIT).unwrap());
    }

    #[test]
    fn key_freed_during_the_retries_is_taken() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = single_instance_lock_path(dir.path(), "k");
        let endpoint_path = single_instance_endpoint_path(dir.path(), "k");
        let LockAttempt::Acquired(held) = try_lock_file(&lock_path).unwrap() else {
            panic!("the first lock must be acquired");
        };
        // The first one never publishes an endpoint (it did not get the
        // data folder lock) and goes away while the second one retries.
        let first = std::thread::spawn(move || {
            std::thread::sleep(RETRY * 5);
            drop(held);
        });
        let got = acquire_or_activate(&lock_path, &endpoint_path, CALLBACK_WAIT, RETRY).unwrap();
        assert!(matches!(got, SingleInstance::First(_)));
        first.join().unwrap();
        // Still held by the value we got.
        assert!(matches!(
            try_lock_file(&lock_path).unwrap(),
            LockAttempt::Held
        ));
    }

    #[test]
    fn lock_that_cannot_be_tried_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-folder");
        let got = acquire_or_activate(
            &single_instance_lock_path(&missing, "k"),
            &single_instance_endpoint_path(&missing, "k"),
            Duration::ZERO,
            RETRY,
        );
        assert!(got.is_err());
    }
}
