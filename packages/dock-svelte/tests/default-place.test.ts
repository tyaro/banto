// #782 PR5 (the decision of 2026-11-22 on the issue): a pane hidden from the dock is shown at its
// place in the DEFAULT layout, not where it was hidden from. `core/defaultPlace.ts`, case by case;
// what holds for every tree and every order is in `slot-properties.test.ts`.
import { describe, expect, it } from 'vitest';
import { dockShareOf, hasDefaultPlace, placeAtDefault } from '../src/core/defaultPlace';
import { dockPanelAtEdge, removePanel } from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import { createDockState } from '../src/state.svelte';
import { threePaneDefaultPlaces, threePaneDockLayout } from '../src/threePane';
import type { DockNode, DockPanelNode, DockSplitNode } from '../src/types';
import { shapeOf } from './fixtures/visibility-sim';

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });
const split = (
	id: string,
	direction: 'row' | 'column',
	sizes: number[],
	children: DockNode[]
): DockSplitNode => ({ type: 'split', id, direction, sizes, children });
const tabs = (id: string, ids: string[], activeIndex = 0): DockNode => ({
	type: 'tabs',
	id,
	activeIndex,
	children: ids.map(panel)
});
const sizesOf = (node: DockNode | null): number[] => (node?.type === 'split' ? node.sizes : []);
const close = (got: number[], want: number[]) => {
	expect(got).toHaveLength(want.length);
	want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 9));
};
/** A `makeId` that must not be asked. */
const never = (): string => {
	throw new Error('makeId was asked');
};
const without = (tree: DockNode, ...ids: string[]): DockNode | null =>
	ids.reduce<DockNode | null>((root, id) => removePanel(root, id), tree);

/** left | center | right in a row: `ThreePaneDock`'s default. */
const three = (): DockSplitNode =>
	split('root', 'row', [0.2, 0.5, 0.3], [panel('left'), panel('center'), panel('right')]);

describe('placeAtDefault: no default place', () => {
	it('is null without a default layout, and for a pane the default tree does not hold', () => {
		expect(placeAtDefault(panel('center'), null, panel('left'), 0.2, never)).toBeNull();
		expect(placeAtDefault(panel('center'), three(), panel('log'), 0.2, never)).toBeNull();
		expect(placeAtDefault(null, three(), panel('log'), 0.2, never)).toBeNull();
		expect(hasDefaultPlace(null, 'left')).toBe(false);
		expect(hasDefaultPlace(three(), 'log')).toBe(false);
		expect(hasDefaultPlace(three(), 'left')).toBe(true);
		// A split or tab group id is not a pane.
		expect(hasDefaultPlace(three(), 'root')).toBe(false);
	});

	it('is null when no pane of the default tree is docked and the pane is at no edge of it', () => {
		// `center` is neither the first nor the last child of the row.
		expect(placeAtDefault(panel('log'), three(), panel('center'), 0.5, never)).toBeNull();
		// The pane that is the whole default tree has no sibling and no edge.
		expect(placeAtDefault(panel('log'), panel('only'), panel('only'), 1, never)).toBeNull();
	});
});

