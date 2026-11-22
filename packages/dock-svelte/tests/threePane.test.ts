// The pure half of `ThreePaneDock` (#663 ④, three-pane-dock-plan §4.1 / §4.4 / §4.7 / §4.9):
// the default layout, reconciling a saved layout with today's panes, the saved value - and the
// whole-layout replacement's description (`core/replace.ts`, `DockHost.replaceLayout`).
import { describe, expect, it } from 'vitest';
import { layoutChanges } from '../src/core/replace';
import { collectPanelIds, findNode, findParent } from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import { createDockState } from '../src/state.svelte';
import {
	fitThreePaneLayout,
	reconcileThreePaneLayout,
	threePaneDockLayout,
	threePaneSavedLayout,
	type ThreePanePanels
} from '../src/threePane';
import type { DockLayout, DockPanelNode, DockSplitNode } from '../src/types';

const PANES: ThreePanePanels = {
	left: { title: 'Tree' },
	center: { title: 'Work' },
	right: { title: 'Detail' }
};

const base = { hostWidth: 1000, panels: PANES };

describe('threePaneDockLayout', () => {
	it('lays left | centre | right in a row with the px widths as shares', () => {
		const layout = threePaneDockLayout(base);
		const root = layout.docked as DockSplitNode;
		expect(root.type).toBe('split');
		expect(root.direction).toBe('row');
		expect(root.children.map((c) => c.id)).toEqual(['left', 'center', 'right']);
		expect(root.sizes[0]).toBeCloseTo(0.28);
		expect(root.sizes[2]).toBeCloseTo(0.36);
		expect(root.sizes[1]).toBeCloseTo(0.36);
		expect(layout.floating).toEqual([]);
		expect(validateDockLayout(layout).ok).toBe(true);
	});

	it('shrinks the sides so the centre keeps its minimum, and is deterministic', () => {
		const layout = threePaneDockLayout({ ...base, hostWidth: 700 });
		const sizes = (layout.docked as DockSplitNode).sizes;
		expect(sizes[1] * 700).toBeCloseTo(320);
		expect(sizes[0] / sizes[2]).toBeCloseTo(280 / 360);
		expect(threePaneDockLayout({ ...base, hostWidth: 700 })).toEqual(layout);
	});

	it('uses a fallback width when the host is not measured', () => {
		const sizes = (threePaneDockLayout({ ...base, hostWidth: 0 }).docked as DockSplitNode).sizes;
		expect(sizes[0]).toBeCloseTo(280 / 1280);
	});

	it('leaves out a side that has no pane; a lone centre is the root', () => {
		const noRight = threePaneDockLayout({ ...base, panels: { ...PANES, right: null } });
		expect(collectPanelIds(noRight.docked)).toEqual(['left', 'center']);
		const alone = threePaneDockLayout({ ...base, panels: { center: PANES.center } });
		expect(alone.docked).toEqual({ type: 'panel', id: 'center', title: 'Work' });
	});

	it('hides a side with *Open false, as a pane hidden from the dock (with the share it has by default)', () => {
		const layout = threePaneDockLayout({ ...base, leftOpen: false });
		expect(collectPanelIds(layout.docked)).toEqual(['center', 'right']);
		expect(layout.floating).toHaveLength(1);
		expect(layout.floating[0]).toMatchObject({ id: 'left', open: false });
		const full = threePaneDockLayout(base);
		expect(layout.floating[0].dockShare).toBeCloseTo((full.docked as DockSplitNode).sizes[0], 9);
		// Shown, it docks at its default place: the default layout with both sides open.
		const dock = createDockState(layout);
		dock.defaultLayout = full;
		expect(dock.show('left')).toBe('docked');
		expect(dock.layout.docked).toEqual(full.docked);
	});

	it('places extra panels by `initial`', () => {
		const layout = threePaneDockLayout({
			...base,
			panels: {
				...PANES,
				extra: [
					{ id: 'log', title: 'Log', initial: { edge: 'bottom' } },
					{ id: 'help', title: 'Help', initial: 'floating', width: 300, height: 200 },
					{ id: 'notes', title: 'Notes' }
				]
			}
		});
		const root = layout.docked as DockSplitNode;
		expect(root.direction).toBe('column');
		expect(root.children[1]).toMatchObject({ id: 'log' });
		expect(layout.floating.map((w) => [w.id, w.open, w.width])).toEqual([
			['help', true, 300],
			['notes', false, 360]
		]);
		expect(validateDockLayout(layout).ok).toBe(true);
	});

	it('throws for an extra id that is one of the three or used twice', () => {
		expect(() =>
			threePaneDockLayout({ ...base, panels: { ...PANES, extra: [{ id: 'center', title: 'X' }] } })
		).toThrow(/reserved/);
		expect(() =>
			threePaneDockLayout({
				...base,
				panels: {
					...PANES,
					extra: [
						{ id: 'log', title: 'A' },
						{ id: 'log', title: 'B' }
					]
				}
			})
		).toThrow(/twice/);
	});
});

