// Issue #782 PR8b: 端の帯（オートハイド）の区画を影の木 S に墓石として載せる。
//
// 帯へ送った区画は S に残る（`band` の印が付いた墓石。タブの組は組ごと、id も S が持つ）。帯から戻すと
// 元の split / タブの組の、元の取り分へ戻る。浮動の pane や非表示の pane をどの順で戻しても同じ木になる。
// 保存には帯の墓石つきの木（`dockedWithAutoHidden`）を書き、読み込みはその木の射影が `docked` と同じか
// を確かめる。違えば捨て、戻すときは既定の位置、既定が無ければ帯の端へ入る。
//
// ここは性質（fast-check、ADR-0033）と、形を固定した例。S の中身の不変条件は
// `shadow-parallel.test.ts` の `notFollowing` が毎手確かめる（帯の墓石と保存の木も）。
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { regionPanelIds } from '../src/core/autohide';
import { bandTreeOf, readBandTree, shadowBandIds } from '../src/core/bandTree';
import { projectShadow, shadowPanelIds, type ShadowNode } from '../src/core/shadow';
import { EDGE_DOCK_RATIO, collectPanelIds, findNode, findParent } from '../src/core/tree';
import { validateDockLayout } from '../src/core/validate';
import { createDockState, shadowStateOf, type DockState } from '../src/state.svelte';
import { reconcileThreePaneLayout, threePaneDockLayout } from '../src/threePane';
import type {
	DockLayout,
	DockNode,
	DockPanelNode,
	DockSplitNode,
	DockTabGroupNode
} from '../src/types';
import {
	badSizes,
	buildTree,
	counterMakeId,
	dockedIds,
	expectAllDocked,
	failCase,
	floatedIds,
	hiddenIds,
	loadedFresh,
	newDock,
	opRecipe,
	runOps,
	runStep,
	treeDiff,
	treeRecipe,
	type OpRecipe
} from './fixtures/dock-properties';
import { shapeOf } from './fixtures/visibility-sim';

const env =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env.DOCK_PROPERTY_SEED ?? 782);
const RUNS = Number(env.DOCK_PROPERTY_RUNS ?? 0);
if (RUNS) vi.setConfig({ testTimeout: 600_000 });
const params = (numRuns: number): fc.Parameters<unknown> => ({
	seed: SEED,
	numRuns: RUNS || numRuns
});

const ops = (min: number, max: number): fc.Arbitrary<OpRecipe[]> =>
	fc.array(opRecipe, { minLength: min, maxLength: max });

const panel = (id: string): DockPanelNode => ({ type: 'panel', id, title: id.toUpperCase() });
const split = (
	id: string,
	direction: 'row' | 'column',
	sizes: number[],
	children: DockNode[]
): DockSplitNode => ({ type: 'split', id, direction, sizes, children });
const tabs = (id: string, ids: string[], activeIndex = 0): DockTabGroupNode => ({
	type: 'tabs',
	id,
	activeIndex,
	children: ids.map(panel)
});
const layoutOf = (docked: DockNode | null): DockLayout => ({ version: 4, floating: [], docked });
const sizesOf = (dock: DockState, id: string): number[] =>
	(findNode(dock.layout.docked, id) as DockSplitNode).sizes;
const close = (a: number[], b: number[]): void => {
	expect(a.length).toBe(b.length);
	a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
};

/** Every pane of the layout, wherever it is: each must be there once. */
const everyPane = (dock: DockState): string[] =>
	[
		...collectPanelIds(dock.layout.docked),
		...dock.autoHidden.flatMap((entry) => regionPanelIds(entry.node)),
		...dock.layout.floating.map((w) => w.id)
	].sort();

/** Send up to `count` docked regions to their bands (`picks` choose them); the region ids sent. */
function toBands(dock: DockState, picks: number[], count: number, steps: string[]): string[] {
	const sent: string[] = [];
	for (let k = 0; k < count; k++) {
		const docked = dockedIds(dock);
		if (docked.length < 2) break;
		const id = docked[picks[k] % docked.length];
		if (!dock.autoHideRegion(id)) continue;
		// The entry is named by a pane of it: a tab stands for its group.
		sent.push(id);
		steps.push(`(${id} to its band)`);
	}
	return sent;
}

/** What is wrong with the layout as a whole after a step, or `null`. */
function unsound(dock: DockState, all: string[]): string | null {
	const now = everyPane(dock);
	if (JSON.stringify(now) !== JSON.stringify([...all].sort())) return `panes ${now.join(',')}`;
	const saved = validateDockLayout(JSON.parse(dock.serialize()));
	if (!saved.ok) return `not a layout: ${JSON.stringify(saved.issues)}`;
	const { shadow } = shadowStateOf(dock);
	const regions = dock.autoHidden.map((entry) => regionPanelIds(entry.node));
	const held = new Set(shadowBandIds(shadow));
	for (const ids of regions) {
		const n = ids.filter((id) => held.has(id)).length;
		if (n !== 0 && n !== ids.length) return `part of the band of ${ids.join(',')} is in S`;
	}
	return null;
}

