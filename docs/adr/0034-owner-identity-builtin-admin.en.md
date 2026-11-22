# ADR-0034: Identify owners by a never-reused `accountId`, attribute login-less operations to the built-in `admin`, and remove first-run setup (v8.0.0; no compatibility, databases are recreated)

> 日本語: [0034-owner-identity-builtin-admin.md](0034-owner-identity-builtin-admin.md)

- Status: Accepted (drafted 2026-11-22. The direction is settled by the owner's decisions 1-6 and 16-19 of the same
  day and by N1-N6 in §10 of the plan. On the same day the owner approved, all as recommended, the details this ADR
  newly fixed (the name and carrier of the mark in decision §3, the hand-over point for reserved names in §4, the
  recovery path in §7) and every point in "Points to confirm with the owner" of PR #804. Also on the same
  day the four cross-review findings on PR #804 were incorporated: the timing of the protection and the display
  contract in §2, the authorization-time snapshot and `actor_kind` in §3, the LAN write condition and the headless
  CLI contract in §5-§7, the restore check in §9, and the acceptance tests in §10)
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
- `seed_first_boot_settings` writes only "when `settings` is empty"
  (`apps/admin-template/core/src/first_boot.rs:40-53`). Once 0014 inserts rows that condition no longer holds, so
  C2b revises it (details in C2b).
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
  - **Run it with the app and the server stopped.** The CLI cannot revoke sessions held in the memory of a running
    process. Used on the SQLite file a Tauri app shares, it makes that app login-required too (as intended).
  - The audit row is recorded as an operation of the built-in `admin` (`actor_kind = 'cli'`, `origin = 'cli'`).
  - The password is not taken as an argument (it would stay in the process list and shell history). It is read
    from standard input. Argument details are decided in C2b.
- **The headless first-run path**: new database → starting `banto-serve` as is stops without listening, because
  login is off and viewer-public is off (item 3 of §6) → CLI (create admin + lock down) → start → log in → update.
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
- **The offline recovery procedure** (the way to "go back to a backup" after start-up stopped). Today a restore
  can only be staged from the running administration screen. A stopped start-up cannot reach it, so a procedure
  that bypasses the screen is fixed here.
  - Stop the app → place the backup to go back to in that database's backup directory under the pending file name
    (`restore-pending.sqlite3`) → start.
  - **The start-up order is "apply the pending restore → migrations → settings and admin checks"** (the apply
    already comes first: `banto-serve.rs:111`, `apps/admin-template/src-tauri/src/lib.rs:4358`). This order is
    fixed as a rule. A hand-placed file also goes through the check right before applying (above). If it fails it
    is deleted and the original database does not change.
  - It works in desktop-only derived apps that do not ship `banto-serve`. The procedure is written in upgrading
    and README (C1).
  - PostgreSQL has no banto restore entry (`backup.rs:206-215`). Operators restore with their own tools. An old
    database is refused by the start-up check above.

### 10. Acceptance tests (part of the completion criteria of the implementation PRs)

- **The headless path** (C2b; both SQLite and PostgreSQL): new database → starting as is stops without listening
  → CLI (exits without starting to listen; the account, the lockdown and the audit row land together) → start →
  log in → an update succeeds and is audited. A database on which the CLI failed midway has neither the account
  nor the lockdown.
- **While Tauri is login-less** (C2b): an existing account cannot log in over REST. An account token issued before
  the switch can neither read nor write over REST. A viewer-public session can only read and PUT the ui-settings
  of its own kind; business and administrative changes are refused. An explicit app grant behaves as its
  `GrantSpec` says.
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
- **Restore** (C1): the regression tests of §9.

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
- Implementation is split into the PRs of plan §7: C1 (rebuilding the baseline, generating `account_uid`, counting
  by `kind`, **the minimum protection of the built-in row**, the restore check), C2 (reserved names, the start-up
  check, the attribution mark and the authorization-time snapshot, `actor_id` / `actor_kind`), C2b (removing
  first-run setup, explicit settings and stopping on broken ones, REST while login is off, the lockdown condition,
  the CLI), C3 (`accountId` on the wire), C4 and C5 (ui-settings). The table in plan §7 was aligned with
  this split (2026-11-22); if they differ, this ADR takes precedence. Implementation can start with C1 (`Accepted` on 2026-11-22).
