<script lang="ts">
	/**
	 * Dashboard widget `spc` (roadmap M13; dashboardWidgets.ts, #716 W1): price distribution
	 * (histogram + normal curve), category Pareto, price spread per top category (box plot). The
	 * three charts have a fixed height and the widget scrolls, so `height` is not used.
	 */
	import { BoxPlot, downloadSvg, Histogram, ParetoChart } from '@banto/charts';
	import { categoryCounts, priceByCategoryGroups, priceValues } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';

	let { data }: DashboardWidgetProps = $props();

	const prices = $derived(priceValues(data.rows));
	const paretoItems = $derived(categoryCounts(data.rows));
	const boxGroups = $derived(priceByCategoryGroups(data.rows));

	// M13 SVG export demo (roadmap.md M13, `core/export.ts`): the chart
	// components don't expose their `<svg>` via a prop/ref, so the caller
	// grabs it with a plain DOM query on the wrapping element instead (the
	// pattern `core/export.ts`'s doc comment describes for "利用側").
	let histogramWrapper: HTMLElement | undefined = $state();
	function exportHistogram(): void {
		const svg = histogramWrapper?.querySelector('svg');
		if (svg) downloadSvg(svg, 'price-histogram.svg');
	}

	const countLabel = (n: number) => m['dashboard.countUnit']({ count: n.toLocaleString() });
	const yen = (n: number) => `¥${n.toLocaleString()}`;
</script>

<div class="spc-panel">
	<section class="spc-chart" bind:this={histogramWrapper}>
		<div class="spc-chart-header">
			<h3>{m['dashboard.spcHistogramTitle']()}</h3>
			<button type="button" class="export-btn" onclick={exportHistogram}>
				{m['dashboard.svgExport']()}
			</button>
		</div>
		<Histogram
			values={prices}
			label={m['dashboard.spcHistogramAria']()}
			height={220}
			normalCurve
			formatValue={yen}
		/>
	</section>
	<section class="spc-chart">
		<h3>{m['dashboard.spcParetoTitle']()}</h3>
		<ParetoChart
			items={paretoItems}
			label={m['dashboard.spcParetoAria']()}
			height={220}
			formatValue={countLabel}
		/>
	</section>
	<section class="spc-chart">
		<h3>{m['dashboard.spcBoxTitle']()}</h3>
		<BoxPlot
			groups={boxGroups}
			label={m['dashboard.spcBoxAria']()}
			height={220}
			formatValue={yen}
		/>
	</section>
</div>

<style>
	.spc-panel {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		height: 100%;
		overflow-y: auto;
	}

	/* Sub-chart card (dashboard page's .card, spec §10): same face/border/
	   radius/shadow so the SPC panel's stacked charts read as the same kind
	   of card as the top-level dashboard grid. */
	.spc-chart {
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: var(--banto-space-3) var(--banto-space-4);
	}

	.spc-chart h3 {
		margin: 0 0 var(--banto-space-1);
		font-size: var(--banto-font-size-base);
		font-weight: 600;
		color: var(--banto-text);
		font-feature-settings: 'palt';
	}

	.spc-chart-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-2);
	}

	.spc-chart-header h3 {
		margin: 0;
	}

	.export-btn {
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: 999px;
		background: var(--banto-surface);
		color: var(--banto-text);
		padding: var(--banto-space-1) var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
		cursor: pointer;
		transition:
			border-color var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.export-btn:hover {
		border-color: var(--banto-primary);
		color: var(--banto-primary);
	}

	.export-btn:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}
</style>
