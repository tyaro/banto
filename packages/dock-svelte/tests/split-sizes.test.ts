// #733: a split's sizes come back whatever order its panes are taken out and put back in. A split
// slot's `size` is the pane's share of the whole split (the panes out of it counted), and
// `restoreDockSlot` scales it up by the share of the ones still out. The walks below run the slot
// functions through the model of `fixtures/visibility-sim.ts`.
//
// #782 PR5: a pane HIDDEN from the dock (`dismiss`) no longer remembers a place - `show` docks it
// at its default place (`default-place.test.ts`, `slot-properties.test.ts`). The slots, and
// every rule here about their shares, now live on only for a pane FLOATED out of the tree
// (`undockPanel` / `dockAtSlot`, its `homeSlot`) and for the edge bands, until #782 PR6 - PR8
// replace them. The rules were the same for hidden and floated panes (#734), so the cases below
// are kept and run through floats: with `createDockState`, "hide" / `-x` / `dismiss` of a docked
// pane is `undockPanel`, and "show" / `+x` / `show` of it is `dockAtSlot` with its `homeSlot`
// (`outByFloat`). What a closed window's saved `dockSlot` did (a reload between the steps, an
// assignment that drops it, old JSON without `share`) has no counterpart - a `homeSlot` is not
// saved - and those cases are gone.
import { describe, expect, it } from 'vitest';
import { captureDockSlot, restoreDockSlot } from '../src/core/slot';
import { collectPanelIds, findNode, removePanel } from '../src/core/tree';
import { deflateShadow } from '../src/core/shadow';
import { createDockState, shadowStateOf, type DockState } from '../src/state.svelte';
import type { DockNode, DockSlot, DropRegion } from '../src/types';
import { keyOf, shapeOf, simStep, type Sim, type SlotImpl } from './fixtures/visibility-sim';

const nowSlot: SlotImpl = { capture: captureDockSlot, restore: restoreDockSlot };
const EPS = 1e-9;

/** A place in the shadow tree: the containers around it, nearest first, and the share held in each split. */
type Place =
	| { kind: 'root' }
	| { kind: 'tab'; groupId: string; outer?: Place }
	| { kind: 'split'; splitId: string; share?: number; outer?: Place };

const placeFrom = (slot: DockSlot): Place => {
	if (slot.kind === 'root') return { kind: 'root' };
	const outer = slot.outer ? { outer: placeFrom(slot.outer) } : {};
	if (slot.kind === 'tab') return { kind: 'tab', groupId: slot.groupId, ...outer };
	const share = slot.share === undefined ? {} : { share: slot.share };
	return { kind: 'split', splitId: slot.splitId, ...share, ...outer };
};

/**
 * The place the pane `id`, floated out of the tree, goes back to (#782 PR7): read off the shadow
 * tree, which holds it - `homeSlot(id)` names that place and is not rewritten when the shares
 * around it change. What the rules of #733 - #743 are about: the split / tab group it is in, and
 * the share of the whole split it holds (the panes out of it counted). `undefined`: the pane
 * remembers no place.
 */
const placeOf = (dock: DockState, id: string): Place | undefined => {
	if (dock.homeSlot(id) === undefined) return undefined;
	const slot = deflateShadow(shadowStateOf(dock).shadow).away.find((a) => a.panel.id === id)?.slot;
	return slot && placeFrom(slot);
};

const panel = (id: string): DockNode => ({ type: 'panel', id, title: id.toUpperCase() });
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
	children: ids.map((i) => ({ type: 'panel' as const, id: i, title: i.toUpperCase() }))
});

/** Every split's sizes, depth first (compared once the shapes are equal). */
const sizesOf = (node: DockNode | null): number[][] =>
	node?.type === 'split' ? [node.sizes, ...node.children.flatMap(sizesOf)] : [];

/** A split's sizes that are not as they should be: one per child, each above 0, adding up to 1. */
const badSizes = (node: DockNode | null): string[] =>
	node?.type !== 'split'
		? []
		: [
				...(node.sizes.length !== node.children.length ||
				node.sizes.some((s) => !(s > 0)) ||
				Math.abs(node.sizes.reduce((a, b) => a + b, 0) - 1) > EPS
					? [`${node.id}: ${JSON.stringify(node.sizes)}`]
					: []),
				...node.children.flatMap(badSizes)
			];

const sameSizes = (a: number[][], b: number[][]): boolean =>
	a.length === b.length &&
	a.every((s, i) => s.length === b[i].length && s.every((x, j) => Math.abs(x - b[i][j]) < 1e-6));

const L: Record<string, () => DockNode> = {
	'row[a,b,c] even': () => split('s', 'row', [1 / 3, 1 / 3, 1 / 3], ['a', 'b', 'c'].map(panel)),
	'row[a,b,c] uneven': () => split('s', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)),
	'column[row[a,b],c]': () =>
		split(
			's',
			'column',
			[0.6, 0.4],
			[split('in', 'row', [0.3, 0.7], ['a', 'b'].map(panel)), panel('c')]
		),
	'row[a,b,c,d]': () => split('s', 'row', [0.1, 0.2, 0.3, 0.4], ['a', 'b', 'c', 'd'].map(panel)),
	'row[a,column[b,c],d]': () =>
		split(
			's',
			'row',
			[0.25, 0.45, 0.3],
			[panel('a'), split('in', 'column', [0.4, 0.6], ['b', 'c'].map(panel)), panel('d')]
		),
	'row[tabs[a,b],c,d]': () =>
		split('s', 'row', [0.5, 0.2, 0.3], [tabs('t', ['a', 'b']), panel('c'), panel('d')]),
	'row[a,column[b,row[c,d]]]': () =>
		split(
			's',
			'row',
			[0.35, 0.65],
			[
				panel('a'),
				split(
					'in',
					'column',
					[0.4, 0.6],
					[panel('b'), split('in2', 'row', [0.7, 0.3], ['c', 'd'].map(panel))]
				)
			]
		)
};

/** Five panes: for the random sequences (every sequence would take too long). */
const L5: Record<string, () => DockNode> = {
	'column[row[a,b,c],row[d,e]]': () =>
		split(
			's',
			'column',
			[0.55, 0.45],
			[
				split('r1', 'row', [0.2, 0.5, 0.3], ['a', 'b', 'c'].map(panel)),
				split('r2', 'row', [0.65, 0.35], ['d', 'e'].map(panel))
			]
		),
	'row[a,column[b,tabs[c,d]],e]': () =>
		split(
			's',
			'row',
			[0.15, 0.6, 0.25],
			[
				panel('a'),
				split('in', 'column', [0.3, 0.7], [panel('b'), tabs('t', ['c', 'd'])]),
				panel('e')
			]
		),
	'row[a,b,c,d,e]': () =>
		split('s', 'row', [0.05, 0.15, 0.2, 0.25, 0.35], ['a', 'b', 'c', 'd', 'e'].map(panel))
};

interface WalkResult {
	/** Sequences that put every pane back. */
	back: number;
	/** ... in the old shape (their sizes are compared). */
	sameShape: number;
	/** Back in the old shape with other sizes (the first few). */
	wrong: string[];
	/** A step that left a split's sizes broken (the first few). */
	broken: string[];
}

/**
 * Every sequence of hide / show steps (with `mixed`, float / back too) up to `maxSteps` steps on
 * `make()`, equal states at the same depth walked once (sizes count in the state here).
 */
function walk(make: () => DockNode, maxSteps: number, mixed = false): WalkResult {
	const ids = collectPanelIds(make());
	const shape = JSON.stringify(shapeOf(make()));
	const sizes = sizesOf(make());
	const key = (sim: Sim) =>
		keyOf(sim) + JSON.stringify(sizesOf(sim.docked).map((s) => s.map((x) => x.toFixed(9))));
	const result: WalkResult = { back: 0, sameShape: 0, wrong: [], broken: [] };
	let level = new Map<string, { sim: Sim; steps: string[] }>([
		['', { sim: { docked: make(), hidden: [], floating: [] }, steps: [] }]
	]);
	for (let depth = 1; depth <= maxSteps; depth++) {
		const next = new Map<string, { sim: Sim; steps: string[] }>();
		for (const { sim, steps } of level.values()) {
			for (const id of ids) {
				const kinds =
					findNode(sim.docked, id)?.type === 'panel'
						? mixed
							? ['-', '~']
							: ['-']
						: sim.hidden.some((h) => h.id === id)
							? ['+']
							: sim.floated?.some((h) => h.id === id)
								? ['^']
								: [];
				for (const kind of kinds) {
					const s = simStep(nowSlot, sim, `${kind}${id}`);
					if (s.floating.length > 0) continue;
					const k = key(s);
					if (next.has(k)) continue;
					const e = { sim: s, steps: [...steps, `${kind}${id}`] };
					next.set(k, e);
					const bad = badSizes(s.docked);
					if (bad.length > 0 && result.broken.length < 5)
						result.broken.push(`${e.steps.join(' ')}: ${bad.join(', ')}`);
					if (s.hidden.length > 0 || (s.floated?.length ?? 0) > 0) continue;
					result.back++;
					if (JSON.stringify(shapeOf(s.docked)) !== shape) continue;
					result.sameShape++;
					if (!sameSizes(sizesOf(s.docked), sizes) && result.wrong.length < 5)
						result.wrong.push(`${e.steps.join(' ')} -> ${JSON.stringify(sizesOf(s.docked))}`);
				}
			}
		}
		level = next;
	}
	return result;
}

