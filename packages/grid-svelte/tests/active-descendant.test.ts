// @vitest-environment jsdom
/**
 * Issue #1016: DOM focus stays on the grid element, so the active cell is
 * named with `aria-activedescendant` (a screen reader otherwise has no way to
 * tell which cell the cursor is on).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { cellDomId, domIdPart, groupRowDomId } from '../src/core/domId';
import { SAVED_TABINDEX_ATTR, SUPPRESSED_TABINDEX, cellControls } from '../src/rowTabStops';
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

	// The active cell's row stays drawn while it is outside the virtualized
	// window: with the attribute gone NVDA reads the whole table and drops to
	// browse mode (on a wheel scroll, and on coming back to the grid by Tab).
	describe('active row outside the virtualized window', () => {
		const ROW = 32;
		/** The header (32px in this stub) scrolls with the rows. */
		const HEADER = 32;

		async function scrollTo(grid: HTMLElement, top: number) {
			grid.scrollTop = top;
			await fireEvent.scroll(grid);
		}

		function inFlowRows(container: HTMLElement): HTMLElement[] {
			return [...container.querySelectorAll<HTMLElement>('.row:not(.outside-window)')];
		}

		it('keeps the attribute and the gridcell while the row is scrolled out, above the window', async () => {
			const { container } = render(BantoGrid<Row>, {
				rows: makeRows(1_000),
				columns,
				rowHeight: ROW,
				getRowId: (row: Row) => row.id
			});
			const grid = screen.getByRole('grid');
			await fireEvent.pointerDown(cellAt(container, 1, 'name'));
			const id = grid.getAttribute('aria-activedescendant')!;
			const cell = cellAt(container, 1, 'name');
			expect(container.querySelector('.outside-window')).toBeNull();

			await scrollTo(grid, HEADER + 500 * ROW);
			expect(grid.getAttribute('aria-activedescendant')).toBe(id);
			const active = activeDescendant(grid);
			expect(active.getAttribute('role')).toBe('gridcell');
			expect(active.classList.contains('active')).toBe(true);
			// The same element: a keyed row is moved, not drawn again.
			expect(active).toBe(cell);
			expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);

			// One extra row, out of the flow, at its own place: the window's rows
			// keep their order and offsets.
			const outside = [...container.querySelectorAll<HTMLElement>('.row.outside-window')];
			expect(outside).toHaveLength(1);
			const row = outside[0];
			expect(row.contains(active)).toBe(true);
			expect(row.getAttribute('aria-rowindex')).toBe('3');
			const block = container.querySelector<HTMLElement>('.rows-block')!;
			const offsetY = Number(/translateY\((\d+)px\)/.exec(block.style.transform)![1]);
			expect(offsetY).toBeGreaterThan(ROW);
			expect(parseFloat(row.style.top) + offsetY).toBe(1 * ROW);
			const flow = inFlowRows(container);
			expect(flow[0].getAttribute('aria-rowindex')).toBe(String(offsetY / ROW + 2));
			flow.forEach((el, i) => {
				expect(el.getAttribute('aria-rowindex')).toBe(String(offsetY / ROW + 2 + i));
				expect(el.style.top).toBe('');
			});
			// Above the window it comes first in the DOM, so rows stay in row order.
			expect(block.firstElementChild).toBe(row);
			// The scroll height is the row count alone.
			const viewport = container.querySelector<HTMLElement>('.rows-viewport')!;
			expect(viewport.style.height).toBe(`${1_000 * ROW}px`);
			// Nothing was selected or scrolled on the way.
			expect(grid.scrollTop).toBe(HEADER + 500 * ROW);
			expect(container.querySelectorAll('.cell.active')).toHaveLength(1);

			await scrollTo(grid, 0);
			expect(container.querySelector('.outside-window')).toBeNull();
			expect(grid.getAttribute('aria-activedescendant')).toBe(id);
			expect(activeDescendant(grid)).toBe(cellAt(container, 1, 'name'));
			expect(cellAt(container, 1, 'name').closest<HTMLElement>('.row')!.style.top).toBe('');
		});

		it("keeps it below the window too, after the window's rows", async () => {
			const { container } = render(BantoGrid<Row>, {
				rows: makeRows(1_000),
				columns,
				rowHeight: ROW,
				getRowId: (row: Row) => row.id
			});
			const grid = screen.getByRole('grid');
			await scrollTo(grid, HEADER + 500 * ROW);
			await fireEvent.pointerDown(cellAt(container, 500, 'category'));
			const cell = cellAt(container, 500, 'category');

			await scrollTo(grid, 0);
			expect(activeDescendant(grid)).toBe(cell);
			const row = cell.closest<HTMLElement>('.row')!;
			expect(row.classList.contains('outside-window')).toBe(true);
			expect(row.style.top).toBe(`${500 * ROW}px`);
			expect(row.getAttribute('aria-rowindex')).toBe('502');
			expect(container.querySelector('.rows-block')!.lastElementChild).toBe(row);
			expect(inFlowRows(container)[0].getAttribute('aria-rowindex')).toBe('2');
		});

		it('is still there when the grid element is focused again, and nothing moves', async () => {
			const { container } = render(BantoGrid<Row>, {
				rows: makeRows(1_000),
				columns,
				rowHeight: ROW,
				selectable: true,
				getRowId: (row: Row) => row.id
			});
			const grid = screen.getByRole('grid');
			await fireEvent.pointerDown(cellAt(container, 1, 'name'));
			const cell = cellAt(container, 1, 'name');
			await scrollTo(grid, HEADER + 500 * ROW);

			grid.blur();
			grid.focus();
			await tick();
			expect(document.activeElement).toBe(grid);
			const active = activeDescendant(grid);
			expect(active).toBe(cell);
			expect(active.getAttribute('role')).toBe('gridcell');
			// The cursor is not moved to the rows in view, and the view does not jump back.
			expect(container.querySelectorAll('.cell.active')).toHaveLength(1);
			expect(grid.scrollTop).toBe(HEADER + 500 * ROW);
			expect(container.querySelector('input[type="checkbox"]:checked')).toBeNull();
			// Out of sight, its checkbox is no tab stop (Tab would jump the view there).
			const box = cell.closest('.row')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
			expect(box.tabIndex).toBe(Number(SUPPRESSED_TABINDEX));
			await scrollTo(grid, 0);
			expect(box.isConnected).toBe(true);
			// Nor is it one in the window: the body's tab stop is the grid element (item 5).
			expect(box.tabIndex).toBe(Number(SUPPRESSED_TABINDEX));
		});

		// What the host draws with `render` / `cell` is out of the Tab order too
		// (review of #1031). Since item 5 that holds for every row, in the window
		// or not (tab-stops.test.ts); here: nothing changes on the way out and back.
		describe('tab stops inside it', () => {
			const controls = createRawSnippet<[Row]>((row) => ({
				render: () =>
					`<span class="controls">` +
					`<button type="button" data-k="plain">open ${row().id}</button>` +
					`<span data-k="zero" tabindex="0">zero</span>` +
					`<span data-k="two" tabindex="2">two</span>` +
					`<button type="button" data-k="minus" tabindex="-1">minus</button>` +
					`<input data-k="input" />` +
					`<span data-k="editable" contenteditable="true">edit</span>` +
					`</span>`
			}));
			const withControls: GridColumn<Row>[] = [
				...columns,
				{ id: 'open', header: 'Open', accessor: () => '', render: controls },
				{
					id: 'link',
					header: 'Link',
					accessor: 'name',
					cell: (row) => ({ text: row.name, href: `/rows/${row.id}` })
				}
			];
			const KEYS = ['plain', 'zero', 'two', 'minus', 'input', 'editable'];

			function setup() {
				const { container } = render(BantoGrid<Row>, {
					rows: makeRows(1_000),
					columns: withControls,
					rowHeight: ROW,
					selectable: true,
					getRowId: (row: Row) => row.id
				});
				return { container, grid: screen.getByRole('grid') };
			}

			function tabindexes(row: HTMLElement): Record<string, string | null> {
				const out: Record<string, string | null> = {};
				for (const key of KEYS) {
					out[key] = row.querySelector(`[data-k="${key}"]`)!.getAttribute('tabindex');
				}
				out.link = row.querySelector('a.cell-link')!.getAttribute('tabindex');
				out.box = row.querySelector('input[type="checkbox"]')!.getAttribute('tabindex');
				return out;
			}

			const ORIGINAL = {
				plain: null,
				zero: '0',
				two: '2',
				minus: '-1',
				input: null,
				editable: null,
				link: null,
				box: null
			};

			/** The values the elements had before they were taken out ('' = no attribute). */
			function originals(row: HTMLElement): Record<string, string | null> {
				const out: Record<string, string | null> = {};
				for (const key of KEYS) {
					out[key] = row.querySelector(`[data-k="${key}"]`)!.getAttribute(SAVED_TABINDEX_ATTR);
				}
				out.link = row.querySelector('a.cell-link')!.getAttribute(SAVED_TABINDEX_ATTR);
				out.box = row.querySelector('input[type="checkbox"]')!.getAttribute(SAVED_TABINDEX_ATTR);
				return out;
			}
			const allOut = (row: HTMLElement) =>
				Object.values(tabindexes(row)).every((value) => value === SUPPRESSED_TABINDEX);

			it('keeps every focusable element out of the Tab order, out of the window and back in it', async () => {
				const { container, grid } = setup();
				await fireEvent.pointerDown(cellAt(container, 0, 'name'));
				const row = cellAt(container, 0, 'name').closest<HTMLElement>('.row')!;
				expect(allOut(row)).toBe(true);
				expect(originals(row)).toEqual(
					Object.fromEntries(Object.entries(ORIGINAL).map(([key, value]) => [key, value ?? '']))
				);

				await scrollTo(grid, HEADER + 500 * ROW);
				expect(row.classList.contains('outside-window')).toBe(true);
				expect(row.isConnected).toBe(true);
				expect(allOut(row)).toBe(true);
				// Still exposed to assistive technology: only `tabindex` changed.
				expect(row.hasAttribute('inert')).toBe(false);
				expect(row.closest('[aria-hidden="true"]')).toBeNull();
				// The rows of the window are the same.
				expect(allOut(inFlowRows(container)[0])).toBe(true);

				await scrollTo(grid, 0);
				expect(row.classList.contains('outside-window')).toBe(false);
				expect(allOut(row)).toBe(true);

				// And again: nothing piles up over the rounds.
				await scrollTo(grid, HEADER + 500 * ROW);
				await scrollTo(grid, 0);
				expect(allOut(row)).toBe(true);
				expect(originals(row).two).toBe('2');
				expect(originals(row).plain).toBe('');
			});

			it('treats what is drawn or changed while the row is out there the same way', async () => {
				const { container, grid } = setup();
				await fireEvent.pointerDown(cellAt(container, 0, 'name'));
				const row = cellAt(container, 0, 'name').closest<HTMLElement>('.row')!;
				await scrollTo(grid, HEADER + 500 * ROW);
				const host = row.querySelector<HTMLElement>('.controls')!;

				// Added later (a host snippet drawn again), nested too.
				host.insertAdjacentHTML(
					'beforeend',
					'<span><button type="button" data-k="late">late</button>' +
						'<span data-k="late-three" tabindex="3">three</span></span>'
				);
				// The host writes `tabindex` again on an element that is already out.
				row.querySelector('[data-k="plain"]')!.setAttribute('tabindex', '5');
				row.querySelector('[data-k="zero"]')!.removeAttribute('tabindex');
				// MutationObserver callbacks are microtasks.
				await Promise.resolve();
				await tick();
				for (const key of ['late', 'late-three', 'plain', 'zero']) {
					expect(row.querySelector(`[data-k="${key}"]`)!.getAttribute('tabindex')).toBe(
						SUPPRESSED_TABINDEX
					);
				}
				// The value the host wrote last is the one that is remembered.
				expect(row.querySelector('[data-k="plain"]')!.getAttribute(SAVED_TABINDEX_ATTR)).toBe('5');
				expect(row.querySelector('[data-k="zero"]')!.getAttribute(SAVED_TABINDEX_ATTR)).toBe('');

				// Back in the window they stay out, and what is drawn there is taken out too.
				await scrollTo(grid, 0);
				host.insertAdjacentHTML('beforeend', '<button type="button" data-k="inside">in</button>');
				await Promise.resolve();
				await tick();
				for (const key of ['late', 'late-three', 'plain', 'zero', 'inside']) {
					expect(row.querySelector(`[data-k="${key}"]`)!.getAttribute('tabindex')).toBe(
						SUPPRESSED_TABINDEX
					);
				}
			});

			it('remembers a -1 the host writes (a mode switch): F2 does not walk into it', async () => {
				const { container, grid } = setup();
				await fireEvent.pointerDown(cellAt(container, 0, 'name'));
				const row = cellAt(container, 0, 'name').closest<HTMLElement>('.row')!;
				const zero = row.querySelector<HTMLElement>('[data-k="zero"]')!;
				await scrollTo(grid, HEADER + 500 * ROW);
				await Promise.resolve();
				await tick();

				// Originally tabindex="0"; the host turns it off while it is out.
				zero.setAttribute('tabindex', '-1');
				await Promise.resolve();
				await tick();
				expect(zero.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
				expect(zero.getAttribute(SAVED_TABINDEX_ATTR)).toBe('-1');
				await scrollTo(grid, 0);
				expect(zero.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
				expect(cellControls(zero.closest('.cell')!)).not.toContain(zero);

				// The host switches it back on.
				zero.setAttribute('tabindex', '0');
				await Promise.resolve();
				await tick();
				expect(zero.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
				expect(cellControls(zero.closest('.cell')!)).toContain(zero);
			});

			describe('focus never stays inside it', () => {
				it('moves the focus to the grid element when the row goes out with a control focused', async () => {
					const { container, grid } = setup();
					await fireEvent.pointerDown(cellAt(container, 0, 'name'));
					const row = cellAt(container, 0, 'name').closest<HTMLElement>('.row')!;
					const button = row.querySelector<HTMLElement>('[data-k="plain"]')!;
					button.focus();
					expect(document.activeElement).toBe(button);

					await scrollTo(grid, HEADER + 500 * ROW);
					expect(row.classList.contains('outside-window')).toBe(true);
					expect(button.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
					expect(document.activeElement).toBe(grid);
					expect(grid.scrollTop).toBe(HEADER + 500 * ROW);
					expect(activeDescendant(grid)).toBe(cellAt(container, 0, 'name'));
					expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
				});

				it('hands a focus() on a control out there to the grid element', async () => {
					const { container, grid } = setup();
					await fireEvent.pointerDown(cellAt(container, 0, 'name'));
					const row = cellAt(container, 0, 'name').closest<HTMLElement>('.row')!;
					await scrollTo(grid, HEADER + 500 * ROW);
					expect(row.classList.contains('outside-window')).toBe(true);

					for (const key of ['plain', 'minus', 'input']) {
						(document.body as HTMLElement).focus();
						row.querySelector<HTMLElement>(`[data-k="${key}"]`)!.focus();
						expect(document.activeElement).toBe(grid);
					}
					row.querySelector<HTMLElement>('input[type="checkbox"]')!.focus();
					expect(document.activeElement).toBe(grid);
					expect(grid.scrollTop).toBe(HEADER + 500 * ROW);
					expect(activeDescendant(grid)).toBe(cellAt(container, 0, 'name'));
				});

				it('puts the scroll position back when that focus() brought the row into view', async () => {
					const { container, grid } = setup();
					await fireEvent.pointerDown(cellAt(container, 0, 'name'));
					const row = cellAt(container, 0, 'name').closest<HTMLElement>('.row')!;
					const button = row.querySelector<HTMLElement>('[data-k="plain"]')!;
					await scrollTo(grid, HEADER + 500 * ROW);

					// What a browser does for a focus() without `preventScroll`: it
					// scrolls to the element first, and `focusin` arrives before the
					// scroll event of that jump.
					button.addEventListener(
						'focusin',
						() => {
							grid.scrollTop = 0;
							grid.scrollLeft = 40;
						},
						{ capture: true, once: true }
					);
					button.focus();
					expect(document.activeElement).toBe(grid);
					expect(grid.scrollTop).toBe(HEADER + 500 * ROW);
					expect(grid.scrollLeft).toBe(0);
					await tick();
					expect(row.classList.contains('outside-window')).toBe(true);
					expect(activeDescendant(grid)).toBe(cellAt(container, 0, 'name'));
				});

				it('leaves the cell editor alone: the edit goes on, nothing is committed', async () => {
					const edits: unknown[] = [];
					const { container } = render(BantoGrid<Row>, {
						rows: makeRows(1_000),
						columns: [{ ...columns[0], editable: true }, columns[1]],
						rowHeight: ROW,
						getRowId: (row: Row) => row.id,
						onCellEdit: (edit: unknown) => {
							edits.push(edit);
						}
					});
					const grid = screen.getByRole('grid');
					await fireEvent.pointerDown(cellAt(container, 0, 'name'));
					grid.focus();
					await fireEvent.keyDown(grid, { key: 'F2' });
					await tick();
					const editor = cellAt(container, 0, 'name').querySelector<HTMLInputElement>('input')!;
					expect(document.activeElement).toBe(editor);

					await scrollTo(grid, HEADER + 500 * ROW);
					expect(editor.closest('.row')!.classList.contains('outside-window')).toBe(true);
					expect(document.activeElement).toBe(editor);
					expect(edits).toEqual([]);
				});

				it('leaves the focus on a control of a row inside the window', async () => {
					const { container, grid } = setup();
					await fireEvent.pointerDown(cellAt(container, 0, 'name'));
					const row = cellAt(container, 0, 'name').closest<HTMLElement>('.row')!;
					const button = row.querySelector<HTMLElement>('[data-k="plain"]')!;
					button.focus();
					expect(document.activeElement).toBe(button);

					// Still inside the window (overscan included): nothing moves.
					await scrollTo(grid, HEADER + 1 * ROW);
					expect(row.classList.contains('outside-window')).toBe(false);
					expect(document.activeElement).toBe(button);

					// With the active row out there, a row of the window is not touched either.
					await scrollTo(grid, HEADER + 500 * ROW);
					expect(document.activeElement).toBe(grid);
					const inside = cellAt(container, 500, 'name')
						.closest<HTMLElement>('.row')!
						.querySelector<HTMLElement>('[data-k="plain"]')!;
					inside.focus();
					expect(document.activeElement).toBe(inside);
					expect(activeDescendant(grid)).toBe(cellAt(container, 0, 'name'));
				});
			});
		});

		it('the first arrow key moves from it and brings the active cell back into view', async () => {
			const { container } = render(BantoGrid<Row>, {
				rows: makeRows(1_000),
				columns,
				rowHeight: ROW,
				getRowId: (row: Row) => row.id
			});
			const grid = screen.getByRole('grid');
			await fireEvent.pointerDown(cellAt(container, 1, 'name'));
			await scrollTo(grid, HEADER + 500 * ROW);

			await fireEvent.keyDown(grid, { key: 'ArrowDown' });
			// Row 2 is put at the top of the rows area.
			expect(grid.scrollTop).toBe(HEADER + 2 * ROW);
			await fireEvent.scroll(grid);
			const active = activeDescendant(grid);
			expect(active).toBe(cellAt(container, 2, 'name'));
			expect(active.getAttribute('role')).toBe('gridcell');
			expect(container.querySelector('.outside-window')).toBeNull();
		});

		it('keeps a group header row the same way', async () => {
			const state = new GridState(columns);
			state.groupBy = 'category';
			const { container } = render(BantoGrid<Row>, {
				rows: makeRows(1_000),
				columns,
				state,
				rowHeight: ROW,
				getRowId: (row: Row) => row.id
			});
			const grid = screen.getByRole('grid');
			await fireEvent.pointerDown(cellAt(container, 1, 'name'));
			await fireEvent.keyDown(grid, { key: 'ArrowUp' });
			const header = activeDescendant(grid);
			expect(header.getAttribute('role')).toBe('row');

			await scrollTo(grid, HEADER + 300 * ROW);
			expect(activeDescendant(grid)).toBe(header);
			expect(header.classList.contains('outside-window')).toBe(true);
			expect(header.getAttribute('aria-rowindex')).toBe('2');
			expect(container.querySelectorAll('.outside-window')).toHaveLength(1);
		});

		it('does not draw a row that is not fetched yet (server mode)', async () => {
			const sparse: Row[] = [];
			makeRows(3).forEach((row, i) => (sparse[i] = row));
			const { container, rerender } = render(BantoGrid<Row>, {
				rows: sparse,
				columns,
				mode: 'server',
				totalRows: 1_000,
				rowHeight: ROW,
				getRowId: (row: Row) => row.id
			});
			const grid = screen.getByRole('grid');
			await fireEvent.pointerDown(cellAt(container, 1, 'name'));
			const cell = cellAt(container, 1, 'name');

			// A fetched row is kept like in client mode ...
			await scrollTo(grid, HEADER + 500 * ROW);
			expect(activeDescendant(grid)).toBe(cell);
			expect(container.querySelectorAll('.outside-window')).toHaveLength(1);

			// ... but once it is a hole again there is nothing to name.
			await rerender({ rows: [] as Row[] });
			expect(container.querySelector('.outside-window')).toBeNull();
			expect(grid.hasAttribute('aria-activedescendant')).toBe(false);
		});
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

/**
 * Reached by Tab there is no active cell yet. NVDA then stays in browse mode
 * and takes the arrow keys for itself, so the key that would create the cursor
 * never arrives: the cursor is placed as soon as the grid element is focused.
 */
describe('BantoGrid: focus on the grid element places the cursor (#1016)', () => {
	it('names the first cell of the first row in view, without selecting anything', async () => {
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(1_000),
			columns,
			rowHeight: 32,
			selectable: true,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		grid.focus();
		await tick();
		const first = cellAt(container, 0, 'name');
		expect(activeDescendant(grid)).toBe(first);
		expect(first.classList.contains('active')).toBe(true);
		// Only the cursor: no cell range, no row selection, no scrolling.
		expect(container.querySelector('[role="gridcell"][aria-selected="true"]')).toBeNull();
		expect(container.querySelector('input[type="checkbox"]:checked')).toBeNull();
		expect(grid.scrollTop).toBe(0);
	});

	it('after scrolling, names the first row in view at that time', async () => {
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(1_000),
			columns,
			rowHeight: 32,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		// The header (32px in this stub) scrolls with the rows.
		grid.scrollTop = 32 + 500 * 32;
		await fireEvent.scroll(grid);
		grid.focus();
		await tick();
		expect(activeDescendant(grid)).toBe(cellAt(container, 500, 'name'));
		expect(grid.scrollTop).toBe(32 + 500 * 32);
	});

	it('leaves an existing active cell where it is', async () => {
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(5),
			columns,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		await fireEvent.pointerDown(cellAt(container, 2, 'category'));
		grid.focus();
		await tick();
		expect(activeDescendant(grid)).toBe(cellAt(container, 2, 'category'));
	});

	it('names the group header row when that is the first row in view', async () => {
		const state = new GridState(columns);
		state.groupBy = 'category';
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(4),
			columns,
			state,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		grid.focus();
		await tick();
		expect(activeDescendant(grid)).toBe(container.querySelector('.group-header-row'));
	});

	it('does not place the cursor when a header button takes the focus', async () => {
		const { container } = render(BantoGrid<Row>, {
			rows: makeRows(3),
			columns,
			getRowId: (row: Row) => row.id
		});
		const grid = screen.getByRole('grid');
		const button = screen.getByRole('button', { name: 'Name' });
		button.focus();
		await tick();
		expect(document.activeElement).toBe(button);
		expect(grid.hasAttribute('aria-activedescendant')).toBe(false);
		expect(container.querySelector('.cell.active')).toBeNull();
	});

	it('does nothing with no rows', async () => {
		render(BantoGrid<Row>, { rows: [] as Row[], columns, getRowId: (row: Row) => row.id });
		const grid = screen.getByRole('grid');
		grid.focus();
		await tick();
		expect(document.activeElement).toBe(grid);
		expect(grid.hasAttribute('aria-activedescendant')).toBe(false);
	});
});
