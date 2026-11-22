// #782: properties of where panes come back, over generated trees and steps (fast-check,
// ADR-0033). What holds for every tree and every order.
//
// PR5 changed what the first half is about. A pane HIDDEN from the dock (`dismiss`) remembers no
// place: `show` docks it at its place in the default layout (`core/defaultPlace.ts`; here the
// default layout of a state is the tree it starts with, `newDock`). The properties of "the
// remembered docked place" of PR1 that were about hide / show are rewritten as properties of the
// default place (the first four `describe`s). A pane FLOATED out of the tree (`undockPanel`)
// still goes back to where it was (`homeSlot`, `core/slot.ts`) until PR6: the properties and the
// known failures of the slots are kept for floats in the last `describe`s.
//
// Each property runs with a fixed seed (`SEED`) and a fixed number of cases, so a run is the same
// every time. A failure prints the seed, the shrunk recipe, and - from `failCase` - the tree and
// the steps as text. To look for more cases: `DOCK_PROPERTY_RUNS=5000 DOCK_PROPERTY_SEED=1 pnpm
// --filter @banto/dock-svelte test slot-properties`.
//
// Known failures are marked `it.fails` with the issue and the smallest case found; each also has
// its case pinned as an ordinary `it.fails` below the property. When one starts to pass, vitest
// reports it: take the mark off then. Left: the edge bands (2 by hide / show, 2 by floats), for
// #782 PR8. The 14 by floats that #782 PR6 passed are ordinary cases now.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { collectPanelIds, findNode, findParent, removePanel } from '../src/core/tree';
import type { DockState } from '../src/state.svelte';
import type { DockNode } from '../src/types';
import {
	EDGES,
	badSizes,
	buildTree,
	dockedIds,
	expectAllDocked,
	failCase,
	floatedIds,
	hiddenIds,
	loadedFresh,
	newDock,
	opRecipe,
	permutations,
	resolveStep,
	runOps,
	runStep,
	runSteps,
	treeDiff,
	splitTreeRecipe,
	treeRecipe,
	treeText,
	type OpKind,
	type OpRecipe,
	type TreeRecipe
} from './fixtures/dock-properties';
import { shapeOf } from './fixtures/visibility-sim';

// The package has no Node types (`tsconfig.json`'s `types`): read the environment untyped.
const env =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env.DOCK_PROPERTY_SEED ?? 782);
const RUNS = Number(env.DOCK_PROPERTY_RUNS ?? 0);
// With the usual number of cases each property takes well under a second; a search with more
// (`DOCK_PROPERTY_RUNS`) needs longer than vitest's 5 seconds.
if (RUNS) vi.setConfig({ testTimeout: 600_000 });
const params = (numRuns: number): fc.Parameters<unknown> => ({
	seed: SEED,
	numRuns: RUNS || numRuns
});

const ops = (min: number, max: number): fc.Arbitrary<OpRecipe[]> =>
	fc.array(opRecipe, { minLength: min, maxLength: max });

const shapeText = (node: DockNode | null): string => JSON.stringify(shapeOf(node));

/** `tree` without the panes that are not in `ids` (`removePanel`, in any order: the same tree). */
const without = (tree: DockNode, ids: string[]): DockNode | null =>
	collectPanelIds(tree)
		.filter((id) => !ids.includes(id))
		.reduce<DockNode | null>((root, id) => removePanel(root, id), tree);

/**
 * The docked tree after `steps` - which end with every pane back -, checked for sizes that do
 * not add up, and for every pane of `tree` being back in the dock exactly once (a pane left
 * floating, hidden or in a band, or docked twice, would let orders look the same by being wrong
 * the same way).
 */
const treeAfter = (tree: DockNode, steps: string[], allDocked = true): DockNode | null => {
	const dock = runSteps(tree, steps);
	if (allDocked) expectAllDocked(dock, collectPanelIds(tree), tree, steps);
	const docked = dock.layout.docked;
	const bad = badSizes(docked);
	if (bad.length > 0) failCase(tree, steps, `bad sizes ${bad.join(', ')}`);
	return docked;
};

const panel = (id: string): DockNode => ({ type: 'panel', id, title: id.toUpperCase() });
const split = (id: string, direction: 'row' | 'column', sizes: number[], children: DockNode[]) =>
	({ type: 'split', id, direction, sizes, children }) as DockNode;
const tabs = (id: string, ids: string[]) =>
	({ type: 'tabs', id, activeIndex: 0, children: ids.map(panel) }) as DockNode;
const even = (n: number): number[] => Array.from({ length: n }, () => 1 / n);
const row = (ids: string[]): DockNode => split('s1', 'row', even(ids.length), ids.map(panel));

