// @vitest-environment jsdom
/**
 * Series colours past slot 8 (#851): `MAX_CHART_SERIES` is 16, slots 9..16
 * fall back to slot 8, and that fallback survives the SVG export.
 *
 * "A theme without 9..16" below is a theme that defines `--banto-chart-1..8`
 * only: an older `@banto/theme`, or an app theme written before #851. With it
 * the 9th and later series must look as they did while `MAX_CHART_SERIES` was
 * 8 (the colour of slot 8).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CHART_SERIES, seriesColorVar } from '../src/core/color';
import { inlineCssVarRefs, serializeChartSvg } from '../src/core/export';

/** `--banto-chart-1..count` -> a distinct colour each (`#000001`, `#000002`, ...). */
function theme(count: number): Map<string, string> {
	const vars = new Map<string, string>();
	for (let n = 1; n <= count; n++) vars.set(`--banto-chart-${n}`, slotColour(n));
	return vars;
}

const slotColour = (n: number) => `#0000${n.toString(16).padStart(2, '0')}`;

/** What a browser computes for `value` under `vars` (var() with a fallback included). */
const computed = (value: string, vars: Map<string, string>) =>
	inlineCssVarRefs(value, (name) => vars.get(name) ?? '');

describe('seriesColorVar (#851)', () => {
	it('MAX_CHART_SERIES is 16', () => expect(MAX_CHART_SERIES).toBe(16));

	it('slots 1..8 are a plain reference, as before', () => {
		for (let i = 0; i < 8; i++) expect(seriesColorVar(i)).toBe(`var(--banto-chart-${i + 1})`);
	});

	it('slots 9..16 reference their own slot and fall back to slot 8', () => {
		for (let i = 8; i < 16; i++)
			expect(seriesColorVar(i)).toBe(`var(--banto-chart-${i + 1}, var(--banto-chart-8))`);
	});

	it('the 17th and later series stay on slot 16 (no wrapping back to slot 1)', () => {
		for (const i of [16, 17, 20, 1000, Number.POSITIVE_INFINITY])
			expect(seriesColorVar(i)).toBe(seriesColorVar(15));
	});

	it('a negative index takes slot 1', () => {
		expect(seriesColorVar(-1)).toBe('var(--banto-chart-1)');
	});

	it('with a 16-slot theme every one of the first 16 series has its own colour', () => {
		const vars = theme(16);
		const colours = Array.from({ length: 16 }, (_, i) => computed(seriesColorVar(i), vars));
		expect(colours).toEqual(Array.from({ length: 16 }, (_, i) => slotColour(i + 1)));
		expect(computed(seriesColorVar(16), vars)).toBe(slotColour(16));
	});

	it('with a theme without 9..16, the 9th and later series take the colour of slot 8', () => {
		const vars = theme(8);
		for (let i = 0; i < 8; i++) expect(computed(seriesColorVar(i), vars)).toBe(slotColour(i + 1));
		for (const i of [8, 9, 15, 16, 40])
			expect(computed(seriesColorVar(i), vars)).toBe(slotColour(8));
	});
});

describe('inlineCssVarRefs with a fallback (#851)', () => {
	it('uses the variable when it resolves', () => {
		expect(inlineCssVarRefs('var(--a, var(--b))', (n) => (n === '--a' ? 'red' : 'blue'))).toBe(
			'red'
		);
	});

	it('uses the fallback, resolved, when the variable does not', () => {
		expect(inlineCssVarRefs('var(--a, var(--b))', (n) => (n === '--b' ? 'blue' : ''))).toBe('blue');
		expect(inlineCssVarRefs('var(--a, #123456)', () => '')).toBe('#123456');
		expect(inlineCssVarRefs('var(--a, rgb(1, 2, 3))', () => '')).toBe('rgb(1, 2, 3)');
	});

	it('leaves the innermost reference as written when nothing resolves', () => {
		expect(inlineCssVarRefs('var(--a, var(--b))', () => '')).toBe('var(--b)');
	});

	it('handles several references and the text around them', () => {
		const resolve = (n: string) => (n === '--y' ? '2px' : n === '--z' ? '3px' : '');
		expect(inlineCssVarRefs('1px var(--x, var(--y)) var(--z) 4px', resolve)).toBe(
			'1px 2px 3px 4px'
		);
	});

	it('leaves an unbalanced reference as written', () => {
		expect(inlineCssVarRefs('var(--a, rgb(1, 2', () => '')).toBe('var(--a, rgb(1, 2');
	});
});

/**
 * `serializeChartSvg` resolves colours in two ways:
 * - `fill` / `stroke` (BAKED_PROPS) come from `getComputedStyle`, i.e. the
 *   browser itself substitutes `var(--banto-chart-N, var(--banto-chart-8))`.
 *   jsdom does not compute presentation attributes (it reports the initial
 *   `fill` for every element), so that half is not asserted here; the
 *   `computed` checks above state what CSS gives.
 * - any other attribute that still holds a `var()` goes through
 *   `inlineCssVarRefs` against the root's custom properties. That is the code
 *   this package owns, and what the marks below (`stop-color`) exercise.
 */
describe('serializeChartSvg keeps the fallback (#851)', () => {
	const SVG_NS = 'http://www.w3.org/2000/svg';

	afterEach(() => document.body.replaceChildren());

	/** An <svg> with one gradient stop per series, coloured with `seriesColorVar(i)`. */
	function mount(seriesCount: number, vars: Map<string, string>): SVGSVGElement {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 100 100');
		for (const [name, value] of vars) svg.style.setProperty(name, value);
		for (let i = 0; i < seriesCount; i++) {
			const stop = document.createElementNS(SVG_NS, 'stop');
			stop.setAttribute('stop-color', seriesColorVar(i));
			svg.append(stop);
		}
		document.body.append(svg);
		return svg;
	}

	const exportedColours = (svg: SVGSVGElement) =>
		[...serializeChartSvg(svg).matchAll(/stop-color="([^"]*)"/g)].map((m) => m[1]);

	it('with a theme without 9..16, the 9th and later series are exported in the colour of slot 8', () => {
		const colours = exportedColours(mount(18, theme(8)));
		expect(colours.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, i) => slotColour(i + 1)));
		expect(colours.slice(8)).toEqual(Array.from({ length: 10 }, () => slotColour(8)));
	});

	it('with a 16-slot theme, series 9..16 are exported in their own colour and later ones in slot 16', () => {
		const colours = exportedColours(mount(18, theme(16)));
		expect(colours.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => slotColour(i + 1)));
		expect(colours.slice(16)).toEqual([slotColour(16), slotColour(16)]);
	});
});
