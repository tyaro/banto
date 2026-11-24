// @vitest-environment jsdom
/**
 * Issue #890: `columns` can change after mount, and the user's state (widths,
 * order, sort, filters, pins, hidden, selection, scroll) survives it.
 *
 * The component cases follow what banto-industrial's Hub tag table does: an
 * edit mode that flips `editable` on every column (the Hub used to rebuild the
 * grid with `{#key}` for this), and `unit` / `decimals` columns that come and
 * go.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
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

interface Tag {
	id: number;
	name: string;
	value: number;
	unit: string;
	decimals: number;
}

/** The Hub's tag table: `edit` is its edit mode, `analog` adds unit / decimals. */
function tagColumns({ edit = false, analog = false } = {}): GridColumn<Tag>[] {
	return [
		{ id: 'name', header: 'Name', accessor: 'name', width: 200, editable: edit },
		{ id: 'value', header: 'Value', accessor: 'value', editable: edit },
		...(analog
			? ([
					{ id: 'unit', header: 'Unit', accessor: 'unit', width: 70, editable: edit },
					{ id: 'decimals', header: 'Decimals', accessor: 'decimals', editable: edit }
				] satisfies GridColumn<Tag>[])
			: []),
		{ id: 'id', header: 'ID', accessor: 'id' }
	];
}

const rows: Tag[] = [
	{ id: 1, name: 'Beta', value: 20, unit: 'kPa', decimals: 1 },
	{ id: 2, name: 'Alpha', value: 10, unit: 'degC', decimals: 2 },
	{ id: 3, name: 'Delta', value: 30, unit: 'kPa', decimals: 0 }
];

