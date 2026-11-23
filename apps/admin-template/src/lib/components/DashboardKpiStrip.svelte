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
	import type { DashboardData } from '#lib/banto/dashboardData.svelte.js';
	import { DASHBOARD_KPIS, type DashboardKpiDef } from '#lib/banto/dashboardKpis.js';

	let { data }: { data: DashboardData } = $props();
</script>

{#snippet tile(kpi: DashboardKpiDef)}
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
	</div>
{/snippet}

<div class="stat-row">
	{#each DASHBOARD_KPIS as kpi (kpi.id)}
		{#if kpi.link}
			<a class="stat-tile stat-link" href={kpi.link.href} title={kpi.link.title}>
				{@render tile(kpi)}
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
