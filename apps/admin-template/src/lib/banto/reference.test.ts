import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDataProvider, type DataProvider } from '@banto/admin-core';
import { REFERENCE_SEARCH_LIMIT, referenceFrom } from './reference';

interface Staff {
	id: number;
	name: string;
	site: string;
	active: boolean;
	[key: string]: unknown;
}

const rows: Staff[] = [
	{ id: 1, name: 'Aoki', site: 'Tokyo', active: true },
	{ id: 2, name: 'Aoyama', site: 'Osaka', active: false },
	{ id: 3, name: 'Inoue', site: 'Tokyo', active: true }
];

const provider = () =>
	createInMemoryDataProvider({
		staff: { rows: rows.map((row) => ({ ...row })), searchFields: ['name'] }
	});

const live = () => new AbortController().signal;

describe('referenceFrom (#714)', () => {
	it('searches with the quick search of getList and maps the rows', async () => {
		const source = referenceFrom<Staff>(provider(), 'staff', {
			labelOf: (row) => row.name,
			descriptionOf: (row) => row.site
		});
		expect(await source.search('ao', live())).toEqual([
			{ value: 1, label: 'Aoki', description: 'Tokyo' },
			{ value: 2, label: 'Aoyama', description: 'Osaka' }
		]);
		expect(await source.search('zzz', live())).toEqual([]);
	});

	it('an empty query is no search: the first rows, within the limit', async () => {
		const data = provider();
		const getList = vi.spyOn(data, 'getList');
		const source = referenceFrom<Staff>(data, 'staff', { labelOf: (row) => row.name, limit: 2 });
		expect((await source.search('  ', live())).map((option) => option.value)).toEqual([1, 2]);
		expect(getList).toHaveBeenLastCalledWith('staff', {
			pagination: { offset: 0, limit: 2 },
			sort: [],
			filters: []
		});
		await referenceFrom<Staff>(data, 'staff', { labelOf: (row) => row.name }).search('a', live());
		expect(getList).toHaveBeenLastCalledWith('staff', {
			pagination: { offset: 0, limit: REFERENCE_SEARCH_LIMIT },
			sort: [],
			filters: [],
			search: 'a'
		});
	});

	it('applies the fixed filters and sort', async () => {
		const source = referenceFrom<Staff>(provider(), 'staff', {
			labelOf: (row) => row.name,
			filters: [{ field: 'active', op: 'eq', value: true }],
			sort: [{ field: 'name', direction: 'desc' }]
		});
		expect(await source.search('', live())).toEqual([
			{ value: 3, label: 'Inoue' },
			{ value: 1, label: 'Aoki' }
		]);
	});

	it('round trip: search, the picked value, resolve gives the same name back', async () => {
		const source = referenceFrom<Staff>(provider(), 'staff', {
			labelOf: (row) => row.name,
			descriptionOf: (row) => row.site
		});
		const [picked] = await source.search('inou', live());
		expect(picked.label).toBe('Inoue');
		expect(await source.resolve(picked.value, live())).toEqual(picked);
	});

	it('resolves a stored value with getOne; a missing record is null', async () => {
		const source = referenceFrom<Staff>(provider(), 'staff', { labelOf: (row) => row.name });
		expect(await source.resolve(3, live())).toEqual({ value: 3, label: 'Inoue' });
		expect(await source.resolve(99, live())).toBeNull();
	});

	it('lets other failures through', async () => {
		const failing = {
			getList: () => Promise.reject(new Error('offline')),
			getOne: () => Promise.reject(new Error('offline'))
		} as unknown as DataProvider;
		const source = referenceFrom<Staff>(failing, 'staff', { labelOf: (row) => row.name });
		await expect(source.search('a', live())).rejects.toThrow('offline');
		await expect(source.resolve(1, live())).rejects.toThrow('offline');
	});

	it('throws away the answer of an aborted request', async () => {
		const source = referenceFrom<Staff>(provider(), 'staff', { labelOf: (row) => row.name });
		const controller = new AbortController();
		const search = source.search('a', controller.signal);
		const resolve = source.resolve(1, controller.signal);
		controller.abort();
		await expect(search).rejects.toMatchObject({ name: 'AbortError' });
		await expect(resolve).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('takes a getter, read at call time (definitions are built before initBanto)', async () => {
		const ready: { provider?: DataProvider } = {};
		const source = referenceFrom<Staff>(
			() => {
				if (!ready.provider) throw new Error('not ready');
				return ready.provider;
			},
			'staff',
			{ labelOf: (row) => row.name }
		);
		ready.provider = provider();
		expect(await source.resolve(1, live())).toEqual({ value: 1, label: 'Aoki' });
	});
});
