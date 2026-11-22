// A small model of `DockState.dismiss` / `DockState.show` on the docked tree alone (#721), with the
// slot functions passed in: `split-sizes.test.ts` runs it with `src/core/slot.ts` (the side by side
// run with a copy of main's went with #782 PR7). It keeps what decides the tree's shape - the docked tree, the
// hidden panes with their slots in the order of `layout.floating`, and the panes that went
// floating (their slot is forgotten) - and nothing else (no window geometry, no lifecycle).
// #734: also the panes floated out of the tree (`DockState.undockPanel`, remembering their
// `homeSlot`) and put back (`DockState.dockAtSlot`, the panel menu's "back").
// `panel-visibility.test.ts` checks it against `createDockState` on the same sequences.
import type { HiddenDockSlot } from '../../src/core/slot';
import { findNode, removePanel } from '../../src/core/tree';
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

/** The panes out of the tree but `id`, in the order a caller of the slot functions lists them (hidden, then floated). */
function pendingOf(sim: Sim, id: string): HiddenDockSlot[] {
	return [...sim.hidden, ...(sim.floated ?? [])].filter((h) => h.id !== id);
}

export function simDismiss(impl: SlotImpl, sim: Sim, id: string): Sim {
	const node = findNode(sim.docked, id);
	// Not docked: `dismiss` only closes a window, the tree does not change.
	if (!node || node.type !== 'panel') return sim;
	const pending = [...sim.hidden, ...(sim.floated ?? [])];
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
