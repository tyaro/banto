import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionScope, UiSettingsProvider } from '@banto/admin-core';
import type { DockLayout } from '@banto/dock-svelte';
import { createDockLayoutStore } from '#lib/banto/dockLayoutStore.svelte.js';
import { createThreePaneLayoutTarget, type ThreePaneLayoutApi } from './threePaneLayoutTarget.js';

const EMPTY: DockLayout = { version: 2, floating: [], docked: null };
const DEFAULT = { schema: 1, name: 'default' };

function fakeDock(shown: object = DEFAULT) {
	const state = { shown, restored: [] as unknown[] };
	const api: ThreePaneLayoutApi = {
		layoutSnapshot: () => state.shown,
		restoreLayout: (saved) => {
			state.restored.push(saved);
			state.shown = saved === undefined ? DEFAULT : JSON.parse(String(saved));
			return Promise.resolve();
		}
	};
	return { state, api };
}

function make() {
	let current: ThreePaneLayoutApi | undefined;
	const target = createThreePaneLayoutTarget({ layout: EMPTY, autoHidden: [] }, () => current);
	return {
		target,
		mount(api: ThreePaneLayoutApi) {
			current = api;
			target.attach();
		}
	};
}

describe('createThreePaneLayoutTarget', () => {
	it('before the dock is mounted a stored value becomes initialLayout and is what serialize() says', () => {
		const { target } = make();
		expect(target.initialLayout).toBeUndefined();
		expect(target.hydrate('{"schema":1}')).toBe(true);
		expect(target.initialLayout).toBe('{"schema":1}');
		expect(target.serialize()).toBe('{"schema":1}');
	});

	it('rejects a stored value that is not a JSON object', () => {
		const { target } = make();
		expect(target.hydrate('nope')).toBe(false);
		expect(target.hydrate('42')).toBe(false);
		expect(target.hydrate('null')).toBe(false);
		expect(target.initialLayout).toBeUndefined();
	});

	it('after mounting, serialize() is the snapshot text and a stored value is installed with restoreLayout', async () => {
		const { state, api } = fakeDock();
		const { target, mount } = make();
		mount(api);
		expect(target.serialize()).toBe(JSON.stringify(DEFAULT));
		expect(target.hydrate('{"schema":1,"name":"saved"}')).toBe(true);
		// while it is being installed the stored text is the answer (not a user's change)
		expect(target.serialize()).toBe('{"schema":1,"name":"saved"}');
		await Promise.resolve();
		await Promise.resolve();
		expect(state.restored).toEqual(['{"schema":1,"name":"saved"}']);
		expect(target.serialize()).toBe('{"schema":1,"name":"saved"}');
	});

	it('serialize() still reads layoutSnapshot() while a stored value is being installed (keeps the effect dependency)', () => {
		const { api } = fakeDock();
		let reads = 0;
		const counting: ThreePaneLayoutApi = {
			layoutSnapshot: () => (reads++, api.layoutSnapshot()),
			restoreLayout: () => new Promise(() => {})
		};
		const { target, mount } = make();
		mount(counting);
		target.hydrate('{"schema":1,"name":"saved"}');
		reads = 0;
		expect(target.serialize()).toBe('{"schema":1,"name":"saved"}');
		expect(reads).toBe(1);
	});

	it('does not install a stored value that is already what is shown', () => {
		const { state, api } = fakeDock({ schema: 1, name: 'same' });
		const { target, mount } = make();
		mount(api);
		expect(target.hydrate(JSON.stringify({ schema: 1, name: 'same' }))).toBe(true);
		expect(state.restored).toEqual([]);
	});

	it('assigning the default skips the install while the dock still shows the default it started with', () => {
		const { state, api } = fakeDock();
		const { target, mount } = make();
		mount(api);
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual([]);
		state.shown = { schema: 1, name: 'moved' };
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual([undefined]);
	});

	it('a dock that started from a stored value is always re-installed to the default', () => {
		const { state, api } = fakeDock({ schema: 1, name: 'stored' });
		const { target, mount } = make();
		target.hydrate('{"schema":1,"name":"stored"}');
		mount(api);
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual([undefined]);
	});

	it('ignores assignments while withoutApplying runs, and any layout that is not the default', () => {
		const { state, api } = fakeDock();
		const { target, mount } = make();
		mount(api);
		state.shown = { schema: 1, name: 'moved' };
		target.withoutApplying(() => {
			target.layout = target.defaultLayout;
		});
		target.layout = EMPTY;
		expect(state.restored).toEqual([]);
	});
});

