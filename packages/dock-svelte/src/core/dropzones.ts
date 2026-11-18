/**
 * Pure drop-target geometry of a docked pane (spec §5.2: "画面端・グループ端に
 * ドロップして分割（上下左右スナップ）"). No Svelte imports.
 *
 * Since #694 PR-2 a drag docks only when it is released ON a guide button: the
 * pane under the pointer shows a cross of buttons in its middle (`crossButtons`:
 * up / down / left / right split it, the centre joins it as a tab), and
 * `DragController` hit-tests them by geometry (`hitGuideButton`) - the buttons are
 * drawn `pointer-events: none` and exist only during a drag. The host's outer
 * edges use the same buttons (`core/edges.ts`). A release over a pane but off its
 * buttons is not a dock (it floats, like a release on free space).
 *
 * `computeDropRegion` (the old "outer 25% band of the pane" rule) is no longer used
 * by the drag; it stays exported for compatibility.
 */
import type { Rect } from './geometry';
import type { DropRegion } from '../types';

/** Default side (px) of one guide button. */
export const GUIDE_BUTTON_SIZE = 32;
/** Gap (px) between the buttons of the cross. */
export const GUIDE_BUTTON_GAP = 4;
/** Smallest side (px) a guide button is shrunk to before the guide is not shown at all. */
export const GUIDE_BUTTON_MIN = 16;
/** Space (px) kept between a guide and the border of the pane / host it is drawn in. */
export const GUIDE_INSET = 8;

/** One guide button: what a release on it does, and where it is (same coordinates as the rect it was laid out in). */
export interface GuideButton<R extends DropRegion = DropRegion> {
	region: R;
	rect: Rect;
}

/**
 * The button side for a guide drawn inside a `width` x `height` area: `size`, shrunk
 * so a full cross (three buttons and two gaps) plus `GUIDE_INSET` on each side fits
 * the smaller side; `0` (= no guide) when that would be under `GUIDE_BUTTON_MIN`.
 */
export function guideButtonSize(width: number, height: number, size = GUIDE_BUTTON_SIZE): number {
	const room = Math.min(width, height) - 2 * GUIDE_INSET - 2 * GUIDE_BUTTON_GAP;
	if (!(room > 0)) return 0;
	const fit = Math.min(size, Math.floor(room / 3));
	return fit >= GUIDE_BUTTON_MIN ? fit : 0;
}

/** What a pane accepts (`DockCapabilities.dropCenter` / `dropSplit` of its panes). */
export interface CrossOptions {
	/** Offer the centre (join as a tab). Default `true`. */
	center?: boolean;
	/** Offer up / down / left / right (split beside it). Default `true`. */
	split?: boolean;
}

/**
 * The cross guide for a pane at `rect`: five buttons around its centre, in the order
 * centre, left, right, top, bottom, minus the ones `options` withholds. Empty when
 * the pane is too small (`guideButtonSize`).
 */
export function crossButtons(rect: Rect, options: CrossOptions = {}): GuideButton[] {
	const b = guideButtonSize(rect.width, rect.height);
	if (b <= 0) return [];
	const step = b + GUIDE_BUTTON_GAP;
	const cx = rect.x + rect.width / 2 - b / 2;
	const cy = rect.y + rect.height / 2 - b / 2;
	const at = (region: DropRegion, x: number, y: number): GuideButton => ({
		region,
		rect: { x, y, width: b, height: b }
	});
	const out: GuideButton[] = [];
	if (options.center ?? true) out.push(at('center', cx, cy));
	if (options.split ?? true)
		out.push(
			at('left', cx - step, cy),
			at('right', cx + step, cy),
			at('top', cx, cy - step),
			at('bottom', cx, cy + step)
		);
	return out;
}

/** True when the point (`x`, `y`) is on `rect` (left / top edge in, right / bottom edge out). */
export function pointInRect(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** True when two rects overlap (touching edges do not). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The region of the button the point (`x`, `y`) is on, or `null` (between / outside the buttons). */
export function hitGuideButton<R extends DropRegion>(
	buttons: readonly GuideButton<R>[],
	x: number,
	y: number
): R | null {
	return buttons.find((b) => pointInRect(b.rect, x, y))?.region ?? null;
}

/**
 * Given a pointer position (`localX`, `localY`) inside a drop target's rect
 * (`width` x `height`, both in the same units, origin top-left), return which
 * `DropRegion` it falls in. An edge band of `edgeRatio` (fraction of the
 * corresponding dimension) on each side maps to that edge; everything else is
 * `'center'`. A point in two bands at once (a corner) resolves to whichever
 * edge is normalized-distance-closer; on an exact tie, priority is
 * left > right > top > bottom (stable sort order below - arbitrary but
 * deterministic).
 *
 * Boundary convention: a point exactly `edgeRatio * dimension` from an edge
 * is NOT in that edge's band (strict `<`), so it resolves to `'center'`
 * unless it's within another edge's band.
 *
 * Not used by the drag since #694 PR-2 (a drop needs a guide button, see the module
 * doc); kept as a pure helper for compatibility.
 */
export function computeDropRegion(
	localX: number,
	localY: number,
	width: number,
	height: number,
	edgeRatio = 0.25
): DropRegion {
	if (width <= 0 || height <= 0) return 'center';

	const leftDist = localX / width;
	const rightDist = (width - localX) / width;
	const topDist = localY / height;
	const bottomDist = (height - localY) / height;

	const candidates: { region: DropRegion; dist: number }[] = [];
	if (leftDist < edgeRatio) candidates.push({ region: 'left', dist: leftDist });
	if (rightDist < edgeRatio) candidates.push({ region: 'right', dist: rightDist });
	if (topDist < edgeRatio) candidates.push({ region: 'top', dist: topDist });
	if (bottomDist < edgeRatio) candidates.push({ region: 'bottom', dist: bottomDist });

	if (candidates.length === 0) return 'center';

	candidates.sort((a, b) => a.dist - b.dist);
	return candidates[0].region;
}
