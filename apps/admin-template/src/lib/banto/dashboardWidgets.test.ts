/**
 * The dashboard's registrations (dashboardWidgets.ts / dashboardKpis.ts,
 * downstream-requests-2026-11-plan §4.13.3, #716 W1・W2): one entry per widget with everything the
 * dock, the View menu, the one-column display and the pop-out route read from it, and the KPI
 * strip's values.
 *
 * scaffold: this file stays in every preset that keeps the dashboard, so what it says about the
 * widgets of an optional package sits between the same `[scaffold:charts]` / `[scaffold:dock]`
 * marks as their registrations (`scripts/scaffold.mjs` cuts both). The rest holds for any set of
 * registrations, an empty one included.
 */
import { describe, expect, it } from 'vitest';
import { computeStatTiles, lowestStockItems } from './dashboard';
import type { DashboardData } from './dashboardData.svelte';
import { DASHBOARD_KPIS } from './dashboardKpis';
import { DASHBOARD_WIDGETS, findDashboardWidget } from './dashboardWidgets';
import { LOW_STOCK_THRESHOLD, LOW_STOCK_VIEW_ID } from './resources/items';
import type { Item } from './sampleData';

const item = (id: number, price: number, stock: number, updatedAt: string): Item => ({
	id,
	name: `item-${id}`,
	price,
	stock,
	updatedAt,
	version: 1
});

function dataOf(rows: Item[]): DashboardData {
	return { rows, loading: false, totalCount: rows.length, stats: computeStatTiles(rows) };
}

describe('DASHBOARD_WIDGETS (#716 W1)', () => {
	const ids = DASHBOARD_WIDGETS.map((def) => def.id);

	it('has no duplicate id', () => {
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('gives every widget a title, an icon, a size and a component', () => {
		for (const def of DASHBOARD_WIDGETS) {
			expect(def.title.trim(), def.id).not.toBe('');
			expect(def.icon, def.id).toBeTruthy();
			expect(def.width, def.id).toBeGreaterThan(0);
			expect(def.height, def.id).toBeGreaterThan(0);
			expect(typeof def.component, def.id).toBe('function');
		}
	});

	it('resolves a title when it is read, not when the module loads', () => {
		// A getter (ADR-0005): an own data property would have frozen the load-time locale.
		for (const def of DASHBOARD_WIDGETS) {
			expect(typeof Object.getOwnPropertyDescriptor(def, 'title')?.get, def.id).toBe('function');
			expect(def, def.id).not.toHaveProperty('titleKey');
		}
	});

	it('looks a widget up by id', () => {
		for (const def of DASHBOARD_WIDGETS) expect(findDashboardWidget(def.id)).toBe(def);
		expect(findDashboardWidget('nope')).toBeUndefined();
	});
	// [scaffold:charts] begin

	it('registers the chart widgets in the order the View menu lists them', () => {
		// An id goes into the saved arrangement: renaming one here is a breaking change.
		expect(ids.filter((id) => id !== 'memo' && id !== 'lowStock')).toEqual([
			'monthly',
			'categoryStock',
			'stackedBar',
			'priceBuckets',
			'scatter',
			'spc',
			'trend'
		]);
	});

	it('marks which chart widgets follow the shared period (W3)', () => {
		// The streaming trend makes its own points.
		expect(findDashboardWidget('trend')?.usesPeriod ?? false).toBe(false);
		expect(
			DASHBOARD_WIDGETS.filter((def) => def.usesPeriod && def.id !== 'lowStock').map(
				(def) => def.id
			)
		).toEqual(['monthly', 'categoryStock', 'stackedBar', 'priceBuckets', 'scatter', 'spc']);
	});
	// [scaffold:charts] end

	it('registers the list (W2): in every preset, after the charts, following the shared period', () => {
		// `@banto/grid-svelte` is a core package: the entry sits outside the scaffold regions.
		const index = ids.indexOf('lowStock');
		expect(index).toBeGreaterThanOrEqual(0);
		expect(ids.slice(index + 1).filter((id) => id !== 'memo')).toEqual([]);
		expect(findDashboardWidget('lowStock')?.usesPeriod).toBe(true);
	});
	// [scaffold:dock] begin

	it('registers the memo last, and it does not follow the shared period', () => {
		expect(ids.at(-1)).toBe('memo');
		expect(findDashboardWidget('memo')?.usesPeriod ?? false).toBe(false);
	});
	// [scaffold:dock] end
});

describe('lowestStockItems (#716 W2: the list widget)', () => {
	const rows = [
		item(1, 100, 30, '2026-01-01'),
		item(2, 100, 5, '2026-01-01'),
		item(3, 100, 0, '2026-01-01'),
		item(4, 100, 5, '2026-01-01')
	];

	it('orders by stock, fewest first, ties by id, without changing the input', () => {
		const before = rows.map((row) => row.id);
		expect(lowestStockItems(rows).map((row) => row.id)).toEqual([3, 2, 4, 1]);
		expect(rows.map((row) => row.id)).toEqual(before);
	});

	it('keeps at most `limit` rows, and none of an empty set', () => {
		expect(lowestStockItems(rows, 2).map((row) => row.id)).toEqual([3, 2]);
		expect(lowestStockItems(rows, 0)).toEqual([]);
		expect(lowestStockItems([])).toEqual([]);
	});
});

describe('DASHBOARD_KPIS (#716 W1)', () => {
	const data = dataOf([
		item(1, 1000, 5, '2026-01-10T00:00:00Z'),
		item(2, 2000, 1500, '2026-01-20T00:00:00Z'),
		item(3, 4500, LOW_STOCK_THRESHOLD, '2026-02-01T00:00:00Z')
	]);
	const kpi = (id: string) => DASHBOARD_KPIS.find((def) => def.id === id)!;

	it('is the strip, in order', () => {
		expect(DASHBOARD_KPIS.map((def) => def.id)).toEqual([
			'count',
			'stockTotal',
			'avgPrice',
			'lowStock'
		]);
	});

	it('gives every tile a label and an icon', () => {
		for (const def of DASHBOARD_KPIS) {
			expect(def.label.trim(), def.id).not.toBe('');
			expect(def.icon, def.id).toBeTruthy();
		}
	});

	it('formats the values from the one read', () => {
		expect(kpi('count').value(data)).toBe('3');
		expect(kpi('stockTotal').value(data)).toBe((1505 + LOW_STOCK_THRESHOLD).toLocaleString());
		expect(kpi('avgPrice').value(data)).toBe('¥2,500');
		// Low stock is strictly below the threshold: only the first row.
		expect(kpi('lowStock').value(data)).toBe('1');
		expect(kpi('count').value(dataOf([]))).toBe('0');
		expect(kpi('avgPrice').value(dataOf([]))).toBe('¥0');
	});

	it('links the low-stock tile to the items list on its low-stock view', () => {
		expect(DASHBOARD_KPIS.filter((def) => def.link).map((def) => def.id)).toEqual(['lowStock']);
		const link = kpi('lowStock').link!;
		expect(link.href).toMatch(new RegExp(`/items\\?view=${LOW_STOCK_VIEW_ID}$`));
		expect(link.title.trim()).not.toBe('');
	});
	// [scaffold:charts] begin

	it('draws a sparkline of the updates per month beside the stock total only', () => {
		expect(DASHBOARD_KPIS.filter((def) => def.sparkline).map((def) => def.id)).toEqual([
			'stockTotal'
		]);
		const values = kpi('stockTotal').sparkline!(data);
		expect(values.reduce((sum, n) => sum + n, 0)).toBe(3);
	});
	// [scaffold:charts] end
});
