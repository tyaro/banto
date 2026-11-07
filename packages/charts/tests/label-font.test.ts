/**
 * D9-b (theme-dimension-tokens.md): the label CSS uses the rem type tokens,
 * and the margin estimates read the rendered label's computed font size.
 * The real-browser counterpart (root 20px / token override on the demo
 * dashboard) is e2e/visual/chart-label-font.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	estimateLabelWidth,
	leftMarginFor,
	leftMarginForTicks,
	rightMarginForLastTick
} from '../src/core/labels';
import { DEFAULT_LABEL_FONT_SIZE, readFontSizePx, trackFontSize } from '../src/internal/label-font';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import BarChartSrc from '../src/BarChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import BoxPlotSrc from '../src/BoxPlot.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import ComboChartSrc from '../src/ComboChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import GanttChartSrc from '../src/GanttChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import HeatmapSrc from '../src/Heatmap.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import HistogramSrc from '../src/Histogram.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import LineChartSrc from '../src/LineChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import ParetoChartSrc from '../src/ParetoChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import ScatterChartSrc from '../src/ScatterChart.svelte?raw';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import StackedAreaChartSrc from '../src/StackedAreaChart.svelte?raw';

const el = {} as Element;
const style = (fontSize: string) => () => ({ fontSize });

/**
 * Minimal stand-in for the browser's cascade: `--banto-font-size-sm` (rem)
 * resolved against the root font size, as `getComputedStyle` would.
 */
function resolveSm(rootPx: number, smRem = 0.8): string {
	return `${smRem * rootPx}px`;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('readFontSizePx', () => {
	it('returns the computed size in px', () => {
		expect(readFontSizePx(el, 11, style('16px'))).toBe(16);
		expect(readFontSizePx(el, 11, style('11.2px'))).toBeCloseTo(11.2);
	});

	it('falls back to 11px where nothing can be read (SSR, node tests)', () => {
		expect(DEFAULT_LABEL_FONT_SIZE).toBe(11);
		expect(readFontSizePx(null)).toBe(11);
		expect(readFontSizePx(el, undefined, undefined)).toBe(11);
		// No global getComputedStyle in the node test environment.
		expect(readFontSizePx(el)).toBe(11);
	});

	it('falls back on an empty or invalid value (detached element)', () => {
		expect(readFontSizePx(el, 11, style(''))).toBe(11);
		expect(readFontSizePx(el, 11, style('0px'))).toBe(11);
		expect(readFontSizePx(el, 9, style('auto'))).toBe(9);
	});
});

describe('trackFontSize', () => {
	function stubBrowser(initial: string) {
		let current = initial;
		let callback: (() => void) | undefined;
		const disconnect = vi.fn();
		vi.stubGlobal('getComputedStyle', () => ({ fontSize: current }));
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(cb: () => void) {
					callback = cb;
				}
				observe() {}
				disconnect = disconnect;
			}
		);
		return {
			set(next: string) {
				current = next;
			},
			resize: () => callback?.(),
			disconnect
		};
	}

	it('reports on attach, again on resize, and disconnects on teardown', () => {
		const browser = stubBrowser('11.2px');
		const seen: number[] = [];
		const cleanup = trackFontSize((px) => seen.push(px))(el);
		expect(seen).toEqual([11.2]);
		browser.set('16px'); // e.g. the root font size changed at runtime
		browser.resize();
		expect(seen).toEqual([11.2, 16]);
		(cleanup as () => void)();
		expect(browser.disconnect).toHaveBeenCalledOnce();
	});

	it('keeps the last value when the size is transiently unreadable', () => {
		const browser = stubBrowser('16px');
		const seen: number[] = [];
		trackFontSize((px) => seen.push(px))(el);
		browser.set('');
		browser.resize();
		expect(seen).toEqual([16]);
	});

	it('reads once and observes nothing without ResizeObserver', () => {
		vi.stubGlobal('getComputedStyle', () => ({ fontSize: '14px' }));
		vi.stubGlobal('ResizeObserver', undefined);
		const seen: number[] = [];
		expect(trackFontSize((px) => seen.push(px))(el)).toBeUndefined();
		expect(seen).toEqual([14]);
	});
});

