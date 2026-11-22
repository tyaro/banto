// @vitest-environment jsdom
//
// `DockHost`'s `onLayoutCommit` (#791 first half, downstream-requests-2026-11-plan §4.6 / §10-18):
// called once at each settle point where `dock.serialize()` differs from the layout last reported
// (or last restored) - the end of a gesture, and the tick after any other change (a method of the
// host, a button of the dock UI, the app's own `DockState` call) - with `'user'`; not for the steps
// of a gesture, a cancelled / refused / `stale` change or a restore (`replaceLayout` without
// `commit`); `replaceLayout(next, { commit: 'reset' })` reports `'reset'` once, in the applying step.
//
// jsdom: the same stubs as `DockHostGesture.test.ts` (no layout engine, no `PointerEvent`).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import type { DockPanelChange } from '../src/core/lifecycle';
import { createDockState } from '../src/state.svelte';
import type { DockLayout, DockLayoutCommitReason } from '../src/types';

const saved: [object, string, PropertyDescriptor | undefined][] = [];

function stub(target: object, prop: string, descriptor: PropertyDescriptor): void {
	saved.push([target, prop, Object.getOwnPropertyDescriptor(target, prop)]);
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
	for (const [target, prop, descriptor] of saved.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

afterEach(() => {
	cleanup();
});

function firePointer(target: EventTarget, type: string, x: number, y: number): Event {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true });
	target.dispatchEvent(ev);
	return ev;
}

function press(target: EventTarget, key: string): void {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	flushSync();
}

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await tick();
	flushSync();
}

/** A row split `l | (x, y tabs)` and an open floating window `f`. */
const layout = (): DockLayout => ({
	version: 2,
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

function mount(
	props: { beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean> } = {}
) {
	const dock = createDockState(layout());
	const commits: [string, DockLayoutCommitReason][] = [];
	/** `onLayoutCommit` and `onGestureEnd`, in the order they were called. */
	const order: string[] = [];
	const view = render(DockHostHarness, {
		dock,
		...props,
		onLayoutCommit: (l: DockLayout, reason: DockLayoutCommitReason) => {
			commits.push([JSON.stringify(l), reason]);
			order.push(`commit:${reason}`);
		},
		onGestureEnd: (kind: string, outcome: string) => order.push(`${kind}:${outcome}`)
	});
	flushSync();
	return { dock, view, commits, order, host: () => view.component.host() };
}

const sizes = (dock: ReturnType<typeof createDockState>) =>
	(dock.layout.docked as { sizes: number[] }).sizes;

describe('DockHost onLayoutCommit: gestures', () => {
	it('is not called at mount', async () => {
		const { commits } = mount();
		await settle();
		expect(commits).toEqual([]);
	});

	it('a divider drag reports once, at the pointerup, before onGestureEnd - not for its steps', async () => {
		const { dock, commits, order } = mount();
		firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 550, 100);
		await settle();
		firePointer(window, 'pointermove', 600, 100);
		await settle();
		expect(sizes(dock)[0]).toBeCloseTo(0.6);
		expect(commits).toEqual([]);
		firePointer(window, 'pointerup', 600, 100);
		// Synchronously, with the layout as `serialize()` writes it.
		expect(commits).toEqual([[dock.serialize(), 'user']]);
		expect(order).toEqual(['commit:user', 'divider:commit']);
		await settle();
		expect(commits).toHaveLength(1);
	});

	it('a gesture cancelled by Esc reports nothing', async () => {
		const { dock, commits } = mount();
		firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 600, 100);
		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		await settle();
		expect(sizes(dock)).toEqual([0.5, 0.5]);
		expect(commits).toEqual([]);
	});

	it('a floating resize reports once at its end, and cancelGesture reports nothing', async () => {
		const { dock, commits, host } = mount();
		const handle = () => screen.getByRole('dialog', { name: 'F' }).querySelector('.handle-se')!;
		firePointer(handle(), 'pointerdown', 900, 500);
		firePointer(window, 'pointermove', 940, 500);
		await settle();
		expect(commits).toEqual([]);
		expect(host().cancelGesture()).toBe(true);
		await settle();
		expect(commits).toEqual([]);
		firePointer(handle(), 'pointerdown', 900, 500);
		firePointer(window, 'pointermove', 940, 500);
		firePointer(window, 'pointerup', 940, 500);
		await settle();
		expect(commits).toEqual([[dock.serialize(), 'user']]);
	});

	it('each keyboard step on a divider reports once', async () => {
		const { dock, commits } = mount();
		const divider = screen.getByRole('separator');
		divider.focus();
		press(divider, 'ArrowRight');
		expect(commits).toHaveLength(1);
		press(divider, 'ArrowRight');
		await settle();
		expect(commits).toHaveLength(2);
		expect(commits[1]).toEqual([dock.serialize(), 'user']);
	});

	it('a press that changes nothing (a click on the active tab) reports nothing', async () => {
		const { commits } = mount();
		firePointer(screen.getByRole('tab', { name: 'X' }), 'pointerdown', 10, 10);
		firePointer(window, 'pointerup', 10, 10);
		await settle();
		expect(commits).toEqual([]);
	});
});

