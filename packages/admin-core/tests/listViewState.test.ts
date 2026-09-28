import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearAllListViewState,
	clearListViewState,
	loadActiveListMode,
	loadLastOpenedId,
	loadListViewState,
	noteLastEditedRecord,
	purgeListViewStateNotOwnedBy,
	saveActiveListMode,
	saveLastOpenedId,
	saveListViewState,
	takeLastEditedRecord
} from '../src/listViewState';
import { beginSession, endSession } from '../src/sessionLifecycle';
import {
	currentSessionScope,
	isCurrentSessionScope,
	sessionGeneration,
	sessionOwnerKey,
	type SessionScope
} from '../src/sessionScope.svelte';

const ALICE = { id: 'alice', name: 'Alice' };
const BOB = { id: 'bob', name: 'Bob' };

/**
 * Every test starts inside a confirmed session for ALICE (`scope`). Node has
 * no global `sessionStorage`, so `beginSession`/`endSession`'s own
 * purge/clear of the GLOBAL storage no-op here; each test passes its own
 * in-memory storage explicitly.
 */
let scope: SessionScope;
beforeEach(() => {
	endSession();
	beginSession(ALICE);
	scope = currentSessionScope();
});

/** The on-disk shape: `{ owner, data }` - what a raw `setItem` in a test must write to be readable by `scope`. */
function owned(data: unknown, owner: string | null = scope.owner): string {
	return JSON.stringify({ owner, data });
}

