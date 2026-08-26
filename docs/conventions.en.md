# Banto maintainer conventions — invariants you must not break

> The Japanese [`conventions.md`](conventions.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Intended reader: **people who maintain and extend the template itself**
(Track A). Procedures for users building their own app from the template live
on the [README](../README.md) side (Track B). For the distinction between the
two tracks, see
[README "Documentation comes in two tracks"](../README.md#ドキュメントの2トラック).

Positioning: this collects, in one place, the "why we write it this way" rules
that used to be scattered across the doc comments at the top of each module, so
they can be referenced every time a feature is added. The items written here
are limited to **invariants that machines (lint/types/CI) cannot fully enforce,
and are upheld by review**. General language style (naming, formatting) is
delegated to eslint/prettier/clippy/rustfmt and is out of scope here.

The three categories of documentation (added 2026-07-19, improvement-plan
P4-7): the "why" is divided into three roles — **code comments** (local reasons
that only make sense in place) / **this document** (cross-cutting invariants =
rules to uphold) / **[ADR](adr/README.en.md)** (design decisions that chose one
option by comparing alternatives = why that rule was made). Where the "why"
behind an invariant here involves a comparison of alternatives, it can be
traced from the corresponding ADR (e.g., §1 · §2 →
[ADR-0001](adr/0001-rest-tauri-two-path-symmetry.en.md), §3 →
[ADR-0002](adr/0002-minimal-dependencies.en.md)). Do not write the same "why"
in two places.

Machine checks (added 2026-07-19, improvement-plan P3-5): the machine-checkable
items in this document are checked by `pnpm verify:architecture`
(`scripts/verify-architecture.mjs`, enforced in the CI frontend job). Such
items are annotated **[machine-checked]** in each section — everything else
continues to be upheld by review. Intentional exceptions are managed as a pair:
a justification comment in the code + an allowlist (with reasons) in the script.

Deletability: this document is a Track A asset. If you **hard-fork and evolve
independently** without tracking upstream, you may delete it wholesale
(following the template's "everything is deletable" policy). Keep it if you keep
tracking upstream / keep maintaining the template.

How to reference: because line numbers change, this document references by
**file + symbol name + spec section** as a rule. The actual code is the primary
source; if there is a discrepancy, the code wins.

---

## 1. Decision symmetry between REST and Tauri [machine-checked: existence of both paths for mutating operations]

Every mutating operation (create/update/delete/import/login/logout/setup)
**passes through the same authorization and the same audit on both the REST and
Tauri paths**. Only the origin (`"rest"` / `"tauri"`) differs.

- REST: `RoleGuard` / `require_role_at_least` + `record_write` in
  `banto-server` `routes/mod.rs` (moved from `admin-template-core` `rest/mod.rs`
  in V2 theme C PR-C4; the app-side `rest/items.rs` · `rest/attachments.rs`
  import and use these).
- Tauri: `require_role` in `src-tauri/src/lib.rs` (its doc comment states
  "mirrors REST's `RoleGuard`") + `audit.record(...)` in each command.
- The correspondence table is in the module doc of `rest/mod.rs` (spec M14).
- **Read operations (list/get) are not audited on either path.** A denied
  record is written only for "authenticated but insufficient role." No-session
  (Unauthorized) is not recorded — this decision, too, is aligned on both
  sides.

When adding a feature: do not add a new mutating command to only one of the
paths. Always implement and test both paths + the denied case on both paths as
a pair (template-scope §6 checklist ④⑤).

**Machine check (`verify:architecture` rule 8, CR-1)**: that a mutating
operation exists on both the REST/Tauri paths is guaranteed by the `DUAL_PATH`
manifest + completeness check in `scripts/verify-architecture.mjs`. Unless you
add a new Tauri command / REST route to a classification (dual-path /
desktop-only / read), CI fails — so **the mistake of adding to only one path is
always caught**. For declared pairs, **rule 8 also cross-checks the role floor
(authorization level) on both paths** (CR-6: the `role` field of `DUAL_PATH`
plus `ROLE_READ` for reads). The only part outside the machine check is
**whether the audit records are identical** (same `AuditEntry` shape), which is
guaranteed by code + tests. The rationale for the desktop-only / read
classification is in maintainability-review-2026-07.md §3.

**Canonical audit shape** (outside the machine check = aligned by code + tests;
deviations were measured and fixed in maintenance-review-2026-08 §5.3):

- **`resource` follows the operation's target.** The audit-log *retention
  policy* config (`audit_config_get`/`apply`) reads/writes settings, not the
  audit log itself, so both its success and denial use `resource: "settings"`
  (only `audit-log/list`, which reads the log body, keeps `"audit_log"`). On
  REST this is done by splitting `audit_log_router` into a list guard and a
  config guard. Tagging denial and success alike lets an admin filtering by
  resource see refusals and successes in one bucket.
- **`entity_id` is "the target's real name".** Backup operations always use the
  backup file's real name (`backups_create` and restore-from-existing are
  `Some`; restore-from-upload has no server-assigned name yet, so `None` with
  the display name in `detail.fileName`).
- **A denial's `detail` may be asymmetric between paths.** REST carries
  `{method, path}` (a side effect of the RoleGuard middleware) while Tauri is
  `None`. A denial records an operation that did NOT run, so what matters is
  "who was refused which `resource`"; identifying the specific operation is
  unnecessary (an operation that ran leaves its `action`/`entity_id` on the
  success entry). This asymmetry is deliberate.
- **REST login does not record throttled (429) attempts** — `login_failed` is
  recorded only once the request reaches the argon2 verifier. This is a
  deliberate asymmetry to avoid audit-log self-DoS; the Tauri path (local
  input, no throttle) records every failure. The lockout itself is separately
  observable as rate-limiter state.

## 2. The service layer knows nothing of tauri / axum / RBAC / HTTP [machine-checked: tauri/axum non-dependence only]

All services (`ItemsService` / `AuditLogService` / `BackupService` /
`SettingsService` / `UsersService` / the `AttachmentsService` of
`banto-attachments`) keep the same shape:

- `#[derive(Clone)]` (`Db` (an enum wrapper over an Arc-backed pool) /
  `broadcast::Sender` / `PathBuf` are Arc-backed or read-only, so cloning is
  cheap).
- Return `Result<_, BantoError>`. Do not depend on `tauri` / `axum`.
- Authorization, audit, and event notification are **attached by the caller
  (the REST/Tauri wiring layer)**. The service knows nothing of actor / RBAC /
  HTTP (`audit.rs` doc: "This service does not know about actors, RBAC, or
  HTTP").

Effect: services can be driven directly from a `:memory:` pool in
`cargo test`. Each service's `#[cfg(test)] mod tests` assumes this shape. New
services also keep this contract.

## 3. Do not add dependencies (a culture of hand-implementation)

The workspace (root `Cargo.toml`) curates dependencies carefully and does
**not** include the following. Each is substituted by a hand-written
implementation:

| Dependency you might want | Instead | Where it is implemented |
|---|---|---|
| `chrono` / `time` | hand-written date conversion | `iso_datetime_from_system_time` / `compact_stamp` in `backup.rs`. Howard Hinnant's `civil_from_days` is ported in three places (`banto-attachments`, `backup.rs`, the app's `core/src/db.rs`; if a fourth appears, decide on consolidating into `banto-core`) |
| MIME detection library | magic-byte detection | `banto-attachments` `detect_mime` (see §6 below) |
| `multipart` | raw byte body + `?fileName=` query | uploads in `banto-server` `routes/backups.rs` · app `rest/attachments.rs` |
| `tower-http` | hand-written `axum::middleware::from_fn` | `security_headers.rs` / `csrf.rs` |
| markdown library | own parser + escaping | `packages/report/src/core/{parse,bind,html}.ts` (deps empty) |
| `tracing` | `eprintln!` | `audit.rs` |

Rule: if you want to pull in any of the above, that is a design decision and
**subject to discussion**. Do not add it lightly (avoid binary bloat, an
enlarged audit surface, and the copy burden on users).

Decision criteria (added 2026-07-18, improvement-plan-2026-07.md P1-5): the
goal is not "zero dependencies" but **minimizing total maintenance cost**. If
several of the following apply, favorably consider adopting the dependency:

- the hand-written implementation is growing (rule of thumb: over ~100–200
  lines, or its spec has started to expand)
- it touches a security boundary (with a hand-written one, you must chase
  vulnerability fixes yourself)
- it is a domain with many edge cases: Unicode, date/time, cryptography,
  parsers, etc.
- the crate/package is sufficiently mature (maintenance track record, few
  dependencies)
- you can pull in only the needed part behind a feature flag
- you have measured the increase in binary/bundle size and confirmed it is
  within an acceptable range

Conversely, a small hand-written implementation that matches none of these
should stay as is. Do not preemptively replace existing hand-written
implementations (the table in §3) — decide individually, at the point when each
implementation actually starts to match the above.

Individual "add it or not" deferred decisions are recorded in an ADR (including
the comparison of alternatives): **server logging (using `eprintln!` instead of
pulling in `tracing`) is [ADR-0004](adr/0004-server-logging-eprintln.en.md)**,
**TLS on the LAN (terminating at a reverse proxy instead of pulling in rustls)
is [ADR-0003](adr/0003-tls-via-reverse-proxy.en.md)**. Both are Accepted as
"do not add it now, with conditions for reconsideration."

**Exceptions on the "add it" side are also recorded in an ADR**: the decision to
pull in Paraglide JS for the UI i18n runtime is
[ADR-0005](adr/0005-i18n-paraglide.en.md) (this table and policy are kept as-is;
an intentional exception limited to i18n — adopted under the P1-5 criteria of
"compile-time i18n so the runtime dependency is minimal and type-safe"). i18n is
in the app layer only; neither dictionaries nor i18n dependencies go into
`@banto/*` (§5).

## 4. No reverse dependency from core → options [machine-checked]

Core (`admin-core` / `grid-svelte` / `forms` / `theme`) does not import
options. The dependency direction is "shell → option allowed, option → core
allowed, **core → option not allowed**". **The canonical core/option list is
the table in [template-scope.md §3](template-scope.md)** (do not duplicate the
enumeration here — duplication is a drift source; machine checks rule 2/6 walk
`packages/` dynamically, so new packages are covered automatically).

Current guarantees:

- The `dependencies` / `peerDependencies` of all `packages/@banto/*` are empty.
- There are zero `from '@banto/...'` imports between packages.
- Notes like "charts/dock consume this token" in `theme/banto.css` are comments,
  not imports.

When you bundle an option, add a row to the table in template-scope §3 and take
on **the obligation to document its removal procedure (the list of files to
pull out)**. Keep a structure where deleting it does not break the rest (§6
checklist ②③).

## 5. Packages hold no app-specific imports [machine-checked: `$lib` import only]

Components in `packages/@banto/*` **do not import app-specific symbols** such as
`sessionStore` or the `ProviderError` of `@banto/admin-core`. The transport is
injected, as in `client: XxxClient` (e.g., `AttachmentsPanel` receives an
`AttachmentsClient` and never imports `attachmentsAdmin.ts` (the app-side layer
you copy and rewrite) from the package).

State ownership: loading/empty/error states are owned inside the component and
do not leak branching to the host page (the same rule as grid-svelte).

## 6. Security invariants (cross-cutting) [machine-checked: partial (no mime / settings symmetry)]

These are the kind of rules that "become vulnerabilities if not upheld." Items
without a runtime guard are **upheld by reviewing every call site**.

- **Detect MIME by magic bytes. Do not use the client's declaration.**
  `banto-attachments` `detect_mime` limits to four formats via the magic bytes
  of `image::guess_format`; anything else is `application/octet-stream`.
  `NewAttachment` has no `mime` field (it does not even receive a declaration).
  **[machine-checked: `NewAttachment` has no mime field (rule 9)]**
- **Do not use user input in file paths.** The attachment body is named by the
  row id, and `file_name` is display-only. For backups, `safe_backup_path`
  rejects all separators, `..`, and anything outside `[A-Za-z0-9._-]` (which
  also simultaneously blocks Content-Disposition injection and Windows reserved
  names). Attachments have the same kind of check in `validate_file_name`.
- **Throttle before heavy verification (argon2).** `auth.rs`
  `login_rate_limited` passes a two-dimensional throttle, per-(IP+username) and
  per-IP, **before** the argon2 verifier (a DoS countermeasure against a
  username-rotation flood). The regression test
  `per_ip_dimension_bounds_a_username_rotation_flood` verifies that "argon2 is
  not called during a lockout."
- **`DefaultBodyLimit` sits above the service-layer check.** The ordering is
  that the transport limit only needs to be "comfortably above" the service
  layer's actual check (`MAX_ATTACHMENT_BYTES`, etc.) (the doc of `rest/mod.rs`
  and various places in the router).
- **Apply the security-headers middleware at the outermost layer (LAST).** By
  attaching it after merging `/api/*` and the static fallback, the structure
  ensures headers do not leak even if a new route forgets to opt in
  (`security_headers.rs`).
- **Do not put secrets in audit detail.** Never put password / hash / bearer
  token into `detail`. There is no runtime guard; **upheld by review**. The
  key/value store records only the key and does not include the value
  (`settings_set`).
- **Raw key/value reads of settings are admin-symmetric.** `settings_get` is
  admin-gated symmetrically with `settings_set` (being able to read an arbitrary
  key is of equal privilege to being able to write it). Only UI settings are
  split into a separate command `ui_settings_get` (viewer-allowed, limited to
  their own namespace). "Do not create an asymmetry of privilege within the same
  store." **[machine-checked: `settings_get`/`settings_set` share the same Admin
  gate (rule 9)]**
