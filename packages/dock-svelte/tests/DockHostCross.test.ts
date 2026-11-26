// @vitest-environment jsdom
//
// The cross guide on a docked pane (#694 PR-2): during a drag the pane under the
// pointer shows five buttons (centre = join as a tab, up / down / left / right =
// split), and a drop happens ONLY on a button; off the buttons the pane floats
// (or the floating window moves). The target's `dropCenter` / `dropSplit`
// capabilities withhold buttons (a tab group: every pane must allow it). The
// buttons exist only during a drag and are `aria-hidden`. A focus lost to the
// re-mount a drop causes (a split, a new tab group, a pane floated) is handed back.
//
// jsdom has no layout engine: every element's rect is 1000 x 600 at the origin
// (the cross is around (500, 300), 32 px buttons 36 px apart) and
// `elementFromPoint` returns `hit()`; all restored in afterAll (same harness as
// DockHostEdge.test.ts).
import { cleanup, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { crossButtons, guideButtonSize, hitGuideButton } from '../src/core/dropzones';
import type { DockPanelChange } from '../src/core/lifecycle';
import type { DockCapabilities } from '../src/core/policy';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

describe('crossButtons / guideButtonSize / hitGuideButton (core/dropzones)', () => {
	it('five buttons around the centre of the rect; a hit only on a button', () => {
		const cross = crossButtons({ x: 0, y: 0, width: 1000, height: 600 });
		expect(cross).toEqual([
			{ region: 'center', rect: { x: 484, y: 284, width: 32, height: 32 } },
			{ region: 'left', rect: { x: 448, y: 284, width: 32, height: 32 } },
			{ region: 'right', rect: { x: 520, y: 284, width: 32, height: 32 } },
			{ region: 'top', rect: { x: 484, y: 248, width: 32, height: 32 } },
			{ region: 'bottom', rect: { x: 484, y: 320, width: 32, height: 32 } }
		]);
		expect(hitGuideButton(cross, 500, 300)).toBe('center');
		expect(hitGuideButton(cross, 464, 300)).toBe('left');
		expect(hitGuideButton(cross, 482, 300)).toBeNull(); // the gap
		expect(hitGuideButton(cross, 516, 300)).toBeNull(); // right / bottom border is out
		expect(hitGuideButton(cross, 10, 300)).toBeNull(); // the old edge band
	});

	it('the options withhold the centre or the four sides', () => {
		const rect = { x: 0, y: 0, width: 1000, height: 600 };
		expect(crossButtons(rect, { center: false }).map((b) => b.region)).toEqual([
			'left',
			'right',
			'top',
			'bottom'
		]);
		expect(crossButtons(rect, { split: false }).map((b) => b.region)).toEqual(['center']);
	});

	it('a small pane shrinks the buttons, and gets none below the minimum', () => {
		expect(guideButtonSize(1000, 600)).toBe(32);
		expect(guideButtonSize(100, 600)).toBe(25);
		expect(guideButtonSize(1000, 72)).toBe(16);
		expect(guideButtonSize(1000, 71)).toBe(0);
		expect(crossButtons({ x: 0, y: 0, width: 1000, height: 70 })).toEqual([]);
		expect(guideButtonSize(0, 0)).toBe(0);
	});
});

// --- through DockHost ----------------------------------------------------------

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

function firePointer(target: EventTarget, type: string, x: number, y: number): void {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true });
	target.dispatchEvent(ev);
}

function dragTo(target: EventTarget, x: number, y: number): void {
	firePointer(target, 'pointerdown', 100, 100);
	firePointer(window, 'pointermove', 130, 130);
	firePointer(window, 'pointermove', x, y);
	flushSync();
}

function release(x: number, y: number): void {
	firePointer(window, 'pointerup', x, y);
	flushSync();
}

/** A tab group (x, y; X active) next to a plain pane (p), plus one floating window (f). */
function mixed(): DockLayout {
	return {
		version: 4,
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
	};
}

function mount(
	capabilities?: (id: string) => DockCapabilities | undefined,
	beforePanelChange?: (change: DockPanelChange) => boolean
) {
	const dock = createDockState(mixed());
	render(DockHostHarness, { dock, capabilities, beforePanelChange });
	return { dock };
}

