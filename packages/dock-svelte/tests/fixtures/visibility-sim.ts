// A small model of `DockState.dismiss` / `DockState.show` on the docked tree alone (#721), with the
// slot functions passed in: the tests run it with `src/core/slot.ts` and with the copy of main's
// (`slot-main.ts`) side by side. It keeps what decides the tree's shape - the docked tree, the
// hidden panes with their slots in the order of `layout.floating`, and the panes that went
// floating (their slot is forgotten) - and nothing else (no window geometry, no lifecycle).
// #734: also the panes floated out of the tree (`DockState.undockPanel`, remembering their
// `homeSlot`) and put back (`DockState.dockAtSlot`, the panel menu's "back").
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
		makeId: () => string,
		/** The other panes out of the tree with their slots (#733: the share it takes leaves theirs). */
		hidden?: HiddenDockSlot[]
	): DockNode | null;
	/**
	 * The wiring before #734: `dismiss` counted the closed windows' slots only, not the floated
	 * panes' (`DragController.homeSlots`, read by the float alone).
	 */
	split?: boolean;
}

export interface Sim {
	docked: DockNode | null;
	/** The panes hidden from the dock with their slots, in the order `dismiss` added them. */
	hidden: HiddenDockSlot[];
	/** The panes that went floating (the place was gone): never docked again by show / dismiss. */
	floating: string[];
	/** The panes floated out of the tree with their `homeSlot`s, in the order they left (#734). */
	floated?: HiddenDockSlot[];
}

export const panelOf = (id: string): DockPanelNode => ({
	type: 'panel',
	id,
	title: id.toUpperCase()
});

/** A fresh id: one the tree and the slots do not mention (a counter would do the same). */
function makeIdFor(sim: Sim): () => string {
	const used = JSON.stringify([sim.docked, sim.hidden, sim.floated ?? []]);
	let k = 0;
	return () => {
		while (used.includes(`"g${k}"`)) k++;
		return `g${k++}`;
	};
}

/** The panes out of the tree but `id`, as `DockState`'s `#pendingSlots` lists them (hidden, then floated). */
function pendingOf(sim: Sim, id: string): HiddenDockSlot[] {
	return [...sim.hidden, ...(sim.floated ?? [])].filter((h) => h.id !== id);
}

export function simDismiss(impl: SlotImpl, sim: Sim, id: string): Sim {
	const node = findNode(sim.docked, id);
	// Not docked: `dismiss` only closes a window, the tree does not change.
	if (!node || node.type !== 'panel') return sim;
	const pending = impl.split ? sim.hidden : [...sim.hidden, ...(sim.floated ?? [])];
	const slot = impl.capture(sim.docked, id, pending);
	const docked = removePanel(sim.docked, id);
	return slot
		? { ...sim, docked, hidden: [...sim.hidden, { id, slot }] }
		: { ...sim, docked, floating: [...sim.floating, id] };
}

/** `undockPanel` (#734): the place is remembered as a `homeSlot`, counting the hidden panes and the floated ones. */
export function simFloat(impl: SlotImpl, sim: Sim, id: string): Sim {
	const node = findNode(sim.docked, id);
	if (!node || node.type !== 'panel') return sim;
	const floated = sim.floated ?? [];
	const slot = impl.capture(sim.docked, id, [...sim.hidden, ...floated]);
	const docked = removePanel(sim.docked, id);
	return slot
		? { ...sim, docked, floated: [...floated, { id, slot }] }
		: { ...sim, docked, floating: [...sim.floating, id] };
}

/** "Back" (`dockAtSlot` with the `homeSlot`). The place is gone: counted as floating for good, like `show`. */
export function simBack(impl: SlotImpl, sim: Sim, id: string): Sim {
	const entry = sim.floated?.find((h) => h.id === id);
	if (!entry) return sim;
	// An empty list is left out, so the state's key is the same as before any float.
	const rest = sim.floated!.filter((h) => h.id !== id);
	const floated = rest.length > 0 ? rest : undefined;
	const docked = impl.restore(
		sim.docked,
		panelOf(id),
		entry.slot,
		makeIdFor(sim),
		pendingOf(sim, id)
	);
	if (docked === null) return { ...sim, floated, floating: [...sim.floating, id] };
	return { ...sim, docked, floated };
}

export function simShow(impl: SlotImpl, sim: Sim, id: string): Sim {
	const entry = sim.hidden.find((h) => h.id === id);
	if (!entry) return sim;
	const hidden = sim.hidden.filter((h) => h.id !== id);
	const docked = impl.restore(
		sim.docked,
		panelOf(id),
		entry.slot,
		makeIdFor(sim),
		pendingOf(sim, id)
	);
	// The place is gone: `show` opens it floating and the slot is forgotten.
	if (docked === null) return { ...sim, hidden, floating: [...sim.floating, id] };
	return { ...sim, docked, hidden };
}

