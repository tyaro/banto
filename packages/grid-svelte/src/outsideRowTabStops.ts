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
 * never moved (a focused control in the row keeps it; a negative `tabindex`
 * is still focusable).
 */

/** Holds the element's own `tabindex` while it is overridden ('' = it had none). */
export const SAVED_TABINDEX_ATTR = 'data-banto-grid-tabindex';

/**
 * What we write into `tabindex` while a row is outside the window. A negative
 * value, so Tab skips the element but a script can still focus it (like -1);
 * and a value the host is not going to write itself, so "the value is this"
 * means "the last write was ours" without counting writes: whatever else is
 * there when the observer reports (or when the row comes back) is the host's
 * latest word.
 */
export const SUPPRESSED_TABINDEX = '-32768';

/**
 * Everything that can be a tab stop. Wider than strictly needed (a disabled
 * button, say): an extra negative `tabindex` is harmless and is taken off again.
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
 * Parks the element's current `tabindex` as the original ('' = none) and
 * takes it out of the tab order.
 */
function park(el: Element): void {
	el.setAttribute(SAVED_TABINDEX_ATTR, el.getAttribute('tabindex') ?? '');
	el.setAttribute('tabindex', SUPPRESSED_TABINDEX);
}

function takeOutTree(root: Element): void {
	const els = [...(root.matches(FOCUSABLE) ? [root] : []), ...root.querySelectorAll(FOCUSABLE)];
	for (const el of els) {
		if (!el.hasAttribute(SAVED_TABINDEX_ATTR)) park(el);
	}
}

/**
 * Decided by the value that is there now, not by the writes seen on the way:
 * ours still there means the original comes back; anything else was written
 * by the host after us and stays (no attribute included).
 */
function putBack(row: Element): void {
	for (const el of row.querySelectorAll(`[${SAVED_TABINDEX_ATTR}]`)) {
		const saved = el.getAttribute(SAVED_TABINDEX_ATTR);
		el.removeAttribute(SAVED_TABINDEX_ATTR);
		if (el.getAttribute('tabindex') !== SUPPRESSED_TABINDEX) continue;
		if (saved === null || saved === '') el.removeAttribute('tabindex');
		else el.setAttribute('tabindex', saved);
	}
}

export function outsideRowTabStops(
	row: HTMLElement,
	outside: boolean
): { update(outside: boolean): void; destroy(): void } {
	let observer: MutationObserver | null = null;

	function start(): void {
		if (observer) return;
		takeOutTree(row);
		// The row's content can be drawn again while it is out there (a host
		// snippet reacting to data): give what is added the same treatment.
		observer = new MutationObserver((records) => {
			const written = new Set<Element>();
			for (const record of records) {
				if (record.type === 'childList') {
					for (const node of record.addedNodes) {
						if (node instanceof Element) takeOutTree(node);
					}
				} else if (record.target !== row && record.target instanceof Element) {
					const el = record.target;
					if (record.attributeName === 'tabindex') written.add(el);
					else if (!el.hasAttribute(SAVED_TABINDEX_ATTR) && el.matches(FOCUSABLE)) {
						// href / contenteditable / controls made it focusable.
						park(el);
					}
				}
			}
			// `tabindex` is judged once per element, by the value it has now:
			// ours means the last write was ours (nothing to do); anything else is
			// what the host wrote last, so it becomes the original (even a -1, or
			// no attribute). One we already hold counts even if the element no
			// longer matches (the attribute is gone).
			for (const el of written) {
				if (el.getAttribute('tabindex') === SUPPRESSED_TABINDEX) continue;
				if (el.hasAttribute(SAVED_TABINDEX_ATTR) || el.matches(FOCUSABLE)) park(el);
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
		// Reports not delivered yet are dropped: putBack reads the value that is
		// there now, which already includes everything they would have said.
		observer.takeRecords();
		observer.disconnect();
		observer = null;
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
