// #782 PR6: `DockState` makes its steps on the shadow tree S and assigns what S shows. The cases
// here are the ones the review of PR #864 found, where that differs from making the step on the
// docked tree: shares of 0, a cancelled divider drag, an id S keeps out of sight, and the
// `collapsed` flag of a region that is the only child of its split of S that shows (S holds it
// since #782 PR8d; before, `DockState` carried it on the docked tree).
import { describe, expect, it } from 'vitest';
import { validateDockLayout } from '../src/core/validate';
import { shadowPanelIds } from '../src/core/shadow';
import {
	createDockState,
	shadowStateOf,
	watchShadow,
	type DockState,
	type ShadowFollow
} from '../src/state.svelte';
import type { DockNode, DockPanelNode } from '../src/types';
import { counterMakeId } from './fixtures/dock-properties';

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });
const split = (
	id: string,
	direction: 'row' | 'column',
	sizes: number[],
	children: DockNode[]
): DockNode => ({ type: 'split', id, direction, sizes, children });
const tabs = (id: string, ids: string[]): DockNode => ({
	type: 'tabs',
	id,
	activeIndex: 0,
	children: ids.map(panel)
});

/** A state docked as `tree`, which is also its default layout. */
function dockOf(tree: DockNode): DockState {
	const dock = createDockState({ version: 4, floating: [], docked: tree }, counterMakeId());
	dock.defaultLayout = { version: 4, floating: [], docked: tree };
	return dock;
}
const back = (dock: DockState, id: string): boolean => dock.dockBack(id);
const sizesOf = (node: DockNode | null | undefined): number[] =>
	node?.type === 'split' ? node.sizes : [];
const idsOf = (node: DockNode | null | undefined): string[] =>
	node && node.type !== 'panel' ? node.children.map((c) => c.id) : [];
const close = (got: number[], want: number[]) => {
	expect(got).toHaveLength(want.length);
	want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 9));
};
/** Saved and loaded again: the layout holds no id twice. */
function expectLoads(dock: DockState): void {
	const saved = dock.serialize();
	expect(validateDockLayout(JSON.parse(saved))).toMatchObject({ ok: true });
	expect(createDockState().hydrate(saved)).toBe(true);
}

describe('shares of 0 among the panes that show (review of PR #864, 1)', () => {
	// row[a 1, b 0, c 0], `a` floated: `b` and `c` hold 0 together and show evenly.
	const zero = (): DockNode => split('s', 'row', [1, 0, 0], [panel('a'), panel('b'), panel('c')]);

	it('a pane hidden and shown again holds its share of what shows: b and c stay even', () => {
		const dock = dockOf(zero());
		dock.undockPanel('a');
		close(sizesOf(dock.layout.docked), [0.5, 0.5]);
		dock.dismiss('b');
		expect(dock.show('b')).toBe('docked');
		expect(idsOf(dock.layout.docked)).toEqual(['b', 'c']);
		close(sizesOf(dock.layout.docked), [0.5, 0.5]);
		// A write to a split whose shown children have 0 together (`core/shadow.ts`, "Shares of 0"):
		// they take the even part of the split - 2 of 3 - and the place of `a` the rest.
		close(sizesOf(shadowStateOf(dock).shadow as DockNode), [1 / 3, 1 / 3, 1 / 3]);
		expect(back(dock, 'a')).toBe(true);
		close(sizesOf(dock.layout.docked), [1 / 3, 1 / 3, 1 / 3]);
	});

	it('with a share that is not the even one: b at .25 of what shows', () => {
		const dock = dockOf(
			split('s', 'row', [1, 0, 0, 0], [panel('a'), panel('b'), panel('c'), panel('d')])
		);
		dock.undockPanel('a');
		dock.resizeSplit('s', 0, -1 / 12);
		close(sizesOf(dock.layout.docked), [0.25, 5 / 12, 1 / 3]);
		// The resize was a write too: from here on the split holds no 0 among what shows.
		dock.dismiss('b');
		dock.show('b');
		close(sizesOf(dock.layout.docked), [0.25, 5 / 12, 1 / 3]);
	});
});

