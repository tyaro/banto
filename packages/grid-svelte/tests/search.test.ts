/**
 * The client-mode quick search (Issue #555): `searchRows` against the cases
 * shared with banto-storage's SQL (SQLite + PostgreSQL) and the InMemory
 * provider (`crates/banto-storage/testdata/list-search-parity.json`). The
 * text columns are the ones whose `filterType` is text (the default).
 */
import { describe, expect, it } from 'vitest';
import searchFixture from '../../../crates/banto-storage/testdata/list-search-parity.json';
import { filterRows } from '../src/core/filter';
import { searchableColumns, searchRows } from '../src/core/search';
import type { FilterState, GridColumn } from '../src/types';

interface SearchRow {
	id: number;
	name: string;
	note: string | null;
	price: number;
	day: string | null;
}

const fixture = searchFixture as {
	textFields: string[];
	rows: SearchRow[];
	cases: { name: string; search: string | null; filters?: FilterState[]; expectedIds: number[] }[];
};

const columns: GridColumn<SearchRow>[] = [
	{ id: 'id', header: 'ID', accessor: 'id', filterType: 'number' },
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'note', header: 'Note', accessor: (row) => row.note, filterType: 'text' },
	{ id: 'price', header: 'Price', accessor: 'price', filterType: 'number' },
	{ id: 'day', header: 'Day', accessor: 'day', filterType: 'date' }
];

describe('searchRows: the shared parity fixture', () => {
	it('looks in exactly the fixture text fields', () => {
		expect(searchableColumns(columns).map((column) => column.id)).toEqual(fixture.textFields);
	});

	for (const { name, search, filters, expectedIds } of fixture.cases) {
		it(name, () => {
			const filtered = filterRows(fixture.rows, filters ?? [], columns);
			const ids = searchRows(filtered, search ?? undefined, columns).map((row) => row.id);
			expect(ids).toEqual(expectedIds);
		});
	}

	it('returns the same array for a blank term', () => {
		expect(searchRows(fixture.rows, '  ', columns)).toBe(fixture.rows);
	});
});