describe('regions in the edge bands and floated panes: any order back (#782 PR8b)', () => {
	it('floated panes and up to two regions in their bands, put back in any order: the tree is as it was', () => {
		fc.assert(
			fc.property(
				treeRecipe,
				ops(0, 3),
				fc.array(fc.nat({ max: 6 }), { minLength: 2, maxLength: 2 }),
				fc.array(fc.nat({ max: 1000 }), { minLength: 6, maxLength: 6 }),
				fc.boolean(),
				(recipe, out, picks, order, bandsFirst) => {
					const tree = buildTree(recipe);
					const all = collectPanelIds(tree);
					const dock = newDock(tree);
					const steps: string[] = [];
					let sent: string[] = [];
					// The regions go to their bands before the panes are floated, or after.
					if (bandsFirst) sent = toBands(dock, picks, 2, steps);
					steps.push(...runOps(dock, out, ['float']));
					if (!bandsFirst) sent = toBands(dock, picks, 2, steps);
					fc.pre(sent.length > 0);
					const backs = [
						...floatedIds(dock).map((id) => ({ kind: 'float' as const, id })),
						...sent.map((id) => ({ kind: 'band' as const, id }))
					]
						.map((back, i) => ({ back, key: order[i % order.length], i }))
						.sort((a, b) => a.key - b.key || a.i - b.i)
						.map((x) => x.back);
					for (const back of backs) {
						if (back.kind === 'float') {
							runStep(dock, `^${back.id}`);
							steps.push(`^${back.id}`);
						} else {
							if (!dock.restoreAutoHidden(back.id))
								failCase(tree, steps, `${back.id} not restored`);
							steps.push(`(${back.id} back from its band)`);
						}
						const wrong = unsound(dock, all);
						if (wrong) failCase(tree, steps, wrong);
					}
					expectAllDocked(dock, all, tree, steps);
					const bad = badSizes(dock.layout.docked);
					if (bad.length > 0) failCase(tree, steps, `bad sizes ${bad.join(', ')}`);
					const diff = treeDiff(dock.layout.docked, tree);
					if (diff) failCase(tree, steps, diff);
					// Nothing is left of the bands: no place in S, no tree saved.
					expect(shadowPanelIds(shadowStateOf(dock).shadow, 'away')).toEqual([]);
					expect(dock.layout.dockedWithAutoHidden).toBeUndefined();
				}
			),
			params(400)
		);
	});

	it('two regions in their bands come back to the same tree in either order, also after a save and a load', () => {
		fc.assert(
			fc.property(
				treeRecipe,
				ops(0, 2),
				fc.array(fc.nat({ max: 6 }), { minLength: 2, maxLength: 2 }),
				fc.boolean(),
				(recipe, out, picks, reload) => {
					const tree = buildTree(recipe);
					const make = (): { dock: DockState; sent: string[]; steps: string[] } => {
						const dock = newDock(tree);
						const steps = runOps(dock, out, ['hide']);
						const sent = toBands(dock, picks, 2, steps);
						return { dock: reload ? loadedFresh(dock) : dock, sent, steps };
					};
					const one = make();
					fc.pre(one.sent.length === 2);
					const other = make();
					for (const id of one.sent) expect(one.dock.restoreAutoHidden(id)).toBe(true);
					for (const id of [...other.sent].reverse())
						expect(other.dock.restoreAutoHidden(id)).toBe(true);
					const diff = treeDiff(one.dock.layout.docked, other.dock.layout.docked);
					if (diff) failCase(tree, [...one.steps, reload ? '@' : ''], diff);
					// The hidden panes back too (in the reverse of the order hidden): as it was.
					for (const h of hiddenIds(one.dock).reverse()) runStep(one.dock, `+${h}`);
					const all = treeDiff(one.dock.layout.docked, tree);
					if (all) failCase(tree, [...one.steps, reload ? '@' : ''], all);
				}
			),
			params(300)
		);
	});
});

