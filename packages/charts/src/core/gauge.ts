import { estimateLabelWidth, truncateLabel } from './labels';

/**
 * Gauge arc-angle + threshold-color math (spec §6.1 Gauge). The track sweeps
 * 270deg, from 135deg to 405deg in `core/pie.ts`'s angle convention (0deg =
 * +x/3 o'clock, clockwise) - that range traces up over the top and back down
 * to a 90deg gap centered at the bottom, the classic speedometer shape, and
 * feeds straight into `arcPath(cx, cy, rOuter, rInner, 135, gaugeAngle(...))`.
 */
export const GAUGE_START_DEG = 135;
export const GAUGE_SWEEP_DEG = 270;
export const GAUGE_END_DEG = GAUGE_START_DEG + GAUGE_SWEEP_DEG; // 405

/**
 * `value` clamped into `[min, max]`, expressed as a ratio 0..1 of that range.
 * A degenerate/inverted range (`max <= min`) yields 0 rather than dividing by
 * zero or a negative span. A non-finite `value` is treated as the range
 * floor (ratio 0) rather than propagating `NaN` into the arc geometry.
 */
export function gaugeRatio(value: number, min: number, max: number): number {
	if (max <= min || !Number.isFinite(value)) return 0;
	const clamped = Math.min(max, Math.max(min, value));
	return (clamped - min) / (max - min);
}

/**
 * Absolute end angle (degrees, `core/pie.ts` convention) of the value arc:
 * `GAUGE_START_DEG` when `value <= min`, `GAUGE_END_DEG` when `value >= max`,
 * linear in between. Pass this straight as `arcPath`'s `endDeg` alongside
 * `GAUGE_START_DEG` as `startDeg`.
 */
export function gaugeAngle(value: number, min: number, max: number): number {
	return GAUGE_START_DEG + gaugeRatio(value, min, max) * GAUGE_SWEEP_DEG;
}

export interface GaugeThresholds {
	warning?: number;
	danger?: number;
	/** Lower warning threshold: `value <= warningLow` is warning-colored (e.g. low-level alarm). */
	warningLow?: number;
	/** Lower danger threshold: `value <= dangerLow` is danger-colored; wins over `warningLow`. */
	dangerLow?: number;
}

/**
 * Value-arc color: a THEME status var (spec §6.4 rule 10 - never a
 * chart series slot), chosen by which threshold `value` has reached or
 * crossed ("crossed above", i.e. `value >= threshold`; the lower thresholds
 * `warningLow`/`dangerLow` match on `value <= threshold`). Danger wins over
 * warning (checked first); omitted thresholds never match, so no `thresholds`
 * prop at all means "always primary". A non-finite `value` never matches
 * and stays primary.
 */
export function gaugeColorVar(value: number, thresholds: GaugeThresholds = {}): string {
	if (thresholds.danger !== undefined && value >= thresholds.danger) return 'var(--banto-danger)';
	if (thresholds.dangerLow !== undefined && value <= thresholds.dangerLow)
		return 'var(--banto-danger)';
	if (thresholds.warning !== undefined && value >= thresholds.warning)
		return 'var(--banto-warning)';
	if (thresholds.warningLow !== undefined && value <= thresholds.warningLow)
		return 'var(--banto-warning)';
	return 'var(--banto-primary)';
}

/** Gap (px) between the arc and the min/max labels, measured along the +/-45deg diagonal. */
export const GAUGE_LABEL_GAP = 14;
/** Smallest outer radius (px) the dial shrinks to for the labels; below this the labels are cut instead. */
export const GAUGE_MIN_FIT_RADIUS = 36;
const GAUGE_ABSOLUTE_MIN_RADIUS = 10;
const LABEL_SEPARATION = 4;
const EDGE_PAD = 2;

export interface GaugeLayoutInput {
	width: number;
	plotHeight: number;
	minText: string;
	maxText: string;
	fontSize: number;
	sidePad: number;
	topPad: number;
	bottomPad: number;
	trackWidth: number;
	/** Vertical extent of the 270deg arc relative to rOuter. */
	verticalFactor: number;
}

export interface GaugeLayout {
	cx: number;
	cy: number;
	rOuter: number;
	rInner: number;
	/** Text to draw for the min / max label (truncated with an ellipsis when it cannot fit). */
	minLabel: string;
	maxLabel: string;
}

/**
 * Dial geometry plus the two range labels. The labels sit at +/-45deg off the
 * bottom, `GAUGE_LABEL_GAP` outside the arc, centred there. The radius shrinks
 * (down to `GAUGE_MIN_FIT_RADIUS`) so the wider label stays inside the svg;
 * whatever still does not fit - the edge or the gap between the two labels - is
 * cut with an ellipsis (the component keeps the full text in a `<title>`).
 * Unchanged while everything fits.
 */
export function gaugeLayout(i: GaugeLayoutInput): GaugeLayout {
	const wMin = estimateLabelWidth(i.minText, i.fontSize);
	const wMax = estimateLabelWidth(i.maxText, i.fontSize);
	const half = Math.max(wMin, wMax) / 2;
	const rLabelFit = (i.width / 2 - EDGE_PAD - half) / Math.SQRT1_2 - GAUGE_LABEL_GAP;
	const rBase = Math.min(
		(i.width - i.sidePad * 2) / 2,
		(i.plotHeight - i.topPad - i.bottomPad) / i.verticalFactor
	);
	const rOuter = Math.max(
		GAUGE_ABSOLUTE_MIN_RADIUS,
		Math.min(rBase, Math.max(rLabelFit, Math.min(rBase, GAUGE_MIN_FIT_RADIUS)))
	);
	const cx = i.width / 2;
	const cy = i.topPad + rOuter;
	const rInner = Math.max(1, rOuter - i.trackWidth);

	// Label centres sit `d` from cx; each may reach the svg edge, and the two
	// together must leave `LABEL_SEPARATION` between them.
	const d = (rOuter + GAUGE_LABEL_GAP) * Math.SQRT1_2;
	const edgeMax = 2 * (i.width / 2 - EDGE_PAD - d);
	const pairMax = 2 * (2 * d - LABEL_SEPARATION);
	const minIsShort = wMin <= wMax;
	const shortW = Math.min(wMin, wMax);
	const shortFit = Math.min(shortW, Math.max(0, edgeMax));
	const longMax = Math.max(0, Math.min(edgeMax, pairMax - shortFit));
	const shortMax = Math.max(
		0,
		Math.min(edgeMax, pairMax - Math.min(Math.max(wMin, wMax), longMax))
	);
	const fit = (text: string, max: number) => truncateLabel(text, max, i.fontSize);
	return {
		cx,
		cy,
		rOuter,
		rInner,
		minLabel: fit(i.minText, minIsShort ? shortMax : longMax),
		maxLabel: fit(i.maxText, minIsShort ? longMax : shortMax)
	};
}
