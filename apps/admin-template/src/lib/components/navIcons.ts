/**
 * Icon resolution for navigation entries (visual-refresh-design.md §5.2).
 *
 * `navigation.ts` stays UI-agnostic and keeps its emoji `icon: string` field
 * for now - unit 1 (this file) must not touch it, that's unit 2's scope.
 *
 * TODO(unit 2): move `NavIconKey` into `$lib/navigation.ts` per
 * visual-refresh-design.md §5.1 (replacing the emoji-string `icon` field on
 * `NavItem`), then have this module import the type from there instead of
 * declaring it locally.
 */
import type { Component } from 'svelte';
import { LayoutDashboard, Package, Users, ScrollText, Settings } from '@lucide/svelte';

export type NavIconKey = 'dashboard' | 'items' | 'users' | 'audit-log' | 'settings';

export const NAV_ICONS: Record<NavIconKey, Component> = {
	dashboard: LayoutDashboard,
	items: Package,
	users: Users,
	'audit-log': ScrollText,
	settings: Settings
};
