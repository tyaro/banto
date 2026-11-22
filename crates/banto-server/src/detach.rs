//! Writes run to completion even when the client disconnects (Issue #793,
//! ADR-0035).
//!
//! hyper 1.x drops the service future - the handler - when it reads the
//! peer's FIN while the response is still pending. A handler that has a side
//! effect on each side of an `.await` (commit -> revoke sessions -> audit)
//! then stops half-way: the account exists, the audit row does not.
//!
//! [`BoundServer::serve`](crate::BoundServer::serve) therefore wraps the whole
//! router in [`detach_writes`]: a request with a writing method (POST, PUT,
//! PATCH, DELETE) runs in its own `tokio::spawn`ed task and the connection
//! only waits for that task. Dropping the waiting side (the disconnect) does
//! not stop the task. Reads (GET, HEAD, the SSE stream) are untouched.
//!
//! - **Every** write is detached, login included; there is no opt-out
//!   (plan §10, decision 8). A derived app gets this by being served through
//!   `serve` - there is nothing to wrap per handler, so nothing to forget.
//! - **Not idempotent.** A client that disconnected does not know the
//!   outcome. An operation that takes effect twice when it is sent again (a
//!   create) has to be guarded where it always was: a version, a unique
//!   constraint.
//! - **Stop**: [`RunningServer::stop`](crate::RunningServer::stop) first
//!   closes this gate (a write that arrives afterwards is answered 503 and
//!   never starts), then waits - with an upper bound - until the detached
//!   writes are done, and reports the ones that are not
//!   ([`StopOutcome::WritesRemaining`]). It never reports success with work
//!   left behind.
//! - **A bound on how many run at once** ([`MAX_DETACHED_WRITES`]): a
//!   disconnected client's write no longer occupies a connection, so writes
//!   could otherwise pile up beyond the number of connections. Only NEW
//!   writes are refused (503, the handler never starts); one that was
//!   accepted is never stopped. The bound is a [`WriteBudget`]; an app that
//!   replaces its listener hands the old listener's budget to the new one
//!   ([`BoundServer::with_write_budget`](crate::BoundServer::with_write_budget)),
//!   so the writes a stopped listener left running still count.
//! - **The body is received first** (PR #829 review): a write takes its place
//!   only once its body has arrived, so a client that sends the headers and
//!   then stalls holds no place and starts no handler. The layer reads up to
//!   [`BUFFERED_BODY_MAX_BYTES`] itself, giving up (408) when nothing arrives
//!   for [`BODY_IDLE_LIMIT`] - a limit on the body that has not come, never
//!   on a handler. A larger body is streamed to the handler as before, and
//!   only [`MAX_STREAMED_WRITES`] of those run at once, so stalled uploads
//!   cannot use up the room of ordinary writes.
//! - **Panic**: a handler that panics is answered 500 ("read the state again,
//!   then retry") instead of a dropped connection, and logged with
//!   `eprintln!` (no `tracing`, conventions §3).
//!
//! A router served some other way (`oneshot` in tests) does not get the
//! layer; nothing there can disconnect.
//!
//! Tauri commands need no such layer: a command is not tied to a connection
//! (Tauri runs each async command as its own task), so this is a difference
//! of transport only. Authorization and audit stay symmetric (conventions §1).

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use banto_core::{BantoError, ErrorBody};
use futures_util::StreamExt;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::watch;

/// How many detached writes run at once under one [`WriteBudget`] (ADR-0035
/// §7) - one listener, or every listener generation that shares the budget.
/// A write that arrives while this many are running is answered 503 and does
/// not start. Far above what this kind of app sees - a write is short, and before
/// the layer the number was bounded by the open connections - so it only cuts
/// off writes piled up by clients that send and disconnect.
pub const MAX_DETACHED_WRITES: usize = 256;

/// How much of a write's body the layer receives itself before the write
/// takes its place (ADR-0035 §7). The same 2 MiB as axum's default body limit
/// (`DefaultBodyLimit`), so every body a handler accepts without raising that
/// limit is received before its handler - and its place - exists.
pub const BUFFERED_BODY_MAX_BYTES: usize = 2 * 1024 * 1024;

