//! Issue #793 / ADR-0035: a write served through `BoundServer::serve` runs to
//! completion when its client disconnects, a panic is answered 500, and
//! `RunningServer::stop` refuses new writes, waits for the running ones and
//! says so when some are left.
//!
//! Over a real socket: the thing under test is what hyper does to a handler
//! when the peer goes away, which `oneshot` cannot show.

use axum::routing::{get, post};
use axum::Router;
use banto_server::{
    bind, start, BoundServer, RunningServer, ServerConfig, StopOutcome, WriteBudget, WriteLedger,
    BUFFERED_BODY_MAX_BYTES, MAX_DETACHED_WRITES, MAX_STREAMED_WRITES, RECEIVING_BODIES_MAX_BYTES,
};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

/// A handler in the shape of the real writes: one step, an `.await`, a second
/// step ("create", then "audit").
#[derive(Clone, Default)]
struct TwoSteps {
    /// How many requests reached the first step.
    created: Arc<AtomicUsize>,
    /// How many requests reached the second step.
    audited: Arc<AtomicUsize>,
    /// One permit lets one request go from the first step to the second.
    gate: Arc<SemaphoreBox>,
}

struct SemaphoreBox(Semaphore);

impl Default for SemaphoreBox {
    fn default() -> Self {
        Self(Semaphore::new(0))
    }
}

impl TwoSteps {
    async fn run(self) -> &'static str {
        self.created.fetch_add(1, Ordering::SeqCst);
        self.gate.0.acquire().await.expect("gate").forget();
        self.audited.fetch_add(1, Ordering::SeqCst);
        "done"
    }

    fn release(&self, requests: usize) {
        self.gate.0.add_permits(requests);
    }

    fn created(&self) -> usize {
        self.created.load(Ordering::SeqCst)
    }

    fn audited(&self) -> usize {
        self.audited.load(Ordering::SeqCst)
    }
}

fn local() -> ServerConfig {
    ServerConfig {
        bind: "127.0.0.1".to_string(),
        port: 0,
    }
}

async fn serve(steps: &TwoSteps) -> RunningServer {
    start(local(), router(steps)).await.expect("start")
}

fn router(steps: &TwoSteps) -> Router {
    let write = steps.clone();
    let read = steps.clone();
    Router::new()
        .route(
            "/work",
            post(move || write.clone().run()).get(move || read.clone().run()),
        )
        .route(
            "/panic",
            post(|| async {
                if true {
                    panic!("handler panicked (expected in this test)");
                }
                "unreachable"
            }),
        )
        .route("/plain", post(|| async { "plain" }))
        .route(
            "/peer",
            post(
                |axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>| async move {
                    format!("peer={}", peer.ip())
                },
            ),
        )
        .route("/read", get(|| async { "read" }))
}

async fn until(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..300 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for: {what}");
}

/// Sends a request without a body and leaves the connection open.
async fn send(addr: SocketAddr, method: &str, path: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let request =
        format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("write");
    stream
}

/// Reads one whole response (the request asked for `Connection: close`, or
/// the server closes because it is stopping).
async fn read_response(mut stream: TcpStream) -> String {
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes))
        .await
        .expect("response in time")
        .expect("read");
    String::from_utf8_lossy(&bytes).into_owned()
}

async fn request(addr: SocketAddr, method: &str, path: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.expect("write");
    read_response(stream).await
}