/** One step: `-x` dismiss, `+x` show, `~x` float (#734), `^x` back. */
export function simStep(impl: SlotImpl, sim: Sim, step: string): Sim {
	const id = step.slice(1);
	switch (step[0]) {
		case '-':
			return simDismiss(impl, sim, id);
		case '+':
			return simShow(impl, sim, id);
		case '~':
			return simFloat(impl, sim, id);
		case '^':
			return simBack(impl, sim, id);
		default:
			throw new Error(`unknown step ${step}`);
	}
}

/** Runs `-x` (dismiss) / `+x` (show) / `~x` (float) / `^x` (back) steps. */
export function simRun(impl: SlotImpl, docked: DockNode, steps: string[]): Sim {
	let sim: Sim = { docked, hidden: [], floating: [] };
	for (const step of steps) sim = simStep(impl, sim, step);
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
 * Every sequence of `-x` / `+x` (with `mixed`, `~x` / `^x` too: #734) up to `maxSteps` steps on `make()`, run with `main` and `now` side
 * by side (a breadth-first walk over the pair of states; equal pairs at the same depth are walked
 * once, with the number of sequences reaching them). A step is one the main run allows: hide a
 * docked pane, show a hidden one. A sequence is checked when every pane is shown again in the main
 * run; a sequence in which main sent a pane floating can not come back, so it is not walked on.
 */
export function enumerateSequences(
	make: () => DockNode,
	main: SlotImpl,
	now: SlotImpl,
	maxSteps: number,
	{ mixed = false }: { mixed?: boolean } = {}
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
				const kinds = docked
					? mixed
						? ['-', '~']
						: ['-']
					: e.main.hidden.some((h) => h.id === id)
						? ['+']
						: e.main.floated?.some((h) => h.id === id)
							? ['^']
							: [];
				for (const kind of kinds) {
					const step = `${kind}${id}`;
					const m = simStep(main, e.main, step);
					if (m.floating.length > 0) continue;
					const n = simStep(now, e.now, step);
					const key = keyOf(m) + keyOf(n);
					const seen = next.get(key);
					if (seen) seen.count += e.count;
					else next.set(key, { main: m, now: n, count: e.count, steps: [...e.steps, step] });
				}
			}
		}
		for (const e of next.values()) {
			if (e.main.hidden.length > 0 || (e.main.floated?.length ?? 0) > 0) continue;
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

/**
 * Every hide order of every set of panes of `make()`, then every show order, with the states
 * merged on the way (`keyOf`), run with `main` and `now` side by side (#732; moved here from
 * `panel-visibility-exhaustive-merged.test.ts` so that #782 PR3 runs the same walk with the shadow
 * tree). A run is checked when every pane is shown again: `now` must be back at the old shape
 * (`want: 'all'`), or at least whenever `main` is (`want: 'main'`).
 */
export function walkHideThenShow(
	make: () => DockNode,
	main: SlotImpl,
	now: SlotImpl,
	want: 'all' | 'main'
): { checked: number; failures: string[] } {
	const ids = collectPanelIds(make());
	const shape = JSON.stringify(shapeOf(make()));
	const ok = (sim: Sim) =>
		sim.floating.length === 0 && JSON.stringify(shapeOf(sim.docked)) === shape;
	interface Entry {
		main: Sim;
		now: Sim;
		showing: boolean;
		steps: string[];
	}
	const start: Sim = { docked: make(), hidden: [], floating: [] };
	let level: Entry[] = [{ main: start, now: start, showing: false, steps: [] }];
	const failures: string[] = [];
	let checked = 0;
	while (level.length > 0) {
		const next = new Map<string, Entry>();
		const add = (e: Entry) => {
			const key = `${e.showing}${keyOf(e.main)}${keyOf(e.now)}`;
			if (!next.has(key)) next.set(key, e);
		};
		for (const e of level) {
			// The panes to show: hidden in the current run (a floating one is not docked again).
			const hidden = e.now.hidden.map((h) => h.id);
			if (e.showing && hidden.length === 0) {
				checked++;
				if (!ok(e.now) && (want === 'all' || ok(e.main)))
					failures.push(
						`${e.steps.join(' ')} -> ${JSON.stringify(shapeOf(e.now.docked))} floating [${e.now.floating}]`
					);
				continue;
			}
			const step = (id: string, show: boolean): Entry => {
				const m = show ? simShow(main, e.main, id) : simDismiss(main, e.main, id);
				// The same slot on both sides (nothing to compare with): one run.
				const same = main === now && e.main === e.now;
				const n = same ? m : show ? simShow(now, e.now, id) : simDismiss(now, e.now, id);
				return { main: m, now: n, showing: show, steps: [...e.steps, `${show ? '+' : '-'}${id}`] };
			};
			if (e.showing) {
				for (const id of hidden) add(step(id, true));
				continue;
			}
			if (hidden.length > 0) add({ ...e, showing: true });
			for (const id of ids) if (findNode(e.now.docked, id)) add(step(id, false));
		}
		level = [...next.values()];
	}
	return { checked, failures };
}
