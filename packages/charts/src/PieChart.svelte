<script lang="ts" generics="TRow">
	/**
	 * Pie / donut chart (spec §6). Each row is one slice; slice color follows
	 * the row's index in `data` (rule 1 - fixed order, never reassigned/
	 * cycled if a row disappears between renders).
	 */
	import { pieSlices, arcPath } from './core/pie';
	import { seriesColorVar } from './core/color';
	import { handleMarkKeydown, onMarkDetached } from './internal/mark-keys';
	import {
		getValue,
		toNumber,
		type Accessor,
		type ChartMark,
		type MarkProps,
		type TooltipRow
	} from './types';
	import ChartContainer from './internal/ChartContainer.svelte';
	import Legend from './internal/Legend.svelte';
	import Tooltip from './internal/Tooltip.svelte';
	import { defaultChartMessages, type ChartMessages } from './messages';

	interface Props extends MarkProps<TRow> {
		data: TRow[];
		category: Accessor<TRow>;
		value: Accessor<TRow>;
		donut?: boolean;
		label: string;
		height?: number;
		formatValue?: (n: number) => string;
		/** i18n layer 1 (docs/conventions.md §13): overrides forwarded to `ChartContainer`'s empty-state text. Defaults reproduce today's Japanese output. */
		messages?: Partial<ChartMessages>;
	}

	let {
		data,
		category,
		value,
		donut = false,
		label,
		height = 240,
		formatValue,
		messages = {},
		onMarkActivate,
		markLabel
	}: Props = $props();

	const formatValueDisplay = $derived(formatValue ?? ((n: number) => n.toLocaleString()));

	const t = $derived({ ...defaultChartMessages, ...messages });

	const categories = $derived(data.map((row) => getValue(row, category)));
	const values = $derived(data.map((row) => toNumber(getValue(row, value))));
	const isEmpty = $derived(data.length === 0 || values.every((v) => !Number.isFinite(v) || v <= 0));

	const slices = $derived(pieSlices(values));

	const legendItems = $derived(
		categories.map((cat, i) => ({
			id: `${i}-${String(cat)}`,
			label: String(cat ?? ''),
			colorVar: seriesColorVar(i)
		}))
	);

	const PADDING = 8;

	function geometry(width: number, plotHeight: number) {
		const cx = width / 2;
		const cy = plotHeight / 2;
		const rOuter = Math.max(0, Math.min(width, plotHeight) / 2 - PADDING);
		const rInner = donut ? rOuter * 0.6 : 0;
		return { cx, cy, rOuter, rInner };
	}

	// Pointer and keyboard focus are tracked separately (see BarChart): the
	// pointer leaving a slice must not hide the tooltip of the focused one.
	let pointedIndex: number | null = $state(null);
	let focusedIndex: number | null = $state(null);
	// Checked against the current slices: when `data` shrinks, a removed focused
	// element may never fire blur, so a stale index must not reach the overlay.
	/** The slice's element left the document (data shrank, value became 0): drop the focus / pointer state that pointed at it. */
	function forgetMark(i: number): void {
		if (focusedIndex === i) focusedIndex = null;
		if (pointedIndex === i) pointedIndex = null;
	}

	const hoveredIndex = $derived.by(() => {
		const i = pointedIndex ?? focusedIndex;
		return i !== null && i >= 0 && i < slices.length ? i : null;
	});

	// Selectable slices (only when `onMarkActivate` is given). Clockwise from the
	// first slice; roving tabindex keeps one slice as the Tab stop.
	// The tab stop is the slice's `data` index (an identity, not a position in `navOrder`).
	let tabIdx: number | null = $state(null);
	// A slice with no sweep (value 0 / invalid) has no drawn area: it would be an
	// invisible Tab stop, so it is not selectable. `navOrder[pos]` is its `data`
	// index; the callback's `index` stays the position in `data`.
	const navOrder = $derived(slices.flatMap((s, i) => (s.endAngle > s.startAngle ? [i] : [])));
	const activeMark = $derived(Math.max(0, navOrder.indexOf(tabIdx ?? -1)));

	function markFor(i: number): ChartMark<TRow> {
		return {
			row: data[i],
			index: i,
			category: String(categories[i] ?? ''),
			value: values[i]
		};
	}

	function markName(i: number): string {
		const mark = markFor(i);
		return markLabel ? markLabel(mark) : t.markLabel(mark.category, formatValueDisplay(values[i]));
	}

	function tooltipRows(index: number): TooltipRow[] {
		return [
			{
				label: String(categories[index] ?? ''),
				value: formatValueDisplay(values[index]),
				colorVar: seriesColorVar(index)
			}
		];
	}
