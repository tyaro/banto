/**
 * The dashboard's widgets: ONE registration per widget + ONE component file per widget
 * (downstream-requests-2026-11-plan §4.13.3, #716 W1).
 *
 * The line (§4.13.1): the user edits the ARRANGEMENT; the author registers the KINDS and their
 * content here, in code. To add a widget, write its component (props = `DashboardWidgetProps`)
 * and add one entry below (`titleKey` is the message key of its title). There is no screen to
 * compose a widget.
 *
 * Used from:
 *  - the dashboard page (`routes/(app)/dashboard/+page.svelte`): the fixed cards and the dock's
 *    panels are both drawn from here;
 *  - the standalone `routes/panel/[id]` route a panel renders as once popped out into a real
 *    Tauri `WebviewWindow` (spec §5.3 v2) - it has no access to the page's locals, so it looks
 *    the widget up by id.
 *
 * `DashboardWidgetDef` has the fields of the dock package's `FloatingWindowDef` (id / title /
 * icon / width / height) written out instead of `extends`, so this module does not import the
 * dock: the registrations stay when `scripts/scaffold.mjs` removes the dock (`removeDock`). The
 * page hands a def to `dock.ensureWindow`, which type-checks that the two shapes still agree.
 *
 * W1 keeps the two PLACES of today: `DASHBOARD_CARDS` says which widgets are the fixed cards, and
 * the page lists the ids its dock offers as panels. W2 moves everything into one dock and removes
 * both lists.
 *
 * scaffold: the entries are grouped by the optional package their component needs.
 * `removeCharts` / `removeDock` cut the `[scaffold:charts]` / `[scaffold:dock]` regions (the
 * imports and the entries) and delete the component files. Keep an entry inside the region of the
 * package its component imports; an entry that needs neither goes outside the regions.
 *
 * To give a new icon id a line icon, add it to PanelIcon.svelte's lookup. Unknown ids still
 * render as their original text for adopters.
 */
import type { Component } from 'svelte';
import * as m from '#lib/paraglide/messages.js';
import type { DashboardData } from './dashboardData.svelte';
// [scaffold:charts] begin
import CategoryStockWidget from '#lib/components/dashboard/charts/CategoryStockWidget.svelte';
import MonthlyWidget from '#lib/components/dashboard/charts/MonthlyWidget.svelte';
import PriceBucketsWidget from '#lib/components/dashboard/charts/PriceBucketsWidget.svelte';
import ScatterWidget from '#lib/components/dashboard/charts/ScatterWidget.svelte';
import SpcWidget from '#lib/components/dashboard/charts/SpcWidget.svelte';
import StackedBarWidget from '#lib/components/dashboard/charts/StackedBarWidget.svelte';
import TrendWidget from '#lib/components/dashboard/charts/TrendWidget.svelte';
// [scaffold:charts] end
// [scaffold:dock] begin
import MemoWidget from '#lib/components/dashboard/MemoWidget.svelte';
// [scaffold:dock] end

/** The props every widget component takes. */
export interface DashboardWidgetProps {
	/** The data the page read once (`createDashboardData`), and - from W3 - the shared period. */
	data: DashboardData;
	/** The content's height in px. The caller measures its own container and hands it down. */
	height: number;
}

export interface DashboardWidgetDef {
	/** Goes into the saved arrangement: do not change it later. */
	id: string;
	/**
	 * A lazy `get title()` getter, not an eager `m['…']()` (ADR-0005, PR-B2/B2b): this module is
	 * evaluated at app startup BEFORE locale.ts registers the `custom-banto` strategy, so an eager
	 * call would freeze to the English `baseLocale`. The dock serializes the title INTO the saved
	 * layout; the page's `createDockLayoutStore({ validate })` re-resolves it by id on restore
	 * (dockTitles.ts, #729 review).
	 */
	readonly title: string;
	/** An icon id (PanelIcon.svelte's lookup). */
	icon?: string;
	/** The size of the widget's floating window (dock-svelte's defaults when omitted). */
	width?: number;
	height?: number;
	/** Draws the content. */
	component: Component<DashboardWidgetProps>;
	/** Uses the rows narrowed by the shared period (W3). `false` / omitted: the memo, the streaming trend. */
	usesPeriod?: boolean;
}

/** W1 only (W2 removes it): a widget shown as a fixed card above the dock. */
export interface DashboardCardDef {
	/** A registered widget's id. The card's heading is the widget's title. */
	id: string;
	/** `primary` spans 8 of the 12 columns, `secondary` 4 (one column under 900px). */
	tier: 'primary' | 'secondary';
	/** The line under the heading (a getter, like `title`). */
	readonly caption: string;
}