describe('hidden panes come back at their default place, in any order (#782 PR5 property 1)', () => {
	it('panes hidden and shown in any sequence: the tree is always the default tree without the panes still hidden', () => {
		fc.assert(
			fc.property(treeRecipe, ops(2, 14), (recipe, recipes) => {
				const tree = buildTree(recipe);
				const dock = newDock(tree);
				const steps: string[] = [];
				for (const op of recipes) {
					steps.push(...runOps(dock, [op], ['hide', 'show']));
					const expected = without(tree, dockedIds(dock));
					if (shapeText(dock.layout.docked) !== shapeText(expected)) {
						failCase(tree, steps, `${treeText(dock.layout.docked)} is not ${treeText(expected)}`);
					}
					const bad = badSizes(dock.layout.docked);
					if (bad.length > 0) failCase(tree, steps, `bad sizes ${bad.join(', ')}`);
				}
			}),
			params(300)
		);
	});

	// The decision of 2026-11-22 (#782, 3): the order panes are shown in does not matter.
	it('2 to 4 panes hidden, shown in every order: the default shape each time', () => {
		fc.assert(
			fc.property(treeRecipe, ops(2, 5), (recipe, out) => {
				const tree = buildTree(recipe);
				const before = newDock(tree);
				const steps = runOps(before, out, ['hide']);
				const hidden = hiddenIds(before);
				fc.pre(hidden.length >= 2 && hidden.length <= 4);
				for (const order of permutations(hidden)) {
					const all = [...steps, ...order.map((id) => `+${id}`)];
					const shape = shapeText(treeAfter(tree, all));
					if (shape !== shapeText(tree)) failCase(tree, all, `${shape} is not the default shape`);
				}
			}),
			params(300)
		);
	});

	it('pinned: row[a, b, c], every pane hidden, shown in every order -> row[a, b, c]', () => {
		const tree = split('s1', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel));
		for (const order of permutations(['a', 'b', 'c'])) {
			const steps = ['-a', '-b', '-c', ...order.map((id) => `+${id}`)];
			expect(shapeOf(treeAfter(tree, steps)), steps.join(' ')).toEqual({ row: ['a', 'b', 'c'] });
		}
	});

	// The place is the default one; of the size only one number is kept (the share the pane held
	// when it was hidden). So the sizes come back exactly when the panes are shown in the reverse
	// of the order they were hidden in, and are what those shares give in any other order.
	it('shown in the reverse of the order hidden: the tree as it was, sizes too', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 6), (recipe, out) => {
				const tree = buildTree(recipe);
				const dock = newDock(tree);
				const steps = runOps(dock, out, ['hide']);
				for (const id of hiddenIds(dock).reverse()) steps.push(`+${id}`);
				const diff = treeDiff(treeAfter(tree, steps), tree);
				if (diff) failCase(tree, steps, diff);
			}),
			params(300)
		);
	});

	it('pinned: row[a .2, b .3, c .5], a then b hidden: +b +a is .2 / .3 / .5, +a +b is .2 / .3 / .5 of what each held', () => {
		const tree = split('s1', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel));
		expect(treeDiff(treeAfter(tree, ['-a', '-b', '+b', '+a']), tree)).toBeNull();
		// a held .2 of row[a, b, c], b .375 of row[b, c]: a first takes .2 beside c, then b .375.
		const other = treeAfter(tree, ['-a', '-b', '+a', '+b']);
		expect(shapeOf(other)).toEqual({ row: ['a', 'b', 'c'] });
		const sizes = other?.type === 'split' ? other.sizes : [];
		[0.2 * 0.625, 0.375, 0.8 * 0.625].forEach((v, i) => expect(sizes[i]).toBeCloseTo(v, 9));
	});
});

describe('showing a pane changes nothing else (#782 PR5 property 2)', () => {
	const showsOnly = (trees: fc.Arbitrary<TreeRecipe>, kinds: OpKind[]) =>
		fc.property(trees, ops(2, 10), (recipe, recipes) => {
			const tree = buildTree(recipe);
			const dock = newDock(tree);
			const steps = runOps(dock, recipes, kinds);
			for (const id of hiddenIds(dock)) {
				const before = dock.layout.docked;
				const where = dock.show(id);
				steps.push(`+${id}`);
				// Every pane of the default tree has a default sibling docked: never floating.
				if (where !== 'docked') failCase(tree, steps, `${id} was shown ${where}`);
				const bad = badSizes(dock.layout.docked);
				if (bad.length > 0) failCase(tree, steps, `bad sizes ${bad.join(', ')}`);
				// The tree without the pane shown is the tree before: the others keep their places
				// (a pane moved to an outer edge, into a tab group, beside another) and their ratios.
				const diff = treeDiff(removePanel(dock.layout.docked, id), before);
				if (diff) failCase(tree, steps, `the rest changed: ${diff}`);
			}
			expect(hiddenIds(dock)).toEqual([]);
		});

	it('after panes were hidden and docked panes moved (beside another, into a tab group, to an outer edge): the pane shown is docked, the rest is as it was', () => {
		fc.assert(showsOnly(treeRecipe, ['hide', 'hide', 'move', 'tab', 'edge']), params(300));
	});

	it('the same with panes floated and docked back in between', () => {
		fc.assert(
			showsOnly(treeRecipe, ['hide', 'hide', 'move', 'tab', 'edge', 'float', 'back']),
			params(300)
		);
	});

	// Was KNOWN FAILURE 1 of PR1 (a hidden pane shown floating once its neighbours were moved to
	// outer edges): a default sibling is always found, wherever it was moved to.
	it('pinned: row[a, b, c, d, e], a, b and c hidden, d moved to the right edge and e to the left: every pane back in the dock', () => {
		const tree = row(['a', 'b', 'c', 'd', 'e']);
		const dock = runSteps(tree, ['-a', '-b', '-c', 'd>>right', 'e>>left', '+a', '+b', '+c']);
		expectAllDocked(dock, ['a', 'b', 'c', 'd', 'e'], tree, []);
		// Each on its default side of its nearest default sibling: c before d, then b, then a.
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['e', 'a', 'b', 'c', 'd'] });
	});

	// What the default place does NOT promise: once panes were moved, the order panes are shown in
	// can matter - each goes beside the nearest default sibling docked at that moment.
	it('pinned: row[a, b, c, d], b and c hidden, d moved below a: the order matters', () => {
		const tree = row(['a', 'b', 'c', 'd']);
		const steps = ['-b', '-c', 'd>a:bottom'];
		// b beside a (its nearest), then c beside b.
		expect(shapeOf(treeAfter(tree, [...steps, '+b', '+c']))).toEqual({
			column: [{ row: ['a', 'b', 'c'] }, 'd']
		});
		// c beside d (its nearest), then b beside a.
		expect(shapeOf(treeAfter(tree, [...steps, '+c', '+b']))).toEqual({
			column: [{ row: ['a', 'b'] }, { row: ['c', 'd'] }]
		});
	});

	// Nor that a pane moved to an outer edge stays the outermost (PR1's property 3, kept for floats
	// below): a pane whose default place is outside of it comes back outside of it.
	it('pinned: row[a, column[b, c]], a hidden, b moved to the left edge: a is shown to the left of b and c', () => {
		const tree = split('s1', 'row', even(2), [
			panel('a'),
			split('s2', 'column', even(2), [panel('b'), panel('c')])
		]);
		expect(shapeOf(treeAfter(tree, ['-a', 'b>>left', '+a']))).toEqual({
			row: ['a', { row: ['b', 'c'] }]
		});
	});

	// Was the case of #780 for hide / show: c, moved beside d, stays there - in every order.
	it('pinned (#780 as hide / show): column[row[a, b, c], d, e], a, b and e hidden, c moved to the right of d', () => {
		const tree = split('s1', 'column', even(3), [
			split('s2', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]),
			panel('d'),
			panel('e')
		]);
		const shapes = new Set(
			permutations(['a', 'b', 'e']).map((order) =>
				shapeText(treeAfter(tree, ['-a', '-b', '-e', 'c>d:right', ...order.map((id) => `+${id}`)]))
			)
		);
		// c is in a row with d now: a and b join that row on their default side of c, e goes below d.
		expect([...shapes]).toEqual([JSON.stringify({ row: [{ column: ['d', 'e'] }, 'a', 'b', 'c'] })]);
	});
});