const titlebarF = () => document.querySelector('[role="dialog"][aria-label="F"] .titlebar')!;
const crossRegions = () =>
	[...document.querySelectorAll<HTMLElement>('[data-dock-cross]')].map((b) => b.dataset.dockCross);
const onPane = (id: string) => () => document.querySelector(`[data-dock-drop-id="${id}"]`);

describe('the cross guide on a docked pane (DockHost)', () => {
	it('drawn only during a drag, on the pane under the pointer; the hovered button is active', () => {
		mount();
		hit = onPane('p');
		expect(document.querySelectorAll('[data-dock-cross]')).toHaveLength(0);
		dragTo(titlebarF(), 500, 336);
		expect(crossRegions()).toEqual(['center', 'left', 'right', 'top', 'bottom']);
		const active = document.querySelector<HTMLElement>('[data-dock-cross].active');
		expect(active?.dataset.dockCross).toBe('bottom');
		expect(active?.getAttribute('aria-hidden')).toBe('true');
		// The guide is the half of the pane the split gives (unchanged by PR-2).
		const guide = document.querySelector<HTMLElement>('.snap-guide')!;
		expect([guide.style.top, guide.style.height]).toEqual(['300px', '300px']);
		release(500, 336);
		expect(document.querySelectorAll('.guide-button')).toHaveLength(0);
	});

	it('the centre button joins the pane as a tab; a side button splits it', () => {
		const { dock } = mount();
		hit = onPane('p');
		dragTo(titlebarF(), 500, 300);
		release(500, 300);
		expect(dock.layout.docked).toMatchObject({
			children: [{ id: 't' }, { type: 'tabs', children: [{ id: 'p' }, { id: 'f' }] }]
		});
		cleanup();
		const { dock: dock2 } = mount();
		hit = onPane('p');
		dragTo(titlebarF(), 536, 300);
		release(536, 300);
		// Right of P in a row split: F becomes P's next sibling.
		expect(dock2.layout.docked).toMatchObject({
			direction: 'row',
			children: [{ id: 't' }, { id: 'p' }, { id: 'f' }]
		});
	});

	it('off the buttons over a pane: a floating window moves, a docked pane floats', () => {
		const { dock } = mount();
		hit = onPane('p');
		dragTo(titlebarF(), 300, 300);
		expect(crossRegions()).toHaveLength(5);
		expect(document.querySelector('[data-dock-cross].active')).toBeNull();
		release(300, 300);
		expect(dock.layout.docked).toEqual(mixed().docked);
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['f']);
		dragTo(document.querySelector('[data-dock-tab-id="x"]')!, 300, 300);
		release(300, 300);
		expect(dock.layout.floating.map((w) => w.id)).toContain('x');
	});

	it('over a floating window there is no cross (the window moves)', () => {
		const { dock } = mount();
		hit = () => document.querySelector('[role="dialog"][aria-label="F"]');
		dragTo(document.querySelector('[data-dock-tab-id="x"]')!, 500, 300);
		expect(crossRegions()).toEqual([]);
		release(500, 300);
		expect(dock.layout.floating.map((w) => w.id)).toContain('x');
	});

	it('its own group, centre: a no-op as before', () => {
		const { dock } = mount();
		hit = onPane('t');
		dragTo(document.querySelector('[data-dock-tab-id="x"]')!, 500, 300);
		expect(crossRegions()).toContain('center');
		release(500, 300);
		expect(dock.layout).toEqual(mixed());
	});

	it('dropCenter: false withholds the centre; a release there floats instead of joining', () => {
		const { dock } = mount((id) => (id === 'p' ? { dropCenter: false } : undefined));
		hit = onPane('p');
		dragTo(titlebarF(), 500, 300);
		expect(crossRegions()).toEqual(['left', 'right', 'top', 'bottom']);
		release(500, 300);
		expect(dock.layout.docked).toEqual(mixed().docked);
	});

	it('dropSplit: false withholds the four sides', () => {
		const { dock } = mount((id) => (id === 'p' ? { dropSplit: false } : undefined));
		hit = onPane('p');
		dragTo(titlebarF(), 536, 300);
		expect(crossRegions()).toEqual(['center']);
		release(536, 300);
		expect(dock.layout.docked).toEqual(mixed().docked);
	});

	it('a tab group offers a button only when every pane in it allows it', () => {
		mount((id) => (id === 'y' ? { dropCenter: false } : undefined));
		hit = onPane('t');
		dragTo(titlebarF(), 500, 300);
		expect(crossRegions()).toEqual(['left', 'right', 'top', 'bottom']);
		release(500, 300);
	});
});

