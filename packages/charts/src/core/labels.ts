import { dropCollidingTicks, thinCategoryLabels, thinCenteredTicks } from './ticks-time';

/**
 * Axis-label width estimation (pure, Vitest-covered - spec §6.2 keeps number
 * logic out of the components). SVG <text> cannot be measured before render
 * without a DOM round-trip, so margins that depend on label length (e.g. the
 * left margin of a horizontal bar chart holding category names) use a
 * per-character estimate instead: fullwidth/CJK glyphs are roughly square
 * (~1.18em, i.e. ~13px at the 11px tick font), everything else (~digits,
 * ASCII, halfwidth kana) averages ~0.62em. Deliberately slightly generous -
 * a few px of unused margin is invisible; a clipped label is not.
 *
 * The charts pass `fontSize` = the computed font size of a rendered label
 * (`internal/label-font.ts`, theme-dimension-tokens.md D9-b), since the label
 * CSS uses the rem type tokens; the 11px default is what they use until it
 * can be read (SSR, tests) and what direct callers get when they omit it.
 */

const CJK_CHAR_WIDTH_EM = 1.18;
const DEFAULT_CHAR_WIDTH_EM = 0.62;

/** True for characters rendered fullwidth (CJK ideographs, kana, fullwidth forms, CJK punctuation). */
function isFullwidth(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0x9fff) || // CJK radicals..ideographs (incl. kana 3040-30FF)
		(codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compatibility forms
		(codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth forms
		(codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extensions
	);
}

/** Estimated rendered width (px) of `text` at `fontSize` px. */
export function estimateLabelWidth(text: string, fontSize = 11): number {
	let em = 0;
	for (const char of text) {
		em += isFullwidth(char.codePointAt(0) ?? 0) ? CJK_CHAR_WIDTH_EM : DEFAULT_CHAR_WIDTH_EM;
	}
	return em * fontSize;
}

const ELLIPSIS = '…';

/**
 * `text` shortened with a trailing ellipsis so its estimated width at
 * `fontSize` fits `maxWidth` (px); unchanged when it already fits. Used for
 * category labels whose margin hit its cap (absolute `max` or 40% of the
 * chart width): the cap wins so the plot never collapses, and the label is
 * cut visibly instead of overflowing the chart edge (the components keep the
 * full text in a `<title>`). Returns '' when not even the ellipsis fits.
 */
export function truncateLabel(text: string, maxWidth: number, fontSize = 11): string {
	if (estimateLabelWidth(text, fontSize) <= maxWidth) return text;
	// CJK fonts draw '…' fullwidth: budget it like a fullwidth glyph.
	const ellipsis = CJK_CHAR_WIDTH_EM * fontSize;
	const chars = [...text];
	while (chars.length > 0) {
		chars.pop();
		const prefix = chars.join('');
		if (estimateLabelWidth(prefix, fontSize) + ellipsis <= maxWidth) return prefix + ELLIPSIS;
	}
	return ellipsis <= maxWidth ? ELLIPSIS : '';
}

export interface AxisMarginOptions {
	fontSize?: number;
	/** Gap between the label's end and the plot edge (the `x = innerLeft - gap` offset used by the components). */
	gap?: number;
	min?: number;
	/**
	 * Absolute cap (px). Default: 140px at the 11px label font, scaled with
	 * `fontSize` so a larger rendered font (root font size / token override,
	 * D9-b) doesn't clip labels that fit at the standard size.
	 */
	max?: number;
}

const DEFAULT_MAX_MARGIN = 140;

/** The default absolute cap for `fontSize` (140px at 11px). */
function defaultMax(fontSize: number): number {
	return (DEFAULT_MAX_MARGIN * fontSize) / 11;
}

/**
 * Max share of the chart width each auto-grown margin may take. Left and
 * right are capped separately, so together they never exceed 80% and the
 * plot keeps at least 20% of the width.
 */
const MAX_TICK_MARGIN_RATIO = 0.4;

/**
 * Value-axis tick labels (numbers + a unit such as 件) are short, so they may
 * take a little more than the category cap: at 200% text on a 320px chart
 * ("500件" = 29.7px font, 77.8px wide, 211px svg) the label needs 86px, 41%,
 * and the 40% cap clipped its left edge by ~2px. Category labels keep 40%
 * (they are truncated with an ellipsis instead).
 */
const MAX_VALUE_TICK_MARGIN_RATIO = 0.45;

export interface TickMarginOptions extends AxisMarginOptions {
	/** Measured container width (px). Unknown/0 -> only the absolute `max` applies. */
	totalWidth?: number;
}

/** `max`, further capped at 40% of `totalWidth` when the width is known. */
function widthCap(max: number, totalWidth: number, ratio: number = MAX_TICK_MARGIN_RATIO): number {
	return totalWidth > 0 ? Math.min(max, Math.floor(totalWidth * ratio)) : max;
}

/**
 * Left margin needed to fit end-anchored axis labels (horizontal bar chart
 * category names): the longest estimated label + gap, clamped to [min, max]
 * so one pathological label can't crush the plot area. With `totalWidth`,
 * also capped at 40% of it (that cap wins over `min` in a very narrow chart).
 */
export function leftMarginFor(labels: string[], options: TickMarginOptions = {}): number {
	const { fontSize = 11, gap = 8, min = 48, totalWidth = 0 } = options;
	const max = widthCap(options.max ?? defaultMax(fontSize), totalWidth);
	const widest = labels.reduce(
		(acc, label) => Math.max(acc, estimateLabelWidth(label, fontSize)),
		0
	);
	// ceil (not round): a label that sets the margin must never be cut by `truncateLabel`.
	return Math.floor(Math.min(max, Math.ceil(Math.max(min, widest + gap))));
}

/** Grow `base` to fit the widest label (+ `gap`), capped by `max` and 40% of `totalWidth`; never below `base`. */
function growMargin(labels: string[], base: number, gap: number, o: TickMarginOptions): number {
	const { fontSize = 11, totalWidth = 0 } = o;
	const max = Math.floor(o.max ?? defaultMax(fontSize));
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, estimateLabelWidth(label, fontSize));
	const cap = Math.max(base, widthCap(max, totalWidth, MAX_VALUE_TICK_MARGIN_RATIO));
	return Math.min(cap, Math.max(base, Math.ceil(widest + gap)));
}

