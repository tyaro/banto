// #782 PR7: a change that is not made on the shadow tree S - an assignment from outside
// (`dock.layout = ...`: `ThreePaneDock`'s `syncPanels`, `DockHost.replaceLayout` without `saved`,
// an app's own). No guess is made of what the assignment did to the tree (owner's decision of
// 2026-11-23, as AvalonDock's PreviousContainer / PreviousContainerIndex):
//
//  - the split / tab group a floated pane was in is still in the tree (by its id): "back" puts the
//    pane into it, at the index it had (at the end when the container has fewer children now), with
//    the share it had there - the panes that show share the rest as the assignment left them;
//  - else the pane goes back to its default place (`DockState.defaultLayout`, as a pane hidden from
//    the dock does), or not at all when it has none.
//
// The shares a pane held are not worked out across an assignment. What is made on S (drags, floats,
// `dockExisting*`, closing, the edge bands since #782 PR8b) is as before.
// A layout put back as it was (a cancelled gesture) gets the S that was held with it.
import { describe, expect, it } from 'vitest';
import { markPresent, projectShadow, regraftShadow, type ShadowNode } from '../src/core/shadow';
import { dockPanelAtEdge, dockPanelIntoTree, removePanel } from '../src/core/tree';
import {
	adoptLayout,
	createDockState,
	homeMark,
	rememberShadow,
	shadowStateOf,
	watchShadow,
	type DockState,
	type ShadowFollow
} from '../src/state.svelte';
import type { DockNode, DockPanelNode } from '../src/types';
import { badSizes, counterMakeId } from './fixtures/dock-properties';
import { permutations } from './fixtures/exhaustive';
import { shapeOf } from './fixtures/visibility-sim';

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

/** A state docked as `tree`; with `defaults`, `tree` is its default layout too. */
const dockOf = (tree: DockNode, defaults = false): DockState => {
	const dock = createDockState({ version: 4, floating: [], docked: tree }, counterMakeId());
	if (defaults) dock.defaultLayout = { version: 4, floating: [], docked: tree };
	return dock;
};
const back = (dock: DockState, id: string): boolean => dock.dockBack(id);
const sizesOf = (node: DockNode | null | undefined): number[] =>
	node?.type === 'split' ? node.sizes : [];
const close = (got: number[], want: number[]) => {
	expect(got).toHaveLength(want.length);
	want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 9));
};
/** The sizes of the split `id` of the docked tree. */
const sizesIn = (dock: DockState, id: string): number[] => {
	const find = (n: DockNode | null): number[] | undefined => {
		if (n?.type !== 'split') return undefined;
		if (n.id === id) return n.sizes;
		for (const c of n.children) {
			const hit = find(c);
			if (hit) return hit;
		}
		return undefined;
	};
	return find(dock.layout.docked) ?? [];
};
/** How S followed the assignments `run` makes. */
const followsOf = (dock: DockState, run: () => void): ShadowFollow[] => {
	const seen: ShadowFollow[] = [];
	watchShadow(dock, (f) => seen.push(f));
	run();
	watchShadow(dock, null);
	return seen;
};
/** The share the place of the pane `id` holds in its split of S. */
const heldIn = (dock: DockState, id: string): number | undefined => {
	const find = (node: ShadowNode | null): number | undefined => {
		if (!node || node.type !== 'split') return undefined;
		const i = node.children.findIndex((c) => c.id === id);
		if (i !== -1) return node.sizes[i];
		for (const c of node.children) {
			const hit = find(c);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};
	return find(shadowStateOf(dock).shadow);
};
/** An assignment from outside: the docked pane `id` taken out of the tree. */
const take = (dock: DockState, id: string): void => {
	dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, id) };
};
/** An assignment from outside: the docked pane `id` moved to `region` of `target` (`core/tree.ts`). */
const move = (
	dock: DockState,
	id: string,
	target: string,
	region: 'left' | 'right' | 'center'
): void => {
	dock.layout = {
		...dock.layout,
		docked: dockPanelIntoTree(
			removePanel(dock.layout.docked, id),
			panel(id),
			target,
			region,
			() => `moved-${id}`
		)
	};
};
/** An assignment from outside: a new pane `id` at an outer edge. */
const add = (dock: DockState, id: string, edge: 'right' | 'bottom'): void => {
	dock.layout = {
		...dock.layout,
		docked: dockPanelAtEdge(dock.layout.docked, panel(id), edge, () => `edge-${id}`)
	};
};

