// @vitest-environment jsdom
//
// Docking on the host's outer edges (#694 PR-1, buttons since PR-2): the pure
// tree operation (`dockPanelAtEdge`, a quarter of the host), the outer-edge
// buttons (`core/edges.ts`), the
// `DockState` methods, and the drop through `DockHost` - the panes whose
// chain the wrap changes are asked first (`reparent`), then the moved pane
// (`dock` / `move-docked`); a structure change while the answer waits is
// `stale`; an empty tree behaves as before; the buttons exist only during a
// drag; a focus lost to the re-mount is handed back.
//
// jsdom has no layout engine: every element's rect is 1000 x 600 at the
// origin (so the host and the pane frames coincide) and `elementFromPoint`
// returns `hit()`; all restored in afterAll (same harness as
// DockHostLifecycle.test.ts).
import { cleanup, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import {
	computeEdgeDrop,
	edgeButtons,
	edgeGuideRect,
	insetViewport,
	visibleHostRect
} from '../src/core/edges';
import type { DockPanelChange } from '../src/core/lifecycle';
import { dockPanelAtEdge } from '../src/core/tree';
import { createDockState } from '../src/state.svelte';
import type { DockLayout, DockNode, DockPanelNode } from '../src/types';

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });

describe('dockPanelAtEdge (core/tree)', () => {
	const fixedId = () => 'new';
	const root: DockNode = {
		type: 'split',
		id: 's',
		direction: 'row',
		sizes: [0.3, 0.7],
		children: [panel('a'), panel('b')]
	};

	it('wraps the root in a new split, the panel on the given side with a quarter of it', () => {
		expect(dockPanelAtEdge(root, panel('n'), 'left', fixedId)).toEqual({
			type: 'split',
			id: 'new',
			direction: 'row',
			sizes: [0.25, 0.75],
			children: [panel('n'), root]
		});
		expect(dockPanelAtEdge(root, panel('n'), 'right', fixedId)).toMatchObject({
			direction: 'row',
			sizes: [0.75, 0.25],
			children: [root, panel('n')]
		});
		expect(dockPanelAtEdge(root, panel('n'), 'top', fixedId)).toMatchObject({
			direction: 'column',
			sizes: [0.25, 0.75],
			children: [panel('n'), root]
		});
		expect(dockPanelAtEdge(root, panel('n'), 'bottom', fixedId)).toMatchObject({
			direction: 'column',
			sizes: [0.75, 0.25],
			children: [root, panel('n')]
		});
	});

	it('always wraps, even a root split in the same direction; the input is not mutated', () => {
		const copy = structuredClone(root);
		const out = dockPanelAtEdge(root, panel('n'), 'right', fixedId) as {
			children: DockNode[];
		};
		expect(out.children).toHaveLength(2);
		expect(out.children[0]).toBe(root);
		expect(root).toEqual(copy);
	});

	it('an empty tree: the panel becomes the root; a collapsed flag is dropped', () => {
		expect(dockPanelAtEdge(null, { ...panel('n'), collapsed: true }, 'left', fixedId)).toEqual(
			panel('n')
		);
	});
});

describe('computeEdgeDrop / edgeButtons (core/edges)', () => {
	// 1000 x 600 host: 32 px buttons, 8 px in from each side, at the middle of the side.
	it('one button per side at its middle; only the button is a target', () => {
		expect(edgeButtons(1000, 600)).toEqual([
			{ region: 'left', rect: { x: 8, y: 284, width: 32, height: 32 } },
			{ region: 'right', rect: { x: 960, y: 284, width: 32, height: 32 } },
			{ region: 'top', rect: { x: 484, y: 8, width: 32, height: 32 } },
			{ region: 'bottom', rect: { x: 484, y: 560, width: 32, height: 32 } }
		]);
		expect(computeEdgeDrop(24, 300, 1000, 600)).toBe('left');
		expect(computeEdgeDrop(8, 284, 1000, 600)).toBe('left');
		expect(computeEdgeDrop(40, 300, 1000, 600)).toBeNull();
		expect(computeEdgeDrop(976, 300, 1000, 600)).toBe('right');
		expect(computeEdgeDrop(500, 24, 1000, 600)).toBe('top');
		expect(computeEdgeDrop(500, 576, 1000, 600)).toBe('bottom');
		// The old 24 px strip along a side is no longer a target.
		expect(computeEdgeDrop(2, 300, 1000, 600)).toBeNull();
		expect(computeEdgeDrop(2, 100, 1000, 600)).toBeNull();
		expect(computeEdgeDrop(500, 300, 1000, 600)).toBeNull();
		expect(computeEdgeDrop(0, 0, 0, 600)).toBeNull();
	});

	it('a small host gets smaller buttons, and none below the minimum', () => {
		expect(edgeButtons(400, 80)[0].rect).toEqual({ x: 8, y: 31, width: 18, height: 18 });
		expect(edgeButtons(400, 60)).toEqual([]);
		expect(computeEdgeDrop(10, 30, 400, 60)).toBeNull();
	});
});

