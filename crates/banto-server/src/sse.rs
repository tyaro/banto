//! The foundation an SSE stream is served on (Issue #935,
//! `docs/design/sse-stream-design.md` §4): this crate's own `/api/events`
//! ([`crate::events`]) and every stream a derived app adds go through the
//! ONE loop in this module, so the rules of an open stream are written once.
//!
//! An app's handler takes an [`SseContext`] (available only behind
//! [`require_auth`]), builds a stream of [`SseFrame`]s - from a `watch`
//! ([`watch_frames`]), a `broadcast` ([`broadcast_frames`]) or anything else -
//! and returns [`sse_response`]:
//!
//! ```
//! use axum::response::Response;
//! use axum::routing::get;
//! use axum::{middleware, Extension, Router};
//! use banto_server::{require_auth, sse_response, watch_frames, AuthState, SseContext, SseFrame};
//! use tokio::sync::watch;
//!
//! async fn values_stream(
//!     context: SseContext,
//!     Extension(values): Extension<watch::Receiver<Vec<f64>>>,
//! ) -> Response {
//!     let frames = watch_frames(values, |values| {
//!         SseFrame::json(values).ok()?.event("values").ok()
//!     });
//!     sse_response(context, frames)
//! }
//!
//! fn routes(auth: AuthState, values: watch::Receiver<Vec<f64>>) -> Router {
//!     Router::new()
//!         .route("/api/plant/stream", get(values_stream))
//!         .layer(Extension(values))
//!         .layer(middleware::from_fn_with_state(auth, require_auth))
//! }
//! ```
//!
//! ## The rules of an open stream (Issue #231, ADR-0014)
//!
//! [`require_auth`] validates the session when the stream opens. A stream
//! then stays open for as long as the tab does, so every stream also
//! re-runs the session check (`AuthState::revalidate`, i.e.
//! [`AuthState::authenticate`] without sliding the idle window) every
//! [`REVALIDATE_INTERVAL`] - the keepalive's interval - and ends when the
//! session is no longer valid (account deleted, role/password changed or
//! reset, token logged out or expired). Revocation therefore reaches an open
//! stream within one interval (plus one check), in any process sharing the
//! account store.
//!
//! - The re-check runs against the [`AuthState`] that authorized the opening
//!   request, for the token it validated: [`require_auth`] binds both to the
//!   request - together with the session, the permissions and the moment
//!   the authorization finished - and [`SseContext`] takes them from there.
//!   A handler cannot hand in another state, and the `Authorization` header
//!   is not read a second time.
//! - The first re-check is due one interval after [`require_auth`]
//!   authorized the opening request - NOT after the handler got around to
//!   building its response. A handler that awaited something else for longer
//!   than that gets its stream re-checked before the first frame is taken.
//! - One deadline per stream, owned by the stream itself (no spawned task,
//!   no second timer): when the client disconnects, axum drops the stream,
//!   and the deadline and any re-check in flight are dropped with it.
//! - A due re-check runs before further frames are taken, exactly once; the
//!   next deadline is set one interval after that check FINISHED. However
//!   long checks take, frames get a whole interval between two checks - the
//!   checks can never starve the delivery (review of #234).
//! - A check is abandoned after [`REVALIDATE_TIMEOUT`] (shorter than the
//!   interval). A timeout counts as "could not check", like a store failure
//!   (`Err`): neither ends a stream WITHOUT an authorization condition
//!   (#230: a session that cannot be checked is kept); the next deadline
//!   checks again. The abandoned lookup future is dropped, and since
//!   `authenticate` only changes the session after its lookup returns, an
//!   abandoned check never changes it later.
//! - A session re-bound while its check was in flight (its own password
//!   change) is judged on its current binding, exactly as for a request
//!   ([`AuthState::authenticate`]'s `settle_lookup`).
//! - Public viewer sessions and `SessionValidation::DisabledNoRevocation`
//!   never look anything up, so the re-check is an in-memory token check:
//!   those streams end only when the token itself does.
//! - The server stopping ends the stream the next time the stream is
//!   polled (Issue #283), also while a re-check is waiting for the store:
//!   `RunningServer::stop` never waits for a stream's check. That is what
//!   this module guarantees, and it reaches as far as the response body is
//!   polled: a stream whose client does not read (the send is held by
//!   backpressure, which arbitrarily large frames make possible) is not
//!   polled, so it does not get to see the stop signal. For such a
//!   connection only the server-wide cap of `RunningServer::stop` applies
//!   (`STOP_TIMEOUT`), and that is a cap on the WAIT: `stop` stops waiting
//!   and aborts the task that runs the server. axum serves each connection
//!   on a task of its own, so this does not promise that the socket of a
//!   connection that does not finish is closed within the cap.
//!
//! ## Streams with an authorization condition (design §4.3.1)
//!
//! A permission change does not end a session - ordinary requests read the
//! permissions per request - so a stream that is only guarded where it opens
//! would go on after its permission was taken away. A stream opened with
//! [`SseContext::require_permission`] / [`SseContext::reauthorize_with`]
//! therefore:
//!
//! - is refused with `403` before its first frame when the condition does not
//!   hold for the opening request's session and permissions;
//! - re-reads the session's permissions at every re-check (the same read as
//!   a request's, without sliding the idle window) and ends when the
//!   condition no longer holds;
//! - ends at the FIRST re-check that could not be completed (`Err` or
//!   timeout, of the session check or of the permission read): it only
//!   streams on an authorization that was confirmed. So such a stream is,
//!   at most [`REVALIDATE_INTERVAL`] + [`REVALIDATE_TIMEOUT`] after its
//!   authorization was last confirmed, either confirmed again or closed -
//!   counted from [`require_auth`]'s authorization for the first check
//!   (above), and a token that ended while its permissions were being read
//!   does not count as confirmed (`AuthState::authenticate_with_permissions`).
//!
//! A stream without a condition (`/api/events` included) never reads the
//! permissions and keeps the #230 rule above.

