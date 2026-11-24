//! Issue #935 (design `docs/design/sse-stream-design.md` §6): an app's own
//! SSE stream on the foundation (`SseContext` + `sse_response`), from OUTSIDE
//! the crate and over a real socket - the way a derived app uses it.
//!
//! Nothing here can shorten the re-check interval (an app cannot either,
//! by design), so the tests that wait for a re-check wait the real
//! `REVALIDATE_INTERVAL` (15 s). They run side by side; the file takes about
//! 20 s. The fine-grained cases (manual schedule) are the unit tests in
//! `src/sse/tests.rs`.

use axum::response::Response;
use axum::routing::get;
use axum::{middleware, Extension, Router};
use banto_admin_services::permissions::PermissionKey;
use banto_core::BantoError;
use banto_server::events::{REVALIDATE_INTERVAL, REVALIDATE_TIMEOUT};
use banto_server::{
    broadcast_frames, require_auth, sse_response, sse_route, start, watch_frames, AuthState,
    Identity, RunningServer, ServerConfig, ServerEvent, SessionAccount, SessionPermissions,
    SessionStamp, SessionValidation, SseContext, SseFrame,
};
use futures_util::StreamExt;
use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, watch};

/// How long a stream may take to be closed by a re-check: the bound of the
/// design (interval + timeout) plus slack for a busy machine.
const CLOSED_BY_RECHECK: Duration =
    Duration::from_secs(REVALIDATE_INTERVAL.as_secs() + REVALIDATE_TIMEOUT.as_secs() + 10);

/// `RunningServer::stop`'s own safety net is 5 s (`STOP_TIMEOUT`); a stop
/// that had to fall back on it took at least that long.
const WELL_UNDER_STOP_TIMEOUT: Duration = Duration::from_secs(3);

fn plant_view() -> PermissionKey {
    PermissionKey::parse("plant.view").expect("a well-formed key")
}

// ---- the account store ----

/// Accounts with per-user permissions. Password `"pw"`. Every read (account
/// lookup, permission read) can be made to fail, or to never answer - and
/// then says so on `waiting`.
#[derive(Clone, Default)]
struct Store {
    accounts: Arc<Mutex<HashMap<String, SessionAccount>>>,
    held: Arc<Mutex<BTreeSet<PermissionKey>>>,
    failing: Arc<AtomicBool>,
    hanging: Arc<AtomicBool>,
    waiting: Arc<Mutex<Option<mpsc::UnboundedSender<()>>>>,
}

impl Store {
    /// `alice`, an admin holding `plant.view`.
    fn with_alice() -> Self {
        let store = Self::default();
        store.accounts.lock().unwrap().insert(
            "alice".to_string(),
            SessionAccount {
                identity: Identity {
                    id: "alice".to_string(),
                    name: "Alice".to_string(),
                    role: "admin".to_string(),
                    account_id: None,
                },
                stamp: SessionStamp {
                    account_id: 1,
                    auth_epoch: 0,
                },
            },
        );
        store.held.lock().unwrap().insert(plant_view());
        store
    }

    async fn answer<T>(&self, value: impl FnOnce() -> T) -> Result<T, BantoError> {
        if self.hanging.load(Ordering::SeqCst) {
            if let Some(waiting) = self.waiting.lock().unwrap().as_ref() {
                let _ = waiting.send(());
            }
            std::future::pending::<()>().await;
        }
        if self.failing.load(Ordering::SeqCst) {
            return Err(BantoError::Other("store unavailable".to_string()));
        }
        Ok(value())
    }

    fn auth(&self) -> AuthState {
        let (verify, lookup, reader) = (self.clone(), self.clone(), self.clone());
        AuthState::new(
            move |u: String, p: String| {
                let store = verify.clone();
                Box::pin(async move {
                    let accounts = store.accounts.lock().unwrap();
                    (p == "pw")
                        .then(|| accounts.get(&u).map(|a| a.identity.clone()))
                        .flatten()
                })
            },
            SessionValidation::lookup(move |u: String| {
                let store = lookup.clone();
                Box::pin(async move {
                    store
                        .answer(|| store.accounts.lock().unwrap().get(&u).cloned())
                        .await
                })
            }),
        )
        .with_permission_reader(move |_account_id: i64| {
            let store = reader.clone();
            Box::pin(async move {
                store
                    .answer(|| SessionPermissions::new(store.held.lock().unwrap().clone()))
                    .await
            })
        })
    }
}

// ---- the app ----

