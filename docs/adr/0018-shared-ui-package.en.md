# ADR-0018: Move general-purpose UI components into a new `@banto/ui` package in stages, and have callers inject text, icons, state and actions

> 日本語: [0018-shared-ui-package.md](0018-shared-ui-package.md)

- Status: Proposed
- Date: 2026-10-07
- Related: Issue #220 / [conventions.md](../conventions.en.md) §4, §5, §9, §13, §14 /
  [ADR-0002](0002-minimal-dependencies.en.md), [ADR-0005](0005-i18n-paraglide.en.md),
  [ADR-0007](0007-derived-app-dev-optimizer-exclude.en.md), [ADR-0008](0008-machine-check-stop-gate.en.md),
  [ADR-0011](0011-git-tag-distribution.en.md) / [template-scope.md](../template-scope.md) §2.1, §3.1 /
  banto-industrial #381 (the Esc layering contract), T19 S2-c2 (the undo button on toasts)

## Context

General-purpose components such as `PageHeader` and `SurfaceCard` live in
`apps/admin-template/src/lib/components/`, and derived apps copy them. Copies do not receive
later improvements or fixes. In practice the two banto-industrial apps (banto-hub and
chronogazer) copied `CommandPalette` and `ToastHost` at different times, and there are now three
variants (see the inventory below). Issue #220 proposed keeping the monorepo and sharing common
UI as a package under `packages/`. The owner's plan (2026-10-07) has four phases:

- Phase 0 (this ADR): inventory and design. No code moves.
- Phase 1: move the seven components in `components/ui/` (EmptyState, ErrorState, IconButton,
  LoadingState, PageHeader, StatusBadge, SurfaceCard) into the new package and make
  admin-template its consumer.
