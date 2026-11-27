/**
 * layoutStore.ts (three-pane-dock-plan §4.4; downstream-requests-2026-11-plan §4.6, #791 K4):
 * saving a layout from what `onLayoutCommit` reports - bound to the signed-in user and the
 * session when the app gives a `scope`, one key with no owner when it does not. The wiring to a
 * real `DockHost` is in `DockHostLayoutStore.test.ts`; the pages' in the dashboard e2e.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createDockLayoutStore,
	createDockState,
	type DockLayout,
	type DockLayoutSettings,
	type DockLayoutStoreOptions
} from '../src/index';

/** admin-core's `SessionScope`, by shape. */
type SessionScope = { readonly generation: number; readonly owner: string | null };

const STORAGE_KEY = 'banto.dock.test';
const SETTING_KEY = 'dock.test';

function floating(id: string, x = 10): DockLayout {
	return {
		version: 4,
		floating: [{ id, title: id, x, y: 10, width: 100, height: 80, open: true }],
		docked: null
	};
}

const DEFAULT = floating('default');
const json = (layout: DockLayout) => JSON.stringify(layout);

class MemoryStorage implements Storage {
	#map = new Map<string, string>();
	get length() {
		return this.#map.size;
	}
	clear() {
		this.#map.clear();
	}
	getItem(key: string) {
		return this.#map.get(key) ?? null;
	}
	key(index: number) {
		return [...this.#map.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.#map.delete(key);
	}
	setItem(key: string, value: string) {
		this.#map.set(key, value);
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fakeProvider(get: () => Promise<string | null> = async () => null) {
	// The provider's #786 shape: `{ value, revision }` / `{ revision }`.
	return {
		get: vi.fn(async (_key: string) => {
			const value = await get();
			return { value, revision: value === null ? '0' : 'rev' };
		}),
		set: vi.fn(async (_key: string, _value: string) => ({ revision: 'rev' })),
		remove: vi.fn(async (_key: string) => ({ revision: '0' }))
	} satisfies DockLayoutSettings;
}

/** A session whose owner/generation the test can switch. */
function fakeSession(owner: string | null) {
	let live: SessionScope = { generation: 1, owner } as SessionScope;
	return {
		scope: () => live,
		isCurrent: (scope: SessionScope) =>
			scope.generation === live.generation && scope.owner === live.owner,
		switchTo(next: string | null) {
			live = { generation: live.generation + 1, owner: next } as SessionScope;
		}
	};
}

function setup(
	opts: {
		owner?: string | null;
		storage?: Storage;
		provider?: ReturnType<typeof fakeProvider>;
		defaultLayout?: () => DockLayout | null;
		validate?: DockLayoutStoreOptions['validate'];
		reset?: DockLayoutStoreOptions['reset'];
		beforeBaseline?: (dock: ReturnType<typeof createDockState>) => void;
	} = {}
) {
	const storage = opts.storage ?? new MemoryStorage();
	const provider = opts.provider ?? fakeProvider();
	const session = fakeSession(opts.owner === undefined ? 'acct:1' : opts.owner);
	const dock = createDockState();
	const store = createDockLayoutStore({
		dock,
		storageKey: STORAGE_KEY,
		settingKey: SETTING_KEY,
		provider: () => provider,
		defaultLayout: opts.defaultLayout ?? (() => DEFAULT),
		validate: opts.validate,
		reset: opts.reset,
		beforeBaseline: opts.beforeBaseline && (() => opts.beforeBaseline!(dock)),
		storage,
		scope: session.scope(),
		isCurrent: session.isCurrent
	});
	/** What a `DockHost` reports at a settle point (`onLayoutCommit`, `'user'`). */
	const report = () => store.commit(JSON.parse(dock.serialize()), 'user');
	/** "Reset layout": the host put the default in (`replaceLayout`, `commit: 'reset'`) and reports it. */
	const reset = () => {
		dock.layout = DEFAULT;
		store.commit(JSON.parse(dock.serialize()), 'reset');
	};
	return { storage, provider, session, dock, store, report, reset };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('first paint (local copy)', () => {
	it("draws the owner's own copy", () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:acct:1`, json(floating('mine')));
		const { dock } = setup({ storage });
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['mine']);
	});

	it("never reads another user's copy", () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:acct:2`, json(floating('theirs')));
		const { dock } = setup({ storage });
		expect(dock.layout.floating).toEqual([]);
	});

	it('removes and ignores the old ownerless copy', () => {
		const storage = new MemoryStorage();
		storage.setItem(STORAGE_KEY, json(floating('old')));
		const { dock } = setup({ storage });
		expect(dock.layout.floating).toEqual([]);
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('uses no copy without a confirmed owner (reads nothing, writes nothing)', () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:null`, json(floating('x')));
		const { dock, store, report } = setup({ storage, owner: null });
		expect(dock.layout.floating).toEqual([]);
		store.seedIfEmpty();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['default']);
		dock.layout = floating('moved');
		report();
		expect(storage.length).toBe(1); // only the untouched `:null` entry
	});

	it('drops a rejected copy', () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:acct:1`, '{broken');
		const { dock } = setup({ storage });
		expect(dock.layout.floating).toEqual([]);
		expect(storage.getItem(`${STORAGE_KEY}:acct:1`)).toBeNull();
	});
});

describe('provider read', () => {
	it('applies the saved layout, refreshes the copy and does not echo it back', async () => {
		const provider = fakeProvider(async () => json(floating('remote')));
		const { dock, store, storage, report } = setup({ provider });
		await store.load();
		report();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['remote']);
		expect(provider.get).toHaveBeenCalledWith(SETTING_KEY);
		expect(storage.getItem(`${STORAGE_KEY}:acct:1`)).toBe(dock.serialize());
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
	});

	it('wins over a move made before it answered (and drops that pending write)', async () => {
		const read = deferred<string | null>();
		const provider = fakeProvider(() => read.promise);
		const { dock, store, report } = setup({ provider });
		const loading = store.load();
		dock.layout = floating('moved');
		report();
		read.resolve(json(floating('remote')));
		await loading;
		report();
		vi.runAllTimers();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['remote']);
		expect(provider.set).not.toHaveBeenCalled();
	});

	it.each([
		['null', async () => null],
		[
			'an error',
			async () => {
				throw new Error('offline');
			}
		],
		['a rejected value', async () => '{"version":99}']
	])('restores the default on %s, not the local copy', async (_label, get) => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:acct:1`, json(floating('cached')));
		const provider = fakeProvider(get as () => Promise<string | null>);
		const { dock, store, report } = setup({ storage, provider });
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['cached']);
		await store.load();
		report();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['default']);
		expect(storage.getItem(`${STORAGE_KEY}:acct:1`)).toBe(json(DEFAULT));
		vi.runAllTimers();
		// The restored default is not a user change: nothing is written over the provider.
		expect(provider.set).not.toHaveBeenCalled();
	});

	it('runs the validate hook (repair or reject)', async () => {
		const provider = fakeProvider(async () => 'raw');
		const validate = vi.fn((raw: string) => (raw === 'raw' ? json(floating('repaired')) : null));
		const { dock, store } = setup({ provider, validate });
		await store.load();
		expect(validate).toHaveBeenCalledWith('raw');
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['repaired']);
	});

	it('drops a result that returns after the user changed', async () => {
		const read = deferred<string | null>();
		const provider = fakeProvider(() => read.promise);
		const { dock, store, session, storage } = setup({ provider });
		const loading = store.load();
		session.switchTo('acct:2');
		read.resolve(json(floating('user1')));
		await loading;
		expect(dock.layout.floating).toEqual([]);
		expect(storage.getItem(`${STORAGE_KEY}:acct:1`)).toBeNull();
		expect(storage.getItem(`${STORAGE_KEY}:acct:2`)).toBeNull();
	});

	it('drops a result that returns after unmount', async () => {
		const read = deferred<string | null>();
		const provider = fakeProvider(() => read.promise);
		const { dock, store } = setup({ provider });
		const loading = store.load();
		store.dispose();
		read.resolve(json(floating('late')));
		await loading;
		expect(dock.layout.floating).toEqual([]);
	});

	it('seeds the default later when the host was not measured when the read answered', async () => {
		let measured = false;
		const { dock, store } = setup({ defaultLayout: () => (measured ? DEFAULT : null) });
		await store.load();
		expect(dock.layout.floating).toEqual([]);
		measured = true;
		store.seedIfEmpty();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['default']);
	});
});

describe('saving', () => {
	it('mirrors to the copy at once and writes the provider once, debounced', () => {
		const { dock, store, storage, provider, report } = setup();
		store.seedIfEmpty();
		report();
		dock.layout = floating('a', 1);
		report();
		dock.layout = floating('a', 2);
		report();
		expect(storage.getItem(`${STORAGE_KEY}:acct:1`)).toBe(json(floating('a', 2)));
		expect(provider.set).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('a', 2)));
	});

	it('does not save the seeded default or the restored first paint', () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:acct:1`, json(floating('mine')));
		const { store, provider, report } = setup({ storage });
		report();
		store.seedIfEmpty();
		report();
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
	});

	it('seeds only once: a panel the user removed stays removed', () => {
		const { dock, store } = setup();
		store.seedIfEmpty();
		dock.layout = { version: 4, floating: [], docked: null };
		store.seedIfEmpty();
		expect(dock.layout.floating).toEqual([]);
	});

	it('flushes a pending write on unmount', () => {
		const { dock, store, provider, report } = setup();
		dock.layout = floating('moved');
		report();
		store.dispose();
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('moved')));
		vi.runAllTimers();
		expect(provider.set).toHaveBeenCalledTimes(1);
	});

	it('drops a pending write when the user changes during the debounce', () => {
		const { dock, provider, session, report } = setup();
		dock.layout = floating('moved');
		report();
		session.switchTo('acct:2');
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
	});

	it('drops the unmount flush when the session changed with it', () => {
		const { dock, store, provider, session, report } = setup();
		dock.layout = floating('moved');
		report();
		session.switchTo(null);
		store.dispose();
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
	});

	it("does not write a stale session's layout into any copy", () => {
		const { dock, storage, session, report } = setup();
		session.switchTo('acct:2');
		dock.layout = floating('moved');
		report();
		expect(storage.length).toBe(0);
	});

	it("a reported 'reset' saves the default, once", () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:acct:1`, json(floating('mine')));
		const { provider, report, reset } = setup({ storage });
		report();
		reset();
		expect(storage.getItem(`${STORAGE_KEY}:acct:1`)).toBe(json(DEFAULT));
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(DEFAULT));
		expect(provider.remove).not.toHaveBeenCalled();
	});

	it('saves an explicit reset even when the default is already shown (read failed)', async () => {
		const provider = fakeProvider(async () => {
			throw new Error('offline');
		});
		const { dock, store, report, reset } = setup({ provider });
		await store.load();
		report();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['default']);
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
		reset();
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(DEFAULT));
	});
});

describe("reset: 'remove'", () => {
	it('deletes the saved value and the local copy instead of saving the default', () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:acct:1`, json(floating('mine')));
		const { dock, provider, report, reset } = setup({ storage, reset: 'remove' });
		dock.layout = floating('moved');
		report();
		// The reset replaces the write still pending.
		reset();
		expect(storage.getItem(`${STORAGE_KEY}:acct:1`)).toBeNull();
		expect(provider.remove).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);
		expect(provider.remove).toHaveBeenCalledTimes(1);
		expect(provider.remove).toHaveBeenCalledWith(SETTING_KEY);
		expect(provider.set).not.toHaveBeenCalled();
	});

	it('a change after the reset is saved again (and replaces a deletion not sent yet)', () => {
		const { dock, provider, report, reset } = setup({ reset: 'remove' });
		reset();
		dock.layout = floating('after');
		report();
		vi.advanceTimersByTime(500);
		expect(provider.remove).not.toHaveBeenCalled();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('after')));
	});

	it('is flushed on unmount, and dropped when the session changed', () => {
		const first = setup({ reset: 'remove' });
		first.reset();
		first.store.dispose();
		expect(first.provider.remove).toHaveBeenCalledTimes(1);
		const second = setup({ reset: 'remove' });
		second.reset();
		second.session.switchTo('acct:2');
		second.store.dispose();
		vi.runAllTimers();
		expect(second.provider.remove).not.toHaveBeenCalled();
	});

	it('saves the default when the provider has no remove', () => {
		const provider = fakeProvider();
		const dock = createDockState();
		const storage = new MemoryStorage();
		const store = createDockLayoutStore({
			dock,
			storageKey: STORAGE_KEY,
			settingKey: SETTING_KEY,
			provider: () => ({ get: provider.get, set: provider.set }),
			defaultLayout: () => DEFAULT,
			reset: 'remove',
			storage
		});
		dock.layout = DEFAULT;
		store.commit(JSON.parse(dock.serialize()), 'reset');
		expect(storage.getItem(STORAGE_KEY)).toBe(json(DEFAULT));
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(DEFAULT));
	});
});

