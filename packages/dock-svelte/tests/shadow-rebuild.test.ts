// #782 PR7: when a change is not made on the shadow tree S - an assignment from outside that adds
// or moves a pane (`ThreePaneDock`'s `syncPanels`, `DockHost.replaceLayout`), a layout put back as
// it was (a cancelled gesture) - S is made again from the places S itself says (`deflateShadow` ->
// `inflateShadow`), not from the slots the panes were floated with. So what S knew of the panes
// out of the tree (the moves made on it, the shares) is kept, and nothing rewrites a `homeSlot`:
// it only names the place.
import { describe, expect, it } from 'vitest';
import { dockPanelAtEdge } from '../src/core/tree';
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
import { counterMakeId } from './fixtures/dock-properties';
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
