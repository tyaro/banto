<script lang="ts">
	/**
	 * App shell dock (nav-launcher-plan.md §5.1, D2-a): the alternative to
	 * Sidebar.svelte when `settings.navLayout === 'launcher'`. Wiring only -
	 * the same sections as the sidebar (`navSections()`: RBAC hiding and the
	 * viewer-public allowlist, §4.9), icons, unseen-change badges and texts
	 * are turned into `@banto/ui` `LauncherBar` groups; presentation,
	 * magnification, tooltips and the <=900px tab bar live in the package.
	 * Mounted before `.main` by (app)/+layout.svelte, like the sidebar (§4.7).
	 * The screen edge is the user's setting (`settings.launcherPosition`, D4).
	 */
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import {
		isPathActive,
		navBarEntries,
		navLabel,
		navSections,
		resolveAppPath,
		type NavItem
	} from '#lib/navigation.js';
	import { navIcon } from './navIcons';
	import { navBadges } from '#lib/navBadges.svelte.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { settings } from '#lib/settings.svelte.js';
	import { LauncherBar, type LauncherGroup, type LauncherItem } from '@banto/ui';

	const sections = $derived(
		navSections({ publicViewer: sessionStore.publicViewer, role: sessionStore.role })
	);

	/** Unseen-change badge text, capped like the sidebar's. */
	function badgeText(count: number): string {
		return count > 99 ? '99+' : String(count);
	}

	function toItem(item: NavItem): LauncherItem {
		const count = navBadges.count(item.path);
		return {
			id: item.path,
			href: resolveAppPath(item.path),
			label: navLabel(item),
			icon: navIcon(item.icon),
			active: isPathActive(item.path, page.url.pathname),
			badge:
				count > 0 ? { text: badgeText(count), label: m['shell.navUpdates']({ count }) } : undefined
		};
	}

	/**
	 * The main nav is one dock group (one `<nav>` landmark). A nav group (`NavItem.group`,
	 * nav-menubar-plan D8-b) is ruled off inside it: `separatorBefore` on the group's first item and
	 * on the standalone item right after it. With no group this is a plain run of items.
	 */
	function mainGroup(): LauncherGroup {
		const items: LauncherItem[] = [];
		let afterGroup = false;
		for (const entry of navBarEntries(sections.main)) {
			const own = entry.kind === 'group' ? entry.items : [entry.item];
			own.forEach((item, index) => {
				const rule = items.length > 0 && (afterGroup || (entry.kind === 'group' && index === 0));
				items.push({ ...toItem(item), ...(rule ? { separatorBefore: true } : {}) });
				afterGroup = false;
			});
			afterGroup = entry.kind === 'group';
		}
		return { id: 'main', ariaLabel: m['shell.mainNav'](), items };
	}

	const groups: LauncherGroup[] = $derived([
		mainGroup(),
		...(sections.admin.length > 0
			? [{ id: 'admin', ariaLabel: m['shell.adminNav'](), items: sections.admin.map(toItem) }]
			: [])
	]);
</script>

<LauncherBar {groups} position={settings.launcherPosition} />