use std::convert::Infallible;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use banto_admin_services::permissions::PermissionKey;
use banto_core::BantoError;
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio::time::Instant;

#[cfg(doc)]
use crate::auth::require_auth;
use crate::auth::{AuthState, AuthenticatedSession, SessionPermissions};
use crate::server::{ShutdownSignal, SseConnectionGuard, SseConnections};
use crate::ApiError;

/// Interval of the SSE keepalive comment.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// Interval of an open stream's session re-check (Issue #231): the
/// keepalive's, so a revoked session loses its stream within one keepalive
/// period. Measured from the end of the previous check. Costs one indexed
/// account read per open account stream per interval (none for public
/// viewer / no-revocation sessions), plus one permission read for a stream
/// with an authorization condition.
///
/// Deliberately not configurable per stream: "revocation reaches an open
/// stream within one interval" (ADR-0014) must hold for every stream.
pub const REVALIDATE_INTERVAL: Duration = KEEPALIVE_INTERVAL;

/// How long one re-check may take before it is abandoned as "could not
/// check" (a stream without an authorization condition is kept, one with a
/// condition ends). Shorter than [`REVALIDATE_INTERVAL`], so a store that
/// stops answering cannot hold the stream inside one check.
pub const REVALIDATE_TIMEOUT: Duration = Duration::from_secs(5);

const _: () = assert!(REVALIDATE_TIMEOUT.as_nanos() < REVALIDATE_INTERVAL.as_nanos());

/// When one stream's re-checks are due.
pub(crate) enum Schedule {
    /// Production: due `period` after [`require_auth`] authorized the
    /// opening request (`Schedule::count_from`), then `period` after the
    /// END of each check (`Schedule::rearm`).
    Every { period: Duration, next: Instant },
    /// Tests: due whenever the test sends a tick; ends when it drops the
    /// sender.
    #[cfg(test)]
    Manual(tokio::sync::mpsc::UnboundedReceiver<()>),
}

impl Schedule {
    pub(crate) fn every(period: Duration) -> Self {
        Self::Every {
            period,
            next: Instant::now() + period,
        }
    }

