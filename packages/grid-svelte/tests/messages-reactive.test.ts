// @vitest-environment jsdom
/**
 * `messages` is reactive: a parent that swaps the bundle later (a locale
 * switch) gets the new wording without remounting. Each component merges
 * `defaultGridMessages` with `messages` via `$derived`, so a rerender with
 * new props must show the new strings.
 */
import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import ColumnsMenu from '../src/ColumnsMenu.svelte';
import FilterChips from '../src/FilterChips.svelte';
import FilterPopover from '../src/FilterPopover.svelte';
import HeaderCell from '../src/HeaderCell.svelte';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

beforeAll(() => {
	// jsdom has no ResizeObserver; BantoGrid constructs one on mount.
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: '商品名', accessor: 'name', filterable: true, filterType: 'text' }
];

describe('messages can be swapped after mount', () => {
	it('BantoGrid: the empty-state text follows', async () => {
		const { rerender } = render(BantoGrid<Row>, {
			rows: [],
			columns,
			state: new GridState<Row>(columns),
			getRowId: (row: Row) => row.id,
			messages: { emptyState: () => 'First' }
		});
		expect(screen.getByText('First')).toBeTruthy();
		await rerender({ messages: { emptyState: () => 'Second' } });
		expect(screen.getByText('Second')).toBeTruthy();
		expect(screen.queryByText('First')).toBeNull();
	});

	it('ColumnsMenu: the button label follows', async () => {
		const { rerender } = render(ColumnsMenu<Row>, {
			state: new GridState<Row>(columns),
			messages: { columnsMenuButton: () => 'Cols-A' }
		});
		expect(screen.getByRole('button', { name: /Cols-A/ })).toBeTruthy();
		await rerender({ messages: { columnsMenuButton: () => 'Cols-B' } });
		expect(screen.getByRole('button', { name: /Cols-B/ })).toBeTruthy();
	});

	it('FilterChips: the group label follows', async () => {
		const state = new GridState<Row>(columns);
		state.setFilter({ field: 'name', op: 'contains', value: 'x' });
		const { rerender } = render(FilterChips<Row>, {
			state,
			messages: { filterChipsLabel: () => 'Chips-A' }
		});
		await tick();
		expect(screen.getByRole('group', { name: 'Chips-A' })).toBeTruthy();
		await rerender({ messages: { filterChipsLabel: () => 'Chips-B' } });
		expect(screen.getByRole('group', { name: 'Chips-B' })).toBeTruthy();
	});

	it('FilterPopover: the apply button and the operator labels follow', async () => {
		const { rerender } = render(FilterPopover<Row>, {
			column: columns[0],
			current: undefined,
			onApply: vi.fn(),
			onClear: vi.fn(),
			onClose: vi.fn(),
			messages: { filterApply: () => 'Apply-A', filterOpContains: () => 'Has-A' }
		});
		expect(screen.getByRole('button', { name: 'Apply-A' })).toBeTruthy();
		expect(screen.getByRole('option', { name: 'Has-A' })).toBeTruthy();
		await rerender({
			messages: { filterApply: () => 'Apply-B', filterOpContains: () => 'Has-B' }
		});
		expect(screen.getByRole('button', { name: 'Apply-B' })).toBeTruthy();
		expect(screen.getByRole('option', { name: 'Has-B' })).toBeTruthy();
	});

	it('HeaderCell: the filter button label follows', async () => {
		const { rerender } = render(HeaderCell<Row>, {
			column: columns[0],
			state: new GridState<Row>(columns),
			width: 120,
			showPriority: false,
			onDragStart: vi.fn(),
			onDragMove: vi.fn(),
			onDragEnd: vi.fn(),
			messages: { filterAriaLabel: (h: string) => `A:${h}` }
		});
		expect(screen.getByRole('button', { name: 'A:商品名' })).toBeTruthy();
		await rerender({ messages: { filterAriaLabel: (h: string) => `B:${h}` } });
		expect(screen.getByRole('button', { name: 'B:商品名' })).toBeTruthy();
	});
});
