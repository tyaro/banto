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
// M13 new chart types (roadmap.md M13, SPC/QC): histogram, Pareto, box plot.
export { default as Histogram } from './Histogram.svelte';
export { default as ParetoChart } from './ParetoChart.svelte';
export { default as BoxPlot } from './BoxPlot.svelte';

export type {
	Accessor,
	ChartMargin,
	SeriesBase,
	TooltipRow,
	ChartAxis,
	ThresholdBand,
	EventMarker
} from './types';
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

// M13 headless core additions (roadmap.md M13): zoom/pan viewport state for
// trend charts, histogram binning + normal-curve overlay, Pareto data,
// box-plot statistics, and rolling-window helpers for streaming updates.
export {
	fullViewport,
	zoomViewport,
	panViewport,
	isFullViewport,
	visibleRange,
	type Viewport
} from './core/viewport';
export { decimationStride, decimatedIndices } from './core/decimate';
export { histogramBins, normalCurvePoints, type Bin } from './core/bins';
export { paretoData, type ParetoItem, type ParetoDatum } from './core/pareto';
export { boxStats, quantileSorted, type BoxStats } from './core/boxplot';
export { rollingAppend, evictBefore } from './core/rolling';
export { serializeChartSvg, downloadSvg, inlineCssVarRefs } from './core/export';
