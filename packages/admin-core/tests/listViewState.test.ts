import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../src/provider';
import {
	clearAllListViewState,
	clearListViewState,
	loadActiveListMode,
	loadLastOpenedId,
	loadListViewState,
	noteLastEditedRecord,
	saveActiveListMode,
	saveLastOpenedId,
	saveListViewState,
	takeLastEditedRecord,
	withListViewStateClearing
} from '../src/listViewState';

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
		saveListViewState('items:server', snapshot, storage);
		expect(loadListViewState('items:server', undefined, storage)).toEqual(snapshot);
	});

	it('returns null when nothing was saved for the key', () => {
		expect(loadListViewState('items:server', undefined, makeMemoryStorage())).toBeNull();
	});

	it('keeps different keys independent (client vs server mode, or a different resource)', () => {
		const storage = makeMemoryStorage();
		saveListViewState('items:client', { sort: [], filters: [], groupBy: 'category' }, storage);
		saveListViewState('items:server', { sort: [], filters: [] }, storage);
		saveListViewState('users:server', { sort: [], filters: [] }, storage);

		expect(loadListViewState('items:client', undefined, storage)?.groupBy).toBe('category');
		expect(loadListViewState('items:server', undefined, storage)?.groupBy).toBeUndefined();
		expect(loadListViewState('users:server', undefined, storage)).toEqual({
			sort: [],
			filters: []
		});
	});

	it('ignores malformed JSON rather than throwing', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.items:server', '{not json');
		expect(loadListViewState('items:server', undefined, storage)).toBeNull();
	});

	it('ignores a payload missing sort/filters arrays', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.listView.items:server', JSON.stringify({ groupBy: 'category' }));
		expect(loadListViewState('items:server', undefined, storage)).toBeNull();
	});

	it('resolveStorage(null) (e.g. SSR/disabled storage) no-ops on save and returns null on load', () => {
		expect(() => saveListViewState('items:server', { sort: [], filters: [] }, null)).not.toThrow();
		expect(loadListViewState('items:server', undefined, null)).toBeNull();
	});

	it('clearListViewState removes a saved snapshot', () => {
		const storage = makeMemoryStorage();
		saveListViewState('items:server', { sort: [], filters: [] }, storage);
		clearListViewState('items:server', storage);
		expect(loadListViewState('items:server', undefined, storage)).toBeNull();
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
				JSON.stringify({ sort: [validSort], filters: [validFilter] })
			);
			expect(loadListViewState('items:server', undefined, storage)).toEqual({
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
				storage.setItem('banto.listView.items:server', JSON.stringify(bad));
				expect(loadListViewState('items:server', undefined, storage)).toBeNull();
			}
		);

		it('a filter value of null/0/false is still valid (falsy but present)', () => {
			const storage = makeMemoryStorage();
			storage.setItem(
				'banto.listView.items:server',
				JSON.stringify({ sort: [], filters: [{ field: 'stock', op: 'eq', value: 0 }] })
			);
			expect(loadListViewState('items:server', undefined, storage)?.filters).toEqual([
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
			expect(loadListViewState('items:server', ['price', 'name'], storage)).toEqual({
				sort: [{ field: 'price', direction: 'desc' }],
				filters: [{ field: 'name', op: 'contains', value: 'tea' }]
			});
		});

		it('every field unknown -> empty (default) sort/filters, snapshot still loads', () => {
			const storage = makeMemoryStorage();
			saveListViewState(
				'items:server',
				{
					sort: [{ field: 'removedColumn', direction: 'asc' }],
					filters: [{ field: 'alsoRemoved', op: 'eq', value: 1 }]
				},
				storage
			);
			expect(loadListViewState('items:server', ['price', 'name'], storage)).toEqual({
				sort: [],
				filters: []
			});
		});

		it('omitting knownFields skips the check entirely (unchanged behavior)', () => {
			const storage = makeMemoryStorage();
			saveListViewState(
				'items:server',
				{ sort: [{ field: 'anyField', direction: 'asc' }], filters: [] },
				storage
			);
			expect(loadListViewState('items:server', undefined, storage)?.sort).toEqual([
				{ field: 'anyField', direction: 'asc' }
			]);
		});
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

// Issue #215/#255 review (P2): a second identity signing into the same tab
// must not inherit the first identity's saved list state.
describe('clearAllListViewState', () => {
	it('removes every banto.listView.* key: snapshots (any resource/mode), active mode, last-opened-id, last-edited-record', () => {
		const storage = makeMemoryStorage();
		saveListViewState('items:server', { sort: [], filters: [] }, storage);
		saveListViewState('items:client', { sort: [], filters: [] }, storage);
		saveListViewState('users:server', { sort: [], filters: [] }, storage);
		saveActiveListMode('items', 'client', storage);
		saveLastOpenedId('items', 42, storage);
		noteLastEditedRecord('items', { id: 1, values: {} }, storage);

		clearAllListViewState(storage);

		expect(loadListViewState('items:server', undefined, storage)).toBeNull();
		expect(loadListViewState('items:client', undefined, storage)).toBeNull();
		expect(loadListViewState('users:server', undefined, storage)).toBeNull();
		expect(loadActiveListMode('items', storage)).toBeNull();
		expect(loadLastOpenedId('items', storage)).toBeNull();
		expect(takeLastEditedRecord('items', storage)).toBeNull();
	});

	it('never touches keys outside the banto.listView. namespace', () => {
		const storage = makeMemoryStorage();
		storage.setItem('banto.auth.token', 'user-a-token');
		storage.setItem('banto.ui.theme.mode', 'dark');
		saveListViewState('items:server', { sort: [], filters: [] }, storage);

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

describe('withListViewStateClearing', () => {
	// The wrapper's `clearAllListViewState()` calls default to the global
	// `sessionStorage` (same DI convention as every other function here,
	// but these specific calls are internal to the wrapper - there's no
	// `storage` parameter to pass through), so these tests stub the global
	// for their duration instead.
	let storage: Storage;

	beforeEach(() => {
		storage = makeMemoryStorage();
		vi.stubGlobal('sessionStorage', storage);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function makeAuthProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
		return {
			login: async () => ({ success: true }),
			logout: async () => {},
			check: async () => true,
			getIdentity: async () => null,
			...overrides
		};
	}

	function primeState(): void {
		saveListViewState(
			'items:server',
			{ sort: [{ field: 'price', direction: 'desc' }], filters: [] },
			storage
		);
		saveLastOpenedId('items', 42, storage);
	}

	it('logout clears list view state after the underlying logout resolves', async () => {
		primeState();
		let logoutCalled = false;
		const provider = withListViewStateClearing(
			makeAuthProvider({
				logout: async () => {
					logoutCalled = true;
				}
			})
		);
		await provider.logout();
		expect(logoutCalled).toBe(true);
		expect(loadLastOpenedId('items', storage)).toBeNull();
	});

	it('logout clears even when the underlying logout rejects (still "done with this tab")', async () => {
		primeState();
		const provider = withListViewStateClearing(
			makeAuthProvider({
				logout: async () => {
					throw new Error('network error');
				}
			})
		);
		await expect(provider.logout()).rejects.toThrow('network error');
		expect(loadLastOpenedId('items', storage)).toBeNull();
	});

	it('a successful login clears the PREVIOUS identity state', async () => {
		primeState();
		const provider = withListViewStateClearing(
			makeAuthProvider({ login: async () => ({ success: true }) })
		);
		await provider.login({ username: 'b', password: 'x' });
		expect(loadLastOpenedId('items', storage)).toBeNull();
	});

	it('a FAILED login does not clear anything (no identity actually changed)', async () => {
		primeState();
		const provider = withListViewStateClearing(
			makeAuthProvider({ login: async () => ({ success: false, error: 'bad password' }) })
		);
		await provider.login({ username: 'a', password: 'wrong' });
		expect(loadLastOpenedId('items', storage)).toBe(42);
	});

	it('a successful setup() (first-run account creation) clears', async () => {
		primeState();
		const provider = withListViewStateClearing(
			makeAuthProvider({ setup: async () => ({ success: true }) })
		);
		await provider.setup?.({ username: 'admin', password: 'x' });
		expect(loadLastOpenedId('items', storage)).toBeNull();
	});

	it('a successful enterPublicViewer() clears', async () => {
		primeState();
		const provider = withListViewStateClearing(
			makeAuthProvider({ enterPublicViewer: async () => true })
		);
		await provider.enterPublicViewer?.();
		expect(loadLastOpenedId('items', storage)).toBeNull();
	});

	it('a FAILED enterPublicViewer() does not clear', async () => {
		primeState();
		const provider = withListViewStateClearing(
			makeAuthProvider({ enterPublicViewer: async () => false })
		);
		await provider.enterPublicViewer?.();
		expect(loadLastOpenedId('items', storage)).toBe(42);
	});

	it('other methods (check/getIdentity) pass through unchanged', async () => {
		const provider = withListViewStateClearing(
			makeAuthProvider({
				check: async () => false,
				getIdentity: async () => ({ id: 'x', name: 'x' })
			})
		);
		await expect(provider.check()).resolves.toBe(false);
		await expect(provider.getIdentity()).resolves.toEqual({ id: 'x', name: 'x' });
	});

	it('omits setup/enterPublicViewer on the wrapper when absent on the original (optional methods stay optional)', () => {
		const provider = withListViewStateClearing(makeAuthProvider());
		expect(provider.setup).toBeUndefined();
		expect(provider.enterPublicViewer).toBeUndefined();
	});

	it('accepts an explicit onTransition callback in place of the clearAllListViewState default', async () => {
		const onTransition = vi.fn();
		const provider = withListViewStateClearing(makeAuthProvider(), onTransition);
		await provider.login({ username: 'a', password: 'x' });
		await provider.logout();
		expect(onTransition).toHaveBeenCalledTimes(2);
	});

	// #255 review (fix 1): `{ ...provider }` only copies OWN enumerable
	// properties - a class instance's methods live on its PROTOTYPE, so they
	// were silently dropped and calling them threw. A regression test with an
	// actual class, not just an object literal.
	describe('preserves a class-based AuthProvider (fix 1 of #255 review)', () => {
		class ClassAuthProvider implements AuthProvider {
			signedIn = false;
			async login(): Promise<{ success: boolean }> {
				this.signedIn = true;
				return { success: true };
			}
			async logout(): Promise<void> {
				this.signedIn = false;
			}
			async check(): Promise<boolean> {
				return this.signedIn;
			}
			async getIdentity() {
				return this.signedIn ? { id: 'a', name: 'a' } : null;
			}
		}

		it('prototype methods (check/getIdentity) are callable at all (previously threw)', async () => {
			const provider = withListViewStateClearing(new ClassAuthProvider());
			await expect(provider.check()).resolves.toBe(false);
			await expect(provider.getIdentity()).resolves.toBeNull();
		});

		it('this-based shared state survives a login -> check round trip through the wrapper', async () => {
			const provider = withListViewStateClearing(new ClassAuthProvider());
			await expect(provider.check()).resolves.toBe(false);
			await provider.login({ username: 'a', password: 'x' });
			// Before the fix: `login()` (wrapped, delegates to the real
			// instance) sets `this.signedIn = true` on the REAL instance, but
			// a naive `{ ...provider }` copy's `check` - invoked as
			// `wrapper.check()` - runs with `this === wrapper`, which never
			// got `signedIn` set, so this incorrectly resolved `false`.
			await expect(provider.check()).resolves.toBe(true);
			await expect(provider.getIdentity()).resolves.toEqual({ id: 'a', name: 'a' });
			await provider.logout();
			await expect(provider.check()).resolves.toBe(false);
		});
	});

	// #255 review (fix 1): a plain OBJECT (not a class) whose methods share
	// state via `this` has the identical failure mode - `login`/`check` here
	// are two different functions on the same object, not a class's methods,
	// but the wrapper must still resolve `this` to the real object for both.
	it('preserves this-based shared state on a plain object AuthProvider (fix 1 of #255 review)', async () => {
		const rawProvider = {
			signedIn: false,
			login: async function (this: { signedIn: boolean }) {
				this.signedIn = true;
				return { success: true };
			},
			logout: async function (this: { signedIn: boolean }) {
				this.signedIn = false;
			},
			check: async function (this: { signedIn: boolean }) {
				return this.signedIn;
			},
			getIdentity: async () => null
		};
		const provider = withListViewStateClearing(rawProvider as unknown as AuthProvider);
		await expect(provider.check()).resolves.toBe(false);
		await provider.login({});
		await expect(provider.check()).resolves.toBe(true);
	});

	it('an unknown/custom method (not part of AuthProvider) still resolves this to the real provider', async () => {
		const rawProvider = {
			login: async () => ({ success: true }),
			logout: async () => {},
			check: async () => true,
			getIdentity: async () => null,
			label: 'real',
			whoAmI(this: { label: string }) {
				return this.label;
			}
		};
		const provider = withListViewStateClearing(rawProvider as unknown as AuthProvider);
		expect((provider as unknown as { whoAmI(): string }).whoAmI()).toBe('real');
	});
});
