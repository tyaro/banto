import { describe, expect, it } from 'vitest';
import { conflictOf, createInMemoryDataProvider } from '@banto/admin-core';
import {
	conflictFields,
	defaultConflictChoices,
	inputTypedDuringSave,
	keptEditsOverTheirs,
	lockVersionOf,
	resolvedValues,
	sameValue
} from './conflict';

// Issue #638: the pure part of the detail form's conflict dialog.
const fields = ['name', 'price', 'stock'];
const base = { id: 1, name: 'tea', price: 100, stock: 10, version: 1 };

describe('conflictFields', () => {
	it('lists only the fields the other person changed, in field order', () => {
		const current = { ...base, price: 120, stock: 3, version: 2 };
		const draft = { ...base, name: 'green tea', stock: 8 };
		expect(conflictFields(fields, base, current, draft)).toEqual([
			{ field: 'price', theirs: 120, mine: 100, mineChanged: false },
			{ field: 'stock', theirs: 3, mine: 8, mineChanged: true }
		]);
	});

	it('is empty when only the version moved', () => {
		expect(conflictFields(fields, base, { ...base, version: 5 }, base)).toEqual([]);
	});

	it('treats missing and null alike', () => {
		expect(sameValue(undefined, null)).toBe(true);
		expect(sameValue(0, '0')).toBe(false);
	});
});

describe('defaultConflictChoices', () => {
	it('keeps mine where I changed the field, theirs where I did not', () => {
		const current = { ...base, price: 120, stock: 3, version: 2 };
		const draft = { ...base, stock: 8 };
		expect(defaultConflictChoices(conflictFields(fields, base, current, draft))).toEqual({
			price: 'theirs',
			stock: 'mine'
		});
	});
});

describe('resolvedValues', () => {
	const current = { ...base, name: 'their tea', price: 120, version: 7 };
	const draft = { ...base, name: 'my tea', price: 90, stock: 4 };
	const conflicts = conflictFields(fields, base, current, draft);

	it('takes each conflicting field from the chosen side and the version from current', () => {
		expect(resolvedValues(draft, current, conflicts, { name: 'theirs', price: 'mine' })).toEqual({
			...draft,
			name: 'their tea',
			price: 90,
			version: 7
		});
	});

	it('defaults a missing choice to mine (overwrite) and keeps my other edits', () => {
		const values = resolvedValues(draft, current, conflicts, {});
		expect(values).toMatchObject({ name: 'my tea', price: 90, stock: 4, version: 7 });
	});

	it('leaves the version alone when current has none', () => {
		const { version: _drop, ...unversioned } = current;
		expect(resolvedValues(draft, unversioned, conflicts, {}).version).toBe(1);
	});
});

describe('keptEditsOverTheirs', () => {
	it('keeps my edits only on fields the other person did not change', () => {
		const current = { ...base, price: 120, version: 2 };
		const draft = { ...base, name: 'green tea', price: 90 };
		expect(keptEditsOverTheirs(fields, base, current, draft)).toEqual({ name: 'green tea' });
	});
});

describe('two clients on one InMemory provider (Issue #638, end to end)', () => {
	it('the second save conflicts, and the chosen values re-sent with current.version win', async () => {
		const provider = createInMemoryDataProvider(
			{ items: { rows: [{ ...base }] } },
			{ latencyMs: 0 }
		);
		type R = Record<string, unknown>;
		// A and B open the same record.
		const loadedA = await provider.getOne<R>('items', 1);
		const loadedB = await provider.getOne<R>('items', 1);
		// A saves price.
		const savedA = await provider.update<R>('items', 1, { ...loadedA, price: 120 });
		expect(savedA.version).toBe(2);
		// B saves name + price against the version it loaded: refused.
		const draftB = { ...loadedB, name: 'green tea', price: 90 };
		const err = await provider.update<R>('items', 1, draftB).catch((e: unknown) => e);
		const conflict = conflictOf(err);
		expect(conflict?.current).toMatchObject({ price: 120, version: 2 });
		const current = conflict!.current!;
		const conflicts = conflictFields(fields, loadedB, current, draftB);
		expect(conflicts.map((c) => c.field)).toEqual(['price']);
		// B keeps A's price: its own name edit (an unconflicted field) still goes.
		const values = resolvedValues(draftB, current, conflicts, { price: 'theirs' });
		const savedB = await provider.update<R>('items', 1, values);
		expect(savedB).toMatchObject({ name: 'green tea', price: 120, version: 3 });
		// A's next save still carries version 2: refused in turn.
		await expect(provider.update<R>('items', 1, { ...savedA, stock: 1 })).rejects.toMatchObject({
			body: { kind: 'conflict' }
		});
		// A delete with a stale version is refused; with the latest it goes.
		await expect(provider.deleteOne('items', 1, { version: 2 })).rejects.toMatchObject({
			body: { kind: 'conflict' }
		});
		await provider.deleteOne('items', 1, { version: 3 });
	});
});

describe('lockVersionOf', () => {
	it('reads a numeric version only', () => {
		expect(lockVersionOf({ version: 3 })).toBe(3);
		expect(lockVersionOf({ version: '3' })).toBeUndefined();
		expect(lockVersionOf(null)).toBeUndefined();
	});
});

describe('inputTypedDuringSave', () => {
	it('returns only the fields typed during the save', () => {
		expect(inputTypedDuringSave({ name: 'a', price: 5 }, { name: 'a', price: 4 })).toEqual({
			price: 5
		});
	});

	it('never returns the lock version (a stale one must not undo the saved version)', () => {
		// version-only conflict -> auto re-send: the store still held version 1
		// while 2 was sent and 3 came back.
		expect(inputTypedDuringSave({ name: 'a', version: 1 }, { name: 'a', version: 2 })).toEqual({});
		expect(inputTypedDuringSave({ name: 'b', version: 1 }, { name: 'a', version: 2 })).toEqual({
			name: 'b'
		});
	});
});