/// One value of the plant: what a producer task would `send_replace` every
/// cycle. `made_at` is the stamp that tells a new value from a re-sent one.
#[derive(Clone, serde::Serialize)]
struct Reading {
    made_at: u64,
    value: f64,
}

/// The app's state, as its handlers get it.
#[derive(Clone)]
struct Plant {
    values: watch::Sender<Reading>,
    alarms: broadcast::Sender<String>,
}

impl Plant {
    fn new() -> Self {
        Self {
            values: watch::channel(Reading {
                made_at: 1,
                value: 20.5,
            })
            .0,
            alarms: broadcast::channel(16).0,
        }
    }

    /// One stream per screen, the kinds told apart by name (design §4.7).
    fn frames(&self) -> impl futures_util::Stream<Item = SseFrame> + Send + 'static {
        let values = watch_frames(self.values.subscribe(), |reading| {
            SseFrame::json(reading).ok()?.event("values").ok()
        });
        let alarms = broadcast_frames(self.alarms.subscribe(), |alarm| {
            SseFrame::text(alarm.clone()).event("alarm").ok()
        });
        futures_util::stream::select(values.boxed(), alarms.boxed())
    }
}

/// Needs `plant.view`, also after it opened.
async fn plant_stream(context: SseContext, Extension(plant): Extension<Plant>) -> Response {
    sse_response(context.require_permission(plant_view()), plant.frames())
}

/// No condition; the one stream of a screen that does not open
/// `/api/events`, so it is counted as a client.
async fn board_stream(context: SseContext, Extension(plant): Extension<Plant>) -> Response {
    sse_response(context.counted_as_client(), plant.frames())
}

/// No condition, not counted.
async fn open_stream(context: SseContext, Extension(plant): Extension<Plant>) -> Response {
    sse_response(context, plant.frames())
}

const PLANT: &str = "/api/plant/stream";
const BOARD: &str = "/api/board/stream";
const OPEN: &str = "/api/open/stream";
const EVENTS: &str = "/api/events";

struct App {
    store: Store,
    auth: AuthState,
    token: String,
    plant: Plant,
    events: broadcast::Sender<ServerEvent>,
    server: RunningServer,
}

impl App {
    async fn start() -> Self {
        let store = Store::with_alice();
        let auth = store.auth();
        let token = auth.login("alice", "pw").await.expect("alice logs in");
        let plant = Plant::new();
        let (events, _) = broadcast::channel(16);
        let streams = Router::new()
            .route(PLANT, get(plant_stream))
            .route(BOARD, get(board_stream))
            .route(OPEN, get(open_stream))
            .layer(Extension(plant.clone()))
            .layer(middleware::from_fn_with_state(auth.clone(), require_auth));
        let router = streams.merge(sse_route(auth.clone(), events.clone()));
        let server = start(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0,
            },
            router,
        )
        .await
        .expect("the server starts");
        Self {
            store,
            auth,
            token,
            plant,
            events,
            server,
        }
    }

    fn addr(&self) -> SocketAddr {
        self.server.local_addr()
    }

    async fn open(&self, path: &str) -> Client {
        let client = Client::get(self.addr(), path, &self.token).await;
        assert_eq!(client.status, 200, "{path}");
        client
    }

    async fn status_of(&self, path: &str) -> u16 {
        Client::get(self.addr(), path, &self.token).await.status
    }
}

// ---- a client ----

/// One `GET` over its own connection (`Connection: close`, so the end of
/// the stream is the end of the socket).
struct Client {
    socket: TcpStream,
    status: u16,
    /// Everything received after the response head, not yet consumed.
    received: String,
}

