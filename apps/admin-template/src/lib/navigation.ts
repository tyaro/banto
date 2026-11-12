/**
 * Sidebar navigation definition.
 *
 * From M2, entries for CRUD pages are derived from resource definitions
 * (spec §3.1); manual entries like the ones below remain possible.
 */
import { isPathActive, type AppPath } from '#lib/appPath.js';
import type { Component } from 'svelte';
import type { RouteId } from '$app/types';
import { isDemoBuild } from '#lib/banto/environment.js';
import { resources } from '#lib/banto/resources/index.js';
import { isAdmin, type Role } from '#lib/permissions.js';
import * as m from '#lib/paraglide/messages.js';

/** Icon resolution key (visual-refresh-design.md §5.1). Resolved to an actual
 *  icon component only in the display layer (#lib/components/navIcons.ts) -
 *  this module stays UI-agnostic. */
export type NavIconKey = 'dashboard' | 'tree' | 'users' | 'audit-log' | 'settings';

/** Paraglide message key for a nav entry's visible label (i18n layer ②,
 *  ADR-0005). The label itself is resolved at render time via `m[labelKey]()`
 *  so it tracks the active locale — see `pageTitle` below and Sidebar.svelte. */
export type NavLabelKey =
	'nav.dashboard' | 'nav.tree' | 'nav.users' | 'nav.auditLog' | 'nav.settings';

/** Keys of the demo-only catalog entry (`NavItem.demoOnly`). Kept out of the unions above on purpose:
 *  scaffold's removers edit those unions by exact text (scripts/scaffold.mjs). */
export type DemoNavIconKey = 'ui-demo' | 'chart-gallery';
export type DemoNavLabelKey = 'nav.uiDemo' | 'nav.chartGallery';

export interface NavItem {
	path: AppPath;
	/** Fixed pages name a dictionary key; resource entries give `label` instead. */
	labelKey?: NavLabelKey | DemoNavLabelKey;
	/** Lazy label (resource entries: `nav.label` or the resource label). Read it via `navLabel()`. */
	label?: () => string;
	/** Fixed pages use a key resolved in navIcons.ts; resource entries carry the component from `nav.icon`. */
	icon: NavIconKey | DemoNavIconKey | Component;
	/** Resource whose current localized label is passed to route-specific titles. */
	pageTitleResource?: string;
	/** Exact route IDs keep static child pages distinct from record-edit routes. */
	pageTitles?: Partial<Record<RouteId, (resourceLabel: string) => string>>;
	/** Spec M10 RBAC: only shown to the `admin` role. Undefined/false = visible to every role. */
	adminOnly?: boolean;
	/**
	 * admin-core resource name whose `invalidate()` bus (spec §3.4 - own
	 * mutations AND `resource_changed` server events) feeds this entry's
	 * unseen-change badge (#lib/navBadges.svelte.ts, wired by
	 * routes/(app)/+layout.svelte). Undefined = no badge for this entry.
	 */
	badgeResource?: string;

	/**
	 * Opt-in allowlist for the LAN "viewer-public" session
	 * (viewer-public-plan §3.1-6, ADR-0012): `sessionStore.publicViewer`
	 * sessions see ONLY entries with `publicViewer: true` in the sidebar, and
	 * `(app)/+layout.ts`'s guard redirects any other path to the first such
	 * entry. This narrows the SCREEN surface only - the actual data boundary
	 * is RBAC's `viewer` role (ADR-0012 §帰結), so this flag must never be
	 * treated as an authorization check. Undefined/false = hidden from a
	 * public-viewer session. Template default: `/dashboard` and `/items`.
	 */
	publicViewer?: boolean;

	/**
	 * Show this entry in the sidebar / command palette only in the static demo
	 * build (`VITE_BANTO_DEMO=1`, see `isDemoBuild`). The route itself stays
	 * reachable by URL in every build - this hides the nav entry, nothing more
	 * (a catalog page like `/ui-demo`, not a feature).
	 */
	demoOnly?: boolean;
}

export { isPathActive, resolveAppPath, type AppPath } from '#lib/appPath.js';

/** The entry's visible label, resolved lazily so it follows the active locale. */
export function navLabel(item: NavItem): string {
	return item.label ? item.label() : m[item.labelKey as NavLabelKey | DemoNavLabelKey]();
}

