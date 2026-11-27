// @vitest-environment jsdom
/**
 * #784: `onRowContextMenu` - the row's context menu from a right-click or the
 * ContextMenu key / Shift+F10. Same contract as BantoTree's `onContextMenu`:
 * opt-in `preventDefault`, focus (the active cell) follows the click before the
 * callback, the row selection is left alone. Same jsdom stubs as
 * row-selection.test.ts so rows virtualize into view.
 */
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
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
		get: () => 400
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get: () => 32
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
	{ id: 'name', header: '商品名', accessor: 'name', editable: true },
	{ id: 'price', header: '価格', accessor: 'price' }
];
const getRowId = (row: Row) => row.id;

function cellOf(container: HTMLElement, row: number, field: string): HTMLElement {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${row}"][data-cell-field="${field}"]`
	)!;
}

/** Dispatches a contextmenu event and reports whether the default was prevented. */
function rightClick(target: HTMLElement, init: MouseEventInit = {}): boolean {
	const event = createEvent.contextMenu(target, { clientX: 40, clientY: 50, ...init });
	target.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('BantoGrid onRowContextMenu (#784)', () => {
	it('leaves the browser menu alone when not provided', () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		expect(rightClick(cellOf(container, 0, 'price'))).toBe(false);
	});

	it('calls back with the row and the pointer position, and suppresses the default menu', () => {
		const onRowContextMenu = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
		expect(rightClick(cellOf(container, 1, 'price'))).toBe(true);
		expect(onRowContextMenu).toHaveBeenCalledTimes(1);
		expect(onRowContextMenu).toHaveBeenCalledWith(rows[1], { x: 40, y: 50 });
	});

	it('moves the active cell and focus to the clicked cell, focus before the callback', async () => {
		const seen: boolean[] = [];
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			// Focus is synchronous, so it is observable inside the callback.
			onRowContextMenu: () => seen.push(document.activeElement === screen.getByRole('grid'))
		});
		rightClick(cellOf(container, 2, 'price'));
		expect(seen).toEqual([true]);
		await tick();
		expect(cellOf(container, 2, 'price').classList.contains('active')).toBe(true);
	});

	it('does not change the row selection', async () => {
		const onSelectionChange = vi.fn();
		const onRowContextMenu = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			selectable: true,
			onSelectionChange,
			onRowContextMenu
		});
		await fireEvent.click(screen.getByRole('checkbox', { name: 'ペンを選択' }));
		onSelectionChange.mockClear();
		rightClick(cellOf(container, 2, 'price'));
		expect(onRowContextMenu).toHaveBeenCalledWith(rows[2], expect.anything());
		expect(onSelectionChange).not.toHaveBeenCalled();
		const box = (name: string) =>
			screen.getByRole('checkbox', { name: `${name}を選択` }) as HTMLInputElement;
		expect(box('ペン').checked).toBe(true);
		expect(box('消しゴム').checked).toBe(false);
	});

	it('keeps the cell range when right-clicking inside it, collapses outside it', async () => {
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			onRowContextMenu: vi.fn()
		});
		await fireEvent.pointerDown(cellOf(container, 0, 'name'), { button: 0, pointerId: 1 });
		await fireEvent.pointerDown(cellOf(container, 1, 'price'), {
			button: 0,
			pointerId: 1,
			shiftKey: true
		});
		const inRange = () => container.querySelectorAll('.cell[aria-selected="true"]').length;
		expect(inRange()).toBe(4);
		rightClick(cellOf(container, 0, 'price'));
		await tick();
		expect(inRange()).toBe(4);
		expect(cellOf(container, 0, 'price').classList.contains('active')).toBe(true);
		rightClick(cellOf(container, 2, 'price'));
		await tick();
		expect(inRange()).toBe(1);
		expect(cellOf(container, 2, 'price').classList.contains('active')).toBe(true);
	});

	it('opens from the ContextMenu key and Shift+F10, but not bare F10', async () => {
		const onRowContextMenu = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
		const grid = screen.getByRole('grid');
		await fireEvent.pointerDown(cellOf(container, 1, 'price'), { button: 0, pointerId: 1 });

		await fireEvent.keyDown(grid, { key: 'F10' });
		expect(onRowContextMenu).not.toHaveBeenCalled();

		// fireEvent resolves to false when the default was prevented.
		expect(await fireEvent.keyDown(grid, { key: 'ContextMenu' })).toBe(false);
		expect(onRowContextMenu).toHaveBeenLastCalledWith(rows[1], { x: 0, y: 0 });

		await fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
		expect(onRowContextMenu).toHaveBeenCalledTimes(2);
	});

	it('uses the active cell left / bottom edge as the keyboard position', async () => {
		const onRowContextMenu = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
		const cell = cellOf(container, 0, 'price');
		cell.getBoundingClientRect = () => ({ left: 120, bottom: 64 }) as DOMRect;
		await fireEvent.pointerDown(cell, { button: 0, pointerId: 1 });
		await fireEvent.keyDown(screen.getByRole('grid'), { key: 'ContextMenu' });
		expect(onRowContextMenu).toHaveBeenCalledWith(rows[0], { x: 120, y: 64 });
	});

	it('does not suppress the ContextMenu key when not provided', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		await fireEvent.pointerDown(cellOf(container, 1, 'price'), { button: 0, pointerId: 1 });
		expect(await fireEvent.keyDown(screen.getByRole('grid'), { key: 'ContextMenu' })).toBe(true);
	});

	it('keeps the native text menu inside the cell editor and is silent while editing', async () => {
		const onRowContextMenu = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
		await fireEvent.doubleClick(cellOf(container, 0, 'name'));
		const editor = screen.getByRole('textbox') as HTMLInputElement;
		expect(rightClick(editor)).toBe(false);
		await fireEvent.keyDown(editor, { key: 'ContextMenu' });
		await fireEvent.keyDown(screen.getByRole('grid'), { key: 'F10', shiftKey: true });
		expect(onRowContextMenu).not.toHaveBeenCalled();
	});

	it('is not called for a group header', async () => {
		const gridState = new GridState<Row>(columns);
		gridState.setGroupBy('name');
		const onRowContextMenu = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			state: gridState,
			onRowContextMenu
		});
		const header = container.querySelector<HTMLElement>('.group-header-row')!;
		expect(rightClick(header)).toBe(false);
		// Put the active cell on the header (one row above the first data row).
		await fireEvent.pointerDown(cellOf(container, 1, 'price'), { button: 0, pointerId: 1 });
		const grid = screen.getByRole('grid');
		await fireEvent.keyDown(grid, { key: 'ArrowUp' });
		await fireEvent.keyDown(grid, { key: 'ContextMenu' });
		expect(onRowContextMenu).not.toHaveBeenCalled();
	});

	it('is not called for an empty grid', async () => {
		const onRowContextMenu = vi.fn();
		render(BantoGrid<Row>, { rows: [] as Row[], columns, getRowId, onRowContextMenu });
		await fireEvent.keyDown(screen.getByRole('grid'), { key: 'ContextMenu' });
		expect(onRowContextMenu).not.toHaveBeenCalled();
	});

	describe('without a pointer (no active cell yet)', () => {
		// #1016: focusing the grid element already puts the cursor on the first
		// cell, so the first arrow key moves from there (the #784 "enters without
		// moving" rule no longer applies once the grid has taken the focus).
		it('focus enters the first cell, the first arrow key moves; Shift+F10 then opens that row menu', async () => {
			const onRowContextMenu = vi.fn();
			const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
			const grid = screen.getByRole('grid');
			grid.focus();
			await tick();
			expect(cellOf(container, 0, 'name').classList.contains('active')).toBe(true);
			const down = createEvent.keyDown(grid, { key: 'ArrowDown' });
			grid.dispatchEvent(down);
			await tick();
			expect(down.defaultPrevented).toBe(true);
			expect(cellOf(container, 1, 'name').classList.contains('active')).toBe(true);
			expect(onRowContextMenu).not.toHaveBeenCalled();
			await fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
			await tick();
			expect(onRowContextMenu).toHaveBeenCalledTimes(1);
			expect(onRowContextMenu.mock.calls[0][0]).toBe(rows[1]);
		});

		// A key that arrives with no focus event before it (no cursor placed
		// yet) still only enters the first cell.
		it('without a focus event, the first arrow key enters the first cell without moving; Shift+F10 then opens the menu', async () => {
			const onRowContextMenu = vi.fn();
			const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
			const grid = screen.getByRole('grid');
			const down = createEvent.keyDown(grid, { key: 'ArrowDown' });
			grid.dispatchEvent(down);
			await tick();
			expect(down.defaultPrevented).toBe(true);
			expect(cellOf(container, 0, 'name').classList.contains('active')).toBe(true);
			expect(onRowContextMenu).not.toHaveBeenCalled();
			await fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
			await tick();
			expect(onRowContextMenu).toHaveBeenCalledTimes(1);
			expect(onRowContextMenu.mock.calls[0][0]).toBe(rows[0]);
		});

		it('a grid without onRowContextMenu also enters the first cell on an arrow key', async () => {
			const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
			await fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowRight' });
			expect(cellOf(container, 0, 'name').classList.contains('active')).toBe(true);
		});

		it('the ContextMenu key straight away enters the first cell and opens the menu', async () => {
			const onRowContextMenu = vi.fn();
			const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
			await fireEvent.keyDown(screen.getByRole('grid'), { key: 'ContextMenu' });
			await tick();
			expect(onRowContextMenu).toHaveBeenCalledTimes(1);
			expect(onRowContextMenu.mock.calls[0][0]).toBe(rows[0]);
			expect(cellOf(container, 0, 'name').classList.contains('active')).toBe(true);
		});

		it('ContextMenu without onRowContextMenu does nothing and is not suppressed', async () => {
			const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
			const grid = screen.getByRole('grid');
			const event = createEvent.keyDown(grid, { key: 'ContextMenu' });
			grid.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
			expect(container.querySelector('.cell.active')).toBeNull();
		});

		it('skips the group header and lands on the first data row', async () => {
			const gridState = new GridState<Row>(columns);
			gridState.setGroupBy('name');
			const onRowContextMenu = vi.fn();
			render(BantoGrid<Row>, { rows, columns, getRowId, state: gridState, onRowContextMenu });
			await fireEvent.keyDown(screen.getByRole('grid'), { key: 'ContextMenu' });
			await tick();
			expect(onRowContextMenu).toHaveBeenCalledTimes(1);
			expect(onRowContextMenu.mock.calls[0][0]).toBe(rows[0]);
		});

		it('server mode: lands on the first loaded slot, looking only at loaded slots', async () => {
			const sparse: Row[] = [];
			sparse[3] = rows[1];
			sparse[7] = rows[2];
			const onRowContextMenu = vi.fn();
			render(BantoGrid<Row>, {
				mode: 'server',
				totalRows: 50_000_000,
				rows: sparse,
				columns,
				getRowId,
				onRowContextMenu
			});
			await fireEvent.keyDown(screen.getByRole('grid'), { key: 'ContextMenu' });
			await tick();
			expect(onRowContextMenu).toHaveBeenCalledTimes(1);
			expect(onRowContextMenu.mock.calls[0][0]).toBe(rows[1]);
		});

		it('server mode: no loaded row in view - the menu key waits, an arrow key enters the first loaded row', async () => {
			const sparse: Row[] = [];
			sparse[2] = rows[1];
			sparse[900] = rows[2];
			const onRowContextMenu = vi.fn();
			const state = new GridState<Row>(columns);
			render(BantoGrid<Row>, {
				mode: 'server',
				totalRows: 1000,
				rows: sparse,
				columns,
				getRowId,
				state,
				onRowContextMenu
			});
			const grid = screen.getByRole('grid');
			// View from row 10: nothing loaded there (2 is above, 900 far below).
			grid.scrollTop = 10 * state.rowHeight + 32;
			await fireEvent.scroll(grid);
			const menu = createEvent.keyDown(grid, { key: 'ContextMenu' });
			grid.dispatchEvent(menu);
			await tick();
			expect(menu.defaultPrevented).toBe(false);
			expect(onRowContextMenu).not.toHaveBeenCalled();
			// Never the far row 900: an arrow key enters the first loaded row (2).
			await fireEvent.keyDown(grid, { key: 'ArrowDown' });
			await fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
			await tick();
			expect(onRowContextMenu).toHaveBeenCalledTimes(1);
			expect(onRowContextMenu.mock.calls[0][0]).toBe(rows[1]);
		});

		it('client mode: the menu key picks the first data row in view after scrolling', async () => {
			const many: Row[] = Array.from({ length: 200 }, (_, i) => ({
				id: i + 1,
				name: `n${i}`,
				price: i
			}));
			const onRowContextMenu = vi.fn();
			const state = new GridState<Row>(columns);
			const { container } = render(BantoGrid<Row>, {
				rows: many,
				columns,
				getRowId,
				state,
				onRowContextMenu
			});
			const grid = screen.getByRole('grid');
			// The header probe is 32px tall in these stubs.
			grid.scrollTop = 50 * state.rowHeight + 32;
			await fireEvent.scroll(grid);
			await fireEvent.keyDown(grid, { key: 'ContextMenu' });
			await tick();
			expect(onRowContextMenu).toHaveBeenCalledTimes(1);
			expect(onRowContextMenu.mock.calls[0][0]).toBe(many[50]);
			expect(cellOf(container, 50, 'name').classList.contains('active')).toBe(true);
		});

		it('server mode: nothing loaded yet does nothing', async () => {
			const onRowContextMenu = vi.fn();
			render(BantoGrid<Row>, {
				mode: 'server',
				totalRows: 50_000_000,
				rows: [] as Row[],
				columns,
				getRowId,
				onRowContextMenu
			});
			const grid = screen.getByRole('grid');
			const event = createEvent.keyDown(grid, { key: 'ArrowDown' });
			grid.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
			expect(onRowContextMenu).not.toHaveBeenCalled();
		});

		it('does nothing for an empty grid', async () => {
			const onRowContextMenu = vi.fn();
			render(BantoGrid<Row>, { rows: [] as Row[], columns, getRowId, onRowContextMenu });
			const grid = screen.getByRole('grid');
			const event = createEvent.keyDown(grid, { key: 'ArrowDown' });
			grid.dispatchEvent(event);
			await fireEvent.keyDown(grid, { key: 'ContextMenu' });
			await tick();
			expect(event.defaultPrevented).toBe(false);
			expect(onRowContextMenu).not.toHaveBeenCalled();
		});
	});
});