describe('commit', () => {
	it('works unbound (passed as `onLayoutCommit`) and takes the JSON text as is', () => {
		const { provider, store } = setup();
		const { commit } = store;
		commit(json(floating('text')), 'user');
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('text')));
	});

	it("saves a 'narrow-switch' like a user's change", () => {
		const { provider, store } = setup();
		store.commit({ schema: 1, panels: [], layout: DEFAULT }, 'narrow-switch');
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledWith(
			SETTING_KEY,
			JSON.stringify({ schema: 1, panels: [], layout: DEFAULT })
		);
	});

	it('a report after dispose (the host unmounts after the page) is sent at once', () => {
		const { dock, provider, store, report } = setup();
		store.dispose();
		dock.layout = floating('last');
		report();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('last')));
		vi.runAllTimers();
		expect(provider.set).toHaveBeenCalledTimes(1);
	});

	it('... but not for a session that is gone', () => {
		const { dock, provider, store, session, report } = setup();
		store.dispose();
		session.switchTo('acct:2');
		dock.layout = floating('last');
		report();
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
	});
});

describe('beforeBaseline', () => {
	it('adjusts the seeded default: the adjusted layout is the baseline, not a change to save', () => {
		const beforeBaseline = vi.fn((dock: ReturnType<typeof createDockState>) => {
			dock.layout = floating('adjusted');
		});
		const { dock, store, provider, report } = setup({ beforeBaseline });
		expect(beforeBaseline).not.toHaveBeenCalled();
		store.seedIfEmpty();
		expect(beforeBaseline).toHaveBeenCalledTimes(1);
		report();
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
		dock.layout = floating('moved');
		report();
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledTimes(1);
	});

	it('runs for the default restored by a read with nothing saved, not for a stored layout', async () => {
		const beforeBaseline = vi.fn();
		const empty = setup({ beforeBaseline });
		await empty.store.load();
		expect(beforeBaseline).toHaveBeenCalledTimes(1);
		const stored = setup({
			beforeBaseline,
			provider: fakeProvider(async () => json(floating('remote')))
		});
		await stored.store.load();
		expect(beforeBaseline).toHaveBeenCalledTimes(1);
	});

	it('is not called for a reset', () => {
		const beforeBaseline = vi.fn();
		const { reset } = setup({ beforeBaseline });
		reset();
		expect(beforeBaseline).not.toHaveBeenCalled();
	});
});