/// Sends `method /work`, waits until the handler is between its two steps,
/// then closes the connection and gives hyper time to notice.
async fn disconnect_mid_request(addr: SocketAddr, method: &str, steps: &TwoSteps) {
    let before = steps.created();
    let stream = send(addr, method, "/work").await;
    until("the handler to reach its first step", || {
        steps.created() == before + 1
    })
    .await;
    drop(stream);
    tokio::time::sleep(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn a_write_finishes_both_steps_after_its_client_disconnected() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;

    disconnect_mid_request(server.local_addr(), "POST", &steps).await;
    assert_eq!(steps.audited(), 0, "still held between the two steps");
    steps.release(1);
    until("the second step of the disconnected write", || {
        steps.audited() == 1
    })
    .await;

    assert!(matches!(server.stop().await, StopOutcome::Finished));
}

/// The premise of the layer, and its boundary: a READ is not detached, so
/// hyper drops its handler at the disconnect and the second step never runs.
/// If this ever fails, hyper no longer drops the handler and the layer's
/// reason should be re-read (ADR-0035).
#[tokio::test]
async fn a_read_is_still_dropped_at_the_disconnect() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;

    disconnect_mid_request(server.local_addr(), "GET", &steps).await;
    steps.release(1);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(steps.audited(), 0, "the dropped handler did not go on");

    assert!(matches!(server.stop().await, StopOutcome::Finished));
}

#[tokio::test]
async fn a_panicking_write_is_answered_500_and_the_server_keeps_serving() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;
    let addr = server.local_addr();

    let response = request(addr, "POST", "/panic").await;
    assert!(response.starts_with("HTTP/1.1 500"), "{response}");
    let body = response.split("\r\n\r\n").nth(1).unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(body).expect("JSON error body");
    assert_eq!(body["kind"], "other");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("状態を読み直してから"),
        "{body}"
    );

    // Not counted as running any more, and the server still answers.
    let response = request(addr, "GET", "/read").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(matches!(server.stop().await, StopOutcome::Finished));
}

#[tokio::test]
async fn stop_waits_for_a_running_write() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;

    // Only the detached task is left: its connection is gone.
    disconnect_mid_request(server.local_addr(), "POST", &steps).await;
    let stop = tokio::spawn(server.stop());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!stop.is_finished(), "stop() waits for the running write");
    assert_eq!(steps.audited(), 0);

    steps.release(1);
    let outcome = tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .expect("stop() returns once the write is done")
        .unwrap();
    assert!(matches!(outcome, StopOutcome::Finished));
    assert_eq!(steps.audited(), 1, "the write finished before stop() did");
}

#[tokio::test]
async fn stop_reports_the_writes_that_did_not_finish_in_time() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;

    disconnect_mid_request(server.local_addr(), "POST", &steps).await;
    let outcome = server
        .stop_waiting_writes_for(Duration::from_millis(200))
        .await;
    let StopOutcome::WritesRemaining(remaining) = outcome else {
        panic!("a write is still running: the stop must not report a clean finish");
    };
    assert_eq!(remaining.count(), 1);
    assert_eq!(remaining.operations(), vec!["POST /work".to_string()]);
    assert!(!remaining.is_finished());
    assert!(!remaining.wait(Duration::from_millis(50)).await);

    // It was not aborted: once it can go on, it finishes.
    steps.release(1);
    assert!(remaining.wait(Duration::from_secs(5)).await);
    assert!(remaining.is_finished());
    assert_eq!(steps.audited(), 1);
}

#[tokio::test]
async fn a_held_test_write_counts_like_a_request() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;
    let held = server.hold_write_for_test("POST /held").expect("open gate");
    let outcome = server
        .stop_waiting_writes_for(Duration::from_millis(100))
        .await;
    let remaining = outcome.remaining().expect("the held write remains");
    assert_eq!(remaining.operations(), vec!["POST /held".to_string()]);
    drop(held);
    assert!(remaining.is_finished());
}

/// Sends the headers of a write that declares `declared` bytes of body, then
/// `sent` of it, and leaves the connection open.
async fn send_partial(addr: SocketAddr, declared: usize, sent: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let request = format!(
        "POST /work HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
         Content-Length: {declared}\r\n\r\n{sent}"
    );
    stream.write_all(request.as_bytes()).await.expect("write");
    stream
}