/**
 * Left margin needed to fit the end-anchored y tick labels of a value axis
 * (line/combo/area/scatter charts): `max(baseLeft, widest label + gap)`.
 * `baseLeft` is the caller's (or the chart's default) left margin and acts as
 * the minimum, so charts whose labels already fit keep their exact previous
 * layout; only clipped cases widen.
 *
 * The growth is capped (same policy as `leftMarginFor`: absolute `max`,
 * default 140px) and, when the container width is known (`totalWidth` > 0),
 * also at 40% of it, so a pathological label (e.g. `1e100` through the
 * default formatter, ~130 chars) can't squeeze the plot area to zero. When
 * capped, the label simply clips at the container edge rather than the plot
 * disappearing. The cap never goes below `baseLeft`.
 */
export function leftMarginForTicks(
	labels: string[],
	baseLeft: number,
	options: TickMarginOptions = {}
): number {
	return growMargin(labels, baseLeft, options.gap ?? 8, options);
}

/** Right-axis counterpart of `leftMarginForTicks` (start-anchored labels, 12px clearance), same cap policy. */
export function rightMarginForTicks(
	labels: string[],
	baseRight: number,
	options: TickMarginOptions = {}
): number {
	return growMargin(labels, baseRight, options.gap ?? 12, options);
}

/**
 * Right margin needed so the LAST middle-anchored tick label of a bottom
 * value axis doesn't clip at the container edge: half the label overhangs
 * the plot's right edge, so reserve that half (plus a small pad). With
 * `totalWidth`, capped at 40% of it like the other margins.
 */
export function rightMarginForLastTick(lastLabel: string, options: TickMarginOptions = {}): number {
	const { fontSize = 11, gap = 4, min = 16, totalWidth = 0 } = options;
	const margin = Math.round(Math.max(min, estimateLabelWidth(lastLabel, fontSize) / 2 + gap));
	// No absolute cap (as before); with `totalWidth`, at most 40% of it.
	return Math.min(margin, widthCap(Infinity, totalWidth));
}

/**
 * Right margin for a band (categorical) x axis whose LAST label is centred in
 * the last band: the label overhangs the plot's right edge by half its width
 * minus half a band step, so a large font on a narrow chart clips it. Solves
 * `step = (totalWidth - left - right) / count` for the `right` that keeps the
 * label inside; never below `baseRight` (a caller's `margins.right` or the
 * default 16), and with `totalWidth` capped at 40% of it like the other
 * margins. Without `totalWidth` (SSR, tests) it returns `baseRight`.
 */
