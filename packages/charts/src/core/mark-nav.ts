/**
 * Keyboard navigation across the selectable marks of a chart
 * (docs/design/crossfilter-drilldown-design.md §4.3). Marks form one linear
 * order (`BarChart`: category-major, then series; `PieChart`: clockwise from
 * the first slice). Pure: no DOM, no Svelte, so it is unit-testable.
 */

/** Keys the roving-tabindex handler moves with (Enter / Space select instead). */
export type MarkNavKey = 'ArrowRight' | 'ArrowDown' | 'ArrowLeft' | 'ArrowUp' | 'Home' | 'End';

const NAV_KEYS: ReadonlySet<string> = new Set([
	'ArrowRight',
	'ArrowDown',
	'ArrowLeft',
	'ArrowUp',
	'Home',
	'End'
]);

export function isMarkNavKey(key: string): key is MarkNavKey {
	return NAV_KEYS.has(key);
}

/** `true` for the keys that select the focused mark (Enter / Space). */
export function isMarkActivateKey(key: string): boolean {
	return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/**
 * Index of the mark to focus after `key`, or `null` when `key` is not a
 * navigation key or there is nothing to move to. Right / Down go to the next
 * mark, Left / Up to the previous one, Home / End to the first / last. It
 * clamps at both ends (no wrap-around), so a held arrow key stops at the edge.
 * An out-of-range `current` is clamped into `[0, count - 1]` first.
 */
export function nextMarkIndex(key: string, current: number, count: number): number | null {
	if (!Number.isInteger(count) || count <= 0 || !isMarkNavKey(key)) return null;
	const cur = clampMarkIndex(Number.isFinite(current) ? Math.trunc(current) : 0, count);
	switch (key) {
		case 'ArrowRight':
		case 'ArrowDown':
			return Math.min(cur + 1, count - 1);
		case 'ArrowLeft':
		case 'ArrowUp':
			return Math.max(cur - 1, 0);
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
	}
}

/** Clamp the roving tab stop into range (data can shrink between renders). */
export function clampMarkIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(Math.max(index, 0), count - 1);
}
