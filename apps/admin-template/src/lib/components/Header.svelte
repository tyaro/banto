<script lang="ts">
	/**
	 * App shell header (visual-refresh-design.md §8.2). DOM order: drawer button
	 * (<=900px only) -> page heading -> spacer -> search pill -> theme toggle
	 * (sun/moon) -> user menu.
	 * The >900px fold button is NOT here: it sits at the left of the sidebar's
	 * top row, before the logo (Sidebar.svelte; Google-apps style), so above
	 * 900px the header starts with the page title.
	 * In the dock layout (nav-launcher-plan.md §4.1/§4.6) no toggle is shown
	 * (there is no drawer) and the brand the sidebar carried takes its place
	 * at the left.
	 * In the menu bar layout (nav-menubar-plan.md §4.1/§4.6/§4.9) the brand and
	 * ShellMenubar lead the row above 900px: the page title is capped at
	 * `--banto-shell-menubar-title-max` (full text in `title`, D6) and the
	 * search is always the icon (D6). At <=900px, or when the main nav is too
	 * narrow even for "more" (`menubarInsufficient`, §4.9), the drawer button
	 * comes back and the sidebar is the drawer; while insufficient the bar
	 * stays mounted (hidden) so it can report the width coming back.
	 */
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { logoutAndLeave } from '#lib/banto/logout.svelte.js';
	import { notifyLogoutOutcome } from '#lib/banto/logoutNotice.js';
	import { pageTitle } from '#lib/navigation.js';
	import { getBantoMode, isTauri } from '#lib/banto/setup.js';
	import { lanShareStatus } from '#lib/banto/lanShare.svelte.js';
	import { isAdmin } from '#lib/permissions.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { settings } from '#lib/settings.svelte.js';
	import { narrowViewport } from '#lib/narrowViewport.svelte.js';
	import { commandPaletteStore } from '#lib/commandPalette.svelte.js';
	import { appShortcuts, COMMAND_PALETTE_SHORTCUT } from '#lib/shortcuts.js';
	import { IconButton, Menu, MenuGroup, MenuItem, MenuSeparator, StatusBadge } from '@banto/ui';
	import ShellMenubar from './ShellMenubar.svelte';
	import {
		Menu as MenuIcon,
		Search,
		Settings,
		LogOut,
		LogIn,
		Maximize,
		Minimize,
		Moon,
		Sun
	} from '@lucide/svelte';

	interface Props {
		/** <=900px overlay drawer state, owned by (app)/+layout.svelte (design.md §8.1). */
		overlayOpen?: boolean;
		onToggleOverlay?: () => void;
		/** Menu bar layout: the main nav is too narrow even for "more" (nav-menubar-plan.md §4.9), owned by the layout. */
		menubarInsufficient?: boolean;
		onMenubarInsufficient?: (insufficient: boolean) => void;
	}

	let {
		overlayOpen = false,
		onToggleOverlay,
		menubarInsufficient = false,
		onMenubarInsufficient
	}: Props = $props();

	// Menu bar layout (nav-menubar-plan.md §4.9, D10-a): the bar is mounted
	// above 900px; the drawer button shows at <=900px (as in the sidebar
	// layout) and while the bar is insufficient. The brand stays while
	// insufficient - swapping it for the narrower button would hand the nav
	// the width back and flip the state again.
	const menubar = $derived(settings.navLayout === 'menubar');
	const showBar = $derived(menubar && !narrowViewport.current);
	const showDrawerButton = $derived(
		settings.navLayout !== 'launcher' &&
			(narrowViewport.current || (showBar && menubarInsufficient))
	);

	let barHost: HTMLElement | undefined = $state();
	let drawerButtonHost: HTMLElement | undefined = $state();

	// PR-2 hand-over (§4.9): HeaderNav only closes its dropdown when it turns
	// insufficient; where focus goes is the shell's call. Focus inside the bar
	// (now hidden) moves to the drawer button that replaces it; focus on the
	// drawer button or in the drawer moves back to the bar's first item when
	// it fits again (the button and the drawer go away).
	async function handleMenubarInsufficient(insufficient: boolean): Promise<void> {
		const active = document.activeElement;
		const focusToButton = insufficient && barHost?.contains(active) === true;
		const focusToBar =
			!insufficient &&
			(drawerButtonHost?.contains(active) === true ||
				document.getElementById('app-sidebar')?.contains(active) === true);
		onMenubarInsufficient?.(insufficient);
		if (!focusToButton && !focusToBar) return;
		await tick();
		const target = focusToButton
			? drawerButtonHost?.querySelector<HTMLElement>('button')
			: barHost?.querySelector<HTMLElement>('[data-header-nav-top]');
		target?.focus();
	}

	// The 900px breakpoint (and a layout switch) swaps the bar and the drawer
	// without going through `onInsufficient`: the focused nav element is
	// unmounted. Capture where focus is before the DOM changes and hand it to
	// the replacement - the drawer button for a bar that leaves, the bar's
	// first item for a drawer that leaves (an inert, insufficient bar refuses
	// the focus, and `handleMenubarInsufficient` moves it on).
	let lastShowBar: boolean | undefined;
	$effect.pre(() => {
		const next = showBar;
		const previous = lastShowBar;
		lastShowBar = next;
		if (previous === undefined || next === previous) return;
		const active = document.activeElement;
		const fromBar = !next && barHost?.contains(active) === true;
		const fromDrawer =
			next &&
			(drawerButtonHost?.contains(active) === true ||
				document.getElementById('app-sidebar')?.contains(active) === true);
		if (!fromBar && !fromDrawer) return;
		void tick().then(() => {
			const target = fromBar
				? drawerButtonHost?.querySelector<HTMLElement>('button')
				: barHost?.querySelector<HTMLElement>('[data-header-nav-top]');
			if (target?.isConnected && !target.closest('[inert]')) target.focus();
		});
	});

	const pageTitleText = $derived(pageTitle(page.url.pathname, page.route.id));

	// <=900px: the one button that opens/closes the overlay drawer. Above 900px
	// the sidebar's own top row carries the fold button instead (one control
	// at a time: `narrowViewport` decides which is rendered, not CSS).
	const drawerLabel = $derived(
		overlayOpen ? m['shell.closeSidebar']() : m['shell.expandSidebar']()
	);

	const displayName = $derived(sessionStore.identity?.name ?? sessionStore.identity?.id ?? '');
	const avatarInitial = $derived(displayName ? displayName.charAt(0).toUpperCase() : '?');

	// Standard status area (choiapp-feedback-2026-09 §4.2): environment/session
	// facts an operator should see at a glance, without opening a page.
	// Decided once per page load - `getBantoMode()` never changes at runtime
	// (same rule as settings/+page.svelte's `tauri` constant), and this
	// component only mounts after the (app) layout guard awaited bantoReady.
	const demoMode = getBantoMode() === 'demo';

	// Issue #558 (design-ux-review-2026-11 D-2): "LAN 共有中・接続 n 台" while
	// this PC shares the app on the LAN - only in the desktop window, and only
	// for an admin (the LAN status is the admin-only `server_status`; a LAN
	// browser never asks). Re-read every 10 s while shown
	// (`lanShare.svelte.ts`); the watch stops with this header or the role.
	const desktopWindow = isTauri();
	const watchLanShare = $derived(desktopWindow && isAdmin(sessionStore.role));
	$effect(() => {
		if (!watchLanShare) return;
		return lanShareStatus.watch();
	});
	const lanShare = $derived(watchLanShare ? lanShareStatus.summary : null);

	const roleLabels = {
		admin: m['role.admin'],
		editor: m['role.editor'],
		viewer: m['role.viewer']
	} as const;

	async function logout() {
		// Issue #215/#255, #260 (I-10): log out, confirm the session, and go
		// to /login only when it is confirmed ended (another tab's login
		// confirmed meanwhile stays) - see `#lib/banto/logout.svelte.ts` for
		// the order. Same in `commands.ts`.
		await logoutAndLeave(() => goto(resolve(`login`)), { notify: notifyLogoutOutcome });
	}

	// Kiosk shell fullscreen button (display-preset-plan.md D1-b). Two
	// independent state sources depending on environment (spec §10: the
	// branch lives here in the provider-ish helper below, not spread across
	// the template):
	// - Browser/LAN: the real Fullscreen API - `document.fullscreenElement`
	//   is the source of truth, kept in sync via the `fullscreenchange` event
	//   (also fires for an ESC-key exit, which this component never sees
	//   directly).
	// - Tauri: `setFullscreen`/`isFullscreen` from `@tauri-apps/api/window`
	//   change the OS window, not the DOM - there is no DOM event to listen
	//   for, so `isFullscreen` is a plain local flag this component owns,
	//   seeded once from the window's actual state on mount.
	// Dynamic import (not a static one) keeps this module loadable in the
	// `visual` project's plain-browser preview, which has no Tauri runtime.
	let isFullscreen = $state(false);

	$effect(() => {
		if (!settings.kiosk) return;
		if (isTauri()) {
			let cancelled = false;
			void (async () => {
				try {
					const { getCurrentWindow } = await import('@tauri-apps/api/window');
					const current = await getCurrentWindow().isFullscreen();
					if (!cancelled) isFullscreen = current;
				} catch {
					// Older backend/webview without the window plugin permission:
					// keep the button working as a pure toggle (state just starts
					// at `false`, same as a fresh browser tab).
				}
			})();
			return () => {
				cancelled = true;
			};
		}

		function onFullscreenChange(): void {
			isFullscreen = document.fullscreenElement !== null;
		}
		document.addEventListener('fullscreenchange', onFullscreenChange);
		onFullscreenChange();
		return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
	});

	async function toggleFullscreen(): Promise<void> {
		const next = !isFullscreen;
		if (isTauri()) {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			await getCurrentWindow().setFullscreen(next);
			isFullscreen = next;
			return;
		}
		if (next) {
			await document.documentElement.requestFullscreen();
		} else {
			await document.exitFullscreen();
		}
		// `fullscreenchange` (bound above) updates `isFullscreen` for the
		// browser path - no need to set it here too.
	}