const panel = (id: string, title = id): DockPanelNode => ({ type: 'panel', id, title });

describe('reconcileThreePaneLayout', () => {
	it('restores a saved value as it was (wrapped, bare, or JSON text)', () => {
		const layout = threePaneDockLayout(base);
		const saved = threePaneSavedLayout(layout);
		expect(saved).toMatchObject({ schema: 1, panels: ['left', 'center', 'right'] });
		for (const value of [saved, layout, JSON.stringify(saved), JSON.stringify(layout)]) {
			const result = reconcileThreePaneLayout(value, base);
			expect(result.status).toBe('restored');
			expect(result.layout).toEqual(layout);
		}
	});

	it('falls back to the default for an unusable value', () => {
		for (const value of [null, 'not json', { schema: 2, layout: {} }, { version: 9 }]) {
			const result = reconcileThreePaneLayout(value, base);
			expect(result.status).toBe('default');
			expect(result.layout).toEqual(threePaneDockLayout(base));
		}
	});

	it('takes today’s titles without calling it a repair', () => {
		const saved = threePaneDockLayout({ ...base, panels: { ...PANES, left: { title: 'Old' } } });
		const result = reconcileThreePaneLayout(saved, base);
		expect(result.status).toBe('restored');
		expect(findNode(result.layout.docked, 'left')).toMatchObject({ title: 'Tree' });
	});

	it('drops unknown panes everywhere and adds missing ones', () => {
		const saved: DockLayout = {
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [panel('center'), panel('gone')]
			},
			floating: [{ id: 'old', title: 'Old', x: 0, y: 0, width: 100, height: 100, open: true }],
			autoHidden: [
				{
					edge: 'left',
					node: {
						type: 'tabs',
						id: 'g',
						activeIndex: 1,
						children: [panel('left'), panel('ghost')]
					},
					slot: { kind: 'root' }
				}
			]
		};
		const result = reconcileThreePaneLayout(saved, {
			...base,
			panels: { ...PANES, extra: [{ id: 'log', title: 'Log', initial: { edge: 'bottom' } }] }
		});
		expect(result.status).toBe('repaired');
		const ids = threePaneSavedLayout(result.layout).panels.sort();
		expect(ids).toEqual(['center', 'left', 'log', 'right']);
		// The lone tab left in the band becomes its region; right is docked on its side.
		expect(result.layout.autoHidden?.[0].node).toMatchObject({ type: 'panel', id: 'left' });
		expect(findParent(result.layout.docked, 'right')).toMatchObject({ direction: 'row' });
		// A missing extra panel comes as a closed floating window.
		expect(result.layout.floating).toEqual([expect.objectContaining({ id: 'log', open: false })]);
		expect(validateDockLayout(result.layout).ok).toBe(true);
	});

	it('puts a collapsed centre or a centre behind another tab back on screen', () => {
		const collapsed: DockLayout = {
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.3, 0.4, 0.3],
				children: [panel('left'), { ...panel('center'), collapsed: true }, panel('right')]
			},
			floating: []
		};
		const a = reconcileThreePaneLayout(collapsed, base);
		expect(a.status).toBe('repaired');
		expect(findNode(a.layout.docked, 'center')).not.toHaveProperty('collapsed');

		const behind: DockLayout = {
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ type: 'tabs', id: 'g', activeIndex: 0, children: [panel('left'), panel('center')] },
					panel('right')
				]
			},
			floating: []
		};
		const b = reconcileThreePaneLayout(behind, base);
		expect(b.status).toBe('repaired');
		// The centre leaves the tab group (another tab could hide it again, PR #723 review) and
		// stands beside what is left of it, after the left pane.
		expect(findParent(b.layout.docked, 'center')).toMatchObject({
			type: 'split',
			direction: 'row',
			children: [{ id: 'left' }, { id: 'center' }]
		});
		expect(collectPanelIds(b.layout.docked)).toEqual(['left', 'center', 'right']);
		expect(validateDockLayout(b.layout).ok).toBe(true);
	});

	it('takes the centre out of a tab group even when it is the active tab', () => {
		const tabbed: DockLayout = {
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.3, 0.7],
				children: [
					panel('left'),
					{
						type: 'tabs',
						id: 'g',
						activeIndex: 0,
						children: [panel('center'), panel('right'), panel('log')]
					}
				]
			},
			floating: []
		};
		const result = reconcileThreePaneLayout(tabbed, {
			...base,
			panels: { ...PANES, extra: [{ id: 'log', title: 'Log' }] }
		});
		expect(result.status).toBe('repaired');
		const docked = result.layout.docked as DockSplitNode;
		// The group keeps its place and share; the centre comes before it.
		expect(docked.sizes).toEqual([0.3, 0.7]);
		expect(docked.children[1]).toMatchObject({
			type: 'split',
			children: [
				{ type: 'panel', id: 'center' },
				{ type: 'tabs', id: 'g', children: [{ id: 'right' }, { id: 'log' }] }
			]
		});
		expect(validateDockLayout(result.layout).ok).toBe(true);
	});

	it('turns a tab group of the centre alone into the centre, at the root or nested', () => {
		const group = { type: 'tabs' as const, id: 'g', activeIndex: 0, children: [panel('center')] };
		const atRoot: DockLayout = { version: 2, docked: group, floating: [] };
		const a = reconcileThreePaneLayout(atRoot, base);
		expect(a.status).toBe('repaired');
		expect(findNode(a.layout.docked, 'g')).toBeNull();
		expect(findNode(a.layout.docked, 'center')?.type).toBe('panel');
		expect(findParent(a.layout.docked, 'center')?.type).not.toBe('tabs');
		expect(validateDockLayout(a.layout).ok).toBe(true);

		const nested: DockLayout = {
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.3, 0.4, 0.3],
				children: [panel('left'), { ...group, collapsed: true }, panel('right')]
			},
			floating: []
		};
		const b = reconcileThreePaneLayout(nested, base);
		expect(b.status).toBe('repaired');
		const docked = b.layout.docked as DockSplitNode;
		expect(docked.sizes).toEqual([0.3, 0.4, 0.3]);
		expect(docked.children[1]).toEqual({ type: 'panel', id: 'center', title: 'Work' });
		expect(validateDockLayout(b.layout).ok).toBe(true);
	});

	it('gives the default when the centre is floating, closed, auto-hidden or missing', () => {
		const win = { title: 'Work', x: 0, y: 0, width: 100, height: 100 };
		const cases: DockLayout[] = [
			{
				version: 2,
				docked: panel('left'),
				floating: [{ id: 'center', ...win, open: true }]
			},
			{
				version: 2,
				docked: panel('left'),
				floating: [{ id: 'center', ...win, open: false }]
			},
			{
				version: 2,
				docked: panel('left'),
				floating: [],
				autoHidden: [{ edge: 'right', node: panel('center'), slot: { kind: 'root' } }]
			},
			{ version: 2, docked: panel('left'), floating: [] }
		];
		for (const saved of cases) {
			const result = reconcileThreePaneLayout(saved, base);
			expect(result.status).toBe('default');
			expect(result.layout).toEqual(threePaneDockLayout(base));
		}
	});
});

