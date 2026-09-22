import { describe, expect, it } from 'vitest';
import { invalidate } from '../src/invalidate';
import type { DataProvider } from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import { createWindowedListResource } from '../src/windowed.svelte';

interface Row {
	id: number;
	name: string;
}

const authProvider = {
	login: async () => ({ success: true }),
	logout: async () => {},
	check: async () => true,
	getIdentity: async () => null
};

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeDataset(count: number): Row[] {
	return Array.from({ length: count }, (_, i) => ({ id: i, name: `row-${i}` }));
}

/**
 * Controllable mock DataProvider: every `getList` call queues a manually
 * resolvable promise (recorded in `calls`) instead of resolving immediately,
 * so tests can force a specific resolution order.
 */
function createControllableProvider(datasetSize = 50) {
	const dataset = makeDataset(datasetSize);
	const calls: { offset: number; limit: number }[] = [];
	const resolvers: ((value: { rows: Row[]; totalCount: number }) => void)[] = [];
	const rejectors: ((reason: Error) => void)[] = [];

	const provider: DataProvider = {
		getList: (_resource: string, params) =>
			new Promise((resolve, reject) => {
				const offset = params.pagination?.offset ?? 0;
				const limit = params.pagination?.limit ?? dataset.length;
				calls.push({ offset, limit });
				rejectors.push(reject);
				resolvers.push(resolve as (value: { rows: Row[]; totalCount: number }) => void);
			}),
		getOne: async () => {
			throw new Error('unused');
		},
		create: async () => {
			throw new Error('unused');
		},
		update: async () => {
			throw new Error('unused');
		},
		deleteOne: async () => {}
	};

	/** Resolve the call at `index` with a slice of the dataset matching its own offset/limit (or `overrideRows`/`overrideTotal` for custom responses). */
	function resolveCall(index: number, overrideRows?: Row[], overrideTotal?: number): void {
		const { offset, limit } = calls[index];
		const rows = overrideRows ?? dataset.slice(offset, offset + limit);
		resolvers[index]({ rows, totalCount: overrideTotal ?? dataset.length });
	}

	return {
		provider,
		calls,
		resolveCall,
		rejectCall: (index: number) => rejectors[index](new Error('Refresh failed')),
		dataset
	};
}

