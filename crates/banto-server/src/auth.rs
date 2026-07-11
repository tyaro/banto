//! Token-based authentication for the embedded server (spec §11.2).
//!
//! There is no secure-cookie story for a plain-HTTP LAN server, so the
//! bearer token is handed back in the login response body and the frontend
//! is responsible for attaching `Authorization: Bearer <token>` on every
//! subsequent request (mirrors `HttpDataProvider`'s planned wire contract,
//! spec §3.2/§11.1).
//!
//! Two hardening measures live here beyond plain "is this token known":
//!
//! - **Token expiry** ([`TokenPolicy`]): tokens carry an issue time and a
//!   last-used time and are invalidated once they exceed either an absolute
//!   lifetime (default 8h) or an idle timeout (default 1h, refreshed on every
//!   `verify`/`identity_for`). Without this a session lives forever until an
//!   explicit `logout`, and abandoned sessions accumulate in memory unbounded.
//!   Each token individually opts into a second, much longer-lived policy
//!   (spec M11 "LAN Remember me"): a token issued with `remember: true` is
//!   evaluated against `AuthState`'s `remembered_policy` (default 30d
//!   absolute / 7d idle) instead of the regular `token_policy` for the rest
//!   of its life - see [`TokenRecord::remembered`].
//! - **Login rate limiting** ([`RateLimitPolicy`]): consecutive failed
//!   `POST /api/auth/login` attempts, keyed by client IP + username, trip a
//!   short lockout (default: 5 failures -> 60s). Because credential
//!   verification runs a deliberately expensive argon2id hash (spec §8.2), an
//!   unthrottled login endpoint is also a CPU-exhaustion DoS vector, not just
//!   a brute-force one.
//!
//! Expired tokens and stale failure records are reaped lazily (on lookup) and
//! opportunistically (a cheap sweep on each write); there is deliberately no
//! background reaper task, to keep this a plain library type with no owned
//! runtime.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use banto_core::ErrorBody;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identity returned by `GET /api/auth/identity` (spec §3.3). Mirrors
/// `packages/admin-core/src/provider.ts::Identity`.
///
/// Convention: `id` is the account's `username` (not a numeric row id) -
/// both the REST layer (`admin-template-core::rest`) and the `src-tauri`
/// adapter rely on this to recover "which account is this session for"
/// (e.g. for `change-password`) from nothing but the `Identity` a session
/// is keyed on.
///
/// `role` (spec M10 RBAC) is carried as a plain string, not an enum:
/// `banto-server` is resource/policy-agnostic (see this module's doc
/// comment) and has no `Role` type of its own - it just ferries whatever
/// the app crate's credential verifier put here back out again. Callers
/// that need to make a decision based on it (`admin-template-core::rest`'s
/// role-guard middleware, `src-tauri`'s `require_role`) parse it into their
/// own `Role` type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub role: String,
}

/// Verifies a `username`/`password` pair against whatever credential store
/// the app crate wires in (spec §8.2), asynchronously (a real store is a
/// database lookup + password hash verification, both of which may need to
/// `.await`). Returns the session [`Identity`] on success.
///
/// Boxed owned-`String` arguments (rather than `&str` + a lifetime) keep
/// this object-safe/`'static` without extra lifetime plumbing: the request
/// body the credentials come from is already owned by the time a handler
/// calls this.
pub type CredentialVerifier =
    Arc<dyn Fn(String, String) -> BoxFuture<'static, Option<Identity>> + Send + Sync>;

/// Session-token lifetime policy (spec §11.2). Both bounds are enforced on
/// every lookup ([`AuthState::verify`]/[`AuthState::identity_for`]):
///
/// - `absolute_ttl`: hard cap measured from the token's issue time; refresh
///   activity cannot extend a token past this.
/// - `idle_ttl`: sliding window measured from the token's last use; each
///   successful lookup resets it, so an actively-used session stays alive
///   (up to `absolute_ttl`) while an abandoned one lapses.
#[derive(Debug, Clone, Copy)]
pub struct TokenPolicy {
    pub absolute_ttl: Duration,
    pub idle_ttl: Duration,
}

impl Default for TokenPolicy {
    /// 8h absolute / 1h idle - a full working session, but a laptop left
    /// open overnight (or a walked-away-from browser) does not stay logged
    /// in indefinitely.
    fn default() -> Self {
        Self {
            absolute_ttl: Duration::from_secs(8 * 60 * 60),
            idle_ttl: Duration::from_secs(60 * 60),
        }
    }
}

impl TokenPolicy {
    /// 30-day absolute / 7-day idle - the "Remember me" policy (spec M11):
    /// long-lived enough that a LAN browser client stays logged in across
    /// restarts for weeks, but still bounded (unlike no expiry at all) so a
    /// token that leaked or was simply forgotten about does not grant access
    /// forever, and idle enough to lapse if the client genuinely stops
    /// using it.
    pub fn remembered_default() -> Self {
        Self {
            absolute_ttl: Duration::from_secs(30 * 24 * 60 * 60),
            idle_ttl: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }
}

/// Login failed-attempt throttling policy (spec §11.2). Failures are counted
/// per key (client IP + username, see [`rate_limit_key`]); reaching
/// `max_failures` consecutive failures starts a `lockout`-long window during
/// which further attempts are rejected without even running the (expensive)
/// credential check. A single success clears the counter.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitPolicy {
    pub max_failures: u32,
    pub lockout: Duration,
}