// #1043: a host that is not wholly on screen. The buttons go to the part that is.
describe('the outer-edge buttons of a host partly off screen (core/edges, #1043)', () => {
	const viewport = { x: 0, y: 0, width: 1280, height: 800 };
	const regions = (buttons: ReturnType<typeof edgeButtons>) =>
		Object.fromEntries(buttons.map((b) => [b.region, b.rect]));

	it('visibleHostRect: the host cut by the viewport and the scroll containers, host-local', () => {
		// Wholly on screen: the whole host.
		expect(visibleHostRect({ x: 100, y: 50, width: 1000, height: 600 }, [viewport])).toEqual({
			x: 0,
			y: 0,
			width: 1000,
			height: 600
		});
		// Taller than the viewport, its top at 115: 685 px of it show.
		expect(visibleHostRect({ x: 100, y: 115, width: 1000, height: 1100 }, [viewport])).toEqual({
			x: 0,
			y: 0,
			width: 1000,
			height: 685
		});
		// Scrolled: 300 px out at the top.
		expect(visibleHostRect({ x: 100, y: -300, width: 1000, height: 1100 }, [viewport])).toEqual({
			x: 0,
			y: 300,
			width: 1000,
			height: 800
		});
		// A scroll container (under a 64 px header) cuts it further, on both axes.
		expect(
			visibleHostRect({ x: 100, y: -300, width: 1000, height: 1100 }, [
				viewport,
				{ x: 240, y: 64, width: 1040, height: 736 }
			])
		).toEqual({ x: 140, y: 364, width: 860, height: 736 });
		// Not on screen at all: nothing (never a negative size).
		expect(visibleHostRect({ x: 0, y: 900, width: 1000, height: 600 }, [viewport])).toMatchObject({
			width: 1000,
			height: 0
		});
	});

	it('a host taller than the viewport: every button is in the part on screen, at the middle of its sides', () => {
		// The issue's case: the bottom button was at y = 1060 of a 1100 px host (off an 800 px viewport).
		expect(edgeButtons(1000, 1100)[3].rect.y).toBe(1060);
		const visible = visibleHostRect({ x: 100, y: 115, width: 1000, height: 1100 }, [viewport]);
		expect(regions(edgeButtons(1000, 1100, {}, visible))).toEqual({
			left: { x: 8, y: 326.5, width: 32, height: 32 },
			right: { x: 960, y: 326.5, width: 32, height: 32 },
			top: { x: 484, y: 8, width: 32, height: 32 },
			bottom: { x: 484, y: 645, width: 32, height: 32 }
		});
		// Only where the button is drawn is a target.
		expect(computeEdgeDrop(500, 660, 1000, 1100, visible)).toBe('bottom');
		expect(computeEdgeDrop(500, 1076, 1000, 1100, visible)).toBeNull();
		expect(computeEdgeDrop(24, 342, 1000, 1100, visible)).toBe('left');
		expect(computeEdgeDrop(24, 550, 1000, 1100, visible)).toBeNull();
	});

	it('a host out at the top (scrolled): the top button comes down to the part on screen', () => {
		const visible = visibleHostRect({ x: 0, y: -300, width: 1000, height: 1100 }, [viewport]);
		expect(regions(edgeButtons(1000, 1100, {}, visible))).toEqual({
			left: { x: 8, y: 684, width: 32, height: 32 },
			right: { x: 960, y: 684, width: 32, height: 32 },
			top: { x: 484, y: 308, width: 32, height: 32 },
			bottom: { x: 484, y: 1060, width: 32, height: 32 }
		});
	});

	it('a host out at the left and the right: the side buttons come in', () => {
		const visible = visibleHostRect({ x: -200, y: 0, width: 2000, height: 600 }, [viewport]);
		expect(regions(edgeButtons(2000, 600, {}, visible))).toMatchObject({
			left: { x: 208, y: 284 },
			right: { x: 1440, y: 284 },
			top: { x: 824, y: 8 },
			bottom: { x: 824, y: 560 }
		});
	});

	it('a host wholly on screen, or smaller than it: as before', () => {
		for (const [w, h] of [
			[1000, 600],
			[400, 80],
			[400, 60]
		]) {
			const visible = visibleHostRect({ x: 20, y: 30, width: w, height: h }, [viewport]);
			expect(edgeButtons(w, h, {}, visible)).toEqual(edgeButtons(w, h));
			for (const edge of ['left', 'right', 'top', 'bottom'] as const)
				expect(edgeGuideRect(w, h, edge, {}, visible)).toEqual(edgeGuideRect(w, h, edge));
		}
		// The quarter of the host (`EDGE_DOCK_RATIO`).
		expect(edgeGuideRect(1000, 600, 'left')).toEqual({ x: 0, y: 0, width: 250, height: 600 });
		expect(edgeGuideRect(1000, 600, 'bottom')).toEqual({ x: 0, y: 450, width: 1000, height: 150 });
	});

	it('little of the host on screen: smaller buttons that do not meet, none when they would not fit', () => {
		const strip = visibleHostRect({ x: 0, y: 720, width: 1000, height: 1100 }, [viewport]);
		expect(strip.height).toBe(80);
		const buttons = edgeButtons(1000, 1100, {}, strip);
		expect(buttons.map((b) => b.rect.width)).toEqual([18, 18, 18, 18]);
		expect(regions(buttons).top.y + 18).toBeLessThanOrEqual(regions(buttons).bottom.y);
		const sliver = visibleHostRect({ x: 0, y: 760, width: 1000, height: 1100 }, [viewport]);
		expect(edgeButtons(1000, 1100, {}, sliver)).toEqual([]);
	});

	it('the snap guide: the part of the quarter on screen, at least a strip around the button', () => {
		const visible = { x: 0, y: 0, width: 1000, height: 685 };
		// The sides: the quarter, as tall as what shows.
		expect(edgeGuideRect(1000, 1100, 'left', {}, visible)).toEqual({
			x: 0,
			y: 0,
			width: 250,
			height: 685
		});
		expect(edgeGuideRect(1000, 1100, 'right', {}, visible)).toEqual({
			x: 750,
			y: 0,
			width: 250,
			height: 685
		});
		// The top quarter (275 px) is on screen whole.
		expect(edgeGuideRect(1000, 1100, 'top', {}, visible)).toEqual({
			x: 0,
			y: 0,
			width: 1000,
			height: 275
		});
		// The bottom quarter (825..1100) is not on screen: a strip around the button (32 + 2 * 8).
		const bottom = edgeGuideRect(1000, 1100, 'bottom', {}, visible);
		expect(bottom).toEqual({ x: 0, y: 637, width: 1000, height: 48 });
		const button = edgeButtons(1000, 1100, {}, visible)[3].rect;
		expect(button.y).toBeGreaterThanOrEqual(bottom.y);
		expect(button.y + button.height).toBeLessThanOrEqual(bottom.y + bottom.height);
		// Scrolled until part of it shows: that part.
		expect(
			edgeGuideRect(1000, 1100, 'bottom', {}, { x: 0, y: 200, width: 1000, height: 800 })
		).toEqual({ x: 0, y: 825, width: 1000, height: 175 });
		// Scrolled to the end: the whole quarter.
		expect(
			edgeGuideRect(1000, 1100, 'bottom', {}, { x: 0, y: 300, width: 1000, height: 800 })
		).toEqual({ x: 0, y: 825, width: 1000, height: 275 });
	});
});