describe('without a scope (one key, no owner)', () => {
	function ownerless(
		opts: { provider?: DockLayoutSettings; storage?: Storage; storageKey?: string | null } = {}
	) {
		const storage = opts.storage ?? new MemoryStorage();
		const provider = opts.provider ?? fakeProvider();
		const dock = createDockState();
		const store = createDockLayoutStore({
			dock,
			...(opts.storageKey === null ? {} : { storageKey: opts.storageKey ?? STORAGE_KEY }),
			settingKey: SETTING_KEY,
			provider: () => provider,
			defaultLayout: () => DEFAULT,
			storage
		});
		const report = () => store.commit(JSON.parse(dock.serialize()), 'user');
		return { storage, provider, dock, store, report };
	}

	it('draws and mirrors the copy at the bare key (it is not removed)', () => {
		const storage = new MemoryStorage();
		storage.setItem(STORAGE_KEY, json(floating('mine')));
		const { dock, report } = ownerless({ storage });
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['mine']);
		dock.layout = floating('moved');
		report();
		expect(storage.getItem(STORAGE_KEY)).toBe(json(floating('moved')));
	});

	it('reads the provider, and saves a change debounced', async () => {
		const provider = fakeProvider(async () => json(floating('remote')));
		const { dock, store, report } = ownerless({ provider });
		await store.load();
		report();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['remote']);
		dock.layout = floating('moved');
		report();
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('moved')));
	});

	it('uses no local copy without a storageKey', async () => {
		const storage = new MemoryStorage();
		const { dock, store, report } = ownerless({ storage, storageKey: null });
		await store.load();
		dock.layout = floating('moved');
		report();
		expect(storage.length).toBe(0);
	});

	it("asks the provider's sessionGuard (taken at creation) instead of isCurrent", async () => {
		let session = 1;
		const base = fakeProvider(async () => json(floating('remote')));
		const provider = {
			...base,
			sessionGuard: () => {
				const captured = session;
				return () => session === captured;
			}
		};
		const { dock, store, report } = ownerless({ provider });
		dock.layout = floating('moved');
		report();
		session = 2;
		vi.runAllTimers();
		expect(provider.set).not.toHaveBeenCalled();
		await store.load();
		expect(provider.get).not.toHaveBeenCalled();
	});
});

