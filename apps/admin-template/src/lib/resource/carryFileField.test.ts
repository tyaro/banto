import { describe, expect, it } from 'vitest';
import { resetKeepingFile, type ResettableStore } from './carryFileField';

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