// Verification conditions of D9-b: (1) root font size other than 14px,
// (2) `--banto-font-size-sm` overridden. In both, a long axis label must fit
// the margin estimated from the measured size, and the margin must follow
// the font size (the old fixed 11px estimate would clip).
describe('margins follow the rendered label size (D9-b conditions)', () => {
	const category = 'アップルジュース（業務用）';
	const tick = '800,000,000';
	const cases = [
		['(1) root 20px, sm = 0.8rem', resolveSm(20)],
		['(2) --banto-font-size-sm overridden to 1rem at root 14px', resolveSm(14, 1)]
	] as const;

	it.each(cases)('%s: category labels fit and the margin grows', (_name, computed) => {
		const px = readFontSizePx(el, 11, style(computed));
		expect(px).toBeGreaterThan(11);
		const margin = leftMarginFor([category], { fontSize: px, max: 400 });
		// end-anchored at innerLeft - 8: the label's left edge stays inside the
		// chart (within the margin's Math.round; the estimate itself is generous)
		expect(margin - 8 - estimateLabelWidth(category, px)).toBeGreaterThanOrEqual(-0.5);
		// the fixed 11px estimate would have clipped it
		const old = leftMarginFor([category], { max: 400 });
		expect(old - 8 - estimateLabelWidth(category, px)).toBeLessThan(0);
	});

	it.each(cases)('%s: value-axis ticks fit and the margin grows', (_name, computed) => {
		const px = readFontSizePx(el, 11, style(computed));
		const left = leftMarginForTicks(['0', tick], 48, { fontSize: px, totalWidth: 1200 });
		expect(left - 8 - estimateLabelWidth(tick, px)).toBeGreaterThanOrEqual(0);
		expect(left).toBeGreaterThan(leftMarginForTicks(['0', tick], 48, { totalWidth: 1200 }));
		expect(rightMarginForLastTick(tick, { fontSize: px })).toBeGreaterThanOrEqual(
			estimateLabelWidth(tick, px) / 2
		);
	});

	it('the standard environment (root 14px, sm 0.8rem = 11.2px) stays within 0.2px of the old 11px', () => {
		const px = readFontSizePx(el, 11, style(resolveSm(14)));
		expect(Math.abs(px - 11)).toBeLessThanOrEqual(0.2 + 1e-9);
	});
});

// No component-mount test infra in this package: guard the wiring by source
// so each label-aware chart keeps feeding the measured size into the estimate.
const SOURCES: Record<string, string> = {
	BarChart: BarChartSrc,
	BoxPlot: BoxPlotSrc,
	ComboChart: ComboChartSrc,
	GanttChart: GanttChartSrc,
	Heatmap: HeatmapSrc,
	Histogram: HistogramSrc,
	LineChart: LineChartSrc,
	ParetoChart: ParetoChartSrc,
	ScatterChart: ScatterChartSrc,
	StackedAreaChart: StackedAreaChartSrc
};

describe('chart wiring', () => {
	it.each(Object.keys(SOURCES))('%s measures a rendered label and passes fontSize', (name) => {
		const src = SOURCES[name];
		expect(src).toMatch(/trackFontSize\(/);
		expect(src).toMatch(/\{@attach \w+ === 0 \? track\w+Font : null\}/);
		const calls = src.match(/(leftMarginFor(Ticks)?|rightMarginFor(Ticks|LastTick))\(/g) ?? [];
		const withFont = src.match(/fontSize: \w+FontSize/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		expect(withFont.length).toBe(calls.length);
	});

	it.each(Object.keys(SOURCES))('%s has no raw px font size left', (name) => {
		expect(SOURCES[name]).not.toMatch(/font-size:\s*[\d.]+(px|rem)/);
	});
});
