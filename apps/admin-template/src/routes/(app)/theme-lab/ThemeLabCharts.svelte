<script lang="ts">
	/**
	 * The chart part of the theme lab preview (Issue #690): the 8 categorical
	 * colours (a pie) and the sequential / diverging scales (two small
	 * heatmaps). Its own file so `pnpm scaffold` can drop it together with
	 * `@banto/charts` without touching the rest of the lab (scripts/scaffold.mjs
	 * `removeCharts`). The chart palette is fixed in banto.css (`--banto-chart-*`):
	 * it does not follow `--banto-brand-hue`, only the light / dark theme.
	 */
	import { DIV_RAMP, Heatmap, PieChart } from '@banto/charts';
	import * as m from '#lib/paraglide/messages.js';

	const categories = Array.from({ length: 8 }, (_, i) => ({
		name: `${i + 1}`,
		count: 12 - i
	}));

	const COLUMNS = ['A', 'B', 'C', 'D', 'E'];
	const ROWS = ['1', '2', '3'];
	const sequential = ROWS.flatMap((row, r) =>
		COLUMNS.map((col, c) => ({ col, row, value: r * 5 + c }))
	);
	// signed around 0: the middle step of the diverging ramp is the neutral midpoint
	const diverging = ROWS.flatMap((row, r) =>
		COLUMNS.map((col, c) => ({ col, row, value: r * 5 + c - 7 }))
	);
</script>

<div class="charts">
	<section>
		<h4>{m['themeLab.charts.categoryTitle']()}</h4>
		<PieChart
			data={categories}
			category={(row) => row.name}
			value={(row) => row.count}
			label={m['themeLab.charts.categoryAria']()}
			height={200}
		/>
	</section>
	<section>
		<h4>{m['themeLab.charts.sequentialTitle']()}</h4>
		<Heatmap
			data={sequential}
			x={(row) => row.col}
			y={(row) => row.row}
			value={(row) => row.value}
			label={m['themeLab.charts.sequentialAria']()}
			height={160}
		/>
	</section>
	<section>
		<h4>{m['themeLab.charts.divergingTitle']()}</h4>
		<Heatmap
			data={diverging}
			x={(row) => row.col}
			y={(row) => row.row}
			value={(row) => row.value}
			ramp={[...DIV_RAMP]}
			label={m['themeLab.charts.divergingAria']()}
			height={160}
		/>
	</section>
</div>

<style>
	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));
		gap: var(--banto-space-4);
	}

	section {
		min-width: 0;
	}

	h4 {
		margin: 0 0 var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}
</style>
