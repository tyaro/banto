/**
 * List-order contract parity (Issue #243 review): the InMemory DataProvider
 * must order rows exactly like banto-storage's SQL - ties broken by the
 * unique key `id` in the direction of the last sort key, unsorted lists by
 * `id` ascending, NULLs last. The expectations live in one fixture shared
 * with the Rust tests (`crates/banto-storage/testdata/list-order-parity.json`)
 * and the grid's client-sort tests, so the implementations cannot drift.
 */
import { describe, expect, it } from 'vitest';
import betweenFixture from '../../../crates/banto-storage/testdata/filter-between-parity.json';
import parityFixture from '../../../crates/banto-storage/testdata/list-order-parity.json';
import searchFixture from '../../../crates/banto-storage/testdata/list-search-parity.json';
import { createInMemoryDataProvider } from '../src/providers/inMemory';
import type { FilterState, SortState } from '../src/types';

interface ParityRow {
	id: number;
	grp: number;
	score: number | null;
}

const fixture = parityFixture as {
	rows: ParityRow[];
	cases: { sort: SortState[]; expectedIds: number[] }[];
};

describe('InMemory list order matches the shared SQL contract', () => {
	const provider = createInMemoryDataProvider(
		{ parity: { rows: fixture.rows as unknown as Record<string, unknown>[] } },
		{ latencyMs: 0 }
	);

	for (const { sort, expectedIds } of fixture.cases) {
		const label = sort.map((s) => `${s.field} ${s.direction}`).join(', ') || '(unsorted)';

		it(`orders ${label}`, async () => {
			const result = await provider.getList<ParityRow>('parity', { sort, filters: [] });
			expect(result.rows.map((row) => row.id)).toEqual(expectedIds);
		});

		it(`pages ${label} without duplicates or gaps`, async () => {
			const ids: number[] = [];
			for (let offset = 0; offset < fixture.rows.length; offset += 5) {
				const page = await provider.getList<ParityRow>('parity', {
					sort,
					filters: [],
					pagination: { offset, limit: 5 }
				});
				ids.push(...page.rows.map((row) => row.id));
			}
			expect(ids).toEqual(expectedIds);
		});
	}
});

/**
 * The `between` filter contract (date-time-pickers §5.9): the half-open
 * `[from, to)` compared as text, shared with banto-storage's SQL and the
 * grid's client filter (`crates/banto-storage/testdata/filter-between-parity.json`).
 * A malformed value matches nothing here (the server answers 400).
 */
describe('InMemory between and lt/lte/gt/gte match the shared SQL contract', () => {
	interface RangeRow {
		id: number;
		day: string | null;
		at: string | null;
	}
	const between = betweenFixture as {
		rows: RangeRow[];
		cases: { name: string; field: string; value: unknown; expectedIds: number[] }[];
		compare: {
			name: string;
			field: string;
			op: FilterState['op'];
			value: unknown;
			expectedIds: number[];
		}[];
		invalid: { name: string; value: unknown }[];
	};
	const provider = createInMemoryDataProvider(
		{ ranges: { rows: between.rows as unknown as Record<string, unknown>[] } },
		{ latencyMs: 0 }
	);
	const list = async (filter: FilterState) =>
		(await provider.getList<RangeRow>('ranges', { sort: [], filters: [filter] })).rows.map(
			(row) => row.id
		);

	for (const { name, field, value, expectedIds } of between.cases) {
		it(name, async () => {
			expect(await list({ field, op: 'between', value })).toEqual(expectedIds);
		});
	}

	for (const { name, field, op, value, expectedIds } of between.compare) {
		it(`${op}: ${name}`, async () => {
			expect(await list({ field, op, value })).toEqual(expectedIds);
		});
	}

	for (const { name, value } of between.invalid) {
		it(`a malformed value matches nothing: ${name}`, async () => {
			expect(await list({ field: 'day', op: 'between', value })).toEqual([]);
		});
	}
});

/**
 * The quick search (`ListParams.search`, Issue #555): any text field contains
 * the trimmed term, case-insensitively, ANDed with the filters - the same
 * cases banto-storage's SQL and the grid's client search assert
 * (`crates/banto-storage/testdata/list-search-parity.json`).
 */
describe('InMemory search matches the shared SQL contract', () => {
	interface SearchRow {
		id: number;
		name: string;
		note: string | null;
		price: number;
		day: string | null;
	}
	const search = searchFixture as {
		textFields: string[];
		rows: SearchRow[];
		cases: {
			name: string;
			search: string | null;
			filters?: FilterState[];
			expectedIds: number[];
		}[];
	};
	const provider = createInMemoryDataProvider(
		{
			things: {
				rows: search.rows as unknown as Record<string, unknown>[],
				searchFields: search.textFields
			}
		},
		{ latencyMs: 0 }
	);

	for (const { name, search: term, filters, expectedIds } of search.cases) {
		it(name, async () => {
			const result = await provider.getList<SearchRow>('things', {
				sort: [],
				filters: filters ?? [],
				...(term !== null && { search: term })
			});
			expect(result.rows.map((row) => row.id)).toEqual(expectedIds);
			expect(result.totalCount).toBe(expectedIds.length);
		});
	}

	it('defaults the search fields to every field holding a string', async () => {
		const defaults = createInMemoryDataProvider(
			{ things: { rows: search.rows as unknown as Record<string, unknown>[] } },
			{ latencyMs: 0 }
		);
		// `day` holds strings, so without `searchFields` it is searched too.
		const result = await defaults.getList<SearchRow>('things', {
			sort: [],
			filters: [],
			search: '2026-01'
		});
		expect(result.rows.map((row) => row.id)).toEqual([4]);
	});
});
