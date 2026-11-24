//! Unit tests of the SSE foundation (Issue #935, design §6): the frame, the
//! two conversions, the extractor, and the loop driven through an APP stream
//! (a `watch` of values with a named event) on a manual schedule. The
//! `/api/events` side of the same loop is `events.rs`'s tests, which this
//! module does not repeat - except where the two must differ (a stream with
//! an authorization condition next to one without).

use super::*;
use crate::auth::{require_auth, Identity, SessionAccount, SessionStamp, SessionValidation};
use crate::events::{sse_route_with, ServerEvent};
use crate::grant::{GrantCondition, GrantKind, GrantSpec};
use crate::server::{start, ServerConfig};
use axum::body::Body;
use axum::http::{Request as HttpRequest, StatusCode};
use axum::routing::get;
use axum::{middleware, Extension, Router};
use http_body_util::BodyExt;
use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use tokio::sync::mpsc;
use tower::ServiceExt;

// ---- SseFrame ----

#[test]
fn an_event_name_must_be_non_empty_and_on_one_line() {
    for bad in ["", "two\nlines", "carriage\rreturn", "\r\n"] {
        let rejected = SseFrame::text("x").event(bad).expect_err(bad);
        assert_eq!(rejected.name, bad);
        assert!(rejected.to_string().contains("invalid SSE event name"));
    }
    assert_eq!(
        SseFrame::text("x").event("").unwrap_err().reason,
        "empty",
        "the reason says which rule"
    );
    // Anything else is the app's business (spaces, non-ASCII, ...).
    for good in ["values", "plant values", "警報", "a:b"] {
        SseFrame::text("x").event(good).expect(good);
    }
}

#[test]
fn json_fails_like_serde_json_and_never_panics() {
    // A map with a non-string key is not JSON.
    let unserializable: HashMap<(u8, u8), u8> = [((1, 2), 3)].into_iter().collect();
    assert!(SseFrame::json(&unserializable).is_err());
    assert!(SseFrame::json("unsized str").is_ok());
}

/// The whole body of a stream of `frames` that ends by itself.
async fn wire(frames: Vec<SseFrame>) -> String {
    let stream = guarded_stream(
        Guard {
            auth: Store::default().auth(),
            token: "unused".to_string(),
            conditions: Vec::new(),
            schedule: Schedule::every(REVALIDATE_INTERVAL),
            timeout: REVALIDATE_TIMEOUT,
            shutdown: None,
            counted: None,
        },
        futures_util::stream::iter(frames),
    );
    let body = Sse::new(stream).into_response().into_body();
    String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap()
}

#[tokio::test]
async fn frames_are_written_as_event_and_data_lines() {
    let frames = vec![
        // `/api/events`' shape: no name, one line of JSON.
        SseFrame::json(&serde_json::json!({ "kind": "notice" })).unwrap(),
        SseFrame::json(&7).unwrap().event("values").unwrap(),
        // Every way of writing a line break is one break on the wire.
        SseFrame::text("one\ntwo\r\nthree\rfour")
            .event("first")
            .unwrap()
            // The last name wins.
            .event("note")
            .unwrap(),
    ];
    assert_eq!(
        wire(frames).await,
        "data: {\"kind\":\"notice\"}\n\n\
         event: values\ndata: 7\n\n\
         event: note\ndata: one\ndata: two\ndata: three\ndata: four\n\n"
    );
}

// ---- watch_frames / broadcast_frames ----

/// The next item, which must already be on its way (the timeout only turns
/// a hang into a failure).
async fn next_item<S: Stream<Item = SseFrame> + Unpin>(frames: &mut S) -> Option<SseFrame> {
    tokio::time::timeout(Duration::from_secs(5), frames.next())
        .await
        .expect("timed out waiting for a frame")
}

/// `true` when nothing is ready on `frames` right now.
async fn nothing_ready<S: Stream<Item = SseFrame> + Unpin>(frames: &mut S) -> bool {
    futures_util::poll!(frames.next()).is_pending()
}

fn number(value: &u32) -> Option<SseFrame> {
    SseFrame::json(value).ok()
}

#[tokio::test]
async fn watch_frames_send_the_current_value_then_every_send() {
    let (tx, rx) = watch::channel(1u32);
    let mut frames = Box::pin(watch_frames(rx, number));
    assert_eq!(
        next_item(&mut frames).await,
        number(&1),
        "the current value, right after the open"
    );
    assert!(nothing_ready(&mut frames).await, "and only once");

    // The same value sent again is delivered again: the producer's cycle is
    // what the reader sees (design §4.5).
    tx.send_replace(1);
    assert_eq!(next_item(&mut frames).await, number(&1));
    tx.send_replace(2);
    assert_eq!(next_item(&mut frames).await, number(&2));

    // A slow reader gets the latest value, not every one.
    tx.send_replace(3);
    tx.send_replace(4);
    assert_eq!(next_item(&mut frames).await, number(&4));
    assert!(nothing_ready(&mut frames).await);

    drop(tx);
    assert_eq!(next_item(&mut frames).await, None, "the sender is gone");
}

