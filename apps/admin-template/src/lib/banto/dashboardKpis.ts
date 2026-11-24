/**
 * The dashboard's KPI strip, as ONE array (downstream-requests-2026-11-plan §4.13.3, #716 W1).
 *
 * The strip is fixed: the author defines the tiles here, the order is the array's order, and the
 * user can neither reorder nor hide them (nothing is saved). `DashboardKpiStrip.svelte` draws it.
 * To add a tile, add one entry. A label is a lazy getter for the same reason as a widget's title
 * (`dashboardWidgets.ts`): this module is evaluated before the locale is resolved.
 *
 * App layer, items demo: removed with the dashboard page by `scripts/scaffold.mjs` (`removeDashboard`).
 */
import type { Component } from 'svelte';
import { JapaneseYen, Package, TriangleAlert, Warehouse } from '@lucide/svelte';
import * as m from '#lib/paraglide/messages.js';
// [scaffold:charts] begin
import { updatesByMonth } from './dashboard';
// [scaffold:charts] end
import type { DashboardData } from './dashboardData.svelte';
import type { DashboardDrill } from './dashboardDrill';
import { LOW_STOCK_THRESHOLD } from './resources/items';

export interface DashboardKpiDef {
	id: string;
	/** The tile's label (a getter: resolved when read, not when this module loads). */
	readonly label: string;
	/** A line icon (`@lucide/svelte`); drawn decorative. */
	icon: Component<{ size?: number }>;
	/** The formatted value. */
	value: (data: DashboardData) => string;
	/**
	 * When the tile is a link: what it opens and its tooltip. The strip turns `drill` into the URL
	 * with the page's period (`drillHref`, #882 D3), so the list counts what the tile counts.
	 */
	link?: { readonly drill: DashboardDrill; readonly title: string };
	/**
	 * The values of a small trend line beside the number (the charts package's sparkline).
	 * `scripts/scaffold.mjs` (`removeCharts`) drops the entries' values and the strip's drawing of it.
	 */
	sparkline?: (data: DashboardData) => number[];
}

const yen = (n: number) => `¥${n.toLocaleString()}`;

export const DASHBOARD_KPIS: DashboardKpiDef[] = [
	{
		id: 'count',
		get label() {
			return m['dashboard.statCount']();
		},
		icon: Package,
		value: (data) => data.stats.count.toLocaleString()
	},
	{
		id: 'stockTotal',
		get label() {
			return m['dashboard.statStockTotal']();
		},
		icon: Warehouse,
		// [scaffold:charts] begin
		sparkline: (data) => updatesByMonth(data.rows).map((mc) => mc.count),
		// [scaffold:charts] end
		value: (data) => data.stats.stockTotal.toLocaleString()
	},
	{
		id: 'avgPrice',
		get label() {
			return m['dashboard.statAvgPrice']();
		},
		icon: JapaneseYen,
		value: (data) => yen(data.stats.avgPrice)
	},
	{
		// #555 (4): the tile opens the items list on its `low-stock` view (ResourceListPage reads
		// `?view=`; same LOW_STOCK_THRESHOLD as the count), and #882 D3 carries the period too.
		id: 'lowStock',
		get label() {
			return m['dashboard.statLowStock']({ threshold: LOW_STOCK_THRESHOLD });
		},
		icon: TriangleAlert,
		value: (data) => data.stats.lowStockCount.toLocaleString(),
		link: {
			drill: { kind: 'lowStock' },
			get title() {
				return m['dashboard.statLowStockOpen']();
			}
		}
	}
];