/**
 * Entries derived from the resource definitions (ADR-0030 §8): every resource
 * with a `nav` object, in `resources` array order (placed right after the
 * dashboard). Labels stay functions so module evaluation does not freeze the
 * locale. `nav` false/undefined = no entry.
 */
function resourceNavItems(): NavItem[] {
	return resources.flatMap((resource) => {
		const nav = resource.nav;
		if (!nav) return [];
		const createRoute = `/(app)${resource.path}/new`;
		const editRoute = `/(app)${resource.path}/[id]`;
		return [
			{
				path: resource.path,
				label: nav.label ?? (() => resource.label),
				icon: nav.icon,
				badgeResource: nav.badge ? resource.name : undefined,
				pageTitleResource: resource.name,
				pageTitles: {
					[createRoute]: (name: string) => m['resource.createTitle']({ resource: name }),
					[editRoute]: (name: string) => m['resource.editTitle']({ resource: name })
				} as NavItem['pageTitles'],
				publicViewer: nav.publicViewer,
				adminOnly: nav.adminOnly
			}
		];
	});
}

const allNavItems: NavItem[] = [
	{ path: '/dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', publicViewer: true },
	...resourceNavItems(),
	{ path: '/tree', labelKey: 'nav.tree', icon: 'tree' },
	{ path: '/ui-demo', labelKey: 'nav.uiDemo', icon: 'ui-demo', demoOnly: true },
	{ path: '/chart-gallery', labelKey: 'nav.chartGallery', icon: 'chart-gallery', demoOnly: true },
	{ path: '/users', labelKey: 'nav.users', icon: 'users', adminOnly: true },
	{ path: '/audit-log', labelKey: 'nav.auditLog', icon: 'audit-log', adminOnly: true },
	{ path: '/settings', labelKey: 'nav.settings', icon: 'settings' }
];

/** The entries the shell shows: `demoOnly` ones only in the demo build (`isDemoBuild()` is a build-time constant). */
export const navItems: NavItem[] = allNavItems.filter((item) => !item.demoOnly || isDemoBuild());

/** `navItems` entries visible to a LAN "viewer-public" session (see `NavItem.publicViewer`'s doc comment). Order preserved - the first entry is the guard's redirect target. */
export function publicNavItems(): NavItem[] {
	return navItems.filter((item) => item.publicViewer);
}

/**
 * The sidebar's two sections for a session: `main` (primary nav) and `admin`
 * (own heading). Pure - the session values come in as arguments so this module
 * stays UI-agnostic (Sidebar.svelte passes `sessionStore` fields).
 *
 * Spec M10 RBAC: admin-only entries (the user-management page) are hidden
 * rather than shown disabled - navigation-level hiding, same as
 * routes/(app)/users/+page.ts redirecting a non-admin instead of rendering a
 * 403 screen.
 *
 * viewer-public-plan §3.1-6 (ADR-0012): a LAN "viewer-public" session sees ONLY
 * the `publicViewer` allowlist and never the admin section, regardless of role
 * (a publicViewer grant identity's role is always `viewer`, so `admin` would
 * already be empty, but the explicit check keeps this correct even if that
 * ever changed).
 */
export function navSections(session: { publicViewer: boolean; role: Role }): {
	main: NavItem[];
	admin: NavItem[];
} {
	return {
		main: session.publicViewer ? publicNavItems() : navItems.filter((item) => !item.adminOnly),
		admin:
			!session.publicViewer && isAdmin(session.role)
				? navItems.filter((item) => item.adminOnly)
				: []
	};
}

// "Banto" is the product brand (owner-fixed): kept as a component constant,
// never entered into the dictionary (PR-B2 scope rule).
const BRAND = 'Banto';

export function pageTitle(pathname: string, routeId?: RouteId | null): string {
	// Over every entry, not just the visible ones: a `demoOnly` page keeps its title when opened by URL.
	const item = allNavItems.find((entry) => isPathActive(entry.path, pathname));
	if (!item) return BRAND;
	const title = routeId ? item.pageTitles?.[routeId] : undefined;
	if (title) {
		// Read the definition lazily: localized getters and replacement resources
		// work without requiring the runtime registry to have been initialized.
		const label = resources.find((resource) => resource.name === item.pageTitleResource)?.label;
		return title(label ?? navLabel(item));
	}
	return navLabel(item);
}
