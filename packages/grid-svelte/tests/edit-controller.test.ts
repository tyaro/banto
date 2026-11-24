import { describe, expect, it, vi } from 'vitest';
import { EditController, type EditHost } from '../src/edit.svelte';
import type { CellEdit, GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	price: number;
	kind: number;
	locked?: boolean;
}

const nameColumn: GridColumn<Row> = {
	id: 'name',
	header: 'Name',
	accessor: 'name',
	editable: true
};
const priceColumn: GridColumn<Row> = {
	id: 'price',
	header: 'Price',
	accessor: 'price',
	editable: true,
	editor: 'number',
	validate: (value) => (typeof value === 'number' && value < 0 ? 'must be >= 0' : null)
};
const kindColumn: GridColumn<Row> = {
	id: 'kind',
	header: 'Kind',
	accessor: 'kind',
	editable: true,
	editor: 'select',
	editorOptions: [
		{ value: 1, label: 'One' },
		{ value: 2, label: 'Two' }
	]
};

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A host over a mutable row list: `currentRow` looks the session's row up by id. */
function setup(overrides: Partial<EditHost<Row>> = {}) {
	const rows: Row[] = [
		{ id: 1, name: 'Apple', price: 100, kind: 1 },
		{ id: 2, name: 'Banana', price: 200, kind: 2 }
	];
	const saved: CellEdit<Row>[] = [];
	const host = {
		save: vi.fn<(edit: CellEdit<Row>) => void | Promise<void>>((edit) => {
			saved.push(edit);
		})
	};
	const edit: EditController<Row> = new EditController<Row>({
		getRowId: (row) => row.id,
		currentRow: () => rows.find((row) => row.id === edit.session?.rowId),
		save: () => host.save,
		invalidMessage: () => 'invalid input',
		...overrides
	});
	return { rows, saved, host, edit };
}

