import { describe, expect, it } from 'vitest';
import {
	allMatchingVerdict,
	canSelectAllMatching,
	retainSelected,
	sameRowIds,
	selectAllState,
	toggleAll,
	toggleRowId,
	type RowId
} from '../src/core/rowSelection';

describe('selectAllState (#713)', () => {
	it('is none when nothing is selected or there are no targets', () => {
		expect(selectAllState(new Set(), [1, 2])).toBe('none');
		expect(selectAllState(new Set([1]), [])).toBe('none');
	});

	it('is some when only part of the targets is selected', () => {
		expect(selectAllState(new Set<RowId>([2]), [1, 2, 3])).toBe('some');
	});

	it('is all when every target is selected', () => {
		expect(selectAllState(new Set<RowId>([3, 1, 2]), [1, 2, 3])).toBe('all');
	});

	it('ignores selected rows outside the targets', () => {
		expect(selectAllState(new Set<RowId>([9]), [1, 2])).toBe('none');
		expect(selectAllState(new Set<RowId>([1, 2, 9]), [1, 2])).toBe('all');
	});

	it('does not mix up a number id and the same digits as a string', () => {
		expect(selectAllState(new Set<RowId>(['1']), [1])).toBe('none');
	});
});

describe('toggleRowId (#713)', () => {
	it('appends an unselected row and keeps the order of selection', () => {
		expect(toggleRowId([3, 1], 2)).toEqual([3, 1, 2]);
	});

	it('drops a selected row', () => {
		expect(toggleRowId([3, 1, 2], 1)).toEqual([3, 2]);
	});

	it('does not change its input', () => {
		const selected: RowId[] = [1];
		toggleRowId(selected, 2);
		toggleRowId(selected, 1);
		expect(selected).toEqual([1]);
	});
});

describe('toggleAll (#713)', () => {
	it('selects every target from none', () => {
		expect(toggleAll([], [1, 2, 3])).toEqual([1, 2, 3]);
	});

	it('adds only the missing targets from some', () => {
		expect(toggleAll([2], [1, 2, 3])).toEqual([2, 1, 3]);
	});

	it('drops the targets from all, keeping rows outside the targets', () => {
		expect(toggleAll([9, 1, 2], [1, 2])).toEqual([9]);
	});

	it('keeps rows outside the targets when selecting', () => {
		expect(toggleAll([9], [1, 2])).toEqual([9, 1, 2]);
	});

	it('does nothing without targets', () => {
		expect(toggleAll([9], [])).toEqual([9]);
	});

	it('does not add a target twice when the targets repeat an id', () => {
		expect(toggleAll([], [1, 1, 2])).toEqual([1, 2]);
	});
});

describe('retainSelected (#713)', () => {
	it('drops the rows that are no longer present', () => {
		expect(retainSelected([1, 2, 3], new Set<RowId>([3, 1]))).toEqual([1, 3]);
	});

	it('returns the same array when nothing was dropped', () => {
		const selected: RowId[] = [1, 2];
		expect(retainSelected(selected, new Set<RowId>([1, 2, 3]))).toBe(selected);
	});

	it('empties the selection when no row is present', () => {
		expect(retainSelected([1, 2], new Set())).toEqual([]);
	});
});

describe('canSelectAllMatching (#713)', () => {
	const base = {
		mode: 'server',
		selectAll: 'all',
		loadedCount: 40,
		totalRows: 1200,
		allMatching: false,
		enabled: true
	} as const;

	it('offers it in server mode when every loaded row is selected and more rows match', () => {
		expect(canSelectAllMatching(base)).toBe(true);
	});

	it('never offers it in client mode', () => {
		expect(canSelectAllMatching({ ...base, mode: 'client' })).toBe(false);
	});

	it('does not offer it unless every loaded row is selected', () => {
		expect(canSelectAllMatching({ ...base, selectAll: 'some' })).toBe(false);
		expect(canSelectAllMatching({ ...base, selectAll: 'none' })).toBe(false);
	});

	it('does not offer it when everything that matches is already loaded, or the total is unknown', () => {
		expect(canSelectAllMatching({ ...base, totalRows: 40 })).toBe(false);
		expect(canSelectAllMatching({ ...base, totalRows: 12 })).toBe(false);
		expect(canSelectAllMatching({ ...base, totalRows: undefined })).toBe(false);
	});

	it('does not offer it unless the host opted in', () => {
		expect(canSelectAllMatching({ ...base, enabled: false })).toBe(false);
	});

	it('does not offer it again while in the mode', () => {
		expect(canSelectAllMatching({ ...base, allMatching: true })).toBe(false);
	});
});

describe('sameRowIds (#713)', () => {
	it('compares content and order, not identity', () => {
		const ids: RowId[] = [1, 2];
		expect(sameRowIds(ids, ids)).toBe(true);
		expect(sameRowIds([1, 2], [1, 2])).toBe(true);
		expect(sameRowIds([], [])).toBe(true);
		expect(sameRowIds([1, 2], [2, 1])).toBe(false);
		expect(sameRowIds([1, 2], [1])).toBe(false);
		expect(sameRowIds([1], ['1'])).toBe(false);
	});
});

describe('allMatchingVerdict (#713)', () => {
	const entered = { flag: true, enteredWith: [1, 2], selected: [1, 2], usable: true };

	it('keeps: not in the mode, or in it and untouched', () => {
		expect(
			allMatchingVerdict({ flag: false, enteredWith: null, selected: [1], usable: true })
		).toBe('keep');
		expect(allMatchingVerdict(entered)).toBe('keep');
	});

	it('rejects a flag the host turned on itself', () => {
		expect(allMatchingVerdict({ flag: true, enteredWith: null, selected: [1], usable: true })).toBe(
			'reject'
		);
	});

	it('leaves when the host turns the flag off', () => {
		expect(allMatchingVerdict({ ...entered, flag: false })).toBe('leave');
	});

	it('leaves but keeps the value when the host rewrites the selection', () => {
		expect(allMatchingVerdict({ ...entered, selected: [] })).toBe('leave-keep');
		expect(allMatchingVerdict({ ...entered, selected: [1] })).toBe('leave-keep');
		expect(allMatchingVerdict({ ...entered, selected: [1, 2, 3] })).toBe('leave-keep');
	});

	it('leaves when the grid stops being a selectable server grid', () => {
		expect(allMatchingVerdict({ ...entered, usable: false })).toBe('leave');
	});
});