#[tokio::test]
async fn watch_frames_skip_what_encode_declines() {
    let (tx, rx) = watch::channel(0u32);
    // Odd values only; the current value (0) is declined too.
    let mut frames = Box::pin(watch_frames(rx, |value: &u32| {
        (value % 2 == 1).then(|| number(value)).flatten()
    }));
    assert!(nothing_ready(&mut frames).await, "0 is not sent");
    tx.send_replace(2);
    assert!(nothing_ready(&mut frames).await, "2 is not sent");
    tx.send_replace(3);
    assert_eq!(next_item(&mut frames).await, number(&3));
}

#[tokio::test]
async fn a_reconnect_gets_the_last_value_again_also_when_the_producer_stopped() {
    // Design §4.5: the first frame of a stream is "the value made last", not
    // a fresh one. What tells them apart is the stamp inside the value.
    #[derive(Clone, serde::Serialize)]
    struct Reading {
        made_at: u64,
        value: f64,
    }
    let (tx, rx) = watch::channel(Reading {
        made_at: 100,
        value: 1.5,
    });
    let encode = |reading: &Reading| SseFrame::json(reading).ok();
    let mut first = Box::pin(watch_frames(rx.clone(), encode));
    let seen = next_item(&mut first).await.expect("the current value");
    drop(first);

    // The producer makes nothing more; the client reconnects twice.
    for _ in 0..2 {
        let mut again = Box::pin(watch_frames(rx.clone(), encode));
        assert_eq!(
            next_item(&mut again).await.as_ref(),
            Some(&seen),
            "the same value with the same stamp: not a new one"
        );
        assert!(nothing_ready(&mut again).await, "and nothing after it");
    }

    // Once the producer runs again, the stamp changes.
    tx.send_replace(Reading {
        made_at: 101,
        value: 1.5,
    });
    let mut after = Box::pin(watch_frames(rx, encode));
    assert_ne!(next_item(&mut after).await, Some(seen));
}

#[tokio::test]
async fn broadcast_frames_skip_a_gap_and_end_when_the_senders_are_gone() {
    let (tx, keep) = broadcast::channel::<u32>(2);
    tx.send(0).unwrap();
    let mut frames = Box::pin(broadcast_frames(tx.subscribe(), number));
    assert!(
        nothing_ready(&mut frames).await,
        "nothing from before it subscribed"
    );

    tx.send(1).unwrap();
    assert_eq!(next_item(&mut frames).await, number(&1));

    // Four events into a buffer of two: the reader lagged. It skips the gap
    // and goes on with what is still there.
    for value in 2..6 {
        tx.send(value).unwrap();
    }
    assert_eq!(next_item(&mut frames).await, number(&4));
    assert_eq!(next_item(&mut frames).await, number(&5));

    let mut odd = Box::pin(broadcast_frames(tx.subscribe(), |value: &u32| {
        (value % 2 == 1).then(|| number(value)).flatten()
    }));
    tx.send(6).unwrap();
    tx.send(7).unwrap();
    assert_eq!(next_item(&mut odd).await, number(&7), "6 was declined");

    drop(tx);
    drop(keep);
    assert_eq!(next_item(&mut frames).await, number(&6));
    assert_eq!(next_item(&mut frames).await, number(&7));
    assert_eq!(next_item(&mut frames).await, None);
}

// ---- the store behind the sessions ----

/// An account store with per-user permissions. The verifier accepts password
/// `"pw"`. The account lookup and the permission read each count their
/// calls, fail on demand, or never answer - and say so on `waiting` the
/// moment they start to wait, so a test knows the check is in flight.
#[derive(Clone, Default)]
struct Store {
    accounts: Arc<Mutex<HashMap<String, SessionAccount>>>,
    held: Arc<Mutex<BTreeSet<PermissionKey>>>,
    lookups: Arc<AtomicUsize>,
    permission_reads: Arc<AtomicUsize>,
    lookup_failing: Arc<AtomicBool>,
    permissions_failing: Arc<AtomicBool>,
    lookup_hanging: Arc<AtomicBool>,
    permissions_hanging: Arc<AtomicBool>,
    waiting: Arc<Mutex<Option<mpsc::UnboundedSender<&'static str>>>>,
}

fn key(raw: &str) -> PermissionKey {
    PermissionKey::parse(raw).expect("a well-formed key")
}

fn plant_view() -> PermissionKey {
    key("plant.view")
}

impl Store {
    /// A store with `alice` (an admin holding `plant.view`).
    fn with_alice() -> Self {
        let store = Self::default();
        store.put("alice", "admin", 1, 0);
        store.grant(plant_view());
        store
    }

