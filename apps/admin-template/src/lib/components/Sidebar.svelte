<script lang="ts">
	/**
	 * App shell sidebar (visual-refresh-design.md §8.3). Four sections:
	 * brand / primary nav / admin nav (role-gated, own heading) / footer
	 * (collapse toggle). `overlayOpen` is owned by (app)/+layout.svelte (no
	 * new global store) and only matters at <=900px, where this component
	 * renders as a fixed slide-in drawer instead of the flex column.
	 */
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { navItems } from '$lib/navigation';
	import { NAV_ICONS } from './navIcons';
	import { settings } from '$lib/settings.svelte';
	import { sessionStore } from '$lib/session.svelte';
	import { isAdmin } from '$lib/permissions';
	import IconButton from './ui/IconButton.svelte';
	import { PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';

	interface Props {
		/** <=900px overlay drawer state (design.md §8.1); not a fold state - see the media query below. */
		overlayOpen?: boolean;
	}

	let { overlayOpen = false }: Props = $props();

	function isActive(path: string): boolean {
		return page.url.pathname === path || page.url.pathname.startsWith(path + '/');
	}

	// Spec M10 RBAC: hide admin-only entries (「ユーザー管理」) rather than
	// showing them disabled - navigation-level hiding, same as
	// routes/(app)/users/+page.ts redirecting a non-admin instead of
	// rendering a 403 screen.
	const mainItems = $derived(navItems.filter((item) => !item.adminOnly));
	const adminItems = $derived(
		isAdmin(sessionStore.role) ? navItems.filter((item) => item.adminOnly) : []
	);
</script>

<aside class:collapsed={settings.sidebarCollapsed} class:overlay-open={overlayOpen}>
	<div class="brand">
		<span class="brand-mark" aria-hidden="true">
			<svg viewBox="0 0 24 24" width="14" height="14">
				<rect x="10" y="3" width="4" height="2" rx="1" />
				<circle cx="12" cy="12" r="6" />
				<rect x="10" y="19" width="4" height="2" rx="1" />
			</svg>
		</span>
		<span class="brand-name">Banto</span>
	</div>

	<nav class="nav-section" aria-label="主要ナビゲーション">
		{#each mainItems as item (item.path)}
			{@const Icon = NAV_ICONS[item.icon]}
			<a
				href={`${base}${item.path}`}
				class="nav-item"
				class:active={isActive(item.path)}
				aria-current={isActive(item.path) ? 'page' : undefined}
				title={settings.sidebarCollapsed ? item.label : undefined}
			>
				<span class="icon"><Icon size={20} aria-hidden="true" /></span>
				<span class="label">{item.label}</span>
			</a>
		{/each}
	</nav>

	{#if adminItems.length > 0}
		<div class="section-divider"></div>
		<nav class="nav-section" aria-label="管理ナビゲーション">
			<p class="section-heading" aria-hidden="true">管理</p>
			{#each adminItems as item (item.path)}
				{@const Icon = NAV_ICONS[item.icon]}
				<a
					href={`${base}${item.path}`}
					class="nav-item"
					class:active={isActive(item.path)}
					aria-current={isActive(item.path) ? 'page' : undefined}
					title={settings.sidebarCollapsed ? item.label : undefined}
				>
					<span class="icon"><Icon size={20} aria-hidden="true" /></span>
					<span class="label">{item.label}</span>
				</a>
			{/each}
		</nav>
	{/if}

	<div class="footer">
		<IconButton
			label={settings.sidebarCollapsed ? 'サイドバーを開く' : 'サイドバーをたたむ'}
			icon={settings.sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
			onclick={() => settings.toggleSidebar()}
		/>
	</div>
</aside>

<style>
	aside {
		width: var(--banto-shell-sidebar-width);
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		background: var(--banto-surface);
		border-right: 1px solid var(--banto-border);
		transition: width var(--banto-duration-base) var(--banto-ease-out);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	aside.collapsed {
		width: var(--banto-shell-sidebar-width-collapsed);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		height: var(--banto-shell-header-height);
		padding: 0 0.9rem;
		border-bottom: 1px solid var(--banto-border);
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

	.brand-name {
		overflow: hidden;
		white-space: nowrap;
		opacity: 1;
		transition: opacity var(--banto-duration-base) var(--banto-ease-out);
	}

	aside.collapsed .brand-name {
		opacity: 0;
	}

	.nav-section {
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		gap: 2px;
	}

	.section-divider {
		height: 1px;
		margin: 0.25rem 0.9rem;
		background: var(--banto-border);
	}

	.section-heading {
		margin: 0.4rem 0.6rem 0.2rem;
		color: var(--banto-text-muted);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		overflow: hidden;
		white-space: nowrap;
		opacity: 1;
		transition: opacity var(--banto-duration-base) var(--banto-ease-out);
	}

	aside.collapsed .section-heading {
		opacity: 0;
	}

	.nav-item {
		position: relative;
		display: grid;
		/* Fixed icon column (design.md §8.3): the icon's X coordinate never
		   moves on collapse - only the label track shrinks with the aside's
		   own width transition above. */
		grid-template-columns: 20px minmax(0, 1fr);
		align-items: center;
		column-gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border-radius: var(--banto-radius-md);
		color: var(--banto-text-muted);
		text-decoration: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.nav-item:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.nav-item.active {
		background: color-mix(in srgb, var(--banto-primary) 14%, transparent);
		/* axe-core wcag2aa color-contrast (visual-refresh-plan.md §7.1): plain
		   --banto-primary on this tint background measures ~4.24:1, just under
		   the 4.5:1 text minimum - --banto-primary-hover (already defined,
		   previously unused) is darker/lighter enough per theme to clear it. */
		color: var(--banto-primary-hover);
		font-weight: 600;
	}

	.nav-item.active::before {
		content: '';
		position: absolute;
		inset-block: 4px;
		left: 0;
		width: 2px;
		border-radius: 2px;
		background: var(--banto-primary);
	}

	/* Glass preset accent (spec M12): the active nav item gets the accent
	   gradient. Scoped by the preset attribute so standard keeps the flat
	   tint above untouched. */
	:global([data-banto-preset='glass']) .nav-item.active {
		background: var(--banto-accent-gradient);
		color: var(--banto-text-inverse);
	}

	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.label {
		overflow: hidden;
		white-space: nowrap;
		opacity: 1;
		transition: opacity var(--banto-duration-base) var(--banto-ease-out);
	}

	aside.collapsed .label {
		opacity: 0;
	}

	.footer {
		margin-top: auto;
		padding: 0.5rem;
		border-top: 1px solid var(--banto-border);
	}

	@media (max-width: 900px) {
		aside {
			position: fixed;
			inset: 0 auto 0 0;
			z-index: 900;
			/* Overlay mode has no fold concept (design.md §8.3): always full
			   width regardless of the persisted collapsed setting. */
			width: var(--banto-shell-sidebar-width);
			box-shadow: var(--banto-shadow-lg);
			transform: translateX(-100%);
			transition: transform var(--banto-duration-base) var(--banto-ease-spring);
		}

		aside.collapsed {
			width: var(--banto-shell-sidebar-width);
		}

		aside.collapsed .label,
		aside.collapsed .brand-name,
		aside.collapsed .section-heading {
			opacity: 1;
		}

		aside.overlay-open {
			transform: translateX(0);
		}

		.footer {
			display: none;
		}
	}
</style>