export function rightMarginForBandLabel(
	lastLabel: string,
	count: number,
	options: TickMarginOptions & { baseRight?: number; left?: number } = {}
): number {
	const { fontSize = 11, gap = 4, totalWidth = 0, baseRight = 16, left = 0 } = options;
	if (count <= 0 || totalWidth <= 0) return baseRight;
	const half = estimateLabelWidth(lastLabel, fontSize) / 2 + gap;
	const needed = Math.ceil((half - (totalWidth - left) / (2 * count)) / (1 - 1 / (2 * count)));
	return Math.max(baseRight, Math.min(needed, widthCap(Infinity, totalWidth)));
}

export interface BandLabel {
	/** Index into the input labels. */
	index: number;
	/** Text to draw (the end labels are cut with an ellipsis when they would leave the svg). */
	text: string;
	/** The full text; draw a `<title>` with it when it differs from `text`. */
	full: string;
}

/**
 * Picks and fits the x labels of a band (categorical) axis whose labels are
 * centred on `centers`. The FIRST and LAST labels are cut with an ellipsis
 * (`truncateLabel`) to the width that is left between their centre and the svg
 * edge (needs `totalWidth`; without it nothing is cut), then the labels are
 * thinned by their drawn widths (`thinCategoryLabels`). When even the first and
 * last collide only the LAST is kept (the latest category matters most), so a
 * narrow chart never loses its end label. Labels whose text is cut to nothing
 * are dropped.
 */
export function fitBandLabels(
	labels: string[],
	centers: number[],
	options: { fontSize?: number; totalWidth?: number; gap?: number } = {}
): BandLabel[] {
	const { fontSize = 11, totalWidth = 0, gap = 4 } = options;
	const n = labels.length;
	if (n === 0) return [];
	const edge = 2;
	const texts = labels.slice();
	if (totalWidth > 0) {
		// Each end label is centred on its tick, so it may use twice the distance to
		// the NEARER svg edge (a long last label can push its centre into the left
		// half; a lone label is both first and last).
		const room = (c: number) => 2 * Math.max(0, Math.min(c - edge, totalWidth - c - edge));
		texts[0] = truncateLabel(labels[0], room(centers[0]), fontSize);
		if (n > 1) texts[n - 1] = truncateLabel(labels[n - 1], room(centers[n - 1]), fontSize);
	}
	let kept = thinCategoryLabels(
		centers,
		texts.map((t) => estimateLabelWidth(t, fontSize)),
		gap
	);
	if (n > 1 && kept.length === 1 && kept[0] === 0) kept = [n - 1];
	return kept
		.filter((i) => texts[i] !== '')
		.map((i) => ({ index: i, text: texts[i], full: labels[i] }));
}

/**
 * Left margin needed so the FIRST middle-anchored x label of a value axis
 * (centred on the plot's left edge) doesn't leave the svg: half its width plus
 * a small pad. Callers take `max(baseLeft, ...)` so layouts whose labels already
 * fit are unchanged. With `totalWidth`, capped at 40% of it like the other margins.
 */
export function leftMarginForFirstLabel(
	firstLabel: string,
	options: TickMarginOptions = {}
): number {
	const { fontSize = 11, gap = 4, totalWidth = 0 } = options;
	const margin = Math.ceil(estimateLabelWidth(firstLabel, fontSize) / 2 + gap);
	return Math.min(margin, widthCap(Infinity, totalWidth));
}

/**
 * Indices of the labels of a continuous (value) axis to draw: all while they
 * fit, otherwise thinned evenly with the first and last kept. `xs[i]` is the
 * centre of label `i`; widths are estimated at `fontSize` (same measure as
 * `fitBandLabels`, no DOM). Only the labels are thinned - callers keep every
 * gridline.
 */
export function thinValueLabels(
	labels: string[],
	xs: number[],
	options: { fontSize?: number; gap?: number } = {}
): number[] {
	const { fontSize = 11, gap = 4 } = options;
	return thinKeepEnd(
		xs,
		labels.map((l) => estimateLabelWidth(l, fontSize)),
		gap
	);
}

