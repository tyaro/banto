/**
 * Pure cell-edit commit decision logic (spec §4.5): given a column, its row,
 * and a candidate (already-parsed) value, decide whether the edit is a
 * no-op, fails `column.validate`, or should be committed. No Svelte imports
 * — usable standalone and easy to unit test. BantoGrid.svelte calls this for
 * both interactive edits (Enter/Tab/blur/checkbox-toggle) and range paste.
 */
import type { CellEdit, GridColumn } from '../types';
import { getColumnValue } from './sort';

export type PrepareCommitResult<TRow> =
	| { kind: 'noop' }
	| { kind: 'invalid'; message: string }
	| { kind: 'commit'; edit: CellEdit<TRow> };

/**
 * `oldValue` is read from `row` via `column.accessor` (the row is not yet
 * mutated at commit time — the caller owns rows and applies the change,
 * typically after a round trip through the DataProvider).
 */
export function prepareCommit<TRow>(
	column: GridColumn<TRow>,
	row: TRow,
	rowId: string | number,
	draft: unknown
): PrepareCommitResult<TRow> {
	const oldValue = getColumnValue(row, column);
	if (draft === oldValue) return { kind: 'noop' };

	if (column.validate) {
		const message = column.validate(draft, row);
		if (message) return { kind: 'invalid', message };
	}

	return {
		kind: 'commit',
		edit: { row, rowId, field: column.id, value: draft, oldValue }
	};
}
