// #782 PR1: the generators and helpers of the property tests (`place-properties.test.ts`).
//
// A case is plain numbers - `TreeRecipe` and `OpRecipe[]` - turned into a tree and into steps
// against the state as it is when the step runs (the n-th docked pane, the n-th hidden one), so
// every generated step can run and fast-check shrinks towards a flat even split and few steps.
// A failure is reported with the tree's shape and the steps as text (`describeCase`), which is
// what goes into a pinned case.
import fc from 'fast-check';
import { autoHiddenPanelIds } from '../../src/core/autohide';
import { collectPanelIds, dockPanelIntoTree, findNode, removePanel } from '../../src/core/tree';
import { createDockState, type DockState } from '../../src/state.svelte';
import type { DockEdge, DockNode, DropRegion } from '../../src/types';
import { shapeOf } from './visibility-sim';

export const EPS = 1e-6;
const SUM_EPS = 1e-9;
const PANEL_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
export const EDGES: DockEdge[] = ['left', 'right', 'top', 'bottom'];
/** The deepest split of a generated tree (the root is 1). */
const MAX_DEPTH = 3;

// ----- trees ---------------------------------------------------------------------------------

export interface TreeRecipe {
	/** Panes, 3 to 7 (`a`, `b`, ...). */
	panels: number;
	/** The root split runs in a column (else a row); the splits inside alternate. */
	column: boolean;
	/** Neighbours may be joined into a tab group (else every pane is a split's child). */
	tabs: boolean;
	/** Read in order by `buildTree`; 0 everywhere = one flat split with even sizes. */
	choices: number[];
}

const recipeOf = (tabs: fc.Arbitrary<boolean>): fc.Arbitrary<TreeRecipe> =>
	fc.record({
		panels: fc.integer({ min: 3, max: PANEL_IDS.length }),
		column: fc.boolean(),
		tabs,
		choices: fc.array(fc.nat({ max: 11 }), { minLength: 40, maxLength: 40 })
	});

/** Any tree: 3 to 7 panes, with or without tab groups. */
export const treeRecipe = recipeOf(fc.boolean());
/** A tree of splits and panes only. */
export const splitTreeRecipe = recipeOf(fc.constant(false));

const panel = (id: string): DockNode => ({ type: 'panel', id, title: id.toUpperCase() });

/**
 * The tree of a recipe: 3 to 7 panes, splits 1 to 3 deep (row and column alternating, sizes
 * normalized from weights 2 to 5), neighbours joined into a tab group (2 or 3 tabs) or a split
 * inside. Split ids are `s1`, `s2`, ... and tab group ids `t1`, ... in the order they are made.
 */
export function buildTree(recipe: TreeRecipe): DockNode {
	let at = 0;
	const next = (max: number): number => (recipe.choices[at++ % recipe.choices.length] ?? 0) % max;
	let splits = 0;
	let groups = 0;
	const build = (ids: string[], column: boolean, depth: number): DockNode => {
		if (ids.length === 1) return panel(ids[0]);
		const id = `s${++splits}`;
		// 1 of 3 gaps joins its two sides into one child (never all of them: a split has 2 or more).
		// Without tab groups, the deepest split takes every pane as its own child.
		const joinable = recipe.tabs || depth < MAX_DEPTH;
		const joins = ids.slice(1).map(() => next(3) === 1 && joinable);
		if (joins.every(Boolean)) joins[next(joins.length)] = false;
		const parts: string[][] = [[ids[0]]];
		ids.slice(1).forEach((p, i) => {
			if (joins[i]) parts[parts.length - 1].push(p);
			else parts.push([p]);
		});
		const children = parts.map((part): DockNode => {
			if (part.length === 1) return panel(part[0]);
			const asTabs = recipe.tabs && (depth >= MAX_DEPTH || (part.length <= 3 && next(3) === 1));
			if (!asTabs) return build(part, !column, depth + 1);
			return {
				type: 'tabs',
				id: `t${++groups}`,
				activeIndex: 0,
				children: part.map(panel)
			} as DockNode;
		});
		// Weights 2 to 5: the smallest share of 7 children is 2/32, above the 5% a slot's size is
		// clamped to (the old slot's minimum share - below it the show order shows, pinned in
		// `place-properties.test.ts`).
		const weights = children.map(() => next(4) + 2);
		const total = weights.reduce((a, b) => a + b, 0);
		return {
			type: 'split',
			id,
			direction: column ? 'column' : 'row',
			sizes: weights.map((w) => w / total),
			children
		};
	};
	return build(PANEL_IDS.slice(0, recipe.panels), recipe.column, 1);
}

// ----- steps ---------------------------------------------------------------------------------

/**
 * One step, by number: `kind` picks what to do among `kinds` of `opRecipe`, `i` / `j` pick the
 * pane and the target among the ones the step can take now, `r` the region or edge.
 */
export interface OpRecipe {
	kind: number;
	i: number;
	j: number;
	r: number;
}

/**
 * `move`: `dockExisting` at a side of another docked pane; `tab`: `dockExisting` into its tab
 * group (`center`); `edge`: `dockExistingAtEdge`; `back`: a floated pane back to its place.
 */
