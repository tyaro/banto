// @vitest-environment jsdom
/**
 * `@banto/charts/testing` (#852): the stand-ins make a chart draw its series
 * in jsdom, and `restore()` leaves nothing behind.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import LineChart from '../src/LineChart.svelte';
import { flushChart, installChartDom } from '../src/testing';

afterEach(cleanup);

const SIZE_PROPS = ['clientWidth', 'offsetWidth', 'clientHeight', 'offsetHeight'] as const;
function expectSeriesDrawn(container: Element) {
	// 空の線も `<path d="">` を出すので、本当に線が引かれたこと（M と L）を見る
	const ds = [...container.querySelectorAll('svg.chart-svg path')].map(
		(el) => el.getAttribute('d') ?? ''
	);
	expect(ds.some((d) => d.includes('M') && d.includes('L'))).toBe(true);
}
function snapshot() {
	return {
		props: SIZE_PROPS.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)),
		observer: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
	};
}

const props = {
	data: [
		{ t: 1, v: 1 },
		{ t: 2, v: 3 },
		{ t: 3, v: 2 }
	],
	x: (r: unknown) => (r as { t: number }).t,
	series: [{ id: 's', label: 's', y: (r: unknown) => (r as { v: number }).v }],
	label: 'line'
};

describe('installChartDom', () => {
	it('draws the series, and restore() leaves no stand-in behind', async () => {
		const before = snapshot();
		const dom = installChartDom({ width: 300, height: 200 });
		try {
			const { container } = render(LineChart, props);
			await flushChart();
			expect(container.querySelector('svg.chart-svg')).not.toBeNull();
			expectSeriesDrawn(container);
			expect(document.createElement('div').clientWidth).toBe(300);
			expect(typeof ResizeObserver).toBe('function');
		} finally {
			dom.restore();
		}
		expect(snapshot()).toEqual(before);
		expect(document.createElement('div').clientWidth).toBe(0);
		dom.restore(); // idempotent
	});

	it('renders only the empty state without it (the reason it exists)', async () => {
		const { container } = render(LineChart, props);
		await flushChart();
		expect(container.querySelector('svg.chart-svg')).toBeNull();
	});

	it('refuses a second install while one is in effect, and works again after restore()', () => {
		const before = snapshot();
		const a = installChartDom();
		try {
			expect(() => installChartDom({ width: 100 })).toThrow(/already installed/);
		} finally {
			a.restore();
		}
		expect(snapshot()).toEqual(before);
		const b = installChartDom({ width: 100 });
		expect(document.createElement('div').clientWidth).toBe(100);
		b.restore();
		expect(snapshot()).toEqual(before);
	});

	it('rejects a zero size', () => {
		expect(() => installChartDom({ width: 0 })).toThrow(RangeError);
	});
});
