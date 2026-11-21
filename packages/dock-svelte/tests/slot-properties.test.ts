// #782 PR1: properties of the remembered docked places, over generated trees and steps
// (fast-check, ADR-0033). The cases of `split-sizes.test.ts` / `panel-visibility.test.ts` list
// layouts and orders one by one; these say what holds for every tree and every order, and are
// what the shadow tree of #782 has to pass. Nothing in `src/` is changed by this file.
//
// Each property runs with a fixed seed (`SEED`) and a fixed number of cases, so a run is the same
// every time. A failure prints the seed, the shrunk recipe, and - from `failCase` - the tree and
// the steps as text. To look for more cases: `DOCK_PROPERTY_RUNS=5000 DOCK_PROPERTY_SEED=1 pnpm
// --filter @banto/dock-svelte test slot-properties`.
//
// Known failures are marked `it.fails` with the issue and the smallest case found; each also has
// its case pinned as an ordinary `it.fails` below the property. When one starts to pass (#782
// PR5 / PR6), vitest reports it: take the mark off then.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { collectPanelIds, removePanel } from '../src/core/tree';
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
	notBackInDock,
	newDock,
	opRecipe,
	permutations,
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

/**
 * The docked tree after `steps` - which end with every pane shown -, checked for sizes that do
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

/**
 * Run `out` (steps of `outKinds`), then `moves` (steps of `moveKinds`), then show the hidden
 * panes in every order: the tree is the same for all of them. 2 to 4 panes hidden (24 orders at
 * most).
 */
const sameInAnyShowOrder = (
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
		const hidden = hiddenIds(before);
		fc.pre(hidden.length >= 2 && hidden.length <= 4);
		const [first, ...rest] = permutations(hidden).map((order) => [
			...steps,
			...order.map((id) => `+${id}`)
		]);
		const expected = treeAfter(tree, first, allDocked);
		for (const other of rest) {
			const diff = treeDiff(treeAfter(tree, other, allDocked), expected);
			if (diff) {
				failCase(tree, other, `not as shown ${first.slice(steps.length).join(' ')}: ${diff}`);
			}
		}
	});

/** The trees after `steps` and then the hidden panes `hidden` shown in every order, as text. */
const inEveryOrder = (tree: DockNode, steps: string[], hidden: string[]): string[] => [
	...new Set(
		permutations(hidden).map((order) =>
			treeText(treeAfter(tree, [...steps, ...order.map((id) => `+${id}`)]))
		)
	)
];

const panel = (id: string): DockNode => ({ type: 'panel', id, title: id.toUpperCase() });
const split = (id: string, direction: 'row' | 'column', sizes: number[], children: DockNode[]) =>
	({ type: 'split', id, direction, sizes, children }) as DockNode;
const tabs = (id: string, ids: string[]) =>
	({ type: 'tabs', id, activeIndex: 0, children: ids.map(panel) }) as DockNode;
const even = (n: number): number[] => Array.from({ length: n }, () => 1 / n);
const row = (ids: string[]): DockNode => split('s1', 'row', even(ids.length), ids.map(panel));

