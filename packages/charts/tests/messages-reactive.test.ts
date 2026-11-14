// @vitest-environment jsdom
/**
 * `messages` is reactive: a parent that swaps the bundle later (a locale
 * switch) gets the new wording without remounting. Each component merges
 * `defaultChartMessages` with `messages` via `$derived`, so a rerender with
 * new props must show the new strings.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BoxPlot from '../src/BoxPlot.svelte';
import GanttChart from '../src/GanttChart.svelte';
import Gauge from '../src/Gauge.svelte';
import Histogram from '../src/Histogram.svelte';
import LineChart from '../src/LineChart.svelte';
import ParetoChart from '../src/ParetoChart.svelte';
import StackedAreaChart from '../src/StackedAreaChart.svelte';

beforeAll(() => {
	// jsdom has no layout: give every element a width so ChartContainer's
	// `bind:clientWidth` goes positive and the plot (not just the empty
	// state) renders. ResizeObserver is absent too.
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => 400
	});
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

afterEach(cleanup);

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('messages can be swapped after mount', () => {
	it('ChartContainer (via BoxPlot): the empty-state text follows', async () => {
		const { container, rerender } = render(BoxPlot, {
			groups: [],
			label: 'box',
			messages: { emptyState: () => 'A' }
		});
		expect(container.querySelector('.empty-state')?.textContent).toBe('A');
		await rerender({ messages: { emptyState: () => 'B' } });
		expect(container.querySelector('.empty-state')?.textContent).toBe('B');
	});

	it('Gauge: the no-value placeholder follows', async () => {
		const { container, rerender } = render(Gauge, {
			value: null,
			max: 100,
			label: 'g',
			messages: { gaugeNoValue: () => 'none-A' }
		});
		await flush();
		expect(container.querySelector('.hero-value')?.textContent?.trim()).toBe('none-A');
		await rerender({ messages: { gaugeNoValue: () => 'none-B' } });
		expect(container.querySelector('.hero-value')?.textContent?.trim()).toBe('none-B');
	});

	it('Histogram: the legend label follows', async () => {
		const { container, rerender } = render(Histogram, {
			values: [1, 2, 2, 3, 3, 3, 4, 5],
			label: 'h',
			normalCurve: true, // the legend shows from 2 items
			messages: { histogramFrequency: () => 'freq-A' }
		});
		expect(container.textContent).toContain('freq-A');
		await rerender({ messages: { histogramFrequency: () => 'freq-B' } });
		expect(container.textContent).toContain('freq-B');
		expect(container.textContent).not.toContain('freq-A');
	});

	it('ParetoChart: the legend label follows', async () => {
		const { container, rerender } = render(ParetoChart, {
			items: [
				{ label: 'a', value: 5 },
				{ label: 'b', value: 3 }
			],
			label: 'p',
			messages: { paretoValue: () => 'val-A' }
		});
		expect(container.textContent).toContain('val-A');
		await rerender({ messages: { paretoValue: () => 'val-B' } });
		expect(container.textContent).toContain('val-B');
		expect(container.textContent).not.toContain('val-A');
	});

	it('GanttChart: the "today" marker label follows', async () => {
		const props = {
			tasks: [{ id: 't1', label: 'task', start: '2026-01-01', end: '2026-01-10' }],
			label: 'gantt',
			today: '2026-01-05'
		};
		const { container, rerender } = render(GanttChart, {
			...props,
			messages: { ganttToday: () => 'today-A' }
		});
		await flush();
		expect(container.textContent).toContain('today-A');
		await rerender({ messages: { ganttToday: () => 'today-B' } });
		expect(container.textContent).toContain('today-B');
		expect(container.textContent).not.toContain('today-A');
	});

	it('LineChart: the empty-state text (ChartContainer) follows', async () => {
		const { container, rerender } = render(LineChart, {
			data: [],
			x: (r: unknown) => r,
			series: [{ id: 's', label: 's', y: (r: unknown) => r }],
			label: 'l',
			messages: { emptyState: () => 'A' }
		});
		expect(container.querySelector('.empty-state')?.textContent).toBe('A');
		await rerender({ messages: { emptyState: () => 'B' } });
		expect(container.querySelector('.empty-state')?.textContent).toBe('B');
	});

	it('StackedAreaChart: the empty-state text (ChartContainer) follows', async () => {
		const { container, rerender } = render(StackedAreaChart, {
			data: [],
			x: (r: unknown) => r,
			series: [{ id: 's', label: 's', y: (r: unknown) => r }],
			label: 's',
			messages: { emptyState: () => 'A' }
		});
		expect(container.querySelector('.empty-state')?.textContent).toBe('A');
		await rerender({ messages: { emptyState: () => 'B' } });
		expect(container.querySelector('.empty-state')?.textContent).toBe('B');
	});
});
