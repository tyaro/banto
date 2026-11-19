// @vitest-environment jsdom
//
// Persistent panes of DockHost (#663 ④, three-pane-dock-plan §4.2 C / §6 受け入れ 3):
// the content of a `persistent` pane is rendered once outside the tree and moved
// into its receptacle, so undock / dock / a drop on the outer edge / a split made
// around it (reparent) / auto-hide / a tab switch keep the SAME DOM element and
// mount it once; the focus and scroll offsets inside are put back after a move,
// and a focus the host put elsewhere is not taken back. `PersistentContents` is
// also tested on its own for two receptacles mounted at once.
//
// Same jsdom stubs as DockHostLifecycle.test.ts (no layout engine: every element
// is 1000 x 600 at the origin, `elementFromPoint` returns `hit()`).
import { cleanup, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DockHostPersistentHarness from './DockHostPersistentHarness.svelte';
import { createDockState } from '../src/state.svelte';
import type { DockPanelChange } from '../src/core/lifecycle';
import { PersistentContents } from '../src/core/persistent';
import type { DockCapabilities } from '../src/core/policy';
import type { DockLayout } from '../src/types';

let hit: () => Element | null = () => document.querySelector('[data-dock-host]');
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
	stub(document, 'elementFromPoint', { writable: true, value: () => hit() });
});

afterAll(() => {
	for (const [target, prop, descriptor] of saved.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

beforeEach(() => {
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
		left: 0,
		top: 0,
		right: 1000,
		bottom: 600,
		width: 1000,
		height: 600,
		x: 0,
		y: 0,
		toJSON: () => ({})
	} as DOMRect);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	hit = () => document.querySelector('[data-dock-host]');
});

const CENTRE = [500, 300] as const;
const BELOW = [500, 336] as const;

function firePointer(target: EventTarget, type: string, x: number, y: number): void {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true });
	target.dispatchEvent(ev);
}

/** A press that crosses the drag threshold and is released at (x2, y2). */
function dragFrom(target: EventTarget, x2 = 300, y2 = 300): void {
	firePointer(target, 'pointerdown', 100, 100);
	firePointer(window, 'pointermove', 130, 130);
	firePointer(window, 'pointermove', x2, y2);
	firePointer(window, 'pointerup', x2, y2);
	flushSync();
}

/** A press without movement (a tab click). */
function clickPress(target: EventTarget): void {
	firePointer(target, 'pointerdown', 10, 10);
	firePointer(window, 'pointerup', 10, 10);
	flushSync();
}

const settle = async () => {
	flushSync();
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
};

/** A tab group (x, y) next to a plain pane (p), plus one floating window (f). */
const mixed = (): DockLayout => ({
	version: 2,
	floating: [{ id: 'f', title: 'F', x: 600, y: 300, width: 300, height: 200, open: true }],
	docked: {
		type: 'split',
		id: 's',
		direction: 'row',
		sizes: [0.5, 0.5],
		children: [
			{
				type: 'tabs',
				id: 't',
				activeIndex: 0,
				children: [
					{ type: 'panel', id: 'x', title: 'X' },
					{ type: 'panel', id: 'y', title: 'Y' }
				]
			},
			{ type: 'panel', id: 'p', title: 'P' }
		]
	}
});

type Props = {
	beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
	keepMounted?: (panelId: string) => boolean;
	persistent?: (panelId: string) => boolean;
	capabilities?: (panelId: string) => DockCapabilities | undefined;
};

function mount(layout: DockLayout, props: Props = {}) {
	const dock = createDockState(layout);
	const mounts = new Map<string, number>();
	const onMounted = (id: string) => mounts.set(id, (mounts.get(id) ?? 0) + 1);
	const view = render(DockHostPersistentHarness, { dock, onMounted, ...props });
	return { dock, mounts, host: () => view.component.host() };
}

const probe = (id: string) => document.querySelector<HTMLElement>(`[data-probe="${id}"]`);
const inputOf = (name: string) =>
	document.querySelector<HTMLInputElement>(`input[aria-label="${name} input"]`);
const dialogOf = (name: string) =>
	document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);
const tabOf = (id: string) => document.querySelector<HTMLElement>(`[data-dock-tab-id="${id}"]`)!;
const stash = () => document.querySelector<HTMLElement>('.persistent-stash')!;
const label = (c: DockPanelChange) =>
	c.kind === 'tab-switch'
		? `tab-switch ${c.from}>${c.to}${c.remount ? '' : ' kept'}`
		: `${c.kind} ${c.panelId}${'remount' in c && !c.remount ? ' kept' : ''}`;