/**
 * `dock` with `dismiss` / `show` of a docked pane done as float / back (`undockPanel`, `dockAtSlot`
 * with its `homeSlot`): see the top of this file.
 */
const outByFloat = (dock: DockState): DockState => {
	const dismiss = dock.dismiss.bind(dock);
	const show = dock.show.bind(dock);
	dock.dismiss = (id) => {
		if (findNode(dock.layout.docked, id)?.type === 'panel') dock.undockPanel(id);
		else dismiss(id);
	};
	dock.show = (id) => {
		const slot = dock.homeSlot(id);
		if (slot === undefined) return show(id);
		return dock.dockAtSlot(id, slot) ? 'docked' : 'floating';
	};
	return dock;
};

const counterMakeId = (): (() => string) => {
	let n = 0;
	return () => `gen-${n++}`;
};

/**
 * `-x` hide, `+x` show, `~x` float, `^x` back, `>x:y` dock the floating `x` into `y`'s tabs
 * (`dockPanel`, not back to its place), `*x` open the closed `x` floating (`open`: it forgets its
 * docked place), `@` save and load (`serialize` / `hydrate`: the floated
 * panes' `homeSlot`s are not saved, so they stay floating), with `createDockState`.
 * #741: `>x:y:region` docks the floating `x` at that side of `y` (`left` / `right` / `top` /
 * `bottom`: into `y`'s split when it runs that way), and `!x` takes the floating or hidden `x`
 * out of the layout with an assignment made from today's layout (what `ThreePaneDock`'s
 * `syncPanels` does for a panel removed from `panels`).
 */
const runSteps = (
	make: () => DockNode,
	steps: string[],
	each?: (dock: DockState) => void
): DockState => {
	const dock = outByFloat(
		createDockState({ version: 2, floating: [], docked: make() }, counterMakeId())
	);
	for (const step of steps) {
		each?.(dock);
		const id = step.slice(1);
		if (step === '@') {
			expect(dock.hydrate(dock.serialize()), 'hydrate').toBe(true);
			continue;
		}
		if (step[0] === '-' || step[0] === '~') dock.undockPanel(id);
		else if (step[0] === '*') dock.open(id);
		else if (step[0] === '!')
			dock.layout = { ...dock.layout, floating: dock.layout.floating.filter((w) => w.id !== id) };
		else if (step[0] === '>') {
			const [panelId, target, region] = id.split(':');
			dock.dockPanel(panelId, target, (region ?? 'center') as DropRegion);
		} else {
			const slot = dock.homeSlot(id);
			if (slot) dock.dockAtSlot(id, slot);
		}
	}
	return dock;
};

describe('split sizes come back in any show order (#733)', () => {
	it('row[a,b,c] (thirds): hide a and b, show a then b -> thirds again (was 0.17 / 0.50 / 0.33)', () => {
		const make = L['row[a,b,c] even'];
		for (const order of [
			['a', 'b'],
			['b', 'a']
		]) {
			const dock = runSteps(make, ['-a', '-b', ...order.map((id) => `+${id}`)]);
			expect(shapeOf(dock.layout.docked)).toEqual(shapeOf(make()));
			expect(sameSizes(sizesOf(dock.layout.docked), sizesOf(make())), order.join()).toBe(true);
		}
	});

	it('row[a .2, b .3, c .5]: the first one shown keeps its share against c (a : c = 2 : 5)', () => {
		const dock = runSteps(L['row[a,b,c] uneven'], ['-a', '-b', '+a']);
		const root = dock.layout.docked;
		expect(shapeOf(root)).toEqual({ row: ['a', 'c'] });
		expect(root?.type === 'split' && root.sizes[0] / root.sizes[1]).toBeCloseTo(0.2 / 0.5, 9);
	});

	it('the same through float and back (`undockPanel` / `dockAtSlot`), and float and hide mixed', () => {
		const make = L['row[a,b,c] uneven'];
		for (const steps of ['~a ~b ^a ^b', '~a -b ^a +b', '-a ~b +a ^b', '-b ~a ^a +b']) {
			const dock = runSteps(make, steps.split(' '));
			expect(shapeOf(dock.layout.docked), steps).toEqual(shapeOf(make()));
			expect(sameSizes(sizesOf(dock.layout.docked), sizesOf(make())), steps).toBe(true);
		}
	});

	it('column[row[a,b],c]: the row goes back to its place with its share, its panes with theirs', () => {
		const make = L['column[row[a,b],c]'];
		for (const steps of ['-a -b +a +b', '-a -b +b +a', '-a -c -b +c +a +b', '-b -a -c +a +c +b']) {
			const dock = runSteps(make, steps.split(' '));
			expect(shapeOf(dock.layout.docked), steps).toEqual(shapeOf(make()));
			expect(sameSizes(sizesOf(dock.layout.docked), sizesOf(make())), steps).toBe(true);
		}
	});

	it('a slot taken alone (no other pane out) keeps the size it had: the share of the split', () => {
		const dock = runSteps(L['row[a,b,c] uneven'], ['-b']);
		const slot = dock.homeSlot('b');
		expect(slot?.kind === 'split' && slot.size).toBeCloseTo(0.3, 9);
		expect(slot?.kind === 'split' && slot.share).toBeCloseTo(0.3, 9);
	});

	it('`size` keeps its old meaning (the share of the split then), `share` is of the whole split', () => {
		const dock = runSteps(L['row[a,b,c] uneven'], ['-a', '-b']);
		const slot = dock.homeSlot('b');
		expect(slot?.kind === 'split' && slot.size).toBeCloseTo(0.375, 9);
		expect(slot?.kind === 'split' && slot.share).toBeCloseTo(0.3, 9);
	});

	// Codex P2 on #739: the floated pane's `homeSlot` is not saved, so the hidden pane's `share` is
	// saved without it - shown after a reload it comes back as it would have before #733.
	it('row[a .2, b .3, c .5]: float a, hide b, show b -> b : c = 3 : 5', () => {
		for (const steps of ['~a -b +b']) {
			const dock = runSteps(L['row[a,b,c] uneven'], steps.split(' '));
			expect(shapeOf(dock.layout.docked), steps).toEqual({ row: ['b', 'c'] });
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.375, 0.625]]), steps).toBe(true);
		}
		// The slot keeps the share of the whole row, `a` still counted.
		const dock = runSteps(L['row[a,b,c] uneven'], ['~a', '-b']);
		const slot = dock.homeSlot('b');
		expect(slot?.kind === 'split' && slot.share).toBeCloseTo(0.3, 9);
		// Nothing of it is saved (#782 PR5): what is saved is the layout itself.
		expect(dock.savedLayout()).toEqual(JSON.parse(dock.serialize()));
		expect(dock.savedLayout()).toBe(dock.layout);
	});

	// Codex P2 on #739: a floated pane docked again elsewhere no longer holds its share of the split,
	// so the hidden pane's `share` stops counting it - the same whether shown before or after.
	it('row[a .2, b .3, c .5]: float a, hide b, dock a into c, show b -> b : c = 3 : 5 in either order', () => {
		for (const steps of ['~a -b >a:c +b', '~a -b +b >a:c']) {
			const dock = runSteps(L['row[a,b,c] uneven'], steps.split(' '));
			const root = dock.layout.docked;
			expect(root?.type === 'split' && root.children.map((c) => c.id)[0], steps).toBe('b');
			expect(sameSizes(sizesOf(root), [[0.375, 0.625]]), steps).toBe(true);
		}
		// The hidden pane's slot itself: the share of `row[b,c]` now, the rest of it as it was.
		const before = runSteps(L['row[a,b,c] uneven'], ['~a', '-b']);
		const after = runSteps(L['row[a,b,c] uneven'], ['~a', '-b', '>a:c']);
		const slotOf = (d: DockState) => placeOf(d, 'b');
		expect(slotOf(after)).toEqual({ ...slotOf(before), share: expect.closeTo(0.375, 9) });
		expect(after.homeSlot('a')).toBeUndefined();
	});

	it('a floated pane put back in its place (`dockAtSlot`) keeps its share counted: the old sizes', () => {
		const make = L['row[a,b,c] uneven'];
		for (const steps of ['~a -b ^a +b', '~b -a ^b +a', '-c ~a ^a +c']) {
			const dock = runSteps(make, steps.split(' '));
			expect(shapeOf(dock.layout.docked), steps).toEqual(shapeOf(make()));
			expect(sameSizes(sizesOf(dock.layout.docked), sizesOf(make())), steps).toBe(true);
		}
		// The slot is not touched.
		const before = runSteps(make, ['~a', '-b']);
		const after = runSteps(make, ['~a', '-b', '^a']);
		const slotOf = (d: DockState) => placeOf(d, 'b');
		expect(slotOf(after)).toEqual(slotOf(before));
	});
});