/** In-memory Storage stand-in: Node has no global sessionStorage (same helper as uiSettings.test.ts). `key()`/`length` are real (not stubs) - `clearAllListViewState` enumerates keys, unlike every other function here. */
function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: (index) => Array.from(map.keys())[index] ?? null,
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
		saveListViewState(scope, 'items:server', snapshot, storage);
		expect(loadListViewState(scope, 'items:server', undefined, storage)).toEqual(snapshot);
	});

	it('returns null when nothing was saved for the key', () => {
		expect(loadListViewState(scope, 'items:server', undefined, makeMemoryStorage())).toBeNull();
	});

	it('keeps different keys independent (client vs server mode, or a different resource)', () => {
		const storage = makeMemoryStorage();
		saveListViewState(
			scope,
			'items:client',
			{ sort: [], filters: [], groupBy: 'category' },
			storage
		);
		saveListViewState(scope, 'items:server', { sort: [], filters: [] }, storage);
		saveListViewState(scope, 'users:server', { sort: [], filters: [] }, storage);

		expect(loadListViewState(scope, 'items:client', undefined, storage)?.groupBy).toBe('category');
		expect(loadListViewState(scope, 'items:server', undefined, storage)?.groupBy).toBeUndefined();
		expect(loadListViewState(scope, 'users:server', undefined, storage)).toEqual({
			sort: [],
			filters: []
		});
	});

	it('ignores malformed JSON rather than throwing', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.items:server', '{not json');
		expect(loadListViewState(scope, 'items:server', undefined, storage)).toBeNull();
	});

	it('ignores a payload missing sort/filters arrays', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.items:server', owned({ groupBy: 'category' }));
		expect(loadListViewState(scope, 'items:server', undefined, storage)).toBeNull();
	});

	it('resolveStorage(null) (e.g. SSR/disabled storage) no-ops on save and returns null on load', () => {
		expect(() =>
			saveListViewState(scope, 'items:server', { sort: [], filters: [] }, null)
		).not.toThrow();
		expect(loadListViewState(scope, 'items:server', undefined, null)).toBeNull();
	});

	it('clearListViewState removes a saved snapshot', () => {
		const storage = makeMemoryStorage();
		saveListViewState(scope, 'items:server', { sort: [], filters: [] }, storage);
		clearListViewState('items:server', storage);
		expect(loadListViewState(scope, 'items:server', undefined, storage)).toBeNull();
	});

	// #215/#255 review: a saved payload is untrusted (a column removed/
	// renamed since, a hand-edited/corrupted sessionStorage entry, a future
	// FilterOp this version doesn't know) - every element's shape is checked,
	// not just "the arrays exist".
	describe('deep shape validation (#255 review)', () => {
		const validSort = { field: 'price', direction: 'desc' };
		const validFilter = { field: 'name', op: 'contains', value: 'tea' };

		it('accepts a fully well-formed snapshot', () => {
			const storage = makeMemoryStorage();
			storage.setItem(
				'banto.listView.items:server',
				owned({ sort: [validSort], filters: [validFilter] })
			);
			expect(loadListViewState(scope, 'items:server', undefined, storage)).toEqual({
				sort: [validSort],
				filters: [validFilter]
			});
		});

		it.each([
			['a sort entry missing field', { sort: [{ direction: 'asc' }], filters: [] }],
			[
				'a sort entry with an empty field',
				{ sort: [{ field: '', direction: 'asc' }], filters: [] }
			],
			[
				'a sort entry with an invalid direction',
				{ sort: [{ field: 'price', direction: 'sideways' }], filters: [] }
			],
			['a sort entry that is not an object', { sort: ['price'], filters: [] }],
			['a filter entry missing field', { sort: [], filters: [{ op: 'eq', value: 1 }] }],
			[
				'a filter entry with an unknown op',
				{ sort: [], filters: [{ field: 'price', op: 'fuzzy_match', value: 1 }] }
			],
			[
				'a filter entry with no value key at all',
				{ sort: [], filters: [{ field: 'price', op: 'eq' }] }
			],
			['groupBy that is neither a string nor null', { sort: [], filters: [], groupBy: 42 }]
		])(
			'rejects the WHOLE snapshot for %s (falls back to null -> caller default)',
			(_label, bad) => {
				const storage = makeMemoryStorage();
				storage.setItem('banto.listView.items:server', owned(bad));
				expect(loadListViewState(scope, 'items:server', undefined, storage)).toBeNull();
			}
		);

		it('a filter value of null/0/false is still valid (falsy but present)', () => {
			const storage = makeMemoryStorage();
			storage.setItem(
				'banto.listView.items:server',
				owned({ sort: [], filters: [{ field: 'stock', op: 'eq', value: 0 }] })
			);
			expect(loadListViewState(scope, 'items:server', undefined, storage)?.filters).toEqual([
				{ field: 'stock', op: 'eq', value: 0 }
			]);
		});
	});

	// #215/#255 review: "捨てる" - drop a sort/filter entry whose `field`
	// isn't a column the CURRENT screen has, rather than reject the whole
	// snapshot (a column can be renamed/removed between sessions).
	describe('knownFields filtering (#255 review)', () => {
		it('drops sort/filter entries for fields outside knownFields, keeping the rest', () => {
			const storage = makeMemoryStorage();
			saveListViewState(
				scope,
				'items:server',
				{
					sort: [
						{ field: 'price', direction: 'desc' },
						{ field: 'removedColumn', direction: 'asc' }
					],
					filters: [
						{ field: 'name', op: 'contains', value: 'tea' },
						{ field: 'renamedColumn', op: 'eq', value: 1 }
					]
				},
				storage
			);
			expect(loadListViewState(scope, 'items:server', ['price', 'name'], storage)).toEqual({
				sort: [{ field: 'price', direction: 'desc' }],
				filters: [{ field: 'name', op: 'contains', value: 'tea' }]
			});
		});

		it('every field unknown -> empty (default) sort/filters, snapshot still loads', () => {
			const storage = makeMemoryStorage();
			saveListViewState(
				scope,
				'items:server',
				{
					sort: [{ field: 'removedColumn', direction: 'asc' }],
					filters: [{ field: 'alsoRemoved', op: 'eq', value: 1 }]
				},
				storage
			);
			expect(loadListViewState(scope, 'items:server', ['price', 'name'], storage)).toEqual({
				sort: [],
				filters: []
			});
		});

		it('omitting knownFields skips the check entirely (unchanged behavior)', () => {
			const storage = makeMemoryStorage();
			saveListViewState(
				scope,
				'items:server',
				{ sort: [{ field: 'anyField', direction: 'asc' }], filters: [] },
				storage
			);
			expect(loadListViewState(scope, 'items:server', undefined, storage)?.sort).toEqual([
				{ field: 'anyField', direction: 'asc' }
			]);
		});
	});
});

describe('saveActiveListMode / loadActiveListMode', () => {
	it('round-trips the last active mode per resource', () => {
		const storage = makeMemoryStorage();
		saveActiveListMode(scope, 'items', 'client', storage);
		expect(loadActiveListMode(scope, 'items', storage)).toBe('client');
	});

	it('returns null when nothing was saved', () => {
		expect(loadActiveListMode(scope, 'items', makeMemoryStorage())).toBeNull();
	});

	it('keeps different resources independent', () => {
		const storage = makeMemoryStorage();
		saveActiveListMode(scope, 'items', 'client', storage);
		saveActiveListMode(scope, 'widgets', 'server', storage);
		expect(loadActiveListMode(scope, 'items', storage)).toBe('client');
		expect(loadActiveListMode(scope, 'widgets', storage)).toBe('server');
	});
});

