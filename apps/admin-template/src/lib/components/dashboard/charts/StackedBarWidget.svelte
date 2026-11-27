<script lang="ts">
	/** Dashboard widget `stackedBar`: the top categories' stock stacked by price band (dashboardWidgets.ts, #716 W1). */
	import { BarChart } from '@banto/charts';
	import { stockByCategoryPriceBand } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCount } from '#lib/banto/i18n.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import ChartFit from './ChartFit.svelte';

	let { data, height }: DashboardWidgetProps = $props();

	const categoryPriceBand = $derived(stockByCategoryPriceBand(data.rows));
</script>

<ChartFit {height}>
	{#snippet children(chartHeight)}
		<BarChart
			data={categoryPriceBand}
			category={(row) => row.category}
			series={[
				{ id: 'low', label: m['dashboard.priceBandLow'](), value: (row) => row.low },
				{ id: 'mid', label: m['dashboard.priceBandMid'](), value: (row) => row.mid },
				{ id: 'high', label: m['dashboard.priceBandHigh'](), value: (row) => row.high }
			]}
			stacked
			label={m['dashboard.stackedBarAria']()}
			height={chartHeight}
			formatValue={(n) => formatCount(n)}
		/>
	{/snippet}
</ChartFit>
