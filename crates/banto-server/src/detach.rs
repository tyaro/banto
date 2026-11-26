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
//!   That holds for every listener served through `serve`, also one the app
//!   made itself
//!   ([`BoundServer::from_listener`](crate::BoundServer::from_listener),
//!   Issue #947); the layer is not public, so there is no other way to
//!   install it.
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
//!   [`BUFFERED_BODY_MAX_BYTES`] itself, giving up (408) when the body is
//!   not complete within [`BODY_RECEIVE_LIMIT`] - a limit on the body that
//!   has not come, never on a handler. All the bodies being received
//!   together hold at most [`RECEIVING_BODIES_MAX_BYTES`]; beyond that a
//!   write is refused (503) instead of using more memory. A larger body is
//!   streamed to the handler as before, and only [`MAX_STREAMED_WRITES`] of
//!   those run at once, so stalled uploads cannot use up the room of
//!   ordinary writes.
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
use tokio::sync::{watch, Notify};

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

/// How long the layer waits for the whole of a body it is receiving
/// (ADR-0035 §7), from the request's headers to the body's end. Only the
/// wait for a body that has not arrived is limited, and only before the
/// handler starts; a handler is never stopped.
pub const BODY_RECEIVE_LIMIT: Duration = Duration::from_secs(30);

/// How many bytes all the bodies the layer is receiving hold together, under
/// one [`WriteBudget`] (ADR-0035 §7). These bytes are held before anything
/// checked who sent them, so their sum is bounded: a write whose next piece
/// does not fit is answered 503 and does not start. Counted as they arrive
/// (not as declared), and given back when the body is complete and its write
/// has taken a place, or when the wait ends any other way (the client is
/// gone, the time is up, the write is refused).
pub const RECEIVING_BODIES_MAX_BYTES: usize = 64 * 1024 * 1024;

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
    /// The bytes of the bodies being received for writes that have not
    /// started yet.
    receiving_bytes: AtomicUsize,
    /// Woken whenever a write gives its place back, so a waiter can sleep
    /// until `running` is 0 ([`WriteBudget::wait_idle_until`]).
    given_back: Notify,
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

    /// How many bytes of bodies are being received now for writes that have
    /// not started yet, over all the listeners that share this budget (at
    /// most [`RECEIVING_BODIES_MAX_BYTES`]).
    pub fn receiving_bytes(&self) -> usize {
        self.0.receiving_bytes.load(Ordering::SeqCst)
    }

    /// Whether every place is taken now (a write arriving now is refused).
    fn is_full(&self) -> bool {
        self.running() >= MAX_DETACHED_WRITES
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
        self.0.given_back.notify_waiters();
    }

    /// Waits until no write is running under this budget - of any listener
    /// and any generation that shares it - or until `deadline`. `true` when
    /// none is running.
    ///
    /// Not public: "0 right now" only means "all done" when nothing can start
    /// a write any more, i.e. after every gate was closed. The one caller
    /// that can promise that is [`crate::WriteLedger::stop_all_until`]
    /// (Issue #981).
    pub(crate) async fn wait_idle_until(&self, deadline: tokio::time::Instant) -> bool {
        loop {
            // Registered BEFORE the count is read: a `give_back` between the
            // read and the sleep still wakes this.
            let given_back = self.0.given_back.notified();
            tokio::pin!(given_back);
            given_back.as_mut().enable();
            if self.running() == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, given_back).await.is_err() {
                return self.running() == 0;
            }
        }
    }
}

/// The bytes one body being received holds of
/// [`RECEIVING_BODIES_MAX_BYTES`]; dropping it gives them back.
struct ReceivingRoom {
    budget: WriteBudget,
    held: usize,
}

impl ReceivingRoom {
    fn new(budget: WriteBudget) -> Self {
        Self { budget, held: 0 }
    }

    /// Holds `more` bytes as well, unless the bodies being received would
    /// then hold more than [`RECEIVING_BODIES_MAX_BYTES`] together.
    fn grow(&mut self, more: usize) -> bool {
        let count = &self.budget.0.receiving_bytes;
        let mut current = count.load(Ordering::SeqCst);
        loop {
            let Some(grown) = current
                .checked_add(more)
                .filter(|grown| *grown <= RECEIVING_BODIES_MAX_BYTES)
            else {
                return false;
            };
            match count.compare_exchange_weak(current, grown, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => {
                    self.held += more;
                    return true;
                }
                Err(now) => current = now,
            }
        }
    }
}

impl Drop for ReceivingRoom {
    fn drop(&mut self) {
        self.budget
            .0
            .receiving_bytes
            .fetch_sub(self.held, Ordering::SeqCst);
    }
}