describe('layoutChanges (DockHost.replaceLayout)', () => {
	const keepNone = () => false;

	it('asks nothing when every mounted pane stays where it is', () => {
		const layout = threePaneDockLayout(base);
		expect(layoutChanges(layout, layout, keepNone)).toEqual([]);
	});

	it('describes panes taken off the screen, re-docked and floated', () => {
		const before: DockLayout = {
			version: 2,
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [panel('center'), panel('right')]
			},
			floating: [
				{ id: 'left', title: 'L', x: 0, y: 0, width: 100, height: 100, open: true },
				{ id: 'log', title: 'Log', x: 0, y: 0, width: 100, height: 100, open: true }
			]
		};
		const after = threePaneDockLayout({
			...base,
			panels: { ...PANES, extra: [{ id: 'log', title: 'Log' }] }
		});
		const persistent = (id: string) => id === 'center';
		expect(layoutChanges(before, after, keepNone, persistent)).toEqual([
			// `center` is persistent and stays on screen; `right` keeps its mount chain (root split /
			// keyed child): neither is asked.
			{ kind: 'dock', panelId: 'left', remount: true },
			{ kind: 'hide', panelId: 'log', remount: true }
		]);
	});

	it('tells a persistent pane kept as a closed window from one left out (close = discarded)', () => {
		const win = (id: string, open: boolean) => ({
			id,
			title: id,
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			open
		});
		const before: DockLayout = {
			version: 2,
			docked: panel('center'),
			floating: [win('kept', true), win('gone', true), win('closed', false)]
		};
		const after: DockLayout = {
			version: 2,
			docked: panel('center'),
			floating: [win('kept', false), win('closed', false)]
		};
		const persistent = (id: string) => id !== 'center';
		expect(layoutChanges(before, after, keepNone, persistent)).toEqual([
			{ kind: 'hide', panelId: 'kept', remount: false },
			{ kind: 'close', panelId: 'gone' }
		]);
		// Left out while closed (mounted, not shown): discarded too.
		const empty: DockLayout = { version: 2, docked: panel('center'), floating: [] };
		expect(layoutChanges(after, empty, keepNone, persistent)).toEqual([
			{ kind: 'close', panelId: 'kept' },
			{ kind: 'close', panelId: 'closed' }
		]);
	});

	it('says a kept pane that ends behind a tab or hidden is not re-mounted', () => {
		const before = threePaneDockLayout(base);
		const after: DockLayout = {
			version: 2,
			docked: {
				type: 'split',
				id: 'three-pane:root',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ type: 'tabs', id: 'g', activeIndex: 1, children: [panel('left'), panel('center')] },
					panel('right')
				]
			},
			floating: []
		};
		const persistent = (id: string) => id === 'left';
		expect(layoutChanges(before, after, keepNone, persistent)).toEqual([
			{ kind: 'tab-switch', groupId: 'g', from: 'left', to: 'center', remount: false },
			{ kind: 'move-docked', panelId: 'center', remount: true }
		]);
	});
});

