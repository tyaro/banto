import { describe, expect, it } from 'vitest';
import {
	clampMarkIndex,
	isMarkActivateKey,
	isMarkNavKey,
	nextMarkIndex
} from '../src/core/mark-nav';
import { defaultChartMessages } from '../src/messages';

describe('nextMarkIndex', () => {
	it('moves to the next mark with Right / Down and the previous with Left / Up', () => {
		expect(nextMarkIndex('ArrowRight', 1, 4)).toBe(2);
		expect(nextMarkIndex('ArrowDown', 1, 4)).toBe(2);
		expect(nextMarkIndex('ArrowLeft', 2, 4)).toBe(1);
		expect(nextMarkIndex('ArrowUp', 2, 4)).toBe(1);
	});

	it('clamps at both ends (no wrap-around)', () => {
		expect(nextMarkIndex('ArrowRight', 3, 4)).toBe(3);
		expect(nextMarkIndex('ArrowLeft', 0, 4)).toBe(0);
	});

	it('Home / End go to the first / last mark', () => {
		expect(nextMarkIndex('Home', 2, 4)).toBe(0);
		expect(nextMarkIndex('End', 1, 4)).toBe(3);
	});

	it('returns null for other keys and for nothing to navigate', () => {
		expect(nextMarkIndex('a', 0, 4)).toBeNull();
		expect(nextMarkIndex('Enter', 0, 4)).toBeNull();
		expect(nextMarkIndex('ArrowRight', 0, 0)).toBeNull();
		expect(nextMarkIndex('ArrowRight', 0, Number.NaN)).toBeNull();
	});

	it('clamps an out-of-range current index first', () => {
		expect(nextMarkIndex('ArrowLeft', 9, 4)).toBe(2);
		expect(nextMarkIndex('ArrowRight', -5, 4)).toBe(1);
		expect(nextMarkIndex('ArrowRight', Number.NaN, 4)).toBe(1);
	});

	it('a single mark stays put', () => {
		expect(nextMarkIndex('ArrowRight', 0, 1)).toBe(0);
		expect(nextMarkIndex('End', 0, 1)).toBe(0);
	});
});

describe('key predicates and clamp', () => {
	it('recognises navigation and activation keys', () => {
		expect(isMarkNavKey('Home')).toBe(true);
		expect(isMarkNavKey('Tab')).toBe(false);
		expect(isMarkActivateKey('Enter')).toBe(true);
		expect(isMarkActivateKey(' ')).toBe(true);
		expect(isMarkActivateKey('a')).toBe(false);
	});

	it('clampMarkIndex keeps the tab stop in range when data shrinks', () => {
		expect(clampMarkIndex(5, 3)).toBe(2);
		expect(clampMarkIndex(-1, 3)).toBe(0);
		expect(clampMarkIndex(1, 0)).toBe(0);
	});
});

describe('default mark labels', () => {
	it('reads "<category>: <value>", naming the series when there are several', () => {
		expect(defaultChartMessages.markLabel('食品', '1,200')).toBe('食品: 1,200');
		expect(defaultChartMessages.markLabelWithSeries('食品', '在庫', '1,200')).toBe(
			'食品（在庫）: 1,200'
		);
	});
});