</script>

<div class="banto-piechart">
	<Legend items={legendItems} />
	<ChartContainer
		{label}
		{height}
		empty={isEmpty}
		interactive={onMarkActivate !== undefined}
		{messages}
	>
		{#snippet plot({ width, height: plotHeight })}
			{@const g = geometry(width, plotHeight)}
			{#each slices as slice, i (i)}
				{#if onMarkActivate && navOrder.includes(i)}
					{@const pos = navOrder.indexOf(i)}
					<g
						class="mark"
						{@attach (node: Element) => onMarkDetached(node, () => forgetMark(i))}
						role="button"
						tabindex={pos === activeMark ? 0 : -1}
						aria-label={markName(i)}
						data-mark-index={pos}
						onclick={() => onMarkActivate(markFor(i))}
						onkeydown={(e) =>
							handleMarkKeydown(
								e,
								pos,
								navOrder.length,
								() => onMarkActivate(markFor(i)),
								(next) => (tabIdx = navOrder[next])
							)}
						onfocus={() => {
							tabIdx = i;
							focusedIndex = i;
						}}
						onblur={() => (focusedIndex = null)}
						onpointerenter={() => (pointedIndex = i)}
						onpointerleave={() => (pointedIndex = null)}
					>
						<path
							d={arcPath(g.cx, g.cy, g.rOuter, g.rInner, slice.startAngle, slice.endAngle)}
							fill={seriesColorVar(i)}
							stroke="var(--banto-surface)"
							stroke-width="2"
							class="slice"
							class:hovered={hoveredIndex === i}
						/>
					</g>
				{:else}
					<!-- Per-mark hover highlight/tooltip (rule 6); pointer-only, see LineChart's hover-surface comment for rationale. -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<path
						d={arcPath(g.cx, g.cy, g.rOuter, g.rInner, slice.startAngle, slice.endAngle)}
						fill={seriesColorVar(i)}
						stroke="var(--banto-surface)"
						stroke-width="2"
						class="slice"
						class:hovered={hoveredIndex === i}
						onpointerenter={() => (pointedIndex = i)}
						onpointerleave={() => (pointedIndex = null)}
					/>
				{/if}
			{/each}
		{/snippet}
		{#snippet overlay({ width, height: plotHeight })}
			{#if hoveredIndex !== null}
				{@const g = geometry(width, plotHeight)}
				{@const slice = slices[hoveredIndex]}
				{@const mid = (slice.startAngle + slice.endAngle) / 2}
				{@const rad = (mid * Math.PI) / 180}
				{@const anchorR = (g.rOuter + g.rInner) / 2}
				<Tooltip
					x={g.cx + anchorR * Math.cos(rad)}
					y={g.cy + anchorR * Math.sin(rad)}
					containerWidth={width}
					containerHeight={plotHeight}
					rows={tooltipRows(hoveredIndex)}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.banto-piechart {
		width: 100%;
	}

	.slice {
		cursor: default;
		transition: opacity 0.1s ease;
	}

	.slice.hovered {
		opacity: 0.85;
	}

	/* Selectable slices (onMarkActivate): the group is the button; the focus ring is drawn on the slice itself (an SVG group's own outline would be its bounding box). */
	.mark {
		cursor: pointer;
		outline: none;
	}

	.mark:focus-visible .slice {
		stroke: var(--banto-text);
		stroke-width: 3;
	}
</style>
