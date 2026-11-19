// #733: a split's sizes come back whatever order its panes are hidden and shown in. A split slot's
// `size` is the pane's share of the whole split (the panes hidden from it counted), and
// `restoreDockSlot` scales it up by the share of the ones still out. The walks below run the slot
// functions through the model of `fixtures/visibility-sim.ts` (checked against `createDockState`
// by `panel-visibility.test.ts`); the shape against main is checked there, the sizes here.
import { describe, expect, it } from 'vitest';
import { captureDockSlot, restoreDockSlot } from '../src/core/slot';
import { collectPanelIds, findNode, removePanel } from '../src/core/tree';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockLayout, DockNode, DockSlot } from '../src/types';
import { keyOf, shapeOf, simStep, type Sim, type SlotImpl } from './fixtures/visibility-sim';

const nowSlot: SlotImpl = { capture: captureDockSlot, restore: restoreDockSlot };
const EPS = 1e-9;

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

const counterMakeId = (): (() => string) => {
	let n = 0;
	return () => `gen-${n++}`;
};

/**
 * `-x` hide, `+x` show, `~x` float, `^x` back, `@` save and load (`serialize` / `hydrate`: the
 * floated panes' `homeSlot`s are not saved, so they stay floating), with `createDockState`.
 */
const runSteps = (
	make: () => DockNode,
	steps: string[],
	each?: (dock: DockState) => void
): DockState => {
	const dock = createDockState({ version: 2, floating: [], docked: make() }, counterMakeId());
	for (const step of steps) {
		each?.(dock);
		const id = step.slice(1);
		if (step === '@') {
			expect(dock.hydrate(dock.serialize()), 'hydrate').toBe(true);
			continue;
		}
		if (step[0] === '-') dock.dismiss(id);
		else if (step[0] === '+') dock.show(id);
		else if (step[0] === '~') dock.undockPanel(id);
		else {
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
		const slot = dock.layout.floating.find((w) => w.id === 'b')?.dockSlot;
		expect(slot?.kind === 'split' && slot.size).toBeCloseTo(0.3, 9);
		expect(slot?.kind === 'split' && slot.share).toBeCloseTo(0.3, 9);
	});

	it('`size` keeps its old meaning (the share of the split then), `share` is of the whole split', () => {
		const dock = runSteps(L['row[a,b,c] uneven'], ['-a', '-b']);
		const slot = dock.layout.floating.find((w) => w.id === 'b')?.dockSlot;
		expect(slot?.kind === 'split' && slot.size).toBeCloseTo(0.375, 9);
		expect(slot?.kind === 'split' && slot.share).toBeCloseTo(0.3, 9);
	});

	// Cross review on #739: a slot saved by a release before #733 has no `share`, and its `size` is
	// a share of the split as it was then - it comes back as it did there.
	it('slots saved before #733 (no `share`): row[a,b,c] in thirds, hide a then b, show b then a -> thirds', () => {
		const strip = (slot: DockSlot): DockSlot => {
			if (slot.kind === 'root') return slot;
			const out = { ...slot, ...(slot.outer ? { outer: strip(slot.outer) } : {}) };
			if (out.kind === 'split') delete out.share;
			return out;
		};
		const before = runSteps(L['row[a,b,c] even'], ['-a', '-b']);
		const layout = JSON.parse(before.serialize()) as DockLayout;
		const old: DockLayout = {
			...layout,
			floating: layout.floating.map((w) => (w.dockSlot ? { ...w, dockSlot: strip(w.dockSlot) } : w))
		};
		const sizes = old.floating.map((w) => (w.dockSlot?.kind === 'split' ? w.dockSlot.size : NaN));
		expect(sizes[0]).toBeCloseTo(1 / 3, 9);
		expect(sizes[1]).toBeCloseTo(1 / 2, 9);
		// b then a came back in thirds before #733 (a then b did not: #733 itself).
		const dock = createDockState({ version: 2, floating: [], docked: null }, counterMakeId());
		expect(dock.hydrate(JSON.stringify(old))).toBe(true);
		dock.show('b');
		dock.show('a');
		expect(shapeOf(dock.layout.docked)).toEqual({ row: ['a', 'b', 'c'] });
		expect(sameSizes(sizesOf(dock.layout.docked), [[1 / 3, 1 / 3, 1 / 3]])).toBe(true);
	});

	// Codex P2 on #739: the floated pane's `homeSlot` is not saved, so the hidden pane's `share` is
	// saved without it - shown after a reload it comes back as it would have before #733.
	it('row[a .2, b .3, c .5]: float a, hide b, show b -> b : c = 3 : 5 with or without a reload', () => {
		for (const steps of ['~a -b +b', '~a -b @ +b', '~a @ -b +b']) {
			const dock = runSteps(L['row[a,b,c] uneven'], steps.split(' '));
			expect(shapeOf(dock.layout.docked), steps).toEqual({ row: ['b', 'c'] });
			expect(sameSizes(sizesOf(dock.layout.docked), [[0.375, 0.625]]), steps).toBe(true);
		}
		// Not saved: the layout itself keeps the share of the whole row, `a` still counted.
		const dock = runSteps(L['row[a,b,c] uneven'], ['~a', '-b']);
		const slot = dock.layout.floating.find((w) => w.id === 'b')?.dockSlot;
		expect(slot?.kind === 'split' && slot.share).toBeCloseTo(0.3, 9);
		const saved = (JSON.parse(dock.serialize()) as DockLayout).floating.find((w) => w.id === 'b');
		expect(saved?.dockSlot?.kind === 'split' && saved.dockSlot.share).toBeCloseTo(0.375, 9);
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
	 */
	const sequences = (ids: string[], count: number, seed: number, reload = false): string[] => {
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
				if (back) {
					steps.push(`${away.get(id) === '-' ? '+' : '^'}${id}`);
					away.delete(id);
				} else {
					const kind = random() < 0.6 ? '-' : '~';
					away.set(id, kind);
					steps.push(`${kind}${id}`);
				}
			}
			const rest = [...away].sort(() => random() - 0.5);
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
});