describe('a docked pane that leaves the layout (#743, #782 PR5 property 3)', () => {
	it('the hidden panes shown in any order: the default shape without the pane that left', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 3), fc.nat({ max: 6 }), (recipe, out, pick) => {
				const tree = buildTree(recipe);
				const before = newDock(tree);
				const steps = runOps(before, out, ['hide']);
				const docked = dockedIds(before);
				fc.pre(docked.length >= 2);
				const gone = docked[pick % docked.length];
				const expected = removePanel(tree, gone);
				for (const order of permutations(hiddenIds(before))) {
					const dock = runSteps(tree, steps);
					// An assignment made from today's layout (`ThreePaneDock`'s `syncPanels`).
					dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, gone) };
					for (const id of order) runStep(dock, `+${id}`);
					const all = [...steps, `(${gone} leaves)`, ...order.map((h) => `+${h}`)];
					expectAllDocked(
						dock,
						collectPanelIds(tree).filter((id) => id !== gone),
						tree,
						all
					);
					const bad = badSizes(dock.layout.docked);
					if (bad.length > 0) failCase(tree, all, `bad sizes ${bad.join(', ')}`);
					if (shapeText(dock.layout.docked) !== shapeText(expected)) {
						failCase(tree, all, `${treeText(dock.layout.docked)} is not ${treeText(expected)}`);
					}
				}
			}),
			params(300)
		);
	});
});

describe('a region in an edge band and hidden panes (#739, #782 PR5 property 4)', () => {
	const bandRoundTrip = (restoreLast: boolean) =>
		fc.property(treeRecipe, ops(1, 3), fc.nat({ max: 6 }), (recipe, out, pick) => {
			const tree = buildTree(recipe);
			const dock = newDock(tree);
			const steps = runOps(dock, out, ['hide']);
			const docked = dockedIds(dock);
			fc.pre(docked.length >= 2);
			const id = docked[pick % docked.length];
			fc.pre(dock.autoHideRegion(id));
			steps.push(`(${id} to its band)`);
			const restore = () => {
				expect(dock.restoreAutoHidden(id), 'restoreAutoHidden').toBe(true);
				steps.push(`(${id} back from its band)`);
			};
			if (!restoreLast) restore();
			// In the reverse of the order hidden: the sizes come back too.
			for (const h of hiddenIds(dock).reverse()) {
				runStep(dock, `+${h}`);
				steps.push(`+${h}`);
			}
			if (restoreLast) restore();
			expectAllDocked(dock, collectPanelIds(tree), tree, steps);
			const bad = badSizes(dock.layout.docked);
			if (bad.length > 0) failCase(tree, steps, `bad sizes ${bad.join(', ')}`);
			const diff = treeDiff(dock.layout.docked, tree);
			if (diff) failCase(tree, steps, diff);
		});

	it('a region auto-hidden to a band and put back, then the hidden panes shown: the tree is as it was', () => {
		fc.assert(bandRoundTrip(false), params(300));
	});

	// KNOWN FAILURE (for PR8, the bands on the shadow tree): the hidden panes shown while the region
	// is in its band. The band's slot is the place the region had when it went there - beside the
	// panes docked then -, not its default place: the region comes back there, whatever was shown
	// at its default place meanwhile. Smallest case: the pinned one below.
	it.fails(
		'KNOWN FAILURE: the hidden panes shown first, then the region put back from its band',
		() => {
			fc.assert(bandRoundTrip(true), params(300));
		}
	);
	it.fails(
		'KNOWN FAILURE (pinned): row[column[a, b], c], a hidden, b to its band, a shown, b put back',
		() => {
			const tree = split('s1', 'row', even(2), [
				split('s2', 'column', even(2), [panel('a'), panel('b')]),
				panel('c')
			]);
			const dock = runSteps(tree, ['-a']);
			expect(dock.autoHideRegion('b')).toBe(true);
			runStep(dock, '+a');
			expect(dock.restoreAutoHidden('b')).toBe(true);
			// row[a, b, c]: b goes back beside c (where it was when a was hidden), not below a.
			expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(tree));
		}
	);
});