describe('show order does not matter (#782 property 1)', () => {
	it('panes hidden, shown in any order (#733)', () => {
		fc.assert(sameInAnyShowOrder(treeRecipe, ['hide'], [], 0), params(300));
	});

	it('then docked panes moved to an outer edge (dockExistingAtEdge), trees without tab groups (#777, #781): the same tree in every order', () => {
		fc.assert(sameInAnyShowOrder(splitTreeRecipe, ['hide'], ['edge'], 2, false), params(300));
	});

	// KNOWN FAILURE (new, found by the check that every pane is back in the dock): when the panes
	// next to the hidden ones are all moved to outer edges, the hidden ones are shown floating, in
	// every order - so the property above holds by every order being wrong the same way. Smallest
	// case: the pinned one below. Whether that is the intended fallback is for #782 to decide.
	it.fails('KNOWN FAILURE: the same, every pane back in the dock', () => {
		fc.assert(sameInAnyShowOrder(splitTreeRecipe, ['hide'], ['edge'], 2), params(300));
	});
	it.fails(
		'KNOWN FAILURE (pinned): row[a, b, c, d, e], a, b and c hidden, d moved to the right edge and e to the left',
		() => {
			const tree = row(['a', 'b', 'c', 'd', 'e']);
			// row[e, d] and a, b, c floating (open), in every order.
			const dock = runSteps(tree, ['-a', '-b', '-c', 'd>>right', 'e>>left', '+a', '+b', '+c']);
			expect(notBackInDock(dock, ['a', 'b', 'c', 'd', 'e'])).toEqual([]);
		}
	);

	// KNOWN FAILURE (new, found by this property): a pane moved out of its tab group to an outer
	// edge is still what its hidden tab mate goes back to, when that mate is shown before the
	// panes of the split around. Smallest case: the pinned one below.
	it.fails('KNOWN FAILURE: then docked panes moved to an outer edge, trees with tab groups', () => {
		fc.assert(sameInAnyShowOrder(treeRecipe, ['hide'], ['edge'], 2, false), params(300));
	});
	it.fails(
		'KNOWN FAILURE (pinned): row[a, tabs[b, c], d], b and d hidden, c moved to the left edge',
		() => {
			const tree = split('s1', 'row', even(3), [panel('a'), tabs('t1', ['b', 'c']), panel('d')]);
			// +d +b: row[tabs[b, c], row[a, d]]; +b +d: row[row[tabs[b, c], d], a].
			expect(inEveryOrder(tree, ['-b', '-d', 'c>>left'], ['b', 'd'])).toHaveLength(1);
		}
	);

	// KNOWN FAILURE (#780, decided in #782: passes with PR6): a pane moved beside another docked
	// pane with `dockExisting`. Smallest case found: the second pinned one below.
	it.fails(
		'KNOWN FAILURE (#780): then docked panes moved beside another (dockExisting at a side)',
		() => {
			fc.assert(sameInAnyShowOrder(splitTreeRecipe, ['hide'], ['move'], 2), params(300));
		}
	);
	it.fails('KNOWN FAILURE (#780, pinned): the case of the issue', () => {
		const tree = split('s1', 'column', even(3), [
			split('s2', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]),
			panel('d'),
			panel('e')
		]);
		// What #782 decided is right, in every order: column[row[a, b], row[d, c], e] - c stays
		// beside d. (Today e first gives this; a or b first gives row[column[row[a, b], d, e], c].)
		// Sizes are the ones e first gives: the column in thirds, a : b as they were (0.2 : 0.3),
		// d and c half each.
		const expected = split('s1', 'column', even(3), [
			split('s2', 'row', [0.4, 0.6], [panel('a'), panel('b')]),
			split('s3', 'row', [0.5, 0.5], [panel('d'), panel('c')]),
			panel('e')
		]);
		const steps = ['-a', '-b', '-e', 'c>d:right'];
		for (const order of permutations(['a', 'b', 'e'])) {
			const all = [...steps, ...order.map((id) => `+${id}`)];
			const diff = treeDiff(treeAfter(tree, all), expected);
			if (diff) failCase(tree, all, diff);
		}
	});
	it.fails(
		'KNOWN FAILURE (#780, pinned): row[a, b, c, d], a and c hidden, b moved to the left of d',
		() => {
			// +c +a: row[b, row[a, c, d]]; +a +c: row[a, c, row[b, d]].
			const tree = row(['a', 'b', 'c', 'd']);
			expect(inEveryOrder(tree, ['-a', '-c', 'b>d:left'], ['a', 'c'])).toHaveLength(1);
		}
	);

	// KNOWN FAILURE (new; #780 reports `center` as the same in every order for its own case): the
	// pane between two hidden ones moved into a tab group - the two come back in the order shown.
	it.fails(
		"KNOWN FAILURE: then docked panes moved into another pane's tab group (dockExisting center)",
		() => {
			fc.assert(sameInAnyShowOrder(splitTreeRecipe, ['hide'], ['tab'], 2), params(300));
		}
	);
	it.fails(
		"KNOWN FAILURE (pinned): row[a, b, c, d], a and c hidden, b moved into d's tab group",
		() => {
			// +c +a: row[c, a, tabs[d, b]]; +a +c: row[a, c, tabs[d, b]].
			const tree = row(['a', 'b', 'c', 'd']);
			expect(inEveryOrder(tree, ['-a', '-c', 'b>d:center'], ['a', 'c'])).toHaveLength(1);
		}
	);

	// KNOWN FAILURE (new): a pane moved to an outer edge and then hidden itself, with a pane hidden
	// before the move.
	it.fails('KNOWN FAILURE: edge moves between the hides (a moved pane may be hidden after)', () => {
		fc.assert(sameInAnyShowOrder(splitTreeRecipe, ['hide', 'hide', 'edge'], [], 0), params(300));
	});
	it.fails(
		'KNOWN FAILURE (pinned): row[a, b, c], a hidden, b moved to the left edge, b hidden',
		() => {
			// +b +a: row[b, row[a, c]]; +a +b: row[a, row[b, c]].
			const tree = row(['a', 'b', 'c']);
			expect(inEveryOrder(tree, ['-a', 'b>>left', '-b'], ['a', 'b'])).toHaveLength(1);
		}
	);

	// KNOWN FAILURE (new): a slot's size is clamped to 5% (`core/slot.ts`'s `MIN_SHARE`), so a pane
	// under 5% of its split comes back at 5% or at its own size by the order. The generated trees
	// keep every share above 5% (`buildTree`'s weights); this is the case left out.
	it.fails('KNOWN FAILURE (pinned): a pane under 5% of its split, hidden with a sibling', () => {
		const weights = [1, 1, 3, 4, 4, 4, 4];
		const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
		const tree = split(
			's1',
			'row',
			weights.map((w) => w / 21),
			ids.map(panel)
		);
		// +a +b: [.0476, .0476, ...] (as it was); +b +a: [.05, .0475, .1425, .19, ...].
		expect(inEveryOrder(tree, ['-a', '-b'], ['a', 'b'])).toHaveLength(1);
	});
});

