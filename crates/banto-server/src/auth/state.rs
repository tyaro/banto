use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use banto_admin_services::audit::{grant_actor_kind, ActorSession, AuditActor, ACTOR_KIND_ACCOUNT};
use banto_core::BantoError;
use futures_util::future::BoxFuture;
use uuid::Uuid;

use super::*;
use crate::grant::{GrantGeneration, GrantKind, GrantSpec};

/// Monotonic clock injected into [`AuthState`] so tests can advance time
/// deterministically instead of sleeping. Production always uses
/// [`Clock::real`], which reports elapsed time since construction; the
/// manually-advanced variant is only constructible under `#[cfg(test)]`.
pub(super) struct Clock {
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

pub(super) struct Inner {
    /// The token table AND the auth mode with its generation (ADR-0034
    /// section 6): one lock, so a mode switch is serialized with every
    /// issuance and every settled authorization.
    pub(super) tokens: RwLock<TokenTable>,
    /// Per grant kind: the FIFO of its tokens (the cap needs the *oldest*
    /// one and `HashMap` has no order) and its revocation generation
    /// (ADR-0017 §2). This is THE internal lock issuance and revocation
    /// serialize on. Lock order: `grants` before `tokens`; never the reverse.
    grants: Mutex<HashMap<GrantKind, GrantQueue>>,
    failures: RwLock<HashMap<String, FailureRecord>>,
    /// Verification slots reserved right now (Issue #279). Lock order: this
    /// before `failures`; never the reverse.
    pub(super) in_flight: Mutex<InFlight>,
    verify_credentials: CredentialVerifier,
    /// Issue #204: `Some` for [`SessionValidation::Lookup`], `None` for
    /// [`SessionValidation::DisabledNoRevocation`]. Fixed at construction,
    /// shared by every clone of this state (they share `Inner`).
    session_lookup: Option<SessionLookup>,
    /// Issue #697: how an account session's per-user permissions are read
    /// ([`AuthState::with_permission_reader`]). `None` = no session holds
    /// any. Set once while the state is built, read on every request.
    permission_reader: RwLock<Option<PermissionReader>>,
    /// The id of the built-in `admin` row ([`AuthState::with_builtin_admin_id`],
    /// ADR-0034 section 3). Set once while the state is built.
    builtin_admin_id: RwLock<Option<i64>>,
    token_policy: TokenPolicy,
    /// Long-lived policy applied to tokens issued with "Remember me" (spec
    /// M11) instead of `token_policy` - see [`TokenRecord::remembered`].
    remembered_policy: TokenPolicy,
    rate_limit: RateLimitPolicy,
    clock: Clock,
}

impl Inner {
    /// Which [`TokenPolicy`] `record` is evaluated against: its own grant
    /// policy when it has one, else the "remembered" or the regular policy by
    /// its `remembered` flag (spec M11).
    fn policy_for(&self, record: &TokenRecord) -> TokenPolicy {
        record.policy.unwrap_or(if record.remembered {
            self.remembered_policy
        } else {
            self.token_policy
        })
    }

    /// Drop every expired record (the opportunistic sweep on each write).
    fn sweep_expired(&self, tokens: &mut TokenTable, now: Duration) {
        tokens
            .records
            .retain(|_, record| !record.is_expired(now, &self.policy_for(record)));
    }
}

/// Shared, cloneable auth state: an in-memory map of valid bearer tokens to
/// the [`Identity`] that logged in with them (each with expiry bookkeeping),
/// a per-key failed-login counter, and an injected async credential verifier.
/// Cloning is cheap (`Arc` handle).
#[derive(Clone)]
pub struct AuthState {
    pub(super) inner: Arc<Inner>,
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
                tokens: RwLock::new(TokenTable::default()),
                grants: Mutex::new(HashMap::new()),
                failures: RwLock::new(HashMap::new()),
                in_flight: Mutex::new(InFlight::default()),
                verify_credentials,
                session_lookup,
                permission_reader: RwLock::new(None),
                builtin_admin_id: RwLock::new(None),
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

    /// Install how an account session's per-user permissions are read
    /// (Issue #697, user-permissions-plan §5). [`crate::require_auth`] calls
    /// it once per request for an account session and puts the result into
    /// the request extensions as a [`SessionPermissions`], which
    /// `crate::routes::require_permission` and handlers (through
    /// `Extension<SessionPermissions>`) decide on. Read per request, so a
    /// revoked permission stops working on the next request without ending
    /// the session.
    ///
    /// Without a reader no session holds any permission (fail closed). A
    /// grant session (ADR-0017) never holds any, reader or not. Applies to
    /// every clone of this state (they share it); call it while building the
    /// state, before serving.
    pub fn with_permission_reader(
        self,
        reader: impl Fn(i64) -> BoxFuture<'static, Result<SessionPermissions, BantoError>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        let reader: PermissionReader = Arc::new(reader);
        *self
            .inner
            .permission_reader
            .write()
            .expect("auth permission reader lock poisoned") = Some(reader);
        self
    }

