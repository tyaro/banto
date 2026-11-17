import { describe, expect, it } from 'vitest';
import { dropCollidingTicks, everyNthIndex, thinCenteredTicks } from '../src/core/ticks-time';

describe('dropCollidingTicks', () => {
	it('keeps all ticks when boxes do not overlap', () => {
		expect(dropCollidingTicks([0, 5, 10], [0, 100, 200], [40, 40, 40])).toEqual([0, 5, 10]);
	});

	it('keeps the last tick and drops the previous one when the end-anchored box overlaps', () => {
		// 2nd (middle-anchored, x=100) spans 80..120; last (end-anchored, x=130) spans 90..130.
		expect(dropCollidingTicks([0, 5, 6], [0, 100, 130], [40, 40, 40])).toEqual([0, 6]);
	});

	it('handles empty and single inputs', () => {
		expect(dropCollidingTicks([], [], [])).toEqual([]);
		expect(dropCollidingTicks([3], [10], [40])).toEqual([3]);
	});
});

describe('everyNthIndex', () => {
	it('returns every index when count fits within maxTicks', () => {
		expect(everyNthIndex(4, 6)).toEqual([0, 1, 2, 3]);
	});

	it('thins out indices when count exceeds maxTicks, always including the last', () => {
		const result = everyNthIndex(100, 5);
		expect(result[0]).toBe(0);
		expect(result[result.length - 1]).toBe(99);
		expect(result.length).toBeLessThanOrEqual(6);
	});

	it('handles count = 0', () => {
		expect(everyNthIndex(0, 5)).toEqual([]);
	});

	it('handles a single data point', () => {
		expect(everyNthIndex(1, 5)).toEqual([0]);
	});

	it('drops the last stepped index when it would collide with the final index', () => {
		// count=31, maxTicks=4 -> step=8 -> stepped [0,8,16,24]; 30-24=6 < 8,
		// so 24 yields to the always-labeled final index 30.
		expect(everyNthIndex(31, 4)).toEqual([0, 8, 16, 30]);
	});

	it('always yields a strictly increasing sequence ending at the final index', () => {
		// The stepped loop can never leave a gap of >= step before count-1,
		// so the final index always replaces the too-close stepped one; the
		// resulting invariant is: strictly increasing, ends at count-1.
		const result = everyNthIndex(100, 7);
		for (let i = 1; i < result.length; i++) expect(result[i]).toBeGreaterThan(result[i - 1]);
		expect(result[result.length - 1]).toBe(99);
	});
});

describe('thinCenteredTicks', () => {
	it('keeps every tick when no boxes collide', () => {
		expect(thinCenteredTicks([0, 100, 200, 300], [40, 40, 40, 40])).toEqual([0, 1, 2, 3]);
	});

	it('steps evenly back from the last tick until boxes fit', () => {
		// 4 ticks 50px apart, 60px wide boxes: step 1 and 2 (100px apart, 60+4 fits) -> 1,3.
		expect(thinCenteredTicks([0, 50, 100, 150], [60, 60, 60, 60])).toEqual([1, 3]);
	});

	it('falls back to the last tick alone when even the widest step collides', () => {
		expect(thinCenteredTicks([0, 10, 20], [500, 500, 500])).toEqual([2]);
	});

	it('handles 0, 1 and 2 ticks', () => {
		expect(thinCenteredTicks([], [])).toEqual([]);
		expect(thinCenteredTicks([5], [900])).toEqual([0]);
		expect(thinCenteredTicks([0, 1], [50, 50])).toEqual([1]);
		expect(thinCenteredTicks([0, 200], [50, 50])).toEqual([0, 1]);
	});

	it('copes with a degenerate zero-width plot (all ticks at one x)', () => {
		expect(thinCenteredTicks([0, 0, 0], [30, 30, 30])).toEqual([2]);
	});
});
