// #782 PR2: the shadow tree's pure functions (`src/core/shadow.ts`) - cases one by one, then
// properties over generated trees and steps (fast-check, ADR-0033; the generators of
// `fixtures/dock-properties.ts`). Nothing of `DockState` is used: the module is not wired in yet.
//
// The properties say two things. Where the visible tree has an answer of its own, the projection
// of S after a step is that answer (`tree.ts` on the projection before the step). And what the
// slots could not give: every order of coming back ends in the same S.
//
// Fixed seed and number of cases, as in `place-properties.test.ts` (`DOCK_PROPERTY_SEED` /
// `DOCK_PROPERTY_RUNS` to look further).
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { validateDockLayout } from '../src/core/validate';
import {
	dockAtShadowEdge,
	dockIntoShadow,
	findShadowPanel,
	markAway,
	markPresent,
	projectShadow,
	removeFromShadow,
	resizeShadowSplit,
	shadowOf,
	shadowPanelIds,
	writeShadowSizes,
	type ShadowNode,
	type ShadowPanelNode,
	type ShadowTabGroupNode
} from '../src/core/shadow';
import {
	collectPanelIds,
	dockPanelAtEdge,
	dockPanelIntoTree,
	findNode,
	removePanel,
	resizeSplit
} from '../src/core/tree';
import type { DockNode, DockPanelNode, DockSplitNode, DropRegion } from '../src/types';
import {
	EDGES,
	EPS,
	badSizes,
	buildTree,
	counterMakeId,
	opRecipe,
	permutations,
	treeDiff,
	treeRecipe,
	treeText,
	type OpRecipe
} from './fixtures/dock-properties';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const SEED = Number(env?.DOCK_PROPERTY_SEED ?? 782);
const RUNS = Number(env?.DOCK_PROPERTY_RUNS ?? 0);
if (RUNS) vi.setConfig({ testTimeout: 600_000 });
const params = (numRuns: number): fc.Parameters<unknown> => ({
	seed: SEED,
	numRuns: RUNS || numRuns
});

// ----- building and reading ------------------------------------------------------------------

const p = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });
const gone = (id: string): ShadowPanelNode => ({ ...p(id), away: true });
const split =
	(direction: 'row' | 'column') =>
	(id: string, children: ShadowNode[], sizes?: number[]): ShadowNode => ({
		type: 'split',
		id,
		direction,
		children,
		sizes: sizes ?? children.map(() => 1 / children.length)
	});
const row = split('row');
const column = split('column');
const tabs = (id: string, children: ShadowPanelNode[], activeIndex = 0): ShadowTabGroupNode => ({
	type: 'tabs',
	id,
	children,
	activeIndex
});

/** S as text: `row[a, b†, tabs[c, d]]`, a tombstone with `†`. */
const text = (node: ShadowNode | DockNode | null): string =>
	node === null
		? 'null'
		: node.type === 'panel'
			? node.id + ((node as ShadowPanelNode).away ? '†' : '')
			: `${node.type === 'tabs' ? 'tabs' : node.direction}[${node.children.map(text).join(', ')}]`;

const sizesOfSplit = (s: ShadowNode | DockNode | null, id: string): number[] =>
	(findNode(s as DockNode, id) as DockSplitNode).sizes;

const close = (a: number[], b: number[]): void => {
	expect(a).toHaveLength(b.length);
	a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
};

const away = (s: ShadowNode | null, ...ids: string[]): ShadowNode | null => ids.reduce(markAway, s);
const present = (s: ShadowNode | null, ...ids: string[]): ShadowNode | null =>
	ids.reduce((acc: ShadowNode | null, id) => markPresent(acc, id), s);

// ----- projection ----------------------------------------------------------------------------

