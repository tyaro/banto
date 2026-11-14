/**
 * Categorical series color slots (spec §6.4 rule 1):
 * series take CSS var slots 1..8 IN FIXED ORDER by series index - never
 * cycle, never reassign when a series is removed (color follows the
 * entity, i.e. its position in the caller's `series`/`data` array).
 * More than 8 series is out of scope for v1; overflow series are clamped
 * to the last slot rather than wrapping back to slot 1 (wrapping would
 * silently alias a later series onto an earlier one's color).
 */
export const MAX_CHART_SERIES = 8;

export function seriesColorVar(index: number): string {
	const slot = Math.min(Math.max(index, 0) + 1, MAX_CHART_SERIES);
	return `var(--banto-chart-${slot})`;
}

/**
 * Sequential (single-hue) ramp for magnitude encodings (spec §6.4 rule 9: a
 * heatmap cell's color is a MAGNITUDE, not a category, so it must never borrow
 * from the categorical `seriesColorVar` slots - one hue only, varying in
 * lightness). Step 0 = low = closest to the surface, last step = high = most
 * contrast. The values are theme tokens (`--banto-chart-seq-1..7` in banto.css,
 * light and dark, checked by packages/theme/tests/chart-palette.test.ts), so the
 * ramp follows the theme. SVG export bakes the resolved colour of every
 * `fill="var(...)"` (export.ts), so a reference is safe there too.
 */
export const SEQ_STEPS = 7;
export const SEQ_RAMP: readonly string[] = Array.from(
	{ length: SEQ_STEPS },
	(_, i) => `var(--banto-chart-seq-${i + 1})`
);

/**
 * Diverging ramp (blue <- neutral -> orange, no red/green) for signed values
 * around a meaningful midpoint (deviation from a target, change since the last
 * period). The middle step (`--banto-chart-div-4`) is the neutral midpoint.
 */
export const DIV_STEPS = 7;
export const DIV_RAMP: readonly string[] = Array.from(
	{ length: DIV_STEPS },
	(_, i) => `var(--banto-chart-div-${i + 1})`
);

/**
 * Bin `value` into one of `ramp`'s steps by its linear position within
 * `[min, max]` (step 0 = min end, last step = max end). Degenerate domains
 * (`min === max`, e.g. every cell holds the same value) map to the ramp's
 * middle step rather than always the lightest/darkest end, since there is no
 * "low" or "high" to distinguish. `ramp` defaults to `SEQ_RAMP` but accepts a
 * caller-supplied ramp of any length >= 1. A non-finite `value`, `min` or
 * `max` (e.g. `NaN` for a missing value) has no step and returns `''`, like
 * an empty `ramp` - callers should skip such a mark rather than paint it.
 */
export function sequentialColor(
	value: number,
	min: number,
	max: number,
	ramp: readonly string[] = SEQ_RAMP
): string {
	if (ramp.length === 0 || !allFinite(value, min, max)) return '';
	if (ramp.length === 1) return ramp[0];
	if (min === max) return ramp[Math.floor(ramp.length / 2)];

	const ratio = Math.min(1, Math.max(0, halfDiff(value, min) / halfDiff(max, min)));
	const step = Math.min(ramp.length - 1, Math.floor(ratio * ramp.length));
	return ramp[step];
}

/**
 * Pick a `ramp` step for `value` around `mid`: the middle step for `value ===
 * mid`, the steps below the middle for `[min, mid)` and the steps above it for
 * `(mid, max]`. Each side is binned linearly over its own half, so an
 * asymmetric domain (e.g. -10..+40) still uses the whole of both sides, and
 * any value off `mid` lands at least one step away from the neutral middle.
 * Values outside `[min, max]` are clamped; a side with no extent (`min === mid`
 * or `max === mid`) maps everything on that side to its outermost step.
 * `ramp` defaults to `DIV_RAMP` and should have an odd length (with an even
 * length the step just below the centre is treated as the middle). A
 * non-finite `value`, `min`, `mid` or `max` returns `''`, as in
 * `sequentialColor`.
 */
export function divergingColor(
	value: number,
	min: number,
	mid: number,
	max: number,
	ramp: readonly string[] = DIV_RAMP
): string {
	if (ramp.length === 0 || !allFinite(value, min, mid, max)) return '';
	const centre = Math.floor((ramp.length - 1) / 2);
	if (value === mid) return ramp[centre];
	const below = value < mid;
	const side = below ? centre : ramp.length - 1 - centre;
	if (side === 0) return ramp[centre];
	const extent = below ? halfDiff(mid, min) : halfDiff(max, mid);
	const ratio = extent <= 0 ? 1 : Math.min(1, Math.abs(halfDiff(value, mid)) / extent);
	const k = Math.min(side, Math.max(1, Math.ceil(ratio * side)));
	return ramp[below ? centre - k : centre + k];
}

function allFinite(...values: number[]): boolean {
	return values.every(Number.isFinite);
}

/**
 * `(a - b) / 2` without overflow: the plain difference of two finite numbers
 * can exceed `Number.MAX_VALUE` (e.g. `1e308 - -1e308`) and become `Infinity`,
 * which turns the ratio into `NaN`. Halving first keeps it finite; the ratios
 * use half-differences on both sides, so the factor cancels out.
 */
function halfDiff(a: number, b: number): number {
	return a / 2 - b / 2;
}
