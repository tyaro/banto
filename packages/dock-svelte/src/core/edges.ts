/**
 * Outer-edge drop targets of the whole host (#694 PR-1; spec §5.2 "画面端・
 * グループ端にドロップして分割"). Pure, no Svelte imports.
 *
 * Kept apart from `core/dropzones.ts` (a pane's own cross guide) on purpose: the
 * outer edge is a different target (the whole docked root is wrapped,
 * `core/tree.ts#dockPanelAtEdge`), and it is hit-tested BEFORE the panes (so it wins
 * over a pane's cross and over a floating window lying on the host's border).
 *
 * Since #694 PR-2 the target is one guide button per side (drawn like the cross's
 * buttons), at the middle of that side, `GUIDE_INSET` px in. They exist only while a
 * drag is in progress (`DragController` lays them out and hit-tests them from its own
 * hover update; `DockHost` draws them with `pointer-events: none`), so they never
 * take a pointer or a hit test outside a drag. The snap guide for an edge is
 * `dropRegionRect(hostRect, edge, EDGE_DOCK_RATIO)` - the quarter of the host the new
 * split gives the pane (`dockPanelAtEdge`'s sizes).
 */
import {
	GUIDE_INSET,
	guideButtonSize,
	hitGuideButton,
	type GuideButton,
	type GuideSizing
} from './dropzones';
import type { DockEdge } from '../types';

/**
 * The outer-edge buttons of a `width` x `height` host (origin top-left), in the order
 * left, right, top, bottom. The button side is the cross's (`guideButtonSize` of the
 * host, with `sizing` - the touch density's, `readGuideSizing`); empty when the host is
 * too small for it.
 */
export function edgeButtons(
	width: number,
	height: number,
	sizing: GuideSizing = {}
): GuideButton<DockEdge>[] {
	const b = guideButtonSize(width, height, sizing.size, sizing.min);
	if (b <= 0) return [];
	const midX = width / 2 - b / 2;
	const midY = height / 2 - b / 2;
	const at = (region: DockEdge, x: number, y: number): GuideButton<DockEdge> => ({
		region,
		rect: { x, y, width: b, height: b }
	});
	return [
		at('left', GUIDE_INSET, midY),
		at('right', width - GUIDE_INSET - b, midY),
		at('top', midX, GUIDE_INSET),
		at('bottom', midX, height - GUIDE_INSET - b)
	];
}

/**
 * Which outer-edge button (if any) a host-local point (`localX`, `localY`; origin
 * top-left of a `width` x `height` host) is on. Between the buttons = none.
 */
export function computeEdgeDrop(
	localX: number,
	localY: number,
	width: number,
	height: number
): DockEdge | null {
	if (width <= 0 || height <= 0) return null;
	return hitGuideButton(edgeButtons(width, height), localX, localY);
}
