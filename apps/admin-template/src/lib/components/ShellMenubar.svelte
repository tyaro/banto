<script lang="ts">
	/**
	 * App shell menu bar (nav-menubar-plan.md §5.2, D1): the nav links in the
	 * header row when `settings.navLayout === 'menubar'`. Wiring only, the
	 * same shape as ShellLauncher.svelte - the sections of the sidebar
	 * (`navSections()`: RBAC hiding and the viewer-public allowlist, §4.11)
	 * are ordered into bar slots by `navBarEntries()` (groups gathered at
	 * their first member, §4.10) and handed to `@banto/ui` `HeaderNav`, which
	 * owns the overflow into "more", the dropdowns and the keyboard (§4.3-4.8).
	 *
	 * Two landmarks with the sidebar's names (§4.8): the main nav, which
	 * overflows, and the admin nav as one fixed "Admin" group that never goes
	 * into "more" (D4). Unread counts are passed as numbers (§4.5). Mounted by
	 * Header.svelte above 900px only; `onInsufficient` reports a main nav too
	 * narrow even for "more" so the shell falls back to the drawer (§4.9).
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
	import { HeaderNav, type HeaderNavEntry, type HeaderNavLink } from '@banto/ui';

	interface Props {
		/** The main nav became too narrow even for "more" (`true`), or fits again (`false`). */
		onInsufficient?: (insufficient: boolean) => void;
	}

	let { onInsufficient }: Props = $props();

	// The admin HeaderNav never overflows, so HeaderNav's own "close the open
	// dropdown when insufficient" path does not reach it - and its top-layer
	// dropdown would stay shown over the hidden, inert bar. Remount it closed
	// each time the main nav turns insufficient (same width, so the main nav's
	// measurement is unaffected).
	let adminGeneration = $state(0);

	function handleInsufficient(insufficient: boolean): void {
		if (insufficient) adminGeneration += 1;
		onInsufficient?.(insufficient);
	}

	const sections = $derived(
		navSections({ publicViewer: sessionStore.publicViewer, role: sessionStore.role })
	);

	function toLink(item: NavItem): HeaderNavLink {
		return {
			id: item.path,
			href: resolveAppPath(item.path),
			label: navLabel(item),
			icon: navIcon(item.icon),
			active: isPathActive(item.path, page.url.pathname),
			count: navBadges.count(item.path)
		};
	}

	const mainEntries: HeaderNavEntry[] = $derived(
		navBarEntries(sections.main).map((entry) =>
			entry.kind === 'item'
				? { kind: 'link', ...toLink(entry.item) }
				: { kind: 'group', id: entry.key, label: m[entry.key](), items: entry.items.map(toLink) }
		)
	);

	// D4: the whole admin section is one group (navBarEntries ignores an
	// adminOnly item's own `group`).
	const adminEntries: HeaderNavEntry[] = $derived(
		sections.admin.length > 0
			? [
					{
						kind: 'group',
						id: 'admin',
						label: m['shell.adminHeading'](),
						items: sections.admin.map(toLink)
					}
				]
			: []
	);

	const updatesLabel = (count: number): string => m['shell.navUpdates']({ count });
</script>

<HeaderNav
	entries={mainEntries}
	ariaLabel={m['shell.mainNav']()}
	moreLabel={m['shell.navMore']()}
	{updatesLabel}
	onInsufficient={handleInsufficient}
/>
{#if adminEntries.length > 0}
	{#key adminGeneration}
		<HeaderNav
			entries={adminEntries}
			ariaLabel={m['shell.adminNav']()}
			moreLabel={m['shell.navMore']()}
			{updatesLabel}
			overflow={false}
		/>
	{/key}
{/if}