    /// Count the first deadline from `confirmed`, the moment the opening
    /// request's authorization finished - not from when the schedule was
    /// made (the handler may have awaited in between). A deadline already
    /// in the past is due at once.
    fn count_from(&mut self, confirmed: Instant) {
        match self {
            Self::Every { period, next } => *next = confirmed + *period,
            #[cfg(test)]
            Self::Manual(_) => {}
        }
    }

    /// Resolves when a re-check is due; `false` if the schedule ended.
    /// Cancel-safe: the deadline lives in `self`, not in this future.
    async fn due(&mut self) -> bool {
        match self {
            Self::Every { next, .. } => {
                tokio::time::sleep_until(*next).await;
                true
            }
            #[cfg(test)]
            Self::Manual(ticks) => ticks.recv().await.is_some(),
        }
    }

    /// Set the next deadline, after a check has finished.
    fn rearm(&mut self) {
        match self {
            Self::Every { period, next } => *next = Instant::now() + *period,
            #[cfg(test)]
            Self::Manual(_) => {}
        }
    }
}

/// Makes the [`Schedule`] for each newly opened stream.
pub(crate) type ScheduleSource = Arc<dyn Fn() -> Schedule + Send + Sync>;

/// The schedule and timeout of the streams opened behind the layer that
/// carries this as an `Extension`. Crate-private, so only this crate's tests
/// (and [`crate::events`]'s test seam) can install one: an app's streams
/// always run on [`REVALIDATE_INTERVAL`] / [`REVALIDATE_TIMEOUT`].
#[derive(Clone)]
pub(crate) struct SseTiming {
    pub(crate) schedule: ScheduleSource,
    pub(crate) timeout: Duration,
}

impl SseTiming {
    fn production() -> Self {
        Self {
            schedule: Arc::new(|| Schedule::every(REVALIDATE_INTERVAL)),
            timeout: REVALIDATE_TIMEOUT,
        }
    }
}

/// ONE authorization of a request, as [`require_auth`] binds it to that
/// request (design §4.3): the [`AuthState`] that made it, the token it
/// validated, the session and permissions it returned, and the moment it
/// finished. Crate-private and constructible only here and in
/// `require_auth`, so no app code can put one into a request: its presence
/// is what "behind `require_auth`" means to [`SseContext`], and what is
/// inside is all a stream is opened and re-checked with - the state, the
/// token (never the `Authorization` header read again, which a middleware
/// inside the route could have changed) and the clock of its first re-check.
///
/// No `Debug`: it holds the token.
#[derive(Clone)]
pub(crate) struct SseAuthBinding {
    auth: AuthState,
    token: String,
    session: AuthenticatedSession,
    permissions: SessionPermissions,
    confirmed: Instant,
}

impl SseAuthBinding {
    /// Call right after the authorization returned, with what it was asked
    /// and what it answered: "now" is taken as the moment it was confirmed.
    pub(crate) fn new(
        auth: AuthState,
        token: String,
        session: AuthenticatedSession,
        permissions: SessionPermissions,
    ) -> Self {
        Self {
            auth,
            token,
            session,
            permissions,
            confirmed: Instant::now(),
        }
    }
}

/// One authorization condition of a stream: must hold when it opens and at
/// every re-check.
type Condition = Arc<dyn Fn(&AuthenticatedSession, &SessionPermissions) -> bool + Send + Sync>;

/// What one SSE stream takes from the request that opens it (Issue #935):
/// the authorization [`require_auth`] made for it - the [`AuthState`], the
/// token it validated, the session and permissions it returned and when -
/// and the server's stop signal and stream count. Hand it to
/// [`sse_response`].
///
/// An extractor that only works behind [`require_auth`], and it cannot be
/// built any other way: a route WITHOUT `require_auth` answers `500` (fail
/// closed - a stream must never open on a token nobody checked). Behind it,
/// a request without a valid `Authorization: Bearer` never reaches the
/// handler (`require_auth` answers `401`).
///
/// The stream's re-checks run against the `AuthState` given to that
/// `require_auth`, for the token it validated; a handler has no way to
/// supply another state or token. The first re-check is due
/// [`REVALIDATE_INTERVAL`] after that authorization, however long the
/// handler takes before it calls [`sse_response`].
///
/// See the [module doc](crate::sse) for the rules of the stream, and
/// `docs/design/sse-stream-design.md` §4 / ADR-0014 for the reasons.
pub struct SseContext {
    auth: AuthState,
    token: String,
    session: AuthenticatedSession,
    permissions: SessionPermissions,
    /// When `require_auth` finished authorizing the opening request.
    confirmed: Instant,
    shutdown: Option<ShutdownSignal>,
    connections: Option<SseConnections>,
    timing: Option<SseTiming>,
    counted: bool,
    conditions: Vec<Condition>,
}