// #694 (left over from PR-1, which repaired only the outer-edge drop): a drop on a cross button
// re-builds the docked tree too, and the re-mount drops the DOM focus on <body>.
describe('the focus after a drop that re-mounts docked panes (DockHost)', () => {
	const inputOf = (name: string) =>
		document.querySelector<HTMLInputElement>(`input[aria-label="${name} input"]`)!;
	const frameOf = (id: string) =>
		document.querySelector<HTMLElement>(`[data-dock-drop-id="${id}"]`)!;
	const tabOf = (id: string) => document.querySelector<HTMLElement>(`[data-dock-tab-id="${id}"]`)!;

	it('a split: a focus lost to the re-mount goes back to the frame it was in (the body of p)', async () => {
		const { dock } = mount();
		const before = inputOf('P');
		before.focus();
		hit = onPane('p');
		dragTo(titlebarF(), 500, 336);
		release(500, 336);
		await tick();
		// P is wrapped in a new column split with F under it: re-mounted.
		expect(dock.layout.docked).toMatchObject({
			children: [{ id: 't' }, { direction: 'column', children: [{ id: 'p' }, { id: 'f' }] }]
		});
		expect(inputOf('P')).not.toBe(before);
		expect(document.activeElement).toBe(frameOf('p').querySelector('[role="region"]'));
	});

	it('a new tab: the pane became a tab, the focus goes to the active tab of its group', async () => {
		const { dock } = mount();
		inputOf('P').focus();
		hit = onPane('p');
		dragTo(titlebarF(), 500, 300);
		release(500, 300);
		await tick();
		expect(dock.layout.docked).toMatchObject({
			children: [{ id: 't' }, { type: 'tabs', children: [{ id: 'p' }, { id: 'f' }] }]
		});
		const active = document.activeElement as HTMLElement;
		expect(active.getAttribute('role')).toBe('tab');
		expect(active.tabIndex).toBe(0);
		expect(active.closest('[data-dock-drop-id]')).toBe(tabOf('p').closest('[data-dock-drop-id]'));
	});

	it('a focus that survived is left alone (in the tab group the split does not touch)', async () => {
		mount();
		const input = inputOf('X');
		input.focus();
		hit = onPane('p');
		dragTo(titlebarF(), 500, 336);
		release(500, 336);
		await tick();
		expect(document.activeElement).toBe(input);
	});

	it('a focus a hook moved elsewhere while the answer waited is left alone', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		mount(undefined, (c) => (c.kind === 'dock' && outside.focus(), true));
		inputOf('P').focus();
		hit = onPane('p');
		dragTo(titlebarF(), 500, 336);
		release(500, 336);
		await tick();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	it('a docked pane floated: the pane that stays is re-mounted, its focus goes back to its frame', async () => {
		const { dock } = mount();
		const before = inputOf('X');
		before.focus();
		// Off every button, over the host: P floats and the split collapses to the tab group.
		dragTo(frameOf('p').querySelector('.titlebar')!, 300, 300);
		release(300, 300);
		await tick();
		expect(dock.layout.docked).toMatchObject({ type: 'tabs', id: 't' });
		expect(dock.layout.floating.map((w) => w.id)).toContain('p');
		expect(inputOf('X')).not.toBe(before);
		expect(document.activeElement).toBe(tabOf('x'));
	});

	it('a docked pane floated with the focus in it: the focus goes to its new window', async () => {
		mount();
		inputOf('P').focus();
		dragTo(frameOf('p').querySelector('.titlebar')!, 300, 300);
		release(300, 300);
		await tick();
		expect(document.activeElement).toBe(document.querySelector('[data-dock-window-id="p"]'));
	});
});