describe('projectShadow', () => {
	it('an S without tombstones projects to itself (the same object)', () => {
		const tree = row('s1', [p('a'), column('s2', [p('b'), tabs('t1', [p('c'), p('d')], 1)])]);
		expect(projectShadow(shadowOf(tree as DockNode))).toBe(tree);
		expect(projectShadow(null)).toBeNull();
		// A tab group of one tab too (a saved layout may hold one): it is not shown as the pane.
		const lone = row('s1', [tabs('t1', [p('a')]), p('b')]);
		expect(projectShadow(lone)).toBe(lone);
		expect(text(projectShadow(markAway(lone, 'b')))).toBe('tabs[a]');
	});

	it('leaves the tombstones out and shares the sizes among the shown children', () => {
		const s = row('s1', [gone('a'), p('b'), p('c')], [0.2, 0.3, 0.5]);
		const shown = projectShadow(s);
		expect(text(shown)).toBe('row[b, c]');
		expect(shown!.id).toBe('s1');
		close(sizesOfSplit(shown, 's1'), [0.375, 0.625]);
	});

	it('a split with one shown child shows as that child, not flattened into the split around it', () => {
		const s = row('s1', [p('a'), column('s2', [row('s3', [p('b'), p('c')]), gone('d')])]);
		expect(text(projectShadow(s))).toBe('row[a, row[b, c]]');
		expect(projectShadow(row('s1', [gone('a'), column('s2', [p('b'), p('c')])]))!.id).toBe('s2');
	});

	it('nothing shown = null, at any depth', () => {
		expect(projectShadow(gone('a'))).toBeNull();
		const s = row('s1', [column('s2', [gone('a'), tabs('t1', [gone('b'), gone('c')])]), p('d')]);
		expect(text(projectShadow(s))).toBe('d');
		expect(projectShadow(away(s, 'd'))).toBeNull();
	});

	it('a tab group shows its shown tabs, the active one counted among them', () => {
		const s = tabs('t1', [gone('a'), p('b'), gone('c'), p('d')], 3);
		const shown = projectShadow(s);
		expect(shown).toEqual({ type: 'tabs', id: 't1', children: [p('b'), p('d')], activeIndex: 1 });
		expect(text(projectShadow(tabs('t1', [gone('a'), p('b')], 1)))).toBe('b');
	});

	it('collapsed: a collapsed group with one shown tab shows as a collapsed pane; the root is expanded', () => {
		const group: ShadowNode = { ...tabs('t1', [p('a'), gone('b')]), collapsed: true };
		expect(projectShadow(row('s1', [group, p('c')]))).toEqual(
			row('s1', [{ ...p('a'), collapsed: true }, p('c')])
		);
		const lone = row('s1', [{ ...p('a'), collapsed: true }, gone('b')]);
		expect(projectShadow(lone)).toEqual(p('a'));
	});

	// #782 PR8d: S holds the flag of a region that is the only child of its split that shows.
	it('collapsed: the only shown child of a split keeps its flag beside the siblings it shows with', () => {
		const flagged = { ...p('a'), collapsed: true };
		const s = row('s1', [column('s2', [flagged, gone('b')]), p('c')]);
		expect(projectShadow(s)).toEqual(row('s1', [flagged, p('c')]));
		// The pane that comes back finds it collapsed beside it.
		expect(projectShadow(markPresent(s, 'b'))).toEqual(
			row('s1', [column('s2', [flagged, p('b')]), p('c')])
		);
		// A tombstone taken out for good does not expand it either.
		expect(projectShadow(removeFromShadow(s, 'b'))).toEqual(row('s1', [flagged, p('c')]));
		// Its last sibling showing gone: nothing is left to show beside the band.
		expect(projectShadow(markAway(s, 'c'))).toEqual(p('a'));
		expect(text(projectShadow(markPresent(markAway(s, 'c'), 'c')))).toBe('row[a, c]');
	});

	it('collapsed: a region left as the only shown child of its split is expanded, as when the split folds', () => {
		const flagged = { ...p('a'), collapsed: true };
		const s = row('s1', [column('s2', [flagged, p('b'), gone('x')]), p('c')]);
		const left = markAway(s, 'b');
		expect(projectShadow(left)).toEqual(row('s1', [p('a'), p('c')]));
		expect(projectShadow(markPresent(left, 'b'))).toEqual(
			row('s1', [column('s2', [p('a'), p('b')]), p('c')])
		);
		expect(projectShadow(removeFromShadow(s, 'b'))).toEqual(row('s1', [p('a'), p('c')]));
		// Through a split that shows one child itself, and a tab group.
		const group: ShadowNode = { ...tabs('t1', [p('a'), p('e')]), collapsed: true };
		const deep = row('s1', [column('s2', [column('s3', [group, gone('x')]), p('b')]), p('c')]);
		expect(JSON.stringify(projectShadow(markAway(deep, 'b')))).not.toContain('collapsed');
	});
});

// ----- the mark ------------------------------------------------------------------------------

