import { describe, expect, it } from 'vitest';
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
		expect(getAuthProvider()).toBe(authProvider);
		expect(getResource('items').label).toBe('商品');
		expect(listResources()).toHaveLength(1);
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
