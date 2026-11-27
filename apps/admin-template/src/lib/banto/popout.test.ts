/**
 * The joint between the dock's saved layout and the pop-out's memory (popout.ts
 * `createLayoutSaveWatch`, Issue #1019): a widget put back into the dock is forgotten only
 * once the layout that has it again is in the provider.
 *
 * The round trip below is the dashboard's wiring without its components: the real
 * `createDockLayoutStore` (`@banto/dock-svelte`) and `createPanelPopOut` (`@banto/admin-core`),
 * a provider and two storages that outlive "a start of the app", and the report a `DockHost`
 * makes at a settle point (`onLayoutCommit`) called by hand. The Tauri side is a `list` that
 * answers no window and a `listen` that never fires.
 *
 * scaffold: removed with the dock (`removeDock`), like popout.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanelPopOut, type PanelPopOutStorage } from '@banto/admin-core';
import { createDockLayoutStore, createDockState, type DockLayout } from '@banto/dock-svelte';
import { createLayoutSaveWatch } from './popout';

const SETTING_KEY = 'dock.test';
const LAYOUT_STORAGE_KEY = 'banto.dock.test';
const OWNER = 'acct:1';

/** One widget, as a floating window: `open: false` is how the dock holds a popped-out one. */
function layout(open: boolean): DockLayout {
	return {
		version: 4,
		floating: [{ id: 'memo', title: 'Memo', x: 10, y: 10, width: 200, height: 120, open }],
		docked: null
	};
}

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

/** What survives a restart: the provider's value, this browser's copies, the pop-out's memory. */
function createWorld(saved: DockLayout, poppedOut: string[]) {
	const state = {
		/** The provider's copy of the layout (the one that counts at a start). */
		value: JSON.stringify(saved) as string | null,
		/** The provider refuses writes while set. */
		offline: false,
		writes: 0,
		popped: [...poppedOut]
	};
	const popOutStorage: PanelPopOutStorage = {
		load: () => [...state.popped],
		save: (ids) => {
			state.popped = [...ids];
		}
	};
	return Object.assign(state, {
		localStorage: new MemoryStorage(),
		provider: {
			get: async () => ({ value: state.value }),
			set: async (_key: string, value: string) => {
				if (state.offline) throw new Error('offline');
				state.writes++;
				state.value = value;
			}
		},
		popOutStorage
	});
}

