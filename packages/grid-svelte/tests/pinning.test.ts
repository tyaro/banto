import { describe, expect, it } from 'vitest';
import {
	MIN_SCROLLABLE_WIDTH,
	clampDropIndex,
	contentXAt,
	fitPinnedCount,
	moveInOrder,
	partitionPinned,
	pinnedOffsets,
	scrollLeftToReveal
} from '../src/core/pinning';

describe('partitionPinned (#713)', () => {
	it('puts the pinned items first and keeps the order inside each zone', () => {
		const pinned = new Set(['c', 'a']);
		expect(partitionPinned(['a', 'b', 'c', 'd'], (id) => pinned.has(id))).toEqual({
			ordered: ['a', 'c', 'b', 'd'],
			pinnedCount: 2
		});
	});

	it('leaves the order alone when nothing is pinned', () => {
		expect(partitionPinned(['a', 'b'], () => false)).toEqual({
			ordered: ['a', 'b'],
			pinnedCount: 0
		});
	});

	it('handles every item being pinned and an empty list', () => {
		expect(partitionPinned(['a', 'b'], () => true)).toEqual({
			ordered: ['a', 'b'],
			pinnedCount: 2
		});
		expect(partitionPinned([], () => true)).toEqual({ ordered: [], pinnedCount: 0 });
	});
});

describe('pinnedOffsets (#713)', () => {
	it('is the running sum of the widths before each column', () => {
		expect(pinnedOffsets([80, 120, 200], 3)).toEqual([0, 80, 200]);
	});

	it('starts after the leading (checkbox) column', () => {
		expect(pinnedOffsets([80, 120, 200], 2, 40)).toEqual([40, 120]);
	});

	it('is empty for no pinned column and never runs past the widths', () => {
		expect(pinnedOffsets([80, 120], 0, 40)).toEqual([]);
		expect(pinnedOffsets([80], 3)).toEqual([0]);
	});
});

describe('fitPinnedCount (#713)', () => {
	it('sticks every pinned column when they leave enough room to scroll', () => {
		expect(fitPinnedCount({ pinnedWidths: [100, 100], leading: 0, viewportWidth: 800 })).toBe(2);
	});

	it('cuts the trailing pinned columns that would not leave the minimum scrollable width', () => {
		const viewportWidth = 100 + 100 + MIN_SCROLLABLE_WIDTH;
		expect(fitPinnedCount({ pinnedWidths: [100, 100], leading: 0, viewportWidth })).toBe(2);
		expect(
			fitPinnedCount({ pinnedWidths: [100, 100], leading: 0, viewportWidth: viewportWidth - 1 })
		).toBe(1);
	});

	it('counts the leading (checkbox) column against the budget', () => {
		const viewportWidth = 100 + MIN_SCROLLABLE_WIDTH;
		expect(fitPinnedCount({ pinnedWidths: [100], leading: 0, viewportWidth })).toBe(1);
		expect(fitPinnedCount({ pinnedWidths: [100], leading: 40, viewportWidth })).toBe(0);
	});

	it('stops at the first column that does not fit, even if a later narrow one would', () => {
		expect(
			fitPinnedCount({
				pinnedWidths: [300, 10],
				leading: 0,
				viewportWidth: 200,
				minScrollable: 50
			})
		).toBe(0);
	});

	it('does not limit anything before the viewport is measured', () => {
		expect(fitPinnedCount({ pinnedWidths: [500, 500], leading: 40, viewportWidth: 0 })).toBe(2);
	});

	it('is 0 without pinned columns', () => {
		expect(fitPinnedCount({ pinnedWidths: [], leading: 40, viewportWidth: 800 })).toBe(0);
	});
});

describe('clampDropIndex (#713)', () => {
	// Display order: 2 pinned + 3 unpinned.
	it('keeps a pinned column inside the pinned zone', () => {
		expect(clampDropIndex(0, 1, 2, 5)).toBe(1);
		expect(clampDropIndex(0, 2, 2, 5)).toBe(2);
		expect(clampDropIndex(0, 4, 2, 5)).toBe(2);
	});

	it('keeps an unpinned column out of the pinned zone', () => {
		expect(clampDropIndex(3, 0, 2, 5)).toBe(2);
		expect(clampDropIndex(3, 2, 2, 5)).toBe(2);
		expect(clampDropIndex(3, 5, 2, 5)).toBe(5);
		expect(clampDropIndex(3, 9, 2, 5)).toBe(5);
	});

	it('only clamps to the list when nothing is pinned', () => {
		expect(clampDropIndex(1, 0, 0, 3)).toBe(0);
		expect(clampDropIndex(1, 7, 0, 3)).toBe(3);
	});
});

