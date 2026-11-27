# ADR-0037: Pop-out panel windows live in a Tauri plugin crate, `banto-tauri-panel`

> 日本語: [0037-tauri-panel-plugin.md](0037-tauri-panel-plugin.md)

- Status: Accepted
- Date: 2026-11-26 (owner's decision: the new crate, the split of the pure half, where the TS side goes)
- Related: Issue #1006 (downstream: tyaro/banto-industrial#1281) / spec §5.3 /
  [conventions.md](../conventions.md) §1, §3, §4, §6, §10 / [template-scope.md](../template-scope.md) §3 /
  [ADR-0002](0002-minimal-dependencies.en.md), [ADR-0011](0011-git-tag-distribution.en.md)

## Context

`@banto/dock-svelte` has a hook for a pop-out button, `onPopOut`. What happens on the Tauri side after the press (open
the window, tell that it closed) existed only as **code to copy** in `apps/admin-template`
(`src/lib/banto/popout.ts` and `panel_open` in `src-tauri/src/lib.rs`).

A downstream app (the Hub of banto-industrial) wants to put a dock panel on a second monitor. The behaviour it needs
is not in the copy:

- Remember position and size per panel id and reopen there; fall back to the default when the place is off screen
  (a monitor was unplugged).
- Close the panel windows when the main window is closed.

Copying per app means rebuilding this in every app. It goes into banto in a reusable form.

Constraints:

- CI's headless job cannot build a crate that links tauri (no webkit2gtk; same as the `keyring` note in the root
  `Cargo.toml`).
- Distribution is by git tag (ADR-0011); downstream apps reference `crates/*` as Git dependencies.
- No added dependencies (conventions §3, ADR-0002).

## Decision

### 1. The Rust side is a new crate, `crates/banto-tauri-panel` (a Tauri v2 plugin)