describe('placeAtDefault: beside the nearest default sibling', () => {
	it('an empty tree: the pane is the tree', () => {
		expect(placeAtDefault(null, three(), panel('left'), 0.2, never)).toEqual(panel('left'));
	});

	it('left / right go to their side of the centre, with the share they held', () => {
		const left = placeAtDefault(panel('center'), three(), panel('left'), 0.35, never);
		// The split takes the default one's id: nothing is asked of `makeId`.
		expect(left).toMatchObject({ type: 'split', id: 'root', direction: 'row' });
		expect(shapeOf(left)).toEqual({ row: ['left', 'center'] });
		close(sizesOf(left), [0.35, 0.65]);
		const both = placeAtDefault(left, three(), panel('right'), 0.3, never);
		expect(shapeOf(both)).toEqual({ row: ['left', 'center', 'right'] });
		// The others keep their ratio.
		close(sizesOf(both), [0.35 * 0.7, 0.65 * 0.7, 0.3]);
	});

	it('without a share to speak of (1, or out of range): the default share against the default siblings docked', () => {
		for (const share of [1, undefined, 0, -1, Number.NaN, 2]) {
			const left = placeAtDefault(panel('center'), three(), panel('left'), share, never);
			// left .2 against center .5.
			close(sizesOf(left), [0.2 / 0.7, 0.5 / 0.7]);
		}
		const row = split('root', 'row', [0.5, 0.5], [panel('center'), panel('right')]);
		// left .2 against center .5 + right .3.
		close(sizesOf(placeAtDefault(row, three(), panel('left'), 1, never)), [0.2, 0.4, 0.4]);
	});

	it('the nearest sibling docked now; of two as near, the one before', () => {
		const d = split('s', 'row', [0.25, 0.25, 0.25, 0.25], ['a', 'b', 'c', 'd'].map(panel));
		const ad = split('s', 'row', [0.5, 0.5], [panel('a'), panel('d')]);
		expect(shapeOf(placeAtDefault(ad, d, panel('b'), 0.25, never))).toEqual({
			row: ['a', 'b', 'd']
		});
		expect(shapeOf(placeAtDefault(ad, d, panel('c'), 0.25, never))).toEqual({
			row: ['a', 'c', 'd']
		});
		// d below a (moved by hand): c goes to the left of d, b to the right of a.
		const moved = split('x', 'column', [0.5, 0.5], [panel('a'), panel('d')]);
		let n = 0;
		const makeId = () => `new-${n++}`;
		expect(shapeOf(placeAtDefault(moved, d, panel('c'), 0.25, makeId))).toEqual({
			column: ['a', { row: ['c', 'd'] }]
		});
		expect(shapeOf(placeAtDefault(moved, d, panel('b'), 0.25, makeId))).toEqual({
			column: [{ row: ['a', 'b'] }, 'd']
		});
		// The default split's id is free for the first split made; asked of `makeId` never.
		expect(n).toBe(0);
	});

	it('a nested default: the pane goes beside the whole part its sibling is now, in its own split', () => {
		// row[a, column[b, c]]
		const d = split(
			's',
			'row',
			[0.4, 0.6],
			[panel('a'), split('in', 'column', [0.5, 0.5], [panel('b'), panel('c')])]
		);
		// a beside the whole column, not beside b.
		const column = split('in', 'column', [0.5, 0.5], [panel('b'), panel('c')]);
		const a = placeAtDefault(column, d, panel('a'), 0.4, never);
		expect(shapeOf(a)).toEqual({ row: ['a', { column: ['b', 'c'] }] });
		expect(a).toMatchObject({ id: 's' });
		// c below b, in a column of their own (the row is another default split: not spliced into).
		const ab = split('s', 'row', [0.4, 0.6], [panel('a'), panel('b')]);
		const c = placeAtDefault(ab, d, panel('c'), 0.5, never);
		expect(shapeOf(c)).toEqual({ row: ['a', { column: ['b', 'c'] }] });
		expect((c as DockSplitNode).children[1]).toMatchObject({ id: 'in', sizes: [0.5, 0.5] });
		close(sizesOf(c), [0.4, 0.6]);
	});

	it('the same direction nested twice in the default: a default split is not spliced into another', () => {
		// column[column[b, c], e]: b and e docked as column[b, e]; c belongs to the inner column.
		const d = split(
			'out',
			'column',
			[0.6, 0.4],
			[split('in', 'column', [0.5, 0.5], [panel('b'), panel('c')]), panel('e')]
		);
		const be = split('out', 'column', [0.6, 0.4], [panel('b'), panel('e')]);
		const c = placeAtDefault(be, d, panel('c'), 0.5, never);
		expect(shapeOf(c)).toEqual({ column: [{ column: ['b', 'c'] }, 'e'] });
		// Into a split that is not of the default layout (made by a drop), it is spliced.
		const foreign = split('gen-1', 'column', [0.6, 0.4], [panel('b'), panel('e')]);
		expect(shapeOf(placeAtDefault(foreign, d, panel('c'), 0.5, never))).toEqual({
			column: ['b', 'c', 'e']
		});
	});

	it('asks `makeId` only when the default id is taken', () => {
		// The id of the default row is the id of a tab group docked now.
		const taken = tabs('root', ['center', 'log']);
		let n = 0;
		const tree = placeAtDefault(taken, three(), panel('left'), 0.2, () => `new-${n++}`);
		expect(n).toBe(1);
		expect(tree).toMatchObject({ type: 'split', id: 'new-0' });
		expect(shapeOf(tree)).toEqual({ row: ['left', { tabs: ['center', 'log'] }] });
	});
});