/// How long the layer waits for the next piece of a body it is receiving
/// (ADR-0035 §7). Only the wait for bytes that have not arrived is limited,
/// and only before the handler starts; a handler is never stopped.
pub const BODY_IDLE_LIMIT: Duration = Duration::from_secs(30);

/// How many of the [`MAX_DETACHED_WRITES`] places writes with a body larger
/// than [`BUFFERED_BODY_MAX_BYTES`] may hold (ADR-0035 §7). Such a body (an
/// uploaded backup) is not held in memory by the layer: it is streamed to
/// the handler, so the write has to take its place before the body is there.
/// Stalled uploads can then only keep other large uploads out.
pub const MAX_STREAMED_WRITES: usize = 16;

/// The shared count behind [`MAX_DETACHED_WRITES`] (ADR-0035 §7).
///
/// Each listener has its own gate and its own list of running writes (a stop
/// closes and drains one generation), but the room for NEW writes belongs to
/// the app: a listener that was stopped with writes still running keeps
/// their share of the budget until they finish, and the listener that
/// replaces it - the same configuration brought back after a refused switch,
/// for instance - can only start what is left. Get it from
/// [`RunningServer::write_budget`](crate::RunningServer::write_budget) and
/// pass it to
/// [`BoundServer::with_write_budget`](crate::BoundServer::with_write_budget).
/// A listener that is given none has a budget of its own.
#[derive(Clone, Default)]
pub struct WriteBudget(Arc<Counts>);

#[derive(Default)]
struct Counts {
    /// Every running write.
    running: AtomicUsize,
    /// The running writes whose body is streamed (a subset of `running`).
    streamed: AtomicUsize,
}

/// Adds one to `count` unless it is already `max`.
fn take_below(count: &AtomicUsize, max: usize) -> bool {
    // A plain compare-and-swap loop: `fetch_update` is deprecated in favour
    // of `try_update` on newer toolchains, and `try_update` does not exist on
    // older ones.
    let mut current = count.load(Ordering::SeqCst);
    loop {
        if current >= max {
            return false;
        }
        match count.compare_exchange_weak(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => return true,
            Err(now) => current = now,
        }
    }
}

impl WriteBudget {
    /// How many writes are running under this budget now, over all the
    /// listeners that share it.
    pub fn running(&self) -> usize {
        self.0.running.load(Ordering::SeqCst)
    }

    /// Takes one place, unless [`MAX_DETACHED_WRITES`] are taken - or, for a
    /// write whose body is streamed, [`MAX_STREAMED_WRITES`] of those.
    fn try_take(&self, streamed: bool) -> bool {
        if streamed && !take_below(&self.0.streamed, MAX_STREAMED_WRITES) {
            return false;
        }
        if take_below(&self.0.running, MAX_DETACHED_WRITES) {
            return true;
        }
        if streamed {
            self.0.streamed.fetch_sub(1, Ordering::SeqCst);
        }
        false
    }

    fn give_back(&self, streamed: bool) {
        self.0.running.fetch_sub(1, Ordering::SeqCst);
        if streamed {
            self.0.streamed.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl std::fmt::Debug for WriteBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteBudget")
            .field("running", &self.running())
            .finish()
    }
}

/// Why [`DetachedWrites::enter`] refused a write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refused {
    /// The server was asked to stop.
    Stopping,
    /// [`MAX_DETACHED_WRITES`] writes are running under the budget, or -
    /// for a write whose body is streamed - [`MAX_STREAMED_WRITES`] of those.
    Busy,
}

/// How many characters of `METHOD path` are kept for one running write.
const LABEL_MAX_CHARS: usize = 120;

/// How many running writes [`RemainingWrites::operations`] lists at most (the
/// count is always exact).
const OPERATIONS_LISTED_MAX: usize = 8;

/// The detached writes of one listener: a gate (open until the server is
/// asked to stop) and the writes running right now.
#[derive(Clone)]
pub(crate) struct DetachedWrites(Arc<Inner>);

struct Inner {
    state: Mutex<Running>,
    /// `state.running.len()`, published under the `state` lock, so a waiter
    /// can sleep until it is 0.
    running_count: watch::Sender<usize>,
    /// The room for new writes, possibly shared with other generations.
    budget: WriteBudget,
}