impl Default for RateLimitPolicy {
    /// 5 strikes, then a 60s cool-off: long enough to make online
    /// brute-forcing / argon2 CPU-flooding impractical, short enough that a
    /// user who genuinely fat-fingered their password five times is not
    /// locked out for long.
    fn default() -> Self {
        Self {
            max_failures: 5,
            lockout: Duration::from_secs(60),
        }
    }
}

/// Result of a rate-limited login attempt ([`AuthState::login_rate_limited`]).
/// The three variants map onto the three login-handler responses: a bearer
/// token, a plain "wrong credentials" 200, or a 429 lockout.
#[derive(Debug)]
pub enum LoginOutcome {
    /// Credentials verified; carries a freshly-issued bearer token.
    Success(String),
    /// Credentials rejected (and this failure was counted toward the lockout
    /// threshold).
    InvalidCredentials,
    /// The key is currently locked out; `retry_after` is how long until it
    /// may try again. The credential check was NOT run.
    RateLimited { retry_after: Duration },
}

/// One stored session token: the identity it authenticates plus the two
/// timestamps [`TokenPolicy`] is evaluated against. Times are measured on
/// [`Clock`]'s monotonic scale (a `Duration` since the state was created).
struct TokenRecord {
    identity: Identity,
    issued_at: Duration,
    last_used: Duration,
    /// Whether this particular token was issued with "Remember me" (spec
    /// M11): if so, it is evaluated against `AuthState`'s `remembered_policy`
    /// instead of its regular `token_policy` for the rest of its life. This
    /// lives on the token, not on the login/identity, so a single account can
    /// have both a short-lived desktop session and a long-lived "remembered"
    /// LAN browser session live at the same time.
    remembered: bool,
}

impl TokenRecord {
    /// Has this token exceeded either bound of `policy` as of `now`?
    fn is_expired(&self, now: Duration, policy: &TokenPolicy) -> bool {
        now.saturating_sub(self.issued_at) >= policy.absolute_ttl
            || now.saturating_sub(self.last_used) >= policy.idle_ttl
    }
}

/// Per-key failed-login bookkeeping for [`RateLimitPolicy`].
struct FailureRecord {
    /// Consecutive failures since the last success/reset.
    count: u32,
    /// End of the active lockout, if the threshold has been reached.
    locked_until: Option<Duration>,
    /// Time of the most recent failure, used to age out stale entries so the
    /// map does not grow without bound and so a long-ago streak does not
    /// count against a much later attempt.
    last_failure: Duration,
}

impl FailureRecord {
    /// Should this record be kept during a sweep as of `now`? Keep it while a
    /// lockout is still in force, or while its last failure is recent enough
    /// (within one `lockout` window) to still count toward the streak.
    fn is_live(&self, now: Duration, policy: &RateLimitPolicy) -> bool {
        if let Some(until) = self.locked_until {
            if until > now {
                return true;
            }
        }
        now.saturating_sub(self.last_failure) < policy.lockout
    }
}

/// Monotonic clock injected into [`AuthState`] so tests can advance time
/// deterministically instead of sleeping. Production always uses
/// [`Clock::real`], which reports elapsed time since construction; the
/// manually-advanced variant is only constructible under `#[cfg(test)]`.
struct Clock {
    /// Anchor captured at construction; the real clock reports time relative
    /// to this so `now()` is a small monotonic `Duration`.
    base: Instant,
    /// When present, `now()` returns this stored value (advanced by tests)
    /// instead of reading the wall clock.
    #[cfg(test)]
    frozen: Option<RwLock<Duration>>,
}

impl Clock {
    fn real() -> Self {
        Self {
            base: Instant::now(),
            #[cfg(test)]
            frozen: None,
        }
    }

    /// Current time on this clock's monotonic scale.
    fn now(&self) -> Duration {
        #[cfg(test)]
        if let Some(frozen) = &self.frozen {
            return *frozen.read().expect("auth clock lock poisoned");
        }
        self.base.elapsed()
    }

    #[cfg(test)]
    fn frozen() -> Self {
        Self {
            base: Instant::now(),
            frozen: Some(RwLock::new(Duration::ZERO)),
        }
    }

    #[cfg(test)]
    fn advance(&self, by: Duration) {
        let frozen = self
            .frozen
            .as_ref()
            .expect("advance() called on a real clock");
        *frozen.write().expect("auth clock lock poisoned") += by;
    }
}

struct Inner {
    tokens: RwLock<HashMap<String, TokenRecord>>,
    failures: RwLock<HashMap<String, FailureRecord>>,
    verify_credentials: CredentialVerifier,
    token_policy: TokenPolicy,
    /// Long-lived policy applied to tokens issued with "Remember me" (spec
    /// M11) instead of `token_policy` - see [`TokenRecord::remembered`].
    remembered_policy: TokenPolicy,
    rate_limit: RateLimitPolicy,
    clock: Clock,
}

