<script lang="ts">
	/**
	 * The dashboard's KPI strip (downstream-requests-2026-11-plan §4.13.3, #716 W1): draws
	 * `DASHBOARD_KPIS` in the array's order. Fixed - no reorder, no hide, nothing saved.
	 *
	 * The markup and the CSS are the page's former `.stat-row`, moved as they were. The kiosk's large
	 * numbers stay keyed on the shell's `.kiosk` class (`:global(.shell.kiosk)`), with the 600px
	 * adjustment (§4.13.6: the kiosk baselines watch them).
	 */
	// [scaffold:charts] begin
	import { Sparkline } from '@banto/charts';
	// [scaffold:charts] end
	import { ChevronRight } from '@lucide/svelte';
	import { DASHBOARD_ROW_LIMIT, type DashboardPageData } from '#lib/banto/dashboardData.svelte.js';
	import { drillHref } from '#lib/banto/dashboardDrill.js';
	import { DASHBOARD_KPIS, type DashboardKpiDef } from '#lib/banto/dashboardKpis.js';
	import {
		DEFAULT_DASHBOARD_PERIOD,
		hasSelection,
		latestDay,
		type DashboardFilter
	} from '#lib/banto/dashboardPeriod.js';
	import * as m from '#lib/paraglide/messages.js';

	/**
	 * `filter` is the page's period: a tile that opens the list carries it (#882 D3). The selection
	 * (#882 C2) narrows the numbers here but is NOT carried by the link (the list's view takes the
	 * period only), so the tile says so in words that are SEEN while something is chosen (not in the
	 * tooltip alone: a keyboard or touch user does not get a tooltip. #963 review).
	 */
	let { data, filter }: { data: DashboardPageData; filter: DashboardFilter } = $props();
	const anchorDay = $derived(latestDay(data.all.rows));
	// A period is chosen but there is no row to count it from yet (the first read): the link would
	// open the list for every period, so it waits.
	const waiting = $derived(filter.period !== DEFAULT_DASHBOARD_PERIOD && anchorDay === null);
	const selectionNote = $derived(
		hasSelection(filter.selection) ? m['dashboard.selectionNotCarried']() : ''
	);
	const truncatedNote = $derived(
		data.truncated
			? m['dashboard.truncatedNote']({ limit: DASHBOARD_ROW_LIMIT.toLocaleString() })
			: ''
	);
</script>

{#snippet tile(kpi: DashboardKpiDef, note: string = '')}
	<span class="stat-icon" aria-hidden="true"><kpi.icon size={18} /></span>
	<div class="stat-body">
		<span class="stat-label">{kpi.label}</span>
		{#if kpi.sparkline}
			<div class="stat-value-row">
				<span class="stat-value">{kpi.value(data)}</span>
				<!-- [scaffold:charts] begin -->
				<Sparkline values={kpi.sparkline(data)} width={72} height={24} />
				<!-- [scaffold:charts] end -->
			</div>
		{:else}
			<span class="stat-value">{kpi.value(data)}</span>
		{/if}
		{#if note}
			<span class="stat-note" data-stat-note>{note}</span>
		{/if}
	</div>
{/snippet}

<div class="stat-row">
	{#each DASHBOARD_KPIS as kpi (kpi.id)}
		{#if kpi.link}
			<a
				class="stat-tile stat-link"
				href={waiting ? undefined : drillHref(kpi.link.drill, filter, anchorDay)}
				aria-disabled={waiting ? 'true' : undefined}
				title={[kpi.link.title, truncatedNote].filter(Boolean).join('\n')}
			>
				{@render tile(kpi, selectionNote)}
				<ChevronRight class="stat-link-icon" size={16} aria-hidden="true" />
			</a>
		{:else}
			<section class="stat-tile">
				{@render tile(kpi)}
			</section>
		{/if}
	{/each}
</div>

<style>
	/* KPI tiles (design.md §10): icon + label + tabular-nums value. Tile-only
	   card (not SurfaceCard, spec §K3): same face/border/radius/shadow tokens
	   without SurfaceCard's optional title/description header. */
	.stat-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: var(--banto-space-4);
	}

	/* Card tiers (#623): KPI row = subtle (flat), the main chart = primary,
	   the other charts = default. Tokens in banto.css (--banto-card-*). */
	.stat-tile {
		background: var(--banto-card-subtle-bg);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-card-subtle-shadow);
		padding: var(--banto-space-4) var(--banto-space-5);
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
	}

	/* #555 (4): a tile that opens a list view (the 在庫僅少 tile). */
	.stat-link {
		color: inherit;
		text-decoration: none;
		transition: border-color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.stat-link:hover {
		border-color: var(--banto-primary);
	}

	.stat-link:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.stat-link :global(.stat-link-icon) {
		margin-left: auto;
		flex: none;
		color: var(--banto-text-muted);
	}

	.stat-icon {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--banto-radius-md);
		background: color-mix(in srgb, var(--banto-primary) 12%, transparent);
		color: var(--banto-primary);
	}

	.stat-body {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		min-width: 0;
	}

	.stat-label {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	/* While marks are chosen: what the tile's link opens differs from the number (#882 C2). */
	.stat-note {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-xs);
		text-wrap: pretty;
	}

	.stat-value {
		font-size: var(--banto-font-size-2xl);
		font-weight: 650;
		color: var(--banto-text);
		font-variant-numeric: tabular-nums;
	}

	/* Kiosk (#624 PR-2): KPIs readable from across the room. Keyed on the
	   shell's .kiosk class (settings.kiosk), not on density. The number never
	   wraps; its size shrinks with the width of the text column (.stat-body is
	   an inline-size container), not the viewport. 15cqi fits ~9 bold
	   tabular digits (about 5.8em). The sparkline drops below the number so it
	   does not eat that width. */
	:global(.shell.kiosk) .stat-row {
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
	}

	:global(.shell.kiosk) .stat-icon {
		width: 56px;
		height: 56px;
	}

	:global(.shell.kiosk) .stat-label {
		font-size: var(--banto-font-size-lg);
	}

	:global(.shell.kiosk) .stat-body {
		flex: 1 1 0;
		container-type: inline-size;
	}

	:global(.shell.kiosk) .stat-value {
		font-size: min(var(--banto-font-size-3xl), 15cqi);
		line-height: 1.1;
		white-space: nowrap;
	}

	:global(.shell.kiosk) .stat-value-row {
		flex-direction: column;
		align-items: flex-start;
		gap: var(--banto-space-1);
	}

	@media (max-width: 600px) {
		:global(.shell.kiosk) .stat-icon {
			width: 36px;
			height: 36px;
		}
	}

	.stat-value-row {
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
	}
</style>