/// PR #829 review (P2): clients that send the headers and part of the body
/// and then stall - more of them than there are places - hold no place and
/// start no handler, so a proper write still goes through.
#[tokio::test]
async fn writes_whose_body_never_arrives_do_not_keep_other_writes_out() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;
    let addr = server.local_addr();
    let budget = server.write_budget();

    let mut stalled = Vec::new();
    for _ in 0..MAX_DETACHED_WRITES + 8 {
        stalled.push(send_partial(addr, 10, "abc").await);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(steps.created(), 0, "no handler started");
    assert_eq!(budget.running(), 0, "no place is held");

    steps.release(1);
    let response = request(addr, "POST", "/work").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.ends_with("done"), "{response}");
    assert_eq!(steps.audited(), 1);

    // A stalled client that sends the rest is served like any other.
    let mut late = stalled.pop().expect("one");
    late.write_all(b"defghij").await.expect("write");
    steps.release(1);
    let response = read_response(late).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert_eq!(steps.audited(), 2);

    drop(stalled);
    assert!(matches!(server.stop().await, StopOutcome::Finished));
}

/// Bodies too large to receive up front are streamed, so they take their
/// place before they arrive - but only `MAX_STREAMED_WRITES` of them, and
/// ordinary writes keep the rest of the room.
#[tokio::test]
async fn stalled_large_bodies_only_keep_other_large_bodies_out() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;
    let addr = server.local_addr();
    let large = BUFFERED_BODY_MAX_BYTES + 1;

    let mut held = Vec::new();
    for _ in 0..MAX_STREAMED_WRITES {
        held.push(send_partial(addr, large, "").await);
    }
    until("the large writes to start", || {
        steps.created() == MAX_STREAMED_WRITES
    })
    .await;

    // The answer comes without the body; the connection stays open until
    // the client gives up, so read the start of the response only.
    let mut one_more = send_partial(addr, large, "").await;
    let mut start = [0u8; 12];
    tokio::time::timeout(Duration::from_secs(5), one_more.read_exact(&mut start))
        .await
        .expect("response in time")
        .expect("read");
    let refused = String::from_utf8_lossy(&start).into_owned();
    assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
    assert_eq!(
        steps.created(),
        MAX_STREAMED_WRITES,
        "the refused one never ran"
    );

    // An ordinary write goes through while all of them are still running.
    let response = request(addr, "POST", "/plain").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert_eq!(steps.audited(), 0);

    steps.release(MAX_STREAMED_WRITES);
    until("the large writes to finish", || {
        steps.audited() == MAX_STREAMED_WRITES
    })
    .await;
    drop(held);
    assert!(matches!(server.stop().await, StopOutcome::Finished));
}

/// PR #833 review (P2): clients that send almost a whole body and stall make
/// the layer hold those bytes before anything checked who they are. Their
/// sum stays within `RECEIVING_BODIES_MAX_BYTES` however many there are; the
/// ones beyond it are refused; and the bytes come back when they go away.
#[tokio::test]
async fn stalled_bodies_hold_a_bounded_number_of_bytes_together() {
    let steps = TwoSteps::default();
    let server = serve(&steps).await;
    let addr = server.local_addr();
    let budget = server.write_budget();
    let fit = RECEIVING_BODIES_MAX_BYTES / BUFFERED_BODY_MAX_BYTES;

    // Each sends all but the last byte of a body of the largest buffered
    // size, then keeps its connection open.
    let clients: Vec<_> = (0..fit + 8)
        .map(|_| {
            tokio::spawn(async move {
                let mut stream = send_partial(addr, BUFFERED_BODY_MAX_BYTES, "").await;
                // A refused client may see its connection closed mid-write.
                let _ = stream
                    .write_all(&vec![b'x'; BUFFERED_BODY_MAX_BYTES - 1])
                    .await;
                std::future::pending::<()>().await;
            })
        })
        .collect();
    until("the bodies to fill the room", || {
        budget.receiving_bytes() > RECEIVING_BODIES_MAX_BYTES - BUFFERED_BODY_MAX_BYTES
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(budget.receiving_bytes() <= RECEIVING_BODIES_MAX_BYTES);
    assert_eq!(steps.created(), 0, "no handler started");
    assert_eq!(budget.running(), 0, "no place is held");

    // A write without a body needs no room and goes through.
    let response = request(addr, "POST", "/plain").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    // The stalled clients go away: the bytes come back, and a write with a
    // body goes through again.
    for client in &clients {
        client.abort();
    }
    until("the bytes to come back", || budget.receiving_bytes() == 0).await;
    steps.release(1);
    let mut stream = send_partial(addr, 5, "hello").await;
    let mut start = [0u8; 12];
    tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut start))
        .await
        .expect("response in time")
        .expect("read");
    assert_eq!(&start, b"HTTP/1.1 200");
    assert!(matches!(server.stop().await, StopOutcome::Finished));
}