describe('DockState.dockPanelAtEdge / dockExistingAtEdge', () => {
	it('a floating window docks along the edge and leaves floating', () => {
		const dock = createDockState(mixed());
		dock.dockPanelAtEdge('f', 'bottom');
		expect(dock.layout.floating).toEqual([]);
		expect(dock.layout.docked).toMatchObject({
			type: 'split',
			direction: 'column',
			children: [{ id: 's' }, { id: 'f' }]
		});
	});

	it('a docked pane is taken out and put along the edge; the only docked pane is a no-op', () => {
		const dock = createDockState(mixed());
		dock.dockExistingAtEdge('p', 'top');
		expect(dock.layout.docked).toMatchObject({
			type: 'split',
			direction: 'column',
			children: [{ id: 'p' }, { id: 't' }]
		});
		const single = createDockState({ version: 4, floating: [], docked: panel('p') });
		single.dockExistingAtEdge('p', 'left');
		expect(single.layout.docked).toEqual(panel('p'));
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

/** Press, cross the drag threshold, move to (x, y) - the drag is still in progress. */
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

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

type Props = {
	beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
	keepMounted?: (panelId: string) => boolean;
};

function mount(layout: DockLayout, props: Props = {}) {
	const dock = createDockState(layout);
	render(DockHostHarness, { dock, ...props });
	return { dock };
}

const titlebarOf = (name: string) =>
	document.querySelector(`[role="dialog"][aria-label="${name}"] .titlebar`)!;
const tabOf = (id: string) => document.querySelector<HTMLElement>(`[data-dock-tab-id="${id}"]`)!;
const inputOf = (name: string) =>
	document.querySelector<HTMLInputElement>(`input[aria-label="${name} input"]`);
const label = (c: DockPanelChange) =>
	c.kind === 'tab-switch' ? `tab-switch ${c.from}>${c.to}` : `${c.kind} ${c.panelId}`;

describe('a drop on the outer edge of the host (DockHost)', () => {
	it('the buttons are drawn only during a drag; the hovered one is active with a quarter-host guide', () => {
		mount(mixed());
		expect(document.querySelectorAll('.guide-button')).toHaveLength(0);
		dragTo(titlebarOf('F'), 24, 300);
		const buttons = [...document.querySelectorAll<HTMLElement>('.guide-button.outer')];
		expect(buttons.map((s) => s.dataset.dockEdge)).toEqual(['left', 'right', 'top', 'bottom']);
		expect(buttons.every((b) => b.getAttribute('aria-hidden') === 'true')).toBe(true);
		expect(
			buttons.filter((s) => s.classList.contains('active')).map((s) => s.dataset.dockEdge)
		).toEqual(['left']);
		const guide = document.querySelector<HTMLElement>('.snap-guide')!;
		expect([guide.style.left, guide.style.top, guide.style.width, guide.style.height]).toEqual([
			'0px',
			'0px',
			'250px',
			'600px'
		]);
		firePointer(window, 'pointermove', 995, 300);
		flushSync();
		// Off the button (still near the side): no edge guide, the floating preview instead.
		expect(document.querySelector('.guide-button.active')).toBeNull();
		expect(document.querySelector<HTMLElement>('.snap-guide')!.style.width).toBe('300px');
		release(500, 300);
		expect(document.querySelectorAll('.guide-button')).toHaveLength(0);
	});

	it('a release near a side but off its button does not dock (the window moves)', () => {
		const { dock } = mount(mixed());
		dragTo(titlebarOf('F'), 5, 300);
		release(5, 300);
		expect(dock.layout.docked).toEqual(mixed().docked);
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['f']);
	});

	it('asks the wrapped panes first (reparent, tree order), then the dropped pane; docks along the edge', () => {
		const calls: string[] = [];
		const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(label(c)), true) });
		const before = inputOf('P');
		dragTo(titlebarOf('F'), 24, 300);
		release(24, 300);
		expect(calls).toEqual(['reparent x', 'reparent p', 'dock f']);
		expect(dock.layout.floating).toEqual([]);
		expect(dock.layout.docked).toMatchObject({
			type: 'split',
			direction: 'row',
			sizes: [0.25, 0.75],
			children: [{ id: 'f' }, { id: 's' }]
		});
		// What the question is about: P's content really is a new mount.
		expect(inputOf('P')).not.toBeNull();
		expect(inputOf('P')).not.toBe(before);
	});

	it('an outer-edge button wins over the pane under it', () => {
		const { dock } = mount(mixed());
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragTo(titlebarOf('F'), 976, 300);
		release(976, 300);
		expect(dock.layout.docked).toMatchObject({
			direction: 'row',
			children: [{ id: 's' }, { id: 'f' }]
		});
	});

	it('a refusal by a pushed-out pane stops it: nothing changes and the dropped pane is not asked', () => {
		const calls: string[] = [];
		const { dock } = mount(mixed(), {
			beforePanelChange: (c) => (calls.push(label(c)), c.kind !== 'reparent')
		});
		dragTo(titlebarOf('F'), 24, 300);
		release(24, 300);
		expect(calls).toEqual(['reparent x']);
		expect(dock.layout).toEqual(mixed());
	});

	it('keepMounted panes are asked too (a background tab is re-mounted as well)', () => {
		const asked: DockPanelChange[] = [];
		mount(mixed(), { beforePanelChange: (c) => (asked.push(c), true), keepMounted: () => true });
		dragTo(titlebarOf('F'), 500, 576);
		release(500, 576);
		expect(asked).toEqual([
			{ kind: 'reparent', panelId: 'x', cause: 'f', remount: true },
			{ kind: 'reparent', panelId: 'y', cause: 'f', remount: true },
			{ kind: 'reparent', panelId: 'p', cause: 'f', remount: true },
			{ kind: 'dock', panelId: 'f', remount: true }
		]);
	});

	it('a docked pane moved to the edge: only the panes whose chain changes are asked, then move-docked', () => {
		const calls: string[] = [];
		const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(label(c)), true) });
		dragTo(tabOf('x'), 976, 300);
		release(976, 300);
		// x leaves t (t collapses to the bare pane y, which was not mounted); p moves one level down.
		expect(calls).toEqual(['reparent p', 'move-docked x']);
		expect(dock.layout.docked).toMatchObject({
			type: 'split',
			direction: 'row',
			children: [{ id: 's', children: [{ id: 'y' }, { id: 'p' }] }, { id: 'x' }]
		});
	});

	it('an approval whose structure changed meanwhile is stale: the dropped pane is not asked nor docked', async () => {
		let answer: (ok: boolean) => void = () => {};
		const calls: string[] = [];
		const { dock } = mount(mixed(), {
			beforePanelChange: (c) => (calls.push(label(c)), new Promise<boolean>((r) => (answer = r)))
		});
		dragTo(titlebarOf('F'), 24, 300);
		release(24, 300);
		dock.setActiveTab('t', 1); // the app switches a tab while the answer waits
		answer(true);
		await nextTask();
		expect(calls).toEqual(['reparent x']);
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['f']);
	});

	it('an empty tree: no buttons, a drop near the border moves the floating window as before', () => {
		const layout: DockLayout = {
			version: 4,
			floating: [{ id: 'f', title: 'F', x: 600, y: 300, width: 300, height: 200, open: true }],
			docked: null
		};
		const { dock } = mount(layout);
		dragTo(titlebarOf('F'), 24, 300);
		expect(document.querySelectorAll('.guide-button')).toHaveLength(0);
		release(24, 300);
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['f']);
	});

	it('the only docked pane is not offered the edges (nothing to wrap)', () => {
		const layout: DockLayout = { version: 4, floating: [], docked: panel('p') };
		const { dock } = mount(layout);
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragTo(document.querySelector('[data-dock-drop-id="p"] [role="toolbar"]')!, 24, 300);
		expect(document.querySelectorAll('.guide-button.outer')).toHaveLength(0);
		release(24, 300);
		// Where the left button would be is off every button: the pane floats, nothing is wrapped.
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['p']);
	});

	it('a small pane on the border: the cross buttons under an outer button are not offered, the outer one wins', () => {
		const { dock } = mount(mixed());
		const paneP = document.querySelector('[data-dock-drop-id="p"]')!;
		const whole = Element.prototype.getBoundingClientRect.call(document.body);
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: Element
		) {
			if (this !== paneP) return whole;
			return { ...whole, left: 0, top: 220, right: 160, bottom: 380, width: 160, height: 160 };
		});
		hit = () => paneP;
		dragTo(titlebarOf('F'), 24, 300);
		const cross = [...document.querySelectorAll<HTMLElement>('.guide-button:not(.outer)')];
		expect(cross.map((b) => b.dataset.dockCross)).toEqual(['center', 'right', 'top', 'bottom']);
		release(24, 300);
		expect(dock.layout.docked).toMatchObject({ children: [{ id: 'f' }, { id: 's' }] });
	});

	it('a focus lost to the re-mount goes back to the frame it was in (the active tab of t)', async () => {
		mount(mixed());
		inputOf('X')!.focus();
		dragTo(titlebarOf('F'), 24, 300);
		release(24, 300);
		await tick();
		expect(document.activeElement).toBe(tabOf('x'));
	});

	it('a focus that survived or that a hook moved elsewhere is left alone', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		mount(mixed(), { beforePanelChange: (c) => (c.kind === 'dock' && outside.focus(), true) });
		inputOf('X')!.focus();
		dragTo(titlebarOf('F'), 24, 300);
		release(24, 300);
		await tick();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});
});

