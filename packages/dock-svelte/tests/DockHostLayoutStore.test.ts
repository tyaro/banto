// @vitest-environment jsdom
//
// `createDockLayoutStore` wired to a real `DockHost` through `onLayoutCommit` only (#791 K4,
// downstream-requests-2026-11-plan §4.6 "試験"): what the dashboard does. Every kind of change -
// not only a drag - is saved once: a method of the host (`setPanelVisible` / `showPanel`), a
// keyboard step on a divider, a tab switch, the app's own `DockState` call. A layout the store
// applied (the provider's value, the seeded default) is reported by the host too and is not
// written back. "Reset layout" (`replaceLayout`, `commit: 'reset'`) is one write, never a second
// one as `'user'`; with `reset: 'remove'` it deletes the provider's row.
//
// jsdom: the same stubs as `DockHostCommit.test.ts` (no layout engine, no `PointerEvent`).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockLayoutStore, type DockLayoutStoreOptions } from '../src/layoutStore';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

const stubbed: [object, string, PropertyDescriptor | undefined][] = [];

function stub(target: object, prop: string, descriptor: PropertyDescriptor): void {
	stubbed.push([target, prop, Object.getOwnPropertyDescriptor(target, prop)]);
	Object.defineProperty(target, prop, { configurable: true, ...descriptor });
}

beforeAll(() => {
	stub(globalThis, 'ResizeObserver', {
		writable: true,
		value: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	});
	stub(HTMLElement.prototype, 'clientWidth', { get: () => 1000 });
	stub(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
	stub(document, 'elementFromPoint', {
		writable: true,
		value: () => document.querySelector('[data-dock-host]')
	});
});

afterAll(() => {
	for (const [target, prop, descriptor] of stubbed.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const KEY = 'dock.test';

/** A row split `l | (x, y tabs)` and an open floating window `f`. */
const DEFAULT = (): DockLayout => ({
	version: 4,
	floating: [{ id: 'f', title: 'F', x: 600, y: 300, width: 300, height: 200, open: true }],
	docked: {
		type: 'split',
		id: 's',
		direction: 'row',
		sizes: [0.5, 0.5],
		children: [
			{ type: 'panel', id: 'l', title: 'L' },
			{
				type: 'tabs',
				id: 't',
				activeIndex: 0,
				children: [
					{ type: 'panel', id: 'x', title: 'X' },
					{ type: 'panel', id: 'y', title: 'Y' }
				]
			}
		]
	}
});

/** A provider with one row per key, like the settings DB. */
function memoryProvider(initial: Record<string, string> = {}) {
	const rows = new Map(Object.entries(initial));
	return {
		rows,
		get: vi.fn(async (key: string) => ({ value: rows.get(key) ?? null })),
		set: vi.fn(async (key: string, value: string) => void rows.set(key, value)),
		remove: vi.fn(async (key: string) => void rows.delete(key))
	};
}

function firePointer(target: EventTarget, type: string, x: number, y: number): void {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true });
	target.dispatchEvent(ev);
}

/** The host's effects and the store's promises (not the debounce timer). */
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
		flushSync();
	}
}

/** The debounce runs out and the write lands. */
async function saved(): Promise<void> {
	await settle();
	await vi.advanceTimersByTimeAsync(500);
}

async function mount(
	opts: { rows?: Record<string, string>; reset?: DockLayoutStoreOptions['reset'] } = {}
) {
	const provider = memoryProvider(opts.rows);
	const dock = createDockState();
	const store = createDockLayoutStore({
		dock,
		settingKey: KEY,
		provider: () => provider,
		defaultLayout: DEFAULT,
		reset: opts.reset
	});
	// The page: the host reports to the store, and nothing else does.
	const view = render(DockHostHarness, { dock, onLayoutCommit: store.commit });
	flushSync();
	store.seedIfEmpty();
	await store.load();
	await saved();
	return { provider, dock, store, view, host: () => view.component.host() };
}

