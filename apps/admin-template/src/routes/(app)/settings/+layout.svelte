<script lang="ts">
	/**
	 * Settings shell (settings-routes step 2, choiapp-feedback-2026-09 §3.2 -
	 * overrides step 1/§3's "tabs vs anchors" call, see that doc section for
	 * why): a description + a category nav + the active category's own route
	 * rendered via `{@render children()}`.
	 *
	 * Categories come from `+layout.ts`'s visible subset (`data.categories`)
	 * so the nav only ever lists what the current session may reach - same
	 * capability-hide rule step 1 used for its in-page anchor nav (spec
	 * §11.3), now applied to real routes instead of anchors.
	 *
	 * The nav is a horizontal strip above the content at every width (no left
	 * rail any more, so the content is not narrowed next to the app sidebar).
	 *
	 * `.settings-page` stays the shared root class (unchanged from step 1)
	 * so `settings.css` - and every category page's markup classes
	 * (`.settings-section`/`.settings-grid`/etc.) - keep applying to
	 * whichever category page renders inside `{@render children()}`. The
	 * nav's own look/behavior (tab strip, active state) is new for this
	 * step, so it lives in this component's own scoped style block instead of
	 * settings.css's global namespace (moved out of the old
	 * `.settings-page .section-nav` rules there).
	 *
	 * Copilot review on PR #198 also moved the shared cross-category stores'
	 * INITIAL loads here (see the `$effect`s below) - previously
	 * `authSettingsStore.load()`/`systemInfoStore.load()` only ran inside
	 * whichever section happened to own the mount effect
	 * (SecuritySection/ConnectivitySection), which was fine back when every
	 * category rendered on one page but left a direct visit to a
	 * READ-ONLY-consumer route (`/settings/account`'s autologin status,
	 * `/settings/connectivity`'s auth-disabled LAN gate,
	 * `/settings/data`'s `backupPostgresDialect`) with a `null` store
	 * forever. This layout is the one thing every category route shares, so
	 * loading here - with the exact same conditions those sections used -
	 * guarantees the value is fetched regardless of which category is opened
	 * first. Sections keep their own POST-SAVE reloads unchanged (only the
	 * mount-time fetch moved); see `authSettingsStore.svelte.ts` /
	 * `systemInfoStore.svelte.ts`'s doc comments for the corresponding
	 * `error` fields these effects write to.
	 */
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { isAdmin } from '#lib/permissions.js';
	import { isPathActive, resolveAppPath } from '#lib/navigation.js';
	import { errorMessage, tauri } from './shared';
	import { reloadAuthSettings } from './authSettingsStore.svelte';
	import { systemInfoStore } from './systemInfoStore.svelte';
	import type { SettingsCategory } from './categories';
	import type { LayoutProps } from './$types';
	import './settings.css';

	let { data, children }: LayoutProps = $props();

	/**
	 * Mirrors Sidebar.svelte's `isActive` / `navBadges.svelte.ts`'s
	 * `pathOwns`: a category owns its own path and any sub-path.
	 * `base`-prefixed (Copilot review on PR #198): `page.url.pathname`
	 * always includes the app's base path (e.g. the GitHub Pages demo's
	 * `BASE_PATH=/banto`), but `category.path` from `categories.ts` never
	 * does - comparing the bare path against it meant no category was ever
	 * active there.
	 */
	function isActive(category: SettingsCategory): boolean {
		return isPathActive(category.path, page.url.pathname);
	}

	// authSettingsStore's initial load (M11 login-not-required mode) - Tauri
	// only, same condition SecuritySection's own mount effect used.
	$effect(() => {
		if (!tauri) return;
		void reloadAuthSettings();
	});

	// systemInfoStore's initial load (M-review 2026-08 §2.4) - same
	// availability/role gate ConnectivitySection's own mount effect used.
	$effect(() => {
		if (!systemInfoStore.available || !isAdmin(sessionStore.role)) return;
		void (async () => {
			systemInfoStore.error = null;
			try {
				await systemInfoStore.load();
			} catch (err) {
				systemInfoStore.error = errorMessage(err);
			}
		})();
	});
</script>

<div class="page settings-page">
	<!-- The shell already shows the page title. Keep a document heading for
	     assistive technology without repeating the visible title in the content. -->
	<h1 class="sr-only">{m['nav.settings']()}</h1>
	<p class="settings-description">{m['settings.pageDescription']()}</p>

	<div class="settings-layout">
		<nav class="section-nav" aria-label={m['settings.sectionNavAria']()}>
			{#each data.categories as category (category.id)}
				<a
					href={resolveAppPath(category.path)}
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
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	.settings-description {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
		text-wrap: pretty;
	}

	.settings-layout {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		min-width: 0;
	}

	/* ADR-0022: these are page links, not ARIA tabs. Each link keeps its own underline
	   when the strip wraps, so the current category is clear on narrow screens. */
	.section-nav {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-1) var(--banto-space-2);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
	}

	.section-nav a {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--banto-control-height-lg);
		max-width: 100%;
		padding: var(--banto-space-2) var(--banto-space-3);
		border-bottom: var(--banto-border-width-strong) solid transparent;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
		font-weight: 600;
		text-decoration: none;
		overflow-wrap: anywhere;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.section-nav a:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.section-nav a:focus-visible {
		/* A real outline also remains visible in forced-colors mode. */
		outline: var(--banto-border-width-strong) solid currentColor;
		outline-offset: calc(-1 * var(--banto-border-width-strong));
	}

	.section-nav a.active {
		/* Keep the stronger text token for contrast in the light theme. */
		color: var(--banto-primary-hover);
		border-bottom-color: currentColor;
	}

	@media (forced-colors: active) {
		/* Transparent borders become visible in forced colors. Remove inactive
		   underlines and keep their space so the current category stays distinct. */
		.section-nav a:not(.active) {
			border-bottom-style: none;
			padding-bottom: calc(var(--banto-space-2) + var(--banto-border-width-strong));
		}
	}

	.settings-content {
		min-width: 0;
	}
</style>
