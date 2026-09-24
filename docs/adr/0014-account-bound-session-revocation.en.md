# ADR-0014: Bind sessions to "account row id + authentication epoch" and revoke them by checking the database on every request

> 日本語: [0014-account-bound-session-revocation.md](0014-account-bound-session-revocation.md)

- Status: Accepted
- Date: 2026-09-24
- Related: Issue #204 / conventions §1, §6 / roadmap M10, M11 / ADR-0001 (two-path symmetry) /
  ADR-0012 (synthetic viewer session)

## Context

Deleting or demoting a user, or changing/resetting their password, left their
existing sessions working with the permissions they had at login. REST's
`AuthState` stored the login-time `Identity` (role included) on the token and
returned it until expiry, and `RoleGuard` authorized on that role alone. Tauri's
`require_role` likewise authorized on a cached `UserIdentity`. A deleted admin's
old token could create admins for as long as it was unexpired (8 hours normally,
30 days with Remember me).

Constraints:

- It must work on **both paths**, and a change made on one path must affect the
  other path's sessions.
- It must hold across processes (the Tauri app's embedded server, `banto-serve`,
  several servers sharing one PostgreSQL) and restarts. Tokens live only in
  process memory.
- `banto-server` does not know where accounts are stored (`UsersService` is
  injected). Derived apps own their `users` table and service.
- Shorter token lifetimes do not solve it (a window remains).

## Decision

**A session carries the `SessionStamp { account_id, auth_epoch }` it was issued
under, and the account is re-read from the database on every authenticated
request/command.** A missing account, a different row id or a different epoch
revokes the session (401); a match authorizes with the account's **current**
role from the database.

- `users.auth_epoch` is incremented in the **same statement** as a role change,
  a password change and a password reset (no read-then-write split). Deletion
  needs no epoch: the row is gone. Row ids are never reused, so an account
  re-created under the same username does not inherit old sessions.
- REST: `AuthState::with_session_validator(lookup)` installs the re-read, and
  `require_auth` (`AuthState::authenticate`) checks it. `RoleGuard`, `check`,
  `identity` and `change-password` go through the same check.
- Tauri: `require_role` runs the same check via `current_session`, and only
  rewrites the cached session after comparing it (compare-and-set).
- At login the stamp is read **before** the credential check (argon2), so a
  change committed during verification cannot be outlived by the new token.
- When the database cannot answer, the session is not revoked; only that
  request fails (a transient outage neither logs everyone out nor lets requests
  through).
- A self-service password change keeps only the session that made it, re-bound
  to the new epoch - it has just proven the current password. Every other
  session (other devices, the other path, Remember me) ends. If another change
  interleaved (the epoch advanced by more than one), it is not re-bound.

## Alternatives considered

- **Option A (adopted): row id + authentication epoch in the database, checked
  per request.** Pros: the state lives only in the database, so every process,
  path and restart sees the same result. Demotion takes effect at once (the role
  is read from the database too). `banto-server` only receives a lookup
  function and stays storage-agnostic. Cons: one index read on
  `UNIQUE(username)` per authenticated request - negligible for a LAN admin
  app. No cache: its lifetime would be exactly the revocation delay.
- **Option B (rejected): drop the user's tokens from the in-memory map.** Only
  works in the process holding the tokens. It does not propagate between the
  Tauri app's embedded server, `banto-serve` or several servers, and never
  reaches the Tauri window's session (a separate token space). Persisting tokens
  to the database would propagate, but adds token storage, cleanup and leak
  surface - and still reads the database per request.
- **Option C (rejected): no epoch; only check existence and role per request.**
  Stops deletion and demotion, but password changes/resets leave old sessions
  alive (a session obtained with a leaked password cannot be cut).
- **Option D (rejected): a "sessions issued before this time are invalid"
  timestamp instead of an epoch.** Compares issue and change times across
  process/server clocks, which breaks on clock skew and same-second ordering. A
  monotonic integer epoch compares deterministically.
- **Option E (rejected): shorter token lifetimes.** Narrows the window; does
  not revoke.

## Consequences

- Derived apps must add `auth_epoch` to `users`, increment it in the writes
  above, and wire `with_session_validator` plus the Tauri-side check (migration
  steps in CHANGELOG). A plain `AuthState::new` without the lookup keeps
  trusting login-time permissions until expiry, as before.
- With a lookup installed, tokens without a stamp (`issue_token`) are rejected
  on first use (fail closed). Paths that create an account and log it straight
  in use `issue_account_token`.
- The synchronous `verify`/`identity_for` look at memory only. Access decisions
  must go through `authenticate` (`require_auth`). `identity_for` is current only
  behind `require_auth` (each check writes the current identity back).
- Synthetic viewer sessions (ADR-0012) and the Tauri no-login mode's synthetic
  session have no account and are not checked.
- SSE (`/api/events`) is checked when the connection opens. After revocation, an
  already-open stream keeps receiving notifications (resource names and notice
  text) until it disconnects.