describe('serialize -> hydrate keeps the places of the edge bands (#782 PR8b)', () => {
	it('a save and a load at any point: every region comes back where it does without one', () => {
		fc.assert(
			fc.property(
				treeRecipe,
				ops(0, 3),
				fc.array(fc.nat({ max: 6 }), { minLength: 2, maxLength: 2 }),
				ops(0, 4),
				fc.nat({ max: 3 }),
				(recipe, out, picks, between, reloadAt) => {
					const tree = buildTree(recipe);
					const all = collectPanelIds(tree);
					// The same steps on two states; one is saved and loaded on the way.
					const run = (reload: boolean): { dock: DockState; steps: string[] } => {
						let dock = newDock(tree);
						const steps = runOps(dock, out, ['hide']);
						const sent = toBands(dock, picks, 2, steps);
						const load = (at: number): void => {
							if (!reload || reloadAt !== at) return;
							dock = loadedFresh(dock);
							steps.push('@');
						};
						load(0);
						// What a user does while the regions are in their bands: hides, shows, moves.
						steps.push(...runOps(dock, between, ['hide', 'show', 'move', 'tab', 'edge']));
						load(1);
						sent.forEach((id, k) => {
							if (dock.isAutoHidden(id)) {
								if (!dock.restoreAutoHidden(id)) failCase(tree, steps, `${id} not restored`);
								steps.push(`(${id} back from its band)`);
							}
							load(2 + k);
							const wrong = unsound(dock, all);
							if (wrong) failCase(tree, steps, wrong);
						});
						return { dock, steps };
					};
					const kept = run(false);
					const loaded = run(true);
					const diff = treeDiff(loaded.dock.layout.docked, kept.dock.layout.docked);
					if (diff) failCase(tree, loaded.steps, diff);
				}
			),
			params(400)
		);
	});

	it('what is saved: no `slot`, the tree with the places only while a band has one, no floated pane in it', () => {
		const dock = newDock(split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)));
		expect('dockedWithAutoHidden' in JSON.parse(dock.serialize())).toBe(false);
		dock.undockPanel('a');
		expect('dockedWithAutoHidden' in JSON.parse(dock.serialize())).toBe(false);
		expect(dock.autoHideRegion('b')).toBe(true);
		const saved = JSON.parse(dock.serialize()) as DockLayout;
		expect(saved.version).toBe(4);
		expect(saved.autoHidden).toEqual([{ node: panel('b'), edge: 'left' }]);
		// `a` floats: its place is not saved, and its share went to the others in proportion.
		const places = saved.dockedWithAutoHidden as Extract<ShadowNode, { type: 'split' }>;
		expect(places).toMatchObject({ type: 'split', id: 'r', direction: 'row' });
		expect(places.children).toEqual([{ ...panel('b'), away: true, band: true }, panel('c')]);
		close(places.sizes, [0.375, 0.625]);
		expect(saved.docked).toEqual(panel('c'));
		expect(dock.restoreAutoHidden('b')).toBe(true);
		expect('dockedWithAutoHidden' in JSON.parse(dock.serialize())).toBe(false);
		expect('autoHidden' in JSON.parse(dock.serialize())).toBe(false);
	});

	// Review of PR #857: a floating window moved, locked or raised changes nothing of S - with a
	// region in a band too, S is not walked for it and the tree saved is the same one.
	it('a floating window changed while a region is in its band: S is not followed again', () => {
		const dock = newDock(split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)));
		dock.undockPanel('a');
		expect(dock.autoHideRegion('b')).toBe(true);
		const { follows, shadow } = shadowStateOf(dock);
		const saved = JSON.stringify(dock.layout.dockedWithAutoHidden);
		dock.setLocked('a', true);
		dock.move('a', 30, 40, 800, 600);
		dock.setCollapsed('a', true);
		expect(shadowStateOf(dock).follows).toBe(follows);
		expect(shadowStateOf(dock).shadow).toBe(shadow);
		expect(JSON.stringify(dock.layout.dockedWithAutoHidden)).toBe(saved);
	});

	it('every docked region in a band (nothing docked): the places are saved, and both come back', () => {
		const dock = newDock(split('r', 'row', [0.3, 0.7], ['a', 'b'].map(panel)));
		expect(dock.autoHideRegion('a')).toBe(true);
		expect(dock.autoHideRegion('b')).toBe(true);
		expect(dock.layout.docked).toBeNull();
		const fresh = loadedFresh(dock);
		expect(fresh.layout.docked).toBeNull();
		expect(shadowBandIds(shadowStateOf(fresh).shadow)).toEqual(['a', 'b']);
		expect(fresh.restoreAutoHidden('b')).toBe(true);
		expect(fresh.layout.docked).toEqual(panel('b'));
		expect(fresh.restoreAutoHidden('a')).toBe(true);
		expect(shapeOf(fresh.layout.docked)).toEqual({ row: ['a', 'b'] });
		close(sizesOf(fresh, 'r'), [0.3, 0.7]);
	});
});

