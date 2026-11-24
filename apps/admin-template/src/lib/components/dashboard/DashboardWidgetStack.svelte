<script lang="ts">
	/**
	 * The dashboard's widgets stacked in ONE column, in the order they are registered
	 * (downstream-requests-2026-11-plan §4.13.3・§4.13.7 a, #716 W2).
	 *
	 * Not an arrangement: nothing here can be moved, resized, hidden or saved. The page uses it
	 *  - where the page is too narrow for the dock (`DockHost` has no narrow display: it only
	 *    shrinks its split tree) - then `widgets` is what the saved arrangement shows, and that
	 *    arrangement is only read, never written;
	 *  - in a copy scaffolded without the dock (`scripts/scaffold.mjs`, `removeDock`) - then it is
	 *    the only display, with every registered widget.
	 *
	 * Each card is as high as the widget's floating window would be (`def.height`), so a widget is
	 * given the same room as in a pane.
	 */
	import type { DashboardPageData } from '#lib/banto/dashboardData.svelte.js';
	import type { DashboardWidgetDef } from '#lib/banto/dashboardWidgets.js';
	import DashboardWidgetFrame from './DashboardWidgetFrame.svelte';

	interface Props {
		/** The widgets to show, in the order to stack them. */
		widgets: readonly DashboardWidgetDef[];
		data: DashboardPageData;
	}

	let { widgets, data }: Props = $props();

	/** `def.height` is a floating window's height, title bar included; the card has its own heading. */
	const WINDOW_TITLEBAR = 40;
	const DEFAULT_WINDOW_HEIGHT = 320;
	const bodyHeight = (def: DashboardWidgetDef) =>
		(def.height ?? DEFAULT_WINDOW_HEIGHT) - WINDOW_TITLEBAR;
</script>

<div class="widget-stack" data-dashboard-stack>
	{#each widgets as widget (widget.id)}
		<section class="card" aria-labelledby="dashboard-stack-{widget.id}">
			<h2 id="dashboard-stack-{widget.id}">{widget.title}</h2>
			<div class="card-body" style:height="{bodyHeight(widget)}px">
				<DashboardWidgetFrame {widget} {data} />
			</div>
		</section>
	{/each}
</div>

<style>
	.widget-stack {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	/* The same card face the dashboard's fixed cards had (design.md §10). */
	.card {
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-card-default-shadow);
		padding: var(--banto-space-4) var(--banto-space-5);
		min-width: 0;
	}

	h2 {
		margin: 0 0 var(--banto-space-2);
		font-size: var(--banto-font-size-base);
		font-feature-settings: 'palt';
	}

	.card-body {
		min-width: 0;
	}
</style>
