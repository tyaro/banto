<script lang="ts">
	/**
	 * Dashboard widget `categoryStock`: stock total per category, as horizontal bars (dashboardWidgets.ts, #716 W1).
	 * With `onSelect` (#882 C2) a bar chooses its category: the page narrows the other widgets by it, and
	 * every bar stays here (the widget is not narrowed by its own dimension; the chosen bar stands out).
	 * Without `onSelect` (the popped-out window) the bars are not selectable.
	 */
	import { BarChart } from '@banto/charts';
	import { byCategory } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import ChartFit from './ChartFit.svelte';

	let { data, height, onSelect, selected }: DashboardWidgetProps = $props();

	const categoryStock = $derived(byCategory(data.rows));
	const select = $derived(
		onSelect ? (mark: { category: string }) => onSelect(mark.category) : undefined
	);
	const isSelected = $derived(
		onSelect ? (mark: { category: string }) => mark.category === selected : undefined
	);
</script>

<ChartFit {height}>
	{#snippet children(chartHeight)}
		<BarChart
			data={categoryStock}
			category={(row) => row.category}
			series={[{ id: 'stock', label: m['dashboard.seriesStock'](), value: (row) => row.stock }]}
			horizontal
			label={m['dashboard.categoryStockAria']()}
			height={chartHeight}
			formatValue={(n) => n.toLocaleString()}
			onMarkActivate={select}
			markSelected={isSelected}
		/>
	{/snippet}
</ChartFit>