- **SQL columns only through the whitelist.** Field names originating from the
  frontend must always be resolved to SQL columns via `ColumnMap`
  (`list_query.rs`), and values must always be bound (never string-interpolated).
  Sort on an unknown field is ignored; filter is a hard error. Services that
  accept `ListParams` (currently items / audit) have a `column_map()` (services
  with a fixed ORDER BY only do not need one).
- **Keep the two CSP definitions in sync.** Desktop uses `app.security.csp` in
  `tauri.conf.json`; LAN uses `CONTENT_SECURITY_POLICY` in `banto-server`'s
  `security_headers.rs`. **The only intended delta is connect-src** (Tauri
  IPC); everything else must match directive-by-directive (the rationale, and
  why `unsafe-inline` is required, live in the doc comment at the top of
  `security_headers.rs`). Editing is manual, but **drift in any directive other
  than connect-src is caught in CI by `verify-architecture.mjs` rule 12**
  ([ADR-0008](adr/0008-machine-check-stop-gate.md); there is no cross-check test
  and src-tauri does not compile, so it guards against one side silently
  loosening) — whenever you change one, update both.

## 7. `{@html}` only with self-generated, fully escaped output [machine-checked: allowlist of use sites]

Keep the use of `{@html}` to a minimum, limited to **safe strings that are
self-generated and fully escaped**. The current two sites:

