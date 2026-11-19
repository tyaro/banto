/**
 * dockLayoutStore.svelte.ts (three-pane-dock-plan §4.4, #663 段階 ④ PR-5): the
 * dashboard's layout save, bound to the signed-in user and the session. The page
 * wiring (effects) is covered by the dashboard e2e.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionScope, UiSettingsProvider } from '@banto/admin-core';
import { createDockState, type DockLayout } from '@banto/dock-svelte';
import { createDockLayoutStore, type DockLayoutStoreOptions } from './dockLayoutStore.svelte';

const STORAGE_KEY = 'banto.dock.test';
const SETTING_KEY = 'dock.test';

function floating(id: string, x = 10): DockLayout {
	return {
		version: 2,
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
	return {
		get: vi.fn(get),
		set: vi.fn(async (_key: string, _value: string) => {})
	} satisfies UiSettingsProvider;
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
	} = {}
) {
	const storage = opts.storage ?? new MemoryStorage();
	const provider = opts.provider ?? fakeProvider();
	const session = fakeSession(opts.owner === undefined ? 'account:1' : opts.owner);
	const dock = createDockState();
	const store = createDockLayoutStore({
		dock,
		storageKey: STORAGE_KEY,
		settingKey: SETTING_KEY,
		provider: () => provider,
		defaultLayout: opts.defaultLayout ?? (() => DEFAULT),
		validate: opts.validate,
		storage,
		scope: session.scope(),
		isCurrent: session.isCurrent
	});
	/** What the page's autosave effect does on every layout change. */
	const report = () => store.changed(dock.serialize());
	return { storage, provider, session, dock, store, report };
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
		storage.setItem(`${STORAGE_KEY}:account:1`, json(floating('mine')));
		const { dock } = setup({ storage });
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['mine']);
	});

	it("never reads another user's copy", () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:account:2`, json(floating('theirs')));
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
		storage.setItem(`${STORAGE_KEY}:account:1`, '{broken');
		const { dock } = setup({ storage });
		expect(dock.layout.floating).toEqual([]);
		expect(storage.getItem(`${STORAGE_KEY}:account:1`)).toBeNull();
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
		expect(storage.getItem(`${STORAGE_KEY}:account:1`)).toBe(dock.serialize());
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
		storage.setItem(`${STORAGE_KEY}:account:1`, json(floating('cached')));
		const provider = fakeProvider(get as () => Promise<string | null>);
		const { dock, store, report } = setup({ storage, provider });
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['cached']);
		await store.load();
		report();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['default']);
		expect(storage.getItem(`${STORAGE_KEY}:account:1`)).toBe(json(DEFAULT));
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
		session.switchTo('account:2');
		read.resolve(json(floating('user1')));
		await loading;
		expect(dock.layout.floating).toEqual([]);
		expect(storage.getItem(`${STORAGE_KEY}:account:1`)).toBeNull();
		expect(storage.getItem(`${STORAGE_KEY}:account:2`)).toBeNull();
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
		expect(storage.getItem(`${STORAGE_KEY}:account:1`)).toBe(json(floating('a', 2)));
		expect(provider.set).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(floating('a', 2)));
	});

	it('does not save the seeded default or the restored first paint', () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:account:1`, json(floating('mine')));
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
		dock.layout = { version: 2, floating: [], docked: null };
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
		session.switchTo('account:2');
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
		session.switchTo('account:2');
		dock.layout = floating('moved');
		report();
		expect(storage.length).toBe(0);
	});

	it('reset restores the default and saves it', () => {
		const storage = new MemoryStorage();
		storage.setItem(`${STORAGE_KEY}:account:1`, json(floating('mine')));
		const { dock, store, provider, report } = setup({ storage });
		report();
		store.reset();
		report();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['default']);
		vi.advanceTimersByTime(500);
		expect(provider.set).toHaveBeenCalledWith(SETTING_KEY, json(DEFAULT));
	});
});
