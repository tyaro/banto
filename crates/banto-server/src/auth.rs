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
//!   `POST /api/auth/login` attempts trip a short lockout (default 60s) along
//!   two dimensions - per (IP + username) at 5 failures, and per IP alone at
//!   20 failures. Because credential verification runs a deliberately
//!   expensive argon2id hash even for an unknown username (spec §8.2's
//!   dummy-hash timing defense), an unthrottled login endpoint is also a
//!   CPU-exhaustion DoS, not just a brute-force one; the per-IP dimension is
//!   what stops that from being evaded by rotating the `username` field (see
//!   [`RateLimitPolicy`]).
//!
//! Expired tokens and stale failure records are reaped lazily (on lookup) and
//! opportunistically (a cheap sweep on each write); there is deliberately no
//! background reaper task, to keep this a plain library type with no owned
//! runtime.
//!
//! ## Synthetic viewer sessions (LAN 閲覧公開, Issue #189)
//!
//! [`AuthState::issue_public_viewer_token`] mints a bearer token bound to the
//! fixed identity `{ id: "public", name: "public", role: "viewer" }`
//! ([`PUBLIC_VIEWER_ID`]) with no credentials at all - it is what
//! `POST /api/auth/public-viewer` hands a LAN client when
//! `server.viewer_public` is ON (ADR-0012, conventions §6). Three properties
//! matter and are asserted by this module's tests:
//!
//! - It takes NO identity/role argument, so there is no escalation path: a
//!   public viewer token can only ever be `viewer`.
//! - Issuance is uncredentialed and therefore free to repeat, so the public
//!   tokens are additionally held in a bounded FIFO capped at
//!   [`MAX_PUBLIC_VIEWER_SESSIONS`] - minting past the cap evicts the OLDEST
//!   public token (issuance itself never fails, so a tablet reloading its
//!   page never gets stuck). Only public tokens are evicted this way; real
//!   login sessions are untouched.
//! - `logout` of a public token revokes only that token, exactly like any
//!   other session, so one wall display signing out never blanks the others.
//!
//! ## Account-bound sessions (Issue #204)
//!
//! A token on its own only proves "this account logged in once". Deleting,
//! demoting or re-keying the account must end that session, across every
//! process that shares the account store (the Tauri app's embedded server,
//! `banto-serve`, several servers on one PostgreSQL) and without a restart.
//! So a session is additionally bound to a [`SessionStamp`] - the account's
//! stable row id plus its current *authentication epoch*, a counter the
//! credential store increments whenever existing sessions must end - and,
//! with [`SessionValidation::Lookup`] (a required constructor argument),
//! every authenticated request re-reads the account through the
//! [`SessionLookup`] ([`AuthState::authenticate`], which [`require_auth`]
//! runs):
//!
//! - account missing, or a different stamp -> the token is revoked and the
//!   request gets `401`;
//! - otherwise the CURRENT identity (display name, role) from the store is
//!   what the request is authorized with, and the token's cached copy is
//!   refreshed to it for the synchronous [`AuthState::identity_for`] readers
//!   that run after [`require_auth`];
//! - the store failing to answer is an error response, not a revocation
//!   (a DB hiccup must not log everyone out), and not a pass either.
//!
//! The stamp is captured BEFORE the credential check at login
//! ([`AuthState::login_rate_limited`]), so a change that commits while a
//! login is in flight leaves the new token with a stale stamp - it is
//! rejected on first use rather than outliving the change. Tokens minted
//! without a stamp ([`AuthState::issue_token`]) are rejected while a lookup is
//! installed (fail closed); callers that create an account and log it in
//! directly use [`AuthState::issue_account_token`]. There is deliberately no
//! cache in front of the lookup: it is one indexed read per request, and a
//! cache would re-open exactly the window this closes. Synthetic public
//! viewer sessions have no account and are not looked up.
//!
//! Every constructor takes the [`SessionValidation`] explicitly, so an
//! application cannot end up without revocation by omission (upgrading from
//! the one-argument `AuthState::new` is a compile error, not a silent
//! downgrade). [`SessionValidation::DisabledNoRevocation`] keeps the pre-#204
//! behavior of trusting the identity captured at login until the token
//! expires, and exists only for states with no account store behind them.

use std::collections::{HashMap, VecDeque};
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
use banto_core::{BantoError, ErrorBody};
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

/// `Identity.id` (and `name`) of every synthetic LAN 閲覧公開 viewer session
/// (Issue #189, ADR-0012, conventions §6). Real accounts may share this
/// username, so this is a display/audit label, never a session discriminator.
/// `GET /api/auth/identity` exposes issuance metadata as `publicViewer` (#209).
pub const PUBLIC_VIEWER_ID: &str = "public";

/// Upper bound on simultaneously-live synthetic viewer sessions
/// (`docs/viewer-public-plan.md` §2.2). Minting one needs no credentials, so
/// without a cap a LAN client could grow the token map without bound; a cap
/// (rather than a rate limit) is the right shape because issuance is cheap and
/// legitimate - a wall display reloading its page must never be refused, so
/// reaching the cap evicts the OLDEST public token instead of failing.
/// 256 is far above any plausible number of kiosk screens on one LAN while
/// keeping the map's memory trivially bounded.
pub const MAX_PUBLIC_VIEWER_SESSIONS: usize = 256;

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

/// What a session is bound to besides its identity (Issue #204, see the
/// module doc's "Account-bound sessions"): the account's stable row id and
/// its authentication epoch at the time the session was established. A
/// session stays valid only while the store reports the SAME pair for the
/// account - the id guards against a deleted account's username being
/// reused by a new account, the epoch against every in-place change the
/// store decides should end sessions (role, password, reset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionStamp {
    pub account_id: i64,
    pub auth_epoch: i64,
}

/// The current state of an account as reported by a [`SessionLookup`]:
/// the identity to authorize the request with (its `role` is the account's
/// role NOW, not at login) plus the [`SessionStamp`] to compare against.
#[derive(Debug, Clone)]
pub struct SessionAccount {
    pub identity: Identity,
    pub stamp: SessionStamp,
}

/// Re-reads an account by [`Identity::id`] (the username) from the
/// credential store (Issue #204). `Ok(None)` means the account no longer
/// exists (the session is revoked); `Err` means the store could not answer
/// (the request fails, the session is kept). Passed in as
/// [`SessionValidation::Lookup`]; for `banto-admin-services`'
/// `UsersService` use `crate::routes::user_session_lookup`.
pub type SessionLookup = Arc<
    dyn Fn(String) -> BoxFuture<'static, Result<Option<SessionAccount>, BantoError>> + Send + Sync,
>;

/// How an [`AuthState`] decides that a session is still valid (Issue #204).
/// A required argument of every constructor, so no application ends up
/// without revocation by omission - see the module doc's "Account-bound
/// sessions".
pub enum SessionValidation {
    /// Re-read the account through the [`SessionLookup`] on every
    /// authenticated request: sessions of deleted accounts, and of accounts
    /// whose [`SessionStamp`] changed (role change, password change/reset),
    /// are revoked, and requests are authorized with the account's current
    /// role. **The only choice for states whose sessions belong to real
    /// accounts.**
    ///
    /// At login the lookup receives the username exactly as submitted (it
    /// runs before the verifier, see [`AuthState::login_rate_limited`]); the
    /// login succeeds only when the account it returns is the one the
    /// verifier accepted ([`Identity::id`]). A verifier that normalizes
    /// usernames (trimming, case folding) needs a lookup that accepts the
    /// submitted form too, or such logins report [`LoginOutcome::Unavailable`].
    Lookup(SessionLookup),
    /// **DANGER: no revocation.** Sessions trust the identity (role included)
    /// captured at login until the token expires (up to 30 days with
    /// "Remember me"): deleting, demoting or re-keying the account does NOT
    /// end them. This is the pre-#204 behavior, kept only for states with no
    /// account store behind them - tests with a fixed verifier, or a server
    /// that only ever issues synthetic public viewer sessions. Never use it
    /// for real accounts.
    DisabledNoRevocation,
}

