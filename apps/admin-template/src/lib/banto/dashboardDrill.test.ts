/**
 * `drillHref` (#882 D3, crossfilter-drilldown-design §7.2 / §9): the link a mark opens. The list
 * side (reading the link, the boundary rows) is `resource/listViews.test.ts` and the e2e.
 */
import { describe, expect, it } from 'vitest';
import { drillHref } from './dashboardDrill';
import { latestDay, periodStart, type DashboardFilter } from './dashboardPeriod';
import { PRICE_BANDS } from './resources/items';
import type { Item } from './sampleData';

const all: DashboardFilter = { period: 'all', selection: {} };
const days30: DashboardFilter = { period: '30d', selection: {} };

/** The query of a link, as the list reads it. */
const queryOf = (href: string) => Object.fromEntries(new URL(href, 'http://x').searchParams);

describe('drillHref', () => {
	it('opens the low-stock view; with no period it carries no `after`', () => {
		const href = drillHref({ kind: 'lowStock' }, all, '2026-07-02');
		expect(href).toMatch(/\/items\?/);
		expect(queryOf(href)).toEqual({ view: 'low-stock' });
	});

	it('carries the day periodStart returned as `arg.after`, as it is', () => {
		// 30d from 2026-07-02: the day it starts AFTER is 2026-06-02 (not the anchor, not the next day).
		expect(periodStart('30d', '2026-07-02')).toBe('2026-06-02');
		expect(queryOf(drillHref({ kind: 'lowStock' }, days30, '2026-07-02'))).toEqual({
			view: 'low-stock',
			'arg.after': '2026-06-02'
		});
		for (const period of ['90d', '12m'] as const) {
			expect(
				queryOf(drillHref({ kind: 'lowStock' }, { period, selection: {} }, '2026-07-02'))[
					'arg.after'
				]
			).toBe(periodStart(period, '2026-07-02'));
		}
	});

	it('counts the period from the newest day of the rows read (latestDay)', () => {
		const rows = [{ updatedAt: '2026-03-01' }, { updatedAt: '2026-07-02T10:00:00Z' }] as Item[];
		const anchor = latestDay(rows);
		expect(queryOf(drillHref({ kind: 'lowStock' }, days30, anchor))['arg.after']).toBe(
			'2026-06-02'
		);
	});

	it('leaves `after` out when there is no anchor day (no rows read)', () => {
		expect(queryOf(drillHref({ kind: 'lowStock' }, days30, null))).toEqual({ view: 'low-stock' });
	});

	it('opens the price-band view with the band, and the period on top', () => {
		for (const band of PRICE_BANDS) {
			expect(queryOf(drillHref({ kind: 'priceBucket', bucket: band.id }, all, null))).toEqual({
				view: 'price-band',
				'arg.band': band.id
			});
		}
		expect(
			queryOf(drillHref({ kind: 'priceBucket', bucket: '100-149' }, days30, '2026-07-02'))
		).toEqual({ view: 'price-band', 'arg.band': '100-149', 'arg.after': '2026-06-02' });
	});

	it('writes the values through the URL encoder (an open band id ends in "-")', () => {
		const href = drillHref({ kind: 'priceBucket', bucket: '200-' }, all, null);
		expect(href).toMatch(/arg\.band=200-$/);
		expect(queryOf(href)['arg.band']).toBe('200-');
	});
});
