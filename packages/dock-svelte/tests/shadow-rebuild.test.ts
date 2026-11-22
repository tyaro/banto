// #782 PR7: when a change is not made on the shadow tree S - an assignment from outside that adds
// or moves a pane (`ThreePaneDock`'s `syncPanels`, `DockHost.replaceLayout`), a layout put back as
// it was (a cancelled gesture) - S is made again from the places S itself says (`deflateShadow` ->
// `inflateShadow`), not from the slots the panes were floated with. So what S knew of the panes
// out of the tree (the moves made on it, the shares) is kept, and nothing rewrites a `homeSlot`:
// it only names the place.
import { describe, expect, it } from 'vitest';
import { dockPanelAtEdge, dockPanelIntoTree, removePanel } from '../src/core/tree';
import {
	adoptLayout,
	createDockState,
	rememberShadow,
	shadowStateOf,
	watchShadow,
	type DockState,
	type ShadowFollow
} from '../src/state.svelte';
import type { DockNode, DockPanelNode } from '../src/types';
import { badSizes, counterMakeId, runSteps } from './fixtures/dock-properties';
import { permutations } from './fixtures/exhaustive';
import { shapeOf } from './fixtures/visibility-sim';

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });
const split = (
	id: string,
	direction: 'row' | 'column',
	sizes: number[],
	children: DockNode[]
): DockNode => ({ type: 'split', id, direction, sizes, children });

const dockOf = (tree: DockNode): DockState =>
	createDockState({ version: 2, floating: [], docked: tree }, counterMakeId());
const back = (dock: DockState, id: string): boolean => dock.dockAtSlot(id, dock.homeSlot(id)!);
const sizesOf = (node: DockNode | null | undefined): number[] =>
	node?.type === 'split' ? node.sizes : [];
