<script lang="ts">
	/**
	 * Dashboard widget `priceBuckets`: item count per price band, as a donut (dashboardWidgets.ts, #716 W1).
	 * With `onSelect` (#882 C2) a slice chooses its band: the page narrows the other widgets by it, and the
	 * band under the page's heading offers the items list on that band (the drill-down of D3 moved there).
	 * Choosing the chosen slice again takes the choice off. Without `onSelect` (the popped-out window) the
	 * slices are not selectable.
	 */
	import { PieChart } from '@banto/charts';
	import { priceBuckets } from '#lib/banto/dashboard.js';
	import { PRICE_BANDS } from '#lib/banto/resources/items.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCount } from '#lib/banto/i18n.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import ChartFit from './ChartFit.svelte';

	let { data, height, onSelect, selected }: DashboardWidgetProps = $props();

	const buckets = $derived(priceBuckets(data.rows));
	const countLabel = (n: number) => m['dashboard.countUnit']({ count: formatCount(n) });
	// The buckets are in `PRICE_BANDS` order, so a slice's index is its band.
	const select = $derived(
		onSelect
			? (mark: { index: number }) => {
					const band = PRICE_BANDS[mark.index];
					if (band) onSelect(band.id);
				}
			: undefined
	);
	const isSelected = $derived(
		onSelect ? (mark: { index: number }) => PRICE_BANDS[mark.index]?.id === selected : undefined
	);
</script>

<ChartFit {height}>
	{#snippet children(chartHeight)}
		<PieChart
			data={buckets}
			category={(row) => row.bucket}
			value={(row) => row.count}
			donut
			label={m['dashboard.priceBucketAria']()}
			height={chartHeight}
			formatValue={countLabel}
			onMarkActivate={select}
			markSelected={isSelected}
		/>
	{/snippet}
</ChartFit>
