<script lang="ts">
	/**
	 * Standalone panel window (spec §5.3 v2 pop-out). Deliberately OUTSIDE the
	 * `(app)` route group: it gets none of that group's shell (no
	 * Sidebar/Header, `routes/(app)/+layout.svelte`) AND none of its auth
	 * GUARD (`routes/(app)/+layout.ts`'s `redirect(307, '/login')`) - a
	 * popped-out panel is a chrome-less native window whose ONLY content is
	 * this one panel, and it must never redirect: the main window (and ONLY
	 * the main window) owns the login flow, so an unauthenticated visit here
	 * just shows a message instead.
	 *
	 * Works in two contexts with identical code:
	 *  - as this route rendered in a plain browser tab (Playwright-verifiable
	 *    in this dev environment, which has no webkit2gtk to run the real
	 *    Tauri multiwindow path);
	 *  - as the actual content of the native `WebviewWindow` the
	 *    `banto-tauri-panel` plugin opens (its default route `panel/{id}`,
	 *    ADR-0037) - not verifiable here, verify on a machine with webkit2gtk.
	 */
	import { page } from '$app/state';
	import { getSessionController, resolveSettled } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { bantoReady } from '#lib/banto/setup.js';
	import { createDashboardData } from '#lib/banto/dashboardData.svelte.js';
	import { findDashboardWidget } from '#lib/banto/dashboardWidgets.js';
	import PanelIcon from '#lib/components/PanelIcon.svelte';
	import DashboardWidgetFrame from '#lib/components/dashboard/DashboardWidgetFrame.svelte';

	const id = $derived(page.params.id ?? '');
	const def = $derived(findDashboardWidget(id));

	// 'unverified' (Issue #204): the server could not check the session (a
	// 500 / unreachable). Not the same as logged out - say so, and keep the
	// stored token for the next attempt (reopening the panel retries).
	// Issue #260 (v2.0.0): confirmed through this window's SessionController
	// (`resolveSettled` never rejects) - the provider has no `check()` any
	// more.
	let authState: 'checking' | 'ok' | 'unauthenticated' | 'unverified' = $state('checking');

	$effect(() => {
		void (async () => {
			await bantoReady; // provider selection (spec §11.1's three-way probe) must finish first
			const result = await resolveSettled(getSessionController());
			if (result.outcome === 'unverified') authState = 'unverified';
			else authState = result.snapshot.status === 'active' ? 'ok' : 'unauthenticated';
		})();
	});

	// This window is its own document (its own JS heap, no cache shared with the main window), so
	// it reads its own copy of the data - once, and only once the session is confirmed. The
	// widget gets it as a prop, like on the dashboard page (dashboardData.svelte.ts, #716 W1).
	const data = createDashboardData();
	$effect(() => {
		if (authState !== 'ok') return;
		void data.load();
	});
	$effect(() => () => data.dispose());

	// The route's own viewport is the widget's height budget (no dashboard chrome around it
	// here): `DashboardWidgetFrame` measures the body's content box, as in a pane of the dock.
</script>

<svelte:head>
	<title>{def?.title ?? id} - Banto</title>
</svelte:head>

{#if authState === 'checking'}
	<p class="status">{m['dashboard.panelChecking']()}</p>
{:else if authState === 'unauthenticated'}
	<p class="status">{m['dashboard.panelLoginRequired']()}</p>
{:else if authState === 'unverified'}
	<p class="status">{m['app.sessionCheckFailed.title']()}</p>
{:else}
	<div class="panel-window">
		<header class="panel-header">
			{#if def?.icon}<span class="icon" aria-hidden="true"><PanelIcon icon={def.icon} /></span>{/if}
			<span class="title">{def?.title ?? id}</span>
		</header>
		<div class="panel-body">
			{#if data.loading && data.rows.length === 0}
				<p class="panel-status">{m['common.loading']()}</p>
			{:else if def}
				<DashboardWidgetFrame widget={def} {data} />
			{:else}
				<p class="panel-status">{m['dashboard.unknownPanel']()}</p>
			{/if}
		</div>
	</div>
{/if}

<style>
	.status {
		min-height: 100vh;
		display: grid;
		place-items: center;
		margin: 0;
		padding: var(--banto-space-4);
		text-align: center;
		color: var(--banto-text-muted);
	}

	/* Caption-style status text (dashboard page's .card-caption, spec §10). */
	.panel-status {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}

	.panel-window {
		height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.panel-header {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		height: var(--banto-dock-titlebar-height, 2rem);
		padding: 0 var(--banto-space-3);
		background: var(--banto-surface-raised);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		font-size: var(--banto-font-size-md);
		font-weight: 600;
		color: var(--banto-text);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		box-sizing: border-box;
		padding: var(--banto-space-3);
		background: var(--banto-surface);
	}
</style>