/// Shared, cloneable auth state: an in-memory map of valid bearer tokens to
/// the [`Identity`] that logged in with them (each with expiry bookkeeping),
/// a per-key failed-login counter, and an injected async credential verifier.
/// Cloning is cheap (`Arc` handle).
#[derive(Clone)]
pub struct AuthState {
    inner: Arc<Inner>,
}

impl AuthState {
    /// Build a new [`AuthState`] with the default [`TokenPolicy`] and
    /// [`RateLimitPolicy`]. `verify_credentials` decides whether a
    /// `username`/`password` pair may log in and, if so, which [`Identity`]
    /// the resulting session belongs to.
    pub fn new(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self::with_policy(
            verify_credentials,
            TokenPolicy::default(),
            RateLimitPolicy::default(),
        )
    }

    /// Like [`AuthState::new`], but with explicit token-expiry and
    /// login-rate-limit policies (spec §11.2). Callers that need non-default
    /// session lifetimes or lockout thresholds use this; everything else
    /// stays on [`AuthState::new`]'s defaults. The "Remember me" policy
    /// (spec M11) stays on [`TokenPolicy::remembered_default`] - use
    /// [`AuthState::with_policies`] to also override that.
    pub fn with_policy(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        token_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::with_policies(
            verify_credentials,
            token_policy,
            TokenPolicy::remembered_default(),
            rate_limit,
        )
    }

    /// Like [`AuthState::with_policy`], but also lets the caller override the
    /// "Remember me" policy (spec M11) applied to tokens issued with
    /// `remember: true` instead of [`TokenPolicy::remembered_default`].
    pub fn with_policies(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::build(
            Arc::new(verify_credentials),
            token_policy,
            remembered_policy,
            rate_limit,
            Clock::real(),
        )
    }

