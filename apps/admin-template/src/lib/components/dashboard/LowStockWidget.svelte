<script lang="ts">
	/**
	 * Dashboard widget `lowStock`: the items with the least stock, as a list (dashboardWidgets.ts,
	 * #716 W2, downstream-requests-2026-11-plan §4.13.7 c) - the sample of a LIST widget next to the
	 * charts and the memo. `@banto/grid-svelte` is a core package, so this widget stays in every
	 * scaffold preset that keeps the dashboard.
	 *
	 * Read-only: no cell editing, no row action. The rows are the page's one read (`data.rows`),
	 * narrowed here; in your own app, replace `lowestStockItems` with your own selection.
	 */
	import { BantoGrid, type GridColumn } from '@banto/grid-svelte';
	import { categoryOf, lowestStockItems } from '#lib/banto/dashboard.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCount } from '#lib/banto/i18n.js';

	let { data, height }: DashboardWidgetProps = $props();

	const rows = $derived(lowestStockItems(data.rows));

	const columns: GridColumn<Item>[] = [
		{ id: 'name', header: m['items.fieldName'](), accessor: 'name', width: 180 },
		{
			id: 'category',
			header: m['dashboard.lowStockCategory'](),
			accessor: (row) => categoryOf(row.name),
			width: 110
		},
		{
			id: 'stock',
			header: m['items.fieldStock'](),
			accessor: 'stock',
			width: 80,
			align: 'right',
			format: (value) => formatCount(Number(value))
		}
	];
</script>

<!-- The grid fills its container and scrolls inside it: the container takes the height handed down. -->
<div class="low-stock" style:height="{height}px">
	<BantoGrid {rows} {columns} getRowId={(row) => row.id} messages={gridMessages()} />
</div>

<style>
	.low-stock {
		min-height: 0;
	}
</style>
