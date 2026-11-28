<script lang="ts" generics="TRow">
	/**
	 * Bar chart: vertical or horizontal, grouped or stacked (spec §6). Data is
	 * pre-aggregated by the caller (one row per category). The value axis
	 * ALWAYS includes 0 (rule 7 - a bar axis is never truncated), and rounds
	 * only the bar's true "data end" (top for vertical, right for horizontal)
	 * per rule 3; the opposite (baseline) end is always square.
	 *
	 * v1 scope note: the rounded-cap logic assumes non-negative values (the
	 * dashboard's stock-count / bucket-count data always is). A negative-value
	 * bar still renders correctly (0-baseline, proper stacking direction, see
	 * `core/stack.ts`) but keeps a square top rather than a rounded bottom -
	 * documented simplification, not exercised by this milestone's charts.
	 */
	import { linearScale, bandScale, niceTicks } from './core/scale';
	import { stackSeries, type StackSegment } from './core/stack';
	import { roundedTopBarPath } from './core/path';
	import { seriesColorVar } from './core/color';
	import {
		estimateLabelWidth,
		leftMarginFor,
		leftMarginForFirstLabel,
		fitBandLabels,
		originLabelsCollide,
		rightMarginForBandLabel,
		leftMarginForTicks,
		rightMarginForLastTick,
		truncateLabel,
		thinVerticalLabels,
		thinKeepEnd
	} from './core/labels';
	import { DEFAULT_LABEL_FONT_SIZE, trackFontSize } from './internal/label-font';
	import { handleMarkKeydown, isKeyboardFocus, onMarkDetached } from './internal/mark-keys';
	import {
		getValue,
		toNumber,
		type Accessor,
		type ChartMargin,
		type ChartMark,
		type MarkProps,
		type TooltipRow
	} from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface BarSeries {
		id: string;
		label: string;
		value: Accessor<TRow>;
	}

	interface Props extends MarkProps<TRow> {
		data: TRow[];
		category: Accessor<TRow>;
		series: BarSeries[];
		stacked?: boolean;
		horizontal?: boolean;
		label: string;
		height?: number;
		formatValue?: (n: number) => string;
		/** Per-side overrides merged over the computed defaults (see `MARGIN` below). */
		margins?: Partial<ChartMargin>;
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		category,
		series,
		stacked = false,
		horizontal = false,
		label,
		height = 240,
		formatValue,
		margins,
		messages = {},
		onMarkActivate,
		markLabel,
		markSelected
	}: Props = $props();

	const RADIUS = 4;
	const CATEGORY_PADDING = 0.3;

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));
	const t = $derived({ ...defaultChartMessages, ...messages });

	const categories = $derived(data.map((row) => getValue(row, category)));
	const matrix = $derived(data.map((row) => series.map((s) => toNumber(getValue(row, s.value)))));
	const isEmpty = $derived(data.length === 0 || series.length === 0);

	const stackedSegments = $derived(stacked ? stackSeries(matrix) : null);

	// Value domain always spans at least [0, ...] (rule 7) whether stacked
	// (bounded by running stack offsets) or grouped (bounded by raw values).
	const boundaryValues = $derived.by(() => {
		if (stackedSegments) return stackedSegments.flat().flatMap((seg) => [seg.start, seg.end]);
		return matrix.flat().filter((v) => Number.isFinite(v));
	});
	const dataMin = $derived(Math.min(0, ...(boundaryValues.length ? boundaryValues : [0])));
	const dataMax = $derived(Math.max(0, ...(boundaryValues.length ? boundaryValues : [1])));
	const valueTicks = $derived(niceTicks(dataMin, dataMax, 5));
	// The value SCALE spans the nice-tick range, not the raw data extent -
	// niceTicks rounds outward (e.g. data max 293k -> last tick 300k), so
	// using the data extent as the scale domain would place trailing ticks
	// beyond the plot edge (clipped labels) and bars would touch the very
	// edge of the plot. Ticks and bars share this one scale domain.
	const domainMin = $derived(valueTicks[0]);
	const domainMax = $derived(valueTicks[valueTicks.length - 1]);

	const legendItems = $derived(
		series.map((s, i) => ({ id: s.id, label: s.label, colorVar: seriesColorVar(i) }))
	);

	// Default margins are label-aware in horizontal mode: the left margin
	// grows to fit the longest category name (end-anchored at innerLeft - 8,
	// clamped so one long name can't crush the plot), and the right margin
	// reserves half the LAST bottom value-tick label (middle-anchored, so
	// half of it overhangs the plot's right edge). Both are estimates from
	// `core/labels.ts` and can be overridden per side via the `margins` prop.
	// The estimates use the rendered tick font (D9-b: read from the first
	// category label (horizontal) / y tick label (vertical), 11px
	// until/unless it can be read).
	// Measured container width (bound from ChartContainer) so the margin cap can
	// be relative to it (40%), same as LineChart.
	let plotWidth: number = $state(0);
	let tickFontSize = $state(DEFAULT_LABEL_FONT_SIZE);
	const trackTickFont = trackFontSize((px) => (tickFontSize = px));
	const MARGIN = $derived.by((): ChartMargin => {
		const leftMargin = leftMarginForTicks(valueTicks.map(formatValueDisplay), 48, {
			fontSize: tickFontSize,
			totalWidth: plotWidth
		});
		const base = horizontal
			? {
					top: 8,
					right: rightMarginForLastTick(
						formatValueDisplay(valueTicks[valueTicks.length - 1] ?? 0),
						{ fontSize: tickFontSize, totalWidth: plotWidth }
					),
					bottom: 26,
					// The first value tick is middle-anchored on the plot's left edge: reserve half of it.
					left: Math.max(
						leftMarginFor(
							categories.map((cat) => String(cat ?? '')),
							{ fontSize: tickFontSize, totalWidth: plotWidth }
						),
						leftMarginForFirstLabel(formatValueDisplay(valueTicks[0] ?? 0), {
							fontSize: tickFontSize,
							totalWidth: plotWidth
						})
					)
				}
			: {
					top: 8,
					bottom: 26,
					// Vertical: the value tick labels, never below the previous 48px.
					left: leftMargin,
					// The last category label is centred in the last band: reserve room so a
					// large font on a narrow chart doesn't clip it (never below 16).
					right: rightMarginForBandLabel(
						categories.length > 0 ? String(categories[categories.length - 1] ?? '') : '',
						categories.length,
						{ baseRight: 16, left: leftMargin, totalWidth: plotWidth, fontSize: tickFontSize }
					)
				};
		return { ...base, ...margins };
	});

	interface BarRect {
		catIndex: number;
		seriesIndex: number;
		x: number;
		y: number;
		w: number;
		h: number;
		radius: number;
		value: number;
	}

	function plotMetrics(width: number, plotHeight: number) {
		const m = MARGIN;
		return {
			innerLeft: m.left,
			innerTop: m.top,
			innerWidth: Math.max(0, width - m.left - m.right),
			innerHeight: Math.max(0, plotHeight - m.top - m.bottom)
		};
	}

	/** Which segment in a stacked category is the visual "cap" (gets the rounded data-end). Assumes non-negative values (see file header note). */
	function capIndex(row: StackSegment[]): number {
		let cap = row.length - 1;
		for (let i = 0; i < row.length; i++) {
			if (row[i].value >= 0) cap = i;
		}
		return cap;
	}

	function computeBars(width: number, plotHeight: number): BarRect[] {
		const { innerLeft, innerTop, innerWidth, innerHeight } = plotMetrics(width, plotHeight);
		const bars: BarRect[] = [];

		if (horizontal) {
			const catScale = bandScale(data.length, [innerTop, innerTop + innerHeight], CATEGORY_PADDING);
			const valueScale = linearScale([domainMin, domainMax], [innerLeft, innerLeft + innerWidth]);

			data.forEach((_, catIndex) => {
				const catY = catScale.start(catIndex);
				if (stackedSegments) {
					const row = stackedSegments[catIndex];
					const cap = capIndex(row);
					row.forEach((seg, seriesIndex) => {
						const x0 = valueScale(seg.start);
						const x1 = valueScale(seg.end);
						bars.push({
							catIndex,
							seriesIndex,
							x: Math.min(x0, x1),
							y: catY,
							w: Math.abs(x1 - x0),
							h: catScale.bandwidth,
							radius: seriesIndex === cap ? RADIUS : 0,
							value: seg.value
						});
					});
				} else {
					const subScale = bandScale(series.length, [catY, catY + catScale.bandwidth], 0);
					series.forEach((_s, seriesIndex) => {
						const value = matrix[catIndex][seriesIndex];
						const x0 = valueScale(Math.min(0, value));
						const x1 = valueScale(Math.max(0, value));
						bars.push({
							catIndex,
							seriesIndex,
							x: x0,
							y: subScale.start(seriesIndex),
							w: Math.abs(x1 - x0),
							h: subScale.bandwidth,
							radius: value >= 0 ? RADIUS : 0,
							value
						});
					});
				}
			});
		} else {
			const catScale = bandScale(
				data.length,
				[innerLeft, innerLeft + innerWidth],
				CATEGORY_PADDING
			);
			const valueScale = linearScale([domainMin, domainMax], [innerTop + innerHeight, innerTop]);

			data.forEach((_, catIndex) => {
				const catX = catScale.start(catIndex);
				if (stackedSegments) {
					const row = stackedSegments[catIndex];
					const cap = capIndex(row);
					row.forEach((seg, seriesIndex) => {
						const y0 = valueScale(seg.start);
						const y1 = valueScale(seg.end);
						bars.push({
							catIndex,
							seriesIndex,
							x: catX,
							y: Math.min(y0, y1),
							w: catScale.bandwidth,
							h: Math.abs(y1 - y0),
							radius: seriesIndex === cap ? RADIUS : 0,
							value: seg.value
						});
					});
				} else {
					const subScale = bandScale(series.length, [catX, catX + catScale.bandwidth], 0);
					series.forEach((_s, seriesIndex) => {
						const value = matrix[catIndex][seriesIndex];
						const y0 = valueScale(Math.max(0, value));
						const y1 = valueScale(Math.min(0, value));
						bars.push({
							catIndex,
							seriesIndex,
							x: subScale.start(seriesIndex),
							y: y0,
							w: subScale.bandwidth,
							h: Math.max(0, y1 - y0),
							radius: value >= 0 ? RADIUS : 0,
							value
						});
					});
				}
			});
		}

		return bars;
	}

	// Pointer and keyboard focus are tracked separately: the pointer leaving a
	// mark must not hide the tooltip of the mark that still has the focus. The
	// pointer wins while it is over a mark; otherwise the focused mark is shown.
	let pointed: { catIndex: number; seriesIndex: number } | null = $state(null);
	let focusedMark: { catIndex: number; seriesIndex: number } | null = $state(null);
	// Checked against the current data: when `data` / `series` shrink, a removed
	// focused element may never fire blur, so a stale reference must not survive.
	const hovered: { catIndex: number; seriesIndex: number } | null = $derived.by(() => {
		const h = pointed ?? focusedMark;
		return h !== null && h.catIndex < data.length && h.seriesIndex < series.length ? h : null;
	});

	/** The mark's element left the document (data shrank, value became 0): drop the focus / pointer state that pointed at it. */
	function forgetMark(bar: BarRect): void {
		const same = (h: { catIndex: number; seriesIndex: number } | null) =>
			h !== null && h.catIndex === bar.catIndex && h.seriesIndex === bar.seriesIndex;
		if (same(focusedMark)) focusedMark = null;
		if (same(pointed)) pointed = null;
	}

	function isHovered(bar: BarRect): boolean {
		return (
			hovered !== null &&
			hovered.catIndex === bar.catIndex &&
			hovered.seriesIndex === bar.seriesIndex
		);
	}

	// Selectable marks (only when `onMarkActivate` is given; otherwise none of
	// this runs and the DOM is exactly what it was). Marks are one linear order,
	// category-major then series, which is also the order `computeBars` pushes
	// them in. Roving tabindex: exactly one mark is a Tab stop.
	// The tab stop is a mark identity (not a position), so it survives marks before it appearing or disappearing.
	let tabKey: string | null = $state(null);
	const keyOf = (b: { catIndex: number; seriesIndex: number }) => `${b.catIndex}:${b.seriesIndex}`;

	/**
	 * A mark with no drawn area (a zero-width stacked segment, a zero-value bar)
	 * is not selectable: it would be an invisible Tab stop with no focus ring.
	 * It stays a plain path. Selectable marks keep their order; the `index` the
	 * callback receives is still the position in `data`.
	 */
	function isDrawn(bar: BarRect): boolean {
		return bar.w > 0 && bar.h > 0;
	}

	function markFor(bar: BarRect): ChartMark<TRow> {
		return {
			row: data[bar.catIndex],
			index: bar.catIndex,
			category: String(categories[bar.catIndex] ?? ''),
			seriesId: series[bar.seriesIndex].id,
			value: bar.value
		};
	}

	function markName(bar: BarRect): string {
		const mark = markFor(bar);
		if (markLabel) return markLabel(mark);
		const value = formatValueDisplay(bar.value);
		return series.length > 1
			? t.markLabelWithSeries(mark.category, series[bar.seriesIndex].label, value)
			: t.markLabel(mark.category, value);
	}

	/**
	 * Pointer / focus area of a mark, wider than the drawn bar so a thin bar is
	 * easy to hit: a grouped bar takes its whole slot along the value axis; a
	 * stacked segment keeps its own extent (its neighbours share the column).
	 */
	function hitRect(bar: BarRect, m: ReturnType<typeof plotMetrics>) {
		if (stacked) return { x: bar.x, y: bar.y, w: bar.w, h: bar.h };
		return horizontal
			? { x: m.innerLeft, y: bar.y, w: m.innerWidth, h: bar.h }
			: { x: bar.x, y: m.innerTop, w: bar.w, h: m.innerHeight };
	}

	function tooltipFor(bar: BarRect): { title: string; rows: TooltipRow[] } {
		return {
			title: String(categories[bar.catIndex] ?? ''),
			rows: [
				{
					label: series[bar.seriesIndex].label,
					value: formatValueDisplay(bar.value),
					colorVar: seriesColorVar(bar.seriesIndex)
				}
			]
		};
	}
