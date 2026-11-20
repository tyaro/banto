// @vitest-environment jsdom
/**
 * #713: columns pinned to the left edge. The pure decisions (offsets, the
 * drag zones, how far to scroll) are covered in pinning.test.ts; this file
 * covers GridState's `pinned` and the wiring in BantoGrid / HeaderCell.
 * Same jsdom stubs as BantoGrid.test.ts so rows virtualize into view, plus a
 * `clientWidth` the test can change (jsdom has no layout).
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

let clientWidth = 600;

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
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return clientWidth;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get() {
			return 32;
		}
	});
});

beforeEach(() => {
	clientWidth = 600;
});

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	category: string;
	price: number;
}

const rows: Row[] = [
	{ id: 1, name: 'ペン', category: '文具', price: 300 },
	{ id: 2, name: 'ノート', category: '文具', price: 100 },
	{ id: 3, name: 'お茶', category: '飲料', price: 200 }
];

/** `name` is pinned although it is defined second. Widths: 80 / 100 / 200 / 300. */
const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id', width: 80 },
	{ id: 'name', header: '商品名', accessor: 'name', width: 100, pinned: 'left' },
	{ id: 'category', header: '分類', accessor: 'category', width: 200 },
	{ id: 'price', header: '価格', accessor: 'price', width: 300 }
];

const getRowId = (row: Row) => row.id;

function cellOf(container: HTMLElement, field: string, rowIndex = 0): HTMLElement {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${rowIndex}"][data-cell-field="${field}"]`
	)!;
}

function headers(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('.header-cell')];
}

describe('GridState.pinned (#713)', () => {
	it('seeds from the definitions and shows the pinned columns first', () => {
		const state = new GridState(columns);
		expect(state.pinned).toEqual(['name']);
		expect(state.isPinned('name')).toBe(true);
		expect(state.pinnedCount).toBe(1);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['name', 'id', 'category', 'price']);
		expect(state.allColumns.map((c) => c.id)).toEqual(['name', 'id', 'category', 'price']);
		// `order` itself is untouched: unpinning puts the column back.
		expect(state.order).toEqual(['id', 'name', 'category', 'price']);
	});

	it('pins and unpins, returning the column to its own slot', () => {
		const state = new GridState(columns);
		state.setColumnPinned('price', true);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['name', 'price', 'id', 'category']);
		expect(state.pinnedCount).toBe(2);
		state.toggleColumnPinned('name');
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['price', 'id', 'name', 'category']);
		state.setColumnPinned('price', false);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['id', 'name', 'category', 'price']);
		expect(state.pinnedCount).toBe(0);
	});

	it('ignores unknown ids and repeated calls', () => {
		const state = new GridState(columns);
		state.setColumnPinned('missing', true);
		state.setColumnPinned('name', true);
		expect(state.pinned).toEqual(['name']);
	});

	it('does not count a hidden pinned column, and brings it back pinned', () => {
		const state = new GridState(columns);
		state.setColumnHidden('name', true);
		expect(state.pinnedCount).toBe(0);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['id', 'category', 'price']);
		expect(state.isPinned('name')).toBe(true);
		state.setColumnHidden('name', false);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['name', 'id', 'category', 'price']);
	});

	it('keeps a dragged column inside its zone', () => {
		const state = new GridState(columns);
		state.setColumnPinned('category', true); // display: name category | id price
		state.moveColumn('category', 0);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['category', 'name', 'id', 'price']);
		// A pinned column dragged to the far right stops at the end of the pinned zone.
		state.moveColumn('category', 4);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['name', 'category', 'id', 'price']);
		// An unpinned column dragged to the far left stops after the pinned zone.
		state.moveColumn('price', 0);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['name', 'category', 'price', 'id']);
		expect(state.pinnedCount).toBe(2);
	});

	it('round-trips through serialize / hydrate', () => {
		const state = new GridState(columns);
		state.setColumnPinned('price', true);
		state.setColumnPinned('name', false);
		expect(JSON.parse(state.serialize()).pinned).toEqual(['price']);

		const restored = GridState.hydrate(state.serialize(), columns);
		expect(restored.pinned).toEqual(['price']);
		expect(restored.orderedColumns.map((c) => c.id)).toEqual(['price', 'id', 'name', 'category']);
	});

	it('restores "nothing pinned" over a definition that pins', () => {
		const state = new GridState(columns);
		state.setColumnPinned('name', false);
		expect(GridState.hydrate(state.serialize(), columns).pinned).toEqual([]);
	});

	it('keeps the definitions for a payload saved before pinning existed', () => {
		const legacy = JSON.stringify({
			sort: [],
			filters: [],
			order: ['price', 'id', 'name', 'category'],
			widths: {},
			hidden: [],
			groupBy: null
		});
		const state = GridState.hydrate(legacy, columns);
		expect(state.pinned).toEqual(['name']);
		expect(state.orderedColumns.map((c) => c.id)).toEqual(['name', 'price', 'id', 'category']);
	});

	it('resets pinning to the definitions when an old payload without `pinned` is hydrated', () => {
		const state = new GridState(columns);
		state.setColumnPinned('name', false);
		state.setColumnPinned('price', true);
		state.hydrate(
			JSON.stringify({
				sort: [],
				filters: [],
				order: ['price', 'id', 'name', 'category'],
				widths: {},
				hidden: [],
				groupBy: null
			})
		);
		expect(state.pinned).toEqual(['name']);
	});

	it('drops unknown, duplicate and non-string ids from a payload', () => {
		const state = new GridState(columns);
		state.hydrate(
			JSON.stringify({
				...JSON.parse(state.serialize()),
				pinned: ['price', 'gone', 'price', 7]
			})
		);
		expect(state.pinned).toEqual(['price']);
	});

	it('rejects a payload whose pinned is not a list', () => {
		const state = new GridState(columns);
		state.hydrate(JSON.stringify({ ...JSON.parse(state.serialize()), pinned: 'name', sort: [] }));
		expect(state.pinned).toEqual(['name']);
	});
});

