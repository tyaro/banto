<script lang="ts">
	/**
	 * Dashboard widget `memo` (dashboardWidgets.ts, #716 W1). The draft and its save belong to the
	 * PAGE (the pane is re-created by every dock structure change, shared-primitives-upstream-plan
	 * §3.5・D9), so this widget only draws what the page provides (`provideDashboardMemoPane`).
	 * Where nothing is provided - the popped-out window (`routes/panel/[id]`), another document
	 * that cannot reach the page's draft - it shows the static note, as before W1. It reads neither
	 * `data` nor `height`.
	 */
	import * as m from '#lib/paraglide/messages.js';
	import { dashboardMemoPane } from '#lib/banto/dashboardMemo.svelte.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import DashboardMemoField from '#lib/components/DashboardMemoField.svelte';

	// Every widget takes the same props (the registry's component type); the memo reads none.
	const _props: DashboardWidgetProps = $props();

	const pane = dashboardMemoPane();
</script>

{#if pane}
	<DashboardMemoField
		draft={pane.draft}
		save={pane.save}
		saveTitle={pane.saveTitle}
		status={pane.status}
	/>
{:else}
	<p class="memo">{m['dashboard.panelMemoBody']()}</p>
{/if}

<style>
	/* Caption-style memo text (dashboard page's .card-caption, spec §10). */
	.memo {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
		line-height: 1.6;
	}
</style>
