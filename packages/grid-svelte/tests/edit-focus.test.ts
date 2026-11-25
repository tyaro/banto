// @vitest-environment jsdom
/** Issue #212: keyboard editing retains focus unless the user moves elsewhere (spec §4.5). */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import type { CellEdit, GridColumn } from '../src/types';

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
	document.querySelectorAll('[data-outside]').forEach((element) => element.remove());
});
interface Row {
	id: number;
	name: string;
	category: string;
}
const rows: Row[] = [
	{ id: 1, name: 'Alpha', category: 'First' },
	{ id: 2, name: 'Beta', category: 'Second' }
];
const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', editable: true },
	{ id: 'category', header: 'Category', accessor: 'category', editable: true }
];
function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function setup(
	onCellEdit?: (edit: CellEdit<Row>) => void | Promise<void>,
	mode: 'client' | 'server' = 'client',
	gridColumns = columns
) {
	const view = render(BantoGrid<Row>, {
		rows,
		columns: gridColumns,
		mode,
		totalRows: rows.length,
		getRowId: (row: Row) => row.id,
		onCellEdit
	});
	const grid = screen.getByRole('grid');
	const cell = (row = 0, field = 'name') =>
		view.container.querySelector<HTMLElement>(
			`[data-cell-row="${row}"][data-cell-field="${field}"]`
		)!;
	return { ...view, grid, cell };
}
async function draft(cell: HTMLElement, value = 'Changed') {
	await fireEvent.doubleClick(cell);
	const editor = screen.getByRole('textbox') as HTMLInputElement;
	expect(document.activeElement).toBe(editor);
	await fireEvent.input(editor, { target: { value } });
	return editor;
}
async function finish(save: ReturnType<typeof deferred>, outcome: 'success' | 'failure') {
	if (outcome === 'success') save.resolve();
	else save.reject(new Error('Save failed'));
	await save.promise.catch(() => {});
	await tick();
}
function outside(tag: 'button' | 'div' = 'button') {
	const element = document.createElement(tag);
	element.dataset.outside = '';
	document.body.appendChild(element);
	return element;
}

describe.each(['client', 'server'] as const)('keyboard edit focus (%s)', (mode) => {
	it('Enter restores grid focus so F2 and typing edit the following row', async () => {
		const save = deferred();
		const onCellEdit = vi.fn(() => save.promise);
		const { grid, cell } = setup(onCellEdit, mode);
		const editor = await draft(cell());
		await fireEvent.keyDown(editor, { key: 'Enter' });
		await finish(save, 'success');
		expect(document.activeElement).toBe(grid);
		expect(cell(1).classList.contains('active')).toBe(true);
		await fireEvent.keyDown(document.activeElement!, { key: 'F2' });
		const next = screen.getByRole('textbox') as HTMLInputElement;
		expect(document.activeElement).toBe(next);
		expect(next.value).toBe('Beta');
		await fireEvent.input(next, { target: { value: 'Next draft' } });
		expect(next.value).toBe('Next draft');
		expect(onCellEdit).toHaveBeenCalledTimes(1);
	});
	it('Escape restores grid focus so arrows and F2 continue without saving', async () => {
		const onCellEdit = vi.fn();
		const { grid, cell } = setup(onCellEdit, mode);
		await fireEvent.keyDown(await draft(cell()), { key: 'Escape' });
		expect(document.activeElement).toBe(grid);
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		await fireEvent.keyDown(document.activeElement!, { key: 'F2' });
		expect(document.activeElement).toBe(screen.getByRole('textbox'));
		expect((document.activeElement as HTMLInputElement).value).toBe('First');
		expect(onCellEdit).not.toHaveBeenCalled();
	});
	it.each([false, true])('Tab restores grid focus after moving (shift=%s)', async (shiftKey) => {
		const save = deferred();
		const { grid, cell } = setup(() => save.promise, mode);
		await fireEvent.keyDown(await draft(cell(0, shiftKey ? 'category' : 'name')), {
			key: 'Tab',
			shiftKey
		});
		await finish(save, 'success');
		expect(document.activeElement).toBe(grid);
		expect(cell(0, shiftKey ? 'name' : 'category').classList.contains('active')).toBe(true);
	});
	it('an unchanged draft closes and returns focus without calling the provider', async () => {
		const save = vi.fn();
		const { grid, cell } = setup(save, mode);
		await fireEvent.keyDown(await draft(cell(), 'Alpha'), { key: 'Enter' });
		await tick();
		expect(document.activeElement).toBe(grid);
		expect(save).not.toHaveBeenCalled();
	});
});

it('a failed keyboard save restores the draft focus and permits retry', async () => {
	const first = deferred();
	const second = deferred();
	const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	const { grid, cell } = setup(save);
	const editor = await draft(cell());
	await fireEvent.keyDown(editor, { key: 'Enter' });
	// Exercise incidental body focus without a newer pointer/focus target.
	editor.blur();
	await finish(first, 'failure');
	expect(document.activeElement).toBe(editor);
	expect(editor.value).toBe('Changed');
	expect(screen.getByRole('alert').textContent).toContain('Save failed');
	await fireEvent.input(editor, { target: { value: 'Retry' } });
	await fireEvent.keyDown(editor, { key: 'Enter' });
	await finish(second, 'success');
	expect(document.activeElement).toBe(grid);
	expect(save).toHaveBeenCalledTimes(2);
});

