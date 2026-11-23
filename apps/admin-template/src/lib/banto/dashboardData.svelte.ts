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
 * W3 adds the shared period here (the rows narrowed by it); W1 has all rows only.
 *
 * App layer, items demo: removed with the dashboard page by `scripts/scaffold.mjs` (`removeDashboard`).
 */
import { createListResource } from '@banto/admin-core';
import { computeStatTiles, type StatTiles } from './dashboard';
import type { Item } from './sampleData';

/** The most rows one read asks for (the same limit the page and each panel used before W1). */
export const DASHBOARD_ROW_LIMIT = 20_000;

/** What a widget / the KPI strip may read. Read-only: only the owner loads and disposes. */
export interface DashboardData {
	/** All rows of the one read (empty until it settles). */
	readonly rows: Item[];
	/** A read is in flight. */
	readonly loading: boolean;
	/** The server's count of all rows (may exceed `rows.length` past `DASHBOARD_ROW_LIMIT`). */
	readonly totalCount: number;
	/** The KPI numbers, computed once per `rows` (not once per tile). */
	readonly stats: StatTiles;
}

/** The owner's side (the page / the pop-out route): start the read, and drop it on unmount. */
export interface DashboardDataSource extends DashboardData {
	load(): Promise<void>;
	dispose(): void;
}

export function createDashboardData(): DashboardDataSource {
	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: DASHBOARD_ROW_LIMIT } }
	});
	const stats = $derived(computeStatTiles(list.rows));
	return {
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
			return stats;
		},
		load: () => list.load(),
		dispose: () => list.dispose()
	};
}