/** The tree of #780: column[row[a .2, b .3, c .5], d, e]. */
const issue780 = (): DockNode =>
	split(
		's1',
		'column',
		[1 / 3, 1 / 3, 1 / 3],
		[
			split('s2', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]),
			panel('d'),
			panel('e')
		]
	);
/** a, b and e floated, c moved to the right of d: S holds column[row[a†, b†], row[d, c], e†]. */
const moved780 = (): DockState => {
	const dock = dockOf(issue780());
	for (const id of ['a', 'b', 'e']) dock.undockPanel(id);
	dock.dockExisting('c', 'd', 'right');
	return dock;
};
const shape780 = { column: [{ row: ['a', 'b'] }, { row: ['d', 'c'] }, 'e'] };

describe('an assignment from outside: the container a floated pane was in is still there (#782 PR7)', () => {
	it('a pane added at an outer edge: the floated panes go back as S had them (#780), in any order', () => {
		for (const order of permutations(['a', 'b', 'e'])) {
			const dock = moved780();
			expect(followsOf(dock, () => add(dock, 'z', 'right'))).toEqual([
				{ step: null, result: 'rebuilt' }
			]);
			expect(shadowStateOf(dock).unplaced, order.join()).toEqual([]);
			for (const id of order) expect(back(dock, id), `${order.join()}: ${id}`).toBe(true);
			expect(shapeOf(dock.layout.docked), order.join()).toEqual({ row: [shape780, 'z'] });
			close(sizesIn(dock, 's1'), [1 / 3, 1 / 3, 1 / 3]);
			close(sizesIn(dock, 's2'), [0.4, 0.6]);
		}
	});

	it('the `homeMark` is the same object all along: it names the place, nothing rewrites it', () => {
		const dock = dockOf(split('s', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)));
		dock.undockPanel('a');
		const home = homeMark(dock, 'a');
		add(dock, 'z', 'bottom');
		expect(homeMark(dock, 'a')).toBe(home);
		expect(heldIn(dock, 'a')).toBeCloseTo(0.2, 9);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b', 'c'] }, 'z'] });
		close(sizesIn(dock, 's'), [0.2, 0.3, 0.5]);
	});

	it('a sibling removed: back at the index it had, with the share it had - the rest as the assignment left it', () => {
		// row[a .1, b .2, c .3, d .4], b floated (index 1), a removed: row[c 3/7, d 4/7].
		const dock = dockOf(split('s', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'd'].map(panel)));
		dock.undockPanel('b');
		take(dock, 'a');
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		expect(heldIn(dock, 'b')).toBeCloseTo(0.2, 9);
		expect(back(dock, 'b')).toBe(true);
		// Index 1 of the row as it is now: between c and d (no guess that `a` was the one before it).
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['c', 'b', 'd'] });
		close(sizesIn(dock, 's'), [(0.8 * 3) / 7, 0.2, (0.8 * 4) / 7]);
	});

	it('an index past the end: at the end', () => {
		const dock = dockOf(split('s', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'd'].map(panel)));
		dock.undockPanel('d');
		take(dock, 'a');
		expect(back(dock, 'd')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['b', 'c', 'd'] });
		close(sizesIn(dock, 's'), [0.6 * 0.4, 0.6 * 0.6, 0.4]);
	});

	it('two floated out of one split: both back at their indices, in either order', () => {
		for (const order of permutations(['a', 'e'])) {
			const dock = dockOf(
				split('s', 'row', [0.1, 0.2, 0.3, 0.2, 0.2], ['a', 'b', 'c', 'd', 'e'].map(panel))
			);
			dock.undockPanel('a');
			dock.undockPanel('e');
			take(dock, 'c');
			for (const id of order) expect(back(dock, id)).toBe(true);
			expect(shapeOf(dock.layout.docked), order.join()).toEqual({ row: ['a', 'b', 'd', 'e'] });
			close(sizesIn(dock, 's'), [0.1, 0.35, 0.35, 0.2]);
		}
	});

	it('a tab group: the tab goes back into it at its index', () => {
		const dock = dockOf(split('s', 'row', [0.5, 0.5], [tabs('t', ['a', 'b', 'c']), panel('x')]));
		dock.undockPanel('b');
		add(dock, 'z', 'bottom');
		expect(back(dock, 'b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({
			column: [{ row: [{ tabs: ['a', 'b', 'c'] }, 'x'] }, 'z']
		});
	});

	it('a container that showed as its one pane in place (the others floated) is put around that pane again', () => {
		// row[column[a, b], c]: a floated - the column shows as b. A pane added from outside.
		const dock = dockOf(
			split(
				's1',
				'row',
				[0.6, 0.4],
				[split('s2', 'column', [0.3, 0.7], ['a', 'b'].map(panel)), panel('c')]
			)
		);
		dock.undockPanel('a');
		add(dock, 'z', 'bottom');
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({
			column: [{ row: [{ column: ['a', 'b'] }, 'c'] }, 'z']
		});
		close(sizesIn(dock, 's2'), [0.3, 0.7]);
	});
});