/** One start of the app for the same user, wired like the dashboard. Fake timers. */
async function startApp(world: ReturnType<typeof createWorld>) {
	const dock = createDockState();
	const dockLayout = createDockLayoutStore({
		dock,
		settingKey: SETTING_KEY,
		storageKey: LAYOUT_STORAGE_KEY,
		provider: () => world.provider,
		defaultLayout: () => layout(true),
		storage: world.localStorage,
		scope: { owner: OWNER },
		isCurrent: () => true
	});
	const layoutSaves = createLayoutSaveWatch();
	/** `DockHost`'s `onLayoutCommit` (the page's `reportLayout`), at a settle point. */
	const report = () => layoutSaves.track(dockLayout.commit(JSON.parse(dock.serialize()), 'user'));
	const restore = vi.fn((id: string) => {
		const saved = layoutSaves.next();
		dock.open(id);
		report();
		return saved;
	});
	const popOut = createPanelPopOut({
		isTauri: () => true,
		// No panel window is open: the app was closed with the window, which went with it.
		invoke: async () => [],
		listen: async () => () => {},
		storage: world.popOutStorage,
		restore
	});
	// The page: read the provider's layout, then connect (which puts back what has no window).
	await dockLayout.load();
	const disconnect = popOut.connect();
	await vi.advanceTimersByTimeAsync(0);
	return {
		dock,
		restore,
		inDock: () => dock.panels.some((row) => row.id === 'memo' && row.visible),
		/** The user closes the widget in the dock (its ✕), and the host reports it. */
		closeWidget: () => {
			dock.close('memo');
			report();
		},
		/** The debounce passes and the provider answers. */
		saveSettles: () => vi.advanceTimersByTimeAsync(600),
		quit: () => {
			disconnect();
			dockLayout.dispose();
		}
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('a widget put back into the dock and the saved layout (Issue #1019)', () => {
	it('comes back again at the next start when the write of the layout that has it was refused', async () => {
		// The layout without the widget is saved (it was out in a window), and the app was closed
		// with that window open.
		const world = createWorld(layout(false), ['memo']);

		// Start 1: the widget goes back into the dock, but the provider refuses the write.
		world.offline = true;
		const first = await startApp(world);
		expect(first.restore).toHaveBeenCalledTimes(1);
		expect(first.inDock()).toBe(true);
		await first.saveSettles();
		expect(world.value).toBe(JSON.stringify(layout(false)));
		// Not forgotten: the saved layout still lacks the widget.
		expect(world.popped).toEqual(['memo']);
		first.quit();

		// Start 2, same user: the provider's old layout wins over this browser's copy - and the
		// memory puts the widget back once more. This time the write lands.
		world.offline = false;
		const second = await startApp(world);
		expect(second.restore).toHaveBeenCalledTimes(1);
		expect(second.inDock()).toBe(true);
		expect(world.popped).toEqual(['memo']);
		await second.saveSettles();
		expect(JSON.parse(world.value!).floating[0].open).toBe(true);
		expect(world.popped).toEqual([]);
		second.quit();

		// Start 3: nothing to put back; the widget is where the saved layout has it.
		const third = await startApp(world);
		expect(third.restore).not.toHaveBeenCalled();
		expect(third.inDock()).toBe(true);
		third.quit();
	});

	it('does not come back once it was saved and the user closed it afterwards', async () => {
		const world = createWorld(layout(false), ['memo']);
		const first = await startApp(world);
		await first.saveSettles();
		expect(world.popped).toEqual([]);
		first.closeWidget();
		await first.saveSettles();
		first.quit();

		const second = await startApp(world);
		expect(second.restore).not.toHaveBeenCalled();
		expect(second.inDock()).toBe(false);
		second.quit();
	});

	it('a later write that lands settles it, with the layout as the user left it', async () => {
		const world = createWorld(layout(false), ['memo']);
		world.offline = true;
		const first = await startApp(world);
		await first.saveSettles();
		expect(world.popped).toEqual(['memo']);

		// Back online; the user closes the widget for good, and that layout is saved.
		world.offline = false;
		first.closeWidget();
		await first.saveSettles();
		expect(world.popped).toEqual([]);
		first.quit();

		const second = await startApp(world);
		expect(second.restore).not.toHaveBeenCalled();
		expect(second.inDock()).toBe(false);
		second.quit();
	});

	it('the write flushed when the screen is left right away counts too', async () => {
		const world = createWorld(layout(false), ['memo']);
		const first = await startApp(world);
		expect(world.popped).toEqual(['memo']);
		// Left within the debounce: `dispose` sends the write.
		first.quit();
		await vi.advanceTimersByTimeAsync(0);
		expect(world.writes).toBe(1);
		expect(world.popped).toEqual([]);
	});
});

describe('createLayoutSaveWatch', () => {
	const settle = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	function watchOf(promise: Promise<boolean>) {
		const seen: { value?: boolean } = {};
		void promise.then((value) => (seen.value = value));
		return seen;
	}

	it('is answered by a saved report made after next(), not by one made before', async () => {
		const saves = createLayoutSaveWatch();
		let landBefore!: (outcome: string) => void;
		saves.track(new Promise<string>((resolve) => (landBefore = resolve)));
		const seen = watchOf(saves.next());
		// A write that was already on its way lands: it holds the layout from before.
		landBefore('saved');
		await settle();
		expect(seen.value).toBeUndefined();
		saves.track(Promise.resolve('saved'));
		await settle();
		expect(seen.value).toBe(true);
	});

	it.each(['failed', 'dropped', 'unchanged'])(
		'stays pending after a report that was %s, until one is saved',
		async (outcome) => {
			const saves = createLayoutSaveWatch();
			const seen = watchOf(saves.next());
			saves.track(Promise.resolve(outcome));
			await settle();
			expect(seen.value).toBeUndefined();
			saves.track(Promise.resolve('saved'));
			await settle();
			expect(seen.value).toBe(true);
		}
	);
});
