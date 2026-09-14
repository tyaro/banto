<script lang="ts">
	/**
	 * Settings shell (settings-routes step 2, choiapp-feedback-2026-09 §3.2 -
	 * overrides step 1/§3's "tabs vs anchors" call, see that doc section for
	 * why): `PageHeader` + a category nav + the active category's own route
	 * rendered via `{@render children()}`.
	 *
	 * Categories come from `+layout.ts`'s visible subset (`data.categories`)
	 * so the nav only ever lists what the current session may reach - same
	 * capability-hide rule step 1 used for its in-page anchor nav (spec
	 * §11.3), now applied to real routes instead of anchors.
	 *
	 * `.settings-page` stays the shared root class (unchanged from step 1)
	 * so `settings.css` - and every category page's markup classes
	 * (`.settings-section`/`.settings-grid`/etc.) - keep applying to
	 * whichever category page renders inside `{@render children()}`. The
	 * nav's own look/behavior (rail vs tabs, active state) is new for this
	 * step, so it lives in this component's own scoped style block instead of
	 * settings.css's global namespace (moved out of the old
	 * `.settings-page .section-nav` rules there).
	 */
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import type { SettingsCategory } from './categories';
	import type { LayoutProps } from './$types';
	import './settings.css';

	let { data, children }: LayoutProps = $props();

	/** Mirrors Sidebar.svelte's `isActive` / `navBadges.svelte.ts`'s `pathOwns`: a category owns its own path and any sub-path. */
	function isActive(category: SettingsCategory): boolean {
		return page.url.pathname === category.path || page.url.pathname.startsWith(category.path + '/');
	}
</script>

<div class="page settings-page">
	<PageHeader title={m['nav.settings']()} description={m['settings.pageDescription']()} />

	<div class="settings-layout">
		<nav class="section-nav" aria-label={m['settings.sectionNavAria']()}>
			{#each data.categories as category (category.id)}
				<a
					href={`${base}${category.path}`}
					class:active={isActive(category)}
					aria-current={isActive(category) ? 'page' : undefined}
				>
					{m[category.labelKey]()}
				</a>
			{/each}
		</nav>

		<div class="settings-content">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.settings-layout {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* Below 1024px: horizontal tab strip above the content (choiapp-feedback-2026-09 §3.2). */
	.section-nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.section-nav a {
		padding: 0.3rem 0.7rem;
		border: 1px solid var(--banto-border);
		border-radius: 999px;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		font-weight: 600;
		text-decoration: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.section-nav a:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.section-nav a:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* axe-core wcag2aa color-contrast (visual-refresh-plan.md §7.1): same
	   fix as Sidebar.svelte's .nav-item.active / the old
	   .theme-option.selected - plain --banto-primary text on this tint
	   background falls short of 4.5:1 (light theme). */
	.section-nav a.active {
		border-color: var(--banto-primary);
		color: var(--banto-primary-hover);
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
	}

	.settings-content {
		min-width: 0;
	}

	/* >=1024px: sticky left rail, content to its right (choiapp-feedback
	   -2026-09 §3.2). Sticky offset reuses Header.svelte's own height token -
	   the rail must clear the sticky app header (Header.svelte, z-index 100)
	   while the page body scrolls, same as Sidebar.svelte's own `aside`. */
	@media (min-width: 1024px) {
		.settings-layout {
			flex-direction: row;
			align-items: flex-start;
			gap: 1.5rem;
		}

		.section-nav {
			flex-direction: column;
			flex: 0 0 200px;
			gap: 0.25rem;
			position: sticky;
			top: calc(var(--banto-shell-header-height) + 1rem);
		}

		.settings-content {
			flex: 1;
		}
	}
</style>