describe('DockHost onLayoutCommit: changes outside a gesture', () => {
	it('a tab switch by click reports once', async () => {
		const { dock, commits } = mount();
		firePointer(screen.getByRole('tab', { name: 'Y' }), 'pointerdown', 10, 10);
		firePointer(window, 'pointerup', 10, 10);
		await settle();
		expect(dock.serialize()).toContain('"activeIndex":1');
		expect(commits).toEqual([[dock.serialize(), 'user']]);
	});

	it('setPanelVisible and showPanel report once each', async () => {
		const { dock, commits, host } = mount();
		expect(await host().setPanelVisible('l', false)).toBe('applied');
		await settle();
		expect(commits).toHaveLength(1);
		expect(await host().showPanel('l')).toBe('applied');
		await settle();
		expect(commits).toHaveLength(2);
		expect(commits.map((c) => c[1])).toEqual(['user', 'user']);
		expect(commits[1][0]).toBe(dock.serialize());
	});

	it("the app's own DockState call reports once, in the tick after it", async () => {
		const { dock, commits } = mount();
		dock.close('f');
		expect(commits).toEqual([]);
		await settle();
		expect(commits).toEqual([[dock.serialize(), 'user']]);
		// Several calls in one tick are one report.
		dock.open('f');
		dock.setActiveTab('t', 1);
		await settle();
		expect(commits).toHaveLength(2);
	});

	it('a change made and undone in the same tick reports nothing', async () => {
		const { dock, commits } = mount();
		const before = dock.serialize();
		dock.close('f');
		dock.hydrate(before);
		await settle();
		expect(dock.serialize()).toBe(before);
		expect(commits).toEqual([]);
	});

	it('a refused change and a stale one report nothing', async () => {
		let allow = false;
		const { dock, commits, host } = mount({ beforePanelChange: () => allow });
		const before = dock.serialize();
		expect(await host().setPanelVisible('l', false)).toBe('refused');
		allow = true;
		expect(await host().setPanelVisible('f', false, { isCurrent: () => false })).toBe('stale');
		await settle();
		expect(dock.serialize()).toBe(before);
		expect(commits).toEqual([]);
	});

	it('a change during a gesture waits for the gesture to end, and is reported once with it', async () => {
		const { dock, commits } = mount();
		firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 600, 100);
		dock.close('f');
		await settle();
		expect(commits).toEqual([]);
		firePointer(window, 'pointerup', 600, 100);
		await settle();
		expect(commits).toEqual([[dock.serialize(), 'user']]);
	});

	it('a change not reported yet is reported when the host unmounts', () => {
		const { dock, commits, view } = mount();
		dock.close('f');
		expect(commits).toEqual([]);
		view.unmount();
		expect(commits).toEqual([[dock.serialize(), 'user']]);
	});
});

describe('DockHost onLayoutCommit: replaceLayout', () => {
	const other = (): DockLayout => ({
		version: 2,
		floating: [{ id: 'g', title: 'G', x: 10, y: 10, width: 300, height: 200, open: true }],
		docked: { type: 'panel', id: 'l', title: 'L' }
	});

	it('without commit (a restore) reports nothing, and later changes are compared with it', async () => {
		const { dock, commits, host } = mount();
		expect(await host().replaceLayout(other(), { saved: true })).toBe('applied');
		await settle();
		expect(commits).toEqual([]);
		// Back to the restored layout within a tick: still nothing.
		const restored = dock.serialize();
		dock.close('g');
		dock.hydrate(restored);
		await settle();
		expect(commits).toEqual([]);
		dock.close('g');
		await settle();
		expect(commits).toEqual([[dock.serialize(), 'user']]);
	});

	it("commit: 'reset' reports 'reset' once, in the applying step, after `applied` - never 'user' too", async () => {
		const { dock, commits, host } = mount();
		const seen: string[] = [];
		const outcome = await host().replaceLayout(other(), {
			saved: true,
			commit: 'reset',
			applied: () => seen.push(`applied:${commits.length}:${dock.serialize()}`)
		});
		expect(outcome).toBe('applied');
		// `applied` ran with the new layout in and before the report.
		expect(seen).toEqual([`applied:0:${dock.serialize()}`]);
		expect(commits).toEqual([[dock.serialize(), 'reset']]);
		await settle();
		expect(commits).toHaveLength(1);
	});

	it("commit: 'reset' is reported even when the layout is the same", async () => {
		const { dock, commits, host } = mount();
		expect(await host().replaceLayout(JSON.parse(dock.serialize()), { commit: 'reset' })).toBe(
			'applied'
		);
		await settle();
		expect(commits.map((c) => c[1])).toEqual(['reset']);
	});

	it('a refused, stale or invalid replacement reports nothing and runs no `applied`', async () => {
		let allow = false;
		const { commits, host } = mount({ beforePanelChange: () => allow });
		const applied = vi.fn();
		expect(await host().replaceLayout(other(), { commit: 'reset', applied })).toBe('refused');
		allow = true;
		expect(
			await host().replaceLayout(other(), { commit: 'reset', applied, isCurrent: () => false })
		).toBe('stale');
		expect(
			await host().replaceLayout({ version: 2 } as unknown as DockLayout, {
				commit: 'reset',
				applied
			})
		).toBe('invalid');
		await settle();
		expect(commits).toEqual([]);
		expect(applied).not.toHaveBeenCalled();
	});

	it('a gesture in progress is cancelled first: only the reset is reported', async () => {
		const { commits, host, order } = mount();
		firePointer(screen.getByRole('separator'), 'pointerdown', 500, 100);
		firePointer(window, 'pointermove', 600, 100);
		expect(await host().replaceLayout(other(), { saved: true, commit: 'reset' })).toBe('applied');
		await settle();
		expect(commits.map((c) => c[1])).toEqual(['reset']);
		expect(order).toEqual(['divider:cancel', 'commit:reset']);
	});
});