describe('a reset while the first read is pending (PR #881 review)', () => {
	it.each(['save', 'remove'] as const)(
		'the read does not bring the old layout back, and the reset is still sent (%s)',
		async (mode) => {
			const read = deferred<string | null>();
			const provider = fakeProvider(() => read.promise);
			const { dock, store, reset } = setup({ provider, reset: mode });
			const loading = store.load();
			reset();
			read.resolve(json(floating('old')));
			await loading;
			expect(dock.layout.floating.map((w) => w.id)).toEqual(['default']);
			vi.advanceTimersByTime(500);
			if (mode === 'remove') {
				expect(provider.remove).toHaveBeenCalledTimes(1);
				expect(provider.set).not.toHaveBeenCalled();
			} else {
				expect(provider.set).toHaveBeenCalledTimes(1);
				expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(DEFAULT));
			}
		}
	);

	it('a plain move made meanwhile still loses to the read', async () => {
		const read = deferred<string | null>();
		const provider = fakeProvider(() => read.promise);
		const { dock, store, report } = setup({ provider });
		const loading = store.load();
		dock.layout = floating('moved');
		report();
		read.resolve(json(floating('remote')));
		await loading;
		vi.runAllTimers();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['remote']);
		expect(provider.set).not.toHaveBeenCalled();
	});
});