</script>

<div class="banto-barchart">
	<Legend items={legendItems} />
	<ChartContainer
		{label}
		{height}
		empty={isEmpty}
		interactive={onMarkActivate !== undefined}
		bind:width={plotWidth}
		{messages}
	>
		{#snippet plot({ width, height: plotHeight })}
			{@const m = plotMetrics(width, plotHeight)}
			{@const bars = computeBars(width, plotHeight)}
			{@const navPos = new Map(
				(onMarkActivate ? bars.filter(isDrawn) : []).map((b, i) => [b, i] as const)
			)}
			{@const navCount = navPos.size}
			{@const navBars = [...navPos.keys()]}
			{@const chosen = markSelected
				? new Set(navBars.filter((b) => markSelected(markFor(b))))
				: null}
			{@const stop = Math.max(
				0,
				navBars.findIndex((b) => keyOf(b) === tabKey)
			)}

			{#if horizontal}
				{@const valueScale = linearScale(
					[domainMin, domainMax],
					[m.innerLeft, m.innerLeft + m.innerWidth]
				)}
				<!-- Value labels are thinned so neighbours never collide (large root
				     font / narrow plot); gridlines stay at every tick. -->
				{@const shownTicks = new Set(
					thinKeepEnd(
						valueTicks.map((t) => valueScale(t)),
						valueTicks.map((t) => estimateLabelWidth(formatValueDisplay(t), tickFontSize)),
						// No extra gap: estimateLabelWidth already over-counts digits and the narrow
						// ',' / '.', and a 4px gap thinned labels the standard density shows legibly.
						0
					).map((i) => valueTicks[i])
				)}
				{#each valueTicks as tick (tick)}
					<line
						x1={valueScale(tick)}
						x2={valueScale(tick)}
						y1={m.innerTop}
						y2={m.innerTop + m.innerHeight}
						class="gridline"
					/>
					{#if shownTicks.has(tick)}
						<text
							x={valueScale(tick)}
							y={m.innerTop + m.innerHeight + 16}
							class="tick-label"
							text-anchor="middle"
						>
							{formatValueDisplay(tick)}
						</text>
					{/if}
				{/each}
				{@const catScale = bandScale(
					data.length,
					[m.innerTop, m.innerTop + m.innerHeight],
					CATEGORY_PADDING
				)}
				<!-- A low pane: when the labels are taller than the band step they are thinned
				     (first and last kept), like the x labels of a band axis; bars stay at every category. -->
				{@const shownRows = new Set(
					thinKeepEnd(
						categories.map((_, i) => catScale.center(i)),
						categories.map(() => tickFontSize * 1.1),
						0
					)
				)}
				{#each categories as cat, i (i)}
					<!-- Thinned rows stay in the DOM (visibility hidden) so the row-0 font tracker survives. -->
					<!-- Cut with an ellipsis when the margin hit its cap (full text in <title>). -->
					{@const full = String(cat ?? '')}
					{@const shown = truncateLabel(full, m.innerLeft - 8, tickFontSize)}
					<text
						x={m.innerLeft - 8}
						y={catScale.center(i)}
						class="tick-label"
						text-anchor="end"
						dominant-baseline="middle"
						visibility={shownRows.has(i) ? undefined : 'hidden'}
						{@attach i === 0 ? trackTickFont : null}
					>
						{shown}{#if shown !== full}<title>{full}</title>{/if}
					</text>
				{/each}
				<line
					x1={m.innerLeft}
					x2={m.innerLeft}
					y1={m.innerTop}
					y2={m.innerTop + m.innerHeight}
					class="axis-line"
				/>
			{:else}
				{@const valueScale = linearScale(
					[domainMin, domainMax],
					[m.innerTop + m.innerHeight, m.innerTop]
				)}
				{@const catScaleX = bandScale(
					data.length,
					[m.innerLeft, m.innerLeft + m.innerWidth],
					CATEGORY_PADDING
				)}
				{@const xLabels = categories.map((cat) => String(cat ?? ''))}
				<!-- The bottom y label yields to the first category label when a large font makes them meet. -->
				{@const originCollides =
					xLabels.length > 0 &&
					originLabelsCollide(xLabels[0], formatValueDisplay(valueTicks[0] ?? 0), {
						fontSize: tickFontSize,
						xBaseline: 16,
						xOffset: catScaleX.center(0) - m.innerLeft
					})}
				<!-- Y labels thinned by their height when the pane is low (0 and the top kept); gridlines stay at every tick. -->
				{@const shownY = new Set(
					thinVerticalLabels(
						valueTicks.map((t) => valueScale(t)),
						tickFontSize
					)
				)}
				{#each valueTicks as tick, ti (tick)}
					<line
						x1={m.innerLeft}
						x2={m.innerLeft + m.innerWidth}
						y1={valueScale(tick)}
						y2={valueScale(tick)}
						class="gridline"
					/>
					<text
						x={m.innerLeft - 8}
						y={valueScale(tick)}
						class="tick-label"
						text-anchor="end"
						dominant-baseline="middle"
						visibility={!shownY.has(ti) || (ti === 0 && originCollides) ? 'hidden' : undefined}
						{@attach ti === 0 ? trackTickFont : null}
					>
						{formatValueDisplay(tick)}
					</text>
				{/each}
				<!-- Category labels are thinned when crowded (many categories / large
				     root font); bars stay at every category. -->
				{#each fitBandLabels( xLabels, xLabels.map( (_, i) => catScaleX.center(i) ), { fontSize: tickFontSize, totalWidth: width } ) as lb (lb.index)}
					<text
						x={catScaleX.center(lb.index)}
						y={m.innerTop + m.innerHeight + 16}
						class="tick-label"
						text-anchor="middle"
					>
						{lb.text}{#if lb.text !== lb.full}<title>{lb.full}</title>{/if}
					</text>
				{/each}
				<line
					x1={m.innerLeft}
					x2={m.innerLeft + m.innerWidth}
					y1={m.innerTop + m.innerHeight}
					y2={m.innerTop + m.innerHeight}
					class="axis-line"
				/>
			{/if}

			{#each bars as bar (`${bar.catIndex}-${bar.seriesIndex}`)}
				{#if onMarkActivate && navPos.has(bar)}
					{@const hit = hitRect(bar, m)}
					{@const idx = navPos.get(bar) ?? 0}
					<g
						class="mark"
						class:dimmed={chosen !== null && chosen.size > 0 && !chosen.has(bar)}
						{@attach (node: Element) => onMarkDetached(node, () => forgetMark(bar))}
						role="button"
						tabindex={idx === stop ? 0 : -1}
						aria-label={markName(bar)}
						aria-pressed={chosen ? chosen.has(bar) : undefined}
						data-mark-index={idx}
						onclick={() => onMarkActivate(markFor(bar))}
						onkeydown={(e) =>
							handleMarkKeydown(
								e,
								idx,
								navCount,
								() => onMarkActivate(markFor(bar)),
								(next) => (tabKey = keyOf(navBars[next]))
							)}
						onfocus={(e) => {
							tabKey = keyOf(bar);
							if (isKeyboardFocus(e.currentTarget)) {
								focusedMark = { catIndex: bar.catIndex, seriesIndex: bar.seriesIndex };
							}
						}}
						onblur={() => (focusedMark = null)}
						onpointerenter={() =>
							(pointed = { catIndex: bar.catIndex, seriesIndex: bar.seriesIndex })}
						onpointerleave={() => (pointed = null)}
					>
						<path
							d={roundedTopBarPath(bar.x, bar.y, bar.w, bar.h, bar.radius, horizontal)}
							fill={seriesColorVar(bar.seriesIndex)}
							stroke="var(--banto-surface)"
							stroke-width="2"
							class="bar"
							class:hovered={isHovered(bar)}
						/>
						<rect class="hit" x={hit.x} y={hit.y} width={hit.w} height={hit.h} />
					</g>
				{:else}
					<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see LineChart's hover-surface comment for rationale. -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<path
						d={roundedTopBarPath(bar.x, bar.y, bar.w, bar.h, bar.radius, horizontal)}
						fill={seriesColorVar(bar.seriesIndex)}
						stroke="var(--banto-surface)"
						stroke-width="2"
						class="bar"
						class:hovered={isHovered(bar)}
						onpointerenter={() =>
							(pointed = { catIndex: bar.catIndex, seriesIndex: bar.seriesIndex })}
						onpointerleave={() => (pointed = null)}
					/>
				{/if}
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hovered}
				{@const bars = computeBars(width, plotHeight)}
				{@const bar = bars.find(isHovered)}
				{#if bar}
					{@const info = tooltipFor(bar)}
					<Tooltip
						x={bar.x + (horizontal ? bar.w : bar.w / 2)}
						y={bar.y + (horizontal ? bar.h / 2 : 0)}
						containerWidth={width}
						containerHeight={plotHeight}
						title={info.title}
						rows={info.rows}
					/>
				{/if}
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-barchart {
		width: 100%;
	}

	.gridline {
		stroke: var(--banto-chart-grid);
		stroke-width: 1;
	}

	.axis-line {
		stroke: var(--banto-chart-axis);
		stroke-width: 1;
	}

	.tick-label {
		fill: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		font-variant-numeric: tabular-nums;
	}

	.bar {
		cursor: default;
		transition: opacity 0.1s ease;
	}

	.bar.hovered {
		opacity: 0.85;
	}

	/* Selectable marks (onMarkActivate): the group is the button; the focus ring is drawn on the bar itself (an SVG group's own outline would be its bounding box). */
	.mark {
		cursor: pointer;
		outline: none;
	}

	.mark:focus-visible .bar {
		stroke: var(--banto-text);
		stroke-width: 3;
	}

	/* markSelected: while a mark is chosen, the others step back. */
	.mark.dimmed .bar {
		opacity: 0.35;
	}

	.hit {
		fill: none;
		pointer-events: all;
	}
</style>