describe('saveLastOpenedId / loadLastOpenedId', () => {
	it('round-trips a string or number id for a resource', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId(scope, 'items', 42, storage);
		expect(loadLastOpenedId(scope, 'items', storage)).toBe(42);

		saveLastOpenedId(scope, 'users', 'abc-123', storage);
		expect(loadLastOpenedId(scope, 'users', storage)).toBe('abc-123');
	});

	it('returns null when nothing was saved', () => {
		expect(loadLastOpenedId(scope, 'items', makeMemoryStorage())).toBeNull();
	});

	it('saving null clears a previously-saved id', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId(scope, 'items', 42, storage);
		saveLastOpenedId(scope, 'items', null, storage);
		expect(loadLastOpenedId(scope, 'items', storage)).toBeNull();
	});

	it('keeps different resources independent', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId(scope, 'items', 1, storage);
		saveLastOpenedId(scope, 'users', 2, storage);
		expect(loadLastOpenedId(scope, 'items', storage)).toBe(1);
		expect(loadLastOpenedId(scope, 'users', storage)).toBe(2);
	});

	it('is NOT one-shot (unlike takeLastEditedRecord): repeated loads return the same id', () => {
		const storage = makeMemoryStorage();
		saveLastOpenedId(scope, 'items', 42, storage);
		expect(loadLastOpenedId(scope, 'items', storage)).toBe(42);
		expect(loadLastOpenedId(scope, 'items', storage)).toBe(42);
	});

	it('ignores a malformed payload rather than throwing', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.lastOpened.items', '{not json');
		expect(loadLastOpenedId(scope, 'items', storage)).toBeNull();
	});
});

describe('noteLastEditedRecord / takeLastEditedRecord', () => {
	it('round-trips id/values for a resource', () => {
		const storage = makeMemoryStorage();
		noteLastEditedRecord(scope, 'items', { id: 7, values: { name: 'tea', price: 300 } }, storage);
		expect(takeLastEditedRecord(scope, 'items', storage)).toEqual({
			id: 7,
			values: { name: 'tea', price: 300 }
		});
	});

	it('is one-shot: a second take (without a new note) returns null', () => {
		const storage = makeMemoryStorage();
		noteLastEditedRecord(scope, 'items', { id: 7, values: { name: 'tea' } }, storage);
		takeLastEditedRecord(scope, 'items', storage);
		expect(takeLastEditedRecord(scope, 'items', storage)).toBeNull();
	});

	it('returns null when nothing was noted', () => {
		expect(takeLastEditedRecord(scope, 'items', makeMemoryStorage())).toBeNull();
	});

	it('keeps different resources independent', () => {
		const storage = makeMemoryStorage();
		noteLastEditedRecord(scope, 'items', { id: 1, values: {} }, storage);
		noteLastEditedRecord(scope, 'users', { id: 2, values: {} }, storage);
		expect(takeLastEditedRecord(scope, 'items', storage)?.id).toBe(1);
		expect(takeLastEditedRecord(scope, 'users', storage)?.id).toBe(2);
	});

	it('ignores a malformed payload rather than throwing', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.lastEdited.items', '{not json');
		expect(takeLastEditedRecord(scope, 'items', storage)).toBeNull();
	});
});

// Issue #215/#255 review (P2): a second identity signing into the same tab
// must not inherit the first identity's saved list state.
describe('clearAllListViewState', () => {
	it('removes every banto.listView.* key: snapshots (any resource/mode), active mode, last-opened-id, last-edited-record', () => {
		const storage = makeMemoryStorage();
		saveListViewState(scope, 'items:server', { sort: [], filters: [] }, storage);
		saveListViewState(scope, 'items:client', { sort: [], filters: [] }, storage);
		saveListViewState(scope, 'users:server', { sort: [], filters: [] }, storage);
		saveActiveListMode(scope, 'items', 'client', storage);
		saveLastOpenedId(scope, 'items', 42, storage);
		noteLastEditedRecord(scope, 'items', { id: 1, values: {} }, storage);

		clearAllListViewState(storage);

		expect(loadListViewState(scope, 'items:server', undefined, storage)).toBeNull();
		expect(loadListViewState(scope, 'items:client', undefined, storage)).toBeNull();
		expect(loadListViewState(scope, 'users:server', undefined, storage)).toBeNull();
		expect(loadActiveListMode(scope, 'items', storage)).toBeNull();
		expect(loadLastOpenedId(scope, 'items', storage)).toBeNull();
		expect(takeLastEditedRecord(scope, 'items', storage)).toBeNull();
	});

	it('never touches keys outside the banto.listView. namespace', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.auth.token', 'user-a-token');
		storage.setItem('banto.ui.theme.mode', 'dark');
		saveListViewState(scope, 'items:server', { sort: [], filters: [] }, storage);

		clearAllListViewState(storage);

		expect(storage.getItem('banto.auth.token')).toBe('user-a-token');
		expect(storage.getItem('banto.ui.theme.mode')).toBe('dark');
	});

	it('is a no-op (never throws) when nothing was ever saved', () => {
		expect(() => clearAllListViewState(makeMemoryStorage())).not.toThrow();
	});

	it('resolveStorage(null) no-ops', () => {
		expect(() => clearAllListViewState(null)).not.toThrow();
	});
});