impl SessionValidation {
    /// [`SessionValidation::Lookup`] from a plain closure (wraps it in the
    /// `Arc` [`SessionLookup`] is).
    pub fn lookup(
        lookup: impl Fn(String) -> BoxFuture<'static, Result<Option<SessionAccount>, BantoError>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self::Lookup(Arc::new(lookup))
    }
}

/// A session that passed [`AuthState::authenticate`] (Issue #204): the
/// identity to authorize with - re-read from the account store when a
/// [`SessionLookup`] is installed - whether it is a synthetic public viewer
/// session (#209), and the stamp it is bound to (`None` for public viewer
/// sessions and when no lookup is installed).
///
/// [`require_auth`] inserts this into the request's extensions, so guards and
/// handlers behind it can read the validated identity without a second
/// lookup. Serializes as the `GET /api/auth/identity` body
/// (`Identity & { publicViewer }`); the stamp is internal and never
/// serialized.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedSession {
    #[serde(flatten)]
    pub identity: Identity,
    pub public_viewer: bool,
    #[serde(skip)]
    pub stamp: Option<SessionStamp>,
}

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
/// along TWO independent dimensions, each starting a `lockout`-long window on
/// reaching its threshold (during which attempts are rejected without running
/// the expensive credential check); a success clears both:
///
/// - **per (IP + username)** ([`rate_limit_key`]), threshold `max_failures`:
///   the classic per-account brute-force guard, and NAT-friendly (one noisy
///   client behind a shared address doesn't lock out every account).
/// - **per IP alone** ([`ip_rate_limit_key`]), threshold `max_ip_failures`:
///   counts failures from an address regardless of username. Without this,
///   an attacker on one IP evades the per-account lockout entirely just by
///   varying the `username` field each request - and because credential
///   verification runs a deliberately expensive argon2id hash even for an
///   unknown user (dummy-hash timing defense), that is a CPU/memory
///   exhaustion DoS, not merely brute-force. This dimension bounds argon2
///   invocations per IP. Its threshold is higher than `max_failures` so a
///   shared NAT with several genuinely-fumbling users isn't tripped by
///   normal use.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitPolicy {
    pub max_failures: u32,
    pub max_ip_failures: u32,
    pub lockout: Duration,
}