struct Running {
    closed: bool,
    next_id: u64,
    /// id -> `METHOD path` (no query string) of each running write.
    running: BTreeMap<u64, String>,
}

impl Default for DetachedWrites {
    fn default() -> Self {
        Self::with_budget(WriteBudget::default())
    }
}

impl DetachedWrites {
    /// The writes of one listener, counted against `budget`.
    pub(crate) fn with_budget(budget: WriteBudget) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(Running {
                closed: false,
                next_id: 0,
                running: BTreeMap::new(),
            }),
            running_count: watch::channel(0).0,
            budget,
        }))
    }

    /// The budget this listener counts against.
    pub(crate) fn budget(&self) -> WriteBudget {
        self.0.budget.clone()
    }

    fn state(&self) -> MutexGuard<'_, Running> {
        // Nothing panics while the lock is held; if it ever did, the map is
        // still consistent (every change is a single insert/remove).
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Counts one more running write until the returned guard is dropped, or
    /// refuses: once the gate is closed, or while [`MAX_DETACHED_WRITES`] are
    /// running under the budget (this listener's and those of the other
    /// generations sharing it). The gate check and the count are one step
    /// under the lock: a write is either refused, or seen by the stop that
    /// closed the gate.
    pub(crate) fn enter(&self, label: String) -> Result<DetachedWriteGuard, Refused> {
        self.enter_as(label, false)
    }

    /// [`enter`](Self::enter) for a write whose body is streamed to the
    /// handler: also bounded by [`MAX_STREAMED_WRITES`].
    fn enter_streamed(&self, label: String) -> Result<DetachedWriteGuard, Refused> {
        self.enter_as(label, true)
    }

    fn enter_as(&self, label: String, streamed: bool) -> Result<DetachedWriteGuard, Refused> {
        let mut state = self.state();
        if state.closed {
            return Err(Refused::Stopping);
        }
        if !self.0.budget.try_take(streamed) {
            return Err(Refused::Busy);
        }
        let id = state.next_id;
        state.next_id += 1;
        state.running.insert(id, label);
        self.0.running_count.send_replace(state.running.len());
        Ok(DetachedWriteGuard {
            writes: self.clone(),
            id,
            streamed,
        })
    }

    /// Refuse every write from now on. Never reopened: a stopped listener is
    /// replaced by a new one with its own gate.
    pub(crate) fn close(&self) {
        self.state().closed = true;
    }

    /// How many writes are running now.
    pub(crate) fn count(&self) -> usize {
        self.state().running.len()
    }

    /// `METHOD path` of the running writes, oldest first, at most
    /// [`OPERATIONS_LISTED_MAX`].
    pub(crate) fn operations(&self) -> Vec<String> {
        self.state()
            .running
            .values()
            .take(OPERATIONS_LISTED_MAX)
            .cloned()
            .collect()
    }

    /// Waits until no write is running, for at most `limit`. `true` when
    /// none is.
    pub(crate) async fn wait_idle(&self, limit: Duration) -> bool {
        let mut count = self.0.running_count.subscribe();
        // `wait_for` checks the current value first. The sender lives in
        // `self`, so it cannot close while this waits.
        let idle = tokio::time::timeout(limit, count.wait_for(|running| *running == 0)).await;
        matches!(idle, Ok(Ok(_)))
    }
}

/// One running write in [`DetachedWrites`]; dropping it uncounts it. It is
/// owned by the spawned task, so it is dropped however the task ends - the
/// handler returns, or it panics (the unwind drops it).
pub(crate) struct DetachedWriteGuard {
    writes: DetachedWrites,
    id: u64,
    /// Whether it also holds one of the [`MAX_STREAMED_WRITES`] places.
    streamed: bool,
}

impl Drop for DetachedWriteGuard {
    fn drop(&mut self) {
        let mut state = self.writes.state();
        state.running.remove(&self.id);
        self.writes.0.budget.give_back(self.streamed);
        self.writes
            .0
            .running_count
            .send_replace(state.running.len());
    }
}