describe('saving and loading changes nothing (#782 property 5)', () => {
	it('serialize / hydrate between any two steps, into the same state and into a new one made from the saved text (given the default layout again): the tree, and the tree with every hidden pane shown and back in the dock, are the same as without the save', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 8), fc.nat({ max: 8 }), (recipe, recipes, cut) => {
				const tree = buildTree(recipe);
				const plain = newDock(tree);
				// Not `float`: a floated pane's `homeSlot` is not saved, by design.
				const steps = runOps(plain, recipes, ['hide', 'hide', 'show', 'move', 'tab', 'edge']);
				const at = cut % (steps.length + 1);
				// Two ways to save and load: back into the same state (`@`), and into a new state
				// made from the saved text alone (`@@`: only the default layout is given again),
				// which then goes on with the rest of the steps.
				const saved = [...steps.slice(0, at), '@', ...steps.slice(at)];
				const savedNew = [...steps.slice(0, at), '@@', ...steps.slice(at)];
				const same = runSteps(tree, saved);
				const fresh = newDock(tree);
				for (const step of steps.slice(0, at)) runStep(fresh, step);
				const reloaded = loadedFresh(fresh);
				for (const step of steps.slice(at)) runStep(reloaded, step);
				const variants: [string[], DockState][] = [
					[saved, same],
					[savedNew, reloaded]
				];
				for (const [text, dock] of variants) {
					const diff = treeDiff(dock.layout.docked, plain.layout.docked);
					if (diff) failCase(tree, text, `not as without the save: ${diff}`);
					if (hiddenIds(dock).join() !== hiddenIds(plain).join()) {
						failCase(tree, text, `hidden panes ${hiddenIds(dock)} != ${hiddenIds(plain)}`);
					}
				}
				// Then every hidden pane shown.
				for (const id of hiddenIds(plain)) {
					runStep(plain, `+${id}`);
					for (const [text, dock] of variants) {
						runStep(dock, `+${id}`);
						text.push(`+${id}`);
					}
				}
				for (const [text, dock] of variants) {
					expectAllDocked(dock, collectPanelIds(tree), tree, text);
					const diff = treeDiff(dock.layout.docked, plain.layout.docked);
					if (diff) failCase(tree, text, `not as without the save: ${diff}`);
				}
			}),
			params(300)
		);
	});

	// Was KNOWN FAILURE (pinned) of PR1: a pane shown floating, saved or not.
	it('pinned: row[a, b, c], a hidden, b moved to the left edge, c hidden, a and c shown: every pane back in the dock', () => {
		const tree = row(['a', 'b', 'c']);
		const dock = runSteps(tree, ['-a', 'b>>left', '-c', '+a', '+c']);
		expectAllDocked(dock, ['a', 'b', 'c'], tree, []);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c'] });
	});

	// Was KNOWN FAILURE (pinned) of PR1: `a`, moved into c's tab group and hidden, opened floating
	// after a load. Its default place is beside the column, saved or not.
	it("pinned: row[a, column[b, c]], b hidden, a moved into c's tab group and hidden, saved and loaded", () => {
		const tree = split('s1', 'row', even(2), [
			panel('a'),
			split('s2', 'column', even(2), [panel('b'), panel('c')])
		]);
		const steps = ['-b', 'a>c:center', '-a'];
		const plain = treeAfter(tree, [...steps, '+b', '+a']);
		const loaded = treeAfter(tree, [...steps, '@', '+b', '+a']);
		expect(treeDiff(loaded, plain)).toBeNull();
		expect(shapeOf(plain)).toEqual(shapeOf(tree));
	});
});

// ----- floated panes: the remembered place (`homeSlot`) -----------------------------------------
//
// The properties PR1 wrote for hide / show, for panes floated out (`~x`) and docked back to where
// they were (`^x`). The place is the pane's tombstone in the shadow tree since #782 PR6 (floating
// out, docking back, `dockExisting*`, drops and resizes are done on S), which passes the known
// failures PR1 found - kept below as ordinary cases, each with what it was.

/**
 * Float 2 to 4 panes (`out`), then run `moves` (steps of `moveKinds`), then dock the floated
 * panes back in every order: the tree is the same for all of them.
 */
const sameInAnyBackOrder = (
	trees: fc.Arbitrary<TreeRecipe>,
	outKinds: OpKind[],
	moveKinds: OpKind[],
	maxMoves: number,
	allDocked = true
) =>
	fc.property(trees, ops(2, 5), ops(0, maxMoves), (recipe: TreeRecipe, out, moves) => {
		const tree = buildTree(recipe);
		const before = newDock(tree);
		const steps = [...runOps(before, out, outKinds), ...runOps(before, moves, moveKinds)];
		const floated = floatedIds(before);
		fc.pre(floated.length >= 2 && floated.length <= 4);
		const [first, ...rest] = permutations(floated).map((order) => [
			...steps,
			...order.map((id) => `^${id}`)
		]);
		const expected = treeAfter(tree, first, allDocked);
		for (const other of rest) {
			const diff = treeDiff(treeAfter(tree, other, allDocked), expected);
			if (diff) {
				failCase(tree, other, `not as docked back ${first.slice(steps.length).join(' ')}: ${diff}`);
			}
		}
	});

/** The trees after `steps` and then the floated panes `floated` docked back in every order, as text. */
const inEveryBackOrder = (tree: DockNode, steps: string[], floated: string[]): string[] => [
	...new Set(
		permutations(floated).map((order) =>
			treeText(treeAfter(tree, [...steps, ...order.map((id) => `^${id}`)]))
		)
	)
];