describe('moveInOrder (#713)', () => {
	it('without pinned columns, inserts before the visible column at the index', () => {
		const order = ['a', 'b', 'c', 'd'];
		expect(moveInOrder(order, order, 0, 'a', 2)).toEqual(['b', 'a', 'c', 'd']);
		expect(moveInOrder(order, order, 0, 'a', 4)).toEqual(['b', 'c', 'd', 'a']);
		expect(moveInOrder(order, order, 0, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
	});

	it('keeps a column dropped on its own slot in place', () => {
		const order = ['a', 'b', 'c'];
		expect(moveInOrder(order, order, 0, 'b', 1)).toEqual(order);
		expect(moveInOrder(order, order, 0, 'b', 2)).toEqual(order);
	});

	it('returns the same array for a drop that does not change the visible position', () => {
		const order = ['a', 'b', 'c'];
		expect(moveInOrder(order, order, 0, 'b', 1)).toBe(order);
		expect(moveInOrder(order, order, 0, 'b', 2)).toBe(order);
		// b pinned: visible = b, a, c. Dropping a before c is a no-op.
		expect(moveInOrder(order, ['b', 'a', 'c'], 1, 'a', 2)).toBe(order);
		expect(moveInOrder(order, ['b', 'a', 'c'], 1, 'a', 1)).toBe(order);
	});

	it('returns the same array for an unknown or hidden column', () => {
		const order = ['a', 'h', 'b'];
		expect(moveInOrder(order, ['a', 'b'], 0, 'missing', 0)).toBe(order);
		expect(moveInOrder(order, ['a', 'b'], 0, 'h', 0)).toBe(order);
	});

	it('translates a visible index past hidden ids', () => {
		// 'h' is hidden: visible = a, b, c.
		expect(moveInOrder(['a', 'h', 'b', 'c'], ['a', 'b', 'c'], 0, 'c', 1)).toEqual([
			'a',
			'h',
			'c',
			'b'
		]);
	});

	// `order` interleaves the zones: pinned = p1, p2 (display: p1 p2 x y).
	const order = ['x', 'p1', 'y', 'p2'];
	const visible = ['p1', 'p2', 'x', 'y'];

	it('reorders a pinned column among the pinned ones', () => {
		expect(moveInOrder(order, visible, 2, 'p2', 0)).toEqual(['x', 'p2', 'p1', 'y']);
	});

	it('moves a pinned column to the end of the pinned zone, after the last pinned one', () => {
		expect(moveInOrder(order, visible, 2, 'p1', 2)).toEqual(['x', 'y', 'p2', 'p1']);
	});

	it('clamps a pinned column dragged into the unpinned zone to the end of its own', () => {
		expect(moveInOrder(order, visible, 2, 'p1', 4)).toEqual(['x', 'y', 'p2', 'p1']);
	});

	it('clamps an unpinned column dragged into the pinned zone to the start of its own', () => {
		expect(moveInOrder(order, visible, 2, 'y', 0)).toEqual(['y', 'x', 'p1', 'p2']);
	});

	it('reorders an unpinned column among the unpinned ones', () => {
		expect(moveInOrder(order, visible, 2, 'x', 4)).toEqual(['p1', 'y', 'p2', 'x']);
	});

	it('leaves the only pinned column where it is', () => {
		expect(moveInOrder(['x', 'p', 'y'], ['p', 'x', 'y'], 1, 'p', 3)).toEqual(['x', 'p', 'y']);
	});

	it('gives the display order a drop at that index asks for, for every column and index', () => {
		const pinned = new Set(['p1', 'p2']);
		for (const field of visible) {
			for (let to = 0; to <= visible.length; to++) {
				const next = moveInOrder(order, visible, 2, field, to);
				const shown = partitionPinned(next, (id) => pinned.has(id)).ordered;
				const from = visible.indexOf(field);
				const target = clampDropIndex(from, to, 2, visible.length);
				const expected = visible.filter((id) => id !== field);
				expected.splice(from < target ? target - 1 : target, 0, field);
				expect(shown, `${field} -> ${to}`).toEqual(expected);
			}
		}
	});
});

describe('contentXAt (#713)', () => {
	it('reads a point over the pinned block as unscrolled', () => {
		expect(contentXAt({ viewX: 50, scrollLeft: 300, pinnedWidth: 120 })).toBe(50);
	});

	it('adds the scroll offset right of the pinned block', () => {
		expect(contentXAt({ viewX: 120, scrollLeft: 300, pinnedWidth: 120 })).toBe(420);
		expect(contentXAt({ viewX: 50, scrollLeft: 300, pinnedWidth: 0 })).toBe(350);
	});
});

describe('scrollLeftToReveal (#713)', () => {
	const base = { scrollLeft: 200, viewportWidth: 500, pinnedWidth: 120, cellPinned: false };

	it('does not move for a pinned cell', () => {
		expect(scrollLeftToReveal({ ...base, cellLeft: 40, cellWidth: 80, cellPinned: true })).toBe(
			200
		);
	});

	it('does not move when the cell is already clear of the pinned block', () => {
		expect(scrollLeftToReveal({ ...base, cellLeft: 320, cellWidth: 100 })).toBe(200);
	});

	it('scrolls left until a cell hidden under the pinned block clears it', () => {
		// On screen from 200, but the first 120px are covered: 250 is hidden.
		expect(scrollLeftToReveal({ ...base, cellLeft: 250, cellWidth: 100 })).toBe(130);
	});

	it('never scrolls to a negative offset', () => {
		expect(scrollLeftToReveal({ ...base, cellLeft: 100, cellWidth: 50 })).toBe(0);
	});

	it('scrolls right until the cell ends at the viewport edge', () => {
		expect(scrollLeftToReveal({ ...base, cellLeft: 650, cellWidth: 100 })).toBe(250);
	});

	it('shows the start of a cell wider than the free width', () => {
		expect(scrollLeftToReveal({ ...base, cellLeft: 700, cellWidth: 450 })).toBe(580);
	});

	it('behaves as before without pinned columns', () => {
		const plain = { scrollLeft: 200, viewportWidth: 500, pinnedWidth: 0, cellPinned: false };
		expect(scrollLeftToReveal({ ...plain, cellLeft: 150, cellWidth: 100 })).toBe(150);
		expect(scrollLeftToReveal({ ...plain, cellLeft: 650, cellWidth: 100 })).toBe(250);
		expect(scrollLeftToReveal({ ...plain, cellLeft: 250, cellWidth: 100 })).toBe(200);
	});
});