describe('markAway / markPresent', () => {
	const tree = (): ShadowNode =>
		column('s1', [row('s2', [p('a'), p('b'), p('c')], [0.2, 0.3, 0.5]), p('d'), p('e')]);

	it('only the mark changes: no split folds, no sizes move', () => {
		const s = away(tree(), 'a', 'b');
		expect(text(s)).toBe('column[row[a†, b†, c], d, e]');
		expect(sizesOfSplit(s, 's2')).toEqual([0.2, 0.3, 0.5]);
		expect(text(projectShadow(s))).toBe('column[c, d, e]');
		expect(shadowPanelIds(s, 'away')).toEqual(['a', 'b']);
		expect(shadowPanelIds(s, 'shown')).toEqual(['c', 'd', 'e']);
		expect(shadowPanelIds(s)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(findShadowPanel(s, 'a')?.away).toBe(true);
		expect(findShadowPanel(s, 's2')).toBeNull();
	});

	it('coming back gives the first S again, in any order', () => {
		const s = away(tree(), 'a', 'b', 'e');
		for (const order of permutations(['a', 'b', 'e'])) {
			expect(present(s, ...order)).toEqual(tree());
		}
	});

	it('no-ops return the same S', () => {
		const s = away(tree(), 'a');
		expect(markAway(s, 'a')).toBe(s);
		expect(markAway(s, 'nope')).toBe(s);
		expect(markAway(s, 's2')).toBe(s);
		expect(markPresent(s, 'b')).toBe(s);
		expect(markPresent(s, 'nope')).toBe(s);
		expect(markAway(null, 'a')).toBeNull();
		expect(markPresent(null, 'a')).toBeNull();
	});

	it('a tab group: the active tab that leaves hands over to the next shown one; the tab that comes back is active', () => {
		const s = tabs('t1', [p('a'), p('b'), p('c')], 1);
		const noB = markAway(s, 'b') as Extract<ShadowNode, { type: 'tabs' }>;
		expect(noB.activeIndex).toBe(2);
		expect((markAway(noB, 'c') as typeof noB).activeIndex).toBe(0);
		expect((markAway(s, 'a') as typeof noB).activeIndex).toBe(1);
		expect((markPresent(away(s, 'a', 'b'), 'a') as typeof noB).activeIndex).toBe(0);
	});

	it('coming back takes the new title / icon', () => {
		const s = markAway(row('s1', [{ ...p('a'), icon: 'x' }, p('b')]), 'a');
		expect(findShadowPanel(markPresent(s, 'a', { title: 'New' }), 'a')).toEqual({
			type: 'panel',
			id: 'a',
			title: 'New'
		});
		expect(findShadowPanel(markPresent(s, 'a'), 'a')).toEqual({ ...p('a'), icon: 'x' });
	});

	it('collapsed: a tombstone is not collapsed, and a flag the projection drops does not come back', () => {
		const s = row('s1', [{ ...p('a'), collapsed: true }, p('b'), p('c')]);
		expect(findShadowPanel(markAway(s, 'a'), 'a')).toEqual(gone('a'));
		// b and c leave: a is the only pane shown, so it is expanded - and stays so when they return.
		const back = present(away(s, 'b', 'c'), 'b', 'c');
		expect(back).toEqual(row('s1', [p('a'), p('b'), p('c')]));
		// One sibling still open: the flag stays.
		expect(findShadowPanel(markAway(s, 'b'), 'a')?.collapsed).toBe(true);
	});
});

// ----- taking out ----------------------------------------------------------------------------

describe('removeFromShadow', () => {
	it('shares the place among the siblings of S in proportion (#743), tombstones included', () => {
		const s = row('s1', [gone('a'), p('b'), p('c')], [0.2, 0.3, 0.5]);
		const next = removeFromShadow(s, 'c');
		expect(text(next)).toBe('row[a†, b]');
		close(sizesOfSplit(next, 's1'), [0.4, 0.6]);
	});

	it('a split that still holds a tombstone does not fold; one left with a single child does', () => {
		const s = row('s1', [p('a'), column('s2', [p('b'), p('c'), gone('d')])], [0.3, 0.7]);
		const noC = removeFromShadow(s, 'c');
		expect(text(noC)).toBe('row[a, column[b, d†]]');
		expect(text(projectShadow(noC))).toBe('row[a, b]');
		const noD = removeFromShadow(noC, 'd');
		expect(text(noD)).toBe('row[a, b]');
		expect(sizesOfSplit(noD, 's1')).toEqual([0.3, 0.7]);
		// The child left may be a tombstone: it moves up as one.
		expect(text(removeFromShadow(noC, 'b'))).toBe('row[a, d†]');
	});

	it('takes a tombstone out as well (a pane whose definition is gone)', () => {
		const s = row('s1', [gone('a'), p('b'), p('c')], [0.5, 0.25, 0.25]);
		const next = removeFromShadow(s, 'a');
		expect(text(next)).toBe('row[b, c]');
		close(sizesOfSplit(next, 's1'), [0.5, 0.5]);
	});

	it('a tab group: folds to its last tab, keeps the active tab on a shown one', () => {
		expect(
			text(removeFromShadow(row('s1', [tabs('t1', [gone('a'), p('b')], 1), p('c')]), 'b'))
		).toBe('row[a†, c]');
		const group = tabs('t1', [p('a'), gone('b'), p('c'), p('d')], 2);
		expect(removeFromShadow(group, 'c')).toEqual(tabs('t1', [p('a'), gone('b'), p('d')], 2));
		expect(removeFromShadow(group, 'a')).toEqual(tabs('t1', [gone('b'), p('c'), p('d')], 1));
	});

	it('the last pane = null; an unknown pane = the same S', () => {
		const s = row('s1', [p('a'), p('b')]);
		expect(removeFromShadow(removeFromShadow(s, 'a'), 'b')).toBeNull();
		expect(removeFromShadow(s, 'nope')).toBe(s);
		expect(removeFromShadow(null, 'a')).toBeNull();
	});
});

// ----- putting in / moving -------------------------------------------------------------------

describe('dockIntoShadow', () => {
	it('#780: a side acts on the outermost node whose projection is the target, found before the removal', () => {
		const s = away(
			column('s1', [row('s2', [p('a'), p('b'), p('c')], [0.2, 0.3, 0.5]), p('d'), p('e')]),
			'a',
			'b',
			'e'
		);
		const right = dockIntoShadow(s, p('c'), 'd', 'right', counterMakeId());
		expect(text(right)).toBe('column[row[a†, b†], row[d, c], e†]');
		close(sizesOfSplit(right, 's2'), [0.4, 0.6]);
		for (const order of permutations(['a', 'b', 'e'])) {
			expect(text(projectShadow(present(right, ...order)))).toBe('column[row[a, b], row[d, c], e]');
		}
		const bottom = dockIntoShadow(s, p('c'), 'd', 'bottom', counterMakeId());
		expect(text(bottom)).toBe('column[row[a†, b†], d, c, e†]');
		// d and c share what d had; the row of a and b and e keep theirs.
		close(sizesOfSplit(bottom, 's1'), [1 / 3, 1 / 6, 1 / 6, 1 / 3]);
	});

	it('a side, target the only pane shown of its split: the pane goes beside that split', () => {
		// `column[row[a, b], row[c†, d], e]`: d shows alone in its row.
		const s = column('s1', [row('s2', [p('a'), p('b')]), row('s3', [gone('c'), p('d')]), p('e')]);
		expect(text(dockIntoShadow(s, p('x'), 'd', 'bottom', counterMakeId()))).toBe(
			'column[row[a, b], row[c†, d], x, e]'
		);
		// Also in the row's own direction: the pane is at the left of all the row was, c's place
		// included (a row in a row, as `dockPanelAtEdge` makes one), not between c and d.
		const left = dockIntoShadow(s, p('x'), 'd', 'left', counterMakeId());
		expect(text(left)).toBe('column[row[a, b], row[x, row[c†, d]], e]');
		expect(text(projectShadow(left))).toBe('column[row[a, b], row[x, d], e]');
	});

	it('known failure 1 of #782: a tab made while panes are away does not depend on the order back', () => {
		const s = away(row('s1', [p('a'), p('b'), p('c'), p('d')]), 'a', 'c');
		const next = dockIntoShadow(s, p('b'), 'd', 'center', counterMakeId());
		expect(text(next)).toBe('row[a†, c†, tabs[d, b]]');
		expect(text(projectShadow(next))).toBe('tabs[d, b]');
		for (const order of permutations(['a', 'c'])) {
			expect(text(projectShadow(present(next, ...order)))).toBe('row[a, c, tabs[d, b]]');
		}
	});

	it('center: into the tab group of S, even when one tab of it shows; the pane is active', () => {
		const s = row('s1', [p('a'), tabs('t1', [p('b'), gone('c')])]);
		const next = dockIntoShadow(s, p('a'), 'b', 'center', counterMakeId());
		expect(next).toEqual(tabs('t1', [p('b'), gone('c'), p('a')], 2));
		const made = dockIntoShadow(row('s1', [p('a'), p('b')]), p('x'), 'b', 'center', () => 'new');
		expect(made).toEqual(row('s1', [p('a'), tabs('new', [p('b'), p('x')], 1)]));
	});

	it("takes the pane's own tombstone out: a floated pane docked elsewhere has one place", () => {
		const s = away(row('s1', [p('a'), column('s2', [p('b'), p('c')])]), 'b');
		const next = dockIntoShadow(s, p('b'), 'a', 'left', counterMakeId());
		expect(text(next)).toBe('row[b, a, c]');
	});

	it('a target that does not show falls back to the first shown leaf; nothing shown wraps S', () => {
		const s = row('s1', [gone('a'), p('b'), p('c')]);
		expect(text(dockIntoShadow(s, p('x'), 'a', 'top', counterMakeId()))).toBe(
			'row[a†, column[x, b], c]'
		);
		expect(text(dockIntoShadow(s, p('c'), 'c', 'bottom', counterMakeId()))).toBe(
			'column[row[a†, b], c]'
		);
		const none = away(s, 'b', 'c');
		expect(text(dockIntoShadow(none, p('x'), 'b', 'left', counterMakeId()))).toBe(
			'row[x, row[a†, b†, c†]]'
		);
		expect(text(dockIntoShadow(none, p('x'), 'b', 'center', counterMakeId()))).toBe(
			'row[row[a†, b†, c†], x]'
		);
		expect(dockIntoShadow(null, { ...p('x'), collapsed: true }, 'b', 'left')).toEqual(p('x'));
	});

	it('a drop on the side of the own two-tab group splits it from the other tab', () => {
		const s = row('s1', [p('a'), tabs('t1', [p('b'), p('c')])]);
		expect(text(dockIntoShadow(s, p('c'), 't1', 'bottom', counterMakeId()))).toBe(
			'row[a, column[b, c]]'
		);
	});

	it("the moved pane's own id is a stale target, also when it is a tab of a group (re-review of PR #826)", () => {
		// Not the group of a: the first shown leaf, as `tree.ts` (a is gone when the target is looked up).
		for (const group of [
			tabs('t1', [p('a'), p('b'), p('c')]),
			tabs('t1', [p('a'), p('b')]),
			tabs('t1', [p('a'), p('b'), gone('c')])
		]) {
			const s = row('s1', [p('x'), group]);
			for (const region of ['right', 'center'] as const) {
				const next = dockIntoShadow(s, p('a'), 'a', region, counterMakeId());
				const seen = projectShadow(s);
				const mirror = dockPanelIntoTree(
					removePanel(seen, 'a'),
					p('a'),
					'a',
					region,
					counterMakeId()
				);
				expect(treeDiff(projectShadow(next), mirror)).toBeNull();
			}
		}
		const three = row('s1', [p('x'), tabs('t1', [p('a'), p('b'), p('c')])]);
		expect(text(dockIntoShadow(three, p('a'), 'a', 'right', counterMakeId()))).toBe(
			'row[x, a, tabs[b, c]]'
		);
	});

	it('a new order inside one split is a move in S: the tombstones keep their share (review of PR #826, 1)', () => {
		const s = row('s1', [gone('a'), p('b'), p('c')], [0.4, 0.2, 0.4]);
		const next = dockIntoShadow(s, p('b'), 'c', 'right', counterMakeId());
		expect(text(next)).toBe('row[a†, c, b]');
		// Not [.5, .25, .25]: b never left the split, so a's 40% is not shared out and back.
		close(sizesOfSplit(next, 's1'), [0.4, 0.3, 0.3]);
		close(sizesOfSplit(projectShadow(markPresent(next, 'a')), 's1'), [0.4, 0.3, 0.3]);
		// The pane's own tombstone put back into the same split: the other tombstone keeps its share.
		const two = row('s1', [gone('a'), gone('b'), p('c'), p('d')], [0.4, 0.2, 0.3, 0.1]);
		const back = dockIntoShadow(two, p('b'), 'd', 'right', counterMakeId());
		expect(text(back)).toBe('row[a†, c, d, b]');
		close(sizesOfSplit(back, 's1'), [0.4, 0.2, 0.2, 0.2]);
		// Leaving the split for another container is still #743: the share goes to the siblings.
		const out = dockIntoShadow(s, p('b'), 'c', 'bottom', counterMakeId());
		expect(text(out)).toBe('row[a†, column[c, b]]');
		close(sizesOfSplit(out, 's1'), [0.5, 0.5]);
	});

	it('a split as the target is resolved again after the removal when it is still there (review of PR #826, 2)', () => {
		// The first leaf of s2 is the moved pane itself: `tree.ts` takes the first leaf of what is left.
		const s = row('s1', [p('x'), column('s2', [p('a'), p('b'), p('c')])]);
		const next = dockIntoShadow(s, p('a'), 's2', 'right', counterMakeId());
		expect(text(next)).toBe('row[x, column[row[b, a], c]]');
		const mirror = dockPanelIntoTree(removePanel(s, 'a'), p('a'), 's2', 'right', counterMakeId());
		expect(next).toEqual(mirror);
		// A split that the removal folds is a stale id: the first shown leaf of the tree (`tree.ts`).
		const folded = row('s1', [p('x'), column('s2', [p('b'), p('a')])]);
		const stale = dockIntoShadow(folded, p('a'), 's2', 'right', counterMakeId());
		expect(stale).toEqual(
			dockPanelIntoTree(removePanel(folded, 'a'), p('a'), 's2', 'right', counterMakeId())
		);
		expect(text(stale)).toBe('row[x, a, b]');
		// With a tombstone in it the split stays in S, but no longer shows as a split: stale as well.
		const held = row('s1', [p('x'), column('s2', [p('a'), p('b'), gone('c')])]);
		expect(text(dockIntoShadow(held, p('a'), 's2', 'center', counterMakeId()))).toBe(
			'row[tabs[x, a], column[b, c†]]'
		);
	});
});

describe('dockAtShadowEdge', () => {
	it('wraps all of S, tombstones included, and takes EDGE_DOCK_RATIO', () => {
		const s = away(row('s1', [p('a'), p('b'), p('c')]), 'a');
		const next = dockAtShadowEdge(s, p('b'), 'left', () => 'edge');
		expect(text(next)).toBe('row[b, row[a†, c]]');
		expect(sizesOfSplit(next, 'edge')).toEqual([0.25, 0.75]);
		expect(
			sizesOfSplit(
				dockAtShadowEdge(s, p('b'), 'bottom', () => 'edge'),
				'edge'
			)
		).toEqual([0.75, 0.25]);
		expect(dockAtShadowEdge(null, p('x'), 'left')).toEqual(p('x'));
		expect(dockAtShadowEdge(p('x'), p('x'), 'left')).toEqual(p('x'));
	});

	it('known failure 2 of #782: a hidden tab stays at its group when its partner goes to the edge', () => {
		const s = away(row('s1', [p('a'), tabs('t1', [p('b'), p('c')]), p('d')]), 'b', 'd');
		const next = dockAtShadowEdge(s, p('c'), 'left', counterMakeId());
		expect(text(next)).toBe('row[c, row[a, b†, d†]]');
		for (const order of permutations(['b', 'd'])) {
			expect(text(projectShadow(present(next, ...order)))).toBe('row[c, row[a, b, d]]');
		}
	});

	it('known failure 3 of #782: the pane moved to the edge, hidden later, comes back in any order', () => {
		let s = away(row('s1', [p('a'), p('b'), p('c')]), 'a');
		s = markAway(dockAtShadowEdge(s, p('b'), 'left', counterMakeId()), 'b');
		for (const order of permutations(['a', 'b'])) {
			expect(text(projectShadow(present(s, ...order)))).toBe('row[b, row[a, c]]');
		}
	});

	it('known failure 7 of #782: every pane comes back into the dock', () => {
		let s = away(row('s1', [p('a'), p('b'), p('c')]), 'a');
		s = markAway(dockAtShadowEdge(s, p('b'), 'left', counterMakeId()), 'c');
		expect(text(projectShadow(s))).toBe('b');
		expect(text(projectShadow(present(s, 'a', 'c')))).toBe('row[b, row[a, c]]');

		let t = away(row('s1', [p('a'), p('b'), p('c'), p('d'), p('e')]), 'a', 'b', 'c');
		const makeId = counterMakeId();
		t = dockAtShadowEdge(t, p('d'), 'right', makeId);
		t = dockAtShadowEdge(t, p('e'), 'left', makeId);
		for (const order of permutations(['a', 'b', 'c'])) {
			expect(text(projectShadow(present(t, ...order)))).toBe('row[e, row[row[a, b, c], d]]');
		}
	});
});

// ----- sizes ---------------------------------------------------------------------------------

describe('writeShadowSizes / resizeShadowSplit', () => {
	const s = (): ShadowNode => row('s1', [p('a'), gone('b'), p('c'), p('d')], [0.1, 0.2, 0.3, 0.4]);

	it('the shown children share what they have in the new proportion; the tombstone keeps its share', () => {
		const next = writeShadowSizes(s(), 's1', [0.5, 0.25, 0.25]);
		close(sizesOfSplit(next, 's1'), [0.4, 0.2, 0.2, 0.2]);
		close(sizesOfSplit(projectShadow(next), 's1'), [0.5, 0.25, 0.25]);
		// The pane that comes back has the share it left with.
		close(sizesOfSplit(projectShadow(markPresent(next, 'b')), 's1'), [0.4, 0.2, 0.2, 0.2]);
	});

	it('with every child shown the sizes are written as they are', () => {
		const all = row('s1', [p('a'), p('b')], [0.5, 0.5]);
		expect(sizesOfSplit(writeShadowSizes(all, 's1', [0.3, 0.7]), 's1')).toEqual([0.3, 0.7]);
	});

	it('what is written adds up to 1; a negative or not finite share is not written', () => {
		const all = row('s1', [p('a'), p('b'), p('c')]);
		close(sizesOfSplit(writeShadowSizes(all, 's1', [0.2, 0.3, 2]), 's1'), [0.08, 0.12, 0.8]);
		expect(writeShadowSizes(all, 's1', [0.5, -0.1, 0.6])).toBe(all);
		expect(writeShadowSizes(all, 's1', [0.5, Number.NaN, 0.5])).toBe(all);
		expect(writeShadowSizes(all, 's1', [1, Number.POSITIVE_INFINITY, 1])).toBe(all);
	});

	it('no-ops: an unknown split, a wrong number of sizes, sizes adding up to 0, nothing changed', () => {
		const tree = s();
		expect(writeShadowSizes(tree, 'nope', [0.5, 0.5])).toBe(tree);
		expect(writeShadowSizes(tree, 'a', [1])).toBe(tree);
		expect(writeShadowSizes(tree, 's1', [0.1, 0.2, 0.3, 0.4])).toBe(tree);
		expect(writeShadowSizes(tree, 's1', [0, 0, 0])).toBe(tree);
		expect(writeShadowSizes(null, 's1', [1])).toBeNull();
	});

	it('resizeShadowSplit: the divider counts the shown children, as the user sees them', () => {
		// Shown: a .125, c .375, d .5 - the first divider is between a and c.
		const next = resizeShadowSplit(s(), 's1', 0, 0.125);
		close(sizesOfSplit(projectShadow(next), 's1'), [0.25, 0.25, 0.5]);
		close(sizesOfSplit(next, 's1'), [0.2, 0.2, 0.2, 0.4]);
		const tree = s();
		expect(resizeShadowSplit(tree, 's1', 2, 0.1)).toBe(tree);
		expect(resizeShadowSplit(tree, 'nope', 0, 0.1)).toBe(tree);
	});

	it('a split that shows as its only child cannot be resized (it has no divider)', () => {
		const tree = row('s1', [gone('a'), p('b')]);
		expect(resizeShadowSplit(tree, 's1', 0, 0.1)).toBe(tree);
	});
});

// The saved format allows a share of 0 (`validateDockLayout`). The promise for it (review of
// PR #826, 3) is in the doc of `shadow.ts`: S keeps a 0 as it is, and only a write to a split
// whose shown children have 0 together gives them a share - the even one.
describe('shares of 0 (a layout the saved format allows)', () => {
	const zero = (): DockSplitNode => row('s1', [p('a'), p('b'), p('c')], [0, 0, 1]) as DockSplitNode;

	it('the fixture passes the validation of a saved layout as it is', () => {
		const result = validateDockLayout({ version: 4, docked: zero(), floating: [] });
		expect(result.ok).toBe(true);
		expect(sizesOfSplit(result.ok ? result.layout.docked : null, 's1')).toEqual([0, 0, 1]);
	});

	it('hiding and coming back keep the 0: the mark alone never writes a share', () => {
		const hidden = markAway(zero(), 'c');
		expect(sizesOfSplit(hidden, 's1')).toEqual([0, 0, 1]);
		// Shown as `tree.ts#removePanel` shows it: evenly.
		expect(projectShadow(hidden)).toEqual(removePanel(zero(), 'c'));
		close(sizesOfSplit(projectShadow(hidden), 's1'), [0.5, 0.5]);
		expect(markPresent(hidden, 'c')).toEqual(zero());
	});

	it('a resize is not lost: the shown children take the even part of the split, the tombstone the rest', () => {
		const hidden = markAway(zero(), 'c');
		const next = resizeShadowSplit(hidden, 's1', 0, 0.1);
		const mirror = resizeSplit(projectShadow(hidden), 's1', 0, 0.1);
		close(sizesOfSplit(mirror, 's1'), [0.6, 0.4]);
		close(sizesOfSplit(projectShadow(next), 's1'), [0.6, 0.4]);
		// a and b had nothing to share, so they get 2 of 3 parts; c keeps the third.
		close(sizesOfSplit(next, 's1'), [0.4, 4 / 15, 1 / 3]);
		// From here on c keeps its share, as in any other split.
		const again = resizeShadowSplit(next, 's1', 0, -0.2);
		close(sizesOfSplit(again, 's1'), [4 / 15, 0.4, 1 / 3]);
		// Writing what shows already changes nothing.
		expect(writeShadowSizes(hidden, 's1', [0.5, 0.5])).toBe(hidden);
	});

	it('a drop beside them: the same even part, and tombstones keep their proportion', () => {
		const hidden = markAway(zero(), 'c');
		const next = dockIntoShadow(hidden, p('d'), 'b', 'right', counterMakeId());
		expect(text(next)).toBe('row[a, b, d, c†]');
		close(sizesOfSplit(next, 's1'), [0.25, 0.25, 0.25, 0.25]);
		expect(
			treeDiff(
				projectShadow(next),
				dockPanelIntoTree(projectShadow(hidden), p('d'), 'b', 'right', counterMakeId())
			)
		).toBeNull();
		// Two tombstones of 0.75 and 0.25 stay 3 : 1 in what is left for them.
		const two = row('s1', [p('a'), p('b'), gone('c'), gone('e')], [0, 0, 0.75, 0.25]);
		const more = dockIntoShadow(two, p('d'), 'b', 'right', counterMakeId());
		close(sizesOfSplit(more, 's1'), [0.2, 0.2, 0.2, 0.3, 0.1]);
		// A 0 beside a share: nothing special, the shown children share what they have.
		const part = row('s1', [p('a'), p('b'), gone('c')], [0, 0.5, 0.5]);
		close(sizesOfSplit(resizeShadowSplit(part, 's1', 0, 0.2), 's1'), [0.1, 0.4, 0.5]);
		close(sizesOfSplit(dockIntoShadow(part, p('d'), 'b', 'right', counterMakeId()), 's1'), [
			1 / 6,
			1 / 6,
			1 / 6,
			0.5
		]);
	});
});

// ----- properties ----------------------------------------------------------------------------

type StepKind = 'away' | 'back' | 'remove' | 'move' | 'tab' | 'edge' | 'resize';
const ALL: StepKind[] = ['away', 'back', 'remove', 'move', 'tab', 'edge', 'resize'];
const SIDES: DropRegion[] = ['left', 'right', 'top', 'bottom'];

const splitsOf = (node: DockNode | null): DockSplitNode[] =>
	node?.type === 'split' ? [node, ...node.children.flatMap(splitsOf)] : [];

/** The ids of the splits and tab groups of a visible tree, depth first. */
const containerIds = (node: DockNode | null): string[] =>
	node === null || node.type === 'panel'
		? []
		: [node.id, ...(node.type === 'split' ? node.children.flatMap(containerIds) : [])];

interface Run {
	s: ShadowNode | null;
	steps: string[];
}

/**
 * Run `ops` on S. With `mirror`, every step that the visible tree can answer by itself is also
 * done by `tree.ts` on the projection before the step, and the two must agree.
 */
function run(tree: DockNode, ops: OpRecipe[], kinds: StepKind[], mirror: boolean): Run {
	let s = shadowOf(tree);
	const steps: string[] = [];
	// One counter for both: `tree.ts` starts every step from the id S is at.
	let made = 0;
	let mirrored = 0;
	const makeId = (): string => `gen-${made++}`;
	const mirrorId = (): string => `gen-${mirrored++}`;
	const fail = (why: string): never => {
		throw new Error(
			`${why}\n  tree:  ${treeText(tree)}\n  steps: ${steps.join(' ')}\n  S:     ${text(s)}`
		);
	};
	for (const op of ops) {
		const kind = kinds[op.kind % kinds.length];
		mirrored = made;
		const before = projectShadow(s);
		const shown = shadowPanelIds(s, 'shown');
		const gone = shadowPanelIds(s, 'away');
		const id = shown[op.i % Math.max(shown.length, 1)];
		const node = id === undefined ? undefined : (findNode(before, id) as DockPanelNode);
		let expected: DockNode | null | undefined;
		let exact = true;
		if (kind === 'back') {
			if (gone.length === 0) continue;
			const back = gone[op.i % gone.length];
			steps.push(`+${back}`);
			s = markPresent(s, back);
		} else if (id === undefined || node === undefined) {
			continue;
		} else if (kind === 'away') {
			steps.push(`-${id}`);
			s = markAway(s, id);
			expected = removePanel(before, id);
		} else if (kind === 'remove') {
			steps.push(`x${id}`);
			s = removeFromShadow(s, id);
			expected = removePanel(before, id);
		} else if (kind === 'edge') {
			const edge = EDGES[op.r];
			steps.push(`${id}>>${edge}`);
			s = dockAtShadowEdge(s, node, edge, makeId);
			expected = dockPanelAtEdge(removePanel(before, id), node, edge, mirrorId);
		} else if (kind === 'move' || kind === 'tab') {
			const others = shown.filter((x) => x !== id);
			if (others.length === 0) continue;
			// A drop names a pane, or a split / tab group that shows (`dockExisting` takes any id).
			// The pane's own id comes last: a stale target once the pane is taken out.
			const targets = [...others, ...containerIds(before), id];
			const target = targets[op.j % targets.length];
			const region = kind === 'tab' ? 'center' : SIDES[op.r];
			steps.push(`${id}>${target}:${region}`);
			const hadTombstone = gone.length > 0;
			s = dockIntoShadow(s, node, target, region, makeId);
			// With tombstones a side drop may sit at a different depth than the visible tree would
			// put it (#780), and split ids differ: only the tree without them has to agree.
			// The pane's own two-tab group as the target is the one case `shadow.ts` answers by itself
			// (the other tab; `tree.ts` no longer finds the group).
			const rest = removePanel(before, id);
			const ownGroup = findNode(before, target)?.type === 'tabs' && findNode(rest, target) === null;
			if ((!hadTombstone || kind === 'tab') && !ownGroup) {
				expected = dockPanelIntoTree(rest, node, target, region, mirrorId);
				exact = !hadTombstone;
			}
		} else {
			const splits = splitsOf(before);
			if (splits.length === 0) continue;
			const at = splits[op.i % splits.length];
			const divider = op.j % (at.children.length - 1);
			const delta = (op.r - 1.5) * 0.08;
			steps.push(`${at.id}|${divider}:${delta}`);
			s = resizeShadowSplit(s, at.id, divider, delta);
			expected = resizeSplit(before, at.id, divider, delta);
		}
		const bad = invalid(s);
		if (bad.length > 0) fail(`S is not valid: ${bad.join('; ')}`);
		if (!mirror || expected === undefined) continue;
		const after = projectShadow(s);
		const diff = treeDiff(after, expected);
		if (diff !== null) fail(`the projection is not what tree.ts gives: ${diff}`);
		if (exact && JSON.stringify(activeOf(after)) !== JSON.stringify(activeOf(expected))) {
			fail(`ids / active tabs differ: ${JSON.stringify(after)} != ${JSON.stringify(expected)}`);
		}
	}
	return { s, steps };
}

/** Ids and active tabs, depth first (`treeDiff` compares shapes by pane id and sizes only). */
const activeOf = (node: DockNode | null): unknown[] =>
	node === null || node.type === 'panel'
		? []
		: node.type === 'tabs'
			? [node.id, node.activeIndex]
			: [node.id, ...node.children.flatMap(activeOf)];

/** What is wrong with S: its shape, its sizes, its marks - and its projection's sizes. */
function invalid(s: ShadowNode | null): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const walk = (node: ShadowNode, inTabs: boolean): void => {
		if (seen.has(node.id)) out.push(`id ${node.id} twice`);
		seen.add(node.id);
		if (node.type === 'panel') {
			if ('away' in node && node.away !== true) out.push(`${node.id}: away written but not true`);
			if (node.away === true && node.collapsed !== undefined)
				out.push(`${node.id}: collapsed tombstone`);
			if (inTabs && node.collapsed !== undefined) out.push(`${node.id}: collapsed tab`);
			return;
		}
		if (node.children.length < 2) out.push(`${node.id}: ${node.children.length} child(ren)`);
		if (node.type === 'tabs') {
			const active = node.children[node.activeIndex];
			if (active === undefined) out.push(`${node.id}: activeIndex ${node.activeIndex}`);
			else if (active.away === true && node.children.some((c) => c.away !== true)) {
				out.push(`${node.id}: the active tab is away`);
			}
			node.children.forEach((c) => walk(c, true));
			return;
		}
		const sum = node.sizes.reduce((a, b) => a + b, 0);
		if (
			node.sizes.length !== node.children.length ||
			node.sizes.some((x) => !(x > 0)) ||
			Math.abs(sum - 1) > 1e-9
		) {
			out.push(`${node.id}: sizes ${JSON.stringify(node.sizes)}`);
		}
		node.children.forEach((c) => walk(c, false));
	};
	if (s !== null) walk(s, false);
	return [...out, ...badSizes(projectShadow(s)).map((b) => `projection ${b}`)];
}

