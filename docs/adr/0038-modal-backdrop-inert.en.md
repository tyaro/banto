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
modal drawer of `ThreePaneLayout`). The topmost tracked layer decides the backdrop: on the way from `<body>` down to that
layer, every element beside the path gets `inert`. A lower layer is part of the backdrop until the upper one closes. The
order in which layers close does not matter (the backdrop is rebuilt on every change).

**Which tracked layer is above which** is decided in this order:

1. Nested inside another layer = above it.
2. Different z-indexes: the higher number is above, whoever opened last (a command palette at 1000 stays above a `Modal`
   at 900 opened after it - what is drawn on top is on top).
3. Equal z-indexes: **the one registered (opened) last is above**, not the later one in the document. A dialog of the
   layout (a "your session ran out" confirmation) can sit before a page's `Drawer` in the DOM; by document order it would
   stay `inert` as the Drawer's backdrop although it opened last.

A registration is one "open". A layer that closes and opens again registers anew, so it becomes the top among its equals
(also when it was the lower one: "what opened just now is on top", consistently). The order of the layers that remain
does not change when another one closes.

The "above" test of Esc and of the focus pull-back (`hasVisibleLayerAbove` and friends) follows the same rule: at equal
z-indexes, when both are tracked layers (or inside one) the registration order decides; **when either is untracked, the
document order as before**. Esc so closes the upper layer only and never disagrees with the `inert` of the backdrop.

CSS paints equal z-indexes in document order, so the rule alone would leave the upper layer drawn under the lower one's
scrim. `OverlayPanel` (`Modal`, `Drawer`, `ConfirmDialog` - all at `--banto-z-modal`) therefore raises its own z-index
after registering, by one more than the layers already open at the same z-index (`--overlay-lift`; a single open layer
gets 0 = the theme's number). An app that tracks its own layer at the same z-index as a @banto/ui layer decides its
paint order itself (a different z-index is the simple way).

**The lift is for the paint only; it takes no part in deciding who is above.** Two tracked layers (rules 2 and 3) are
compared by their z-index without the lift (the theme's number). Compared as raised, three sibling layers opened in a
row go wrong: the second is at 901, the third registers at 900, rule 2 puts the second one above, and the third becomes
`inert` and has its first focus refused. Without the lift all three are 900, rule 3 (the registration order) alone
decides, and the answer matches the paint (900 / 901 / 902). What is taken off is the measured change of the z-index
around the lift (0 when nothing could be written). **Against an untracked layer the comparison is as painted** (the
raised z-index, then the document order): a layer with no registration order must not be judged "above" while it is
drawn below. `OverlayPanel` does it in this order, synchronously: register, raise, bring the backdrop in line (an
untracked layer that the lift put below joins it), then the first focus.

Adding and removing `inert` per layer (reference counts) was rejected: computing "the set that must be inert now" and
writing only the difference to what we set keeps one state under out-of-order closes and DOM changes.

### 2. Only the `inert` we set is removed

- An element that was already `inert` is not touched.
- If the app writes `inert` on the same element while a layer is open (the sidebar turns off-canvas under an open Modal),
  the element is handed over to the app (not removed on close). If the app removes it, it is put back and removed on
  close. The writes are seen through `MutationObserver` records.

### 3. What stays out of the backdrop

- **`data-modal-exempt`** (`MODAL_EXEMPT_ATTR`): what is drawn above every modal and is used while one is open.
  The keys of `@banto/touch-keys-svelte` (typing into a field inside a modal; kept apart so they do not take focus
  from the field). `ToastHost` does not have it: `attachFocusTrap()` returns Tab to the modal, so a toast button
  would be reachable by pointer only. Toasts are treated as the live regions below: the text is announced, the
  buttons are `inert` while a modal is open.
- **Live regions** (`aria-live` other than off, `role="status" | "alert" | "log"`, `<output>`): `inert` also silences
  announcements, so a live region and its ancestors are not made inert. Instead **the controls inside it (buttons, links
  ...) are made `inert` one by one**. The notice is read; the button behind the modal cannot be pressed. Not putting
  controls inside live regions is the real fix (done alongside #1055); this guards what is left.
- **Untracked layers that are above** (an app's own dialog, an open off-canvas sidebar; by the existing "above" rules =
  z-index, then document order - an untracked layer has no registration order):
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
- While two or more `Modal` / `Drawer` are stacked, the later one's z-index is `--banto-z-modal` plus one per layer. An
  untracked layer at that same value (an open off-canvas sidebar = `--banto-z-sidebar`) is then below it wherever it is in
  the document, and part of the backdrop. A tracked layer placed just above `--banto-z-modal` (+1, +2 ...) is above by
  the rules (its own number is higher) and yet can meet the painted number of a stacked `Modal` / `Drawer`. Put other
  layers well apart (the command palette is at 1000).
- Making a control inside a live region `inert` puts it back into the accessibility tree on close; an `aria-atomic`
  region may be read again.
- For a layer inside a shadow DOM, only what is outside the shadow root becomes the backdrop.
