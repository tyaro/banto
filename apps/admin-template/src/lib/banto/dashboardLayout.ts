/**
 * The dashboard's dock: the default arrangement, its height, the keys it is saved under and the
 * check of a saved value (downstream-requests-2026-11-plan §4.13.3, #716 W2).
 *
 * The line (§4.13.1): the user edits the ARRANGEMENT (add, move, resize, show / hide); the author
 * decides the default here, in code. There is no screen for an administrator to hand out a
 * default (decision 3).
 *
 * To change the default, edit `DEFAULT_ROWS`: each inner list is one row of panes, top to bottom.
 * A widget that is registered but not listed is offered by the View menu and opens as a floating
 * window when the user adds it. A listed id that is not registered (its package was removed by
 * `scripts/scaffold.mjs`) is skipped, and a row left empty is dropped.
 *
 * App layer, dock only: removed together with the dock by `scripts/scaffold.mjs` (`removeDock`).
 * Without the dock the dashboard stacks the registered widgets in one column
 * (`DashboardWidgetStack.svelte`), which needs none of this.
 */
import type { DockLayout, DockNode } from '@banto/dock-svelte';
import { findDashboardWidget } from './dashboardWidgets';
import { refreshPanelTitles } from './dockTitles';

/**
 * The provider key (`UiSettingsProvider`, per user) and the localStorage key of the first-paint
 * copy (`${key}:<owner>`). New with W2: the keys of the dock before it (`dock.dashboard`,
 * `banto.dock.dashboard:<owner>`) are neither read nor converted (decision 2 - that dock held a
 * different set of panels below a fixed grid of cards).
 */
export const DASHBOARD_LAYOUT_SETTING_KEY = 'dashboard.widgets';
export const DASHBOARD_LAYOUT_STORAGE_KEY = 'banto.dashboard.widgets';

/** One pane of the default arrangement: a registered widget's id and its share of the row's width. */
interface DefaultCell {
	id: string;
	/** Relative width within the row. Default 1. */
	weight?: number;
}

/**
 * The default arrangement, row by row. The first row keeps the 8 : 4 split the fixed cards had
 * (the monthly trend is the primary chart). `spc` and `trend` are not in it: they are added from
 * the View menu, as before W2.
 */
const DEFAULT_ROWS: readonly (readonly DefaultCell[])[] = [
	[{ id: 'monthly', weight: 2 }, { id: 'categoryStock' }],
	[{ id: 'stackedBar' }, { id: 'priceBuckets' }, { id: 'scatter' }],
	[{ id: 'lowStock', weight: 2 }, { id: 'memo' }]
];

/**
 * The height of one row of the default arrangement, in px. A pane holds its content from 220px up
 * (title bar included; measured in W1, §4.13.8); 300px leaves a chart about the height the fixed
 * cards gave it.
 */
export const DASHBOARD_ROW_HEIGHT = 300;

/** The rows of the default with only the registered widgets; a row left empty is dropped. */
function defaultRows(): DefaultCell[][] {
	return DEFAULT_ROWS.map((row) =>
		row.filter((cell) => findDashboardWidget(cell.id) !== undefined)
	).filter((row) => row.length > 0);
}

/**
 * The dock's height in px: the rows of the default arrangement, `DASHBOARD_ROW_HEIGHT` each (900px
 * with all three rows; one row when the charts were removed). A fixed height, not "what is left of
 * the screen": three rows do not fit a 900px-high screen below the KPI strip, so the page scrolls -
 * as it did with the fixed cards.
 */
export function dashboardDockHeight(): number {
	return Math.max(1, defaultRows().length) * DASHBOARD_ROW_HEIGHT;
}

function share(weights: number[]): number[] {
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	return weights.map((weight) => weight / total);
}

/**
 * The default layout: every pane docked, nothing floating - so it does not depend on the host's
 * size and can be built before the host is measured (and while the dock is not on screen, in the
 * one-column display of a narrow page).
 */
export function defaultDashboardLayout(): DockLayout {
	const rows = defaultRows().map((row, index): DockNode => {
		const panels = row.map((cell): DockNode => {
			const def = findDashboardWidget(cell.id)!;
			return { type: 'panel', id: def.id, title: def.title, icon: def.icon };
		});
		return panels.length === 1
			? panels[0]!
			: {
					type: 'split',
					id: `row-${index}`,
					direction: 'row',
					children: panels,
					sizes: share(row.map((cell) => cell.weight ?? 1))
				};
	});
	const docked: DockNode | null =
		rows.length > 1
			? {
					type: 'split',
					id: 'root',
					direction: 'column',
					children: rows,
					sizes: rows.map(() => 1 / rows.length)
				}
			: (rows[0] ?? null);
	return { version: 4, floating: [], docked };
}

/**
 * The `validate` hook of the layout's store (`createDockLayoutStore`): a saved value is used only
 * when every panel in it is a registered widget; then its titles are re-resolved in today's
 * locale (dockTitles.ts, #729 review).
 *
 * A value that names an id the registry does not have - a widget the author removed or renamed
 * later, a copy scaffolded without the charts reading a layout saved with them - is REJECTED
 * (`null`): the store shows the default, and the stale value stays until the user changes the
 * layout or resets it. Dropping only the unknown panes would keep the rest of the user's
 * arrangement, but leaves holes (a split with one child, a share nobody fills) that the author's
 * new default was meant to replace; the default is the predictable answer.
 */
export function validateDashboardLayout(json: string): string | null {
	let unknown = false;
	const refreshed = refreshPanelTitles(json, (id) => {
		const def = findDashboardWidget(id);
		if (!def) unknown = true;
		return def?.title;
	});
	return unknown ? null : refreshed;
}
