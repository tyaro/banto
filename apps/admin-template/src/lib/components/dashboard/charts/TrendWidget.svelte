<script lang="ts">
	/**
	 * Dashboard widget `trend` (roadmap M13; dashboardWidgets.ts, #716 W1): 1 point/sec streaming
	 * via `rollingAppend` (window capped so the chart never grows unbounded), started/stopped with
	 * this component's own lifecycle - each dock pane/floating window/popped-out Tauri window gets
	 * its own instance and therefore its own interval (see `core/rolling.ts`, `LineChart`'s
	 * streaming doc comment). It makes its own points, so it does not read `data`.
	 */
	import { LineChart, rollingAppend } from '@banto/charts';
	import { onDestroy, onMount } from 'svelte';
	import { nextTrendPoint, seedTrendPoints, type TrendPoint } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import ChartFit from './ChartFit.svelte';

	let { height }: DashboardWidgetProps = $props();

	const TREND_WINDOW = 120;
	const TREND_INTERVAL_MS = 1000;
	let trendData: TrendPoint[] = $state(seedTrendPoints(40));
	let trendTimer: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		trendTimer = setInterval(() => {
			const next = nextTrendPoint(trendData[trendData.length - 1]);
			trendData = rollingAppend(trendData, [next], TREND_WINDOW);
		}, TREND_INTERVAL_MS);
	});

	onDestroy(() => clearInterval(trendTimer));

	const trendBands = [
		{ from: 66, to: 70, label: m['dashboard.trendBandControl'](), colorVar: 'var(--banto-success)' }
	];
	const trendMarkers = [
		{ at: 10, label: m['dashboard.trendMarkerInspect'](), colorVar: 'var(--banto-warning)' }
	];
</script>

<ChartFit {height}>
	{#snippet children(chartHeight)}
		<LineChart
			data={trendData}
			x={(row) => row.t}
			series={[
				{ id: 'temperature', label: m['dashboard.trendTemp'](), y: (row) => row.temperature },
				{
					id: 'pressure',
					label: m['dashboard.trendPressure'](),
					y: (row) => row.pressure,
					axis: 'right'
				}
			]}
			label={m['dashboard.trendAria']()}
			height={chartHeight}
			zoomable
			bands={trendBands}
			markers={trendMarkers}
			formatX={(v) => `#${v}`}
			formatY={(n) => `${n.toFixed(1)}℃`}
			formatYRight={(n) => `${n.toFixed(2)}MPa`}
		/>
	{/snippet}
</ChartFit>
