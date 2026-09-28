import { describe, expect, it } from 'vitest';
import {
	clearListViewState,
	loadActiveListMode,
	loadLastOpenedId,
	loadListViewState,
	noteLastEditedRecord,
	saveActiveListMode,
	saveLastOpenedId,
	saveListViewState,
	takeLastEditedRecord
} from '../src/listViewState';

/** In-memory Storage stand-in: Node has no global sessionStorage (same helper as uiSettings.test.ts). */
function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		}
	} as Storage;
}

describe('saveListViewState / loadListViewState', () => {
	it('round-trips sort/filters/groupBy for a key', () => {
		const storage = makeMemoryStorage();
		const snapshot = {
			sort: [{ field: 'price', direction: 'desc' as const }],
			filters: [{ field: 'name', op: 'contains' as const, value: 'tea' }],
			groupBy: 'category'
		};
		saveListViewState('items:server', snapshot, storage);
		expect(loadListViewState('items:server', storage)).toEqual(snapshot);
	});

	it('returns null when nothing was saved for the key', () => {
		expect(loadListViewState('items:server', makeMemoryStorage())).toBeNull();
	});

	it('keeps different keys independent (client vs server mode, or a different resource)', () => {
		const storage = makeMemoryStorage();
		saveListViewState('items:client', { sort: [], filters: [], groupBy: 'category' }, storage);
		saveListViewState('items:server', { sort: [], filters: [] }, storage);
		saveListViewState('users:server', { sort: [], filters: [] }, storage);

		expect(loadListViewState('items:client', storage)?.groupBy).toBe('category');
		expect(loadListViewState('items:server', storage)?.groupBy).toBeUndefined();
		expect(loadListViewState('users:server', storage)).toEqual({ sort: [], filters: [] });
	});

	it('ignores malformed JSON rather than throwing', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.items:server', '{not json');
		expect(loadListViewState('items:server', storage)).toBeNull();
	});

	it('ignores a payload missing sort/filters arrays', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.items:server', JSON.stringify({ groupBy: 'category' }));
		expect(loadListViewState('items:server', storage)).toBeNull();
	});

	it('resolveStorage(null) (e.g. SSR/disabled storage) no-ops on save and returns null on load', () => {
		expect(() => saveListViewState('items:server', { sort: [], filters: [] }, null)).not.toThrow();
		expect(loadListViewState('items:server', null)).toBeNull();
	});

	it('clearListViewState removes a saved snapshot', () => {
		const storage = makeMemoryStorage();
		saveListViewState('items:server', { sort: [], filters: [] }, storage);
		clearListViewState('items:server', storage);
		expect(loadListViewState('items:server', storage)).toBeNull();
	});
});

describe('saveActiveListMode / loadActiveListMode', () => {
	it('round-trips the last active mode per resource', () => {
		const storage = makeMemoryStorage();
		saveActiveListMode('items', 'client', storage);
		expect(loadActiveListMode('items', storage)).toBe('client');
	});

	it('returns null when nothing was saved', () => {
		expect(loadActiveListMode('items', makeMemoryStorage())).toBeNull();
	});

	it('keeps different resources independent', () => {
		const storage = makeMemoryStorage();
		saveActiveListMode('items', 'client', storage);
		saveActiveListMode('widgets', 'server', storage);
		expect(loadActiveListMode('items', storage)).toBe('client');
		expect(loadActiveListMode('widgets', storage)).toBe('server');
	});
});

describe('saveLastOpenedId / loadLastOpenedId', () => {
	it('round-trips a string or number id for a resource', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId('items', 42, storage);
		expect(loadLastOpenedId('items', storage)).toBe(42);

		saveLastOpenedId('users', 'abc-123', storage);
		expect(loadLastOpenedId('users', storage)).toBe('abc-123');
	});

	it('returns null when nothing was saved', () => {
		expect(loadLastOpenedId('items', makeMemoryStorage())).toBeNull();
	});

	it('saving null clears a previously-saved id', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId('items', 42, storage);
		saveLastOpenedId('items', null, storage);
		expect(loadLastOpenedId('items', storage)).toBeNull();
	});

	it('keeps different resources independent', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId('items', 1, storage);
		saveLastOpenedId('users', 2, storage);
		expect(loadLastOpenedId('items', storage)).toBe(1);
		expect(loadLastOpenedId('users', storage)).toBe(2);
	});

	it('is NOT one-shot (unlike takeLastEditedRecord): repeated loads return the same id', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId('items', 42, storage);
		expect(loadLastOpenedId('items', storage)).toBe(42);
		expect(loadLastOpenedId('items', storage)).toBe(42);
	});

	it('ignores a malformed payload rather than throwing', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.lastOpened.items', '{not json');
		expect(loadLastOpenedId('items', storage)).toBeNull();
	});
});

describe('noteLastEditedRecord / takeLastEditedRecord', () => {
	it('round-trips id/values for a resource', () => {
		const storage = makeMemoryStorage();
		noteLastEditedRecord('items', { id: 7, values: { name: 'tea', price: 300 } }, storage);
		expect(takeLastEditedRecord('items', storage)).toEqual({
			id: 7,
			values: { name: 'tea', price: 300 }
		});
	});

	it('is one-shot: a second take (without a new note) returns null', () => {
		const storage = makeMemoryStorage();
		noteLastEditedRecord('items', { id: 7, values: { name: 'tea' } }, storage);
		takeLastEditedRecord('items', storage);
		expect(takeLastEditedRecord('items', storage)).toBeNull();
	});

	it('returns null when nothing was noted', () => {
		expect(takeLastEditedRecord('items', makeMemoryStorage())).toBeNull();
	});

	it('keeps different resources independent', () => {
		const storage = makeMemoryStorage();
		noteLastEditedRecord('items', { id: 1, values: {} }, storage);
		noteLastEditedRecord('users', { id: 2, values: {} }, storage);
		expect(takeLastEditedRecord('items', storage)?.id).toBe(1);
		expect(takeLastEditedRecord('users', storage)?.id).toBe(2);
	});

	it('ignores a malformed payload rather than throwing', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.lastEdited.items', '{not json');
		expect(takeLastEditedRecord('items', storage)).toBeNull();
	});
});