describe('an assignment from outside: the container is gone - the default place (#782 PR7)', () => {
	const uneven = (): DockNode => split('s', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel));

	it('the row folded around the one pane left: back at the default place', () => {
		const dock = dockOf(uneven(), true);
		dock.undockPanel('a');
		const home = homeMark(dock, 'a');
		take(dock, 'c');
		expect(dock.layout.docked).toEqual(panel('b'));
		expect(shadowStateOf(dock).unplaced).toEqual(['a']);
		expect(homeMark(dock, 'a')).toBe(home);
		expect(dock.backTree('a')).not.toBeNull();
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b'] });
		expect(badSizes(dock.layout.docked)).toEqual([]);
		expect(dock.layout.floating).toEqual([]);
	});

	it('no default layout: no place - the pane stays floating', () => {
		const dock = dockOf(uneven());
		dock.undockPanel('a');
		take(dock, 'c');
		// It still remembers a place (#782 PR8a): whether it can go back is `backTree`, not `hasHome`.
		expect(dock.hasHome('a')).toBe(true);
		expect(dock.backTree('a')).toBeNull();
		expect(back(dock, 'a')).toBe(false);
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['a']);
		expect(dock.layout.docked).toEqual(panel('b'));
	});

	// Review of #870: that a float lost its place ends with that float.
	it('floated again after it went back to its default place: the new place is its own, an edge band does not drop it', () => {
		const dock = dockOf(
			split(
				'col',
				'column',
				[0.5, 0.3, 0.2],
				[split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('d'), panel('z')]
			),
			true
		);
		dock.undockPanel('a');
		take(dock, 'b');
		take(dock, 'c');
		expect(shadowStateOf(dock).unplaced).toEqual(['a']);
		expect(back(dock, 'a')).toBe(true);
		const placed = shapeOf(dock.layout.docked);
		// Floated a second time, with no default layout any more: the place is the tombstone's.
		dock.undockPanel('a');
		dock.defaultLayout = null;
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		expect(dock.autoHideRegion('z')).toBe(true);
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		expect(dock.backTree('a')).not.toBeNull();
		expect(dock.restoreAutoHidden('z')).toBe(true);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual(placed);
		expect(dock.layout.floating).toEqual([]);
	});

	it('a pane that lost its place keeps none: a later assignment does not bring it back', () => {
		const dock = dockOf(uneven(), true);
		dock.undockPanel('a');
		take(dock, 'c');
		add(dock, 'z', 'right');
		expect(shadowStateOf(dock).unplaced).toEqual(['a']);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'z'] });
	});
});