- Phase 2: the menu components (`components/menu/`), CommandPalette and ToastHost, reconciled
  with the banto-industrial copies (banto-hub's CommandPalette, ToastHost, Modal, Drawer and the
  focusTrap, escLayering and focusRestore helpers; chronogazer's CommandPalette and ToastHost).
- Phase 3: banto-industrial switches to the new package.

### Inventory (the seven phase-1 components, v5.1.0 + main 03c69d1)

| Component      | Lines | Non-app imports                  | Props / snippets                                  | Consumer files   |
| -------------- | ----- | -------------------------------- | ------------------------------------------------- | ---------------- |
| `EmptyState`   | 64    | `@lucide/svelte` (Inbox)         | `icon?` `title` `description?` `action?`(snippet) | 3                |
| `ErrorState`   | 66    | `@lucide/svelte` (OctagonAlert)  | `icon?` `title` `description?` `action?`(snippet) | 1                |
| `IconButton`   | 61    | none                             | `label` `icon` `size?` `onclick`                  | 2 (4 call sites) |
| `LoadingState` | 91    | **`#lib/paraglide/messages.js`** | `label?` `lines?`                                 | 6                |
| `PageHeader`   | 68    | none                             | `title` `description?` `actions?`(snippet)        | 8                |
| `StatusBadge`  | 87    | `@lucide/svelte` (5 icons)       | `variant` `label` `icon?`                         | 4                |
| `SurfaceCard`  | 83    | none                             | `title?` `description?` `children` `footer?`      | 9                |

- **The only app-specific import is Paraglide in `LoadingState`** (the default announced text,
  `common.loading`). None of the components imports `$app/*`, stores, Tauri or `@banto/*`. Only
  one call site (`users/+page.svelte`) relies on `LoadingState`'s default text; the other five
  pass `label`.
- **Three components, seven icons depend on lucide** (Inbox, OctagonAlert, Circle, CircleCheck,
  TriangleAlert, CircleAlert, Info). All of them are defaults that `icon` can replace. Neither
  banto-industrial app depends on `@lucide/svelte`.
- **Keyboard and assistive technology**: `IconButton` is a `<button>` that puts `label` into both
  `aria-label` and `title`, with `--banto-focus-ring` on `:focus-visible`. `LoadingState` is
  `role="status"` + `aria-live="polite"` with visually hidden text, and stops the pulse under
  `prefers-reduced-motion`. `ErrorState` is `role="alert"`. `StatusBadge` never relies on colour
  alone and always renders an icon (`aria-hidden`). `PageHeader` renders `<h1>` with
  `view-transition-name: page-header`; `EmptyState`, `ErrorState` and `SurfaceCard` render a
  fixed `<h2>`.
- **Tokens used** (all already in `@banto/theme`): `--banto-text`, `-text-muted`, `-danger`,
  `-primary`, `-primary-hover`, `-surface`, `-surface-subtle`, `-surface-hover`, `-border`,
  `-radius-sm/md/lg`, `-shadow-sm`, `-control-height(-sm)`, `-focus-ring`, `-duration-fast`,
  `-ease-out`, `-backdrop`, `-{success,warning,danger}-tint(-text)`. There are no raw colour values
  (`StatusBadge`'s `info` builds its tint from tokens with `color-mix()`).
- banto-industrial uses none of these seven (banto-hub's settings page notes that "the
  template's `PageHeader` is not there" and has no heading of its own). The phase-1 gain is a
  smaller copy surface in admin-template and new components that derived apps can start using.

### Inventory (phase-2 candidates, three variants)

| Component                            | admin-template | banto-hub   | chronogazer | Consumers (template / hub / cg) |
| ------------------------------------ | -------------- | ----------- | ----------- | ------------------------------- |
| `menu/` (Menu + 3 parts + context)   | 437 lines      | -           | -           | Header only / - / -             |
| `CommandPalette`                     | 335 lines      | 325 lines   | 278 lines   | 1 / 1 / 1                       |
| `ToastHost`                          | 132 lines      | 104 lines   | 77 lines    | 1 / 1 / 1                       |
| `Modal` / `Drawer`                   | -              | 307 / 307   | -           | - / 4 files / -                 |
| focusTrap, focusRestore, escLayering | -              | 98, 48, 190 | -           | - / 10 files / -                |

**Menu components**: import nothing but `svelte` (the code already says it avoids app-specific
imports so it can be promoted to a shared package). `popover="auto"` (top layer; the browser
handles outside clicks and Esc) + `role="menu"`, roving focus (Up/Down, Home, End; Tab closes),
flips above the trigger when there is no room below, closes on scroll, and returns focus to the
trigger on close (without stealing it if focus has already moved elsewhere). `MenuItem` supports
`aria-disabled` and `danger`. It can move as is.

**How the three CommandPalette variants differ** (shared: overlay + `role="dialog"` +
combobox/listbox, group headings, Up/Down and Enter, closes on an outside pointerdown, disabled
while a command runs, failures go through admin-core's `notify`):

- Only admin-template has: four Paraglide strings, **closing itself when the session changes**
  (#258, `currentSessionScope`/`isCurrentSessionScope`), recent commands recorded per session
  (`#lib/recentCommands`), the post-visual-refresh tokens (`--banto-surface-overlay`,
  `--banto-radius-lg`, `--banto-shadow-lg`) and entry motion (`@starting-style`), and a
  `--banto-surface-hover` selected row.
- Only banto-hub has: a **focus trap** (`attachFocusTrap`), **returning focus to where it was
  opened from** (checked after `tick()`, falling back to `header button`), and **Esc handled on
  window** (closes even when focus is outside the palette). Its text is hard-coded Japanese,
  recent commands are not split per session, the selected row is a primary tint
  (`--banto-accent-gradient` under glass), and the shadow and overlay use raw `rgba()`.
- chronogazer: admin-template's pre-#258, pre-visual-refresh shape with hard-coded Japanese. No
  focus trap, no focus return, no window-level Esc.
- All three import `@banto/admin-core` (`searchCommands`, `PaletteCommand`, `notify`,
  `isProviderError`) and the app's `#lib/commands` and `#lib/commandPalette.svelte`. All three use
  `rgba(0, 0, 0, 0.35)` for the overlay background.

**How the three ToastHost variants differ**: admin-template has tinted backgrounds per kind
(including warning), slide-in motion, glass, `:focus-visible` on the close button and a Paraglide
"close" label. banto-hub has an **optional action button** (undo; its store's `push` accepts
`{ action, durationMs }` and returns the `id`), hard-coded Japanese and the older style (left
stripe only, raw `rgba()` shadow, no warning colours). chronogazer is banto-hub without the
action. All three import the app's `#lib/toast.svelte`, and the store shape (`toasts`, `push`,
`dismiss`) is the same.

**Modal / Drawer (banto-hub only)**: nearly identical logic with different looks (centred,
fade + scale, 560px default / right side, fade + fly, 480px default). Props: `open`, `title`,
`width`, `closeOnOverlayClick`, `onclose`, `onRequestClose` (return `false` to stay open),
`dirty` (Esc and overlay do not close; × still does), `onBlockedClose`, `focusFallback`,
`children`. Esc, overlay and × all go through one `requestClose`, which does not close twice
(`closing` and `data-layer-inactive`); focus before opening is captured in `$effect.pre` and
restored after `tick()`; a focus trap; Esc yields when a layer is in front
(`hasVisibleLayerAbove`). z-index 900, raw `rgba()` shadow and overlay, and the ×'s `aria-label`
is hard-coded Japanese. `escLayering.ts` holds the seven-point layering contract and the
z-index table, reading z-index from computed CSS. admin-template's only modal layer is
CommandPalette.

### Existing rules that constrain the design

- conventions §4 (rules `empty-deps`, `no-cross-package`): packages have empty `dependencies`/
  `peerDependencies` and no cross-package imports. Not even `svelte` is declared (resolution is
  left to the consumer). Today the only bare specifiers imported from `packages/*/src` are
  `svelte` and `svelte/*`.
- conventions §5 (rule `no-app-import`): no `#lib`/`$lib` imports; transports are injected.
- conventions §9 (rule `raw-colors`): no raw colour values in package `<style>` blocks.
- conventions §13 / ADR-0005: packages have no Paraglide and no dictionaries; text comes in via
  layer-1 injection (defaults stay the current Japanese, as with `defaultGridMessages`).
- conventions §14 / ADR-0007: a package with `.svelte.ts` must be in `optimizeDeps.exclude` and
  the external-consumer fixture (rules `optimizedeps-svelte-source`,
  `external-consumer-fixture`). Packages with only `.svelte` and `.ts` are out of scope.
- The sync tripwire in `scripts/scaffold.test.mjs`: a new package must be registered as core,
  asset or excluded, or CI fails. `scripts/check-versions.mjs` picks up `packages/*` by itself.

## Decision

**Create one new package, `packages/ui` (`@banto/ui`), and move components into it in phases 1
to 3. Components receive text, icons, state and actions through props, snippets and callbacks,
and import no app code, stores, `$app/*`, Tauri, other `@banto/*` packages or third-party
packages.** Each phase is below (written with the recommended options from
[Owner decision points](#owner-decision-points); they are settled on acceptance).

### 1. Package shape (phase 1)

- `packages/ui/`: `package.json` (same shape as the other packages: same `version`,
  `files: ["src"]`, `exports` = `{ ".": { "svelte": "./src/index.ts", "default": "./src/index.ts" } }`,
  empty `dependencies`/`peerDependencies`, the same devDependencies as forms), `tsconfig.json`,
  `svelte.config.js`, `vite.config.ts` (`svelte()` + `svelteTesting()`), `README.md`, `src/`,
  `tests/`.
- `src/index.ts` exports the seven components, the types (`StatusBadgeVariant`,
  `UiIconComponent`, `UiMessages`) and `defaultUiMessages` by name. No subpath exports.
- **No `types` condition**: as in the other packages, `svelte`/`default` point at the TS source,
  and consumers' `svelte-check` (including the external-consumer fixture) already resolves types
  that way. Adding a `types` condition should be a separate change across all packages.
- The phase-1 components are `.svelte` and `.ts` only, with no `.svelte.ts`. So the package is
  **not** listed in `optimizeDeps.exclude` (rule `optimizedeps-svelte-source` would flag it as
  extra). When phase 2 adds a `.svelte.ts` (for example a toast store), that PR lists it in the
  exclude and the fixture (the rules catch omissions).

### 2. Phase-1 public API

The current props become the public API (admin-template's call sites only change their import
lines). Only two things are added:

- **Icons**: `icon` is typed as `UiIconComponent` (a `Component` that accepts `size?: number`
  and `aria-hidden`). lucide components can be passed as they are. The default icons are the
  SVGs of the seven lucide icons, **vendored** under `src/icons/` (keeping the ISC notice in the
  files), so the look does not change. The vendored icons are not exported (this is not an icon
  set).
- **Text**: `LoadingState`'s `label` defaults to the package's `defaultUiMessages.loading()`
  (`'読み込み中…'`). admin-template passes `label={m['common.loading']()}` at the one call site
  that relied on the default (so English display does not show Japanese). When phase 2 adds more
  text, components take `messages?: UiMessages`, as grid does.

Adding `disabled` and the like to `IconButton` is not part of phase 1 (the public API is fixed in
its current shape; extensions come in a later minor).

### 3. CSS and theme

Each component keeps its CSS in a scoped Svelte `<style>` using only `--banto-*` tokens. No
separate CSS file is shipped. Consumers load `@banto/theme/css` as they do today (without it the
tokens do not resolve); the README says so. Glass works through `--banto-backdrop` as before.

### 4. Dependency direction, core and options

`@banto/ui` is **core** (the shell's Header and Sidebar use it): add a row to template-scope
§2.1 and add it to `CORE` in `scripts/scaffold.test.mjs`. It imports no other `@banto/*`, so a
core → option dependency cannot arise.

### 5. Machine checks, distribution, scaffold and external use

- The existing rules (`no-cross-package`, `no-app-import`, `raw-colors`, `empty-deps`,
  `docs-package-refs`) walk `packages/`, so they apply to the new package unchanged.
- **Add one rule** (it meets ADR-0008's three conditions; record it in that ledger): bare import
  specifiers in `packages/*/src` are limited to `svelte` and `svelte/*`. Because dependencies
  cannot be declared (`empty-deps`), importing `@lucide/svelte` or similar works in the monorepo
  (admin-template's dependency is visible through hoisting) and breaks only in derived apps that
  lack it (banto-industrial has no lucide). No allowlist is needed (zero violations today). The
  idea of adding `$app/` and `@tauri-apps/` to `no-app-import` is covered by the same rule.
- `check-versions.mjs` needs no change (it picks up `packages/*`). Update publishing.md's install
  examples and package list, and the list of "packages with `.svelte.ts`" in conventions §14
  (stating that phase 1 is out of scope).
- External-consumer fixture: not required by the rule (no `.svelte.ts`), but add `@banto/ui` to
  its dependencies and to the `+page.svelte` imports (not to the exclude) to confirm that the Git
  dependency with `path:packages/ui` installs and passes `svelte-check` and `vite build`. The
  fixture's ref points at the current tag, so this goes into the ref-bump PR after a tag that
  contains `@banto/ui` (the "bump the fixture ref after tagging" step in publishing.md).
- Because this ADR names `@banto/ui`, it goes into `DOCS_PACKAGE_REF_ALLOWLIST` in
  `verify-architecture.mjs` with a reason until phase 1. Remove it once the package exists.

### 6. Tests and visual checks

- `packages/ui/tests/` gets a jsdom test per component (`@testing-library/svelte`): `IconButton`'s
  `aria-label`/`title`, `StatusBadge` rendering an icon for every variant, `LoadingState`'s
  `role="status"` with default and given text, `ErrorState`'s `role="alert"`, snippet rendering.
- DOM and CSS do not change, so `e2e/visual` (visual regression) and a11y (axe) results are
  expected to stay the same. Svelte's scoping class hashes change, but the pixels do not. The
  phase-1 PR confirms that visual regression passes; if a difference shows up, fix the cause
  instead of updating baselines.
- No new showcase page (adding nav moves every baseline, template-scope §3.1). admin-template's
  existing pages already use all seven components; the package README documents the props with
  minimal examples.

### 7. Versioning and compatibility

Phase 1 is **additive only** (a new package and changed import lines in admin-template) and does
not change any existing `@banto/*` public API: a SemVer minor. `[Unreleased]` already holds
v6.0.0's breaking change (#344), so merging before the v6.0.0 tag ships it in v6.0.0; after the
tag, in v6.1.0. Version and tag are shared with the other packages (publishing.md). Copies of
`components/ui/` that derived apps took from admin-template keep working (migration is optional;
upgrading.md gets the steps).

### 8. Phase-2 reconciliation (proposal)

- **Menu components**: move as is. Callers already pass `label`.
- **CommandPalette**: the package holds only the **presentation and interaction** component. It
  receives the command list, a search function, execution, a close request and text (`items`,
  `search(query) => items`, `onExecute(item)`, `onClose()`, `messages`) and does not import
  admin-core (its types match `PaletteCommand` structurally). Session scoping (#258), recording
  recent commands, the `Ctrl+K` wiring and failure notifications stay in the app. banto-hub's
  **focus trap, focus return and window-level Esc** become standard behaviour. The look follows
  admin-template's current one (tokens, motion, `--banto-surface-hover` selected row).
- **ToastHost**: the package holds a presentation component taking `toasts`, `ondismiss` and
  `messages`, with banto-hub's **action button** (`action?: { label, onClick }`) as standard. The
  look follows admin-template's current one. Whether the store (`push`, `dismiss`, auto-dismiss
  time) stays in the app (it is small) or ships as `createToastStore()` is a decision point
  (shipping it makes it `.svelte.ts`, which brings the exclude and fixture obligations).
- **Modal / Drawer and the layering helpers** (focusTrap, focusRestore, escLayering,
  drawerCloseGuard): admin-template has no page that uses them, so whether they go into phase 2
  or wait for phase 3 (driven by banto-industrial's need) is a decision point, together with
  template-scope's "cross-cutting" criterion. If they go in, banto-hub's contracts
  (`onRequestClose`, `dirty`/`onBlockedClose`, `focusFallback`, no double close, the layering
  contract) come over in full, with z-index and the overlay background as tokens.
- **Theme**: the overlay background (`rgba(0, 0, 0, 0.35)` in all three variants) trips rule
  `raw-colors`, so add a token to `@banto/theme` (for example `--banto-scrim`). Shadows move to
  the existing `--banto-shadow-lg`.

### 9. Phase 3

banto-industrial upgrades to a tag that contains `@banto/ui` (v6.0.0 also needs the #344
migration) and replaces CommandPalette and ToastHost (both apps) and, if phase 2 included them,
Modal, Drawer and the layering helpers (banto-hub). Whether banto-hub's `TreeContextMenu` moves to
`Menu` is decided separately in phase 3. The replacements are confirmed by banto-industrial's E2E
(accidental drawer close, Esc layering, and so on).

## Alternatives considered

- **Option A (adopted): one `@banto/ui`, filled in phases, with injection.** Pros: the existing
  distribution (Git tag + subdirectory), version check and machine checks work as they are; it
  starts small and grows with demand. Cons: one more package, and more sync points across
  scaffold, the fixture and docs.
- **Option B (rejected): put them in `@banto/admin-core`.** admin-core is headless (it has no
  `.svelte` components); mixing presentation components in breaks its responsibility.
- **Option C (rejected): several packages per group (status, menu, overlay).** Each package needs
  its own version, scaffold, fixture and docs sync, which does not pay off for small components.
  Split the overlay group later if it grows large.
- **Option D (rejected): make lucide a `peerDependencies` entry.** It is an exception to
  conventions §4's "empty dependencies" (needing an ADR) and forces derived apps without lucide
  (banto-industrial) to add it. Vendoring seven icons is a few dozen lines and, by ADR-0002's
  criteria, cheaper.
- **Option E (rejected): no default icons, `icon` required.** More code at each call site, and
  every call would have to recreate `StatusBadge`'s "not colour alone" default (an icon per
  variant).
- **Option F (rejected): keep copying and ask for sync through docs.** There are already three
  variants (see the inventory); the sync has not held.
- **Option G (out of scope): a separate repository, registry publishing, independent
  versioning.** Issue #220's re-evaluation conditions (owner, audience or release cycle becoming
  independent of the base) are not met. ADR-0011 stays.

## Consequences

- `@banto/ui` components import no app code, stores, `$app/*`, Tauri, other `@banto/*` packages
  or third-party packages (checked by a rule). Text is injected with defaults, icons are vendored
  defaults replaceable through `icon`, and colours and sizes come only from tokens.
- Changing a component's props is a change to a `@banto/*` public API and follows SemVer and the
  CHANGELOG's "notes for consumers" (publishing.md).
- Vendored lucide icons keep their source version and ISC notice in the files. They do not track
  lucide's visual updates (replace them if needed).
- Adding `.svelte.ts` in phase 2 brings the package under `optimizeDeps.exclude` and the
  external-consumer fixture (existing rules catch omissions).
- The phase-1 PR deletes admin-template's `components/ui/`. Copies in derived apps keep working,
  so migration is optional; upgrading.md gets the steps.

## Owner decision points

Before phase 1:

1. **Name and standing**: `packages/ui` / `@banto/ui` as core (scaffold leaves it alone)?
2. **Default icons**: (a) vendor the seven lucide icons (recommended; no visual change) / (b) no
   default (`icon` required) / (c) lucide as `peerDependencies` (a §4 exception, needing its own
   ADR).
3. **`LoadingState`'s default text**: (a) package default `'読み込み中…'` and admin-template passes
   it explicitly everywhere (recommended) / (b) make `label` required.
4. **Freeze the public API at the current props?** (`disabled` on `IconButton` and the like in a
   later minor.)
5. **Version**: land phase 1 before the v6.0.0 tag to ship it in v6.0.0, or make it v6.1.0?
6. **New machine check**: add the rule limiting packages' bare imports to `svelte` and `svelte/*`
   (+ `$app/`, `@tauri-apps/`)? (Recorded in ADR-0008's ledger.)
7. **Showcase**: no new demo page; are the existing pages plus the package README enough?

Before phase 2:

8. **CommandPalette**: keep only presentation and interaction in the package, leaving session
   scoping, recent-command recording, `Ctrl+K` and notifications in the app? Make banto-hub's
   focus trap, focus return and window-level Esc standard? Follow admin-template's selected-row
   look and drop banto-hub's primary tint and glass gradient (or make them an option)?
9. **ToastHost**: make banto-hub's action button standard? Ship the store (`.svelte.ts` → exclude
   and fixture obligations) or keep it in the app?
10. **Modal / Drawer and the layering helpers**: include them in phase 2 (admin-template has no
    page that uses them), or leave them to phase 3 as banto-industrial's need? If included, bring
    all of banto-hub's contracts as options, or drop some?
11. **Theme tokens**: make the overlay background (`--banto-scrim` or similar) and the z-index
    layers (1000 / 900 and so on) tokens?
12. **Menu**: keep relying on the `popover` API (including Tauri's WebView2 / WebKitGTK)? Move
    banto-hub's `TreeContextMenu` to `Menu` in phase 3?