impl fmt::Debug for SseContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never the token.
        f.debug_struct("SseContext")
            .field("session", &self.session.identity.id)
            .field("counted", &self.counted)
            .field("conditions", &self.conditions.len())
            .finish_non_exhaustive()
    }
}

/// `500`: the route is not behind [`require_auth`] (a wiring mistake).
fn not_behind_require_auth() -> Response {
    ApiError(BantoError::Other(
        "SSE stream route is not behind require_auth".to_string(),
    ))
    .into_response()
}

impl<S: Send + Sync> FromRequestParts<S> for SseContext {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // `require_auth` inserts the binding after its authorization was
        // complete. Everything the stream is opened and re-checked with
        // comes from it, as one bundle: nothing else the request carries is
        // trusted - not a session or permissions in its extensions, and not
        // its `Authorization` header (not read again).
        let Some(SseAuthBinding {
            auth,
            token,
            session,
            permissions,
            confirmed,
        }) = parts.extensions.get::<SseAuthBinding>().cloned()
        else {
            return Err(not_behind_require_auth());
        };
        Ok(Self {
            auth,
            token,
            session,
            permissions,
            confirmed,
            shutdown: parts.extensions.get::<ShutdownSignal>().cloned(),
            connections: parts.extensions.get::<SseConnections>().cloned(),
            timing: parts.extensions.get::<SseTiming>().cloned(),
            counted: false,
            conditions: Vec::new(),
        })
    }
}

impl SseContext {
    /// Count this stream in [`crate::RunningServer::sse_connections`] (the
    /// desktop header's "接続 n 台", Issue #558) for as long as it is open.
    ///
    /// Off by default: `/api/events` is already counted once per open
    /// screen, so a screen that also opens an app stream would count twice.
    /// Call this for the ONE stream of a screen that does not open
    /// `/api/events` (design §4.6).
    #[must_use]
    pub fn counted_as_client(mut self) -> Self {
        self.counted = true;
        self
    }

    /// Keep the stream open only while the session holds `permission`
    /// (design §4.3.1):
    ///
    /// - at the open, [`sse_response`] answers `403` - and not one frame is
    ///   sent - when the session does not hold it;
    /// - at every re-check the session's permissions are read again, and the
    ///   stream ends when it no longer holds it;
    /// - **the stream also ends when a re-check could not be completed**
    ///   (`Err` or timeout): it only streams on an authorization that was
    ///   confirmed, at most [`REVALIDATE_INTERVAL`] + [`REVALIDATE_TIMEOUT`]
    ///   ago. The client reconnects; while the store does not answer,
    ///   `require_auth` refuses the reconnect.
    ///
    /// May be called several times (all are required). A grant session holds
    /// no permissions, exactly as for a request.
    ///
    /// Keep the route's [`crate::routes::require_permission`] layer as well:
    /// it is what writes the `denied` audit row when the open (or a
    /// reconnect after the stream was closed) is refused. Closing an open
    /// stream writes no audit row by itself.
    #[must_use]
    pub fn require_permission(self, permission: PermissionKey) -> Self {
        self.reauthorize_with(move |_session, permissions| permissions.has(&permission))
    }