// #1043. The viewport here is 1000 x 600 (`clientWidth` / `clientHeight` of every element,
// `<html>` included); the host is 1000 x 2000, so 600 px of it show.
describe('a host taller than the viewport (DockHost, #1043)', () => {
	let top = 0;
	const hostEl = () => document.querySelector<HTMLElement>('[data-dock-host]')!;
	const outer = (edge: string) =>
		document.querySelector<HTMLElement>(`.guide-button.outer[data-dock-edge="${edge}"]`)!;
	const box = (el: HTMLElement) => [el.style.left, el.style.top, el.style.width, el.style.height];

	/** Every element is the 1000 x 2000 host at `top`, but `clipper` (a box of its own). */
	function tall(clipper?: { el: Element; top: number }) {
		top = 0;
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: Element
		) {
			const y = this === clipper?.el ? clipper.top : top;
			return {
				left: 0,
				top: y,
				right: 1000,
				bottom: y + 2000,
				width: 1000,
				height: 2000,
				x: 0,
				y,
				toJSON: () => ({})
			} as DOMRect;
		});
	}

	it('the buttons are in the part on screen; a drop on the bottom one docks along the bottom of the HOST', () => {
		tall();
		const { dock } = mount(mixed());
		dragTo(titlebarOf('F'), 500, 576);
		expect(box(outer('left'))).toEqual(['8px', '284px', '32px', '32px']);
		expect(box(outer('right'))).toEqual(['960px', '284px', '32px', '32px']);
		expect(box(outer('top'))).toEqual(['484px', '8px', '32px', '32px']);
		// Was 1960px: 1360 px below the viewport.
		expect(box(outer('bottom'))).toEqual(['484px', '560px', '32px', '32px']);
		expect(outer('bottom').classList.contains('active')).toBe(true);
		// The bottom quarter (1500..2000) is not on screen: the guide is a strip around the button.
		expect(box(document.querySelector<HTMLElement>('.snap-guide')!)).toEqual([
			'0px',
			'552px',
			'1000px',
			'48px'
		]);
		release(500, 576);
		expect(dock.layout.floating).toEqual([]);
		expect(dock.layout.docked).toMatchObject({
			type: 'split',
			direction: 'column',
			sizes: [0.75, 0.25],
			children: [{ id: 's' }, { id: 'f' }]
		});
	});

	it('where the bottom button was (the bottom of the host) is not a target any more', () => {
		tall();
		const { dock } = mount(mixed());
		// Scrolled to the end, the pointer over the old place of the TOP button (host-local y 24).
		top = -1400;
		dragTo(titlebarOf('F'), 500, -1376);
		expect(document.querySelector('.guide-button.active')).toBeNull();
		release(500, -1376);
		expect(dock.layout.docked).toEqual(mixed().docked);
	});

	it('a scroll during the drag moves the buttons with the part on screen, without a pointer move', () => {
		tall();
		const { dock } = mount(mixed());
		dragTo(titlebarOf('F'), 500, 576);
		top = -1400;
		window.dispatchEvent(new Event('scroll'));
		flushSync();
		expect(box(outer('top'))).toEqual(['484px', '1408px', '32px', '32px']);
		expect(box(outer('left'))).toEqual(['8px', '1684px', '32px', '32px']);
		expect(box(outer('bottom'))).toEqual(['484px', '1960px', '32px', '32px']);
		// The pointer did not move: it is still on the bottom button, and the quarter shows now.
		expect(outer('bottom').classList.contains('active')).toBe(true);
		expect(box(document.querySelector<HTMLElement>('.snap-guide')!)).toEqual([
			'0px',
			'1500px',
			'1000px',
			'500px'
		]);
		// A scroll of an inner container is seen too (it does not bubble: listened in capture).
		top = -700;
		hostEl().parentElement!.dispatchEvent(new Event('scroll'));
		flushSync();
		expect(box(outer('top'))).toEqual(['484px', '708px', '32px', '32px']);
		// The bottom button stays where the pointer is: at the bottom of what shows.
		expect(box(outer('bottom'))).toEqual(['484px', '1260px', '32px', '32px']);
		expect(outer('bottom').classList.contains('active')).toBe(true);
		release(500, 576);
		expect(dock.layout.docked).toMatchObject({
			direction: 'column',
			sizes: [0.75, 0.25],
			children: [{ id: 's' }, { id: 'f' }]
		});
		// The listeners went with the drag.
		top = 0;
		window.dispatchEvent(new Event('scroll'));
		flushSync();
		expect(document.querySelectorAll('.guide-button')).toHaveLength(0);
	});

	it('a scroll container around the host cuts it too (a header above the scrolled area)', () => {
		const { dock } = mount(mixed());
		const scroller = hostEl().parentElement!;
		scroller.style.overflow = 'auto';
		// The scroller's box starts 100 px down (1000 x 600, like every `clientWidth` / `clientHeight`).
		tall({ el: scroller, top: 100 });
		try {
			dragTo(titlebarOf('F'), 500, 124);
			// 100..600 of the host show: the top button is under the scroller's top, not the viewport's.
			expect(box(outer('top'))).toEqual(['484px', '108px', '32px', '32px']);
			expect(box(outer('left'))).toEqual(['8px', '334px', '32px', '32px']);
			expect(box(outer('bottom'))).toEqual(['484px', '560px', '32px', '32px']);
			expect(outer('top').classList.contains('active')).toBe(true);
			release(500, 124);
			expect(dock.layout.docked).toMatchObject({
				direction: 'column',
				sizes: [0.25, 0.75],
				children: [{ id: 'f' }, { id: 's' }]
			});
		} finally {
			scroller.style.overflow = '';
		}
	});
});

