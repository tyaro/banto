<script lang="ts">
	/**
	 * Draws one registered widget into the box it is put in (#716 W2): measures that box and hands
	 * the widget its `height` (`DashboardWidgetProps`), together with the page's data.
	 *
	 * Used by every place a widget is shown - a pane of the dashboard's dock, a card of the
	 * one-column display (`DashboardWidgetStack.svelte`), the popped-out window
	 * (`routes/panel/[id]`) - so the height means the same everywhere: the CONTENT box, with the
	 * caller's padding already outside it. Before W2 the dock measured the pane's padding box and
	 * took 16px off, which left the widget 8px taller than the room it had.
	 *
	 * The caller's box needs a height (a pane, a fixed-height card body); this fills it.
	 */
	import type { DashboardData } from '#lib/banto/dashboardData.svelte.js';
	import type { DashboardWidgetDef } from '#lib/banto/dashboardWidgets.js';

	interface Props {
		widget: DashboardWidgetDef;
		data: DashboardData;
	}

	let { widget, data }: Props = $props();

	/** Until the box is measured (the first frame). */
	const UNMEASURED_HEIGHT = 240;
	/** A widget is not told to be smaller than this; a smaller box cuts it off. */
	const MIN_HEIGHT = 120;

	let measured = $state(0);
	const height = $derived(measured > 0 ? Math.max(MIN_HEIGHT, measured) : UNMEASURED_HEIGHT);
</script>

<div class="widget-frame" bind:clientHeight={measured}>
	<widget.component {data} {height} />
</div>

<style>
	.widget-frame {
		height: 100%;
		min-height: 0;
	}
</style>
