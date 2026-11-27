// @vitest-environment jsdom
/**
 * #1016: the grid is three tab stops - the grid element (the body), the
 * header row (a roving `tabindex`) and the bulk bar - instead of one per
 * control. jsdom does not perform native Tab navigation, so these tests read
 * `tabindex` (who is a tab stop) and drive the keys that move the focus;
 * the real Tab order is covered by e2e/demo/grid-tab-stops.spec.ts.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { HEADER_STOP_ATTR, headerTabStop } from '../src/headerTabStop';
import { SUPPRESSED_TABINDEX } from '../src/rowTabStops';
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
	category: string;
}

const actions = createRawSnippet<[Row]>((row) => ({
	render: () =>
		`<span><button type="button" data-act="edit-${row().id}">edit</button>` +
		`<button type="button" data-act="off-${row().id}" disabled>off</button>` +
		`<select data-act="pick-${row().id}"><option>a</option></select></span>`
}));

const baseColumns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', editable: true, filterable: true },
	{ id: 'category', header: 'Category', accessor: 'category', filterable: true },
	{ id: 'plain', header: 'Plain', accessor: 'category', sortable: false },
	{
		id: 'open',
		header: 'Open',
		accessor: () => '',
		sortable: false,
		cell: (row) => ({ text: `Open ${row.name}`, href: `/items/${row.id}` })
	},
	{ id: 'actions', header: 'Actions', accessor: () => '', sortable: false, render: actions }
];
const rows: Row[] = [
	{ id: 1, name: 'Alpha', category: 'First' },
	{ id: 2, name: 'Beta', category: 'Second' }
];

function setup(props: { columns?: GridColumn<Row>[]; rows?: Row[]; selectable?: boolean } = {}) {
	return render(BantoGrid<Row>, {
		rows: props.rows ?? rows,
		columns: props.columns ?? baseColumns,
		getRowId: (row: Row) => row.id,
		selectable: props.selectable ?? true,
		onCellEdit: () => {}
	});
}

/** MutationObserver reports are microtasks. */
async function reported() {
	await Promise.resolve();
	await tick();
}

function headerStops(container: HTMLElement) {
	return [...container.querySelectorAll<HTMLElement>('.header-row [data-banto-grid-header-stop]')];
}

/** The elements of `root` the browser would stop at with Tab. */
function tabStops(root: Element) {
	return [
		...root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
	].filter((el) => el.tabIndex >= 0 && !el.matches(':disabled'));
}

function cell(container: HTMLElement, rowIndex: number, field: string) {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${rowIndex}"][data-cell-field="${field}"]`
	)!;
}

async function selectCell(container: HTMLElement, rowIndex: number, field: string) {
	const target = cell(container, rowIndex, field);
	await fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
	await fireEvent.pointerUp(window, { pointerId: 1 });
	expect(document.activeElement).toBe(screen.getByRole('grid'));
	return target;
}