describe('a cancelled divider drag puts S back too (review of PR #864, 2)', () => {
	it('row[a 1, b 0, c 0], a floated, the divider of b / c dragged and cancelled: a comes back at 1', () => {
		const dock = dockOf(split('s', 'row', [1, 0, 0], [panel('a'), panel('b'), panel('c')]));
		dock.undockPanel('a');
		const before = dock.layout;
		const shadow = shadowStateOf(dock).shadow;
		dock.resizeSplit('s', 0, 0.1);
		close(sizesOf(dock.layout.docked), [0.6, 0.4]);
		// The drag wrote to a split whose shown children had 0 together: the place of `a` gave way.
		expect(sizesOf(shadowStateOf(dock).shadow as DockNode)[0]).toBeLessThan(1);
		dock.restoreSplitSizes('s', before);
		close(sizesOf(dock.layout.docked), [0.5, 0.5]);
		expect(shadowStateOf(dock).shadow).toEqual(shadow);
		expect(back(dock, 'a')).toBe(true);
		close(sizesOf(dock.layout.docked), [1, 0, 0]);
	});

	it('the children of the split changed since: only what shows is put back, as before', () => {
		const dock = dockOf(split('s', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]));
		dock.undockPanel('a');
		const before = dock.layout;
		dock.resizeSplit('s', 0, 0.1);
		// `a` is not a child of the split any more (docked elsewhere): its place in S is gone.
		dock.dockPanelAtEdge('a', 'top');
		dock.restoreSplitSizes('s', before);
		const row = dock.layout.docked?.type === 'split' ? dock.layout.docked.children[1] : null;
		close(sizesOf(row), [0.375, 0.625]);
	});
});

describe('an id S keeps out of sight is not shown twice (review of PR #864, 3)', () => {
	// row[x, tabs(T)[a, b]], `b` floated: the group shows as `a`, and S keeps `T` for it.
	const grouped = (): DockNode =>
		split('s', 'row', [0.5, 0.5], [panel('x'), tabs('T', ['a', 'b'])]);

	it('a floating window takes the id of the group meanwhile: the group comes back under another', () => {
		const dock = dockOf(grouped());
		dock.undockPanel('b');
		dock.ensureWindow({ id: 'T', title: 'T' }, 800, 600);
		expectLoads(dock);
		expect(back(dock, 'b')).toBe(true);
		const group = dock.layout.docked?.type === 'split' ? dock.layout.docked.children[1] : null;
		expect(idsOf(group)).toEqual(['a', 'b']);
		expect(group?.id).not.toBe('T');
		expectLoads(dock);
		// The prediction of "back" said the same tree.
		const again = dockOf(grouped());
		again.undockPanel('b');
		again.ensureWindow({ id: 'T', title: 'T' }, 800, 600);
		const predicted = again.backTree('b', counterMakeId());
		expect(predicted).toEqual(dock.layout.docked);
	});

	// Cross-review of PR #864: the id given instead must be free too. "Back" from the panel menu
	// docks with a fixed `<pane>:restored`, which a window may have as well.
	it('the id given instead is one nothing has: a fixed `makeId` whose id is a window`s too', () => {
		const fixed = (): string => 'b:restored';
		const dock = dockOf(grouped());
		dock.undockPanel('b');
		dock.ensureWindow({ id: 'T', title: 'T' }, 800, 600);
		dock.ensureWindow({ id: 'b:restored', title: 'other' }, 800, 600);
		const predicted = dock.backTree('b', fixed);
		expect(dock.dockBack('b', fixed)).toBe(true);
		expect(dock.layout.docked).toEqual(predicted);
		const group = dock.layout.docked?.type === 'split' ? dock.layout.docked.children[1] : null;
		expect(group?.id).toBe('b:restored-2');
		expectLoads(dock);
	});

	// Cross-review of PR #864: the group made again at the default place takes its default id `G`
	// directly, and the group S kept out of sight gets a new id by the same `makeId` - here one
	// that says `G` too.
	it('a default id taken by the place, and the same id given instead to another group: not twice', () => {
		const tree = split('s', 'row', [0.5, 0.5], [tabs('G', ['a', 'b']), tabs('T', ['c', 'd'])]);
		const dock = createDockState({ version: 4, floating: [], docked: tree }, () => 'G');
		dock.defaultLayout = { version: 4, floating: [], docked: tree };
		dock.dismiss('a');
		dock.undockPanel('d');
		dock.ensureWindow({ id: 'T', title: 'T' }, 800, 600);
		expect(dock.show('a')).toBe('docked');
		expectLoads(dock);
		expect(back(dock, 'd')).toBe(true);
		const groups = idsOf(dock.layout.docked);
		expect(new Set(groups).size).toBe(2);
		expect(groups).not.toContain('T');
		expectLoads(dock);
	});

	it('the same for a pane hidden and shown into the group, and for a pane dropped onto its tab', () => {
		const shown = dockOf(split('s', 'row', [0.5, 0.5], [panel('x'), tabs('T', ['a', 'b', 'c'])]));
		shown.undockPanel('b');
		shown.dismiss('c');
		shown.ensureWindow({ id: 'T', title: 'T' }, 800, 600);
		expect(shown.show('c')).toBe('docked');
		expectLoads(shown);

		const dropped = dockOf(grouped());
		dropped.undockPanel('b');
		dropped.ensureWindow({ id: 'T', title: 'T' }, 800, 600);
		dropped.dockExisting('x', 'a', 'center');
		expectLoads(dropped);
	});
});

