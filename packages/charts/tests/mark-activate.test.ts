// @vitest-environment jsdom
/**
 * Selectable marks (`onMarkActivate`) on BarChart / PieChart: role switch,
 * roving tabindex, labels, click / key activation. Without `onMarkActivate`
 * the DOM stays the old `role="img"` with no buttons.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BarChart from '../src/BarChart.svelte';
import PieChart from '../src/PieChart.svelte';
import { installChartDom, type ChartDomHandle } from '../src/testing';

let dom: ChartDomHandle;
beforeAll(() => {
	dom = installChartDom();
});
afterAll(() => dom.restore());
afterEach(cleanup);

const flush = () => new Promise((r) => setTimeout(r, 0));
interface Row {
	name: string;
	a: number;
	b: number;
}
const rows: Row[] = [
	{ name: 'A', a: 10, b: 1 },
	{ name: 'B', a: 20, b: 2 },
	{ name: 'C', a: 30, b: 3 }
];

describe('BarChart', () => {
	it('is a plain image without onMarkActivate', async () => {
		const { container } = render(BarChart, {
			data: rows,
			category: (r: unknown) => (r as Row).name,
			series: [{ id: 'a', label: 'A', value: (r: unknown) => (r as Row).a }],
			label: '棒'
		});
		await flush();
		expect(container.querySelector('[role="img"]')).not.toBeNull();
		expect(container.querySelector('[role="group"]')).toBeNull();
		expect(container.querySelectorAll('[role="button"]').length).toBe(0);
	});

	it('exposes buttons with one tab stop, and activates on click / Enter / Space / arrows', async () => {
		const onMarkActivate = vi.fn();
		const { container } = render(BarChart, {
			data: rows,
			category: (r: unknown) => (r as Row).name,
			series: [{ id: 'a', label: 'A', value: (r: unknown) => (r as Row).a }],
			label: '棒',
			onMarkActivate
		});
		await flush();
		expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('棒');
		const buttons = [...container.querySelectorAll<SVGGElement>('[role="button"]')];
		expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['A: 10', 'B: 20', 'C: 30']);
		expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

		await fireEvent.click(buttons[1]);
		expect(onMarkActivate).toHaveBeenLastCalledWith({
			row: rows[1],
			index: 1,
			category: 'B',
			seriesId: 'a',
			value: 20
		});
		await fireEvent.keyDown(buttons[0], { key: 'Enter' });
		await fireEvent.keyDown(buttons[0], { key: ' ' });
		expect(onMarkActivate).toHaveBeenCalledTimes(3);

		await fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
		await flush();
		expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
		expect(document.activeElement).toBe(buttons[1]);
	});

	it('names the series for a multi-series chart and honours markLabel', async () => {
		const { container, rerender } = render(BarChart, {
			data: rows,
			category: (r: unknown) => (r as Row).name,
			series: [
				{ id: 'a', label: 'A系列', value: (r: unknown) => (r as Row).a },
				{ id: 'b', label: 'B系列', value: (r: unknown) => (r as Row).b }
			],
			label: '棒',
			onMarkActivate: () => {}
		});
		await flush();
		const first = container.querySelector('[role="button"]');
		expect(first?.getAttribute('aria-label')).toBe('A（A系列）: 10');
		await rerender({ markLabel: (mark: { category: string }) => `${mark.category}を開く` });
		await flush();
		expect(container.querySelector('[role="button"]')?.getAttribute('aria-label')).toBe('Aを開く');
	});
});

describe('PieChart', () => {
	it('is a plain image without onMarkActivate, buttons with it', async () => {
		const plain = render(PieChart, {
			data: rows,
			category: (r: unknown) => (r as Row).name,
			value: (r: unknown) => (r as Row).a,
			label: '円'
		});
		await flush();
		expect(plain.container.querySelectorAll('[role="button"]').length).toBe(0);
		cleanup();

		const onMarkActivate = vi.fn();
		const { container } = render(PieChart, {
			data: rows,
			category: (r: unknown) => (r as Row).name,
			value: (r: unknown) => (r as Row).a,
			label: '円',
			onMarkActivate
		});
		await flush();
		const buttons = [...container.querySelectorAll<SVGGElement>('[role="button"]')];
		expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['A: 10', 'B: 20', 'C: 30']);
		await fireEvent.keyDown(buttons[0], { key: 'End' });
		await flush();
		expect(document.activeElement).toBe(buttons[2]);
		await fireEvent.keyDown(buttons[2], { key: 'Enter' });
		expect(onMarkActivate).toHaveBeenCalledWith({
			row: rows[2],
			index: 2,
			category: 'C',
			value: 30
		});
	});
});
