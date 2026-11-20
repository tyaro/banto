import { describe, expect, it } from 'vitest';
import {
	retainSelected,
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