    /// [`SseContext::require_permission`] for a condition finer than one
    /// permission (per equipment, role AND permission, ...): the stream is
    /// refused / ended when `allow` returns `false`, at the same moments.
    ///
    /// `allow` gets the session and the permissions as just read by the
    /// foundation (the opening request's, then each re-check's). It is
    /// synchronous on purpose: it must not wait on anything (no store read),
    /// so the stream's stop and timeout rules stay inside this module.
    #[must_use]
    pub fn reauthorize_with<F>(mut self, allow: F) -> Self
    where
        F: Fn(&AuthenticatedSession, &SessionPermissions) -> bool + Send + Sync + 'static,
    {
        self.conditions.push(Arc::new(allow));
        self
    }
}

/// An SSE event name rejected by [`SseFrame::event`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidSseEventName {
    /// The rejected name, verbatim.
    pub name: String,
    /// Why it was rejected (English, for logs/panics).
    pub reason: &'static str,
}

impl fmt::Display for InvalidSseEventName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid SSE event name {:?}: {}", self.name, self.reason)
    }
}

impl std::error::Error for InvalidSseEventName {}

/// One event of a stream: an optional `event:` name and the `data:` payload.
///
/// ```
/// use banto_server::SseFrame;
///
/// let frame = SseFrame::json(&serde_json::json!({ "t": 1 }))
///     .expect("serializable")
///     .event("values")
///     .expect("a valid name");
/// assert!(SseFrame::text("x").event("two\nlines").is_err());
/// # let _ = frame;
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    event: Option<String>,
    data: String,
}

impl SseFrame {
    /// A frame whose `data:` is `value` as JSON (one line).
    pub fn json<T: Serialize + ?Sized>(value: &T) -> Result<Self, serde_json::Error> {
        Ok(Self {
            event: None,
            data: serde_json::to_string(value)?,
        })
    }

    /// A frame whose `data:` is `data` as it is. A line break (LF, CR or
    /// CRLF) starts a new `data:` line, as SSE prescribes, so the client
    /// reads the lines joined with `\n`.
    pub fn text(data: impl Into<String>) -> Self {
        let data: String = data.into();
        Self {
            event: None,
            // One break per line, whichever way it was written: axum starts
            // a `data:` line at every CR and every LF, so a CRLF left as it
            // is would read back as two breaks.
            data: if data.contains('\r') {
                data.replace("\r\n", "\n").replace('\r', "\n")
            } else {
                data
            },
        }
    }

    /// Name the event (`event: <name>`), so one stream can carry several
    /// kinds (design §4.7: one stream per screen, kinds told apart by name).
    /// Replaces a name set before. `Err` for an empty name and for one with a
    /// line break (CR / LF), which would end the field - checked here so a
    /// bad name is an error at the call, never a panic while streaming.
    pub fn event(mut self, name: impl Into<String>) -> Result<Self, InvalidSseEventName> {
        let name = name.into();
        let reason = if name.is_empty() {
            Some("empty")
        } else if name.contains(['\r', '\n']) {
            Some("contains a line break")
        } else {
            None
        };
        match reason {
            Some(reason) => Err(InvalidSseEventName { name, reason }),
            None => {
                self.event = Some(name);
                Ok(self)
            }
        }
    }

    fn into_event(self) -> Event {
        let event = match self.event {
            // Validated by `SseFrame::event` (axum panics on a line break).
            Some(name) => Event::default().event(name),
            None => Event::default(),
        };
        // axum writes one `data:` line per line of `data`.
        event.data(self.data)
    }
}

/// The values of a `watch` channel as frames: **the current value once,
/// right after the stream opens**, then, after every `send`, the latest value
/// that could be read (also when it equals the previous one; a slow reader
/// skips intermediate values). A value for which `encode` returns `None` is
/// not sent. Ends when the sender is gone.
///
/// The first frame is "the value made last", NOT "a fresh value": every
/// reconnect gets it again, also while the producer has stopped. Freshness
/// travels in the value: have the producer `send_replace` every cycle with a
/// stamp (the time the value was made) inside, and let the reader count a
/// value as new only when its stamp changed (design §4.5). The foundation
/// itself never re-sends a value on a timer - that would hide a producer
/// that stopped.
pub fn watch_frames<T, F>(
    mut rx: watch::Receiver<T>,
    mut encode: F,
) -> impl Stream<Item = SseFrame> + Send
where
    T: Send + Sync + 'static,
    F: FnMut(&T) -> Option<SseFrame> + Send + 'static,
{
    async_stream::stream! {
        loop {
            // The borrow is released before the frame is handed out.
            let frame = {
                let value = rx.borrow_and_update();
                encode(&value)
            };
            if let Some(frame) = frame {
                yield frame;
            }
            if rx.changed().await.is_err() {
                break;
            }
        }
    }
}

