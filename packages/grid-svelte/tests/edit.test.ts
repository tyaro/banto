import { describe, expect, it } from 'vitest';
import { prepareCommit } from '../src/core/edit';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	name: string;
	price: number;
}

const row: Row = { id: 1, name: 'Green Tea', price: 140 };

describe('prepareCommit', () => {
	it('returns noop when the draft equals the current value', () => {
		const column: GridColumn<Row> = { id: 'name', header: 'Name', accessor: 'name', editable: true };
		expect(prepareCommit(column, row, 1, 'Green Tea')).toEqual({ kind: 'noop' });
	});

	it('returns invalid with the validator message when validation fails', () => {
		const column: GridColumn<Row> = {
			id: 'name',
			header: 'Name',
			accessor: 'name',
			editable: true,
			validate: (value) => (String(value).length === 0 ? '必須項目です' : null)
		};
		expect(prepareCommit(column, row, 1, '')).toEqual({ kind: 'invalid', message: '必須項目です' });
	});

	it('returns a commit edit with row/rowId/field/value/oldValue when the value changed and validates', () => {
		const column: GridColumn<Row> = {
			id: 'name',
			header: 'Name',
			accessor: 'name',
			editable: true,
			validate: () => null
		};
		expect(prepareCommit(column, row, 1, 'Roasted Tea')).toEqual({
			kind: 'commit',
			edit: { row, rowId: 1, field: 'name', value: 'Roasted Tea', oldValue: 'Green Tea' }
		});
	});

	it('commits without a validate function at all', () => {
		const column: GridColumn<Row> = { id: 'price', header: 'Price', accessor: 'price', editable: true };
		expect(prepareCommit(column, row, 1, 200)).toEqual({
			kind: 'commit',
			edit: { row, rowId: 1, field: 'price', value: 200, oldValue: 140 }
		});
	});

	it('supports accessor functions, not just keyof', () => {
		const column: GridColumn<Row> = {
			id: 'label',
			header: 'Label',
			accessor: (r) => `${r.name} (${r.price})`,
			editable: true
		};
		expect(prepareCommit(column, row, 1, 'Green Tea (140)')).toEqual({ kind: 'noop' });
	});

	it('validate receives both the candidate value and the row', () => {
		const column: GridColumn<Row> = {
			id: 'price',
			header: 'Price',
			accessor: 'price',
			editable: true,
			validate: (value, r) => (Number(value) > 99999 || r.id < 0 ? '0〜99999で入力してください' : null)
		};
		expect(prepareCommit(column, row, 1, 999999)).toEqual({
			kind: 'invalid',
			message: '0〜99999で入力してください'
		});
	});
});
