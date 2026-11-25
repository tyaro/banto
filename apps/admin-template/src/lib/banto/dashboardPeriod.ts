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
 *  - Cross-filtering between widgets (#882 C1・C2): a mark of a widget registered with `selects`
 *    chooses ONE value of its dimension (`toggleSelection`); the choice is a further field of
 *    `DashboardFilter` (`selection`) and a further step of `narrowRows`, so the page's state
 *    reaches the data the same way as the period. The page shows what is chosen in a band under
 *    its heading (`DashboardSelectionBar.svelte`).
 *
 * App layer, items demo: removed with the dashboard page by `scripts/scaffold.mjs` (`removeDashboard`).
 */
import { categoryOf } from './dashboard';
import { PRICE_BANDS, priceBandIndex } from './resources/items';
import type { Item } from './sampleData';

/** The choices, in the order the control shows them. */
export const DASHBOARD_PERIODS = ['all', '30d', '90d', '12m'] as const;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** What the page starts with, and what a document that is not told the period draws. */
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = 'all';

/** The dimensions a mark can select (#882 C1). The author registers them in code (`selects`). */
export const DASHBOARD_DIMENSIONS = ['category', 'priceBucket'] as const;

export type DashboardDimension = (typeof DASHBOARD_DIMENSIONS)[number];

/** The value each row has on a dimension: the category word, or the id of its price band. */
const DIMENSION_VALUE: Record<DashboardDimension, (row: Item) => string> = {
	category: (row) => categoryOf(row.name),
	priceBucket: (row) => PRICE_BANDS[priceBandIndex(row.price)]!.id
};

/** The conditions the page's rows are narrowed by. */
export interface DashboardFilter {
	period: DashboardPeriod;
	/** The value chosen per dimension (one each). A dimension without a value does not narrow. */
	selection: Partial<Record<DashboardDimension, string>>;
}

export const DEFAULT_DASHBOARD_FILTER: DashboardFilter = {
	period: DEFAULT_DASHBOARD_PERIOD,
	selection: {}
};

/**
 * How a chosen value reads in the page's band: a price band's label (`PRICE_BANDS`), a category
 * as it is. An id that is no band reads as the id.
 */
export function selectionValueLabel(dimension: DashboardDimension, value: string): string {
	if (dimension !== 'priceBucket') return value;
	return PRICE_BANDS.find((band) => band.id === value)?.label ?? value;
}

/** Is anything chosen (the page's band is shown only then)? An empty value does not count. */
export function hasSelection(selection: DashboardFilter['selection']): boolean {
	return DASHBOARD_DIMENSIONS.some((dimension) => (selection[dimension] ?? '') !== '');
}

/**
 * What a mark does to the selection (#882 C2): choosing the value that is already chosen takes
 * it off; any other value replaces the dimension's choice (one value per dimension). The other
 * dimensions are kept. Returns a NEW object (the page assigns it), without the keys that are off.
 */
export function toggleSelection(
	selection: DashboardFilter['selection'],
	dimension: DashboardDimension,
	value: string
): DashboardFilter['selection'] {
	const next: DashboardFilter['selection'] = {};
	for (const key of DASHBOARD_DIMENSIONS) {
		const chosen = selection[key] ?? '';
		if (key !== dimension) {
			if (chosen !== '') next[key] = chosen;
		} else if (value !== '' && value !== chosen) {
			next[key] = value;
		}
	}
	return next;
}

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
	// Months back: a day that overflows the target month is clamped to its last day (2024-02-29
	// minus 12 months is 2023-02-28, not 2023-03-01 - `Date.UTC` alone would roll it over and drop
	// the 2023-03-01 rows). Days back need no clamp.
	const target = month - 1 - (months ?? 0);
	const lastDay = new Date(Date.UTC(year, target + 1, 0)).getUTCDate();
	const start = new Date(Date.UTC(year, target, Math.min(day, lastDay) - (days ?? 0)));
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
 * The rows the filter leaves: the period, then the selection of every dimension except `except`
 * (the dimension the asking widget shows itself). With nothing to narrow by it returns `rows`
 * ITSELF (the same array), so the data that is not narrowed and the data that is are one object
 * at `all`.
 */
export function narrowRows(
	rows: Item[],
	filter: DashboardFilter,
	except?: DashboardDimension
): Item[] {
	const anchor = filter.period === DEFAULT_DASHBOARD_PERIOD ? null : latestDay(rows);
	const start = anchor === null ? null : periodStart(filter.period, anchor);
	let result = start === null ? rows : rows.filter((row) => dayOf(row.updatedAt) > start);
	for (const dimension of DASHBOARD_DIMENSIONS) {
		const chosen = filter.selection[dimension];
		if (dimension === except || chosen === undefined || chosen === '') continue;
		const valueOf = DIMENSION_VALUE[dimension];
		result = result.filter((row) => valueOf(row) === chosen);
	}
	return result;
}