impl std::fmt::Debug for WriteBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteBudget")
            .field("running", &self.running())
            .field("receiving_bytes", &self.receiving_bytes())
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

    /// Whether a write arriving now would be refused whatever its body is -
    /// asked before the body is received, so that one is not waited for (and
    /// held in memory) only to be refused. [`enter`](Self::enter) decides.
    fn refusal_now(&self) -> Option<Refused> {
        if self.state().closed {
            Some(Refused::Stopping)
        } else if self.0.budget.is_full() {
            Some(Refused::Busy)
        } else {
            None
        }
    }

    /// Refuse every write from now on. Never reopened: a stopped listener is
    /// replaced by a new one with its own gate.
    /// Whether [`Self::close`] was called.
    pub(crate) fn is_closed(&self) -> bool {
        self.0
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .closed
    }

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
    /// It was not complete within the time limit.
    Late,
    /// The bodies being received already hold
    /// [`RECEIVING_BODIES_MAX_BYTES`].
    NoRoom,
    /// The connection failed, or the body is malformed.
    Broken,
}

/// Receives a write's body before its handler exists: all of it when it is
/// at most [`BUFFERED_BODY_MAX_BYTES`]. A body that declares more, or turns
/// out to be more, is not held in memory - what was read is handed on in
/// front of the rest. The bytes held are counted in `room` as they arrive;
/// `limit` bounds the whole wait.
async fn receive_body(
    declared: Option<u64>,
    body: Body,
    room: &mut ReceivingRoom,
    limit: Duration,
) -> Result<Received, BodyFailure> {
    if declared.is_some_and(|length| length > BUFFERED_BODY_MAX_BYTES as u64) {
        return Ok(Received::Streamed(body));
    }
    let receive = async {
        let mut pieces = body.into_data_stream();
        let mut received: Vec<u8> = Vec::new();
        loop {
            match pieces.next().await {
                Some(Err(_)) => return Err(BodyFailure::Broken),
                None => return Ok(Received::Whole(Bytes::from(received))),
                Some(Ok(piece)) => {
                    if !room.grow(piece.len()) {
                        return Err(BodyFailure::NoRoom);
                    }
                    received.extend_from_slice(&piece);
                    if received.len() > BUFFERED_BODY_MAX_BYTES {
                        let head = futures_util::stream::once(std::future::ready(Ok(Bytes::from(
                            received,
                        ))));
                        return Ok(Received::Streamed(Body::from_stream(head.chain(pieces))));
                    }
                }
            }
        }
    };
    match tokio::time::timeout(limit, receive).await {
        Ok(outcome) => outcome,
        Err(_) => Err(BodyFailure::Late),
    }
}

/// The answer to a write that was refused: nothing ran and nothing changed.
fn refused_response(refused: Refused, streamed: bool, label: &str) -> Response {
    match refused {
        Refused::Stopping => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "サーバーを停止しているため、この操作は受け付けられませんでした。\
             少し待ってから、もう一度試してください。",
        ),
        Refused::Busy => {
            let bound = if streamed {
                format!("本文の大きい書き込みの上限（{MAX_STREAMED_WRITES}件）")
            } else {
                format!("上限（{MAX_DETACHED_WRITES}件）")
            };
            eprintln!(
                "banto-server: 処理中の書き込みが{bound}に達したため、\
                 新しい書き込みを断りました（{label}）"
            );
            busy_response()
        }
    }
}

