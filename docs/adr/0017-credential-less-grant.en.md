# ADR-0017: Generalize credential-less session issuance into "grants", with viewer-public as the first kind and a derived app's commissioning mode as the second (no auth-bypass hook in banto)

> 日本語: [0017-credential-less-grant.md](0017-credential-less-grant.md)

- Status: Accepted (owner decision 2026-10-02; implementation in the v2.2.0 PR; the open details are listed under "Open points" and are settled in the implementation PR)
- Date: 2026-10-02
- Related: [ADR-0012](0012-lan-public-viewer-synthetic-session.en.md) (viewer-public = a viewer-only synthetic session; this ADR generalizes it and does not supersede it) /
  [ADR-0014](0014-account-bound-session-revocation.en.md) (account-bound revocation; grant sessions are outside it) /
  [ADR-0016](0016-session-controller-single-writer.en.md) and [docs/session-controller-design.md](../session-controller-design.md) §4.7, §6.2, I-13, I-21 (`adopt()`/`end()` become deprecated) /
  [docs/viewer-public-plan.md](../viewer-public-plan.md) §2.2 / conventions §1, §6, §10 /
  derived app: banto-hub's "commissioning mode" in tyaro/banto-industrial
- Code under discussion: banto v2.1.1 (`25f2291`). `file:line` references below are to that version

## Context

banto has one entry point that hands out a session without credentials: viewer-public
(ADR-0012). `POST /api/auth/public-viewer` issues a bearer token bound to the fixed identity
`{ id: "public", role: "viewer" }` while `server.viewer_public` is ON
(`crates/banto-server/src/routes/auth.rs:95-105`, `crates/banto-server/src/auth.rs:890-926`).
After issuance the token rides the same `require_auth` + `RoleGuard` + audit path as a login,
skipping only the account check (ADR-0014, `auth.rs:1131-1135`). The implementation is
specific to viewer-public:

- a **one-bit** provenance, `TokenRecord.public_viewer: bool` (`auth.rs:424-425`) and
  `AuthenticatedSession.public_viewer: bool` (`auth.rs:255-262`);
- a FIFO of public tokens only, `Inner::public_tokens` (`auth.rs:577`), capped by
  `MAX_PUBLIC_VIEWER_SESSIONS = 256` (`auth.rs:154`);
- the issuance condition hard-coded in the handler (`routes/auth.rs:98`,
  `SettingsService::server_config().viewer_public`);
- revocation on OFF via `revoke_public_viewer_tokens` (`auth.rs:936-953`), called by the app's
  `save_server_config_locked` (`apps/admin-template/src-tauri/src/lib.rs:2155-2166`);
- on the client, `publicViewerFallback` (`packages/admin-core/src/sessionController.svelte.ts:1150-1218`),
  `AuthProvider.enterPublicViewer` and `status().viewerPublic` (`packages/admin-core/src/provider.ts:129,166-168`,
  `providers/http.ts:537-562`), and `kindOfResolvedAuth` deriving `kind: 'publicViewer'` from the
  `identity.publicViewer` marker (`sessionController.svelte.ts:225-229`).

The derived app banto-hub (tyaro/banto-industrial) solves the same need - a session without
credentials - in a **different shape** for its "commissioning mode": until the server is locked
down, its own authorization in 34 places **lets every request through unauthenticated as a
synthesized admin**, and the front end confirms the commissioning session with
`SessionController.adopt()`/`end()` (design §4.7 S-44 to S-46, the policy runner of §6.2)
without going through the provider. Two problems:

1. **The auth bypass is scattered over 34 places in the derived app.** Requests exist that go
   through none of banto's `require_auth`, `RoleGuard`, audit or SSE re-validation
   (`crates/banto-server/src/events.rs:210`); a missed lock-down check is directly an
   unauthenticated admin surface. This breaks conventions §6 ("authorization is explicit",
   "no auth-bypassing public router" - the reason ADR-0012 rejected its options B and C) in the
   derived app.