    fn put(&self, username: &str, role: &str, account_id: i64, auth_epoch: i64) {
        self.accounts.lock().unwrap().insert(
            username.to_string(),
            SessionAccount {
                identity: Identity {
                    id: username.to_string(),
                    name: username.to_string(),
                    role: role.to_string(),
                    account_id: None,
                },
                stamp: SessionStamp {
                    account_id,
                    auth_epoch,
                },
            },
        );
    }

    fn remove(&self, username: &str) {
        self.accounts.lock().unwrap().remove(username);
    }

    fn grant(&self, permission: PermissionKey) {
        self.held.lock().unwrap().insert(permission);
    }

    /// Takes the permission away. The session stays as it is.
    fn take_away(&self, permission: &PermissionKey) {
        self.held.lock().unwrap().remove(permission);
    }

    fn lookups(&self) -> usize {
        self.lookups.load(Ordering::SeqCst)
    }

    fn permission_reads(&self) -> usize {
        self.permission_reads.load(Ordering::SeqCst)
    }

    /// Told (`"lookup"` / `"permissions"`) whenever a read starts to hang.
    fn watch_waiting(&self) -> mpsc::UnboundedReceiver<&'static str> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.waiting.lock().unwrap() = Some(tx);
        rx
    }

    async fn hang(&self, what: &'static str) {
        if let Some(waiting) = self.waiting.lock().unwrap().as_ref() {
            let _ = waiting.send(what);
        }
        std::future::pending::<()>().await;
    }

    fn auth(&self) -> AuthState {
        let verify = self.clone();
        let lookup = self.clone();
        let reader = self.clone();
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
                    store.lookups.fetch_add(1, Ordering::SeqCst);
                    if store.lookup_hanging.load(Ordering::SeqCst) {
                        store.hang("lookup").await;
                    }
                    if store.lookup_failing.load(Ordering::SeqCst) {
                        return Err(BantoError::Other("store unavailable".to_string()));
                    }
                    Ok(store.accounts.lock().unwrap().get(&u).cloned())
                })
            }),
        )
        .with_permission_reader(move |_account_id: i64| {
            let store = reader.clone();
            Box::pin(async move {
                store.permission_reads.fetch_add(1, Ordering::SeqCst);
                if store.permissions_hanging.load(Ordering::SeqCst) {
                    store.hang("permissions").await;
                }
                if store.permissions_failing.load(Ordering::SeqCst) {
                    return Err(BantoError::Other("store unavailable".to_string()));
                }
                Ok(SessionPermissions::new(store.held.lock().unwrap().clone()))
            })
        })
    }
}

// ---- an app's stream ----

const PLANT_PATH: &str = "/api/plant/stream";

/// What the app's handler is built from: the values it streams (as the
/// named event `values`), and how it sets its context up.
#[derive(Clone)]
struct Plant {
    values: watch::Sender<u32>,
    /// How many values `encode` was asked for (0 = not one frame was made).
    encoded: Arc<AtomicUsize>,
    permission: Option<PermissionKey>,
    counted: bool,
}

impl Plant {
    fn new() -> Self {
        Self {
            values: watch::channel(0).0,
            encoded: Arc::default(),
            permission: None,
            counted: false,
        }
    }

    /// The stream needs `plant.view`, also after it opened.
    fn guarded(mut self) -> Self {
        self.permission = Some(plant_view());
        self
    }

    fn counted(mut self) -> Self {
        self.counted = true;
        self
    }

    fn encoded(&self) -> usize {
        self.encoded.load(Ordering::SeqCst)
    }
}

async fn plant_stream(context: SseContext, Extension(plant): Extension<Plant>) -> Response {
    let encoded = plant.encoded.clone();
    let frames = watch_frames(plant.values.subscribe(), move |value| {
        encoded.fetch_add(1, Ordering::SeqCst);
        SseFrame::json(value).ok()?.event("values").ok()
    });
    let context = match plant.permission {
        Some(permission) => context.require_permission(permission),
        None => context,
    };
    let context = if plant.counted {
        context.counted_as_client()
    } else {
        context
    };
    sse_response(context, frames)
}

/// The app's route, as an app writes it - plus the test's schedule.
fn plant_route(
    auth: &AuthState,
    plant: &Plant,
    schedule: ScheduleSource,
    timeout: Duration,
) -> Router {
    Router::new()
        .route(PLANT_PATH, get(plant_stream))
        .layer(Extension(plant.clone()))
        .layer(Extension(SseTiming { schedule, timeout }))
        .layer(middleware::from_fn_with_state(auth.clone(), require_auth))
}

/// A schedule the test drives by hand (it serves one stream).
fn manual_ticks() -> (ScheduleSource, mpsc::UnboundedSender<()>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let rx = Mutex::new(Some(rx));
    let source: ScheduleSource = Arc::new(move || {
        Schedule::Manual(
            rx.lock()
                .unwrap()
                .take()
                .expect("a manual schedule serves one stream"),
        )
    });
    (source, tx)
}

