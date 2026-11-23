<script lang="ts">
	/** Dashboard widget `categoryStock`: stock total per category, as horizontal bars (dashboardWidgets.ts, #716 W1). */
	import { BarChart } from '@banto/charts';
	import { byCategory } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';

	let { data, height }: DashboardWidgetProps = $props();

	const categoryStock = $derived(byCategory(data.rows));
</script>

<BarChart
	data={categoryStock}
	category={(row) => row.category}
	series={[{ id: 'stock', label: m['dashboard.seriesStock'](), value: (row) => row.stock }]}
	horizontal
	label={m['dashboard.categoryStockAria']()}
	{height}
	formatValue={(n) => n.toLocaleString()}
/>
