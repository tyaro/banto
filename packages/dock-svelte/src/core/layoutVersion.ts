/**
 * Which `DockLayout.version` a layout is written with (#727 / PR #732 review).
 *
 * A slot's `outer` chain may be up to `MAX_SLOT_DEPTH` (8) deep, but a version 2 reader (the
 * releases before #727) rejects a whole layout whose slot is deeper than `V2_MAX_SLOT_DEPTH` (4).
 * So a layout is written as version 3 only when it holds such a deep slot, and as version 2
 * otherwise - an older release still reads every layout it could read before, and one it cannot
 * read says so by its `version`. Decided from the content every time it is written: a v3 layout
 * whose deep slots are gone goes back to 2.
 */
import type { DockLayout, DockSlot } from '../types';

/** The deepest slot (itself and its `outer` chain) a version 1 / 2 layout may hold. */
export const V2_MAX_SLOT_DEPTH = 4;

/** How deep `slot` is: 1 for a slot without `outer`, plus one per `outer`. */
export function slotDepth(slot: DockSlot): number {
	let depth = 0;
	// Bounded by the input: a chain that contains itself cannot come from JSON.
	for (let s: DockSlot | undefined = slot; s; s = s.kind === 'root' ? undefined : s.outer) depth++;
	return depth;
}

/** The `version` `layout` is to be written with: 3 when it holds a slot deeper than `V2_MAX_SLOT_DEPTH`, else 2. */
export function layoutVersionFor(layout: Omit<DockLayout, 'version'>): 2 | 3 {
	const deep = (slot: DockSlot | undefined): boolean =>
		slot !== undefined && slotDepth(slot) > V2_MAX_SLOT_DEPTH;
	if (layout.floating.some((w) => deep(w.dockSlot))) return 3;
	if ((layout.autoHidden ?? []).some((e) => deep(e.slot))) return 3;
	return 2;
}

/** `layout` with the `version` its content asks for (the same object when it already has it). */
export function withLayoutVersion(layout: DockLayout): DockLayout {
	const version = layoutVersionFor(layout);
	return layout.version === version ? layout : { ...layout, version };
}