describe('a pane out of the tree that leaves the layout, or goes back into its split elsewhere (#741)', () => {
	const rowOf = (dock: DockState) => {
		const root = dock.layout.docked;
		if (root?.type !== 'split') throw new Error('no split');
		return Object.fromEntries(root.children.map((c, i) => [c.id, root.sizes[i]]));
	};
	const slotOf = placeOf;

	// The third item: an assignment made from today's layout that drops a pane out of the tree
	// (`ThreePaneDock`'s `syncPanels` for a panel removed from `panels`, `replaceLayout` without
	// `saved`): it no longer holds its share, whether it was floated or hidden.
	it('row[a .2, b .3, c .5]: a out, b hidden, a taken out of the layout, show b -> b : c = 3 : 5', () => {
		for (const steps of ['~a -b !a +b', '-a -b !a +b', '-b ~a !a +b', '~a -b +b !a']) {
			const dock = runSteps(L['row[a,b,c] uneven'], steps.split(' '));
			expect(shapeOf(dock.layout.docked), steps).toEqual({ row: ['b', 'c'] });
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.375, 0.625]]), steps).toBe(true);
			expect(dock.layout.floating, steps).toEqual([]);
		}
		// A floated pane still there keeps its place, its share taken without the one removed.
		const dock = runSteps(L['row[a,b,c,d]'], ['~a', '-b', '~c', '!a']);
		expect(dock.homeSlot('a')).toBeUndefined();
		const home = slotOf(dock, 'c');
		expect(home?.kind === 'split' && home.share).toBeCloseTo(0.3 / 0.9, 9);
		const hidden = slotOf(dock, 'b');
		expect(hidden?.kind === 'split' && hidden.share).toBeCloseTo(0.2 / 0.9, 9);
		dock.show('b');
		dock.dockAtSlot('c', dock.homeSlot('c')!);
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['b', 'c', 'd'] });
		expect(sameSizes(sizesOf(dock.layout.docked), [[2 / 9, 3 / 9, 4 / 9]])).toBe(true);
	});

	// The second item: a floated pane docked again into the split it left, at another place
	// (`dockPanel`, a drop on a side of a pane of that split - not `dockAtSlot`). A `share` is of the
	// whole split, the panes out of it counted. The split has the pane again - at the size
	// `dockPanel` gives it (it evens the split), not the share it left with - so the shares of the
	// panes still out are still of the whole split: each comes back at its own share, the panes in
	// the split scaled around it. Nothing is counted twice and nothing is left counted for a pane
	// that is not coming, so the slots are left as they are.
	it('row[a .1, b .2, c .3, d .4]: float a, hide b, dock a beside d, show b -> b takes .2 of the row', () => {
		const make = L['row[a,b,c,d]'];
		for (const steps of ['~a -b >a:d:right +b', '-b ~a >a:d:right +b', '~a -b >a:c:left +b']) {
			const before = runSteps(make, steps.split(' ').slice(0, 3));
			const dock = runSteps(make, steps.split(' '));
			const was = rowOf(before);
			const now = rowOf(dock);
			expect(Object.keys(now).sort(), steps).toEqual(['a', 'b', 'c', 'd']);
			expect(now.b, steps).toBeCloseTo(0.2, 9);
			// The panes that were in the row keep their sizes against each other.
			for (const id of ['a', 'c', 'd']) expect(now[id], steps).toBeCloseTo(was[id] * 0.8, 9);
		}
		// The hidden pane's slot is not touched by the dock ...
		expect(slotOf(runSteps(make, ['~a', '-b', '>a:d:right']), 'b')).toEqual(
			slotOf(runSteps(make, ['~a', '-b']), 'b')
		);
		// ... and two hidden panes come back at their own shares, in either order.
		// (Five panes, .05 / .15 / .2 / .25 / .35: two stay docked, so the row itself stays.)
		const five = L5['row[a,b,c,d,e]'];
		for (const steps of ['~a -b -c >a:d:right +b +c', '~a -b -c >a:d:right +c +b']) {
			const now = rowOf(runSteps(five, steps.split(' ')));
			expect(now.b, steps).toBeCloseTo(0.15, 9);
			expect(now.c, steps).toBeCloseTo(0.2, 9);
			expect(now.a, steps).toBeCloseTo(now.d, 9);
		}
		// One of them shown before the dock: the one after it still takes its share of the row.
		const mixed = rowOf(runSteps(five, '~a -b -c +b >a:d:right +c'.split(' ')));
		expect(mixed.c).toBeCloseTo(0.2, 9);
	});

	it('docked out of the split instead (below d, into its tabs): b takes its share of row[b,c,d]', () => {
		const make = L['row[a,b,c,d]'];
		for (const steps of ['~a -b >a:d:bottom +b', '~a -b >a:c:center +b', '~a -b +b >a:d:bottom']) {
			const root = runSteps(make, steps.split(' ')).layout.docked;
			expect(root?.type === 'split' && root.sizes, steps).toEqual([
				expect.closeTo(2 / 9, 9),
				expect.closeTo(3 / 9, 9),
				expect.closeTo(4 / 9, 9)
			]);
		}
	});
});

