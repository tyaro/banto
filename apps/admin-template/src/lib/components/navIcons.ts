/**
 * Icon resolution for navigation entries (visual-refresh-design.md §5.2).
 *
 * `navigation.ts` stays UI-agnostic and only holds the `NavIconKey` string
 * key; the actual icon component is resolved here, in the display layer.
 */
import type { Component } from 'svelte';
import { LayoutDashboard, Package, Users, ScrollText, Settings } from '@lucide/svelte';
import type { NavIconKey } from '$lib/navigation';

export const NAV_ICONS: Record<NavIconKey, Component> = {
	dashboard: LayoutDashboard,
	items: Package,
	users: Users,
	'audit-log': ScrollText,
	settings: Settings
};
