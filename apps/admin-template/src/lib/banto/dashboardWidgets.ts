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
 *  - the dashboard page (`routes/(app)/dashboard/+page.svelte`): every widget is a panel of its
 *    ONE dock (#716 W2; the default arrangement is `dashboardLayout.ts`), and the View menu lists
 *    them in this order. On a narrow page, and in a copy without the dock, the same widgets are
 *    stacked in one column in this order (`DashboardWidgetStack.svelte`);
 *  - the standalone `routes/panel/[id]` route a panel renders as once popped out into a real
 *    Tauri `WebviewWindow` (spec §5.3 v2) - it has no access to the page's locals, so it looks
 *    the widget up by id.
 *
 * `DashboardWidgetDef` has the fields of the dock package's `FloatingWindowDef` (id / title /
 * icon / width / height) written out instead of `extends`, so this module does not import the
 * dock: the registrations stay when `scripts/scaffold.mjs` removes the dock (`removeDock`). The
 * page hands a def to `dock.ensureWindow`, which type-checks that the two shapes still agree.
 *
 * scaffold: the entries are grouped by the optional package their component needs.
 * `removeCharts` / `removeDock` cut the `[scaffold:charts]` / `[scaffold:dock]` regions (the
 * imports and the entries) and delete the component files. Keep an entry inside the region of the
 * package its component imports; an entry that needs neither (the list, `lowStock`) goes outside
 * the regions and stays in every preset that keeps the dashboard.
 *
 * To give a new icon id a line icon, add it to PanelIcon.svelte's lookup. Unknown ids still
 * render as their original text for adopters.
 */
import type { Component } from 'svelte';
import * as m from '#lib/paraglide/messages.js';
import type { DashboardData, DashboardPageData } from './dashboardData.svelte';
// [scaffold:charts] begin
import CategoryStockWidget from '#lib/components/dashboard/charts/CategoryStockWidget.svelte';
import MonthlyWidget from '#lib/components/dashboard/charts/MonthlyWidget.svelte';
import PriceBucketsWidget from '#lib/components/dashboard/charts/PriceBucketsWidget.svelte';
import ScatterWidget from '#lib/components/dashboard/charts/ScatterWidget.svelte';
import SpcWidget from '#lib/components/dashboard/charts/SpcWidget.svelte';
import StackedBarWidget from '#lib/components/dashboard/charts/StackedBarWidget.svelte';
import TrendWidget from '#lib/components/dashboard/charts/TrendWidget.svelte';
// [scaffold:charts] end
import LowStockWidget from '#lib/components/dashboard/LowStockWidget.svelte';
// [scaffold:dock] begin
import MemoWidget from '#lib/components/dashboard/MemoWidget.svelte';
// [scaffold:dock] end

/** The props every widget component takes. */
export interface DashboardWidgetProps {
	/**
	 * The data the page read once (`createDashboardData`). For a widget registered with
	 * `usesPeriod` its `rows` are narrowed by the page's shared period (#716 W3); the widget does
	 * not know the period, it draws the rows it is given.
	 */
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
	/**
	 * Draws the rows narrowed by the page's shared period (#716 W3, `dashboardPeriod.ts`), and is
	 * drawn again when the period changes. `false` / omitted (the memo, the streaming trend): the
	 * widget is given the rows not narrowed, and a change of the period does not reach it.
	 */
	usesPeriod?: boolean;
}

/**
 * The data ONE widget is given: the page's narrowed data (the same object the KPI strip draws
 * from) when it is registered with `usesPeriod`, else the same read not narrowed. Every place
 * that draws a widget goes through `DashboardWidgetFrame.svelte`, which calls this.
 */
export function dashboardDataFor(
	def: Pick<DashboardWidgetDef, 'usesPeriod'>,
	data: DashboardPageData
): DashboardData {
	return def.usesPeriod ? data : data.all;
}

/**
 * A message that takes no input: a widget's title. A registration names the KEY (the same form as
 * `navigation.ts`'s `labelKey`); the exported list turns it into the getter.
 */
type PlainMessageKey = {
	[K in keyof typeof m]: (typeof m)[K] extends () => string ? K : never;
}[keyof typeof m];

/** What a registration below writes: a `DashboardWidgetDef` with `titleKey` in place of `title`. */
type WidgetEntry = Omit<DashboardWidgetDef, 'title'> & { titleKey: PlainMessageKey };

const widgets: WidgetEntry[] = [];
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
// [scaffold:charts] end
// The list: the items with the least stock (`@banto/grid-svelte`, a core package).
widgets.push({
	id: 'lowStock',
	titleKey: 'panels.lowStock',
	icon: 'lowStock',
	width: 420,
	height: 320,
	component: LowStockWidget,
	usesPeriod: true
});
// [scaffold:dock] begin
// The memo: its draft and its save belong to the page (`dashboardMemo.svelte.ts`, wired in the
// page's `[scaffold:dock]` region - a close in the dock has to settle the draft), so it goes
// with the dock.
widgets.push({
	id: 'memo',
	titleKey: 'panels.memo',
	icon: 'memo',
	width: 320,
	height: 220,
	component: MemoWidget
});
// [scaffold:dock] end

/** Every registered widget, in the order the View menu lists them and the one-column display stacks them. */
export const DASHBOARD_WIDGETS: readonly DashboardWidgetDef[] = widgets.map(
	({ titleKey, ...rest }): DashboardWidgetDef => ({
		...rest,
		get title() {
			return m[titleKey]();
		}
	})
);

/** Look up a widget by id; `undefined` for an unknown id (e.g. a stale / typo'd panel window). */
export function findDashboardWidget(id: string): DashboardWidgetDef | undefined {
	return DASHBOARD_WIDGETS.find((def) => def.id === id);
}
