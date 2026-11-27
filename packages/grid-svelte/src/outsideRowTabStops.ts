/**
 * Svelte action for the row BantoGrid keeps in the DOM while it is outside the
 * virtualized window (#1016): while `outside` is true, nothing inside the row
 * is a tab stop — the grid's own checkbox and links, and whatever the host
 * drew with `column.render` / `cell` alike — so Tab never lands on a control
 * that is out of sight (which would jump the view to that row).
 *
 * `inert` / `aria-hidden` were considered and dropped: they also hide the row from assistive technology, and `aria-activedescendant` must point at an exposed cell.
 *
 * Only `tabindex` is touched: the original value is parked in a data
 * attribute and put back when the row is inside the window again. Focus is
 * never moved (a focused control in the row keeps it; `tabindex="-1"` is still
 * focusable).
 */

/** Holds the element's own `tabindex` while it is overridden ('' = it had none). */
export const SAVED_TABINDEX_ATTR = 'data-banto-grid-tabindex';

/**
 * Everything that can be a tab stop. Wider than strictly needed (a disabled
 * button, say): an extra `tabindex="-1"` is harmless and is taken off again.
 */
const FOCUSABLE = [
	'a[href]',
	'area[href]',
	'button',
	'input',
	'select',
	'textarea',
	'summary',
	'iframe',
	'object',
	'embed',
	'audio[controls]',
	'video[controls]',
	'[tabindex]',
	'[contenteditable]'
].join(',');

/** Attributes whose change can turn an element into a tab stop. */
const WATCHED = ['tabindex', 'href', 'contenteditable', 'controls'];

/**
 * How many `tabindex` writes of ours the observer has not reported yet, per
 * element. The observer reports every attribute write (even one that stores
 * the same value) in write order, so a report that finds this count above
 * zero is our own echo; one that finds none is the host writing `tabindex`.
 */
type OwnWrites = WeakMap<Element, number>;

/**
 * Parks the element's current `tabindex` as the original and takes it out of
 * the tab order. `own` is given while the observer is running (our write will
 * be reported back); the first pass, before it observes, passes none.
 */
function park(el: Element, own: OwnWrites | null): void {
	const current = el.getAttribute('tabindex');
	el.setAttribute(SAVED_TABINDEX_ATTR, current ?? '');
	if (current === '-1') return;
	el.setAttribute('tabindex', '-1');
	if (own) own.set(el, (own.get(el) ?? 0) + 1);
}

function takeOutTree(root: Element, own: OwnWrites | null): void {
	const els = [...(root.matches(FOCUSABLE) ? [root] : []), ...root.querySelectorAll(FOCUSABLE)];
	for (const el of els) {
		if (!el.hasAttribute(SAVED_TABINDEX_ATTR)) park(el, own);
	}
}

function putBack(row: Element): void {
	for (const el of row.querySelectorAll(`[${SAVED_TABINDEX_ATTR}]`)) {
		const saved = el.getAttribute(SAVED_TABINDEX_ATTR);
		el.removeAttribute(SAVED_TABINDEX_ATTR);
		if (saved === null || saved === '') el.removeAttribute('tabindex');
		else el.setAttribute('tabindex', saved);
	}
}

export function outsideRowTabStops(
	row: HTMLElement,
	outside: boolean
): { update(outside: boolean): void; destroy(): void } {
	let observer: MutationObserver | null = null;
	let own: OwnWrites = new WeakMap();

	function start(): void {
		if (observer) return;
		own = new WeakMap();
		takeOutTree(row, null);
		// The row's content can be drawn again while it is out there (a host
		// snippet reacting to data): give what is added the same treatment.
		observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === 'childList') {
					for (const node of record.addedNodes) {
						if (node instanceof Element) takeOutTree(node, own);
					}
				} else if (record.target !== row && record.target instanceof Element) {
					const el = record.target;
					if (record.attributeName === 'tabindex') {
						const pending = own.get(el) ?? 0;
						if (pending > 0) {
							// Our own write coming back.
							own.set(el, pending - 1);
							continue;
						}
						// The host wrote `tabindex` (a new value, or removed it): that is
						// the new original, even if it is -1. One we already hold counts
						// even if it no longer matches (the attribute is gone).
						if (el.hasAttribute(SAVED_TABINDEX_ATTR) || el.matches(FOCUSABLE)) park(el, own);
					} else if (!el.hasAttribute(SAVED_TABINDEX_ATTR) && el.matches(FOCUSABLE)) {
						// href / contenteditable / controls made it focusable.
						park(el, own);
					}
				}
			}
		});
		observer.observe(row, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: WATCHED
		});
	}

	function stop(): void {
		if (!observer) return;
		observer.disconnect();
		observer = null;
		own = new WeakMap();
		putBack(row);
	}

	if (outside) start();
	return {
		update(next: boolean) {
			if (next) start();
			else stop();
		},
		destroy() {
			// The row is leaving the DOM: nothing to put back.
			observer?.disconnect();
			observer = null;
		}
	};
}
