// @vitest-environment jsdom
/**
 * Issue #1036: the active cell stays where it was while the user scrolls with
 * the wheel or the scrollbar. An action key (Enter, Space, F2, the row menu
 * keys) pressed while that cell is off screen only scrolls to it; pressed
 * again it acts. Keys that move the active cell are unchanged.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { cellInViewHorizontally } from '../src/core/pinning';
import { defaultGridMessages } from '../src/messages';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

const ROW = 32;
/**
 * The header row is `position: sticky; top: 0`: it does not scroll away, it
 * covers the top `HEADER` px of the grid. Rows are laid out from 0 right
 * after it, so the rows on screen are `[scrollTop, scrollTop + ROWS_VIEWPORT)`
 * (measured in a real browser, #1036). Taller than a row on purpose: a row
 * wholly behind the header must not pass for one in view.
 */
const HEADER = 40;
const VIEWPORT = 400;
const ROWS_VIEWPORT = VIEWPORT - HEADER;
let clientWidth = 0;

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	// jsdom has no layout; match the viewport stubs in BantoGrid.test.ts.
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get: () => VIEWPORT
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get: () => HEADER
	});
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => clientWidth
	});
});
beforeEach(() => {
	clientWidth = 0;
});
afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	category: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', width: 200 },
	{ id: 'category', header: 'Category', accessor: 'category', width: 200 }
];
const wideColumns: GridColumn<Row>[] = [
	...columns,
	{ id: 'c3', header: 'C3', accessor: 'name', width: 200 },
	{ id: 'c4', header: 'C4', accessor: 'name', width: 200 }
];

function makeRows(count: number): Row[] {
	return Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		name: `Name ${i + 1}`,
		category: i % 2 === 0 ? 'Odd' : 'Even'
	}));
}

function cellAt(container: HTMLElement, rowIndex: number, field: string): HTMLElement {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${rowIndex}"][data-cell-field="${field}"]`
	)!;
}

async function scrollTo(grid: HTMLElement, top: number, left = 0) {
	grid.scrollTop = top;
	grid.scrollLeft = left;
	await fireEvent.scroll(grid);
}

function statusText(container: HTMLElement): string {
	return container.querySelector('[role="status"]')!.textContent ?? '';
}

const SCROLLED = defaultGridMessages.scrolledToActiveCell();

describe('cellInViewHorizontally (#1036)', () => {
	const base = { cellLeft: 400, cellWidth: 100, viewportWidth: 300, pinnedWidth: 0 };

	it('is true while any part of the cell is in the viewport', () => {
		expect(cellInViewHorizontally({ ...base, scrollLeft: 200, cellPinned: false })).toBe(true);
		// A sliver on either side.
		expect(cellInViewHorizontally({ ...base, scrollLeft: 101, cellPinned: false })).toBe(true);
		expect(cellInViewHorizontally({ ...base, scrollLeft: 499, cellPinned: false })).toBe(true);
	});

	it('is false once the cell is wholly out, on either side', () => {
		expect(cellInViewHorizontally({ ...base, scrollLeft: 100, cellPinned: false })).toBe(false);
		expect(cellInViewHorizontally({ ...base, scrollLeft: 500, cellPinned: false })).toBe(false);
	});

	it('counts the part under the pinned block as out of view, and a pinned cell as in view', () => {
		const pinned = { ...base, pinnedWidth: 120, scrollLeft: 400 };
		// 400..500 on a viewport whose free part starts at 400 + 120.
		expect(cellInViewHorizontally({ ...pinned, cellPinned: false })).toBe(false);
		expect(cellInViewHorizontally({ ...pinned, scrollLeft: 379, cellPinned: false })).toBe(true);
		expect(cellInViewHorizontally({ ...pinned, cellPinned: true })).toBe(true);
	});

	it('counts a viewport that was never measured as in view', () => {
		expect(
			cellInViewHorizontally({ ...base, viewportWidth: 0, scrollLeft: 9_999, cellPinned: false })
		).toBe(true);
	});
});

