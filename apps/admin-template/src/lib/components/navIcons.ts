/**
 * Icon resolution for navigation entries (visual-refresh-design.md §5.2).
 *
 * `navigation.ts` stays UI-agnostic and only holds the `NavIconKey` string
 * key; the actual icon component is resolved here, in the display layer.
 */
import type { Component } from 'svelte';
import { LayoutDashboard, ListTree, Users, ScrollText, Settings } from '@lucide/svelte';
import { Palette } from '@lucide/svelte';
import { ChartColumn } from '@lucide/svelte';
import type { DemoNavIconKey, NavIconKey } from '#lib/navigation.js';

export const NAV_ICONS: Record<NavIconKey | DemoNavIconKey, Component> = {
	dashboard: LayoutDashboard,
	tree: ListTree,
	users: Users,
	'audit-log': ScrollText,
	settings: Settings,
	'ui-demo': Palette,
	'chart-gallery': ChartColumn
};

/** Fixed pages name an icon by key; resource entries already carry the component. */
export function navIcon(icon: NavIconKey | DemoNavIconKey | Component): Component {
	return typeof icon === 'string' ? NAV_ICONS[icon] : icon;
}
