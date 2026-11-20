/**
 * Pinned (left-fixed) columns (#713): the pure decisions behind BantoGrid's
 * `position: sticky` columns - which columns lead the display order, where
 * each one sticks, how many fit the viewport, where a dragged column may be
 * dropped, and how far to scroll so the active cell is not left under the
 * pinned block. No DOM and no runes; BantoGrid.svelte and GridState only
 * apply the result (spec §4.1, the same core/render split as
 * `core/rowSelection.ts`).
 *
 * Vocabulary: the display order is two zones - the pinned zone (every visible
 * pinned column, leftmost) and the rest. `pinnedCount` is the size of the
 * pinned zone. `leading` is the width of whatever is fixed before the first
 * column (the row-selection checkbox column, else 0).
 */

/** Where a column is pinned. Only the left edge today. */
export type ColumnPin = 'left';

/**
 * The least width (px) that must stay scrollable beside the pinned block. A
 * pinned block that would leave less than this is cut back (`fitPinnedCount`),
 * so the unpinned columns can always be scrolled into view.
 */
export const MIN_SCROLLABLE_WIDTH = 120;

/**
 * Stable partition: pinned items first, each zone keeping its relative order.
 * Returns the same items in display order plus the size of the pinned zone.
 */
export function partitionPinned<T>(
	items: readonly T[],
	isPinned: (item: T) => boolean
): { ordered: T[]; pinnedCount: number } {
	const pinned: T[] = [];
	const rest: T[] = [];
	for (const item of items) (isPinned(item) ? pinned : rest).push(item);
	return { ordered: [...pinned, ...rest], pinnedCount: pinned.length };
}

/**
 * How many of the leading pinned columns can actually stick: the longest
 * prefix whose width (plus `leading`) still leaves `minScrollable` px of the
 * viewport for the other columns. A viewport that has not been measured yet
 * (`viewportWidth <= 0`) does not limit anything. 0 means "pin nothing" - the
 * caller then also leaves the checkbox column unpinned.
 */
export function fitPinnedCount(params: {
	/** Widths of the pinned-zone columns, in display order. */
	pinnedWidths: readonly number[];
	leading: number;
	viewportWidth: number;
	minScrollable?: number;
}): number {
	const { pinnedWidths, leading, viewportWidth, minScrollable = MIN_SCROLLABLE_WIDTH } = params;
	if (viewportWidth <= 0) return pinnedWidths.length;
	const budget = viewportWidth - minScrollable;
	let used = leading;
	let count = 0;
	for (const width of pinnedWidths) {
		if (used + width > budget) break;
		used += width;
		count++;
	}
	return count;
}

/**
 * `left` offset (px) of each of the first `count` columns when stuck:
 * `leading` for the first, then the running sum of the widths before it.
 */
export function pinnedOffsets(widths: readonly number[], count: number, leading = 0): number[] {
	const offsets: number[] = [];
	let left = leading;
	for (let i = 0; i < count && i < widths.length; i++) {
		offsets.push(left);
		left += widths[i];
	}
	return offsets;
}

/**
 * Keeps a drag-reorder inside the dragged column's own zone: a pinned column
 * (`fromIndex < pinnedCount`) may be dropped at 0..pinnedCount, any other at
 * pinnedCount..total. Indices are insertion positions in the display order
 * before the dragged column is removed.
 */
export function clampDropIndex(
	fromIndex: number,
	toIndex: number,
	pinnedCount: number,
	total: number
): number {
	const [min, max] = fromIndex < pinnedCount ? [0, pinnedCount] : [pinnedCount, total];
	return Math.min(max, Math.max(min, toIndex));
}

/**
 * Content x of a point given by its x inside the viewport (`viewX`, from the
 * scroll container's left edge). Over the stuck block the content is drawn
 * unscrolled, so the point is where it looks; right of it, it is scrolled.
 */
export function contentXAt(params: {
	viewX: number;
	scrollLeft: number;
	pinnedWidth: number;
}): number {
	const { viewX, scrollLeft, pinnedWidth } = params;
	return viewX < pinnedWidth ? viewX : viewX + scrollLeft;
}

/**
 * Moves `field` in `order` (every column id, hidden ones included) so that it
 * lands at insertion position `toIndex` of `visibleIds` (the display order:
 * pinned zone first, hidden ids left out), without leaving its zone
 * (`clampDropIndex`).
 *
 * The column is placed immediately before the visible column now at that
 * position. At the end of the unpinned zone it goes last in `order`; at the
 * end of the pinned zone it goes right after the last other pinned column,
 * because `order` interleaves both zones and "before the first unpinned
 * column" could still be ahead of a pinned one. Hidden ids keep their place
 * relative to the others. Returns a new array, or `order` itself when
 * `field` is not a visible column.
 */
export function moveInOrder(
	order: readonly string[],
	visibleIds: readonly string[],
	pinnedCount: number,
	field: string,
	toIndex: number
): readonly string[] {
	const fromVisible = visibleIds.indexOf(field);
	if (fromVisible === -1 || !order.includes(field)) return order;
	const target = clampDropIndex(fromVisible, toIndex, pinnedCount, visibleIds.length);
	// A drop that leaves the visible position unchanged must not touch the
	// stored order either (it could reorder hidden / pinned-zone neighbours).
	if (target === fromVisible || target === fromVisible + 1) return order;
	const next = order.filter((id) => id !== field);

	let insertAt: number;
	if (fromVisible < pinnedCount && target >= pinnedCount) {
		// End of the pinned zone: after the last pinned column other than itself.
		const others = visibleIds.slice(0, pinnedCount).filter((id) => id !== field);
		const last = others[others.length - 1];
		// The only pinned column: it has no neighbour to pass, so it stays put.
		if (last === undefined) return order.slice();
		insertAt = next.indexOf(last) + 1;
	} else {
		const targetId = visibleIds[target];
		// Dropping a column onto its own slot (before itself) keeps it in place.
		if (targetId === field) return order.slice();
		insertAt = targetId === undefined ? next.length : next.indexOf(targetId);
	}
	next.splice(insertAt, 0, field);
	return next;
}

/**
 * The `scrollLeft` that brings a cell fully into the part of the viewport not
 * covered by the pinned block, or the current `scrollLeft` when it already
 * is. A cell that is itself pinned is always in view, so nothing moves.
 * `cellLeft` is the cell's left edge in content coordinates; `pinnedWidth`
 * is the width of the stuck block (checkbox column included).
 */
export function scrollLeftToReveal(params: {
	cellLeft: number;
	cellWidth: number;
	scrollLeft: number;
	viewportWidth: number;
	pinnedWidth: number;
	cellPinned: boolean;
}): number {
	const { cellLeft, cellWidth, scrollLeft, viewportWidth, pinnedWidth, cellPinned } = params;
	if (cellPinned) return scrollLeft;
	if (cellLeft < scrollLeft + pinnedWidth) return Math.max(0, cellLeft - pinnedWidth);
	if (cellLeft + cellWidth > scrollLeft + viewportWidth) {
		// Never push the cell's left edge under the pinned block: a cell wider
		// than the free width shows its start, not its end.
		return Math.max(0, Math.min(cellLeft - pinnedWidth, cellLeft + cellWidth - viewportWidth));
	}
	return scrollLeft;
}
