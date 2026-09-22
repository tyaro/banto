// @vitest-environment jsdom
/** Issue #205: an inline draft belongs to a row ID, never its display index. */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { GridState } from '../src/state.svelte';
import type { CellEdit, GridColumn } from '../src/types';

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
	id: number;
	name: string;
	category: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', editable: true },
	{ id: 'category', header: 'Category', accessor: 'category' }
];
const rows: Row[] = [
	{ id: 1, name: 'Alpha', category: 'First' },
	{ id: 2, name: 'Beta', category: 'Second' },
	{ id: 3, name: 'Gamma', category: 'Second' }
];

function setup(mode: 'client' | 'server' = 'client') {
	const edits: CellEdit<Row>[] = [];
	const state = new GridState(columns);
	const view = render(BantoGrid<Row>, {
		rows,
		columns,
		state,
		mode,
		totalRows: rows.length,
		getRowId: (row: Row) => row.id,
		onCellEdit: (edit: CellEdit<Row>) => {
			edits.push(edit);
		}
	});
	return { ...view, edits, state };
}

async function startDraft(container: HTMLElement, rowIndex: number) {
	await fireEvent.doubleClick(
		container.querySelector(`[data-cell-row="${rowIndex}"][data-cell-field="name"]`)!
	);
	await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Beta draft' } });
}

async function assertDraftAndCommit(rowIndex: number, edits: CellEdit<Row>[]) {
	const editor = screen.getByRole('textbox') as HTMLInputElement;
	expect(editor.value).toBe('Beta draft');
	expect(editor.closest('[data-cell-row]')?.getAttribute('data-cell-row')).toBe(String(rowIndex));
	await fireEvent.keyDown(editor, { key: 'Enter' });
	expect(edits).toHaveLength(1);
	expect(edits[0]).toMatchObject({
		rowId: 2,
		row: { id: 2 },
		field: 'name',
		oldValue: 'Beta',
		value: 'Beta draft'
	});
}

describe.each(['client', 'server'] as const)('inline edit row identity (%s)', (mode) => {
	it('keeps the draft on the same row after an incoming reorder', async () => {
		const { container, rerender, edits } = setup(mode);
		await startDraft(container, 1);
		// Fresh objects model a provider refresh rather than in-place DOM movement.
		await rerender({ rows: [rows[1], rows[2], rows[0]].map((row) => ({ ...row })) });
		await assertDraftAndCommit(0, edits);
	});

	it('keeps the draft on the same row after a preceding row is deleted', async () => {
		const { container, rerender, edits } = setup(mode);
		await startDraft(container, 1);
		await rerender({ rows: rows.slice(1), totalRows: 2 });
		await assertDraftAndCommit(0, edits);
	});

	it('cancels when the edited row disappears and does not resurrect the draft', async () => {
		const { container, rerender, edits } = setup(mode);
		await startDraft(container, 1);
		await rerender({ rows: [rows[0], rows[2]], totalRows: 2 });
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(edits).toHaveLength(0);
		await rerender({ rows, totalRows: 3 });
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(edits).toHaveLength(0);
	});
});

it('preserves the edited row when client sorting changes its position', async () => {
	const { container, state, edits } = setup();
	await startDraft(container, 1);
	// Ascending category puts Second rows first after the second toggle.
	state.toggleSort('category', false);
	state.toggleSort('category', false);
	await tick();
	await assertDraftAndCommit(0, edits);
});

it('preserves the edited row when group headers change display indices', async () => {
	const { container, state, edits } = setup();
	await startDraft(container, 1);
	state.setGroupBy('category');
	await tick();
	// First header, Alpha, Second header, Beta, Gamma.
	await assertDraftAndCommit(3, edits);
});

it('cancels when a sparse server refresh replaces the edited row with a hole', async () => {
	const { container, rerender, edits } = setup('server');
	await startDraft(container, 1);
	await rerender({ rows: [rows[0], undefined, rows[2]] });
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(edits).toHaveLength(0);
	// Loading another record into that slot must not inherit the abandoned edit.
	await rerender({ rows: [rows[0], { id: 4, name: 'Delta', category: 'Second' }, rows[2]] });
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(edits).toHaveLength(0);
});