describe('placeAtDefault: tab groups', () => {
	// row[tabs[a, b, c], p]
	const d = (): DockNode => split('s', 'row', [0.6, 0.4], [tabs('t', ['a', 'b', 'c']), panel('p')]);

	it("joins its default tab mate's group on its default side, as the active tab", () => {
		const ac = split('s', 'row', [0.6, 0.4], [tabs('t', ['a', 'c'], 1), panel('p')]);
		const b = placeAtDefault(ac, d(), panel('b'), 0.6, never);
		expect((b as DockSplitNode).children[0]).toEqual(tabs('t', ['a', 'b', 'c'], 1));
		// The sizes of the split are not touched.
		close(sizesOf(b), [0.6, 0.4]);
	});

	it('makes the group again (with its default id) around a bare tab mate', () => {
		const bp = split('s', 'row', [0.6, 0.4], [panel('b'), panel('p')]);
		const a = placeAtDefault(bp, d(), panel('a'), 0.6, never);
		expect((a as DockSplitNode).children[0]).toEqual(tabs('t', ['a', 'b'], 0));
		const c = placeAtDefault(bp, d(), panel('c'), 0.6, never);
		expect((c as DockSplitNode).children[0]).toEqual(tabs('t', ['b', 'c'], 1));
	});

	it('follows its tab mate wherever it was moved; with no mate docked, takes the place of the group', () => {
		// b moved into p's group.
		const moved = tabs('g', ['p', 'b'], 0);
		expect(placeAtDefault(moved, d(), panel('a'), 0.6, never)).toEqual(
			tabs('g', ['p', 'a', 'b'], 1)
		);
		// No tab of the group is docked: beside p, where the group belongs.
		const alone = placeAtDefault(panel('p'), d(), panel('a'), 0.6, never);
		expect(shapeOf(alone)).toEqual({ row: ['a', 'p'] });
		close(sizesOf(alone), [0.6, 0.4]);
	});

	it('expands a collapsed group it joins', () => {
		const collapsed: DockNode = {
			...(tabs('t', ['a', 'c']) as object),
			collapsed: true
		} as DockNode;
		const tree = split('s', 'row', [0.6, 0.4], [collapsed, panel('p')]);
		const b = placeAtDefault(tree, d(), panel('b'), 0.6, never) as DockSplitNode;
		expect(b.children[0]).not.toHaveProperty('collapsed');
	});
});

describe('placeAtDefault: the default edge', () => {
	it('no default pane docked: along the edge its default place is at, with the share it held', () => {
		const left = placeAtDefault(panel('log'), three(), panel('left'), 0.2, () => 'edge');
		expect(left).toMatchObject({ type: 'split', id: 'edge', direction: 'row' });
		expect(shapeOf(left)).toEqual({ row: ['left', 'log'] });
		close(sizesOf(left), [0.2, 0.8]);
		const right = placeAtDefault(panel('log'), three(), panel('right'), 1, () => 'edge');
		expect(shapeOf(right)).toEqual({ row: ['log', 'right'] });
		// No share to speak of: what `dockPanelAtEdge` gives.
		expect(right).toEqual(dockPanelAtEdge(panel('log'), panel('right'), 'right', () => 'edge'));
	});

	it('an extra panel docked on an edge by default (`initial: { edge }`) goes back to that edge', () => {
		const defaults = threePaneDefaultPlaces({
			hostWidth: 1000,
			panels: {
				left: { title: 'L' },
				center: { title: 'C' },
				right: { title: 'R' },
				extra: [{ id: 'log', title: 'Log', initial: { edge: 'bottom' } }]
			}
		}).docked!;
		expect(shapeOf(defaults)).toEqual({ column: [{ row: ['left', 'center', 'right'] }, 'log'] });
		// The row is docked: below the whole row.
		const row = without(defaults, 'log')!;
		const back = placeAtDefault(row, defaults, panel('log'), 0.25, never);
		expect(shapeOf(back)).toEqual(shapeOf(defaults));
		// Only a pane the default layout does not dock is docked: the bottom edge.
		const other = placeAtDefault(panel('x'), defaults, panel('log'), 0.25, () => 'edge');
		expect(shapeOf(other)).toEqual({ column: ['x', 'log'] });
		// The centre has no side of its own in the row; the row is the top of the column.
		expect(shapeOf(placeAtDefault(panel('x'), defaults, panel('center'), 1, () => 'edge'))).toEqual(
			{
				column: ['center', 'x']
			}
		);
	});
});

