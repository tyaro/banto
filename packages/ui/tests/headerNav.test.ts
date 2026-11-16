/**
 * @banto/ui `headerNav.ts` (docs/design/nav-menubar-plan.md §4.3, §4.4, §4.7,
 * §7.1): the overflow arithmetic `fitCount` as a table - everything fits (no
 * "more"), one entry moves (the "more" width is taken off and the rest
 * recomputed), everything moves, width 0, gaps, the boundary where adding
 * "more" costs one entry, and the insufficient state with its recover slack -
 * plus the "more" sections (D2-a), the counts and the arrow-key moves (D3-c).
 * The component's own contracts are in `HeaderNav.component.test.ts` (a
 * separate name: `HeaderNav.test.ts` would be the same file as this one on a
 * case-insensitive file system).
 */
import { describe, expect, it } from 'vitest';
import {
	fitCount,
	HEADER_NAV_INSUFFICIENT,
	HEADER_NAV_RECOVER_SLACK,
	headerNavBadgeText,
	headerNavEntryActive,
	headerNavEntryCount,
	headerNavListTarget,
	headerNavOverflowSections,
	headerNavTopRowTarget,
	type HeaderNavEntry
} from '../src/index';

const INSUFFICIENT = HEADER_NAV_INSUFFICIENT;

describe('fitCount', () => {
	// Three items of 100px, 10px gaps (total 320), "more" 60px.
	const widths = [100, 100, 100];

	it.each([
		['everything fits exactly (no "more")', 320, 3],
		['everything fits with room to spare', 1000, 3],
		// 319 < 320: "more" is needed: 60 + (100 + 10) * 2 = 280 <= 319.
		['one px short: "more" takes the last one', 319, 2],
		// Boundary: two items + "more" need 280.
		['two items + "more" at the boundary', 280, 2],
		['one px under: one item + "more"', 279, 1],
		// One item + "more": 60 + 110 = 170.
		['one item + "more" at the boundary', 170, 1],
		['everything moves to "more"', 169, 0],
		['only "more" fits', 60, 0],
		['not even "more" fits', 59, INSUFFICIENT],
		['width 0', 0, INSUFFICIENT]
	])('%s (available %d -> %d)', (_label, available, expected) => {
		expect(fitCount(widths, available, 60, 10)).toBe(expected);
	});

	it('counts one gap between two items, not after the last', () => {
		expect(fitCount([50, 50], 100, 30, 0)).toBe(2);
		expect(fitCount([50, 50], 108, 30, 8)).toBe(2);
		expect(fitCount([50, 50], 107, 30, 8)).toBe(1);
	});

	it('tolerates sub-pixel rounding', () => {
		expect(fitCount([100.4, 100.4], 200.6, 40, 0)).toBe(2);
	});

	it('returns 0 for no entries, whatever the width', () => {
		expect(fitCount([], 0, 60, 10)).toBe(0);
		expect(fitCount([], 500, 60, 10)).toBe(0);
	});

	it('a lone entry that fits needs no "more", even when "more" would not fit', () => {
		expect(fitCount([30], 40, 60, 10)).toBe(1);
	});

	describe('recover slack (§4.9)', () => {
		const slack = HEADER_NAV_RECOVER_SLACK;

		it('enters the insufficient state at the plain boundary', () => {
			expect(fitCount(widths, 60, 60, 10, { previous: 0 })).toBe(0);
			expect(fitCount(widths, 59, 60, 10, { previous: 0 })).toBe(INSUFFICIENT);
		});

		it('stays insufficient until the slack is also free', () => {
			const previous = INSUFFICIENT;
			expect(fitCount(widths, 60, 60, 10, { previous })).toBe(INSUFFICIENT);
			expect(fitCount(widths, 60 + slack - 1, 60, 10, { previous })).toBe(INSUFFICIENT);
			expect(fitCount(widths, 60 + slack, 60, 10, { previous })).toBe(0);
		});

		it('returns the plain count once recovered', () => {
			expect(fitCount(widths, 400, 60, 10, { previous: INSUFFICIENT })).toBe(3);
			expect(fitCount(widths, 200, 60, 10, { previous: INSUFFICIENT })).toBe(1);
		});

		it('recovers from the smallest layout that fits, all-in-a-row included (not just "more")', () => {
			// One 30px entry, a 60px "more": it is insufficient below 30px, so it
			// comes back at 30 + slack, well before "more" itself would fit.
			const previous = INSUFFICIENT;
			expect(fitCount([30], 29, 60, 10, { previous: 1 })).toBe(INSUFFICIENT);
			expect(fitCount([30], 30 + slack - 1, 60, 10, { previous })).toBe(INSUFFICIENT);
			expect(fitCount([30], 30 + slack, 60, 10, { previous })).toBe(1);
		});

		it('takes a custom slack', () => {
			const options = { previous: INSUFFICIENT, recoverSlack: 40 };
			expect(fitCount(widths, 99, 60, 10, options)).toBe(INSUFFICIENT);
			expect(fitCount(widths, 100, 60, 10, options)).toBe(0);
		});
	});
});