// --- Issue #947 (ADR-0035 §9): a listener of the app's own ---

/// A listener that is not `tokio::net::TcpListener`, standing in for an
/// app's own (a TLS listener that does its handshake in `accept`).
struct OwnListener {
    inner: tokio::net::TcpListener,
    accepted: Arc<AtomicUsize>,
}

impl axum::serve::Listener for OwnListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            if let Ok(accepted) = self.inner.accept().await {
                self.accepted.fetch_add(1, Ordering::SeqCst);
                return accepted;
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

/// Serves `steps`' router on a new [`OwnListener`], counted against `budget`.
async fn serve_own(steps: &TwoSteps, budget: WriteBudget) -> (RunningServer, Arc<AtomicUsize>) {
    let accepted = Arc::new(AtomicUsize::new(0));
    let listener = OwnListener {
        inner: tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind"),
        accepted: accepted.clone(),
    };
    let server = BoundServer::from_listener(listener)
        .expect("local address")
        .with_write_budget(budget)
        .serve(router(steps));
    (server, accepted)
}

/// The plain listener and one of the app's own, same router, one budget.
async fn serve_both(steps: &TwoSteps) -> (RunningServer, RunningServer, WriteBudget) {
    let plain = bind(local()).await.expect("bind").serve(router(steps));
    let budget = plain.write_budget();
    let (own, _) = serve_own(steps, budget.clone()).await;
    (plain, own, budget)
}

#[tokio::test]
async fn a_write_on_a_listener_of_the_apps_own_is_detached_too() {
    let steps = TwoSteps::default();
    let (server, accepted) = serve_own(&steps, WriteBudget::default()).await;

    disconnect_mid_request(server.local_addr(), "POST", &steps).await;
    assert_eq!(accepted.load(Ordering::SeqCst), 1, "served by OwnListener");
    assert_eq!(steps.audited(), 0);
    steps.release(1);
    until("the second step to run", || steps.audited() == 1).await;

    // The peer the listener reported is there for the handlers (the login
    // rate limit, the loopback checks), as on the plain listener.
    let response = request(server.local_addr(), "POST", "/peer").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.ends_with("peer=127.0.0.1"), "{response}");

    // A read is still dropped with its connection, here as well.
    disconnect_mid_request(server.local_addr(), "GET", &steps).await;
    steps.release(1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(steps.audited(), 1, "the GET did not go on");

    assert!(matches!(server.stop().await, StopOutcome::Finished));
}

#[tokio::test]
async fn stopping_both_listeners_waits_for_the_writes_of_both() {
    let steps = TwoSteps::default();
    let (plain, own, budget) = serve_both(&steps).await;

    disconnect_mid_request(plain.local_addr(), "POST", &steps).await;
    disconnect_mid_request(own.local_addr(), "POST", &steps).await;
    assert_eq!(budget.running(), 2, "one budget counts both listeners");

    // Together, not one after the other: both gates close before either
    // waits, and the two waits share the same 10 seconds.
    let stop = tokio::spawn(RunningServer::stop_all([plain, own]));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!stop.is_finished(), "both stops wait for their write");
    assert_eq!(steps.audited(), 0);

    steps.release(2);
    let outcomes = tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .expect("the stop returns once the writes are done")
        .unwrap();
    assert_eq!(outcomes.len(), 2);
    assert!(outcomes
        .iter()
        .all(|outcome| matches!(outcome, StopOutcome::Finished)));
    assert_eq!(steps.audited(), 2);
    assert_eq!(budget.running(), 0);
}

