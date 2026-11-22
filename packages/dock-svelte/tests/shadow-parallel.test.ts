// #782 PR4: `DockState` keeps the shadow tree S beside its layout. Nothing reads S yet - hiding,
// showing and moving still go by the slots - so what is checked here is that S FOLLOWS: after
// every assignment of `layout`, `projectShadow(S)` is `layout.docked`, whatever was done.
//
// `watchShadow` also tells HOW S followed each assignment (`ShadowFollow`): `same` - the step done
// on S alone shows the tree the slots made -, `written` - only sizes / tabs / flags differed and
// were written onto S -, `rebuilt` - S was made again from the docked tree and the slots. The
// properties below say where the two already agree step by step (`same` always), and the pinned
// cases where they do not are the ones #782 PR5 / PR6 change by letting S decide.
//
// Seeds and counts are fixed as in `slot-properties.test.ts` (`DOCK_PROPERTY_SEED` /
// `DOCK_PROPERTY_RUNS` to look for more).
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
	markAway,
	markPresent,
	projectShadow,
	sameDocked,
	shadowPanelIds,
	writeShadowView,
	type ShadowNode
} from '../src/core/shadow';
import { findNode, removePanel } from '../src/core/tree';
import {
	createDockState,
	shadowStateOf,
	watchShadow,
	type DockState,
	type ShadowFollow
} from '../src/state.svelte';
import type { DockNode, DockSplitNode } from '../src/types';
import {
	buildTree,
	counterMakeId,
	failCase,
	floatedIds,
	hiddenIds,
	newDock,
	opRecipe,
	resolveStep,
	runStep,
	treeRecipe,
	treeText,
	type OpKind,
	type OpRecipe,
	type TreeRecipe
} from './fixtures/dock-properties';

const env =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env.DOCK_PROPERTY_SEED ?? 782);
const RUNS = Number(env.DOCK_PROPERTY_RUNS ?? 0);
if (RUNS) vi.setConfig({ testTimeout: 600_000 });
const params = (numRuns: number): fc.Parameters<unknown> => ({
	seed: SEED,
	numRuns: RUNS || numRuns
});

const panel = (id: string): DockNode => ({ type: 'panel', id, title: id.toUpperCase() });
const split = (id: string, direction: 'row' | 'column', sizes: number[], children: DockNode[]) =>
	({ type: 'split', id, direction, sizes, children }) as DockNode;
const tabs = (id: string, ids: string[], activeIndex = 0) =>
	({ type: 'tabs', id, activeIndex, children: ids.map(panel) }) as DockNode;

/** What is wrong with S as a tree (ids twice, a split with one child, sizes that do not add up ...). */
function badShadow(s: ShadowNode | null): string[] {
	const out: string[] = [];
	const ids = new Set<string>();
	const visit = (node: ShadowNode): void => {
		if (ids.has(node.id)) out.push(`id twice: ${node.id}`);
		ids.add(node.id);
		if (node.type === 'panel') return;
		if (node.type === 'tabs') {
			if (node.children.length === 0) out.push(`empty group: ${node.id}`);
			const active = node.children[node.activeIndex];
			if (!active) out.push(`active tab out of range: ${node.id}`);
			else if (active.away === true && node.children.some((c) => c.away !== true))
				out.push(`active tab is away: ${node.id}`);
			node.children.forEach(visit);
			return;
		}
		if (node.children.length < 2) out.push(`split of ${node.children.length}: ${node.id}`);
		const sum = node.sizes.reduce((a, b) => a + b, 0);
		if (
			node.sizes.length !== node.children.length ||
			node.sizes.some((size) => !(size >= 0)) ||
			Math.abs(sum - 1) > 1e-9
		)
			out.push(`sizes of ${node.id}: ${JSON.stringify(node.sizes)}`);
		node.children.forEach(visit);
	};
	if (s) visit(s);
	return out;
}

/**
 * The one thing S cannot show (`writeShadowView`): the `collapsed` flag of a region that is the
 * only shown child of a split of S. `docked` without those flags.
 */
