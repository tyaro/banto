/**
 * Public entry point for @banto/charts (spec §6, §6.1).
 * v1 scope: LineChart (line/area), BarChart (vertical/horizontal, stacked),
 * PieChart (pie/donut), ScatterChart, Sparkline.
 * v2 scope (§6.1): ComboChart (bar + line, shared axis), RadarChart,
 * Heatmap, Gauge. No Canvas renderer, no export, no animation beyond simple
 * CSS hover transitions (spec limit).
 */
export { default as LineChart } from './LineChart.svelte';
export { default as BarChart } from './BarChart.svelte';
export { default as PieChart } from './PieChart.svelte';
export { default as ScatterChart } from './ScatterChart.svelte';
export { default as Sparkline } from './Sparkline.svelte';
export { default as ComboChart } from './ComboChart.svelte';
export { default as RadarChart } from './RadarChart.svelte';
export { default as Heatmap } from './Heatmap.svelte';
export { default as Gauge } from './Gauge.svelte';

export type { Accessor, ChartMargin, SeriesBase, TooltipRow } from './types';
export { getValue, toNumber } from './types';

export { linearScale, niceTicks, bandScale, type LinearScale, type BandScale } from './core/scale';
export { stackSeries, type StackSegment } from './core/stack';
export { pieSlices, arcPath, polarToCartesian, type PieSlice } from './core/pie';
export { linePath, areaPath, roundedTopBarPath, type Point } from './core/path';
export { everyNthIndex } from './core/ticks-time';
export { seriesColorVar, MAX_CHART_SERIES, sequentialColor, SEQ_RAMP } from './core/color';
export {
	estimateLabelWidth,
	leftMarginFor,
	rightMarginForLastTick,
	type AxisMarginOptions
} from './core/labels';
export { radarPoints, ringPolygon, spokeAngle, spokeLabelAnchor, type LabelAnchor } from './core/radar';
export { heatmapGrid, heatmapCellKey, type HeatmapGrid } from './core/heatmap';
export {
	gaugeAngle,
	gaugeRatio,
	gaugeColorVar,
	GAUGE_START_DEG,
	GAUGE_SWEEP_DEG,
	GAUGE_END_DEG,
	type GaugeThresholds
} from './core/gauge';