An app adds `.plugin(banto_tauri_panel::init())` to its `tauri::Builder` and `banto-tauri-panel:allow-open` and
`banto-tauri-panel:allow-list` (added with #1013) to its capability. The plugin owns:

- The command `open` (`plugin:banto-tauri-panel|open`, arguments `id` and `title`). If the id's window is already
  open it is only brought to the front.
- The command `list` (`plugin:banto-tauri-panel|list`, no arguments; added with #1013): the ids of the panel windows
  open right now (built by the plugin and not yet seen destroyed).
- When a panel window is gone, `banto://panel-closed` (payload: the panel id) to the main window.
- Position and size remembered per id (default: `panel-windows.json` in the app's data dir). An off-screen place opens
  at the default position and size.
- When the main window is gone, the panel windows are closed too (the memory stays).
- Settings (`banto_tauri_panel::Builder`): the route shape (default `panel/{id}`), the main window's label (default
  `main`), the prefix of the panel windows' labels (default `panel-`), default and minimum size, **memory off**
  (`remember_geometry(false)`), **closing together off** (`close_with_main(false)`), where the memory is kept
  (`store_path`). The title is passed from the frontend on every open.
- The plugin tracks **only the windows it built itself (label -> id)** and limits focusing, the closed notice,
  the memory and closing with the main window to them. An app window that merely has a label with the prefix is left
  alone. The settings are checked by the pure `PanelConfig::validate`: an empty prefix, invalid characters, an empty
  main label, or a main label that starts with the prefix make `setup` return an `Err` and stop the app at start-up
  (no panic).

### 2. Everything with a rule in it is a pure module, separated by a feature

| Half                                                        | Contents                                                                                                                                                                              | How it is checked                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Pure (`config`, `geometry`, `store`; std and serde only)    | id validation, building labels and routes, the off-screen judgement, reading and writing the memory's JSON (a broken file reads as empty; a write replaces the file from a temp file) | Unit tests. The rust job of `ci.yml` runs `cargo test -p banto-tauri-panel --no-default-features`    |
| Tauri wiring (`plugin`; feature `tauri`, **on by default**) | Asks Tauri for windows, monitors and events and hands the values to the pure half                                                                                                     | Code review, `tauri-check.yml` (compile and clippy on ubuntu and windows), a check on a real desktop |

`tauri` is on by default so that an app only adds one dependency line. Only the places that build headless (the step
in `ci.yml` and the external-consumer fixture) write `--no-default-features` / `default-features = false`.

### 3. A panel id is ASCII letters, digits, `-` and `_` (at most 64 characters)

The id comes from the webview and becomes part of the window label, of the route the window loads, and a key of the
memory file. With only these characters it cannot change the route's shape (`../`, `?`, `#`) or break Tauri's label
rules (conventions §6: user input is not used as a path). The route shape itself is set in Rust and cannot be passed
from the frontend.

### 4. Geometry is kept in physical pixels; "on screen" means the top strip lies on some monitor

- A logical pixel only means something together with one monitor's scale factor. The window may return to another
  monitor, so physical pixels are kept (`outer_position`, `inner_size`, the monitors' `position` and `size`).
- A window counts as on screen when its top strip (32px high - where it is grabbed) lies inside one monitor
  vertically and at least 100px of it (or all of it, for a narrower window) horizontally. The overhang of Windows'
  invisible border (about -8) is tolerated up to 16px.
- Nothing is remembered while the window is minimised, maximised, fullscreen or hidden. A near-zero size or the
  minimised position (-32000) is neither remembered nor restored.
- At most 256 panels are remembered; a new id beyond that is not (the file does not grow without limit).

### 5. The TS side lives in `@banto/admin-core`

`openPanelWindow`, `listenPanelClosed`, `createPanelPopOut` (`packages/admin-core/src/panelWindow.ts`).

- `isTauri`, `invoke` and `listen` are **injected**. admin-core does not depend on `@tauri-apps/api` (same as
  `events.ts` and `providers/tauri.ts`).
- `createPanelPopOut` combines the `onPopOut` to hand to a dock and the subscription that puts the panel back when
  its window is gone (`connect()`). In a browser `onPopOut` is `undefined`. The contract with `@banto/dock-svelte` -
  **a browser does not pass `onPopOut` (no button is drawn)** - is unchanged.
- A panel is detached only once the `connect()` subscription is known to work, since the closed notice is the only
  way it comes back. A pop-out pressed while the registration is pending waits for it; if it failed, nothing is
  detached and `onError` gets the reason. If `connect()` is stopped while it waits or while `detach` runs, no window
  is opened (`restore` puts a detached panel back).
- **It remembers the ids of the panels that are out in a window** (#1013, #1014): from the moment `detach` took the
  panel out of the dock until `restore` puts it back. Where it is kept is injected (`storage: { load, save }`; the
  template uses a per-user localStorage entry). Each `connect()` reconciles the memory with the plugin's `list` and
  restores a remembered panel whose **window is not open** (if the main window is closed with a panel out, nobody
  hears the closed notice, and the dock's saved layout holds the panel as closed). A panel whose window is open (the
  main window was reloaded, the screen was left and entered again) stays remembered and comes back on its notice.
  - **If `list` fails nothing is restored and `onListError` gets the reason.** Restoring blindly was rejected: with a
    window still open, the same panel would be in the dock and in its window each time the screen is entered. Not
    restoring loses nothing: the panel stays "popped out" (`focus` opens its window, whose closing puts it back).
  - Putting the panels back on the main window's `CloseRequested` was rejected: it does not run on a kill or a
    crash, and the window may close before the (asynchronous) save of the restored dock is done. Reconciling at
    start-up works however the last run ended.
  - **The id of a panel put back into the dock stays in `storage` until the layout that has it again is known to be
    saved** (#1019). That save is made later, asynchronously, by another part (`@banto/dock-svelte`'s
    `createDockLayoutStore`), and it can fail. If the memory were dropped when the panel is put back, a failed save
    would lose the panel at the next start: the provider's old layout (the panel closed) wins and nothing remembers
    it. `restore`'s return value carries this: nothing = forgotten at once (as before; for a dock whose layout is not
    saved); a promise = kept until it resolves `true` (or nothing). On `false`, a rejection, or a run that ends
    first, the id stays and the next `createPanelPopOut` (the next start, the next visit of the screen) restores the
    panel again - that is the retry. `isPoppedOut` is `false` from before `restore` is called (a panel in the dock is
    not shown as "in a window"). Once the save is confirmed nothing is remembered, so a panel the user closes
    afterwards stays closed.
    - admin-core does not import `@banto/dock-svelte` (conventions §4), so the app joins them. The layout store's
      `commit` returns a promise of what became of the write (`'saved'`, `'unchanged'`, `'failed'`, `'dropped'`);
      the template's `createLayoutSaveWatch` (`popout.ts`) turns "a report made after `restore` was saved" into
      `restore`'s return value.
    - Rejected: (a) `restore` calling the store's `commit` itself and returning its promise - the restored layout
      is reported by `DockHost` (`onLayoutCommit`), not by `restore`, so it would be reported twice; (b) only an
      `onSaved` notice on the store - it cannot tell which report was saved, and the success of a write already on
      its way (a layout without the panel) would drop the memory; (c) retrying the write inside admin-core - it
      knows neither the layout nor where it is saved; (d) preferring the local copy over the provider at the next
      start - that changes the rule that the provider's copy is the one that counts, per user and across devices.
    - Accepted limits: if, after a failed save, the user closes the panel and that save fails too, the next start
      puts the panel back (nothing was saved, so the intent is unknown; restoring is the safer side). When `restore`
      does not change the layout (the read failed, the default is shown and has the panel) nothing is reported, so
      the id stays until something is saved.
  - It has `isPoppedOut(id)`, `subscribe(cb)` and `focus(content)`. A dock cannot tell a popped-out panel from a
    closed one, so a list of panels (the View menu) reads these to show it as on screen and, when it is selected,
    brings its window to the front (showing it in the dock would duplicate it). `focus` does nothing for a panel that
    is not popped out. Changes are told through a plain subscription (admin-core does not depend on Svelte).
- It does not import `@banto/dock-svelte` (conventions §4). `PanelWindowContent` (`id` and `title`) is the part of
  the dock's `PanelContent` this module reads.

### 6. Not subject to the REST / Tauri symmetry (conventions §1)

`open` and `list` write no data and are not audited. They are desktop-only operations on this PC's windows, with no REST
twin (the same class as the template's former `panel_open`). A plugin command is not a top-level command of `lib.rs`,
so rule 8 of `verify:architecture` does not scan it.

### 7. Dependencies (conventions §3)

- Runtime: `tauri` (the app already has it) and `serde` / `serde_json` (already in the workspace).
- Build time: **`tauri-plugin`** (feature `build`; it generates the plugin's permissions - the standard way a Tauri
  plugin is made). `Cargo.lock` gains one crate, `tauri-plugin`; its dependencies (`tauri-utils`, `anyhow`, `glob`,
  `plist`, `schemars`, `walkdir`, ...) are already there through `tauri-build`. It sits inside the feature `tauri`
  (optional), so it is not part of a headless build.
- The ready-made plugin that remembers window positions (`tauri-plugin-window-state`) is not used (option C below).

## Alternatives considered

- **Option A (chosen)**: a new crate (plugin) with the pure half separated by a feature.
  Pros: a downstream app uses it with one dependency line and `.plugin(...)`. The rules are tested in headless CI.
  Cons: one more crate. The behaviour of the Tauri wiring is not tested in CI (compile and clippy only).
- **Option B (rejected)**: grow the template's copy (add the memory and closing together to `panel_open`).
  Every downstream app copies and rebuilds it - the very starting point of the issue.
- **Option C (rejected)**: use `tauri-plugin-window-state`.
  Ready-made, but it works per window label on every window (the main one too); the rules "per id, panels only" and
  "off screen falls back to the default" would not be ours. The closed notice and closing with the main window are
  needed separately anyway. It also adds a dependency (ADR-0002). The part we need is about 200 lines, and its edge
  cases gather in the off-screen judgement, which is a pure, tested function.
- **Option D (rejected)**: put it into an existing crate (`banto-server`, ...).
  tauri would enter a layer that does not know tauri (conventions §2), and the headless job could no longer build
  that crate.
- **Option E (rejected)**: ship functions for the app's `invoke_handler` instead of a plugin.
  Registering the command, handling the events and `manage`-ing the state would be written per app, and a missed
  wire (what happens when the main window closes, ...) is likely. A plugin brings everything with one line. Needing
  one permission line is the plugin's drawback.
- **Where the TS side goes**: putting it into `@banto/dock-svelte` was rejected. The dock is a package that does not
  know Tauri, the injected `invoke` / `listen` shape already exists in admin-core, and a screen without a dock can
  open a window too.

## Consequences

- One more public crate (the sixth). Its version follows the workspace. The external-consumer fixture brings it in
  with `default-features = false` (rule `external-consumer-fixture`).
- A PR that changes the Tauri wiring (`src/plugin.rs`) is checked on a real desktop: open, bring to front, close and
  return to the dock, position and size come back, an unplugged monitor falls back to the default, closing the main
  window closes the panels, a panel that was out when the main window was closed is in the dock at the next start, a
  reload of the main window with a panel out does not duplicate it. CI only compiles and lints it.
- The plugin's name (`banto-tauri-panel`) must be the same in four places: `links` in `Cargo.toml`, `PLUGIN_NAME`,
  admin-core's `PANEL_OPEN_COMMAND`, and the app's capability. Change all of them in one PR (downstream capabilities
  change too).
- `permissions/` is generated by the build and committed (the convention of Tauri plugins; do not edit it by hand).
  A new command is added to `COMMANDS` in `build.rs`. **A new command means one more permission line in downstream
  capabilities** (`list` came after v9.3.0; in an app without the permission `list` fails, and the "restore nothing"
  side above applies).
- Changing the memory file's shape (`version` 1) means raising `version`. A file of another version reads as empty
  and is replaced on the next save (the memory is a convenience; losing it does no harm).
- An app that removes the dock removes the `src-tauri` dependency, `.plugin(...)` and the capability line by hand
  ([remove-optional-assets](../recipes/remove-optional-assets.md); `pnpm scaffold` does not rewrite `src-tauri`).
- What a panel window draws, and how another window holds its subscriptions and session, stays in the app.
