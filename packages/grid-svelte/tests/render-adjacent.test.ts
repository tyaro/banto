// @vitest-environment jsdom
/**
 * #591: a column's `render` snippet (custom cell content - an app's "open"
 * button) and `adjacentRow` (the previous / next row in the order on screen).
 * Same jsdom stubs as BantoGrid.test.ts so rows virtualize into view.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { isColumnEditable } from '../src/core/edit';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get() {
			return 400;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get() {
			return 32;
		}
	});
});

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	price: number;
}

const rows: Row[] = [
	{ id: 1, name: 'ペン', price: 300 },
	{ id: 2, name: 'ノート', price: 100 },
	{ id: 3, name: '消しゴム', price: 200 }
];

const openButton = createRawSnippet<[Row]>((row) => ({
	render: () => `<button type="button" data-open="${row().id}">open ${row().id}</button>`
}));

const columns: GridColumn<Row>[] = [
	{ id: 'open', header: '操作', accessor: () => '', render: openButton },
	{ id: 'name', header: '商品名', accessor: 'name', editable: true },
	{ id: 'price', header: '価格', accessor: 'price' }
];

describe('GridColumn.render (#591)', () => {
	it('renders the snippet in each row cell', () => {
		render(BantoGrid<Row>, {
			rows,
			columns,
			state: new GridState<Row>(columns),
			getRowId: (row: Row) => row.id
		});
		expect(screen.getByRole('button', { name: 'open 1' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'open 3' })).toBeTruthy();
	});

	it('is never editable, like `cell`', () => {
		expect(isColumnEditable({ ...columns[0], editable: true }, rows[0])).toBe(false);
	});

	it('Enter on the active render cell clicks its button', async () => {
		const clicked = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			state: new GridState<Row>(columns),
			getRowId: (row: Row) => row.id
		});
		container
			.querySelector('[data-open="2"]')!
			.addEventListener('click', () => clicked(), { once: true });
		const cell = container.querySelector('[data-cell-row="1"][data-cell-field="open"]')!;
		await fireEvent.pointerDown(cell);
		await fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' });
		expect(clicked).toHaveBeenCalledTimes(1);
	});
});

describe('BantoGrid.adjacentRow (#591)', () => {
	it('follows the sorted order in client mode, undefined past either end or for an unknown id', async () => {
		const state = new GridState<Row>(columns);
		state.sort = [{ field: 'price', direction: 'asc' }];
		const { component } = render(BantoGrid<Row>, {
			rows,
			columns,
			state,
			getRowId: (row: Row) => row.id
		});
		await tick();
		// price asc: 2 (100), 3 (200), 1 (300)
		expect(component.adjacentRow(3, -1)?.id).toBe(2);
		expect(component.adjacentRow(3, 1)?.id).toBe(1);
		expect(component.adjacentRow(2, -1)).toBeUndefined();
		expect(component.adjacentRow(1, 1)).toBeUndefined();
		expect(component.adjacentRow(99, 1)).toBeUndefined();
	});

	it('skips rows the filter hides', async () => {
		const state = new GridState<Row>(columns);
		state.filters = [{ field: 'name', op: 'contains', value: 'ノ' }];
		const { component } = render(BantoGrid<Row>, {
			rows,
			columns,
			state,
			getRowId: (row: Row) => row.id
		});
		await tick();
		expect(component.adjacentRow(2, 1)).toBeUndefined();
		expect(component.adjacentRow(1, 1)).toBeUndefined();
	});

	it('uses the loaded slots in server mode; a neighbour not loaded yet is undefined', async () => {
		const sparse: (Row | undefined)[] = [];
		sparse[0] = rows[0];
		sparse[1] = rows[1];
		sparse[5] = rows[2];
		const { component } = render(BantoGrid<Row>, {
			mode: 'server',
			totalRows: 10,
			rows: sparse,
			columns,
			state: new GridState<Row>(columns),
			getRowId: (row: Row) => row.id
		});
		await tick();
		expect(component.adjacentRow(1, 1)?.id).toBe(2);
		expect(component.adjacentRow(2, -1)?.id).toBe(1);
		expect(component.adjacentRow(2, 1)).toBeUndefined();
		expect(component.adjacentRow(3, -1)).toBeUndefined();
	});
});