// The five cases the reviews of PR #870 found while the places were still worked out from the
// difference of the trees - with what the rule gives now.
describe('the cases of the reviews of #870, by the rule (#782 PR7)', () => {
	it('Codex 1: a floated, z to its band, c removed by an assignment, z back, a back', () => {
		// column[row[a .2, b .3, c .5], z]. With c removed the row is gone (it showed b and c, and
		// is folded around b): a goes back to its default place - beside b.
		const dock = dockOf(
			split(
				'col',
				'column',
				[0.7, 0.3],
				[split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('z')]
			),
			true
		);
		dock.undockPanel('a');
		expect(dock.autoHideRegion('z')).toBe(true);
		take(dock, 'c');
		expect(dock.restoreAutoHidden('z')).toBe(true);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'z'] });
		expect(badSizes(dock.layout.docked)).toEqual([]);
	});

	for (const region of ['right', 'center'] as const) {
		it(`Codex 2: a floated, c moved to ${region} of d by an assignment: a back in the row, with the share it had`, () => {
			// column[row[a .1, b .2, c .3, e .4], d]: the row is still there. a keeps .1; b and e
			// share the rest as the assignment left them (1 : 2) - not 1/7, 2/7, 4/7.
			const dock = dockOf(
				split(
					'col',
					'column',
					[0.6, 0.4],
					[split('r', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'e'].map(panel)), panel('d')]
				)
			);
			dock.undockPanel('a');
			move(dock, 'c', 'd', region);
			expect(back(dock, 'a')).toBe(true);
			close(sizesIn(dock, 'r'), [0.1, 0.3, 0.6]);
		});
	}

	it('Codex 3: column[a .2, row[b, c] .3, d .5], a floated, c moved to the right of d: the column as it was', () => {
		const dock = dockOf(
			split(
				'col',
				'column',
				[0.2, 0.3, 0.5],
				[panel('a'), split('r', 'row', [0.5, 0.5], ['b', 'c'].map(panel)), panel('d')]
			)
		);
		dock.undockPanel('a');
		move(dock, 'c', 'd', 'right');
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: ['a', 'b', { row: ['d', 'c'] }] });
		close(sizesIn(dock, 'col'), [0.2, 0.3, 0.5]);
	});

	it('Codex 4: column[a, row[b, c], d], d floated, b moved to the right of a: d back at the end', () => {
		const dock = dockOf(
			split(
				'col',
				'column',
				[0.3, 0.3, 0.4],
				[panel('a'), split('r', 'row', [0.5, 0.5], ['b', 'c'].map(panel)), panel('d')]
			)
		);
		dock.undockPanel('d');
		move(dock, 'b', 'a', 'right');
		expect(back(dock, 'd')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'c', 'd'] });
		close(sizesIn(dock, 'col'), [0.3, 0.3, 0.4]);
	});

	it('cross-review: column[row[a, b], tabs[d, e], x], a floated, b moved into the tab group', () => {
		// The row showed as b, and b is a tab now: the row cannot be put around a tab, so a has no
		// place in S and goes back to its default place.
		const tree = split(
			'col',
			'column',
			[0.5, 0.3, 0.2],
			[split('r', 'row', [0.4, 0.6], ['a', 'b'].map(panel)), tabs('t', ['d', 'e']), panel('x')]
		);
		const dock = dockOf(tree, true);
		dock.undockPanel('a');
		move(dock, 'b', 'd', 'center');
		expect(shadowStateOf(dock).unplaced).toEqual(['a']);
		expect(back(dock, 'a')).toBe(true);
		// The default place: beside b, its sibling of the default layout - with the group b is in.
		expect(shapeOf(dock.layout.docked)).toEqual({
			column: [{ row: ['a', { tabs: ['d', 'e', 'b'] }] }, 'x']
		});
		expect(badSizes(dock.layout.docked)).toEqual([]);
		// Without a default layout it stays floating.
		const bare = dockOf(tree);
		bare.undockPanel('a');
		move(bare, 'b', 'd', 'center');
		expect(back(bare, 'a')).toBe(false);
	});
});

