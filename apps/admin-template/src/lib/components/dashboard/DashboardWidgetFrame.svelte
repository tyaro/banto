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
	import type { DashboardPageData } from '#lib/banto/dashboardData.svelte.js';
	import type { DashboardDrill } from '#lib/banto/dashboardDrill.js';
	import {
		dashboardDataFor,
		type DashboardSelect,
		type DashboardWidgetDef
	} from '#lib/banto/dashboardWidgets.js';

	interface Props {
		widget: DashboardWidgetDef;
		data: DashboardPageData;
		/** Handed to the widget as it is. Omitted in the popped-out window: no drill-down there (#882 D3). */
		onDrill?: (drill: DashboardDrill) => void;
		/**
		 * The page's selection and its toggle (#882 C2). A widget registered with `selects` gets its
		 * own dimension's part (`selected` / `onSelect`); the others get nothing. Omitted in the
		 * popped-out window: no selecting there.
		 */
		select?: DashboardSelect;
	}

	let { widget, data, onDrill, select }: Props = $props();

	const dimension = $derived(widget.selects);
	const onSelect = $derived(
		select && dimension ? (value: string) => select.toggle(dimension, value) : undefined
	);
	const selected = $derived(select && dimension ? select.selection[dimension] : undefined);

	/**
	 * #716 W3: the rows narrowed by the page's shared period only for a widget registered with
	 * `usesPeriod`; every other widget gets the read as it is, so a change of the period does not
	 * reach it. #882: a `usesSelection` widget's rows are narrowed by the selection too.
	 */
	const widgetData = $derived(dashboardDataFor(widget, data));

	/** Until the box is measured (the first frame). */
	const UNMEASURED_HEIGHT = 240;
	/** A widget is not told to be smaller than this; a smaller box cuts it off. */
	const MIN_HEIGHT = 120;

	let measured = $state(0);
	const height = $derived(measured > 0 ? Math.max(MIN_HEIGHT, measured) : UNMEASURED_HEIGHT);
</script>

<div class="widget-frame" bind:clientHeight={measured}>
	<widget.component data={widgetData} {height} {onDrill} {onSelect} {selected} />
</div>

<style>
	.widget-frame {
		height: 100%;
		min-height: 0;
	}
</style>
