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
export type NavIconKey = 'dashboard' | 'items' | 'users' | 'audit-log' | 'settings';

/** Paraglide message key for a nav entry's visible label (i18n layer ②,
 *  ADR-0005). The label itself is resolved at render time via `m[labelKey]()`
 *  so it tracks the active locale — see `pageTitle` below and Sidebar.svelte. */
export type NavLabelKey =
	'nav.dashboard' | 'nav.items' | 'nav.users' | 'nav.auditLog' | 'nav.settings';

export interface NavItem {
	path: string;
	labelKey: NavLabelKey;
	icon: NavIconKey;
	/** Spec M10 RBAC: only shown to the `admin` role. Undefined/false = visible to every role. */
	adminOnly?: boolean;
}

export const navItems: NavItem[] = [
	{ path: '/dashboard', labelKey: 'nav.dashboard', icon: 'dashboard' },
	{ path: '/items', labelKey: 'nav.items', icon: 'items' },
	{ path: '/users', labelKey: 'nav.users', icon: 'users', adminOnly: true },
	{ path: '/audit-log', labelKey: 'nav.auditLog', icon: 'audit-log', adminOnly: true },
	{ path: '/settings', labelKey: 'nav.settings', icon: 'settings' }
];

// "Banto" is the product brand (owner-fixed): kept as a component constant,
// never entered into the dictionary (PR-B2 scope rule).
const BRAND = 'Banto';

export function pageTitle(pathname: string): string {
	const item = navItems.find(
		(entry) => pathname === entry.path || pathname.startsWith(entry.path + '/')
	);
	return item ? m[item.labelKey]() : BRAND;
}