describe('a provider swapped in later (PR #881 review)', () => {
	function swapping() {
		let session = 1;
		const plain = fakeProvider();
		const guarded = {
			...fakeProvider(async () => json(floating('remote'))),
			sessionGuard: () => {
				const captured = session;
				return () => session === captured;
			}
		};
		let current: DockLayoutSettings = plain;
		const dock = createDockState();
		const store = createDockLayoutStore({
			dock,
			settingKey: SETTING_KEY,
			provider: () => current,
			defaultLayout: () => DEFAULT
		});
		return {
			plain,
			guarded,
			dock,
			store,
			wire: () => (current = guarded),
			switchSession: () => session++,
			report: () => store.commit(JSON.parse(dock.serialize()), 'user')
		};
	}

	it('a write armed with it is dropped when its session changes', () => {
		const t = swapping();
		t.wire();
		t.dock.layout = floating('moved');
		t.report();
		t.switchSession();
		vi.runAllTimers();
		expect(t.guarded.set).not.toHaveBeenCalled();
		expect(t.plain.set).not.toHaveBeenCalled();
	});

	it('a read started with it is dropped when its session changes', async () => {
		const t = swapping();
		t.wire();
		const loading = t.store.load();
		t.switchSession();
		await loading;
		expect(t.dock.layout.floating).toEqual([]);
	});

	it('a write goes to the provider it was armed for', () => {
		const t = swapping();
		t.dock.layout = floating('moved');
		t.report();
		t.wire();
		vi.runAllTimers();
		expect(t.plain.set).toHaveBeenCalledTimes(1);
		expect(t.guarded.set).not.toHaveBeenCalled();
	});
});