    fn build(
        verify_credentials: CredentialVerifier,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
        clock: Clock,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                tokens: RwLock::new(HashMap::new()),
                failures: RwLock::new(HashMap::new()),
                verify_credentials,
                token_policy,
                remembered_policy,
                rate_limit,
                clock,
            }),
        }
    }

    /// Verify credentials and, on success, mint and store a new uuid-v4
    /// bearer token bound to the returned identity. Returns `None` on bad
    /// credentials.
    ///
    /// This is the un-throttled, trusted-caller path (used programmatically
    /// and in tests): it does NOT consult the login rate limiter. The
    /// network-exposed `POST /api/auth/login` handler goes through
    /// [`AuthState::login_rate_limited`] instead, since that is the surface an
    /// attacker can flood.
    pub async fn login(&self, username: &str, password: &str) -> Option<String> {
        let identity =
            (self.inner.verify_credentials)(username.to_string(), password.to_string()).await?;
        Some(self.issue_token(identity))
    }

    /// Rate-limited credential check for the login endpoint (spec §11.2).
    /// `key` identifies the caller for lockout purposes (see
    /// [`rate_limit_key`]). Order matters: the lockout is checked *before* the
    /// expensive credential verifier runs, so a locked-out key cannot be used
    /// to keep argon2 busy. A success clears the key's failure streak; a
    /// failure adds to it (and may start a lockout).
    ///
    /// `remember` (spec M11 "LAN Remember me"): when `true`, the issued token
    /// is evaluated against `remembered_policy` (long-lived) instead of the
    /// regular `token_policy` for the rest of its life - see
    /// [`TokenRecord::remembered`].
    pub async fn login_rate_limited(
        &self,
        key: &str,
        username: &str,
        password: &str,
        remember: bool,
    ) -> LoginOutcome {
        if let Some(retry_after) = self.locked_out(key) {
            return LoginOutcome::RateLimited { retry_after };
        }

        match (self.inner.verify_credentials)(username.to_string(), password.to_string()).await {
            Some(identity) => {
                self.reset_failures(key);
                LoginOutcome::Success(self.issue_token_with(identity, remember))
            }
            None => {
                self.record_failure(key);
                LoginOutcome::InvalidCredentials
            }
        }
    }

    /// Mint and store a new bearer token for an already-verified `identity`,
    /// without going through `verify_credentials` again. Used by callers
    /// that just created/authenticated an account through some other path
    /// (e.g. the REST `/api/auth/setup` handler, right after
    /// `UsersService::setup_first_user` succeeds) and want to log the new
    /// session in immediately, the same way `login` would. Not "remembered"
    /// (spec M11) - use [`AuthState::issue_token_remembered`] for that.
    pub fn issue_token(&self, identity: Identity) -> String {
        self.issue_token_with(identity, false)
    }

    /// Like [`AuthState::issue_token`], but the token is issued as
    /// "remembered" (spec M11 "LAN Remember me"): it is evaluated against
    /// `remembered_policy` instead of `token_policy` for the rest of its
    /// life.
    pub fn issue_token_remembered(&self, identity: Identity) -> String {
        self.issue_token_with(identity, true)
    }

    /// Shared implementation of [`AuthState::issue_token`]/
    /// [`AuthState::issue_token_remembered`]/[`AuthState::login_rate_limited`].
    ///
    /// Opportunistically sweeps already-expired tokens under the same write
    /// lock, so the map stays bounded without a background reaper. Each
    /// existing record is checked against whichever policy applies to IT
    /// (its own `remembered` flag), not the policy of the token being
    /// inserted.
    fn issue_token_with(&self, identity: Identity, remembered: bool) -> String {
        let token = Uuid::new_v4().to_string();
        let now = self.inner.clock.now();
        let token_policy = self.inner.token_policy;
        let remembered_policy = self.inner.remembered_policy;
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        tokens.retain(|_, record| {
            let policy = if record.remembered {
                &remembered_policy
            } else {
                &token_policy
            };
            !record.is_expired(now, policy)
        });
        tokens.insert(
            token.clone(),
            TokenRecord {
                identity,
                issued_at: now,
                last_used: now,
                remembered,
            },
        );
        token
    }

    /// Is `token` a currently-valid, unexpired bearer token? A successful
    /// check refreshes the token's idle timer (spec §11.2); an expired token
    /// is removed as a side effect.
    pub fn verify(&self, token: &str) -> bool {
        self.touch(token).is_some()
    }

    /// Invalidate `token` (idempotent: logging out twice is not an error).
    pub fn logout(&self, token: &str) {
        self.inner
            .tokens
            .write()
            .expect("auth token lock poisoned")
            .remove(token);
    }

    /// The [`Identity`] bound to `token`, or `None` if it is not a
    /// currently-valid, unexpired token. Refreshes the idle timer on success
    /// (same as [`AuthState::verify`]). Exposed (beyond what the `/api/auth/*`
    /// routes below need) so other routers built in the app crate - e.g.
    /// `admin-template-core::rest`'s `/api/auth/change-password` - can
    /// recover "which account is this request for" from the same bearer
    /// token `require_auth` already validated.
    pub fn identity_for(&self, token: &str) -> Option<Identity> {
        self.touch(token)
    }

    /// Shared lookup for [`verify`](Self::verify)/[`identity_for`](Self::identity_for):
    /// return the identity behind a live token and slide its idle window
    /// forward, or evict it and return `None` if it has expired. Takes a
    /// write lock (not a read lock) precisely because the idle-timer refresh
    /// mutates the record - an acceptable cost for a single-host LAN server.
    ///
    /// Which [`TokenPolicy`] applies is decided per-token by its own
    /// `remembered` flag (spec M11), not by a single state-wide policy.
    fn touch(&self, token: &str) -> Option<Identity> {
        let now = self.inner.clock.now();
        let token_policy = self.inner.token_policy;
        let remembered_policy = self.inner.remembered_policy;
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");

        let expired = {
            let record = tokens.get(token)?;
            let policy = if record.remembered {
                &remembered_policy
            } else {
                &token_policy
            };
            record.is_expired(now, policy)
        };

        if expired {
            tokens.remove(token);
            None
        } else {
            let record = tokens
                .get_mut(token)
                .expect("token was just confirmed present");
            record.last_used = now;
            Some(record.identity.clone())
        }
    }

    /// If `key` is currently locked out, how long until it may retry;
    /// otherwise `None`.
    fn locked_out(&self, key: &str) -> Option<Duration> {
        let now = self.inner.clock.now();
        let failures = self
            .inner
            .failures
            .read()
            .expect("auth failure lock poisoned");
        failures.get(key).and_then(|record| {
            record
                .locked_until
                .filter(|until| *until > now)
                .map(|until| until - now)
        })
    }

    /// Record a failed attempt for `key`, starting a lockout once the streak
    /// reaches [`RateLimitPolicy::max_failures`]. Sweeps aged-out records
    /// under the same write lock.
    fn record_failure(&self, key: &str) {
        let now = self.inner.clock.now();
        let policy = self.inner.rate_limit;
        let mut failures = self
            .inner
            .failures
            .write()
            .expect("auth failure lock poisoned");
        failures.retain(|_, record| record.is_live(now, &policy));

        let record = failures.entry(key.to_string()).or_insert(FailureRecord {
            count: 0,
            locked_until: None,
            last_failure: now,
        });

        // An expired lockout, or a gap longer than the window since the last
        // failure, ends the previous streak so counting restarts cleanly.
        let lock_expired = record.locked_until.is_some_and(|until| until <= now);
        let streak_stale = now.saturating_sub(record.last_failure) >= policy.lockout;
        if lock_expired || streak_stale {
            record.count = 0;
            record.locked_until = None;
        }

        record.count += 1;
        record.last_failure = now;
        if record.count >= policy.max_failures {
            record.locked_until = Some(now + policy.lockout);
        }
    }

    /// Clear `key`'s failure streak after a successful login.
    fn reset_failures(&self, key: &str) {
        self.inner
            .failures
            .write()
            .expect("auth failure lock poisoned")
            .remove(key);
    }

    #[cfg(test)]
    fn with_frozen_clock(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::build(
            Arc::new(verify_credentials),
            token_policy,
            remembered_policy,
            rate_limit,
            Clock::frozen(),
        )
    }

    #[cfg(test)]
    fn advance(&self, by: Duration) {
        self.inner.clock.advance(by);
    }
}

