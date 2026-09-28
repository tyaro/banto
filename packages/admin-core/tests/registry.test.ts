import { describe, expect, it, vi } from 'vitest';
import {
	endSession,
	getAuthProvider,
	getDataProvider,
	getResource,
	initBanto,
	listResources,
	notify,
	sessionGeneration
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

	it('registers providers/resources and exposes them', async () => {
		const { dataProvider, authProvider } = makeProviders();
		initBanto({
			dataProvider,
			authProvider,
			resources: [{ name: 'items', label: '商品' }]
		});

		expect(getDataProvider()).toBe(dataProvider);
		// NOT `.toBe(authProvider)` (#215/#255 review): `initBanto` wraps the
		// given AuthProvider in a `Proxy` (`withListViewStateClearing`,
		// `listViewState.ts`) so `logout`/`login`/`setup`/`enterPublicViewer`
		// also end the session (`registry.svelte.ts`'s `endSession`) -
		// `getAuthProvider()` therefore returns that proxy, not the exact
		// object passed in. Un-overridden methods are rebound
		// (`value.bind(target)`, fix 1 of the #255 review) so a NEW function
		// object comes back on every access too - `.check`/`.getIdentity`
		// are therefore behavior-equivalent, not reference-equal. Behavior is
		// what a caller can rely on; see `listViewState.test.ts`'s
		// `withListViewStateClearing` suite (including a class-based
		// `AuthProvider` and one sharing state via `this`) for the wrapper's
		// full contract.
		expect(getAuthProvider()).not.toBe(authProvider);
		await expect(getAuthProvider().check()).resolves.toBe(true);
		await expect(getAuthProvider().getIdentity()).resolves.toBeNull();
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

	// Issue #215/#255 review (fix 2): `sessionGeneration()` is what a caller
	// (e.g. the items detail page) compares before/after an in-flight
	// request to detect "the identity changed while this was pending".
	describe('sessionGeneration / endSession (#215/#255 review, fix 2)', () => {
		it('endSession() bumps sessionGeneration()', () => {
			const before = sessionGeneration();
			endSession();
			expect(sessionGeneration()).toBe(before + 1);
		});

		it('a successful login/logout through the wrapped AuthProvider bumps it too', async () => {
			const { dataProvider, authProvider } = makeProviders();
			initBanto({ dataProvider, authProvider, resources: [] });
			const before = sessionGeneration();

			await getAuthProvider().login({ username: 'a', password: 'x' });
			expect(sessionGeneration()).toBe(before + 1);

			await getAuthProvider().logout();
			expect(sessionGeneration()).toBe(before + 2);
		});

		it('a FAILED login does not bump it (no identity actually changed)', async () => {
			const dataProvider = makeProviders().dataProvider;
			const authProvider: AuthProvider = {
				login: async () => ({ success: false, error: 'bad password' }),
				logout: async () => {},
				check: async () => true,
				getIdentity: async () => null
			};
			initBanto({ dataProvider, authProvider, resources: [] });
			const before = sessionGeneration();
			await getAuthProvider().login({ username: 'a', password: 'wrong' });
			expect(sessionGeneration()).toBe(before);
		});
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