fn busy_response() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "処理中の操作が多いため、この操作は受け付けられませんでした。\
         少し待ってから、もう一度試してください。",
    )
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
    // What can be refused without the body is refused before it is waited
    // for. (Authentication and the role guard are inside the router: they
    // run in the spawned task, after the body.)
    if let Some(refused) = writes.refusal_now() {
        return refused_response(refused, false, &label);
    }
    // The body comes first: until it is here the write holds no place and
    // nothing of it runs, so a client that stalls costs what it cost before
    // this layer - its own connection - plus the bytes it sent, which `room`
    // counts. If the connection goes away during this wait, this future is
    // dropped (and `room` with it) and nothing has happened.
    let (parts, body) = request.into_parts();
    let mut room = ReceivingRoom::new(writes.budget());
    let declared = declared_length(&parts.headers);
    let received = match receive_body(declared, body, &mut room, BODY_RECEIVE_LIMIT).await {
        Ok(received) => received,
        Err(BodyFailure::Late) => {
            return error_response(
                StatusCode::REQUEST_TIMEOUT,
                "リクエストの本文が時間内に届かなかったため、この操作は受け付けられませんでした。\
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
        Err(BodyFailure::NoRoom) => {
            eprintln!(
                "banto-server: 受け取り中の書き込みの本文が上限\
                 （合計 {RECEIVING_BODIES_MAX_BYTES} バイト）に達したため、\
                 新しい書き込みを断りました（{label}）"
            );
            return busy_response();
        }
    };
    let (entered, body, streamed) = match received {
        Received::Whole(bytes) => (writes.enter(label.clone()), Body::from(bytes), false),
        Received::Streamed(body) => (writes.enter_streamed(label.clone()), body, true),
    };
    // From here the body belongs to a running write (counted by its place)
    // or to nothing.
    drop(room);
    let guard = match entered {
        Ok(guard) => guard,
        Err(refused) => return refused_response(refused, streamed, &label),
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

    fn room() -> ReceivingRoom {
        ReceivingRoom::new(WriteBudget::default())
    }

    #[tokio::test]
    async fn a_body_within_the_limit_is_received_whole() {
        let body = pieces(vec![Ok(Bytes::from("hel")), Ok(Bytes::from("lo"))], false);
        match receive_body(None, body, &mut room(), SOON).await {
            Ok(Received::Whole(bytes)) => assert_eq!(&bytes[..], b"hello"),
            other => panic!("expected the whole body, got {other:?}"),
        }
        let empty = receive_body(Some(0), axum::body::Body::empty(), &mut room(), SOON).await;
        assert!(matches!(empty, Ok(Received::Whole(bytes)) if bytes.is_empty()));
    }

    /// The case of the review: headers, part of the body, then nothing.
    #[tokio::test]
    async fn a_body_that_stops_arriving_is_given_up_after_the_time_limit() {
        let body = pieces(vec![Ok(Bytes::from("{\"user"))], true);
        let outcome = receive_body(Some(40), body, &mut room(), SOON).await;
        assert_eq!(outcome.err(), Some(BodyFailure::Late));

        // The limit is on the whole body: one that keeps trickling in is
        // given up as well.
        let trickle = futures_util::stream::unfold((), |()| async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Some((Ok::<_, std::io::Error>(Bytes::from("x")), ()))
        });
        let body = axum::body::Body::from_stream(trickle);
        let outcome = receive_body(None, body, &mut room(), Duration::from_millis(100)).await;
        assert_eq!(outcome.err(), Some(BodyFailure::Late));

        let broken = pieces(vec![Err(std::io::Error::other("reset"))], false);
        let outcome = receive_body(None, broken, &mut room(), SOON).await;
        assert_eq!(outcome.err(), Some(BodyFailure::Broken));
    }

    #[tokio::test]
    async fn a_larger_body_is_streamed_and_arrives_complete() {
        // Declared: handed on untouched, without waiting for any of it.
        let stalled = pieces(vec![], true);
        let declared = Some(BUFFERED_BODY_MAX_BYTES as u64 + 1);
        assert!(matches!(
            receive_body(declared, stalled, &mut room(), SOON).await,
            Ok(Received::Streamed(_))
        ));
        // Exactly the limit is still received whole.
        let exact = axum::body::Body::from(vec![7u8; BUFFERED_BODY_MAX_BYTES]);
        let at_limit = Some(BUFFERED_BODY_MAX_BYTES as u64);
        assert!(matches!(
            receive_body(at_limit, exact, &mut room(), SOON).await,
            Ok(Received::Whole(bytes)) if bytes.len() == BUFFERED_BODY_MAX_BYTES
        ));

        // Not declared (chunked): what was read goes in front of the rest.
        let piece = Bytes::from(vec![b'x'; 512 * 1024]);
        let body = pieces((0..5).map(|_| Ok(piece.clone())).collect(), false);
        let Ok(Received::Streamed(body)) = receive_body(None, body, &mut room(), SOON).await else {
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

    /// PR #833 review: the bodies being received hold a bounded number of
    /// bytes together, and every way the wait ends gives them back.
    #[tokio::test]
    async fn the_bodies_being_received_share_a_bound_and_give_their_bytes_back() {
        let budget = WriteBudget::default();
        let full = BUFFERED_BODY_MAX_BYTES;
        let stalled_after = |bytes: usize| pieces(vec![Ok(Bytes::from(vec![1u8; bytes]))], true);

        // Bodies that arrived almost whole and then stalled: as many as fit.
        let fit = RECEIVING_BODIES_MAX_BYTES / full;
        {
            let mut rooms: Vec<_> = (0..fit)
                .map(|_| ReceivingRoom::new(budget.clone()))
                .collect();
            let waits = rooms
                .iter_mut()
                .map(|room| receive_body(None, stalled_after(full), room, Duration::from_secs(60)));
            let mut waiting = std::pin::pin!(futures_util::future::join_all(waits));
            let early = tokio::time::timeout(Duration::from_millis(100), &mut waiting).await;
            assert!(early.is_err(), "all still waiting");
            assert_eq!(budget.receiving_bytes(), RECEIVING_BODIES_MAX_BYTES);

            // One more is refused at its first piece, and holds nothing.
            let mut one_more = ReceivingRoom::new(budget.clone());
            let outcome = receive_body(None, stalled_after(1), &mut one_more, SOON).await;
            assert_eq!(outcome.err(), Some(BodyFailure::NoRoom));
            drop(one_more);
            assert_eq!(budget.receiving_bytes(), RECEIVING_BODIES_MAX_BYTES);
            // A write without a body needs none.
            let mut empty = ReceivingRoom::new(budget.clone());
            let outcome = receive_body(Some(0), axum::body::Body::empty(), &mut empty, SOON).await;
            assert!(matches!(outcome, Ok(Received::Whole(_))));
            // The clients go away: the waits and their rooms are dropped.
        }
        assert_eq!(budget.receiving_bytes(), 0);

        // Given up for the time, or broken: back as well.
        let mut late = ReceivingRoom::new(budget.clone());
        let outcome = receive_body(None, stalled_after(100), &mut late, SOON).await;
        assert_eq!(outcome.err(), Some(BodyFailure::Late));
        assert_eq!(
            budget.receiving_bytes(),
            100,
            "held until the room is dropped"
        );
        drop(late);
        assert_eq!(budget.receiving_bytes(), 0);
    }

    /// Through the layer: the bytes are held while the body is on its way,
    /// and given back when the write starts, is refused, or its client goes
    /// away. A write that would be refused anyway is refused before its body.
    #[tokio::test]
    async fn the_layer_gives_the_received_bytes_back_however_the_wait_ends() {
        use axum::routing::post;
        use tower::ServiceExt;

        let writes = DetachedWrites::default();
        let budget = writes.budget();
        let seen = Arc::new(AtomicUsize::new(0));
        let handler = {
            let (seen, budget) = (Arc::clone(&seen), budget.clone());
            move |body: String| {
                // What the handler sees while it runs.
                seen.store(budget.receiving_bytes() + 1, Ordering::SeqCst);
                async move { body }
            }
        };
        let router = axum::Router::new().route("/echo", post(handler)).layer(
            axum::middleware::from_fn_with_state(writes.clone(), detach_writes),
        );
        let post_with = |body: axum::body::Body| {
            let router = router.clone();
            let request = Request::builder()
                .method(Method::POST)
                .uri("/echo")
                .body(body)
                .unwrap();
            async move { router.oneshot(request).await.unwrap() }
        };

        // Completed: counted while waiting, not once the handler runs.
        let response = post_with(pieces(vec![Ok(Bytes::from("hello"))], false)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            seen.load(Ordering::SeqCst),
            1,
            "0 bytes held in the handler"
        );
        assert_eq!(budget.receiving_bytes(), 0);

        // The client goes away during the wait.
        {
            let mut waiting = std::pin::pin!(post_with(pieces(vec![Ok(Bytes::from("hel"))], true)));
            let early = tokio::time::timeout(Duration::from_millis(100), &mut waiting).await;
            assert!(early.is_err(), "still waiting for the body");
            assert_eq!(budget.receiving_bytes(), 3);
        }
        assert_eq!(budget.receiving_bytes(), 0);

        // Refused after the body arrived (the gate closed meanwhile).
        let (send, body) = tokio::sync::oneshot::channel::<Bytes>();
        // Told when the layer first polls the body, i.e. has begun to wait
        // for it (no sleep: the test does not depend on timing).
        let (polled, layer_is_waiting) = tokio::sync::oneshot::channel::<()>();
        let late_body = axum::body::Body::from_stream(futures_util::stream::once(async move {
            let _ = polled.send(());
            Ok::<_, std::io::Error>(body.await.unwrap_or_default())
        }));
        let waiting = tokio::spawn(post_with(late_body));
        layer_is_waiting.await.expect("the layer polled the body");
        writes.close();
        send.send(Bytes::from("late")).expect("still waiting");
        let response = waiting.await.expect("join");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(budget.receiving_bytes(), 0);

        // Refused before the body: this one would never arrive.
        let response = post_with(pieces(vec![], true)).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