function withoutLoneFlags(docked: DockNode | null, s: ShadowNode | null): DockNode | null {
	const lone = new Set<string>();
	const visit = (node: ShadowNode): void => {
		if (node.type !== 'split') return;
		const shown = node.children.filter((c) => shadowPanelIds(c, 'shown').length > 0);
		const only = shown.length === 1 ? projectShadow(shown[0]) : null;
		if (only) lone.add(only.id);
		node.children.forEach(visit);
	};
	if (s) visit(s);
	const strip = (node: DockNode): DockNode => {
		if (node.type === 'split') return { ...node, children: node.children.map(strip) };
		if (!lone.has(node.id) || node.collapsed !== true) return node;
		const next = { ...node };
		delete next.collapsed;
		return next;
	};
	return docked && lone.size > 0 ? strip(docked) : docked;
}

/** The panes out of the tree that remember a docked place: hidden (`dockSlot`) and floated (`homeSlot`). */
const pendingIds = (dock: DockState): string[] => [...hiddenIds(dock), ...floatedIds(dock)].sort();

/**
 * What does not hold of S after a step, or `null`: its projection is the docked tree, it is a
 * well-formed tree, and its tombstones are the panes that remember a docked place (but the ones
 * it has no place for).
 */
function notFollowing(dock: DockState): string | null {
	const { shadow, unplaced } = shadowStateOf(dock);
	const seen = projectShadow(shadow);
	if (!sameDocked(seen, withoutLoneFlags(dock.layout.docked, shadow))) {
		return `S shows ${treeText(seen)}`;
	}
	const bad = badShadow(shadow);
	if (bad.length > 0) return `S is not a tree: ${bad.join('; ')}`;
	const away = [...shadowPanelIds(shadow, 'away'), ...unplaced].sort();
	if (JSON.stringify(away) !== JSON.stringify(pendingIds(dock))) {
		return `S remembers ${away.join(',')} of ${pendingIds(dock).join(',')}`;
	}
	return null;
}

/** A state made from `tree`, with every `ShadowFollow` from now on collected in `follows`. */
function watched(tree: DockNode): { dock: DockState; follows: ShadowFollow[] } {
	const dock = newDock(tree);
	const follows: ShadowFollow[] = [];
	watchShadow(dock, (follow) => follows.push(follow));
	return { dock, follows };
}

const first = (node: DockNode | null, type: 'split' | 'tabs'): DockNode | null => {
	if (!node || node.type === 'panel') return null;
	if (node.type === type) return node;
	if (node.type === 'tabs') return null;
	for (const child of node.children) {
		const found = first(child, type);
		if (found) return found;
	}
	return null;
};

/**
 * A change that is not a step of `dock-properties.ts`, picked by `op`: a divider, a tab click, a
 * tab moved, a region collapsed / expanded, a hidden pane opened floating (it forgets its place),
 * a region to a band and back, a save and load, a docked pane dropped by an assignment. Returns
 * it as text (`skip`: nothing to do it to).
 */
function runOther(dock: DockState, op: OpRecipe): string {
	const docked = dock.layout.docked;
	const aSplit = first(docked, 'split') as DockSplitNode | null;
	const group = first(docked, 'tabs');
	const ids = docked ? shadowPanelIds(docked) : [];
	const id = ids.length > 0 ? ids[op.i % ids.length] : undefined;
	switch (op.kind % 9) {
		case 0:
			if (!aSplit) return 'skip';
			dock.resizeSplit(aSplit.id, op.i % (aSplit.children.length - 1), op.r % 2 ? 0.07 : -0.07);
			return `resize ${aSplit.id}`;
		case 1:
			if (group?.type !== 'tabs') return 'skip';
			dock.setActiveTab(group.id, op.i % group.children.length);
			return `tab ${group.id}`;
		case 2:
			if (group?.type !== 'tabs') return 'skip';
			dock.moveTab(group.id, op.i % group.children.length, op.j % group.children.length);
			return `moveTab ${group.id}`;
		case 3: {
			if (!id) return 'skip';
			dock.setDockedCollapsed(id, !dock.isDockedCollapsed(id));
			return `collapse ${id}`;
		}
		case 4: {
			const hidden = hiddenIds(dock);
			if (hidden.length === 0) return 'skip';
			dock.open(hidden[op.i % hidden.length]);
			return `open ${hidden[op.i % hidden.length]}`;
		}
		case 5:
			if (!id || ids.length < 2) return 'skip';
			return `autoHide ${id} ${dock.autoHideRegion(id)}`;
		case 6: {
			const band = dock.autoHidden[0];
			if (!band) return 'skip';
			return `restore ${band.node.id} ${dock.restoreAutoHidden(band.node.id)}`;
		}
		case 7:
			if (!dock.hydrate(dock.serialize())) throw new Error('hydrate refused its own serialize');
			return '@';
		default:
			if (!id || ids.length < 2) return 'skip';
			dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, id) };
			return `drop ${id}`;
	}
}

