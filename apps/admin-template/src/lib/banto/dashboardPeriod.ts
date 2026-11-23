/**
 * The dashboard's shared period (downstream-requests-2026-11-plan §4.13.3, #716 W3).
 *
 * The page holds ONE filter (`DashboardFilter`) and hands it to `createDashboardData`, which
 * narrows the rows it read with `narrowRows` below. The KPI strip and the widgets registered with
 * `usesPeriod` draw from those narrowed rows; a widget never sees the filter itself.
 *
 *  - The choices are fixed (`DASHBOARD_PERIODS`): no free date range.
 *  - Nothing here is saved: the filter is the page's state, a reload starts at `all`, and it is
 *    not part of the saved arrangement (`dashboardLayout.ts`). A popped-out panel (another
 *    document) is not told: it draws all rows.
 *  - The sample narrows by an item's `updatedAt`, counted back from the NEWEST `updatedAt` in the
 *    rows - not from the wall clock. The sample data is fixed (`sampleData.ts` ends at one fixed
 *    day), so a wall-clock "last 30 days" would be empty, and a screenshot would depend on the day
 *    it was taken. In your own app, pass today's date to `periodStart` instead (and narrow by your
 *    own column).
 *  - Cross-filtering between widgets (#882) adds its conditions as further fields of
 *    `DashboardFilter` and further steps of `narrowRows`: the page's state reaches the data the
 *    same way.
 *
 * App layer, items demo: removed with the dashboard page by `scripts/scaffold.mjs` (`removeDashboard`).
 */
import type { Item } from './sampleData';

/** The choices, in the order the control shows them. */
export const DASHBOARD_PERIODS = ['all', '30d', '90d', '12m'] as const;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** What the page starts with, and what a document that is not told the period draws. */
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = 'all';

/** The conditions the page's rows are narrowed by. #882 adds its own fields here. */
export interface DashboardFilter {
	period: DashboardPeriod;
}

export const DEFAULT_DASHBOARD_FILTER: DashboardFilter = { period: DEFAULT_DASHBOARD_PERIOD };

/** `YYYY-MM-DD` of a stored date / timestamp (`2026-07-02`, `2026-07-02T10:00:00Z`, `2026-07-02 10:00:00`). */
const dayOf = (value: string) => value.slice(0, 10);

const DAYS: Partial<Record<DashboardPeriod, number>> = { '30d': 30, '90d': 90 };
const MONTHS: Partial<Record<DashboardPeriod, number>> = { '12m': 12 };

/**
 * The day (`YYYY-MM-DD`) a period starts AFTER, counted back from `anchor` (a `YYYY-MM-DD…`
 * string): a row is inside when its day is later than this. `null` = no lower bound (`all`, or an
 * `anchor` that is not a date). `30d` from `2026-07-02` gives `2026-06-02`: the 30 days up to and
 * including the anchor.
 */
export function periodStart(period: DashboardPeriod, anchor: string): string | null {
	const days = DAYS[period];
	const months = MONTHS[period];
	if (days === undefined && months === undefined) return null;
	const [year, month, day] = dayOf(anchor).split('-').map(Number);
	const start = new Date(Date.UTC(year, month - 1 - (months ?? 0), day - (days ?? 0)));
	return Number.isNaN(start.getTime()) ? null : start.toISOString().slice(0, 10);
}

/** The newest `updatedAt` day in the rows; `null` when there is no row. */
export function latestDay(rows: readonly Item[]): string | null {
	let latest: string | null = null;
	for (const row of rows) {
		const day = dayOf(row.updatedAt);
		if (latest === null || day > latest) latest = day;
	}
	return latest;
}

/**
 * The rows the filter leaves. With nothing to narrow by it returns `rows` ITSELF (the same
 * array), so the data that is not narrowed and the data that is are one object at `all`.
 */
export function narrowRows(rows: Item[], filter: DashboardFilter): Item[] {
	const anchor = filter.period === DEFAULT_DASHBOARD_PERIOD ? null : latestDay(rows);
	const start = anchor === null ? null : periodStart(filter.period, anchor);
	if (start === null) return rows;
	return rows.filter((row) => dayOf(row.updatedAt) > start);
}