2. **An `adopt()`ed session has no token**, so `resolve()` cannot ask the provider (I-13), its
   ticket is epoch-only (I-21) and an SSE 401 cannot trigger a confirmation (S-45). The
   controller keeps an exception to "the provider answers in one round trip" (ADR-0016) in its
   core for a single consumer.

What had to be decided: **what banto offers when a derived app needs an "admin-equivalent
session without credentials"**. Constraints:

- No bypass hook ("skip authentication when this condition holds") in banto. The authorization
  entry stays a single bearer path (do not weaken ADR-0012).
- Existing viewer-public users (`--preset display`, the two derived apps) keep working.
  v2.1.1 → **minor**.
- Condition, cap, revocation and lifetime can be expressed in the same shape as viewer-public
  (only the identity and the condition differ).

## Decision

**Generalize viewer-public's "conditional, credential-less token issuance" into a `grant`;
viewer-public becomes the first kind (`publicViewer`) and a derived app's commissioning mode the
second (app-defined, e.g. `commissioning`).** Only issuance is generalized; afterwards the token
is an ordinary bearer session through `require_auth` + `RoleGuard` + audit + SSE re-validation.
No bypass hook. The front end stops using `adopt()`/`end()` and confirms the commissioning
session with the same fallback as viewer-public (fetch a grant, let the provider answer).

### 1. Version and compatibility (minor, v2.2.0)

Additions only; every existing name stays as a thin wrapper or alias (table under
"Compatibility"). Derived apps keep working by bumping `@banto/admin-core` and `banto-server`
to v2.2.0; only the code that uses grants moves to the new API.

### 2. Server (`crates/banto-server`)

```rust
/// A grant kind. An open set defined by the app (not a closed enum).
/// `[A-Za-z][A-Za-z0-9_-]{0,31}`; the same string is used in the URL, in status, in identity.kind and as the client's SessionKind.
pub struct GrantKind(/* Arc<str> */);
impl GrantKind { pub const PUBLIC_VIEWER: &str = "publicViewer"; }

pub type GrantCondition =
    Arc<dyn Fn() -> BoxFuture<'static, Result<bool, BantoError>> + Send + Sync>;

pub struct GrantSpec {
    pub kind: GrantKind,
    /// Fixed. The issuing route accepts no identity/role (the same "no escalation path" property as ADR-0012).
    pub identity: Identity,
    /// Issuance condition, evaluated per request (viewer-public: `server_config().viewer_public`).
    pub enabled: GrantCondition,
    /// Per-kind FIFO cap, default 256 (= `MAX_PUBLIC_VIEWER_SESSIONS`). Past it the oldest is revoked.
    pub max_sessions: usize,
    /// `None` = `AuthState`'s default `token_policy` (8h / idle 1h). Never remembered.
    pub policy: Option<TokenPolicy>,
    /// If true the issuing route answers 403 unless the peer is loopback.
    pub require_loopback_peer: bool,
}

impl AuthState {
    pub fn issue_grant_token(&self, spec: &GrantSpec) -> String;
    pub fn revoke_grant_tokens(&self, kind: &GrantKind) -> usize;
}
```

- `TokenRecord.public_viewer: bool` → `grant: Option<GrantKind>` (`auth.rs:424-425`).
  `Inner::public_tokens: VecDeque<String>` (`auth.rs:577`) → `HashMap<GrantKind, VecDeque<String>>`
  (one FIFO per kind; the cap, oldest-first eviction and "never touches a real login" tests at
  `auth.rs:2641-2690` hold per kind unchanged).
- `AuthenticatedSession` (`auth.rs:255-262`) carries `grant: Option<GrantKind>`; the JSON of
  `GET /api/auth/identity` becomes `Identity & { publicViewer: bool, kind: string }`
  (`publicViewer = grant == PUBLIC_VIEWER`, `kind = the grant string | "account"`). The Rust
  struct-literal compatibility is "Open point 1".
- The account-check branch (`if session.public_viewer` at `auth.rs:1131-1135`) becomes
  `if session.grant.is_some()`. Grant sessions carry no stamp and are not looked up
  (outside ADR-0014: the identity is fixed, there is nothing to re-read). SSE re-validation
  (`revalidate`, `auth.rs:1114-1119`, `events.rs:210`) goes through the same function, so a
  stream ends at the next re-check after `revoke_grant_tokens` (generalize the test at
  `events.rs:702-713`).