describe('a tab group in an edge band (#782 PR8b)', () => {
	const tree = (): DockNode =>
		split('r', 'row', [0.25, 0.25, 0.5], [tabs('g', ['a', 'b'], 1), panel('c'), panel('d')]);

	it('goes with its id and its active tab, and comes back as the same group at the same share', () => {
		const dock = newDock(tree());
		expect(dock.autoHideRegion('a')).toBe(true);
		expect(dock.autoHidden[0].node).toEqual(tabs('g', ['a', 'b'], 1));
		const s = shadowStateOf(dock).shadow as ShadowNode;
		expect(shadowBandIds(s)).toEqual(['a', 'b']);
		expect((findNode(s as DockNode, 'g') as DockTabGroupNode).children.map((c) => c.id)).toEqual([
			'a',
			'b'
		]);
		close(sizesOf(dock, 'r'), [1 / 3, 2 / 3]);
		// The divider between what is left is dragged meanwhile: the band keeps its quarter.
		dock.resizeSplit('r', 0, 0.2);
		dock.openFlyout('a');
		expect(dock.restoreAutoHidden('g')).toBe(true);
		expect(dock.layout.docked).toMatchObject({ id: 'r', children: [{ id: 'g' }, {}, {}] });
		const group = findNode(dock.layout.docked, 'g') as DockTabGroupNode;
		expect(group.children.map((c) => c.id)).toEqual(['a', 'b']);
		expect(group.activeIndex).toBe(0);
		expect(sizesOf(dock, 'r')[0]).toBeCloseTo(0.25, 9);
	});

	it('a pane hidden from the band leaves the rest of the region its place', () => {
		const dock = newDock(tree());
		expect(dock.autoHideRegion('g')).toBe(true);
		dock.dismiss('a');
		expect(dock.autoHidden.map((e) => e.node)).toEqual([panel('b')]);
		// The share the region holds at its place.
		expect(dock.layout.floating.find((w) => w.id === 'a')?.dockShare).toBeCloseTo(0.25, 9);
		expect(shadowBandIds(shadowStateOf(dock).shadow)).toEqual(['b']);
		expect(dock.restoreAutoHidden('b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['b', 'c', 'd'] });
		close(sizesOf(dock, 'r'), [0.25, 0.25, 0.5]);
		// ... and the hidden pane joins it again at its default place.
		expect(dock.show('a')).toBe('docked');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: [{ tabs: ['a', 'b'] }, 'c', 'd'] });
		close(sizesOf(dock, 'r'), [0.25, 0.25, 0.5]);
	});

	it('panes shown at their default place beside the tabs in the band: the docked tree never holds the band`s id', () => {
		const full = (): DockNode =>
			split('r', 'row', [0.5, 0.5], [tabs('g', ['a', 'b', 'x', 'y']), panel('c')]);
		const dock = newDock(full());
		dock.dismiss('x');
		dock.dismiss('y');
		expect(dock.autoHideRegion('g')).toBe(true);
		expect(dock.show('x')).toBe('docked');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['x', 'c'] });
		expect(dock.show('y')).toBe('docked');
		// Two panes show in the group S keeps for the band: the group keeps its id, the band gets
		// another (the id the group ends with does not depend on what comes back first).
		const shown = findParent(dock.layout.docked, 'x') as DockTabGroupNode;
		expect(shown.type).toBe('tabs');
		expect(shown.id).toBe('g');
		expect(dock.autoHidden[0].node.id).toBe('g:band');
		expect(dock.isAutoHidden('a')).toBe(true);
		expect(validateDockLayout(JSON.parse(dock.serialize())).ok).toBe(true);
		// The region comes back into that group, in default order.
		expect(dock.restoreAutoHidden('a')).toBe(true);
		expect(findParent(dock.layout.docked, 'a')?.id).toBe('g');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: [{ tabs: ['a', 'b', 'x', 'y'] }, 'c'] });
		close(sizesOf(dock, 'r'), [0.5, 0.5]);
		expect(validateDockLayout(JSON.parse(dock.serialize())).ok).toBe(true);
	});
});