#[tokio::test]
async fn each_listener_reports_the_writes_it_left_running() {
    let steps = TwoSteps::default();
    let (plain, own, budget) = serve_both(&steps).await;

    disconnect_mid_request(own.local_addr(), "POST", &steps).await;
    let mut outcomes =
        RunningServer::stop_all_waiting_writes_for([plain, own], Duration::from_millis(200)).await;
    let own_outcome = outcomes.pop().expect("one outcome per listener");
    let plain_outcome = outcomes.pop().expect("in the order given");
    assert!(
        matches!(plain_outcome, StopOutcome::Finished),
        "the plain listener accepted no write"
    );
    let remaining = own_outcome
        .remaining()
        .expect("the write came in on the app's own listener");
    assert_eq!(remaining.operations(), vec!["POST /work".to_string()]);
    assert_eq!(budget.running(), 1, "it still takes up room in the budget");

    steps.release(1);
    assert!(remaining.wait(Duration::from_secs(5)).await);
    assert_eq!(steps.audited(), 1);
    assert_eq!(budget.running(), 0);
}

#[tokio::test]
async fn replacing_one_listener_leaves_the_writes_of_the_other_detached() {
    let steps = TwoSteps::default();
    let (plain, own, budget) = serve_both(&steps).await;

    // One write running on each, both without a connection by now.
    disconnect_mid_request(plain.local_addr(), "POST", &steps).await;
    disconnect_mid_request(own.local_addr(), "POST", &steps).await;

    // Only the app's own listener is stopped (a renewed certificate). Its
    // write is not aborted and is reported.
    let own_addr = own.local_addr();
    let left = own
        .stop_waiting_writes_for(Duration::from_millis(200))
        .await
        .remaining()
        .expect("the old generation's write is still running");
    assert_eq!(left.count(), 1);
    assert!(
        TcpStream::connect(own_addr).await.is_err(),
        "the stopped listener is closed"
    );

    // Meanwhile the plain listener is untouched: its gate is open, and a
    // write whose client goes away now is detached as before.
    let response = request(plain.local_addr(), "POST", "/plain").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    disconnect_mid_request(plain.local_addr(), "POST", &steps).await;
    assert_eq!(steps.created(), 3);
    assert_eq!(budget.running(), 3, "old generation included");

    // The next generation, on the same budget.
    let (renewed, _) = serve_own(&steps, budget.clone()).await;
    disconnect_mid_request(renewed.local_addr(), "POST", &steps).await;
    assert_eq!(budget.running(), 4);
    assert_eq!(steps.audited(), 0);

    steps.release(4);
    until("all four writes to finish", || steps.audited() == 4).await;
    assert!(left.wait(Duration::from_secs(5)).await);
    let (plain_outcome, renewed_outcome) = tokio::join!(plain.stop(), renewed.stop());
    assert!(matches!(plain_outcome, StopOutcome::Finished));
    assert!(matches!(renewed_outcome, StopOutcome::Finished));
    assert_eq!(budget.running(), 0);
}

#[tokio::test]
async fn listeners_that_share_a_budget_share_the_room_for_new_writes() {
    let steps = TwoSteps::default();
    let (plain, own, budget) = serve_both(&steps).await;

    // The app's own listener uses up the whole budget.
    let held: Vec<_> = (0..MAX_DETACHED_WRITES)
        .map(|n| own.hold_write_for_test(&format!("POST /held/{n}")).unwrap())
        .collect();
    assert_eq!(budget.running(), MAX_DETACHED_WRITES);
    let response = request(plain.local_addr(), "POST", "/plain").await;
    assert!(response.starts_with("HTTP/1.1 503"), "{response}");

    drop(held);
    let response = request(plain.local_addr(), "POST", "/plain").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    let (plain_outcome, own_outcome) = tokio::join!(plain.stop(), own.stop());
    assert!(matches!(plain_outcome, StopOutcome::Finished));
    assert!(matches!(own_outcome, StopOutcome::Finished));
}

// --- A stop requested from outside (a revoked certificate), `StopHandle` ---