- The `change-password` refusal (`routes/auth.rs:227`) becomes `grant.is_some()`: a grant
  session owns no credential (even if an account shares the display name).
- **Issuing route** `POST /api/auth/grant/{kind}` (new; `X-Banto-Client` stays required via
  `crate::csrf`). In order: unregistered `kind` → 404 `not_found`; `require_loopback_peer`
  and the peer is not loopback **or is unknown** → 403 `forbidden` (fail closed);
  `enabled()` → `Ok(false)` → 403, `Err` → that `BantoError` (`ApiError`); otherwise
  `issue_grant_token` → `{ success: true, token }` (same body as viewer-public).
  **Issuance is not audited** (existing policy, `routes/auth.rs:88-94`).
  `POST /api/auth/public-viewer` stays as an alias of `/api/auth/grant/publicViewer`.
- **Peer check**: `ConnectInfo<SocketAddr>` is always supplied by `BoundServer::serve` through
  `into_make_service_with_connect_info::<SocketAddr>()` (`crates/banto-server/src/server.rs:128-131`).
  All three ways of reaching a server go through it - banto-serve's `server::start`
  (`server.rs:174`), the Tauri embedded server (`apps/admin-template/src-tauri/src/lib.rs:1887`,
  `bound.serve(router)`) and tests that use `BoundServer`. **The only path without it is a test
  driving the router directly with `tower::oneshot`** (where `MaybePeerAddr` at
  `auth.rs:1515-1536` yields `None`). So the design may close on "unknown peer = 403", and
  `rest/tests.rs` sets `req.extensions_mut().insert(ConnectInfo(addr))` explicitly. The loopback
  test counts IPv4-mapped IPv6 (`::ffff:127.0.0.1`) as loopback (same normalization as around
  `server.rs:264`; IPv6 itself stays out of scope).