/// Lockout key for a login attempt (spec §11.2): client IP + username when
/// the peer address is known, falling back to username-only when it is not
/// (e.g. a caller that did not wire up `ConnectInfo`). Keying on the pair
/// (rather than IP alone) avoids one noisy client on a shared NAT locking out
/// every account behind it, while still binding the streak to a network
/// origin when available.
pub fn rate_limit_key(ip: Option<IpAddr>, username: &str) -> String {
    match ip {
        Some(ip) => format!("{ip}|{username}"),
        None => format!("-|{username}"),
    }
}

/// The connection's peer address, as an extractor that never rejects. Yields
/// `Some` when the server was started with
/// `into_make_service_with_connect_info::<SocketAddr>()` (production, see
/// `server::start`), and `None` otherwise - notably `tower`'s `oneshot` in
/// tests, which serves a router with no connect-info layer. axum 0.8's
/// [`ConnectInfo`] is only a required extractor (there is no
/// `Option<ConnectInfo<..>>`), so the login handler wraps it here rather than
/// failing the whole request when the peer address is unavailable.
struct MaybePeerAddr(Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for MaybePeerAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(MaybePeerAddr(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|info| info.0),
        ))
    }
}

fn unauthorized_response() -> Response {
    (StatusCode::UNAUTHORIZED, Json(ErrorBody::Unauthorized)).into_response()
}

fn bearer_token(req: &Request) -> Option<&str> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// Axum middleware: reject the request with `401 { "kind": "unauthorized" }`
/// (banto-core's [`ErrorBody`]) unless `Authorization: Bearer <token>`
/// carries a currently-valid token. Apply with
/// `middleware::from_fn_with_state(auth_state, require_auth)` so the guarded
/// router does not need `AuthState` as its own `State` type (this keeps
/// composition with other routers/state simple, spec §11 rest.rs).
pub async fn require_auth(State(auth): State<AuthState>, req: Request, next: Next) -> Response {
    match bearer_token(&req) {
        Some(token) if auth.verify(token) => next.run(req).await,
        _ => unauthorized_response(),
    }
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
    /// LAN "Remember me" checkbox (spec M11). Defaults to `false` so older
    /// frontend builds that do not send this field at all keep today's
    /// regular-`TokenPolicy` behavior unchanged.
    #[serde(default)]
    remember: bool,
}

#[derive(Debug, Serialize)]
struct LoginResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

/// `POST /api/auth/login` (spec §11.1/§11.2). Three outcomes:
/// - success -> `200 {success:true, token}`.
/// - wrong credentials -> `200 {success:false, error}` (unchanged legacy
///   shape the frontend's `HttpAuthProvider.login` reads directly).
/// - too many recent failures -> `429` with a banto-core [`ErrorBody::Other`]
///   body carrying a Japanese message. `429`'s body is the `{kind,message}`
///   error shape (not `LoginResponse`) on purpose: the frontend treats any
///   non-2xx as an error and surfaces `ErrorBody::message`, so the lockout
///   reason reaches the user as `{success:false, error}` without any frontend
///   change (`packages/admin-core/src/providers/http.ts`).
///
/// The peer address (for the lockout key) comes from `ConnectInfo`, made
/// optional so callers that serve without
/// `into_make_service_with_connect_info` (e.g. `tower`'s `oneshot` in tests)
/// still work - they simply fall back to a username-only lockout key.
async fn login_handler(
    State(auth): State<AuthState>,
    MaybePeerAddr(peer): MaybePeerAddr,
    Json(body): Json<LoginRequest>,
) -> Response {
    let key = rate_limit_key(peer.map(|addr| addr.ip()), &body.username);
    match auth
        .login_rate_limited(&key, &body.username, &body.password, body.remember)
        .await
    {
        LoginOutcome::Success(token) => Json(LoginResponse {
            success: true,
            error: None,
            token: Some(token),
        })
        .into_response(),
        LoginOutcome::InvalidCredentials => Json(LoginResponse {
            success: false,
            error: Some("ユーザー名またはパスワードが違います".to_string()),
            token: None,
        })
        .into_response(),
        LoginOutcome::RateLimited { retry_after } => {
            let seconds = retry_after.as_secs().max(1);
            let message = format!(
                "ログインの失敗が続いたため、一時的にロックされています。約{seconds}秒後にもう一度お試しください。"
            );
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, seconds.to_string())],
                Json(ErrorBody::Other { message }),
            )
                .into_response()
        }
    }
}

async fn logout_handler(State(auth): State<AuthState>, req: Request) -> StatusCode {
    if let Some(token) = bearer_token(&req) {
        auth.logout(token);
    }
    StatusCode::OK
}

async fn check_handler(State(auth): State<AuthState>, req: Request) -> Json<bool> {
    let ok = bearer_token(&req).is_some_and(|token| auth.verify(token));
    Json(ok)
}