describe('GridState.setColumns (#890)', () => {
	/** A state the user has touched everywhere. */
	function usedState() {
		const state = new GridState<Tag>(tagColumns({ analog: true }));
		state.resizeColumn('name', 320);
		state.resizeColumn('unit', 90);
		state.moveColumn('id', 0);
		state.toggleSort('value', false);
		state.setFilter({ field: 'name', op: 'contains', value: 'ta' });
		state.setColumnPinned('name', true);
		state.setColumnHidden('decimals', true);
		return state;
	}

	it('keeps every piece of user state when only the definitions change', () => {
		const state = usedState();
		const before = state.serialize();

		state.setColumns(tagColumns({ analog: true, edit: true }));

		expect(state.serialize()).toBe(before);
		expect(state.orderedColumns.map((column) => column.id)).toEqual([
			'name',
			'id',
			'value',
			'unit'
		]);
		// ...and the definitions are the new ones.
		expect(state.orderedColumns.find((column) => column.id === 'value')?.editable).toBe(true);
		expect(state.allColumns.every((column) => column.id === 'id' || column.editable)).toBe(true);
	});

	it('does not re-apply width / hidden / pinned of a column that was already there', () => {
		const state = new GridState<Tag>(tagColumns());
		state.setColumns([
			{ id: 'name', header: 'Name', accessor: 'name', width: 999, hidden: true },
			{ id: 'value', header: 'Value', accessor: 'value', pinned: 'left' },
			{ id: 'id', header: 'ID', accessor: 'id' }
		]);
		expect(state.widths.name).toBe(200);
		expect(state.hidden).toEqual([]);
		expect(state.pinned).toEqual([]);
	});

	it('is a no-op for the same array instance', () => {
		const columns = tagColumns();
		const state = new GridState<Tag>(columns);
		const order = state.order;
		state.setColumns(columns);
		expect(state.order).toBe(order);
	});

	describe('a column that is gone', () => {
		it('drops its order slot, hidden / pinned flags, sort and filter - and nothing else', () => {
			const state = usedState();
			state.toggleSort('unit', true);
			state.setFilter({ field: 'unit', op: 'eq', value: 'kPa' });
			state.setColumnPinned('unit', true);

			state.setColumns(tagColumns());

			expect(state.order).toEqual(['id', 'name', 'value']);
			expect(state.hidden).toEqual([]);
			expect(state.pinned).toEqual(['name']);
			expect(state.sort).toEqual([{ field: 'value', direction: 'asc' }]);
			expect(state.filters).toEqual([{ field: 'name', op: 'contains', value: 'ta' }]);
			expect(state.widths.name).toBe(320);
		});

		it('clears a groupBy on it (and the collapsed groups with it)', () => {
			const state = new GridState<Tag>(tagColumns({ analog: true }));
			state.setGroupBy('unit');
			state.toggleGroup('kPa');
			state.setColumns(tagColumns());
			expect(state.groupBy).toBeNull();
			expect(state.collapsedGroups.size).toBe(0);
		});

		it('keeps a groupBy on a column that stays', () => {
			const state = new GridState<Tag>(tagColumns({ analog: true }));
			state.setGroupBy('name');
			state.toggleGroup('Alpha');
			state.setColumns(tagColumns());
			expect(state.groupBy).toBe('name');
			expect(state.collapsedGroups.has('Alpha')).toBe(true);
		});

		it('never leaves every remaining column hidden', () => {
			const state = new GridState<Tag>(tagColumns());
			state.setColumnHidden('name', true);
			state.setColumnHidden('value', true);
			// `id` was the only visible column; it goes away.
			state.setColumns(tagColumns().filter((column) => column.id !== 'id'));
			expect(state.orderedColumns.map((column) => column.id)).toEqual(['name']);
			expect(state.hidden).toEqual(['value']);
		});
	});

	describe('a column that is new', () => {
		it('lands after the column its definition follows, whatever the user reordered', () => {
			const state = new GridState<Tag>(tagColumns());
			state.moveColumn('id', 0); // id, name, value
			state.setColumns(tagColumns({ analog: true }));
			// unit follows value, decimals follows unit - not "appended last".
			expect(state.order).toEqual(['id', 'name', 'value', 'unit', 'decimals']);
		});

		it('lands first when it is the first definition', () => {
			const state = new GridState<Tag>(tagColumns());
			state.setColumns([{ id: 'no', header: 'No', accessor: 'id' }, ...tagColumns()]);
			expect(state.order).toEqual(['no', 'name', 'value', 'id']);
		});

		it('is seeded from its definition: width, hidden and pinned', () => {
			const state = new GridState<Tag>(tagColumns());
			state.setColumns([
				...tagColumns(),
				{ id: 'unit', header: 'Unit', accessor: 'unit', width: 70, pinned: 'left' },
				{ id: 'decimals', header: 'Decimals', accessor: 'decimals', hidden: true }
			]);
			expect(state.widths.unit).toBe(70);
			expect(state.widths.decimals).toBe(150);
			expect(state.pinned).toEqual(['unit']);
			expect(state.hidden).toEqual(['decimals']);
			expect(state.orderedColumns.map((column) => column.id)).toEqual([
				'unit',
				'name',
				'value',
				'id'
			]);
		});

		it('gets its last width back when it returns; the rest of its state starts over', () => {
			const state = new GridState<Tag>(tagColumns({ analog: true }));
			state.resizeColumn('unit', 90);
			state.setColumnHidden('unit', true);
			state.toggleSort('unit', false);

			state.setColumns(tagColumns());
			state.setColumns(tagColumns({ analog: true }));

			expect(state.widths.unit).toBe(90);
			expect(state.isHidden('unit')).toBe(false);
			expect(state.sort).toEqual([]);
			expect(state.order).toEqual(['name', 'value', 'unit', 'decimals', 'id']);
		});
	});

	it('a serialized state round-trips after a swap', () => {
		const state = usedState();
		state.setColumns(tagColumns());
		const restored = GridState.hydrate(state.serialize(), tagColumns());
		expect(restored.order).toEqual(state.order);
		expect(restored.pinned).toEqual(state.pinned);
		expect(restored.widths.name).toBe(320);
	});
});

