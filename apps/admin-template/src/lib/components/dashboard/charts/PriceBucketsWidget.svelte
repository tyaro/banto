<script lang="ts">
	/**
	 * Dashboard widget `priceBuckets`: item count per price band, as a donut (dashboardWidgets.ts, #716 W1).
	 * With `onDrill` (#882 D3) a slice opens the items list on that band (`/items?view=price-band&arg.band=…`);
	 * without it (the popped-out window) the slices are not selectable.
	 */
	import { PieChart } from '@banto/charts';
	import { priceBuckets } from '#lib/banto/dashboard.js';
	import { DASHBOARD_ROW_LIMIT } from '#lib/banto/dashboardData.svelte.js';
	import { PRICE_BANDS } from '#lib/banto/resources/items.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import ChartFit from './ChartFit.svelte';

	let { data, height, onDrill }: DashboardWidgetProps = $props();

	const buckets = $derived(priceBuckets(data.rows));
	const countLabel = (n: number) => m['dashboard.countUnit']({ count: n.toLocaleString() });
	// The buckets are in `PRICE_BANDS` order, so a slice's index is its band.
	const drill = $derived(
		onDrill
			? (mark: { index: number }) => {
					const band = PRICE_BANDS[mark.index];
					if (band) onDrill({ kind: 'priceBucket', bucket: band.id });
				}
			: undefined
	);
	// The read left rows out: the reading of a mark says the list can hold more than the number.
	const truncatedLabel = $derived(
		data.truncated
			? (mark: { category: string; value: number }) =>
					`${mark.category}: ${countLabel(mark.value)}. ${m['dashboard.truncatedNote']({ limit: DASHBOARD_ROW_LIMIT.toLocaleString() })}`
			: undefined
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
			onMarkActivate={drill}
			markLabel={truncatedLabel}
		/>
	{/snippet}
</ChartFit>