function key(target: Element, init: KeyboardEventInit) {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

describe('header row: one tab stop (roving tabindex)', () => {
	it('has exactly one tab stop, the first control; a column that cannot be sorted is not one', () => {
		const { container } = setup();
		const stops = headerStops(container);
		// select-all, Name sort, Name filter, Category sort, Category filter.
		expect(stops.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim())).toEqual([
			expect.stringContaining('選択'),
			'Name',
			'Nameの絞り込み',
			'Category',
			'Categoryの絞り込み'
		]);
		expect(stops.map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([stops[0]]);
		const plain = screen.getByRole('button', { name: 'Plain' });
		expect(plain.getAttribute('tabindex')).toBe('-1');
		expect(stops).not.toContain(plain);
	});

	it('ArrowRight / ArrowLeft / Home / End move the focus and the tab stop', () => {
		const { container } = setup();
		const stops = headerStops(container);
		const header = container.querySelector('.header-row')!;
		stops[0].focus();
		expect(key(stops[0], { key: 'ArrowRight' }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(stops[1]);
		expect(tabStops(header)).toEqual([stops[1]]);
		key(stops[1], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(stops[2]);
		key(stops[2], { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(stops[1]);
		key(stops[1], { key: 'End' });
		expect(document.activeElement).toBe(stops[4]);
		expect(tabStops(header)).toEqual([stops[4]]);
		// Nothing after the last one: the key is still taken (no scroll).
		expect(key(stops[4], { key: 'ArrowRight' }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(stops[4]);
		key(stops[4], { key: 'Home' });
		expect(document.activeElement).toBe(stops[0]);
		expect(tabStops(header)).toEqual([stops[0]]);
	});

	it('remembers the control touched last, also by the mouse', () => {
		const { container } = setup();
		const stops = headerStops(container);
		// A click focuses the button.
		stops[2].focus();
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([stops[2]]);
		screen.getByRole('grid').focus();
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([stops[2]]);
	});

	it('leaves keys with a modifier and the keys of the sort button alone', async () => {
		const { container } = setup();
		const stops = headerStops(container);
		stops[1].focus();
		expect(key(stops[1], { key: 'ArrowRight', shiftKey: true }).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(stops[1]);
		await fireEvent.keyDown(stops[1], { key: 'Enter' });
		expect(stops[1].closest('[role="columnheader"]')!.getAttribute('aria-sort')).toBe('ascending');
		expect(document.activeElement).toBe(stops[1]);
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([stops[1]]);
	});

	it('does not take the arrow keys of the filter popover; closing it returns to the button', async () => {
		const { container } = setup();
		const filterButton = screen.getByRole('button', { name: 'Nameの絞り込み' });
		filterButton.focus();
		await fireEvent.click(filterButton);
		const input = await waitFor(() => {
			const el = container.querySelector<HTMLElement>('.header-row [role="dialog"] input');
			expect(el).not.toBeNull();
			return el!;
		});
		input.focus();
		expect(key(input, { key: 'ArrowLeft' }).defaultPrevented).toBe(false);
		expect(key(input, { key: 'Home' }).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(input);
		await fireEvent.keyDown(input, { key: 'Escape' });
		await waitFor(() => expect(document.activeElement).toBe(filterButton));
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([filterButton]);
	});

	it('skips the select-all checkbox while it is disabled (no rows)', async () => {
		const { container } = setup({ rows: [] });
		await reported();
		const stops = headerStops(container);
		expect((stops[0] as HTMLInputElement).disabled).toBe(true);
		expect(stops.map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1', '-1']);
		stops[2].focus();
		key(stops[2], { key: 'Home' });
		expect(document.activeElement).toBe(stops[1]);
	});

	it('the select-all checkbox becomes the tab stop when the rows arrive, unless a control was touched', async () => {
		const { container, rerender } = setup({ rows: [] });
		await reported();
		const stops = headerStops(container);
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([stops[1]]);
		await rerender({ rows });
		await reported();
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([stops[0]]);

		await rerender({ rows: [] });
		await reported();
		stops[2].focus();
		await rerender({ rows });
		await reported();
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([stops[2]]);
	});

	it('keeps one tab stop when a column stops being sortable or is removed', async () => {
		const { container, rerender } = setup();
		const header = () => container.querySelector('.header-row')!;
		const categorySort = screen.getByRole('button', { name: 'Category' });
		categorySort.focus();
		expect(tabStops(header())).toEqual([categorySort]);

		// No longer sortable: it loses the stop, the first control takes it.
		await rerender({
			columns: [baseColumns[0], { ...baseColumns[1], sortable: false }, ...baseColumns.slice(2)]
		});
		await reported();
		expect(categorySort.getAttribute('tabindex')).toBe('-1');
		expect(headerStops(container)).not.toContain(categorySort);
		expect(tabStops(header())).toEqual([headerStops(container)[0]]);

		// The column of the current stop is removed.
		const nameFilter = screen.getByRole('button', { name: 'Nameの絞り込み' });
		nameFilter.focus();
		expect(tabStops(header())).toEqual([nameFilter]);
		await rerender({ columns: baseColumns.slice(1) });
		await reported();
		expect(nameFilter.isConnected).toBe(false);
		expect(tabStops(header())).toEqual([headerStops(container)[0]]);
	});

	it('follows the DOM order after the controls are moved (a column reordered or pinned)', async () => {
		const header = document.createElement('div');
		header.innerHTML = ['a', 'b', 'c']
			.map((k) => `<span><button data-k="${k}" ${HEADER_STOP_ATTR}>${k}</button></span>`)
			.join('');
		document.body.append(header);
		const action = headerTabStop(header);
		try {
			const get = (k: string) => header.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
			get('b').focus();
			// b's column moves to the front (a keyed each moves the node).
			header.prepend(get('b').parentElement!);
			await reported();
			expect(tabStops(header)).toEqual([get('b')]);
			// Moving a node drops its focus (the browser does the same).
			get('b').focus();
			key(get('b'), { key: 'ArrowRight' });
			expect(document.activeElement).toBe(get('a'));
			key(get('a'), { key: 'End' });
			expect(document.activeElement).toBe(get('c'));
			// A control added later joins as -1.
			header.insertAdjacentHTML('beforeend', `<button data-k="d" ${HEADER_STOP_ATTR}>d</button>`);
			await reported();
			expect(tabStops(header)).toEqual([get('c')]);
		} finally {
			action.destroy();
			header.remove();
		}
	});

	it('without a select column the first sort button is the tab stop', () => {
		const { container } = setup({ selectable: false });
		expect(tabStops(container.querySelector('.header-row')!)).toEqual([
			screen.getByRole('button', { name: 'Name' })
		]);
	});
});

describe('body: only the grid element is a tab stop', () => {
	it('takes the row checkbox, the links and the host controls out of the Tab order', async () => {
		const { container } = setup();
		await reported();
		const grid = screen.getByRole('grid');
		expect(grid.getAttribute('tabindex')).toBe('0');
		for (const row of container.querySelectorAll('.row')) {
			expect(tabStops(row)).toEqual([]);
		}
		for (const el of container.querySelectorAll('.row input, .row a, .row button, .row select')) {
			expect(el.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		}
		// The whole grid: the grid element is not inside itself, so what is left is the header's one stop.
		expect(tabStops(grid)).toEqual([headerStops(container)[0]]);
	});

	it('also for rows drawn later', async () => {
		const { container, rerender } = setup();
		await rerender({ rows: [...rows, { id: 3, name: 'Gamma', category: 'Third' }] });
		await reported();
		expect(container.querySelectorAll('.row').length).toBe(3);
		for (const row of container.querySelectorAll('.row')) expect(tabStops(row)).toEqual([]);
	});

	it('leaves the cell editor focusable and a tab stop', async () => {
		const { container } = setup();
		await selectCell(container, 0, 'name');
		await fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' });
		const editor = await waitFor(() => screen.getByRole('textbox'));
		await reported();
		expect(document.activeElement).toBe(editor);
		expect(editor.tabIndex).toBe(0);
		expect(editor.getAttribute('tabindex')).not.toBe(SUPPRESSED_TABINDEX);
	});

	it('Space on the active cell still toggles the row checkbox', async () => {
		const { container } = setup();
		await selectCell(container, 0, 'category');
		await fireEvent.keyDown(screen.getByRole('grid'), { key: ' ' });
		expect(container.querySelector<HTMLInputElement>('.row .select-box')!.checked).toBe(true);
	});
});

describe('F2 on a cell that is not editable: into its controls', () => {
	it('focuses the first enabled control; Tab / Shift+Tab walk the cell; Shift+Tab before the first and Escape go back to the grid element', async () => {
		const { container } = setup();
		await reported();
		const grid = screen.getByRole('grid');
		const active = await selectCell(container, 0, 'actions');
		const edit = container.querySelector<HTMLElement>('[data-act="edit-1"]')!;
		const pick = container.querySelector<HTMLElement>('[data-act="pick-1"]')!;

		expect(key(grid, { key: 'F2' }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(edit);
		// The disabled button is skipped.
		expect(key(edit, { key: 'Tab' }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(pick);
		// Past the last one Tab is the browser's.
		expect(key(pick, { key: 'Tab' }).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(pick);
		expect(key(pick, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(edit);
		expect(key(edit, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(grid);

		key(grid, { key: 'F2' });
		expect(document.activeElement).toBe(edit);
		expect(key(edit, { key: 'Escape' }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(grid);
		expect(container.querySelector('.cell.active')).toBe(active);
	});

	it('walks a focusable wrapper and the control inside it in order', async () => {
		const wrapped = createRawSnippet<[Row]>((row) => ({
			render: () =>
				`<span><div tabindex="0" data-act="wrap-${row().id}">` +
				`<button type="button" data-act="inner-${row().id}">inner</button></div>` +
				`<button type="button" data-act="after-${row().id}">after</button></span>`
		}));
		const { container } = setup({
			columns: [
				...baseColumns.filter((c) => c.id !== 'actions'),
				{ id: 'actions', header: 'Actions', accessor: () => '', sortable: false, render: wrapped }
			]
		});
		await reported();
		const grid = screen.getByRole('grid');
		await selectCell(container, 0, 'actions');
		const wrap = container.querySelector<HTMLElement>('[data-act="wrap-1"]')!;
		const inner = container.querySelector<HTMLElement>('[data-act="inner-1"]')!;
		const after = container.querySelector<HTMLElement>('[data-act="after-1"]')!;

		key(grid, { key: 'F2' });
		expect(document.activeElement).toBe(wrap);
		key(wrap, { key: 'Tab' });
		expect(document.activeElement).toBe(inner);
		expect(key(inner, { key: 'Tab' }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(after);
		key(after, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(inner);
		expect(key(inner, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(wrap);
	});

	it('reaches a `cell` link the same way, and F2 on it comes back', async () => {
		const { container } = setup();
		await reported();
		const grid = screen.getByRole('grid');
		await selectCell(container, 0, 'open');
		key(grid, { key: 'F2' });
		const link = screen.getByRole('link', { name: 'Open Alpha' });
		expect(document.activeElement).toBe(link);
		key(link, { key: 'F2' });
		expect(document.activeElement).toBe(grid);
	});

	it('does nothing on a cell without a control, and leaves a key the control handled', async () => {
		const { container } = setup();
		await reported();
		const grid = screen.getByRole('grid');
		await selectCell(container, 0, 'category');
		expect(key(grid, { key: 'F2' }).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(grid);

		await selectCell(container, 0, 'actions');
		key(grid, { key: 'F2' });
		const edit = container.querySelector<HTMLElement>('[data-act="edit-1"]')!;
		edit.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
		key(edit, { key: 'Escape' });
		expect(document.activeElement).toBe(edit);
	});

	it('still starts the editor on an editable cell', async () => {
		const { container } = setup();
		await selectCell(container, 0, 'name');
		await fireEvent.keyDown(screen.getByRole('grid'), { key: 'F2' });
		expect(await waitFor(() => screen.getByRole('textbox'))).toBeTruthy();
	});
});
