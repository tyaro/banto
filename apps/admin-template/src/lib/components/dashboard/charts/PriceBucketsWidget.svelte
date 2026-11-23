<script lang="ts">
	/** Dashboard widget `priceBuckets`: item count per price band, as a donut (dashboardWidgets.ts, #716 W1). */
	import { PieChart } from '@banto/charts';
	import { priceBuckets } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';

	let { data, height }: DashboardWidgetProps = $props();

	const buckets = $derived(priceBuckets(data.rows));
	const countLabel = (n: number) => m['dashboard.countUnit']({ count: n.toLocaleString() });
</script>

<PieChart
	data={buckets}
	category={(row) => row.bucket}
	value={(row) => row.count}
	donut
	label={m['dashboard.priceBucketAria']()}
	{height}
	formatValue={countLabel}
/>