</script>

<header class:compact={settings.kiosk} class:menubar-shown={showBar}>
	{#if showDrawerButton}
		<span class="drawer-button" bind:this={drawerButtonHost}>
			<IconButton
				label={drawerLabel}
				icon={MenuIcon}
				expanded={overlayOpen}
				controls="app-sidebar"
				onclick={() => onToggleOverlay?.()}
			/>
		</span>
	{/if}
	{#if settings.navLayout === 'launcher' || showBar}
		<div class="brand">
			<span class="brand-mark" aria-hidden="true">
				<svg viewBox="0 0 24 24" width="14" height="14">
					<rect x="10" y="3" width="4" height="2" rx="1" />
					<circle cx="12" cy="12" r="6" />
					<rect x="10" y="19" width="4" height="2" rx="1" />
				</svg>
			</span>
			<!-- "Banto" is the product brand (owner-fixed): a component constant,
			     never keyed - same as Sidebar.svelte. -->
			<span class="brand-name">Banto</span>
		</div>
	{/if}
	{#if showBar}
		<!-- Menu bar (nav-menubar-plan.md §4.1): takes the room the row leaves
		     (no spacer). While insufficient (§4.9) it is hidden and inert -
		     the drawer carries the same landmarks then - but keeps its width so
		     HeaderNav can see the room come back. -->
		<div
			class="menubar"
			bind:this={barHost}
			style:visibility={menubarInsufficient ? 'hidden' : undefined}
			inert={menubarInsufficient}
		>
			<ShellMenubar onInsufficient={handleMenubarInsufficient} />
		</div>
	{/if}

	<!-- The shell shows the title visually. Page content retains its document
	     h1 for assistive technology, using PageHeader's hideTitle option. -->
	<p class="page-title" class:menubar-title={showBar} title={showBar ? pageTitleText : undefined}>
		{pageTitleText}
	</p>

	{#if !showBar}
		<div class="spacer"></div>
	{/if}

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
		{#if lanShare}
			<a
				class="lan-share-link"
				href={resolve(`settings/connectivity`)}
				title={m['shell.lanSharingOpenSettings']()}
				data-lan-share-connections={lanShare.connections ?? ''}
			>
				<StatusBadge
					variant="success"
					label={lanShare.connections === null
						? m['shell.lanSharing']()
						: m['shell.lanSharingConnections']({ count: lanShare.connections })}
				/>
			</a>
		{/if}
		{#if !sessionStore.authDisabled}
			<StatusBadge variant="neutral" label={roleLabels[sessionStore.role]()} />
		{/if}
	</div>

	<!-- Kiosk shell (display-preset-plan.md D1-b): the search pill/command
	     palette icon is hidden entirely rather than just shrunk - a
	     permanently-mounted dashboard has no keyboard operator to invoke it. -->
	{#if !settings.kiosk}
		<button
			type="button"
			class="search-pill"
			title={m['shell.openCommandPalette']()}
			onclick={() => commandPaletteStore.show()}
		>
			<Search size={16} aria-hidden="true" />
			<span>{m['shell.searchPlaceholder']()}</span>
			<!-- The dispatcher's key, as the platform writes it (Ctrl+K / ⌘K, #435). -->
			<kbd>{appShortcuts.format(COMMAND_PALETTE_SHORTCUT)}</kbd>
		</button>
		<div class="search-icon-only">
			<IconButton
				label={showBar
					? m['shell.openCommandPaletteWithShortcut']({
							label: m['shell.openCommandPalette'](),
							shortcut: appShortcuts.format(COMMAND_PALETTE_SHORTCUT)
						})
					: m['shell.openCommandPalette']()}
				icon={Search}
				onclick={() => commandPaletteStore.show()}
			/>
		</div>
	{:else}
		<IconButton
			label={isFullscreen ? m['shell.exitFullscreen']() : m['shell.enterFullscreen']()}
			icon={isFullscreen ? Minimize : Maximize}
			onclick={toggleFullscreen}
		/>
	{/if}

	<!-- Colour mode toggle: shows the OPPOSITE of the theme on screen and pins
	     it on click (no longer following the OS). Rendered in every layout and
	     viewport; the picker left the settings page. -->
	<IconButton
		label={settings.resolvedTheme === 'dark'
			? m['shell.switchToLightMode']()
			: m['shell.switchToDarkMode']()}
		icon={settings.resolvedTheme === 'dark' ? Sun : Moon}
		onclick={() => settings.toggleThemeMode()}
	/>

	{#if sessionStore.publicViewer}
		<!-- viewer-public-plan §3.1-6 (ADR-0012): a LAN "viewer-public" session
		     has no account/menu at all - offer the way back to a real login
		     instead of the user menu. Role chip above still shows 閲覧者
		     (unchanged). -->
		<button
			type="button"
			class="banto-btn banto-btn--secondary login-button"
			onclick={() => goto(resolve(`login`))}
		>
			<LogIn size={16} aria-hidden="true" />
			{m['shell.login']()}
		</button>
	{:else if !sessionStore.authDisabled}
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
					onSelect={() => goto(resolve(`settings`))}
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
		z-index: var(--banto-z-header);
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
		height: var(--banto-shell-header-height);
		padding: 0 var(--banto-space-4);
		background: var(--banto-shell-header-bg, var(--banto-surface));
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		/* The glass header uses stronger blur than cards (design-ux-review A-3). */
		backdrop-filter: var(--banto-shell-header-backdrop, var(--banto-backdrop, none));
	}

	/* Keep the prefixed path for older WebKit even when a consumer compiles
	   this source without the template's CSS prefixing step. Keep it in a
	   separate rule: the production minifier otherwise drops the standard
	   declaration from a pair in the same rule. */
	@supports not (backdrop-filter: blur(1px)) {
		header {
			backdrop-filter: var(--banto-shell-header-backdrop, var(--banto-backdrop, none));
			-webkit-backdrop-filter: var(--banto-shell-header-backdrop, var(--banto-backdrop, none));
		}
	}

	/* Kiosk shell (display-preset-plan.md D1-b): shorter header for a
	   permanently-mounted dashboard. Sticky/z-index above are unchanged. */
	header.compact {
		height: var(--banto-shell-header-height-compact);
	}

	.status-area {
		display: none;
		align-items: center;
		gap: var(--banto-space-2);
	}

	@media (min-width: 768px) {
		.status-area {
			display: flex;
		}
	}

	/* Issue #558: the "LAN 共有中" chip is a link to the connection settings. */
	.lan-share-link {
		display: inline-flex;
		border-radius: var(--banto-radius-md);
		text-decoration: none;
	}

	.lan-share-link:hover {
		filter: brightness(0.96);
	}

	.lan-share-link:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* Dock layout brand (same look as Sidebar.svelte's .brand). */
	.brand {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		flex-shrink: 0;
		padding-right: var(--banto-space-3);
		border-right: var(--banto-border-width) solid var(--banto-border);
		font-weight: 700;
	}

	.brand-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 26px;
		height: 26px;
		border-radius: var(--banto-radius-md);
		background: var(--banto-accent-gradient);
	}

	.brand-mark svg {
		fill: var(--banto-text-inverse);
	}

	.page-title {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--banto-font-size-base);
		font-weight: 600;
		font-feature-settings: 'palt';
	}

	.spacer {
		flex: 1;
	}

	/* Menu bar layout (nav-menubar-plan.md §4.6): the bar takes what the row
	   leaves; the main HeaderNav inside grows the same way and measures it. */
	.menubar {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		flex: 1 1 0;
		min-width: 0;
		height: 100%;
	}

	/* D6: the title stays, capped and cut with an ellipsis. */
	.page-title.menubar-title {
		flex: 0 1 auto;
		max-width: var(--banto-shell-menubar-title-max);
	}

	.drawer-button {
		display: contents;
	}

	.search-pill {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
		height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text-muted);
		font: inherit;
		font-size: var(--banto-font-size-sm);
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
		padding: var(--banto-space-1) var(--banto-space-1);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-sm);
		background: var(--banto-surface-subtle);
		color: var(--banto-text-muted);
		font: inherit;
		font-size: var(--banto-font-size-xs);
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

	/* Menu bar layout (nav-menubar-plan.md §4.6, D6): always the icon, with
	   the key in its tooltip, so the nav keeps the room. */
	header.menubar-shown .search-pill {
		display: none;
	}

	header.menubar-shown .search-icon-only {
		display: block;
	}

	.user-trigger {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
		height: var(--banto-control-height);
		padding: 0 var(--banto-space-2) 0 var(--banto-space-1);
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

	.login-button {
		flex-shrink: 0;
		white-space: nowrap;
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
		font-size: var(--banto-font-size-sm);
		font-weight: 700;
	}

	.user-name {
		display: none;
		font-size: var(--banto-font-size-md);
		font-weight: 600;
		white-space: nowrap;
	}

	@media (min-width: 768px) {
		.user-name {
			display: inline;
		}
	}
</style>