describe('floated panes: the order they are docked back in does not matter (#782 property 1, floats)', () => {
	it('panes floated, docked back in any order (#733)', () => {
		fc.assert(sameInAnyBackOrder(treeRecipe, ['float'], [], 0), params(300));
	});

	it('then docked panes moved to an outer edge (dockExistingAtEdge), trees without tab groups (#777, #781): the same tree in every order', () => {
		fc.assert(sameInAnyBackOrder(splitTreeRecipe, ['float'], ['edge'], 2, false), params(300));
	});

	// Was a KNOWN FAILURE until #782 PR6 (PR1's 1, by floats): when the panes next to the floated ones are all moved to
	// outer edges, their places are gone ("back" is not offered) - so the property above holds by
	// every order being wrong the same way. Smallest case: the pinned one below.
	it('the same, every pane back in the dock', () => {
		fc.assert(sameInAnyBackOrder(splitTreeRecipe, ['float'], ['edge'], 2), params(300));
	});
	it('pinned: row[a, b, c, d, e], a, b and c floated, d moved to the right edge and e to the left', () => {
		const tree = row(['a', 'b', 'c', 'd', 'e']);
		const dock = runSteps(tree, ['~a', '~b', '~c', 'd>>right', 'e>>left', '^a', '^b', '^c']);
		expectAllDocked(dock, ['a', 'b', 'c', 'd', 'e'], tree, []);
	});

	// Was a KNOWN FAILURE until #782 PR6 (PR1's 2, by floats): a pane moved out of its tab group to an outer edge is
	// still what its floated tab mate goes back to, when that mate is docked back before the panes
	// of the split around. Smallest case: the pinned one below.
	it('then docked panes moved to an outer edge, trees with tab groups', () => {
		fc.assert(sameInAnyBackOrder(treeRecipe, ['float'], ['edge'], 2, false), params(300));
	});
	it('pinned: row[a, tabs[b, c], d], b and d floated, c moved to the left edge', () => {
		const tree = split('s1', 'row', even(3), [panel('a'), tabs('t1', ['b', 'c']), panel('d')]);
		expect(inEveryBackOrder(tree, ['~b', '~d', 'c>>left'], ['b', 'd'])).toHaveLength(1);
	});

	// Was a KNOWN FAILURE until #782 PR6 (#780, decided in #782: passes with PR6): a pane moved beside another docked
	// pane with `dockExisting`. By hide / show this no longer arises (PR5); by floats it does.
	it('#780: then docked panes moved beside another (dockExisting at a side)', () => {
		fc.assert(sameInAnyBackOrder(splitTreeRecipe, ['float'], ['move'], 2), params(300));
	});
	it('#780 (pinned): the case of the issue', () => {
		const tree = split('s1', 'column', even(3), [
			split('s2', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]),
			panel('d'),
			panel('e')
		]);
		// What #782 decided is right, in every order: column[row[a, b], row[d, c], e] - c stays
		// beside d. Sizes: the column in thirds, a : b as they were (0.2 : 0.3), d and c half each.
		const expected = split('s1', 'column', even(3), [
			split('s2', 'row', [0.4, 0.6], [panel('a'), panel('b')]),
			split('s3', 'row', [0.5, 0.5], [panel('d'), panel('c')]),
			panel('e')
		]);
		const steps = ['~a', '~b', '~e', 'c>d:right'];
		for (const order of permutations(['a', 'b', 'e'])) {
			const all = [...steps, ...order.map((id) => `^${id}`)];
			const diff = treeDiff(treeAfter(tree, all), expected);
			if (diff) failCase(tree, all, diff);
		}
	});
	it('#780 (pinned): row[a, b, c, d], a and c floated, b moved to the left of d', () => {
		const tree = row(['a', 'b', 'c', 'd']);
		expect(inEveryBackOrder(tree, ['~a', '~c', 'b>d:left'], ['a', 'c'])).toHaveLength(1);
	});

	// Was a KNOWN FAILURE until #782 PR6 (PR1's, by floats): the pane between two floated ones moved into a tab group -
	// the two come back in the order they are docked back.
	it("then docked panes moved into another pane's tab group (dockExisting center)", () => {
		fc.assert(sameInAnyBackOrder(splitTreeRecipe, ['float'], ['tab'], 2), params(300));
	});
	it("pinned: row[a, b, c, d], a and c floated, b moved into d's tab group", () => {
		const tree = row(['a', 'b', 'c', 'd']);
		expect(inEveryBackOrder(tree, ['~a', '~c', 'b>d:center'], ['a', 'c'])).toHaveLength(1);
	});

	// Was a KNOWN FAILURE until #782 PR6 (PR1's, by floats): a pane moved to an outer edge and then floated itself, with
	// a pane floated before the move.
	it('edge moves between the floats (a moved pane may be floated after)', () => {
		fc.assert(sameInAnyBackOrder(splitTreeRecipe, ['float', 'float', 'edge'], [], 0), params(300));
	});
	it('pinned: row[a, b, c], a floated, b moved to the left edge, b floated', () => {
		const tree = row(['a', 'b', 'c']);
		expect(inEveryBackOrder(tree, ['~a', 'b>>left', '~b'], ['a', 'b'])).toHaveLength(1);
	});

	// Was a KNOWN FAILURE until #782 PR6 (PR1's, by floats): a slot's size is clamped to 5% (`core/slot.ts`'s
	// `MIN_SHARE`), so a pane under 5% of its split comes back at 5% or at its own size by the order.
	// A hidden pane's `dockShare` is not clamped (the reverse order is exact: property 1 above).
	it('pinned: a pane under 5% of its split, floated with a sibling', () => {
		const weights = [1, 1, 3, 4, 4, 4, 4];
		const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
		const tree = split(
			's1',
			'row',
			weights.map((w) => w / 21),
			ids.map(panel)
		);
		expect(inEveryBackOrder(tree, ['~a', '~b'], ['a', 'b'])).toHaveLength(1);
	});
});