- `report/src/ReportView.svelte`: only the output of the own engine
  `renderHtml`. `html.ts` escapes all text/attributes without exception and
  also blocks `javascript:` src ("no 'trusted' string anywhere in this
  module").
- `settings/+page.svelte`: the SVG generated by the `qrcode` crate (the LAN
  connection QR).

Do not feed externally-sourced, unescaped strings into `{@html}`.

## 8. Pitfalls of Svelte 5 runes

Traps that are easy to fall into in `@banto/*` components.
`AttachmentsPanel.svelte` is a live example:

- **`$effect` tracks only the intended dependencies; wrap side effects in
  `untrack`.** If state that you read and write inside an effect becomes a
  tracking target, you get `effect_update_depth_exceeded` (an infinite loop).
  Wrap the synchronous prefix of reload logic in `untrack()`.
- **The owner revokes the object URL.** A URL created via `createObjectURL` must
  always be revoked in the `finally` of reload / teardown / download
  (`attachmentsAdmin.ts`: "Callers own the returned URL's lifetime").
- **Invalidate async races with a loadToken.** Detect a superseded request with
  `++loadToken`, discard the result, and revoke the already-obtained URL.

## 9. Theme tokens only; raw values consolidated in the theme [machine-checked: color values in packages only]

UI CSS uses only `var(--banto-*)` tokens and **does not write raw values of
color or dimension into components**. Raw values are consolidated in
`packages/theme/src/css/banto.css`. The glass preset is applied opt-in, as in
`backdrop-filter: var(--banto-backdrop, none)` (visual-refresh-design.md).
Scope note: the machine check (rule 5, raw-colors) walks `packages/` only. Raw
values in the app layer (`apps/admin-template/src`) are tolerated **only as
deliberate exceptions with a justification comment** (existing examples: the
login brand pane, the static theme-preview swatches; never write a raw value
without a reason comment).

## 10. 3-way provider branching + demo explicitly refuses

Environment branching is decided by `getBantoMode()` across the three kinds
`tauri` / `server` / `demo`, and is **confined to the provider layer
(`*Admin.ts` / setup)**. UI components hold no environment branching. Demo mode
does not create an InMemory implementation but refuses with `DEMO_MODE_MESSAGE`
(do not let a standalone browser use backend features). Mode restrictions on
some operations (download/upload are server-only, folder is tauri-only, etc.)
are also expressed in the provider layer.

## 11. The migration style

- Sequentially-numbered file names (`0001_items.sql` … `0006_attachments.sql`)
  are embedded and run by `sqlx::migrate!`. Since V2 "full PostgreSQL support
  for the app," they branch into two lines per dialect:
  `apps/admin-template/core/migrations-sqlite/` (the existing DDL kept
  byte-equivalent for backward compatibility) and `.../migrations-postgres/`
  (the strict-type Postgres version of the same schema: `BIGINT GENERATED BY
  DEFAULT AS IDENTITY` / `BOOLEAN` / TEXT time columns default to `now()::text`,
  etc.). `db::run_migrations` dispatches based on the connection's backend.
  **Filename/sequence parity between the two dialects is caught in CI by
  `verify-architecture.mjs` rule 11** ([ADR-0008](adr/0008-machine-check-stop-gate.md);
  Postgres CI is smoke-only and each `sqlx::migrate!` embeds its dir
  independently, so adding to one dialect only would go silently missing; type
  differences within a same-named pair stay review-guaranteed per the intended
  divergence above).
- **The app owns the table definitions.** `banto-attachments` has no migrations
  of its own and keeps its in-test `CREATE TABLE` in sync with
  `0006_attachments.sql` ("MUST be kept in sync").
- Restore validation (`REQUIRED_TABLES`) checks **only table existence** for the
  Banto-owned `settings`, `users`, and `audit_log` tables, not columns (a coarse
  but cheap "is this a Banto DB" judgment). Domain tables such as `items`, which
  derived apps replace or remove, are deliberately not required.
- Every connection opened for validation is `conn.close()`d on all paths (a
  countermeasure against lingering file locks on Windows).

## 12. Doc comments reference spec sections

The top of a module and individual design decisions cite spec sections,
maintaining the culture of tying the "why" of a design to the spec. New modules
also cite the relevant spec section at the top (measure the number of
referencing files with `rg -l 'spec §|spec M'`; as of 2026-08 roughly 40 Rust /
159 TS+Svelte files).

**Reference grammar** (prefix → target). Before consolidating, moving, or
renaming a document, count inbound references with `rg` in **both the path
form (`docs/xxx.md`) and the label/section form (`spec §N` etc.)** — measuring
only one form has produced real misjudgements (maintenance-review-2026-08 §2.1):

| Notation | Target |
| --- | --- |
| `spec §N` | §N of `ui-framework-spec.md` (**this notation is reserved for ui-framework-spec**) |
| `roadmap MN` / `spec MN` | the MN section of `roadmap.md` (M10+ live in roadmap; spec §15 only holds the initial draft M0–M9; prefer `roadmap MN` for new code) |
| `<plan> §N` | §N of `docs/<plan>.md` (e.g. `attachments-plan §3.7`) |
| `conventions §N` | §N of this document (section numbers are immutable) |
| `M-review YYYY-MM §N` | §N of `feature-review-YYYY-MM.md` |
| `CR-N` / `AD-N` | `maintainability-review-2026-07.md` (§4 and the §7 addendum) |
| `ADR-000N` | `adr/000N-*.md` |
| `Discussion #N` | GitHub Discussion (**provenance notes only** — allowed in an ADR's "Related" line and review-document context notes; never as a normative reference in code or docs body. Body text must stand alone without reading the Discussion. [ADR-0010](adr/0010-discussions-predecision-layer.en.md)) |

## 13. UI text is held through keys (Paraglide) [machine-checked: raw Japanese literals in the app layer] {#i18n-messages}

The **text version** of §9 (raw color/dimension values consolidated in the
theme). Text shown in the UI is placed under keys in `messages/{en,ja}.json`,
and components reference it **through Paraglide** (`import * as m from
'$lib/paraglide/messages'` → `m['key']()`). Do not hardcode raw text (Japanese
literals, etc.) into components ([ADR-0005](adr/0005-i18n-paraglide.en.md)).

- **The scope is the app layer only** (`apps/admin-template/src`). `@banto/*`
  packages hold neither dictionaries nor i18n dependencies nor `$lib` imports
  (§5); they receive text as resolved strings injected **via the layer-①
  `messages` props** (the layer-① injection method,
  [ADR-0005](adr/0005-i18n-paraglide.en.md)). Do not place `messages/*.json`
  in packages.
- The base/source locale is English (the source of truth for messages), and the
  default **display** locale is Japanese (via the custom-banto strategy in
  `locale.ts`, for zero visual regression, ADR-0005).
- Locale resolution and persistence are confined to the provider/settings layer
  (`locale.ts`) (§10). UI components hold no locale branching.
- The brand name "Banto" is not translated. Locale display names (日本語 /
  English) are held in each language's native name and not translated (a key
  with the same value in both locales).

Current guarantee: that the `.svelte` files under `apps/admin-template/src`
(excluding the generated `paraglide/` and the dictionaries `messages/*.json`)
have no Japanese literals outside comments is checked by grep in
`verify:architecture` (rule `raw-jp-in-app`) (the same shape as the raw-color
check in §9). Legitimate exceptions are added to the script's allowlist with a
reason.

## 14. Exclude source-shipped `.svelte.ts` packages from the dev optimizer [machine-checked]

`@banto/*` ship source (`exports` point at `./src/index.ts`, raw `.svelte.ts`
published as-is;
[publishing.md](publishing.md) / [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.en.md)).
In a derived app they become real node_modules packages, and Vite's dev
dependency optimizer hands `.svelte.ts` to `svelte.compileModule` without
preprocessing, so TS-only syntax like `import type` throws 500 (issue #150).

Invariant: **every `@banto/*` package that source-ships a `.svelte.ts` under
`src/` and is a dependency of `apps/admin-template` MUST be listed in
`apps/admin-template/vite.config.ts`'s `optimizeDeps.exclude`** (kept in sync on
new additions). Packages with only `.svelte` components
(charts/attachments/report) go through the preprocessing path and are exempt.
`verify:architecture` (rule `optimizedeps-svelte-source`) machine-checks that
the exclude list matches "the `@banto/*` deps of admin-template that carry a
`.svelte.ts`".

---

## Process (already covered in other documents)

- **Execution process** (orchestrator design → task splitting → model
  delegation → verification → PR + CI gate):
  [roadmap.md §7](roadmap.md#7-実施プロセス).
- **Feature-addition checklist** (four-condition judgment / documenting removal
  procedure / no reverse dependency / two-path symmetry / test both admin's 403
  and UI hiding):
  [template-scope.md §6](template-scope.md#6-今後の運用ルールと宿題).
- **Form in which extensions are provided** (package + deletable demo + recipe;
  do not build a runtime plugin mechanism):
  [template-scope.md §3.1](template-scope.md#31-今後の機能拡張の提供形態2026-07-15-決定).
- **Distribution** (consumed via git tag / `path:` dependency):
  [publishing.md](publishing.md).
