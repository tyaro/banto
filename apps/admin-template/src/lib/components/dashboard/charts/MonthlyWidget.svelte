<script lang="ts">
	/** Dashboard widget `monthly`: updates per month, as an area line (dashboardWidgets.ts, #716 W1). */
	import { LineChart } from '@banto/charts';
	import { updatesByMonth } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import ChartFit from './ChartFit.svelte';

	let { data, height }: DashboardWidgetProps = $props();

	const monthCounts = $derived(updatesByMonth(data.rows));
</script>

<ChartFit {height}>
	{#snippet children(chartHeight)}
		<LineChart
			data={monthCounts}
			x={(row) => row.month}
			series={[{ id: 'count', label: m['dashboard.seriesUpdates'](), y: (row) => row.count }]}
			area
			label={m['dashboard.monthlyAria']()}
			height={chartHeight}
			formatY={(n) => n.toLocaleString()}
		/>
	{/snippet}
</ChartFit>