/**
 * True when the y label at the plot's bottom-left (end-anchored at
 * `innerLeft - yGap`, centred on the x axis) would collide with the first x
 * label (`xAnchor` 'middle' on the plot's left edge, or 'start'/'end'; baseline
 * `xBaseline` px below the axis). At the standard font the x label sits
 * below the y label, so nothing is dropped; a large font pushes them into each
 * other, and then the caller omits the y label (the origin is implied by the
 * axis). Pass the label that survived thinning, with its drawn text and anchor,
 * not the first candidate. Glyph boxes use digit height (~0.72em).
 */
export function originLabelsCollide(
	xLabel: string,
	yLabel: string,
	options: {
		fontSize?: number;
		xBaseline?: number;
		xAnchor?: 'middle' | 'start' | 'end';
		/** Distance (px) of the x label's anchor from the plot's left edge (0 = on the edge; a band centre for a band axis). */
		xOffset?: number;
		yGap?: number;
	} = {}
): boolean {
	const { fontSize = 11, xBaseline = 16, xAnchor = 'middle', xOffset = 0, yGap = 8 } = options;
	if (xLabel === '' || yLabel === '') return false;
	// vertical: x label top (below the axis) vs. bottom of the y label centred on the axis
	if (xBaseline - 0.72 * fontSize >= 0.36 * fontSize) return false;
	const xw = estimateLabelWidth(xLabel, fontSize);
	const xLeft = xOffset + (xAnchor === 'middle' ? -xw / 2 : xAnchor === 'end' ? -xw : 0);
	const yRight = -yGap;
	const yLeft = yRight - estimateLabelWidth(yLabel, fontSize);
	const xRight = xLeft + xw;
	return xLeft < yRight && yLeft < xRight;
}

/**
 * Horizontal bar chart: true when a bottom value label (its drawn centre
 * `xOffset` px right of the plot's left edge, as `placeEdgeLabel` reports, baseline `xBaseline` below the
 * axis) would collide with the lowest category label (end-anchored at
 * `innerLeft - gap`, vertically centred `catCenterAbove` px above the axis).
 * At the standard font the value labels sit well below the category labels;
 * a large font (or a low band) pushes the origin value label into the lowest
 * category name, and then the caller omits the VALUE label (the category name
 * carries the meaning; the gridline still marks the value). Widths are
 * estimates, so both boxes get a safety margin (width x1.15, half an em of slack)
 * to stay correct on fonts wider than the estimate; heights are line boxes
 * (~1.5em), like the E2E check measures them.
 */
export function horizontalOriginLabelsCollide(
	valueLabel: string,
	categoryLabel: string,
	options: {
		fontSize?: number;
		xBaseline?: number;
		xOffset?: number;
		catCenterAbove: number;
		gap?: number;
		/** Width (px) the category label is cut to (the left margin), when it is capped. */
		catMaxWidth?: number;
	}
): boolean {
	const {
		fontSize = 11,
		xBaseline = 16,
		xOffset = 0,
		catCenterAbove,
		gap = 8,
		catMaxWidth
	} = options;
	if (valueLabel === '' || categoryLabel === '') return false;
	// Boxes are judged as the browser draws them: line boxes (~1.5em tall, taller than the glyphs
	// for CJK / fallback fonts). Vertically they collide when either centre lies inside the other's box.
	const valueCentre = xBaseline - 0.36 * fontSize;
	const catCentre = -catCenterAbove;
	if (Math.abs(valueCentre - catCentre) >= 0.75 * fontSize) return false;
	// Horizontally: the estimated widths get a margin, and the category label's right edge a slack of
	// half an em (a wider real font / the end anchor's rounding), so a Linux font cannot slip through.
	const vw = estimateLabelWidth(valueLabel, fontSize) * 1.15;
	const cw = Math.min(estimateLabelWidth(categoryLabel, fontSize) * 1.15, catMaxWidth ?? Infinity);
	const slack = 0.5 * fontSize;
	return xOffset - vw / 2 < -gap + slack && xOffset + vw / 2 > -gap - cw;
}

/**
 * Indices of the y tick labels of a vertical value axis to draw: all while
 * they fit, otherwise thinned evenly with the first (the origin) and the last
 * (the top) kept. `ys[i]` is the screen y of tick `i` (ticks in ascending value
 * order, so `ys` descends); a label is `fontSize * 1.1` px high. Only the
 * labels are thinned - callers keep every gridline. A pane with room for every
 * label keeps all of them.
 */
