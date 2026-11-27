// @vitest-environment jsdom
/**
 * #1035, found with NVDA's browse mode (Chromium / WebView2):
 * - the header row read "商品名商品名の絞り込み": the sort button (the column name) and
 *   the filter button (the column name again) one after the other. The filter
 *   button's name is now the same in every column, with no column name in it.
 * - every cell read "clickable": Chromium exposes an element that has a mouse
 *   button listener of its own as clickable. Svelte delegates `onclick` & co. to
 *   the mount target, but attaches a capture listener (`onclickcapture`) to the
 *   element itself - that was one `click` listener per cell.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
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

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

interface Row {
	id: number;
	name: string;
	price: number;
}

const rows: Row[] = [
	{ id: 1, name: 'ペン', price: 300 },
	{ id: 2, name: 'ノート', price: 100 }
];
const columns: GridColumn<Row>[] = [
	{
		id: 'open',
		header: '操作',
		accessor: 'id',
		sortable: false,
		cell: (row) => ({ text: `開く ${row.id}`, href: `#/items/${row.id}` })
	},
	{ id: 'name', header: '商品名', accessor: 'name', filterable: true, editable: true },
	{ id: 'price', header: '価格', accessor: 'price', filterable: true }
];
const getRowId = (row: Row) => row.id;

function cellOf(container: HTMLElement, row: number, field: string): HTMLElement {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${row}"][data-cell-field="${field}"]`
	)!;
}

function activeCell(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>('[data-cell-row].active');
}

describe('header: the filter button does not repeat the column name (#1035)', () => {
	it('is named 「絞り込み」 in every column; the column name comes from its columnheader', () => {
		render(BantoGrid<Row>, { rows, columns, getRowId });
		const buttons = screen.getAllByRole('button', { name: '絞り込み' });
		expect(buttons).toHaveLength(2);
		for (const header of ['商品名', '価格']) {
			const cell = screen.getByRole('columnheader', { name: header });
			const inCell = within(cell).getAllByRole('button');
			// What browse mode reads in the cell: the column name once.
			expect(inCell.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim())).toEqual([
				header,
				'絞り込み'
			]);
		}
	});

	it('the popover it opens keeps the column name', async () => {
		render(BantoGrid<Row>, { rows, columns, getRowId });
		const header = screen.getByRole('columnheader', { name: '価格' });
		await fireEvent.click(within(header).getByRole('button', { name: '絞り込み' }));
		expect(screen.getByRole('dialog', { name: '価格の絞り込み' })).toBeTruthy();
	});

	it('messages.filterButtonLabel names the button; filterAriaLabel only the popover', async () => {
		render(BantoGrid<Row>, {
			rows,
			columns,
			getRowId,
			messages: { filterButtonLabel: () => 'Filter', filterAriaLabel: (h) => `Filter ${h}` }
		});
		const header = screen.getByRole('columnheader', { name: '商品名' });
		const button = within(header).getByRole('button', { name: 'Filter' });
		expect(screen.queryByRole('button', { name: 'Filter 商品名' })).toBeNull();
		await fireEvent.click(button);
		expect(screen.getByRole('dialog', { name: 'Filter 商品名' })).toBeTruthy();
	});
});

/** Blink's "mouse button" events: a listener for one of these on an element makes it clickable. */
const MOUSE_BUTTON_EVENTS = new Set(['click', 'mousedown', 'mouseup', 'dblclick', 'DOMActivate']);

