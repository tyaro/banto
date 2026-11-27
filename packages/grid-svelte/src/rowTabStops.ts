/**
 * Svelte action for a data row of BantoGrid (#1016): nothing inside the row is
 * a tab stop - the grid's own checkbox and links, and whatever the host drew
 * with `column.render` / `cell` alike - so the body of the grid is one tab
 * stop (the grid element, which names the active cell with
 * `aria-activedescendant`), and Tab goes header -> body -> bulk bar instead
 * of through every control of every row. The controls are reached from the
 * active cell (Space / Enter / F2, see `handleContainerKeydown`); the mouse
 * is not affected (a negative `tabindex` is still focusable).
 *
 * The cell editor (anything inside `EDITOR_CELL`) keeps its own `tabindex`
 * while the row is inside the virtualized window: it owns the focus during an
 * edit, and an injected editor may tab between its own parts. While the row
 * is `outside` the window (the active row BantoGrid keeps in the DOM) the
 * editor is taken out too, so Tab never lands on a control that is out of
 * sight (which would jump the view to that row).
 *
 * `inert` / `aria-hidden` were considered and dropped: they also hide the row from assistive technology, and `aria-activedescendant` must point at an exposed cell.
 *
 * Only `tabindex` is touched: the original value is parked in a data
 * attribute (and put back for the editor when the row is inside the window
 * again). Focus is not this action's business: BantoGrid moves it to the
 * grid element when the row goes out (`takeFocusFromOutsideRow`).
 */

/** The cell being edited: its content is left alone while the row is inside the window. */
export const EDITOR_CELL = '.cell.editing';

/** Holds the element's own `tabindex` while it is overridden ('' = it had none). */
export const SAVED_TABINDEX_ATTR = 'data-banto-grid-tabindex';

/**
 * What we write into `tabindex`. A negative
 * value, so Tab skips the element but a script can still focus it (like -1);
 * and a value the host is not going to write itself, so "the value is this"
 * means "the last write was ours" without counting writes: whatever else is
 * there when the observer reports (or when the value is put back) is the host's
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

function takeOutTree(root: Element, taken: (el: Element) => boolean): void {
	const els = [...(root.matches(FOCUSABLE) ? [root] : []), ...root.querySelectorAll(FOCUSABLE)];
	for (const el of els) {
		if (!el.hasAttribute(SAVED_TABINDEX_ATTR) && taken(el)) park(el);
	}
}

/**
 * Decided by the value that is there now, not by the writes seen on the way:
 * ours still there means the original comes back; anything else was written
 * by the host after us and stays (no attribute included).
 */
function putBack(els: Iterable<Element>): void {
	for (const el of els) {
		const saved = el.getAttribute(SAVED_TABINDEX_ATTR);
		el.removeAttribute(SAVED_TABINDEX_ATTR);
		if (el.getAttribute('tabindex') !== SUPPRESSED_TABINDEX) continue;
		if (saved === null || saved === '') el.removeAttribute('tabindex');
		else el.setAttribute('tabindex', saved);
	}
}

/**
 * The controls of a cell that were tab stops before this action took them
 * out, in DOM order: what the keyboard walks through after F2 on the cell
 * (BantoGrid `handleCellControlKeydown`). One the host itself keeps out of
 * the tab order (an original negative `tabindex`) or that is disabled is not
 * one of them.
 */
export function cellControls(cell: Element): HTMLElement[] {
	return [...cell.querySelectorAll<HTMLElement>(`[${SAVED_TABINDEX_ATTR}]`)].filter((el) => {
		if (el.getAttribute('tabindex') !== SUPPRESSED_TABINDEX || el.matches(':disabled'))
			return false;
		const saved = el.getAttribute(SAVED_TABINDEX_ATTR);
		return saved === '' || saved === null || Number(saved) >= 0;
	});
}

export function rowTabStops(
	row: HTMLElement,
	outside: boolean
): { update(outside: boolean): void; destroy(): void } {
	/** Whether `el` is taken out of the tab order right now. */
	const taken = (el: Element): boolean => outside || !el.closest(EDITOR_CELL);

	takeOutTree(row, taken);
	// The row's content is drawn again as the data changes (a host snippet, a
	// cell entering or leaving its editor): give what is added the same
	// treatment. Reports are microtasks, so a cell's `editing` class is
	// already there when its editor is reported.
	function handle(records: MutationRecord[]): void {
		const written = new Set<Element>();
		for (const record of records) {
			if (record.type === 'childList') {
				for (const node of record.addedNodes) {
					if (node instanceof Element) takeOutTree(node, taken);
				}
			} else if (record.target !== row && record.target instanceof Element) {
				const el = record.target;
				if (record.attributeName === 'tabindex') written.add(el);
				else if (!el.hasAttribute(SAVED_TABINDEX_ATTR) && el.matches(FOCUSABLE) && taken(el)) {
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
			if (!taken(el)) continue;
			if (el.hasAttribute(SAVED_TABINDEX_ATTR) || el.matches(FOCUSABLE)) park(el);
		}
	}
	let observer: MutationObserver | null = new MutationObserver(handle);
	observer.observe(row, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: WATCHED
	});

	return {
		update(next: boolean) {
			if (next === outside) return;
			// What is not reported yet is judged first, under the rule it was
			// written under: a value the host wrote on the editor while the row
			// was out there becomes the original, and is what comes back below.
			if (observer) handle(observer.takeRecords());
			outside = next;
			if (outside) {
				// The editor goes out with the rest.
				takeOutTree(row, taken);
				return;
			}
			// Back inside the window: the editor gets its own values back.
			putBack([...row.querySelectorAll(`[${SAVED_TABINDEX_ATTR}]`)].filter((el) => !taken(el)));
		},
		destroy() {
			// The row is leaving the DOM: nothing to put back.
			observer?.disconnect();
			observer = null;
		}
	};
}
