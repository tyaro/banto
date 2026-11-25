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
 * #882 C1: the filter also holds a selection per dimension. `rows` / `stats` (the KPI strip) are
 * narrowed by period AND selection; `byPeriod` by the period only; `without(dimension)` by the
 * period and every selection but that dimension (the widget that shows it is not narrowed by its
 * own choice). Each is computed lazily, once, when first read.
 * The filter is not saved, and changing it reads nothing again: narrowing happens here, on the rows
 * already read. Without `filter` (the pop-out route) nothing is narrowed.
 *
 * App layer, items demo: removed with the dashboard page by `scripts/scaffold.mjs` (`removeDashboard`).
 */
import { createListResource } from '@banto/admin-core';
import { computeStatTiles, type StatTiles } from './dashboard';
import {
	DASHBOARD_DIMENSIONS,
	DEFAULT_DASHBOARD_FILTER,
	narrowRows,
	type DashboardDimension,
	type DashboardFilter
} from './dashboardPeriod';
import type { Item } from './sampleData';

/** The most rows one read asks for (the same limit the page and each panel used before W1). */
export const DASHBOARD_ROW_LIMIT = 20_000;

/**
 * Did the read leave rows out (the server holds more than the `DASHBOARD_ROW_LIMIT` it read)?
 * `readRows` is the count BEFORE the period narrows anything: narrowing is not a truncation
 * (#882 D3, crossfilter-drilldown-design §7.2). Then the dashboard's numbers cover the rows read,
 * while the list a mark opens shows every row that matches.
 */
export function rowsTruncated(totalCount: number, readRows: number): boolean {
	return totalCount > readRows;
}

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
	/** The read left rows out (`rowsTruncated`): the numbers cover the rows read, not every row. Never narrowed. */
	readonly truncated: boolean;
	/** The KPI numbers, computed once per `rows` (not once per tile). */
	readonly stats: StatTiles;
}

/**
 * What the page hands to whatever draws widgets: the narrowed data, and the same read NOT
 * narrowed (`all`) for the widgets that do not use the period.
 */
export interface DashboardPageData extends DashboardData {
	readonly all: DashboardData;
	/** Narrowed by the period only (a `usesPeriod` widget that ignores the selection). */
	readonly byPeriod: DashboardData;
	/** Narrowed by the period and the selection of every dimension but `dimension` (#882 C1). */
	without(dimension: DashboardDimension): DashboardData;
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

/** One narrowing of the read: the rows, and the KPI numbers computed from them on first use. */
class Narrowed {
	readonly rows: Item[];
	readonly stats: StatTiles;
	constructor(
		read: () => Item[],
		readStats: () => StatTiles,
		filter: () => DashboardFilter,
		except?: DashboardDimension
	) {
		this.rows = $derived(narrowRows(read(), filter(), except));
		this.stats = $derived(this.rows === read() ? readStats() : computeStatTiles(this.rows));
	}
}

export function createDashboardData(options: DashboardDataOptions = {}): DashboardDataSource {
	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: DASHBOARD_ROW_LIMIT } }
	});
	const filterNow = () => options.filter?.() ?? DEFAULT_DASHBOARD_FILTER;
	const allStats = $derived(computeStatTiles(list.rows));
	// With nothing to narrow by `rows` is `list.rows` itself, and `stats` is `allStats` (the
	// numbers are not computed twice).
	const narrowed = (filter: () => DashboardFilter, except?: DashboardDimension) =>
		new Narrowed(
			() => list.rows,
			() => allStats,
			filter,
			except
		);
	const page = narrowed(filterNow);
	const byPeriod = narrowed(() => ({ ...filterNow(), selection: {} }));
	const without = Object.fromEntries(
		DASHBOARD_DIMENSIONS.map((dimension) => [dimension, narrowed(filterNow, dimension)])
	) as Record<DashboardDimension, Narrowed>;
	// Also while a read is in flight: the rows and the count shown stay the previous ones until the
	// answer is in, so the warning for them stays too.
	const truncated = $derived(rowsTruncated(list.totalCount, list.rows.length));
	const view = (source: { rows: Item[]; stats: StatTiles }): DashboardData => ({
		get rows() {
			return source.rows;
		},
		get loading() {
			return list.loading;
		},
		get totalCount() {
			return list.totalCount;
		},
		get truncated() {
			return truncated;
		},
		get stats() {
			return source.stats;
		}
	});
	const all = view({
		get rows() {
			return list.rows;
		},
		get stats() {
			return allStats;
		}
	});
	const periodView = view(byPeriod);
	const withoutViews = Object.fromEntries(
		DASHBOARD_DIMENSIONS.map((dimension) => [dimension, view(without[dimension])])
	) as Record<DashboardDimension, DashboardData>;
	const pageView = view(page);
	return {
		get rows() {
			return pageView.rows;
		},
		get loading() {
			return pageView.loading;
		},
		get totalCount() {
			return pageView.totalCount;
		},
		get truncated() {
			return pageView.truncated;
		},
		get stats() {
			return pageView.stats;
		},
		all,
		byPeriod: periodView,
		without: (dimension) => withoutViews[dimension],
		load: () => list.load(),
		dispose: () => list.dispose()
	};
}