it.each(['success', 'failure'] as const)(
	'does not reclaim focus or selection after outside intent on %s',
	async (outcome) => {
		const save = deferred();
		const { cell } = setup(() => save.promise);
		const editor = await draft(cell());
		await fireEvent.keyDown(editor, { key: 'Enter' });
		const button = outside();
		await fireEvent.pointerDown(button);
		button.focus();
		await finish(save, outcome);
		expect(document.activeElement).toBe(button);
		expect(cell().classList.contains('active')).toBe(true);
		if (outcome === 'failure')
			expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Changed');
	}
);

it.each(['non-focusable click', 'programmatic focus then removal', 'window blur'] as const)(
	'body focus after %s does not authorize restoration',
	async (action) => {
		const save = deferred();
		const { cell } = setup(() => save.promise);
		const editor = await draft(cell());
		await fireEvent.keyDown(editor, { key: 'Enter' });
		editor.blur();
		if (action === 'non-focusable click') await fireEvent.pointerDown(outside('div'));
		else if (action === 'programmatic focus then removal') {
			const button = outside();
			button.focus();
			button.remove();
		} else window.dispatchEvent(new Event('blur'));
		await finish(save, 'success');
		expect(document.activeElement).toBe(document.body);
		expect(cell().classList.contains('active')).toBe(true);
	}
);

it('a blur validation failure keeps the outside target focused', async () => {
	const save = deferred();
	const { cell } = setup(() => save.promise);
	await draft(cell());
	const button = outside();
	button.focus();
	await tick();
	await finish(save, 'failure');
	expect(document.activeElement).toBe(button);
	expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Changed');
});

it('a rejected save after an outside non-focusable click leaves the draft unfocused', async () => {
	const save = deferred();
	const { cell } = setup(() => save.promise);
	const editor = await draft(cell());
	await fireEvent.keyDown(editor, { key: 'Enter' });
	editor.blur();
	await fireEvent.pointerDown(outside('div'));
	await finish(save, 'failure');
	expect(document.activeElement).toBe(document.body);
	expect(editor.value).toBe('Changed');
	// Explicitly returning to the draft gives this session focus ownership again.
	editor.focus();
	await fireEvent.keyDown(editor, { key: 'Escape' });
	expect(document.activeElement).toBe(screen.getByRole('grid'));
});

it('a save completing after unmount never focuses the detached grid', async () => {
	const save = deferred();
	const { cell, grid, unmount } = setup(() => save.promise);
	await fireEvent.keyDown(await draft(cell()), { key: 'Enter' });
	const focus = vi.spyOn(grid, 'focus');
	await unmount();
	await finish(save, 'success');
	expect(focus).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(document.body);
});

it.each(['Enter', 'Escape'])(
	'a fresh %s after returning to the window renews editor focus ownership',
	async (key) => {
		const { grid, cell } = setup();
		const editor = await draft(cell());
		window.dispatchEvent(new Event('blur'));
		window.dispatchEvent(new Event('focus'));
		expect(document.activeElement).toBe(editor);
		await fireEvent.keyDown(editor, { key });
		await tick();
		expect(document.activeElement).toBe(grid);
	}
);

it.each(['success', 'failure'] as const)(
	'a newer editor retains focus when the old save reports %s',
	async (outcome) => {
		const save = deferred();
		const { cell } = setup(() => save.promise);
		await fireEvent.keyDown(await draft(cell()), { key: 'Enter' });
		const newer = await draft(cell(1), 'Newer draft');
		await finish(save, outcome);
		expect(document.activeElement).toBe(newer);
		expect(newer.value).toBe('Newer draft');
		expect(cell(1).classList.contains('active')).toBe(true);
	}
);

it('client validation leaves the invalid draft focused for correction', async () => {
	const save = vi.fn();
	const { grid, cell } = setup(save, 'client', [
		{ ...columns[0], validate: (value) => (value === 'Changed' ? 'Try another name' : null) },
		columns[1]
	]);
	const editor = await draft(cell());
	await fireEvent.keyDown(editor, { key: 'Enter' });
	expect(document.activeElement).toBe(editor);
	expect(editor.value).toBe('Changed');
	expect(screen.getByRole('alert').textContent).toContain('Try another name');
	expect(save).not.toHaveBeenCalled();
	await fireEvent.input(editor, { target: { value: 'Valid' } });
	await fireEvent.keyDown(editor, { key: 'Enter' });
	await tick();
	expect(document.activeElement).toBe(grid);
	expect(save).toHaveBeenCalledTimes(1);
});

