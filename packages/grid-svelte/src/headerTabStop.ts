/**
 * Svelte action for BantoGrid's header row (#1016): the header is one tab
 * stop (a roving `tabindex`). Of its controls - the select-all checkbox, then
 * per column the sort button and the filter button - exactly one has
 * `tabindex="0"`, the rest `-1`; ArrowLeft / ArrowRight move to the control
 * before / after, Home / End to the first / last. The control touched last
 * (by key or by mouse) is the one Tab comes back to.
 *
 * The controls are the elements marked with `HEADER_STOP_ATTR`, read in DOM
 * order every time: columns can be reordered, hidden, pinned, or stop being
 * sortable / filterable, and the set simply is what is there now. A control
 * that is disabled (select-all with no rows) is skipped. Until one is touched,
 * and when the remembered control is gone or disabled, the tab stop is the
 * first one there is.
 *
 * This action is the only writer of `tabindex` on the marked elements: the
 * templates do not set a reactive one (the sort button has a static `-1`,
 * which is also what it goes back to when it loses its mark).
 */

/** Marks a control of the header row that takes part in the roving tab stop. */
export const HEADER_STOP_ATTR = 'data-banto-grid-header-stop';

const STOP = `[${HEADER_STOP_ATTR}]`;

function stopsOf(header: HTMLElement): HTMLElement[] {
	return [...header.querySelectorAll<HTMLElement>(STOP)].filter((el) => !el.matches(':disabled'));
}

export function headerTabStop(header: HTMLElement): { destroy(): void } {
	/** The control Tab lands on: the one touched last. */
	let current: HTMLElement | null = null;
	/**
	 * Until a control is touched the tab stop is simply the first one, also
	 * when that one only becomes available later (select-all is disabled
	 * until the rows are loaded).
	 */
	let touched = false;
	/** The marked elements of the last pass. */
	let marked = new Set<HTMLElement>();

	function apply(): void {
		const stops = stopsOf(header);
		if (!touched || !current || !stops.includes(current)) {
			// The remembered one is gone (or disabled): back to "not touched".
			touched = false;
			current = stops[0] ?? null;
		}
		const now = new Set(header.querySelectorAll<HTMLElement>(STOP));
		// Disabled ones get -1 too, so one that is enabled later is not a
		// second tab stop before the next report.
		for (const el of now) {
			const value = el === current ? '0' : '-1';
			if (el.getAttribute('tabindex') !== value) el.setAttribute('tabindex', value);
		}
		// One that lost its mark while it was the tab stop (a column that
		// stopped being sortable) must not stay one.
		for (const el of marked) {
			if (!now.has(el) && el.getAttribute('tabindex') === '0') el.setAttribute('tabindex', '-1');
		}
		marked = now;
	}

	function handleFocusIn(event: FocusEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement) || !target.matches(STOP)) return;
		if (touched && current === target) return;
		touched = true;
		current = target;
		apply();
	}

	function handleKeydown(event: KeyboardEvent): void {
		// Only keys pressed on a control itself: the filter popover lives
		// inside the header row and keeps its own arrow keys.
		const target = event.target;
		if (!(target instanceof HTMLElement) || !target.matches(STOP)) return;
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		const stops = stopsOf(header);
		const index = stops.indexOf(target);
		if (index === -1) return;
		let next: number;
		switch (event.key) {
			case 'ArrowLeft':
				next = index - 1;
				break;
			case 'ArrowRight':
				next = index + 1;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = stops.length - 1;
				break;
			default:
				return;
		}
		// At either end the key does nothing, but it is still ours: it must
		// not scroll the grid under the focused control.
		event.preventDefault();
		const to = stops[next];
		if (!to || to === target) return;
		// `focusin` makes it the current one.
		to.focus();
	}

	apply();
	const observer = new MutationObserver(apply);
	observer.observe(header, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: [HEADER_STOP_ATTR, 'disabled']
	});
	header.addEventListener('focusin', handleFocusIn);
	header.addEventListener('keydown', handleKeydown);

	return {
		destroy() {
			observer.disconnect();
			header.removeEventListener('focusin', handleFocusIn);
			header.removeEventListener('keydown', handleKeydown);
		}
	};
}
