# ADR-0038: One place in `layering.ts` makes the outside of a modal layer `inert`

> 日本語: [0038-modal-backdrop-inert.md](0038-modal-backdrop-inert.md)

- Status: Accepted
- Date: 2026-11-28 (owner decision: one place manages the backdrop; the overlaid pane becomes a true modal; the pane gets a close button)
- Related: Issue #1055 (what #1045 / PR #1050 left out) / [ADR-0018](0018-shared-ui-package.en.md) §10 /
  `packages/ui/src/layering.ts` (layer promise 8)

## Context

The modal layers of `@banto/ui` (`Modal`, `Drawer`, `ConfirmDialog`, `CommandPalette`) say `aria-modal="true"` and trap
focus (layer promise 4). What is outside was blocked by a scrim that covers the screen.

The pane that `ThreePaneLayout` opens over the centre when the frame is narrow covers only the frame (`.three-pane`). What
is outside the frame (the app's header) can still be clicked. Adding only `aria-modal="true"` hides the header from
assistive technology while clicks still reach it (the two scopes disagree).

PR #1050 tried `inertOutside` (make the siblings outside `inert` when the pane opens) and dropped it. What the review left:

- It looks at the siblings once, on open, so an empty portal becomes `inert` and a layer opened in it later is dead.
- Leaving live regions (`role="status"` ...) out as a whole leaves the buttons inside them (the connection banner's
  "retry") pressable behind the modal.
- If each layer makes its own surroundings `inert`, layers that do not close in nested order remove each other's `inert`.

## Decision

### 1. `layering.ts` holds, per document, "the topmost modal layer"

A modal layer calls `trackModalLayer(layer)` while it is open (`Modal`, `Drawer`, `ConfirmDialog`, `CommandPalette`, the
modal drawer of `ThreePaneLayout`). The topmost tracked layer (nested inside another = above it; otherwise the existing
"above" rules = z-index, then document order) decides the backdrop: on the way from `<body>` down to that layer, every
element beside the path gets `inert`. A lower layer is part of the backdrop until the upper one closes. The order in which
layers close does not matter (the backdrop is rebuilt on every change).

Adding and removing `inert` per layer (reference counts) was rejected: computing "the set that must be inert now" and
writing only the difference to what we set keeps one state under out-of-order closes and DOM changes.

### 2. Only the `inert` we set is removed

- An element that was already `inert` is not touched.
- If the app writes `inert` on the same element while a layer is open (the sidebar turns off-canvas under an open Modal),
  the element is handed over to the app (not removed on close). If the app removes it, it is put back and removed on
  close. The writes are seen through `MutationObserver` records.

### 3. What stays out of the backdrop

- **`data-modal-exempt`** (`MODAL_EXEMPT_ATTR`): what is drawn above every modal and is used while one is open.
  `ToastHost` (`--banto-z-toast` is above the modals; the notice of a failed save inside a modal, and its close button)
  and the keys of `@banto/touch-keys-svelte` (typing into a field inside a modal).
- **Live regions** (`aria-live` other than off, `role="status" | "alert" | "log"`, `<output>`): `inert` also silences
  announcements, so a live region and its ancestors are not made inert. Instead **the controls inside it (buttons, links
  ...) are made `inert` one by one**. The notice is read; the button behind the modal cannot be pressed. Not putting
  controls inside live regions is the real fix (done alongside #1055); this guards what is left.
- **Untracked layers that are above** (an app's own dialog, an open off-canvas sidebar; by the existing "above" rules):
  Esc already yields to them, so they stay usable. One that appears later inside an element we made inert is found and
  let out. Such a layer does not make the rest inert, though: an app's own modal layer calls `trackModalLayer`.

### 4. While a layer is open, the backdrop follows the DOM

A `MutationObserver` (child changes under `<body>`, and `inert`, `role`, `aria-live`, `aria-modal`, `hidden`, `class`,
`style` ...) rebuilds it. A banner or a portal's content that appears later is covered too. Changes inside the top layer
only do not rebuild. Nothing is observed while no layer is open.

Deciding once on open was rejected: it cannot solve the first problem of PR #1050 (elements that appear later).

### 5. The overlaid pane of `ThreePaneLayout` becomes a true modal

While a modal drawer (the default) is open, the pane is `role="dialog"` + `aria-modal="true"` (named like the pane) and
`trackModalLayer` makes the outside (the frame's centre and band, and the app around the frame) `inert`. The scrim is a
sibling of the pane, so it is named through `backdrop` and kept (a click on it closes). A close button (×) sits at the
top of the pane (the same `IconButton` as `Drawer`, text `overlayClose`), so a pane with nothing focusable can be closed
without Esc. Non-modal drawers (`leftDrawerModal` / `rightDrawerModal` false) do not change.

## Consequences

- What `aria-modal` hides from assistive technology is what clicks and Tab cannot reach.
- The outside of `Modal`, `Drawer` and `CommandPalette` is `inert` too (until now: the scrim and the focus trap only).
  What could be pressed beside the scrim (elements with a z-index above it) no longer can. Mark what must stay usable
  with `data-modal-exempt`.
- `PickerDialog` (date picking; `aria-modal` inside a `popover`) is not tracked: a light layer next to its field that
  keeps closing on an outside press.
- The scrim still covers the frame only. What is outside the frame is not dimmed, but cannot be operated.
- "Above" compares z-index numbers, so a number inside another stacking context (the pane is `z-index: 2` inside its
  frame) can disagree with what is really drawn on top (the same limit as the existing Esc rules). An untracked layer
  judged "above" this way stays out of the backdrop.
- Making a control inside a live region `inert` puts it back into the accessibility tree on close; an `aria-atomic`
  region may be read again.
- For a layer inside a shadow DOM, only what is outside the shadow root becomes the backdrop.
