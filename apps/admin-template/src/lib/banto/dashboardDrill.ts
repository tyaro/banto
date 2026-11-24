/**
 * Drill-down: from a mark of a dashboard widget (or the low-stock KPI tile) to the items list
 * that holds the rows it counts (docs/design/crossfilter-drilldown-design.md §7.2, Issue #882).
 *
 * A widget only says WHAT was chosen (`DashboardDrill`); it does not know the period. The page
 * turns that into a URL here, adding the period's start day, so the list counts what the mark
 * counted. The list reads the link (`?view=<id>&arg.<name>=<value>`, §7.1) and applies it once.
 *
 * App layer, items demo: removed with the dashboard page by `scripts/scaffold.mjs`
 * (`removeDashboard`). It imports no chart package.
 */
import { resolveAppPath } from '#lib/appPath.js';
import { periodStart, type DashboardFilter } from './dashboardPeriod';
import {
	LOW_STOCK_VIEW_ID,
	PRICE_BAND_VIEW_ID,
	PRICE_BANDS,
	itemsResource
} from './resources/items';

/** The id of a price band (`PRICE_BANDS`, the one table both the chart and the list read). */
export type PriceBucketId = (typeof PRICE_BANDS)[number]['id'];

/**
 * What a mark / tile stands for. (A category kind is not offered: items has no real category
 * column, design §10 decision 8.)
 */
export type DashboardDrill = { kind: 'lowStock' } | { kind: 'priceBucket'; bucket: PriceBucketId };

/**
 * The URL to move to. With a period other than "all" (`anchorDay` = the newest day in the rows
 * read, `latestDay`), the day `periodStart` returned - the lower bound, that day NOT included - is
 * carried as `arg.after` as it is: the list does not count the anchor again (§7.1).
 */
export function drillHref(
	drill: DashboardDrill,
	filter: DashboardFilter,
	anchorDay: string | null
): string {
	const params = new URLSearchParams();
	params.set('view', drill.kind === 'lowStock' ? LOW_STOCK_VIEW_ID : PRICE_BAND_VIEW_ID);
	if (drill.kind === 'priceBucket') params.set('arg.band', drill.bucket);
	const after = anchorDay === null ? null : periodStart(filter.period, anchorDay);
	if (after !== null) params.set('arg.after', after);
	return `${resolveAppPath(itemsResource.path)}?${params.toString()}`;
}