it('a pointer-selected cell remains selected when a keyboard save completes', async () => {
	const save = deferred();
	const { grid, cell } = setup(() => save.promise);
	await fireEvent.keyDown(await draft(cell()), { key: 'Tab' });
	await fireEvent.pointerDown(cell(1), { button: 0, pointerId: 1 });
	expect(document.activeElement).toBe(grid);
	expect(cell(1).classList.contains('active')).toBe(true);
	await finish(save, 'success');
	expect(document.activeElement).toBe(grid);
	expect(cell(1).classList.contains('active')).toBe(true);
});

/**
 * #964 G2 (grid-touch-edit-design §4.1 ②③ / §5.1): something that writes into
 * the focused editor without moving focus (an on-screen keypad), and an app
 * that then commits the cell by blurring the editor.
 */
describe('a writer that leaves focus on the editor (#964 G2)', () => {
	/** A keypad key: a press outside the editor that leaves focus where it is. */
	async function pressOutside() {
		await fireEvent.pointerDown(outside('div'));
	}
	/** What the keypad's confirm does to the field (the value, then `input`). */
	async function write(editor: HTMLInputElement, value: string) {
		await fireEvent.input(editor, { target: { value } });
	}

	it('every editor carries the public marker attribute', async () => {
		const { cell } = setup(undefined, 'client', [
			columns[0],
			{ id: 'category', header: 'Category', accessor: 'category', editable: true, editor: 'select' }
		]);
		await fireEvent.doubleClick(cell());
		expect(screen.getByRole('textbox').hasAttribute('data-grid-editor')).toBe(true);
		await fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
		await fireEvent.doubleClick(cell(0, 'category'));
		expect(screen.getByRole('combobox').hasAttribute('data-grid-editor')).toBe(true);
	});

	it.each(['client', 'server'] as const)(
		'input on the focused editor takes the claim back; the blur commit returns focus to the grid (%s)',
		async (mode) => {
			const save = deferred();
			const onCellEdit = vi.fn(() => save.promise);
			const { grid, cell } = setup(onCellEdit, mode);
			await fireEvent.doubleClick(cell());
			const editor = screen.getByRole('textbox') as HTMLInputElement;
			await pressOutside();
			expect(document.activeElement).toBe(editor);
			await write(editor, 'Typed');
			editor.blur();
			expect(document.activeElement).toBe(document.body);
			await finish(save, 'success');
			expect(onCellEdit).toHaveBeenCalledTimes(1);
			expect(screen.queryByRole('textbox')).toBeNull();
			expect(document.activeElement).toBe(grid);
			// No move: the edited cell stays the active one.
			expect(cell().classList.contains('active')).toBe(true);
		}
	);

	it('without an input the press outside keeps the claim given up', async () => {
		const { cell } = setup(vi.fn());
		const editor = await draft(cell());
		await pressOutside();
		editor.blur();
		await tick();
		await tick();
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(document.activeElement).toBe(document.body);
	});

	it('an input on an editor that lost focus does not take the claim back', async () => {
		const first = deferred();
		const onCellEdit = vi.fn<() => Promise<void> | void>(() => first.promise);
		const { cell } = setup(onCellEdit);
		const editor = await draft(cell());
		await pressOutside();
		editor.blur();
		await finish(first, 'failure');
		// The refused draft stays open, unfocused (the claim was given up).
		expect(document.activeElement).toBe(document.body);
		await write(editor, 'Late');
		onCellEdit.mockImplementation(() => {});
		await fireEvent.blur(editor);
		await tick();
		expect(onCellEdit).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(document.activeElement).toBe(document.body);
	});

	it('a blur towards another control never pulls focus back to the grid', async () => {
		const { cell } = setup(vi.fn());
		const editor = await draft(cell());
		const button = outside();
		button.focus();
		await tick();
		await tick();
		expect(editor.isConnected).toBe(false);
		expect(document.activeElement).toBe(button);
	});

	it('an input while the save is pending does not take the claim back', async () => {
		const save = deferred();
		const { cell } = setup(() => save.promise);
		const editor = await draft(cell());
		await fireEvent.keyDown(editor, { key: 'Enter' });
		await pressOutside();
		expect(document.activeElement).toBe(editor);
		await write(editor, 'While saving');
		await finish(save, 'success');
		// The owner's Enter would have moved down and focused the grid.
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(cell(1).classList.contains('active')).toBe(false);
		expect(document.activeElement).toBe(document.body);
	});

	it('acting elsewhere while the save is pending wins when it completes', async () => {
		const save = deferred();
		const { cell } = setup(() => save.promise);
		const editor = await draft(cell());
		await pressOutside();
		await write(editor, 'Typed');
		editor.blur();
		await pressOutside();
		await finish(save, 'success');
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(document.activeElement).toBe(document.body);
	});

	it('a rejected save leaves the draft and focuses it again for the owner', async () => {
		const save = deferred();
		const { cell } = setup(() => save.promise);
		const editor = await draft(cell());
		await pressOutside();
		await write(editor, 'Refused');
		editor.blur();
		await finish(save, 'failure');
		const failed = screen.getByRole('textbox') as HTMLInputElement;
		expect(failed.value).toBe('Refused');
		expect(document.activeElement).toBe(failed);
		expect(screen.getByText('Save failed')).toBeTruthy();
	});
});
