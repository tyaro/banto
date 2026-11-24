// @vitest-environment jsdom
/**
 * Selectable marks, second half: (1) marks with no drawn area are not
 * selectable (no invisible Tab stop), while the callback's `index` stays the
 * position in `data`; (2) the tooltip follows keyboard focus and the pointer
 * separately, so the pointer leaving a focused mark does not hide its tooltip.
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
const cat = (r: unknown) => (r as Row).name;
const valA = (r: unknown) => (r as Row).a;
const valB = (r: unknown) => (r as Row).b;
const buttonsOf = (c: HTMLElement) => [...c.querySelectorAll<SVGGElement>('[role="button"]')];
const names = (c: HTMLElement) => buttonsOf(c).map((b) => b.getAttribute('aria-label'));

const rows: Row[] = [
	{ name: 'A', a: 10, b: 1 },
	{ name: 'B', a: 20, b: 2 }
];
const zeroFirst: Row[] = [
	{ name: 'Z', a: 0, b: 0 },
	{ name: 'B', a: 20, b: 2 },
	{ name: 'M', a: 0, b: 5 },
	{ name: 'C', a: 30, b: 3 }
];

describe('marks without a drawn area are not selectable', () => {
	it('pie: zero slices (first and middle) are skipped, index stays the data position', async () => {
		const onMarkActivate = vi.fn();
		const { container } = render(PieChart, {
			data: zeroFirst,
			category: cat,
			value: valA,
			label: '円',
			onMarkActivate
		});
		await flush();
		const buttons = buttonsOf(container);
		expect(names(container)).toEqual(['B: 20', 'C: 30']);
		expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1']);
		await fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
		await flush();
		expect(document.activeElement).toBe(buttons[1]);
		await fireEvent.keyDown(buttons[1], { key: 'Enter' });
		expect(onMarkActivate).toHaveBeenLastCalledWith({
			row: zeroFirst[3],
			index: 3,
			category: 'C',
			value: 30
		});
	});

	it('stacked bars: zero segments are skipped, index stays the data position', async () => {
		const onMarkActivate = vi.fn();
		const { container } = render(BarChart, {
			data: zeroFirst,
			category: cat,
			series: [
				{ id: 'a', label: 'A', value: valA },
				{ id: 'b', label: 'B', value: valB }
			],
			stacked: true,
			label: '棒',
			onMarkActivate
		});
		await flush();
		// Z has no segment at all; M's `a` is 0
		expect(names(container)).toEqual([
			'B（A）: 20',
			'B（B）: 2',
			'M（B）: 5',
			'C（A）: 30',
			'C（B）: 3'
		]);
		const buttons = buttonsOf(container);
		expect(buttons.filter((b) => b.getAttribute('tabindex') === '0').length).toBe(1);
		await fireEvent.keyDown(buttons[0], { key: 'End' });
		await flush();
		expect(document.activeElement).toBe(buttons[4]);
		await fireEvent.keyDown(buttons[4], { key: 'Enter' });
		expect(onMarkActivate).toHaveBeenLastCalledWith({
			row: zeroFirst[3],
			index: 3,
			category: 'C',
			seriesId: 'b',
			value: 3
		});
	});
});

describe('tooltip follows focus and pointer separately', () => {
	const tip = (c: HTMLElement) => c.querySelector('.chart-tooltip');

	it('bar: the pointer leaving does not hide the focused mark tooltip; blur hides it', async () => {
		const { container } = render(BarChart, {
			data: rows,
			category: cat,
			series: [{ id: 'a', label: 'A', value: valA }],
			label: '棒',
			onMarkActivate: () => {}
		});
		await flush();
		const buttons = buttonsOf(container);
		buttons[0].focus();
		await flush();
		expect(tip(container)?.textContent).toContain('10');
		await fireEvent.pointerEnter(buttons[1]);
		await flush();
		expect(tip(container)?.textContent).toContain('20');
		await fireEvent.pointerLeave(buttons[1]);
		await flush();
		expect(tip(container)?.textContent).toContain('10');
		buttons[0].blur();
		await flush();
		expect(tip(container)).toBeNull();
	});

	it('pie and bar: data shrinking under a focused last mark does not throw or leave a tooltip', async () => {
		const three: Row[] = [...rows, { name: 'C', a: 30, b: 3 }];
		for (const [Comp, props] of [
			[PieChart, { category: cat, value: valA, label: '円' }],
			[BarChart, { category: cat, series: [{ id: 'a', label: 'A', value: valA }], label: '棒' }]
		] as const) {
			const { container, rerender } = render(
				Comp as never,
				{
					...props,
					data: three,
					onMarkActivate: () => {}
				} as never
			);
			await flush();
			buttonsOf(container)[2].focus();
			await flush();
			expect(tip(container)).not.toBeNull();
			await rerender({ data: [rows[0]] } as never);
			await flush();
			expect(tip(container)).toBeNull();
			expect(buttonsOf(container).length).toBe(1);
			cleanup();
		}
	});

	it('pie: the pointer entering and leaving the focused slice keeps its tooltip', async () => {
		const { container } = render(PieChart, {
			data: rows,
			category: cat,
			value: valA,
			label: '円',
			onMarkActivate: () => {}
		});
		await flush();
		const buttons = buttonsOf(container);
		buttons[0].focus();
		await fireEvent.pointerEnter(buttons[0]);
		await fireEvent.pointerLeave(buttons[0]);
		await flush();
		expect(tip(container)?.textContent).toContain('10');
		buttons[0].blur();
		await flush();
		expect(tip(container)).toBeNull();
	});
});
