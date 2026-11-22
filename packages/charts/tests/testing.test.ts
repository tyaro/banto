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
		const hadObserver = 'ResizeObserver' in globalThis;
		const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
		const dom = installChartDom({ width: 300, height: 200 });
		try {
			const { container } = render(LineChart, props);
			await flushChart();
			expect(container.querySelector('svg.chart-svg')).not.toBeNull();
			expect(container.querySelectorAll('path').length).toBeGreaterThan(0);
			expect(document.createElement('div').clientWidth).toBe(300);
			expect(typeof ResizeObserver).toBe('function');
		} finally {
			dom.restore();
		}
		expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')).toEqual(before);
		expect(document.createElement('div').clientWidth).toBe(0);
		expect('ResizeObserver' in globalThis).toBe(hadObserver);
		dom.restore(); // idempotent
	});

	it('renders only the empty state without it (the reason it exists)', async () => {
		const { container } = render(LineChart, props);
		await flushChart();
		expect(container.querySelector('svg.chart-svg')).toBeNull();
	});

	it('rejects a zero size', () => {
		expect(() => installChartDom({ width: 0 })).toThrow(RangeError);
	});
});