describe('DockHost + createDockLayoutStore', () => {
	it('the seeded default and the layout read from the provider are not written back', async () => {
		const empty = await mount();
		expect(empty.dock.layout.floating.map((w) => w.id)).toEqual(['f']);
		expect(empty.provider.set).not.toHaveBeenCalled();
		cleanup();
		const stored = createDockState(DEFAULT());
		stored.close('f');
		const restored = await mount({ rows: { [KEY]: stored.serialize() } });
		expect(restored.dock.serialize()).toBe(stored.serialize());
		expect(restored.provider.set).not.toHaveBeenCalled();
	});

	it('setPanelVisible and showPanel are saved once each', async () => {
		const { provider, dock, host } = await mount();
		expect(await host().setPanelVisible('l', false)).toBe('applied');
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.rows.get(KEY)).toBe(dock.serialize());
		expect(await host().showPanel('l')).toBe('applied');
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(2);
		expect(provider.rows.get(KEY)).toBe(dock.serialize());
	});

	it('a keyboard step on a divider is saved once', async () => {
		const { provider, dock } = await mount();
		const divider = screen.getByRole('separator');
		divider.focus();
		divider.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
		);
		flushSync();
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.rows.get(KEY)).toBe(dock.serialize());
		expect((dock.layout.docked as { sizes: number[] }).sizes[0]).not.toBe(0.5);
	});

	it('a tab switch is saved once', async () => {
		const { provider, dock } = await mount();
		firePointer(screen.getByRole('tab', { name: 'Y' }), 'pointerdown', 10, 10);
		firePointer(window, 'pointerup', 10, 10);
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.rows.get(KEY)).toContain('"activeIndex":1');
		expect(provider.rows.get(KEY)).toBe(dock.serialize());
	});

	it("the app's own DockState calls in one tick are one save", async () => {
		const { provider, dock } = await mount();
		dock.close('f');
		dock.setActiveTab('t', 1);
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.rows.get(KEY)).toBe(dock.serialize());
	});

	it('changes within the debounce are one write, of the last layout', async () => {
		const { provider, dock, host } = await mount();
		await host().setPanelVisible('l', false);
		await settle();
		dock.close('f');
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.rows.get(KEY)).toBe(dock.serialize());
	});

	it("reset is saved once, as 'reset' only - also when the default is already shown", async () => {
		const { provider, dock, host } = await mount();
		expect(await host().replaceLayout(DEFAULT(), { saved: true, commit: 'reset' })).toBe('applied');
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(1);
		dock.close('f');
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(2);
		expect(await host().replaceLayout(DEFAULT(), { saved: true, commit: 'reset' })).toBe('applied');
		await saved();
		expect(provider.set).toHaveBeenCalledTimes(3);
		expect(provider.rows.get(KEY)).toBe(JSON.stringify(DEFAULT()));
		expect(provider.remove).not.toHaveBeenCalled();
	});

	it("reset: 'remove' deletes the provider's row, once, and writes nothing", async () => {
		const changed = createDockState(DEFAULT());
		changed.close('f');
		const { provider, dock, host } = await mount({
			rows: { [KEY]: changed.serialize() },
			reset: 'remove'
		});
		expect(provider.rows.has(KEY)).toBe(true);
		expect(await host().replaceLayout(DEFAULT(), { saved: true, commit: 'reset' })).toBe('applied');
		await saved();
		expect(dock.serialize()).toBe(JSON.stringify(DEFAULT()));
		expect(provider.remove).toHaveBeenCalledTimes(1);
		expect(provider.set).not.toHaveBeenCalled();
		expect(provider.rows.has(KEY)).toBe(false);
	});

	it('a change not reported yet when the page unmounts is still saved', async () => {
		const { provider, dock, store, view } = await mount();
		dock.close('f');
		const last = dock.serialize();
		// The page's cleanup runs before the host's: the host reports after `dispose`.
		store.dispose();
		view.unmount();
		expect(provider.set).toHaveBeenCalledTimes(1);
		expect(provider.set).toHaveBeenCalledWith(KEY, last);
	});
});