describe('a new pane with the id of a group S keeps out of sight (Codex P2 on #864)', () => {
	// tabs(T)[a, b], `b` floated: the group shows as `a`. A new pane `T` is no id of the layout.
	const fresh = (): DockState => {
		const dock = dockOf(tabs('T', ['a', 'b']));
		dock.undockPanel('b');
		return dock;
	};

	it('ensurePanel as a tab of a: the group takes another id, and b still comes back into it', () => {
		const dock = fresh();
		dock.ensurePanel({ id: 'T', title: 'new panel' }, 800, 600, 'center', 'a');
		expect(idsOf(dock.layout.docked)).toEqual(['a', 'T']);
		expect(dock.layout.docked?.id).not.toBe('T');
		expectLoads(dock);
		expect(back(dock, 'b')).toBe(true);
		expect(idsOf(dock.layout.docked)).toEqual(['a', 'b', 'T']);
		expectLoads(dock);
	});

	it('ensurePanel beside a, and at no target: the same', () => {
		const beside = fresh();
		beside.ensurePanel({ id: 'T', title: 'new panel' }, 800, 600, 'left', 'a');
		expectLoads(beside);
		expect(back(beside, 'b')).toBe(true);
		expectLoads(beside);

		const root = fresh();
		root.ensurePanel({ id: 'T', title: 'new panel' }, 800, 600);
		expectLoads(root);
		expect(back(root, 'b')).toBe(true);
		expectLoads(root);
	});

	it('a floating window T dropped at an outer edge, and the prediction of it', () => {
		const dock = fresh();
		dock.ensureWindow({ id: 'T', title: 'T' }, 800, 600);
		const predicted = dock.droppedAtEdgeTree('T', 'top', counterMakeId(50));
		expect(idsOf(predicted)).toEqual(['T', 'a']);
		dock.dockPanelAtEdge('T', 'top');
		expectLoads(dock);
		expect(back(dock, 'b')).toBe(true);
		expectLoads(dock);
	});
});

