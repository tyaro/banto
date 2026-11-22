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

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use banto_core::{BantoError, ErrorBody};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::watch;

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
}

struct Running {
    closed: bool,
    next_id: u64,
    /// id -> `METHOD path` (no query string) of each running write.
    running: BTreeMap<u64, String>,
}

impl Default for DetachedWrites {
    fn default() -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(Running {
                closed: false,
                next_id: 0,
                running: BTreeMap::new(),
            }),
            running_count: watch::channel(0).0,
        }))
    }
}

impl DetachedWrites {
    fn state(&self) -> MutexGuard<'_, Running> {
        // Nothing panics while the lock is held; if it ever did, the map is
        // still consistent (every change is a single insert/remove).
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Counts one more running write until the returned guard is dropped, or
    /// `None` once the gate is closed. The check and the count are one step
    /// under the lock: a write is either refused, or seen by the stop that
    /// closed the gate.
    pub(crate) fn enter(&self, label: String) -> Option<DetachedWriteGuard> {
        let mut state = self.state();
        if state.closed {
            return None;
        }
        let id = state.next_id;
        state.next_id += 1;
        state.running.insert(id, label);
        self.0.running_count.send_replace(state.running.len());
        Some(DetachedWriteGuard {
            writes: self.clone(),
            id,
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
}

impl Drop for DetachedWriteGuard {
    fn drop(&mut self) {
        let mut state = self.writes.state();
        state.running.remove(&self.id);
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
    let Some(guard) = writes.enter(label.clone()) else {
        // The server was asked to stop. Nothing ran, nothing changed.
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "サーバーを停止しているため、この操作は受け付けられませんでした。\
             少し待ってから、もう一度試してください。",
        );
    };
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
        assert!(writes.enter("POST /c".to_string()).is_none());
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
        use std::sync::atomic::{AtomicUsize, Ordering};
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
}