describe('floated panes: out and back is the tree as it was (#782 property 2, floats)', () => {
	it('floated, then docked back in any order', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 6), ops(6, 6), (recipe, out, back) => {
				const tree = buildTree(recipe);
				const dock = newDock(tree);
				const steps = runOps(dock, out, ['float']);
				steps.push(...runOps(dock, back, ['back']));
				// Whatever is still out comes back in the order it left.
				for (const id of floatedIds(dock)) steps.push(`^${id}`);
				const diff = treeDiff(treeAfter(tree, steps), tree);
				if (diff) failCase(tree, steps, diff);
			}),
			params(300)
		);
	});
});

describe('floated panes: a pane moved to an outer edge stays there (#782 property 3, floats)', () => {
	/** Why `id` is not the root split's child at `edge`, or `null`. */
	const notAtEdge = (root: DockNode | null, id: string, edge: string): string | null => {
		const direction = edge === 'left' || edge === 'right' ? 'row' : 'column';
		if (root?.type !== 'split' || root.direction !== direction)
			return `the root is not a ${direction}`;
		const at = edge === 'left' || edge === 'top' ? 0 : root.children.length - 1;
		return root.children[at].id === id ? null : `${id} is not the root's ${edge} child`;
	};

	const staysAtEdge = (trees: fc.Arbitrary<TreeRecipe>) =>
		fc.property(
			trees,
			ops(1, 4),
			fc.nat({ max: 6 }),
			fc.constantFrom(...EDGES),
			(recipe, out, pick, edge) => {
				const tree = buildTree(recipe);
				const before = newDock(tree);
				const steps = runOps(before, out, ['float']);
				const docked = dockedIds(before);
				fc.pre(docked.length >= 2);
				const id = docked[pick % docked.length];
				steps.push(`${id}>>${edge}`);
				for (const order of permutations(floatedIds(before))) {
					const all = [...steps, ...order.map((h) => `^${h}`)];
					const why = notAtEdge(treeAfter(tree, all), id, edge);
					if (why) failCase(tree, all, `${why}: ${treeText(treeAfter(tree, all))}`);
				}
			}
		);

	it('panes floated at any depth, one docked pane moved to an edge, docked back in any order: trees without tab groups (#777, #781)', () => {
		fc.assert(staysAtEdge(splitTreeRecipe), params(300));
	});

	// Was a KNOWN FAILURE until #782 PR6 (PR1's, by floats; the same case as property 1's with tab groups): the floated
	// tab mate of the moved pane comes back to it at the edge, not to the place of their group.
	it('the same with tab groups', () => {
		fc.assert(staysAtEdge(treeRecipe), params(300));
	});
	it('pinned: row[a, tabs[b, c], d], a and b floated, c moved to the left edge', () => {
		const tree = split('s1', 'row', even(3), [panel('a'), tabs('t1', ['b', 'c']), panel('d')]);
		const root = treeAfter(tree, ['~a', '~b', 'c>>left', '^a', '^b']);
		expect(notAtEdge(root, 'c', 'left')).toBeNull();
	});
});

describe('hidden and floated panes together (#782 PR6)', () => {
	/** Hide and float panes of a tree (2 to 4 out), and the steps that bring each back. */
	const mixedOut = (recipe: TreeRecipe, out: OpRecipe[]) => {
		const tree = buildTree(recipe);
		const before = newDock(tree);
		const steps = runOps(before, out, ['hide', 'float']);
		const back = [
			...hiddenIds(before).map((id) => `+${id}`),
			...floatedIds(before).map((id) => `^${id}`)
		];
		return { tree, steps, back };
	};

	// The default place is worked out on the shadow tree: the place of a floated pane is a default
	// sibling that is there, so a hidden pane shown first lands beside it, in default order.
	it('shown and docked back in any order: the shape of the default tree', () => {
		fc.assert(
			fc.property(treeRecipe, ops(2, 5), (recipe, out) => {
				const { tree, steps, back } = mixedOut(recipe, out);
				fc.pre(back.length >= 2 && back.length <= 4);
				for (const order of permutations(back)) {
					const all = [...steps, ...order];
					const got = treeAfter(tree, all);
					if (shapeText(got) !== shapeText(tree)) failCase(tree, all, treeText(got));
				}
			}),
			params(300)
		);
	});

	// Review of PR #863: after floats, hides and shows are mixed, "back" gives the old order AND
	// the old sizes. The tombstone of `a` gives way to `b` as it took from it (`removeFromShadow`
	// and its reverse), so it holds what it held.
	it('pinned: row[a .2, b .3, c .5], a floated, b hidden and shown, a docked back: the tree as it was, sizes too', () => {
		const tree = split('s1', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]);
		const dock = runSteps(tree, ['~a', '-b', '+b']);
		// While `a` is out, `b` and `c` are as they were to each other.
		const shown = split('s1', 'row', [0.375, 0.625], [panel('b'), panel('c')]);
		expect(treeDiff(dock.layout.docked, shown)).toBeNull();
		runStep(dock, '^a');
		expect(treeDiff(dock.layout.docked, tree)).toBeNull();
	});

	// The order PR5 pinned as row[b, a, c] (the float did not count the hidden pane): the default
	// order now. The sizes are not the old ones: `b` was hidden at .3 of the row of three and is
	// shown at .3 of what shows (`b` and `c`); `a` and `c` stay 2 : 5 to each other.
	it('pinned: row[a .2, b .3, c .5], b hidden, a floated, b shown, a docked back: the old order', () => {
		const tree = split('s1', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]);
		const dock = runSteps(tree, ['-b', '~a', '+b']);
		const shown = split('s1', 'row', [0.3, 0.7], [panel('b'), panel('c')]);
		expect(treeDiff(dock.layout.docked, shown)).toBeNull();
		runStep(dock, '^a');
		const back = split(
			's1',
			'row',
			[14 / 64, 15 / 64, 35 / 64],
			[panel('a'), panel('b'), panel('c')]
		);
		expect(treeDiff(dock.layout.docked, back)).toBeNull();
	});

	// Found with `DOCK_PROPERTY_RUNS=4000 DOCK_PROPERTY_SEED=7`: `e` is shown beside the place of
	// `d` (floated) in a column whose only child that shows is not one of its default siblings. Its
	// default share is then taken against the place - not the whole of what shows (sizes [1, 0]).
	it('pinned: a pane shown beside a place, in a split where no default sibling shows', () => {
		const tree = split('s1', 'row', even(4), [
			panel('a'),
			panel('b'),
			panel('c'),
			split('s2', 'column', [0.5, 0.5], [panel('d'), panel('e')])
		]);
		const steps = ['a>e:bottom', '-b', '~d', 'a>e:center', '-c', '-e', '+b', '+c', '+e'];
		const docked = treeAfter(tree, steps, false);
		expect(shapeText(docked)).toBe('{"column":["e",{"row":["a","b","c"]}]}');
		expect(docked?.type === 'split' && docked.sizes.every((size) => size > 0.1)).toBe(true);
	});

	it('pinned: column[row[a, b, c], d, e], c moved beside d with a floated and b hidden: both back in the row they left, in either order', () => {
		const tree = split('s1', 'column', even(3), [
			split('s2', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]),
			panel('d'),
			panel('e')
		]);
		// `b` was hidden at .375 of what showed of its row (`b` and `c`): what it takes of the row.
		const expected = split('s1', 'column', even(3), [
			split('s2', 'row', [0.625, 0.375], [panel('a'), panel('b')]),
			split('gen-0', 'row', [0.5, 0.5], [panel('d'), panel('c')]),
			panel('e')
		]);
		for (const back of [
			['^a', '+b'],
			['+b', '^a']
		]) {
			const all = ['~a', '-b', 'c>d:right', ...back];
			const diff = treeDiff(treeAfter(tree, all), expected);
			if (diff) failCase(tree, all, diff);
		}
	});
});

