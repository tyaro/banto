<script lang="ts">
	/**
	 * Chart gallery: the chart types that are not on the dashboard (combo,
	 * heatmap, gauge, radar, stacked area, Gantt), drawn from the same `items`
	 * data. A catalog page like `/ui-demo`: the sidebar entry exists only in the
	 * demo build (`demoOnly` in navigation.ts), the route itself is reachable by
	 * URL in every build. Same "load once, whole dataset" pattern as the
	 * dashboard, since the aggregations need the full set.
	 */
	import {
		ComboChart,
		GanttChart,
		Gauge,
		Heatmap,
		RadarChart,
		StackedAreaChart
	} from '@banto/charts';
	import { createListResource } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import {
		categoryCountsTop,
		categoryTrendByMonth,
		computeStatTiles,
		inventorySchedule,
		monthlyWithMovingAvg,
		type MonthCategoryCount,
		weekdayMonthHeat
	} from '#lib/banto/dashboard.js';
	import { PageHeader, LoadingState } from '@banto/ui';

	const STOCK_TARGET = 3_000_000;

	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const stats = $derived(computeStatTiles(list.rows));
	const monthlyAvg = $derived(monthlyWithMovingAvg(list.rows));
	const weekdayHeat = $derived(weekdayMonthHeat(list.rows));
	const topCategories = $derived(categoryCountsTop(list.rows, 5));
	const categoryTrend = $derived(categoryTrendByMonth(list.rows));
	const schedule = $derived(inventorySchedule(list.rows));

	const yen = (n: number) => `¥${n.toLocaleString()}`;
	// UTC getters (not toLocaleDateString): the schedule's dates are UTC
	// midnight `YYYY-MM-DD` instants (see dashboard.ts inventorySchedule), and
	// a locale-dependent format would make the visual regression snapshot
	// unstable across environments.
	const formatGanttDate = (ms: number) => {
		const d = new Date(ms);
		return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
	};
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.chartGallery']()} description={m['chartGallery.intro']()} />

	{#if list.loading && list.rows.length === 0}
		<LoadingState label={m['items.loadingData']()} />
	{:else}
		<h2 class="section-heading">{m['chartGallery.mixedHeading']()}</h2>
		<div class="chart-grid">
			<section class="card primary">
				<h2>{m['chartGallery.comboTitle']()}</h2>
				<p class="card-caption">{m['chartGallery.comboCaption']()}</p>
				<ComboChart
					data={monthlyAvg}
					x={(row) => row.month}
					bars={[
						{ id: 'count', label: m['chartGallery.seriesUpdates'](), value: (row) => row.count }
					]}
					lines={[{ id: 'avg3', label: m['chartGallery.series3mAvg'](), y: (row) => row.avg3 }]}
					label={m['chartGallery.comboAria']()}
					height={280}
					formatY={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['chartGallery.heatmapTitle']()}</h2>
				<p class="card-caption">{m['chartGallery.heatmapCaption']()}</p>
				<Heatmap
					data={weekdayHeat}
					x={(row) => row.month}
					y={(row) => row.weekday}
					value={(row) => row.count}
					label={m['chartGallery.heatmapAria']()}
					height={300}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['chartGallery.gaugeTitle']()}</h2>
				<p class="card-caption">{m['chartGallery.gaugeCaption']({ target: yen(STOCK_TARGET) })}</p>
				<Gauge
					value={stats.stockTotal}
					max={STOCK_TARGET}
					label={m['chartGallery.gaugeAria']()}
					height={220}
					formatValue={(n) => `${Math.round((n / STOCK_TARGET) * 100)}%`}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['chartGallery.radarTitle']()}</h2>
				<p class="card-caption">{m['chartGallery.radarCaption']()}</p>
				<RadarChart
					data={topCategories}
					axis={(row) => row.category}
					series={[
						{
							id: 'count',
							label: m['chartGallery.seriesProductCount'](),
							value: (row) => row.count
						}
					]}
					label={m['chartGallery.radarAria']()}
					height={280}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>
		</div>

		<h2 class="section-heading">{m['chartGallery.trendHeading']()}</h2>
		<div class="chart-grid">
			<section class="card">
				<h2>{m['chartGallery.categoryTrendTitle']()}</h2>
				<p class="card-caption">{m['chartGallery.categoryTrendCaption']()}</p>
				<StackedAreaChart
					data={categoryTrend.rows}
					x={(row) => row.month}
					series={categoryTrend.categories.map((c) => ({
						id: c,
						label: c,
						y: (row: MonthCategoryCount) => row.values[c] ?? 0
					}))}
					label={m['chartGallery.categoryTrendAria']()}
					height={280}
					formatY={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card">
				<h2>{m['chartGallery.scheduleTitle']()}</h2>
				<p class="card-caption">{m['chartGallery.scheduleCaption']()}</p>
				<GanttChart
					tasks={schedule.tasks}
					label={m['chartGallery.scheduleAria']()}
					today={schedule.today}
					formatDate={formatGanttDate}
				/>
			</section>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.section-heading {
		margin: var(--banto-space-1) 0 0;
		font-size: var(--banto-font-size-base);
		color: var(--banto-text-muted);
	}

	/* Same asymmetric 12-column grid as the dashboard: primary 8/12, secondary
	   4/12, a single column under 900px. */
	.chart-grid {
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		gap: var(--banto-space-4);
	}

	.card {
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: var(--banto-space-4) var(--banto-space-5);
		min-width: 0;
		grid-column: span 12;
	}

	@media (min-width: 901px) {
		.card.primary {
			grid-column: span 8;
		}

		.card.secondary {
			grid-column: span 4;
		}
	}

	h2 {
		margin: 0 0 var(--banto-space-1);
		font-size: var(--banto-font-size-base);
		font-feature-settings: 'palt';
	}

	.card-caption {
		margin: 0 0 var(--banto-space-2);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}
</style>