    /// Tell the state the id of the built-in `admin` row (ADR-0034 section
    /// 3). The wiring reads it ONCE at startup by `kind = 'builtin'`
    /// (`UsersService::check_startup`) - never by name, never as a fixed
    /// number - and it becomes the `actor_id` of every session marked
    /// `audit_as_builtin_admin`. Applies to every clone of this state; call
    /// it while building the state, before serving. (A restore swaps the
    /// database only across a restart, so the id cannot go stale.)
    pub fn with_builtin_admin_id(self, id: i64) -> Self {
        *self
            .inner
            .builtin_admin_id
            .write()
            .expect("auth builtin admin lock poisoned") = Some(id);
        self
    }

    /// Who the audit log attributes `session`'s actions to (ADR-0034 section
    /// 3) - the snapshot [`crate::require_auth`] puts into the request's
    /// extensions. One rule for every session, the service layer's
    /// [`AuditActor::attribute`] (the desktop commands call the same one):
    ///
    /// - an account: its username, `actor_id` = its `users.id`, kind
    ///   `account`;
    /// - a grant with the mark: the built-in `admin`, `actor_id` = the
    ///   built-in row's id, kind `grant:<kind>`;
    /// - a grant without it: its fixed id, no `actor_id`, kind `grant:<kind>`.
    ///
    /// The role is the session's own in every case.
    pub fn audit_actor(&self, session: &AuthenticatedSession) -> AuditActor {
        let grant_kind = session
            .grant
            .as_ref()
            .map(|kind| grant_actor_kind(kind.as_str()));
        let builtin_admin_id = *self
            .inner
            .builtin_admin_id
            .read()
            .expect("auth builtin admin lock poisoned");
        AuditActor::attribute(
            ActorSession {
                username: &session.identity.id,
                account_id: session.stamp.map(|stamp| stamp.account_id),
                role: &session.identity.role,
                kind: grant_kind.as_deref().unwrap_or(ACTOR_KIND_ACCOUNT),
                audit_as_builtin_admin: session.audit_as_builtin_admin,
            },
            builtin_admin_id,
        )
    }

