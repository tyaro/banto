/**
 * The dashboard's shared period (dashboardPeriod.ts, downstream-requests-2026-11-plan §4.13.3,
 * #716 W3): where a period starts, and which rows it leaves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DASHBOARD_PERIODS,
	DEFAULT_DASHBOARD_FILTER,
	DEFAULT_DASHBOARD_PERIOD,
	DASHBOARD_DIMENSIONS,
	latestDay,
	narrowRows,
	periodStart,
	type DashboardFilter
} from './dashboardPeriod';
import type { Item } from './sampleData';

const item = (id: number, updatedAt: string): Item => ({
	id,
	name: `item-${id}`,
	price: 100,
	stock: 1,
	updatedAt,
	version: 1
});

describe('periodStart (#716 W3)', () => {
	it('has four fixed choices and starts at "all"', () => {
		expect(DASHBOARD_PERIODS).toEqual(['all', '30d', '90d', '12m']);
		expect(DEFAULT_DASHBOARD_PERIOD).toBe('all');
		expect(DEFAULT_DASHBOARD_FILTER).toEqual({ period: 'all', selection: {} });
	});

	it('counts back from the anchor: days, or calendar months', () => {
		expect(periodStart('all', '2026-07-02')).toBeNull();
		expect(periodStart('30d', '2026-07-02')).toBe('2026-06-02');
		expect(periodStart('90d', '2026-07-02')).toBe('2026-04-03');
		expect(periodStart('12m', '2026-07-02')).toBe('2025-07-02');
		// Across a year's end, and from a timestamp.
		expect(periodStart('30d', '2026-01-10T08:00:00Z')).toBe('2025-12-11');
		expect(periodStart('12m', '2026-01-10 08:00:00')).toBe('2025-01-10');
	});

	it('has no lower bound for an anchor that is not a date', () => {
		expect(periodStart('30d', '')).toBeNull();
		expect(periodStart('30d', 'not a date')).toBeNull();
	});
});

describe('narrowRows (#716 W3)', () => {
	const rows = [
		item(1, '2026-07-02'),
		item(2, '2026-06-03'),
		item(3, '2026-06-02'),
		item(4, '2026-04-04T23:59:59Z'),
		item(5, '2026-04-03'),
		item(6, '2025-07-03'),
		item(7, '2025-07-02'),
		item(8, '2024-01-01')
	];
	const ids = (period: (typeof DASHBOARD_PERIODS)[number]) =>
		narrowRows(rows, { period, selection: {} }).map((row) => row.id);

	it('counts from the newest updatedAt in the rows, not from the wall clock', () => {
		expect(latestDay(rows)).toBe('2026-07-02');
		expect(latestDay([])).toBeNull();
		// 30 days up to and including the newest day: its start day itself is outside.
		expect(ids('30d')).toEqual([1, 2]);
		expect(ids('90d')).toEqual([1, 2, 3, 4]);
		expect(ids('12m')).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('clamps a day that overflows the target month (leap day, 12 months back)', () => {
		expect(periodStart('12m', '2024-02-29')).toBe('2023-02-28');
		const leap = [item(1, '2024-02-29'), item(2, '2023-03-01'), item(3, '2023-02-28')];
		expect(narrowRows(leap, { period: '12m', selection: {} }).map((row) => row.id)).toEqual([1, 2]);
		// Days back are not clamped: 30 days before 2024-03-31 is 2024-03-01.
		expect(periodStart('30d', '2024-03-31')).toBe('2024-03-01');
	});

	it('returns the rows themselves when there is nothing to narrow by', () => {
		expect(narrowRows(rows, { period: 'all', selection: {} })).toBe(rows);
		const none: Item[] = [];
		expect(narrowRows(none, { period: '30d', selection: {} })).toBe(none);
	});
});

describe('the period is not saved (#716 W3, §4.13.7 b)', () => {
	const here = fileURLToPath(new URL('.', import.meta.url));

	// The filter is the page's `$state` and reaches the data as an argument. Neither module knows a
	// place to keep it: no saved setting, no browser storage, no layout store. (That a reload starts
	// at "all" and that changing the period writes no setting is the e2e scenario 13k6.)
	it.each(['dashboardPeriod.ts', 'dashboardData.svelte.ts'])(
		'%s has nowhere to save to',
		(name) => {
			const source = readFileSync(`${here}/${name}`, 'utf8');
			expect(source).not.toMatch(
				/createSavedSetting|getUiSettings|UiSettingsProvider|localStorage|sessionStorage|createDockLayoutStore/
			);
		}
	);
});

describe('the selection (#882 C1)', () => {
	const row = (id: number, name: string, price: number, updatedAt: string): Item => ({
		...item(id, updatedAt),
		name,
		price
	});
	// category = the first word of the name; price bands: 0-99 / 100-149 / 150-199 / 200-
	const rows = [
		row(1, 'Alpha one', 50, '2026-07-02'),
		row(2, 'Alpha two', 120, '2026-06-20'),
		row(3, 'Beta one', 120, '2026-06-25'),
		row(4, 'Beta two', 250, '2024-01-01')
	];
	const ids = (list: Item[]) => list.map((r) => r.id);
	const filter = (
		selection: DashboardFilter['selection'],
		period: DashboardFilter['period'] = 'all'
	): DashboardFilter => ({ period, selection });

	it('has the two dimensions, and an empty selection narrows nothing (the same array)', () => {
		expect(DASHBOARD_DIMENSIONS).toEqual(['category', 'priceBucket']);
		expect(narrowRows(rows, filter({}))).toBe(rows);
		expect(narrowRows(rows, filter({ category: '' }))).toBe(rows);
	});

	it('narrows by one dimension, and by two together', () => {
		expect(ids(narrowRows(rows, filter({ category: 'Alpha' })))).toEqual([1, 2]);
		expect(ids(narrowRows(rows, filter({ priceBucket: '100-149' })))).toEqual([2, 3]);
		expect(ids(narrowRows(rows, filter({ category: 'Beta', priceBucket: '100-149' })))).toEqual([
			3
		]);
	});

	it('does not narrow by the dimension it is asked to leave out (a mark does not hide its siblings)', () => {
		const both = filter({ category: 'Alpha', priceBucket: '100-149' });
		expect(ids(narrowRows(rows, both))).toEqual([2]);
		expect(ids(narrowRows(rows, both, 'category'))).toEqual([2, 3]);
		expect(ids(narrowRows(rows, both, 'priceBucket'))).toEqual([1, 2]);
		// Only one dimension chosen and it is the one left out: nothing narrows.
		expect(narrowRows(rows, filter({ category: 'Alpha' }), 'category')).toBe(rows);
	});

	it('stacks on the period', () => {
		// 30d from 2026-07-02 leaves rows 1-3; the selection then narrows them.
		expect(ids(narrowRows(rows, filter({ category: 'Beta' }, '30d')))).toEqual([3]);
		expect(ids(narrowRows(rows, filter({ category: 'Beta' }, 'all')))).toEqual([3, 4]);
		// Leaving the dimension out still keeps the period.
		expect(ids(narrowRows(rows, filter({ category: 'Beta' }, '30d'), 'category'))).toEqual([
			1, 2, 3
		]);
	});
});