/** A dock whose `restoreLayout` finishes when the test says (what lands is reconciled). */
function asyncDock(shown: object) {
	const state = { shown, restored: [] as unknown[] };
	const queue: { finish: () => void; fail: () => void }[] = [];
	const api: ThreePaneLayoutApi = {
		layoutSnapshot: () => state.shown,
		restoreLayout: (saved) => {
			state.restored.push(saved);
			const next = saved === undefined ? DEFAULT : JSON.parse(String(saved));
			return new Promise((resolve, reject) => {
				queue.push({
					finish: () => {
						// reconciled: what lands is never byte-equal to the stored text
						state.shown = { ...next, reconciled: true };
						resolve(undefined);
					},
					fail: () => {
						state.shown = { schema: 1, name: 'half-way' };
						reject(new Error('restore failed'));
					}
				});
			});
		}
	};
	return { state, api, queue };
}

const flushAsync = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createThreePaneLayoutTarget: a layout being applied is never a user change', () => {
	it('freezes serialize() until the last of overlapping installs settles, then reports onApplied once', async () => {
		const { state, api, queue } = asyncDock({ schema: 1, name: 'custom' });
		const { target, mount } = make();
		mount(api);
		const applied = vi.fn();
		target.onApplied!(applied);
		target.hydrate('{"schema":1,"name":"a"}');
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual(['{"schema":1,"name":"a"}', undefined]);
		queue[0].finish();
		await flushAsync();
		expect(target.serialize()).toBe('{"schema":1,"name":"a"}');
		expect(applied).not.toHaveBeenCalled();
		queue[1].finish();
		await flushAsync();
		expect(applied).toHaveBeenCalledTimes(1);
		expect(target.serialize()).toBe(JSON.stringify({ ...DEFAULT, reconciled: true }));
	});

	it('a rejected restore still ends the freeze and reports onApplied', async () => {
		const { api, queue } = asyncDock({ schema: 1, name: 'custom' });
		const { target, mount } = make();
		mount(api);
		const applied = vi.fn();
		target.onApplied!(applied);
		target.hydrate('{"schema":1,"name":"a"}');
		queue[0].fail();
		await flushAsync();
		expect(applied).toHaveBeenCalledTimes(1);
		expect(target.serialize()).toBe(JSON.stringify({ schema: 1, name: 'half-way' }));
	});

	it('a stored value equal to what is shown is still installed while another install is running', () => {
		const { state, api } = asyncDock({ schema: 1, name: 'same' });
		const { target, mount } = make();
		mount(api);
		target.hydrate('{"schema":1,"name":"other"}');
		target.hydrate(JSON.stringify({ schema: 1, name: 'same' }));
		expect(state.restored).toHaveLength(2);
	});

	it('the default is still installed while another install is running, even over the start default', () => {
		const { state, api } = asyncDock(DEFAULT);
		const { target, mount } = make();
		mount(api);
		target.hydrate('{"schema":1,"name":"other"}');
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual(['{"schema":1,"name":"other"}', undefined]);
	});

	it('before mount, attach reports the held value (or the default) as applied', () => {
		const { api } = asyncDock({ schema: 1, name: 'reconciled' });
		const { target, mount } = make();
		const applied = vi.fn();
		target.onApplied!(applied);
		target.hydrate('{"schema":1,"name":"stored"}');
		target.layout = target.defaultLayout;
		expect(target.initialLayout).toBeUndefined();
		mount(api);
		expect(applied).toHaveBeenCalledTimes(1);
		expect(target.serialize()).toBe(JSON.stringify({ schema: 1, name: 'reconciled' }));
	});

	it('withoutApplying answers what is shown, and keeps the freeze of an install still running', () => {
		const { state, api } = asyncDock({ schema: 1, name: 'custom' });
		const { target, mount } = make();
		mount(api);
		target.hydrate('{"schema":1,"name":"a"}');
		state.shown = DEFAULT;
		expect(target.withoutApplying(() => target.serialize())).toBe(JSON.stringify(DEFAULT));
		expect(target.serialize()).toBe('{"schema":1,"name":"a"}');
	});
});

