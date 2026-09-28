import { describe, expect, it, vi } from 'vitest';
import {
	getAuthProvider,
	getDataProvider,
	getResource,
	initBanto,
	listResources,
	notify
} from '../src/registry.svelte';
import type { AuthProvider, DataProvider, Notifier } from '../src/provider';

function makeProviders(): { dataProvider: DataProvider; authProvider: AuthProvider } {
	const dataProvider: DataProvider = {
		getList: async () => ({ rows: [], totalCount: 0 }),
		getOne: async () => ({}) as never,
		create: async () => ({}) as never,
		update: async () => ({}) as never,
		deleteOne: async () => {}
	};
	const authProvider: AuthProvider = {
		login: async () => ({ success: true }),
		logout: async () => {},
		check: async () => true,
		getIdentity: async () => null
	};
	return { dataProvider, authProvider };
}

describe('registry', () => {
	// Must run before any initBanto() call in this file/module instance.
	it('throws a helpful error before initBanto is called', () => {
		expect(() => getDataProvider()).toThrow(/initBanto/);
		expect(() => getAuthProvider()).toThrow(/initBanto/);
	});

	it('registers providers/resources and exposes them', () => {
		const { dataProvider, authProvider } = makeProviders();
		initBanto({
			dataProvider,
			authProvider,
			resources: [{ name: 'items', label: '商品' }]
		});

		expect(getDataProvider()).toBe(dataProvider);
		// NOT `.toBe(authProvider)` (#215/#255 review): `initBanto` wraps the
		// given AuthProvider (`withListViewStateClearing`,
		// `listViewState.ts`) so `logout`/`login`/`setup`/`enterPublicViewer`
		// also clear this session's saved list view state - `getAuthProvider()`
		// therefore returns that wrapper, not the exact object passed in.
		// Behavior (not identity) is what a caller can rely on; see
		// `listViewState.test.ts`'s `withListViewStateClearing` suite for the
		// wrapper's own contract.
		expect(getAuthProvider()).not.toBe(authProvider);
		expect(getAuthProvider().check).toBe(authProvider.check);
		expect(getAuthProvider().getIdentity).toBe(authProvider.getIdentity);
		expect(getResource('items').label).toBe('商品');
		expect(listResources()).toHaveLength(1);
	});

	it('getAuthProvider().logout() clears saved list view state (Issue #215/#255)', async () => {
		const { dataProvider, authProvider } = makeProviders();
		const storage = (() => {
			const map = new Map<string, string>();
			return {
				getItem: (key: string) => map.get(key) ?? null,
				setItem: (key: string, value: string) => void map.set(key, value),
				removeItem: (key: string) => void map.delete(key),
				clear: () => map.clear(),
				key: (index: number) => Array.from(map.keys())[index] ?? null,
				get length() {
					return map.size;
				}
			} as Storage;
		})();
		vi.stubGlobal('sessionStorage', storage);
		try {
			storage.setItem('banto.listView.items:server', JSON.stringify({ sort: [], filters: [] }));
			initBanto({ dataProvider, authProvider, resources: [] });
			await getAuthProvider().logout();
			expect(storage.getItem('banto.listView.items:server')).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('getResource throws for an unknown resource', () => {
		const { dataProvider, authProvider } = makeProviders();
		initBanto({ dataProvider, authProvider, resources: [] });
		expect(() => getResource('missing')).toThrow(/missing/);
	});

	it('notify is a no-op without a notifier and forwards to one when set', () => {
		const { dataProvider, authProvider } = makeProviders();
		const seen: { kind: string; message: string }[] = [];
		const notifier: Notifier = { notify: (kind, message) => seen.push({ kind, message }) };

		initBanto({ dataProvider, authProvider, resources: [] });
		expect(() => notify('success', 'ignored')).not.toThrow();

		initBanto({ dataProvider, authProvider, resources: [], notifier });
		notify('success', 'ok');
		expect(seen).toEqual([{ kind: 'success', message: 'ok' }]);
	});
});