/// What [`RunningServer::stop`](crate::RunningServer::stop) found when it
/// gave up waiting.
#[derive(Debug)]
pub enum StopOutcome {
    /// The listener is closed and every write it accepted is done.
    Finished,
    /// The listener is closed and refuses new writes, but writes it accepted
    /// earlier are still running after the wait. They keep running: they
    /// cannot be cancelled without leaving them half-done. The caller decides
    /// what must not happen while they run (e.g. starting a listener with a
    /// wider configuration, ADR-0035).
    WritesRemaining(RemainingWrites),
}

impl StopOutcome {
    /// The writes that were still running, if any.
    pub fn remaining(self) -> Option<RemainingWrites> {
        match self {
            StopOutcome::Finished => None,
            StopOutcome::WritesRemaining(remaining) => Some(remaining),
        }
    }
}

/// The writes of a stopped listener that had not finished when
/// [`RunningServer::stop`](crate::RunningServer::stop) returned. A live view:
/// the numbers go down as the writes finish.
#[derive(Clone)]
pub struct RemainingWrites(DetachedWrites);

impl RemainingWrites {
    pub(crate) fn new(writes: DetachedWrites) -> Self {
        Self(writes)
    }

    /// How many are running now.
    pub fn count(&self) -> usize {
        self.0.count()
    }

    /// Whether all of them are done now.
    pub fn is_finished(&self) -> bool {
        self.count() == 0
    }

    /// `METHOD path` (no query string, cut to a fixed length) of the ones
    /// running now, oldest first. A bounded list for a log or an audit
    /// detail - [`Self::count`] is the exact number.
    pub fn operations(&self) -> Vec<String> {
        self.0.operations()
    }

    /// Waits until all of them are done, for at most `limit`. `true` when
    /// they are.
    pub async fn wait(&self, limit: Duration) -> bool {
        self.0.wait_idle(limit).await
    }
}

impl std::fmt::Debug for RemainingWrites {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemainingWrites")
            .field("count", &self.count())
            .field("operations", &self.operations())
            .finish()
    }
}

fn is_write(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// `METHOD path` for the running-writes list. The query string is left out
/// (it can carry a file name), and the result is cut to a fixed length.
fn write_label(method: &Method, path: &str) -> String {
    let label = format!("{method} {path}");
    if label.chars().count() <= LABEL_MAX_CHARS {
        return label;
    }
    let mut cut: String = label.chars().take(LABEL_MAX_CHARS).collect();
    cut.push('…');
    cut
}

fn error_response(status: StatusCode, message: &str) -> Response {
    let body = ErrorBody::from(&BantoError::Other(message.to_string()));
    (status, Json(body)).into_response()
}

/// The length the request declares, if it declares one that can be read.
fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// A write's body, as the layer hands it to the handler.
#[derive(Debug)]
enum Received {
    /// All of it arrived, and it is at most [`BUFFERED_BODY_MAX_BYTES`].
    Whole(Bytes),
    /// It is larger than that: the handler reads the rest from the
    /// connection.
    Streamed(Body),
}

/// Why [`receive_body`] gave up. Nothing ran in either case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyFailure {
    /// Nothing arrived for the idle limit.
    Idle,
    /// The connection failed, or the body is malformed.
    Broken,
}

/// Receives a write's body before its handler exists: all of it when it is
/// at most [`BUFFERED_BODY_MAX_BYTES`]. A body that declares more, or turns
/// out to be more, is not held in memory - what was read is handed on in
/// front of the rest. `idle_limit` bounds each wait for the next piece.
async fn receive_body(
    declared: Option<u64>,
    body: Body,
    idle_limit: Duration,
) -> Result<Received, BodyFailure> {
    if declared.is_some_and(|length| length > BUFFERED_BODY_MAX_BYTES as u64) {
        return Ok(Received::Streamed(body));
    }
    let mut pieces = body.into_data_stream();
    let mut received: Vec<u8> = Vec::new();
    loop {
        match tokio::time::timeout(idle_limit, pieces.next()).await {
            Err(_) => return Err(BodyFailure::Idle),
            Ok(Some(Err(_))) => return Err(BodyFailure::Broken),
            Ok(None) => return Ok(Received::Whole(Bytes::from(received))),
            Ok(Some(Ok(piece))) => {
                received.extend_from_slice(&piece);
                if received.len() > BUFFERED_BODY_MAX_BYTES {
                    let head =
                        futures_util::stream::once(std::future::ready(Ok(Bytes::from(received))));
                    return Ok(Received::Streamed(Body::from_stream(head.chain(pieces))));
                }
            }
        }
    }
}