describe('the `collapsed` flag of an only shown child stays (review of PR #864, 4; in S since #782 PR8d)', () => {
	// row[column[a, b], c, d], `b` floated: `a` shows as a child of the row and can be collapsed
	// there, but in S it is the only child of its column that shows.
	const nested = (): DockNode =>
		split(
			's',
			'row',
			[0.4, 0.3, 0.3],
			[split('k', 'column', [0.5, 0.5], [panel('a'), panel('b')]), panel('c'), panel('d')]
		);
	const collapsedA = (): DockState => {
		const dock = dockOf(nested());
		dock.undockPanel('b');
		dock.setDockedCollapsed('a', true);
		expect(dock.isDockedCollapsed('a')).toBe(true);
		return dock;
	};

	it('another divider dragged: a stays collapsed', () => {
		const dock = collapsedA();
		const follows: ShadowFollow[] = [];
		watchShadow(dock, (follow) => follows.push(follow));
		dock.resizeSplit('s', 1, 0.05);
		// S is kept as the step made it - not made again from the slots, which would lose what S
		// knows of the places (cross-review of PR #864).
		expect(follows.map((f) => f.result)).not.toContain('rebuilt');
		expect(shadowPanelIds(shadowStateOf(dock).shadow, 'away')).toEqual(['b']);
		expect(dock.isDockedCollapsed('a')).toBe(true);
		close(sizesOf(dock.layout.docked), [0.4, 0.35, 0.25]);
	});

	it('a pane moved, hidden, shown and floated elsewhere: a stays collapsed', () => {
		const dock = collapsedA();
		dock.dockExisting('d', 'c', 'top');
		expect(dock.isDockedCollapsed('a')).toBe(true);
		dock.dismiss('d');
		expect(dock.isDockedCollapsed('a')).toBe(true);
		expect(dock.show('d')).toBe('docked');
		expect(dock.isDockedCollapsed('a')).toBe(true);
		dock.undockPanel('d');
		expect(dock.isDockedCollapsed('a')).toBe(true);
		expect(back(dock, 'd')).toBe(true);
		expect(dock.isDockedCollapsed('a')).toBe(true);
	});

	it('the pane back in its column: a stays collapsed beside it, and S holds the flag from then on', () => {
		const dock = collapsedA();
		expect(back(dock, 'b')).toBe(true);
		// As when `b` was put back beside a collapsed `a` before PR6: `a` is a child of its column
		// again, still collapsed; `b` shows.
		expect(dock.isDockedCollapsed('a')).toBe(true);
		expect(dock.isDockedCollapsed('b')).toBe(false);
		expect(shadowStateOf(dock).shadow).toEqual(dock.layout.docked);
	});

	// Codex P2 on #864: the flag is carried for the regions a step does not touch. The pane the
	// step moves shows where it lands, as before PR6 (`tree.ts#removePanel` drops its flag).
	it('a itself moved: it shows where it lands (outer edge, beside a pane, as a tab; and the predictions)', () => {
		const edge = collapsedA();
		const atEdge = edge.droppedAtEdgeTree('a', 'top', counterMakeId(50));
		edge.dockExistingAtEdge('a', 'top');
		expect(edge.isDockedCollapsed('a')).toBe(false);
		expect(JSON.stringify(atEdge)).not.toContain('"collapsed"');

		const beside = collapsedA();
		const onto = beside.droppedTree('a', 'd', 'bottom', counterMakeId(50));
		beside.dockExisting('a', 'd', 'bottom');
		expect(beside.isDockedCollapsed('a')).toBe(false);
		expect(JSON.stringify(onto)).not.toContain('"collapsed"');

		const tab = collapsedA();
		tab.dockExisting('a', 'c', 'center');
		expect(tab.isDockedCollapsed('a')).toBe(false);
		expect(tab.isDockedCollapsed('c')).toBe(false);
	});

	it('a floated and dropped back, or docked back to its place: it shows', () => {
		const dropped = collapsedA();
		dropped.undockPanel('a');
		dropped.dockPanel('a', 'c', 'left');
		expect(dropped.isDockedCollapsed('a')).toBe(false);

		const returned = collapsedA();
		returned.undockPanel('a');
		expect(back(returned, 'a')).toBe(true);
		expect(returned.isDockedCollapsed('a')).toBe(false);

		const atEdge = collapsedA();
		atEdge.undockPanel('a');
		atEdge.dockPanelAtEdge('a', 'bottom');
		expect(atEdge.isDockedCollapsed('a')).toBe(false);
	});

	it('another pane moved while a tab group that is the only shown child is collapsed: the group stays; its own tab moved out leaves the band to the tab left', () => {
		const tree = split(
			's',
			'row',
			[0.4, 0.3, 0.3],
			[
				split('k', 'column', [0.5, 0.5], [tabs('g', ['a', 'e']), panel('b')]),
				panel('c'),
				panel('d')
			]
		);
		const make = (): DockState => {
			const dock = dockOf(tree);
			dock.undockPanel('b');
			dock.setDockedCollapsed('g', true);
			expect(dock.isDockedCollapsed('g')).toBe(true);
			return dock;
		};
		const other = make();
		other.dockExistingAtEdge('d', 'bottom');
		expect(other.isDockedCollapsed('g')).toBe(true);
		// #782 PR8d: as for a collapsed group with a sibling showing (`tree.ts#removePanel`: the
		// band of a group left with one tab is that tab's). Before, this one case expanded.
		const own = make();
		own.dockExistingAtEdge('e', 'bottom');
		expect(own.isDockedCollapsed('a')).toBe(true);
		expect(own.isDockedCollapsed('e')).toBe(false);
		const beside = dockOf(tree);
		beside.setDockedCollapsed('g', true);
		beside.dockExistingAtEdge('e', 'bottom');
		expect(beside.isDockedCollapsed('a')).toBe(true);
	});

	it('a pane joining a as a tab expands the region (the step touched it)', () => {
		const tabbed = collapsedA();
		tabbed.dockExisting('d', 'a', 'center');
		expect(tabbed.isDockedCollapsed('a')).toBe(false);
		expect(tabbed.isDockedCollapsed('d')).toBe(false);
	});
});
