/**
 * Sidebar navigation definition.
 *
 * From M2, entries for CRUD pages are derived from resource definitions
 * (spec §3.1); manual entries like the ones below remain possible.
 */
import * as m from '$lib/paraglide/messages';

/** Icon resolution key (visual-refresh-design.md §5.1). Resolved to an actual
 *  icon component only in the display layer ($lib/components/navIcons.ts) -
 *  this module stays UI-agnostic. */
export type NavIconKey = 'dashboard' | 'items' | 'tree' | 'users' | 'audit-log' | 'settings';

/** Paraglide message key for a nav entry's visible label (i18n layer ②,
 *  ADR-0005). The label itself is resolved at render time via `m[labelKey]()`
 *  so it tracks the active locale — see `pageTitle` below and Sidebar.svelte. */
export type NavLabelKey =
	'nav.dashboard' | 'nav.items' | 'nav.tree' | 'nav.users' | 'nav.auditLog' | 'nav.settings';

export interface NavItem {
	path: string;
	labelKey: NavLabelKey;
	icon: NavIconKey;
	/** Spec M10 RBAC: only shown to the `admin` role. Undefined/false = visible to every role. */
	adminOnly?: boolean;
	/**
	 * admin-core resource name whose `invalidate()` bus (spec §3.4 - own
	 * mutations AND `resource_changed` server events) feeds this entry's
	 * unseen-change badge ($lib/navBadges.svelte.ts, wired by
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
}

export const navItems: NavItem[] = [
	{ path: '/dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', publicViewer: true },
	// [scaffold:items] begin
	{
		path: '/items',
		labelKey: 'nav.items',
		icon: 'items',
		badgeResource: 'items',
		publicViewer: true
	},
	// [scaffold:items] end
	{ path: '/tree', labelKey: 'nav.tree', icon: 'tree' },
	{ path: '/users', labelKey: 'nav.users', icon: 'users', adminOnly: true },
	{ path: '/audit-log', labelKey: 'nav.auditLog', icon: 'audit-log', adminOnly: true },
	{ path: '/settings', labelKey: 'nav.settings', icon: 'settings' }
];

/** `navItems` entries visible to a LAN "viewer-public" session (see `NavItem.publicViewer`'s doc comment). Order preserved - the first entry is the guard's redirect target. */
export function publicNavItems(): NavItem[] {
	return navItems.filter((item) => item.publicViewer);
}

// "Banto" is the product brand (owner-fixed): kept as a component constant,
// never entered into the dictionary (PR-B2 scope rule).
const BRAND = 'Banto';

export function pageTitle(pathname: string): string {
	const item = navItems.find(
		(entry) => pathname === entry.path || pathname.startsWith(entry.path + '/')
	);
	return item ? m[item.labelKey]() : BRAND;
}