/// The events of a `broadcast` channel as frames: only those sent after
/// `rx` subscribed (nothing from the past). An event for which `encode`
/// returns `None` is not sent. A reader that fell behind the channel's
/// buffer skips the gap (`Lagged`) and goes on; the stream ends when every
/// sender is gone.
pub fn broadcast_frames<T, F>(
    mut rx: broadcast::Receiver<T>,
    mut encode: F,
) -> impl Stream<Item = SseFrame> + Send
where
    T: Clone + Send + 'static,
    F: FnMut(&T) -> Option<SseFrame> + Send + 'static,
{
    async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(value) => {
                    if let Some(frame) = encode(&value) {
                        yield frame;
                    }
                }
                // A slow client fell behind the broadcast buffer: skip the
                // gap rather than closing the connection.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                // Sender dropped (server shutting down): end the stream.
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

/// Serve `frames` as an SSE response under the rules of the
/// [module doc](crate::sse) - the same ones as `/api/events`:
///
/// - the session behind the opening request is re-checked every
///   [`REVALIDATE_INTERVAL`] against the `AuthState` that authorized it
///   (`context` carries it), and the stream ends once it is no longer valid;
/// - the conditions put on `context` ([`SseContext::require_permission`],
///   [`SseContext::reauthorize_with`]) are judged HERE, before the first
///   frame - `403` when one does not hold - and again at every re-check;
/// - the first of those re-checks is due one interval after `require_auth`
///   authorized the opening request; when the handler took longer than that
///   to get here, it runs before the first frame is taken;
/// - the stream ends when the server stops - the next time it is polled,
///   also in the middle of a re-check (`RunningServer::stop` does not wait
///   for a check) - and when `frames` ends (the client reconnects). A
///   stream that is not polled because its client does not read does not
///   get there: `RunningServer::stop` only stops waiting for it at its own
///   cap (its socket is not promised to be closed by then);
/// - a keepalive comment is sent every 15 seconds.
///
/// The response is `text/event-stream`; frames are written as
/// `event: <name>` (only when named) and `data: <payload>`.
pub fn sse_response<S>(context: SseContext, frames: S) -> Response
where
    S: Stream<Item = SseFrame> + Send + 'static,
{
    let SseContext {
        auth,
        token,
        session,
        permissions,
        confirmed,
        shutdown,
        connections,
        timing,
        counted,
        conditions,
    } = context;
    // Fail closed at the open: judged before anything is streamed, with the
    // session and permissions `require_auth` authorized.
    if !conditions.iter().all(|allow| allow(&session, &permissions)) {
        return ApiError(BantoError::Forbidden).into_response();
    }
    let timing = timing.unwrap_or_else(SseTiming::production);
    // The handler may have awaited between `require_auth` and here: the
    // first deadline belongs to the authorization, not to this call. If it
    // has passed already, the loop re-checks before it takes a frame (it is
    // `biased` towards a due re-check).
    let mut schedule = (timing.schedule)();
    schedule.count_from(confirmed);
    let stream = guarded_stream(
        Guard {
            auth,
            token,
            conditions,
            schedule,
            timeout: timing.timeout,
            shutdown,
            // A refused open is never counted; an open one is counted from
            // here, and uncounted when the stream is dropped.
            counted: connections
                .filter(|_| counted)
                .map(|connections| connections.open()),
        },
        frames,
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(KEEPALIVE_INTERVAL))
        .into_response()
}

/// What guards one open stream.
struct Guard {
    auth: AuthState,
    token: String,
    conditions: Vec<Condition>,
    schedule: Schedule,
    timeout: Duration,
    shutdown: Option<ShutdownSignal>,
    /// Issue #558: owned by the stream, so it is dropped - and the stream
    /// uncounted - when the stream ends or is dropped unfinished.
    counted: Option<SseConnectionGuard>,
}

/// What the stream's loop does next.
enum Step {
    /// A re-check is due (`false`: the schedule ended).
    Recheck(bool),
    /// The next frame (`None`: the frames ended).
    Deliver(Option<SseFrame>),
    /// The server was asked to stop (Issue #283).
    Shutdown,
}

/// Resolves once the server was asked to stop; never without a signal (a
/// router served some other way). Cancel-safe.
async fn stopped(shutdown: &mut Option<ShutdownSignal>) {
    match shutdown.as_mut() {
        Some(signal) => signal.triggered().await,
        None => std::future::pending().await,
    }
}

/// One re-check. `Ok(true)`: the session is valid and every condition
/// holds. `Ok(false)`: the session ended, or a condition no longer holds.
/// `Err`: the store could not answer.
///
/// Without conditions this is `AuthState::revalidate` alone - the
/// permissions are not read.
async fn recheck(
    auth: &AuthState,
    token: &str,
    conditions: &[Condition],
) -> Result<bool, BantoError> {
    if conditions.is_empty() {
        return Ok(auth.revalidate(token).await?.is_some());
    }
    Ok(match auth.revalidate_with_permissions(token).await? {
        Some((session, permissions)) => {
            conditions.iter().all(|allow| allow(&session, &permissions))
        }
        None => false,
    })
}

/// THE loop (design §4.4): `frames`, ended by the stop signal, by a re-check
/// that says so, or by `frames` ending. Every SSE stream of this crate and of
/// the apps built on it is this function.
fn guarded_stream<S>(guard: Guard, frames: S) -> impl Stream<Item = Result<Event, Infallible>>
where
    S: Stream<Item = SseFrame> + Send + 'static,
{
    async_stream::stream! {
        let Guard {
            auth,
            token,
            conditions,
            mut schedule,
            timeout,
            mut shutdown,
            // Moved into the stream's state, so it lives exactly as long as it.
            counted: _counted,
        } = guard;
        let mut frames = std::pin::pin!(frames);
        loop {
            // Every branch is cancel-safe (a frame not taken stays in
            // `frames`, whose state outlives this `next()`; the deadline
            // stays in `schedule`). `biased`: a due re-check runs before
            // further frames are taken - once, since `rearm` then puts the
            // next one a whole interval away.
            let step = tokio::select! {
                biased;
                // Server stop (Issue #283): a separate lifecycle from the
                // session re-check - without it graceful shutdown waits for
                // this stream forever.
                () = stopped(&mut shutdown) => Step::Shutdown,
                due = schedule.due() => Step::Recheck(due),
                frame = frames.next() => Step::Deliver(frame),
            };
            match step {
                Step::Shutdown => break,
                Step::Recheck(true) => {
                    // The stop signal also wins over a check in flight: a
                    // store that is slow to answer must not hold
                    // `RunningServer::stop`. The abandoned check is the same
                    // future a timeout abandons - it only reads.
                    let verdict = tokio::select! {
                        biased;
                        () = stopped(&mut shutdown) => None,
                        verdict = tokio::time::timeout(
                            timeout,
                            recheck(&auth, &token, &conditions),
                        ) => Some(verdict),
                    };
                    let Some(verdict) = verdict else {
                        break;
                    };
                    schedule.rearm();
                    let keep = match verdict {
                        Ok(Ok(valid)) => valid,
                        // The store could not answer (`Err`) or not in time
                        // (the lookup is dropped). Without a condition: keep
                        // the stream (#230) and check again next time. With
                        // one: the authorization could not be confirmed, so
                        // the stream ends (design §4.3.1).
                        Ok(Err(_)) | Err(_) => conditions.is_empty(),
                    };
                    if !keep {
                        break;
                    }
                }
                // Never keep streaming without the re-check.
                Step::Recheck(false) => break,
                Step::Deliver(Some(frame)) => yield Ok(frame.into_event()),
                Step::Deliver(None) => break,
            }
        }
    }
}

#[cfg(test)]
mod tests;
