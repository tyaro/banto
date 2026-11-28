/**
 * Esc / focus layering for overlays - the one module behind CommandPalette,
 * Modal and Drawer, and public so an app's own layers (a retreating split
 * pane, a context menu, a page-level Esc handler) follow the same rules
 * (docs/adr/0018-shared-ui-package.md §10, phase 4). Phase 2b kept a minimal
 * package-internal copy (`overlayFocus.ts`) for the palette; phase 4 merged it
 * with banto-industrial banto-hub's `escLayering.ts` / `focusTrap.ts` /
 * `focusRestore.ts` / `drawerCloseGuard.ts`, so there is one mechanism, not two.
 *
 * ## The layer promises (banto-hub #378 / #381)
 *
 * Overlapping UI closes **one layer per Esc, topmost first**:
 *
 * 1. The layer that closes on Esc **consumes** the event (`preventDefault`);
 *    a handler that sees `event.defaultPrevented` yields. Not enough alone:
 *    window listeners cannot `stopPropagation` each other and run in
 *    registration order ("which opened first"), hence 2.
 * 2. A layer **yields Esc (and its focus pull-back) while a visible, active
 *    layer is above it** ({@link hasVisibleLayerAbove} with `except`). "Above"
 *    is a z comparison, not "any other layer" (a palette at 1000 over a
 *    drawer at 900 must not each think the other is on top). A handler that is
 *    not a layer itself (the page underneath) calls it without `except`: any
 *    visible layer wins. Non-modal layers carry no role, so they opt in with
 *    {@link LAYER_MARKER_ATTR} while open.
 * 3. Layers handle Esc **at window level**, so a layer still closes when
 *    focus was moved outside it by something else.
 * 4. A layer that says `aria-modal="true"` **traps focus**
 *    ({@link attachFocusTrap}): Tab wraps inside (panel `keydown`) and focus
 *    landing outside is pulled back (document `focusin`) - otherwise Tab
 *    reaches an opener behind the scrim and stacks a second layer.
 * 5. On close, **focus returns to the element focused when the layer opened**
 *    ({@link restoreFocus}) - only if it is still connected, not inert and
 *    visible; otherwise to the caller's fallback, else nowhere (never forced
 *    onto `<body>`, from where Tab bypasses every trap).
 * 6. A layer that is closing or retreated **says so in the DOM**: an outro
 *    keeps the panel laid out, so Modal / Drawer set
 *    {@link LAYER_INACTIVE_ATTR} the moment they decide to close; a retreated
 *    pane uses `visibility: hidden` + `inert`. Conversely an opening layer must
 *    be visible from its first frame (never transition `visibility` on open).
 * 7. Non-modal layers (sidebar, retreated tree) cannot trap, so whoever
 *    **opens a lower one closes the upper one first** (caller's job).
 * 8. A layer that says `aria-modal="true"` **makes everything outside it
 *    `inert`** ({@link trackModalLayer}, #1055, ADR-0038) - what `aria-modal`
 *    hides from assistive technology is exactly what clicks and Tab cannot
 *    reach. One place in this module knows which tracked layer is on top and
 *    owns the `inert` it sets; see "The modal backdrop" below.
 *
 * ## What counts as "above"
 *
 * Layers are `[role="dialog"]`, `[role="alertdialog"]` (ConfirmDialog),
 * `[role="menu"]` and `[data-esc-layer]`
 * ({@link LAYER_SELECTOR}). Active = not inside {@link LAYER_INACTIVE_ATTR} or
 * `inert`, laid out (has client rects) and not `display: none` /
 * `visibility: hidden`. Against `except`, an active layer is above when:
 *
 * - it is in an open popover (the browser's top layer, above any z-index);
 * - its effective z-index ({@link effectiveZIndex}, read from CSS - so the
 *   theme's `--banto-z-*` tokens decide, nothing is copied here) is higher;
 * - its z-index is equal and it comes later in document order (CSS paint
 *   order), so two equal layers never both yield;
 * - it sits **inside** `except` with its own positioned z-index (a Modal
 *   opened from a Drawer's content, a popup menu inside a dialog). A nested
 *   layer without its own z-index is part of `except`, not above it.
 *
 * `except` itself and its ancestors never count.
 *
 * ## The modal backdrop (promise 8)
 *
 * Modal, Drawer, ConfirmDialog, CommandPalette and ThreePaneLayout's modal
 * drawer call {@link trackModalLayer} while open. Per document, the topmost
 * tracked layer (nested inside another = above it; else the "above" rules
 * above) decides the backdrop: walking from `<body>` down to the layer, every
 * element beside that path gets `inert`. A lower tracked layer is just part
 * of the backdrop until the upper one is released, in whatever order they
 * close.
 *
 * - Only the `inert` this module set is removed. An element that was already
 *   `inert` is left alone, and one whose `inert` the app writes while a layer
 *   is open (a sidebar that turns off-canvas) is handed over to the app.
 * - {@link MODAL_EXEMPT_ATTR} keeps an element out of the backdrop: what is
 *   drawn above every modal and must stay usable (ToastHost, the touch keys).
 * - Live regions (`aria-live`, `role="status" | "alert" | "log"`, `<output>`)
 *   keep announcing: they are not made inert, the controls inside them are
 *   (a "retry" in a status banner cannot be pressed behind the modal).
 * - The backdrop follows the DOM while a layer is open (MutationObserver): a
 *   banner or a portal's content that appears later is covered too.
 * - A layer nobody tracked that is **above** the top one by the rules above
 *   (an app's own dialog in a portal, an open off-canvas sidebar) is kept out
 *   of the backdrop - Esc yields to it, so it must be usable. It does not
 *   make the rest inert itself: an app's own modal layer calls
 *   {@link trackModalLayer} for that.
 *
 * {@link hasVisibleMenuLayer} and {@link hasVisibleModalLayer} apply the same
 * rules to the menus / the `aria-modal="true"` layers only - what keyboard
 * shortcuts yield to (`shortcut.ts`, shared-primitives-upstream-plan §3.6),
 * so a non-modal floating window does not silence them.
 */