    /// The per-user permissions `session` is authorized with (Issue #697):
    /// none for a grant session, for a session without an account stamp, or
    /// when no reader is installed ([`AuthState::with_permission_reader`]);
    /// otherwise what the reader returns for the session's account right
    /// now. `Err` = the store could not answer (fail the request).
    pub async fn session_permissions(
        &self,
        session: &AuthenticatedSession,
    ) -> Result<SessionPermissions, BantoError> {
        if session.grant.is_some() {
            return Ok(SessionPermissions::none());
        }
        let Some(stamp) = session.stamp else {
            return Ok(SessionPermissions::none());
        };
        let reader = self
            .inner
            .permission_reader
            .read()
            .expect("auth permission reader lock poisoned")
            .clone();
        match reader {
            Some(reader) => reader(stamp.account_id).await,
            None => Ok(SessionPermissions::none()),
        }
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
    ///
    /// ADR-0034 section 6: like [`AuthState::login_rate_limited`], it issues
    /// nothing in [`AuthMode::NoLogin`] or when the mode was switched while
    /// the credentials were being verified (`None`).
    pub async fn login(&self, username: &str, password: &str) -> Option<String> {
        let (mode, entered) = self.mode_now();
        if mode == AuthMode::NoLogin {
            return None;
        }
        match self.verify_and_stamp(username, password).await {
            StampedLogin::Accepted(identity, stamp) => self
                .issue_token_with(identity, false, stamp, Some(entered))
                .ok(),
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
    ///
    /// Serialized with the auth mode (ADR-0034 section 6): the mode's
    /// generation is read on entry, and the token is inserted only if - under
    /// the token table's lock - the generation is still that one and the mode
    /// is [`AuthMode::LoginRequired`]. A [`AuthState::switch_auth_mode`] that
    /// completed while the verifier was awaited therefore wins: nothing is
    /// issued, right credentials or not ([`LoginOutcome::LoginDisabled`], or
    /// [`LoginOutcome::Unavailable`] when the mode is back to login-required).
    /// In [`AuthMode::NoLogin`] on entry the verifier does not run at all.
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

        // ADR-0034 section 6: the generation this login belongs to, read
        // before anything is awaited. No-login mode refuses here, before the
        // verifier (nothing is verified, counted or reserved).
        let (mode, entered) = self.mode_now();
        if mode == AuthMode::NoLogin {
            return LoginOutcome::LoginDisabled;
        }

        // BOTH dimensions are checked before the expensive verifier runs, so
        // a lockout on either one short-circuits argon2 (this is the property
        // that makes the endpoint DoS-resistant, not just brute-force-proof).
        //
        // The check also RESERVES a verification slot atomically (Issue
        // #279): attempts still in flight count like recorded failures, so a
        // burst that lands before the first failure is recorded cannot all
        // slip past the same check. The guard is held across the verifier
        // await and releases the slot however this future ends, cancellation
        // included.
        let _slot = match self.reserve_attempt(&account_key, ip_key.as_deref()) {
            Ok(slot) => slot,
            Err(retry_after) => return LoginOutcome::RateLimited { retry_after },
        };

        match self.verify_and_stamp(username, password).await {
            StampedLogin::Accepted(identity, stamp) => {
                self.reset_failures(&account_key);
                if let Some(ip_key) = &ip_key {
                    self.reset_failures(ip_key);
                }
                // The password was right either way, so the streak is cleared
                // above even when the mode switch below refuses the token.
                match self.issue_token_with(identity, remember, stamp, Some(entered)) {
                    Ok(token) => LoginOutcome::Success(token),
                    Err(IssueRefusal::NoLogin) => LoginOutcome::LoginDisabled,
                    Err(IssueRefusal::Switched) => LoginOutcome::Unavailable,
                }
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
    /// [`SessionLookup`] is installed (e.g. an app's own sign-in route).
    /// `remember` selects the "Remember me" policy (spec M11).
    ///
    /// ADR-0034 section 6: in [`AuthMode::NoLogin`] no account token exists,
    /// so the returned token is NOT stored - it is rejected on first use,
    /// like any unknown token. (The signature stays infallible; the mode is
    /// decided under the same lock as a switch, so there is no window.)
    pub fn issue_account_token(&self, account: SessionAccount, remember: bool) -> String {
        self.issue_unobserved(account.identity, remember, Some(account.stamp))
    }

    /// Mint and store a new bearer token for an already-verified `identity`,
    /// without going through `verify_credentials` again. Used by callers
    /// that just created/authenticated an account through some other path
    /// and want to log the new session in immediately, the same way `login`
    /// would. Not "remembered"
    /// (spec M11) - use [`AuthState::issue_token_remembered`] for that.
    ///
    /// The token carries no [`SessionStamp`] (Issue #204): while a
    /// [`SessionLookup`] is installed it is rejected on first use - use
    /// [`AuthState::issue_account_token`] there instead. Not stored in
    /// [`AuthMode::NoLogin`] either (see [`AuthState::issue_account_token`]).
    pub fn issue_token(&self, identity: Identity) -> String {
        self.issue_unobserved(identity, false, None)
    }

    /// Like [`AuthState::issue_token`], but the token is issued as
    /// "remembered" (spec M11 "LAN Remember me"): it is evaluated against
    /// `remembered_policy` instead of `token_policy` for the rest of its
    /// life. Unstamped, like [`AuthState::issue_token`].
    pub fn issue_token_remembered(&self, identity: Identity) -> String {
        self.issue_unobserved(identity, true, None)
    }

    /// The `issue_*` family: the caller did not await anything between its
    /// own decision and this call, so there is no earlier generation to hold
    /// it to - only the mode as it is now decides. A refused issuance hands
    /// back a token that was never stored.
    fn issue_unobserved(
        &self,
        identity: Identity,
        remembered: bool,
        stamp: Option<SessionStamp>,
    ) -> String {
        self.issue_token_with(identity, remembered, stamp, None)
            .unwrap_or_else(|_| Uuid::new_v4().to_string())
    }

    /// The auth mode right now ([`AuthMode::LoginRequired`] until
    /// [`AuthState::switch_auth_mode`] says otherwise).
    pub fn auth_mode(&self) -> AuthMode {
        self.mode_now().0
    }

    /// The mode and its generation, read together.
    fn mode_now(&self) -> (AuthMode, u64) {
        let tokens = self.inner.tokens.read().expect("auth token lock poisoned");
        (tokens.mode, tokens.mode_generation)
    }

    /// The auth-mode generation right now.
    /// [`AuthState::authenticate_with_permissions`] reads it on entry and
    /// compares it once more when the authorization is complete.
    pub(super) fn mode_generation(&self) -> u64 {
        self.mode_now().1
    }

    /// [`AuthState::authenticate`] plus the session's per-user permissions
    /// ([`AuthState::session_permissions`]), as ONE authorization that is
    /// serialized with the auth mode to its very end (ADR-0034 section 6).
    ///
    /// `authenticate` settles the token against the mode as it is when the
    /// account lookup returns; reading the permissions awaits once more. So
    /// the mode's generation is read on entry and compared again after the
    /// permissions were read: generations only grow, which makes "still the
    /// one read on entry" cover both awaits. An account session whose
    /// authorization was still in flight when
    /// [`AuthState::switch_auth_mode`] completed is `Ok(None)`. A grant
    /// session is outside the mode (ADR-0017).
    ///
    /// Everything that reads the permissions next to a token goes through
    /// here - [`require_auth`], `GET /api/auth/identity`, and a permission
    /// guard stacked without `require_auth` - so none of them can answer for
    /// a session of a generation that ended. Code that needs both must not
    /// pair `authenticate` and `session_permissions` by hand.
    pub async fn authenticate_with_permissions(
        &self,
        token: &str,
    ) -> Result<Option<(AuthenticatedSession, SessionPermissions)>, BantoError> {
        let entered = self.mode_generation();
        let Some(session) = self.authenticate(token).await? else {
            return Ok(None);
        };
        let permissions = self.session_permissions(&session).await?;
        if session.grant.is_none() && self.mode_generation() != entered {
            return Ok(None);
        }
        Ok(Some((session, permissions)))
    }

    /// Switch the auth mode (ADR-0034 section 6): under the token table's one
    /// lock, advance the mode's generation AND revoke every account token.
    /// Returns how many were revoked (the caller may record it in its audit
    /// detail). Grant tokens are untouched - a kind whose condition the
    /// switch closes is revoked by its own
    /// [`AuthState::revoke_grant_tokens`] (ADR-0017 section 2).
    ///
    /// The contract once this returns: nothing of an earlier generation can
    /// be issued or used.
    ///
    /// - a login that passed its entry check and is still verifying
    ///   credentials issues nothing ([`AuthState::login_rate_limited`]);
    /// - a request whose account lookup is still in flight is not authorized
    ///   ([`AuthState::authenticate`] settles against the table after the
    ///   lookup; [`AuthState::authenticate_with_permissions`] compares the
    ///   generation once more after the permissions were read);
    /// - a request that was ALREADY authorized (it is past the guard, holding
    ///   its `AuditActor` snapshot) is not interrupted: it runs to the end as
    ///   the actor it was authorized as, the same rule as for any other
    ///   session end (conventions section 1, Issue #793). The switch does not
    ///   wait for it.
    ///
    /// The side that changes the stored setting must call this right after
    /// persisting it, in the same function, with no `.await` in between (the
    /// order ADR-0017 section 2 uses for grants). Switching to the mode the
    /// state is already in changes nothing and returns 0.
    pub fn switch_auth_mode(&self, mode: AuthMode) -> usize {
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        if tokens.mode == mode {
            return 0;
        }
        tokens.mode = mode;
        tokens.mode_generation += 1;
        let before = tokens.records.len();
        tokens.records.retain(|_, record| record.grant.is_some());
        before - tokens.records.len()
    }

    /// The revocation generation of `kind` RIGHT NOW (ADR-0017 §2). An issuer
    /// reads this BEFORE judging the kind's condition and hands it to
    /// [`AuthState::issue_grant_token`]; a [`AuthState::revoke_grant_tokens`]
    /// in between makes that issuance a no-op. A kind nothing has touched yet
    /// is at generation 0 (the same value its first issuance will see).
    pub fn grant_generation(&self, kind: &GrantKind) -> GrantGeneration {
        let grants = self.inner.grants.lock().expect("auth grant lock poisoned");
        GrantGeneration(grants.get(kind).map_or(0, |queue| queue.generation))
    }

    /// Mint a grant session (ADR-0017; viewer-public is one kind): a regular
    /// (non-remembered) bearer token bound to `spec.identity` - the identity
    /// is the spec's, never the caller's, so there is no escalation path to
    /// review. Everything downstream is unchanged: the token goes through the
    /// same [`require_auth`] + `RoleGuard` + audit path as a logged-in
    /// session, and only the account re-check (Issue #204) is skipped.
    ///
    /// Inserts ONLY while `observed` (read with [`AuthState::grant_generation`]
    /// before the condition was judged) is still the kind's generation,
    /// checked under the same internal lock [`AuthState::revoke_grant_tokens`]
    /// advances it with; otherwise nothing is inserted and `None` is
    /// returned (the issuing route answers `403` - the condition was closed
    /// while this issuance was judging, and re-judging right after a close
    /// has no point). This is what makes "persist the closed condition, then
    /// revoke" sufficient for the application.
    ///
    /// Past `spec.max_sessions` outstanding tokens of the kind, the OLDEST is
    /// revoked to make room - only tokens of this kind; real login sessions
    /// and other kinds are never touched. Lifetime: `spec.policy`, or the
    /// state's regular [`TokenPolicy`] (never the "remembered" one): an
    /// expired grant is simply re-issued by the client's fallback, so an
    /// anonymous LAN client never holds a 30-day token.
    pub fn issue_grant_token(&self, spec: &GrantSpec, observed: GrantGeneration) -> Option<String> {
        let token = Uuid::new_v4().to_string();
        let now = self.inner.clock.now();
        // Lock order: `grants` -> `tokens` (same as `revoke_grant_tokens`).
        let mut grants = self.inner.grants.lock().expect("auth grant lock poisoned");
        let queue = grants.entry(spec.kind.clone()).or_default();
        if queue.generation != observed.0 {
            return None;
        }
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        self.inner.sweep_expired(&mut tokens, now);
        let mode_generation = tokens.mode_generation;
        tokens.records.insert(
            token.clone(),
            TokenRecord {
                // A grant session never carries an `accountId` (ADR-0034
                // section 1): its owner on the screen is its kind, and there
                // is no account row behind it.
                identity: Identity {
                    account_id: None,
                    ..spec.identity.clone()
                },
                issued_at: now,
                last_used: now,
                remembered: false,
                grant: Some(spec.kind.clone()),
                policy: spec.policy,
                stamp: None,
                audit_as_builtin_admin: spec.audit_as_builtin_admin,
                mode_generation,
            },
        );
        queue.tokens.push_back(token.clone());
        while queue.tokens.len() > spec.max_sessions.max(1) {
            if let Some(oldest) = queue.tokens.pop_front() {
                tokens.records.remove(&oldest);
            }
        }
        Some(token)
    }

    /// Revoke every outstanding token of `kind` and advance its generation
    /// (ADR-0017 §2), under the one internal lock
    /// [`AuthState::issue_grant_token`] checks that generation with. Only
    /// that kind's tokens are touched; real login sessions and other kinds
    /// are never revoked here. The `AuthState` outlives server restarts (the
    /// app shares one across `server_apply`), so the side that closes a
    /// kind's condition (viewer-public turned OFF, a commissioning lock-down)
    /// must call this right after persisting the closed condition - in that
    /// order. Returns how many tokens were removed (the caller may record it
    /// as `revokedGrants` in its audit detail).
    pub fn revoke_grant_tokens(&self, kind: &GrantKind) -> usize {
        let mut grants = self.inner.grants.lock().expect("auth grant lock poisoned");
        let queue = grants.entry(kind.clone()).or_default();
        queue.generation += 1;
        let queued: Vec<String> = queue.tokens.drain(..).collect();
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        let before = tokens.records.len();
        for t in queued {
            tokens.records.remove(&t);
        }
        // Defensive: also drop any record of the kind the FIFO lost track of.
        tokens
            .records
            .retain(|_, record| record.grant.as_ref() != Some(kind));
        before - tokens.records.len()
    }

    /// Shared implementation of [`AuthState::issue_token`]/
    /// [`AuthState::issue_token_remembered`]/[`AuthState::login_rate_limited`]
    /// (account sessions; grants go through [`AuthState::issue_grant_token`]).
    ///
    /// Opportunistically sweeps already-expired tokens under the same write
    /// lock, so the map stays bounded without a background reaper. Each
    /// existing record is checked against whichever policy applies to IT
    /// (its own `remembered` flag / grant policy), not the policy of the
    /// token being inserted.
    ///
    /// ADR-0034 section 6: the insert happens only while the mode is
    /// [`AuthMode::LoginRequired`] and - when the issuer awaited something
    /// since it read the generation (`observed`) - the generation is still
    /// that one. Decided under the lock [`AuthState::switch_auth_mode`]
    /// switches under, so an issuance can never land after a switch it
    /// started before.
    fn issue_token_with(
        &self,
        identity: Identity,
        remembered: bool,
        stamp: Option<SessionStamp>,
        observed: Option<u64>,
    ) -> Result<String, IssueRefusal> {
        let token = Uuid::new_v4().to_string();
        let now = self.inner.clock.now();
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        if tokens.mode == AuthMode::NoLogin {
            return Err(IssueRefusal::NoLogin);
        }
        let mode_generation = tokens.mode_generation;
        if observed.is_some_and(|observed| observed != mode_generation) {
            return Err(IssueRefusal::Switched);
        }
        self.inner.sweep_expired(&mut tokens, now);
        tokens.records.insert(
            token.clone(),
            TokenRecord {
                identity,
                issued_at: now,
                last_used: now,
                remembered,
                grant: None,
                policy: None,
                stamp,
                audit_as_builtin_admin: false,
                mode_generation,
            },
        );
        Ok(token)
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
            .records
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
            .records
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
    ///   refreshed to it. The token was still present, unexpired and bound to
    ///   the stamp the store reported AFTER the lookup returned (decided
    ///   under one lock, `AuthState::settle_lookup`) - a token logged out,
    ///   expired or revoked while the lookup was in flight is `Ok(None)`;
    /// - `Ok(None)`: unknown/expired token, or the account is gone or its
    ///   stamp changed (or the token has no stamp) - the token is revoked;
    /// - `Err`: the store could not answer. The token is kept (a transient
    ///   store failure must not log everyone out) but the caller must fail
    ///   the request.
    pub async fn authenticate(
        &self,
        token: &str,
    ) -> Result<Option<AuthenticatedSession>, BantoError> {
        self.authenticate_with(token, IdleWindow::Slide).await
    }

    /// [`AuthState::authenticate`] for a check the client did not ask for -
    /// the periodic re-check of a long-lived stream that is already open
    /// (Issue #231: this crate's own `/api/events`; Issue #239: exposed so a
    /// derived app's own stream, e.g. banto-industrial's `/api/tag-stream` /
    /// `/api/v1/stream`, banto-industrial#430, can do the same). Same
    /// verdicts - including the in-flight re-binding rule of
    /// `AuthState::settle_lookup` and "a store failure is `Err`,
    /// the token is kept" - but it does NOT slide the token's idle window:
    /// an open tab's stream must not keep an otherwise idle session alive
    /// (spec §11.2's `idle_ttl` would never lapse while a browser tab stays
    /// open). This is the ONLY difference from [`AuthState::authenticate`];
    /// use `authenticate` (or `require_auth`) for anything the client
    /// actually asked for.
    ///
    /// Return value (the same verdicts as `authenticate`):
    ///
    /// - `Ok(Some(_))`: valid right now; the returned identity is current.
    /// - `Ok(None)`: not valid right now - e.g. an unknown or logged-out
    ///   token, idle or absolute expiry, a deleted account, a changed
    ///   role/password (stamp mismatch) or an unstamped session. Whether the
    ///   token is also dropped from the in-memory store is NOT part of this
    ///   contract (a token re-bound while this check was in flight is left
    ///   for its next check to decide).
    /// - `Err(BantoError)`: the backing account store could not be checked.
    ///   The token is kept, and the caller may simply try again later.
    ///
    /// Policy for a long-lived stream (this crate's own use in `events.rs`;
    /// see [`crate::events`]'s module doc and `event_stream`) - a caller
    /// decision, not part of `revalidate`'s meaning:
    ///
    /// - end the stream on `Ok(None)`;
    /// - keep the stream open (fail-open) on `Err`, and likewise when the
    ///   caller's own timeout around this call elapses (that is the
    ///   wrapper's error, e.g. `tokio::time::error::Elapsed`, not a
    ///   `revalidate` `Err`) - a transient store failure must not drop every
    ///   open stream;
    /// - re-check on a fixed period, wrap the call in a timeout shorter than
    ///   that period (so a stuck lookup cannot delay the next check), and
    ///   re-arm the next deadline only after the check finishes (from
    ///   completion, not from when it was scheduled) so a slow check cannot
    ///   starve later ones.
    pub async fn revalidate(
        &self,
        token: &str,
    ) -> Result<Option<AuthenticatedSession>, BantoError> {
        self.authenticate_with(token, IdleWindow::Keep).await
    }

    /// The lookup awaits, so its result is settled against the token's state
    /// after it returns (`AuthState::settle_lookup`), never against the
    /// session read before it.
    async fn authenticate_with(
        &self,
        token: &str,
        idle: IdleWindow,
    ) -> Result<Option<AuthenticatedSession>, BantoError> {
        // One extra round only for a token that was re-bound while its lookup
        // was in flight (see `settle_lookup`); every other case is decided in
        // the first round.
        for _ in 0..2 {
            let Some(session) = self.session_for_with(token, idle) else {
                return Ok(None);
            };
            let Some(lookup) = self.session_lookup() else {
                return Ok(Some(session));
            };
            if session.grant.is_some() {
                // A grant session (ADR-0017): no account behind it, and its
                // fixed identity cannot change, so there is nothing to
                // re-check. It ends only through its token (expiry, `logout`,
                // `revoke_grant_tokens`).
                return Ok(Some(session));
            }
            let Some(stamp) = session.stamp else {
                self.revoke_if_stamp(token, None);
                return Ok(None);
            };
            let account = lookup(session.identity.id.clone()).await?;
            match self.settle_lookup(token, stamp, account) {
                Settled::Valid(session) => return Ok(Some(session)),
                Settled::Invalid => return Ok(None),
                Settled::Rebound => {}
            }
        }
        Ok(None)
    }

    /// Decide a finished account lookup against the token's state AS IT IS
    /// NOW, under one lock (Issue #793 S2 review): the lookup awaited, and the
    /// token may have been logged out, expired, revoked or re-bound meanwhile.
    /// A session is reported valid only if, at this instant, the token is
    /// present, not expired, and bound to exactly the stamp the store
    /// reported. `validated` is the stamp the lookup started from.
    ///
    /// - the token is gone, has expired, or belongs to an auth-mode
    ///   generation that ended ([`AuthState::switch_auth_mode`], ADR-0034
    ///   section 6) -> `Invalid` (it is evicted);
    /// - the token is bound to the stamp the store reports -> `Valid`, with
    ///   its identity refreshed (for the synchronous
    ///   [`AuthState::identity_for`] readers behind [`require_auth`]). This
    ///   covers both the ordinary case and a token re-bound meanwhile
    ///   ([`AuthState::rotate_session_epoch`], its own password change) to
    ///   EXACTLY the store's new stamp. Only the token's own re-binding
    ///   counts; this never adopts the store's newest epoch on a token's
    ///   behalf, so the account's other sessions still end;
    /// - the token is still bound to `validated` but the store reports
    ///   something else (or no account) -> it really is stale: revoke it,
    ///   `Invalid`;
    /// - the token was re-bound meanwhile to a stamp this lookup did not
    ///   report (the lookup read the account before the change committed, or
    ///   the account changed again) -> `Rebound`: this lookup cannot decide
    ///   it. The token is left alone and the caller looks up once more.
    fn settle_lookup(
        &self,
        token: &str,
        validated: SessionStamp,
        account: Option<SessionAccount>,
    ) -> Settled {
        let now = self.inner.clock.now();
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");
        let Some(record) = tokens.records.get(token) else {
            return Settled::Invalid;
        };
        // ADR-0034 section 6: a token of an earlier mode generation (or any
        // account token in no-login mode) is gone already - the switch
        // removed it under this lock - so this is the same verdict stated
        // outright rather than left to the removal.
        if record.is_expired(now, &self.inner.policy_for(record)) || !tokens.mode_admits(record) {
            tokens.records.remove(token);
            return Settled::Invalid;
        }
        let current = record.stamp;
        match account {
            Some(account) if current == Some(account.stamp) => {
                let record = tokens
                    .records
                    .get_mut(token)
                    .expect("token was just confirmed present");
                record.identity = account.identity.clone();
                Settled::Valid(AuthenticatedSession {
                    identity: account.identity,
                    grant: None,
                    stamp: Some(account.stamp),
                    audit_as_builtin_admin: false,
                })
            }
            _ if current == Some(validated) => {
                tokens.records.remove(token);
                Settled::Invalid
            }
            _ => Settled::Rebound,
        }
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
        match tokens.records.get_mut(token) {
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
            .records
            .get(token)
            .is_some_and(|record| record.stamp == stamp)
        {
            tokens.records.remove(token);
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
        self.session_for_with(token, IdleWindow::Slide)
    }

    /// [`AuthState::session_for`], sliding the idle window only for
    /// [`IdleWindow::Slide`] (expiry is enforced either way).
    fn session_for_with(&self, token: &str, idle: IdleWindow) -> Option<AuthenticatedSession> {
        let now = self.inner.clock.now();
        let mut tokens = self.inner.tokens.write().expect("auth token lock poisoned");

        // Expired, or not admitted by the auth mode as it is now (ADR-0034
        // section 6; see `settle_lookup`).
        let expired = {
            let record = tokens.records.get(token)?;
            record.is_expired(now, &self.inner.policy_for(record)) || !tokens.mode_admits(record)
        };

        if expired {
            tokens.records.remove(token);
            None
        } else {
            let record = tokens
                .records
                .get_mut(token)
                .expect("token was just confirmed present");
            if idle == IdleWindow::Slide {
                record.last_used = now;
            }
            Some(AuthenticatedSession {
                identity: record.identity.clone(),
                grant: record.grant.clone(),
                stamp: record.stamp,
                audit_as_builtin_admin: record.audit_as_builtin_admin,
            })
        }
    }

    /// Atomically decide whether a login attempt may start the (expensive)
    /// verifier and, if so, reserve its slot (Issue #279). `Err` carries the
    /// `Retry-After` for an immediate [`LoginOutcome::RateLimited`].
    ///
    /// Refused when any of these holds:
    /// - either key is locked out (the pre-existing lockout);
    /// - recorded failures + attempts in flight reach the key's threshold
    ///   (`max_failures` per account key, `max_ip_failures` per IP key) - so
    ///   concurrency can never buy more attempts than the sequential policy;
    /// - [`MAX_IN_FLIGHT_PER_IP`] or [`MAX_CONCURRENT_VERIFICATIONS`] is
    ///   reached (a pure resource cap; no lockout starts, the answer is the
    ///   same `RateLimited` with a short retry).
    ///
    /// Holds the `in_flight` mutex for the whole check-and-reserve, taking
    /// the `failures` read lock inside it (the documented lock order).
    fn reserve_attempt(
        &self,
        account_key: &str,
        ip_key: Option<&str>,
    ) -> Result<InFlightGuard, Duration> {
        let policy = self.inner.rate_limit;
        let mut in_flight = self
            .inner
            .in_flight
            .lock()
            .expect("auth in-flight lock poisoned");

        let mut retry_after = self.locked_out(account_key);
        if let Some(ip_key) = ip_key {
            retry_after = max_option(retry_after, self.locked_out(ip_key));
        }
        if let Some(retry_after) = retry_after {
            return Err(retry_after);
        }

        let account_busy = self.live_failure_count(account_key) + in_flight.count(account_key)
            >= policy.max_failures as usize;
        let ip_busy = ip_key.is_some_and(|ip_key| {
            let held = in_flight.count(ip_key);
            held >= MAX_IN_FLIGHT_PER_IP
                || self.live_failure_count(ip_key) + held >= policy.max_ip_failures as usize
        });
        if account_busy || ip_busy || in_flight.total >= MAX_CONCURRENT_VERIFICATIONS {
            return Err(SATURATED_RETRY_AFTER);
        }

        let mut keys = vec![account_key.to_string()];
        keys.extend(ip_key.map(str::to_string));
        in_flight.total += 1;
        for key in &keys {
            *in_flight.per_key.entry(key.clone()).or_insert(0) += 1;
        }
        Ok(InFlightGuard {
            inner: Arc::clone(&self.inner),
            keys,
        })
    }

    /// Failures currently counting toward `key`'s streak: 0 when the record
    /// is absent or its streak has aged out (same staleness rule as
    /// [`AuthState::record_failure`]).
    fn live_failure_count(&self, key: &str) -> usize {
        let now = self.inner.clock.now();
        let lockout = self.inner.rate_limit.lockout;
        let failures = self
            .inner
            .failures
            .read()
            .expect("auth failure lock poisoned");
        failures
            .get(key)
            .filter(|record| now.saturating_sub(record.last_failure) < lockout)
            .map_or(0, |record| record.count as usize)
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
    pub(super) fn with_frozen_clock(
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
    pub(super) fn advance(&self, by: Duration) {
        self.inner.clock.advance(by);
    }
}

/// How many chars of the username go into a [`rate_limit_key`] (twice the
/// longest creatable username, so no real account is ever affected).
const RATE_LIMIT_KEY_USERNAME_CHARS: usize = 64;

/// Lockout key for a login attempt (spec §11.2): client IP + username when
/// the peer address is known, falling back to username-only when it is not
/// (e.g. a caller that did not wire up `ConnectInfo`). Keying on the pair
/// (rather than IP alone) avoids one noisy client on a shared NAT locking out
/// every account behind it, while still binding the streak to a network
/// origin when available.
pub fn rate_limit_key(ip: Option<IpAddr>, username: &str) -> String {
    // Bound the key's size (Issue #278): the username is attacker-controlled
    // and this key lives in the failure map. No real account name is this
    // long, so the cut only ever merges overlong junk names together.
    let username: String = username
        .chars()
        .take(RATE_LIMIT_KEY_USERNAME_CHARS)
        .collect();
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
pub(super) fn max_option(a: Option<Duration>, b: Option<Duration>) -> Option<Duration> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}
