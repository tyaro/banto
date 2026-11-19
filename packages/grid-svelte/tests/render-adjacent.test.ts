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

describe('GridColumn.renderer / tone (#713)', () => {
	interface R {
		id: number;
		status: string;
		done: number;
		ok: boolean;
	}
	const data: R[] = [
		{ id: 1, status: '稼働', done: 0.4, ok: true },
		{ id: 2, status: '停止', done: 1, ok: false }
	];
	const cols: GridColumn<R>[] = [
		{
			id: 'status',
			header: '状態',
			accessor: 'status',
			renderer: 'badge',
			tone: (v) => (v === '稼働' ? 'success' : 'danger')
		},
		{ id: 'done', header: '進捗', accessor: 'done', renderer: 'progress' },
		{ id: 'ok', header: '有効', accessor: 'ok', renderer: 'boolean' }
	];

	it('draws a badge, an accessible progressbar and a readable boolean', () => {
		const { container } = render(BantoGrid<R>, {
			rows: data,
			columns: cols,
			state: new GridState<R>(cols),
			getRowId: (row: R) => row.id
		});
		expect(container.querySelector('.cell-badge')?.textContent).toBe('稼働');
		expect(
			container
				.querySelector('[data-cell-row="0"][data-cell-field="status"]')
				?.getAttribute('data-tone')
		).toBe('success');
		const bars = screen.getAllByRole('progressbar');
		expect(bars[0].getAttribute('aria-valuenow')).toBe('40');
		expect(bars[0].getAttribute('aria-valuetext')).toBe('40%');
		expect(bars[1].getAttribute('aria-valuenow')).toBe('100');
		const okCells = container.querySelectorAll('[data-cell-field="ok"]');
		expect(okCells[0].textContent).toContain('はい');
		expect(okCells[1].textContent).toContain('いいえ');
	});

	it('boolean labels come from messages', () => {
		const { container } = render(BantoGrid<R>, {
			rows: data,
			columns: cols,
			state: new GridState<R>(cols),
			getRowId: (row: R) => row.id,
			messages: { booleanTrue: () => 'yes', booleanFalse: () => 'no' }
		});
		expect(
			container.querySelector('[data-cell-row="0"][data-cell-field="ok"]')?.textContent
		).toContain('yes');
	});
});

describe('renderer link keyboard (#713)', () => {
	interface LinkRow {
		id: number;
		name: string;
		url: string;
	}
	const linkRows: LinkRow[] = [
		{ id: 1, name: 'a', url: '/a' },
		{ id: 2, name: 'b', url: '' }
	];
	const linkColumns: GridColumn<LinkRow>[] = [
		{ id: 'name', header: '名', accessor: 'name', renderer: 'link', href: (r) => r.url }
	];
	function setup() {
		const onRowClick = vi.fn();
		const view = render(BantoGrid<LinkRow>, {
			rows: linkRows,
			columns: linkColumns,
			state: new GridState<LinkRow>(linkColumns),
			getRowId: (row: LinkRow) => row.id,
			onRowClick
		});
		return { onRowClick, container: view.container };
	}

	for (const key of ['Enter', ' ']) {
		it(`${JSON.stringify(key)} on a drawn link clicks it, not onRowClick`, async () => {
			const { onRowClick, container } = setup();
			const clicked = vi.fn((e: Event) => e.preventDefault());
			container.querySelector('a.cell-link')!.addEventListener('click', clicked, { once: true });
			await fireEvent.pointerDown(container.querySelector('[data-cell-row="0"]')!);
			await fireEvent.keyDown(screen.getByRole('grid'), { key });
			expect(clicked).toHaveBeenCalledTimes(1);
			expect(onRowClick).not.toHaveBeenCalled();
		});

		it(`${JSON.stringify(key)} on a text-fallback row still calls onRowClick`, async () => {
			const { onRowClick, container } = setup();
			expect(container.querySelectorAll('a.cell-link')).toHaveLength(1);
			await fireEvent.pointerDown(container.querySelector('[data-cell-row="1"]')!);
			await fireEvent.keyDown(screen.getByRole('grid'), { key });
			expect(onRowClick).toHaveBeenCalledWith(linkRows[1]);
		});
	}
});