/** Set on a layer that is closing (still in the DOM during an outro) - promise 6. */
export const LAYER_INACTIVE_ATTR = 'data-layer-inactive';

/** Marker for a layer that has no `dialog` / `menu` role (e.g. an off-canvas sidebar) - set only while open. */
export const LAYER_MARKER_ATTR = 'data-esc-layer';

/** Elements that count as Esc-closable layers. */
export const LAYER_SELECTOR = `[role="dialog"], [role="alertdialog"], [role="menu"], [${LAYER_MARKER_ATTR}]`;

/** Only the `[role="menu"]` layers (context menus). */
export const MENU_LAYER_SELECTOR = '[role="menu"]';

/**
 * Only the modal layers - those that say `aria-modal="true"` (Modal, Drawer,
 * CommandPalette; promise 4). A subset of what blocks the page, used where a
 * non-modal `role="dialog"` must not count ({@link hasVisibleModalLayer}).
 */
export const MODAL_LAYER_SELECTOR = '[aria-modal="true"]';

/** What the focus trap and the "focus first" of Modal / Drawer enumerate. */
export const FOCUSABLE_SELECTOR =
	'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

/** Is `el` laid out and not hidden by `display` / `visibility`? */
function isRendered(el: Element): boolean {
	if (el.getClientRects().length === 0) return false;
	const style = getComputedStyle(el);
	return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Focusables inside `panel` that Tab can reach now, in DOM order: in the tab
 * order (`tabIndex >= 0`, so a native control with `tabindex="-1"` is out),
 * not effectively disabled (`:disabled` also covers controls inside a
 * disabled `<fieldset>`), not inside `inert`, laid out. Counted on every call
 * - form parts come and go while a layer is open.
 */
export function focusablesIn(panel: HTMLElement): HTMLElement[] {
	return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(el) =>
			el.tabIndex >= 0 &&
			!el.matches(':disabled') &&
			!el.closest('[inert]') &&
			el.getClientRects().length > 0
	);
}

/** Numeric z-index of `node` if it is positioned and has one, else `null`. */
function ownZIndex(node: Element): number | null {
	const style = getComputedStyle(node);
	const z = Number.parseInt(style.zIndex, 10);
	return !Number.isNaN(z) && style.position !== 'static' ? z : null;
}

