// @vitest-environment jsdom
/**
 * #1034: a gridcell carries `aria-selected` only while the copy / paste range
 * spans two or more cells. A single cell is the cursor, not a selection, so a
 * screen reader does not say "not selected" on every move. Same jsdom stubs as
 * row-context-menu.test.ts so rows virtualize into view.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
	{ id: 'name', header: '商品名', accessor: 'name' },
	{ id: 'price', header: '価格', accessor: 'price' }
];
const getRowId = (row: Row) => row.id;

function cellOf(container: HTMLElement, row: number, field: string): HTMLElement {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${row}"][data-cell-field="${field}"]`
	)!;
}

function setup() {
	return render(BantoGrid<Row>, { rows, columns, getRowId });
}

describe('BantoGrid gridcell aria-selected (#1034)', () => {
	it('puts no aria-selected on any cell with no range, and does not mark the grid multiselectable', () => {
		const { container } = setup();
		expect(container.querySelectorAll('[role="gridcell"]').length).toBeGreaterThan(0);
		expect(container.querySelector('[role="gridcell"][aria-selected]')).toBeNull();
		// Chromium may expose cells of a multiselectable grid as selectable, and NVDA
		// then says "not selected" again (#1034), so the grid stays without it.
		expect(container.querySelector('[role="grid"]')!.hasAttribute('aria-multiselectable')).toBe(
			false
		);
	});

	it('keeps it off after a plain click (one cell is the cursor, not a range)', async () => {
		const { container } = setup();
		await fireEvent.pointerDown(cellOf(container, 0, 'name'), { button: 0, pointerId: 1 });
		await tick();
		expect(cellOf(container, 0, 'name').classList.contains('active')).toBe(true);
		expect(container.querySelector('[role="gridcell"][aria-selected]')).toBeNull();
	});

	it('marks the cells inside a widened range true and the ones outside false', async () => {
		const { container } = setup();
		await fireEvent.pointerDown(cellOf(container, 0, 'name'), { button: 0, pointerId: 1 });
		await fireEvent.pointerDown(cellOf(container, 1, 'price'), {
			button: 0,
			pointerId: 1,
			shiftKey: true
		});
		await tick();
		expect(container.querySelectorAll('[role="gridcell"][aria-selected="true"]')).toHaveLength(4);
		expect(cellOf(container, 0, 'name').getAttribute('aria-selected')).toBe('true');
		expect(cellOf(container, 1, 'price').getAttribute('aria-selected')).toBe('true');
		expect(cellOf(container, 2, 'name').getAttribute('aria-selected')).toBe('false');
		expect(cellOf(container, 2, 'price').getAttribute('aria-selected')).toBe('false');
	});
});
