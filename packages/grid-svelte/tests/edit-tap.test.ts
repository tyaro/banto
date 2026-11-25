// @vitest-environment jsdom
/**
 * #964 G1 (grid-touch-edit-design §3, §9): a touch / pen tap starts editing.
 * A tap is the browser's `click` that follows a `touch` / `pen` `pointerdown`
 * on the same cell; the press alone does nothing (it may become a scroll).
 * jsdom has no hit testing or panning: the scroll is its `pointercancel`.
 */
import { cleanup, createEvent, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
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
	{ id: 2, name: 'ノート', price: 100 },
	{ id: 3, name: '消しゴム', price: 200 }
];
const columns: GridColumn<Row>[] = [
	{ id: 'name', header: '商品名', accessor: 'name', editable: true },
	{ id: 'price', header: '価格', accessor: 'price' }
];
const readOnlyColumns: GridColumn<Row>[] = columns.map((column) => ({
	...column,
	editable: false
}));
const getRowId = (row: Row) => row.id;

type PointerType = 'touch' | 'pen' | 'mouse';

function cellOf(container: HTMLElement, row: number, field: string): HTMLElement {
	return container.querySelector<HTMLElement>(
		`[data-cell-row="${row}"][data-cell-field="${field}"]`
	)!;
}

function editorIn(container: HTMLElement): HTMLInputElement | null {
	return container.querySelector<HTMLInputElement>(
		'[role="gridcell"] input:not([type="checkbox"])'
	);
}

function activeCell(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>('[data-cell-row].active');
}

function gridOf(container: HTMLElement): HTMLElement {
	return container.querySelector<HTMLElement>('[role="grid"]')!;
}

async function press(target: HTMLElement, pointerType: PointerType, pointerId = 1) {
	await fireEvent.pointerDown(target, { pointerType, pointerId, button: 0 });
}

/** pointerdown + pointerup + click, as the browser delivers one tap / click. */
async function tap(target: HTMLElement, pointerType: PointerType, pointerId = 1) {
	await press(target, pointerType, pointerId);
	await fireEvent.pointerUp(target, { pointerType, pointerId, button: 0 });
	await fireEvent.click(target, { detail: 1 });
}

/** Counts the window listeners of the cell drag that are still attached. */
function trackWindowListeners() {
	const live = new Map<string, Set<unknown>>();
	const add = window.addEventListener.bind(window);
	const remove = window.removeEventListener.bind(window);
	vi.spyOn(window, 'addEventListener').mockImplementation(((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	) => {
		if (!live.has(type)) live.set(type, new Set());
		live.get(type)!.add(listener);
		add(type, listener, options);
	}) as typeof window.addEventListener);
	vi.spyOn(window, 'removeEventListener').mockImplementation(((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions
	) => {
		live.get(type)?.delete(listener);
		remove(type, listener, options);
	}) as typeof window.removeEventListener);
	return (type: string) => live.get(type)?.size ?? 0;
}

