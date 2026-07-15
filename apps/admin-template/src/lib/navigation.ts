/**
 * Sidebar navigation definition.
 *
 * From M2, entries for CRUD pages are derived from resource definitions
 * (spec §3.1); manual entries like the ones below remain possible.
 */

/** Icon resolution key (visual-refresh-design.md §5.1). Resolved to an actual
 *  icon component only in the display layer ($lib/components/navIcons.ts) -
 *  this module stays UI-agnostic. */
export type NavIconKey = 'dashboard' | 'items' | 'users' | 'audit-log' | 'settings';

export interface NavItem {
	path: string;
	label: string;
	icon: NavIconKey;
	/** Spec M10 RBAC: only shown to the `admin` role. Undefined/false = visible to every role. */
	adminOnly?: boolean;
}

export const navItems: NavItem[] = [
	{ path: '/dashboard', label: 'ダッシュボード', icon: 'dashboard' },
	{ path: '/items', label: '商品', icon: 'items' },
	{ path: '/users', label: 'ユーザー管理', icon: 'users', adminOnly: true },
	{ path: '/audit-log', label: '監査ログ', icon: 'audit-log', adminOnly: true },
	{ path: '/settings', label: '設定', icon: 'settings' }
];

export function pageTitle(pathname: string): string {
	const item = navItems.find(
		(entry) => pathname === entry.path || pathname.startsWith(entry.path + '/')
	);
	return item?.label ?? 'Banto';
}