describe('headerNavBadgeText', () => {
	it.each([
		[1, '1'],
		[99, '99'],
		[100, '99+'],
		[12345, '99+']
	])('%d -> %s', (count, text) => {
		expect(headerNavBadgeText(count)).toBe(text);
	});
});

const link = (id: string, extra: { active?: boolean; count?: number } = {}): HeaderNavEntry => ({
	kind: 'link',
	id,
	href: `/${id}`,
	label: id,
	...extra
});
const group = (
	id: string,
	items: string[],
	extra: { active?: string; count?: number } = {}
): HeaderNavEntry => ({
	kind: 'group',
	id,
	label: `G-${id}`,
	items: items.map((item) => ({
		id: item,
		href: `/${item}`,
		label: item,
		active: item === extra.active,
		count: extra.count
	}))
});

describe('counts and active', () => {
	it('sums a group from the numeric counts', () => {
		expect(headerNavEntryCount(group('g', ['a', 'b'], { count: 60 }))).toBe(120);
		expect(headerNavEntryCount(link('a', { count: 3 }))).toBe(3);
		expect(headerNavEntryCount(link('a'))).toBe(0);
	});

	it('marks a group active when it holds the current page', () => {
		expect(headerNavEntryActive(group('g', ['a', 'b'], { active: 'b' }))).toBe(true);
		expect(headerNavEntryActive(group('g', ['a', 'b']))).toBe(false);
		expect(headerNavEntryActive(link('a', { active: true }))).toBe(true);
	});
});

describe('headerNavOverflowSections (D2-a)', () => {
	it('keeps the order, puts each group under its heading and gathers loose links', () => {
		const sections = headerNavOverflowSections([
			link('a'),
			link('b'),
			group('g', ['g1', 'g2']),
			link('c'),
			group('h', ['h1'])
		]);
		expect(sections.map((s) => [s.heading ?? null, s.items.map((i) => i.id)])).toEqual([
			[null, ['a', 'b']],
			['G-g', ['g1', 'g2']],
			[null, ['c']],
			['G-h', ['h1']]
		]);
	});

	it('returns nothing for nothing moved', () => {
		expect(headerNavOverflowSections([])).toEqual([]);
	});
});

describe('headerNavTopRowTarget (D3-c)', () => {
	it.each([
		[0, 'ArrowRight', 1],
		[3, 'ArrowRight', 0], // wraps to the first
		[0, 'ArrowLeft', 3], // wraps to the last ("more" counts as an item)
		[2, 'ArrowLeft', 1],
		[2, 'Home', 0],
		[1, 'End', 3],
		[-1, 'ArrowRight', 0],
		[-1, 'ArrowLeft', 3],
		[1, 'ArrowDown', null],
		[1, 'Tab', null],
		[1, 'Enter', null]
	])('from %d, %s -> %s (4 items)', (current, key, expected) => {
		expect(headerNavTopRowTarget(current, 4, key)).toBe(expected);
	});

	it('does nothing with no items', () => {
		expect(headerNavTopRowTarget(-1, 0, 'ArrowRight')).toBeNull();
	});
});

describe('headerNavListTarget (open dropdown)', () => {
	it.each([
		[0, 'ArrowDown', 1],
		[2, 'ArrowDown', 0], // wraps
		[0, 'ArrowUp', 2], // wraps
		[-1, 'ArrowDown', 0],
		[-1, 'ArrowUp', 2],
		[1, 'Home', 0],
		[1, 'End', 2],
		// Left / Right do nothing inside the list (PR-2 default).
		[1, 'ArrowLeft', null],
		[1, 'ArrowRight', null],
		[1, 'Tab', null]
	])('from %d, %s -> %s (3 links)', (current, key, expected) => {
		expect(headerNavListTarget(current, 3, key)).toBe(expected);
	});
});