// Cross-review of PR #876: two bands made of one tab group share that group of S. The id the
// group has once both are back must not depend on which comes back first.
describe('two bands out of one tab group (#782 PR8b)', () => {
	const tree = (): DockNode =>
		split('r', 'row', [0.6, 0.4], [tabs('T', ['a', 'b', 'c', 'd']), panel('z')]);
	const twoBands = (): DockState => {
		const dock = newDock(tree());
		dock.undockPanel('a');
		dock.undockPanel('b');
		expect(dock.autoHideRegion('c')).toBe(true);
		expect(dock.dockBack('a')).toBe(true);
		expect(dock.dockBack('b')).toBe(true);
		expect(dock.autoHideRegion('a')).toBe(true);
		expect(dock.autoHidden).toHaveLength(2);
		return dock;
	};
	const ids = (dock: DockState): string[] => {
		const out: string[] = [];
		const visit = (node: DockNode | null): void => {
			if (!node) return;
			out.push(node.id);
			if (node.type !== 'panel') node.children.forEach(visit);
		};
		visit(dock.layout.docked);
		for (const entry of dock.autoHidden) visit(entry.node);
		return out;
	};

	it.each([
		[['a', 'c'], false],
		[['c', 'a'], false],
		[['a', 'c'], true],
		[['c', 'a'], true]
	] as [string[], boolean][])(
		'back in the order %j (saved and loaded: %s): the group is T again',
		(order, reload) => {
			let dock = twoBands();
			const load = (): void => {
				if (reload) dock = loadedFresh(dock);
			};
			load();
			for (const id of order) {
				expect(new Set(ids(dock)).size).toBe(ids(dock).length);
				expect(validateDockLayout(JSON.parse(dock.serialize())).ok).toBe(true);
				expect(dock.restoreAutoHidden(id)).toBe(true);
				load();
			}
			const group = findParent(dock.layout.docked, 'a') as DockTabGroupNode;
			expect(group.id).toBe('T');
			expect(group.children.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
			expect((dock.layout.docked as DockSplitNode).children.map((c) => c.id)).toEqual(['T', 'z']);
			close(sizesOf(dock, 'r'), [0.6, 0.4]);
			expect(dock.autoHidden).toEqual([]);
		}
	);
});

describe('a region whose place is gone: the default place, else the edge (#782 PR8b)', () => {
	const tree = (): DockNode =>
		split('r', 'row', [0.2, 0.3, 0.5], [panel('a'), tabs('g', ['b', 'c'], 1), panel('d')]);
	const banded = (): DockLayout => {
		const dock = createDockState(layoutOf(tree()), counterMakeId());
		expect(dock.autoHideRegion('g')).toBe(true);
		return JSON.parse(dock.serialize()) as DockLayout;
	};

	it('a layout read without its tree: each pane docks at its default place', () => {
		const { dockedWithAutoHidden: _, ...bare } = banded();
		const dock = createDockState(JSON.stringify(bare), counterMakeId());
		dock.defaultLayout = layoutOf(tree());
		expect(shadowBandIds(shadowStateOf(dock).shadow)).toEqual([]);
		expect(dock.layout.dockedWithAutoHidden).toBeUndefined();
		expect(shapeOf(dock.previewRestoreAutoHidden('b') ?? null)).toEqual({
			row: ['a', { tabs: ['b', 'c'] }, 'd']
		});
		expect(dock.restoreAutoHidden('b')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', { tabs: ['b', 'c'] }, 'd'] });
		// The default group's id is free again, and the band's active tab shows.
		const group = findNode(dock.layout.docked, 'g') as DockTabGroupNode;
		expect(group.type).toBe('tabs');
		expect(group.activeIndex).toBe(1);
		expect(dock.autoHidden).toEqual([]);
	});

	// Codex P2 / cross-review of PR #876: every pane put at its default place becomes the active
	// tab of its group in turn, so the last one put was left in front.
	it.each([
		[['b', 'c'], 0],
		[['b', 'c'], 1],
		[['b', 'c', 'e'], 0],
		[['b', 'c', 'e'], 1],
		[['b', 'c', 'e'], 2]
	] as [string[], number][])(
		'back at the default places of tabs %j, tab %i in front: the tabs in default order, that tab in front',
		(ids, active) => {
			const defaults = (): DockNode =>
				split('r', 'row', [0.2, 0.3, 0.5], [panel('a'), tabs('g', ids, active), panel('d')]);
			const from = createDockState(layoutOf(defaults()), counterMakeId());
			expect(from.autoHideRegion('g')).toBe(true);
			const { dockedWithAutoHidden: _, ...bare } = JSON.parse(from.serialize()) as DockLayout;
			const dock = createDockState(JSON.stringify(bare), counterMakeId());
			dock.defaultLayout = layoutOf(defaults());
			const preview = dock.previewRestoreAutoHidden('g') ?? null;
			expect(dock.restoreAutoHidden('g')).toBe(true);
			const group = findParent(dock.layout.docked, ids[0]) as DockTabGroupNode;
			expect(group.children.map((c) => c.id)).toEqual(ids);
			expect(group.activeIndex).toBe(active);
			// The preview says the same tree.
			expect(shapeOf(preview)).toEqual(shapeOf(dock.layout.docked));
			expect((findParent(preview, ids[0]) as DockTabGroupNode).activeIndex).toBe(active);
		}
	);

	it('panes of the region whose default places are apart: the tab in front shows where it lands', () => {
		// By default `b` and `c` are in different places; the user had made a group of them.
		const defaults = (): DockNode =>
			split(
				'r',
				'row',
				[0.25, 0.25, 0.25, 0.25],
				[tabs('g', ['a', 'b']), panel('m'), panel('c'), panel('d')]
			);
		const made = (): DockNode =>
			split('r', 'row', [0.4, 0.2, 0.4], [panel('a'), panel('m'), tabs('u', ['b', 'c'], 0)]);
		const from = createDockState(layoutOf(made()), counterMakeId());
		expect(from.autoHideRegion('u')).toBe(true);
		const { dockedWithAutoHidden: _, ...bare } = JSON.parse(from.serialize()) as DockLayout;
		const dock = createDockState(JSON.stringify(bare), counterMakeId());
		dock.defaultLayout = layoutOf(defaults());
		expect(dock.restoreAutoHidden('u')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: [{ tabs: ['a', 'b'] }, 'm', 'c'] });
		// `b` was in front in the band: it is in front of the group it joined.
		const group = findParent(dock.layout.docked, 'b') as DockTabGroupNode;
		expect(group.children[group.activeIndex].id).toBe('b');
	});

	it('no default layout: the region docks along its edge as it is, the group with its id and active tab', () => {
		const { dockedWithAutoHidden: _, ...bare } = banded();
		const dock = createDockState(JSON.stringify(bare), counterMakeId());
		expect(dock.restoreAutoHidden('g')).toBe(true);
		const root = dock.layout.docked as DockSplitNode;
		expect(root.direction).toBe('row');
		expect(root.children.map((c) => c.id)).toEqual(['g', 'r']);
		close(root.sizes, [EDGE_DOCK_RATIO, 1 - EDGE_DOCK_RATIO]);
		expect(root.children[0]).toEqual(tabs('g', ['b', 'c'], 1));
		expect(shapeOf(root.children[1])).toEqual({ row: ['a', 'd'] });
	});

	it('a tree that does not show the docked tree is dropped as a whole, the rest of the layout is read', () => {
		const saved = banded();
		// The docked tree edited by hand: `d` is gone from it, but not from the tree of the places.
		const edited = { ...saved, docked: panel('a') };
		const checked = validateDockLayout(edited);
		expect(checked.ok && 'dockedWithAutoHidden' in checked.layout).toBe(false);
		const dock = createDockState(JSON.stringify(edited), counterMakeId());
		expect(dock.layout.autoHidden).toHaveLength(1);
		expect(dock.layout.dockedWithAutoHidden).toBeUndefined();
		expect(dock.restoreAutoHidden('g')).toBe(true);
		expect((dock.layout.docked as DockSplitNode).children.map((c) => c.id)).toEqual(['g', 'a']);
	});

	it('an assignment from outside that takes the split away: the region has no place any more', () => {
		const dock = newDock(tree());
		expect(dock.autoHideRegion('g')).toBe(true);
		expect(dock.layout.dockedWithAutoHidden).toBeDefined();
		// The row is gone (one pane is left): the place went with it - no guess is made.
		dock.layout = { ...dock.layout, docked: panel('d') };
		expect(shadowBandIds(shadowStateOf(dock).shadow)).toEqual([]);
		expect(dock.layout.dockedWithAutoHidden).toBeUndefined();
		// Its default place: beside `d`, in default order.
		expect(dock.restoreAutoHidden('g')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: [{ tabs: ['b', 'c'] }, 'd'] });
	});

	it('an assignment from outside that leaves the split: the region keeps its place and its share', () => {
		const dock = newDock(tree());
		expect(dock.autoHideRegion('g')).toBe(true);
		const row = dock.layout.docked as DockSplitNode;
		// `ThreePaneDock`'s `syncPanels`: a pane added to the row from outside.
		dock.layout = {
			...dock.layout,
			docked: { ...row, children: [...row.children, panel('z')], sizes: [0.2, 0.4, 0.4] }
		};
		expect(shadowBandIds(shadowStateOf(dock).shadow)).toEqual(['b', 'c']);
		expect(dock.restoreAutoHidden('g')).toBe(true);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', { tabs: ['b', 'c'] }, 'd', 'z'] });
		expect(sizesOf(dock, 'r')[1]).toBeCloseTo(0.3, 9);
	});
});

