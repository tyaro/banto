/**
 * Which `DockLayout.version` a layout is written with.
 *
 * Since #782 PR8b there is one: 4. The edge bands hold no slot any more (their places are a tree,
 * `DockLayout.dockedWithAutoHidden`), so the content has nothing left to choose between (#727:
 * 3 for a slot deeper than `V2_MAX_SLOT_DEPTH`, else 2), and a layout of versions 1 - 3 is not
 * read (`validateDockLayout`). What is left here goes with `core/slot.ts` (#782 PR8c).
 */
import type { DockLayout, DockSlot } from '../types';

/** The one version read and written. */
export const DOCK_LAYOUT_VERSION = 4;

/** The deepest slot (itself and its `outer` chain) a version 1 / 2 layout could hold. */
export const V2_MAX_SLOT_DEPTH = 4;

/** How deep `slot` is: 1 for a slot without `outer`, plus one per `outer`. */
export function slotDepth(slot: DockSlot): number {
	let depth = 0;
	// Bounded by the input: a chain that contains itself cannot come from JSON.
	for (let s: DockSlot | undefined = slot; s; s = s.kind === 'root' ? undefined : s.outer) depth++;
	return depth;
}

/** `layout` with the version written today (the same object when it already has it). */
export function withLayoutVersion(layout: DockLayout): DockLayout {
	return layout.version === DOCK_LAYOUT_VERSION
		? layout
		: { ...layout, version: DOCK_LAYOUT_VERSION };
}