impl Default for RateLimitPolicy {
    /// 5 per-account strikes / 20 per-IP strikes, then a 60s cool-off. The
    /// per-account count is long enough to make online brute-forcing
    /// impractical, short enough that a user who fat-fingered their password
    /// five times isn't locked out for long. The per-IP count (4x higher)
    /// caps argon2 to ~20 hashes / 60s / IP under a username-rotation flood
    /// while leaving generous headroom for a shared NAT's legitimate misses.
    fn default() -> Self {
        Self {
            max_failures: 5,
            max_ip_failures: 20,
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
    /// Issue #204: the credentials were accepted, but the account's
    /// [`SessionStamp`] could not be established (the [`SessionLookup`]
    /// failed, or the account it read is not the one that verified - it was
    /// created, deleted or replaced while the login was in flight). No token
    /// was issued and the failure streak was NOT extended; the client may
    /// simply retry. Only produced while a lookup is installed.
    Unavailable,
}

/// Result of [`AuthState::verify_and_stamp`] (Issue #204).
enum StampedLogin {
    /// Credentials verified; the stamp is `None` exactly when no
    /// [`SessionLookup`] is installed.
    Accepted(Identity, Option<SessionStamp>),
    /// Credentials rejected.
    Rejected,
    /// Credentials verified, but the account binding could not be
    /// established (see [`LoginOutcome::Unavailable`]).
    Unavailable,
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
    /// Issuance provenance, independent of account name/role (#209, conventions §6).
    public_viewer: bool,
    /// The account binding (Issue #204) checked by [`AuthState::authenticate`]
    /// while a [`SessionLookup`] is installed. `None` for public viewer
    /// sessions and for tokens minted without one ([`AuthState::issue_token`]),
    /// which a lookup-enabled state rejects.
    stamp: Option<SessionStamp>,
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
    /// Issue order of the synthetic 閲覧公開 viewer tokens currently held in
    /// `tokens` (Issue #189). Kept as a separate FIFO rather than scanning
    /// `tokens` for `identity.id == PUBLIC_VIEWER_ID` because the cap needs
    /// the *oldest* one and `HashMap` has no order. Entries may name a token
    /// that has since been logged out or expired out of `tokens`; eviction
    /// simply removes whatever it finds (a `HashMap::remove` of an absent key
    /// is a no-op). The queue itself is capped at
    /// [`MAX_PUBLIC_VIEWER_SESSIONS`] entries, so live public sessions are
    /// bounded by the cap whether or not stale entries are present.
    public_tokens: RwLock<VecDeque<String>>,
    failures: RwLock<HashMap<String, FailureRecord>>,
    verify_credentials: CredentialVerifier,
    /// Issue #204: `Some` for [`SessionValidation::Lookup`], `None` for
    /// [`SessionValidation::DisabledNoRevocation`]. Fixed at construction,
    /// shared by every clone of this state (they share `Inner`).
    session_lookup: Option<SessionLookup>,
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
    ///
    /// `validation` (Issue #204) is required on purpose: every caller must
    /// decide whether sessions are re-checked against the account store
    /// ([`SessionValidation::Lookup`] - the only safe choice for real
    /// accounts) or not ([`SessionValidation::DisabledNoRevocation`]). There
    /// is deliberately no constructor that picks for you, so upgrading to
    /// this version fails to compile until that choice is written down:
    ///
    /// ```compile_fail,E0061
    /// # use banto_server::{AuthState, Identity};
    /// # use futures_util::future::BoxFuture;
    /// // The pre-#204 one-argument form no longer exists.
    /// let auth = AuthState::new(|_u: String, _p: String| -> BoxFuture<'static, Option<Identity>> {
    ///     Box::pin(async { None })
    /// });
    /// ```
    pub fn new(
        verify_credentials: impl Fn(String, String) -> BoxFuture<'static, Option<Identity>>
            + Send
            + Sync
            + 'static,
        validation: SessionValidation,
    ) -> Self {
        Self::with_policy(
            verify_credentials,
            validation,
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
        validation: SessionValidation,
        token_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::with_policies(
            verify_credentials,
            validation,
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
        validation: SessionValidation,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::build(
            Arc::new(verify_credentials),
            validation,
            token_policy,
            remembered_policy,
            rate_limit,
            Clock::real(),
        )
    }

    fn build(
        verify_credentials: CredentialVerifier,
        validation: SessionValidation,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
        clock: Clock,
    ) -> Self {
        let session_lookup = match validation {
            SessionValidation::Lookup(lookup) => Some(lookup),
            SessionValidation::DisabledNoRevocation => None,
        };
        Self {
            inner: Arc::new(Inner {
                tokens: RwLock::new(HashMap::new()),
                public_tokens: RwLock::new(VecDeque::new()),
                failures: RwLock::new(HashMap::new()),
                verify_credentials,
                session_lookup,
                token_policy,
                remembered_policy,
                rate_limit,
                clock,
            }),
        }
    }

    fn session_lookup(&self) -> Option<&SessionLookup> {
        self.inner.session_lookup.as_ref()
    }
    /// Run the credential check and, when a [`SessionLookup`] is installed,
    /// establish the [`SessionStamp`] the new session is bound to (Issue
    /// #204). The stamp is read BEFORE the credential check: if the account
    /// changes while the (slow, argon2) check runs, the token carries the
    /// pre-change stamp and dies on first use instead of surviving the
    /// change. The verifier always runs, even when the pre-read failed, so
    /// an unknown username still pays the verifier's full cost.
    async fn verify_and_stamp(&self, username: &str, password: &str) -> StampedLogin {
        let pre_read = match self.session_lookup() {
            Some(lookup) => Some(lookup(username.to_string()).await),
            None => None,
        };
        let Some(identity) =
            (self.inner.verify_credentials)(username.to_string(), password.to_string()).await
        else {
            return StampedLogin::Rejected;
        };
        match pre_read {
            None => StampedLogin::Accepted(identity, None),
            Some(Ok(Some(account))) if account.identity.id == identity.id => {
                StampedLogin::Accepted(identity, Some(account.stamp))
            }
            Some(_) => StampedLogin::Unavailable,
        }
    }

    /// Verify credentials and, on success, mint and store a new uuid-v4
    /// bearer token bound to the returned identity. Returns `None` on bad
    /// credentials (and, with a [`SessionLookup`] installed, when the
    /// account's stamp could not be established - see
    /// [`LoginOutcome::Unavailable`]).
    ///
    /// This is the un-throttled, trusted-caller path (used programmatically
    /// and in tests): it does NOT consult the login rate limiter. The
    /// network-exposed `POST /api/auth/login` handler goes through
    /// [`AuthState::login_rate_limited`] instead, since that is the surface an
    /// attacker can flood.
    pub async fn login(&self, username: &str, password: &str) -> Option<String> {
        match self.verify_and_stamp(username, password).await {
            StampedLogin::Accepted(identity, stamp) => {
                Some(self.issue_token_with(identity, false, false, stamp))
            }
            StampedLogin::Rejected | StampedLogin::Unavailable => None,
        }
    }

    /// Rate-limited credential check for the login endpoint (spec §11.2).
    /// `ip` is the caller's peer address (`None` only when the server was
    /// started without `ConnectInfo`, e.g. `tower::oneshot` in tests). Both
    /// throttle dimensions - per (IP+username) and per IP alone (see
    /// [`RateLimitPolicy`]) - are checked *before* the expensive credential
    /// verifier runs, so a lockout on either cannot be used to keep argon2
    /// busy. A success clears both dimensions' streaks; a failure adds to
    /// both (each against its own threshold) and may start a lockout.
    ///
    /// `remember` (spec M11 "LAN Remember me"): when `true`, the issued token
    /// is evaluated against `remembered_policy` (long-lived) instead of the
    /// regular `token_policy` for the rest of its life - see
    /// [`TokenRecord::remembered`].
    pub async fn login_rate_limited(
        &self,
        ip: Option<IpAddr>,
        username: &str,
        password: &str,
        remember: bool,
    ) -> LoginOutcome {
        let account_key = rate_limit_key(ip, username);
        // The per-IP dimension only exists when the peer address is known
        // (production always wires up `ConnectInfo`; `None` is the test /
        // no-connect-info fallback, where an IP-wide limit is meaningless).
        let ip_key = ip.map(ip_rate_limit_key);
        let policy = self.inner.rate_limit;

        // BOTH dimensions are checked before the expensive verifier runs, so
        // a lockout on either one short-circuits argon2 (this is the property
        // that makes the endpoint DoS-resistant, not just brute-force-proof).
        let mut retry_after = self.locked_out(&account_key);
        if let Some(ip_key) = &ip_key {
            retry_after = max_option(retry_after, self.locked_out(ip_key));
        }
        if let Some(retry_after) = retry_after {
            return LoginOutcome::RateLimited { retry_after };
        }

        match self.verify_and_stamp(username, password).await {
            StampedLogin::Accepted(identity, stamp) => {
                self.reset_failures(&account_key);
                if let Some(ip_key) = &ip_key {
                    self.reset_failures(ip_key);
                }
                LoginOutcome::Success(self.issue_token_with(identity, remember, false, stamp))
            }
            // The password was right; only the account binding could not be
            // established. Clear the streak like a success, issue nothing.
            StampedLogin::Unavailable => {
                self.reset_failures(&account_key);
                if let Some(ip_key) = &ip_key {
                    self.reset_failures(ip_key);
                }
                LoginOutcome::Unavailable
            }
            StampedLogin::Rejected => {
                self.record_failure(&account_key, policy.max_failures);
                if let Some(ip_key) = &ip_key {
                    self.record_failure(ip_key, policy.max_ip_failures);
                }
                LoginOutcome::InvalidCredentials
            }
        }
    }

    /// Mint a token for an account the caller has just created or verified
    /// through some other path, bound to its [`SessionStamp`] (Issue #204) -
    /// the stamped counterpart of [`AuthState::issue_token`]/
    /// [`AuthState::issue_token_remembered`], and the one to use while a
    /// [`SessionLookup`] is installed (e.g. `POST /api/auth/setup` logging
    /// the first account in). `remember` selects the "Remember me" policy
    /// (spec M11).
    pub fn issue_account_token(&self, account: SessionAccount, remember: bool) -> String {
        self.issue_token_with(account.identity, remember, false, Some(account.stamp))
    }

    /// Mint and store a new bearer token for an already-verified `identity`,
    /// without going through `verify_credentials` again. Used by callers
    /// that just created/authenticated an account through some other path
    /// (e.g. the REST `/api/auth/setup` handler, right after
    /// `UsersService::setup_first_user` succeeds) and want to log the new
    /// session in immediately, the same way `login` would. Not "remembered"
    /// (spec M11) - use [`AuthState::issue_token_remembered`] for that.
    ///
    /// The token carries no [`SessionStamp`] (Issue #204): while a
    /// [`SessionLookup`] is installed it is rejected on first use - use
    /// [`AuthState::issue_account_token`] there instead.
    pub fn issue_token(&self, identity: Identity) -> String {
        self.issue_token_with(identity, false, false, None)
    }

    /// Like [`AuthState::issue_token`], but the token is issued as
    /// "remembered" (spec M11 "LAN Remember me"): it is evaluated against
    /// `remembered_policy` instead of `token_policy` for the rest of its
    /// life. Unstamped, like [`AuthState::issue_token`].
    pub fn issue_token_remembered(&self, identity: Identity) -> String {
        self.issue_token_with(identity, true, false, None)
    }

    /// Mint a synthetic LAN 閲覧公開 viewer session (Issue #189, ADR-0012,
    /// conventions §6): a regular (non-remembered) bearer token bound to the
    /// FIXED identity `{ id: PUBLIC_VIEWER_ID, name: PUBLIC_VIEWER_ID,
    /// role: "viewer" }`.
    ///
    /// It deliberately takes NO [`Identity`]/role argument. That is the whole
    /// security property: the caller (`POST /api/auth/public-viewer`, which
    /// requires no credentials at all) has no way to ask for anything but
    /// `viewer`, so there is no escalation path to review. Everything
    /// downstream is unchanged - the token goes through the same
    /// [`require_auth`] + `RoleGuard` + audit path as a logged-in session, so
    /// a mutating request made with it is rejected `403` and recorded as a
    /// `denied` entry with actor `public`.
    ///
    /// Not "remembered" (spec M11): a public viewing session expires on the
    /// regular [`TokenPolicy`] and the frontend's route gate transparently
    /// mints a fresh one, so there is no reason to hand an anonymous LAN
    /// client a 30-day token.
    ///
    /// Issuance never fails: once [`MAX_PUBLIC_VIEWER_SESSIONS`] public
    /// tokens are outstanding, the OLDEST is revoked to make room (see
    /// `Inner::public_tokens`). Only public tokens are eligible for that
    /// eviction - real login sessions are never touched by it.
    pub fn issue_public_viewer_token(&self) -> String {
        let token = self.issue_token_with(
            Identity {
                id: PUBLIC_VIEWER_ID.to_string(),
                name: PUBLIC_VIEWER_ID.to_string(),
                role: "viewer".to_string(),
            },
            false,
            true,
            None,
        );

        // Locks are taken one at a time (never nested) and `issue_token_with`
        // has already released the token map's write lock by now, so this
        // cannot deadlock against it.
        let evicted = {
            let mut public_tokens = self
                .inner
                .public_tokens
                .write()
                .expect("public viewer token lock poisoned");
            public_tokens.push_back(token.clone());
            let mut evicted = Vec::new();
            while public_tokens.len() > MAX_PUBLIC_VIEWER_SESSIONS {
                if let Some(oldest) = public_tokens.pop_front() {
                    evicted.push(oldest);
                }
            }
            evicted
        };
        if !evicted.is_empty() {
            let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
            for oldest in evicted {
                tokens.remove(&oldest);
            }
        }

        token
    }

    /// Shared implementation of [`AuthState::issue_token`]/
    /// [`AuthState::issue_token_remembered`]/[`AuthState::login_rate_limited`].
    ///
    /// Opportunistically sweeps already-expired tokens under the same write
    /// lock, so the map stays bounded without a background reaper. Each
    /// existing record is checked against whichever policy applies to IT
    /// (its own `remembered` flag), not the policy of the token being
    /// inserted.
    fn issue_token_with(
        &self,
        identity: Identity,
        remembered: bool,
        public_viewer: bool,
        stamp: Option<SessionStamp>,
    ) -> String {
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
                public_viewer,
                stamp,
            },
        );
        token
    }

    /// Is `token` a currently-valid, unexpired bearer token? A successful
    /// check refreshes the token's idle timer (spec §11.2); an expired token
    /// is removed as a side effect.
    ///
    /// Synchronous and in-memory only: it does NOT consult the account store
    /// (Issue #204). Anything that decides access must use
    /// [`AuthState::authenticate`] (as [`require_auth`] does).
    pub fn verify(&self, token: &str) -> bool {
        self.session_for(token).is_some()
    }

    /// Invalidate `token` (idempotent: logging out twice is not an error).
    pub fn logout(&self, token: &str) {
        self.inner
            .tokens
            .write()
            .expect("auth token lock poisoned")
            .remove(token);
    }

    /// Number of bearer tokens currently held in memory, for the admin System
    /// Info card (M-review 2026-08 §2.4).
    ///
    /// CAVEAT - this is an UPPER BOUND on genuinely-active sessions, not an
    /// exact count. Per this module's design, "expired tokens … are reaped
    /// lazily (on lookup) and opportunistically (a cheap sweep on each write);
    /// there is deliberately no background reaper task", so a token whose
    /// absolute/idle TTL has already lapsed still counts here until the next
    /// `verify`/`identity_for` on it, or the next token issue, sweeps it out.
    /// The card labels this accordingly. A read lock suffices; unlike
    /// [`verify`](Self::verify) this does not slide any idle timer.
    pub fn session_count(&self) -> usize {
        self.inner
            .tokens
            .read()
            .expect("auth token lock poisoned")
            .len()
    }

    /// The [`Identity`] bound to `token`, or `None` if it is not a
    /// currently-valid, unexpired token. Refreshes the idle timer on success
    /// (same as [`AuthState::verify`]). Exposed (beyond what the `/api/auth/*`
    /// routes below need) so other routers built in the app crate - e.g.
    /// `admin-template-core::rest`'s `/api/auth/change-password` - can
    /// recover "which account is this request for" from the same bearer
    /// token `require_auth` already validated.
    ///
    /// Synchronous and in-memory only (Issue #204): it returns the identity
    /// as of the token's last [`AuthState::authenticate`] (which refreshes it
    /// from the account store), so it is current for code running behind
    /// [`require_auth`] - and only there. Code that is not behind it must
    /// call [`AuthState::authenticate`] itself.
    pub fn identity_for(&self, token: &str) -> Option<Identity> {
        self.session_for(token).map(|session| session.identity)
    }

    /// Validate `token` for a request (Issue #204): the in-memory checks of
    /// [`AuthState::verify`] (known, unexpired; slides the idle window), then
    /// - when a [`SessionLookup`] is installed and this is an account session
    /// - re-read the account and compare its [`SessionStamp`]:
    ///
    /// - `Ok(Some(_))`: valid; the returned identity is the account's
    ///   CURRENT one (role included), and the token's cached identity is
    ///   refreshed to it;
    /// - `Ok(None)`: unknown/expired token, or the account is gone or its
    ///   stamp changed (or the token has no stamp) - the token is revoked;
    /// - `Err`: the store could not answer. The token is kept (a transient
    ///   store failure must not log everyone out) but the caller must fail
    ///   the request.
    pub async fn authenticate(
        &self,
        token: &str,
    ) -> Result<Option<AuthenticatedSession>, BantoError> {
        let Some(session) = self.session_for(token) else {
            return Ok(None);
        };
        let Some(lookup) = self.session_lookup() else {
            return Ok(Some(session));
        };
        if session.public_viewer {
            // No account behind it; its fixed `viewer` identity cannot
            // change (ADR-0012), so there is nothing to re-check.
            return Ok(Some(session));
        }
        let Some(stamp) = session.stamp else {
            self.revoke_if_stamp(token, None);
            return Ok(None);
        };
        match lookup(session.identity.id.clone()).await? {
            Some(account) if account.stamp == stamp => {
                self.refresh_identity(token, stamp, &account.identity);
                Ok(Some(AuthenticatedSession {
                    identity: account.identity,
                    public_viewer: false,
                    stamp: Some(stamp),
                }))
            }
            account => {
                // The stamp this lookup started from may be stale for a reason
                // other than revocation: THIS token may have been re-bound
                // meanwhile ([`AuthState::rotate_session_epoch`], its own
                // password change). Decide on the token's CURRENT stamp.
                let rebound = self.settle_stamp_mismatch(token, stamp, account.as_ref());
                Ok(match (rebound, account) {
                    (Some(rebound), Some(account)) => Some(AuthenticatedSession {
                        identity: account.identity,
                        public_viewer: false,
                        stamp: Some(rebound),
                    }),
                    _ => None,
                })
            }
        }
    }

    /// Resolve a lookup whose result does not match the stamp the request
    /// started from (`validated`), under one lock:
    ///
    /// - the token is still bound to `validated` -> it really is stale:
    ///   revoke it, `None`;
    /// - the token was re-bound meanwhile to EXACTLY the stamp the store now
    ///   reports -> it is valid under its new binding: refresh its identity
    ///   and return that stamp. Only the token's own re-binding counts; this
    ///   never adopts the store's newest epoch on a token's behalf, so the
    ///   account's other sessions still end;
    /// - anything else (re-bound to something the store no longer reports,
    ///   or already gone) -> `None`, leaving the token for its next request
    ///   to decide against a fresh lookup.
    fn settle_stamp_mismatch(
        &self,
        token: &str,
        validated: SessionStamp,
        account: Option<&SessionAccount>,
    ) -> Option<SessionStamp> {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        let current = tokens.get(token)?.stamp;
        if current == Some(validated) {
            tokens.remove(token);
            return None;
        }
        let (Some(current), Some(account)) = (current, account) else {
            return None;
        };
        if current != account.stamp {
            return None;
        }
        if let Some(record) = tokens.get_mut(token) {
            record.identity = account.identity.clone();
        }
        Some(current)
    }

    /// Keep `token` alive across its own account's password change (Issue
    /// #204): the change incremented the account's epoch, which ends every
    /// session of it; this re-binds just `token` to `new_epoch` - the value
    /// the change itself wrote - so the session that made the change stays
    /// logged in while all the others end.
    ///
    /// Compare-and-set: only a token still bound to `previous` (the stamp it
    /// was authenticated with for this request) is re-bound. Returns whether
    /// it was; `false` means the token was meanwhile revoked, which the
    /// caller should leave as is (the user simply logs in again).
    pub fn rotate_session_epoch(
        &self,
        token: &str,
        previous: SessionStamp,
        new_epoch: i64,
    ) -> bool {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        match tokens.get_mut(token) {
            Some(record) if record.stamp == Some(previous) => {
                record.stamp = Some(SessionStamp {
                    account_id: previous.account_id,
                    auth_epoch: new_epoch,
                });
                true
            }
            _ => false,
        }
    }

    /// Revoke `token` only if it is still bound to `stamp`. A token re-bound
    /// in the meantime ([`AuthState::rotate_session_epoch`]) was validated
    /// against a newer state than the lookup that failed, so it is left
    /// alone.
    fn revoke_if_stamp(&self, token: &str, stamp: Option<SessionStamp>) {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        if tokens
            .get(token)
            .is_some_and(|record| record.stamp == stamp)
        {
            tokens.remove(token);
        }
    }

    /// Store the account's current identity on `token` (for the synchronous
    /// [`AuthState::identity_for`] readers behind [`require_auth`]), only if
    /// the token is still bound to the stamp that identity was read under.
    fn refresh_identity(&self, token: &str, stamp: SessionStamp, identity: &Identity) {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        if let Some(record) = tokens.get_mut(token) {
            if record.stamp == Some(stamp) {
                record.identity = identity.clone();
            }
        }
    }

    /// Shared lookup for [`verify`](Self::verify)/[`identity_for`](Self::identity_for):
    /// return the identity behind a live token and slide its idle window
    /// forward, or evict it and return `None` if it has expired. Takes a
    /// write lock (not a read lock) precisely because the idle-timer refresh
    /// mutates the record - an acceptable cost for a single-host LAN server.
    ///
    /// Which [`TokenPolicy`] applies is decided per-token by its own
    /// `remembered` flag (spec M11), not by a single state-wide policy.
    pub(crate) fn session_for(&self, token: &str) -> Option<AuthenticatedSession> {
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
            Some(AuthenticatedSession {
                identity: record.identity.clone(),
                public_viewer: record.public_viewer,
                stamp: record.stamp,
            })
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
    /// reaches `max_failures` (the caller passes the threshold for this key's
    /// dimension - `RateLimitPolicy::max_failures` for the per-account key,
    /// `max_ip_failures` for the per-IP key). Sweeps aged-out records under
    /// the same write lock.
    fn record_failure(&self, key: &str, max_failures: u32) {
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
        if record.count >= max_failures {
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
        validation: SessionValidation,
        token_policy: TokenPolicy,
        remembered_policy: TokenPolicy,
        rate_limit: RateLimitPolicy,
    ) -> Self {
        Self::build(
            Arc::new(verify_credentials),
            validation,
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

/// Lockout key for the per-IP throttle dimension (spec §11.2, see
/// [`RateLimitPolicy`]): the client IP alone, username-independent. The
/// `ip-only|` prefix can never collide with a [`rate_limit_key`] value (whose
/// first `|`-segment is always an IP address or `-`, never the literal
/// `ip-only`), so the two dimensions share the one failure map safely.
pub fn ip_rate_limit_key(ip: IpAddr) -> String {
    format!("ip-only|{ip}")
}

/// The larger of two optional retry-after durations (a present value beats
/// `None`): used to report the longer of the two lockout dimensions.
fn max_option(a: Option<Duration>, b: Option<Duration>) -> Option<Duration> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
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
///
/// Issue #204: validation is [`AuthState::authenticate`], so with a
/// [`SessionLookup`] installed the account is re-read on every request - a
/// deleted/re-keyed account's token gets `401` here and is revoked, and a
/// store failure is an error response (not a pass). The validated
/// [`AuthenticatedSession`] (current identity) is inserted into the request's
/// extensions for the guards and handlers behind this middleware.
pub async fn require_auth(State(auth): State<AuthState>, mut req: Request, next: Next) -> Response {
    let Some(token) = bearer_token(&req).map(str::to_owned) else {
        return unauthorized_response();
    };
    match auth.authenticate(&token).await {
        Ok(Some(session)) => {
            req.extensions_mut().insert(session);
            next.run(req).await
        }
        Ok(None) => unauthorized_response(),
        Err(err) => crate::ApiError(err).into_response(),
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
    match auth
        .login_rate_limited(
            peer.map(|addr| addr.ip()),
            &body.username,
            &body.password,
            body.remember,
        )
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
        // Issue #204: same `{kind,message}` shape as the 429 above, so the
        // frontend surfaces the message without any change.
        LoginOutcome::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody::Other {
                message: "アカウントの状態を確認できませんでした。もう一度お試しください。"
                    .to_string(),
            }),
        )
            .into_response(),
    }
}

async fn logout_handler(State(auth): State<AuthState>, req: Request) -> StatusCode {
    if let Some(token) = bearer_token(&req) {
        auth.logout(token);
    }
    StatusCode::OK
}

/// The session behind the request's bearer token, validated the same way
/// [`require_auth`] does (Issue #204) - `check`/`identity` are not behind
/// that middleware, and must not report a revoked session as live.
/// (Takes the token as an owned `String`: a `&Request` held across the
/// `.await` would make the handler future `!Send`.)
async fn authenticated_session(
    auth: &AuthState,
    token: Option<String>,
) -> Result<Option<AuthenticatedSession>, crate::ApiError> {
    let Some(token) = token else {
        return Ok(None);
    };
    Ok(auth.authenticate(&token).await?)
}

async fn check_handler(
    State(auth): State<AuthState>,
    req: Request,
) -> Result<Json<bool>, crate::ApiError> {
    let token = bearer_token(&req).map(str::to_owned);
    Ok(Json(authenticated_session(&auth, token).await?.is_some()))
}

/// `GET /api/auth/identity`: the [`AuthenticatedSession`] (serialized as
/// `Identity & { publicViewer }`, #209 conventions §6) or `null`.
async fn identity_handler(
    State(auth): State<AuthState>,
    req: Request,
) -> Result<Json<Option<AuthenticatedSession>>, crate::ApiError> {
    let token = bearer_token(&req).map(str::to_owned);
    Ok(Json(authenticated_session(&auth, token).await?))
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
/// - `GET /api/auth/identity` — `(Identity & { publicViewer: bool }) | null`.
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
        AuthState::new(
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
            SessionValidation::DisabledNoRevocation,
        )
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
            SessionValidation::DisabledNoRevocation,
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
            SessionValidation::DisabledNoRevocation,
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
            max_ip_failures: 100,
            lockout: Duration::from_secs(60),
        };
        let (auth, calls) = counting_auth(policy);
        for _ in 0..3 {
            assert!(matches!(
                auth.login_rate_limited(None, "admin", "wrong", false).await,
                LoginOutcome::InvalidCredentials
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3, "3 real checks so far");

        // The 4th attempt is locked out and must NOT run the verifier.
        match auth.login_rate_limited(None, "admin", "wrong", false).await {
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
            auth.login_rate_limited(None, "admin", "admin", false).await,
            LoginOutcome::RateLimited { .. }
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn lockout_expires_after_the_cooloff() {
        let policy = RateLimitPolicy {
            max_failures: 3,
            max_ip_failures: 100,
            lockout: Duration::from_secs(60),
        };
        let (auth, _calls) = counting_auth(policy);
        for _ in 0..3 {
            auth.login_rate_limited(None, "admin", "wrong", false).await;
        }
        assert!(matches!(
            auth.login_rate_limited(None, "admin", "admin", false).await,
            LoginOutcome::RateLimited { .. }
        ));

        auth.advance(Duration::from_secs(61)); // ride out the cool-off
        match auth.login_rate_limited(None, "admin", "admin", false).await {
            LoginOutcome::Success(token) => assert!(auth.verify(&token)),
            other => panic!("expected Success after cool-off, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn success_resets_the_failure_streak() {
        let policy = RateLimitPolicy {
            max_failures: 3,
            max_ip_failures: 100,
            lockout: Duration::from_secs(60),
        };
        let (auth, _calls) = counting_auth(policy);
        // Two failures (one short of the threshold)...
        auth.login_rate_limited(None, "admin", "wrong", false).await;
        auth.login_rate_limited(None, "admin", "wrong", false).await;
        // ...then a success clears the streak.
        assert!(matches!(
            auth.login_rate_limited(None, "admin", "admin", false).await,
            LoginOutcome::Success(_)
        ));
        // Two more failures should NOT lock out (streak restarted at 0).
        auth.login_rate_limited(None, "admin", "wrong", false).await;
        assert!(matches!(
            auth.login_rate_limited(None, "admin", "wrong", false).await,
            LoginOutcome::InvalidCredentials
        ));
    }

    #[tokio::test]
    async fn per_ip_dimension_bounds_a_username_rotation_flood() {
        // Regression: without a username-independent per-IP limit, an attacker
        // on one IP evades the per-(IP,username) lockout by varying `username`
        // every request, keeping the argon2 verifier busy indefinitely (a
        // CPU/memory DoS). max_ip_failures must trip regardless of username.
        let policy = RateLimitPolicy {
            max_failures: 5,
            max_ip_failures: 3,
            lockout: Duration::from_secs(60),
        };
        let (auth, calls) = counting_auth(policy);
        let ip = Some(IpAddr::from([203, 0, 113, 7]));

        // Three failures, each under a DIFFERENT username: the per-account
        // lockout (threshold 5) never trips, but the per-IP one (threshold 3)
        // does.
        for i in 0..3 {
            let username = format!("victim{i}");
            assert!(matches!(
                auth.login_rate_limited(ip, &username, "wrong", false).await,
                LoginOutcome::InvalidCredentials
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3, "3 real checks so far");

        // The 4th attempt - yet another fresh username - is now locked out by
        // the IP dimension WITHOUT running the verifier (argon2 is capped).
        match auth
            .login_rate_limited(ip, "victim-new", "wrong", false)
            .await
        {
            LoginOutcome::RateLimited { retry_after } => {
                assert!(retry_after <= Duration::from_secs(60))
            }
            other => panic!("expected RateLimited from the IP dimension, got {other:?}"),
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "IP-locked attempt must short-circuit the verifier"
        );

        // A DIFFERENT IP is unaffected - the lockout is per-address.
        let other_ip = Some(IpAddr::from([203, 0, 113, 8]));
        assert!(matches!(
            auth.login_rate_limited(other_ip, "victim0", "wrong", false)
                .await,
            LoginOutcome::InvalidCredentials
        ));
    }

    #[tokio::test]
    async fn per_ip_dimension_leaves_headroom_above_the_account_threshold() {
        // The IP threshold is deliberately higher than the per-account one so
        // a shared NAT with a few genuinely-fumbling users isn't tripped by
        // normal misses. Below max_ip_failures, distinct-username failures
        // from one IP keep returning InvalidCredentials (not RateLimited).
        let policy = RateLimitPolicy {
            max_failures: 5,
            max_ip_failures: 4,
            lockout: Duration::from_secs(60),
        };
        let (auth, _calls) = counting_auth(policy);
        let ip = Some(IpAddr::from([198, 51, 100, 20]));

        for i in 0..3 {
            let username = format!("user{i}");
            assert!(matches!(
                auth.login_rate_limited(ip, &username, "wrong", false).await,
                LoginOutcome::InvalidCredentials
            ));
        }
        // A legitimate success from the same IP then clears the IP streak...
        assert!(matches!(
            auth.login_rate_limited(ip, "admin", "admin", false).await,
            LoginOutcome::Success(_)
        ));
        // ...so the counter restarts and 3 more distinct-user misses still do
        // not lock the IP (would have, had the streak not reset at 4).
        for i in 0..3 {
            let username = format!("again{i}");
            assert!(matches!(
                auth.login_rate_limited(ip, &username, "wrong", false).await,
                LoginOutcome::InvalidCredentials
            ));
        }
    }

    // --- Remember me (spec M11) --------------------------------------------

    #[tokio::test]
    async fn remembered_token_survives_the_regular_absolute_ttl_but_not_forever() {
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let token = match auth.login_rate_limited(None, "admin", "admin", true).await {
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
        let token = match auth.login_rate_limited(None, "admin", "admin", false).await {
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
            max_ip_failures: 100,
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

    // --- Synthetic viewer sessions (LAN 閲覧公開, Issue #189) ---------------

    #[tokio::test]
    async fn public_viewer_metadata_follows_token_lifetime_and_not_identity() {
        let auth = frozen_auth(short_token_policy(), RateLimitPolicy::default());
        let public = auth.issue_public_viewer_token();
        let identity = auth.identity_for(&public).unwrap();
        let regular = auth.issue_token(identity.clone());
        let remembered = auth.issue_token_remembered(identity);
        let router = auth_routes(auth.clone());

        // Fresh identity requests (including reload) must recover provenance,
        // even when every Identity field matches a synthetic viewer exactly.
        for _ in 0..2 {
            for (token, expected) in [(&public, true), (&regular, false), (&remembered, false)] {
                let response = router
                    .clone()
                    .oneshot(
                        HttpRequest::get("/api/auth/identity")
                            .header("Authorization", format!("Bearer {token}"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(body_json(response).await["publicViewer"], expected);
            }
        }
        auth.advance(Duration::from_secs(31));
        let fresh = auth.issue_public_viewer_token();
        auth.logout(&fresh);
        for token in [&public, &regular, &fresh] {
            let response = router
                .clone()
                .oneshot(
                    HttpRequest::get("/api/auth/identity")
                        .header("Authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(body_json(response).await.is_null());
        }
        assert!(!auth.session_for(&remembered).unwrap().public_viewer);
    }

    #[tokio::test]
    async fn public_viewer_token_is_always_the_fixed_viewer_identity() {
        let auth = demo_auth();
        let token = auth.issue_public_viewer_token();

        assert!(auth.verify(&token));
        let identity = auth.identity_for(&token).expect("identity should exist");
        assert_eq!(identity.id, PUBLIC_VIEWER_ID);
        assert_eq!(identity.name, PUBLIC_VIEWER_ID);
        assert_eq!(
            identity.role, "viewer",
            "there is no escalation path: the role is fixed (ADR-0012)"
        );
    }

    #[tokio::test]
    async fn public_viewer_tokens_are_not_remembered() {
        // A public viewing session rides the regular TokenPolicy - the
        // frontend gate re-issues transparently, so an anonymous LAN client
        // never holds a 30-day token.
        let auth = frozen_auth(TokenPolicy::default(), RateLimitPolicy::default());
        let token = auth.issue_public_viewer_token();

        auth.advance(TokenPolicy::default().absolute_ttl + Duration::from_secs(60));
        assert!(!auth.verify(&token));
    }

    #[tokio::test]
    async fn public_viewer_issuance_past_the_cap_evicts_the_oldest() {
        let auth = demo_auth();
        let mut tokens = Vec::new();
        for _ in 0..MAX_PUBLIC_VIEWER_SESSIONS {
            tokens.push(auth.issue_public_viewer_token());
        }
        assert!(
            tokens.iter().all(|token| auth.verify(token)),
            "every token up to the cap stays valid"
        );

        // One past the cap: issuance still succeeds (a reloading wall display
        // must never be refused), and the FIRST token is the one revoked.
        let overflow = auth.issue_public_viewer_token();
        assert!(auth.verify(&overflow));
        assert!(
            !auth.verify(&tokens[0]),
            "the oldest public token should have been evicted"
        );
        assert!(
            auth.verify(&tokens[1]),
            "only the oldest is evicted, not the whole pool"
        );
    }

    #[tokio::test]
    async fn public_viewer_eviction_never_touches_a_real_login_session() {
        let auth = demo_auth();
        let admin_token = auth.login("admin", "admin").await.expect("admin login");
        let same_identity_token = auth.issue_token(Identity {
            id: PUBLIC_VIEWER_ID.to_string(),
            name: PUBLIC_VIEWER_ID.to_string(),
            role: "viewer".to_string(),
        });

        for _ in 0..(MAX_PUBLIC_VIEWER_SESSIONS + 10) {
            auth.issue_public_viewer_token();
        }

        assert!(
            auth.verify(&admin_token),
            "the cap must only ever evict public viewer tokens"
        );
        assert!(
            !auth
                .session_for(&same_identity_token)
                .unwrap()
                .public_viewer
        );
    }

    #[tokio::test]
    async fn logout_of_a_public_viewer_token_revokes_only_that_token() {
        // One wall display signing out must not blank the others (conventions
        // §6) - `logout` is the plain per-token revoke, nothing public-specific.
        let auth = demo_auth();
        let first = auth.issue_public_viewer_token();
        let second = auth.issue_public_viewer_token();

        auth.logout(&first);

        assert!(!auth.verify(&first));
        assert!(auth.verify(&second));
    }

    #[test]
    fn rate_limit_key_distinguishes_ip_and_username() {
        let with_ip = rate_limit_key(Some("192.168.0.5".parse().unwrap()), "admin");
        let without = rate_limit_key(None, "admin");
        assert_eq!(with_ip, "192.168.0.5|admin");
        assert_eq!(without, "-|admin");
        assert_ne!(with_ip, without);
    }

    // --- Account-bound sessions (Issue #204) ----------------------------------

    type VerifyHook = Box<dyn FnOnce() + Send>;

    /// An in-memory account store standing in for `UsersService`: the
    /// verifier accepts password `"pw"` for any stored account, and the
    /// lookup reports the stored [`SessionAccount`] (or fails on demand).
    #[derive(Clone, Default)]
    struct FakeStore {
        accounts: Arc<std::sync::Mutex<HashMap<String, SessionAccount>>>,
        failing: Arc<std::sync::atomic::AtomicBool>,
        lookups: Arc<AtomicUsize>,
        /// Run once inside the verifier, i.e. while a login is "in flight".
        during_verify: Arc<std::sync::Mutex<Option<VerifyHook>>>,
        /// Holds the NEXT lookup in flight: it signals the first sender on
        /// entry, then waits for the second channel before reading.
        lookup_gate: Arc<std::sync::Mutex<Option<LookupGate>>>,
    }

    type LookupGate = (
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    );

    impl FakeStore {
        fn put(&self, username: &str, role: &str, account_id: i64, auth_epoch: i64) {
            self.accounts.lock().unwrap().insert(
                username.to_string(),
                SessionAccount {
                    identity: Identity {
                        id: username.to_string(),
                        name: format!("{username} name"),
                        role: role.to_string(),
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

        fn get(&self, username: &str) -> Option<SessionAccount> {
            self.accounts.lock().unwrap().get(username).cloned()
        }

        fn auth(&self) -> AuthState {
            let verify_store = self.clone();
            let lookup_store = self.clone();
            let lookup = SessionValidation::lookup(move |u: String| {
                let store = lookup_store.clone();
                Box::pin(async move {
                    store.lookups.fetch_add(1, Ordering::SeqCst);
                    let gate = store.lookup_gate.lock().unwrap().take();
                    if let Some((entered, release)) = gate {
                        let _ = entered.send(());
                        let _ = release.await;
                    }
                    if store.failing.load(Ordering::SeqCst) {
                        Err(BantoError::Other("store unavailable".to_string()))
                    } else {
                        Ok(store.get(&u))
                    }
                })
            });
            AuthState::with_frozen_clock(
                move |u: String, p: String| {
                    let store = verify_store.clone();
                    Box::pin(async move {
                        let hook = store.during_verify.lock().unwrap().take();
                        if let Some(hook) = hook {
                            hook();
                        }
                        if p == "pw" {
                            store.get(&u).map(|account| account.identity)
                        } else {
                            None
                        }
                    })
                },
                lookup,
                TokenPolicy::default(),
                TokenPolicy::remembered_default(),
                RateLimitPolicy::default(),
            )
        }
    }

    impl FakeStore {
        /// The same verifier, with [`SessionValidation::DisabledNoRevocation`].
        fn auth_without_revocation(&self) -> AuthState {
            let verify_store = self.clone();
            AuthState::with_frozen_clock(
                move |u: String, p: String| {
                    let store = verify_store.clone();
                    Box::pin(async move {
                        if p == "pw" {
                            store.get(&u).map(|account| account.identity)
                        } else {
                            None
                        }
                    })
                },
                SessionValidation::DisabledNoRevocation,
                TokenPolicy::default(),
                TokenPolicy::remembered_default(),
                RateLimitPolicy::default(),
            )
        }
    }

    /// Start `authenticate(token)` and hold its lookup in flight; returns the
    /// pending check and the switch that lets the lookup continue.
    async fn check_held_in_lookup(
        store: &FakeStore,
        auth: &AuthState,
        token: &str,
    ) -> (
        tokio::task::JoinHandle<Result<Option<AuthenticatedSession>, BantoError>>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *store.lookup_gate.lock().unwrap() = Some((entered_tx, release_rx));
        let pending = {
            let auth = auth.clone();
            let token = token.to_string();
            tokio::spawn(async move { auth.authenticate(&token).await })
        };
        entered_rx.await.expect("the lookup started");
        (pending, release_tx)
    }

    #[tokio::test]
    async fn a_session_rebound_while_its_check_was_in_flight_stays_valid() {
        // Review of #230: the check snapshotted epoch 0, the password change
        // committed epoch 1 and re-bound this very token, then the lookup
        // (epoch 1) came back. The token is valid under its new binding.
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let changer = login_token(&auth, "alice", false).await;
        let other = login_token(&auth, "alice", true).await;
        let epoch0 = SessionStamp {
            account_id: 1,
            auth_epoch: 0,
        };

        let (changer_check, release_changer) = check_held_in_lookup(&store, &auth, &changer).await;
        store.put("alice", "admin", 1, 1);
        assert!(auth.rotate_session_epoch(&changer, epoch0, 1));
        release_changer.send(()).unwrap();
        let session = changer_check
            .await
            .unwrap()
            .unwrap()
            .expect("the re-bound session must not be reported as revoked");
        assert_eq!(
            session.stamp,
            Some(SessionStamp {
                account_id: 1,
                auth_epoch: 1
            })
        );
        assert!(is_live(&auth, &changer).await);

        // The same interleaving for a session that was NOT re-bound: the
        // store's new epoch is not adopted on its behalf.
        let (other_check, release_other) = check_held_in_lookup(&store, &auth, &other).await;
        release_other.send(()).unwrap();
        assert!(other_check.await.unwrap().unwrap().is_none());
        assert!(!auth.verify(&other), "the stale session is revoked");
        assert!(is_live(&auth, &changer).await);
    }

    #[tokio::test]
    async fn disabled_validation_keeps_the_pre_204_behavior() {
        // The explicit opt-out: nothing is looked up, account changes do not
        // revoke, and the login-time role is what authorizes - exactly what
        // every state did before #204 (and why it must be chosen by name).
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth_without_revocation();
        let normal = login_token(&auth, "alice", false).await;
        let remembered = login_token(&auth, "alice", true).await;
        let unstamped = auth.issue_token(store.get("alice").unwrap().identity);

        store.put("alice", "viewer", 1, 5);
        store.remove("alice");

        for token in [&normal, &remembered, &unstamped] {
            let session = auth.authenticate(token).await.unwrap().unwrap();
            assert_eq!(session.identity.role, "admin");
            assert_eq!(session.stamp, None);
        }
        assert_eq!(store.lookups.load(Ordering::SeqCst), 0);
        assert_eq!(
            protected_router(&auth)
                .oneshot(bearer_get("/protected", &normal))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    async fn login_token(auth: &AuthState, username: &str, remember: bool) -> String {
        match auth
            .login_rate_limited(None, username, "pw", remember)
            .await
        {
            LoginOutcome::Success(token) => token,
            other => panic!("expected Success, got {other:?}"),
        }
    }

    async fn is_live(auth: &AuthState, token: &str) -> bool {
        auth.authenticate(token).await.unwrap().is_some()
    }

    fn protected_router(auth: &AuthState) -> Router {
        Router::new()
            .route("/protected", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                auth.clone(),
                require_auth,
            ))
    }

    fn bearer_get(path: &str, token: &str) -> HttpRequest<Body> {
        HttpRequest::get(path)
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn account_bound_sessions_live_while_the_stamp_matches() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        for remember in [false, true] {
            let token = login_token(&auth, "alice", remember).await;
            let session = auth.authenticate(&token).await.unwrap().unwrap();
            assert_eq!(session.identity.role, "admin");
            assert_eq!(
                session.stamp,
                Some(SessionStamp {
                    account_id: 1,
                    auth_epoch: 0
                })
            );
        }
    }

    #[tokio::test]
    async fn deleting_the_account_revokes_normal_and_remembered_sessions() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let normal = login_token(&auth, "alice", false).await;
        let remembered = login_token(&auth, "alice", true).await;

        store.remove("alice");

        assert!(!is_live(&auth, &normal).await);
        assert!(!is_live(&auth, &remembered).await);
        // Revoked, not just refused once: gone from the token map.
        assert!(!auth.verify(&normal));
        assert!(!auth.verify(&remembered));
    }

    #[tokio::test]
    async fn an_epoch_change_revokes_that_account_only() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        store.put("bob", "editor", 2, 0);
        let auth = store.auth();
        let alice_normal = login_token(&auth, "alice", false).await;
        let alice_remembered = login_token(&auth, "alice", true).await;
        let bob = login_token(&auth, "bob", true).await;

        store.put("alice", "admin", 1, 1);

        assert!(!is_live(&auth, &alice_normal).await);
        assert!(!is_live(&auth, &alice_remembered).await);
        assert!(is_live(&auth, &bob).await);
        // A fresh login after the change is bound to the new epoch.
        let again = login_token(&auth, "alice", false).await;
        assert!(is_live(&auth, &again).await);
    }

    #[tokio::test]
    async fn a_recreated_account_does_not_inherit_the_deleted_accounts_sessions() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = login_token(&auth, "alice", true).await;

        // Deleted and re-created under the same username: same epoch (a new
        // row starts at 0 again), different row id.
        store.remove("alice");
        store.put("alice", "admin", 7, 0);

        assert!(!is_live(&auth, &token).await);
    }

    #[tokio::test]
    async fn authenticate_authorizes_with_the_current_role_and_refreshes_the_cache() {
        // A store that changes the role WITHOUT advancing the epoch (the
        // banto `UsersService` does advance it; a derived store might not):
        // the session survives, but with the role it has NOW.
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = login_token(&auth, "alice", false).await;

        store.put("alice", "viewer", 1, 0);

        let session = auth.authenticate(&token).await.unwrap().unwrap();
        assert_eq!(session.identity.role, "viewer");
        assert_eq!(
            auth.identity_for(&token).unwrap().role,
            "viewer",
            "synchronous readers behind require_auth must see the current role"
        );
    }

    #[tokio::test]
    async fn a_store_failure_fails_the_request_but_keeps_the_session() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = login_token(&auth, "alice", false).await;

        store.failing.store(true, Ordering::SeqCst);
        assert!(auth.authenticate(&token).await.is_err());
        let response = protected_router(&auth)
            .oneshot(bearer_get("/protected", &token))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "a store failure is neither a pass nor a revocation"
        );

        store.failing.store(false, Ordering::SeqCst);
        assert!(is_live(&auth, &token).await);
    }

    #[tokio::test]
    async fn unstamped_tokens_are_rejected_once_a_lookup_is_installed() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let identity = store.get("alice").unwrap().identity;
        let unstamped = auth.issue_token(identity.clone());
        let unstamped_remembered = auth.issue_token_remembered(identity);
        assert!(!is_live(&auth, &unstamped).await);
        assert!(!is_live(&auth, &unstamped_remembered).await);

        let stamped = auth.issue_account_token(store.get("alice").unwrap(), true);
        assert!(is_live(&auth, &stamped).await);
    }

    #[tokio::test]
    async fn public_viewer_sessions_are_not_looked_up() {
        let store = FakeStore::default();
        let auth = store.auth();
        let token = auth.issue_public_viewer_token();
        let session = auth.authenticate(&token).await.unwrap().unwrap();
        assert!(session.public_viewer);
        assert_eq!(store.lookups.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_change_committed_during_login_leaves_the_new_token_dead() {
        // The stamp is read BEFORE the (slow) credential check, so a reset
        // that commits while it runs cannot be outlived by the new token.
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let bump = store.clone();
        *store.during_verify.lock().unwrap() = Some(Box::new(move || {
            bump.put("alice", "admin", 1, 1);
        }));

        let token = login_token(&auth, "alice", false).await;
        assert!(!is_live(&auth, &token).await);
    }

    #[tokio::test]
    async fn login_is_unavailable_when_the_stamp_cannot_be_established() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        store.failing.store(true, Ordering::SeqCst);
        assert!(matches!(
            auth.login_rate_limited(None, "alice", "pw", false).await,
            LoginOutcome::Unavailable
        ));
        assert!(auth.login("alice", "pw").await.is_none());
        assert_eq!(auth.session_count(), 0, "no token may be issued");

        let response = auth_routes(auth.clone())
            .oneshot(
                HttpRequest::post("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"alice","password":"pw"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body_json(response).await["kind"], "other");
    }

    #[tokio::test]
    async fn rotate_session_epoch_rebinds_only_the_named_token_from_the_expected_stamp() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let current = login_token(&auth, "alice", false).await;
        let other = login_token(&auth, "alice", true).await;
        let previous = SessionStamp {
            account_id: 1,
            auth_epoch: 0,
        };

        store.put("alice", "admin", 1, 1);
        assert!(auth.rotate_session_epoch(&current, previous, 1));
        // Already re-bound: a second rotation from the old stamp is refused.
        assert!(!auth.rotate_session_epoch(&current, previous, 1));

        assert!(is_live(&auth, &current).await);
        assert!(!is_live(&auth, &other).await);
        assert!(!auth.rotate_session_epoch(&other, previous, 1), "revoked");
    }

    #[tokio::test]
    async fn check_and_identity_report_a_revoked_session_as_logged_out() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = login_token(&auth, "alice", true).await;
        let router = auth_routes(auth.clone());

        let identity = body_json(
            router
                .clone()
                .oneshot(bearer_get("/api/auth/identity", &token))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(identity["id"], "alice");
        assert_eq!(identity["publicViewer"], false);
        assert!(
            identity.get("stamp").is_none(),
            "the account binding is internal: {identity}"
        );

        store.put("alice", "admin", 1, 1);
        let check = router
            .clone()
            .oneshot(bearer_get("/api/auth/check", &token))
            .await
            .unwrap();
        assert_eq!(body_json(check).await, serde_json::json!(false));
        let identity = router
            .clone()
            .oneshot(bearer_get("/api/auth/identity", &token))
            .await
            .unwrap();
        assert!(body_json(identity).await.is_null());
    }

    #[tokio::test]
    async fn require_auth_rejects_a_revoked_session_with_401() {
        let store = FakeStore::default();
        store.put("alice", "admin", 1, 0);
        let auth = store.auth();
        let token = login_token(&auth, "alice", false).await;
        let protected = protected_router(&auth);
        assert_eq!(
            protected
                .clone()
                .oneshot(bearer_get("/protected", &token))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        store.remove("alice");
        assert_eq!(
            protected
                .clone()
                .oneshot(bearer_get("/protected", &token))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