impl Client {
    async fn get(addr: SocketAddr, path: &str, token: &str) -> Self {
        let mut socket = TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
             Authorization: Bearer {token}\r\n\r\n"
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut client = Self {
            socket,
            status: 0,
            received: String::new(),
        };
        let head = client
            .take_until("\r\n\r\n")
            .await
            .expect("a response head");
        client.status = head
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("no status in {head:?}"));
        client
    }

    /// Reads more; `false` at the end of the socket.
    async fn read_more(&mut self, limit: Duration) -> bool {
        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(limit, self.socket.read(&mut buf))
            .await
            .unwrap_or_else(|_| panic!("nothing within {limit:?}; so far: {:?}", self.received))
            .unwrap_or(0);
        self.received.push_str(&String::from_utf8_lossy(&buf[..n]));
        n > 0
    }

    /// Everything up to and including `needle` (consumed); `None` if the
    /// socket ended first.
    async fn take_until(&mut self, needle: &str) -> Option<String> {
        loop {
            if let Some(at) = self.received.find(needle) {
                let rest = self.received.split_off(at + needle.len());
                return Some(std::mem::replace(&mut self.received, rest));
            }
            if !self.read_more(Duration::from_secs(5)).await {
                return None;
            }
        }
    }

    /// The `data:` of the next event named `name`.
    async fn next_named(&mut self, name: &str) -> String {
        let marker = format!("event: {name}\ndata: ");
        self.take_until(&marker)
            .await
            .unwrap_or_else(|| panic!("the stream ended before a {name:?} event"));
        let line = self.take_until("\n").await.expect("the data line");
        line.trim_end().to_string()
    }

    /// Waits for the server to end the stream; how long that took.
    async fn closed_within(&mut self, limit: Duration) -> Duration {
        let started = Instant::now();
        loop {
            let left = limit
                .checked_sub(started.elapsed())
                .unwrap_or_else(|| panic!("the stream was not closed within {limit:?}"));
            if !self.read_more(left).await {
                return started.elapsed();
            }
        }
    }

    /// `true` while the server has not ended the stream: an event sent now
    /// still arrives.
    async fn still_gets(&mut self, needle: &str) -> bool {
        self.take_until(needle).await.is_some()
    }
}

async fn wait_for_count(server: &RunningServer, want: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while server.sse_connections() != want {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "expected {want} counted streams, got {}",
            server.sse_connections()
        )
    });
}

fn notice(message: &str) -> ServerEvent {
    ServerEvent::Notice {
        level: "info".to_string(),
        message: message.to_string(),
    }
}

// ---- ①: stop ----

#[tokio::test]
async fn stop_does_not_wait_for_open_app_streams() {
    let app = App::start().await;
    let mut clients = Vec::new();
    for path in [PLANT, BOARD, OPEN, EVENTS] {
        clients.push(app.open(path).await);
    }

    let started = Instant::now();
    app.server.stop().await;
    assert!(
        started.elapsed() < WELL_UNDER_STOP_TIMEOUT,
        "stop() took {:?}: it waited for a stream",
        started.elapsed()
    );
    // The streams were ended by the server, not left dangling.
    for mut client in clients {
        client.closed_within(Duration::from_secs(3)).await;
    }
}

#[tokio::test]
async fn stop_does_not_wait_for_a_recheck_that_is_waiting_for_the_store() {
    let app = App::start().await;
    let (waiting_tx, mut waiting) = mpsc::unbounded_channel();
    *app.store.waiting.lock().unwrap() = Some(waiting_tx);
    let _plant = app.open(PLANT).await;
    let _events = app.open(EVENTS).await;

    // From now on the store never answers. The streams' first re-checks
    // (one interval after they opened) walk into it and wait.
    app.store.hanging.store(true, Ordering::SeqCst);
    for _ in 0..2 {
        tokio::time::timeout(
            REVALIDATE_INTERVAL + Duration::from_secs(10),
            waiting.recv(),
        )
        .await
        .expect("both streams' re-checks reach the store")
        .expect("the store is alive");
    }

    // Both checks are in flight (each would take REVALIDATE_TIMEOUT = 5 s
    // to give up). `stop()` must not wait for them.
    let started = Instant::now();
    app.server.stop().await;
    assert!(
        started.elapsed() < WELL_UNDER_STOP_TIMEOUT,
        "stop() took {:?}: it waited for a re-check",
        started.elapsed()
    );
}

// ---- ②: revocation ----

#[tokio::test]
async fn a_revoked_token_loses_its_app_stream_at_the_next_recheck() {
    let app = App::start().await;
    let mut open = app.open(OPEN).await;
    open.next_named("values").await;

    app.auth.logout(&app.token);
    let took = open.closed_within(CLOSED_BY_RECHECK).await;
    assert!(
        took > Duration::from_secs(1),
        "closed by the re-check, not at once: {took:?}"
    );
    assert_eq!(app.status_of(OPEN).await, 401, "the reconnect");
    app.server.stop().await;
}

// ---- ③: several kinds in one stream ----

#[tokio::test]
async fn one_stream_carries_several_named_events() {
    let app = App::start().await;
    let mut board = app.open(BOARD).await;
    assert_eq!(
        board.next_named("values").await,
        r#"{"made_at":1,"value":20.5}"#,
        "the current value, right after the open"
    );

    app.plant.alarms.send("overheat".to_string()).unwrap();
    assert_eq!(board.next_named("alarm").await, "overheat");

    app.plant.values.send_replace(Reading {
        made_at: 2,
        value: 21.0,
    });
    assert_eq!(
        board.next_named("values").await,
        r#"{"made_at":2,"value":21.0}"#
    );
    app.plant.alarms.send("cleared".to_string()).unwrap();
    assert_eq!(board.next_named("alarm").await, "cleared");
    app.server.stop().await;
}