/// The production schedule, with a short period.
fn every(period: Duration) -> ScheduleSource {
    Arc::new(move || Schedule::every(period))
}

async fn get_with(router: Router, path: &str, token: Option<&str>) -> Response {
    let mut request = HttpRequest::get(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    router
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

/// An open plant stream on a manual schedule.
struct Open {
    body: Body,
    ticks: mpsc::UnboundedSender<()>,
    plant: Plant,
}

impl Open {
    /// The next frame's text, or `None` once the stream has ended. The
    /// timeout only turns a hang into a failure; nothing waits on it.
    async fn next_frame(&mut self) -> Option<String> {
        next_frame(&mut self.body).await
    }

    /// One re-check, then a value: the value arrives, so the stream
    /// survived the check (the loop is `biased` towards a due re-check, so
    /// the check runs before the frame is taken).
    async fn recheck_keeps_open(&mut self, value: u32) {
        self.ticks.send(()).unwrap();
        self.plant.values.send_replace(value);
        assert_eq!(
            self.next_frame().await,
            Some(format!("event: values\ndata: {value}\n\n")),
            "the stream must survive the re-check"
        );
    }

    /// One re-check, then a value: the stream ends without delivering it.
    async fn recheck_closes(&mut self) {
        self.ticks.send(()).unwrap();
        self.plant.values.send_replace(999);
        assert_eq!(
            self.next_frame().await,
            None,
            "the stream must end at the re-check, before the next frame"
        );
    }
}

async fn next_frame(body: &mut Body) -> Option<String> {
    tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("timed out waiting for the stream")
        .map(|frame| {
            let bytes = frame
                .expect("frame error")
                .into_data()
                .expect("expected a data frame");
            String::from_utf8(bytes.to_vec()).unwrap()
        })
}

/// Opens `plant`'s stream for `token` with `timeout`, and reads the first
/// frame (the current value).
async fn open_plant_with(auth: &AuthState, plant: Plant, token: &str, timeout: Duration) -> Open {
    let (schedule, ticks) = manual_ticks();
    let response = get_with(
        plant_route(auth, &plant, schedule, timeout),
        PLANT_PATH,
        Some(token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("text/event-stream")
    );
    let mut open = Open {
        body: response.into_body(),
        ticks,
        plant,
    };
    assert_eq!(
        open.next_frame().await.as_deref(),
        Some("event: values\ndata: 0\n\n"),
        "the current value, with its name"
    );
    open
}

async fn open_plant(auth: &AuthState, plant: Plant, token: &str) -> Open {
    open_plant_with(auth, plant, token, REVALIDATE_TIMEOUT).await
}

async fn alice(store: &Store) -> (AuthState, String) {
    let auth = store.auth();
    let token = auth.login("alice", "pw").await.expect("alice logs in");
    (auth, token)
}

// ---- the loop, through an app stream ----

#[tokio::test]
async fn an_app_stream_ends_at_the_recheck_after_its_session_ended() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let mut open = open_plant(&auth, Plant::new(), &token).await;

    open.recheck_keeps_open(1).await;
    open.recheck_keeps_open(2).await;

    // Role change = a new authentication epoch: the session is over.
    store.put("alice", "viewer", 1, 1);
    open.recheck_closes().await;
}

#[tokio::test]
async fn an_app_stream_ends_after_logout() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let mut open = open_plant(&auth, Plant::new(), &token).await;
    auth.logout(&token);
    open.recheck_closes().await;
}

#[tokio::test]
async fn a_stream_without_a_condition_survives_store_failures_and_timeouts() {
    // #230, unchanged: "could not check" is not "revoked" - however often.
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let mut open = open_plant_with(&auth, Plant::new(), &token, Duration::from_millis(50)).await;

    store.lookup_failing.store(true, Ordering::SeqCst);
    for value in 1..=3 {
        open.recheck_keeps_open(value).await;
    }
    store.lookup_failing.store(false, Ordering::SeqCst);

    // A lookup that never answers is abandoned after the timeout.
    store.lookup_hanging.store(true, Ordering::SeqCst);
    for value in 4..=5 {
        open.recheck_keeps_open(value).await;
    }
    store.lookup_hanging.store(false, Ordering::SeqCst);

    // The checks resume: a revocation made meanwhile applies.
    store.remove("alice");
    open.recheck_closes().await;
}

#[tokio::test]
async fn a_stream_ends_when_its_frames_end() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let plant = Plant::new();
    let (schedule, _ticks) = manual_ticks();
    let response = get_with(
        plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT),
        PLANT_PATH,
        Some(&token),
    )
    .await;
    let mut body = response.into_body();
    assert!(next_frame(&mut body).await.is_some());
    // The handler's own sender is the only one: dropping every clone of the
    // plant ends the `watch`, and with it the stream (the client reconnects).
    drop(plant);
    assert_eq!(next_frame(&mut body).await, None);
}

