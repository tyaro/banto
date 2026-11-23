<script lang="ts">
	/**
	 * Fits a `@banto/charts` chart into the height a widget was given (#716 W2).
	 *
	 * A chart's `height` is the height of its SVG; the legend is drawn BELOW the SVG, outside it
	 * (one row is about 20px, more when it wraps in a narrow pane). Handing the widget's `height`
	 * straight to the chart made every chart with a legend that much taller than its pane, and the
	 * bottom was cut off. This measures what the chart draws besides the SVG (own height - the
	 * height handed to the chart) and hands the chart what is left.
	 *
	 * It settles in one step: what is outside the SVG does not depend on the SVG's height. It is
	 * measured again when the box changes (a legend that wraps after the pane got narrower).
	 */
	import { untrack, type Snippet } from 'svelte';

	interface Props {
		/** The widget's `height` (`DashboardWidgetProps`): what the chart AND its legend may take. */
		height: number;
		/** Draws the chart with the height to give it. */
		children: Snippet<[number]>;
	}

	let { height, children }: Props = $props();

	/** A chart is not drawn smaller than this (a pane smaller than that cuts it off). */
	const MIN_CHART_HEIGHT = 96;

	let own = $state(0);
	/** What the chart draws outside its SVG (the legend), in px. */
	let extra = $state(0);
	const chartHeight = $derived(Math.max(MIN_CHART_HEIGHT, Math.floor(height - extra)));

	$effect(() => {
		// Runs when the box was measured again; `chartHeight` is what that box was drawn with.
		if (own <= 0) return;
		const measured = Math.max(0, own - untrack(() => chartHeight));
		if (measured === untrack(() => extra)) return;
		// In the next frame: the measurement arrives from a ResizeObserver, and resizing the box it
		// watches within the same delivery is reported as a "ResizeObserver loop" error.
		const frame = requestAnimationFrame(() => {
			extra = measured;
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

<div class="chart-fit" bind:clientHeight={own}>
	{@render children(chartHeight)}
</div>

<style>
	/* Its own height is what is measured: never stretched by the pane. */
	.chart-fit {
		display: flow-root;
	}
</style>