const ALL: OpKind[] = ['hide', 'show', 'move', 'tab', 'edge', 'float', 'back'];
const ops = (min: number, max: number): fc.Arbitrary<OpRecipe[]> =>
	fc.array(opRecipe, { minLength: min, maxLength: max });

/** Run steps of `kinds`; every one must be followed, and by `same` alone when `exact`. */
const followed = (kinds: OpKind[], exact: boolean) =>
	fc.property(treeRecipe, ops(1, 12), (recipe: TreeRecipe, recipes) => {
		const tree = buildTree(recipe);
		const { dock, follows } = watched(tree);
		const steps: string[] = [];
		for (const op of recipes) {
			const step = resolveStep(dock, op, kinds);
			if (step === null) continue;
			follows.length = 0;
			runStep(dock, step);
			steps.push(step);
			const wrong = notFollowing(dock);
			if (wrong) failCase(tree, steps, wrong);
			const off = follows.find((f) => f.result === 'failed' || (exact && f.result !== 'same'));
			if (off) failCase(tree, steps, `${off.step}: ${off.result}`);
		}
	});

describe('S follows the layout (#782 PR4)', () => {
	it('after every step of any kind, the projection of S is the docked tree', () => {
		fc.assert(followed(ALL, false), params(1500));
	});

	it('with dividers, tabs, bands, saves and assignments between the steps too', () => {
		fc.assert(
			fc.property(treeRecipe, ops(1, 10), ops(10, 10), (recipe: TreeRecipe, recipes, others) => {
				const tree = buildTree(recipe);
				const { dock, follows } = watched(tree);
				const steps: string[] = [];
				recipes.forEach((op, i) => {
					const step = resolveStep(dock, op, ALL);
					if (step !== null) {
						runStep(dock, step);
						steps.push(step);
					}
					const other = runOther(dock, others[i]);
					if (other !== 'skip') steps.push(`(${other})`);
					const wrong = notFollowing(dock);
					if (wrong) failCase(tree, steps, wrong);
					if (follows.some((f) => f.result === 'failed')) failCase(tree, steps, 'failed');
				});
			}),
			params(1500)
		);
	});

	it('asks `makeId` for nothing of its own', () => {
		let calls = 0;
		const dock = createDockState(
			{
				version: 2,
				floating: [],
				docked: split('s', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')])
			},
			() => `gen-${calls++}`
		);
		const follows: ShadowFollow[] = [];
		watchShadow(dock, (follow) => follows.push(follow));
		dock.dockExisting('c', 'b', 'top');
		expect(calls).toBe(1);
		// The new split has the same id in S.
		expect(follows).toEqual([{ step: 'dockExisting', result: 'same' }]);
		dock.dismiss('a');
		dock.dockExistingAtEdge('b', 'left');
		expect(calls).toBe(2);
		dock.show('a');
		dock.undockPanel('c');
		dock.dockPanel('c', 'a', 'center');
		expect(calls).toBe(3);
		expect(notFollowing(dock)).toBe(null);
	});
});

describe('where S and the slots agree step by step (#782 PR4)', () => {
	it('panes hidden, floated, shown and put back in any order: every step on S alone', () => {
		fc.assert(followed(['hide', 'show', 'float', 'back'], true), params(1500));
	});

	it('docked panes moved (side, tab, outer edge) with nothing out of the tree: every step on S alone', () => {
		fc.assert(followed(['move', 'tab', 'edge'], true), params(1000));
	});

	it('panes hidden or floated and docked panes moved to an outer edge: every step on S alone', () => {
		fc.assert(followed(['hide', 'float', 'edge'], true), params(1000));
	});
});

describe('where they do not yet (pinned; #782 PR5 / PR6 let S decide)', () => {
	const run = (tree: DockNode, steps: string[]): { dock: DockState; last: ShadowFollow[] } => {
		const { dock, follows } = watched(tree);
		for (const step of steps) {
			follows.length = 0;
			runStep(dock, step);
			expect(notFollowing(dock), step).toBe(null);
		}
		return { dock, last: follows };
	};

	it('#780: a docked pane moved beside another while panes of its split are out - S is made again', () => {
		// column[row[a, b, c], d, e], a b e hidden, c to the right of d. The slots make
		// `row[d, c]` in the tree that shows; S alone would keep `row[a†, b†]` above it.
		const tree = split(
			's',
			'column',
			[0.4, 0.3, 0.3],
			[
				split('r', 'row', [0.3, 0.3, 0.4], [panel('a'), panel('b'), panel('c')]),
				panel('d'),
				panel('e')
			]
		);
		const { dock, last } = run(tree, ['-a', '-b', '-e', 'c>d:right']);
		// The move itself is the same on S: `row[d, c]` is made around `d`, with the same id.
		expect(last).toEqual([{ step: 'dockExisting', result: 'same' }]);
		let alone = shadowStateOf(dock).shadow;
		const follows: ShadowFollow[] = [];
		watchShadow(dock, (follow) => follows.push(follow));
		for (const id of ['a', 'b', 'e']) {
			dock.show(id);
			alone = markPresent(alone, id);
			expect(notFollowing(dock), id).toBe(null);
		}
		// `a` comes back beside `d` by its slot, above `row[d, c]` in S: S is made again there.
		expect(follows.map((f) => f.result)).toEqual(['rebuilt', 'same', 'same']);
		expect(treeText(dock.layout.docked)).toContain(
			'{"row":[{"column":[{"row":["a","b"]},"d","e"]},"c"]}'
		);
		// The decision of #780, which S alone gives in every order.
		expect(treeText(projectShadow(alone))).toContain(
			'{"column":[{"row":["a","b"]},{"row":["d","c"]},"e"]}'
		);
		// Made again from the slots, every pane out was still accounted for.
		expect(shadowPanelIds(shadowStateOf(dock).shadow, 'away')).toEqual([]);
	});

	it('#845: a pane shown into a split with another still out - the sizes are written onto S', () => {
		// See `split-sizes.test.ts` (KNOWN FAILURE #845). The slots show `d` at .6 of `row[a, d]`;
		// S alone says .2 / .8 and, in the end, .15 / .6 / .25.
		const tree = split(
			's',
			'row',
			[0.15, 0.6, 0.25],
			[
				panel('a'),
				split('in', 'column', [0.3, 0.7], [panel('b'), tabs('t', ['c', 'd'])]),
				panel('e')
			]
		);
		const { dock, last } = run(tree, ['~d', '^d', '~c', '~b']);
		expect(last).toEqual([{ step: 'undockPanel', result: 'same' }]);
		// `!b`: the floated pane is taken out of the layout by an assignment.
		const follows: ShadowFollow[] = [];
		watchShadow(dock, (follow) => follows.push(follow));
		dock.layout = { ...dock.layout, floating: dock.layout.floating.filter((w) => w.id !== 'b') };
		expect(follows).toEqual([{ step: null, result: 'same' }]);
		// From here on, the same marks on a copy of S that nothing is written onto.
		let alone = shadowStateOf(dock).shadow;
		const results: string[] = [];
		for (const step of ['-d', '-e', '+e', '-e', '+d', '+e', '^c']) {
			follows.length = 0;
			runStep(dock, step);
			const id = step.slice(1);
			alone = step[0] === '-' ? markAway(alone, id) : markPresent(alone, id);
			expect(notFollowing(dock), step).toBe(null);
			results.push(`${step} ${follows.map((f) => f.result).join()}`);
		}
		expect(results).toEqual([
			'-d same',
			'-e same',
			'+e same',
			'-e same',
			'+d written',
			'+e same',
			'^c same'
		]);
		const sizes = (node: DockNode | null): number[] => (node?.type === 'split' ? node.sizes : []);
		expect(sizes(dock.layout.docked)[0]).toBeCloseTo(0.3, 9);
		const kept = sizes(projectShadow(alone));
		expect(kept[0]).toBeCloseTo(0.15, 9);
		expect(kept[1]).toBeCloseTo(0.6, 9);
		expect(kept[2]).toBeCloseTo(0.25, 9);
	});
});

describe('changes that move no pane are written onto S (#782 PR4)', () => {
	const row = (): DockNode =>
		split('s', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]);
	const sizesOfRoot = (dock: DockState): number[] => {
		const { shadow } = shadowStateOf(dock);
		return shadow?.type === 'split' ? shadow.sizes : [];
	};

	it('a divider dragged while a pane is out: the pane out keeps its share of S', () => {
		const { dock, follows } = watched(row());
		dock.dismiss('a');
		follows.length = 0;
		dock.resizeSplit('s', 0, 0.1);
		expect(follows).toEqual([{ step: null, result: 'written' }]);
		expect(notFollowing(dock)).toBe(null);
		const sizes = sizesOfRoot(dock);
		expect(sizes[0]).toBeCloseTo(0.2, 9);
		// b .375 + .1 and c .625 - .1 of what shows (.8).
		expect(sizes[1]).toBeCloseTo(0.38, 9);
		expect(sizes[2]).toBeCloseTo(0.42, 9);
	});

	it('`restoreSplitSizes` (a cancelled drag) is written back the same way', () => {
		const { dock } = watched(row());
		dock.dismiss('a');
		const before = dock.layout;
		dock.resizeSplit('s', 0, 0.1);
		dock.restoreSplitSizes('s', before);
		expect(notFollowing(dock)).toBe(null);
		expect(sizesOfRoot(dock)[1]).toBeCloseTo(0.3, 9);
		expect(sizesOfRoot(dock)[2]).toBeCloseTo(0.5, 9);
	});

	it('a tab clicked and a tab moved while a tab is out: the tombstone keeps its index', () => {
		const { dock, follows } = watched(
			split('s', 'row', [0.5, 0.5], [panel('x'), tabs('t', ['a', 'b', 'c', 'd'])])
		);
		dock.dismiss('b');
		follows.length = 0;
		dock.setActiveTab('t', 2);
		dock.moveTab('t', 1, 0);
		expect(follows.map((f) => f.result)).toEqual(['written', 'written']);
		expect(notFollowing(dock)).toBe(null);
		const group = findNode(shadowStateOf(dock).shadow, 't');
		expect(group?.type === 'tabs' && group.children.map((c) => c.id)).toEqual(['c', 'b', 'a', 'd']);
		expect(group?.type === 'tabs' && group.children[group.activeIndex].id).toBe('d');
	});

	it('a region collapsed to a band and expanded', () => {
		const { dock, follows } = watched(row());
		dock.dismiss('a');
		follows.length = 0;
		dock.setDockedCollapsed('b', true);
		expect(follows).toEqual([{ step: null, result: 'written' }]);
		expect(notFollowing(dock)).toBe(null);
		expect(dock.isDockedCollapsed('b')).toBe(true);
		dock.revealDocked('b');
		expect(notFollowing(dock)).toBe(null);
	});

	it('what S cannot hold: the flag of a region that is the only shown child of a split of S', () => {
		// row[x, column[a, b]], a hidden: `b` shows beside `x`, and is collapsed there.
		const { dock, follows } = watched(
			split(
				's',
				'row',
				[0.5, 0.5],
				[panel('x'), split('in', 'column', [0.5, 0.5], [panel('a'), panel('b')])]
			)
		);
		dock.dismiss('a');
		follows.length = 0;
		dock.setDockedCollapsed('b', true);
		expect(dock.isDockedCollapsed('b')).toBe(true);
		// Not written: S is made again, and shows the tree without the flag.
		expect(follows).toEqual([{ step: null, result: 'rebuilt' }]);
		const { shadow } = shadowStateOf(dock);
		expect(sameDocked(projectShadow(shadow), dock.layout.docked)).toBe(false);
		expect(notFollowing(dock)).toBe(null);
		expect(shadowPanelIds(shadow, 'away')).toEqual(['a']);
		dock.setDockedCollapsed('b', false);
		expect(sameDocked(projectShadow(shadowStateOf(dock).shadow), dock.layout.docked)).toBe(true);
	});

	it('a title changed by an assignment', () => {
		const { dock, follows } = watched(row());
		dock.dismiss('a');
		follows.length = 0;
		const docked = dock.layout.docked as DockSplitNode;
		const renamed = { ...docked.children[0], title: 'New' } as DockNode;
		dock.layout = {
			...dock.layout,
			docked: { ...docked, children: [renamed, docked.children[1]] }
		};
		expect(follows).toEqual([{ step: null, result: 'written' }]);
		expect(notFollowing(dock)).toBe(null);
	});
});

