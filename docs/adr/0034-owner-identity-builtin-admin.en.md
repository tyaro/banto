# ADR-0034: Identify owners by a never-reused `accountId`, attribute login-less operations to the built-in `admin`, and remove first-run setup (v8.0.0; no compatibility, databases are recreated)

> 日本語: [0034-owner-identity-builtin-admin.md](0034-owner-identity-builtin-admin.md)

- Status: Proposed (drafted 2026-11-22. The direction is settled by the owner's decisions 1-6 and 16-19 of the same
  day and by N1-N6 in §10 of the plan. Awaiting approval of the details this ADR newly fixes: the name and carrier
  of the mark in decision §3, the hand-over point for reserved names in §4, and the recovery path in §7)
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

- A new database has one row from the start, inserted by a migration: `username = 'admin'` (lowercase),
  `kind = 'builtin'`, `role = 'admin'`, `password_hash` NULL, `account_uid` NULL.
  - Column CHECKs enforce "`kind = 'builtin'` ⇔ `password_hash IS NULL`" and "`kind = 'builtin'` ⇔ `account_uid IS NULL`".
  - A partial unique index (`WHERE kind = 'builtin'`) enforces that there is exactly one built-in row.
- **It has no password and cannot log in.** The credential verifier rejects `kind = 'builtin'` before looking at
  the hash (a second guard on top of the CHECK). When it rejects, it still runs the same dummy hash verification as
  for a missing user (response time does not reveal the row). A login attempt as `admin` is treated like one for a
  missing user and falls under the REST login attempt limits as is.
- **Renaming, disabling, demoting, setting a password and deleting are all forbidden** (in the service layer;
  conventions §2). The SQL of `change_password` and `reset_password` also carries `kind = 'account'`.
- **The last-admin guard** (`ensure_admin_removal_allowed`, `crates/banto-admin-services/src/users.rs:313`) does not
  count the built-in row (`role = 'admin' AND kind = 'account'`). Counting it would allow deleting every human admin.
- The row's `role` is for display in the list only and is **never used for authorization**.
- Everything that counts `users` (list, counts, CSV, backup validation, the last-admin guard) looks at
  `kind = 'account'`. **Whether a row is built-in is decided by `kind` everywhere, never by name.**
- Only `admin` becomes a row. Other fixed grant identities such as `public` get no row (§4 reserves their names).

### 3. Attributing login-less operations: the explicit mark `audit_as_builtin_admin`

Which sessions are attributed to `admin` is never inferred from id or name (conventions §10). The wiring layer sets
a mark.

- **Name of the mark (fixed by this ADR)**: add **`audit_as_builtin_admin: bool`** to `GrantSpec`
  (`crates/banto-server/src/grant.rs:197`). The default is `false` (set by `GrantSpec::new`). The name contains
  `audit` so that it reads as affecting **audit attribution only** (authorization, role and the owner key do not change).