#[tokio::test]
async fn a_stream_never_goes_on_without_its_schedule() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let mut open = open_plant(&auth, Plant::new(), &token).await;
    let (_unused, other) = manual_ticks();
    drop(std::mem::replace(&mut open.ticks, other));
    open.plant.values.send_replace(1);
    assert_eq!(open.next_frame().await, None);
}

#[tokio::test]
async fn the_next_deadline_is_counted_from_the_end_of_a_check() {
    // Checks that take longer than the period must not starve the delivery:
    // with the deadline counted from the START of a check, a check would be
    // due again the moment it finished, and no frame would ever be taken.
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let plant = Plant::new();
    let period = Duration::from_millis(40);
    let response = get_with(
        // The timeout (longer than the period here) is what every check
        // takes: the lookup never answers.
        plant_route(&auth, &plant, every(period), Duration::from_millis(120)),
        PLANT_PATH,
        Some(&token),
    )
    .await;
    let mut body = response.into_body();
    assert!(next_frame(&mut body).await.is_some());
    store.lookup_hanging.store(true, Ordering::SeqCst);

    // Keep sending and receiving until three more checks have run: every
    // value must arrive (a starved stream fails in `next_frame`'s timeout).
    let checks = store.lookups() + 3;
    let mut value = 0u32;
    while store.lookups() < checks {
        value += 1;
        plant.values.send_replace(value);
        assert_eq!(
            next_frame(&mut body).await,
            Some(format!("event: values\ndata: {value}\n\n")),
            "the stream must stay open while the checks overrun"
        );
    }
}

// ---- SseContext ----

#[tokio::test]
async fn a_route_without_require_auth_is_refused_with_500() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let plant = Plant::new();
    let session = auth.session_for(&token).expect("a live session");

    // No `require_auth`. Even a request that carries a valid token AND a
    // session someone else put into it gets no stream: only `require_auth`
    // can make the binding.
    let router = Router::new()
        .route(PLANT_PATH, get(plant_stream))
        .layer(Extension(plant.clone()))
        .layer(Extension(session))
        .layer(Extension(SessionPermissions::none()));
    let response = get_with(router, PLANT_PATH, Some(&token)).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["kind"], "other", "the usual error body: {body}");
    assert_eq!(plant.encoded(), 0, "not one frame was made");
}

#[tokio::test]
async fn behind_require_auth_a_missing_or_bad_token_is_401() {
    let store = Store::with_alice();
    let (auth, _token) = alice(&store).await;
    let plant = Plant::new();
    for token in [None, Some("not-a-token")] {
        let (schedule, _ticks) = manual_ticks();
        let response = get_with(
            plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT),
            PLANT_PATH,
            token,
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(plant.encoded(), 0);
}

#[tokio::test]
async fn the_rechecks_use_the_auth_state_that_authorized_the_open() {
    // Two states over two stores. The app holds both (`other` is in the
    // request too, as an `Extension`), but the stream was opened behind
    // `require_auth(auth)` - so only `auth` is ever asked.
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let other_store = Store::with_alice();
    let other = other_store.auth();

    let plant = Plant::new();
    let (schedule, ticks) = manual_ticks();
    let router = plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT).layer(Extension(other));
    let response = get_with(router, PLANT_PATH, Some(&token)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut open = Open {
        body: response.into_body(),
        ticks,
        plant,
    };
    assert!(open.next_frame().await.is_some());

    let (before, other_before) = (store.lookups(), other_store.lookups());
    open.recheck_keeps_open(1).await;
    assert_eq!(store.lookups(), before + 1, "the state behind require_auth");
    assert_eq!(other_store.lookups(), other_before, "never the other one");

    // What happens in the other store does not reach the stream ...
    other_store.remove("alice");
    open.recheck_keeps_open(2).await;
    // ... what happens in its own does.
    store.remove("alice");
    open.recheck_closes().await;
    assert_eq!(other_store.lookups(), other_before);
}

#[tokio::test]
async fn an_app_stream_is_counted_only_when_it_asks_and_uncounted_however_it_ends() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let connections = SseConnections::default();
    let open_counted = |plant: Plant| {
        let (auth, token, connections) = (auth.clone(), token.clone(), connections.clone());
        async move {
            let (schedule, ticks) = manual_ticks();
            let router = plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT)
                .layer(Extension(connections));
            let response = get_with(router, PLANT_PATH, Some(&token)).await;
            (response, ticks, plant)
        }
    };

    // The default: an app stream is not a client of its own (design §4.6).
    let (plain, _ticks, _plant) = open_counted(Plant::new()).await;
    assert_eq!(plain.status(), StatusCode::OK);
    assert_eq!(connections.count(), 0, "not counted by default");

    // Asked for: counted from the open, before the body is read.
    let (first, _ticks1, _plant1) = open_counted(Plant::new().counted()).await;
    let (second, ticks2, plant2) = open_counted(Plant::new().counted()).await;
    assert_eq!(connections.count(), 2, "one per counted stream");
    drop(plain);
    assert_eq!(connections.count(), 2, "the uncounted one changes nothing");

    // The client goes away: axum drops the body unfinished.
    drop(first);
    assert_eq!(connections.count(), 1);

    // The re-check ends the stream.
    let mut open = Open {
        body: second.into_body(),
        ticks: ticks2,
        plant: plant2,
    };
    assert!(open.next_frame().await.is_some());
    auth.logout(&token);
    open.recheck_closes().await;
    assert_eq!(connections.count(), 0, "a stream ended by the re-check");
    drop(open);
    assert_eq!(connections.count(), 0, "never below zero");

    // The frames end.
    let token = auth.login("alice", "pw").await.unwrap();
    let (schedule, _ticks) = manual_ticks();
    let plant = Plant::new().counted();
    let router = plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT)
        .layer(Extension(connections.clone()));
    let mut body = get_with(router, PLANT_PATH, Some(&token)).await.into_body();
    assert_eq!(connections.count(), 1);
    assert!(next_frame(&mut body).await.is_some());
    drop(plant);
    assert_eq!(next_frame(&mut body).await, None);
    assert_eq!(connections.count(), 0, "a stream whose frames ended");

    // A refused open (403) is never counted.
    store.take_away(&plant_view());
    let (schedule, _ticks) = manual_ticks();
    let plant = Plant::new().guarded().counted();
    let router = plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT)
        .layer(Extension(connections.clone()));
    let refused = get_with(router, PLANT_PATH, Some(&token)).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(connections.count(), 0);
}

