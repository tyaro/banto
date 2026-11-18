// @vitest-environment jsdom
//
// Docking on the host's outer edges (#694 PR-1): the pure tree operation
// (`dockPanelAtEdge`), the outer-edge hit strips (`core/edges.ts`), the
// `DockState` methods, and the drop through `DockHost` - the panes whose
// chain the wrap changes are asked first (`reparent`), then the moved pane
// (`dock` / `move-docked`); a structure change while the answer waits is
// `stale`; an empty tree behaves as before; the strips exist only during a
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
import { computeEdgeDrop, EDGE_DROP_BAND, edgeBandSize } from '../src/core/edges';
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

	it('wraps the root in a new split, the panel on the given side, even sizes', () => {
		expect(dockPanelAtEdge(root, panel('n'), 'left', fixedId)).toEqual({
			type: 'split',
			id: 'new',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [panel('n'), root]
		});
		expect(dockPanelAtEdge(root, panel('n'), 'right', fixedId)).toMatchObject({
			direction: 'row',
			children: [root, panel('n')]
		});
		expect(dockPanelAtEdge(root, panel('n'), 'top', fixedId)).toMatchObject({
			direction: 'column',
			children: [panel('n'), root]
		});
		expect(dockPanelAtEdge(root, panel('n'), 'bottom', fixedId)).toMatchObject({
			direction: 'column',
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

describe('computeEdgeDrop / edgeBandSize (core/edges)', () => {
	it('a strip of EDGE_DROP_BAND px on each side; strict boundary; the centre is none', () => {
		const b = EDGE_DROP_BAND;
		expect(computeEdgeDrop(0, 300, 1000, 600)).toBe('left');
		expect(computeEdgeDrop(b - 1, 300, 1000, 600)).toBe('left');
		expect(computeEdgeDrop(b, 300, 1000, 600)).toBeNull();
		expect(computeEdgeDrop(999, 300, 1000, 600)).toBe('right');
		expect(computeEdgeDrop(500, 2, 1000, 600)).toBe('top');
		expect(computeEdgeDrop(500, 598, 1000, 600)).toBe('bottom');
		expect(computeEdgeDrop(500, 300, 1000, 600)).toBeNull();
	});

	it('corners go to the nearer side, ties to left > right > top > bottom; outside is none', () => {
		expect(computeEdgeDrop(10, 2, 1000, 600)).toBe('top');
		expect(computeEdgeDrop(2, 10, 1000, 600)).toBe('left');
		expect(computeEdgeDrop(5, 5, 1000, 600)).toBe('left');
		expect(computeEdgeDrop(-1, 300, 1000, 600)).toBeNull();
		expect(computeEdgeDrop(1001, 300, 1000, 600)).toBeNull();
		expect(computeEdgeDrop(0, 0, 0, 600)).toBeNull();
	});

	it('a small host gets a thinner strip (an eighth of the smaller side)', () => {
		expect(edgeBandSize(1000, 600)).toBe(EDGE_DROP_BAND);
		expect(edgeBandSize(400, 80)).toBe(10);
		expect(computeEdgeDrop(12, 40, 400, 80)).toBeNull();
		expect(edgeBandSize(0, 600)).toBe(0);
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
		const single = createDockState({ version: 2, floating: [], docked: panel('p') });
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
	it('the strips are drawn only during a drag; the hovered one is active with a half-host guide', () => {
		mount(mixed());
		expect(document.querySelectorAll('.edge-drop')).toHaveLength(0);
		dragTo(titlebarOf('F'), 5, 300);
		const strips = [...document.querySelectorAll<HTMLElement>('.edge-drop')];
		expect(strips.map((s) => s.dataset.dockEdge)).toEqual(['left', 'right', 'top', 'bottom']);
		expect(
			strips.filter((s) => s.classList.contains('active')).map((s) => s.dataset.dockEdge)
		).toEqual(['left']);
		const guide = document.querySelector<HTMLElement>('.snap-guide')!;
		expect([guide.style.left, guide.style.top, guide.style.width, guide.style.height]).toEqual([
			'0px',
			'0px',
			'500px',
			'600px'
		]);
		release(500, 300);
		expect(document.querySelectorAll('.edge-drop')).toHaveLength(0);
	});

	it('asks the wrapped panes first (reparent, tree order), then the dropped pane; docks along the edge', () => {
		const calls: string[] = [];
		const { dock } = mount(mixed(), { beforePanelChange: (c) => (calls.push(label(c)), true) });
		const before = inputOf('P');
		dragTo(titlebarOf('F'), 5, 300);
		release(5, 300);
		expect(calls).toEqual(['reparent x', 'reparent p', 'dock f']);
		expect(dock.layout.floating).toEqual([]);
		expect(dock.layout.docked).toMatchObject({
			type: 'split',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [{ id: 'f' }, { id: 's' }]
		});
		// What the question is about: P's content really is a new mount.
		expect(inputOf('P')).not.toBeNull();
		expect(inputOf('P')).not.toBe(before);
	});

	it('the outer edge wins over the edge band of the pane under it', () => {
		const { dock } = mount(mixed());
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragTo(titlebarOf('F'), 995, 300);
		release(995, 300);
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
		dragTo(titlebarOf('F'), 5, 300);
		release(5, 300);
		expect(calls).toEqual(['reparent x']);
		expect(dock.layout).toEqual(mixed());
	});

	it('keepMounted panes are asked too (a background tab is re-mounted as well)', () => {
		const asked: DockPanelChange[] = [];
		mount(mixed(), { beforePanelChange: (c) => (asked.push(c), true), keepMounted: () => true });
		dragTo(titlebarOf('F'), 500, 595);
		release(500, 595);
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
		dragTo(tabOf('x'), 995, 300);
		release(995, 300);
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
		dragTo(titlebarOf('F'), 5, 300);
		release(5, 300);
		dock.setActiveTab('t', 1); // the app switches a tab while the answer waits
		answer(true);
		await nextTask();
		expect(calls).toEqual(['reparent x']);
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['f']);
	});

	it('an empty tree: no strips, a drop near the border moves the floating window as before', () => {
		const layout: DockLayout = {
			version: 2,
			floating: [{ id: 'f', title: 'F', x: 600, y: 300, width: 300, height: 200, open: true }],
			docked: null
		};
		const { dock } = mount(layout);
		dragTo(titlebarOf('F'), 5, 300);
		expect(document.querySelectorAll('.edge-drop')).toHaveLength(0);
		release(5, 300);
		expect(dock.layout.docked).toBeNull();
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['f']);
	});

	it('the only docked pane is not offered the edges (nothing to wrap)', () => {
		const layout: DockLayout = { version: 2, floating: [], docked: panel('p') };
		const { dock } = mount(layout);
		hit = () => document.querySelector('[data-dock-drop-id="p"]');
		dragTo(document.querySelector('[data-dock-drop-id="p"] [role="toolbar"]')!, 5, 300);
		expect(document.querySelectorAll('.edge-drop')).toHaveLength(0);
		release(5, 300);
		expect(dock.layout.docked).toEqual(panel('p'));
	});

	it('a focus lost to the re-mount goes back to the frame it was in (the active tab of t)', async () => {
		mount(mixed());
		inputOf('X')!.focus();
		dragTo(titlebarOf('F'), 5, 300);
		release(5, 300);
		await tick();
		expect(document.activeElement).toBe(tabOf('x'));
	});

	it('a focus that survived or that a hook moved elsewhere is left alone', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		mount(mixed(), { beforePanelChange: (c) => (c.kind === 'dock' && outside.focus(), true) });
		inputOf('X')!.focus();
		dragTo(titlebarOf('F'), 5, 300);
		release(5, 300);
		await tick();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});
});
