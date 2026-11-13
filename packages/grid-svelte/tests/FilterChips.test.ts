// @vitest-environment jsdom
/**
 * FilterChips (#555 B-2): applied-filter chips above the grid. Covers the
 * wording per operator, x -> removeFilter, "clear all" only from two
 * filters, nothing rendered for zero filters, and where focus goes.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FilterChips from '../src/FilterChips.svelte';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	price: number;
	day: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: '商品名', accessor: 'name' },
	{ id: 'price', header: '価格', accessor: 'price', filterType: 'number' },
	{ id: 'day', header: '日付', accessor: 'day', filterType: 'date' }
];

function setup(onEmpty?: () => void) {
	const state = new GridState<Row>(columns);
	const view = render(FilterChips<Row>, { state, onEmpty });
	return { state, ...view };
}

describe('FilterChips', () => {
	it('renders nothing while no filter is applied', () => {
		const { container } = setup();
		expect(container.querySelector('.filter-chips')).toBeNull();
		expect(screen.queryByRole('group')).toBeNull();
	});

	it('writes a chip as "header operator value"', async () => {
		const { state } = setup();
		state.setFilter({ field: 'name', op: 'contains', value: 'ねじ' });
		await tick();
		const group = screen.getByRole('group', { name: '適用中の絞り込み' });
		expect(group.textContent).toContain('商品名');
		expect(group.textContent).toContain('含む');
		expect(group.textContent).toContain('ねじ');
		expect(screen.getByRole('button', { name: '商品名の絞り込みを外す' })).toBeTruthy();
	});

	it('uses symbols for number columns and shows between / is_null', async () => {
		const { state } = setup();
		state.setFilter({ field: 'price', op: 'gte', value: 100 });
		state.setFilter({ field: 'day', op: 'between', value: ['2026-01-01', null] });
		state.setFilter({ field: 'name', op: 'is_null', value: null });
		await tick();
		const text = screen.getByRole('group').textContent ?? '';
		expect(text).toContain('≥');
		expect(text).toContain('100');
		expect(text).toContain('2026-01-01 〜');
		expect(text).toContain('空');
	});

	it('removes only that filter with the x button', async () => {
		const { state } = setup();
		state.setFilter({ field: 'name', op: 'contains', value: 'a' });
		state.setFilter({ field: 'price', op: 'eq', value: 5 });
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: '商品名の絞り込みを外す' }));
		expect(state.filters.map((f) => f.field)).toEqual(['price']);
	});

	it('offers "clear all" only from two filters', async () => {
		const { state } = setup();
		state.setFilter({ field: 'name', op: 'contains', value: 'a' });
		await tick();
		expect(screen.queryByRole('button', { name: 'すべて解除' })).toBeNull();
		state.setFilter({ field: 'price', op: 'eq', value: 5 });
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'すべて解除' }));
		expect(state.filters).toEqual([]);
	});

	it('does nothing when the chip text is clicked', async () => {
		const { state } = setup();
		state.setFilter({ field: 'name', op: 'contains', value: 'ねじ' });
		await tick();
		await fireEvent.click(screen.getByText('ねじ'));
		expect(state.filters).toHaveLength(1);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('moves focus to the next chip, and calls onEmpty after the last one', async () => {
		const onEmpty = vi.fn();
		const { state } = setup(onEmpty);
		state.setFilter({ field: 'name', op: 'contains', value: 'a' });
		state.setFilter({ field: 'price', op: 'eq', value: 5 });
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: '商品名の絞り込みを外す' }));
		await tick();
		const priceRemove = screen.getByRole('button', { name: '価格の絞り込みを外す' });
		expect(document.activeElement).toBe(priceRemove);
		expect(onEmpty).not.toHaveBeenCalled();
		await fireEvent.click(priceRemove);
		expect(onEmpty).toHaveBeenCalledTimes(1);
	});

	it('uses overridden messages', async () => {
		const state = new GridState<Row>(columns);
		render(FilterChips<Row>, {
			state,
			messages: { filterChipRemove: (h) => `drop ${h}`, filterChipsLabel: () => 'Applied' }
		});
		state.setFilter({ field: 'name', op: 'contains', value: 'a' });
		await tick();
		expect(screen.getByRole('group', { name: 'Applied' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'drop 商品名' })).toBeTruthy();
	});

	it('shows a date range as the chosen days, not the exclusive upper bound', async () => {
		const { state } = setup();
		state.setFilter({ field: 'day', op: 'between', value: ['2026-11-10', '2026-11-14'] });
		await tick();
		const group = screen.getByRole('group', { name: '適用中の絞り込み' });
		expect(group.textContent).toContain('2026-11-10');
		expect(group.textContent).toContain('2026-11-13');
		expect(group.textContent).not.toContain('2026-11-14');
	});

	it('keeps a non-day boundary of a date column as given', async () => {
		const { state } = setup();
		state.setFilter({ field: 'day', op: 'between', value: ['2026-11-10', '2026-11-14T09:00:00'] });
		await tick();
		expect(screen.getByRole('group').textContent).toContain('2026-11-14T09:00:00');
	});

	it('calls onchange after an x and after "clear all"', async () => {
		const state = new GridState<Row>(columns);
		const onchange = vi.fn();
		render(FilterChips<Row>, { state, onchange });
		state.setFilter({ field: 'name', op: 'contains', value: 'a' });
		state.setFilter({ field: 'price', op: 'gt', value: 1 });
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: '商品名の絞り込みを外す' }));
		expect(onchange).toHaveBeenCalledTimes(1);
		state.setFilter({ field: 'name', op: 'contains', value: 'a' });
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'すべて解除' }));
		expect(onchange).toHaveBeenCalledTimes(2);
	});
});