describe('floated panes: shares are kept (#782 property 4, floats)', () => {
	it('a docked pane that leaves the layout: the rest is the tree without it, floated panes included (#743)', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 3), fc.nat({ max: 6 }), (recipe, out, pick) => {
				const tree = buildTree(recipe);
				const before = newDock(tree);
				const steps = runOps(before, out, ['float']);
				const docked = dockedIds(before);
				fc.pre(docked.length >= 2);
				const gone = docked[pick % docked.length];
				const expected = removePanel(tree, gone);
				for (const order of permutations(floatedIds(before))) {
					const dock = runSteps(tree, steps);
					// An assignment made from today's layout (`ThreePaneDock`'s `syncPanels`).
					dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, gone) };
					for (const id of order) runStep(dock, `^${id}`);
					const all = [...steps, `(${gone} leaves)`, ...order.map((h) => `^${h}`)];
					expectAllDocked(
						dock,
						collectPanelIds(tree).filter((id) => id !== gone),
						tree,
						all
					);
					const bad = badSizes(dock.layout.docked);
					if (bad.length > 0) failCase(tree, all, `bad sizes ${bad.join(', ')}`);
					const diff = treeDiff(dock.layout.docked, expected);
					if (diff) failCase(tree, all, diff);
				}
			}),
			params(300)
		);
	});

	const bandRoundTrip = (restoreLast: boolean) =>
		fc.property(treeRecipe, ops(1, 3), fc.nat({ max: 6 }), (recipe, out, pick) => {
			const tree = buildTree(recipe);
			const dock = newDock(tree);
			const steps = runOps(dock, out, ['float']);
			const docked = dockedIds(dock);
			fc.pre(docked.length >= 2);
			const id = docked[pick % docked.length];
			fc.pre(dock.autoHideRegion(id));
			steps.push(`(${id} to its band)`);
			const floated = floatedIds(dock);
			const restore = () => {
				expect(dock.restoreAutoHidden(id), 'restoreAutoHidden').toBe(true);
				steps.push(`(${id} back from its band)`);
			};
			if (!restoreLast) restore();
			for (const h of floated) {
				runStep(dock, `^${h}`);
				steps.push(`^${h}`);
			}
			if (restoreLast) restore();
			expectAllDocked(dock, collectPanelIds(tree), tree, steps);
			const bad = badSizes(dock.layout.docked);
			if (bad.length > 0) failCase(tree, steps, `bad sizes ${bad.join(', ')}`);
			const diff = treeDiff(dock.layout.docked, tree);
			if (diff) failCase(tree, steps, diff);
		});

	it('a region auto-hidden to a band and put back, then the floated panes docked back: the tree is as it was (#739)', () => {
		fc.assert(bandRoundTrip(false), params(300));
	});

	// KNOWN FAILURE (PR1's, by floats; for PR8): the floated panes docked back while the region is
	// in its band. The band's slot has no `share` (#739), so the region comes back by `size` into a
	// split that has changed.
	it.fails(
		'KNOWN FAILURE: the floated panes docked back first, then the region put back from its band',
		() => {
			fc.assert(bandRoundTrip(true), params(300));
		}
	);
	it.fails(
		'KNOWN FAILURE (pinned): row[a, b, c], a floated, b to its band, a docked back, b put back',
		() => {
			const tree = row(['a', 'b', 'c']);
			const dock = runSteps(tree, ['~a']);
			expect(dock.autoHideRegion('b')).toBe(true);
			runStep(dock, '^a');
			expect(dock.restoreAutoHidden('b')).toBe(true);
			expect(treeDiff(dock.layout.docked, tree)).toBeNull();
		}
	);
});