export function thinVerticalLabels(ys: number[], fontSize = 11): number[] {
	return thinKeepEnd(
		ys.map((y) => -y),
		ys.map(() => fontSize * 1.1),
		0
	);
}

/**
 * `thinCenteredTicks` with an explicit priority for a space too small for both
 * ends: it keeps only the FIRST tick there, which silently dropped the last one
 * (the upper bound of a value axis, the latest category). Here the LAST wins
 * (the end that tells the scale / the newest), so the result is never empty and
 * a lone label is the last one. Otherwise identical (first and last both kept
 * while they fit).
 */
export function thinKeepEnd(xs: number[], widths: number[], gap = 4): number[] {
	const kept = thinCenteredTicks(xs, widths, gap);
	return xs.length > 1 && kept.length === 1 && kept[0] === 0 ? [xs.length - 1] : kept;
}

/**
 * True when a label centred on `x` would leave the svg on the left (the first
 * x label of a value axis sits on the plot's left edge, and the left margin
 * could not grow enough - it is capped at 40% of the width). The caller then
 * anchors it 'start' so it reads inward from the edge instead of being cut.
 */
export function clipsLeft(label: string, x: number, fontSize = 11): boolean {
	return x - estimateLabelWidth(label, fontSize) / 2 < 0;
}

/** True when a label centred on `x` would leave the svg on the right (`svgWidth` px wide). */
export function clipsRight(label: string, x: number, svgWidth: number, fontSize = 11): boolean {
	return x + estimateLabelWidth(label, fontSize) / 2 > svgWidth;
}

/** Where and how an x tick label is drawn. */
export interface EdgeLabelPlacement {
	/** The text to draw (cut with an ellipsis when it does not fit; `full` keeps the original for a `<title>`). */
	text: string;
	full: string;
	anchor: 'middle' | 'start' | 'end';
	/** Centre (px) of the drawn extent - what collision thinning should use for this label. */
	centre: number;
	/** Estimated drawn width (px) of `text`. */
	width: number;
}

/**
 * Anchor and text for a tick label at `x` in an svg `svgWidth` px wide.
 * Centred while both halves stay inside; 'start' when only the left half
 * crosses (reads inward from the edge) and 'end' when only the right half does
 * (a last label whose right margin hit its cap). When even that crosses the
 * svg (it is wider than the room on that side) it is cut with an ellipsis to
 * the remaining width (the caller keeps the full text in a `<title>`).
 * `centre`/`width` describe the real drawn extent, so collision thinning done
 * afterwards sees where the label actually sits. `forceEnd` right-aligns the
 * label at `x` regardless (the last tick of a line / stacked-area axis).
 */
export function placeEdgeLabel(
	label: string,
	x: number,
	fontSize: number,
	svgWidth: number,
	forceEnd = false
): EdgeLabelPlacement {
	const w = estimateLabelWidth(label, fontSize);
	const left = clipsLeft(label, x, fontSize);
	if (forceEnd || (!left && clipsRight(label, x, svgWidth, fontSize))) {
		const text = truncateLabel(label, Math.max(0, x), fontSize);
		const tw = estimateLabelWidth(text, fontSize);
		return { text, full: label, anchor: 'end', centre: x - tw / 2, width: tw };
	}
	if (!left) {
		return { text: label, full: label, anchor: 'middle', centre: x, width: w };
	}
	const text = truncateLabel(label, Math.max(0, svgWidth - x), fontSize);
	const tw = estimateLabelWidth(text, fontSize);
	return { text, full: label, anchor: 'start', centre: x + tw / 2, width: tw };
}

/**
 * `dropCollidingTicks` for labels already placed by `placeEdgeLabel`. That
 * function takes the LAST label's anchor `x` (its box extends left of it) and
 * every earlier label's centre, while `placeEdgeLabel` reports each label's
 * drawn centre: passing those centres straight in shifted the last label left
 * by half its width twice. The last label's anchor is rebuilt here as its
 * drawn right edge (centre + width / 2), so its left edge is its true one for
 * any anchor.
 */
export function dropCollidingPlaced(
	indices: number[],
	places: EdgeLabelPlacement[],
	gap = 4
): number[] {
	const last = places.length - 1;
	return dropCollidingTicks(
		indices,
		places.map((p, k) => (k === last ? p.centre + p.width / 2 : p.centre)),
		places.map((p) => p.width),
		gap
	);
}