describe('what cannot change S does not look at it (review of PR #857)', () => {
	it('a floating window moved, resized, brought to the front, locked, collapsed, closed and opened', () => {
		const { dock, follows } = watched(
			split('s', 'row', [0.2, 0.3, 0.3, 0.2], [panel('a'), panel('b'), panel('c'), panel('d')])
		);
		// A tombstone of each kind (hidden, floated), and a window that never was docked.
		dock.dismiss('a');
		dock.undockPanel('b');
		dock.ensureWindow({ id: 'w', title: 'W' }, 800, 600);
		const before = shadowStateOf(dock);
		follows.length = 0;
		for (let i = 0; i < 20; i++) {
			dock.move('b', 3, 2, 800, 600);
			dock.resize('w', 'se', 4, 4, 800, 600);
			dock.focus(i % 2 ? 'b' : 'w');
		}
		dock.setLocked('w', true);
		dock.setLocked('w', false);
		dock.setCollapsed('b', true);
		dock.setCollapsed('b', false);
		dock.close('w');
		dock.open('w');
		const after = shadowStateOf(dock);
		expect(after.follows).toBe(before.follows);
		expect(after.shadow).toBe(before.shadow);
		expect(follows).toEqual([]);
		expect(notFollowing(dock)).toBe(null);
		// The next change of the tree is followed as ever.
		dock.show('a');
		expect(follows).toEqual([{ step: 'show', result: 'same' }]);
		expect(shadowStateOf(dock).follows).toBe(before.follows + 1);
	});

	it('a floated pane closed and opened again keeps its place (its `homeSlot`)', () => {
		const { dock } = watched(split('s', 'row', [0.5, 0.5], [panel('a'), panel('b')]));
		dock.undockPanel('a');
		const before = shadowStateOf(dock).follows;
		dock.close('a');
		dock.focus('a');
		expect(shadowStateOf(dock).follows).toBe(before);
		expect(shadowPanelIds(shadowStateOf(dock).shadow, 'away')).toEqual(['a']);
	});
});

