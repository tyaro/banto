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
	latestDay,
	narrowRows,
	periodStart
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
		expect(DEFAULT_DASHBOARD_FILTER).toEqual({ period: 'all' });
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
		narrowRows(rows, { period }).map((row) => row.id);

	it('counts from the newest updatedAt in the rows, not from the wall clock', () => {
		expect(latestDay(rows)).toBe('2026-07-02');
		expect(latestDay([])).toBeNull();
		// 30 days up to and including the newest day: its start day itself is outside.
		expect(ids('30d')).toEqual([1, 2]);
		expect(ids('90d')).toEqual([1, 2, 3, 4]);
		expect(ids('12m')).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('returns the rows themselves when there is nothing to narrow by', () => {
		expect(narrowRows(rows, { period: 'all' })).toBe(rows);
		const none: Item[] = [];
		expect(narrowRows(none, { period: '30d' })).toBe(none);
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