export type OpKind =
	| 'hide'
	| 'show'
	| 'move'
	| 'tab'
	| 'edge'
	| 'float'
	| 'back'
	/** By an assignment from outside: a docked pane removed / moved to a side of another / into its tabs. */
	| 'drop'
	| 'assign'
	| 'assignTab';

export const opRecipe: fc.Arbitrary<OpRecipe> = fc.record({
	kind: fc.nat({ max: 11 }),
	i: fc.nat({ max: 6 }),
	j: fc.nat({ max: 6 }),
	r: fc.nat({ max: 3 })
});

export const counterMakeId = (start = 0): (() => string) => {
	let n = start;
	return () => `gen-${n++}`;
};

/** A state docked as `tree`, which is also its default layout (where a hidden pane comes back). */
export const newDock = (tree: DockNode): DockState => {
	const dock = createDockState({ version: 4, floating: [], docked: tree }, counterMakeId());
	dock.defaultLayout = { version: 4, floating: [], docked: tree };
	return dock;
};

/**
 * A new state made from the saved text alone (what a reload does): nothing but `dock.serialize()`
 * carries over. Its ids for new splits start apart from the saved state's own.
 */
export function loadedFresh(dock: DockState): DockState {
	// Not the same text back: a load normalizes the sizes (the last digits), so the callers compare
	// the trees within `EPS`.
	const fresh = createDockState(dock.serialize(), counterMakeId(10_000));
	// The default layout is not saved: the app gives it again.
	fresh.defaultLayout = dock.defaultLayout;
	return fresh;
}

export const dockedIds = (dock: DockState): string[] => collectPanelIds(dock.layout.docked);

/**
 * The panes of `ids` that are not docked exactly once (floated or hidden - any floating window -,
 * in a band, missing, or twice in the tree), and the docked panes that are not in `ids`. Empty
 * when every pane is back in the dock.
 */
export function notBackInDock(dock: DockState, ids: string[]): string[] {
	const docked = dockedIds(dock);
	const out = new Set([
		...dock.layout.floating.map((w) => w.id),
		...autoHiddenPanelIds(dock.layout)
	]);
	return [
		...ids.filter((id) => docked.filter((d) => d === id).length !== 1 || out.has(id)),
		...docked.filter((d) => !ids.includes(d))
	];
}

/** Fail with the case as text when a pane of `ids` is not back in the dock exactly once. */
export function expectAllDocked(
	dock: DockState,
	ids: string[],
	tree: DockNode,
	steps: string[]
): void {
	const bad = notBackInDock(dock, ids);
	if (bad.length > 0) {
		failCase(tree, steps, `not back docked once: ${[...new Set(bad)].join(', ')}`);
	}
}
/** The panes hidden from the dock (`dockShare`), in the order they were hidden. */
export const hiddenIds = (dock: DockState): string[] =>
	dock.layout.floating.filter((w) => !w.open && w.dockShare !== undefined).map((w) => w.id);
/** The floated panes that remember a docked place (`hasHome`). */
export const floatedIds = (dock: DockState): string[] =>
	dock.layout.floating.filter((w) => w.open && dock.hasHome(w.id)).map((w) => w.id);

/**
 * Run one step as text (the notation of `split-sizes.test.ts`'s `runSteps`, with the moves of a
 * docked pane added): `-x` hide, `+x` show, `~x` float, `^x` back to its place,
 * `x>y:region` `dockExisting`, `x>>edge` `dockExistingAtEdge`, `@` `serialize` / `hydrate`.
 * By an assignment from outside, made on the docked tree with `core/tree.ts` (#782 PR7, what
 * `ThreePaneDock`'s `syncPanels` or an app's `dock.layout = ...` does): `!x` the docked pane `x`
 * removed, `x=>y:region` the docked pane `x` moved to `region` of `y`.
 */
/** Ids for the containers an assignment from outside makes (never one in use). */
let assignedIds = 0;

export function runStep(dock: DockState, step: string): void {
	if (step === '@') {
		if (!dock.hydrate(dock.serialize())) throw new Error('hydrate refused its own serialize');
		return;
	}
	const assigned = /^(\w+)=>(\w+):(\w+)$/.exec(step);
	if (assigned) {
		const node = findNode(dock.layout.docked, assigned[1]);
		if (node?.type !== 'panel') return;
		const docked = dockPanelIntoTree(
			removePanel(dock.layout.docked, node.id),
			node,
			assigned[2],
			assigned[3] as DropRegion,
			() => `asg-${assignedIds++}`
		);
		dock.layout = { ...dock.layout, docked };
		return;
	}
	if (step[0] === '!') {
		dock.layout = { ...dock.layout, docked: removePanel(dock.layout.docked, step.slice(1)) };
		return;
	}
	const edge = /^(\w+)>>(\w+)$/.exec(step);
	if (edge) return dock.dockExistingAtEdge(edge[1], edge[2] as DockEdge);
	const move = /^(\w+)>(\w+):(\w+)$/.exec(step);
	if (move) return dock.dockExisting(move[1], move[2], move[3] as DropRegion);
	const id = step.slice(1);
	if (step[0] === '-') dock.dismiss(id);
	else if (step[0] === '+') dock.show(id);
	else if (step[0] === '~') dock.undockPanel(id);
	else if (step[0] === '^') {
		dock.dockBack(id);
	} else throw new Error(`unknown step ${step}`);
}