/**
 * Effective z-index of `el`: the first positioned ancestor-or-self with a
 * numeric z-index; `0` if none. Panels are usually not positioned themselves -
 * the overlay around them carries the z-index - hence the walk.
 */
export function effectiveZIndex(el: Element): number {
	for (let node: Element | null = el; node; node = node.parentElement) {
		const z = ownZIndex(node);
		if (z !== null) return z;
	}
	return 0;
}

/** Does `el` (inside `root`) get its own z-index from a node strictly inside `root`? */
function hasOwnZIndexWithin(el: Element, root: Element): boolean {
	for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
		if (ownZIndex(node) !== null) return true;
	}
	return false;
}

function isActiveLayer(el: Element): boolean {
	if (el.closest(`[${LAYER_INACTIVE_ATTR}]`)) return false;
	if (el.closest('[inert]')) return false;
	return isRendered(el);
}

/** Inside an open popover (browser top layer - above any z-index). */
function isInOpenPopover(el: Element): boolean {
	const popover = el.closest('[popover]');
	if (!popover) return false;
	try {
		return popover.matches(':popover-open');
	} catch {
		// Engines without the selector (jsdom) have no top layer either.
		return false;
	}
}

/** Is the active layer `el` above `self` (see the module doc)? */
function isAbove(el: Element, self: Element, selfZ: number): boolean {
	if (isInOpenPopover(el)) return true;
	if (self.contains(el)) return hasOwnZIndexWithin(el, self);
	const z = effectiveZIndex(el);
	if (z !== selfZ) return z > selfZ;
	return (self.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Is a visible, active layer above `except` (promise 2)? Without `except`
 * (the caller is not a layer - the page underneath), any visible, active layer
 * counts. Pass the element that carries the layer's role as `except`.
 */
export function hasVisibleLayerAbove(options: { except?: Element | null } = {}): boolean {
	return hasVisibleLayerMatching(LAYER_SELECTOR, options.except ?? null);
}

/** Is a visible, active layer matching `selector` shown - above `except` when given (same rules as {@link hasVisibleLayerAbove})? */
function hasVisibleLayerMatching(selector: string, except: Element | null): boolean {
	const selfZ = except ? effectiveZIndex(except) : 0;
	for (const el of document.querySelectorAll(selector)) {
		if (except && (el === except || el.contains(except))) continue;
		if (!isActiveLayer(el)) continue;
		if (!except || isAbove(el, except, selfZ)) return true;
	}
	return false;
}

/**
 * Is a visible, active `[role="menu"]` shown (e.g. to keep Ctrl+K from
 * opening a palette over it)? With `except`, only menus above it count (a
 * popup menu inside the `except` dialog counts only with its own z-index).
 */
export function hasVisibleMenuLayer(options: { except?: Element | null } = {}): boolean {
	return hasVisibleLayerMatching(MENU_LAYER_SELECTOR, options.except ?? null);
}

/**
 * Is a visible, active **modal** layer shown ({@link MODAL_LAYER_SELECTOR}:
 * `aria-modal="true"` - Modal, Drawer, CommandPalette)? Unlike
 * {@link hasVisibleLayerAbove}, a non-modal `role="dialog"` (the dock's
 * floating windows), a `data-esc-layer` (off-canvas sidebar) and a menu do
 * not count - pair it with {@link hasVisibleMenuLayer} for "modal or menu".
 * With `except`, the `except` layer itself, its ancestors and the layers
 * below it do not count (shortcut `ownerLayer`, the dock's divider Esc:
 * shared-primitives-upstream-plan §3.6 / §4.3).
 */
export function hasVisibleModalLayer(options: { except?: Element | null } = {}): boolean {
	return hasVisibleLayerMatching(MODAL_LAYER_SELECTOR, options.except ?? null);
}

/**
 * Trap focus inside `panel` (promise 4) and return the detach function.
 * Two parts: the panel's `keydown` wraps Tab / Shift+Tab (a Tab already
 * handled by a nested layer is left alone), and a document `focusin` pulls
 * focus that landed outside back to the first focusable - once outside,
 * later Tabs never reach the panel's keydown. The pull-back does not act while
 * a layer above owns focus. With no focusable inside, Tab is swallowed.
 */
export function attachFocusTrap(panel: HTMLElement): () => void {
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'Tab' || event.defaultPrevented) return;
		const items = focusablesIn(panel);
		if (items.length === 0) {
			event.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (event.shiftKey) {
			if (active === first) {
				event.preventDefault();
				last.focus();
			}
		} else if (active === last) {
			event.preventDefault();
			first.focus();
		}
	};
	const onFocusIn = (event: FocusEvent): void => {
		const target = event.target;
		if (target instanceof Node && panel.contains(target)) return;
		if (hasVisibleLayerAbove({ except: panel })) return;
		(focusablesIn(panel)[0] ?? panel).focus();
	};
	panel.addEventListener('keydown', onKeydown);
	document.addEventListener('focusin', onFocusIn);
	return () => {
		panel.removeEventListener('keydown', onKeydown);
		document.removeEventListener('focusin', onFocusIn);
	};
}

/**
 * Can focus go back to `el`? Connected, not `<body>` / `<html>` (a layer
 * opened while nothing had focus must not count as "restored"), not inside
 * `inert`, laid out and visible.
 */
export function canRestoreFocusTo(el: HTMLElement): boolean {
	if (el === document.body || el === document.documentElement) return false;
	if (!el.isConnected) return false;
	if (el.closest('[inert]')) return false;
	return isRendered(el);
}

/**
 * Focus `target` if it can still take focus (promise 5). Otherwise call
 * `fallback`: if it returns an element, that element gets the same check and
 * is focused when it passes; a fallback that returns nothing is free to move
 * focus itself. Without a usable target or fallback, focus is left alone.
 */
export function restoreFocus(
	target: HTMLElement | null | undefined,
	fallback?: () => HTMLElement | null | undefined | void
): void {
	if (target && canRestoreFocusTo(target)) {
		target.focus();
		return;
	}
	const alternative = fallback?.();
	if (alternative && canRestoreFocusTo(alternative)) alternative.focus();
}

/** How Modal / Drawer was asked to close. */
export type OverlayCloseSource = 'escape' | 'overlay' | 'close-button';

/**
 * Unsaved-changes guard (banto-hub TAG-UX-C): may `source` go on to request a
 * close? The close button always may (deliberate; the caller's
 * `onRequestClose` still confirms). Esc and an overlay click - the accidental
 * routes - may not while `dirty`; the component reports `onBlockedClose`
 * instead.
 */
export function isCloseAllowed(source: OverlayCloseSource, dirty: boolean): boolean {
	if (source === 'close-button') return true;
	return !dirty;
}

// --- the modal backdrop (promise 8, #1055) -----------------------------------

/**
 * Keeps an element (and what is inside it) out of the modal backdrop: it is
 * never made `inert` by {@link trackModalLayer}. For what is drawn above every
 * modal layer and must stay usable while one is open - ToastHost, the touch
 * keys' surface, an app's always-on-top host. Not for page content.
 */
export const MODAL_EXEMPT_ATTR = 'data-modal-exempt';

/** Elements that announce changes: `inert` would silence them. */
const LIVE_REGION_SELECTOR =
	'[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], output';

/** A subtree holding one of these is not made inert as a whole. */
const BACKDROP_KEEP_SELECTOR = `[${MODAL_EXEMPT_ATTR}], ${LIVE_REGION_SELECTOR}`;

/** What can be operated inside a live region (made inert one by one). */
const LIVE_CONTROL_SELECTOR = `${FOCUSABLE_SELECTOR}, [tabindex], [contenteditable], summary, area[href], iframe, [role="button"], [role="link"]`;

/** Never rendered, nothing to block. */
const BACKDROP_SKIPPED_TAGS = new Set(['script', 'style', 'link', 'meta', 'template', 'noscript']);

/**
 * Attribute changes that can change the backdrop: who is inert, what is a
 * live region or exempt, and which layers exist and show (an app's layer is
 * often shown by a class or a style).
 */
const BACKDROP_OBSERVED_ATTRS = [
	'inert',
	'role',
	'aria-live',
	'aria-modal',
	'hidden',
	'class',
	'style',
	MODAL_EXEMPT_ATTR,
	LAYER_MARKER_ATTR,
	LAYER_INACTIVE_ATTR
];

export interface ModalLayerOptions {
	/**
	 * The layer's scrim when it is **not** an ancestor of the layer (a sibling,
	 * like ThreePaneLayout's): kept out of the backdrop while this layer is on
	 * top, so a click on it still arrives. Read on every update.
	 */
	backdrop?: () => Element | null | undefined;
}

interface ModalEntry {
	layer: HTMLElement;
	backdrop?: () => Element | null | undefined;
}

interface ModalBackdrop {
	/** Tracked layers, in the order they were opened. */
	entries: ModalEntry[];
	/** The elements whose `inert` this module set (and so may remove). */
	applied: Set<HTMLElement>;
	/** The layer the backdrop was last built around. */
	top: HTMLElement | null;
	observer: MutationObserver | null;
}

const modalBackdrops = new WeakMap<Document, ModalBackdrop>();

/** Is the tracked layer `el` above the tracked layer `other`? Nested inside = above; else the module's z rules. */
function isModalAbove(el: HTMLElement, other: HTMLElement): boolean {
	if (other.contains(el)) return true;
	if (el.contains(other)) return false;
	return isAbove(el, other, effectiveZIndex(other));
}

function topModalEntry(doc: Document, entries: readonly ModalEntry[]): ModalEntry | null {
	let top: ModalEntry | null = null;
	for (const entry of entries) {
		// A layer that left the DOM before its release decides nothing.
		if (!doc.body?.contains(entry.layer)) continue;
		if (!top || isModalAbove(entry.layer, top.layer)) top = entry;
	}
	return top;
}

/** Is `el` inside an `inert` that this module did not set? */
function isInsideForeignInert(el: Element, applied: ReadonlySet<Element>): boolean {
	for (
		let node = el.closest('[inert]');
		node;
		node = node.parentElement?.closest('[inert]') ?? null
	) {
		if (!applied.has(node)) return true;
	}
	return false;
}

/**
 * The layers nobody tracked that are **above** the tracked `layer` by the
 * module's rules (an app's own dialog in a portal, an open off-canvas
 * sidebar, a menu): they are drawn over the modal and Esc already yields to
 * them, so they are not part of its backdrop. "Active" as elsewhere, except
 * that our own `inert` does not count - a layer that appears inside an
 * element we made inert is found and let out.
 */
function untrackedLayersAbove(
	doc: Document,
	layer: HTMLElement,
	applied: ReadonlySet<Element>
): Element[] {
	const z = effectiveZIndex(layer);
	const above: Element[] = [];
	for (const el of doc.querySelectorAll(LAYER_SELECTOR)) {
		if (el === layer || el.contains(layer) || layer.contains(el)) continue;
		if (el.closest(`[${LAYER_INACTIVE_ATTR}]`) || !isRendered(el)) continue;
		if (isInsideForeignInert(el, applied)) continue;
		if (isAbove(el, layer, z)) above.push(el);
	}
	return above;
}

/**
 * Collect into `want` what must be inert around the modal layer: under
 * `parent` (on the path from `<body>` to the layer), every child beside the
 * path. `inert` cannot be lifted by a descendant, so a child that holds
 * something to keep (`kept`: the layer, its scrim, the layers above it; an
 * exempt element; a live region) is not taken as a whole - the walk goes one
 * level down instead.
 */
function collectBackdrop(
	parent: Element,
	kept: readonly Element[],
	applied: ReadonlySet<HTMLElement>,
	want: Set<HTMLElement>
): void {
	for (const child of parent.children) {
		if (kept.includes(child)) continue;
		// `inert` is an HTML attribute: an <svg> beside the path is left as it is.
		if (!(child instanceof HTMLElement) || BACKDROP_SKIPPED_TAGS.has(child.localName)) continue;
		if (kept.some((el) => child.contains(el))) {
			collectBackdrop(child, kept, applied, want);
			continue;
		}
		if (child.hasAttribute(MODAL_EXEMPT_ATTR)) continue;
		// Already inert and not ours: nothing to add, nothing to walk into.
		if (child.hasAttribute('inert') && !applied.has(child)) continue;
		if (child.matches(LIVE_REGION_SELECTOR)) {
			// Still announced; only what can be operated inside is blocked.
			for (const control of child.querySelectorAll<HTMLElement>(LIVE_CONTROL_SELECTOR)) {
				want.add(control);
			}
			continue;
		}
		if (child.querySelector(BACKDROP_KEEP_SELECTOR)) {
			collectBackdrop(child, kept, applied, want);
			continue;
		}
		want.add(child);
	}
}

/**
 * An `inert` written by someone else on an element we hold: the claim passes
 * to them. Set again = theirs now (not removed on release); removed = the next
 * update puts ours back.
 */
function yieldForeignInert(state: ModalBackdrop, records: readonly MutationRecord[]): void {
	for (const record of records) {
		if (record.type === 'attributes' && record.attributeName === 'inert') {
			state.applied.delete(record.target as HTMLElement);
		}
	}
}

/** Bring the document's `inert` in line with the topmost tracked layer. */
function syncModalBackdrop(doc: Document, state: ModalBackdrop): void {
	yieldForeignInert(state, state.observer?.takeRecords() ?? []);
	const top = topModalEntry(doc, state.entries);
	state.top = top?.layer ?? null;
	const want = new Set<HTMLElement>();
	if (top && doc.body) {
		const kept: Element[] = [top.layer, ...untrackedLayersAbove(doc, top.layer, state.applied)];
		const scrim = top.backdrop?.();
		if (scrim) kept.push(scrim);
		collectBackdrop(doc.body, kept, state.applied, want);
	}
	for (const el of [...state.applied]) {
		if (want.has(el)) continue;
		state.applied.delete(el);
		el.removeAttribute('inert');
	}
	for (const el of want) {
		// Inert already (ours, or someone else's inside a subtree we walked): leave it.
		if (state.applied.has(el) || el.hasAttribute('inert')) continue;
		el.setAttribute('inert', '');
		state.applied.add(el);
	}
	if (state.entries.length === 0) {
		state.observer?.disconnect();
		state.observer = null;
		modalBackdrops.delete(doc);
		return;
	}
	if (state.observer) {
		// Our own writes are not news.
		state.observer.takeRecords();
		return;
	}
	if (typeof MutationObserver !== 'function' || !doc.body) return;
	state.observer = new MutationObserver((records) => {
		yieldForeignInert(state, records);
		// What changes inside the top layer cannot change what is outside it.
		const layer = state.top;
		if (layer && records.every((record) => layer.contains(record.target))) return;
		syncModalBackdrop(doc, state);
	});
	state.observer.observe(doc.body, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: BACKDROP_OBSERVED_ATTRS
	});
}

/**
 * Tell the document that the modal layer `layer` (the element that says
 * `aria-modal="true"`) is open, and return the function that takes it back
 * (promise 8; safe to call twice). While it is the topmost tracked layer,
 * everything outside it is `inert` - see "The modal backdrop" in the module
 * doc for what is kept (exempt elements, live regions) and whose `inert` is
 * whose.
 *
 * Call it when the layer opens and release it the moment it starts closing,
 * **before** focus is given back (the opener is inert until then). Layers may
 * be released in any order.
 */
export function trackModalLayer(layer: HTMLElement, options: ModalLayerOptions = {}): () => void {
	const doc = layer.ownerDocument;
	const state: ModalBackdrop = modalBackdrops.get(doc) ?? {
		entries: [],
		applied: new Set(),
		top: null,
		observer: null
	};
	modalBackdrops.set(doc, state);
	const entry: ModalEntry = { layer, backdrop: options.backdrop };
	state.entries.push(entry);
	syncModalBackdrop(doc, state);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		// `state` lives as long as it has an entry, so it is still the document's.
		state.entries = state.entries.filter((item) => item !== entry);
		syncModalBackdrop(doc, state);
	};
}
