/**
 * 外部利用 fixture（#271）で `@banto/charts/testing`（#852）を確かめる。Git 依存で
 * 入れたパッケージのサブパスを読み、幅が 0 でない所で 1 つの部品をマウントして
 * SVG に系列が描かれること、戻した後に差し替えが残らないことを見る。
 */
import { cleanup, render } from '@testing-library/svelte';
import { LineChart } from '@banto/charts';
import { flushChart, installChartDom } from '@banto/charts/testing';
import { afterEach, describe, expect, it } from 'vitest';

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

describe('@banto/charts/testing（Git 依存の経路）', () => {
	it('幅が 0 でない所で系列が SVG に描かれ、restore() で差し替えが残らない', async () => {
		const hadObserver = 'ResizeObserver' in globalThis;
		const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
		const dom = installChartDom({ width: 320, height: 200 });
		try {
			const { container } = render(LineChart, props);
			await flushChart();
			expect(container.querySelector('svg.chart-svg')).not.toBeNull();
			expect(container.querySelectorAll('svg.chart-svg path').length).toBeGreaterThan(0);
		} finally {
			dom.restore();
		}
		expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')).toEqual(before);
		expect(document.createElement('div').clientWidth).toBe(0);
		expect('ResizeObserver' in globalThis).toBe(hadObserver);

		cleanup();
		const { container } = render(LineChart, props);
		await flushChart();
		expect(container.querySelector('svg.chart-svg')).toBeNull();
	});
});