describe('out and back is the tree as it was (#782 property 2)', () => {
	const roundTrip = (outKinds: OpKind[]) =>
		fc.property(treeRecipe, ops(1, 6), ops(6, 6), (recipe, out, back) => {
			const tree = buildTree(recipe);
			const dock = newDock(tree);
			const steps = runOps(dock, out, outKinds);
			steps.push(...runOps(dock, back, ['show', 'back']));
			// Whatever is still out comes back in the order it left.
			for (const id of hiddenIds(dock)) steps.push(`+${id}`);
			for (const id of floatedIds(dock)) steps.push(`^${id}`);
			const diff = treeDiff(treeAfter(tree, steps), tree);
			if (diff) failCase(tree, steps, diff);
		});

	it('hidden, then shown in any order', () => {
		fc.assert(roundTrip(['hide']), params(300));
	});

	it('hidden or floated, then shown / docked back in any order', () => {
		fc.assert(roundTrip(['hide', 'float']), params(300));
	});
});

describe('a pane moved to an outer edge stays there (#782 property 3)', () => {
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
				const steps = runOps(before, out, ['hide']);
				const docked = dockedIds(before);
				fc.pre(docked.length >= 2);
				const id = docked[pick % docked.length];
				steps.push(`${id}>>${edge}`);
				for (const order of permutations(hiddenIds(before))) {
					const all = [...steps, ...order.map((h) => `+${h}`)];
					const why = notAtEdge(treeAfter(tree, all), id, edge);
					if (why) failCase(tree, all, `${why}: ${treeText(treeAfter(tree, all))}`);
				}
			}
		);

	it('panes hidden at any depth, one docked pane moved to an edge, shown in any order: trees without tab groups (#777, #781)', () => {
		fc.assert(staysAtEdge(splitTreeRecipe), params(300));
	});

	// KNOWN FAILURE (new; the same case as property 1's with tab groups): the hidden tab mate of
	// the moved pane comes back to it at the edge, not to the place of their group.
	it.fails('KNOWN FAILURE: the same with tab groups', () => {
		fc.assert(staysAtEdge(treeRecipe), params(300));
	});
	it.fails(
		'KNOWN FAILURE (pinned): row[a, tabs[b, c], d], a and b hidden, c moved to the left edge',
		() => {
			const tree = split('s1', 'row', even(3), [panel('a'), tabs('t1', ['b', 'c']), panel('d')]);
			// row[tabs[b, c], row[a, d]]: b is at the edge with c, in both orders.
			const root = treeAfter(tree, ['-a', '-b', 'c>>left', '+a', '+b']);
			expect(notAtEdge(root, 'c', 'left')).toBeNull();
		}
	);
});

