/**
 * Outer-edge drop targets of the whole host (#694 PR-1; spec §5.2 "画面端・
 * グループ端にドロップして分割"). Pure, no Svelte imports.
 *
 * Kept apart from `core/dropzones.ts` (a pane's own edge bands and centre) on
 * purpose: the outer edge is a different target (the whole docked root is
 * wrapped, `core/tree.ts#dockPanelAtEdge`), it is hit-tested BEFORE the panes
 * (so it wins over the outermost strip of a pane and over a floating window
 * lying on the host's border), and the next step (#694 PR-2) replaces its band
 * with buttons drawn like the cross guide - only this module changes then.
 *
 * The hit area is a strip of `band` px along each side of the host. It exists
 * only while a drag is in progress (`DragController` calls this from its own
 * hover update; `DockHost` draws the strips with `pointer-events: none`), so
 * it never takes a pointer or a hit test outside a drag. The snap guide for an
 * edge is `dropRegionRect(hostRect, edge)` - the half of the host the new
 * split gives the pane (`dockPanelAtEdge`'s even sizes).
 */
import type { DockEdge } from '../types';

/** Default thickness (px) of the outer-edge strip. */
export const EDGE_DROP_BAND = 24;

/**
 * The strip thickness for a host of `width` x `height`: `band`, but never more
 * than an eighth of the smaller side, so a small host keeps most of its panes'
 * own drop bands (`core/dropzones.ts` uses the outer 25% of each pane).
 */
export function edgeBandSize(width: number, height: number, band = EDGE_DROP_BAND): number {
	const limit = Math.min(width, height) / 8;
	if (!(limit > 0)) return 0;
	return Math.min(band, limit);
}

/**
 * Which outer edge (if any) a host-local point (`localX`, `localY`; origin
 * top-left of a `width` x `height` host) is on. A point outside the host is on
 * none. In a corner (two strips at once) the nearer side wins; on an exact
 * tie the order is left > right > top > bottom (like `computeDropRegion`).
 * Boundary: a point exactly `size` px from a side is NOT on it (strict `<`).
 */
export function computeEdgeDrop(
	localX: number,
	localY: number,
	width: number,
	height: number,
	band = EDGE_DROP_BAND
): DockEdge | null {
	if (width <= 0 || height <= 0) return null;
	if (localX < 0 || localY < 0 || localX > width || localY > height) return null;
	const size = edgeBandSize(width, height, band);
	if (size <= 0) return null;
	const candidates: { edge: DockEdge; dist: number }[] = [
		{ edge: 'left', dist: localX },
		{ edge: 'right', dist: width - localX },
		{ edge: 'top', dist: localY },
		{ edge: 'bottom', dist: height - localY }
	];
	let best: { edge: DockEdge; dist: number } | null = null;
	for (const c of candidates) {
		if (c.dist < size && (best === null || c.dist < best.dist)) best = c;
	}
	return best?.edge ?? null;
}
