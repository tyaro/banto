/** #711: recently opened records are per owner, like the palette's command history (#258). */
import { describe, expect, it } from 'vitest';
import type { SessionScope } from '@banto/admin-core';
import { RECENT_RECORDS_KEY, loadRecentRecords, recordRecentRecord } from './recentRecords';
import { recordTitle } from './recordTitle';

class FakeStorage implements Storage {
	private map = new Map<string, string>();
	get length(): number {
		return this.map.size;
	}
	clear(): void {
		this.map.clear();
	}
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.map.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
}

const scopeOf = (owner: string | null): SessionScope => ({ generation: 1, owner });
const live = () => true;

describe('recent records', () => {
	it('is per owner: another user sees nothing, the first write replaces it', () => {
		const storage = new FakeStorage();
		const a = scopeOf('a');
		const b = scopeOf('b');
		recordRecentRecord(a, { resource: 'items', id: 1, title: 'One' }, { storage, isCurrent: live });
		expect(loadRecentRecords(a, { storage }).map((r) => r.title)).toEqual(['One']);
		expect(loadRecentRecords(b, { storage })).toEqual([]);
		recordRecentRecord(b, { resource: 'items', id: 2, title: 'Two' }, { storage, isCurrent: live });
		expect(loadRecentRecords(a, { storage })).toEqual([]);
		expect(loadRecentRecords(b, { storage }).map((r) => r.title)).toEqual(['Two']);
	});

	it('moves a reopened record to the front, updates its title and caps at 10', () => {
		const storage = new FakeStorage();
		const scope = scopeOf('a');
		const options = { storage, isCurrent: live };
		for (let id = 1; id <= 12; id++) {
			recordRecentRecord(scope, { resource: 'items', id, title: `T${id}` }, options);
		}
		recordRecentRecord(scope, { resource: 'items', id: 5, title: 'Renamed' }, options);
		const list = loadRecentRecords(scope, { storage });
		expect(list).toHaveLength(10);
		expect(list[0]).toEqual({ resource: 'items', id: 5, title: 'Renamed' });
		expect(list.filter((r) => r.id === 5)).toHaveLength(1);
	});

	it('neither reads nor writes without an owner, and a stale scope cannot write', () => {
		const storage = new FakeStorage();
		recordRecentRecord(
			scopeOf(null),
			{ resource: 'items', id: 1, title: 'x' },
			{ storage, isCurrent: live }
		);
		recordRecentRecord(
			scopeOf('a'),
			{ resource: 'items', id: 1, title: 'x' },
			{ storage, isCurrent: () => false }
		);
		expect(storage.getItem(RECENT_RECORDS_KEY)).toBeNull();
		expect(loadRecentRecords(scopeOf(null), { storage })).toEqual([]);
	});

	it('ignores a corrupt entry and malformed records', () => {
		const storage = new FakeStorage();
		storage.setItem(RECENT_RECORDS_KEY, '{nope');
		expect(loadRecentRecords(scopeOf('a'), { storage })).toEqual([]);
		storage.setItem(
			RECENT_RECORDS_KEY,
			JSON.stringify({ owner: 'a', records: [{ resource: 'i', id: 1, title: 't' }, { id: 2 }] })
		);
		expect(loadRecentRecords(scopeOf('a'), { storage })).toHaveLength(1);
	});
});

describe('recordTitle', () => {
	it('prefers the definition, then name / title / label, then #id', () => {
		expect(recordTitle({ recordTitle: (r) => `X${r.id}` }, { id: 1, name: 'n' })).toBe('X1');
		expect(recordTitle({}, { id: 1, name: ' n ' })).toBe('n');
		expect(recordTitle({}, { id: 1, title: 't', label: 'l' })).toBe('t');
		expect(recordTitle({}, { id: 9 })).toBe('#9');
	});
});