describe('readBandTree / bandTreeOf (#782 PR8b)', () => {
	const away = (id: string): ShadowNode => ({ ...panel(id), away: true, band: true });
	const floated = (id: string): ShadowNode => ({ ...panel(id), away: true });
	const s = (): ShadowNode => ({
		type: 'split',
		id: 'r',
		direction: 'row',
		sizes: [0.2, 0.3, 0.5],
		children: [panel('a'), away('b'), panel('c')]
	});
	const docked = (): DockNode => projectShadow(s())!;

	it('reads the tree it is given back, with what the docked tree shows written onto it', () => {
		const raw = JSON.parse(JSON.stringify(s())) as unknown;
		expect(readBandTree(raw, docked(), [['b']])).toEqual(s());
		// Titles, and the shares of what shows, are the docked tree's; the band keeps its share.
		const now = split('r', 'row', [0.5, 0.5], [{ ...panel('a'), title: 'Renamed' }, panel('c')]);
		const read = readBandTree(raw, now, [['b']]) as Extract<ShadowNode, { type: 'split' }>;
		expect(read.children[0]).toMatchObject({ id: 'a', title: 'Renamed' });
		close(read.sizes, [0.35, 0.3, 0.35]);
		// Sizes that do not add up to 1 are scaled.
		const loose = { ...s(), sizes: [2, 3, 5] };
		expect(readBandTree(loose, docked(), [['b']])).toEqual(s());
	});

	it('is not read when it does not show the docked tree, or holds what a band does not', () => {
		const cases: [string, unknown, DockNode | null, string[][]][] = [
			[
				'another pane docked',
				s(),
				split('r', 'row', [0.5, 0.5], [panel('a'), panel('z')]),
				[['b']]
			],
			['a pane less docked', s(), panel('a'), [['b']]],
			['another split id', s(), { ...docked(), id: 'other' } as DockNode, [['b']]],
			['nothing docked', s(), null, [['b']]],
			['a pane no band holds', s(), docked(), [['q']]],
			['no band at all', s(), docked(), []],
			[
				'a tombstone that is not marked `band`',
				{ ...s(), children: [panel('a'), floated('b'), panel('c')] },
				docked(),
				[['b']]
			],
			[
				'`band` on a pane that shows',
				{ ...s(), children: [panel('a'), { ...panel('b'), band: true }, panel('c')] },
				split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)),
				[['b']]
			],
			['an id twice', { ...s(), children: [panel('a'), away('a'), panel('c')] }, docked(), [['a']]],
			['sizes of another length', { ...s(), sizes: [0.5, 0.5] }, docked(), [['b']]],
			['a negative size', { ...s(), sizes: [0.5, -0.1, 0.6] }, docked(), [['b']]],
			[
				'a split in a tab group',
				{ type: 'tabs', id: 'g', activeIndex: 0, children: [s()] },
				docked(),
				[['b']]
			],
			['not a tree', 'nonsense', docked(), [['b']]],
			['no tombstone in it', docked(), docked(), [['b']]]
		];
		for (const [name, raw, tree, regions] of cases)
			expect(readBandTree(raw, tree, regions), name).toBeUndefined();
		expect(readBandTree(undefined, docked(), [['b']])).toBeUndefined();
		expect(readBandTree(null, docked(), [['b']])).toBeUndefined();
	});

	// Cross-review of PR #876: a tab group in a band goes back as one group.
	it('a tab group`s tombstones must be tabs of one group of the tree, whatever its id', () => {
		const group = (id: string): ShadowNode => ({
			type: 'tabs',
			id,
			activeIndex: 0,
			children: [away('a') as never, away('b') as never]
		});
		const within = (first: ShadowNode, ...rest: ShadowNode[]): ShadowNode => ({
			type: 'split',
			id: 'r',
			direction: 'row',
			sizes: [first, ...rest, 0].map(() => 1),
			children: [first, ...rest, panel('c')]
		});
		const shown = panel('c');
		expect(shadowBandIds(readBandTree(within(group('g')), shown, [['a', 'b']]) ?? null)).toEqual([
			'a',
			'b'
		]);
		// S gave the group another id (the band's showed twice): still one group.
		expect(readBandTree(within(group('g-2')), shown, [['a', 'b']])).toBeDefined();
		// Apart: two bare panes of a split, in two splits, or in two tab groups.
		expect(readBandTree(within(away('a'), away('b')), shown, [['a', 'b']])).toBeUndefined();
		const apart = within(away('a'), {
			type: 'split',
			id: 'inner',
			direction: 'column',
			sizes: [0.5, 0.5],
			children: [away('b'), panel('d')]
		});
		expect(
			readBandTree(apart, split('r', 'row', [0.5, 0.5], [panel('d'), panel('c')]), [['a', 'b']])
		).toBeUndefined();
		const two = within(
			{
				type: 'tabs',
				id: 'g1',
				activeIndex: 0,
				children: [away('a') as never, away('x') as never]
			},
			{ type: 'tabs', id: 'g2', activeIndex: 0, children: [away('b') as never, away('y') as never] }
		);
		expect(readBandTree(two, shown, [['a', 'b'], ['x'], ['y']])).toBeUndefined();
		// ... while the same panes as regions of their own are fine where they are.
		expect(readBandTree(within(away('a'), away('b')), shown, [['a'], ['b']])).toBeDefined();
	});

	it('reads a tree as deep as the docked tree it is saved with', () => {
		// 80 splits deep, the band's pane at the bottom.
		let deep: ShadowNode = {
			type: 'split',
			id: 's0',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [away('b'), panel('p0')]
		};
		let seen: DockNode = panel('p0');
		for (let i = 1; i < 80; i++) {
			const direction = i % 2 ? 'column' : 'row';
			deep = {
				type: 'split',
				id: `s${i}`,
				direction,
				sizes: [0.5, 0.5],
				children: [deep, panel(`p${i}`)]
			};
			seen = split(`s${i}`, direction, [0.5, 0.5], [seen, panel(`p${i}`)]);
		}
		const raw = JSON.parse(JSON.stringify(deep)) as unknown;
		expect(shadowBandIds(readBandTree(raw, seen, [['b']]) ?? null)).toEqual(['b']);
		const checked = validateDockLayout({
			version: 4,
			floating: [],
			docked: seen,
			autoHidden: [{ node: panel('b'), edge: 'left' }],
			dockedWithAutoHidden: raw
		});
		expect(checked.ok && checked.layout.dockedWithAutoHidden !== undefined).toBe(true);
	});

	it('does not throw on a value that contains itself', () => {
		const loop: Record<string, unknown> = {
			type: 'split',
			id: 'r',
			direction: 'row',
			sizes: [1, 1]
		};
		loop.children = [loop, away('b')];
		expect(readBandTree(loop, docked(), [['b']])).toBeUndefined();
	});

	it('a region only part of which is in the tree has no place: that part is taken out', () => {
		const group: ShadowNode = {
			type: 'split',
			id: 'r',
			direction: 'row',
			sizes: [0.2, 0.3, 0.5],
			children: [away('x'), away('b'), panel('c')]
		};
		// `x` is one of two panes of its region (the other is not in the tree): only `b` is kept.
		const read = readBandTree(group, panel('c'), [['x', 'y'], ['b']]);
		expect(shadowBandIds(read ?? null)).toEqual(['b']);
		expect(
			readBandTree(group, panel('c'), [
				['x', 'y'],
				['b', 'z']
			])
		).toBeUndefined();
	});

	it('bandTreeOf takes the floated panes` places out, and is null without a band', () => {
		const mixed: ShadowNode = {
			type: 'split',
			id: 'r',
			direction: 'row',
			sizes: [0.2, 0.3, 0.5],
			children: [floated('a'), away('b'), panel('c')]
		};
		const tree = bandTreeOf(mixed) as Extract<ShadowNode, { type: 'split' }>;
		expect(tree.children).toEqual([away('b'), panel('c')]);
		close(tree.sizes, [0.375, 0.625]);
		// With no other tombstone it is S itself.
		const same = s();
		expect(bandTreeOf(same)).toBe(same);
		expect(bandTreeOf({ ...mixed, children: [floated('a'), panel('b'), panel('c')] })).toBeNull();
		expect(bandTreeOf(null)).toBeNull();
	});
});

