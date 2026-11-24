/**
 * items' list views that take URL arguments (#882): the price bands and `low-stock`'s `after`.
 * The point: the dashboard's aggregate (`priceBuckets`) and the list's conditions are built from the
 * same cut points, so on the boundary values they pick the same rows.
 */
import { filterRows, type GridColumn } from '@banto/grid-svelte';
import { describe, expect, it } from 'vitest';
import { priceBuckets } from '../dashboard';
import { presetViewFromUrl, viewFitsFields } from '../../resource/listViews';
import type { Item } from '../sampleData';
import {
	LOW_STOCK_VIEW_ID,
	PRICE_BANDS,
	PRICE_BAND_VIEW_ID,
	itemsResource,
	priceBandFilters,
	updatedAfterFilters
} from './items';

const columns = ['price', 'stock', 'updatedAt'].map((id) => ({
	id,
	header: id,
	accessor: id
})) as unknown as GridColumn<Item>[];

function item(id: number, price: number, updatedAt = '2026-06-01T09:00:00Z'): Item {
	return { id, name: `n${id}`, price, stock: 100, updatedAt, version: 1 } as Item;
}

const views = itemsResource.list?.views ?? [];
const view = (id: string) => views.find((entry) => entry.id === id)!;
const query = (text: string) => new URLSearchParams(text);
const pricesOf = (rows: Item[], id: string) =>
	filterRows(rows, priceBandFilters(id)!, columns).map((row) => row.price);

describe('price bands', () => {
	const rows = [0, 99, 100, 149, 150, 199, 200, 5000].map((price, i) => item(i + 1, price));

	it('the aggregate and each band condition pick the same rows (both sides of every cut point)', () => {
		const counts = priceBuckets(rows).map((bucket) => bucket.count);
		expect(counts).toEqual([2, 2, 2, 2]);
		PRICE_BANDS.forEach((band, i) => {
			expect(pricesOf(rows, band.id)).toHaveLength(counts[i]!);
		});
		expect(pricesOf(rows, '0-99')).toEqual([0, 99]);
		expect(pricesOf(rows, '100-149')).toEqual([100, 149]);
		expect(pricesOf(rows, '150-199')).toEqual([150, 199]);
		expect(pricesOf(rows, '200-')).toEqual([200, 5000]);
	});

	it('an unknown band has no conditions', () => {
		expect(priceBandFilters('nope')).toBeNull();
		expect(priceBandFilters('')).toBeNull();
	});
});

describe('after (the day itself is not included)', () => {
	const rows = [
		item(1, 10, '2026-06-01T23:59:59Z'),
		item(2, 10, '2026-06-02T00:00:00Z'),
		item(3, 10, '2026-06-02T18:30:00Z'),
		item(4, 10, '2026-06-03T00:00:00Z'),
		item(5, 10, '2026-06-03T12:00:00Z')
	];
	const idsAfter = (day: string) =>
		filterRows(rows, updatedAfterFilters(day)!, columns).map((row) => row.id);

	it('keeps the rows from the day after', () => {
		expect(idsAfter('2026-06-02')).toEqual([4, 5]);
		expect(idsAfter('2026-06-01')).toEqual([2, 3, 4, 5]);
	});

	it('crosses month ends and refuses non-days', () => {
		expect(updatedAfterFilters('2026-02-28')![0]!.value).toEqual(['2026-03-01', null]);
		expect(updatedAfterFilters('2026-06-31')).toBeNull();
		expect(updatedAfterFilters('yesterday')).toBeNull();
	});
});

describe('the definition views', () => {
	it('declare argument names of the allowed shape', () => {
		for (const entry of views) {
			for (const name of Object.keys(entry.args ?? {})) expect(name).toMatch(/^[a-z][A-Za-z0-9]*$/);
		}
	});

	it('price-band: required band; the link works whole or not at all', () => {
		const v = view(PRICE_BAND_VIEW_ID);
		expect(
			presetViewFromUrl(v, query('view=price-band&arg.band=100-149'))?.content.filters
		).toEqual(priceBandFilters('100-149'));
		expect(presetViewFromUrl(v, query('view=price-band'))).toBeNull();
		expect(presetViewFromUrl(v, query('arg.band=nope'))).toBeNull();
	});

	it('low-stock: stays plain without arguments, narrows with after', () => {
		const v = view(LOW_STOCK_VIEW_ID);
		expect(presetViewFromUrl(v, query('view=low-stock'))?.strict).toBe(false);
		const withAfter = presetViewFromUrl(v, query('arg.after=2026-06-02'))!;
		expect(withAfter.strict).toBe(true);
		expect(withAfter.content.filters.map((f) => f.field)).toEqual(['stock', 'updatedAt']);
		expect(presetViewFromUrl(v, query('arg.after=2026-13-40'))).toBeNull();
	});

	it('every field the views use is a column of both grids', () => {
		const both = ['price', 'stock', 'updatedAt'];
		for (const entry of views) {
			const content = presetViewFromUrl(
				entry,
				query('arg.band=100-149&arg.after=2026-06-02')
			)?.content;
			expect(content && viewFitsFields(content, both)).toBe(true);
		}
	});
});