describe('a persistent pane keeps the same DOM and is mounted once', () => {
	it('undock, dock back onto a tab group, and tab switches', async () => {
		const calls: string[] = [];
		const { dock, mounts } = mount(mixed(), {
			persistent: (id) => id === 'p',
			beforePanelChange: (c) => (calls.push(label(c)), true)
		});
		const el = probe('p')!;
		// Rendered in its receptacle in the tree, not left in the hidden stash.
		expect(el.closest('[data-dock-persistent-slot="p"]')).not.toBeNull();
		expect(stash().contains(el)).toBe(false);

		dragFrom(screen.getByRole('toolbar', { name: 'P' }));
		await settle();
		expect(dock.layout.floating.find((w) => w.id === 'p')?.open).toBe(true);
		expect(probe('p')).toBe(el);
		expect(dialogOf('P')!.contains(el)).toBe(true);

		hit = () => document.querySelector('[data-dock-drop-id="t"]');
		dragFrom(dialogOf('P')!.querySelector('.titlebar')!, ...CENTRE);
		await settle();
		expect(dock.layout.floating.find((w) => w.id === 'p')).toBeUndefined();
		expect(probe('p')).toBe(el);
		expect(tabOf('p').getAttribute('aria-selected')).toBe('true');

		clickPress(tabOf('x'));
		await settle();
		expect(el.isConnected).toBe(true);
		clickPress(tabOf('p'));
		await settle();
		expect(probe('p')).toBe(el);
		expect(mounts.get('p')).toBe(1);
		// Its own changes say `remount: false`; the panes that are not persistent still re-mount.
		expect(calls).toEqual([
			'reparent x',
			'undock p kept',
			'tab-switch x>p',
			'dock p kept',
			'tab-switch p>x kept',
			'tab-switch x>p'
		]);
	});

	it('a split made around it (reparent) is not asked and does not re-mount it', async () => {
		const calls: string[] = [];
		const { mounts } = mount(mixed(), {
			persistent: (id) => id === 'p',
			beforePanelChange: (c) => (calls.push(label(c)), true)
		});
		const el = probe('p')!;
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragFrom(dialogOf('F')!.querySelector('.titlebar')!, ...BELOW);
		await settle();
		expect(calls).toEqual(['dock f']);
		expect(probe('p')).toBe(el);
		expect(mounts.get('p')).toBe(1);
	});

	it('a drop on the outer edge wraps the root: same DOM, the focus stays in the content', async () => {
		const calls: string[] = [];
		const { dock, mounts } = mount(mixed(), {
			persistent: (id) => id === 'x' || id === 'p',
			beforePanelChange: (c) => (calls.push(label(c)), true)
		});
		const x = probe('x')!;
		const p = probe('p')!;
		const input = inputOf('X')!;
		input.focus();
		dragFrom(dialogOf('F')!.querySelector('.titlebar')!, 24, 300);
		await settle();
		expect(dock.layout.docked).toMatchObject({ children: [{ id: 'f' }, { id: 's' }] });
		expect(calls).toEqual(['dock f']);
		expect(probe('x')).toBe(x);
		expect(probe('p')).toBe(p);
		expect(mounts.get('x')).toBe(1);
		expect(mounts.get('p')).toBe(1);
		// Without `persistent` the host hands a lost focus to the frame's tab; here it was never lost.
		expect(document.activeElement).toBe(input);
	});

	it('hide keeps it in the hidden window (remount false); close discards it; show mounts a fresh one', async () => {
		const calls: string[] = [];
		const { mounts, host } = mount(mixed(), {
			persistent: (id) => id === 'p',
			beforePanelChange: (c) => (calls.push(label(c)), true)
		});
		const el = probe('p')!;
		await host().hidePanel('p');
		await settle();
		expect(el.isConnected).toBe(true);
		expect(dialogOf('P')!.contains(el)).toBe(true);
		await host().showPanel('p');
		await settle();
		expect(probe('p')).toBe(el);
		expect(mounts.get('p')).toBe(1);

		await host().closePanel('p');
		await settle();
		expect(el.isConnected).toBe(false);
		expect(probe('p')).toBeNull();
		expect(stash().children).toHaveLength(0);
		await host().showPanel('p');
		await settle();
		expect(probe('p')).not.toBeNull();
		expect(probe('p')).not.toBe(el);
		expect(mounts.get('p')).toBe(2);
		expect(calls.filter((c) => c.endsWith(' p') || c.endsWith(' p kept'))).toEqual([
			'hide p kept',
			'dock p kept',
			'close p'
		]);
	});
});

describe('persistent is read when the change is applied', () => {
	it('an approval given while it was persistent is stale once it is not (the answer was about remount false)', async () => {
		let keep = true;
		let resolve!: (v: boolean) => void;
		const asked: DockPanelChange[] = [];
		const { dock, host } = mount(mixed(), {
			persistent: (id) => id === 'f' && keep,
			beforePanelChange: (c) => (asked.push(c), new Promise<boolean>((r) => (resolve = r)))
		});
		const outcome = host().hidePanel('f');
		expect(asked).toEqual([{ kind: 'hide', panelId: 'f', remount: false }]);
		keep = false;
		resolve(true);
		expect(await outcome).toBe('stale');
		expect(dock.layout).toEqual(mixed());
	});
});