describe('createWindowedListResource', () => {
	it('dedups overlapping ensureRange calls: each covering block is fetched at most once', async () => {
		const { provider, calls, resolveCall } = createControllableProvider(50);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-dedup', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-dedup', { blockSize: 10 });

		// Blocks 0 (offset 0) and 1 (offset 10) requested by the first call...
		const first = windowed.ensureRange(0, 15);
		// ...and blocks 0, 1, 2 requested by a second, overlapping call made
		// before the first has resolved (marking-in-flight happens
		// synchronously, so only block 2/offset 20 is newly fetched here).
		const second = windowed.ensureRange(5, 25);

		expect(calls.map((c) => c.offset).sort((a, b) => a - b)).toEqual([0, 10, 20]);

		resolveCall(0);
		resolveCall(1);
		resolveCall(2);
		await Promise.all([first, second]);

		expect(windowed.totalCount).toBe(50);
		expect(windowed.rows.slice(0, 25)).toEqual(
			Array.from({ length: 25 }, (_, i) => ({ id: i, name: `row-${i}` }))
		);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('setParams bumps the generation; an in-flight response from the old generation is dropped', async () => {
		const { provider, calls, resolveCall } = createControllableProvider(50);
		initBanto({ dataProvider: provider, authProvider, resources: [{ name: 'w-gen', label: 'W' }] });

		const windowed = createWindowedListResource<Row>('w-gen', { blockSize: 10 });

		const staleLoad = windowed.ensureRange(0, 10); // offset 0, call index 0 - left pending
		windowed.setParams({ sort: [{ field: 'name', direction: 'asc' }] }); // bumps generation, clears cache

		// The stale call's response arrives after the param change...
		resolveCall(0);
		await staleLoad;
		// ...and must not have written state: totalCount/rows are untouched
		// (still their post-setParams-reset values).
		expect(windowed.totalCount).toBe(0);
		expect(windowed.rows).toEqual([]);

		// A fresh ensureRange under the new generation fetches and writes normally.
		const freshLoad = windowed.ensureRange(0, 10); // call index 1
		resolveCall(1);
		await freshLoad;
		expect(windowed.totalCount).toBe(50);
		expect(windowed.rows.slice(0, 10)).toEqual(
			Array.from({ length: 10 }, (_, i) => ({ id: i, name: `row-${i}` }))
		);
		expect(calls).toHaveLength(2);
		windowed.dispose();
	});

	it('invalidate(resource) triggers refresh(), which re-fetches the last ensured range', async () => {
		const { provider, resolveCall } = createControllableProvider(50);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-invalidate', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-invalidate', { blockSize: 10 });
		const load = windowed.ensureRange(0, 10);
		resolveCall(0);
		await load;
		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0' });

		invalidate('w-invalidate');
		await tick(); // let refresh()'s fire-and-forget ensureRange start

		// refresh() re-fetches the same [0, 10) range under a new generation.
		resolveCall(1, [{ id: 0, name: 'row-0-updated' }, ...makeDataset(9).slice(1)]);
		await tick();

		expect(windowed.rows[0]).toEqual({ id: 0, name: 'row-0-updated' });
		windowed.dispose();
	});

	it('totalCount is adopted from the first response and rows are written at their absolute offsets (sparse elsewhere)', async () => {
		const { provider, resolveCall } = createControllableProvider(30);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-sparse', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-sparse', { blockSize: 10 });
		expect(windowed.totalCount).toBe(0);

		// Only ensure the last block (offset 20); blocks 0/1 stay unloaded holes.
		const load = windowed.ensureRange(20, 30);
		resolveCall(0);
		await load;

		expect(windowed.totalCount).toBe(30);
		expect(windowed.rows).toHaveLength(30);
		expect(windowed.rows[0]).toBeUndefined();
		expect(windowed.rows[19]).toBeUndefined();
		expect(windowed.rows[20]).toEqual({ id: 20, name: 'row-20' });
		expect(windowed.rows[29]).toEqual({ id: 29, name: 'row-29' });
		windowed.dispose();
	});

	it('dispose stops further invalidate-triggered refreshes', async () => {
		const { provider, calls, resolveCall } = createControllableProvider(20);
		initBanto({
			dataProvider: provider,
			authProvider,
			resources: [{ name: 'w-dispose', label: 'W' }]
		});

		const windowed = createWindowedListResource<Row>('w-dispose', { blockSize: 10 });
		const load = windowed.ensureRange(0, 10);
		resolveCall(0);
		await load;
		windowed.dispose();

		invalidate('w-dispose');
		await tick();
		expect(calls).toHaveLength(1); // no refetch after dispose
	});
});

function setupRefresh(name: string, size = 6) {
	const controlled = createControllableProvider(size);
	initBanto({ dataProvider: controlled.provider, authProvider, resources: [{ name, label: 'W' }] });
	return { ...controlled, windowed: createWindowedListResource<Row>(name, { blockSize: 2 }) };
}