/// The layer itself (see the module doc). Installed once, outermost, by
/// [`BoundServer::serve`](crate::BoundServer::serve): everything inside it -
/// CSRF check, authentication, role guard, the handler and its audit - runs
/// in the spawned task.
pub(crate) async fn detach_writes(
    State(writes): State<DetachedWrites>,
    request: Request,
    next: Next,
) -> Response {
    if !is_write(request.method()) {
        return next.run(request).await;
    }
    let label = write_label(request.method(), request.uri().path());
    // The body comes first: until it is here the write holds no place and
    // nothing of it runs, so a client that stalls costs what it cost before
    // this layer - its own connection. If the connection goes away during
    // this wait, this future is dropped and nothing has happened.
    let (parts, body) = request.into_parts();
    let received = match receive_body(declared_length(&parts.headers), body, BODY_IDLE_LIMIT).await
    {
        Ok(received) => received,
        Err(BodyFailure::Idle) => {
            return error_response(
                StatusCode::REQUEST_TIMEOUT,
                "リクエストの本文が届かなかったため、この操作は受け付けられませんでした。\
                 もう一度試してください。",
            );
        }
        Err(BodyFailure::Broken) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "リクエストの本文を受け取れなかったため、この操作は受け付けられませんでした。\
                 もう一度試してください。",
            );
        }
    };
    let (entered, body, streamed) = match received {
        Received::Whole(bytes) => (writes.enter(label.clone()), Body::from(bytes), false),
        Received::Streamed(body) => (writes.enter_streamed(label.clone()), body, true),
    };
    let guard = match entered {
        Ok(guard) => guard,
        // Either way nothing ran and nothing changed.
        Err(Refused::Stopping) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "サーバーを停止しているため、この操作は受け付けられませんでした。\
                 少し待ってから、もう一度試してください。",
            );
        }
        Err(Refused::Busy) => {
            let bound = if streamed {
                format!("本文の大きい書き込みの上限（{MAX_STREAMED_WRITES}件）")
            } else {
                format!("上限（{MAX_DETACHED_WRITES}件）")
            };
            eprintln!(
                "banto-server: 処理中の書き込みが{bound}に達したため、\
                 新しい書き込みを断りました（{label}）"
            );
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "処理中の操作が多いため、この操作は受け付けられませんでした。\
                 少し待ってから、もう一度試してください。",
            );
        }
    };
    let request = Request::from_parts(parts, body);
    let task = tokio::spawn(async move {
        let _guard = guard;
        next.run(request).await
    });
    // If the connection goes away, THIS future is dropped; `task` keeps
    // running (dropping a `JoinHandle` detaches it).
    match task.await {
        Ok(response) => response,
        Err(err) => {
            // A panic in the handler (or the runtime shutting down). How far
            // the operation got is unknown.
            eprintln!("banto-server: 書き込みの処理が異常終了しました（{label}）: {err}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "処理の途中でエラーが起きました。状態を読み直してから、もう一度試してください。",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_writing_methods_are_detached() {
        for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
            assert!(is_write(&method), "{method}");
        }
        for method in [Method::GET, Method::HEAD, Method::OPTIONS] {
            assert!(!is_write(&method), "{method}");
        }
    }

    #[test]
    fn label_is_method_and_path_cut_to_a_fixed_length() {
        assert_eq!(write_label(&Method::POST, "/api/users"), "POST /api/users");
        let long = format!("/api/{}", "あ".repeat(300));
        let label = write_label(&Method::PUT, &long);
        assert_eq!(label.chars().count(), LABEL_MAX_CHARS + 1);
        assert!(label.ends_with('…'));
    }

    #[tokio::test]
    async fn a_closed_gate_refuses_and_running_writes_are_counted_until_dropped() {
        let writes = DetachedWrites::default();
        let first = writes.enter("POST /a".to_string()).expect("open gate");
        let second = writes.enter("PUT /b".to_string()).expect("open gate");
        assert_eq!(writes.count(), 2);
        assert_eq!(writes.operations(), vec!["POST /a", "PUT /b"]);
        assert!(!writes.wait_idle(Duration::from_millis(20)).await);

        writes.close();
        assert_eq!(
            writes.enter("POST /c".to_string()).err(),
            Some(Refused::Stopping)
        );
        // Closing does not touch the ones already running.
        assert_eq!(writes.count(), 2);

        drop(first);
        assert_eq!(writes.operations(), vec!["PUT /b"]);
        let waiter = {
            let writes = writes.clone();
            tokio::spawn(async move { writes.wait_idle(Duration::from_secs(3)).await })
        };
        drop(second);
        assert!(waiter.await.unwrap());
        assert_eq!(writes.count(), 0);
    }

    /// ADR-0035 §7: only NEW writes are refused at the bound; the running
    /// ones go on, and a finished one makes room again.
    #[test]
    fn a_write_beyond_the_bound_is_refused_until_one_finishes() {
        let writes = DetachedWrites::default();
        let mut guards: Vec<_> = (0..MAX_DETACHED_WRITES)
            .map(|i| writes.enter(format!("POST /{i}")).unwrap())
            .collect();
        assert_eq!(
            writes.enter("POST /over".to_string()).err(),
            Some(Refused::Busy)
        );
        assert_eq!(writes.count(), MAX_DETACHED_WRITES);
        guards.pop();
        assert!(writes.enter("POST /again".to_string()).is_ok());
    }

    /// Review of PR #829: the bound covers every generation that shares the
    /// budget. A stopped listener's unfinished writes keep their places, the
    /// listener that replaces it can start only what is left, and a place
    /// comes back when an old write finishes. The gate and the drain stay
    /// per generation.
    #[tokio::test]
    async fn generations_sharing_a_budget_share_the_room_for_new_writes() {
        let budget = WriteBudget::default();
        let old = DetachedWrites::with_budget(budget.clone());
        let mut old_writes: Vec<_> = (0..3)
            .map(|i| old.enter(format!("POST /old/{i}")).unwrap())
            .collect();
        // The old listener stops with its three writes still running.
        old.close();
        assert!(!old.wait_idle(Duration::from_millis(10)).await);

        let new = DetachedWrites::with_budget(budget.clone());
        let new_writes: Vec<_> = (0..MAX_DETACHED_WRITES - 3)
            .map(|i| new.enter(format!("POST /new/{i}")).unwrap())
            .collect();
        assert_eq!(budget.running(), MAX_DETACHED_WRITES);
        assert_eq!(
            new.enter("POST /new/over".to_string()).err(),
            Some(Refused::Busy)
        );
        // Each generation still counts (and drains) its own writes.
        assert_eq!((old.count(), new.count()), (3, MAX_DETACHED_WRITES - 3));

        // An old write finishes: exactly one place comes back.
        old_writes.pop();
        let one_more = new.enter("POST /new/room".to_string()).unwrap();
        assert_eq!(
            new.enter("POST /new/over".to_string()).err(),
            Some(Refused::Busy)
        );

        drop(old_writes);
        assert!(old.wait_idle(Duration::from_secs(3)).await);
        assert_eq!(budget.running(), MAX_DETACHED_WRITES - 2);
        drop((new_writes, one_more));
        assert_eq!(budget.running(), 0);
    }

    /// Listeners that were given no budget do not share one.
    #[test]
    fn separate_budgets_do_not_affect_each_other() {
        let first = DetachedWrites::default();
        let _held: Vec<_> = (0..MAX_DETACHED_WRITES)
            .map(|i| first.enter(format!("POST /{i}")).unwrap())
            .collect();
        assert!(DetachedWrites::default()
            .enter("POST /x".to_string())
            .is_ok());
    }

    #[test]
    fn the_listed_operations_are_bounded_but_the_count_is_exact() {
        let writes = DetachedWrites::default();
        let guards: Vec<_> = (0..OPERATIONS_LISTED_MAX + 3)
            .map(|i| writes.enter(format!("POST /{i}")).unwrap())
            .collect();
        assert_eq!(writes.count(), OPERATIONS_LISTED_MAX + 3);
        assert_eq!(writes.operations().len(), OPERATIONS_LISTED_MAX);
        drop(guards);
        assert_eq!(writes.count(), 0);
    }

    /// After the stop signal (the closed gate) a write is answered 503 and
    /// the handler never runs; a read still goes through. Over `oneshot`:
    /// hyper closes its connections when the stop begins, so a real socket
    /// only reaches this in the short race the gate exists for.
    #[tokio::test]
    async fn a_write_after_the_gate_closed_is_answered_503_and_never_runs() {
        use axum::body::Body;
        use axum::routing::post;
        use tower::ServiceExt;

        let ran = Arc::new(AtomicUsize::new(0));
        let writes = DetachedWrites::default();
        let handler = {
            let ran = Arc::clone(&ran);
            move || {
                let ran = Arc::clone(&ran);
                async move {
                    ran.fetch_add(1, Ordering::SeqCst);
                    "ok"
                }
            }
        };
        let router = axum::Router::new()
            .route("/thing", post(handler.clone()).get(handler))
            .layer(axum::middleware::from_fn_with_state(
                writes.clone(),
                detach_writes,
            ));
        let send = |method: Method| {
            let router = router.clone();
            async move {
                let request = Request::builder()
                    .method(method)
                    .uri("/thing")
                    .body(Body::empty())
                    .unwrap();
                router.oneshot(request).await.unwrap()
            }
        };

        assert_eq!(send(Method::POST).await.status(), StatusCode::OK);
        assert_eq!(ran.load(Ordering::SeqCst), 1);
        assert_eq!(writes.count(), 0, "uncounted once it is done");

        writes.close();
        for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
            let response = send(method).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        assert_eq!(ran.load(Ordering::SeqCst), 1, "no refused write ran");
        assert_eq!(writes.count(), 0);

        assert_eq!(send(Method::GET).await.status(), StatusCode::OK);
        assert_eq!(ran.load(Ordering::SeqCst), 2);
    }

    /// PR #829 review: the writes whose body is streamed have a bound of
    /// their own inside the budget, and a refused one leaves no count behind.
    #[test]
    fn streamed_writes_have_their_own_bound_inside_the_budget() {
        let writes = DetachedWrites::default();
        let mut streamed: Vec<_> = (0..MAX_STREAMED_WRITES)
            .map(|n| {
                writes
                    .enter_streamed(format!("POST /big/{n}"))
                    .expect("room")
            })
            .collect();
        assert_eq!(
            writes.enter_streamed("POST /big/more".to_string()).err(),
            Some(Refused::Busy)
        );
        // Ordinary writes still have the rest of the room.
        let ordinary: Vec<_> = (0..MAX_DETACHED_WRITES - MAX_STREAMED_WRITES)
            .map(|n| writes.enter(format!("POST /small/{n}")).expect("room"))
            .collect();
        assert_eq!(writes.budget().running(), MAX_DETACHED_WRITES);

        // Full: a streamed write is refused by the outer bound even after a
        // streamed place came back, and that refusal must not leak one.
        drop(ordinary);
        streamed.pop();
        let ordinary: Vec<_> = (0..MAX_DETACHED_WRITES - MAX_STREAMED_WRITES + 1)
            .map(|n| writes.enter(format!("POST /small/{n}")).expect("room"))
            .collect();
        assert_eq!(
            writes.enter_streamed("POST /big/full".to_string()).err(),
            Some(Refused::Busy)
        );
        drop(ordinary);
        assert!(writes.enter_streamed("POST /big/again".to_string()).is_ok());
        drop(streamed);
        assert_eq!(writes.budget().running(), 0);
        let again: Vec<_> = (0..MAX_STREAMED_WRITES)
            .map(|n| {
                writes
                    .enter_streamed(format!("POST /big/{n}"))
                    .expect("room")
            })
            .collect();
        assert_eq!(again.len(), MAX_STREAMED_WRITES);
    }

    fn pieces(items: Vec<Result<Bytes, std::io::Error>>, then_stall: bool) -> axum::body::Body {
        let sent = futures_util::stream::iter(items);
        if then_stall {
            axum::body::Body::from_stream(sent.chain(futures_util::stream::pending()))
        } else {
            axum::body::Body::from_stream(sent)
        }
    }

    const SOON: Duration = Duration::from_millis(50);

    #[tokio::test]
    async fn a_body_within_the_limit_is_received_whole() {
        let body = pieces(vec![Ok(Bytes::from("hel")), Ok(Bytes::from("lo"))], false);
        match receive_body(None, body, SOON).await {
            Ok(Received::Whole(bytes)) => assert_eq!(&bytes[..], b"hello"),
            other => panic!("expected the whole body, got {other:?}"),
        }
        let empty = receive_body(Some(0), axum::body::Body::empty(), SOON).await;
        assert!(matches!(empty, Ok(Received::Whole(bytes)) if bytes.is_empty()));
    }

    /// The case of the review: headers, part of the body, then nothing.
    #[tokio::test]
    async fn a_body_that_stops_arriving_is_given_up_after_the_idle_limit() {
        let body = pieces(vec![Ok(Bytes::from("{\"user"))], true);
        let outcome = receive_body(Some(40), body, SOON).await;
        assert_eq!(outcome.err(), Some(BodyFailure::Idle));

        let broken = pieces(vec![Err(std::io::Error::other("reset"))], false);
        let outcome = receive_body(None, broken, SOON).await;
        assert_eq!(outcome.err(), Some(BodyFailure::Broken));
    }

    #[tokio::test]
    async fn a_larger_body_is_streamed_and_arrives_complete() {
        // Declared: handed on untouched, without waiting for any of it.
        let stalled = pieces(vec![], true);
        let declared = Some(BUFFERED_BODY_MAX_BYTES as u64 + 1);
        assert!(matches!(
            receive_body(declared, stalled, SOON).await,
            Ok(Received::Streamed(_))
        ));
        // Exactly the limit is still received whole.
        let exact = axum::body::Body::from(vec![7u8; BUFFERED_BODY_MAX_BYTES]);
        let at_limit = Some(BUFFERED_BODY_MAX_BYTES as u64);
        assert!(matches!(
            receive_body(at_limit, exact, SOON).await,
            Ok(Received::Whole(bytes)) if bytes.len() == BUFFERED_BODY_MAX_BYTES
        ));

        // Not declared (chunked): what was read goes in front of the rest.
        let piece = Bytes::from(vec![b'x'; 512 * 1024]);
        let body = pieces((0..5).map(|_| Ok(piece.clone())).collect(), false);
        let Ok(Received::Streamed(body)) = receive_body(None, body, SOON).await else {
            panic!("expected a streamed body");
        };
        let all = axum::body::to_bytes(body, usize::MAX).await.expect("body");
        assert_eq!(all.len(), 5 * 512 * 1024);
        assert!(all.iter().all(|byte| *byte == b'x'));
    }

    /// The handler gets the body the layer received, and a write whose body
    /// never comes neither runs nor is counted.
    #[tokio::test]
    async fn the_handler_reads_the_received_body_and_a_missing_body_starts_nothing() {
        use axum::routing::post;
        use tower::ServiceExt;

        let writes = DetachedWrites::default();
        let router = axum::Router::new()
            .route("/echo", post(|body: String| async move { body }))
            .layer(axum::middleware::from_fn_with_state(
                writes.clone(),
                detach_writes,
            ));
        let request = Request::builder()
            .method(Method::POST)
            .uri("/echo")
            .body(pieces(
                vec![Ok(Bytes::from("hel")), Ok(Bytes::from("lo"))],
                false,
            ))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"hello");

        let request = Request::builder()
            .method(Method::POST)
            .uri("/echo")
            .body(pieces(vec![Ok(Bytes::from("hel"))], true))
            .unwrap();
        let mut waiting = std::pin::pin!(router.oneshot(request));
        let early = tokio::time::timeout(Duration::from_millis(100), &mut waiting).await;
        assert!(early.is_err(), "still waiting for the body");
        assert_eq!(
            writes.count(),
            0,
            "no place is held while the body is missing"
        );
        assert_eq!(writes.budget().running(), 0);
    }
}
