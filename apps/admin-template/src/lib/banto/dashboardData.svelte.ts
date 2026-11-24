/**
 * The dashboard's data, read ONCE per document (downstream-requests-2026-11-plan §4.13.3, #716 W1).
 *
 * The page (`routes/(app)/dashboard/+page.svelte`) creates one of these and hands it to the KPI
 * strip and to every widget as the `data` prop (`DashboardWidgetProps`). A widget never reads
 * `items` itself: before W1 each dock panel loaded its own copy (up to 20,000 rows per panel).
 * A popped-out panel (`routes/panel/[id]`) is another document with its own JS heap, so that route
 * creates its own - still one read per document.
 *
 * Same "load once, whole dataset" pattern as the items page: the dashboard aggregates over the full
 * set, not a paginated window. In your own app, replace what is read here (and the aggregation
 * helpers in `dashboard.ts`); the widgets only see `DashboardData`.
 *
 * W3: the shared period. The page hands its filter in (`filter`, read reactively); `rows` /
 * `stats` are narrowed by it and `all` is the same read NOT narrowed. The KPI strip and the widgets
 * registered with `usesPeriod` are given the narrowed data, every other widget `all`
 * (`dashboardDataFor`, `dashboardWidgets.ts`) - so changing the period redraws only the former.
 * The filter is not saved, and changing it reads nothing again: narrowing happens here, on the rows
 * already read. Without `filter` (the pop-out route) nothing is narrowed.
 *
 * App layer, items demo: removed with the dashboard page by `scripts/scaffold.mjs` (`removeDashboard`).
 */
import { createListResource } from '@banto/admin-core';
import { computeStatTiles, type StatTiles } from './dashboard';
import { DEFAULT_DASHBOARD_FILTER, narrowRows, type DashboardFilter } from './dashboardPeriod';
import type { Item } from './sampleData';

/** The most rows one read asks for (the same limit the page and each panel used before W1). */
export const DASHBOARD_ROW_LIMIT = 20_000;

/** What a widget / the KPI strip may read. Read-only: only the owner loads and disposes. */
export interface DashboardData {
	/**
	 * The rows of the one read (empty until it settles) - narrowed by the page's filter, unless
	 * this is the `all` of a `DashboardPageData`.
	 */
	readonly rows: Item[];
	/** A read is in flight. */
	readonly loading: boolean;
	/** The server's count of all rows (may exceed what was read past `DASHBOARD_ROW_LIMIT`). Never narrowed. */
	readonly totalCount: number;
	/** The KPI numbers, computed once per `rows` (not once per tile). */
	readonly stats: StatTiles;
}

/**
 * What the page hands to whatever draws widgets: the narrowed data, and the same read NOT
 * narrowed (`all`) for the widgets that do not use the period.
 */
export interface DashboardPageData extends DashboardData {
	readonly all: DashboardData;
}

/** The owner's side (the page / the pop-out route): start the read, and drop it on unmount. */
export interface DashboardDataSource extends DashboardPageData {
	load(): Promise<void>;
	dispose(): void;
}

export interface DashboardDataOptions {
	/**
	 * The page's filter, read reactively (a getter over the page's `$state`). Omitted: nothing is
	 * narrowed.
	 */
	filter?: () => DashboardFilter;
}

export function createDashboardData(options: DashboardDataOptions = {}): DashboardDataSource {
	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: DASHBOARD_ROW_LIMIT } }
	});
	const allStats = $derived(computeStatTiles(list.rows));
	// With nothing to narrow by this is `list.rows` itself, and `stats` is `allStats` (the numbers
	// are not computed twice).
	const rows = $derived(narrowRows(list.rows, options.filter?.() ?? DEFAULT_DASHBOARD_FILTER));
	const stats = $derived(rows === list.rows ? allStats : computeStatTiles(rows));
	const all: DashboardData = {
		get rows() {
			return list.rows;
		},
		get loading() {
			return list.loading;
		},
		get totalCount() {
			return list.totalCount;
		},
		get stats() {
			return allStats;
		}
	};
	return {
		get rows() {
			return rows;
		},
		get loading() {
			return list.loading;
		},
		get totalCount() {
			return list.totalCount;
		},
		get stats() {
			return stats;
		},
		all,
		load: () => list.load(),
		dispose: () => list.dispose()
	};
}
