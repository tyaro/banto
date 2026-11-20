// @vitest-environment jsdom
/**
 * #713: opt-in row selection (the checkbox column, the header's "select
 * all", Space on the active cell) and the bulk bar. The pure decisions are
 * covered in rowSelection.test.ts; this file covers the wiring.
 * Same jsdom stubs as BantoGrid.test.ts so rows virtualize into view.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { GridState } from '../src/state.svelte';
import type { GridBulkActionsContext, GridColumn } from '../src/types';

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

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: '商品名', accessor: 'name', filterType: 'text' },
	{ id: 'price', header: '価格', accessor: 'price' }
];

const getRowId = (row: Row) => row.id;

function rowBox(name: string): HTMLInputElement {
	return screen.getByRole('checkbox', { name: `${name}を選択` }) as HTMLInputElement;
}

function headerBox(): HTMLInputElement {
	return screen.getByRole('checkbox', { name: /すべて選択/ }) as HTMLInputElement;
}

describe('BantoGrid row selection (#713)', () => {
	it('draws no checkbox column, bar or live region unless selectable', () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(container.querySelector('.bulk-bar')).toBeNull();
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('2');
		expect(container.querySelector<HTMLElement>('.header-row')!.style.gridTemplateColumns).toBe(
			'150px 150px'
		);
	});

	it('adds a checkbox per row named after the row, outside the data columns', () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, selectable: true });
		expect(rowBox('ペン').checked).toBe(false);
		expect(rowBox('消しゴム')).toBeTruthy();
		expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('3');
		expect(container.querySelector<HTMLElement>('.header-row')!.style.gridTemplateColumns).toBe(
			'40px 150px 150px'
		);
		// Not a data cell: no field, so the cell range / copy never includes it.
		expect(container.querySelectorAll('.select-cell[data-cell-field]')).toHaveLength(0);
		// Nothing is announced before the user changes the selection.
		expect(screen.getByRole('status').textContent).toBe('');
	});

	it('uses getRowLabel for the checkbox name when given', () => {
		render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			selectable: true,
			getRowLabel: (row: Row) => `品目 ${row.id}`
		});
		expect(screen.getByRole('checkbox', { name: '品目 2を選択' })).toBeTruthy();
	});

	it('toggles a row from its checkbox, shows the bar and announces the count', async () => {
		const onSelectionChange = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			selectable: true,
			onSelectionChange
		});
		await fireEvent.click(rowBox('ノート'));
		expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
		expect(rowBox('ノート').checked).toBe(true);
		expect(container.querySelector('.row.selected')).toBeTruthy();
		const bar = screen.getByRole('group', { name: '一括操作' });
		expect(bar.textContent).toContain('1件を選択中');
		expect(screen.getByRole('status').textContent).toBe('1件を選択中');
		// The row state is the checkbox, not aria-selected (that is the cell range's).
		expect(container.querySelector('[role="row"][aria-selected]')).toBeNull();

		await fireEvent.click(rowBox('ノート'));
		expect(onSelectionChange).toHaveBeenLastCalledWith([]);
		expect(container.querySelector('.bulk-bar')).toBeNull();
		expect(screen.getByRole('status').textContent).toBe('選択なし');
	});

	it('does not open the row when its checkbox is clicked', async () => {
		const onRowClick = vi.fn();
		render(BantoGrid<Row>, { rows, columns, getRowId, selectable: true, onRowClick });
		await fireEvent.click(rowBox('ペン'));
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('header checkbox: none -> all -> none, indeterminate for some, and says what it covers', async () => {
		const onSelectionChange = vi.fn();
		render(BantoGrid<Row>, { rows, columns, getRowId, selectable: true, onSelectionChange });
		const header = headerBox();
		expect(header.getAttribute('aria-label')).toBe('一覧の3件をすべて選択');
		expect(header.title).toBe('一覧の3件をすべて選択');

		await fireEvent.click(rowBox('ペン'));
		expect(header.indeterminate).toBe(true);
		expect(header.checked).toBe(false);

		await fireEvent.click(header);
		expect(onSelectionChange).toHaveBeenLastCalledWith([1, 2, 3]);
		expect(header.indeterminate).toBe(false);
		expect(header.checked).toBe(true);

		await fireEvent.click(header);
		expect(onSelectionChange).toHaveBeenLastCalledWith([]);
		expect(header.checked).toBe(false);
	});

	it('Space on the active cell toggles its row; Enter still opens it', async () => {
		const onRowClick = vi.fn();
		const onSelectionChange = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			selectable: true,
			onRowClick,
			onSelectionChange
		});
		const grid = screen.getByRole('grid');
		await fireEvent.pointerDown(
			container.querySelector('[data-cell-row="1"][data-cell-field="price"]')!
		);
		const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
		grid.dispatchEvent(space);
		await tick();
		expect(space.defaultPrevented).toBe(true);
		expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
		expect(onRowClick).not.toHaveBeenCalled();

		await fireEvent.keyDown(grid, { key: ' ' });
		expect(onSelectionChange).toHaveBeenLastCalledWith([]);

		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(onRowClick).toHaveBeenCalledWith(rows[1]);
	});

	it('without selectable, Space keeps opening the row of a read-only grid', async () => {
		const onRowClick = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowClick });
		await fireEvent.pointerDown(container.querySelector('[data-cell-row="0"]')!);
		await fireEvent.keyDown(screen.getByRole('grid'), { key: ' ' });
		expect(onRowClick).toHaveBeenCalledWith(rows[0]);
	});

	it('Space on a link cell follows the link instead of selecting', async () => {
		const onSelectionChange = vi.fn();
		const linkColumns: GridColumn<Row>[] = [
			{
				id: 'name',
				header: '商品名',
				accessor: 'name',
				renderer: 'link',
				href: (row) => `/items/${row.id}`
			},
			{ id: 'price', header: '価格', accessor: 'price' }
		];
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: linkColumns,
			getRowId,
			selectable: true,
			onSelectionChange
		});
		const clicked = vi.fn((event: Event) => event.preventDefault());
		const link = container.querySelector<HTMLAnchorElement>('[data-cell-row="0"] a.cell-link')!;
		link.addEventListener('click', clicked);
		const grid = screen.getByRole('grid');

		await fireEvent.pointerDown(
			container.querySelector('[data-cell-row="0"][data-cell-field="name"]')!
		);
		await fireEvent.keyDown(grid, { key: ' ' });
		expect(clicked).toHaveBeenCalledTimes(1);
		expect(onSelectionChange).not.toHaveBeenCalled();

		// The next cell of the same row has no control: Space selects.
		await fireEvent.keyDown(grid, { key: 'ArrowRight' });
		await fireEvent.keyDown(grid, { key: ' ' });
		expect(onSelectionChange).toHaveBeenLastCalledWith([1]);
	});

	it('Space on an editable cell selects the row and does not start editing', async () => {
		const onSelectionChange = vi.fn();
		const editable: GridColumn<Row>[] = [
			{ id: 'name', header: '商品名', accessor: 'name', editable: true },
			{ id: 'price', header: '価格', accessor: 'price' }
		];
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: editable,
			getRowId,
			selectable: true,
			onSelectionChange
		});
		await fireEvent.pointerDown(
			container.querySelector('[data-cell-row="2"][data-cell-field="name"]')!
		);
		await fireEvent.keyDown(screen.getByRole('grid'), { key: ' ' });
		expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
		expect(container.querySelector('.cell.editing')).toBeNull();
	});

	it('a press on the checkbox column makes that row the active one', async () => {
		const onSelectionChange = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			selectable: true,
			onSelectionChange
		});
		const cell = rowBox('消しゴム').closest('.select-cell')!;
		await fireEvent.pointerDown(cell);
		expect(container.querySelector('.cell.active')?.getAttribute('data-cell-row')).toBe('2');
		// The mousedown default (moving focus to the checkbox) is prevented.
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		cell.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(true);
	});

	it('clear button empties the selection and returns focus to the grid', async () => {
		const onSelectionChange = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			selectable: true,
			selectedRowIds: [1, 3],
			onSelectionChange
		});
		expect(screen.getByRole('group', { name: '一括操作' }).textContent).toContain('2件を選択中');
		const clear = screen.getByRole('button', { name: '選択を解除' });
		clear.focus();
		await fireEvent.click(clear);
		expect(onSelectionChange).toHaveBeenLastCalledWith([]);
		expect(container.querySelector('.bulk-bar')).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('grid'));
	});

	it('hands the selected ids and clear() to the bulkActions snippet', async () => {
		let received: GridBulkActionsContext | undefined;
		const bulkActions = createRawSnippet<[GridBulkActionsContext]>((context) => ({
			render: () => `<button type="button">一括</button>`,
			setup: (node) => {
				node.addEventListener('click', () => {
					received = context();
				});
			}
		}));
		const onSelectionChange = vi.fn();
		render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			selectable: true,
			selectedRowIds: [2],
			bulkActions,
			onSelectionChange
		});
		await fireEvent.click(screen.getByRole('button', { name: '一括' }));
		expect(received?.ids).toEqual([2]);
		received!.clear();
		await tick();
		expect(onSelectionChange).toHaveBeenLastCalledWith([]);
	});

	describe('focus when the bar disappears without clear()', () => {
		function setup() {
			let ctx: GridBulkActionsContext | undefined;
			const bulkActions = createRawSnippet<[GridBulkActionsContext]>((context) => ({
				render: () => `<button type="button">一括</button>`,
				setup: () => {
					ctx = context();
				}
			}));
			const result = render(BantoGrid<Row>, {
				rows,
				columns,
				getRowId,
				selectable: true,
				selectedRowIds: [1],
				bulkActions
			});
			return { ...result, context: () => ctx! };
		}

		it('returns focus to the grid when a reload drops the selected rows, and clear() stays safe', async () => {
			const { container, rerender, context } = setup();
			const button = screen.getByRole('button', { name: '一括' });
			button.focus();
			expect(document.activeElement).toBe(button);
			const ctx = context();
			await rerender({ rows: rows.filter((row) => row.id !== 1) });
			await tick();
			expect(container.querySelector('.bulk-bar')).toBeNull();
			expect(document.activeElement).toBe(screen.getByRole('grid'));
			expect(() => ctx.clear()).not.toThrow();
			expect(document.activeElement).toBe(screen.getByRole('grid'));
		});

		it('does not steal focus that already moved outside the bar', async () => {
			const { container, rerender } = setup();
			const outside = document.createElement('input');
			document.body.appendChild(outside);
			try {
				screen.getByRole('button', { name: '一括' }).focus();
				outside.focus();
				await rerender({ rows: rows.filter((row) => row.id !== 1) });
				await tick();
				expect(container.querySelector('.bulk-bar')).toBeNull();
				expect(document.activeElement).toBe(outside);
			} finally {
				outside.remove();
			}
		});
	});

	it('client mode: a selected row that a filter removes from the list is deselected', async () => {
		const gridState = new GridState<Row>(columns);
		const onSelectionChange = vi.fn();
		render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			state: gridState,
			selectable: true,
			selectedRowIds: [1, 2],
			onSelectionChange
		});
		gridState.setFilter({ field: 'name', op: 'contains', value: 'ノ' });
		await tick();
		expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
		expect(headerBox().getAttribute('aria-label')).toBe('一覧の1件をすべて選択');
		expect(headerBox().checked).toBe(true);
	});

	it('client mode: sorting or hiding a column keeps the selection', async () => {
		const gridState = new GridState<Row>(columns);
		const onSelectionChange = vi.fn();
		render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			state: gridState,
			selectable: true,
			selectedRowIds: [1, 2],
			onSelectionChange
		});
		gridState.toggleSort('price', false);
		gridState.setColumnHidden('name', true);
		await tick();
		expect(onSelectionChange).not.toHaveBeenCalled();
		// The row label falls back to the first column still visible.
		expect((screen.getByRole('checkbox', { name: '100を選択' }) as HTMLInputElement).checked).toBe(
			true
		);
	});

	it('grouped: rows keep their checkbox, group headers have none, Space on a header toggles the group', async () => {
		const gridState = new GridState<Row>(columns);
		gridState.setGroupBy('name');
		const onSelectionChange = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			state: gridState,
			selectable: true,
			onSelectionChange
		});
		expect(container.querySelectorAll('.group-header-row input')).toHaveLength(0);
		expect(screen.getAllByRole('checkbox', { name: /を選択$/ })).toHaveLength(3);
		await fireEvent.click(container.querySelector('.group-header-row')!);
		expect(onSelectionChange).not.toHaveBeenCalled();
		// Collapsing a group does not deselect its rows, and "select all" still covers them.
		await fireEvent.click(headerBox());
		expect(onSelectionChange).toHaveBeenLastCalledWith(expect.arrayContaining([1, 2, 3]));
	});

	it('server mode: "select all" covers only the loaded rows and a filter change clears', async () => {
		const sparse: (Row | undefined)[] = [];
		sparse[0] = rows[0];
		sparse[1] = rows[1];
		const gridState = new GridState<Row>(columns);
		const onSelectionChange = vi.fn();
		render(BantoGrid<Row>, {
			rows: sparse,
			columns,
			getRowId,
			state: gridState,
			mode: 'server',
			totalRows: 50,
			selectable: true,
			onSelectionChange
		});
		const header = headerBox();
		expect(header.getAttribute('aria-label')).toBe('読み込み済みの2件をすべて選択（全50件のうち）');
		await fireEvent.click(header);
		expect(onSelectionChange).toHaveBeenLastCalledWith([1, 2]);

		gridState.toggleSort('price', false);
		await tick();
		expect(onSelectionChange).toHaveBeenCalledTimes(1);

		gridState.setFilter({ field: 'name', op: 'contains', value: 'ノ' });
		await tick();
		expect(onSelectionChange).toHaveBeenLastCalledWith([]);
	});
});