describe('the order of writes (PR #881 review)', () => {
	it('a write waits for the one before it: a slow set never lands after the remove that followed', async () => {
		const first = deferred<void>();
		const calls: string[] = [];
		const provider = {
			get: vi.fn(async () => ({ value: null })),
			set: vi.fn((_key: string, value: string) => {
				calls.push(`set:${value}`);
				return first.promise;
			}),
			remove: vi.fn(async () => {
				calls.push('remove');
			})
		};
		const dock = createDockState();
		const store = createDockLayoutStore({
			dock,
			settingKey: SETTING_KEY,
			provider: () => provider,
			defaultLayout: () => DEFAULT,
			reset: 'remove'
		});
		dock.layout = floating('moved');
		store.commit(JSON.parse(dock.serialize()), 'user');
		vi.advanceTimersByTime(500);
		dock.layout = DEFAULT;
		store.commit(JSON.parse(dock.serialize()), 'reset');
		vi.advanceTimersByTime(500);
		await Promise.resolve();
		expect(calls).toEqual([`set:${json(floating('moved'))}`]);
		first.resolve();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(calls).toEqual([`set:${json(floating('moved'))}`, 'remove']);
	});

	it('a failed write does not hold the next one back', async () => {
		const provider = {
			get: vi.fn(async () => ({ value: null })),
			set: vi
				.fn<(key: string, value: string) => Promise<void>>()
				.mockRejectedValueOnce(new Error('offline'))
				.mockResolvedValue(undefined)
		};
		const dock = createDockState();
		const store = createDockLayoutStore({
			dock,
			settingKey: SETTING_KEY,
			provider: () => provider,
			defaultLayout: () => DEFAULT
		});
		store.commit(json(floating('a')), 'user');
		vi.advanceTimersByTime(500);
		store.commit(json(floating('b')), 'user');
		vi.advanceTimersByTime(500);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(provider.set).toHaveBeenCalledTimes(2);
		expect(provider.set).toHaveBeenLastCalledWith(SETTING_KEY, json(floating('b')));
	});
});

