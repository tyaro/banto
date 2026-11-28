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
 *
 * A host that is not wholly on screen (#1043: a dock taller than the viewport, a page
 * scrolled so the host's top is out): the buttons are laid out in the part of the host
 * that is on screen (`visibleHostRect`, passed as `visible`), at the middle of each side
 * of THAT part, so every button can be reached without scrolling. What a drop does is
 * unchanged (the pane goes along the HOST's edge); the snap guide is the part of that
 * quarter that is on screen, and never thinner than the button it is shown for
 * (`edgeGuideRect`). A host wholly on screen = `visible` is the whole host = as before.
 */
import {
	GUIDE_INSET,
	guideButtonSize,
	hitGuideButton,
	type GuideButton,
	type GuideSizing
} from './dropzones';
import { dropRegionRect, type Rect } from './geometry';
import { EDGE_DOCK_RATIO } from './tree';
import type { DockEdge } from '../types';

/**
 * The part of the host that is on screen, in the host's own coordinates (origin = its
 * top-left). `host` and `clips` are in one coordinate space (client px): `clips` are the
 * boxes that cut the host off - the viewport and every scroll container around it. No
 * overlap at all = a rect of width / height 0 (no button fits it).
 */
export function visibleHostRect(host: Rect, clips: readonly Rect[]): Rect {
	let left = host.x;
	let top = host.y;
	let right = host.x + host.width;
	let bottom = host.y + host.height;
	for (const c of clips) {
		left = Math.max(left, c.x);
		top = Math.max(top, c.y);
		right = Math.min(right, c.x + c.width);
		bottom = Math.min(bottom, c.y + c.height);
	}
	return {
		x: left - host.x,
		y: top - host.y,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top)
	};
}

/**
 * How much of the viewport's top / bottom is covered by something that is not an ancestor of
 * the host - a `position: fixed` / `sticky` header or footer (#1058). Client px, from the
 * viewport edge; missing / negative / not finite = 0.
 */
export interface OverlayInset {
	top?: number;
	bottom?: number;
}

/**
 * `viewport` (client px) minus the covered `inset` at its top and bottom: a clip for
 * `visibleHostRect`. `inset` absent or 0 = the viewport itself (as before). The two together
 * never leave a negative height.
 */
export function insetViewport(viewport: Rect, inset?: OverlayInset): Rect {
	const part = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);
	const top = Math.min(part(inset?.top), viewport.height);
	const bottom = Math.min(part(inset?.bottom), viewport.height - top);
	return {
		x: viewport.x,
		y: viewport.y + top,
		width: viewport.width,
		height: viewport.height - top - bottom
	};
}

/** `visible` cut to the `width` x `height` host; the whole host when it is not given. */
function visiblePart(width: number, height: number, visible?: Rect): Rect {
	if (!visible) return { x: 0, y: 0, width, height };
	return visibleHostRect({ x: 0, y: 0, width, height }, [visible]);
}

/**
 * The outer-edge buttons of a `width` x `height` host (origin top-left), in the order
 * left, right, top, bottom. The button side is the cross's (`guideButtonSize`, with
 * `sizing` - the touch density's, `readGuideSizing`); empty when the host is too small
 * for it. `visible` (host-local, `visibleHostRect`; default = the whole host) is the part
 * of the host that is on screen: the buttons sit `GUIDE_INSET` px inside ITS sides, at
 * their middle, and are sized for it (smaller, or none, when little of the host shows).
 */
export function edgeButtons(
	width: number,
	height: number,
	sizing: GuideSizing = {},
	visible?: Rect
): GuideButton<DockEdge>[] {
	const v = visiblePart(width, height, visible);
	const b = guideButtonSize(v.width, v.height, sizing.size, sizing.min);
	if (b <= 0) return [];
	const midX = v.x + v.width / 2 - b / 2;
	const midY = v.y + v.height / 2 - b / 2;
	const at = (region: DockEdge, x: number, y: number): GuideButton<DockEdge> => ({
		region,
		rect: { x, y, width: b, height: b }
	});
	return [
		at('left', v.x + GUIDE_INSET, midY),
		at('right', v.x + v.width - GUIDE_INSET - b, midY),
		at('top', midX, v.y + GUIDE_INSET),
		at('bottom', midX, v.y + v.height - GUIDE_INSET - b)
	];
}

/**
 * The snap guide shown for the outer-edge button `edge` of a `width` x `height` host
 * (host-local): the quarter of the host a drop there gives the pane
 * (`dropRegionRect(host, edge, EDGE_DOCK_RATIO)`), cut to `visible` (the part of the host
 * on screen, `visibleHostRect`; default = the whole host). When that leaves less than a
 * strip around the button (the quarter is scrolled away: the bottom quarter of a dock
 * taller than the viewport), the guide is that strip - `2 * GUIDE_INSET` + the button
 * deep, along the visible part's `edge` side - so the side the drop goes to still shows.
 * Only the picture: the drop is the host's edge whatever is on screen.
 */
export function edgeGuideRect(
	width: number,
	height: number,
	edge: DockEdge,
	sizing: GuideSizing = {},
	visible?: Rect
): Rect {
	const full = dropRegionRect({ x: 0, y: 0, width, height }, edge, EDGE_DOCK_RATIO);
	if (!visible) return full;
	const v = visiblePart(width, height, visible);
	const strip = guideButtonSize(v.width, v.height, sizing.size, sizing.min) + 2 * GUIDE_INSET;
	// How deep the guide is from the visible part's `edge` side: the visible depth of the
	// quarter, at least the strip (never more than the quarter itself: a small host wholly on
	// screen keeps its quarter), at most the visible part.
	const depth = (overlap: number, room: number, quarter: number) =>
		Math.min(room, Math.max(Math.min(strip, quarter), overlap));
	switch (edge) {
		case 'left': {
			const d = depth(Math.min(full.x + full.width, v.x + v.width) - v.x, v.width, full.width);
			return { x: v.x, y: v.y, width: d, height: v.height };
		}
		case 'right': {
			const d = depth(v.x + v.width - Math.max(full.x, v.x), v.width, full.width);
			return { x: v.x + v.width - d, y: v.y, width: d, height: v.height };
		}
		case 'top': {
			const d = depth(Math.min(full.y + full.height, v.y + v.height) - v.y, v.height, full.height);
			return { x: v.x, y: v.y, width: v.width, height: d };
		}
		case 'bottom': {
			const d = depth(v.y + v.height - Math.max(full.y, v.y), v.height, full.height);
			return { x: v.x, y: v.y + v.height - d, width: v.width, height: d };
		}
	}
}

/**
 * Which outer-edge button (if any) a host-local point (`localX`, `localY`; origin
 * top-left of a `width` x `height` host) is on. Between the buttons = none. `visible` as
 * in `edgeButtons` (the part of the host on screen; default = the whole host).
 */
export function computeEdgeDrop(
	localX: number,
	localY: number,
	width: number,
	height: number,
	visible?: Rect
): DockEdge | null {
	if (width <= 0 || height <= 0) return null;
	return hitGuideButton(edgeButtons(width, height, {}, visible), localX, localY);
}