describe('ThreePaneDock + dockLayoutStore: applying a layout never writes to the provider', () => {
	const SCOPE = { generation: 1, owner: 'account:1' } as SessionScope;
	const KEY = 'banto.dock.three-test';

	function memoryStorage(): Storage {
		const map = new Map<string, string>();
		return {
			get length() {
				return map.size;
			},
			clear: () => map.clear(),
			getItem: (k) => map.get(k) ?? null,
			key: (i) => [...map.keys()][i] ?? null,
			removeItem: (k) => void map.delete(k),
			setItem: (k, v) => void map.set(k, v)
		};
	}

	function wire(opts: { local?: object; shown: object; get: () => Promise<string | null> }) {
		const storage = memoryStorage();
		if (opts.local) storage.setItem(`${KEY}:${SCOPE.owner}`, JSON.stringify(opts.local));
		const provider = {
			get: vi.fn(opts.get),
			set: vi.fn(async (_key: string, _value: string) => {})
		} satisfies UiSettingsProvider;
		const dock = asyncDock(opts.shown);
		const { target, mount } = make();
		const store = createDockLayoutStore({
			dock: target,
			storageKey: KEY,
			settingKey: 'dock.three-test',
			provider: () => provider,
			defaultLayout: () => target.defaultLayout,
			storage,
			scope: SCOPE,
			isCurrent: () => true
		});
		/** The page's autosave effect. */
		const report = () => store.changed(target.serialize());
		/** The page's mount effect, then the autosave effect's first run. */
		const start = () => {
			mount(dock.api);
			void store.load();
			report();
		};
		const local = () => storage.getItem(`${KEY}:${SCOPE.owner}`);
		return { ...dock, target, store, provider, report, start, local };
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('the cached custom layout, then a failed read: the default is shown and nothing is written', async () => {
		const custom = { schema: 1, name: 'custom' };
		const w = wire({ local: custom, shown: custom, get: () => Promise.reject(new Error('down')) });
		expect(w.target.initialLayout).toBe(JSON.stringify(custom));
		w.start();
		await flushAsync();
		expect(w.state.restored).toEqual([undefined]);
		w.report();
		w.queue[0].finish();
		await flushAsync();
		w.report();
		await vi.advanceTimersByTimeAsync(2000);
		expect(w.provider.set).not.toHaveBeenCalled();
		expect(w.local()).toBe(JSON.stringify({ ...DEFAULT, reconciled: true }));
	});

	it('a restore that rejects half-way is not written either', async () => {
		const custom = { schema: 1, name: 'custom' };
		const w = wire({ local: custom, shown: custom, get: async () => null });
		w.start();
		await flushAsync();
		w.queue[0].fail();
		await flushAsync();
		w.report();
		await vi.advanceTimersByTimeAsync(2000);
		expect(w.provider.set).not.toHaveBeenCalled();
	});

	it('a provider value reconciled by restoreLayout is not written back', async () => {
		const w = wire({ shown: DEFAULT, get: async () => '{"schema":1,"name":"remote"}' });
		w.start();
		await flushAsync();
		w.report();
		w.queue[0].finish();
		await flushAsync();
		w.report();
		await vi.advanceTimersByTimeAsync(2000);
		expect(w.provider.set).not.toHaveBeenCalled();
		expect(w.local()).toBe(JSON.stringify({ schema: 1, name: 'remote', reconciled: true }));
	});

	it('the cached value reconciled at mount is not written while the read is pending', async () => {
		let answer!: (v: string | null) => void;
		const w = wire({
			local: { schema: 1, name: 'cached' },
			shown: { schema: 1, name: 'cached', repaired: true },
			get: () => new Promise((resolve) => (answer = resolve))
		});
		w.start();
		await vi.advanceTimersByTimeAsync(2000);
		expect(w.provider.set).not.toHaveBeenCalled();
		answer(null);
		await flushAsync();
		w.queue[0].finish();
		await flushAsync();
		w.report();
		await vi.advanceTimersByTimeAsync(2000);
		expect(w.provider.set).not.toHaveBeenCalled();
	});

	it("a user's move after the default landed is still saved, and so is reset", async () => {
		const custom = { schema: 1, name: 'custom' };
		const w = wire({ local: custom, shown: custom, get: async () => null });
		w.start();
		await flushAsync();
		w.queue[0].finish();
		await flushAsync();
		w.report();
		w.state.shown = { schema: 1, name: 'moved' };
		w.report();
		await vi.advanceTimersByTimeAsync(600);
		expect(w.provider.set).toHaveBeenLastCalledWith(
			'dock.three-test',
			'{"schema":1,"name":"moved"}'
		);
		// "Reset layout": the page installed the default itself, then the store saves it.
		w.state.shown = DEFAULT;
		w.target.withoutApplying(() => w.store.reset());
		await vi.advanceTimersByTimeAsync(600);
		expect(w.provider.set).toHaveBeenLastCalledWith('dock.three-test', JSON.stringify(DEFAULT));
		expect(w.state.restored).toEqual([undefined]);
	});

	it('a reset made while an install is running is not swallowed when the install lands', async () => {
		const custom = { schema: 1, name: 'custom' };
		const w = wire({ local: custom, shown: custom, get: async () => null });
		w.start();
		await flushAsync();
		w.state.shown = DEFAULT;
		w.target.withoutApplying(() => w.store.reset());
		w.queue[0].finish();
		await flushAsync();
		w.report();
		await vi.advanceTimersByTimeAsync(600);
		expect(w.provider.set).toHaveBeenCalled();
	});
});
