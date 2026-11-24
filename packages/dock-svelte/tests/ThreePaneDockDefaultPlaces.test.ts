// @vitest-environment jsdom
//
// Issue #939: `ThreePaneDock`'s `defaultPlaces` - the app's own default places, so a pane hidden
// from a tab group comes back into it -, and the panes of the centre's row hidden one after the
// other come back at the widths they had, in whatever order they are shown (`sideWidthUnit` 'share'
// and 'px').
//
// jsdom: no layout; the host width is a constant (`width`) and the ResizeObserver is a stub.
import { cleanup, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import ThreePaneDockHarness from './ThreePaneDockHarness.svelte';
import { findParent } from '../src/core/tree';
import { createDockState, type DockState } from '../src/state.svelte';
import {
	THREE_PANE_IDS,
	threePaneDefaultPlaces,
	type ThreePaneExtraPanelDef,
	type ThreePaneSideWidthUnit
} from '../src/threePane';
import type { DockLayout, DockPanelNode, DockSplitNode } from '../src/types';

const saved: [object, string, PropertyDescriptor | undefined][] = [];
const width = 1760;

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
	stub(HTMLElement.prototype, 'clientWidth', { get: () => width });
	stub(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
});

afterAll(() => {
	for (const [target, prop, descriptor] of saved.reverse()) {
		if (descriptor) Object.defineProperty(target, prop, descriptor);
		else Reflect.deleteProperty(target, prop);
	}
});

afterEach(() => cleanup());

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await tick();
	flushSync();
}

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id });
const extra: ThreePaneExtraPanelDef[] = [
	{ id: 'layers', title: 'Layers', initial: { edge: 'left' } },
	{ id: 'parts', title: 'Parts', initial: { edge: 'left' } }
];

/** The app's layout: tabs[left, layers, parts] 240px | centre | right 240px (of 1760). */
const designer = (): DockLayout => ({
	version: 4,
	floating: [],
	docked: {
		type: 'split',
		id: 'designer:root',
		direction: 'row',
		sizes: [240 / width, 1 - 480 / width, 240 / width],
		children: [
			{
				type: 'tabs',
				id: 'designer:side',
				activeIndex: 0,
				children: [panel(THREE_PANE_IDS.left), panel('layers'), panel('parts')]
			},
			panel(THREE_PANE_IDS.center),
			panel(THREE_PANE_IDS.right)
		]
	}
});

function mount(props: { defaultPlaces?: unknown; sideWidthUnit?: ThreePaneSideWidthUnit }) {
	const dock: DockState = createDockState();
	const view = render(ThreePaneDockHarness, {
		props: { extra, initialLayout: designer(), ...props, dock }
	});
	flushSync();
	return {
		dock,
		api: () => view.component.api(),
		rerender: view.rerender,
		/** The px of the root row's children, by the id of the child (a tab group's id). */
		px: () => {
			const row = dock.layout.docked as DockSplitNode;
			return Object.fromEntries(row.children.map((c, i) => [c.id, row.sizes[i] * width]));
		},
		tabsOf: (id: string) => {
			const group = findParent(dock.layout.docked, id);
			return group?.type === 'tabs' ? group.children.map((c) => c.id) : null;
		}
	};
}