describe('the panes S remembers (#782 PR4)', () => {
	it('a hidden pane given another docked place by an assignment: S is made again (review of PR #857)', () => {
		const tree = (ids: string[]): DockNode => split('s', 'row', [0.2, 0.3, 0.5], ids.map(panel));
		const { dock, follows } = watched(tree(['a', 'b', 'c']));
		dock.dismiss('a');
		// The slot of `a` as the last pane of the same row.
		const other = newDock(tree(['b', 'c', 'a']));
		other.dismiss('a');
		const slot = other.layout.floating[0].dockSlot;
		const docked = dock.layout.docked;
		follows.length = 0;
		dock.layout = {
			...dock.layout,
			floating: dock.layout.floating.map((w) => (w.id === 'a' ? { ...w, dockSlot: slot } : w))
		};
		// The docked tree and the panes are the same; only where `a` goes back to is not.
		expect(dock.layout.docked).toBe(docked);
		expect(follows).toEqual([{ step: null, result: 'rebuilt' }]);
		expect(shadowPanelIds(shadowStateOf(dock).shadow)).toEqual(['b', 'c', 'a']);
		expect(notFollowing(dock)).toBe(null);
		follows.length = 0;
		dock.show('a');
		expect(shadowPanelIds(dock.layout.docked)).toEqual(['b', 'c', 'a']);
		expect(follows).toEqual([{ step: 'show', result: 'same' }]);
	});

	it('the same slot assigned again as a copy, or with the windows in another order: S is kept', () => {
		const { dock, follows } = watched(
			split('s', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')])
		);
		dock.dismiss('a');
		dock.dismiss('b');
		const before = shadowStateOf(dock).shadow;
		follows.length = 0;
		dock.layout = {
			...dock.layout,
			floating: dock.layout.floating
				.map((w) => ({ ...w, dockSlot: JSON.parse(JSON.stringify(w.dockSlot)) }))
				.reverse()
		};
		expect(follows.filter((f) => f.result === 'rebuilt')).toEqual([]);
		expect(shadowStateOf(dock).shadow).toBe(before);
		expect(notFollowing(dock)).toBe(null);
	});

	it('the same slots with their keys in another order (every level of `outer`): S is kept', () => {
		// Slots two levels deep, and a share written onto S that the slots do not have: an S made
		// again from them would not be the same.
		const { dock, follows } = watched(
			split(
				's',
				'row',
				[0.4, 0.6],
				[
					panel('x'),
					split('in', 'column', [0.2, 0.3, 0.5], [panel('a'), panel('b'), tabs('t', ['c', 'd'])])
				]
			)
		);
		dock.dismiss('a');
		dock.dismiss('d');
		dock.resizeSplit('in', 0, 0.1);
		const before = shadowStateOf(dock).shadow;
		const reversed = (value: unknown): unknown =>
			Array.isArray(value) || value === null || typeof value !== 'object'
				? value
				: Object.fromEntries(
						Object.entries(value)
							.reverse()
							.map(([key, inner]) => [key, reversed(inner)])
					);
		follows.length = 0;
		const floating = dock.layout.floating.map((w) => {
			const dockSlot = reversed(w.dockSlot) as typeof w.dockSlot;
			expect(JSON.stringify(dockSlot)).not.toBe(JSON.stringify(w.dockSlot));
			expect(dockSlot).toEqual(w.dockSlot);
			return { ...w, dockSlot };
		});
		dock.layout = { ...dock.layout, floating };
		expect(follows.filter((f) => f.result === 'rebuilt')).toEqual([]);
		expect(shadowStateOf(dock).shadow).toBe(before);
		expect(notFollowing(dock)).toBe(null);
	});

	const row = (): DockNode =>
		split('s', 'row', [0.2, 0.3, 0.5], [panel('a'), panel('b'), panel('c')]);

	it('a hidden pane opened floating forgets its place: its tombstone leaves S, the others share', () => {
		const { dock } = watched(row());
		dock.dismiss('a');
		dock.open('a');
		const { shadow } = shadowStateOf(dock);
		expect(shadowPanelIds(shadow)).toEqual(['b', 'c']);
		expect(shadow?.type === 'split' && shadow.sizes[0]).toBeCloseTo(0.375, 9);
		expect(notFollowing(dock)).toBe(null);
	});

	it('a layout taken as a whole (`hydrate`) makes S again from its slots', () => {
		const { dock } = watched(row());
		dock.dismiss('a');
		dock.undockPanel('b');
		const loaded = createDockState(dock.serialize(), counterMakeId(100));
		// The floated pane's `homeSlot` is not saved: only the hidden one has a place.
		expect(shadowPanelIds(shadowStateOf(loaded).shadow, 'away')).toEqual(['a']);
		expect(notFollowing(loaded)).toBe(null);
		const follows: ShadowFollow[] = [];
		watchShadow(loaded, (follow) => follows.push(follow));
		loaded.show('a');
		expect(follows).toEqual([{ step: 'show', result: 'same' }]);
	});

	it('a region auto-hidden to a band is not in S (#782 PR8); S is made again around it', () => {
		const { dock, follows } = watched(row());
		dock.dismiss('a');
		follows.length = 0;
		expect(dock.autoHideRegion('b')).toBe(true);
		expect(follows).toEqual([{ step: null, result: 'rebuilt' }]);
		expect(notFollowing(dock)).toBe(null);
		expect(dock.restoreAutoHidden('b')).toBe(true);
		expect(notFollowing(dock)).toBe(null);
	});
});

describe('writeShadowView (#782 PR4)', () => {
	const away = (id: string): ShadowNode => ({ ...panel(id), away: true }) as ShadowNode;
	const s = (): ShadowNode =>
		({
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.2, 0.3, 0.5],
			children: [
				away('a'),
				panel('b'),
				{ type: 'tabs', id: 't', activeIndex: 2, children: [panel('c'), away('d'), panel('e')] }
			]
		}) as ShadowNode;

	it('the same S when the docked tree is its projection', () => {
		const tree = s();
		expect(writeShadowView(tree, projectShadow(tree))).toBe(tree);
		expect(writeShadowView(null, null)).toBe(null);
	});

	it('sizes: the shown children share what they have, the tombstone keeps its share', () => {
		const tree = s();
		const seen = projectShadow(tree) as DockSplitNode;
		const next = writeShadowView(tree, { ...seen, sizes: [0.5, 0.5] });
		const sizes = next?.type === 'split' ? next.sizes : [];
		expect(sizes[0]).toBe(0.2);
		expect(sizes[1]).toBeCloseTo(0.4, 12);
		expect(sizes[2]).toBeCloseTo(0.4, 12);
	});

	it('tabs: the order seen fills the places of the tabs that show, and the active one is found by id', () => {
		const tree = s();
		const seen = projectShadow(tree) as DockSplitNode;
		const group = seen.children[1];
		if (group.type !== 'tabs') throw new Error('not a group');
		const swapped = { ...group, children: [group.children[1], group.children[0]], activeIndex: 1 };
		const next = writeShadowView(tree, { ...seen, children: [seen.children[0], swapped] });
		const t = findNode(next ?? null, 't');
		expect(t?.type === 'tabs' && t.children.map((c) => c.id)).toEqual(['e', 'd', 'c']);
		expect(t?.type === 'tabs' && t.activeIndex).toBe(2);
	});

	it('a group with one shown tab shows as that pane: its `collapsed` flag is the group’s', () => {
		const tree = markAway(s(), 'e');
		const seen = projectShadow(tree) as DockSplitNode;
		const flagged: DockNode = {
			...seen,
			children: [seen.children[0], { ...seen.children[1], collapsed: true } as DockNode]
		};
		const next = writeShadowView(tree, flagged);
		expect(next).not.toBe(undefined);
		const t = findNode(next ?? null, 't');
		expect(t?.type === 'tabs' && t.collapsed).toBe(true);
		expect(sameDocked(projectShadow(next ?? null), flagged)).toBe(true);
	});

	it('`undefined` when the shapes differ: another pane, a pane gone, a pane that is away', () => {
		const tree = s();
		const seen = projectShadow(tree) as DockSplitNode;
		expect(writeShadowView(tree, seen.children[0])).toBe(undefined);
		expect(writeShadowView(tree, { ...seen, children: [panel('x'), seen.children[1]] })).toBe(
			undefined
		);
		const withAway = { ...seen, sizes: [0.2, 0.3, 0.5], children: [panel('a'), ...seen.children] };
		expect(writeShadowView(tree, withAway)).toBe(undefined);
		expect(writeShadowView(tree, null)).toBe(undefined);
		expect(writeShadowView(null, panel('a'))).toBe(undefined);
	});

	it('any docked tree with other sizes, tabs and flags is written onto its S with panes away', () => {
		fc.assert(
			fc.property(treeRecipe, ops(0, 6), ops(4, 4), (recipe: TreeRecipe, outs, others) => {
				const tree = buildTree(recipe);
				// S of a state with panes out, and the docked tree after changes that move no pane.
				const { dock } = watched(tree);
				for (const op of outs) {
					const step = resolveStep(dock, op, ['hide', 'float']);
					if (step !== null) runStep(dock, step);
				}
				const before = shadowStateOf(dock).shadow;
				for (const op of others) runOther(dock, { ...op, kind: op.kind % 3 });
				const next = writeShadowView(before, dock.layout.docked);
				if (next === undefined) failCase(tree, [], `not written: ${treeText(dock.layout.docked)}`);
				if (!sameDocked(projectShadow(next), dock.layout.docked)) failCase(tree, [], 'not shown');
				expect(shadowPanelIds(next, 'away')).toEqual(shadowPanelIds(before, 'away'));
				expect(badShadow(next)).toEqual([]);
			}),
			params(500)
		);
	});
});
