/**
 * What the app shell shows for a nav placement and a width, as a pure
 * function (#850; moved from the two downstream copies' `mobileNav.ts`).
 * The 900px boundary is shared (`NARROW_QUERY`), but whether a narrow sidebar
 * becomes a drawer is the app's choice: `narrowSidebar`.
 */

export type ShellNavLayout = 'sidebar' | 'launcher' | 'menubar';

/**
 * What a <=900px sidebar becomes in the `'sidebar'` layout:
 * `'drawer'` (default; admin-template, banto-hub) slides in over the page;
 * `'column'` (ChronoGazer) stays a column and its button only folds it.
 * The `'menubar'` layout is not affected: its sidebar is a drawer whenever it
 * is shown, because it only stands in for the bar.
 */
export type NarrowSidebar = 'drawer' | 'column';

export interface ShellNavOptions {
	narrowSidebar?: NarrowSidebar;
}

export interface ShellNavView {
	/** Mount the menu bar in the header (the menu bar layout above 900px). */
	showBar: boolean;
	/** Render the sidebar (`<aside>`), as a column or as a drawer (`drawerMode`). */
	showSidebar: boolean;
	/** The rendered sidebar is a drawer (slides in, has a backdrop). */
	drawerMode: boolean;
	/** The header shows the drawer button. Never in the launcher layout. */
	showDrawerButton: boolean;
}

/**
 * - `'sidebar'`: always the sidebar; a drawer at <=900px only with
 *   `narrowSidebar: 'drawer'` (default).
 * - `'launcher'`: no sidebar and no toggle (`LauncherBar` is the nav; at
 *   <=900px it is the bottom tab bar).
 * - `'menubar'`: the bar above 900px (no sidebar). At <=900px, or above it
 *   while the bar does not fit even with "more" (`menubarInsufficient`), the
 *   sidebar is shown as the drawer. The flag only counts while the bar is
 *   mounted (above 900px); keep the bar mounted (hidden) while it is set so
 *   a width that comes back can be measured again.
 */
export function resolveShellNav(
	layout: ShellNavLayout,
	isNarrow: boolean,
	menubarInsufficient: boolean,
	options: ShellNavOptions = {}
): ShellNavView {
	const narrowSidebar = options.narrowSidebar ?? 'drawer';
	if (layout === 'launcher') {
		return { showBar: false, showSidebar: false, drawerMode: false, showDrawerButton: false };
	}
	if (layout === 'sidebar') {
		const drawerMode = isNarrow && narrowSidebar === 'drawer';
		return { showBar: false, showSidebar: true, drawerMode, showDrawerButton: drawerMode };
	}
	const showBar = !isNarrow;
	const drawerMode = isNarrow || (showBar && menubarInsufficient);
	return { showBar, showSidebar: drawerMode, drawerMode, showDrawerButton: drawerMode };
}
