<script lang="ts">
	/**
	 * App shell header (visual-refresh-design.md §8.2). DOM order: hamburger
	 * (<=900px only) -> page heading -> spacer -> search pill -> user menu.
	 */
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { getAuthProvider } from '@banto/admin-core';
	import { pageTitle } from '$lib/navigation';
	import { getBantoMode } from '$lib/banto/setup';
	import { sessionStore } from '$lib/session.svelte';
	import { commandPaletteStore } from '$lib/commandPalette.svelte';
	import IconButton from './ui/IconButton.svelte';
	import Menu from './menu/Menu.svelte';
	import MenuGroup from './menu/MenuGroup.svelte';
	import MenuItem from './menu/MenuItem.svelte';
	import MenuSeparator from './menu/MenuSeparator.svelte';
	import StatusBadge from './ui/StatusBadge.svelte';
	import { Menu as MenuIcon, Search, Settings, LogOut } from '@lucide/svelte';

	interface Props {
		/** <=900px overlay drawer state, owned by (app)/+layout.svelte (design.md §8.1). */
		overlayOpen?: boolean;
		onToggleOverlay?: () => void;
	}

	let { overlayOpen = false, onToggleOverlay }: Props = $props();

	const displayName = $derived(sessionStore.identity?.name ?? sessionStore.identity?.id ?? '');
	const avatarInitial = $derived(displayName ? displayName.charAt(0).toUpperCase() : '?');

	// Standard status area (choiapp-feedback-2026-09 §4.2): environment/session
	// facts an operator should see at a glance, without opening a page.
	// Decided once per page load - `getBantoMode()` never changes at runtime
	// (same rule as settings/+page.svelte's `tauri` constant), and this
	// component only mounts after the (app) layout guard awaited bantoReady.
	const demoMode = getBantoMode() === 'demo';

	const roleLabels = {
		admin: m['role.admin'],
		editor: m['role.editor'],
		viewer: m['role.viewer']
	} as const;

	async function logout() {
		await getAuthProvider().logout();
		goto(`${base}/login`);
	}
</script>

<header>
	<div class="hamburger">
		<IconButton
			label={overlayOpen ? m['shell.closeSidebar']() : m['shell.expandSidebar']()}
			icon={MenuIcon}
			onclick={() => onToggleOverlay?.()}
		/>
	</div>

	<!-- Deliberately NOT a heading: the document h1 belongs to the page
	     content (ui/PageHeader.svelte) - two h1s per page would be a strict
	     a11y violation once every page adopts PageHeader (units 4-5). -->
	<p class="page-title">{pageTitle(page.url.pathname)}</p>

	<div class="spacer"></div>

	<!-- Status area: chips render only while their state applies. Hidden on
	     narrow viewports (same breakpoint as .user-name) to keep the bar
	     usable. No-login mode (M11) deliberately shows NOTHING here - for a
	     choi-app started via the setup-skip path it is the app's normal
	     state, not a condition to warn about, and its synthetic role is not
	     an identity worth a chip (owner decision, choiapp-feedback-2026-09
	     §4.2/§5). -->
	<div class="status-area">
		{#if demoMode}
			<StatusBadge variant="info" label={m['shell.statusDemo']()} />
		{/if}
		{#if !sessionStore.authDisabled}
			<StatusBadge variant="neutral" label={roleLabels[sessionStore.role]()} />
		{/if}
	</div>

	<button type="button" class="search-pill" onclick={() => commandPaletteStore.show()}>
		<Search size={16} aria-hidden="true" />
		<span>{m['shell.searchPlaceholder']()}</span>
		<kbd>Ctrl K</kbd>
	</button>
	<div class="search-icon-only">
		<IconButton
			label={m['shell.openCommandPalette']()}
			icon={Search}
			onclick={() => commandPaletteStore.show()}
		/>
	</div>

	{#if !sessionStore.authDisabled}
		<Menu label={m['shell.userMenu']()} placement="bottom-end">
			{#snippet trigger(props)}
				<button
					{...props}
					type="button"
					class="user-trigger"
					aria-label={m['shell.openUserMenu']()}
				>
					<span class="avatar" aria-hidden="true">{avatarInitial}</span>
					<span class="user-name">{displayName}</span>
				</button>
			{/snippet}
			<MenuGroup label={displayName}>
				<MenuItem
					icon={Settings}
					label={m['nav.settings']()}
					onSelect={() => goto(`${base}/settings`)}
				/>
			</MenuGroup>
			<MenuSeparator />
			<MenuItem icon={LogOut} label={m['shell.logout']()} danger onSelect={logout} />
		</Menu>
	{/if}
</header>

<style>
	header {
		/* Pinned while the page body scrolls (choiapp-feedback-2026-09 §2;
		   Sidebar.svelte's aside is sticky for the same reason). z-index sits
		   above in-page floats (grid popovers/dock windows stay <= 30) and
		   below the <=900px sidebar overlay stack (backdrop 850 / drawer 900)
		   and the global CommandPalette/ToastHost layers (1000). */
		position: sticky;
		top: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: var(--banto-shell-header-height);
		padding: 0 1rem;
		background: var(--banto-surface);
		border-bottom: 1px solid var(--banto-border);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.status-area {
		display: none;
		align-items: center;
		gap: 0.4rem;
	}

	@media (min-width: 768px) {
		.status-area {
			display: flex;
		}
	}

	.hamburger {
		display: none;
	}

	@media (max-width: 900px) {
		.hamburger {
			display: block;
		}
	}

	.page-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		font-feature-settings: 'palt';
		text-wrap: balance;
	}

	.spacer {
		flex: 1;
	}

	.search-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--banto-control-height-sm);
		padding: 0 0.7rem;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text-muted);
		font: inherit;
		font-size: 0.8rem;
		cursor: pointer;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.search-pill:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.search-pill:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.search-pill kbd {
		padding: 0.1rem 0.35rem;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-sm);
		background: var(--banto-surface-subtle);
		color: var(--banto-text-muted);
		font: inherit;
		font-size: 0.7rem;
	}

	.search-icon-only {
		display: none;
	}

	@media (max-width: 768px) {
		.search-pill {
			display: none;
		}

		.search-icon-only {
			display: block;
		}
	}

	.user-trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--banto-control-height);
		padding: 0 0.5rem 0 0.3rem;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.user-trigger:hover {
		background: var(--banto-surface-hover);
	}

	.user-trigger:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.user-name {
		display: none;
		font-size: 0.85rem;
		font-weight: 600;
		white-space: nowrap;
	}

	@media (min-width: 768px) {
		.user-name {
			display: inline;
		}
	}
</style>