// Issue #215/#255 4th review (P2 1): the tab's identity can change behind
// its back (another tab's "Remember me" login, a reload) - state saved for
// one owner must never be handed to another, whatever path changed it.
describe('owner matching (#255 4th review)', () => {
	it('A saves -> B (confirmed by beginSession) restores nothing, from any function', () => {
		const storage = makeMemoryStorage();
		saveListViewState(scope, 'items:server', { sort: [], filters: [] }, storage);
		saveActiveListMode(scope, 'items', 'client', storage);
		saveLastOpenedId(scope, 'items', 42, storage);
		noteLastEditedRecord(scope, 'items', { id: 42, values: {} }, storage);

		beginSession(BOB);
		const bob = currentSessionScope();
		expect(loadListViewState(bob, 'items:server', undefined, storage)).toBeNull();
		expect(loadActiveListMode(bob, 'items', storage)).toBeNull();
		expect(loadLastOpenedId(bob, 'items', storage)).toBeNull();
		expect(takeLastEditedRecord(bob, 'items', storage)).toBeNull();
	});

	it('the SAME owner restores its own state, even across a new session generation (reload / re-login)', () => {
		const storage = makeMemoryStorage();
		saveListViewState(
			scope,
			'items:server',
			{ sort: [{ field: 'price', direction: 'asc' }], filters: [] },
			storage
		);
		saveLastOpenedId(scope, 'items', 7, storage);

		// Like a page reload: no owner until the guard confirms ALICE again.
		endSession();
		beginSession({ ...ALICE });
		const again = currentSessionScope();
		expect(again.generation).not.toBe(scope.generation);
		expect(loadListViewState(again, 'items:server', undefined, storage)?.sort).toEqual([
			{ field: 'price', direction: 'asc' }
		]);
		expect(loadLastOpenedId(again, 'items', storage)).toBe(7);
	});

	it('a real account whose id is "public" and the synthetic public viewer never share state (#209)', () => {
		expect(sessionOwnerKey({ id: 'public', name: 'x' })).not.toBe(
			sessionOwnerKey({ id: 'public', name: 'x', publicViewer: true })
		);
		const storage = makeMemoryStorage();
		beginSession({ id: 'public', name: 'admin named public' });
		const account = currentSessionScope();
		saveLastOpenedId(account, 'items', 1, storage);

		beginSession({ id: 'public', name: 'viewer', publicViewer: true });
		const viewer = currentSessionScope();
		expect(viewer.generation).not.toBe(account.generation);
		expect(loadLastOpenedId(viewer, 'items', storage)).toBeNull();
	});

	it('an entry without an owner envelope (legacy/hand-written) is never restored', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.items:server', JSON.stringify({ sort: [], filters: [] }));
		storage.setItem('banto.listView.lastOpened.items', JSON.stringify(42));
		expect(loadListViewState(scope, 'items:server', undefined, storage)).toBeNull();
		expect(loadLastOpenedId(scope, 'items', storage)).toBeNull();
	});

	describe('no confirmed owner: nothing is saved or restored (fail closed)', () => {
		it.each([
			['before any beginSession / after endSession', () => endSession()],
			['identity null (provider cannot say who)', () => beginSession(null)],
			['identity without an id', () => beginSession({ id: '', name: 'nobody' })]
		])('%s', (_label, enter) => {
			const storage = makeMemoryStorage();
			saveLastOpenedId(scope, 'items', 42, storage);
			enter();
			const ownerless = currentSessionScope();
			expect(ownerless.owner).toBeNull();
			expect(loadLastOpenedId(ownerless, 'items', storage)).toBeNull();

			saveListViewState(ownerless, 'items:server', { sort: [], filters: [] }, storage);
			saveLastOpenedId(ownerless, 'users', 1, storage);
			expect(storage.getItem('banto.listView.items:server')).toBeNull();
			expect(storage.getItem('banto.listView.lastOpened.users')).toBeNull();
		});
	});
});