describe('cells are not exposed as clickable (#1035)', () => {
	function renderTracked(props: Record<string, unknown> = {}) {
		const calls: { target: EventTarget; type: string; capture: boolean }[] = [];
		const add = EventTarget.prototype.addEventListener;
		vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
			this: EventTarget,
			type: string,
			listener: EventListenerOrEventListenerObject | null,
			options?: boolean | AddEventListenerOptions
		) {
			const capture = typeof options === 'boolean' ? options : !!options?.capture;
			calls.push({ target: this, type, capture });
			add.call(this, type, listener, options);
		});
		const view = render(BantoGrid<Row>, { rows, columns, getRowId, selectable: true, ...props });
		const mouseListenersOn = (el: Element) =>
			calls.filter((call) => call.target === el && MOUSE_BUTTON_EVENTS.has(call.type));
		return { ...view, calls, mouseListenersOn };
	}

	it('no cell, row, column header or the grid element has a mouse button listener of its own', () => {
		const { container, mouseListenersOn } = renderTracked();
		const exposed = container.querySelectorAll(
			'[role="gridcell"], [role="row"], [role="columnheader"], [role="grid"]'
		);
		// 2 data rows x (select + 3 columns) cells, 3 rows, 4 headers, the grid.
		expect(exposed.length).toBe(8 + 3 + 4 + 1);
		for (const el of exposed) {
			expect(mouseListenersOn(el), el.outerHTML.slice(0, 80)).toEqual([]);
		}
	});

	it('the one click capture listener is on the presentational wrapper', () => {
		const { container, mouseListenersOn } = renderTracked();
		const wrapper = container.querySelector('.scroll-content')!;
		expect(wrapper.getAttribute('role')).toBe('presentation');
		expect(mouseListenersOn(wrapper)).toEqual([{ target: wrapper, type: 'click', capture: true }]);
	});
});

describe('mouse and tap on a cell still work through the shared listener (#1035)', () => {
	it('a mouse press makes the cell the active one; a drag extends the range', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const from = cellOf(container, 0, 'name');
		await fireEvent.pointerDown(from, { pointerType: 'mouse', pointerId: 1, button: 0 });
		expect(activeCell(container)).toBe(from);
		expect(document.activeElement).toBe(container.querySelector('[role="grid"]'));
		// jsdom has no hit testing: point the drag's `elementFromPoint` at the target.
		const to = cellOf(container, 1, 'price');
		document.elementFromPoint = () => to;
		try {
			await fireEvent.pointerMove(window, { pointerType: 'mouse', pointerId: 1 });
		} finally {
			delete (document as { elementFromPoint?: unknown }).elementFromPoint;
		}
		await fireEvent.pointerUp(window, { pointerType: 'mouse', pointerId: 1 });
		const selected = [...container.querySelectorAll('[role="gridcell"][aria-selected="true"]')];
		expect(selected).toEqual([
			cellOf(container, 0, 'name'),
			cellOf(container, 0, 'price'),
			cellOf(container, 1, 'name'),
			cellOf(container, 1, 'price')
		]);
	});

	it('a double-click on an editable cell opens its editor', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		await fireEvent.dblClick(cellOf(container, 1, 'name'));
		const editor = cellOf(container, 1, 'name').querySelector('input');
		expect(editor?.value).toBe('ノート');
	});

	it('a click on a cell of a grid with no editable column calls onRowClick', async () => {
		const onRowClick = vi.fn();
		const readOnly = columns.map((column) => ({ ...column, editable: false }));
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: readOnly,
			getRowId,
			onRowClick
		});
		const cell = cellOf(container, 1, 'price');
		await fireEvent.pointerDown(cell, { pointerType: 'mouse', pointerId: 1, button: 0 });
		await fireEvent.pointerUp(cell, { pointerType: 'mouse', pointerId: 1, button: 0 });
		await fireEvent.click(cell, { detail: 1 });
		expect(onRowClick).toHaveBeenCalledExactlyOnceWith(rows[1]);
	});

	it('a tap on a link in a cell, whose click does not bubble, still moves the active cell', async () => {
		const onRowClick = vi.fn();
		const readOnly = columns.map((column) => ({ ...column, editable: false }));
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: readOnly,
			getRowId,
			onRowClick
		});
		const link = within(cellOf(container, 1, 'open')).getByRole('link');
		await fireEvent.pointerDown(link, { pointerType: 'touch', pointerId: 7, button: 0 });
		// A touch press alone does nothing.
		expect(activeCell(container)).toBeNull();
		await fireEvent.pointerUp(link, { pointerType: 'touch', pointerId: 7, button: 0 });
		await fireEvent.click(link, { detail: 1 });
		expect(activeCell(container)).toBe(cellOf(container, 1, 'open'));
		// The link's own click stops at the link: the row click is not this tap's.
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('a tap on an editable cell starts editing', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const cell = cellOf(container, 0, 'name');
		await fireEvent.pointerDown(cell, { pointerType: 'touch', pointerId: 3, button: 0 });
		await fireEvent.pointerUp(cell, { pointerType: 'touch', pointerId: 3, button: 0 });
		await fireEvent.click(cell, { detail: 1 });
		expect(cell.querySelector('input')?.value).toBe('ペン');
	});
});
