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
import { isDockRearranging, layoutStructureKey, PersistentContents } from '../src/core/persistent';
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

	it.each([
		['the outer edge', () => document.querySelector('[data-dock-host]'), 24, 300],
		['a pane target', () => document.querySelector('[data-dock-drop-id="p"]'), ...BELOW]
	] as const)(
		'a drop on %s approved while it was persistent is stale once it is not',
		async (_name, target, x, y) => {
			let keep = true;
			let resolve!: (v: boolean) => void;
			const asked: DockPanelChange[] = [];
			// x and p stay persistent so only f's own change is asked (no reparent of them).
			const { dock } = mount(mixed(), {
				persistent: (id) => id === 'x' || id === 'p' || (id === 'f' && keep),
				beforePanelChange: (c) => (asked.push(c), new Promise<boolean>((r) => (resolve = r)))
			});
			hit = target;
			dragFrom(dialogOf('F')!.querySelector('.titlebar')!, x, y);
			await settle();
			expect(asked).toEqual([{ kind: 'dock', panelId: 'f', remount: false }]);
			keep = false;
			resolve(true);
			await settle();
			expect(dock.layout).toEqual(mixed());
		}
	);
});

/**
 * jsdom has no layout, so `scrollTop` is faked the way a browser treats it (#768): an offset
 * belongs to the element while it stays rendered in the same frame (`.body`). Read after the
 * element was hidden (a background tab, the stash) or moved into another frame, it is gone (0).
 * Returns the restore.
 */
function fakeScrollTop(): () => void {
	const tops = new WeakMap<Element, { top: number; frame: Element | null }>();
	const proto = Element.prototype;
	const original = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
	Object.defineProperty(proto, 'scrollTop', {
		configurable: true,
		get(this: Element) {
			const record = tops.get(this);
			if (!record) return 0;
			if (this.closest('[hidden]') || this.closest('.body') !== record.frame) {
				tops.delete(this);
				return 0;
			}
			return record.top;
		},
		set(this: Element, top: number) {
			if (!this.closest('[hidden]')) tops.set(this, { top, frame: this.closest('.body') });
		}
	});
	return () => {
		if (original) Object.defineProperty(proto, 'scrollTop', original);
		else Reflect.deleteProperty(proto, 'scrollTop');
	};
}

const frameOf = (id: string) =>
	document.querySelector(`[data-dock-persistent-slot="${id}"]`)!.closest<HTMLElement>('.body')!;
const scrollerOf = (id: string) => document.querySelector<HTMLElement>(`[data-scroller="${id}"]`)!;