describe('a layout put back as it was (a cancelled gesture) (#782 PR7)', () => {
	const snapshotOf = (dock: DockState) => {
		const snapshot = JSON.parse(JSON.stringify(dock.layout)) as typeof dock.layout;
		rememberShadow(dock, snapshot);
		return snapshot;
	};

	it('gets the S that showed it', () => {
		for (const order of permutations(['a', 'b', 'e'])) {
			const dock = moved780();
			const snapshot = snapshotOf(dock);
			// What the gesture did meanwhile.
			dock.dockExistingAtEdge('d', 'left');
			dock.undockPanel('c');
			adoptLayout(dock, snapshot);
			expect(shadowStateOf(dock).unplaced, order.join()).toEqual([]);
			for (const id of order) expect(back(dock, id), `${order.join()}: ${id}`).toBe(true);
			expect(shapeOf(dock.layout.docked), order.join()).toEqual(shape780);
		}
	});

	it('a pane floating then, docked again meanwhile, remembers its place again', () => {
		const dock = moved780();
		const home = homeMark(dock, 'a');
		const snapshot = snapshotOf(dock);
		// Meanwhile a is docked somewhere else (its place is spent) and d is floated.
		dock.dockPanel('a', 'd', 'bottom');
		dock.undockPanel('d');
		expect(dock.hasHome('a')).toBe(false);
		adoptLayout(dock, snapshot);
		expect(homeMark(dock, 'a')).toBe(home);
		expect(dock.hasHome('d')).toBe(false);
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		for (const id of ['e', 'a', 'b']) expect(back(dock, id), id).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual(shape780);
	});

	it('with nothing docked: the floated panes still go back', () => {
		const dock = dockOf(split('s', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)));
		for (const id of ['a', 'b', 'c']) dock.undockPanel(id);
		expect(dock.layout.docked).toBeNull();
		const snapshot = snapshotOf(dock);
		// Meanwhile b is docked (alone: the root) and c beside it.
		dock.dockPanelAtEdge('b', 'left');
		dock.dockPanel('c', 'b', 'bottom');
		adoptLayout(dock, snapshot);
		expect(dock.layout.docked).toBeNull();
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		for (const id of ['c', 'a', 'b']) expect(back(dock, id), id).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c'] });
		close(sizesOf(dock.layout.docked), [0.2, 0.3, 0.5]);
	});

	it('takes the S held with it, whatever was assigned or went to an edge band since (review of #870)', () => {
		// row[a .1, b .2, c .3, d .4], a floated. Meanwhile b is removed and d goes to its band: put
		// back, a holds .1 again.
		const dock = dockOf(split('s', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'd'].map(panel)));
		dock.undockPanel('a');
		const then = shadowStateOf(dock).shadow;
		const snapshot = snapshotOf(dock);
		take(dock, 'b');
		expect(dock.autoHideRegion('d')).toBe(true);
		const follows = followsOf(dock, () => adoptLayout(dock, snapshot));
		expect(follows).toEqual([{ step: 'adopt', result: 'same' }]);
		expect(shadowStateOf(dock).shadow).toBe(then);
		expect(heldIn(dock, 'a')).toBeCloseTo(0.1, 9);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c', 'd'] });
		close(sizesOf(dock.layout.docked), [0.1, 0.2, 0.3, 0.4]);
	});
});

describe('a region to and from an edge band (#739; a step on S since #782 PR8b)', () => {
	it('a floated pane stays beside the pane that was in the band', () => {
		const dock = dockOf(split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)));
		dock.undockPanel('a');
		expect(dock.autoHideRegion('b')).toBe(true);
		expect(dock.restoreAutoHidden('b')).toBe(true);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c'] });
		close(sizesOf(dock.layout.docked), [0.2, 0.3, 0.5]);
	});
});

// Was a KNOWN FAILURE until #782 PR8b (Codex P2 on #870, 8c7cc0e1): a pane floated while a sibling
// is in a band, and another sibling closed - the pane in the band came back in front of the floated
// pane's place (the slot S said for `b` could not name `c`: S did not hold the panes in a band).
// The band's pane is a tombstone of S now, so `b`'s place stays before it.
describe('floated while a sibling is in an edge band, another sibling closed (#782 PR8b)', () => {
	it('row[a, b, c, d, e]: c to its band, b floated, d closed, c back, b back -> row[a, b, c, e]', () => {
		const dock = dockOf(
			split('s', 'row', [0.2, 0.2, 0.2, 0.2, 0.2], ['a', 'b', 'c', 'd', 'e'].map(panel)),
			true
		);
		expect(dock.autoHideRegion('c')).toBe(true);
		dock.undockPanel('b');
		dock.dismiss('d');
		expect(dock.restoreAutoHidden('c')).toBe(true);
		expect(back(dock, 'b')).toBe(true);
		// Until #782 PR8b: row[a, c, b, e].
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c', 'e'] });
	});
});

