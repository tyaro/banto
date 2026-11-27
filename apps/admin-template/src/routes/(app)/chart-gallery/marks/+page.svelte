<script lang="ts">
	/**
	 * Selectable chart marks (`onMarkActivate` / `markLabel` of `BarChart` and
	 * `PieChart`; docs/design/crossfilter-drilldown-design.md §4.3). A small
	 * catalog page under `/chart-gallery`, reached by URL only (no sidebar entry),
	 * with fixed data so the behaviour is the same in every build. It lives in the
	 * chart-gallery directory on purpose: `removeCharts` deletes that directory,
	 * so the preset scaffold never leaves a `@banto/charts` reference behind.
	 */
	import { BarChart, PieChart, type ChartMark } from '@banto/charts';
	import { PageHeader } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCount } from '#lib/banto/i18n.js';

	interface StockRow {
		category: string;
		stock: number;
	}

	const rows: StockRow[] = [
		{ category: 'A', stock: 120 },
		{ category: 'B', stock: 80 },
		{ category: 'C', stock: 45 },
		{ category: 'D', stock: 15 }
	];

	let selected: ChartMark<StockRow> | null = $state(null);

	const select = (mark: ChartMark<StockRow>) => (selected = mark);
	const markLabel = (mark: ChartMark<StockRow>) =>
		m['chartGallery.marksOpen']({ category: mark.category, value: formatCount(mark.value) });
</script>

<div class="page">
	<PageHeader
		hideTitle
		title={m['chartGallery.marksTitle']()}
		description={m['chartGallery.marksIntro']()}
	/>

	<div class="chart-grid">
		<section class="card">
			<h2>{m['chartGallery.marksBarTitle']()}</h2>
			<BarChart
				data={rows}
				category="category"
				series={[{ id: 'stock', label: m['chartGallery.marksBarTitle'](), value: 'stock' }]}
				label={m['chartGallery.marksBarAria']()}
				onMarkActivate={select}
				{markLabel}
			/>
		</section>
		<section class="card">
			<h2>{m['chartGallery.marksPieTitle']()}</h2>
			<PieChart
				data={rows}
				category="category"
				value="stock"
				donut
				label={m['chartGallery.marksPieAria']()}
				onMarkActivate={select}
				{markLabel}
			/>
		</section>
	</div>

	<p class="selected" data-testid="chart-marks-selected" role="status">
		{#if selected}
			{m['chartGallery.marksSelected']({
				category: selected.category,
				value: formatCount(selected.value)
			})}
		{:else}
			{m['chartGallery.marksNone']()}
		{/if}
	</p>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.chart-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: var(--banto-space-4);
	}

	.card {
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: var(--banto-space-4) var(--banto-space-5);
		min-width: 0;
	}

	h2 {
		margin: 0 0 var(--banto-space-1);
		font-size: var(--banto-font-size-base);
		font-feature-settings: 'palt';
	}

	.selected {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}
</style>