// #741 took a hidden pane dropped from a saved layout out of the shares of the hidden panes kept.
// #782 PR5: a hidden pane holds no slot - dropping one changes nothing for the others, and
// `fitThreePaneLayout` (today's layout, assigned back with `dock.layout = ...`) does the same.
describe('reconcileThreePaneLayout: a hidden pane it drops (#741, #782 PR5)', () => {
	const LOG = { id: 'log', title: 'Log' };
	const withLog: ThreePanePanels = { center: PANES.center, right: PANES.right, extra: [LOG] };
	const without: ThreePanePanels = { center: PANES.center, right: PANES.right };
	const saved = (): DockLayout => {
		const dock = createDockState({
			version: 2,
			floating: [],
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.2, 0.3, 0.5],
				children: ['log', 'right', 'center'].map((id) => ({ type: 'panel', id, title: id }))
			}
		});
		dock.dismiss('log');
		dock.dismiss('right');
		return dock.savedLayout();
	};
	const share = (layout: DockLayout): number | undefined =>
		layout.floating.find((w) => w.id === 'right')?.dockShare;

	it('the pane kept holds the share it held when it was hidden, the other dropped or not', () => {
		// Hidden after `log`: .3 of the .8 left.
		expect(share(saved())).toBeCloseTo(0.375, 9);
		for (const fit of [reconcileThreePaneLayout, fitThreePaneLayout]) {
			const dropped = fit(saved(), { hostWidth: 1000, panels: without });
			expect(dropped.status).toBe('repaired');
			expect(dropped.layout.floating.map((w) => w.id)).toEqual(['right']);
			expect(share(dropped.layout)).toBeCloseTo(0.375, 9);
			expect(validateDockLayout(dropped.layout).ok).toBe(true);
			const kept = fit(saved(), { hostWidth: 1000, panels: withLog });
			expect(share(kept.layout)).toBeCloseTo(0.375, 9);
		}
	});
});
