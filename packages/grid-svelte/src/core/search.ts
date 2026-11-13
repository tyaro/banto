/**
 * The quick search of a client-mode list (Issue #555): the client side of
 * `ListParams.search`. A row matches when ANY text column (`filterType`
 * unset or `'text'`) contains the trimmed term, case-insensitively; a blank
 * term keeps every row. Must stay in sync with banto-storage's `push_search`
 * and the InMemory provider's `applySearch` (shared cases:
 * `crates/banto-storage/testdata/list-search-parity.json`).
 */
import { getColumnValue } from './sort';
import type { GridColumn } from '../types';

/** The columns `searchRows` looks in: every column whose `filterType` is text (the default). */
export function searchableColumns<TRow>(columns: readonly GridColumn<TRow>[]): GridColumn<TRow>[] {
	return columns.filter((column) => (column.filterType ?? 'text') === 'text');
}

/** Keep the rows where a text column contains `search` (see the module doc). Returns `rows` itself for a blank term. */
export function searchRows<TRow>(
	rows: TRow[],
	search: string | undefined,
	columns: readonly GridColumn<TRow>[]
): TRow[] {
	const term = search?.trim().toLowerCase() ?? '';
	if (term === '') return rows;
	const text = searchableColumns(columns);
	return rows.filter((row) =>
		text.some((column) => {
			const value = getColumnValue(row, column);
			return value !== null && value !== undefined && String(value).toLowerCase().includes(term);
		})
	);
}