- `/api/auth/status` (`routes/auth.rs:37-66`) gains `grants: { <kind>: bool }`. Each value is
  "**can this request obtain the grant right now**" = `enabled()` and (when
  `require_loopback_peer`) the peer is loopback. `viewerPublic` stays, equal to
  `grants.publicViewer` (alias). An `Err` from `enabled()` makes that kind `false` (status never
  fails; same fail-closed as viewer-public's "cannot read → do not mint").
- `extra_auth_router` (`routes/auth.rs:296-320`) gets a new version taking
  `grants: Vec<GrantSpec>` (Rust has no overloading, so a new name, e.g.
  `extra_auth_router_with_grants`; the name is for the implementation PR). The old signature
  becomes a wrapper that supplies `vec![GrantSpec::public_viewer(settings.clone())]`.
  `GrantSpec::public_viewer(settings: SettingsService) -> GrantSpec` carries the viewer-public
  specification as-is (identity `public`/`viewer`, condition `server_config().viewer_public`,
  cap 256, `require_loopback_peer: false`). Derived apps **copy** `extra_auth_router`
  (banto-hub `core/src/rest.rs`, chronogazer `core/src/rest.rs`), so the building blocks for the
  issuing route and the status `grants` map (a grant registry and router) are `pub` and
  mergeable by the copies.
- `issue_public_viewer_token()` / `revoke_public_viewer_tokens()` (`auth.rs:890,936`) become thin
  wrappers over `issue_grant_token(&GrantSpec::public_viewer_fixed())` /
  `revoke_grant_tokens(&PUBLIC_VIEWER)`. `PUBLIC_VIEWER_ID` and `MAX_PUBLIC_VIEWER_SESSIONS` stay.
- **Revocation and audit**: the operation that closes the condition (viewer-public OFF,
  commissioning lock-down) calls `revoke_grant_tokens(kind)` and may put the returned `usize`
  into its own audit `detail` as `revokedGrants: n` (issuance is not audited; the closing side
  keeps the count instead). The template's `save_server_config_locked`
  (`src-tauri/src/lib.rs:2160-2165`) switches to `revoke_grant_tokens(&PUBLIC_VIEWER)`.

### 3. The self-deletion guard on user deletion

`acting_user` at `routes/users.rs:69-84` resolves the caller's row through token →
`identity_for` → `users.get_by_username`. A grant session's fixed identity has no account, so
this yields `Unauthorized` and an admin-equivalent grant (commissioning) cannot delete users.
**banto adds a branch that lets grant sessions through the self-deletion guard as "no acting
id"**: read the `AuthenticatedSession` that `require_auth` put in the extensions
(`auth.rs:1562-1573`); if `grant.is_some()` the acting id is `None`, otherwise resolve the row id
as today. `UsersService::delete_user(id, acting_user_id: i64)`
(`crates/banto-admin-services/src/users.rs:843`) gets an `Option<i64>` version; the existing
signature stays as a wrapper. The "last admin cannot be deleted" guard
(`ensure_admin_removal_allowed`) still applies to grants.

### 4. Client (`@banto/admin-core`)

- `AuthProvider.status()` → `{ initialized, viewerPublic?, grants?: Record<string, boolean> }`.
  The HTTP provider (`providers/http.ts:434-456`) answers `grants: {}` for an older server
  (same fail-closed as `viewerPublic`).
- New `AuthProvider.enterGrant?(kind, { expectRevision })`. The HTTP provider POSTs
  `/api/auth/grant/{kind}` and stores the token with the **same compare-and-set** as
  `enterPublicViewer` (`http.ts:537-562`: no token at the start, revision still
  `expectRevision`). `enterPublicViewer` becomes a wrapper over `enterGrant('publicViewer', …)`.
  The Tauri and demo providers stay unimplemented (same reasons as viewer-public,
  `provider.ts:154-164`).
- `publicViewerFallback(controller, provider, ticket, { maxRetries })`
  (`sessionController.svelte.ts:1150-1218`) generalizes to
  `grantFallback(controller, provider, ticket, { kind, available?, maxRetries? })`.
  `available(status)` defaults to `status.grants?.[kind] === true`. The loop (`status()` →
  `isCurrent(ticket)` → `enterGrant({ expectRevision })` → `resolveSettled()`; a failure is not
  retried; only `superseded` is retried with a bound) is unchanged. `publicViewerFallback` is the
  wrapper with `kind: 'publicViewer'` and
  `available: s => s.viewerPublic === true || s.grants?.publicViewer === true`.
- `Identity.kind?: string` is added (issuer-provided, like `identity.publicViewer`).
  `kindOfResolvedAuth` (`sessionController.svelte.ts:225-229`) **prefers the server's
  `identity.kind`**, then the existing order (`identity.publicViewer === true` →
  `'publicViewer'`, the provider's `kind`, `'account'`). Tauri's `'local'` has no `kind` on
  the identity and works as before.
- `sessionOwnerKey` (`sessionController.svelte.ts:200-213`): a grant kind (an `identity.kind`
  other than `publicViewer`/`account`) is keyed by **the kind alone** (e.g. `commissioning`;
  the identity is fixed, so the id adds nothing). `publicViewer` → `public-viewer`,
  `local` → `local` and `account:${id}` are unchanged. A kind confirmed through `adopt()`
  (no `identity.kind`) keeps `${kind}:${id}` until v3. When banto-hub moves from adopt to grant
  its saved-state owner changes once, `commissioning:commissioning` → `commissioning`
  (saved list state is unreadable once; nothing is deleted).
- Owner-change comparison is limited to `kind === 'account'` actives (S-108, v2.1.1 #308) and
  does not change: a grant session is a state of the terminal or the app, not "another user".
- **`adopt()`/`end()` are `@deprecated` in v2.2** (the only user is banto-hub's
  `commissioningPolicy.ts`) and **removed in v3**. I-13, I-21, §4.7 S-44 to S-46 and the policy
  runner in §6.2 get a "replaced by grants; adopt is deprecated" note
  ([session-controller-design.md](../session-controller-design.md)). A grant-based commissioning
  session follows the S-42 path (the provider answers, the ticket has a revision, an SSE 401 can
  trigger a confirmation), and the controller's adopt-only branches (the "while adopted" column
  of §5.1 steps 0-7) disappear in v3.

### 5. Derived-app agreements (for reference; not banto rules)

The shape banto-hub agreed to in this decision (not a banto rule; the starting point of its
migration PR):

- Lock-down calls `revoke_grant_tokens("commissioning")` **right after saving the flag, in the
  same function** (the same shape as viewer-public OFF in `save_server_config_locked`; no request
  can slip between the save and the revocation).
- Logout only drops the token. While commissioning, the next navigation silently re-issues one
  through `grantFallback` (commissioning does not end by "logout"; only lock-down ends it).
- Returning to commissioning through elevation does not revoke existing tokens.
- Bootstrap's self-issuance (Rust side) uses the commissioning admin grant via
  `issue_grant_token`.
- `max_sessions` may be smaller than viewer-public's 256 (the fewer admin-equivalent tokens the
  better).

## Security

- **The entry shrinks to one route.** The only unauthenticated request that passes is the
  issuance at `POST /api/auth/grant/{kind}`; afterwards the token rides the existing
  `require_auth`, `RoleGuard`, audit and SSE re-validation (`events.rs:210`) without exception.
  The derived app's 34 bypasses disappear by concentrating the trust decision in one place
  (`GrantSpec.enabled`).
- **The condition is explicit.** Everything that permits issuance is written in `GrantSpec`
  (kind, fixed identity, condition, cap, lifetime, loopback); review starts there. Viewer-public's
  "takes no identity/role argument" (`auth.rs:872-877`) is kept: the issuing route accepts
  neither an identity nor a role from the client.
- **Per-kind revocation.** `revoke_grant_tokens(kind)` removes only that kind, never real logins
  or other grants (generalizing the test at `auth.rs:2595-2612`). `AuthState` outlives server
  restarts (comment at `lib.rs:2162`), so the operation that closes the condition always revokes.
- **Lifetime stays default** (8h / idle 1h, never remembered). When it lapses the screen silently
  re-issues (as viewer-public; generalize the test at `auth.rs:2629`). No long-lived tokens are
  handed out.
- **Stream re-validation is one path.** `revalidate` → `authenticate_with` → `session_for_with`,
  so a grant's stream closes at the next re-check after revocation. The adopt design had no
  such hook.
- **Caveat 1: an admin-equivalent bearer is stored in the browser.** A commissioning grant token
  sits in `sessionStorage` like viewer-public's. It must be unusable after lock-down, so
  **the derived app pins "lock-down → the next request is 401 → the SSE closes" in tests**
  (banto covers `revoke_grant_tokens` unit tests and the SSE re-validation test).
- **Caveat 2: without `require_loopback_peer` the only protection is the bind constraint at
  start-up.** A commissioning grant with `require_loopback_peer: false` on a LAN-bound server
  hands an admin-equivalent token to anyone on the LAN. banto does not enforce the condition
  (the app's `GrantSpec` decides), so it is a review item of the derived app's migration PR.
- **Caveat 3: behind a reverse proxy (ADR-0003) the peer is the proxy.** Through a same-host
  proxy every request looks loopback and `require_loopback_peer` protects nothing.
  `X-Forwarded-For` is spoofable and is not consulted. → "Open point 3".
- Audit: issuance is not audited (existing policy). Operations of a grant session are recorded
  with the fixed identity's id as actor (as `public` for viewer-public). ui-settings under
  `ui.<identity.id>.*` are shared by terminals of the same kind (`routes/ui_settings.rs:31-36`;
  same nature as viewer-public's `ui.public.*`).

## Compatibility

**Verdict: minor (v2.2.0).** Additions and generalizations only; every existing wire, TS and Rust
name stays.

| Existing name                                                                    | In v2.2                                                                                                             | v3                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /api/auth/public-viewer`                                                   | alias of `/api/auth/grant/publicViewer`                                                                             | kept (as viewer-public's name)                         |
| `viewerPublic` in `GET /api/auth/status`                                         | kept, equal to `grants.publicViewer`                                                                                | kept                                                   |
| `publicViewer` in `GET /api/auth/identity`                                       | kept, equal to `kind === "publicViewer"`; `kind` added                                                              | kept                                                   |
| `AuthState::issue_public_viewer_token` / `revoke_public_viewer_tokens`           | thin wrappers over `issue_grant_token` / `revoke_grant_tokens`                                                      | removal candidates                                     |
| `extra_auth_router(users, auth, audit, allow_setup, settings, extras)`           | wrapper over the new version (with `grants: Vec<GrantSpec>`), supplying `GrantSpec::public_viewer(settings)`        | removal candidate                                      |
| `AuthenticatedSession.public_viewer`                                             | "Open point 1"                                                                                                      | `grant` only                                           |
| `UsersService::delete_user(id, i64)`                                             | wrapper over the `Option<i64>` version                                                                              | removal candidate                                      |
| `publicViewerFallback` / `DEFAULT_PUBLIC_VIEWER_RETRIES`                         | wrappers over `grantFallback`                                                                                       | removal candidates                                     |
| `AuthProvider.enterPublicViewer` / `status().viewerPublic`                       | wrapper over `enterGrant('publicViewer')` / alias of `grants.publicViewer`                                          | kept (part of the provider contract)                   |
| `Identity.publicViewer`                                                          | kept (`kind` added; `kindOfResolvedAuth` prefers `kind`)                                                            | kept                                                   |
| `SessionController.adopt()` / `end()`                                            | **`@deprecated`** (only banto-hub's `commissioningPolicy.ts` uses them)                                             | **removed** (with I-13, I-21 and the adopted branches) |
| `verify-architecture` rule 8 `REST_ONLY` (`scripts/verify-architecture.mjs:326`) | add `POST /api/auth/grant/{kind}` (the Tauri window has no "enter a grant" operation; same reason as viewer-public) | —                                                      |

The "synthetic viewer session" item of `conventions §6` and the rules in `viewer-public-plan §2.2`
are rewritten in the implementation PR as "grants (viewer-public is one kind)" - this ADR is the
decision, the normative text lives in conventions.

## Alternatives considered

- **Option A (adopted): generalize viewer-public issuance into grants; commissioning is the
  second kind.**
  Pros: the unauthenticated entry shrinks to one issuing route. Condition, cap, revocation,
  lifetime and re-validation work with the same code as viewer-public, and the tests
  (`auth.rs:2550-2700`, `rest/tests.rs:3023-3160`, `events.rs:702`) generalize over a kind
  parameter. The front end loses the `adopt()` exception path and becomes the single S-42 path.
  Cons: an admin-equivalent bearer sits in the browser (caveat 1). A weak condition in
  `GrantSpec` stays weak (caveats 2, 3) - but it is far easier to inspect than today's 34
  scattered bypasses.
- **Option B (rejected): add a hook to `require_auth` that "skips authentication and inserts a
  synthetic identity while a condition holds"** (moving banto-hub's current shape into banto).
  Rejected for the same reasons as ADR-0012's option C: an "implicit identity" branch in the
  middleware, a second path next to `actor_identity`/`identity_for` (`routes/mod.rs:93`) which
  are written around a token. SSE re-validation (per token) would not apply, lock-down's
  "immediate revocation" could not be expressed as one `revoke_*` call, and with no token there
  is nothing to "silently re-issue". It widens what verify-architecture does not cover.
- **Option C (rejected): do nothing (the derived app keeps its own).**
  banto keeps maintaining the 34 bypasses and the controller-internal adopt branches
  (the "while adopted" column of §5.1 steps 0-7, I-13, I-21, S-44 to S-71) for one consumer.
  The end of commissioning stays unconfirmable through SSE re-validation / 401 (S-45). It also
  contradicts banto-industrial's policy of folding duplicate implementations into banto.
- **Option D (rejected): a second, commissioning-specific issuing route
  (`/api/auth/commissioning`) in banto.**
  A copy of viewer-public's code differing only in condition and identity, to be copied again for
  a third kind; banto would also carry a derived app's domain word (commissioning). The
  generalization (A) is smaller.

## Consequences

- **The issuing route accepts neither identity nor role from the client.** `GrantSpec.identity`
  is fixed and the route takes only `kind`. Review starts there (as in ADR-0012).
- **Whatever closes the condition calls `revoke_grant_tokens(kind)` in the same function.** The
  issuance condition (`enabled`) and the revocation call come in pairs (the template:
  viewer-public OFF; the derived app: lock-down). `revokedGrants: n` may go into the audit detail.
- **Admin-equivalent grants default to `require_loopback_peer: true` and a small
  `max_sessions`** (a review item of the derived app's migration PR).
- The front end confirms commissioning through `grantFallback` and the provider's answer.
  `adopt()`/`end()` are deprecated; the controller's adopt branches stay unchanged until removal
  in v3 (no behavior change in v2.2).
- Adding a kind is adding one `GrantSpec`; banto's routes and the verify-architecture
  classification do not grow (`/api/auth/grant/{kind}` is one route).
- Tests (S-number policy): session-controller-design.md allots **S-109 onwards** to grants
  (S-42 generalized over the kind, the grant versions of S-44 to S-46, "revoked → 401 → the
  fallback silently re-issues", "condition false → 403 → stays `none`"). Rust: parametrize the
  `public_viewer_*` tests in `auth.rs` over the kind; in `rest/tests.rs` add `grant/{kind}` 404 /
  loopback 403 / condition 403 / issuance → `kind` on identity, and `users_delete` from a grant
  session; in `events.rs` the stream closes at the re-check after revocation. The E2E
  `e2e/tests-public-viewer/public-viewer.spec.ts` keeps passing (alias).

## Open points (settled in the implementation PR; not decided unilaterally here)

1. **The `AuthenticatedSession.public_viewer` field.** The owner decision is
   `public_viewer: bool → grant: Option<GrantKind>`, but `AuthenticatedSession` is an all-`pub`
   struct and **a derived app constructs it with a struct literal** (banto-hub
   `core/src/stream.rs:1670-1676`, a test). Renaming or adding a field both break external
   literal construction, so the Rust side is strictly not minor. Candidates: (a) rename, add
   `pub fn public_viewer(&self) -> bool`, and accept the literal breakage with a CHANGELOG note
   (one place in banto-hub, fixed in its migration PR); (b) keep `public_viewer` and **add**
   `grant` (a literal still breaks; two fields to keep consistent); (c) `#[non_exhaustive]` plus
   a constructor (breaks once as well). (a) is recommended.
2. **The name of the new `extra_auth_router` version and the shape of the parts a copied router
   merges** (a `GrantRegistry` + `grant_router(auth, registry)`, or a single
   `extra_auth_router_with_grants`). banto-hub and chronogazer copy `extra_auth_router`; unless the
   parts are `pub` they would re-copy the handler.
3. **`require_loopback_peer` behind a same-host reverse proxy.** Every peer looks loopback and
   nothing is protected. Candidates: documentation only ("do not enable an admin-equivalent grant
   behind a proxy") / a `trusted_proxies` field on `GrantSpec` that trusts `X-Forwarded-For`
   (no new dependency, but more surface). Documentation only is recommended (as with IPv6,
   until a real need appears).
4. **The grant kind identifier** being the same string in the URL, status, `identity.kind` and
   the client's `SessionKind` (camelCase such as `publicViewer`). A camelCase path segment
   differs from the kebab-case style of existing routes. The alias `/api/auth/public-viewer`
   stays, so there is no practical harm; whether to also accept
   `/api/auth/grant/public-viewer` is for the implementation PR.
5. **Evaluating `status().grants` including `require_loopback_peer`** (the body decides "can this
   request obtain the grant"). Returning the condition alone is simpler but makes LAN terminals
   fetch a 403 for nothing. The body's shape is recommended.
6. The name of the `Option<i64>` version of `UsersService::delete_user` (`delete_user_by`, or
   change the existing one and wrap). Derived apps copy `UsersService` too (banto-hub
   `core/src/users.rs:634`), so banto's change reaches them through template intake (path B).