describe('BantoGrid follows a changed `columns` prop (#890)', () => {
	const label = (el: HTMLElement) => el.querySelector('.label')?.textContent?.trim();
	function headers() {
		return screen.getAllByRole('columnheader').map(label);
	}
	function header(name: string) {
		return screen.getAllByRole('columnheader').find((el) => label(el) === name)!;
	}
	function cell(container: HTMLElement, rowIndex: number, field: string) {
		return container.querySelector<HTMLElement>(
			`[data-cell-row="${rowIndex}"][data-cell-field="${field}"]`
		)!;
	}
	function names(container: HTMLElement) {
		return [...container.querySelectorAll('[data-cell-field="name"]')].map((el) =>
			el.textContent?.trim()
		);
	}
	function setup(columns: GridColumn<Tag>[], state?: GridState<Tag>) {
		const edits: CellEdit<Tag>[] = [];
		const view = render(BantoGrid<Tag>, {
			rows,
			columns,
			state,
			getRowId: (row: Tag) => row.id,
			onCellEdit: (edit: CellEdit<Tag>) => {
				edits.push(edit);
			}
		});
		return { ...view, edits };
	}

	it('edit mode on / off (the Hub): widths, sort, filter, pin, selection and scroll stay', async () => {
		// No `state` prop: the grid owns it, like the Hub's table.
		const { container, rerender } = setup(tagColumns({ analog: true }));
		const grid = screen.getByRole('grid');

		// The user sorts by name, then selects a cell and scrolls.
		await fireEvent.keyDown(header('Name').querySelector('.cell-body')!, { key: 'Enter' });
		expect(names(container)).toEqual(['Alpha', 'Beta', 'Delta']);
		await fireEvent.pointerDown(cell(container, 1, 'value'));
		expect(cell(container, 1, 'value').classList.contains('active')).toBe(true);
		grid.scrollTop = 12;
		grid.scrollLeft = 34;
		await fireEvent.scroll(grid);

		// Read-only: a double click opens no editor.
		await fireEvent.dblClick(cell(container, 0, 'name'));
		expect(screen.queryByRole('textbox')).toBeNull();

		await rerender({ columns: tagColumns({ analog: true, edit: true }) });

		// Same grid element (not rebuilt), same state.
		expect(screen.getByRole('grid')).toBe(grid);
		expect(grid.scrollTop).toBe(12);
		expect(grid.scrollLeft).toBe(34);
		expect(header('Name').getAttribute('aria-sort')).toBe('ascending');
		expect(names(container)).toEqual(['Alpha', 'Beta', 'Delta']);
		expect(header('Name').style.width).toBe('200px');
		expect(cell(container, 1, 'value').classList.contains('active')).toBe(true);

		// ...and the cells are editable now.
		await fireEvent.dblClick(cell(container, 0, 'name'));
		expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Alpha');
		await fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

		// Back to read-only.
		await rerender({ columns: tagColumns({ analog: true }) });
		await fireEvent.dblClick(cell(container, 0, 'name'));
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(header('Name').getAttribute('aria-sort')).toBe('ascending');
	});

	it('unit / decimals columns come and go (the Hub): the rest keeps its state', async () => {
		const state = new GridState<Tag>(tagColumns());
		const { container, rerender } = setup(tagColumns(), state);
		flushSync(() => {
			state.resizeColumn('name', 320);
			state.moveColumn('id', 0);
			state.toggleSort('value', false);
			state.setFilter({ field: 'name', op: 'contains', value: 'ta' });
			state.setColumnPinned('name', true);
		});
		expect(headers()).toEqual(['Name', 'ID', 'Value']);
		await fireEvent.pointerDown(cell(container, 0, 'value'));

		await rerender({ columns: tagColumns({ analog: true }) });

		expect(headers()).toEqual(['Name', 'ID', 'Value', 'Unit', 'Decimals']);
		expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('5');
		expect(header('Name').style.width).toBe('320px');
		expect(header('Unit').style.width).toBe('70px');
		expect(header('Name').classList.contains('pinned')).toBe(true);
		expect(header('Value').getAttribute('aria-sort')).toBe('ascending');
		// Still sorted by value, and the filter still applies ("ta": Beta and Delta).
		expect(names(container)).toEqual(['Beta', 'Delta']);
		expect(cell(container, 0, 'unit').textContent?.trim()).toBe('kPa');
		expect(cell(container, 0, 'value').classList.contains('active')).toBe(true);

		// The user sorts by the new column, then it goes away again.
		flushSync(() => state.toggleSort('unit', false));
		await rerender({ columns: tagColumns() });

		expect(headers()).toEqual(['Name', 'ID', 'Value']);
		expect(state.sort).toEqual([]);
		expect(state.widths.name).toBe(320);
		expect(state.filters).toEqual([{ field: 'name', op: 'contains', value: 'ta' }]);
		expect(cell(container, 0, 'value').classList.contains('active')).toBe(true);
	});

	it('drops the cell selection that sat on a removed column', async () => {
		const { container, rerender } = setup(tagColumns({ analog: true }));
		await fireEvent.pointerDown(cell(container, 0, 'unit'));
		expect(container.querySelector('.cell.active')).not.toBeNull();
		await rerender({ columns: tagColumns() });
		expect(container.querySelector('.cell.active')).toBeNull();
	});

	describe('an open editor', () => {
		async function openEditor(container: HTMLElement, field: string) {
			await fireEvent.dblClick(cell(container, 0, field));
			const editor = screen.getByRole('textbox') as HTMLInputElement;
			await fireEvent.input(editor, { target: { value: 'draft' } });
			return editor;
		}

		it('is cancelled (nothing saved) when its column stops being editable', async () => {
			const { container, rerender, edits } = setup(tagColumns({ edit: true }));
			await openEditor(container, 'name');

			await rerender({ columns: tagColumns() });

			expect(screen.queryByRole('textbox')).toBeNull();
			expect(edits).toEqual([]);
			expect(cell(container, 0, 'name').textContent?.trim()).toBe('Beta');
		});

		it('is cancelled when `editable` becomes a function that refuses this row', async () => {
			const { container, rerender, edits } = setup(tagColumns({ edit: true }));
			await openEditor(container, 'name');

			await rerender({
				columns: tagColumns({ edit: true }).map((column) =>
					column.id === 'name' ? { ...column, editable: (row: Tag) => row.id !== 1 } : column
				)
			});

			expect(screen.queryByRole('textbox')).toBeNull();
			expect(edits).toEqual([]);
		});

		it('is cancelled when its column is removed', async () => {
			const { container, rerender, edits } = setup(tagColumns({ edit: true, analog: true }));
			await openEditor(container, 'unit');

			await rerender({ columns: tagColumns({ edit: true }) });

			expect(screen.queryByRole('textbox')).toBeNull();
			expect(edits).toEqual([]);
		});

		it('stays open, draft kept, when its column is still editable after the swap', async () => {
			const { container, rerender } = setup(tagColumns({ edit: true }));
			await openEditor(container, 'name');

			// Another column changes (and new ones arrive); `name` is as it was.
			await rerender({ columns: tagColumns({ edit: true, analog: true }) });

			const editor = screen.getByRole('textbox') as HTMLInputElement;
			expect(editor.value).toBe('draft');
			expect(editor.closest('.cell')).toBe(cell(container, 0, 'name'));
		});
	});

	describe('with a `state` the caller owns', () => {
		it('pushes a changed prop into that state', async () => {
			const state = new GridState<Tag>(tagColumns());
			const { rerender } = setup(tagColumns(), state);
			flushSync(() => state.resizeColumn('name', 320));

			await rerender({ columns: tagColumns({ analog: true }) });

			expect(state.order).toEqual(['name', 'value', 'unit', 'decimals', 'id']);
			expect(state.widths.name).toBe(320);
			expect(headers()).toEqual(['Name', 'Value', 'Unit', 'Decimals', 'ID']);
		});

		it('follows `state.setColumns` called by the caller', async () => {
			const columns = tagColumns();
			const state = new GridState<Tag>(columns);
			const { container } = setup(columns, state);

			flushSync(() => state.setColumns(tagColumns({ analog: true, edit: true })));

			expect(headers()).toEqual(['Name', 'Value', 'Unit', 'Decimals', 'ID']);
			await fireEvent.dblClick(cell(container, 0, 'unit'));
			expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('kPa');
		});

		it('sorts, filters and groups by a column only `state.setColumns` knows', () => {
			// The `columns` prop still lacks `unit`: the state's definitions are the
			// ones the pipeline looks the column up in.
			const columns = tagColumns();
			const state = new GridState<Tag>(columns);
			const { container } = setup(columns, state);

			flushSync(() => {
				state.setColumns(tagColumns({ analog: true }));
				state.setFilter({ field: 'unit', op: 'eq', value: 'kPa' });
				state.toggleSort('decimals', false);
			});
			expect(names(container)).toEqual(['Delta', 'Beta']);

			flushSync(() => {
				state.removeFilter('unit');
				state.setGroupBy('unit');
			});
			expect(container.querySelectorAll('.group-label').length).toBe(2);
		});

		it('leaves the state alone at mount, even when it was built with other columns', () => {
			// As before #890: the state decides what is rendered until `columns` changes.
			const state = new GridState<Tag>(tagColumns({ analog: true }));
			setup(tagColumns(), state);
			expect(headers()).toEqual(['Name', 'Value', 'Unit', 'Decimals', 'ID']);
		});
	});
});