// Codex P2 on #870: a region that is not beside a floated pane's place, back from its band, leaves
// that place as S has it - the index an assignment gave it meanwhile, and its share.
describe('an edge band and a place it has nothing to do with (#782 PR7)', () => {
	const tree = (): DockNode =>
		split(
			'col',
			'column',
			[0.7, 0.3],
			[split('r', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'd'].map(panel)), panel('z')]
		);

	it('b floated, z to its band, a removed by an assignment, z back, b back: row[c, b, d]', () => {
		const dock = dockOf(tree());
		dock.undockPanel('b');
		expect(dock.autoHideRegion('z')).toBe(true);
		take(dock, 'a');
		expect(heldIn(dock, 'b')).toBeCloseTo(0.2, 9);
		const held = shadowStateOf(dock).shadow;
		expect(dock.restoreAutoHidden('z')).toBe(true);
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		expect(heldIn(dock, 'b')).toBeCloseTo(0.2, 9);
		expect(back(dock, 'b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['c', 'b', 'd'] }, 'z'] });
		close(sizesIn(dock, 'r'), [(0.8 * 3) / 7, 0.2, (0.8 * 4) / 7]);
		expect(held).not.toBeNull();
	});

	it('the same without the assignment: the row as it was', () => {
		const dock = dockOf(tree());
		dock.undockPanel('b');
		expect(dock.autoHideRegion('z')).toBe(true);
		expect(dock.restoreAutoHidden('z')).toBe(true);
		expect(back(dock, 'b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b', 'c', 'd'] }, 'z'] });
		close(sizesIn(dock, 'r'), [0.1, 0.2, 0.3, 0.4]);
		close(sizesIn(dock, 'col'), [0.7, 0.3]);
	});

	it('a divider moved while z is in its band: the share S holds stays', () => {
		const dock = dockOf(tree());
		dock.undockPanel('b');
		expect(dock.autoHideRegion('z')).toBe(true);
		dock.resizeSplit('r', 0, 0.1);
		const then = heldIn(dock, 'b');
		expect(dock.restoreAutoHidden('z')).toBe(true);
		expect(heldIn(dock, 'b')).toBeCloseTo(then!, 9);
		expect(back(dock, 'b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b', 'c', 'd'] }, 'z'] });
	});
});