describe('focus and scroll after a move', () => {
	it('the focused input and the scroll offset come back after an undock', async () => {
		mount(mixed(), { persistent: (id) => id === 'p' });
		const scroller = document.querySelector<HTMLElement>('[data-scroller="p"]')!;
		let top = 0;
		Object.defineProperty(scroller, 'scrollTop', {
			configurable: true,
			get: () => top,
			set: (v: number) => (top = v)
		});
		top = 40;
		scroller.dispatchEvent(new Event('scroll'));
		// What a browser does to a moved scroller (no scroll event): the offset is gone.
		top = 0;
		const input = inputOf('P')!;
		input.focus();
		dragFrom(screen.getByRole('toolbar', { name: 'P' }));
		await settle();
		expect(dialogOf('P')!.contains(input)).toBe(true);
		expect(top).toBe(40);
		expect(document.activeElement).toBe(input);
	});

	it('auto-hide and pin back: same DOM; a focus inside stays there (the host does not move it to the pin)', async () => {
		const layout: DockLayout = {
			version: 2,
			floating: [],
			docked: {
				type: 'split',
				id: 'root',
				direction: 'row',
				sizes: [0.7, 0.3],
				children: [
					{ type: 'panel', id: 'M', title: 'Main' },
					{ type: 'panel', id: 'R', title: 'Props' }
				]
			}
		};
		const calls: string[] = [];
		const { dock, mounts } = mount(layout, {
			persistent: (id) => id === 'R',
			beforePanelChange: (c) => (calls.push(label(c)), true),
			capabilities: (id) =>
				id === 'M' ? { close: false, move: false, undock: false, autoHide: false } : undefined
		});
		const el = probe('R')!;
		screen.getByRole('button', { name: 'Propsを自動で隠す（ピンを外す）' }).click();
		await settle();
		expect(dock.autoHidden).toHaveLength(1);
		document.querySelector<HTMLElement>('[data-dock-band-tab="R"]')!.click();
		await settle();
		const flyout = document.querySelector<HTMLElement>('[data-dock-flyout="R"]')!;
		expect(flyout.contains(el)).toBe(true);
		inputOf('Props')!.focus();
		screen.getByRole('button', { name: 'Propsを元の場所に固定（ピンを留める）' }).click();
		await settle();
		expect(dock.autoHidden).toHaveLength(0);
		expect(probe('R')).toBe(el);
		expect(mounts.get('R')).toBe(1);
		// The host hands a LOST focus to the region's pin button; this one was put back first.
		expect(document.activeElement).toBe(inputOf('Props'));
		// Only the main region (not persistent) is re-mounted by the split shrinking and growing.
		expect(calls).toEqual(['reparent M', 'auto-hide R kept', 'reparent M', 'auto-hide R kept']);
	});

	it('a focus moved elsewhere during the change is not taken back', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		const { mounts } = mount(mixed(), {
			persistent: (id) => id === 'x',
			beforePanelChange: (c) => (c.kind === 'dock' && outside.focus(), true)
		});
		const x = probe('x')!;
		inputOf('X')!.focus();
		dragFrom(dialogOf('F')!.querySelector('.titlebar')!, 24, 300);
		await settle();
		expect(probe('x')).toBe(x);
		expect(mounts.get('x')).toBe(1);
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});
});

describe('PersistentContents (two receptacles at once)', () => {
	function setup() {
		const contents = new PersistentContents();
		const home = document.createElement('div');
		const el = document.createElement('div');
		home.append(el);
		const a = document.createElement('div');
		const b = document.createElement('div');
		document.body.append(home, a, b);
		const detachContent = contents.content('p')(el) as () => void;
		return { contents, home, el, a, b, detachContent };
	}

	it('the newest receptacle holds the content; when it goes, the one left does, then the stash', () => {
		const { contents, home, el, a, b } = setup();
		const offA = contents.slot('p')(a) as () => void;
		expect(el.parentElement).toBe(a);
		// The new receptacle is mounted before the old one is torn down.
		const offB = contents.slot('p')(b) as () => void;
		expect(el.parentElement).toBe(b);
		offA();
		expect(el.parentElement).toBe(b);
		offB();
		expect(el.parentElement).toBe(home);
		document.body.replaceChildren();
	});

	it('the newest one going first gives it back to the older one', () => {
		const { contents, el, a, b } = setup();
		const offA = contents.slot('p')(a) as () => void;
		const offB = contents.slot('p')(b) as () => void;
		offB();
		expect(el.parentElement).toBe(a);
		offA();
		document.body.replaceChildren();
	});

	it('a receptacle mounted before the content gets it when the content mounts; the content leaving removes it', () => {
		const contents = new PersistentContents();
		const slot = document.createElement('div');
		const home = document.createElement('div');
		const el = document.createElement('div');
		home.append(el);
		document.body.append(home, slot);
		contents.slot('p')(slot);
		const off = contents.content('p')(el) as () => void;
		expect(el.parentElement).toBe(slot);
		off();
		expect(el.isConnected).toBe(false);
		document.body.replaceChildren();
	});

	it('a content parked in the stash does not keep the focus', async () => {
		const { contents, home, el, a } = setup();
		home.hidden = true;
		const input = document.createElement('input');
		el.append(input);
		const off = contents.slot('p')(a) as () => void;
		input.focus();
		contents.snapshot();
		off();
		await Promise.resolve();
		expect(el.parentElement).toBe(home);
		expect(document.activeElement).not.toBe(input);
		document.body.replaceChildren();
	});
});