describe('dockShareOf', () => {
	it('the share of its split (its tab group`s, for a tab); 1 with no split around', () => {
		const tree = split(
			's',
			'row',
			[0.2, 0.5, 0.3],
			[panel('a'), tabs('t', ['b', 'c']), panel('d')]
		);
		expect(dockShareOf(tree, 'a')).toBeCloseTo(0.2, 9);
		expect(dockShareOf(tree, 'b')).toBeCloseTo(0.5, 9);
		expect(dockShareOf(tree, 'c')).toBeCloseTo(0.5, 9);
		expect(dockShareOf(panel('a'), 'a')).toBe(1);
		expect(dockShareOf(tabs('t', ['a', 'b']), 'a')).toBe(1);
		expect(dockShareOf(tree, 'nope')).toBe(1);
		expect(dockShareOf(null, 'a')).toBe(1);
		// Sizes that do not add up to 1 are read as ratios; a share of 0 says nothing.
		const loose = split('s', 'row', [2, 6], [panel('a'), panel('b')]);
		expect(dockShareOf(loose, 'a')).toBeCloseTo(0.25, 9);
		expect(dockShareOf(split('s', 'row', [0, 1], [panel('a'), panel('b')]), 'a')).toBe(1);
	});
});

describe('DockState: hide and show by the default layout', () => {
	const state = () => {
		const dock = createDockState({ version: 2, floating: [], docked: three() }, never);
		dock.defaultLayout = { version: 2, floating: [], docked: three() };
		return dock;
	};

	it('a pane moved and then hidden comes back at its default place, not where it was hidden from', () => {
		const dock = createDockState({ version: 2, floating: [], docked: three() }, () => 'moved');
		dock.defaultLayout = { version: 2, floating: [], docked: three() };
		dock.dockExisting('left', 'right', 'bottom');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['center', { column: ['right', 'left'] }] });
		dock.dismiss('left');
		expect(dock.layout.floating[0]).toMatchObject({ id: 'left', open: false, dockShare: 0.5 });
		expect(dock.show('left')).toBe('docked');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['left', 'center', 'right'] });
		// It held half of the column: the one number kept is taken of the row it lands in.
		expect(sizesOf(dock.layout.docked)[0]).toBeCloseTo(0.5, 9);
	});

	it('the width a side was dragged to comes back with it (the place is the default, the share is remembered)', () => {
		const dock = state();
		dock.resizeSplit('root', 0, 0.15);
		close(sizesOf(dock.layout.docked), [0.35, 0.35, 0.3]);
		dock.dismiss('left');
		dock.show('left');
		close(sizesOf(dock.layout.docked), [0.35, 0.35, 0.3]);
	});

	it('`showPlacement`, `showTabSwitch` and `shownTree` say what `show` then does', () => {
		const tree = split('s', 'row', [0.6, 0.4], [tabs('t', ['a', 'b']), panel('p')]);
		const dock = createDockState({ version: 2, floating: [], docked: tree }, never);
		dock.defaultLayout = { version: 2, floating: [], docked: tree };
		dock.dismiss('b');
		expect(dock.showPlacement('b')).toBe('docked');
		// The group collapsed to the bare pane `a`: it is made again around it (re-mounted).
		expect(dock.showTabSwitch('b')).toEqual({ groupId: 't', from: 'a', wrapped: true });
		const predicted = dock.shownTree('b');
		expect(dock.show('b')).toBe('docked');
		expect(dock.layout.docked).toEqual(predicted);
		// Into a group that is still there: the active tab is the one replaced.
		dock.dockExisting('p', 'a', 'center');
		dock.dismiss('b');
		expect(dock.showTabSwitch('b')).toEqual({ groupId: 't', from: 'p', wrapped: false });
		// Not hidden from the dock (an open or a plain closed window, an unknown id): nothing to dock.
		dock.undockPanel('p');
		expect(dock.shownTree('p')).toBeNull();
		dock.close('p');
		expect(dock.shownTree('p')).toBeNull();
		expect(dock.showPlacement('p')).toBe('floating');
		expect(dock.shownTree('nope')).toBeNull();
	});

	it('`panels` says `docked` for a hidden pane only while it has a default place', () => {
		const dock = state();
		dock.dismiss('left');
		const placement = () => dock.panels.find((p) => p.id === 'left')?.placement;
		expect(placement()).toBe('docked');
		dock.defaultLayout = null;
		expect(placement()).toBe('floating');
		expect(dock.show('left')).toBe('floating');
	});
});