const close = (got: number[], want: number[]) => {
	expect(got).toHaveLength(want.length);
	want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 9));
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
	const find = (node: ReturnType<typeof shadowStateOf>['shadow']): number | undefined => {
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

describe('S made again keeps what S knew (#782 PR7)', () => {
	it('a pane added by an assignment from outside: the floated panes still go back as S had them (#780)', () => {
		for (const order of permutations(['a', 'b', 'e'])) {
			const dock = moved780();
			const follows = followsOf(dock, () => {
				dock.layout = {
					...dock.layout,
					docked: dockPanelAtEdge(dock.layout.docked, panel('z'), 'right', () => 'edge')
				};
			});
			expect(follows, order.join()).toEqual([{ step: null, result: 'rebuilt' }]);
			expect(shadowStateOf(dock).unplaced, order.join()).toEqual([]);
			for (const id of order) expect(back(dock, id), `${order.join()}: ${id}`).toBe(true);
			expect(shapeOf(dock.layout.docked), order.join()).toEqual({ row: [shape780, 'z'] });
			const column = (dock.layout.docked as Extract<DockNode, { type: 'split' }>).children[0];
			close(sizesOf(column), [1 / 3, 1 / 3, 1 / 3]);
			close(sizesOf((column as Extract<DockNode, { type: 'split' }>).children[0]), [0.4, 0.6]);
		}
	});

	it('the share a place holds in S is the one it comes back with after S is made again', () => {
		// row[a .2, b .3, c .5], a floated, c removed from outside: a holds .4 of what is left (#743).
		const dock = dockOf(split('s', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]));
		dock.undockPanel('a');
		const home = dock.homeSlot('a');
		dock.layout = { ...dock.layout, docked: panel('b') };
		expect(heldIn(dock, 'a')).toBeCloseTo(0.4, 9);
		// ... and a pane added from outside (S is made again) leaves it there.
		dock.layout = {
			...dock.layout,
			docked: dockPanelAtEdge(dock.layout.docked, panel('z'), 'bottom', () => 'edge')
		};
		expect(heldIn(dock, 'a')).toBeCloseTo(0.4, 9);
		// The slot handed out is the same object all along: it names the place, nothing rewrites it.
		expect(dock.homeSlot('a')).toBe(home);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'z'] });
		const row = (dock.layout.docked as Extract<DockNode, { type: 'split' }>).children[0];
		close(sizesOf(row), [0.4, 0.6]);
	});

	it('a layout put back as it was (a cancelled gesture) gets the S that showed it', () => {
		for (const order of permutations(['a', 'b', 'e'])) {
			const dock = moved780();
			const snapshot = JSON.parse(JSON.stringify(dock.layout)) as typeof dock.layout;
			rememberShadow(dock, snapshot);
			// What the gesture did meanwhile.
			dock.dockExistingAtEdge('d', 'left');
			dock.undockPanel('c');
			adoptLayout(dock, snapshot);
			expect(shadowStateOf(dock).unplaced, order.join()).toEqual([]);
			for (const id of order) expect(back(dock, id), `${order.join()}: ${id}`).toBe(true);
			expect(shapeOf(dock.layout.docked), order.join()).toEqual(shape780);
		}
	});

	it('a layout put back as it was: a pane floating then, docked again meanwhile, remembers its place again', () => {
		const dock = moved780();
		const home = dock.homeSlot('a');
		const snapshot = JSON.parse(JSON.stringify(dock.layout)) as typeof dock.layout;
		rememberShadow(dock, snapshot);
		// Meanwhile a is docked somewhere else (its place is spent) and d is floated.
		dock.dockPanel('a', 'd', 'bottom');
		dock.undockPanel('d');
		expect(dock.homeSlot('a')).toBeUndefined();
		adoptLayout(dock, snapshot);
		expect(dock.homeSlot('a')).toBe(home);
		expect(dock.homeSlot('d')).toBeUndefined();
		expect(shadowStateOf(dock).unplaced).toEqual([]);
		for (const id of ['e', 'a', 'b']) expect(back(dock, id), id).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual(shape780);
	});

	it('a layout put back as it was with nothing docked: the floated panes still go back', () => {
		const dock = dockOf(split('s', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)));
		for (const id of ['a', 'b', 'c']) dock.undockPanel(id);
		expect(dock.layout.docked).toBeNull();
		const snapshot = JSON.parse(JSON.stringify(dock.layout)) as typeof dock.layout;
		rememberShadow(dock, snapshot);
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

	it('a layout put back as it was takes the S held with it, whatever is in an edge band by then (review of #870)', () => {
		// row[a .1, b .2, c .3, d .4], a floated. Meanwhile b is removed (a holds .125) and d goes
		// to its band: put back, a holds .1 again.
		const dock = dockOf(split('s', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'd'].map(panel)));
		dock.undockPanel('a');
		const then = shadowStateOf(dock).shadow;
		const snapshot = JSON.parse(JSON.stringify(dock.layout)) as typeof dock.layout;
		rememberShadow(dock, snapshot);
		dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, 'b') };
		expect(heldIn(dock, 'a')).toBeCloseTo(0.125, 9);
		expect(dock.autoHideRegion('d')).toBe(true);
		const follows = followsOf(dock, () => adoptLayout(dock, snapshot));
		expect(follows).toEqual([{ step: 'adopt', result: 'same' }]);
		expect(shadowStateOf(dock).shadow).toBe(then);
		expect(heldIn(dock, 'a')).toBeCloseTo(0.1, 9);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c', 'd'] });
		close(sizesOf(dock.layout.docked), [0.1, 0.2, 0.3, 0.4]);
	});

	it('a floated pane docked back at its place from outside holds its share again', () => {
		// row[a .1, b .2, c .3, d .4], b and c floated; an assignment docks c back between a and d.
		const dock = dockOf(split('s', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'd'].map(panel)));
		dock.undockPanel('b');
		dock.undockPanel('c');
		dock.layout = {
			...dock.layout,
			floating: dock.layout.floating.filter((w) => w.id !== 'c'),
			docked: split('s', 'row', [0.125, 0.375, 0.5], ['a', 'c', 'd'].map(panel))
		};
		expect(dock.homeSlot('c')).toBeUndefined();
		expect(heldIn(dock, 'b')).toBeCloseTo(0.2, 9);
		expect(back(dock, 'b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c', 'd'] });
		close(sizesOf(dock.layout.docked), [0.1, 0.2, 0.3, 0.4]);
	});
});