// #1058: a fixed / sticky header that is not an ancestor of the host covers the top of the viewport.
describe('what covers the viewport is taken off the visible part (core/edges, #1058)', () => {
	const viewport = { x: 0, y: 0, width: 1280, height: 800 };

	it('insetViewport: nothing / 0 / junk = the viewport itself', () => {
		expect(insetViewport(viewport)).toEqual(viewport);
		expect(insetViewport(viewport, {})).toEqual(viewport);
		expect(insetViewport(viewport, { top: 0, bottom: -5 })).toEqual(viewport);
		expect(insetViewport(viewport, { top: Number.NaN, bottom: Infinity })).toEqual(viewport);
	});

	it('insetViewport: the top and the bottom are cut, never to a negative height', () => {
		expect(insetViewport(viewport, { top: 48 })).toEqual({ x: 0, y: 48, width: 1280, height: 752 });
		expect(insetViewport(viewport, { top: 48, bottom: 40 })).toEqual({
			x: 0,
			y: 48,
			width: 1280,
			height: 712
		});
		expect(insetViewport(viewport, { top: 700, bottom: 700 }).height).toBe(0);
	});

	it('a host scrolled under a 48px header: its visible part starts below the header, and so do the buttons', () => {
		// The dashboard's dock: 900 high, its top 260 px above the viewport top (scrolled).
		const host = { x: 0, y: -260, width: 1000, height: 900 };
		const plain = visibleHostRect(host, [viewport]);
		const covered = visibleHostRect(host, [insetViewport(viewport, { top: 48 })]);
		expect(plain.y).toBe(260);
		expect(covered.y).toBe(308);
		expect(covered.height).toBe(plain.height - 48);
		const top = edgeButtons(1000, 900, {}, covered).find((b) => b.region === 'top');
		// In host-local px, y=308 is the viewport's y=48 = the header's bottom edge.
		expect(top && top.rect.y).toBeGreaterThanOrEqual(308);
		const before = edgeButtons(1000, 900, {}, plain).find((b) => b.region === 'top');
		expect(before && before.rect.y).toBeLessThan(308);
	});
});