describe('BantoGrid tap to edit (#964 G1)', () => {
	it.each(['touch', 'pen'] as const)(
		'a %s tap on an editable cell starts editing',
		async (type) => {
			const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
			await tap(cellOf(container, 1, 'name'), type);
			const editor = editorIn(container);
			expect(editor).not.toBeNull();
			expect(editor!.value).toBe('ノート');
			expect(cellOf(container, 1, 'name').contains(editor)).toBe(true);
			expect(activeCell(container)).toBe(cellOf(container, 1, 'name'));
		}
	);

	it('a mouse click selects and does not start editing', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		await tap(cellOf(container, 1, 'name'), 'mouse');
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBe(cellOf(container, 1, 'name'));
	});

	it('a click with no pointerdown (keyboard / assistive technology) does not start editing', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		await fireEvent.click(cellOf(container, 1, 'name'), { detail: 1 });
		expect(editorIn(container)).toBeNull();
	});

	it('a touch press alone moves neither the active cell nor focus', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		await tap(cellOf(container, 0, 'price'), 'mouse');
		(document.activeElement as HTMLElement).blur();
		await press(cellOf(container, 2, 'price'), 'touch');
		expect(activeCell(container)).toBe(cellOf(container, 0, 'price'));
		expect(document.activeElement).not.toBe(gridOf(container));
	});

	it('a touch press does not commit the open editor of another cell; the tap does', async () => {
		const onCellEdit = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onCellEdit });
		await tap(cellOf(container, 0, 'name'), 'touch');
		const editor = editorIn(container)!;
		editor.focus();
		await fireEvent.input(editor, { target: { value: '万年筆' } });

		await press(cellOf(container, 2, 'price'), 'touch', 2);
		expect(onCellEdit).not.toHaveBeenCalled();
		expect(editorIn(container)).toBe(editor);

		await fireEvent.pointerUp(cellOf(container, 2, 'price'), {
			pointerType: 'touch',
			pointerId: 2
		});
		await fireEvent.click(cellOf(container, 2, 'price'), { detail: 1 });
		await tick();
		expect(onCellEdit).toHaveBeenCalledTimes(1);
		expect(onCellEdit.mock.calls[0][0]).toMatchObject({ rowId: 1, field: 'name', value: '万年筆' });
		expect(activeCell(container)).toBe(cellOf(container, 2, 'price'));
	});

	it('after pointercancel (a scroll) nothing starts and the active cell stays', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		await tap(cellOf(container, 0, 'price'), 'mouse');
		const target = cellOf(container, 1, 'name');
		await press(target, 'touch');
		await fireEvent.pointerCancel(target, { pointerType: 'touch', pointerId: 1 });
		// A click that is not this press's (no pointerdown of its own).
		await fireEvent.click(target, { detail: 1 });
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBe(cellOf(container, 0, 'price'));
	});

	it('a tap that ends on another cell is not a tap on either', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		await press(cellOf(container, 0, 'name'), 'touch');
		await fireEvent.click(cellOf(container, 1, 'name'), { detail: 1 });
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBeNull();
	});

	it('a press released away from its cell is dropped: a later non-pointer click does not edit', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const target = cellOf(container, 1, 'name');
		await press(target, 'pen');
		await fireEvent.pointerUp(document.body, { pointerType: 'pen', pointerId: 1 });
		await fireEvent.click(target, { detail: 1 });
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBeNull();
	});

	it('where click is a plain MouseEvent, a click during a held press or a synthetic one is not its tap', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const target = cellOf(container, 1, 'name');
		// Held: no pointerup yet. `detail` 1 is a real click, 0 a synthetic one.
		await press(target, 'pen');
		await fireEvent.click(target, { detail: 1 });
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBeNull();

		// Released on the cell, then a click known to be synthetic.
		await press(target, 'pen');
		await fireEvent.pointerUp(target, { pointerType: 'pen', pointerId: 1 });
		await fireEvent.click(target, { detail: 0 });
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBeNull();
	});

	it('where click is a PointerEvent, only the click of the pressing pointer is its tap', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const target = cellOf(container, 1, 'name');
		const clickOf = (pointerId: number, pointerType: string) =>
			new PointerEvent('click', { bubbles: true, cancelable: true, pointerId, pointerType });

		// The press is still held (no pointerup yet): a synthetic click
		// (`element.click()`, a keyboard, assistive technology) is not its tap.
		await press(target, 'touch', 4);
		target.dispatchEvent(clickOf(-1, ''));
		await tick();
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBeNull();

		await press(target, 'touch', 4);
		await fireEvent.pointerUp(target, { pointerType: 'touch', pointerId: 4 });
		target.dispatchEvent(clickOf(5, 'touch'));
		await tick();
		expect(editorIn(container)).toBeNull();

		await press(target, 'touch', 4);
		await fireEvent.pointerUp(target, { pointerType: 'touch', pointerId: 4 });
		target.dispatchEvent(clickOf(4, 'touch'));
		await tick();
		expect(editorIn(container)).not.toBeNull();
	});

	it('leaves no window listener behind after a tap, a cancelled press or a cancelled mouse drag', async () => {
		const liveCount = trackWindowListeners();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId });
		const target = cellOf(container, 1, 'price');
		const types = ['pointermove', 'pointerup', 'pointercancel'];
		const before = types.map(liveCount);

		await press(target, 'touch');
		expect(liveCount('pointermove')).toBe(before[0]);
		await fireEvent.pointerCancel(target, { pointerType: 'touch', pointerId: 1 });
		expect(types.map(liveCount)).toEqual(before);

		await tap(target, 'touch', 2);
		expect(types.map(liveCount)).toEqual(before);

		await press(target, 'mouse', 7);
		expect(liveCount('pointermove')).toBe(before[0] + 1);
		await fireEvent.pointerCancel(window, { pointerType: 'mouse', pointerId: 7 });
		expect(types.map(liveCount)).toEqual(before);

		await press(target, 'mouse', 8);
		await fireEvent.pointerUp(window, { pointerType: 'mouse', pointerId: 8 });
		expect(types.map(liveCount)).toEqual(before);
	});

	it('a long press (contextmenu, no click) calls onRowContextMenu and does not start editing', async () => {
		const onRowContextMenu = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowContextMenu });
		const target = cellOf(container, 1, 'name');
		await press(target, 'touch');
		const event = createEvent.contextMenu(target, { clientX: 40, clientY: 50 });
		target.dispatchEvent(event);
		await tick();
		expect(onRowContextMenu).toHaveBeenCalledWith(rows[1], { x: 40, y: 50 });
		expect(editorIn(container)).toBeNull();
		// A later stray click is not the long press's tap.
		await fireEvent.click(target, { detail: 1 });
		expect(editorIn(container)).toBeNull();
	});

	it('editOnTap={false}: a tap only selects; the double tap still edits', async () => {
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, editOnTap: false });
		const target = cellOf(container, 1, 'name');
		await tap(target, 'touch');
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBe(target);
		await tap(target, 'touch');
		await fireEvent.dblClick(target);
		expect(editorIn(container)).not.toBeNull();
	});

	it('a tap on a read-only cell of an editable grid selects and does not call onRowClick', async () => {
		const onRowClick = vi.fn();
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onRowClick });
		await tap(cellOf(container, 1, 'price'), 'touch');
		expect(onRowClick).not.toHaveBeenCalled();
		expect(editorIn(container)).toBeNull();
		expect(activeCell(container)).toBe(cellOf(container, 1, 'price'));
		expect(document.activeElement).toBe(gridOf(container));
	});

	it('a tap on a grid with no editable column calls onRowClick, as a click does', async () => {
		const onRowClick = vi.fn();
		const { container } = render(BantoGrid<Row>, {
			rows,
			columns: readOnlyColumns,
			getRowId,
			onRowClick
		});
		await tap(cellOf(container, 1, 'name'), 'touch');
		expect(onRowClick).toHaveBeenCalledTimes(1);
		expect(onRowClick).toHaveBeenCalledWith(rows[1]);
		expect(activeCell(container)).toBe(cellOf(container, 1, 'name'));
	});
});