// #743: a DOCKED pane that leaves a split panes are out of (hidden: a closed window's `dockSlot`;
// floated: a `homeSlot`). A `share` is of the whole split, the panes out of it counted (#733): the
// one that left is no longer counted, so the panes still out come back at their share of what is
// left - its part goes to all the others (docked and out) in proportion.
describe('a docked pane that leaves a split panes are out of (#743)', () => {
	const uneven = L['row[a,b,c] uneven'];
	const four = L['row[a,b,c,d]'];
	const slotOf = placeOf;
	const shareOf = (slot: Place | undefined) => (slot?.kind === 'split' ? slot.share : undefined);
	/** The sizes of the split that holds the pane `id`, by child (a tab group / split: its id). */
	const around = (dock: DockState, id: string): Record<string, number> => {
		const find = (n: DockNode | null): Extract<DockNode, { type: 'split' }> | null => {
			if (n?.type !== 'split') return null;
			if (n.children.some((c) => c.id === id)) return n;
			for (const c of n.children) {
				const hit = find(c);
				if (hit) return hit;
			}
			return null;
		};
		const parent = find(dock.layout.docked);
		if (!parent) throw new Error(`${id} is not a child of a split`);
		return Object.fromEntries(parent.children.map((c, i) => [c.id, parent.sizes[i]]));
	};
	/** An assignment made from today's layout without the docked panes `ids` (`syncPanels`). */
	const take = (dock: DockState, ...ids: string[]) => {
		dock.layout = {
			...dock.layout,
			docked: ids.reduce((t, id) => removePanel(t, id), dock.layout.docked)
		};
	};

	describe('the ways out', () => {
		it('row[a .2, b .3, c .5]: b hidden, a removed by an assignment, show b -> .375 / .625 (was .3 / .7)', () => {
			const dock = runSteps(uneven, ['-b']);
			expect(shareOf(slotOf(dock, 'b'))).toBeCloseTo(0.3, 9);
			take(dock, 'a');
			expect(shareOf(slotOf(dock, 'b'))).toBeCloseTo(0.375, 9);
			dock.show('b');
			expect(shapeOf(dock.layout.docked)).toEqual({ row: ['b', 'c'] });
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.375, 0.625]])).toBe(true);
		});

		it('the same for a floated pane (its homeSlot)', () => {
			const floated = runSteps(uneven, ['~b']);
			take(floated, 'a');
			expect(shareOf(slotOf(floated, 'b'))).toBeCloseTo(0.375, 9);
			expect(floated.dockAtSlot('b', floated.homeSlot('b')!)).toBe(true);
			expect(sameSizes(sizesOf(floated.layout.docked), [[0.375, 0.625]])).toBe(true);
		});

		it('replaced: a removed and another pane added (closed) by the same assignment', () => {
			const dock = runSteps(uneven, ['-b']);
			dock.layout = {
				...dock.layout,
				docked: removePanel(dock.layout.docked, 'a'),
				floating: [
					...dock.layout.floating,
					{ id: 'z', title: 'Z', x: 0, y: 0, width: 200, height: 100, open: false }
				]
			};
			dock.show('b');
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.375, 0.625]])).toBe(true);
		});

		// row[a .1, b .2, c .3, d .4], b hidden: a's part of the whole row is .1.
		for (const [name, leave] of [
			['removed by an assignment', (d: DockState) => take(d, 'a')],
			[
				'docked below d (dockExisting, another split)',
				(d: DockState) => d.dockExisting('a', 'd', 'bottom')
			],
			[
				'docked into the tabs of c (dockExisting)',
				(d: DockState) => d.dockExisting('a', 'c', 'center')
			],
			[
				'docked at an outer edge (dockExistingAtEdge)',
				(d: DockState) => d.dockExistingAtEdge('a', 'bottom')
			],
			[
				'docked at the outer edge the row runs to',
				(d: DockState) => d.dockExistingAtEdge('a', 'right')
			]
		] as const) {
			it(`row[a .1, b .2, c .3, d .4], b hidden, a ${name}: b comes back at 2/9 of the row`, () => {
				const dock = runSteps(four, ['-b']);
				leave(dock);
				expect(shareOf(slotOf(dock, 'b')), 'the slot').toBeCloseTo(2 / 9, 9);
				dock.show('b');
				const now = around(dock, 'b');
				expect(Object.keys(now).length).toBe(3);
				expect(now.b).toBeCloseTo(2 / 9, 9);
				expect(badSizes(dock.layout.docked)).toEqual([]);
			});
		}

		it('two panes out (one hidden, one floated): both are taken without the one that left', () => {
			const dock = runSteps(four, ['-b', '~c']);
			dock.dockExisting('a', 'd', 'bottom');
			expect(shareOf(slotOf(dock, 'b'))).toBeCloseTo(0.2 / 0.9, 9);
			expect(shareOf(slotOf(dock, 'c'))).toBeCloseTo(0.3 / 0.9, 9);
			dock.show('b');
			dock.dockAtSlot('c', dock.homeSlot('c')!);
			const now = around(dock, 'b');
			expect(now.b).toBeCloseTo(2 / 9, 9);
			expect(now.c).toBeCloseTo(3 / 9, 9);
		});

		it('a split of two: the one that moves out leaves it (the split itself is gone then)', () => {
			// row[a .2, b .3, c .5], b hidden, a below c: column[c, a]; b comes back beside c.
			for (const region of ['bottom', 'center'] as const) {
				const dock = runSteps(uneven, ['-b']);
				dock.dockExisting('a', 'c', region);
				expect(shareOf(slotOf(dock, 'b')), region).toBeCloseTo(0.375, 9);
				dock.show('b');
				expect(around(dock, 'b').b, region).toBeCloseTo(0.375, 9);
			}
		});

		it('a pane out of the tree and a docked one taken away by the same assignment', () => {
			// b .2 and c .3 hidden; c's window and the docked a (.1) go: b : d = .2 : .4.
			const dock = runSteps(four, ['-b', '-c']);
			dock.layout = {
				...dock.layout,
				docked: removePanel(dock.layout.docked, 'a'),
				floating: dock.layout.floating.filter((w) => w.id !== 'c')
			};
			expect(shareOf(slotOf(dock, 'b'))).toBeCloseTo(1 / 3, 9);
			dock.show('b');
			expect(sameSizes(sizesOf(dock.layout.docked), [[1 / 3, 2 / 3]])).toBe(true);
		});

		it('a pane back in the split and a docked one taken away by the same assignment (#743 review)', () => {
			// b .2 and c .3 hidden; c goes back and the docked a (.1) goes: as one after the other.
			const steps = runSteps(four, ['-b', '-c', '+c']);
			const tree = removePanel(steps.layout.docked, 'a');
			take(steps, 'a');
			expect(shareOf(slotOf(steps, 'b')), 'one by one').toBeCloseTo(0.2 / 0.9, 9);
			const dock = runSteps(four, ['-b', '-c']);
			dock.layout = {
				...dock.layout,
				docked: tree,
				floating: dock.layout.floating.filter((w) => w.id !== 'c')
			};
			expect(shareOf(slotOf(dock, 'b')), 'at once').toBeCloseTo(0.2 / 0.9, 9);
			steps.show('b');
			dock.show('b');
			expect(around(dock, 'b').b).toBeCloseTo(2 / 9, 9);
			expect(sameSizes(sizesOf(dock.layout.docked), sizesOf(steps.layout.docked))).toBe(true);
		});
	});

	describe('nested splits', () => {
		const nested = (): DockNode =>
			split(
				's',
				'column',
				[0.5, 0.2, 0.3],
				[split('r', 'row', [0.3, 0.7], ['a', 'b'].map(panel)), panel('d'), panel('e')]
			);

		it('the outer split (a slot outer): column[row[a,b] .5, d .2, e .3], a and b hidden, d removed', () => {
			const dock = runSteps(nested, ['-a', '-b']);
			take(dock, 'd');
			dock.show('b');
			expect(shapeOf(dock.layout.docked)).toEqual({ column: ['b', 'e'] });
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.625, 0.375]])).toBe(true);
			dock.show('a');
			expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'e'] });
			expect(
				sameSizes(sizesOf(dock.layout.docked), [
					[0.625, 0.375],
					[0.3, 0.7]
				])
			).toBe(true);
		});

		it('the same when a is shown first', () => {
			const dock = runSteps(nested, ['-a', '-b']);
			take(dock, 'd');
			dock.show('a');
			dock.show('b');
			expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'e'] });
			expect(
				sameSizes(sizesOf(dock.layout.docked), [
					[0.625, 0.375],
					[0.3, 0.7]
				])
			).toBe(true);
		});

		it('the last docked pane of a split that is gone: column[row[a .2, b .3, c .5], d], a and b hidden, c removed', () => {
			const make = () =>
				split(
					's',
					'column',
					[0.6, 0.4],
					[split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('d')]
				);
			const dock = runSteps(make, ['-a', '-b']);
			expect(shapeOf(dock.layout.docked)).toEqual({ column: ['c', 'd'] });
			take(dock, 'c');
			dock.show('a');
			dock.show('b');
			expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'b'] }, 'd'] });
			expect(
				sameSizes(sizesOf(dock.layout.docked), [
					[0.6, 0.4],
					[0.4, 0.6]
				])
			).toBe(true);
		});

		// column[row[a .2, b .3, c .5] .5, d .2, e .3]: a and b hidden, the row is gone and c is all
		// that is left of it. c moved away has left it as c removed has (cross-review P2 on #743).
		const lone = () =>
			split(
				's',
				'column',
				[0.5, 0.2, 0.3],
				[split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('d'), panel('e')]
			);
		const outerShareOf = (slot: Place | undefined) =>
			slot && slot.kind !== 'root' ? shareOf(slot.outer) : undefined;
		for (const [name, leave, shape] of [
			[
				'docked into the tabs of d (dockExisting)',
				(d: DockState) => d.dockExisting('c', 'd', 'center'),
				{ column: [{ row: ['a', 'b'] }, { tabs: ['d', 'c'] }, 'e'] }
			],
			[
				'docked beside d (dockExisting, another split)',
				(d: DockState) => d.dockExisting('c', 'd', 'right'),
				{ column: [{ row: ['a', 'b'] }, { row: ['d', 'c'] }, 'e'] }
			],
			[
				'docked at an outer edge (dockExistingAtEdge)',
				(d: DockState) => d.dockExistingAtEdge('c', 'bottom'),
				{ column: [{ column: [{ row: ['a', 'b'] }, 'd', 'e'] }, 'c'] }
			],
			[
				'docked at the outer edge the row ran to',
				(d: DockState) => d.dockExistingAtEdge('c', 'right'),
				{ row: [{ column: [{ row: ['a', 'b'] }, 'd', 'e'] }, 'c'] }
			]
		] as const) {
			it(`the last docked pane of a split that is gone, ${name}: a and b at .4 / .6 (#743 review)`, () => {
				const dock = runSteps(lone, ['-a', '-b']);
				expect(shapeOf(dock.layout.docked)).toEqual({ column: ['c', 'd', 'e'] });
				leave(dock);
				expect(shareOf(slotOf(dock, 'a')), 'the slot of a').toBeCloseTo(0.4, 9);
				expect(shareOf(slotOf(dock, 'b')), 'the slot of b').toBeCloseTo(0.6, 9);
				dock.show('a');
				dock.show('b');
				// The row is back at its own place in the column, not around c where it went.
				expect(shapeOf(dock.layout.docked)).toEqual(shape);
				expect(badSizes(dock.layout.docked)).toEqual([]);
				const row = around(dock, 'a');
				expect(row.a).toBeCloseTo(0.4, 9);
				expect(row.b).toBeCloseTo(0.6, 9);
				const column = around(dock, 'e');
				expect(Object.values(column)[0]).toBeCloseTo(0.5, 9);
				expect(column.e).toBeCloseTo(0.3, 9);
			});
		}

		it('the same with a pane out of the split around it: the slots are as when c is removed (#743 review)', () => {
			const removed = runSteps(lone, ['-a', '-b', '-e']);
			take(removed, 'c');
			for (const leave of [
				(d: DockState) => d.dockExisting('c', 'd', 'center'),
				(d: DockState) => d.dockExistingAtEdge('c', 'bottom')
			]) {
				const dock = runSteps(lone, ['-a', '-b', '-e']);
				leave(dock);
				for (const id of ['a', 'b', 'e']) {
					const [got, want] = [slotOf(dock, id), slotOf(removed, id)];
					expect(shareOf(got), `the share of ${id}`).toBeCloseTo(shareOf(want)!, 9);
					if (id !== 'e')
						expect(outerShareOf(got), `the outer share of ${id}`).toBeCloseTo(
							outerShareOf(want)!,
							9
						);
				}
				expect(shareOf(slotOf(dock, 'a'))).toBeCloseTo(0.4, 9);
				expect(shareOf(slotOf(dock, 'e'))).toBeCloseTo(0.3, 9);
			}
		});

		// #777: e hidden from the column too. Its slot named c for the gone row (the one docked pane
		// of it), so e shown first took c from the edge into the column made again around it.
		const ORDERS = ['abe', 'aeb', 'bae', 'bea', 'eab', 'eba'];
		// column[d .2, row[a .2, b .3, c .5] .5, e .3]: c is the old neighbour of e.
		const loneMid = () =>
			split(
				's',
				'column',
				[0.2, 0.5, 0.3],
				[panel('d'), split('r', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('e')]
			);
		for (const [name, make, edge, shape] of [
			['right', lone, 'right', { row: [{ column: [{ row: ['a', 'b'] }, 'd', 'e'] }, 'c'] }],
			['bottom', lone, 'bottom', { column: [{ column: [{ row: ['a', 'b'] }, 'd', 'e'] }, 'c'] }],
			['top', lone, 'top', { column: ['c', { column: [{ row: ['a', 'b'] }, 'd', 'e'] }] }],
			[
				'right, the row between d and e',
				loneMid,
				'right',
				{ row: [{ column: ['d', { row: ['a', 'b'] }, 'e'] }, 'c'] }
			]
		] as const) {
			for (const order of ORDERS) {
				it(`the last docked pane of a gone split moved to the ${name} edge, shown ${order}: c stays at the edge (#777)`, () => {
					const dock = runSteps(make, ['-a', '-b', '-e']);
					dock.dockExistingAtEdge('c', edge);
					for (const id of order) dock.show(id);
					expect(shapeOf(dock.layout.docked)).toEqual(shape);
					expect(badSizes(dock.layout.docked)).toEqual([]);
					// c keeps the room it took at the edge, beside the whole column.
					expect(around(dock, 'c').c).toBeCloseTo(0.25, 9);
					const row = around(dock, 'a');
					expect(row.a).toBeCloseTo(0.4, 9);
					expect(row.b).toBeCloseTo(0.6, 9);
					const column = around(dock, 'e');
					expect(column.d).toBeCloseTo(0.2, 9);
					expect(column.e).toBeCloseTo(0.3, 9);
				});
			}
		}

		// #781: the slots of the splits further out named c too - among the panes of the child it was
		// in (the column c and d are left in), not for a gone split. A pane shown from there went
		// beside the new split at the edge (all it holds was named), c inside.
		const perms = (ids: string): string[] =>
			ids.length < 2
				? [ids]
				: [...ids].flatMap((id, i) => perms(ids.slice(0, i) + ids.slice(i + 1)).map((p) => id + p));
		// row[column[row[a .2, b .3, c .5] .6, d .4] .5, e .2, f .3]
		const deep = () =>
			split(
				'ro',
				'row',
				[0.5, 0.2, 0.3],
				[
					split(
						'col',
						'column',
						[0.6, 0.4],
						[split('ri', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('d')]
					),
					panel('e'),
					panel('f')
				]
			);
		const deepRow = { row: [{ column: [{ row: ['a', 'b'] }, 'd'] }, 'e', 'f'] };
		/** The sizes of deep()'s splits without c, wherever they are in the tree. */
		const expectDeep = (dock: DockState, label: string) => {
			expect(badSizes(dock.layout.docked), label).toEqual([]);
			const row = around(dock, 'a');
			expect(row.a, label).toBeCloseTo(0.4, 9);
			expect(row.b, label).toBeCloseTo(0.6, 9);
			const column = around(dock, 'd');
			expect(Object.values(column)[0], label).toBeCloseTo(0.6, 9);
			expect(column.d, label).toBeCloseTo(0.4, 9);
			const outer = around(dock, 'e');
			expect(Object.values(outer)[0], label).toBeCloseTo(0.5, 9);
			expect(outer.e, label).toBeCloseTo(0.2, 9);
			expect(outer.f, label).toBeCloseTo(0.3, 9);
		};
		for (const [edge, shape] of [
			['right', { row: [deepRow, 'c'] }],
			['bottom', { column: [deepRow, 'c'] }],
			['top', { column: ['c', deepRow] }],
			['left', { row: ['c', deepRow] }]
		] as const) {
			for (const order of perms('abef')) {
				it(`two splits deep, the split between left with d: c moved to the ${edge} edge, shown ${order}, stays at the edge (#781)`, () => {
					const dock = runSteps(deep, ['-a', '-b', '-e', '-f']);
					expect(shapeOf(dock.layout.docked)).toEqual({ column: ['c', 'd'] });
					dock.dockExistingAtEdge('c', edge);
					for (const id of order) dock.show(id);
					expect(shapeOf(dock.layout.docked)).toEqual(shape);
					// c keeps the room it took at the edge, beside the whole row.
					expect(around(dock, 'c').c).toBeCloseTo(0.25, 9);
					expectDeep(dock, order);
				});
			}
		}

		// column[deep() .5, g .2, h .3]: one more split around, every order of the six.
		const deeper = () => split('co', 'column', [0.5, 0.2, 0.3], [deep(), panel('g'), panel('h')]);
		for (const [edge, shape] of [
			['right', { row: [{ column: [deepRow, 'g', 'h'] }, 'c'] }],
			['bottom', { column: [{ column: [deepRow, 'g', 'h'] }, 'c'] }]
		] as const) {
			it(`three splits deep: c moved to the ${edge} edge stays there in any show order (#781)`, () => {
				for (const order of perms('abefgh')) {
					const dock = runSteps(deeper, ['-a', '-b', '-e', '-f', '-g', '-h']);
					dock.dockExistingAtEdge('c', edge);
					for (const id of order) dock.show(id);
					expect(shapeOf(dock.layout.docked), order).toEqual(shape);
					expect(around(dock, 'c').c, order).toBeCloseTo(0.25, 9);
					expectDeep(dock, order);
					const column = around(dock, 'g');
					expect(Object.values(column)[0], order).toBeCloseTo(0.5, 9);
					expect(column.g, order).toBeCloseTo(0.2, 9);
					expect(column.h, order).toBeCloseTo(0.3, 9);
				}
			});
		}

		it('the split around still docked, the one around that gone: c stays at the edge (#781)', () => {
			// e and f docked: the outer row is there, the column around it (g, h hidden) is gone.
			for (const order of perms('abgh')) {
				const dock = runSteps(deeper, ['-a', '-b', '-g', '-h']);
				dock.dockExistingAtEdge('c', 'right');
				for (const id of order) dock.show(id);
				expect(shapeOf(dock.layout.docked), order).toEqual({
					row: [{ column: [deepRow, 'g', 'h'] }, 'c']
				});
				expect(around(dock, 'c').c, order).toBeCloseTo(0.25, 9);
				expectDeep(dock, order);
			}
		});

		it('no gone split inside: a pane of a child of a gone split moved to an edge stays there (#781)', () => {
			// row[column[c .6, d .4] .5, e .2, f .3], e and f hidden: their slots name c and d for the column.
			const shallow = () =>
				split(
					'ro',
					'row',
					[0.5, 0.2, 0.3],
					[split('col', 'column', [0.6, 0.4], ['c', 'd'].map(panel)), panel('e'), panel('f')]
				);
			for (const [edge, shape] of [
				['right', { row: [{ row: ['d', 'e', 'f'] }, 'c'] }],
				['bottom', { column: [{ row: ['d', 'e', 'f'] }, 'c'] }]
			] as const)
				for (const order of ['ef', 'fe']) {
					const dock = runSteps(shallow, ['-e', '-f']);
					dock.dockExistingAtEdge('c', edge);
					for (const id of order) dock.show(id);
					expect(shapeOf(dock.layout.docked), order).toEqual(shape);
					expect(badSizes(dock.layout.docked), order).toEqual([]);
					expect(around(dock, 'c').c, order).toBeCloseTo(0.25, 9);
					const row = around(dock, 'e');
					expect(row.d, order).toBeCloseTo(0.5, 9);
					expect(row.e, order).toBeCloseTo(0.2, 9);
					expect(row.f, order).toBeCloseTo(0.3, 9);
				}
		});

		it('a child of a gone split moved to an edge: the pane hidden beside it comes back to the split, not to the edge (#781)', () => {
			// row[a .2, b .3, c .5], a hidden (its neighbour is b): b to the bottom edge, c is what is left.
			const dock = runSteps(L['row[a,b,c] uneven'], ['-a']);
			dock.dockExistingAtEdge('b', 'bottom');
			dock.show('a');
			expect(shapeOf(dock.layout.docked)).toEqual({ column: [{ row: ['a', 'c'] }, 'b'] });
			expect(badSizes(dock.layout.docked)).toEqual([]);
			expect(around(dock, 'b').b).toBeCloseTo(0.25, 9);
			const row = around(dock, 'a');
			expect(row.a).toBeCloseTo(0.2 / 0.7, 9);
			expect(row.c).toBeCloseTo(0.5 / 0.7, 9);
		});

		it('a hidden pane holds the place of the container its last pane left: nothing to take out', () => {
			// row[column[a,b] .4, c .3, d .3]: a hidden, b removed - a stands for the column in the row.
			const inSplit = () =>
				split(
					's',
					'row',
					[0.4, 0.3, 0.3],
					[split('in', 'column', [0.3, 0.7], ['a', 'b'].map(panel)), panel('c'), panel('d')]
				);
			const dock = runSteps(inSplit, ['-a']);
			take(dock, 'b');
			dock.show('a');
			expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'c', 'd'] });
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.4, 0.3, 0.3]])).toBe(true);
			// The same for a tab group: row[tabs[a,b] .5, c .2, d .3].
			const tabbed = runSteps(L['row[tabs[a,b],c,d]'], ['-a']);
			take(tabbed, 'b');
			tabbed.show('a');
			expect(shapeOf(tabbed.layout.docked)).toEqual({ row: ['a', 'c', 'd'] });
			expect(sameSizes(sizesOf(tabbed.layout.docked), [[0.5, 0.2, 0.3]])).toBe(true);
		});
	});

	// Not a pane leaving its split: the slots of the panes out of it are left as they are.
	describe('what leaves the slots as they are', () => {
		const unchanged = (make: () => DockNode, change: (d: DockState) => void, name: string) => {
			const before = runSteps(make, ['-b']);
			const dock = runSteps(make, ['-b']);
			change(dock);
			expect(slotOf(dock, 'b'), name).toEqual(slotOf(before, 'b'));
			return dock;
		};

		it('a pane moved inside its split (dockExisting beside another child)', () => {
			const dock = unchanged(four, (d) => d.dockExisting('a', 'd', 'right'), 'four');
			expect(shapeOf(dock.layout.docked)).toEqual({ row: ['c', 'd', 'a'] });
			dock.show('b');
			expect(around(dock, 'b').b).toBeCloseTo(0.2, 9);
			// A split of two is made again around them (a new id): still the same split.
			const two = unchanged(uneven, (d) => d.dockExisting('a', 'c', 'right'), 'two');
			expect(shapeOf(two.layout.docked)).toEqual({ row: ['c', 'a'] });
		});

		it('a divider moved (resizeSplit)', () => {
			unchanged(four, (d) => d.resizeSplit('s', 0, 0.1), 'resize');
		});

		it('a pane new to the split (ensurePanel beside a child)', () => {
			const dock = unchanged(
				four,
				(d) => d.ensurePanel({ id: 'z', title: 'Z' }, 800, 600, 'right', 'd'),
				'new'
			);
			expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'c', 'd', 'z'] });
		});

		it('a sibling hidden or floated (it holds its own share), and put back', () => {
			unchanged(four, (d) => d.dismiss('a'), 'hidden');
			unchanged(four, (d) => d.undockPanel('a'), 'floated');
			unchanged(four, (d) => (d.dismiss('a'), d.show('a')), 'hidden and shown');
			unchanged(
				four,
				(d) => (d.undockPanel('a'), d.dockAtSlot('a', d.homeSlot('a')!)),
				'floated and back'
			);
			// Floated and docked again into the split elsewhere (#741, the second item).
			unchanged(four, (d) => (d.undockPanel('a'), d.dockPanel('a', 'd', 'right')), 'elsewhere');
		});

		// The band remembers the pane's place and it comes back by `size` (a region's slot has no
		// `share`, #739 review): taking it out of the others' shares would not be undone when it
		// comes back, so the round trip below would not give the old sizes.
		it('a sibling auto-hidden to a band (autoHideRegion), and put back', () => {
			unchanged(four, (d) => void d.autoHideRegion('a'), 'auto-hidden');
			const dock = unchanged(
				four,
				(d) => (d.autoHideRegion('a'), d.restoreAutoHidden('a')),
				'auto-hidden and back'
			);
			dock.show('b');
			expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c', 'd'] });
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.1, 0.2, 0.3, 0.4]])).toBe(true);
			// Shown while the sibling is in its band: its share of the whole row (as before #743).
			const banded = runSteps(four, ['-b']);
			banded.autoHideRegion('a');
			banded.show('b');
			expect(around(banded, 'b').b).toBeCloseTo(0.2, 9);
		});

		it('a pane removed from a split nothing is out of', () => {
			const dock = runSteps(L['column[row[a,b],c]'], ['-c']);
			const before = slotOf(dock, 'c');
			take(dock, 'a');
			expect(slotOf(dock, 'c')).toEqual(before);
		});
	});

	// Codex P2 on #776: a pane the same change hides or floats has not left, even when its slot
	// cannot be tied to the split (a `root` slot: nothing docked is left for it to name).
	describe('a pane out of the tree whose slot does not name the split (#743 review)', () => {
		const nested = () =>
			split(
				'out',
				'column',
				[0.5, 0.5],
				[split('in', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)), panel('d')]
			);
		const slots = (dock: DockState, ...ids: string[]) =>
			ids.map((id) => JSON.stringify(slotOf(dock, id)));

		it('the same when the last pane is hidden (dismiss), not floated', () => {
			const dock = runSteps(nested, []);
			dock.autoHideRegion('c');
			for (const id of ['d', 'b', 'c']) dock.dismiss(id);
			const before = slots(dock, 'b', 'c', 'd');
			dock.dismiss('a');
			expect(dock.layout.docked).toBeNull();
			expect(slots(dock, 'b', 'c', 'd')).toEqual(before);
			for (const id of ['a', 'b', 'c', 'd']) dock.show(id);
			expect(around(dock, 'd').d).toBeCloseTo(0.5, 9);
			expect(badSizes(dock.layout.docked)).toEqual([]);
		});

		it('row[a .2, b .3, c .5]: c auto-hidden, b / c hidden, a floated: b and c keep their shares', () => {
			const dock = runSteps(uneven, []);
			dock.autoHideRegion('c');
			for (const id of ['b', 'c']) dock.dismiss(id);
			const before = slots(dock, 'b', 'c');
			dock.undockPanel('a');
			expect(slots(dock, 'b', 'c')).toEqual(before);
		});

		// Cross-review P2 on #776: a pending pane whose slot names ANOTHER split has left - only a
		// slot that names no split at all (`root`) says nothing about where the pane went.
		it('column[row[a .2, b .3, c .5], row[x, y, z]]: b hidden, a moved beside y and hidden - by one assignment as step by step: b at .375', () => {
			const two = () =>
				split(
					'out',
					'column',
					[0.5, 0.5],
					[
						split('in', 'row', [0.2, 0.3, 0.5], ['a', 'b', 'c'].map(panel)),
						split('low', 'row', [0.2, 0.3, 0.5], ['x', 'y', 'z'].map(panel))
					]
				);
			const steps = runSteps(two, ['-b']);
			steps.dockExisting('a', 'y', 'left');
			steps.dismiss('a');
			expect(shareOf(slotOf(steps, 'b')), 'one by one').toBeCloseTo(0.375, 9);
			const slotA = slotOf(steps, 'a');
			expect(slotA?.kind === 'split' && slotA.splitId).toBe('low');
			// The same tree and the same slot of a (it names `low`), b's slot as it was (.3).
			const dock = runSteps(two, ['-b']);
			expect(shareOf(slotOf(dock, 'b'))).toBeCloseTo(0.3, 9);
			dock.layout = {
				...dock.layout,
				docked: steps.layout.docked,
				floating: [...dock.layout.floating, steps.layout.floating.find((w) => w.id === 'a')!]
			};
			expect(shareOf(slotOf(dock, 'b')), 'at once').toBeCloseTo(0.375, 9);
			expect(JSON.stringify(slotOf(dock, 'b'))).toBe(JSON.stringify(slotOf(steps, 'b')));
			for (const d of [steps, dock]) d.show('b');
			expect(around(dock, 'b').b).toBeCloseTo(0.375, 9);
			expect(sameSizes(sizesOf(dock.layout.docked), sizesOf(steps.layout.docked))).toBe(true);
		});
	});
});