describe('ThreePaneDock defaultPlaces (#939)', () => {
	it('a pane hidden from a tab group comes back into it', async () => {
		const { api, tabsOf } = mount({ defaultPlaces: designer() });
		await settle();
		for (const id of ['layers', 'parts', THREE_PANE_IDS.left]) {
			expect(await api().setVisible(id, false)).toBe('applied');
			expect(await api().setVisible(id, true)).toBe('applied');
			expect(tabsOf(id), id).toEqual([THREE_PANE_IDS.left, 'layers', 'parts']);
		}
	});

	it('the whole group hidden and shown one by one: the group again, at its width', async () => {
		const { api, tabsOf, px } = mount({ defaultPlaces: designer() });
		await settle();
		const ids = [THREE_PANE_IDS.left, 'layers', 'parts'];
		for (const id of ids) expect(await api().setVisible(id, false)).toBe('applied');
		for (const id of ['parts', THREE_PANE_IDS.left, 'layers'])
			expect(await api().setVisible(id, true)).toBe('applied');
		expect(tabsOf('layers')).toEqual(ids);
		expect(px()['designer:side']).toBeCloseTo(240, 6);
	});

	it("without it: this component's own default places (the extra panel along its edge)", async () => {
		const { api, tabsOf } = mount({});
		await settle();
		expect(await api().setVisible('layers', false)).toBe('applied');
		expect(await api().setVisible('layers', true)).toBe('applied');
		expect(tabsOf('layers')).toBeNull();
	});

	it('follows a change of the prop, and ignores a value that is not a layout with the centre', async () => {
		const { dock, rerender } = mount({});
		await settle();
		const own = JSON.stringify(dock.defaultLayout?.docked);
		await rerender({ defaultPlaces: designer() });
		await settle();
		expect(dock.defaultLayout?.docked?.id).toBe('designer:root');
		for (const bad of ['{', { version: 4, floating: [], docked: panel('layers') }, undefined]) {
			await rerender({ defaultPlaces: bad });
			await settle();
			expect(JSON.stringify(dock.defaultLayout?.docked)).toBe(own);
			await rerender({ defaultPlaces: designer() });
			await settle();
			expect(dock.defaultLayout?.docked?.id).toBe('designer:root');
		}
	});

	// Cross-review of #940: a pane shown would become the active tab over the centre.
	it('the centre as a tab of a group is not taken: the pane shown leaves the centre showing', async () => {
		const overCentre: DockLayout = {
			version: 4,
			floating: [],
			docked: {
				type: 'tabs',
				id: 'over',
				activeIndex: 0,
				children: [panel(THREE_PANE_IDS.center), panel(THREE_PANE_IDS.left)]
			}
		};
		const { api, dock, tabsOf } = mount({ defaultPlaces: overCentre });
		await settle();
		expect(dock.defaultLayout?.docked?.id).not.toBe('over');
		expect(await api().setVisible(THREE_PANE_IDS.left, false)).toBe('applied');
		expect(await api().setVisible(THREE_PANE_IDS.left, true)).toBe('applied');
		expect(tabsOf(THREE_PANE_IDS.center)).toBeNull();
		expect(api().isVisible(THREE_PANE_IDS.center)).toBe(true);
	});

	it('tabs and the right pane hidden in turn (left, right, layers, parts), shown left first: 240px', async () => {
		const { api, px } = mount({ defaultPlaces: designer() });
		await settle();
		const order = [THREE_PANE_IDS.left, THREE_PANE_IDS.right, 'layers', 'parts'];
		for (const id of order) expect(await api().setVisible(id, false)).toBe('applied');
		for (const id of order) expect(await api().setVisible(id, true)).toBe('applied');
		expect(px()['designer:side']).toBeCloseTo(240, 6);
		expect(px()[THREE_PANE_IDS.right]).toBeCloseTo(240, 6);
	});

	it('threePaneDefaultPlaces takes the forms of a saved layout', () => {
		const options = {
			hostWidth: width,
			panels: { left: { title: 'L' }, center: { title: 'C' }, right: { title: 'R' }, extra }
		};
		const layout = designer();
		for (const given of [
			layout,
			JSON.stringify(layout),
			{ schema: 1, panels: [], layout },
			JSON.stringify({ schema: 1, panels: [], layout })
		])
			expect(threePaneDefaultPlaces(options, given).docked).toEqual(layout.docked);
	});
});

describe('ThreePaneDock: panes hidden together come back at their widths (#939)', () => {
	const all = [THREE_PANE_IDS.left, 'layers', 'parts', THREE_PANE_IDS.right];
	const orders = [
		[THREE_PANE_IDS.left, 'layers', 'parts', THREE_PANE_IDS.right],
		[THREE_PANE_IDS.right, 'parts', 'layers', THREE_PANE_IDS.left],
		['layers', THREE_PANE_IDS.right, THREE_PANE_IDS.left, 'parts']
	];
	for (const unit of ['share', 'px'] as const) {
		for (const order of orders) {
			it(`${unit}: hidden left to right, shown ${order.join(', ')}`, async () => {
				const { api, px } = mount({ defaultPlaces: designer(), sideWidthUnit: unit });
				await settle();
				for (const id of all) expect(await api().setVisible(id, false)).toBe('applied');
				for (const id of order) {
					expect(await api().setVisible(id, true)).toBe('applied');
					await settle();
				}
				const now = px();
				expect(now['designer:side']).toBeCloseTo(240, 6);
				expect(now[THREE_PANE_IDS.center]).toBeCloseTo(width - 480, 6);
				expect(now[THREE_PANE_IDS.right]).toBeCloseTo(240, 6);
			});
		}
	}

	it("share, this component's own default places: left and right hidden, shown left first", async () => {
		const dock = createDockState();
		const view = render(ThreePaneDockHarness, { props: { dock } });
		flushSync();
		await settle();
		const api = view.component.api();
		const before = (dock.layout.docked as DockSplitNode).sizes.slice();
		for (const id of [THREE_PANE_IDS.left, THREE_PANE_IDS.right])
			expect(await api.setVisible(id, false)).toBe('applied');
		for (const id of [THREE_PANE_IDS.left, THREE_PANE_IDS.right])
			expect(await api.setVisible(id, true)).toBe('applied');
		const after = (dock.layout.docked as DockSplitNode).sizes;
		before.forEach((v, i) => expect(after[i]).toBeCloseTo(v, 9));
	});
});