// ---- authorization after the open (design §4.3.1) ----

#[tokio::test]
async fn opening_without_the_permission_is_403_before_any_frame() {
    let store = Store::with_alice();
    store.take_away(&plant_view());
    let (auth, token) = alice(&store).await;
    let plant = Plant::new().guarded();
    let (schedule, _ticks) = manual_ticks();
    // No `PermissionGuard` layer on the route: the context's own condition
    // is enough to keep the stream shut.
    let response = get_with(
        plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT),
        PLANT_PATH,
        Some(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_ne!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("text/event-stream")
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["kind"], "forbidden", "{body}");
    assert_eq!(plant.encoded(), 0, "not one frame was made");
}

#[tokio::test]
async fn a_guarded_stream_ends_when_the_permission_is_taken_away_and_events_stay_open() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let mut plant = open_plant(&auth, Plant::new().guarded(), &token).await;

    // `/api/events` for the same session, next to it.
    let (events_tx, _events_rx) = broadcast::channel(16);
    let (schedule, events_ticks) = manual_ticks();
    let response = get_with(
        sse_route_with(
            auth.clone(),
            events_tx.clone(),
            schedule,
            REVALIDATE_TIMEOUT,
        ),
        "/api/events",
        Some(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut events = response.into_body();

    plant.recheck_keeps_open(1).await;

    // Only the permission goes. The session is untouched: an ordinary
    // request is still authenticated (and would be refused by its guard).
    store.take_away(&plant_view());
    assert!(auth.authenticate(&token).await.unwrap().is_some());
    plant.recheck_closes().await;

    // `/api/events` has no condition: it is re-checked and stays open.
    events_ticks.send(()).unwrap();
    events_tx
        .send(ServerEvent::ResourceChanged {
            resource: "items".to_string(),
        })
        .unwrap();
    let frame = next_frame(&mut events).await.expect("still open");
    assert!(frame.contains("resource_changed"), "{frame}");

    // The reconnect is refused at the open.
    let (schedule, _ticks) = manual_ticks();
    let again = Plant::new().guarded();
    let response = get_with(
        plant_route(&auth, &again, schedule, REVALIDATE_TIMEOUT),
        PLANT_PATH,
        Some(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(again.encoded(), 0);
}

#[tokio::test]
async fn a_guarded_stream_ends_at_the_first_check_that_could_not_be_completed() {
    // Design §4.3.1 / §10-16: a stream with a condition only streams on an
    // authorization that was confirmed. Each case: one failed check, closed.
    type Break = fn(&Store);
    let cases: [(&str, Break); 4] = [
        ("the account lookup fails", |store| {
            store.lookup_failing.store(true, Ordering::SeqCst)
        }),
        ("the permission read fails", |store| {
            store.permissions_failing.store(true, Ordering::SeqCst)
        }),
        ("the account lookup never answers", |store| {
            store.lookup_hanging.store(true, Ordering::SeqCst)
        }),
        ("the permission read never answers", |store| {
            store.permissions_hanging.store(true, Ordering::SeqCst)
        }),
    ];
    for (case, break_store) in cases {
        let store = Store::with_alice();
        let (auth, token) = alice(&store).await;
        let mut guarded = open_plant_with(
            &auth,
            Plant::new().guarded(),
            &token,
            Duration::from_millis(50),
        )
        .await;
        // The same session's stream WITHOUT a condition, as the control.
        let mut plain =
            open_plant_with(&auth, Plant::new(), &token, Duration::from_millis(50)).await;

        guarded.recheck_keeps_open(1).await;
        break_store(&store);
        let checks_before = store.lookups();
        guarded.ticks.send(()).unwrap();
        guarded.plant.values.send_replace(2);
        assert_eq!(guarded.next_frame().await, None, "{case}: closed");
        assert_eq!(
            store.lookups(),
            checks_before + 1,
            "{case}: at the first check, not after several"
        );

        // The very same failure, again and again, does not close a stream
        // without a condition (#230).
        for value in 1..=3 {
            plain.recheck_keeps_open(value).await;
        }
    }
}

#[tokio::test]
async fn a_stream_without_a_condition_never_reads_the_permissions() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let mut plain = open_plant(&auth, Plant::new(), &token).await;
    let mut guarded = open_plant(&auth, Plant::new().guarded(), &token).await;
    // `require_auth` read them once per open.
    let after_open = store.permission_reads();
    assert_eq!(after_open, 2);

    for value in 1..=3 {
        plain.recheck_keeps_open(value).await;
    }
    assert_eq!(
        store.permission_reads(),
        after_open,
        "one account read per check, and nothing else"
    );

    guarded.recheck_keeps_open(1).await;
    assert_eq!(
        store.permission_reads(),
        after_open + 1,
        "a stream with a condition reads them once per check"
    );
}

#[tokio::test]
async fn every_condition_must_hold_and_reauthorize_with_sees_what_was_just_read() {
    let store = Store::with_alice();
    store.grant(key("plant.line_a"));
    let (auth, token) = alice(&store).await;
    let values = watch::channel(0u32).0;
    let seen_names = Arc::new(Mutex::new(Vec::new()));

    let handler = {
        let (values, seen_names) = (values.clone(), seen_names.clone());
        move |context: SseContext| {
            let frames = watch_frames(values.subscribe(), |value| SseFrame::json(value).ok());
            let seen_names = seen_names.clone();
            async move {
                let context = context.require_permission(plant_view()).reauthorize_with(
                    move |session, permissions| {
                        seen_names
                            .lock()
                            .unwrap()
                            .push(session.identity.name.clone());
                        permissions.has(&key("plant.line_a"))
                    },
                );
                sse_response(context, frames)
            }
        }
    };
    let (schedule, ticks) = manual_ticks();
    let router = Router::new()
        .route(PLANT_PATH, get(handler))
        .layer(Extension(SseTiming {
            schedule,
            timeout: REVALIDATE_TIMEOUT,
        }))
        .layer(middleware::from_fn_with_state(auth.clone(), require_auth));
    let response = get_with(router, PLANT_PATH, Some(&token)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    assert!(next_frame(&mut body).await.is_some());

    // The display name changes in the store (no new epoch: the session
    // goes on). The condition is handed the identity as re-read.
    store
        .accounts
        .lock()
        .unwrap()
        .get_mut("alice")
        .unwrap()
        .identity
        .name = "Alice B".to_string();
    ticks.send(()).unwrap();
    values.send_replace(1);
    assert!(next_frame(&mut body).await.is_some(), "both still hold");
    assert_eq!(
        *seen_names.lock().unwrap(),
        ["alice", "Alice B"],
        "judged at the open and at the re-check, on current data"
    );

    // One of the two conditions stops holding: closed.
    store.take_away(&key("plant.line_a"));
    ticks.send(()).unwrap();
    values.send_replace(2);
    assert_eq!(next_frame(&mut body).await, None);
}

#[tokio::test]
async fn a_grant_session_holds_no_permission_for_a_stream_either() {
    // Same answer as for a request: a grant session's permissions are none,
    // so a stream that needs one does not open - while a stream without a
    // condition does, and is re-checked on the token alone.
    let store = Store::with_alice();
    let auth = store.auth();
    let on: GrantCondition = Arc::new(|| Box::pin(async { Ok(true) }));
    let spec = GrantSpec::new(
        GrantKind::new("commissioning").expect("a valid kind"),
        Identity {
            id: "commissioning".to_string(),
            name: "commissioning".to_string(),
            role: "admin".to_string(),
            account_id: None,
        },
        on,
    );
    let token = auth
        .issue_grant_token(&spec, auth.grant_generation(&spec.kind))
        .expect("issued");

    let guarded = Plant::new().guarded();
    let (schedule, _ticks) = manual_ticks();
    let response = get_with(
        plant_route(&auth, &guarded, schedule, REVALIDATE_TIMEOUT),
        PLANT_PATH,
        Some(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(guarded.encoded(), 0);

    let mut plain = open_plant(&auth, Plant::new(), &token).await;
    let reads = store.lookups();
    plain.recheck_keeps_open(1).await;
    assert_eq!(store.lookups(), reads, "a grant session is not looked up");
    auth.revoke_grant_tokens(&spec.kind);
    plain.recheck_closes().await;
}

#[tokio::test]
async fn a_guarded_stream_is_closed_within_one_interval_and_one_timeout() {
    // The bound of design §4.3.1, on the production schedule with short
    // numbers: after the authorization was last confirmed (the open), the
    // store stops answering. The stream must be closed after the interval
    // plus the timeout - by the FIRST check - not kept for a later one.
    let period = Duration::from_millis(150);
    let timeout = Duration::from_millis(100);
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let plant = Plant::new().guarded();
    let opened = std::time::Instant::now();
    let response = get_with(
        plant_route(&auth, &plant, every(period), timeout),
        PLANT_PATH,
        Some(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    assert!(next_frame(&mut body).await.is_some());
    store.permissions_hanging.store(true, Ordering::SeqCst);
    let checks_before = store.lookups();

    assert_eq!(next_frame(&mut body).await, None, "closed");
    let took = opened.elapsed();
    assert_eq!(store.lookups(), checks_before + 1, "by the first check");
    assert!(
        took >= period + timeout,
        "not before the check timed out: {took:?}"
    );
    // (No tight upper bound on a wall clock: "by the first check" above is
    // what says no later check was waited for.)
    assert!(took < Duration::from_secs(5), "{took:?}");
}

// ---- the server stopping (design §4.4) ----

async fn serve(router: Router) -> crate::server::RunningServer {
    start(
        ServerConfig {
            bind: "127.0.0.1".to_string(),
            port: 0,
        },
        router,
    )
    .await
    .expect("the server starts")
}

/// Opens `path` over a real socket; returns it once the response head
/// arrived (so the stream is really open).
async fn open_socket(addr: SocketAddr, path: &str, token: &str) -> tokio::net::TcpStream {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut buf = [0u8; 512];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "closed before the response head");
        head.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8_lossy(&head);
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    stream
}

/// `stop()` while the stream's re-check is waiting for a store that never
/// answers - and whose timeout is far away - must not wait for the check.
async fn stop_does_not_wait_for_a_check_in_flight(
    store: Store,
    router: Router,
    ticks: mpsc::UnboundedSender<()>,
    path: &str,
    token: &str,
) {
    use tokio::io::AsyncReadExt;
    let mut waiting = store.watch_waiting();
    let server = serve(router).await;
    let mut socket = open_socket(server.local_addr(), path, token).await;

    store.lookup_hanging.store(true, Ordering::SeqCst);
    ticks.send(()).unwrap();
    assert_eq!(
        waiting.recv().await,
        Some("lookup"),
        "the re-check is now waiting for the store"
    );

    let started = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(3), server.stop())
        .await
        .expect("stop() must not wait for the check (nor for STOP_TIMEOUT)");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "well under STOP_TIMEOUT (5 s) and the check's timeout"
    );
    // The stream was ended by the server (EOF), not left dangling.
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut rest))
        .await
        .expect("the client sees the end of the stream")
        .ok();
}

/// The check's own timeout in the stop tests: far beyond anything the test
/// waits for, so only the stop signal can end the wait.
const NEVER_IN_THIS_TEST: Duration = Duration::from_secs(600);

#[tokio::test]
async fn stop_ends_an_app_stream_whose_recheck_is_in_flight() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let (schedule, ticks) = manual_ticks();
    let plant = Plant::new().guarded();
    let router = plant_route(&auth, &plant, schedule, NEVER_IN_THIS_TEST);
    stop_does_not_wait_for_a_check_in_flight(store, router, ticks, PLANT_PATH, &token).await;
}

#[tokio::test]
async fn stop_ends_api_events_whose_recheck_is_in_flight() {
    // The same loop, so `/api/events` gets the fix too (before #935 a
    // re-check in flight held the stream for up to its 5 s timeout).
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let (schedule, ticks) = manual_ticks();
    let (tx, _rx) = broadcast::channel(16);
    let router = sse_route_with(auth, tx.clone(), schedule, NEVER_IN_THIS_TEST);
    stop_does_not_wait_for_a_check_in_flight(store, router, ticks, "/api/events", &token).await;
    drop(tx);
}

#[tokio::test]
async fn stop_ends_an_idle_app_stream_at_once() {
    let store = Store::with_alice();
    let (auth, token) = alice(&store).await;
    let (schedule, _ticks) = manual_ticks();
    // Kept alive like an app's state: the `watch` does not close on its own.
    let plant = Plant::new();
    let server = serve(plant_route(&auth, &plant, schedule, REVALIDATE_TIMEOUT)).await;
    let _socket = open_socket(server.local_addr(), PLANT_PATH, &token).await;
    let started = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(3), server.stop())
        .await
        .expect("stop() must finish while an app stream is open");
    assert!(started.elapsed() < Duration::from_secs(3));
}