/**
 * A message that takes no input: a widget's title, a card's caption. A registration names the
 * KEY (the same form as `navigation.ts`'s `labelKey`); the exported lists turn it into the getter.
 */
type PlainMessageKey = {
	[K in keyof typeof m]: (typeof m)[K] extends () => string ? K : never;
}[keyof typeof m];

/** What a registration below writes: a `DashboardWidgetDef` with `titleKey` in place of `title`. */
type WidgetEntry = Omit<DashboardWidgetDef, 'title'> & { titleKey: PlainMessageKey };
type CardEntry = Omit<DashboardCardDef, 'caption'> & { captionKey: PlainMessageKey };

const widgets: WidgetEntry[] = [];
const cards: CardEntry[] = [];
// [scaffold:charts] begin
// Widgets drawn with `@banto/charts`. `spc` (histogram + Pareto + box plot, one SVG export
// button) and `trend` (streaming, zoom / pan, bands, markers, second y-axis) are roadmap M13.
widgets.push(
	{
		id: 'monthly',
		titleKey: 'panels.monthly',
		icon: 'monthly',
		width: 420,
		height: 320,
		component: MonthlyWidget,
		usesPeriod: true
	},
	{
		id: 'categoryStock',
		titleKey: 'dashboard.categoryStockTitle',
		icon: 'categoryStock',
		width: 360,
		height: 320,
		component: CategoryStockWidget,
		usesPeriod: true
	},
	{
		id: 'stackedBar',
		titleKey: 'dashboard.stackedBarTitle',
		icon: 'stackedBar',
		width: 420,
		height: 320,
		component: StackedBarWidget,
		usesPeriod: true
	},
	{
		id: 'priceBuckets',
		titleKey: 'panels.priceBuckets',
		icon: 'priceBuckets',
		width: 360,
		height: 320,
		component: PriceBucketsWidget,
		usesPeriod: true
	},
	{
		id: 'scatter',
		titleKey: 'dashboard.scatterTitle',
		icon: 'scatter',
		width: 420,
		height: 320,
		component: ScatterWidget,
		usesPeriod: true
	},
	{
		id: 'spc',
		titleKey: 'panels.spc',
		icon: 'spc',
		width: 460,
		height: 640,
		component: SpcWidget,
		usesPeriod: true
	},
	{
		id: 'trend',
		titleKey: 'panels.trend',
		icon: 'trend',
		width: 640,
		height: 360,
		component: TrendWidget
	}
);
cards.push(
	{ id: 'monthly', tier: 'primary', captionKey: 'dashboard.monthlyCaption' },
	{ id: 'categoryStock', tier: 'secondary', captionKey: 'dashboard.categoryStockCaption' },
	{ id: 'stackedBar', tier: 'secondary', captionKey: 'dashboard.stackedBarCaption' },
	{ id: 'priceBuckets', tier: 'secondary', captionKey: 'dashboard.priceBucketCaption' },
	{ id: 'scatter', tier: 'secondary', captionKey: 'dashboard.scatterCaption' }
);
// [scaffold:charts] end
// [scaffold:dock] begin
// The memo: its draft and its save belong to the page (`dashboardMemo.svelte.ts`), so it is
// only editable where the page provides them - that is, in the dock.
widgets.push({
	id: 'memo',
	titleKey: 'panels.memo',
	icon: 'memo',
	width: 320,
	height: 220,
	component: MemoWidget
});
// [scaffold:dock] end

/** Every registered widget, in the order the View menu lists them. */
export const DASHBOARD_WIDGETS: readonly DashboardWidgetDef[] = widgets.map(
	({ titleKey, ...rest }): DashboardWidgetDef => ({
		...rest,
		get title() {
			return m[titleKey]();
		}
	})
);

/** W1 only (W2 removes it): the fixed cards, in the grid's order. */
export const DASHBOARD_CARDS: readonly DashboardCardDef[] = cards.map(
	({ captionKey, ...rest }): DashboardCardDef => ({
		...rest,
		get caption() {
			return m[captionKey]();
		}
	})
);

/** Look up a widget by id; `undefined` for an unknown id (e.g. a stale / typo'd panel window). */
export function findDashboardWidget(id: string): DashboardWidgetDef | undefined {
	return DASHBOARD_WIDGETS.find((def) => def.id === id);
}