// ---- ④: the stream count ----

#[tokio::test]
async fn app_streams_are_counted_only_when_they_ask() {
    let app = App::start().await;
    assert_eq!(app.server.sse_connections(), 0);

    let events = app.open(EVENTS).await;
    wait_for_count(&app.server, 1).await;

    // A screen with `/api/events` AND an app stream is still one client.
    let plant = app.open(PLANT).await;
    let open = app.open(OPEN).await;
    wait_for_count(&app.server, 1).await;

    // A screen that only opens an app stream counts that one.
    let board = app.open(BOARD).await;
    wait_for_count(&app.server, 2).await;

    drop(plant);
    drop(open);
    drop(events);
    wait_for_count(&app.server, 1).await;
    drop(board);
    wait_for_count(&app.server, 0).await;
    app.server.stop().await;
}

// ---- ⑤: authorization after the open ----

#[tokio::test]
async fn taking_the_permission_away_closes_the_guarded_stream_and_nothing_else() {
    let app = App::start().await;
    let mut plant = app.open(PLANT).await;
    let mut events = app.open(EVENTS).await;
    plant.next_named("values").await;

    // Only the permission goes; the session stays (a role or password
    // change would have ended it - that is ②, not this).
    app.store.held.lock().unwrap().clear();
    assert!(
        app.auth.authenticate(&app.token).await.unwrap().is_some(),
        "the session is still valid"
    );

    let took = plant.closed_within(CLOSED_BY_RECHECK).await;
    assert!(
        took > Duration::from_secs(1),
        "closed by the re-check, not at once: {took:?}"
    );
    assert_eq!(app.status_of(PLANT).await, 403, "the reconnect is refused");

    // `/api/events` was opened at the same time, so its re-check ran too:
    // it has no condition and is still open.
    app.events.send(notice("still here")).unwrap();
    assert!(events.still_gets("still here").await);
    // So is the session's stream without a condition.
    assert_eq!(app.status_of(OPEN).await, 200);
    app.server.stop().await;
}

#[tokio::test]
async fn a_store_that_cannot_answer_closes_the_guarded_stream_and_keeps_api_events() {
    let app = App::start().await;
    let mut plant = app.open(PLANT).await;
    let mut events = app.open(EVENTS).await;
    plant.next_named("values").await;

    // The permission is still held - it just cannot be confirmed.
    app.store.failing.store(true, Ordering::SeqCst);
    plant.closed_within(CLOSED_BY_RECHECK).await;
    assert_eq!(
        app.status_of(PLANT).await,
        500,
        "the reconnect: require_auth cannot check either (fail closed)"
    );

    // The same failure does not close `/api/events` (#230) ...
    app.events.send(notice("still here")).unwrap();
    assert!(events.still_gets("still here").await);

    // ... and once the store is back, the guarded stream opens again.
    app.store.failing.store(false, Ordering::SeqCst);
    let mut again = app.open(PLANT).await;
    again.next_named("values").await;
    app.server.stop().await;
}

// ---- ⑥: a reconnect while the producer stopped ----

#[tokio::test]
async fn a_reconnect_while_the_producer_stopped_gets_the_old_stamp_again() {
    // `watch_frames` sends the value made last to every stream that opens.
    // The foundation does not hide that (design §4.5): the value's own
    // stamp is what tells the reader that nothing new was made.
    let app = App::start().await;
    app.plant.values.send_replace(Reading {
        made_at: 41,
        value: 3.0,
    });
    let mut first = app.open(OPEN).await;
    let seen = first.next_named("values").await;
    assert_eq!(seen, r#"{"made_at":41,"value":3.0}"#);
    drop(first);

    // The producer makes nothing; the client reconnects, twice.
    for _ in 0..2 {
        let mut again = app.open(OPEN).await;
        assert_eq!(
            again.next_named("values").await,
            seen,
            "the same stamp: not a new value"
        );
    }

    // The producer runs again: the stamp moves.
    app.plant.values.send_replace(Reading {
        made_at: 42,
        value: 3.0,
    });
    let mut after = app.open(OPEN).await;
    assert_eq!(
        after.next_named("values").await,
        r#"{"made_at":42,"value":3.0}"#
    );
    app.server.stop().await;
}