describe('shares are kept (#782 property 4)', () => {
	it('a docked pane that leaves the layout: the rest is the tree without it, hidden panes included (#743)', () => {
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
			const steps = runOps(dock, out, ['hide']);
			const docked = dockedIds(dock);
			fc.pre(docked.length >= 2);
			const id = docked[pick % docked.length];
			fc.pre(dock.autoHideRegion(id));
			steps.push(`(${id} to its band)`);
			const hidden = hiddenIds(dock);
			const restore = () => {
				expect(dock.restoreAutoHidden(id), 'restoreAutoHidden').toBe(true);
				steps.push(`(${id} back from its band)`);
			};
			if (!restoreLast) restore();
			for (const h of hidden) {
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

	it('a region auto-hidden to a band and put back, then the hidden panes shown: the tree is as it was (#739)', () => {
		fc.assert(bandRoundTrip(false), params(300));
	});

	// KNOWN FAILURE (new): the hidden panes shown while the region is in its band. The band's slot
	// has no `share` (#739), so the region comes back by `size` into a split that has changed.
	it.fails(
		'KNOWN FAILURE: the hidden panes shown first, then the region put back from its band',
		() => {
			fc.assert(bandRoundTrip(true), params(300));
		}
	);
	it.fails(
		'KNOWN FAILURE (pinned): row[a, b, c], a hidden, b to its band, a shown, b put back',
		() => {
			const tree = row(['a', 'b', 'c']);
			const dock = runSteps(tree, ['-a']);
			expect(dock.autoHideRegion('b')).toBe(true);
			runStep(dock, '+a');
			expect(dock.restoreAutoHidden('b')).toBe(true);
			// [1/6, 1/2, 1/3], not thirds.
			expect(treeDiff(dock.layout.docked, tree)).toBeNull();
		}
	);
});

describe('saving and loading changes nothing (#782 property 5)', () => {
	const saveRoundTrip = (allDocked: boolean) =>
		fc.property(treeRecipe, ops(1, 8), fc.nat({ max: 8 }), (recipe, recipes, cut) => {
			const tree = buildTree(recipe);
			const plain = newDock(tree);
			// Not `tab` (the known failure below), nor `float`: a floated pane's `homeSlot` is not
			// saved, by design (`savedLayout`).
			const steps = runOps(plain, recipes, ['hide', 'hide', 'show', 'move', 'edge']);
			const at = cut % (steps.length + 1);
			// Two ways to save and load: back into the same state (`@`), and into a new state
			// made from the saved text alone (`@@`: nothing else carries over), which then goes
			// on with the rest of the steps.
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
				if (allDocked) expectAllDocked(dock, collectPanelIds(tree), tree, text);
				const diff = treeDiff(dock.layout.docked, plain.layout.docked);
				if (diff) failCase(tree, text, `not as without the save: ${diff}`);
			}
		});

	it('serialize / hydrate between any two steps, into the same state and into a new one made from the saved text: the tree, and the tree with every hidden pane shown, are the same as without the save', () => {
		fc.assert(saveRoundTrip(false), params(300));
	});

	// KNOWN FAILURE (new, the same as property 1's "every pane back in the dock"): the same
	// steps, also checking that every pane is back docked after the shows. Without the save the
	// hidden pane is shown floating too, so this is not about the save.
	it.fails('KNOWN FAILURE: the same, every pane back in the dock', () => {
		fc.assert(saveRoundTrip(true), params(300));
	});
	it.fails(
		'KNOWN FAILURE (pinned): row[a, b, c], a hidden, b moved to the left edge, c hidden, a and c shown',
		() => {
			const tree = row(['a', 'b', 'c']);
			// a is shown floating, saved or not.
			const dock = runSteps(tree, ['-a', 'b>>left', '-c', '+a', '+c']);
			expect(notBackInDock(dock, ['a', 'b', 'c'])).toEqual([]);
		}
	);

	// KNOWN FAILURE (new): with `tab` among the steps above the property fails, but seldom (seed
	// 782: not in 1000 cases, in 3000), so only the case is pinned. Without the save `a` goes back
	// into c's tab group - column[b, tabs[c, a]]; after it `show` finds no place and opens `a`
	// floating - column[b, c].
	it.fails(
		"KNOWN FAILURE (pinned): row[a, column[b, c]], b hidden, a moved into c's tab group and hidden, saved and loaded",
		() => {
			const tree = split('s1', 'row', even(2), [
				panel('a'),
				split('s2', 'column', even(2), [panel('b'), panel('c')])
			]);
			const steps = ['-b', 'a>c:center', '-a'];
			const plain = treeAfter(tree, [...steps, '+b', '+a']);
			const loaded = treeAfter(tree, [...steps, '@', '+b', '+a']);
			expect(treeDiff(loaded, plain)).toBeNull();
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