describe('regraftShadow (#782 PR7)', () => {
	const gone = (id: string): ShadowNode => ({ ...panel(id), away: true });
	const row = (children: ShadowNode[], sizes: number[]): ShadowNode => ({
		type: 'split',
		id: 'r',
		direction: 'row',
		sizes,
		children
	});

	it('nothing away: the docked tree itself', () => {
		const tree = split('r', 'row', [0.5, 0.5], ['a', 'b'].map(panel));
		expect(regraftShadow(tree, tree).shadow).toBe(tree);
		expect(regraftShadow(null, tree)).toEqual({ shadow: tree, unplaced: [] });
	});

	it('nothing docked before and after: S as it is; nothing docked after: no place', () => {
		const all = row([gone('a'), gone('b')], [0.4, 0.6]);
		expect(regraftShadow(all, null)).toEqual({ shadow: all, unplaced: [] });
		const some = row([gone('a'), panel('b')], [0.4, 0.6]);
		expect(regraftShadow(some, null)).toEqual({ shadow: null, unplaced: ['a'] });
	});

	it('a container of another kind or direction with the id is not the container', () => {
		const old = row([gone('a'), panel('b'), panel('c')], [0.2, 0.3, 0.5]);
		const column = split('r', 'column', [0.5, 0.5], ['b', 'c'].map(panel));
		expect(regraftShadow(old, column)).toEqual({ shadow: column, unplaced: ['a'] });
	});

	it('a container is not made again with an id the layout uses elsewhere (`taken`)', () => {
		const old: ShadowNode = {
			type: 'split',
			id: 'outer',
			direction: 'column',
			sizes: [0.5, 0.5],
			children: [row([gone('a'), panel('b')], [0.4, 0.6]), panel('x')]
		};
		const docked = split('outer', 'column', [0.5, 0.5], [panel('b'), panel('x')]);
		expect(regraftShadow(old, docked).unplaced).toEqual([]);
		expect(regraftShadow(old, docked, ['r'])).toEqual({ shadow: docked, unplaced: ['a'] });
	});

	// Codex P2 on #870: a share of 0 is a share (`validate.ts` and S take it) - it does not send
	// the split to the even parts, and the other floated panes keep theirs.
	it('a tombstone with a share of 0 keeps it, and the others keep theirs', () => {
		const old = row([gone('a'), gone('b'), panel('c'), panel('d')], [0, 0.2, 0.3, 0.5]);
		const docked = split(
			'col',
			'column',
			[0.75, 0.25],
			[split('r', 'row', [0.375, 0.625], ['c', 'd'].map(panel)), panel('z')]
		);
		const { shadow, unplaced } = regraftShadow(old, docked);
		expect(unplaced).toEqual([]);
		const r = shadow?.type === 'split' ? shadow.children[0] : null;
		close(r?.type === 'split' ? r.sizes : [], [0, 0.2, 0.3, 0.5]);
	});

	it('the same through `DockState`: row[a 0, b .2, c .3, d .5], a and b floated, z added below', () => {
		const dock = dockOf(split('r', 'row', [0, 0.2, 0.3, 0.5], ['a', 'b', 'c', 'd'].map(panel)));
		dock.undockPanel('a');
		dock.undockPanel('b');
		add(dock, 'z', 'bottom');
		expect(back(dock, 'b')).toBe(true);
		expect(back(dock, 'a')).toBe(true);
		close(sizesIn(dock, 'r'), [0, 0.2, 0.3, 0.5]);
	});

	it('a container put around its one pane in place again takes the band flag of that pane', () => {
		const old: ShadowNode = {
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [
				{
					type: 'tabs',
					id: 't',
					activeIndex: 1,
					children: [{ ...panel('b'), away: true }, panel('a')],
					collapsed: true
				},
				panel('e')
			]
		};
		const docked = split('s', 'row', [0.5, 0.5], [{ ...panel('a'), collapsed: true }, panel('e')]);
		const { shadow, unplaced } = regraftShadow(old, docked);
		expect(unplaced).toEqual([]);
		expect(projectShadow(shadow)).toEqual(docked);
	});

	// Cross-review of #870: only a tab group takes the flag. A split has none - the flag of its
	// only child showing is one S cannot hold (`DockState` keeps it on the docked tree).
	it('a split put around its one pane in place again has no band flag, nor once the other pane is back', () => {
		const old: ShadowNode = {
			type: 'split',
			id: 's',
			direction: 'column',
			sizes: [0.5, 0.5],
			children: [row([gone('b'), panel('a')], [0.4, 0.6]), panel('e')]
		};
		const docked = split(
			's',
			'column',
			[0.5, 0.5],
			[{ ...panel('a'), collapsed: true }, panel('e')]
		);
		const { shadow, unplaced } = regraftShadow(old, docked);
		expect(unplaced).toEqual([]);
		const flagged = (node: ShadowNode | null): string[] =>
			!node
				? []
				: [
						...(node.type === 'split' && 'collapsed' in node ? [node.id] : []),
						...(node.type === 'panel' ? [] : node.children.flatMap(flagged))
					];
		expect(flagged(shadow)).toEqual([]);
		expect(flagged(markPresent(shadow, 'b'))).toEqual([]);
		expect(shapeOf(projectShadow(markPresent(shadow, 'b')))).toEqual({
			column: [{ row: ['b', 'a'] }, 'e']
		});
	});

	it('tombstones that held the whole split leave the panes that show an even part', () => {
		const old = row([gone('a'), gone('b'), panel('c')], [0.5, 0.5, 0]);
		const docked = split('r', 'row', [0.5, 0.5], ['c', 'd'].map(panel));
		const { shadow } = regraftShadow(old, docked);
		const sizes = shadow?.type === 'split' ? shadow.sizes : [];
		close(sizes, [0.25, 0.25, 0.25, 0.25]);
	});
});