// Every sequence: once every pane is back in the old shape, the sizes are the old ones too; on the
// way, every split's sizes stay above 0 and add up to 1. As many steps as fit in about a second
// per layout.
describe('split sizes: every sequence (#733)', () => {
	for (const [name, make] of Object.entries(L)) {
		const n = collectPanelIds(make()).length;
		const steps = n <= 3 ? 10 : 8;
		it(`${name}: every hide / show sequence up to ${steps} steps`, { timeout: 60_000 }, () => {
			const result = walk(make, steps);
			expect(result.sameShape).toBeGreaterThan(0);
			expect(result.broken).toEqual([]);
			expect(result.wrong).toEqual([]);
		});
		const mixedSteps = n <= 3 ? 8 : 6;
		it(`${name}: every mixed sequence up to ${mixedSteps} steps`, { timeout: 60_000 }, () => {
			const result = walk(make, mixedSteps, true);
			expect(result.sameShape).toBeGreaterThan(0);
			expect(result.broken).toEqual([]);
			expect(result.wrong).toEqual([]);
		});
	}
});

// Longer sequences at random (fixed seed) on five panes, with `createDockState`.
describe('split sizes: random sequences with createDockState (#733)', () => {
	const rng = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	/**
	 * 8 to 16 steps, each pane out of the tree hidden or floated at random, then the rest put back.
	 * With `reload`, a save and load (`@`) now and then: the panes floating then stay floating.
	 * With `elsewhere`, a floated pane is now and then docked into a docked pane's tabs (`>x:y`)
	 * instead of back to its place; both stay where they are then (the pane docked into does not
	 * leave: the moved pane would stand for it, and the tree would not be the old one), and a
	 * hidden pane is now and then opened floating (`*x`) instead of shown; it stays floating then.
	 */
	const sequences = (
		ids: string[],
		count: number,
		seed: number,
		reload = false,
		elsewhere = false,
		// #741: a pane out of the tree is now and then taken out of the layout (`!x`) instead of put back.
		remove = false
	): string[] => {
		const random = rng(seed);
		const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
		const out = new Set<string>();
		for (let tries = 0; out.size < count && tries < count * 20; tries++) {
			const away = new Map<string, '-' | '~'>();
			const steps: string[] = [];
			const length = 8 + Math.floor(random() * 9);
			const lost = new Set<string>();
			for (let i = 0; i < length; i++) {
				if (reload && random() < 0.15) {
					steps.push('@');
					for (const [id, kind] of away)
						if (kind === '~') {
							away.delete(id);
							lost.add(id);
						}
					continue;
				}
				const docked = ids.filter((id) => !away.has(id) && !lost.has(id));
				if (docked.length === 0 && away.size === 0) break;
				const back = away.size > 0 && (docked.length === 0 || random() < 0.4);
				const id = pick(back ? [...away.keys()] : docked);
				if (back && remove && random() < 0.35) {
					steps.push(`!${id}`);
					away.delete(id);
					lost.add(id);
				} else if (
					back &&
					elsewhere &&
					away.get(id) === '~' &&
					docked.length > 0 &&
					random() < 0.6
				) {
					const target = pick(docked);
					steps.push(`>${id}:${target}`);
					away.delete(id);
					lost.add(id);
					lost.add(target);
				} else if (back && elsewhere && away.get(id) === '-' && random() < 0.3) {
					steps.push(`*${id}`);
					away.delete(id);
					lost.add(id);
				} else if (back) {
					steps.push(`${away.get(id) === '-' ? '+' : '^'}${id}`);
					away.delete(id);
				} else {
					const kind = random() < 0.6 ? '-' : '~';
					away.set(id, kind);
					steps.push(`${kind}${id}`);
				}
			}
			// A `sort` with a random comparator is not a defined order and V8 changed it (Node 26), so the
			// sequences of the `elsewhere` test use a Fisher-Yates shuffle (the other tests keep their old sequences).
			const rest = [...away];
			if (elsewhere) {
				for (let i = rest.length - 1; i > 0; i--) {
					const j = Math.floor(random() * (i + 1));
					[rest[i], rest[j]] = [rest[j], rest[i]];
				}
			} else rest.sort(() => random() - 0.5);
			for (const [id, kind] of rest) steps.push(`${kind === '-' ? '+' : '^'}${id}`);
			out.add(steps.join(' '));
		}
		return [...out];
	};
	const COUNT = 300;
	for (const [name, make] of Object.entries(L5)) {
		it(`${name}: ${COUNT} sequences`, () => {
			const shape = JSON.stringify(shapeOf(make()));
			const sizes = sizesOf(make());
			const wrong: string[] = [];
			let sameShape = 0;
			for (const seq of sequences(collectPanelIds(make()), COUNT, 733)) {
				const docked = runSteps(make, seq.split(' ')).layout.docked;
				expect(badSizes(docked), seq).toEqual([]);
				if (JSON.stringify(shapeOf(docked)) !== shape) continue;
				sameShape++;
				if (!sameSizes(sizesOf(docked), sizes))
					wrong.push(`${seq} -> ${JSON.stringify(sizesOf(docked))}`);
			}
			expect(sameShape).toBeGreaterThan(COUNT / 2);
			expect(wrong.slice(0, 5)).toEqual([]);
		});
	}
	// With a save and load on the way (Codex P2 on #739): the panes floating then are not put back
	// (their `homeSlot` is not saved), so what comes back is the old tree without them (as
	// `removePanel` leaves it).
	const RELOADS = 150;
	for (const [name, make] of Object.entries(L5)) {
		it(`${name}: ${RELOADS} sequences with reloads`, () => {
			const ids = collectPanelIds(make());
			const wrong: string[] = [];
			let sameShape = 0;
			for (const seq of sequences(ids, RELOADS, 739, true)) {
				let emptied = false;
				const docked = runSteps(make, seq.split(' '), (d) => {
					emptied ||= d.layout.docked === null;
				}).layout.docked;
				expect(badSizes(docked), seq).toEqual([]);
				// Every pane out with some lost on the way: what the lost ones' shares were is not
				// known any more to the panes put back into the empty tree - not checked.
				if (emptied) continue;
				const lost = ids.filter((id) => !findNode(docked, id));
				const old = lost.reduce<DockNode | null>((t, id) => removePanel(t, id), make());
				if (JSON.stringify(shapeOf(docked)) !== JSON.stringify(shapeOf(old))) continue;
				sameShape++;
				if (!sameSizes(sizesOf(docked), sizesOf(old)))
					wrong.push(
						`${seq} -> ${JSON.stringify(sizesOf(docked))} (${JSON.stringify(sizesOf(old))})`
					);
			}
			expect(sameShape).toBeGreaterThan(RELOADS / 2);
			expect(wrong.slice(0, 5)).toEqual([]);
		});
	}
	// Floated panes docked again elsewhere, hidden panes opened floating (Codex P2 on #739): they no
	// longer hold a share of the split they left, so once the rest is back the tree without them is the old tree without them.
	const ELSEWHERE = 150;
	for (const [name, make] of Object.entries(L5)) {
		it(`${name}: ${ELSEWHERE} sequences docking floated panes elsewhere`, () => {
			const ids = collectPanelIds(make());
			const wrong: string[] = [];
			let sameShape = 0;
			let moved = 0;
			let opened = 0;
			for (const seq of sequences(ids, ELSEWHERE, 7393, false, true)) {
				let merged = false;
				const docked = runSteps(make, seq.split(' '), (d) => {
					merged ||= d.layout.docked?.type !== 'split';
				}).layout.docked;
				expect(badSizes(docked), seq).toEqual([]);
				// The root split gone on the way (one pane or tab group left, a pane docked into it):
				// the share of the pane it was is not known any more - not checked.
				if (merged) continue;
				const elsewhere = seq
					.split(' ')
					.flatMap((s) =>
						s[0] === '>' ? [s.slice(1, s.indexOf(':'))] : s[0] === '*' ? [s.slice(1)] : []
					);
				const drop = (t: DockNode | null) => elsewhere.reduce((n, id) => removePanel(n, id), t);
				const now = drop(docked);
				const old = drop(make());
				if (JSON.stringify(shapeOf(now)) !== JSON.stringify(shapeOf(old))) continue;
				sameShape++;
				if (elsewhere.length > 0) moved++;
				if (seq.includes('*')) opened++;
				if (!sameSizes(sizesOf(now), sizesOf(old)))
					wrong.push(`${seq} -> ${JSON.stringify(sizesOf(now))} (${JSON.stringify(sizesOf(old))})`);
			}
			expect(sameShape).toBeGreaterThan(ELSEWHERE / 7);
			expect(moved).toBeGreaterThan(ELSEWHERE / 10);
			expect(opened).toBeGreaterThan(ELSEWHERE / 20);
			expect(wrong.slice(0, 5)).toEqual([]);
		});
	}
	// #741: panes out of the tree (hidden or floated) taken out of the layout by an assignment made
	// from today's layout (`!x`: `ThreePaneDock`'s `syncPanels`, `replaceLayout` without `saved`):
	// they no longer hold a share, so once the rest is back the tree is the old tree without them -
	// as for the panes a reload leaves floating. (More sequences: the ones that empty the tree on
	// the way are not checked, and the panes taken out do not come back to fill it.)
	const REMOVED = 600;
	for (const [name, make] of Object.entries(L5)) {
		it(`${name}: ${REMOVED} sequences taking panes out of the layout`, () => {
			const ids = collectPanelIds(make());
			const wrong: string[] = [];
			let sameShape = 0;
			let removed = 0;
			for (const seq of sequences(ids, REMOVED, 741, false, false, true)) {
				let emptied = false;
				const dock = runSteps(make, seq.split(' '), (d) => {
					emptied ||= d.layout.docked === null;
				});
				const docked = dock.layout.docked;
				expect(badSizes(docked), seq).toEqual([]);
				// As with reloads: every pane out with some lost on the way is not checked.
				if (emptied) continue;
				const lost = ids.filter((id) => !findNode(docked, id));
				const old = lost.reduce<DockNode | null>((t, id) => removePanel(t, id), make());
				if (JSON.stringify(shapeOf(docked)) !== JSON.stringify(shapeOf(old))) continue;
				sameShape++;
				if (seq.includes('!')) removed++;
				if (!sameSizes(sizesOf(docked), sizesOf(old)))
					wrong.push(
						`${seq} -> ${JSON.stringify(sizesOf(docked))} (${JSON.stringify(sizesOf(old))})`
					);
			}
			expect(sameShape).toBeGreaterThan(REMOVED / 6);
			expect(removed).toBeGreaterThan(REMOVED / 10);
			expect(wrong.slice(0, 5)).toEqual([]);
		});
	}
	// #845: found when the sequences above were shuffled another way (PR #840). `d` was shown into
	// `row[a]` at `.6` of it - its share of the whole row, with `e` (out, `.25`) not counted - where
	// `a .15 : d .6` is `.2 / .8`; so `a` ended at `.3`. By hide / show this no longer arises (#782
	// PR5: a hidden pane holds no share of a split, it comes back at its default place). By floats -
	// how `-x` / `+x` run in this file now - the sizes were still off (`.15 / .225 / .625`) until a
	// floated pane went back to its tombstone in the shadow tree, which keeps its share (#782 PR6):
	// `.15 / .6 / .25`. A KNOWN FAILURE until then.
	it('#845 (pinned, by floats): row[a,column[b,tabs[c,d]],e], the column floated, b taken out, the rest floated and docked back', () => {
		const make = L5['row[a,column[b,tabs[c,d]],e]'];
		const dock = runSteps(make, '~d ^d ~c ~b !b -d -e +e -e +d +e ^c'.split(' '));
		const old = removePanel(make(), 'b');
		expect(JSON.stringify(shapeOf(dock.layout.docked))).toBe(JSON.stringify(shapeOf(old)));
		expect(sameSizes(sizesOf(dock.layout.docked), sizesOf(old))).toBe(true);
	});

	// #741: one row, every step checked against what the shares mean. A pane out of the row
	// (floated; hidden too before #782 PR5) holds its share of the whole row - the panes in it and
	// the ones out that still hold theirs; put back, it takes that share of the row without the ones
	// still out. A pane out stops holding its share when it is taken out of the layout (`!x`) or left
	// floating by a reload (`@`): the shares of the ones still out are then of the row without it.
	// Docked again INTO the row at another place (`>x:y:left` / `:right`, `dockPanel`) it is a pane
	// of the row again, at the size `dockPanel` gives it: the shares of the ones still out stay as
	// they are - of the whole row, which has it again (the second item of #741: nothing to re-base).
	const ROWS = 400;
	for (const [name, make] of [
		['row[a,b,c,d,e]', L5['row[a,b,c,d,e]']],
		['row[a,b,c,d]', L['row[a,b,c,d]']]
	] as const) {
		it(`${name}: ${ROWS} sequences, each pane back at its share of the row as it is then`, () => {
			const random = rng(7412);
			const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
			const count = { back: 0, removed: 0, redocked: 0, reloads: 0, afterRedock: 0 };
			for (let n = 0; n < ROWS; n++) {
				const dock = createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());
				/** The panes out (floated) that hold a share of the row. */
				const out = new Map<string, { share: number }>();
				const steps: string[] = [];
				let redocked = false;
				const row = () => {
					const root = dock.layout.docked;
					expect(root?.type === 'split' && root.id, steps.join(' ')).toBe('s');
					return root as Extract<DockNode, { type: 'split' }>;
				};
				const sizeOf = (id: string) => row().sizes[row().children.findIndex((c) => c.id === id)];
				const held = (except?: string) =>
					[...out].reduce((sum, [id, o]) => (id === except ? sum : sum + o.share), 0);
				const release = (id: string) => {
					const gone = out.get(id)!.share;
					out.delete(id);
					for (const o of out.values()) o.share /= 1 - gone;
				};
				const length = 8 + Math.floor(random() * 9);
				for (let i = 0; i < length; i++) {
					const docked = row().children.map((c) => c.id);
					// The row itself stays: two panes are always docked (the ones lost do not come back).
					if (out.size === 0 && docked.length <= 2) break;
					if (out.size > 0 && random() < 0.08) {
						steps.push('@');
						for (const [id] of [...out]) release(id);
						expect(dock.hydrate(dock.serialize()), steps.join(' ')).toBe(true);
						count.reloads++;
						continue;
					}
					if (out.size > 0 && (docked.length <= 2 || random() < 0.45)) {
						const id = pick([...out.keys()]);
						const { share } = out.get(id)!;
						const r = random();
						if (r < 0.15) {
							steps.push(`!${id}`);
							dock.layout = {
								...dock.layout,
								floating: dock.layout.floating.filter((w) => w.id !== id)
							};
							release(id);
							count.removed++;
						} else if (r < 0.5) {
							const target = pick(docked);
							const side = pick(['left', 'right'] as const);
							steps.push(`>${id}:${target}:${side}`);
							dock.dockPanel(id, target, side);
							out.delete(id);
							expect(findNode(row(), id)?.type, steps.join(' ')).toBe('panel');
							redocked = true;
							count.redocked++;
						} else {
							steps.push(`^${id}`);
							expect(dock.dockAtSlot(id, dock.homeSlot(id)!), steps.join(' ')).toBe(true);
							const expected = Math.min(0.95, Math.max(0.05, share / (1 - held(id))));
							expect(sizeOf(id), steps.join(' ')).toBeCloseTo(expected, 6);
							out.delete(id);
							count.back++;
							if (redocked) count.afterRedock++;
						}
					} else {
						const id = pick(docked);
						const share = sizeOf(id) * (1 - held());
						steps.push(`~${id}`);
						dock.undockPanel(id);
						out.set(id, { share });
					}
					expect(badSizes(dock.layout.docked), steps.join(' ')).toEqual([]);
				}
			}
			expect(count.back).toBeGreaterThan(ROWS);
			expect(count.afterRedock).toBeGreaterThan(ROWS / 10);
			for (const key of ['removed', 'redocked', 'reloads'] as const)
				expect(count[key], key).toBeGreaterThan(ROWS / 10);
		});
	}
});
