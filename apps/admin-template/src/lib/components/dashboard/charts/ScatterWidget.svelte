<script lang="ts">
	/** Dashboard widget `scatter`: price against stock per item, the first 500 (dashboardWidgets.ts, #716 W1). */
	import { ScatterChart } from '@banto/charts';
	import { scatterSample } from '#lib/banto/dashboard.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCount } from '#lib/banto/i18n.js';
	import type { DashboardWidgetProps } from '#lib/banto/dashboardWidgets.js';
	import ChartFit from './ChartFit.svelte';

	let { data, height }: DashboardWidgetProps = $props();

	const scatterRows = $derived(scatterSample(data.rows));
	const yen = (n: number) => `¥${formatCount(n)}`;
	const countLabel = (n: number) => m['dashboard.countUnit']({ count: formatCount(n) });
</script>

<ChartFit {height}>
	{#snippet children(chartHeight)}
		<ScatterChart
			data={scatterRows}
			x={(row) => row.price}
			y={(row) => row.stock}
			pointLabel={(row) => row.name}
			label={m['dashboard.scatterAria']()}
			height={chartHeight}
			formatX={(v) => yen(Number(v))}
			formatY={(v) => countLabel(Number(v))}
		/>
	{/snippet}
</ChartFit>