// Codex P2 on #863: a tab group in an edge band keeps the default group's id. A group made again
// in the docked tree must not take it, or the layout holds the id twice and cannot be loaded.
describe('a default id in use out of the docked tree', () => {
	it('row[tabs[a, b, c, d], p], the group to its band, a and b hidden and shown: no id twice, the layout loads', () => {
		const tree = split('s', 'row', [0.6, 0.4], [tabs('t', ['a', 'b', 'c', 'd']), panel('p')]);
		let n = 0;
		const dock = createDockState({ version: 2, floating: [], docked: tree }, () => `new-${n++}`);
		dock.defaultLayout = { version: 2, floating: [], docked: tree };
		expect(dock.autoHideRegion('t')).toBe(true);
		dock.dismiss('a');
		expect(dock.show('a')).toBe('docked');
		dock.dismiss('b');
		expect(dock.show('b')).toBe('docked');
		// c and d are still in the band, in the group `t`; a and b are a group of another id.
		expect(dock.autoHidden.map((e) => e.node.id)).toEqual(['t']);
		const made = dock.layout.docked?.type === 'split' ? dock.layout.docked.children[0] : null;
		expect(made).toMatchObject({ type: 'tabs', children: [{ id: 'a' }, { id: 'b' }] });
		expect(made?.id).not.toBe('t');
		const checked = validateDockLayout(JSON.parse(dock.serialize()));
		expect(checked.ok ? [] : checked.issues).toEqual([]);
		expect(createDockState().hydrate(dock.serialize())).toBe(true);
	});

	it('`placeAtDefault` takes the ids given as in use: a default split id that is a floating window`s', () => {
		const made = placeAtDefault(
			panel('center'),
			three(),
			panel('left'),
			0.2,
			() => 'new',
			new Set(['root'])
		);
		expect(made).toMatchObject({ type: 'split', id: 'new' });
		expect(
			placeAtDefault(panel('center'), three(), panel('left'), 0.2, never, new Set(['x']))
		).toMatchObject({
			id: 'root'
		});
	});
});

describe('ThreePaneDock`s default places', () => {
	it('the default layout with both sides docked, whatever `*Open` says', () => {
		const options = {
			hostWidth: 1000,
			panels: {
				left: { title: 'L' },
				center: { title: 'C' },
				right: { title: 'R' },
				extra: [
					{ id: 'log', title: 'Log' },
					{ id: 'out', title: 'Out', initial: 'floating' as const }
				]
			},
			leftOpen: false,
			rightOpen: false
		};
		const places = threePaneDefaultPlaces(options).docked;
		expect(shapeOf(places)).toEqual({ row: ['left', 'center', 'right'] });
		// A side hidden by default is shown beside the centre; an extra panel that starts hidden or
		// floating has no docked place.
		const dock = createDockState(threePaneDockLayout(options), never);
		dock.defaultLayout = threePaneDefaultPlaces(options);
		expect(shapeOf(dock.layout.docked)).toEqual('center');
		expect(dock.show('right')).toBe('docked');
		expect(dock.show('left')).toBe('docked');
		expect(dock.layout.docked).toEqual(places);
		expect(dock.show('log')).toBe('floating');
		expect(hasDefaultPlace(places, 'out')).toBe(false);
	});
});
