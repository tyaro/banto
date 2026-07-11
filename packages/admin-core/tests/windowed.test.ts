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

	const provider: DataProvider = {
		getList: (_resource: string, params) =>
			new Promise((resolve) => {
				const offset = params.pagination?.offset ?? 0;
				const limit = params.pagination?.limit ?? dataset.length;
				calls.push({ offset, limit });
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

	return { provider, calls, resolveCall, dataset };
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