describe('what became of a report (Issue #1019)', () => {
	const flushPromises = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	/** The outcome so far (`undefined` while the promise is pending). */
	function watch(outcome: Promise<string>) {
		const seen: { value?: string } = {};
		void outcome.then((value) => (seen.value = value));
		return seen;
	}

	it("answers 'saved' once the provider took the write, not before", async () => {
		const sent = deferred<{ revision: string }>();
		const provider = fakeProvider();
		provider.set.mockReturnValueOnce(sent.promise);
		const { dock, report } = setup({ provider });
		dock.layout = floating('moved');
		const seen = watch(report());
		vi.advanceTimersByTime(500);
		await flushPromises();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(seen.value).toBeUndefined();
		sent.resolve({ revision: 'rev' });
		await flushPromises();
		expect(seen.value).toBe('saved');
	});

	it("answers 'failed' when the provider rejects or throws, and does not reject itself", async () => {
		const provider = fakeProvider();
		provider.set.mockRejectedValueOnce(new Error('offline'));
		const { dock, report } = setup({ provider });
		dock.layout = floating('moved');
		const rejected = report();
		vi.advanceTimersByTime(500);
		await expect(rejected).resolves.toBe('failed');

		provider.set.mockImplementationOnce(() => {
			throw new Error('no session');
		});
		dock.layout = floating('again');
		const thrown = report();
		vi.advanceTimersByTime(500);
		await expect(thrown).resolves.toBe('failed');
	});

	it('reports within the debounce share the one write and its answer', async () => {
		const { dock, provider, report } = setup();
		dock.layout = floating('moved', 10);
		const first = report();
		vi.advanceTimersByTime(200);
		dock.layout = floating('moved', 99);
		const second = report();
		vi.advanceTimersByTime(500);
		await expect(first).resolves.toBe('saved');
		await expect(second).resolves.toBe('saved');
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('moved', 99)));
	});

	it('the earlier report shares the failure of the write that absorbed it', async () => {
		const provider = fakeProvider();
		provider.set.mockRejectedValueOnce(new Error('offline'));
		const { dock, report } = setup({ provider });
		dock.layout = floating('moved', 10);
		const first = report();
		dock.layout = floating('moved', 99);
		const second = report();
		vi.advanceTimersByTime(500);
		await expect(first).resolves.toBe('failed');
		await expect(second).resolves.toBe('failed');
	});

	it("answers 'unchanged' for the layout the store applied (nothing is sent)", async () => {
		const { provider, report } = setup();
		await expect(report()).resolves.toBe('unchanged');
		vi.advanceTimersByTime(500);
		expect(provider.set).not.toHaveBeenCalled();
	});

	it("answers 'dropped' when the session is gone - at the report, or by the time it is sent", async () => {
		const { dock, provider, session, report } = setup();
		dock.layout = floating('moved');
		const armed = report();
		session.switchTo('acct:2');
		vi.advanceTimersByTime(500);
		await expect(armed).resolves.toBe('dropped');
		dock.layout = floating('later');
		await expect(report()).resolves.toBe('dropped');
		expect(provider.set).not.toHaveBeenCalled();
	});

	it("answers 'dropped' for a write the provider read replaced", async () => {
		const read = deferred<string | null>();
		const provider = fakeProvider(() => read.promise);
		const { dock, store, report } = setup({ provider });
		const loading = store.load();
		dock.layout = floating('moved');
		const outcome = report();
		read.resolve(json(floating('theirs')));
		await loading;
		await expect(outcome).resolves.toBe('dropped');
		vi.advanceTimersByTime(500);
		expect(provider.set).not.toHaveBeenCalled();
	});

	it("a reset with reset: 'remove' answers 'saved' when the deletion landed, 'failed' when not", async () => {
		const provider = fakeProvider();
		const { store } = setup({ provider, reset: 'remove' });
		const removed = store.commit(DEFAULT, 'reset');
		vi.advanceTimersByTime(500);
		await expect(removed).resolves.toBe('saved');
		expect(provider.remove).toHaveBeenCalledTimes(1);

		provider.remove.mockRejectedValueOnce(new Error('offline'));
		const refused = store.commit(DEFAULT, 'reset');
		vi.advanceTimersByTime(500);
		await expect(refused).resolves.toBe('failed');
	});

	it('answers the write flushed by dispose, and one reported after it', async () => {
		const { dock, provider, store, report } = setup();
		dock.layout = floating('moved');
		const pending = report();
		store.dispose();
		await expect(pending).resolves.toBe('saved');
		dock.layout = floating('late');
		await expect(report()).resolves.toBe('saved');
		expect(provider.set).toHaveBeenCalledTimes(2);
	});

	it('a write waiting behind a slow one is answered in its turn', async () => {
		const slow = deferred<{ revision: string }>();
		const provider = fakeProvider();
		provider.set.mockReturnValueOnce(slow.promise);
		const { dock, report } = setup({ provider });
		dock.layout = floating('a');
		const first = watch(report());
		vi.advanceTimersByTime(500);
		dock.layout = floating('b');
		const second = watch(report());
		vi.advanceTimersByTime(500);
		await flushPromises();
		expect(first.value).toBeUndefined();
		expect(second.value).toBeUndefined();
		slow.reject(new Error('timeout'));
		await flushPromises();
		expect(first.value).toBe('failed');
		expect(second.value).toBe('saved');
	});
});