describe('BantoGrid pinned columns (#713)', () => {
	it('renders nothing pinned by default, also with the checkbox column', () => {
		const plain = columns.map((column) => ({ ...column, pinned: undefined }));
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: plain,
			getRowId,
			selectable: true
		});
		expect(container.querySelector('.pinned')).toBeNull();
		expect(container.querySelector('.pinned-edge')).toBeNull();
		expect(cellOf(container, 'name').style.left).toBe('');
	});

	it('puts the pinned column first and sticks its header and cells at the left edge', () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		expect(headers(container).map((el) => el.textContent?.trim())).toEqual([
			'商品名',
			'ID',
			'分類',
			'価格'
		]);
		expect(container.querySelector<HTMLElement>('.header-row')!.style.gridTemplateColumns).toBe(
			'100px 80px 200px 300px'
		);

		const [nameHeader, idHeader] = headers(container);
		expect(nameHeader.classList.contains('pinned')).toBe(true);
		expect(nameHeader.classList.contains('pinned-edge')).toBe(true);
		expect(nameHeader.style.left).toBe('0px');
		expect(idHeader.classList.contains('pinned')).toBe(false);
		expect(idHeader.style.left).toBe('');

		for (const rowIndex of [0, 1, 2]) {
			const cell = cellOf(container, 'name', rowIndex);
			expect(cell.classList.contains('pinned')).toBe(true);
			expect(cell.classList.contains('pinned-edge')).toBe(true);
			expect(cell.style.left).toBe('0px');
			expect(cellOf(container, 'id', rowIndex).classList.contains('pinned')).toBe(false);
		}
	});

	it('offsets each pinned column by the ones before it; only the last carries the edge', async () => {
		const state = new GridState<Row>(columns);
		const { container } = render(BantoGrid<Row>, { rows, columns, state, getRowId });
		state.setColumnPinned('category', true);
		await tick();

		expect(cellOf(container, 'name').style.left).toBe('0px');
		expect(cellOf(container, 'name').classList.contains('pinned-edge')).toBe(false);
		expect(cellOf(container, 'category').style.left).toBe('100px');
		expect(cellOf(container, 'category').classList.contains('pinned-edge')).toBe(true);
		expect(headers(container)[1].style.left).toBe('100px');

		// A resize of the first pinned column moves the second one's offset.
		state.resizeColumn('name', 140);
		await tick();
		expect(cellOf(container, 'category').style.left).toBe('140px');
	});

	it('pins the checkbox column too, and the pinned columns follow it', () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, selectable: true });
		const selectCells = [...container.querySelectorAll<HTMLElement>('.select-cell')];
		expect(selectCells).toHaveLength(4); // header + 3 rows
		expect(selectCells.every((el) => el.classList.contains('pinned'))).toBe(true);
		expect(cellOf(container, 'name').style.left).toBe('40px');
		expect(headers(container)[0].style.left).toBe('40px');
		expect(container.querySelector('[role="grid"]')!.getAttribute('aria-colcount')).toBe('5');
	});

	it('stops pinning when a hidden column was the only pinned one', async () => {
		const state = new GridState<Row>(columns);
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns,
			state,
			getRowId,
			selectable: true
		});
		state.setColumnHidden('name', true);
		await tick();
		expect(container.querySelector('.pinned')).toBeNull();
		state.setColumnHidden('name', false);
		await tick();
		expect(cellOf(container, 'name').classList.contains('pinned')).toBe(true);
	});

	it('does not stick a column that would leave too little room to scroll', () => {
		clientWidth = 200; // 100 pinned + 120 minimum does not fit
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, selectable: true });
		expect(container.querySelector('.pinned')).toBeNull();
		// The order is still pinned-first.
		expect(headers(container)[0].textContent?.trim()).toBe('商品名');
	});

	it('marks the grid as scrolled sideways only while scrollLeft is above 0', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
		expect(grid.classList.contains('scrolled-x')).toBe(false);

		grid.scrollLeft = 30;
		await fireEvent.scroll(grid);
		expect(grid.classList.contains('scrolled-x')).toBe(true);

		grid.scrollLeft = 0;
		await fireEvent.scroll(grid);
		expect(grid.classList.contains('scrolled-x')).toBe(false);
	});

	it('scrolls the active cell clear of the pinned block on a keyboard move', async () => {
		clientWidth = 400;
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
		// Content: name 0-100 (pinned) | id 100-180 | category 180-380 | price 380-680.
		grid.scrollLeft = 280;
		await fireEvent.scroll(grid);

		// price is on screen (from x = 100 of the viewport); category is under the pinned block.
		await fireEvent.pointerDown(cellOf(container, 'price'));
		await fireEvent.pointerUp(window);
		await fireEvent.keyDown(grid, { key: 'ArrowLeft' });
		// category must start right of the 100px pinned block: 180 - 100.
		expect(grid.scrollLeft).toBe(80);

		// Moving onto the pinned column itself does not scroll.
		await fireEvent.keyDown(grid, { key: 'ArrowLeft' });
		expect(grid.scrollLeft).toBe(0);
		grid.scrollLeft = 250;
		await fireEvent.keyDown(grid, { key: 'ArrowLeft' });
		expect(container.querySelector('.cell.active')?.getAttribute('data-cell-field')).toBe('name');
		expect(grid.scrollLeft).toBe(250);
	});

	it('pins the placeholder cells of a server-mode hole', () => {
		const sparse: (Row | undefined)[] = [rows[0], undefined, rows[2]];
		const { container } = render(BantoGrid<Row>, {
			rows: sparse as Row[],
			columns,
			getRowId,
			mode: 'server',
			totalRows: 3,
			selectable: true
		});
		const placeholder = container.querySelector<HTMLElement>('.placeholder-row')!;
		expect(placeholder.querySelector('.select-cell')!.classList.contains('pinned')).toBe(true);
		const cells = [...placeholder.querySelectorAll<HTMLElement>('.placeholder-cell')];
		expect(cells[0].classList.contains('pinned')).toBe(true);
		expect(cells[0].style.left).toBe('40px');
		expect(cells[1].classList.contains('pinned')).toBe(false);
	});

	it('keeps a group heading at the left edge only when columns are pinned', async () => {
		const state = new GridState<Row>(columns);
		state.setGroupBy('category');
		const { container } = render(BantoGrid<Row>, { rows, columns, state, getRowId });
		const content = () => container.querySelector<HTMLElement>('.group-header-content')!;
		expect(content().classList.contains('stuck')).toBe(true);
		expect(content().querySelector('.group-label')).not.toBeNull();

		state.setColumnPinned('name', false);
		await tick();
		expect(content().classList.contains('stuck')).toBe(false);
	});
});