async fn identity_handler(State(auth): State<AuthState>, req: Request) -> Json<Option<Identity>> {
    let identity = bearer_token(&req).and_then(|token| auth.identity_for(token));
    Json(identity)
}

/// Build the `/api/auth/*` routes (spec §11, mirrors `src-tauri`'s
/// `auth_login`/`auth_logout`/`auth_check`/`auth_identity` commands and
/// `packages/admin-core/src/provider.ts::AuthProvider`):
///
/// - `POST /api/auth/login` — `{ username, password, remember? }` -> `{ success, error?, token? }`.
///   The token travels in the JSON body (not a cookie) since a LAN HTTP
///   server has no secure-cookie story; the frontend stores it and attaches
///   it as `Authorization: Bearer <token>` on every other request. Repeated
///   failures are rate-limited to a `429` (spec §11.2, see [`login_handler`]).
///   `remember` (spec M11, defaults to `false` when omitted) issues a
///   long-lived token evaluated against [`AuthState`]'s `remembered_policy`
///   instead of its regular `token_policy` (see [`TokenPolicy::remembered_default`]).
/// - `POST /api/auth/logout` — invalidates the bearer token on the request.
/// - `GET /api/auth/check` — `bool`, whether the bearer token is valid.
/// - `GET /api/auth/identity` — `Identity | null`.
///
/// First-run account setup (`GET /api/auth/status`, `POST /api/auth/setup`)
/// and `POST /api/auth/change-password` are NOT here: those need the app
/// crate's `UsersService` directly, so they are composed alongside this
/// router in `admin-template-core::rest::api_router` instead (this crate
/// stays resource/credential-store-agnostic).
pub fn auth_routes(auth: AuthState) -> Router {
    Router::new()
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/check", get(check_handler))
        .route("/api/auth/identity", get(identity_handler))
        .with_state(auth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    fn demo_auth() -> AuthState {
        AuthState::new(|u: String, p: String| {
            Box::pin(async move {
                if u == "admin" && p == "admin" {
                    Some(Identity {
                        id: "admin".to_string(),
                        name: "管理者".to_string(),
                        role: "admin".to_string(),
                    })
                } else {
                    None
                }
            })
        })
    }

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn login_wrong_credentials_returns_success_false() {
        let router = auth_routes(demo_auth());
        let response = router
            .oneshot(
                HttpRequest::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"nope"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["success"], false);
        assert!(json["token"].is_null());
    }

    #[tokio::test]
    async fn login_right_credentials_returns_token() {
        let router = auth_routes(demo_auth());
        let response = router
            .oneshot(
                HttpRequest::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"admin"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let json = body_json(response).await;
        assert_eq!(json["success"], true);
        assert!(json["token"].as_str().is_some());
    }

    #[tokio::test]
    async fn logout_invalidates_token() {
        let auth = demo_auth();
        let token = auth
            .login("admin", "admin")
            .await
            .expect("login should succeed");
        assert!(auth.verify(&token));
        auth.logout(&token);
        assert!(!auth.verify(&token));
    }

    #[tokio::test]
    async fn identity_for_returns_the_identity_bound_to_the_token() {
        let auth = demo_auth();
        let token = auth
            .login("admin", "admin")
            .await
            .expect("login should succeed");
        let identity = auth.identity_for(&token).expect("identity should exist");
        assert_eq!(identity.id, "admin");
        assert_eq!(identity.name, "管理者");
    }

    #[tokio::test]
    async fn identity_for_is_none_for_an_invalid_token() {
        let auth = demo_auth();
        assert!(auth.identity_for("not-a-real-token").is_none());
    }

    #[tokio::test]
    async fn issue_token_logs_in_without_calling_verify_credentials() {
        let auth = demo_auth();
        let token = auth.issue_token(Identity {
            id: "owner".to_string(),
            name: "オーナー".to_string(),
            role: "admin".to_string(),
        });
        assert!(auth.verify(&token));
        assert_eq!(auth.identity_for(&token).unwrap().id, "owner");
    }

    // --- Token expiry (spec §11.2) ---------------------------------------

    /// A small, fast policy so the expiry tests read clearly; the clock is
    /// frozen and advanced by hand, so the durations are just relative.
    fn short_token_policy() -> TokenPolicy {
        TokenPolicy {
            absolute_ttl: Duration::from_secs(100),
            idle_ttl: Duration::from_secs(30),
        }
    }

    fn frozen_auth(token_policy: TokenPolicy, rate_limit: RateLimitPolicy) -> AuthState {
        frozen_auth_with_remembered(token_policy, TokenPolicy::remembered_default(), rate_limit)
    }

    /// Like [`frozen_auth`], but also lets a test override the "Remember me"
    /// policy (spec M11) instead of [`TokenPolicy::remembered_default`].
    fn frozen_auth_with_remembered(
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> AuthState {
        AuthState::with_frozen_clock(
            |u: String, p: String| {
                Box::pin(async move {
                    if u == "admin" && p == "admin" {
                        Some(Identity {
                            id: "admin".to_string(),
                            name: "管理者".to_string(),
                            role: "admin".to_string(),
                        })
                    } else {
                        None
                    }
                })
            },
            token_policy,
            remembered_policy,
            rate_limit,
        )
    }

    #[tokio::test]
    async fn token_expires_after_absolute_ttl_even_with_activity() {
        let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
        let token = auth.login("admin", "admin").await.unwrap();

        // Keep "using" it just under the idle timeout each step, so idle
        // expiry never fires - only the absolute cap should eventually kill it.
        // Three steps of 25s = 75s elapsed, all within absolute_ttl (100s).
        for _ in 0..3 {
            auth.advance(Duration::from_secs(25));
            assert!(auth.verify(&token), "should survive within absolute_ttl");
        }
        // One more step: 100s since issue == absolute_ttl. The token is still
        // well within its idle window (last used 25s ago), yet the absolute
        // cap must kill it anyway - activity cannot extend it past this.
        auth.advance(Duration::from_secs(25));
        assert!(!auth.verify(&token), "should be dead past absolute_ttl");
    }

    #[tokio::test]
    async fn token_expires_after_idle_timeout() {
        let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
        let token = auth.login("admin", "admin").await.unwrap();

        auth.advance(Duration::from_secs(31)); // > idle_ttl, no use in between
        assert!(!auth.verify(&token), "should lapse after idle_ttl");
    }

    #[tokio::test]
    async fn verify_refreshes_the_idle_window() {
        let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
        let token = auth.login("admin", "admin").await.unwrap();

        // Use it every 20s (< 30s idle_ttl): the sliding window keeps
        // resetting, so it stays alive well past a single idle period.
        for _ in 0..3 {
            auth.advance(Duration::from_secs(20));
            assert!(auth.verify(&token));
        }
        // Now go quiet past the idle timeout -> lapses.
        auth.advance(Duration::from_secs(31));
        assert!(!auth.verify(&token));
    }

    #[tokio::test]
    async fn issue_token_sweeps_expired_tokens() {
        let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
        let stale = auth.login("admin", "admin").await.unwrap();

        auth.advance(Duration::from_secs(200)); // well past absolute_ttl
                                                // A write (issuing a fresh token) should opportunistically drop the
                                                // stale one rather than leave it lingering in the map.
        let fresh = auth.issue_token(Identity {
            id: "admin".to_string(),
            name: "管理者".to_string(),
            role: "admin".to_string(),
        });
        assert!(auth.verify(&fresh));
        assert_eq!(
            auth.inner.tokens.read().unwrap().len(),
            1,
            "the expired token should have been swept on write"
        );
        assert!(!auth.inner.tokens.read().unwrap().contains_key(&stale));
    }

    // --- Login rate limiting (spec §11.2) --------------------------------

    /// Auth state whose verifier counts how many times it actually ran, so a
    /// test can prove a locked-out attempt short-circuits *before* the
    /// (expensive) credential check.
    fn counting_auth(rate_limit: RateLimitPolicy) -> (AuthState, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let auth = AuthState::with_frozen_clock(
            move |u: String, p: String| {
                let counter = counter.clone();
                Box::pin(async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    if u == "admin" && p == "admin" {
                        Some(Identity {
                            id: "admin".to_string(),
                            name: "管理者".to_string(),
                            role: "admin".to_string(),
                        })
                    } else {
                        None
                    }
                })
            },
            TokenPolicy::default(),
            TokenPolicy::remembered_default(),
            rate_limit,
        );
        (auth, calls)
    }

    #[tokio::test]
    async fn login_locks_out_after_max_consecutive_failures() {
        let policy = RateLimitPolicy {
            max_failures: 3,
            lockout: Duration::from_secs(60),
        };
        let (auth, calls) = counting_auth(policy);
        let key = rate_limit_key(None, "admin");

        for _ in 0..3 {
            assert!(matches!(
                auth.login_rate_limited(&key, "admin", "wrong", false).await,
                LoginOutcome::InvalidCredentials
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3, "3 real checks so far");

        // The 4th attempt is locked out and must NOT run the verifier.
        match auth.login_rate_limited(&key, "admin", "wrong", false).await {
            LoginOutcome::RateLimited { retry_after } => {
                assert!(retry_after <= Duration::from_secs(60));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "locked-out attempt must short-circuit the verifier"
        );

        // Even the CORRECT password is refused while locked out.
        assert!(matches!(
            auth.login_rate_limited(&key, "admin", "admin", false).await,
            LoginOutcome::RateLimited { .. }
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn lockout_expires_after_the_cooloff() {
        let policy = RateLimitPolicy {
            max_failures: 3,
            lockout: Duration::from_secs(60),
        };
        let (auth, _calls) = counting_auth(policy);
        let key = rate_limit_key(None, "admin");

        for _ in 0..3 {
            auth.login_rate_limited(&key, "admin", "wrong", false).await;
        }
        assert!(matches!(
            auth.login_rate_limited(&key, "admin", "admin", false).await,
            LoginOutcome::RateLimited { .. }
        ));

        auth.advance(Duration::from_secs(61)); // ride out the cool-off
        match auth.login_rate_limited(&key, "admin", "admin", false).await {
            LoginOutcome::Success(token) => assert!(auth.verify(&token)),
            other => panic!("expected Success after cool-off, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn success_resets_the_failure_streak() {
        let policy = RateLimitPolicy {
            max_failures: 3,
            lockout: Duration::from_secs(60),
        };
        let (auth, _calls) = counting_auth(policy);
        let key = rate_limit_key(None, "admin");

        // Two failures (one short of the threshold)...
        auth.login_rate_limited(&key, "admin", "wrong", false).await;
        auth.login_rate_limited(&key, "admin", "wrong", false).await;
        // ...then a success clears the streak.
        assert!(matches!(
            auth.login_rate_limited(&key, "admin", "admin", false).await,
            LoginOutcome::Success(_)
        ));
        // Two more failures should NOT lock out (streak restarted at 0).
        auth.login_rate_limited(&key, "admin", "wrong", false).await;
        assert!(matches!(
            auth.login_rate_limited(&key, "admin", "wrong", false).await,
            LoginOutcome::InvalidCredentials
        ));
    }

    // --- Remember me (spec M11) --------------------------------------------

    #[tokio::test]
    async fn remembered_token_survives_the_regular_absolute_ttl_but_not_forever() {
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let key = rate_limit_key(None, "admin");

        let token = match auth.login_rate_limited(&key, "admin", "admin", true).await {
            LoginOutcome::Success(token) => token,
            other => panic!("expected Success, got {other:?}"),
        };

        // Well past the regular 8h absolute_ttl - a non-remembered token
        // would be dead by now (see `token_expires_after_absolute_ttl_even_with_activity`).
        auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
        assert!(
            auth.verify(&token),
            "remember:true should survive past the regular TokenPolicy's absolute_ttl"
        );

        // But it is not immortal: past the remembered policy's own absolute
        // bound, it must lapse too.
        auth.advance(TokenPolicy::remembered_default().absolute_ttl);
        assert!(
            !auth.verify(&token),
            "remembered tokens must still expire at their own absolute_ttl"
        );
    }

    #[tokio::test]
    async fn non_remembered_login_still_uses_the_regular_policy() {
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let key = rate_limit_key(None, "admin");

        let token = match auth.login_rate_limited(&key, "admin", "admin", false).await {
            LoginOutcome::Success(token) => token,
            other => panic!("expected Success, got {other:?}"),
        };

        auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
        assert!(
            !auth.verify(&token),
            "remember:false (the default) must still expire at the regular absolute_ttl"
        );
    }

    #[tokio::test]
    async fn login_handler_remember_true_issues_a_long_lived_token() {
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let router = auth_routes(auth.clone());

        let response = router
            .oneshot(
                HttpRequest::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"username":"admin","password":"admin","remember":true}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let json = body_json(response).await;
        assert_eq!(json["success"], true);
        let token = json["token"].as_str().expect("token").to_string();

        auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
        assert!(
            auth.verify(&token),
            "POST /api/auth/login with remember:true should issue a remembered token"
        );
    }

    #[tokio::test]
    async fn login_handler_omitting_remember_defaults_to_false() {
        // No `remember` field at all (older-frontend-shaped request body) -
        // must behave exactly like the pre-M11 wire contract.
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let router = auth_routes(auth.clone());

        let response = router
            .oneshot(
                HttpRequest::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"admin","password":"admin"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let token = body_json(response).await["token"]
            .as_str()
            .expect("token")
            .to_string();

        auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
        assert!(
            !auth.verify(&token),
            "omitting remember must default to false (regular policy)"
        );
    }

    #[tokio::test]
    async fn login_handler_returns_429_after_lockout() {
        let policy = RateLimitPolicy {
            max_failures: 2,
            lockout: Duration::from_secs(60),
        };
        let auth = frozen_auth(TokenPolicy::default(), policy);
        let router = auth_routes(auth);

        let bad = || {
            HttpRequest::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"admin","password":"nope"}"#))
                .unwrap()
        };

        // Two failures reach the threshold (max_failures: 2).
        for _ in 0..2 {
            let r = router.clone().oneshot(bad()).await.unwrap();
            assert_eq!(r.status(), StatusCode::OK);
        }
        // The next attempt is locked out -> 429 with an ErrorBody the
        // frontend already knows how to surface.
        let locked = router.clone().oneshot(bad()).await.unwrap();
        assert_eq!(locked.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(locked.headers().contains_key(header::RETRY_AFTER));
        let json = body_json(locked).await;
        assert_eq!(json["kind"], "other");
        assert!(json["message"].as_str().unwrap().contains("ロック"));
    }

    #[test]
    fn rate_limit_key_distinguishes_ip_and_username() {
        let with_ip = rate_limit_key(Some("192.168.0.5".parse().unwrap()), "admin");
        let without = rate_limit_key(None, "admin");
        assert_eq!(with_ip, "192.168.0.5|admin");
        assert_eq!(without, "-|admin");
        assert_ne!(with_ip, without);
    }
}
