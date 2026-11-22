import { describe, expect, it } from 'vitest';
import { resetKeepingFile, valuesOnLoad, type ResettableStore } from './carryFileField';

function fakeStore(values: Record<string, unknown>): ResettableStore {
	return {
		values,
		reset(next) {
			this.values = { ...(next ?? {}) };
		}
	};
}

describe('resetKeepingFile (#714 F2)', () => {
	it('resets to the record but keeps the files waiting to upload', () => {
		const files = { existing: null, pending: [{ error: 'x' }] };
		const store = fakeStore({ name: 'mine', files });
		resetKeepingFile(store, 'files', { name: 'theirs' });
		expect(store.values).toEqual({ name: 'theirs', files });
	});

	it('is a plain reset without a file field', () => {
		const store = fakeStore({ name: 'mine' });
		resetKeepingFile(store, null, { name: 'theirs' });
		expect(store.values).toEqual({ name: 'theirs' });
	});
});

describe('valuesOnLoad (#714 F2)', () => {
	const record = { id: 7, name: 'server' };
	const first = [{ key: 'a' }, { key: 'b' }];

	it('first load: the record plus the files handed over from the create form', () => {
		expect(
			valuesOnLoad({ record, fileFieldName: 'files', current: null, leftovers: first })
		).toEqual({ ...record, files: { existing: null, pending: first } });
	});

	it('first load without a handover: the record as it is', () => {
		expect(valuesOnLoad({ record, fileFieldName: 'files', current: null, leftovers: null })).toBe(
			record
		);
	});

	it('reading the record again carries the field as it is now, not the first handover', () => {
		// `a` was retried (now an existing file) and `b` cancelled since the first load.
		const now = { existing: [{ id: 1, fileName: 'a' }], pending: [] };
		expect(
			valuesOnLoad({
				record,
				fileFieldName: 'files',
				current: { name: 'typed', files: now },
				leftovers: first
			})
		).toEqual({ ...record, files: now });
	});

	it('reading the record again keeps a file chosen since, and takes the other values from the server', () => {
		const now = { existing: null, pending: [{ key: 'c' }] };
		const values = valuesOnLoad({
			record,
			fileFieldName: 'files',
			current: { name: 'typed', files: now },
			leftovers: null
		});
		expect(values.name).toBe('server');
		expect(values.files).toBe(now);
	});

	it('without a file field: the record, whatever else is passed', () => {
		expect(
			valuesOnLoad({ record, fileFieldName: null, current: { files: 1 }, leftovers: first })
		).toBe(record);
	});
});