const sameS = (a: ShadowNode | null, b: ShadowNode | null): string | null => {
	if (text(a) !== text(b)) return `${text(a)} != ${text(b)}`;
	return treeDiff(a as DockNode | null, b as DockNode | null);
};

describe('properties of the shadow tree (#782 PR2)', () => {
	const ops = (max: number): fc.Arbitrary<OpRecipe[]> => fc.array(opRecipe, { maxLength: max });

	it('with no tombstone, S is the docked tree: every step agrees with tree.ts exactly', () => {
		fc.assert(
			fc.property(treeRecipe, ops(10), (recipe, list) => {
				const { s } = run(
					buildTree(recipe),
					list,
					['remove', 'move', 'tab', 'edge', 'resize'],
					true
				);
				expect(shadowPanelIds(s, 'away')).toEqual([]);
				expect(projectShadow(s)).toBe(s);
			}),
			params(400)
		);
	});

	it('with tombstones, the projection after a step is tree.ts on the projection before it', () => {
		// away = removePanel, remove = removePanel, edge = dockPanelAtEdge, resize = resizeSplit,
		// a tab = dockPanelIntoTree (center). Side drops are left to the next property and to #780.
		fc.assert(
			fc.property(treeRecipe, ops(14), (recipe, list) => {
				run(buildTree(recipe), list, ALL, true);
			}),
			params(600)
		);
	});

	it('hide in any order, come back in any order: the first tree again, shape and sizes', () => {
		fc.assert(
			fc.property(
				treeRecipe,
				fc.array(fc.nat({ max: 6 }), { maxLength: 4 }),
				fc.nat(),
				(recipe, picks, n) => {
					const tree = buildTree(recipe);
					const all = collectPanelIds(tree);
					const ids = [...new Set(picks.map((i) => all[i % all.length]))];
					const hidden = away(tree, ...ids);
					expect(shadowPanelIds(hidden, 'away').sort()).toEqual([...ids].sort());
					expect(treeDiff(hidden as DockNode, tree)).toBeNull();
					const orders = permutations(ids);
					const backOrders = permutations(ids);
					const other = away(tree, ...orders[n % orders.length]);
					for (const order of backOrders) {
						for (const from of [hidden, other]) {
							const back = present(from, ...order);
							const diff = sameS(back, tree);
							if (diff !== null)
								throw new Error(`${diff}\n  tree: ${treeText(tree)}\n  back: ${order.join(' ')}`);
						}
					}
				}
			),
			params(300)
		);
	});

	it('after any steps, every order of coming back ends in the same S', () => {
		fc.assert(
			fc.property(treeRecipe, ops(12), (recipe, list) => {
				const tree = buildTree(recipe);
				const { s, steps } = run(tree, list, ALL, false);
				const gone = shadowPanelIds(s, 'away');
				const orders = permutations(gone).slice(0, 24);
				const first = present(s, ...orders[0]);
				expect(shadowPanelIds(first, 'away')).toEqual([]);
				expect(collectPanelIds(projectShadow(first)).sort()).toEqual(shadowPanelIds(s).sort());
				for (const order of orders.slice(1)) {
					const diff = sameS(present(s, ...order), first);
					if (diff !== null) {
						throw new Error(
							`${diff}\n  tree:  ${treeText(tree)}\n  steps: ${steps.join(' ')}\n  back:  ${order.join(' ')}`
						);
					}
				}
			}),
			params(600)
		);
	});

	it('a pane that is away keeps its share of S through resizes of what shows', () => {
		fc.assert(
			fc.property(treeRecipe, fc.nat({ max: 6 }), ops(8), (recipe, pick, list) => {
				const tree = buildTree(recipe);
				const all = collectPanelIds(tree);
				const id = all[pick % all.length];
				const { s } = run(markAway(tree, id) as DockNode, list, ['resize'], false);
				// Resizes moved the shown shares only: back, the pane and its split's place are as before.
				const back = markPresent(s, id);
				expect(text(back)).toBe(text(tree));
				const was = ownShare(tree, id);
				const now = ownShare(back as DockNode, id);
				if (was !== null) expect(Math.abs(now! - was)).toBeLessThan(EPS);
			}),
			params(300)
		);
	});
});

/** The share of the pane `id` in its split, or `null` when it is a tab of a group or the root. */
function ownShare(tree: DockNode, id: string): number | null {
	for (const at of splitsOf(tree)) {
		const i = at.children.findIndex((c) => c.id === id);
		if (i !== -1) return at.sizes[i];
	}
	return null;
}