describe('a layout of an earlier version goes back to the default (#782 PR8b)', () => {
	const PANES = { left: { title: 'Tree' }, center: { title: 'Main' }, right: { title: 'Props' } };
	const base = { hostWidth: 1000, panels: PANES };

	it.each([2, 3])('ThreePaneDock: a saved version %i layout is not used', (version) => {
		const now = threePaneDockLayout(base);
		const old = { ...now, version };
		for (const value of [old, { schema: 1, panels: ['left', 'center', 'right'], layout: old }]) {
			const result = reconcileThreePaneLayout(JSON.parse(JSON.stringify(value)), base);
			expect(result.status).toBe('default');
			expect(result.layout).toEqual(now);
		}
		// The same layout written today is restored.
		expect(reconcileThreePaneLayout(now, base).status).toBe('restored');
	});

	it.each([2, 3])(
		'DockState: a version %i layout with a band and its `slot` is refused',
		(version) => {
			const old = {
				version,
				floating: [],
				docked: panel('c'),
				autoHidden: [{ node: panel('b'), edge: 'left', slot: { kind: 'root' } }]
			};
			const dock = createDockState(layoutOf(panel('z')));
			expect(dock.hydrate(JSON.stringify(old))).toBe(false);
			expect(dock.layout.docked).toEqual(panel('z'));
			expect(createDockState(JSON.stringify(old)).layout).toEqual(layoutOf(null));
		}
	);
});