describe('focus and scroll after a move', () => {
	it('the focused input and the scroll offset come back after an undock', async () => {
		const restore = fakeScrollTop();
		try {
			mount(mixed(), { persistent: (id) => id === 'p' });
			await settle();
			const scroller = scrollerOf('p');
			// No `scroll` event: scrolled in the same task as the move (#768).
			scroller.scrollTop = 40;
			const input = inputOf('P')!;
			input.focus();
			dragFrom(screen.getByRole('toolbar', { name: 'P' }));
			await settle();
			expect(dialogOf('P')!.contains(input)).toBe(true);
			expect(scroller.scrollTop).toBe(40);
			expect(document.activeElement).toBe(input);
		} finally {
			restore();
		}
	});

	it('a tab switch away and back: each persistent tab has its own offset in the shared frame (#768)', async () => {
		const restore = fakeScrollTop();
		try {
			const { dock } = mount(mixed(), { persistent: (id) => id === 'x' || id === 'y' });
			await settle();
			const frame = frameOf('x');
			expect(frameOf('y')).toBe(frame);
			frame.scrollTop = 70;
			scrollerOf('x').scrollTop = 25;
			clickPress(tabOf('y'));
			await settle();
			// Y was never scrolled: the top, not X's 70.
			expect(frame.scrollTop).toBe(0);
			// X's own scroller is not rendered any more: a browser has dropped its offset.
			expect(scrollerOf('x').scrollTop).toBe(0);
			frame.scrollTop = 30;
			frame.dispatchEvent(new Event('scroll'));
			clickPress(tabOf('x'));
			await settle();
			expect(frame.scrollTop).toBe(70);
			expect(scrollerOf('x').scrollTop).toBe(25);
			clickPress(tabOf('y'));
			await settle();
			expect(frame.scrollTop).toBe(30);
			// Kept beside the layout, never in it (nothing to save, no version change).
			expect(JSON.stringify(dock.layout)).not.toContain('scroll');
		} finally {
			restore();
		}
	});

	it('the offset of a tab that is not persistent is not taken for the persistent one behind it (#768)', async () => {
		const restore = fakeScrollTop();
		try {
			mount(mixed(), { persistent: (id) => id === 'x' });
			await settle();
			const frame = frameOf('x');
			frame.scrollTop = 70;
			frame.dispatchEvent(new Event('scroll'));
			clickPress(tabOf('y'));
			await settle();
			// Y (re-created) scrolls the shared frame while X is in the background.
			frame.scrollTop = 400;
			frame.dispatchEvent(new Event('scroll'));
			clickPress(tabOf('x'));
			await settle();
			expect(frameOf('x')).toBe(frame);
			expect(frame.scrollTop).toBe(70);
		} finally {
			restore();
		}
	});

	it('hide and show: the offsets recorded before the pane left the screen come back (#768)', async () => {
		const restore = fakeScrollTop();
		try {
			const { dock, host } = mount(mixed(), { persistent: (id) => id === 'p' });
			await settle();
			frameOf('p').scrollTop = 55;
			scrollerOf('p').scrollTop = 15;
			expect(await host().hidePanel('p')).toBe('applied');
			await settle();
			expect(probe('p')!.closest('[hidden]')).not.toBeNull();
			expect(scrollerOf('p').scrollTop).toBe(0);
			expect(await host().showPanel('p')).toBe('applied');
			await settle();
			expect(dock.panels.find((row) => row.id === 'p')?.visible).toBe(true);
			expect(frameOf('p').scrollTop).toBe(55);
			expect(scrollerOf('p').scrollTop).toBe(15);
			// Two re-arrangements in one task (the second before the first was put back): undock, dock back.
			dragFrom(screen.getByRole('toolbar', { name: 'P' }));
			hit = () => document.querySelector('[data-dock-drop-id="t"]');
			dragFrom(dialogOf('P')!.querySelector('.titlebar')!, ...CENTRE);
			await settle();
			expect(dock.layout.floating.find((w) => w.id === 'p')).toBeUndefined();
			expect(frameOf('p').scrollTop).toBe(55);
			expect(scrollerOf('p').scrollTop).toBe(15);
		} finally {
			restore();
		}
	});

	it('collapse and expand: the frame is hidden meanwhile, and gets its offset back (#768)', async () => {
		const restore = fakeScrollTop();
		try {
			const { dock } = mount(mixed(), { persistent: (id) => id === 'f' });
			await settle();
			const frame = frameOf('f');
			frame.scrollTop = 65;
			scrollerOf('f').scrollTop = 20;
			dock.setCollapsed('f', true);
			await settle();
			expect(frame.hidden).toBe(true);
			expect(frame.scrollTop).toBe(0);
			dock.setCollapsed('f', false);
			await settle();
			expect(frameOf('f')).toBe(frame);
			expect(frame.scrollTop).toBe(65);
			expect(scrollerOf('f').scrollTop).toBe(20);
		} finally {
			restore();
		}
	});

	it('the scroll offset of the standard .body frame comes back after an undock and a dock back', async () => {
		// Offsets live per element (jsdom has no layout): the frame is re-created by each move.
		const tops = new WeakMap<Element, number>();
		const proto = Element.prototype;
		const original = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
		Object.defineProperty(proto, 'scrollTop', {
			configurable: true,
			get(this: Element) {
				return tops.get(this) ?? 0;
			},
			set(this: Element, v: number) {
				tops.set(this, v);
			}
		});
		try {
			const { dock } = mount(mixed(), { persistent: (id) => id === 'p' });
			const bodyOf = () =>
				document.querySelector('[data-dock-persistent-slot="p"]')!.closest<HTMLElement>('.body')!;
			const first = bodyOf();
			first.scrollTop = 70;
			first.dispatchEvent(new Event('scroll'));
			dragFrom(screen.getByRole('toolbar', { name: 'P' }));
			await settle();
			const floating = bodyOf();
			expect(floating).not.toBe(first);
			expect(floating.scrollTop).toBe(70);
			floating.scrollTop = 90;
			floating.dispatchEvent(new Event('scroll'));
			hit = () => document.querySelector('[data-dock-drop-id="t"]');
			dragFrom(dialogOf('P')!.querySelector('.titlebar')!, ...CENTRE);
			await settle();
			expect(dock.layout.floating.find((w) => w.id === 'p')).toBeUndefined();
			expect(bodyOf().scrollTop).toBe(90);
		} finally {
			if (original) Object.defineProperty(proto, 'scrollTop', original);
			else Reflect.deleteProperty(proto, 'scrollTop');
		}
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

// jsdom has no `Element.moveBefore()` and fires no `blur` when a focused element leaves the
// document: these cover the bookkeeping only (where the content is, the mark). That no `blur`
// fires in a browser is `e2e/demo/dock-persistent-focus.spec.ts`.
describe('PersistentContents: the focused content waits in the transit element (#763)', () => {
	function setup(withMoveBefore: boolean) {
		const moves: string[] = [];
		if (withMoveBefore) {
			Object.defineProperty(Element.prototype, 'moveBefore', {
				configurable: true,
				writable: true,
				value(this: Element, node: Node, child: Node | null) {
					if (!this.isConnected || !node.isConnected) throw new Error('HierarchyRequestError');
					moves.push(this.id);
					this.insertBefore(node, child);
				}
			});
		}
		const contents = new PersistentContents();
		const [home, transit, a, b] = ['home', 'transit', 'a', 'b'].map((id) => {
			const div = document.createElement('div');
			div.id = id;
			return div;
		});
		const el = document.createElement('div');
		const input = document.createElement('input');
		el.append(input);
		home.append(el);
		home.hidden = true;
		document.body.append(home, transit, a, b);
		contents.transit(transit);
		contents.content('p')(el);
		const offA = contents.slot('p')(a) as () => void;
		moves.length = 0;
		return { contents, home, transit, el, input, a, b, offA, moves };
	}

	afterEach(() => {
		Reflect.deleteProperty(Element.prototype, 'moveBefore');
		document.body.replaceChildren();
	});

	it('snapshot takes it out of the old receptacle; the new one takes it from the transit element', async () => {
		const { contents, transit, el, input, a, b, offA, moves } = setup(true);
		input.focus();
		expect(isDockRearranging(input)).toBe(false);
		contents.snapshot();
		expect(el.parentElement).toBe(transit);
		expect(isDockRearranging(input)).toBe(true);
		// Svelte removes the old receptacle first, then mounts the new one: it waits meanwhile.
		a.remove();
		offA();
		expect(el.parentElement).toBe(transit);
		contents.slot('p')(b);
		expect(el.parentElement).toBe(b);
		expect(moves).toEqual(['transit', 'b']);
		expect(isDockRearranging(input)).toBe(true);
		await Promise.resolve();
		expect(el.parentElement).toBe(b);
		expect(document.activeElement).toBe(input);
		expect(isDockRearranging(input)).toBe(false);
	});

	it('an update that kept the receptacle: it goes back into it', async () => {
		const { contents, transit, el, input, a } = setup(true);
		input.focus();
		contents.snapshot();
		expect(el.parentElement).toBe(transit);
		await Promise.resolve();
		expect(el.parentElement).toBe(a);
		expect(document.activeElement).toBe(input);
		expect(isDockRearranging(input)).toBe(false);
	});

	it('the receptacle went and none came: parked in the stash, the focus does not stay', async () => {
		const { contents, home, el, input, offA } = setup(true);
		input.focus();
		contents.snapshot();
		offA();
		await Promise.resolve();
		expect(el.parentElement).toBe(home);
		expect(document.activeElement).not.toBe(input);
		expect(isDockRearranging(input)).toBe(false);
	});

	it('a content without the focus is not moved or marked', () => {
		const { contents, el, input, a, moves } = setup(true);
		contents.snapshot();
		expect(el.parentElement).toBe(a);
		expect(moves).toEqual([]);
		expect(isDockRearranging(input)).toBe(false);
	});

	it('without moveBefore it stays in its receptacle (appendChild path) and is marked until the focus is back', async () => {
		const { contents, transit, el, input, a, b, offA } = setup(false);
		input.focus();
		contents.snapshot();
		expect(el.parentElement).toBe(a);
		expect(isDockRearranging(input)).toBe(true);
		contents.slot('p')(b);
		offA();
		expect(el.parentElement).toBe(b);
		expect(transit.childElementCount).toBe(0);
		await Promise.resolve();
		expect(document.activeElement).toBe(input);
		expect(isDockRearranging(input)).toBe(false);
	});
});

describe('an update that keeps every receptacle moves nothing (#763 review)', () => {
	const key = (layout: DockLayout) => layoutStructureKey(layout);

	afterEach(() => {
		Reflect.deleteProperty(Element.prototype, 'moveBefore');
		document.body.replaceChildren();
	});

	it('layoutStructureKey: positions, sizes and titles are not part of it; what mounts a receptacle is', () => {
		const base = mixed();
		const moved = mixed();
		Object.assign(moved.floating[0], { x: 10, y: 20, width: 400, height: 250, title: 'Renamed' });
		if (moved.docked?.type === 'split') moved.docked.sizes = [0.3, 0.7];
		expect(key(moved)).toBe(key(base));
		const withBand: DockLayout = {
			...base,
			autoHidden: [
				{ node: { type: 'panel', id: 'q', title: 'Q' }, edge: 'left', slot: { kind: 'root' } }
			]
		};
		const widerBand: DockLayout = {
			...withBand,
			autoHidden: [{ ...withBand.autoHidden![0], size: 320 }]
		};
		expect(key(widerBand)).toBe(key(withBand));

		const changed: ((layout: DockLayout) => unknown)[] = [
			(l) => (l.floating[0].open = false),
			(l) => (l.floating[0].collapsed = true),
			(l) => l.floating.push({ ...l.floating[0], id: 'g' }),
			(l) => (l.docked = null),
			(l) => l.docked?.type === 'split' && l.docked.children.reverse(),
			(l) => l.docked?.type === 'split' && (l.docked.direction = 'column'),
			(l) =>
				l.docked?.type === 'split' &&
				l.docked.children[0].type === 'tabs' &&
				(l.docked.children[0].activeIndex = 1),
			(l) =>
				l.docked?.type === 'split' &&
				l.docked.children[1].type === 'panel' &&
				(l.docked.children[1].collapsed = true)
		];
		for (const change of changed) {
			const next = mixed();
			change(next);
			expect(key(next)).not.toBe(key(base));
		}
		expect(key(withBand)).not.toBe(key(base));
		const otherEdge: DockLayout = {
			...withBand,
			autoHidden: [{ ...withBand.autoHidden![0], edge: 'right' }]
		};
		expect(key(otherEdge)).not.toBe(key(withBand));
	});

	it('snapshot with the same structure leaves the focused content in its receptacle, unmarked', async () => {
		const moves: string[] = [];
		Object.defineProperty(Element.prototype, 'moveBefore', {
			configurable: true,
			writable: true,
			value(this: Element, node: Node, child: Node | null) {
				moves.push(this.id);
				this.insertBefore(node, child);
			}
		});
		const contents = new PersistentContents();
		const [home, transit, a] = ['home', 'transit', 'a'].map((id) => {
			const div = document.createElement('div');
			div.id = id;
			return div;
		});
		const el = document.createElement('div');
		const input = document.createElement('input');
		el.append(input);
		home.append(el);
		document.body.append(home, transit, a);
		contents.transit(transit);
		contents.content('p')(el);
		contents.slot('p')(a);
		input.focus();
		contents.snapshot('one');
		await Promise.resolve();
		moves.length = 0;

		contents.snapshot('one');
		expect(el.parentElement).toBe(a);
		expect(moves).toEqual([]);
		expect(isDockRearranging(input)).toBe(false);
		await Promise.resolve();
		expect(moves).toEqual([]);
		expect(document.activeElement).toBe(input);

		// Another structure: it waits in the transit element again.
		contents.snapshot('two');
		expect(el.parentElement).toBe(transit);
		expect(isDockRearranging(input)).toBe(true);
		await Promise.resolve();
		expect(el.parentElement).toBe(a);
	});

	it('DockHost: moving / resizing another window or a divider does not move the pane being edited', async () => {
		const { dock } = mount(mixed(), { persistent: (id) => id === 'p' });
		await settle();
		const input = inputOf('P')!;
		const content = input.closest<HTMLElement>('.persistent-content')!;
		const slot = content.parentElement!;
		expect(slot.classList.contains('persistent-slot')).toBe(true);
		input.focus();
		let moves = 0;
		Object.defineProperty(Element.prototype, 'moveBefore', {
			configurable: true,
			writable: true,
			value(this: Element, node: Node, child: Node | null) {
				moves += 1;
				this.insertBefore(node, child);
			}
		});

		const before = dock.layout;
		dock.move('f', 15, 10, 1000, 600);
		flushSync();
		expect(isDockRearranging(input)).toBe(false);
		await settle();
		dock.resize('f', 'se', 20, 20, 1000, 600);
		await settle();
		dock.resizeSplit('s', 0, 0.1);
		await settle();
		expect(dock.layout.floating[0]).not.toEqual(before.floating[0]);
		expect(dock.layout.docked).not.toEqual(before.docked);
		expect(moves).toBe(0);
		expect(content.parentElement).toBe(slot);
		expect(document.activeElement).toBe(input);

		// A change of the structure still takes it out and puts it back (the stub is in use).
		clickPress(tabOf('y'));
		await settle();
		expect(moves).toBeGreaterThan(0);
		expect(input.isConnected).toBe(true);
	});
});

describe('isDockRearranging (#763 review)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	it('null / undefined are false, also without DOM globals', () => {
		expect(isDockRearranging(null)).toBe(false);
		expect(isDockRearranging(undefined)).toBe(false);
		vi.stubGlobal('Element', undefined);
		vi.stubGlobal('ShadowRoot', undefined);
		expect(isDockRearranging(null)).toBe(false);
		expect(isDockRearranging(undefined)).toBe(false);
	});

	it('a node inside a shadow tree (also a nested one, and a text node) is found through its hosts', () => {
		const pane = document.createElement('div');
		const outerHost = document.createElement('div');
		pane.append(outerHost);
		document.body.append(pane);
		const outer = outerHost.attachShadow({ mode: 'open' });
		const innerHost = document.createElement('div');
		outer.append(innerHost);
		const inner = innerHost.attachShadow({ mode: 'closed' });
		const input = document.createElement('input');
		const text = document.createTextNode('direct child of the shadow root');
		inner.append(input, text);

		expect(isDockRearranging(input)).toBe(false);
		expect(isDockRearranging(text)).toBe(false);
		pane.setAttribute('data-dock-rearranging', '');
		expect(isDockRearranging(input)).toBe(true);
		expect(isDockRearranging(text)).toBe(true);
		expect(isDockRearranging(innerHost)).toBe(true);
		expect(isDockRearranging(document.body)).toBe(false);
		expect(isDockRearranging(document)).toBe(false);
	});
});

describe('PersistentContents: a content that goes away while marked (#763 review)', () => {
	afterEach(() => document.body.replaceChildren());

	it('the mark is taken off when its pane is closed before the update settles', async () => {
		const contents = new PersistentContents();
		const home = document.createElement('div');
		const a = document.createElement('div');
		const el = document.createElement('div');
		const input = document.createElement('input');
		el.append(input);
		home.append(el);
		document.body.append(home, a);
		const offContent = contents.content('p')(el) as () => void;
		const offSlot = contents.slot('p')(a) as () => void;
		input.focus();
		contents.snapshot();
		expect(isDockRearranging(input)).toBe(true);
		// The pane closed in this update: the stash item (and its content) is torn down.
		offSlot();
		offContent();
		expect(el.isConnected).toBe(false);
		expect(isDockRearranging(input)).toBe(false);
		await Promise.resolve();
		expect(el.hasAttribute('data-dock-rearranging')).toBe(false);
	});
});
