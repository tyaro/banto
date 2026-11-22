# ADR-0034: Identify owners by a never-reused `accountId`, attribute login-less operations to the built-in `admin`, and remove first-run setup (v8.0.0; no compatibility, databases are recreated)

> 日本語: [0034-owner-identity-builtin-admin.md](0034-owner-identity-builtin-admin.md)

- Status: Accepted (drafted 2026-11-22. The direction is settled by the owner's decisions 1-6 and 16-19 of the same
  day and by N1-N6 in §10 of the plan. On the same day the owner approved, all as recommended, the details this ADR
  newly fixed (the name and carrier of the mark in decision §3, the hand-over point for reserved names in §4, the
  recovery path in §7) and every point in "Points to confirm with the owner" of PR #804. Also on the same
  day the four cross-review findings on PR #804 were incorporated: the timing of the protection and the display
  contract in §2, the authorization-time snapshot and `actor_kind` in §3, the LAN write condition and the headless
  CLI contract in §5-§7, the restore check in §9, and the acceptance tests in §10. Also on the same day two
  rounds of re-review were incorporated: the seed fix moves to C1 in §5, serialization by the mode generation in
  §6, the CLI when a restore is pending in §7, the pre-restore check of start-up conditions in §9, and the tests
  in §10. Also on the same day the two findings of a third re-review were incorporated: the order of the
  first-boot seed and the CLI's lockdown in §5 and §7, the listen condition and effective settings in the
  pre-restore check of §9, and the tests in §10)
- Date: 2026-11-22
- Related: Issues #790, #778, #786 /
  [design/downstream-requests-2026-11-plan](../design/downstream-requests-2026-11-plan.md) §2, §4.1-§4.4, §7 (C0), §10 (Japanese only) /
  [ADR-0017](0017-credential-less-grant.en.md) (grants; this ADR adds an addendum to its §3, its audit item and the lockdown condition) /
  [ADR-0012](0012-lan-public-viewer-synthetic-session.en.md) / [ADR-0014](0014-account-bound-session-revocation.en.md) /
  [ADR-0031](0031-user-permissions-separate-axis.en.md) / conventions §1, §2, §6, §10, §11
- Code referenced: main `2a16f917` (after v7.11.0). `file:line` references are as of that commit

## Context

Three requests came from downstream (banto-industrial). They share one root.

- **#790**: the owner is identified by username in three layers (the server's `ui.{username}.{key}`, the wire's
  `Identity.id`, and the screen's `account:${id}`; `packages/admin-core/src/sessionController.svelte.ts:207-217`).
  A username can be reused, so a different person whose account is recreated under a deleted account's name inherits
  the previous person's memory (list memory, recent commands, dock layout). `users.id` is not reused within one
  database, but it restarts from 1 when the database is recreated and **rolls back when a backup is restored**
  (the sequence history lives in the database too).
- **#778**: operations done without login (Tauri's `auth.disabled`, the synthetic session `local`) and through an
  admin-equivalent grant are audited under a fixed name that has no row (`local` and the like). They tie to no row
  of the user list.
- **#786**: conditional writes for ui-settings. The storage table is rebuilt, so how its owner is expressed has to
  be decided at the same time.

On 2026-11-22 the owner changed the premise (decisions 16-18): **the next major (v8.0.0) needs no compatibility and
databases are recreated from scratch**. Existing databases and data are not read. The built-in user is lowercase
`admin`. First-run setup creates neither a user nor a password. This removes back-filling existing rows, moving old
stored settings, and detecting or renaming existing `Admin` / `admin` accounts, and the design became smaller. This
ADR records those decisions and the details the plan left "to be fixed in the C0 ADR".

## Decision

### 1. Owner identity: `users.account_uid` and `accountId` on the wire

- When an account is created, the service layer puts a 128-bit random value (from the OS random source, as a
  string) into `users.account_uid`. It is unique. Renaming or changing the role does not change it. **It is not a
  secret** (it is used for neither authentication nor authorization; it is a name that partitions memory). The
  column constraints make it mandatory on account rows; the built-in row has none (§2).
- `accountId` is added to the wire `Identity` (`crates/banto-server/src/auth/session.rs:27`; REST
  `/api/auth/identity`, the login response, and the Tauri commands). For an account session it is `account_uid`.
  Grant sessions and the Tauri login-less session (`local`) do not carry it.
- The screen's `sessionOwnerKey`: `local` and grant kinds stay as they are. An account is **`acct:<accountId>`**.
  Without an `accountId` it is **`null`** (matches nothing; fail closed). A dev build warns once when it returns
  `null` for the account kind.
- **`Identity.id` stays the username** (audit subjects, display, and the callers of `acting_username` do not change).
- No `instance.id` and no `Identity.instanceId`. A value inside the database rolls back with the sequence on
  restore, so a different person created after the restore would get the same key.
- Inside the server, places that point at an owner (`ui_settings`, the audit `actor_id`) use `users.id`. Rows of the
  same database return together on restore, so they cannot disagree. The screen side (browser storage) does not
  return with the database, so it uses `account_uid`.

### 2. The built-in user `admin`

- A new database has one row from the start, inserted by the migration: `username = 'admin'` (lowercase),
  `kind = 'builtin'`, `role = 'admin'`, `password_hash` NULL, `account_uid` NULL.
  - Column CHECKs keep "`kind = 'builtin'` ⇔ `password_hash IS NULL`" and
    "`kind = 'builtin'` ⇔ `account_uid IS NULL`".
  - A partial unique index (`WHERE kind = 'builtin'`) keeps the built-in row unique.
- **It has no password and cannot log in.** The credential verifier matches only rows with `kind = 'account'` (a
  second guard next to the column CHECK). When it hits the built-in row it still runs the same dummy hash
  verification as for a missing user (so response time does not tell them apart). A login attempt for `admin` is
  treated like one for a missing user and falls under the REST login rate limit as is.
- **Renaming, disabling, demoting, setting a password and deleting are all forbidden** (in the service layer;
  conventions §2). The SQL of `change_password`, `reset_password`, update and delete also carries `kind = 'account'`.
- **The protection is enabled in the same PR that inserts the row (C1)** (cross-review finding 3). If only the row
  lands first, the built-in row can be deleted, and verification fails on it, on main in between:
  - Today's delete (`crates/banto-admin-services/src/users.rs:1484-1508`) simply deletes the target row when another
    admin exists. The CHECKs and the partial unique index do not prevent a delete. A later PR cannot put a deleted
    row back (an applied migration is not re-run).
  - Today's verifier reads the hash as a non-NULL type (`users.rs:860-864`). Hitting a NULL row makes the read fail.
  - **The minimum that goes into C1**: (a) the verifier's SELECT is narrowed to `kind = 'account'`; (b)
    `change_password`, `reset_password`, update (rename, role, disable), delete and CSV import refuse
    `kind = 'builtin'` (both the service-layer check and the SQL condition).
  - What stays in C2: reserved names (§4), the start-up check, the attribution mark and `actor_id` (§3), and the
    symmetry of denied audit rows across both paths.
  - **Ordinary accounts can still be created after C1 exactly as today** (creation, first-run setup, login;
    first-run setup stays until C2b removes it). Tests on both SQLite and PostgreSQL pin that first-run setup and
    ordinary creation pass on a database that holds only the built-in row.
- **The last-admin guard** (`ensure_admin_removal_allowed`, `users.rs:313`) does not count the built-in row
  (`role = 'admin' AND kind = 'account'`). Counting it would allow deleting every human admin.
- The row's `role` is for display in the list only and is **never used for authorization**.
- **Counting and showing are separated** (the display contract). **Whether a row is built-in is always decided by
  `kind`, never by name.**
  - **Places that count, export or match see `kind = 'account'` only**: the number of accounts, CSV export and
    import, backup validation, the last-admin guard, `has_admin`, the credential verifier, the auto-login target,
    and any list a derived app reads to "pick a user".
  - **Only the administrative user list returns the built-in row, as one read-only row.** The list response
    (`UserSummary`) carries `kind`, and the screen offers no edit, delete or password action on a
    `kind = 'builtin'` row (the service layer refuses them anyway). The paging total of this list is the number of
    rows shown (the built-in row included).