- **Where it is carried (fixed by this ADR)**: it is copied to the issued session's `AuthenticatedSession`
  (`crates/banto-server/src/auth/session.rs:146`) as a `#[serde(skip)]` field of the same name. Plan §4.3 said
  "copy it to `SessionStamp`", but `SessionStamp` (`session.rs:53`) is the account's `account_id` / `auth_epoch`
  pair and is `None` for grant sessions (`session.rs:137`), so it cannot carry the mark. The mark is not put on the
  wire (`Identity`'s id, name, role and `kind` do not change).
- **The code that writes audit entries looks at the mark only.** One function decides the attribution, and both
  REST and Tauri call it (conventions §1).
  - Marked: `actor_username = 'admin'`, `actor_id` = the id of the built-in row (looked up by `kind = 'builtin'`,
    not by name and not by a fixed number). `actor_role` is **the session's actual role** (viewer stays viewer).
  - Unmarked grants (viewer-public's `public` and the like): the fixed id as today, `actor_id` NULL.
  - Accounts: `actor_username` is the username, `actor_id` is `users.id`.
- **The Tauri login-less session (`local`) is attributed to `admin`.** The Tauri wiring puts a mark of the same
  meaning on its synthetic session (the audit actor changes from `local` to `admin`). The ui-settings owner and
  `sessionOwnerKey` stay `local` (attribution is for audit only).
- banto adds no role or `require_loopback_peer` condition to a marked grant (which grant is recorded as `admin`'s
  operation is the app's decision). The defaults for admin-equivalent grants (loopback, a small `max_sessions`)
  stay as in the consequences of ADR-0017.
- The audit table gains `actor_id` (nullable, no foreign key; audit entries outlive deleted users). The
  `actor_username` snapshot stays.

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

- **First-run setup creates neither a user nor a password.** A new database starts without creating users.
- The default of `auth.disabled` becomes on (when the key is absent). Tauri starts and enters the app with the
  synthetic session `local` (role from `auth.disabled_role`, default admin). Neither the login screen nor a
  first-run setup screen appears.
- Only users who need user management create accounts, from the user management screen. The audit actor of that
  operation is `admin` (§3).
- Removed: `setup_first_user` and `is_initialized` (`users.rs:738`, `:706`), REST `POST /api/auth/setup`,
  `allow_setup` and status's `initialized`, Tauri's `auth_setup` and the bootstrap window of `auth_config_apply`,
  the screen's `setup` branch and `AuthProvider.setup`, and `BANTO_ALLOW_SETUP`. The very state "initialized"
  disappears (a new database is usable at any time after its migrations).

### 6. The lockdown condition and the safety premise

- **Safety premise** (the thinking of ADR-0017 and spec M11, unchanged): while login is off, **the person in front
  of the device is trusted**. Anyone can operate with the synthetic session's role (admin by default). This is
  acceptable because, while login is off, **nothing can be written from the LAN**: "`auth.disabled` and
  `server.enabled`" is allowed only when viewer-public (`viewer_public`) is on
  (`auth_server_combination_allowed`, `crates/banto-admin-services/src/settings.rs:237`; both save paths and the
  Tauri start-up use the same judgment). What can be opened is read-only.
  **Since the default becomes login-less, this combination rule is the only fence. It is not relaxed.**
  Users who want operation from the LAN create an account first and then lock down.
- **REST while there are zero accounts**: REST has no login-less admin session. Login always fails (no account;
  the built-in is rejected) and there is no first-run setup endpoint, so only viewer-public reads and grants added
  by a derived app get through. The authorization rules go through the same functions on both paths (conventions §1).
- **Lockdown** (turning `auth.disabled` off) is allowed **only when at least one admin account that can log in
  (`kind = 'account' AND role = 'admin'`) exists**. Otherwise it is refused with `Validation` and the message
  "create an admin account first".
  - The judgment and the save happen under the same lock, and the judgment is placed **before** ADR-0017's flow
    "save → revoke grants right after, in the same function".
  - After lockdown the login-less session is revoked. Grant revocation stays as in ADR-0017: a grant whose issuing
    condition closes with the lockdown (a derived app's commissioning, for example) calls
    `revoke_grant_tokens(kind)` right after the save, in the same function.
- **The last-admin guard always applies, also while login is off** (N5). An admin, once created, cannot go back to
  zero, so the race "the last admin disappears after the judgment and before the save" cannot happen. The price is
  that the last admin created while login is off cannot be deleted.
- **A database that requires login but has zero admin accounts** (cannot be produced through the app; only by
  direct editing) stops at start-up with an explicit error (N4). It is not silently returned to login-less (that
  would let anyone who can rewrite the database remove authentication; fail-open).

### 7. The first account when headless, and the recovery path

- Headless (`banto-serve` only; PostgreSQL operation and e2e) has no Tauri login-less session, so the first account
  is created with **a CLI for the person who can reach the database** (arguments of `banto-serve`) (N3). It is not
  a network endpoint. The audit entry is recorded as an operation of the built-in `admin`.
  - The password is not taken as an argument (it would stay in the process list and the shell history). It is read
    from standard input. The exact arguments are decided in C2b.
  - The creation itself goes through the ordinary `UsersService` creation (same validation, reserved names and audit).
- **Recovery path (fixed by this ADR; the rest of N4)**: the account-creating CLI lives in **`banto-serve` only**.
  **The Tauri executable gets no CLI.**
  - "Login required but zero admins" only arises from rewriting the database directly. Whoever can do that can run
    the `banto-serve` CLI against the same database (a SQLite file or PostgreSQL alike). Restoring a backup also
    recovers.
  - Adding "create an account by arguments" to the desktop executable would add an admin-creating path that
    bypasses the screen to every distributed binary that has authentication. A Windows GUI executable would also
    need separate handling of standard input and the console.
  - The work is one function in core, called from `banto-serve`. A derived app is free to add the same path to its
    own executable.

### 8. ui-settings of grant sessions are keyed by kind

- Storage is the new table `ui_settings`. The owner is a string column: `acct:<users.id>` for an account,
  **`grant:<kind>`** for a grant, `local` for the Tauri login-less session. No user row is created for a grant.
- Devices of the same kind share settings (the same nature as today's `ui.<identity.id>.*`; the key changes from
  the fixed id to the kind). A marked grant stays `grant:<kind>` too (it does not become `admin`'s property;
  attribution is for audit only).
- Account rows are protected by a foreign key on a separate column `user_id` (`ON DELETE CASCADE`). The shape of
  the revision and conditional writes belong to #786 and are not decided here (plan §4.4).

### 9. No compatibility; the baseline is rebuilt

- **There is no data migration.** The existing `0003_users.sql` and `0005_audit_log.sql` are **rewritten** into
  the new shape, and `0014_ui_settings.sql` (the table and the INSERT of the built-in `admin` row) is added (both
  SQLite and PostgreSQL; the rule 11 symmetry is kept). The other 11 files, the file names and the numbering do not
  change.
- conventions §11's "released migrations are append-only" is broken **exactly once**. `pnpm verify:migrations` gets
  a one-time allowance for changes to these 4 files only when comparing against tag `v7.11.0` (C1). After the
  v8.0.0 tag it is append-only again.
- **Databases and backups of older versions are not read; they are refused with an explicit error.**
  - Start-up: the body of 0003 changes, so sqlx stops on the checksum mismatch of the applied migration
    (`VersionMismatch`). 0014 is last in the sequence, so it stops before any new migration touches the old
    database. `db::run_migrations` (`apps/admin-template/core/src/db.rs`) maps this to "this database is from a
    version before v8.0.0 and cannot be read; recreate the database".
  - Restore: refused **before** the replacement. `ui_settings` is added to `REQUIRED_TABLES`
    (`crates/banto-admin-services/src/backup.rs:151`). An old backup is rejected at scheduling time with "a
    required table is missing".

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
  - **Adopted: an explicit mark on `GrantSpec`, copied to the session.**
  - Rejected: infer from the fixed id or the role ("an admin-role grant is `admin`", and so on). It violates
    conventions §10, and attribution would change silently when a derived app adds a grant.
  - Rejected: carry the mark on `SessionStamp`. Grant sessions have no `SessionStamp` (§3).
  - Rejected: a name such as `acts_as_builtin_admin`. It reads as if authorization changed too.
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
  - **Adopted: a CLI for the person who can reach the database.**
  - Rejected: ship an admin-equivalent, loopback-only grant in the template. Behind a proxy the loopback condition
    is no protection (ADR-0017 §6).
  - Rejected: keep `BANTO_ALLOW_SETUP`. A network path that creates the first admin would remain.
- **A database that requires login but has zero admins** (N4)
  - **Adopted: stop at start-up; recover with the `banto-serve` CLI.**
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
  `BANTO_ALLOW_SETUP`). The default of a new database becomes login-less. The user list has one `admin` row.
  Accounts named `admin` (case-insensitive) or like a fixed grant id cannot be created. The audit actor of the
  Tauri login-less session changes from `local` to `admin`.
- **No path may turn the built-in row into "an admin that can log in".** Password reset, CSV import, restore,
  individually granted permissions (ADR-0031) and auto-login are each checked in the implementation PRs and put
  into tests.
- **The LAN combination rule is the only fence.** Tests pin, at three places (start-up, both save paths, and
  `banto-serve`), that nothing can be written over REST while login is off.
- Audit rows whose actor is `admin` come from both the Tauri login-less session and marked grants. The actor does
  not tell which path it was (`actor_role` is the actual role).
- A derived app that adds a grant decides per grant whether to set `audit_as_builtin_admin`, and makes sure the
  fixed id does not collide with an existing account's name (start-up stops if it does).
- [ADR-0017](0017-credential-less-grant.en.md) gets an addendum (the acting id of §3, the audit and ui-settings
  item, and the lockdown condition).
- Implementation is split into the PRs of plan §7: C1 (rebuilding the baseline, generating `account_uid`, counting
  by `kind`), C2 (protecting the built-in row, the attribution mark, reserved names), C2b (removing first-run
  setup, the lockdown condition, the CLI), C3 (`accountId` on the wire), C4 and C5 (ui-settings). Implementation
  does not start until this ADR is `Accepted`.