describe('BantoGrid: the cell being edited keeps its draft (#964 G1)', () => {
	async function startWithDraft(pointerType: PointerType) {
		const onCellEdit = vi.fn();
		const view = render(BantoGrid<Row>, { rows, columns, getRowId, onCellEdit });
		const cell = cellOf(view.container, 1, 'name');
		if (pointerType === 'mouse') await fireEvent.dblClick(cell);
		else await tap(cell, pointerType);
		const editor = editorIn(view.container)!;
		editor.focus();
		await fireEvent.input(editor, { target: { value: '手帳' } });
		return { ...view, cell, editor, onCellEdit };
	}

	it('a double-click inside the editor does not restart the session', async () => {
		const { container, editor, onCellEdit } = await startWithDraft('mouse');
		await fireEvent.click(editor);
		await fireEvent.click(editor);
		await fireEvent.dblClick(editor);
		await tick();
		expect(editorIn(container)).toBe(editor);
		expect(editor.value).toBe('手帳');
		expect(onCellEdit).not.toHaveBeenCalled();
	});

	it('the second tap of a double tap, landing in the editor, keeps the draft', async () => {
		const { container, editor, onCellEdit } = await startWithDraft('touch');
		// The editor stops its own pointerdown; click and dblclick bubble.
		await tap(editor, 'touch', 2);
		await fireEvent.dblClick(editor);
		await tick();
		expect(editorIn(container)).toBe(editor);
		expect(editor.value).toBe('手帳');
		expect(document.activeElement).toBe(editor);
		expect(onCellEdit).not.toHaveBeenCalled();
	});

	it('the compatibility mousedown of a tap on that padding does not move focus; a mouse press still does', async () => {
		const { cell, editor } = await startWithDraft('touch');
		await press(cell, 'touch', 2);
		const compat = createEvent.mouseDown(cell);
		cell.dispatchEvent(compat);
		expect(compat.defaultPrevented).toBe(true);
		// Inside the editor the press is the input's own (caret placement).
		const inside = createEvent.mouseDown(editor);
		editor.dispatchEvent(inside);
		expect(inside.defaultPrevented).toBe(false);

		await press(cell, 'mouse', 3);
		const mouse = createEvent.mouseDown(cell);
		cell.dispatchEvent(mouse);
		expect(mouse.defaultPrevented).toBe(false);
	});

	it('a tap on a cell whose save is pending opens a new session, as a double-click does (#210)', async () => {
		const onCellEdit = vi.fn(() => new Promise<void>(() => {}));
		const { container } = render(BantoGrid<Row>, { rows, columns, getRowId, onCellEdit });
		const cell = cellOf(container, 1, 'name');
		await tap(cell, 'touch');
		const first = editorIn(container)!;
		first.focus();
		await fireEvent.input(first, { target: { value: '手帳' } });
		await fireEvent.keyDown(first, { key: 'Enter' });
		expect(onCellEdit).toHaveBeenCalledTimes(1);
		expect(cell.getAttribute('aria-busy')).toBe('true');

		await tap(cell, 'touch', 2);
		await tick();
		expect(cell.getAttribute('aria-busy')).toBe('false');
		expect(editorIn(container)!.value).toBe('ノート');
	});

	it('a tap on the padding of the cell being edited neither commits nor restarts', async () => {
		const { container, cell, editor, onCellEdit } = await startWithDraft('touch');
		await tap(cell, 'touch', 2);
		await fireEvent.dblClick(cell);
		await tick();
		expect(editorIn(container)).toBe(editor);
		expect(editor.value).toBe('手帳');
		expect(document.activeElement).toBe(editor);
		expect(onCellEdit).not.toHaveBeenCalled();
	});
});