describe('conditions on a column that goes away (#890 review)', () => {
	it('setColumns keeps a condition on a field that was never a column', () => {
		const state = new GridState<Tag>(tagColumns({ analog: true }));
		state.setFilter({ field: 'site', op: 'eq', value: 'A' });
		state.setFilter({ field: 'unit', op: 'eq', value: 'kPa' });
		state.toggleSort('site', false);
		state.setColumns(tagColumns());
		expect(state.filters).toEqual([{ field: 'site', op: 'eq', value: 'A' }]);
		expect(state.sort).toEqual([{ field: 'site', direction: 'asc' }]);
		expect(state.prunedRevision).toEqual({ revision: 1, params: true });
	});

	it('prunedRevision stays when nothing is dropped, and says when only a group-by went', () => {
		const state = new GridState<Tag>(tagColumns({ analog: true }));
		state.setColumns(tagColumns({ analog: true, edit: true }));
		state.setColumns(tagColumns());
		expect(state.prunedRevision.revision).toBe(0);
		state.setColumns(tagColumns({ analog: true }));
		state.setGroupBy('unit');
		state.setColumns(tagColumns());
		expect(state.prunedRevision).toEqual({ revision: 1, params: false });
	});

	it('hydrate drops the conditions on a saved column this set lacks; its width comes back with it', () => {
		const saved = new GridState<Tag>(tagColumns({ analog: true }));
		saved.setFilter({ field: 'unit', op: 'eq', value: 'kPa' });
		saved.setFilter({ field: 'site', op: 'eq', value: 'A' });
		saved.toggleSort('decimals', false);
		saved.setGroupBy('unit');
		saved.resizeColumn('unit', 99);

		const restored = GridState.hydrate(saved.serialize(), tagColumns());
		expect(restored.filters).toEqual([{ field: 'site', op: 'eq', value: 'A' }]);
		expect(restored.sort).toEqual([]);
		expect(restored.groupBy).toBeNull();

		restored.setColumns(tagColumns({ analog: true }));
		expect(restored.widths.unit).toBe(99);
		expect(restored.filters).toEqual([{ field: 'site', op: 'eq', value: 'A' }]);
		expect(restored.sort).toEqual([]);
	});

	describe('server mode: the new sort / filters are reported once', () => {
		function serverSetup(columns: GridColumn<Tag>[], state: GridState<Tag>) {
			const calls: { sort: unknown; filters: unknown }[] = [];
			const view = render(BantoGrid<Tag>, {
				rows,
				columns,
				state,
				mode: 'server',
				totalRows: rows.length,
				getRowId: (row: Tag) => row.id,
				onParamsChange: (params: { sort: unknown; filters: unknown }) => {
					calls.push(params);
				}
			});
			return { ...view, calls };
		}

		it('through the `columns` prop', async () => {
			const state = new GridState<Tag>(tagColumns({ analog: true }));
			state.setFilter({ field: 'unit', op: 'eq', value: 'kPa' });
			state.setFilter({ field: 'site', op: 'eq', value: 'A' });
			const { rerender, calls } = serverSetup(tagColumns({ analog: true }), state);

			// Definitions only: nothing to report.
			await rerender({ columns: tagColumns({ analog: true, edit: true }) });
			expect(calls).toEqual([]);

			await rerender({ columns: tagColumns() });
			expect(calls).toEqual([{ sort: [], filters: [{ field: 'site', op: 'eq', value: 'A' }] }]);
		});

		it('through `state.setColumns` called by the caller', () => {
			const columns = tagColumns({ analog: true });
			const state = new GridState<Tag>(columns);
			state.toggleSort('unit', false);
			const { calls } = serverSetup(columns, state);

			flushSync(() => state.setColumns(tagColumns({ analog: true, edit: true })));
			expect(calls).toEqual([]);
			flushSync(() => state.setColumns(tagColumns()));
			expect(calls).toEqual([{ sort: [], filters: [] }]);
		});
	});

	describe('the cell selection follows the record when the rows re-sort', () => {
		function grid(columns: GridColumn<Tag>[], state: GridState<Tag>) {
			return render(BantoGrid<Tag>, {
				rows,
				columns,
				state,
				getRowId: (row: Tag) => row.id
			});
		}
		const activeCell = (container: HTMLElement) =>
			container.querySelector<HTMLElement>('.cell.active');

		it('the active cell stays on its tag; a range collapses to it', async () => {
			// The Hub: sorted by decimals, a name selected, edit mode off drops decimals.
			const state = new GridState<Tag>(tagColumns({ analog: true }));
			state.toggleSort('decimals', false); // Delta(0), Beta(1), Alpha(2)
			const { container, rerender } = grid(tagColumns({ analog: true }), state);
			const at = (row: number, field: string) =>
				container.querySelector<HTMLElement>(
					`[data-cell-row="${row}"][data-cell-field="${field}"]`
				)!;
			await fireEvent.pointerDown(at(1, 'name'));
			await fireEvent.pointerDown(at(2, 'name'), { shiftKey: true });
			expect(container.querySelectorAll('.cell.in-range, .cell.active').length).toBeGreaterThan(1);
			expect(activeCell(container)?.textContent?.trim()).toBe('Alpha');

			await rerender({ columns: tagColumns() }); // unsorted again: Beta, Alpha, Delta

			const active = activeCell(container)!;
			expect(active.textContent?.trim()).toBe('Alpha');
			expect(active.getAttribute('data-cell-row')).toBe('1');
			expect(container.querySelectorAll('.cell.in-range').length).toBe(0);
		});

		it('with no record to follow (the caller set the columns) the selection is cleared', async () => {
			const columns = tagColumns({ analog: true });
			const state = new GridState<Tag>(columns);
			state.toggleSort('decimals', false);
			const { container } = grid(columns, state);
			await fireEvent.pointerDown(
				container.querySelector<HTMLElement>('[data-cell-row="0"][data-cell-field="name"]')!
			);
			flushSync(() => state.setColumns(tagColumns()));
			expect(activeCell(container)).toBeNull();
		});

		it('is left alone when no condition changed', async () => {
			const state = new GridState<Tag>(tagColumns({ analog: true }));
			state.toggleSort('value', false);
			const { container, rerender } = grid(tagColumns({ analog: true }), state);
			await fireEvent.pointerDown(
				container.querySelector<HTMLElement>('[data-cell-row="2"][data-cell-field="name"]')!
			);
			await rerender({ columns: tagColumns() });
			expect(activeCell(container)?.getAttribute('data-cell-row')).toBe('2');
		});
	});
});
