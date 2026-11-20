/**
 * Row selection (#713): the pure decisions behind BantoGrid's checkbox
 * column - what the header's "select all" box shows, what a toggle does, and
 * which selected rows survive a change of the rows on screen. No DOM and no
 * runes; BantoGrid.svelte only draws the result (spec §4.1, the same
 * core/render split as `core/edit.ts`).
 *
 * A selection is a list of row ids (`getRowId`'s values) in the order they
 * were selected. Ids are compared as-is, so `1` and `'1'` are different rows.
 * Every function returns a new array and leaves its input alone, except where
 * noted that the same array comes back when nothing changed.
 */

export type RowId = string | number;

/** What the header's "select all" checkbox shows: unchecked / indeterminate / checked. */
export type SelectAllState = 'none' | 'some' | 'all';

/**
 * State of "select all" over `targetIds` (the rows it would act on - the
 * listed rows in client mode, the loaded rows in server mode). Selected rows
 * outside the targets do not count. No targets is `'none'`.
 */
export function selectAllState(
	selected: ReadonlySet<RowId>,
	targetIds: Iterable<RowId>
): SelectAllState {
	let total = 0;
	let hit = 0;
	for (const id of targetIds) {
		total++;
		if (selected.has(id)) hit++;
	}
	if (total === 0 || hit === 0) return 'none';
	return hit === total ? 'all' : 'some';
}

/** Flip one row: drop it when selected, append it otherwise. */
export function toggleRowId(selected: readonly RowId[], id: RowId): RowId[] {
	return selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id];
}

/**
 * The header checkbox's click: when every target is already selected, drop
 * the targets; otherwise add the missing ones (so `'some'` becomes `'all'`).
 * Selected rows outside the targets are kept either way.
 */
export function toggleAll(selected: readonly RowId[], targetIds: readonly RowId[]): RowId[] {
	const selectedSet = new Set(selected);
	if (selectAllState(selectedSet, targetIds) === 'all') {
		const targets = new Set(targetIds);
		return selected.filter((id) => !targets.has(id));
	}
	const next = [...selected];
	for (const id of targetIds) {
		if (!selectedSet.has(id)) {
			selectedSet.add(id);
			next.push(id);
		}
	}
	return next;
}

/**
 * Keep only the selected rows that are still among `presentIds` (client
 * mode: a row that a filter or a reload removed from the list is no longer
 * selected, so a bulk action never reaches a row that is not listed).
 * Returns the SAME array when nothing was dropped, so the caller can skip
 * the write.
 */
export function retainSelected(
	selected: readonly RowId[],
	presentIds: ReadonlySet<RowId>
): readonly RowId[] {
	const kept = selected.filter((id) => presentIds.has(id));
	return kept.length === selected.length ? selected : kept;
}
