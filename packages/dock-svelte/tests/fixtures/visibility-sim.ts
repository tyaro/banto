// A small model of `DockState.dismiss` / `DockState.show` on the docked tree alone (#721), with the
// slot functions passed in: the tests run it with `src/core/slot.ts` and with the copy of main's
// (`slot-main.ts`) side by side. It keeps what decides the tree's shape - the docked tree, the
// hidden panes with their slots in the order of `layout.floating`, and the panes that went
// floating (their slot is forgotten) - and nothing else (no window geometry, no lifecycle).
// `panel-visibility.test.ts` checks it against `createDockState` on the same sequences.
import type { HiddenDockSlot } from '../../src/core/slot';
import { collectPanelIds, findNode, removePanel } from '../../src/core/tree';
import type { DockNode, DockPanelNode, DockSlot } from '../../src/types';

export interface SlotImpl {
	capture(root: DockNode | null, panelId: string, hidden: HiddenDockSlot[]): DockSlot | null;
	restore(
		root: DockNode | null,
		panel: DockPanelNode,
		slot: DockSlot,
		makeId: () => string
	): DockNode | null;
}

export interface Sim {
	docked: DockNode | null;
	/** The panes hidden from the dock with their slots, in the order `dismiss` added them. */
	hidden: HiddenDockSlot[];
	/** The panes that went floating (the place was gone): never docked again by show / dismiss. */
	floating: string[];
}

export const panelOf = (id: string): DockPanelNode => ({
	type: 'panel',
	id,
	title: id.toUpperCase()
});

/** A fresh id: one the tree and the slots do not mention (a counter would do the same). */
function makeIdFor(sim: Sim): () => string {
	const used = JSON.stringify([sim.docked, sim.hidden]);
	let k = 0;
	return () => {
		while (used.includes(`"g${k}"`)) k++;
		return `g${k++}`;
	};
}

export function simDismiss(impl: SlotImpl, sim: Sim, id: string): Sim {
	const node = findNode(sim.docked, id);
	// Not docked: `dismiss` only closes a window, the tree does not change.
	if (!node || node.type !== 'panel') return sim;
	const slot = impl.capture(sim.docked, id, sim.hidden);
	const docked = removePanel(sim.docked, id);
	return slot
		? { docked, hidden: [...sim.hidden, { id, slot }], floating: sim.floating }
		: { docked, hidden: sim.hidden, floating: [...sim.floating, id] };
}

export function simShow(impl: SlotImpl, sim: Sim, id: string): Sim {
	const entry = sim.hidden.find((h) => h.id === id);
	if (!entry) return sim;
	const hidden = sim.hidden.filter((h) => h.id !== id);
	const docked = impl.restore(sim.docked, panelOf(id), entry.slot, makeIdFor(sim));
	// The place is gone: `show` opens it floating and the slot is forgotten.
	if (docked === null) return { docked: sim.docked, hidden, floating: [...sim.floating, id] };
	return { docked, hidden, floating: sim.floating };
}

/** Runs `-x` (dismiss) / `+x` (show) steps. */
export function simRun(impl: SlotImpl, docked: DockNode, steps: string[]): Sim {
	let sim: Sim = { docked, hidden: [], floating: [] };
	for (const step of steps)
		sim =
			step[0] === '-' ? simDismiss(impl, sim, step.slice(1)) : simShow(impl, sim, step.slice(1));
	return sim;
}

/**
 * The tree's shape (#721): kind, direction and child ids - not generated ids of splits / groups,
 * sizes or the active tab. A tab put back as a split's sibling does not match a tab group.
 */
export const shapeOf = (node: DockNode | null): unknown =>
	node === null
		? null
		: node.type === 'panel'
			? node.id
			: node.type === 'tabs'
				? { tabs: node.children.map((c) => c.id) }
				: { [node.direction]: node.children.map(shapeOf) };

/** Sizes, the active tab and titles do not decide any later shape: left out of the state's key. */
export const keyOf = (sim: Sim): string =>
	JSON.stringify(sim, (k, v: unknown) =>
		k === 'sizes' || k === 'size' || k === 'activeIndex' || k === 'title' ? undefined : v
	);

export interface Regression {
	steps: string[];
	main: unknown;
	now: unknown;
}

export interface EnumerationResult {
	/** Distinct (main, now) states summed over the levels. */
	states: number;
	/** Sequences of 1..maxSteps steps ending with every pane shown (main's) - the ones checked. */
	sequences: number;
	/** Of those, the ones that come back to the old shape with main's slot. */
	mainRestores: number;
	/** ... and with the current one. */
	nowRestores: number;
	/** Back to the old shape with the current slot, not with main's. */
	improvements: number;
	/** Back to the old shape with main's slot, not with the current one (one per state, shortest first). */
	regressions: Regression[];
}

/**
 * Every sequence of `-x` / `+x` up to `maxSteps` steps on `make()`, run with `main` and `now` side
 * by side (a breadth-first walk over the pair of states; equal pairs at the same depth are walked
 * once, with the number of sequences reaching them). A step is one the main run allows: hide a
 * docked pane, show a hidden one. A sequence is checked when every pane is shown again in the main
 * run; a sequence in which main sent a pane floating can not come back, so it is not walked on.
 */
export function enumerateSequences(
	make: () => DockNode,
	main: SlotImpl,
	now: SlotImpl,
	maxSteps: number
): EnumerationResult {
	const ids = collectPanelIds(make());
	const want = JSON.stringify(shapeOf(make()));
	const start: Sim = { docked: make(), hidden: [], floating: [] };
	interface Entry {
		main: Sim;
		now: Sim;
		count: number;
		steps: string[];
	}
	let level = new Map<string, Entry>([
		[keyOf(start) + keyOf(start), { main: start, now: start, count: 1, steps: [] }]
	]);
	const result: EnumerationResult = {
		states: 0,
		sequences: 0,
		mainRestores: 0,
		nowRestores: 0,
		improvements: 0,
		regressions: []
	};
	for (let depth = 1; depth <= maxSteps; depth++) {
		const next = new Map<string, Entry>();
		for (const e of level.values()) {
			for (const id of ids) {
				const docked = findNode(e.main.docked, id)?.type === 'panel';
				const hidden = e.main.hidden.some((h) => h.id === id);
				if (!docked && !hidden) continue;
				const step = `${docked ? '-' : '+'}${id}`;
				const m = docked ? simDismiss(main, e.main, id) : simShow(main, e.main, id);
				if (m.floating.length > 0) continue;
				const n = docked ? simDismiss(now, e.now, id) : simShow(now, e.now, id);
				const key = keyOf(m) + keyOf(n);
				const seen = next.get(key);
				if (seen) seen.count += e.count;
				else next.set(key, { main: m, now: n, count: e.count, steps: [...e.steps, step] });
			}
		}
		for (const e of next.values()) {
			if (e.main.hidden.length > 0) continue;
			const mainOk = JSON.stringify(shapeOf(e.main.docked)) === want;
			const nowOk = JSON.stringify(shapeOf(e.now.docked)) === want;
			result.sequences += e.count;
			if (mainOk) result.mainRestores += e.count;
			if (nowOk) result.nowRestores += e.count;
			if (nowOk && !mainOk) result.improvements += e.count;
			if (mainOk && !nowOk)
				result.regressions.push({
					steps: e.steps,
					main: shapeOf(e.main.docked),
					now: shapeOf(e.now.docked)
				});
		}
		result.states += next.size;
		level = next;
	}
	return result;
}