describe('the generators (#782 PR1)', () => {
	it('make a valid tree of 3 to 7 panes, splits 1 to 3 deep', () => {
		const depthOf = (n: DockNode): number =>
			n.type === 'split' ? 1 + Math.max(...n.children.map(depthOf)) : 0;
		const seen = new Set<string>();
		fc.assert(
			fc.property(treeRecipe, (recipe) => {
				const tree = buildTree(recipe);
				expect(badSizes(tree)).toEqual([]);
				expect(dockedIds(newDock(tree))).toHaveLength(recipe.panels);
				expect(depthOf(tree)).toBeGreaterThanOrEqual(1);
				expect(depthOf(tree)).toBeLessThanOrEqual(3);
				// The state takes it as it is (nothing normalized away).
				expect(treeDiff(newDock(tree).layout.docked, tree)).toBeNull();
				seen.add(JSON.stringify(shapeOf(tree)));
			}),
			params(300)
		);
		expect(seen.size).toBeGreaterThan(100);
	});
});

// #782 PR7: the docked tree changed from outside (`dock.layout = ...`, made with `core/tree.ts` on
// the docked tree: what `ThreePaneDock`'s `syncPanels` and an app's own assignment do) while panes
// are floated. S follows such an assignment - a pane that left its split releases its share, and
// S is made again from the places it says - so the floated panes still go back.
describe('floated panes: assignments from outside in between (#782 PR7)', () => {
	const OUTSIDE: OpKind[] = ['drop', 'assign', 'assignTab'];

	it('docked panes removed and moved by assignments: every floated pane goes back docked, the sizes are sound', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 4), ops(1, 3), ops(0, 2), (recipe, out, outside, more) => {
				const tree = buildTree(recipe);
				const dock = newDock(tree);
				const steps = [
					...runOps(dock, out, ['float']),
					...runOps(dock, outside, OUTSIDE),
					...runOps(dock, more, ['float', 'move', 'edge', ...OUTSIDE])
				];
				const floated = floatedIds(dock);
				fc.pre(floated.length >= 1);
				for (const id of floated) {
					runStep(dock, `^${id}`);
					steps.push(`^${id}`);
				}
				const left = floated.filter((id) => !dockedIds(dock).includes(id));
				if (left.length > 0) failCase(tree, steps, `not back docked: ${left.join(', ')}`);
				if (dock.layout.floating.length > 0) failCase(tree, steps, 'a window is left');
				const bad = badSizes(dock.layout.docked);
				if (bad.length > 0) failCase(tree, steps, `bad sizes ${bad.join(', ')}`);
			}),
			params(300)
		);
	});

	it('a docked pane removed by an assignment is as one hidden for good (#743): the same tree after the floated panes are back', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 4), ops(1, 3), (recipe, out, drops) => {
				const tree = buildTree(recipe);
				const dock = newDock(tree);
				const steps = [...runOps(dock, out, ['float']), ...runOps(dock, drops, ['drop'])];
				const floated = floatedIds(dock);
				fc.pre(floated.length >= 1 && steps.some((step) => step[0] === '!'));
				const backs = floated.map((id) => `^${id}`);
				const hidden = steps.map((step) => (step[0] === '!' ? `-${step.slice(1)}` : step));
				const diff = treeDiff(
					treeAfter(tree, [...steps, ...backs], false),
					treeAfter(tree, [...hidden, ...backs], false)
				);
				if (diff) failCase(tree, [...steps, ...backs], `not as with ${hidden.join(' ')}: ${diff}`);
			}),
			params(300)
		);
	});

	it('a docked pane moved out of its split by an assignment: the shares of the split it left are as when it is removed', () => {
		fc.assert(
			fc.property(splitTreeRecipe, ops(1, 3), opRecipe, (recipe, out, move) => {
				const tree = buildTree(recipe);
				const dock = newDock(tree);
				const steps = runOps(dock, out, ['float']);
				const step = resolveStep(dock, move, ['assign']);
				fc.pre(step !== null);
				const [id, target] = [step!.split('=>')[0], step!.split('=>')[1].split(':')[0]];
				// Out of its split, and not into one that is made around a sibling of it.
				const parentOf = (pane: string) => findParent(dock.layout.docked, pane)?.id;
				const from = parentOf(id);
				fc.pre(parentOf(id) !== undefined && parentOf(id) !== parentOf(target));
				const floated = floatedIds(dock);
				fc.pre(floated.length >= 1);
				const backs = floated.map((f) => `^${f}`);
				const all = [...steps, step!, ...backs];
				// Which pane left is told by the split still being there (a split of two that is folded
				// around the other one, with the moved pane put next to it, reads either way).
				runStep(dock, step!);
				fc.pre(findNode(dock.layout.docked, from!)?.type === 'split');
				const movedTree = treeAfter(tree, all, false);
				const removedTree = treeAfter(tree, [...steps, `!${id}`, ...backs], false);
				// The split it left (when it is still there, with the same children) is shared as when
				// the pane is removed. Where the floated panes land around the pane's new place is as
				// far as a slot can say it (`inflateShadow`), and the sizes there are the assignment's.
				const sharesOf = (root: DockNode | null): string | null => {
					const node = root && findNode(root, from!);
					if (!node || node.type !== 'split') return null;
					return node.children.map((c, i) => `${c.id}:${node.sizes[i].toFixed(6)}`).join(' ');
				};
				const [got, want] = [sharesOf(movedTree), sharesOf(removedTree)];
				const ids = (text: string) => text.replace(/:[\d.]+/g, '');
				if (got !== null && want !== null && ids(got) === ids(want) && got !== want)
					failCase(tree, all, `the split it left: ${got} != ${want} (with !${id})`);
			}),
			params(300)
		);
	});
});