describe('EditController', () => {
	describe('start', () => {
		it('opens a session seeded with the cell value', () => {
			const { rows, edit } = setup();
			const session = edit.start(nameColumn, rows[0]);
			expect(session).toEqual({
				sessionId: 1,
				rowId: 1,
				field: 'name',
				draft: 'Apple',
				error: null,
				pending: false
			});
			expect(edit.session).toEqual(session);
			expect(edit.interactive).toBe(true);
		});

		it('refuses a column that is not editable for the row and leaves the open session alone', () => {
			const { rows, edit } = setup();
			const perRow: GridColumn<Row> = { ...nameColumn, editable: (row) => !row.locked };
			edit.start(priceColumn, rows[1]);
			expect(edit.start(perRow, { ...rows[0], locked: true })).toBeNull();
			expect(edit.start({ ...nameColumn, editable: false }, rows[0])).toBeNull();
			expect(edit.start({ ...nameColumn, renderer: 'link' }, rows[0])).toBeNull();
			expect(edit.session).toMatchObject({ sessionId: 1, rowId: 2, field: 'price' });
		});

		it('reads `editable` on every start, so a column changed later is seen (#890)', () => {
			const { rows, edit } = setup();
			let column: GridColumn<Row> = { ...nameColumn, editable: false };
			expect(edit.start(column, rows[0])).toBeNull();
			column = { ...column, editable: true };
			expect(edit.start(column, rows[0])).not.toBeNull();
		});

		it('gives a reopened cell a new session id (#210)', () => {
			const { rows, edit } = setup();
			const first = edit.start(nameColumn, rows[0])!.sessionId;
			edit.cancel();
			const second = edit.start(nameColumn, rows[0])!.sessionId;
			expect(second).not.toBe(first);
			expect(edit.isLatest(second)).toBe(true);
			expect(edit.isLatest(first)).toBe(false);
		});
	});

	describe('draft and cancel', () => {
		it('setDraft updates the open session and is a no-op when closed', () => {
			const { rows, edit } = setup();
			edit.setDraft('ignored');
			expect(edit.session).toBeNull();
			edit.start(nameColumn, rows[0]);
			edit.setDraft('Apricot');
			expect(edit.session?.draft).toBe('Apricot');
		});

		it('cancel closes without saving and keeps the session id as the latest', () => {
			const { rows, host, edit } = setup();
			const { sessionId } = edit.start(nameColumn, rows[0])!;
			edit.setDraft('Apricot');
			edit.cancel();
			expect(edit.session).toBeNull();
			expect(edit.interactive).toBe(false);
			expect(edit.isLatest(sessionId)).toBe(true);
			expect(host.save).not.toHaveBeenCalled();
		});
	});

	describe('resolveDraft', () => {
		it('parses by editor type', () => {
			const { rows, edit } = setup();
			edit.start(priceColumn, rows[0]);
			edit.setDraft('150');
			expect(edit.resolveDraft(priceColumn)).toEqual({ ok: true, value: 150 });
			expect(edit.session?.error).toBeNull();
		});

		it('marks the session invalid on an unparsable draft and keeps the draft', () => {
			const { rows, edit } = setup();
			edit.start(priceColumn, rows[0]);
			edit.setDraft('abc');
			expect(edit.resolveDraft(priceColumn)).toEqual({ ok: false });
			expect(edit.session).toMatchObject({ draft: 'abc', error: 'invalid input', pending: false });
		});

		it('resolves a select draft to its option value, keeping the type', () => {
			const { rows, edit } = setup();
			edit.start(kindColumn, rows[0]);
			expect(edit.resolveDraft(kindColumn)).toEqual({ ok: true, value: 1 });
			edit.setDraft('2');
			expect(edit.resolveDraft(kindColumn)).toEqual({ ok: true, value: 2 });
		});

		it('is not ok when no session is open', () => {
			const { edit } = setup();
			expect(edit.resolveDraft(nameColumn)).toEqual({ ok: false });
		});
	});

	describe('commitValue', () => {
		it('closes without saving when the value did not change', async () => {
			const { rows, host, edit } = setup();
			edit.start(nameColumn, rows[0]);
			await expect(edit.commitValue(nameColumn, rows[0], 'Apple')).resolves.toBe(true);
			expect(edit.session).toBeNull();
			expect(host.save).not.toHaveBeenCalled();
		});

		it('keeps the session open with the message when validation fails', async () => {
			const { rows, host, edit } = setup();
			const { sessionId } = edit.start(priceColumn, rows[0])!;
			await expect(edit.commitValue(priceColumn, rows[0], -1)).resolves.toBe(false);
			expect(edit.session).toEqual({
				sessionId,
				rowId: 1,
				field: 'price',
				draft: -1,
				error: 'must be >= 0',
				pending: false
			});
			expect(host.save).not.toHaveBeenCalled();
		});

		it('is pending while the save runs, then closes', async () => {
			const gate = deferred();
			const { rows, host, edit } = setup();
			host.save.mockImplementation(() => gate.promise);
			edit.start(nameColumn, rows[0]);
			const committed = edit.commitValue(nameColumn, rows[0], 'Apricot');
			expect(edit.session).toMatchObject({ draft: 'Apricot', error: null, pending: true });
			expect(edit.interactive).toBe(false);
			gate.resolve();
			await expect(committed).resolves.toBe(true);
			expect(edit.session).toBeNull();
		});

		it('passes the edit with the row as displayed when the session opened (baseRow)', async () => {
			const { rows, saved, edit } = setup();
			const opened = rows[0];
			edit.start(nameColumn, opened);
			// The caller replaced the row object while the editor was open.
			rows[0] = { ...opened, price: 999 };
			await edit.commitValue(nameColumn, opened, 'Apricot');
			expect(saved).toHaveLength(1);
			expect(saved[0]).toMatchObject({
				rowId: 1,
				field: 'name',
				value: 'Apricot',
				oldValue: 'Apple'
			});
			expect(saved[0].row).toBe(rows[0]);
			expect(saved[0].baseRow).toBe(opened);
		});

		it('closes without a save callback', async () => {
			const { rows, edit } = setup({ save: () => undefined });
			edit.start(nameColumn, rows[0]);
			await expect(edit.commitValue(nameColumn, rows[0], 'Apricot')).resolves.toBe(true);
			expect(edit.session).toBeNull();
		});

		it('reads the save callback at commit time, not at construction', async () => {
			let save: ((edit: CellEdit<Row>) => void) | undefined;
			const { rows, edit } = setup({ save: () => save });
			const later = vi.fn();
			edit.start(nameColumn, rows[0]);
			save = later;
			await edit.commitValue(nameColumn, rows[0], 'Apricot');
			expect(later).toHaveBeenCalledTimes(1);
		});

		it('reopens with the error and the submitted draft when the save rejects', async () => {
			const { rows, host, edit } = setup();
			host.save.mockRejectedValueOnce(new Error('conflict'));
			const { sessionId } = edit.start(nameColumn, rows[0])!;
			await expect(edit.commitValue(nameColumn, rows[0], 'Apricot')).resolves.toBe(false);
			expect(edit.session).toEqual({
				sessionId,
				rowId: 1,
				field: 'name',
				draft: 'Apricot',
				error: 'conflict',
				pending: false
			});
			host.save.mockRejectedValueOnce('plain reason');
			await edit.commitValue(nameColumn, rows[0], 'Apricot');
			expect(edit.session?.error).toBe('plain reason');
		});

		it('a retry after a rejected save can succeed', async () => {
			const { rows, host, edit } = setup();
			host.save.mockRejectedValueOnce(new Error('conflict'));
			edit.start(nameColumn, rows[0]);
			await edit.commitValue(nameColumn, rows[0], 'Apricot');
			await expect(edit.commitValue(nameColumn, rows[0], 'Apricot')).resolves.toBe(true);
			expect(edit.session).toBeNull();
			expect(host.save).toHaveBeenCalledTimes(2);
		});

		it('ignores a commit for a cell the session is not on', async () => {
			const { rows, host, edit } = setup();
			edit.start(nameColumn, rows[0]);
			await expect(edit.commitValue(nameColumn, rows[1], 'x')).resolves.toBe(false);
			await expect(edit.commitValue(priceColumn, rows[0], 1)).resolves.toBe(false);
			expect(edit.session).toMatchObject({ rowId: 1, field: 'name', draft: 'Apple' });
			expect(host.save).not.toHaveBeenCalled();
			edit.cancel();
			await expect(edit.commitValue(nameColumn, rows[0], 'x')).resolves.toBe(false);
		});

		it('does not commit when the row is no longer displayed', async () => {
			const { rows, host, edit } = setup();
			const row = rows[0];
			edit.start(nameColumn, row);
			rows.splice(0, 1);
			await expect(edit.commitValue(nameColumn, row, 'Apricot')).resolves.toBe(false);
			expect(host.save).not.toHaveBeenCalled();
			// Closing is the host's call (it also owns the selection).
			expect(edit.session).not.toBeNull();
		});

		it('a save that settles after a newer session started leaves that session alone', async () => {
			for (const outcome of ['resolve', 'reject'] as const) {
				const gate = deferred();
				const { rows, host, edit } = setup();
				host.save.mockImplementationOnce(() => gate.promise);
				edit.start(nameColumn, rows[0]);
				const committed = edit.commitValue(nameColumn, rows[0], 'Apricot');
				const newer = edit.start(priceColumn, rows[1])!;
				if (outcome === 'resolve') gate.resolve();
				else gate.reject(new Error('late'));
				await expect(committed).resolves.toBe(false);
				expect(edit.session).toEqual({
					sessionId: newer.sessionId,
					rowId: 2,
					field: 'price',
					draft: 200,
					error: null,
					pending: false
				});
			}
		});

		it('a save that settles after the session was cancelled does not reopen it', async () => {
			const gate = deferred();
			const { rows, host, edit } = setup();
			host.save.mockImplementationOnce(() => gate.promise);
			edit.start(nameColumn, rows[0]);
			const committed = edit.commitValue(nameColumn, rows[0], 'Apricot');
			edit.cancel();
			gate.reject(new Error('late'));
			await expect(committed).resolves.toBe(false);
			expect(edit.session).toBeNull();
		});

		it('takes the column as passed on each call (validate changed while open)', async () => {
			const { rows, edit } = setup();
			edit.start(nameColumn, rows[0]);
			const strict: GridColumn<Row> = { ...nameColumn, validate: () => 'no longer allowed' };
			await expect(edit.commitValue(strict, rows[0], 'Apricot')).resolves.toBe(false);
			expect(edit.session?.error).toBe('no longer allowed');
		});
	});

	describe('focus claim (#212)', () => {
		it('has nothing to track before the first session', () => {
			const { edit } = setup();
			expect(edit.tracksFocus).toBe(false);
			edit.setFocusOwned(true);
			expect(edit.focusOwned).toBe(false);
		});

		it('a new session owns focus until the user leaves, and can renew it', () => {
			const { rows, edit } = setup();
			const { sessionId } = edit.start(nameColumn, rows[0])!;
			expect(edit.tracksFocus).toBe(true);
			expect(edit.ownsFocus(sessionId)).toBe(true);
			edit.setFocusOwned(false);
			expect(edit.ownsFocus(sessionId)).toBe(false);
			expect(edit.focusOwned).toBe(false);
			edit.renewFocus(sessionId);
			expect(edit.ownsFocus(sessionId)).toBe(true);
		});

		it('the claim outlives the session, so a closing commit can still hand focus back', () => {
			const { rows, edit } = setup();
			const { sessionId } = edit.start(nameColumn, rows[0])!;
			edit.cancel();
			expect(edit.ownsFocus(sessionId)).toBe(true);
		});

		it('an older session neither owns nor renews the claim of a newer one', () => {
			const { rows, edit } = setup();
			const older = edit.start(nameColumn, rows[0])!.sessionId;
			const newer = edit.start(priceColumn, rows[1])!.sessionId;
			expect(edit.ownsFocus(older)).toBe(false);
			edit.setFocusOwned(false);
			edit.renewFocus(older);
			expect(edit.ownsFocus(newer)).toBe(false);
		});
	});
});