// Codex P2 on #870: while a region is in an edge band, S is made again from the places it said
// when it last held every pane - but the shares S holds since are not lost with them.
describe('a region in an edge band: the shares S holds since are kept (#782 PR7)', () => {
	const tree = (): DockNode =>
		split(
			'col',
			'column',
			[0.7, 0.3],
			[split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('z')]
		);
	const rowOf = (dock: DockState): number[] => {
		const find = (n: DockNode | null): number[] | undefined => {
			if (n?.type !== 'split') return undefined;
			if (n.id === 'r') return n.sizes;
			for (const c of n.children) {
				const hit = find(c);
				if (hit) return hit;
			}
			return undefined;
		};
		return find(dock.layout.docked) ?? [];
	};

	it('a floated, z to its band, c removed by an assignment, z back, a back: a : b = .4 : .6', () => {
		const dock = dockOf(tree());
		dock.undockPanel('a');
		expect(dock.autoHideRegion('z')).toBe(true);
		dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, 'c') };
		expect(heldIn(dock, 'a')).toBeCloseTo(0.4, 9);
		expect(dock.restoreAutoHidden('z')).toBe(true);
		expect(heldIn(dock, 'a')).toBeCloseTo(0.4, 9);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'z'] });
		close(rowOf(dock), [0.4, 0.6]);
	});

	it('the same with a pane added from outside while z is in its band', () => {
		const dock = dockOf(tree());
		dock.undockPanel('a');
		expect(dock.autoHideRegion('z')).toBe(true);
		dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, 'c') };
		// A pane added from outside while z is in its band: S is made again there too.
		dock.layout = {
			...dock.layout,
			docked: dockPanelAtEdge(dock.layout.docked, panel('y'), 'right', () => 'edge')
		};
		expect(heldIn(dock, 'a')).toBeCloseTo(0.4, 9);
		expect(dock.restoreAutoHidden('z')).toBe(true);
		expect(back(dock, 'a')).toBe(true);
		close(rowOf(dock), [0.4, 0.6]);
	});

	it('a stays beside the pane that was in the band (#739)', () => {
		const dock = dockOf(split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)));
		dock.undockPanel('a');
		expect(dock.autoHideRegion('b')).toBe(true);
		expect(dock.restoreAutoHidden('b')).toBe(true);
		expect(back(dock, 'a')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c'] });
		close(sizesOf(dock.layout.docked), [0.2, 0.3, 0.5]);
	});
});