// Issue #215/#255 4th review (P2 2): a screen built for one session
// generation (e.g. a list page SvelteKit kept alive across invalidateAll())
// must not write its in-memory state back once the session moved on.
describe('writes from a stale scope are refused (#255 4th review)', () => {
	it.each([
		['the session ended', () => endSession()],
		['the owner changed', () => beginSession(BOB)],
		[
			'ended and began again as the SAME owner (new generation)',
			() => {
				endSession();
				beginSession(ALICE);
			}
		]
	])('%s', (_label, move) => {
		const storage = makeMemoryStorage();
		const stale = scope;
		move();
		expect(isCurrentSessionScope(stale)).toBe(false);

		saveListViewState(
			stale,
			'items:server',
			{ sort: [], filters: [{ field: 'name', op: 'contains', value: 'old search' }] },
			storage
		);
		saveActiveListMode(stale, 'items', 'client', storage);
		saveLastOpenedId(stale, 'items', 42, storage);
		noteLastEditedRecord(stale, 'items', { id: 42, values: {} }, storage);
		expect(storage.length).toBe(0);
	});

	it("a stale scope neither reads nor consumes the live session's last-edited marker", () => {
		const storage = makeMemoryStorage();
		const stale = scope;
		endSession();
		beginSession(ALICE);
		const live = currentSessionScope();
		noteLastEditedRecord(live, 'items', { id: 3, values: {} }, storage);

		expect(takeLastEditedRecord(stale, 'items', storage)).toBeNull();
		expect(takeLastEditedRecord(live, 'items', storage)?.id).toBe(3);
	});

	it('a guard re-run confirming the SAME owner keeps the generation (screens stay writable)', () => {
		const before = sessionGeneration();
		beginSession({ ...ALICE });
		expect(sessionGeneration()).toBe(before);
		expect(isCurrentSessionScope(scope)).toBe(true);
	});

	it('currentSessionScope() is a frozen snapshot', () => {
		expect(Object.isFrozen(scope)).toBe(true);
	});
});

// Hygiene on top of the owner check: the GLOBAL sessionStorage is tidied by
// beginSession (another owner's entries) and endSession (everything).
describe('beginSession / endSession tidy the global sessionStorage', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("beginSession(B) removes A's entries; beginSession(A) again keeps them", () => {
		const storage = makeMemoryStorage();
		vi.stubGlobal('sessionStorage', storage);
		saveLastOpenedId(scope, 'items', 42);

		beginSession({ ...ALICE });
		expect(storage.getItem('banto.listView.lastOpened.items')).not.toBeNull();

		beginSession(BOB);
		expect(storage.getItem('banto.listView.lastOpened.items')).toBeNull();
	});

	it('endSession removes every entry', () => {
		const storage = makeMemoryStorage();
		vi.stubGlobal('sessionStorage', storage);
		saveLastOpenedId(scope, 'items', 42);
		endSession();
		expect(storage.length).toBe(0);
	});
});

describe('purgeListViewStateNotOwnedBy', () => {
	it("keeps only the given owner's entries (and never touches other namespaces)", () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.auth.token', 'token');
		storage.setItem('banto.listView.items:server', owned({ sort: [], filters: [] }, 'account:bob'));
		storage.setItem(
			'banto.listView.items:client',
			owned({ sort: [], filters: [] }, 'account:alice')
		);
		storage.setItem('banto.listView.lastOpened.items', JSON.stringify(42));
		storage.setItem('banto.listView.mode.items', '{not json');

		purgeListViewStateNotOwnedBy('account:alice', storage);

		expect(storage.getItem('banto.listView.items:client')).not.toBeNull();
		expect(storage.getItem('banto.listView.items:server')).toBeNull();
		expect(storage.getItem('banto.listView.lastOpened.items')).toBeNull();
		expect(storage.getItem('banto.listView.mode.items')).toBeNull();
		expect(storage.getItem('banto.auth.token')).toBe('token');
	});

	it('owner null drops every entry', () => {
		const storage = makeMemoryStorage();
		storage.setItem(
			'banto.listView.items:client',
			owned({ sort: [], filters: [] }, 'account:alice')
		);
		purgeListViewStateNotOwnedBy(null, storage);
		expect(storage.length).toBe(0);
	});
});