/// Asks for the stop the way a watcher thread does: from a plain thread,
/// through a clone, without the `RunningServer`.
fn request_stop_from_a_thread(server: &RunningServer) {
    let handle = server.stop_handle();
    std::thread::spawn(move || handle.request_stop())
        .join()
        .expect("request_stop does not panic outside the runtime");
}

#[tokio::test]
async fn after_a_requested_stop_no_connection_and_no_write_is_accepted() {
    let steps = TwoSteps::default();
    let (plain, own, _budget) = serve_both(&steps).await;
    let own_addr = own.local_addr();
    assert!(!own.stop_handle().is_stop_requested());

    request_stop_from_a_thread(&own);

    // The gate is closed by the time `request_stop` returned: the listener
    // starts no write, whatever connection it would arrive on.
    assert!(own.stop_handle().is_stop_requested());
    assert!(
        own.hold_write_for_test("POST /late").is_none(),
        "no write starts after the requested stop"
    );
    // And it stops accepting: the port closes without anyone awaiting the
    // server.
    let mut closed = false;
    for _ in 0..300 {
        if TcpStream::connect(own_addr).await.is_err() {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(closed, "the listener is closed after the requested stop");
    assert_eq!(steps.created(), 0, "nothing reached a handler");

    // The other listener is not touched.
    let response = request(plain.local_addr(), "POST", "/plain").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    // Asking again changes nothing, and the owner's stop finishes it.
    request_stop_from_a_thread(&own);
    assert!(matches!(own.stop().await, StopOutcome::Finished));
    assert!(matches!(plain.stop().await, StopOutcome::Finished));
}

#[tokio::test]
async fn a_write_detached_before_a_requested_stop_runs_to_the_end() {
    let steps = TwoSteps::default();
    let (server, _) = serve_own(&steps, WriteBudget::default()).await;

    // Between its two steps, its connection already gone.
    disconnect_mid_request(server.local_addr(), "POST", &steps).await;
    request_stop_from_a_thread(&server);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(steps.audited(), 0, "still running, not aborted");

    // The owner waits afterwards, and is told when it does not finish.
    let remaining = server
        .stop_waiting_writes_for(Duration::from_millis(200))
        .await
        .remaining()
        .expect("the write accepted before the request is still running");
    assert_eq!(remaining.operations(), vec!["POST /work".to_string()]);

    steps.release(1);
    assert!(remaining.wait(Duration::from_secs(5)).await);
    assert_eq!(steps.audited(), 1, "it ran to the end");
}

#[tokio::test]
async fn writes_left_by_an_earlier_generation_are_not_in_stop_all() {
    let steps = TwoSteps::default();
    let (plain, own, budget) = serve_both(&steps).await;

    // The app's own listener is replaced while one of its writes runs.
    disconnect_mid_request(own.local_addr(), "POST", &steps).await;
    let left = own
        .stop_waiting_writes_for(Duration::from_millis(100))
        .await
        .remaining()
        .expect("left running by the replaced generation");
    let (renewed, _) = serve_own(&steps, budget.clone()).await;

    // The final stop of the listeners that are running now is clean...
    let outcomes = RunningServer::stop_all([plain, renewed]).await;
    assert!(outcomes
        .iter()
        .all(|outcome| matches!(outcome, StopOutcome::Finished)));
    // ...but the app still has a write running: the handle it kept, and the
    // shared budget, say so.
    assert!(!left.is_finished());
    assert_eq!(budget.running(), 1);
    assert!(!left.wait(Duration::from_millis(100)).await);

    steps.release(1);
    assert!(left.wait(Duration::from_secs(5)).await);
    assert_eq!(budget.running(), 0);
}

// --- Issue #981 (ADR-0035 §9): the ledger over the generations ---

/// Serves `steps`' router on a new [`OwnListener`], entered in `ledger`.
async fn serve_in(ledger: &WriteLedger, steps: &TwoSteps) -> RunningServer {
    let listener = OwnListener {
        inner: tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind"),
        accepted: Arc::default(),
    };
    BoundServer::from_listener(listener)
        .expect("local address")
        .with_write_ledger(ledger)
        .serve(router(steps))
}

/// A deadline no test here is meant to reach.
fn far_deadline() -> tokio::time::Instant {
    tokio::time::Instant::now() + Duration::from_secs(30)
}

/// `POST /plain` to a listener that may be closed already: the status line,
/// or `None` when no response came (refused, reset, closed).
async fn try_post(addr: SocketAddr) -> Option<String> {
    let mut stream = TcpStream::connect(addr).await.ok()?;
    let request =
        "POST /plain HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut bytes = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes)).await;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    match read {
        Ok(_) if !text.is_empty() => text.lines().next().map(str::to_string),
        _ => None,
    }
}

#[tokio::test]
async fn a_listener_entered_after_close_all_comes_up_stopped() {
    let steps = TwoSteps::default();
    let ledger = WriteLedger::new();
    assert!(!ledger.is_closed());
    ledger.close_all();
    ledger.close_all();
    assert!(ledger.is_closed());

    // A generation that was being rebuilt while the app's stop began.
    let late = serve_in(&ledger, &steps).await;
    assert!(!late.is_serving(), "it is not serving");
    assert!(late.stop_handle().is_stop_requested());
    assert!(
        late.hold_write_for_test("POST /late").is_none(),
        "it starts no write"
    );
    // A write sent to it is refused (503) for as long as a connection is
    // still taken at all; then the port is closed.
    let addr = late.local_addr();
    let mut closed = false;
    for _ in 0..300 {
        match try_post(addr).await {
            Some(status) => assert!(status.starts_with("HTTP/1.1 503"), "{status}"),
            None => {
                if TcpStream::connect(addr).await.is_err() {
                    closed = true;
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(closed, "the listener is closed");
    assert_eq!(ledger.budget().running(), 0, "nothing was started");

    assert!(matches!(late.stop().await, StopOutcome::Finished));
}

#[tokio::test]
async fn close_all_closes_the_gate_of_every_listener_in_the_ledger() {
    let steps = TwoSteps::default();
    let ledger = WriteLedger::new();
    let first = serve_in(&ledger, &steps).await;
    let second = serve_in(&ledger, &steps).await;
    assert!(first.is_serving() && second.is_serving());

    ledger.close_all();

    for server in [&first, &second] {
        assert!(!server.is_serving());
        assert!(server.hold_write_for_test("POST /late").is_none());
    }
    let outcome = ledger.stop_all_until([first, second], far_deadline()).await;
    assert_eq!(outcome.servers.len(), 2);
    assert_eq!(outcome.running, 0);
    assert!(outcome.remaining.is_empty());
}

#[tokio::test]
async fn the_final_stop_waits_for_a_write_an_earlier_generation_left() {
    let steps = TwoSteps::default();
    let ledger = WriteLedger::new();

    // A generation is replaced while one of its writes runs. The app does
    // not keep what its stop returned.
    let old = serve_in(&ledger, &steps).await;
    let write = old.hold_write_for_test("POST /old").expect("accepted");
    assert!(matches!(
        old.stop_within(Duration::ZERO, Duration::ZERO).await,
        StopOutcome::WritesRemaining(_)
    ));
    let current = serve_in(&ledger, &steps).await;

    let stopping = {
        let ledger = ledger.clone();
        tokio::spawn(async move { ledger.stop_all_until([current], far_deadline()).await })
    };
    until("the final stop to begin", || ledger.is_closed()).await;
    // The listener given stops cleanly; the stop goes on waiting for the
    // write of the generation before it.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!stopping.is_finished(), "it waits for the earlier write");

    drop(write);
    let outcome = stopping.await.expect("join");
    assert!(matches!(outcome.servers[..], [StopOutcome::Finished]));
    assert_eq!(outcome.running, 0);
    assert!(outcome.remaining.is_empty());
}

#[tokio::test]
async fn the_final_stop_names_the_earlier_write_that_outlives_the_deadline() {
    let steps = TwoSteps::default();
    let ledger = WriteLedger::new();
    let old = serve_in(&ledger, &steps).await;
    let write = old.hold_write_for_test("POST /old").expect("accepted");
    // Stopped with the plain `stop` family; what it returns is dropped, the
    // ledger has it all the same.
    drop(old.stop_waiting_writes_for(Duration::ZERO).await);
    let current = serve_in(&ledger, &steps).await;

    let deadline = tokio::time::Instant::now() + Duration::from_millis(100);
    let outcome = ledger.stop_all_until([current], deadline).await;

    assert!(tokio::time::Instant::now() >= deadline, "waited until then");
    assert!(matches!(outcome.servers[..], [StopOutcome::Finished]));
    assert_eq!(outcome.running, 1);
    assert_eq!(outcome.remaining, vec!["POST /old".to_string()]);

    // Asked again once it is done, the ledger has nothing left.
    drop(write);
    let outcome = ledger.stop_all_until([], tokio::time::Instant::now()).await;
    assert_eq!(outcome.running, 0);
    assert!(outcome.remaining.is_empty());
}

#[tokio::test]
async fn the_final_stop_waits_for_writes_left_while_it_was_running() {
    let steps = TwoSteps::default();
    let ledger = WriteLedger::new();
    let revoked = serve_in(&ledger, &steps).await;
    let revoked_write = revoked.hold_write_for_test("POST /revoked").expect("ok");
    let current = serve_in(&ledger, &steps).await;
    let current_write = current.hold_write_for_test("POST /current").expect("ok");

    let stopping = {
        let ledger = ledger.clone();
        tokio::spawn(async move { ledger.stop_all_until([current], far_deadline()).await })
    };
    until("the final stop to begin", || ledger.is_closed()).await;

    // Only now - the final stop is under way, held by the write of the
    // listener it was given - the other generation's owner stops it, without
    // waiting for its write at all (a revoked certificate).
    assert!(matches!(
        revoked.stop_within(Duration::ZERO, Duration::ZERO).await,
        StopOutcome::WritesRemaining(_)
    ));
    drop(current_write);
    // The listener given is done now. What was left meanwhile still holds
    // the final stop.
    until("the write of the listener given to finish", || {
        ledger.budget().running() == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !stopping.is_finished(),
        "it waits for the write that was left during the stop"
    );

    drop(revoked_write);
    let outcome = stopping.await.expect("join");
    assert_eq!(outcome.running, 0);
    assert!(outcome.remaining.is_empty());
}

#[tokio::test]
async fn a_deadline_that_has_passed_is_not_waited_for() {
    let steps = TwoSteps::default();
    let ledger = WriteLedger::new();
    let server = serve_in(&ledger, &steps).await;
    // A request whose handler does not return: its connection would hold a
    // plain stop for 5 seconds, its write for 10.
    let _stream = send(server.local_addr(), "POST", "/work").await;
    until("the handler to reach its first step", || {
        steps.created() == 1
    })
    .await;

    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        ledger.stop_all_until([server], tokio::time::Instant::now()),
    )
    .await
    .expect("returns without waiting");

    assert!(matches!(
        outcome.servers[..],
        [StopOutcome::WritesRemaining(_)]
    ));
    assert_eq!(outcome.running, 1);
    assert_eq!(outcome.remaining, vec!["POST /work".to_string()]);

    steps.release(1);
    until("the write to finish", || ledger.budget().running() == 0).await;
}

#[tokio::test]
async fn a_listener_dropped_without_a_stop_keeps_its_write_in_the_ledger() {
    let steps = TwoSteps::default();
    let ledger = WriteLedger::new();
    let server = serve_in(&ledger, &steps).await;
    let write = server.hold_write_for_test("POST /dropped").expect("ok");
    drop(server);

    let outcome = ledger.stop_all_until([], tokio::time::Instant::now()).await;
    assert_eq!(outcome.running, 1);
    assert_eq!(outcome.remaining, vec!["POST /dropped".to_string()]);

    drop(write);
    let outcome = ledger.stop_all_until([], far_deadline()).await;
    assert_eq!(outcome.running, 0);
    assert!(outcome.remaining.is_empty());
}