// Codex P2 on #870 (the second): a docked pane an assignment moves into another container left
// the split it was in, as one it removes did (#743) - its share goes to the ones left there, the
// places of the floated panes among them.
describe('a docked pane moved out of its split by an assignment (#782 PR7)', () => {
	const tree = (): DockNode =>
		split(
			'col',
			'column',
			[0.6, 0.4],
			[split('r', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'e'].map(panel)), panel('d')]
		);
	const moved = (dock: DockState, id: string, target: string, region: 'right' | 'center') => {
		const node = panel(id);
		dock.layout = {
			...dock.layout,
			docked: dockPanelIntoTree(
				removePanel(dock.layout.docked, id),
				node,
				target,
				region,
				() => 'moved'
			)
		};
	};
	const rowR = (dock: DockState): number[] => {
		const find = (n: DockNode | null): number[] | undefined => {
			if (n?.type !== 'split') return undefined;
			if (n.id === 'r') return n.sizes;
			for (const c of n.children) {
				const hit = find(c);
				if (hit) return hit;
			}
			return undefined;
		};
		return find(dock.layout.docked) ?? [];
	};

	for (const region of ['right', 'center'] as const) {
		it(`a floated, c moved to ${region} of d by an assignment, a back: 1/7, 2/7, 4/7`, () => {
			const dock = dockOf(tree());
			dock.undockPanel('a');
			moved(dock, 'c', 'd', region);
			expect(heldIn(dock, 'a')).toBeCloseTo(1 / 7, 9);
			expect(back(dock, 'a')).toBe(true);
			close(rowR(dock), [1 / 7, 2 / 7, 4 / 7]);
		});
	}

	it('the same as the move made by `dockExisting`', () => {
		const by = dockOf(tree());
		by.undockPanel('a');
		by.dockExisting('c', 'd', 'right');
		expect(back(by, 'a')).toBe(true);
		close(rowR(by), [1 / 7, 2 / 7, 4 / 7]);
	});

	it('a pane moved inside its split holds its share: the places are as they were', () => {
		const dock = dockOf(tree());
		dock.undockPanel('a');
		moved(dock, 'c', 'e', 'right');
		expect(heldIn(dock, 'a')).toBeCloseTo(0.1, 9);
		expect(back(dock, 'a')).toBe(true);
		expect(rowR(dock).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
		expect(rowR(dock)[0]).toBeCloseTo(0.1, 9);
	});
});

// The cases the property "floated panes: assignments from outside in between"
// (`slot-properties.test.ts`) found while #782 PR7 was made, pinned.
describe('pinned: docked panes moved by an assignment while panes are floated (#782 PR7)', () => {
	const even = (id: string, direction: 'row' | 'column', children: DockNode[]): DockNode =>
		split(
			id,
			direction,
			children.map(() => 1 / children.length),
			children
		);
	const cases: [string, DockNode, string[], unknown][] = [
		[
			'the last pane showing of a split moved into the split beside it',
			even('s1', 'row', [
				even('s2', 'column', ['a', 'b', 'c'].map(panel)),
				even('s3', 'column', ['d', 'e'].map(panel))
			]),
			['~a', '~b', 'c=>d:left', '^a', '^b'],
			{ row: [{ column: ['a', 'b'] }, { column: [{ row: ['c', 'd'] }, 'e'] }] }
		],
		[
			'a pane moved into the tabs of a pane deeper in its own split',
			even('s1', 'row', [
				panel('a'),
				even('s2', 'column', [even('s3', 'row', ['b', 'c'].map(panel)), panel('d')]),
				panel('e'),
				panel('f')
			]),
			['~e', '~f', 'a=>c:center', '^e', '^f'],
			{ row: [{ column: [{ row: ['b', { tabs: ['c', 'a'] }] }, 'd'] }, 'e', 'f'] }
		],
		[
			'a split of two folded around the pane left, the other put beside it',
			even('s1', 'row', [panel('a'), even('s2', 'column', ['b', 'c'].map(panel)), panel('d')]),
			['~a', 'b=>d:left', '^a'],
			{ row: ['a', 'c', 'b', 'd'] }
		],
		[
			'a pane moved into the split a pane of its own was folded into',
			even('s1', 'column', [
				panel('a'),
				panel('b'),
				panel('c'),
				even('s2', 'row', ['d', 'e'].map(panel))
			]),
			['~a', '~b', 'c=>d:left', '^a', '^b'],
			{ column: ['a', 'b', { row: ['c', 'd', 'e'] }] }
		]
	];
	for (const [name, tree, steps, shape] of cases) {
		it(`${name}: ${steps.join(' ')}`, () => {
			const dock = runSteps(tree, steps);
			expect(dock.layout.floating).toEqual([]);
			expect(badSizes(dock.layout.docked)).toEqual([]);
			expect(JSON.stringify(shapeOf(dock.layout.docked))).toBe(JSON.stringify(shape));
		});
	}
});