describe('atomic window refresh (#212)', () => {
	it('keeps the published snapshot and total until all refreshed blocks settle', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic');
		const load = windowed.ensureRange(0, 6);
		resolveCall(0);
		resolveCall(1);
		resolveCall(2);
		await load;
		await windowed.ensureRange(0, 4);
		const previous = windowed.rows;
		const refresh = windowed.refresh();
		expect(windowed.rows).toBe(previous);
		// A deletion/reorder affects absolute offsets; old and new blocks must not mix.
		resolveCall(
			3,
			[
				{ id: 2, name: 'new-2' },
				{ id: 3, name: 'new-3' }
			],
			4
		);
		await tick();
		expect(windowed.rows).toBe(previous);
		expect(windowed.totalCount).toBe(6);
		expect(windowed.loading).toBe(true);
		resolveCall(
			4,
			[
				{ id: 4, name: 'new-4' },
				{ id: 5, name: 'new-5' }
			],
			4
		);
		await refresh;
		expect(windowed.rows.map((row) => row?.id)).toEqual([2, 3, 4, 5]);
		expect(windowed.totalCount).toBe(4);
		expect(windowed.rows).toHaveLength(4);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('includes concurrent range requests in the same atomic publication', async () => {
		const { windowed, resolveCall, calls } = setupRefresh('w-atomic-concurrent');
		const load = windowed.ensureRange(0, 2);
		resolveCall(0);
		await load;
		const previous = windowed.rows;
		const refresh = windowed.refresh();
		const scroll = windowed.ensureRange(0, 4);
		expect(calls).toHaveLength(3);
		resolveCall(1, [{ id: 10, name: 'replacement' }]);
		await refresh;
		expect(windowed.rows).toBe(previous);
		expect(windowed.loading).toBe(true);
		resolveCall(2, [{ id: 12, name: 'new block' }]);
		await scroll;
		expect(windowed.rows[0]?.id).toBe(10);
		expect(windowed.rows[2]?.id).toBe(12);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('setParams discards a staged refresh and immediately clears rows under the new params', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic-params');
		const load = windowed.ensureRange(0, 2);
		resolveCall(0);
		await load;
		const refresh = windowed.refresh();
		windowed.setParams({ sort: [{ field: 'name', direction: 'desc' }] });
		expect(windowed.rows[0]).toBeUndefined();
		const sorted = windowed.ensureRange(0, 2);
		resolveCall(2, [{ id: 5, name: 'sorted' }]);
		await sorted;
		resolveCall(1, [{ id: 99, name: 'stale' }]);
		await refresh;
		expect(windowed.rows[0]?.id).toBe(5);
		expect(windowed.loading).toBe(false);
		windowed.dispose();
	});

	it('a newer refresh discards the older staged results and bookkeeping', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic-generation');
		const load = windowed.ensureRange(0, 4);
		resolveCall(0);
		resolveCall(1);
		await load;
		const previous = windowed.rows;
		const first = windowed.refresh();
		resolveCall(2, [{ id: 99, name: 'stale first block' }]);
		await tick();
		const second = windowed.refresh();
		resolveCall(3, [{ id: 98, name: 'stale second block' }]);
		await first;
		expect(windowed.rows).toBe(previous);
		expect(windowed.loading).toBe(true);
		resolveCall(4, [{ id: 20, name: 'latest first block' }]);
		resolveCall(5, [{ id: 22, name: 'latest second block' }]);
		await second;
		expect(windowed.rows[0]?.id).toBe(20);
		expect(windowed.rows[2]?.id).toBe(22);
		windowed.dispose();
	});

	it('publishes successful refreshed blocks with holes for failures and permits retry', async () => {
		const { windowed, resolveCall, rejectCall } = setupRefresh('w-atomic-failure');
		const load = windowed.ensureRange(0, 4);
		resolveCall(0);
		resolveCall(1);
		await load;
		const previous = windowed.rows;
		const refresh = windowed.refresh();
		resolveCall(2, [{ id: 10, name: 'replacement' }]);
		await tick();
		expect(windowed.rows).toBe(previous);
		rejectCall(3);
		await refresh;
		expect(windowed.rows[0]?.id).toBe(10);
		expect(windowed.rows[2]).toBeUndefined();
		expect(windowed.error?.message).toContain('Refresh failed');
		expect(windowed.loading).toBe(false);
		const retry = windowed.ensureRange(2, 4);
		resolveCall(4, [{ id: 12, name: 'retried' }]);
		await retry;
		expect(windowed.rows[2]?.id).toBe(12);
		expect(windowed.error).toBeNull();
		windowed.dispose();
	});

	it('initial loads remain incremental even while another block is pending', async () => {
		const { windowed, resolveCall } = setupRefresh('w-atomic-initial');
		const load = windowed.ensureRange(0, 4);
		resolveCall(0);
		await tick();
		expect(windowed.rows[0]?.id).toBe(0);
		expect(windowed.rows[2]).toBeUndefined();
		expect(windowed.loading).toBe(true);
		resolveCall(1);
		await load;
		windowed.dispose();
	});

	it('a refresh with no range issues no request and an empty range clears cached rows', async () => {
		const { windowed, resolveCall, calls } = setupRefresh('w-atomic-empty');
		await windowed.refresh();
		expect(calls).toHaveLength(0);
		const load = windowed.ensureRange(0, 2);
		resolveCall(0);
		await load;
		await windowed.ensureRange(0, 0);
		await windowed.refresh();
		expect(calls).toHaveLength(1);
		expect(windowed.rows[0]).toBeUndefined();
		windowed.dispose();
	});
});