- A database with no built-in row, or more than one (only possible by direct editing), stops at start-up with an
  explicit error. The row is not re-inserted.
- Only `admin` becomes a row. Fixed identities of other grants such as `public` get no row (they become reserved
  names in §4).

### 3. Attributing login-less operations: the explicit mark `audit_as_builtin_admin`

Which sessions are attributed to `admin` is never inferred from id or name (conventions §10). It is decided by a
mark set by the wiring layer.

- **Name of the mark (fixed by this ADR)**: add **`audit_as_builtin_admin: bool`** to `GrantSpec`
  (`crates/banto-server/src/grant.rs:197`). The default is `false` (set by `GrantSpec::new`). The word `audit` is
  in the name so that it reads as affecting **audit attribution only** (authorization, role and the owner key do
  not change).
- **Where it is carried (fixed by this ADR)**: the mark is copied `GrantSpec` → the **`TokenRecord`** at issuance →
  `AuthenticatedSession` (`crates/banto-server/src/auth/session.rs:146`, `#[serde(skip)]`).
  - REST stores a `TokenRecord` when a token is issued (`crates/banto-server/src/auth/state.rs:483`) and rebuilds
    the session from it on every request (`state.rs:840-863`). A field added only to `AuthenticatedSession` is lost
    on that rebuild. The `TokenRecord` is what keeps it.
  - Plan §4.3 says "copy it to `SessionStamp`", but `SessionStamp` (`session.rs:53`) is the pair of an account's
    `account_id` and `auth_epoch`, and is `None` for grant sessions (`session.rs:137`), so it cannot carry the mark.
  - The mark never goes on the wire (`Identity`'s id, name, role and `kind` do not change).
- **The audit principal is the snapshot used for authorization, passed all the way through** (cross-review finding 4).
  - The authorization guard (`require_auth` / `require_role_at_least`) builds the audit principal (`AuditActor`:
    `actor_username`, `actor_id`, `actor_role`, `actor_kind`) **once** from the session it admitted and attaches
    it to the request. Handlers pass it to both the success and the denied audit rows.
  - **The audit writer does not look the bearer up again.** Today's `actor_identity` / `record_write`
    (`crates/banto-server/src/routes/mod.rs:98-99`, `:179-196`) re-resolve the token at a different moment than
    authorization and get a bare `Identity`. On that path the mark and the internal id are lost, and if the token
    was revoked during processing there is no principal at all. With the snapshot, the audit row keeps the
    principal as of authorization even if the token is revoked afterwards.
  - When the guard denies for an insufficient role, it writes the denied audit row with the same snapshot. When
    authentication itself fails (no token, invalid token) there is no principal, as today.
  - Tauri commands build and pass the snapshot with the same type and the same function (conventions §1).
- **One function decides attribution**; both REST and Tauri call it. It looks only at the mark.
  - Marked: `actor_username = 'admin'`, `actor_id` = the id of the built-in row. `actor_role` is **the session's
    actual role** (viewer stays viewer). The wiring resolves the built-in row's id once at start-up by
    `kind = 'builtin'` and keeps it (never by name or by a fixed number; a restore involves a restart, so it cannot
    drift).
  - Unmarked grants (viewer-public's `public` and the like): the fixed id is written as today; `actor_id` is NULL.
  - Accounts: `actor_username` is the username, `actor_id` is `users.id`.
- **The path is kept in `actor_kind`** (`actorKind` on the wire). Rows whose actor is `admin` come from several
  paths, so the actor alone does not tell which. The existing `origin` separates REST from Tauri, but not several
  marked grants within the same REST.
  - Values: `account` / `local` (Tauri login-less) / `grant:<kind>` / `cli` (§7). Rows without a principal have NULL.
  - **It is never used for authorization** (record only; conventions §10 does not change). **Token values are
    never recorded.**
- **The Tauri login-less session (`local`) is attributed to `admin`.** The Tauri wiring puts a mark of the same
  meaning on the synthetic session (the audit actor changes from `local` to `admin`, with `actor_kind = 'local'`).
  The ui-settings owner and `sessionOwnerKey` stay `local` (attribution is audit-only).
- banto adds no role or `require_loopback_peer` condition to a marked grant (which grants are recorded as `admin`
  operations is the app's decision). The defaults for admin-equivalent grants (loopback, a small `max_sessions`)
  stay as in the consequences of ADR-0017.
- The audit table gets `actor_id` (nullable, no foreign key; audit rows survive deleting the user) and `actor_kind`
  (nullable). The `actor_username` snapshot stays.

### 4. Reserved names and the hand-over point to the service layer

- **What is reserved**: `admin`, and the fixed ids of the registered grants (`GrantSpec.identity.id`; `public` in
  the template, `grant.rs:83`). Creating or renaming an account to one of them is refused **case-insensitively**
  (this stops someone from creating `Admin` or `ADMIN` to make rows hard to tell apart). The comparison is done in
  Rust with `to_lowercase()` on both sides (the unique constraint on `users.username` stays case-sensitive and the
  database collation is not relied on). `local` is not reserved (it cannot collide under the new owner notation).
- **Reservation is for telling rows apart**, not a basis for any judgment (conventions §10 is unchanged).
- **Hand-over point (fixed by this ADR)**: grants are an open set a derived app can extend, and the service layer
  does not know axum / tauri (conventions §2). Therefore:
  - `banto-admin-services` gets a small type `ReservedUsernames` that wraps a set of strings.
  - `UsersService` gets **`with_reserved_usernames(self, ReservedUsernames) -> Self`**, a construction-time builder
    of the same shape as the existing `with_permission_catalog`
    (`crates/banto-admin-services/src/users.rs:499`). The arguments of `UsersService::new` do not change.
  - **The service layer always reserves `admin` itself** (it is the layer that knows the built-in row; it stays
    reserved even if the wiring forgets to pass anything). The wiring passes the fixed grant ids only.
  - `GrantRegistry` gets a read accessor that lists the registered fixed ids. The wiring layer (both REST's
    `banto-serve` and Tauri's `lib.rs`) puts them into a `ReservedUsernames` and passes it.
- **Start-up check (N6)**: `UsersService` gets a one-statement check that compares the reserved names with the
  usernames of `kind = 'account'` rows case-insensitively, and both wirings call it at start-up. It can only hit
  when "a grant was added later and an account with the same name as its fixed id already existed". On a hit,
  **start-up stops** with an error that names the account and the remedy (recreate that account, or change the
  grant's fixed id). There is no rename path.

### 5. Removing first-run setup, and the default of a new database

- **First-run setup creates no user and no password.** A new database starts without creating users.
- **Login-less is the default of a new database only** (cross-review finding 1). The baseline migration (`0014`)
  **explicitly inserts** `auth.disabled = 'true'` and `auth.disabled_role = 'admin'` into `settings`. On start the
  Tauri app enters with the synthetic session `local` (role from `auth.disabled_role`). Neither the login screen
  nor a first-run setup screen appears.
- **When a key is missing or its value is unreadable, start-up stops instead of filling in a default.** A broken
  configuration never produces an admin-equivalent local session automatically (fail closed).
  - `auth.disabled` is missing, or neither `true` nor `false`.
  - `auth.disabled` is on but `auth.disabled_role` (the value the synthetic session is built from) is missing or
    unknown. Today's `auth_config` degrades an unreadable role to admin
    (`crates/banto-admin-services/src/settings.rs:540-556`). That stops.
  - Saving (`set_auth_config`) writes all related keys in one transaction, so app operations never leave one out.
    Only direct editing and corruption hit this. Recovery is the CLI of §7 (which rewrites the database to
    login-required) or the restore of §9.
  - Plan §4.3's "change the default of `auth.disabled` to on (when the key is absent)" is not adopted. With a code
    default of on, merely losing the key in a v8 database would make anyone at the terminal an admin.
- **The first-boot seed condition is fixed in the same PR as 0014 (C1)** (re-review finding 1).
  `seed_first_boot_settings` writes only "when `settings` is empty"
  (`apps/admin-template/core/src/first_boot.rs:40-53`). Once 0014 inserts rows into `settings`, that condition no
  longer holds even on a new database. The display scaffold puts `server.viewer_public`, `server.enabled` and
  `server.bind` in through this path (`scripts/scaffold.mjs:2026-2032`), so if 0014 lands without the seed fix, a
  generated display app starts without public viewing. Today's unit tests, which create `settings` empty, do not
  see this. Moving the INSERT of the auth keys to a later PR is not adopted (it would rewrite the baseline
  migration twice).
  - **Contract**: the seed writes **exactly once, on the first start-up of a new database**. It writes even when
    rows inserted by a migration already exist, and overwrites the same keys with the seed values (a preset's
    default wins over the migration's default). From the second start-up on it writes nothing (it does not revert
    settings the user changed).
  - **Shape**: the test changes from "the table is empty" to "the seeded marker is absent". The marker is one row
    in `settings`, written in the same transaction as the seed rows (no half-seeded state after a failure). The
    marker's key name is decided in C1. The marker lives in the database, so a restore brings it back too (a
    backup of a seeded database is not re-seeded after restore).
  - The order stays "apply the pending restore → migrations → seed → read settings" (`banto-serve.rs:111-142`,
    `src-tauri/src/lib.rs:4358-4391`). The settings check that C2b adds (above) runs after the seed.
  - **The seed step goes through the same function at start-up and in the CLI of §7** (third re-review,
    finding 1). On a new database that has never been started normally, the marker is still absent when the CLI
    runs. If the CLI wrote `auth.disabled = false` without seeding, the next normal start-up would overwrite the
    same key with the seed value, as the contract above says. The display preset seeds `auth.disabled = true`
    (`scripts/scaffold.mjs:2026-2032`), so the lockdown would silently disappear and the app would be login-less
    again even though the CLI succeeded. So the CLI also writes the seed and the marker through the same
    function after the migrations, and writes the lockdown **after that** (§7). The seed function takes a
    transaction: start-up calls it in a seed-only transaction, the CLI calls it at the head of its own
    transaction. Neither entry can produce "a setting written before the seed on a database without the
    marker".
  - Completion criterion of C1: start a generated display app on **a database built by C1's real migrations
    (0001-0014)** and confirm that public viewing is enabled (§10).
- Only users who need user management create accounts, from the user management screen. The audit actor of that
  operation is `admin` (§3).
- Removed: `setup_first_user` and `is_initialized` (`users.rs:738`, `:706`), REST `POST /api/auth/setup`,
  `allow_setup` and `initialized` in the status, Tauri `auth_setup` and the bootstrap window of
  `auth_config_apply`, the `setup` branch of the screen and `AuthProvider.setup`, and `BANTO_ALLOW_SETUP`. The
  state "initialized" itself disappears (a new database is usable any time after migration).

### 6. The lockdown condition and the safety premise

- **The safety premise** (unchanged in spirit from ADR-0017 and spec M11): while login is off, **whoever is in
  front of the terminal is trusted**. Anyone can operate with the synthetic session's role (admin by default).
  This is acceptable because **while login is off, business and administrative data cannot be changed from the
  network**.
- **Four things uphold this premise** (cross-review finding 1). `auth_server_combination_allowed`
  (`crates/banto-admin-services/src/settings.rs:237`) alone does not: it only checks the start-up and save
  combination and does not stop authenticated REST writes, and `banto-serve` listens on `BANTO_BIND` / `PORT`
  rather than the saved `server.enabled` (`apps/admin-template/core/src/bin/banto-serve.rs:83`, `:277`).
  1. **The synthetic session `local` exists only inside the Tauri process.** REST never issues a login-less admin
     session (as today).
  2. **While login is off (`auth.disabled` = on), REST is read-only.** Account login is refused (even with correct
     credentials). Right after the save that switches to login-less, in the same function, every account token is
     revoked (the same shape as ADR-0017's "save → revoke in the same function"). Only viewer-public (viewer) and
     grants a derived app explicitly registered get through.
  3. **Both wirings check the listen condition with the same function.** Tauri is unchanged ("`auth.disabled` and
     `server.enabled`" only with viewer-public on; both save paths and start-up). `banto-serve` always listens, so
     at start-up it calls the same function with `server_enabled = true`. If login is off and viewer-public is off
     too, it **stops with an explicit error without listening** and points to the CLI of §7.
  4. **Users who want to operate from the LAN first create an admin account and lock down.** This rule is never
     relaxed.
- **Login admission, token issuance and token authorization are serialized with the mode switch** (re-review
  finding 3; an implementation condition of C2b). "Refuse login at the entry + revoke everything right after the
  switch" (item 2 above) alone leaves this hole: pass the entry check → while the credential verification is
  awaited, the mode switches to login-less and every token is revoked → the old verification completes and issues
  a token. Today's `login_rate_limited` issues after awaiting the verification
  (`crates/banto-server/src/auth/state.rs:348-390`).
  - **Mode generation**: `AuthState` holds the current mode (login required / login-less) and a generation that
    advances on every switch. A switch does "advance the generation + revoke every account token" at once, under
    the same lock as the token table. The shape is the same as the grant generation guard (`grant_generation` /
    `issue_grant_token`, `auth/state.rs:438-515`, ADR-0017 §2).
  - **Issuance**: login reads the generation at the entry. After the verification, right before issuing and under
    the same lock, it confirms "the generation equals the one read at the entry" and "the current mode is login
    required". Otherwise it refuses without issuing (even with correct credentials). A token carries the
    generation it was issued under.
  - **Authorization**: authorizing with an account token confirms the same generation **at the moment
    authorization completes** as well. Today's path returns, after awaiting the database lookup, the session it
    read before the lookup (`auth/state.rs:690-714`); `refresh_identity` (`:817-824`) writes the identity back when
    the stamp matches. A token revoked by a switch during the lookup could pass this one time. After the lookup,
    confirm "the token is still in the table and its generation equals the current one"; otherwise treat the
    request as unauthenticated. (Added 2026-11-22: the first half landed early, in S2 of #793 -
    `AuthState::settle_lookup` settles the token's presence, expiry and stamp under one lock after the lookup. The
    line numbers above predate it. C2 adds the generation check there.)
  - **Contract**: once a switch has completed, nothing can be issued from or used under the old generation.
    Lockdown (login-less → login required) advances the same generation (revoking the synthetic session and the
    grants that lockdown closes is as described below).
  - **In-flight writes**: the point at which a write counts as "admitted" is **the completion of authorization
    with the generation check** (when the guard builds the principal snapshot of §3). A write past that point is
    not interrupted by the switch and runs to the end under the principal as of authorization (the same handling
    as work detached by the #793 layer; plan §4.5). A request whose authorization completes after the switch is
    refused. Whether a switch waits for the remaining work, and how it is audited, follows what #793 (S1, S2,
    ADR-0035) decides for "the order of revocation and audit", and is fixed in C2b.
  - **Regression tests**: complete a switch while the verifier is deliberately held, then resume it: no token is
    issued. Complete a switch while the authorization's database lookup is held: that request does not pass (§10).
- **What "read-only" forbids and does not forbid**:
  - Forbidden: changes to business data and administration (resources, attachments, users, settings, backups and
    so on: every operation that needs a role above viewer or a permission).
  - Not forbidden (a): a viewer-public session **PUTting the ui-settings of its own kind** (`/api/ui-settings/*`
    needs `require_auth` only, `crates/banto-server/src/routes/ui_settings.rs:59-71`; stored under
    `grant:publicViewer` of §8). These are display preferences, not business or administrative data. As today.
  - Not forbidden (b): what **a grant explicitly registered by a derived app** does with the role and permissions
    of its `GrantSpec` (ADR-0017). Its issuing condition is the app's responsibility, and a grant that lockdown
    closes is revoked as described below.
- **What existing things can do while Tauri is login-less**:
  - Existing accounts: the rows remain and can be managed on the user management screen. Logging in as such an
    account is possible neither from the Tauri screen nor over REST (the screen enters as `local`; REST per item 2).
  - Old tokens: revoked at the moment of switching to login-less. Tokens live in memory only, so none survive a
    restart either.
  - Grants: viewer-public can only read and PUT the ui-settings of its own kind. App grants follow their issuing
    conditions.
- **REST while there are zero accounts**: login always fails (no accounts; the built-in row is refused) and there
  is no first-run setup endpoint, so only viewer-public reads and grants added by a derived app get through. The
  authorization rules go through the same function on both paths (conventions §1).
- **Lockdown** (turning `auth.disabled` off) is allowed **only when at least one admin account that can log in
  (`kind = 'account' AND role = 'admin'`) exists**. Otherwise it is refused with `Validation` and the message
  "create an admin account first".
  - The judgment and the save happen under the same lock, and the judgment is placed **before** ADR-0017's
    sequence "save → revoke grants right after, in the same function".
  - After lockdown the login-less session is revoked. Grant revocation is as in ADR-0017: for a grant whose
    issuing condition closes on lockdown (a derived app's commissioning grant and the like),
    `revoke_grant_tokens(kind)` is called in the same function right after the save.
- **The last-admin guard always applies, even while login is off** (N5). Once an admin exists it cannot go back
  to zero, so the race "the last admin disappears after the judgment and before the save" cannot happen. In
  exchange, the last admin created while login is off cannot be deleted.
- **A database that requires login but has zero admin accounts** (impossible through the app; direct editing only)
  stops at start-up with an explicit error (N4; both Tauri and `banto-serve`). It is not silently returned to
  login-less (that would let whoever can rewrite the database switch authentication off: fail-open).

### 7. The first account when headless, and the recovery path

- Headless (`banto-serve` only: PostgreSQL operation and e2e) has no Tauri login-less session, so the first
  account is created with **an offline CLI for the person who can reach the database** (a `banto-serve`
  subcommand) (N3). It is not a network endpoint.
- **The CLI contract (fixed by this ADR; cross-review finding 1)**: the CLI **finishes creating the admin and
  locking down, safely, in one run**. Creating only an account leaves no procedure from a new database's
  `auth.disabled = on` to "writable over REST" (items 2 and 3 of §6).
  - **It runs before listening starts and exits on the spot.** It opens no socket and builds no router. The exit
    code reports success or failure.
  - **In one transaction** it writes (a) the admin account, (b) `auth.disabled = false` (lockdown) and (c) the
    audit row. A failure in between leaves nothing behind. There is no "account only" or "lockdown only" entry
    (no half-done state). On a database that already requires login, (b) rewrites the same value (the same entry
    serves as recovery).
  - Account creation itself goes through the ordinary creation of `UsersService` (same validation and reserved
    names).
  - It runs migrations first, so it works on a new database as is (an old database is refused as in §9). It runs
    **before** the start-up checks of §5 and §6 (missing or corrupt settings keys; login required with zero
    admins), because it is the entry that repairs those states.
  - **The order is "check for a pending restore → migrations → the one transaction above", and the transaction
    settles the first-boot seed at its head** (third re-review, finding 1; §5). When the seeded marker is absent,
    it writes the seed rows and the marker through the same function as start-up, and then writes (a)-(c). For
    the same key (the display preset's `auth.disabled = true`) the lockdown, written later, wins. The other seed
    keys (`server.viewer_public` and so on) keep the preset's values. The next start-up sees the marker and
    writes nothing, so the lockdown stays. On a database that already has the marker the seed does nothing. A
    failure in between leaves neither the seed nor the marker (the next start-up or the next CLI run seeds).
  - **When a restore is pending (`restore-pending.sqlite3`), it writes nothing and stops with an explicit error**
    (re-review finding 2). The CLI neither applies the pending restore implicitly nor ignores it. Ignoring it would
    let the next start-up apply the restore after the CLI succeeded, erasing the account and the lockdown. The
    error says "first apply the restore (start the app) or delete the pending file, then run again". Which comes
    first is the operator's decision.
  - **Run it with the app and the server stopped.** The CLI cannot revoke sessions held in the memory of a running
    process. Used on the SQLite file a Tauri app shares, it makes that app login-required too (as intended).
  - The audit row is recorded as an operation of the built-in `admin` (`actor_kind = 'cli'`, `origin = 'cli'`).
  - The password is not taken as an argument (it would stay in the process list and shell history). It is read
    from standard input. Argument details are decided in C2b.
- **The headless first-run path**: new database → starting `banto-serve` as is stops without listening, because
  login is off and viewer-public is off (item 3 of §6) → CLI (create admin + lock down) → start → log in → update.
  The first start-up may be skipped: the CLI can be used directly on a new database (the order above also
  settles the seed).
- **The recovery path (fixed by this ADR; the remainder of N4)**: this CLI lives **only in `banto-serve`**.
  **The Tauri executable gets no CLI.**
  - Login required with zero admins, or a missing settings key, only arises by rewriting the database directly.
    Anyone able to do that can point the `banto-serve` CLI at the same database (SQLite file or PostgreSQL alike).
    Going back to a backup uses the offline procedure of §9 (usable in distributions without `banto-serve`).
  - Adding "create an account from arguments" to the desktop executable would add, to every distribution that has
    authentication, a way to create an admin that bypasses the screen. A Windows GUI executable also needs separate
    handling of standard input and the console.
  - The work is one core function called from `banto-serve`. A derived app is not prevented from adding the same
    entry to its own executable.

### 8. ui-settings of grant sessions are keyed by kind

- Storage is the new table `ui_settings`. The owner is a string column: `acct:<users.id>` for an account,
  **`grant:<kind>`** for a grant, `local` for the Tauri login-less session. No user row is created for a grant.
- Devices of the same kind share settings (the same nature as today's `ui.<identity.id>.*`; the key changes from
  the fixed id to the kind). A marked grant stays `grant:<kind>` too (it does not become `admin`'s property;
  attribution is for audit only).
- Account rows are protected by a foreign key on a separate column `user_id` (`ON DELETE CASCADE`). The shape of
  the revision and conditional writes belong to #786 and are not decided here (plan §4.4).

### 9. No compatibility; the baseline is rebuilt

- **There is no data migration.** The existing `0003_users.sql` and `0005_audit_log.sql` are **rewritten** to the
  new shape, and `0014_ui_settings.sql` (the table, the INSERT of the built-in `admin` row, and the settings
  INSERTs of §5) is added (both SQLite and PostgreSQL; the symmetry of rule 11 holds). The other 11 files, their
  names and numbering do not change.
- conventions §11's "released migrations are append-only" is broken **once**. `pnpm verify:migrations` gets a
  one-time allowance that permits only these 4 files to differ when comparing against tag `v7.11.0` (C1). After the
  v8.0.0 tag it is append-only again.
- **Old databases and backups are not read; they are refused with an explicit error.**
  - Start-up: since the body of 0003 changes, sqlx stops on the mismatch of the applied checksum
    (`VersionMismatch`). 0014 is the last in sequence, so it stops before any new migration touches an old database.
    `db::run_migrations` (`apps/admin-template/core/src/db.rs`) maps this to "This database is from a version
    before v8.0.0 and cannot be read. Recreate the database."
  - Restore: refused **before** the swap (below).
- **A restore candidate is checked by its migration history, not only by table names** (cross-review finding 2).
  - Today's validation (`crates/banto-admin-services/src/backup.rs:292-317`) looks only at `integrity_check` and
    the names of required tables, and the ordinary migration check runs **after** the start-up apply
    (`backup.rs:731-784`) has swapped the real file. A file that has every required table and an ok
    `integrity_check` but carries v7 checksums passes that validation. Once it passes, the app cannot start after
    the swap (`VersionMismatch`). Adding `ui_settings` to `REQUIRED_TABLES` (`backup.rs:151`) is not enough (it is
    still added).
  - **What is checked**: the candidate is opened read-only and `_sqlx_migrations` is read. (a) Every row
    succeeded; (b) each row's version exists in this app's migrator with a matching checksum; (c) the whole v8
    baseline (`0001`-`0014`) is applied. A version the migrator does not have (a backup from a newer version), a
    checksum mismatch (an old version) or a missing baseline entry is refused. Unapplied migrations after the
    baseline are allowed (the start-up migration moves forward).
  - **The wiring layer supplies the migrator.** The app, not the service layer, knows the list of versions and
    checksums (including migrations a derived app added) (conventions §2). If none was supplied, both staging and
    applying are refused (fail closed).
  - **It is checked twice**: when staging, and right before the start-up apply (before the swap, the WAL removal
    and the automatic pre-restore backup). If the check right before applying fails, the pending file is deleted
    and the apply is abandoned. **The original database is not touched** (the same handling as an invalid pending
    file today).
  - **Regression tests**: a candidate with every required table, an ok `integrity_check` and v7 checksums (1) is
    refused at staging; (2) placed directly as the pending file, is not applied at start-up and the original
    database's bytes do not change; (3) the next start-up succeeds. The same for a candidate with a version the
    migrator lacks and one with a missing baseline entry.
- **A restore candidate is also checked against the start-up conditions within v8** (re-review finding 2). The
  history check stops v7 and unknown versions, but it does not prevent a v8 candidate with a sound history and
  `integrity_check` from stopping at the start-up checks (the built-in row of §2, the settings of §5, login
  required with zero admins of §6). Swapping such a candidate in stops start-up **after the sound original
  database has been replaced**.
  - **What is checked** (before the swap, read-only): every check that stops start-up. (a) the built-in row exists
    (exactly one `admin` with `kind = 'builtin'`), (b) the required settings are readable (`auth.disabled` is
    `true` / `false`; when on, `auth.disabled_role` is a known value), (c) when login is required, at least one
    admin that can log in (`kind = 'account' AND role = 'admin'`), (d) collisions between reserved names and grant
    fixed ids (§4), (e) the wiring being restored into can listen (item 3 of §6; below).
  - **Whether listening is allowed depends on the wiring being restored into** (third re-review, finding 2).
    `banto-serve` always listens, so a candidate with `auth.disabled = true` and `server.viewer_public = false`
    stops start-up at item 3 of §6 even when it satisfies (a)-(d) (`auth_server_combination_allowed` is called
    with `server_enabled = true`). This is hit when a backup of a database that worked fine on the desktop alone
    is restored into a headless deployment. Tauri does not stop start-up on the same combination (even with the
    saved `server.enabled` on, it only skips auto-starting the LAN server:
    `apps/admin-template/src-tauri/src/lib.rs:4585-4603`), so it accepts the same candidate. The check function
    the wiring layer passes contains **every condition that actually stops that wiring's start-up**: the
    `banto-serve` wiring includes (e), the Tauri wiring does not. At staging the wiring that takes the
    reservation checks; right before applying the wiring that is actually starting checks, and the latter is
    decisive (even when another wiring opens the same SQLite file, the candidate is refused before the swap).
  - **The check uses the effective settings start-up will use**: not the values as written in the candidate, but
    the values start-up reads after the migrations and any needed first-boot seed (§5). (b), (c) and (e) all
    read settings.
  - **Use the same function as the start-up check.** The conditions are not written in two places. **A PR that
    adds a check that stops start-up applies it to the pre-restore check in the same PR** (the built-in row and
    the §4 collision in C2; settings, admins and the listen condition in C2b). This is a completion criterion of each PR (plan §7). The
    wiring layer passes the check function together with the migrator (the app is what knows a derived app's
    grants).
  - **A candidate with unapplied migrations after the baseline, or without the seeded marker,** cannot be read in
    its start-up state as is (start-up runs the migrations and, when the marker is absent, overwrites settings
    with the seed of §5 before checking). Copy the candidate to a working copy, run the migrations and the
    first-boot seed (the same function as start-up) on the copy, and pass the same checks before swapping. What
    is swapped in is the original candidate; the working copy is discarded (the start-up after the swap runs the
    migrations and the seed as usual). If the migrations or the seed fail on the copy, refuse.
  - **On refusal the original database is not touched** (as with the history check: the pending file is deleted
    and the apply is abandoned). It is checked at the same two times (at staging and right before applying).
  - **Regression tests**: v8 candidates with a sound history and `integrity_check` that lack the `auth.disabled`
    row, require login with zero admins, or lack the built-in row are refused both at staging and right before
    applying; the original database's bytes do not change and the next start-up succeeds.
  - **Regression test for listening**: the same candidate, with `auth.disabled = true` and
    `server.viewer_public = false` and satisfying (a)-(d), passes both staging and applying under the Tauri
    wiring, and is refused under the `banto-serve` wiring both at staging and right before applying (before the
    swap); the original database's bytes do not change and the next start-up succeeds. A candidate without the
    seeded marker is judged by the values after the seed.
- **The offline recovery procedure** (the way to "go back to a backup" after start-up stopped). Today a restore
  can only be staged from the running administration screen. A stopped start-up cannot reach it, so a procedure
  that bypasses the screen is fixed here.
  - Stop the app → place the backup to go back to in that database's backup directory under the pending file name
    (`restore-pending.sqlite3`) → start.
  - **The start-up order is "apply the pending restore → migrations → settings and admin checks"** (the apply
    already comes first: `banto-serve.rs:111`, `apps/admin-template/src-tauri/src/lib.rs:4358`). This order is
    fixed as a rule. A hand-placed file also goes through the checks right before applying (the two above:
    history and start-up conditions). If it fails it is deleted and the original database does not change. The
    seed (§5) comes after the migrations and before the settings check. The CLI of §7 stops when a pending file
    exists (it neither applies nor ignores it).
  - It works in desktop-only derived apps that do not ship `banto-serve`. The procedure is written in upgrading
    and README (C1).
  - PostgreSQL has no banto restore entry (`backup.rs:206-215`). Operators restore with their own tools. An old
    database is refused by the start-up check above.

### 10. Acceptance tests (part of the completion criteria of the implementation PRs)

- **The headless path** (C2b; both SQLite and PostgreSQL): new database → starting as is stops without listening
  → CLI (exits without starting to listen; the account, the lockdown and the audit row land together) → start →
  log in → an update succeeds and is audited. A database on which the CLI failed midway has neither the account
  nor the lockdown.
- **The CLI before any start-up, and the first-boot seed** (C2b; both SQLite and PostgreSQL; a derived app with
  a non-empty seed, i.e. a generated display app): on a new database, without ever starting normally, CLI →
  start → logging in with the created account succeeds. After the start-up `auth.disabled` is still `false`,
  the other seed keys (`server.viewer_public` and so on) are present, and start-up does not rewrite the seed. A
  database on which the CLI failed midway does not have the seeded marker either (§5, §7).
- **While Tauri is login-less** (C2b): an existing account cannot log in over REST. An account token issued before
  the switch can neither read nor write over REST. A viewer-public session can only read and PUT the ui-settings
  of its own kind; business and administrative changes are refused. An explicit app grant behaves as its
  `GrantSpec` says.
- **Racing the switch** (C2b): switching to login-less while the verification is held issues no token when the
  verification resumes. Switching while the authorization's database lookup is held does not let that request
  pass. A write whose authorization completed before the switch runs to the end, and its audit row keeps the
  principal as of authorization (§6).
- **The first-boot seed** (C1): on a new database built by C1's real migrations, a generated display app seeds
  `server.viewer_public`, `server.enabled` and the bind, and public viewing is enabled. The second start-up does
  not overwrite settings the user changed. An app with an empty seed writes nothing, as today (§5).
- **Broken settings** (C2b): a database where `auth.disabled` is missing or unreadable, one that is login-less
  with `auth.disabled_role` missing or unreadable, and one that requires login with zero admins all stop at
  start-up in both Tauri and `banto-serve` and create no synthetic session. The CLI repairs them.
- **Protection of the built-in row** (C1; both dialects): from the moment the row exists, delete, update, setting
  a password and login are refused. Ordinary account creation and first-run setup pass. The administrative user
  list returns the built-in row; the count, CSV and `has_admin` do not count it.
- **The audit principal** (C2): success and denied audit rows of a marked grant have the same actor, `actor_id`
  and `actor_kind` on REST and Tauri. Revoking the token after authorization and before the audit write still
  leaves the audit row with the principal as of authorization. `actor_kind` tells apart `local`, two marked grants
  of different kinds, and `cli`. No token value appears in the audit log.
- **Restore** (C1): the history regression tests of §9. The regression tests for the start-up conditions are
  added in the PR that introduces each condition (the built-in row and the §4 collision in C2; settings, admins
  and the listen condition in C2b). **The listen condition** (C2b): the same candidate, login-less with
  viewer-public off, is accepted by the Tauri wiring and refused before the swap by the `banto-serve` wiring
  (§9).
- **The CLI and a pending restore** (C2b): running the CLI on a database with a pending file ends with an explicit
  error without writing anything; neither the pending file nor the database changes.

## Alternatives considered

- **Owner key**
  - **Adopted: a per-account random `account_uid`.** Robust against both restore and recreation.
  - Rejected: use `users.id` as is. Recreating or restoring the database hands the same value to a different person.
  - Rejected: `instance.id` + `users.id`. An `instance.id` stored in the database rolls back with it on restore,
    leaving the same hole.
  - Rejected: change `Identity.id` away from the username. Audit, display and every caller of `acting_username` change.
- **The built-in user** (N1)
  - **Adopted: a row that cannot log in, only a place to record login-less operations; first-run setup is removed too.**
  - Rejected: an `admin` that logs in with a password (set during first-run setup). A well-known name becomes a
    password target, and the last-admin guard, the verifier and `password_hash` each need a branch for the built-in row.
  - Rejected: naming it `Admin` or an internal `builtin.admin`. Decision 17 fixed lowercase `admin`.
- **How attribution is decided**
  - **Adopted: an explicit mark on `GrantSpec`, copied to the `TokenRecord` and the session, with the snapshot of
    the principal used for authorization passed to the audit writer.**
  - Rejected: infer from the fixed id or the role ("an admin-role grant is `admin`", and so on). It violates
    conventions §10, and attribution would change silently when a derived app adds a grant.
  - Rejected: carry the mark on `SessionStamp`. Grant sessions have no `SessionStamp` (§3).
  - Rejected: a name such as `acts_as_builtin_admin`. It reads as if authorization changed too.
  - Rejected: add the mark only to `AuthenticatedSession` and re-resolve the bearer where the audit row is written
    (today's shape). REST rebuilds the session from the `TokenRecord` on every request, so the mark is lost, and a
    token revoked during processing leaves no principal (§3).
  - Rejected: not recording the path. The source of a row whose actor is `admin` (Tauri login-less, which grant,
    the CLI) could not be traced afterwards. `origin` only separates REST from Tauri.
- **Hand-over point for reserved names**
  - **Adopted: `UsersService::with_reserved_usernames` (builder); the service layer reserves `admin` itself.**
  - Rejected: add an argument to `UsersService::new`. Every caller (tests included) is rewritten. Forgetting to
    pass the set can happen with a builder too, but `admin` can never drop out, so the remaining hole is only how
    easily a fixed grant id can be told apart.
  - Rejected: pass the list as an argument of each create / rename operation. REST and Tauri callers would each
    assemble it, and the symmetry breaks easily.
  - Rejected: the service layer reads `GrantRegistry`. `banto-admin-services` would depend on `banto-server`
    (conventions §2).
- **Shape of the migration** (N2)
  - **Adopted: rebuild the baseline (rewrite 0003 and 0005, add 0014).** sqlx itself refuses old databases, and
    the column constraints are right from the start.
  - Rejected: only add 0014. No rule is broken, but 0014 would apply to an old database as is, so a hand-written
    check is needed; SQLite's `ALTER TABLE` can neither make `account_uid` mandatory nor drop `NOT NULL` from
    `password_hash`.
  - Rejected: squash everything into one or a few files. Every place where scaffold, recipes and README refer to
    the file names would have to change.
- **The first account when headless** (N3)
  - **Adopted: an offline CLI for the person who can reach the database. It finishes creating the admin and locking
    down in one transaction and exits without starting to listen.**
  - Rejected: a CLI that only creates the account. There is no procedure from a new database's
    `auth.disabled = on` to a state writable over REST. Making lockdown a separate entry creates a half-done state
    where only one of the two happened.
  - Rejected: have `banto-serve` alone ignore `auth.disabled` and always require authentication. The same setting
    in the same database would mean different things depending on the wiring (conventions §1). When the SQLite file
    is shared with Tauri, authenticated writes from the LAN would pass next to a login-less terminal.
  - Rejected: ship an admin-equivalent, loopback-only grant in the template. Behind a proxy the loopback condition
    is no protection (ADR-0017 §6).
  - Rejected: keep `BANTO_ALLOW_SETUP`. A network path that creates the first admin would remain.
- **Accounts over REST while login is off**
  - **Adopted: refuse login and revoke tokens at the switch (REST is read-only).** "Nothing can be changed from
    the network while login is off" then holds without relying on the listen-combination check.
  - Rejected: let authenticated account writes through (today's shape). They are authenticated, so it is not a
    hole, but the premise sentence becomes false, and together with `banto-serve` not consulting the saved setting
    to listen, it becomes impossible to say where the fence is.
- **The default when the key is absent**
  - **Adopted: the migration inserts it explicitly for a new database; a missing or corrupt key stops start-up.**
  - Rejected: a code default of on (the wording of plan §4.3). Merely losing the key in a v8 database would
    produce an admin-equivalent local session (fail-open).
- **Checking a restore candidate**
  - **Adopted: verify the migration history (versions and checksums) read-only, at staging and right before
    applying.**
  - Rejected: look only at required table names. A candidate with v7 checksums passes and the app cannot start
    after the swap (§9).
  - **Adopted: also pass the checks that stop start-up, through the same function, before the swap.** Even a v8
    candidate with a sound history can stop start-up through a missing setting or zero admins.
  - Rejected: leave it to the start-up check after the swap. Start-up stops after the sound original database has
    been replaced.
  - **Adopted: the listen condition is also checked before the swap, for the wiring being restored into and with
    the effective settings.** The wiring passes the check function, so only `banto-serve` includes this
    condition.
  - Rejected: apply the listen condition to every candidate regardless of wiring. A desktop restore would then
    refuse a candidate Tauri can start (login-less with viewer-public off: the very default of a new database).
- **The first-boot seed condition**
  - **Adopted: test "the seeded marker is absent", and fix it in C1 together with 0014.**
  - Rejected: keep "the table is empty" and move the INSERT of the auth keys to a later PR. The baseline migration
    would be rewritten twice.
  - Rejected: move the seed fix to C2b. On main in between, a generated display app starts without public viewing.
- **The order of the first-boot seed and the recovery CLI's lockdown**
  - **Adopted: the CLI also writes the seed and the marker through the same function as start-up, after the
    migrations, and then writes the lockdown in the same transaction.** The lockdown, written later, wins, and
    the next start-up sees the marker and writes nothing. It works for any key.
  - Rejected: the seed does not overwrite auth settings that were written explicitly. (1) Telling "written
    explicitly" apart needs a per-key record of origin (a default inserted by a migration and a value written by
    the CLI are the same row in the same shape). (2) Excluding the auth keys from the seed by name closes the
    way for a preset to set auth defaults ("a preset's default wins over the migration's default" in §5; the
    display preset's `auth.disabled_role`, for example). (3) It protects only the auth keys; any other setting
    written before the seed is still overwritten.
  - Rejected: the CLI settles the seed first in a separate transaction. The harm is small (the same state as a
    database started normally once), but it makes an exception to "a failure in between leaves nothing
    behind". It is unnecessary once the seed function takes a transaction.
  - Rejected: the CLI refuses a database without the marker and asks for a normal start-up first. A new headless
    database stops at start-up when login is off and viewer-public is off. The seed is done before that stop,
    but the procedure would require one failing start-up in between.
- **Login racing the mode switch**
  - **Adopted: confirm the mode generation right before issuing and when authorization completes** (the same
    shape as the grant generation guard).
  - Rejected: only the entry check and the bulk revocation right after the switch. If the mode switches during
    the awaited verification, the old verification issues a token.
- **When the built-in row is protected**
  - **Adopted: C1, which inserts the row, also brings the minimum protection that takes it out of matching and
    modification.**
  - Rejected: leave the protection to C2 (the split in plan §7). On main in between the row can be deleted, and a
    deleted row cannot be put back.
- **A database that requires login but has zero admins** (N4)
  - **Adopted: stop at start-up; recover with the `banto-serve` CLI or the offline restore of §9.**
  - Rejected: silently return to login-less (fail-open).
  - Rejected: give the Tauri executable a CLI as well (§7).

## Consequences

- **v8.0.0 is a breaking change.** Derived apps replace `0003_users.sql` and `0005_audit_log.sql`, add
  `0014_ui_settings.sql`, and **recreate the database** (there is no migration path). A derived app that added its
  own migrations at 0014 or later renumbers them.
- Derived apps that build `Identity` themselves add `accountId`. Without it the owner key is `null` and
  owner-scoped memory is neither saved nor restored (better than silently handing it to someone else). localStorage
  entries under the old `account:` keys become leftovers.
- First-run setup disappears (the screen, the REST endpoint, the Tauri command, `AuthProvider.setup`,
  `BANTO_ALLOW_SETUP`). The default of a new database becomes login-less (0014 inserts the settings explicitly; a
  database where the key is missing or unreadable stops at start-up, §5). The administrative user list shows
  `admin` as one read-only row (it does not appear in counts, CSV or "pick a user" lists, §2). Accounts named
  `admin` (case-insensitive) or like a fixed grant id cannot be created. The audit actor of the Tauri login-less
  session changes from `local` to `admin`.
- **While login is off, accounts can no longer log in over REST** (today they can). Switching to login-less
  revokes account tokens. Operating from the LAN requires lockdown (§6).
- **`banto-serve` does not listen on a database that is login-less with viewer-public off.** The headless first
  run starts with the CLI (create admin + lock down) (§7). The e2e and PostgreSQL operating procedures change.
- **No path may turn the built-in row into "an admin that can log in".** Password reset, CSV import, restore,
  individually granted permissions (ADR-0031) and auto-login are each checked in the implementation PRs and put
  into tests.
- **While login is off, business and administrative data cannot be changed from the network.** The fence is the
  four items of §6 (`local` never leaves over REST, REST is read-only, both wirings check the listen condition
  with the same function, lockdown). The tests of §10 pin it.
- Audit rows whose actor is `admin` come from the Tauri login-less session, marked grants and the CLI. The path is
  in `actor_kind` (`actor_role` is the actual role). The audit table and the wire gain `actor_id` and `actor_kind`
  (`actorKind`).
- REST handlers that write audit rows stop re-resolving the bearer (passing headers to `record_write`) and take the
  principal snapshot the guard built. A derived app that calls `record_write` / `actor_identity` in its own
  handlers has to be rewritten.
- Restore refuses a candidate whose migration history does not match, both at staging and right before applying.
  The wiring passes the migrator to `BackupService`. Going back to a backup after start-up stopped uses the offline
  procedure of placing the pending file by hand (§9).
- A derived app that adds a grant decides per grant whether to set `audit_as_builtin_admin`, and makes sure the
  fixed id does not collide with an existing account's name (start-up stops if it does).
- [ADR-0017](0017-credential-less-grant.en.md) gets an addendum (the acting id of §3, the audit and ui-settings
  item, and the lockdown condition).
- Restore also refuses, before the swap, a candidate that hits a condition that stops start-up (the built-in row,
  required settings, admins when login is required, and for `banto-serve` the listen condition). A login-less
  backup taken on the desktop cannot be restored into a headless deployment while viewer-public is off. A
  derived app that adds a check that stops start-up applies the same check before restore (§9).
- The first-boot seed runs on "the seeded marker is absent" instead of "the table is empty". A derived app that
  carries a copy of `first_boot.rs` has to replace it (otherwise, after 0014, the seed is never written). The
  recovery CLI goes through the same seed function (the seed function takes a transaction; §5, §7).
- Implementation is split into the PRs of plan §7: C1 (rebuilding the baseline, generating `account_uid`, counting
  by `kind`, **the minimum protection of the built-in row**, the restore check, **the fix of the first-boot seed
  condition**), C2 (reserved names, the start-up check, the attribution mark and the authorization-time snapshot,
  `actor_id` / `actor_kind`), C2b (removing first-run setup, explicit settings and stopping on broken ones, REST
  while login is off and **serialization by the mode generation**, the lockdown condition, the CLI), C3 (`accountId` on the wire), C4 and C5 (ui-settings). The table in plan §7 was aligned with
  this split (2026-11-22); if they differ, this ADR takes precedence. Implementation can start with C1 (`Accepted` on 2026-11-22).

## Addendum (2026-11-22, from the C1 implementation; confirmed by the owner)

The C1 implementation (PR #830) changed two points of the body. The owner confirmed both as recommended the same day.
Where the body differs, this addendum takes precedence.

1. **The explicit initial values of `auth.disabled` and `auth.disabled_role` are written in C2b** (changing "written by
   0014" in §5 and §9). Writing them in C1 would make the current `banto-serve` refuse to start in
   `auth_server_combination_allowed` and the Tauri first-run setup refuse as well, breaking "after C1 the current
   first-run setup still creates the first administrator" (plan §5). C2b adds them as an additive migration (`0015`)
   that does not overwrite existing explicit settings. 0014 holds only the table and the built-in `admin` row.
2. **The seeded mark `first_boot.seeded` is written even when the seed list is empty** (changing "write nothing when
   empty" in §10, for that one row only). Without it, an app that later adds seed entries would seed a database in
   use again (a login-required database could fall back to no login). Nothing else is written.

## Addendum (2026-11-22, from the C2 implementation; confirmed by the owner)

The C2 implementation (PR #858) split two sentences of §9, "if the migration or the seed on the working copy fails, refuse"
and "when refusing, do not touch the original DB (delete the reserved file and stop applying)", by the kind of check
result. The owner confirmed it the same day. Where the body differs, this addendum takes precedence.

1. **When the content is confirmed invalid (`Invalid` / `Rejected`), refuse and delete the reserved file as before.** This
   covers: SQLite returned NOTADB or CORRUPT, `integrity_check` reported corruption, a required table is missing, the
   migration history version or checksum does not match, the history table has the wrong shape, or the start-up check
   (built-in row, reserved-name collision) failed.
2. **When the check could not be completed (`Err` / `CandidateRefusal::Unchecked`), do not refuse: keep both the reserved
   file and the original DB, and do not apply.** Examples: cannot open, I/O error, locked, permission, a failed migration
   on the working copy. The next start-up checks again. At staging it returns a non-`validation` error and leaves the
   previous reservation unchanged. "Refuse if the migration or seed on the copy fails" in §9 is replaced, where it refers
   to such failures, by "keep it as unchecked" (implementation: `read_failure` in `banto-admin-services` and
   `apps/admin-template/core/src/startup.rs`).
3. **Why**: so that a transient failure (out of disk space, a lock) does not delete a healthy restore candidate. The cost:
   a candidate to which migrations truly cannot be applied keeps its reservation and reports "could not be checked" at
   every start-up. The original DB is intact, and the reservation can be cancelled from the settings screen.

## Addendum (2026-11-22, from the mode-switch serialization = C2b-b; confirmed by the owner)

Only §6's "allowing a login, issuing a token and authorizing with a token are serialized with the mode switch" was cut out
of C2b and landed first (PR #862). Where it differs from the body, and the details the body did not have, are below. The
points that were to be confirmed are listed separately in the PR description; the owner confirmed all of them as recommended.

1. **The generation check landed in this PR, not in C2** (this replaces "the generation check is added here in C2" in §6's
   2026-11-22 note). The implementation is `AuthState` in `banto-server` (`AuthMode`, `switch_auth_mode`). The mode and its
   generation live under the same lock as the token table.
2. **Two refusals**: `LoginOutcome::LoginDisabled` while the mode is no-login now (`200 {success:false, error}`, the same
   text as Tauri's `auth_login`); `Unavailable` (503, a retry gets in) when the mode went there and back during the
   credential check and is login-required again. In no-login mode the login is refused on entry and the verifier does not
   run (nothing counted, nothing audited - as on the Tauri side).
3. **When authorization is complete**: `authenticate` checks against the table after the account lookup. Reading the
   permissions is one more await after that, so everything that reads both a token and its permissions is gathered into
   `AuthState::authenticate_with_permissions`, which compares the generation it read on entry once more after the
   permissions read (`require_auth`, `GET /api/auth/identity`, a `PermissionGuard` without `require_auth`; cross-review of
   PR #862). The Tauri webview has the same shape: `authorized_session` compares the `seq` from the settle's own lock after
   the permissions read and, if it moved, ends as unauthenticated (`require_permission`, `session_permissions`; it does not
   authorize again from the slot as it is now, i.e. never as another subject). Only `auth_identity`, which is for display,
   reads again. `auth_resolve` reports the same window as `stale`.
4. **Writes in progress**: a write that passed the guard is not interrupted, and the switch does not wait for the remaining
   work (the same as #793's "revocation takes effect from the next request"). The switch's `settings_change` audit detail
   carries the number of account tokens it revoked as `revokedSessions: n` (omitted when 0). The audit of a write in
   progress stays with the actor it was authorized as.
5. **`issue_token` / `issue_token_remembered` / `issue_account_token` keep their return type.** In no-login mode they return
   a token that was not stored (401 on first use). They do not await, so they need no entry generation. A wiring that opens
   `/api/auth/setup` (`allow_setup = true`) must not switch its `AuthState` to no-login until first-run setup is removed (the
   two do not meet in the stock wiring).
6. **Only the Tauri app is wired**: `auth_config_apply` switches right after its save, and start-up copies the stored mode.
   So while the Tauri app is in no-login mode, the embedded server refuses account logins, and account tokens are revoked at
   the switch (the first half of item 2 of "this premise is protected by the following four"). `banto-serve` does not copy
   the mode yet (it stays on the default, login required). Read-only REST in no-login mode, the listen condition and the CLI
   come with the rest of C2b (copying the mode before the CLI exists would lock the administrators of a headless display
   app out).

## Addendum (2026-11-23, from removing first-run setup = the rest of C2b; awaiting the owner's confirmation)

What was left of C2b in sections 5-7, 9 and 10 is in: the default, the
settings check, the lock-down condition, `banto-serve`'s read-only mode and
listening condition, the CLI, the pre-restore check, and the removal of
first-run setup. Where the implementation differs from the text above, or
settles a detail it left open, is listed here (and in the PR as questions for
the owner; once confirmed, this heading becomes "confirmed by the owner").

1. **`0015_auth_mode_defaults.sql` writes `auth.disabled = 'false'` on a
   database that already holds accounts** (an addition to item 1 of the C1
   addendum, "an appended migration that does not override an explicit
   setting"). An existing `auth.disabled` row is never changed. Without one,
   the value is `'false'` when any account (`kind = 'account'`) exists and
   `'true'` otherwise: on databases created on main between C1 and C2 a
   missing key meant "login required", and a migration must not turn that
   into no-login silently (section 5: "no-login is the default of a new
   database only"). A database with no administrator (editors only) becomes
   `'false'` and is then stopped by the check (the CLI repairs it).
   `auth.disabled_role` becomes `'admin'` when missing. The baseline
   (`BASELINE_MIGRATION_VERSION`) stays 14.
2. **The lock-down condition lives in the save itself
   (`SettingsService::set_auth_config`).** A wiring calls the save under
   `auth_config_lock`, so "judge and save under one lock, before the
   revocation" (section 6) holds, and every caller - the Tauri command, a
   derived app's own route - goes through the same judgment (conventions
   section 1). The CLI creates the administrator in the same transaction and
   then writes the mode with `require_login_on_*` (it does not go through
   this judgment; it satisfies the condition itself).
3. **`startup::check(db, wiring)`**, with `Wiring::Desktop` and
   `Wiring::Headless { viewer_public_forced }`. `banto-serve` writes
   `BANTO_VIEWER_PUBLIC=1` to the settings before it checks and passes it to
   the restore-candidate check as `viewer_public_forced`, so the check equals
   what actually stops that start (section 9, (e)). **The check reads only
   the stored `server.viewer_public`**; the variable is "written before the
   check" (`startup::seed_viewer_public`, one function for the start and the
   working copy), so a no-login database whose write failed does not listen
   (cross-review of PR #865). The working copy is prepared like a start:
   `db::prepare` (migrations and the app's seed), the first-boot seed, then
   that write. A candidate is checked on
   a working copy after the migrations AND the first-boot seed (the same
   function as a start); a failing seed is "could not check", like a failing
   migration (C2 addendum, item 2).
4. **While login is required, `auth.disabled_role` is not checked.** No
   session is built from it, so a missing or unknown value does not stop the
   start (the read answers `admin`, which nothing uses; the next save writes
   it again).
5. **CLI details** (section 7 left the arguments to C2b):
   `banto-serve create-admin --username <name> [--display-name <name>]`. The
   password is the first line of standard input (the trailing newline is
   dropped; typed at a terminal it is echoed). The database is `BANTO_DB`.
   Exit codes: 0 = done, 1 = no account, auth setting or audit row written
   (the migrations may have been applied), 2 = bad arguments. The database
   is opened with the migrations only (`db::open_migrated`; the app's demo
   seed of a start does not run). Two audit
   rows (`create` / `users`, and `settings_change` / `settings`
   `{authDisabled: false}`) with `actor_username = 'admin'`, `actor_id` = the
   built-in row, `actor_kind = 'cli'`, `origin = 'cli'`. A database without
   the built-in row (edited directly) is not repaired by the CLI (`actor_id`
   is NULL and the next start's check stops it). The code is
   `admin_template_core::first_account::create_admin_and_require_login`.
6. **`auth_config_apply` refuses an unknown role with `Validation`** instead
   of turning it into `admin` (section 5's "stop degrading an unreadable role
   to admin", applied to the save's entry too). The session-less window it
   had while no account existed is gone.
7. **A field for the screen**: the answers of `auth_config_get` /
   `auth_config_apply` carry `hasAdminAccount` (the settings screen says why
   login cannot be required and points at user management; the save judges
   again). `initialized` is gone from `status`.
8. **Where the acceptance tests live** (section 10): the headless path, the
   CLI before the first start with a seed, broken settings, and the CLI with
   a staged restore are in `core/src/first_account.rs` and
   `core/src/startup.rs` (SQLite) and `core/tests/pg_smoke.rs` (PostgreSQL,
   with the display preset's seed). Listening and restore are in
   `core/src/startup.rs`; REST in no-login mode in `core/src/rest/tests.rs`;
   the desktop lock-down in `src-tauri/src/tests.rs`. "CLI -> start -> login"
   on the generated display app runs in template-acceptance. The e2e
   viewer-public suite is split over two servers: "no account, no login" and
   "an administrator from the CLI, login required".
9. **Tests that went away with their premise**: first-run setup and its races
   (S-18, S-19, S-95's setup, PostgreSQL's concurrent setup), and
   `auth_config_apply` from an empty slot (one S-67 test; with login required
   and no session it is `Unauthorized`).
10. **What "an administrator that can log in" means** (cross-review of PR
    #865): `UsersService::has_admin` answers whether some row with
    `kind = 'account'` and `role = 'admin'` has a username the verifier looks
    up (not empty, within the length limit) and a stored hash the verifier can
    check (an argon2 PHC string that carries its output). The password itself
    is not checked. Startup, the restore candidate and the lock-down all ask
    this one function; a database whose only administrator rows have damaged
    hashes is treated like one with no administrator. "Can check" means:
    an algorithm, version and parameters argon2 accepts, a salt that decodes
    to at least its minimum length, and an
    output. The last-administrator guard (demotion, deletion) asks the same
    predicate (`can_log_in`) inside its write transaction: is there ANOTHER
    administrator that can log in.
11. **A failed preparation is handled the same way by a start and by the
    restore check** (cross-review of PR #865): a failure of `db::prepare`
    (migrations and the app's seed) or of the first-boot settings seed
    **stops the start** in both wirings (the seed failure used to be a
    warning), and is "could not check" for a candidate (the pending restore
    is kept, nothing is swapped). Going on would let a later start seed an
    unmarked database over settings saved in between (a lock-down). A failed
    `BANTO_VIEWER_PUBLIC` write lets both go on; the check then judges by
    the stored value.