describe('BantoGrid action keys while the active cell is off screen (#1036)', () => {
	function renderGrid(props: Record<string, unknown> = {}) {
		const opened: Row[] = [];
		const result = render(BantoGrid<Row>, {
			rows: makeRows(1_000),
			columns,
			rowHeight: ROW,
			getRowId: (row: Row) => row.id,
			onRowClick: (row: Row) => opened.push(row),
			...props
		});
		return { ...result, opened, grid: screen.getByRole('grid') };
	}

	it('Enter only scrolls to the active cell (outside the virtualized window), then opens the row', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		await scrollTo(grid, 500 * ROW);
		expect(container.querySelector('.row.outside-window')).not.toBeNull();

		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened).toEqual([]);
		// Row 1 is the first row under the sticky header again.
		expect(grid.scrollTop).toBe(1 * ROW);
		expect(statusText(container)).toBe(SCROLLED);
		// The active cell did not move.
		expect(cellAt(container, 1, 'name').classList.contains('active')).toBe(true);

		await fireEvent.scroll(grid);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([2]);
	});

	it('acts on the second press even before the scroll event of the first one arrives', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		await scrollTo(grid, 500 * ROW);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([2]);
	});

	it('holds Enter back for a row that is drawn (overscan) but wholly behind the sticky header', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 0, 'name'));
		// Row 0 (0..32) is covered by the header: the grid is scrolled by less
		// than the header's height, and still nothing of the row shows.
		expect(ROW).toBeLessThan(HEADER);
		await scrollTo(grid, ROW);
		expect(container.querySelector('.row.outside-window')).toBeNull();
		expect(cellAt(container, 0, 'name')).not.toBeNull();

		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened).toEqual([]);
		// Row 0 right under the header.
		expect(grid.scrollTop).toBe(0);
		expect(statusText(container)).toBe(SCROLLED);

		await fireEvent.keyUp(grid, { key: 'Enter' });
		await fireEvent.scroll(grid);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([1]);
	});

	it('acts at once while a part of the active row shows just under the header', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 0, 'name'));
		// The last pixel of row 0 is below the header.
		await scrollTo(grid, ROW - 1);

		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([1]);
		expect(grid.scrollTop).toBe(ROW - 1);
		expect(statusText(container)).toBe('');
	});

	it('judges the bottom edge without the header: the viewport of the rows is shorter by it', async () => {
		const { container, grid, opened } = renderGrid();
		// Rows show in 0..360: row 11 (352..384) has a part in view, row 12
		// (384..416) has none, although 384 is less than the grid's 400.
		expect(ROWS_VIEWPORT).toBe(360);
		await fireEvent.pointerDown(cellAt(container, 11, 'name'));
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([12]);
		expect(grid.scrollTop).toBe(0);

		await fireEvent.pointerDown(cellAt(container, 12, 'name'));
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([12]);
		expect(grid.scrollTop).toBe(13 * ROW - ROWS_VIEWPORT);
		expect(statusText(container)).toBe(SCROLLED);
	});

	it('ArrowUp to the row above shows it under the header, not behind it', async () => {
		const { container, grid } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 5, 'name'));
		// Row 5 is the first row under the header.
		await scrollTo(grid, 5 * ROW);
		await fireEvent.keyDown(grid, { key: 'ArrowUp' });
		expect(cellAt(container, 4, 'name').classList.contains('active')).toBe(true);
		expect(grid.scrollTop).toBe(4 * ROW);
	});

	it('a held key does not act: its repeats are swallowed until it is released', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		await scrollTo(grid, 500 * ROW);

		await fireEvent.keyDown(grid, { key: 'Enter' });
		await fireEvent.scroll(grid);
		for (let i = 0; i < 3; i++) {
			const notPrevented = await fireEvent.keyDown(grid, { key: 'Enter', repeat: true });
			expect(notPrevented).toBe(false);
		}
		expect(opened).toEqual([]);
		expect(grid.scrollTop).toBe(1 * ROW);

		await fireEvent.keyUp(grid, { key: 'Enter' });
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([2]);
		// In view and pressed on its own: a repeat is the usual repeat again.
		await fireEvent.keyDown(grid, { key: 'Enter', repeat: true });
		expect(opened.map((row) => row.id)).toEqual([2, 2]);
	});

	it('a new press acts even when the keyup was not seen (it is not a repeat)', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		await scrollTo(grid, 500 * ROW);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		await fireEvent.keyDown(grid, { key: 'Enter', repeat: true });
		expect(opened).toEqual([]);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([2]);
	});

	it('holding Space does not toggle the selection, and another key is not held back', async () => {
		const { container, grid } = renderGrid({ selectable: true, onRowClick: undefined });
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		const checked = () => container.querySelectorAll('.row input[type="checkbox"]:checked').length;
		await scrollTo(grid, 500 * ROW);

		await fireEvent.keyDown(grid, { key: ' ' });
		await fireEvent.scroll(grid);
		await fireEvent.keyDown(grid, { key: ' ', repeat: true });
		await fireEvent.keyDown(grid, { key: ' ', repeat: true });
		expect(checked()).toBe(0);

		// A different key while Space is still down is a press of its own.
		await fireEvent.keyDown(grid, { key: 'ArrowDown' });
		expect(cellAt(container, 2, 'name').classList.contains('active')).toBe(true);
		await fireEvent.keyDown(grid, { key: ' ' });
		expect(checked()).toBe(1);
	});

	it('holds Enter back for a row below the viewport, and scrolls it to the bottom edge', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 3, 'name'));
		for (let i = 0; i < 3; i++) {
			await fireEvent.keyDown(grid, { key: 'PageDown' });
			await fireEvent.scroll(grid);
		}
		const active = Number(
			container.querySelector<HTMLElement>('.cell.active')!.getAttribute('data-cell-row')
		);
		expect(active).toBeGreaterThan(20);
		await scrollTo(grid, 0);

		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened).toEqual([]);
		// The row's bottom edge at the viewport's.
		expect(grid.scrollTop).toBe((active + 1) * ROW - ROWS_VIEWPORT);
	});

	it('arrow keys move from the active cell as before, with no announcement', async () => {
		const { container, grid, opened } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		await scrollTo(grid, 500 * ROW);

		await fireEvent.keyDown(grid, { key: 'ArrowDown' });
		expect(grid.scrollTop).toBe(2 * ROW);
		await fireEvent.scroll(grid);
		expect(cellAt(container, 2, 'name').classList.contains('active')).toBe(true);
		expect(statusText(container)).toBe('');
		expect(opened).toEqual([]);

		// In view now: Enter acts on the first press.
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([3]);
	});

	it('Space and Shift+Space do not toggle the row selection until the row is shown', async () => {
		const { container, grid } = renderGrid({ selectable: true, onRowClick: undefined });
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		const checked = () => container.querySelectorAll('.row input[type="checkbox"]:checked').length;

		await scrollTo(grid, 500 * ROW);
		await fireEvent.keyDown(grid, { key: ' ' });
		expect(checked()).toBe(0);
		expect(statusText(container)).toBe(SCROLLED);
		expect(grid.scrollTop).toBe(1 * ROW);

		await scrollTo(grid, 500 * ROW);
		await fireEvent.keyDown(grid, { key: ' ', shiftKey: true });
		expect(checked()).toBe(0);

		await fireEvent.scroll(grid);
		await fireEvent.keyDown(grid, { key: ' ' });
		expect(checked()).toBe(1);
	});

	it('Enter and F2 do not start editing until the cell is shown', async () => {
		const editable: GridColumn<Row>[] = columns.map((column) => ({ ...column, editable: true }));
		const { container, grid } = renderGrid({
			columns: editable,
			onRowClick: undefined,
			onCellEdit: async () => {}
		});
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		const editor = () => container.querySelector('.cell input, .cell textarea');

		for (const key of ['F2', 'Enter']) {
			await scrollTo(grid, 500 * ROW);
			await fireEvent.keyDown(grid, { key });
			expect(editor()).toBeNull();
			expect(grid.scrollTop).toBe(1 * ROW);
		}

		await fireEvent.scroll(grid);
		await fireEvent.keyDown(grid, { key: 'F2' });
		expect(editor()).not.toBeNull();
	});

	it('the row menu keys do not open the menu until the row is shown', async () => {
		const menus: Row[] = [];
		const { container, grid } = renderGrid({
			onRowContextMenu: (row: Row) => menus.push(row)
		});
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));

		await scrollTo(grid, 500 * ROW);
		await fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
		expect(menus).toEqual([]);
		expect(grid.scrollTop).toBe(1 * ROW);

		await scrollTo(grid, 500 * ROW);
		await fireEvent.keyDown(grid, { key: 'ContextMenu' });
		expect(menus).toEqual([]);

		await fireEvent.scroll(grid);
		await fireEvent.keyDown(grid, { key: 'ContextMenu' });
		expect(menus.map((row) => row.id)).toEqual([2]);
	});

	it('leaves the menu key to the browser when no row menu is wired', async () => {
		const { container, grid } = renderGrid();
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		await scrollTo(grid, 500 * ROW);
		const notPrevented = await fireEvent.keyDown(grid, { key: 'ContextMenu' });
		expect(notPrevented).toBe(true);
		expect(grid.scrollTop).toBe(500 * ROW);
		expect(statusText(container)).toBe('');
	});

	it('holds Enter back for a column scrolled out sideways, and scrolls back to it', async () => {
		clientWidth = 300;
		const { container, grid, opened } = renderGrid({ columns: wideColumns });
		await fireEvent.pointerDown(cellAt(container, 0, 'name'));

		// A part of the column still in view: acts at once.
		await scrollTo(grid, 0, 199);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([1]);

		await scrollTo(grid, 0, 400);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened).toHaveLength(1);
		expect(grid.scrollLeft).toBe(0);
		expect(statusText(container)).toBe(SCROLLED);

		await fireEvent.scroll(grid);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(opened.map((row) => row.id)).toEqual([1, 1]);
	});

	it('toggles a group header in view at once, whatever the horizontal scroll', async () => {
		clientWidth = 300;
		const state = new GridState(wideColumns);
		state.groupBy = 'category';
		const { container, grid } = renderGrid({
			rows: makeRows(6),
			columns: wideColumns,
			state,
			onRowClick: undefined
		});
		// Display index 0 is the first group header, 1 its first row.
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		await fireEvent.keyDown(grid, { key: 'ArrowUp' });
		const before = container.querySelectorAll('.row').length;

		await scrollTo(grid, 0, 400);
		await fireEvent.keyDown(grid, { key: 'Enter' });
		expect(container.querySelectorAll('.row').length).toBeLessThan(before);
		expect(statusText(container)).toBe('');
	});
});
