// @vitest-environment jsdom
/**
 * Issue #1016: DOM focus stays on the grid element, so the active cell is
 * named with `aria-activedescendant` (a screen reader otherwise has no way to
 * tell which cell the cursor is on).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { cellDomId, domIdPart, groupRowDomId } from '../src/core/domId';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	// jsdom has no layout; match the viewport stubs in BantoGrid.test.ts.
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
	id: number | string;
	name: string;
	category: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name' },
	{ id: 'category', header: 'Category', accessor: 'category' }
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

/** The element `aria-activedescendant` names; fails when the id is missing from the DOM. */
function activeDescendant(grid: HTMLElement): HTMLElement {
	const id = grid.getAttribute('aria-activedescendant');
	expect(id).toBeTruthy();
	const element = document.getElementById(id!);
	expect(element).not.toBeNull();
	return element!;
}

describe('domIdPart / cellDomId', () => {
	it('uses only id-safe characters, whatever the row key or the column id holds', () => {
		const id = cellDomId('g1', 'a b\t"c"/#.:[]', '列 名-1_x');
		expect(id).toMatch(/^g1-cell-[A-Za-z0-9_]+-[A-Za-z0-9_]+$/);
	});

	it('is one-to-one: different inputs never share an id', () => {
		const values: (string | number)[] = [1, '1', 'a b', 'a_20_b', 'a-b', 'a_b', 'ab', '', '_'];
		const parts = values.map(domIdPart);
		expect(new Set(parts).size).toBe(values.length);
		// The row / column boundary can not shift either.
		expect(cellDomId('g', 'a-b', 'c')).not.toBe(cellDomId('g', 'a', 'b-c'));
	});
});

describe('BantoGrid aria-activedescendant (#1016)', () => {
	it('has no aria-activedescendant before a cell is active', () => {
		render(BantoGrid<Row>, { rows: makeRows(3), columns, getRowId: (row: Row) => row.id });
		expect(screen.getByRole('grid').hasAttribute('aria-activedescendant')).toBe(false);
	});

	it('follows the active cell on click and on arrow keys, and names a gridcell', async () => {
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(5),
			columns,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');

		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		let active = activeDescendant(grid);
		expect(active).toBe(cellAt(container, 1, 'name'));
		expect(active.getAttribute('role')).toBe('gridcell');
		expect(active.classList.contains('active')).toBe(true);

		await fireEvent.keyDown(grid, { key: 'ArrowDown' });
		active = activeDescendant(grid);
		expect(active).toBe(cellAt(container, 2, 'name'));
		expect(active.getAttribute('role')).toBe('gridcell');

		await fireEvent.keyDown(grid, { key: 'ArrowRight' });
		active = activeDescendant(grid);
		expect(active).toBe(cellAt(container, 2, 'category'));
		expect(active.getAttribute('role')).toBe('gridcell');

		// DOM focus never leaves the grid element: the cells carry no tabindex.
		expect(container.querySelector('[role="gridcell"][tabindex]')).toBeNull();
	});

	it('gives every cell an id that is unique in the document, across two grids', () => {
		const rows = makeRows(3);
		render(BantoGrid<Row>, { rows, columns, getRowId: (row: Row) => row.id });
		render(BantoGrid<Row>, { rows, columns, getRowId: (row: Row) => row.id });
		const ids = [...document.querySelectorAll('.cell[role="gridcell"]')].map((cell) => cell.id);
		expect(ids).toHaveLength(12);
		expect(ids.every((id) => id.length > 0)).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('keeps working when the row key and the column id are not id-safe', async () => {
		const oddColumns: GridColumn<Row>[] = [
			{ id: 'the name / 名前', header: 'Name', accessor: 'name' },
			{ id: 'cat "x"', header: 'Category', accessor: 'category' }
		];
		const rows: Row[] = [
			{ id: 'row 1/a', name: 'Alpha', category: 'First' },
			{ id: 'row 1 a', name: 'Beta', category: 'Second' }
		];
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: oddColumns,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		const cells = [...container.querySelectorAll<HTMLElement>('.cell[role="gridcell"]')];
		await fireEvent.pointerDown(cells[3]);
		const id = grid.getAttribute('aria-activedescendant')!;
		// One IDREF: whitespace would split it into several.
		expect(id).toMatch(/^\S+$/);
		expect(activeDescendant(grid)).toBe(cells[3]);
		expect(new Set(cells.map((cell) => cell.id)).size).toBe(4);
	});

	it('drops the attribute while the active row is scrolled out of the DOM, and restores it', async () => {
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(1_000),
			columns,
			rowHeight: 32,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		const id = grid.getAttribute('aria-activedescendant')!;
		expect(document.getElementById(id)).not.toBeNull();

		grid.scrollTop = 500 * 32;
		await fireEvent.scroll(grid);
		expect(cellAt(container, 1, 'name')).toBeNull();
		expect(document.getElementById(id)).toBeNull();
		expect(grid.hasAttribute('aria-activedescendant')).toBe(false);

		grid.scrollTop = 0;
		await fireEvent.scroll(grid);
		expect(grid.getAttribute('aria-activedescendant')).toBe(id);
		expect(activeDescendant(grid)).toBe(cellAt(container, 1, 'name'));
	});

	it('does not name a row that is not fetched yet (server mode placeholder)', async () => {
		const sparse: Row[] = [];
		sparse[0] = { id: 1, name: 'Alpha', category: 'First' };
		const { container } = render(BantoGrid<Row>, {
			rows: sparse,
			columns,
			mode: 'server',
			totalRows: 5,
			rowHeight: 32,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		await fireEvent.pointerDown(cellAt(container, 0, 'name'));
		expect(activeDescendant(grid)).toBe(cellAt(container, 0, 'name'));
		await fireEvent.keyDown(grid, { key: 'ArrowDown' });
		const id = grid.getAttribute('aria-activedescendant');
		// Either the cursor stayed on the loaded row, or the attribute is off:
		// it never names an id that is not in the DOM.
		if (id !== null) expect(document.getElementById(id)).not.toBeNull();
	});

	it('names the group header row while the cursor is on it', async () => {
		const state = new GridState(columns);
		state.groupBy = 'category';
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(4),
			columns,
			state,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		const header = container.querySelector<HTMLElement>('.group-header-row')!;
		expect(header.id).toBe(groupRowDomId(header.id.split('-group-')[0], 'Odd'));

		// Display index 0 is the first group header, 1 its first row.
		await fireEvent.pointerDown(cellAt(container, 1, 'name'));
		expect(activeDescendant(grid).getAttribute('role')).toBe('gridcell');
		await fireEvent.keyDown(grid, { key: 'ArrowUp' });
		const active = activeDescendant(grid);
		expect(active).toBe(header);
		expect(active.getAttribute('role')).toBe('row');
	});
});
