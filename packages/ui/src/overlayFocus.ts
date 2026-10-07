/**
 * Package-internal focus/Esc helpers for modal overlays (CommandPalette,
 * ADR-0018 §8 decision 8). Not exported from `index.ts`: the general layer
 * helpers (Modal / Drawer, banto-hub's full `escLayering.ts`) are out of
 * phase 2 (decision 10). This is the minimal subset the palette needs, ported
 * from banto-industrial's banto-hub (#381 "layer promises"):
 *
 * 1. The layer that closes on Esc consumes the event (`preventDefault`), and
 *    a handler that sees `event.defaultPrevented` yields - so one Esc closes
 *    one layer, whatever the window-listener registration order.
 * 2. A layer yields Esc (and the focus pull-back below) while a visible,
 *    active layer is ABOVE it - a higher effective z-index, or the browser's
 *    top layer (an open popover); with equal z-index, the later one in
 *    document order (CSS paint order). "Above" is a z comparison, not "any
 *    other layer": with plain "any other", a palette (1000) over a drawer
 *    (900) would each think the other is on top and neither would react.
 * 3. Esc is handled at window level, so it still closes the layer when focus
 *    was moved outside it by something else.
 * 4. A layer that says `aria-modal="true"` traps focus: Tab wraps inside,
 *    and focus landing outside (programmatic `focus()`) is pulled back.
 * 5. On close, focus goes back to the element focused when the layer opened -
 *    only if it is still connected, not inside `inert` and visible; otherwise
 *    to the caller's fallback, else nowhere (never forced onto `<body>`).
 *
 * The layer markers are the ones banto-hub uses (`role="dialog"`,
 * `role="menu"`, `data-esc-layer`, `data-layer-inactive`), so phase 3 can
 * swap its copy in without changing the other layers.
 */

/** Elements that count as Esc-closable layers (banto-hub's selector). */
const LAYER_SELECTOR = '[role="dialog"], [role="menu"], [data-esc-layer]';
/** Set on a layer that is closing (still in the DOM during an outro). */
const LAYER_INACTIVE_ATTR = 'data-layer-inactive';

/** Focusables inside the palette. Its content is package-owned and always laid out, so no geometry check is needed (unlike banto-hub's generic drawer trap). */
const FOCUSABLE_SELECTOR =
	'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

function focusablesIn(panel: HTMLElement): HTMLElement[] {
	return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(el) => !el.hasAttribute('disabled') && !el.closest('[inert]')
	);
}

/** First positioned ancestor-or-self with a numeric z-index; 0 if none. */
function effectiveZIndex(el: Element): number {
	let node: Element | null = el;
	while (node) {
		const style = getComputedStyle(node);
		const z = Number.parseInt(style.zIndex, 10);
		if (!Number.isNaN(z) && style.position !== 'static') return z;
		node = node.parentElement;
	}
	return 0;
}

function isActiveLayer(el: Element): boolean {
	if (el.closest(`[${LAYER_INACTIVE_ATTR}]`)) return false;
	if (el.closest('[inert]')) return false;
	const style = getComputedStyle(el);
	return style.display !== 'none' && style.visibility !== 'hidden';
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

/**
 * Is a visible, active layer above `self` (promise 2)? `self`, its own
 * descendants and its ancestors are ignored. With equal z-index the one later
 * in document order is above - the CSS paint order - so two equal layers
 * never both yield (banto-hub's palette/drawer gap) nor fight over focus.
 */
export function hasLayerAbove(self: Element): boolean {
	const selfZ = effectiveZIndex(self);
	for (const el of document.querySelectorAll(LAYER_SELECTOR)) {
		if (el === self || self.contains(el) || el.contains(self)) continue;
		if (!isActiveLayer(el)) continue;
		if (isInOpenPopover(el)) return true;
		const z = effectiveZIndex(el);
		if (z > selfZ) return true;
		if (z === selfZ && self.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
			return true;
		}
	}
	return false;
}

/**
 * Trap focus inside `panel` (promise 4) and return the detach function.
 * Two parts: the panel's `keydown` wraps Tab / Shift+Tab, and a document
 * `focusin` pulls focus that landed outside back to the first focusable
 * (once outside, later Tabs never reach the panel's keydown) - except while a
 * layer above owns focus.
 */
export function attachFocusTrap(panel: HTMLElement): () => void {
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'Tab') return;
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
		if (hasLayerAbove(panel)) return;
		(focusablesIn(panel)[0] ?? panel).focus();
	};
	panel.addEventListener('keydown', onKeydown);
	document.addEventListener('focusin', onFocusIn);
	return () => {
		panel.removeEventListener('keydown', onKeydown);
		document.removeEventListener('focusin', onFocusIn);
	};
}

/** Can focus go back to `el` (connected, not `<body>`, not inert, visible)? */
function canRestoreFocusTo(el: HTMLElement): boolean {
	if (el === document.body || el === document.documentElement) return false;
	if (!el.isConnected) return false;
	if (el.closest('[inert]')) return false;
	if (el.getClientRects().length === 0) return false;
	const style = getComputedStyle(el);
	return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Focus `target` if it can still take focus, else `fallback()`'s element
 * (same check), else leave focus alone (promise 5).
 */
export function restoreFocus(
	target: HTMLElement | null | undefined,
	fallback?: () => HTMLElement | null | undefined
): void {
	if (target && canRestoreFocusTo(target)) {
		target.focus();
		return;
	}
	const alternative = fallback?.();
	if (alternative && canRestoreFocusTo(alternative)) alternative.focus();
}