export function runSteps(tree: DockNode, steps: string[]): DockState {
	const dock = newDock(tree);
	for (const step of steps) runStep(dock, step);
	return dock;
}

/**
 * The step a recipe stands for in the state as it is now, or `null` when none of `kinds` can
 * run (the step is skipped). At least one pane stays docked; a move needs two docked panes.
 */
export function resolveStep(dock: DockState, op: OpRecipe, kinds: OpKind[]): string | null {
	const docked = dockedIds(dock);
	const hidden = hiddenIds(dock);
	const floated = floatedIds(dock);
	const can = (kind: OpKind): boolean =>
		kind === 'hide' || kind === 'float'
			? docked.length > 1
			: kind === 'move' || kind === 'tab' || kind === 'edge'
				? docked.length > 1
				: kind === 'drop' || kind === 'assign' || kind === 'assignTab'
					? docked.length > 2
					: kind === 'show'
						? hidden.length > 0
						: floated.length > 0;
	const able = kinds.filter(can);
	if (able.length === 0) return null;
	const kind = able[op.kind % able.length];
	const pick = (ids: string[], n: number): string => ids[n % ids.length];
	if (kind === 'hide') return `-${pick(docked, op.i)}`;
	if (kind === 'float') return `~${pick(docked, op.i)}`;
	if (kind === 'show') return `+${pick(hidden, op.i)}`;
	if (kind === 'back') return `^${pick(floated, op.i)}`;
	const id = pick(docked, op.i);
	if (kind === 'drop') return `!${id}`;
	if (kind === 'edge') return `${id}>>${EDGES[op.r % EDGES.length]}`;
	const target = pick(
		docked.filter((d) => d !== id),
		op.j
	);
	const region = kind === 'tab' || kind === 'assignTab' ? 'center' : EDGES[op.r % EDGES.length];
	return `${id}${kind === 'assign' || kind === 'assignTab' ? '=>' : '>'}${target}:${region}`;
}

/** Run the recipes against `dock`, each resolved when it runs. Returns the steps as text. */
export function runOps(dock: DockState, ops: OpRecipe[], kinds: OpKind[]): string[] {
	const steps: string[] = [];
	for (const op of ops) {
		const step = resolveStep(dock, op, kinds);
		if (step === null) continue;
		runStep(dock, step);
		steps.push(step);
	}
	return steps;
}

// ----- comparing -----------------------------------------------------------------------------

/** Every split's sizes, depth first (compared once the shapes are equal). */
export const sizesOf = (node: DockNode | null): number[][] =>
	node?.type === 'split' ? [node.sizes, ...node.children.flatMap(sizesOf)] : [];

/** A split's sizes that are not as they should be: one per child, each above 0, adding up to 1. */
export const badSizes = (node: DockNode | null): string[] =>
	node?.type !== 'split'
		? []
		: [
				...(node.sizes.length !== node.children.length ||
				node.sizes.some((s) => !(s > 0)) ||
				Math.abs(node.sizes.reduce((a, b) => a + b, 0) - 1) > SUM_EPS
					? [`${node.id}: ${JSON.stringify(node.sizes)}`]
					: []),
				...node.children.flatMap(badSizes)
			];

const round = (sizes: number[][]): string =>
	JSON.stringify(sizes.map((s) => s.map((x) => Math.round(x * 1e4) / 1e4)));

/** The tree as text: its shape, then every split's sizes depth first (4 places). */
export const treeText = (node: DockNode | null): string =>
	`${JSON.stringify(shapeOf(node))} ${round(sizesOf(node))}`;

/** What differs between two trees - shape first, then sizes within `EPS` - or `null`. */
export function treeDiff(a: DockNode | null, b: DockNode | null): string | null {
	const sa = JSON.stringify(shapeOf(a));
	const sb = JSON.stringify(shapeOf(b));
	if (sa !== sb) return `shape ${sa} != ${sb}`;
	const za = sizesOf(a);
	const zb = sizesOf(b);
	const same = za.every((s, i) => s.every((x, j) => Math.abs(x - zb[i][j]) < EPS));
	return same ? null : `sizes ${round(za)} != ${round(zb)} of ${sa}`;
}

/** Every order of `ids`. */
export function permutations<T>(ids: T[]): T[][] {
	if (ids.length <= 1) return [ids];
	return ids.flatMap((id, i) =>
		permutations([...ids.slice(0, i), ...ids.slice(i + 1)]).map((rest) => [id, ...rest])
	);
}

/** Fail a property with the case as text: the tree, the steps, what went wrong. */
export function failCase(tree: DockNode, steps: string[], why: string): never {
	throw new Error(`${why}\n  tree:  ${treeText(tree)}\n  steps: ${steps.join(' ')}`);
}
