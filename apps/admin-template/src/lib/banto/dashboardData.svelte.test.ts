/**
 * The dashboard reads `items` ONCE per document (dashboardData.svelte.ts,
 * downstream-requests-2026-11-plan §4.13.3, #716 W1).
 *
 * Two halves:
 *  - `createDashboardData` makes one `getList` call per `load()`, with the whole-dataset window;
 *  - nothing a widget is made of reads data on its own - the registry, the KPI definitions, the
 *    strip and the widget components only take `DashboardData` (a source scan: the components are
 *    not mounted in this node environment). The DOM side - one `/api/items/list` request for the
 *    whole page, dock panels included - is the e2e scenario in `e2e/tests/smoke.spec.ts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
	createInMemoryDataProvider,
	initBanto,
	type AuthProvider,
	type CredentialRevision
} from '@banto/admin-core';
import { DASHBOARD_ROW_LIMIT, createDashboardData, rowsTruncated } from './dashboardData.svelte';
import type { DashboardFilter } from './dashboardPeriod';
import { DASHBOARD_WIDGETS, dashboardDataFor, type DashboardWidgetDef } from './dashboardWidgets';
import { itemsResource } from './resources/items';
import type { Item } from './sampleData';

const item = (id: number, price: number, stock: number): Item => ({
	id,
	name: `item-${id}`,
	price,
	stock,
	updatedAt: '2026-01-15T00:00:00Z',
	version: 1
});

// Signed out and never changing: the read under test does not go through it.
const revision = '0.0' as CredentialRevision;
const authProvider: AuthProvider = {
	login: async () => ({ success: true }),
	logout: async () => {},
	resolve: async () => ({ status: 'none', checked: revision, current: revision }),
	credentialRevision: () => revision,
	onCredentialChanged: () => () => {}
};

function setup(rows: Item[]) {
	const dataProvider = createInMemoryDataProvider({ items: { rows } });
	const getList = vi.spyOn(dataProvider, 'getList');
	initBanto({ dataProvider, authProvider, resources: [itemsResource] });
	return { getList };
}

describe('createDashboardData (#716 W1)', () => {
	it('reads items once per load, the whole dataset, and derives the KPI numbers from it', async () => {
		const { getList } = setup([item(1, 100, 3), item(2, 200, 500)]);
		const data = createDashboardData();
		expect(getList).not.toHaveBeenCalled();
		expect(data.rows).toEqual([]);
		expect(data.stats.count).toBe(0);

		await data.load();

		expect(getList).toHaveBeenCalledTimes(1);
		expect(getList.mock.calls[0][0]).toBe('items');
		expect(getList.mock.calls[0][1]).toMatchObject({
			pagination: { offset: 0, limit: DASHBOARD_ROW_LIMIT }
		});
		expect(data.loading).toBe(false);
		expect(data.rows.map((row) => row.id)).toEqual([1, 2]);
		expect(data.totalCount).toBe(2);
		expect(data.stats).toMatchObject({ count: 2, stockTotal: 503, avgPrice: 150 });
		// Reading the numbers and the rows again asks the provider nothing.
		void data.stats;
		void data.rows;
		expect(getList).toHaveBeenCalledTimes(1);
		data.dispose();
	});
});

describe('the row limit (#882 D3)', () => {
	it('is exceeded only when the server holds more rows than were read', () => {
		expect(rowsTruncated(0, 0)).toBe(false);
		expect(rowsTruncated(DASHBOARD_ROW_LIMIT, DASHBOARD_ROW_LIMIT)).toBe(false);
		expect(rowsTruncated(DASHBOARD_ROW_LIMIT + 1, DASHBOARD_ROW_LIMIT)).toBe(true);
		// Compared with the rows read, not with what a period leaves: 2 of 4 shown is not a cut.
		expect(rowsTruncated(4, 4)).toBe(false);
	});
});

describe('the shared period (#716 W3)', () => {
	const dated = (id: number, stock: number, updatedAt: string): Item => ({
		...item(id, 100, stock),
		updatedAt
	});
	// The newest day is 2026-07-02: "30d" leaves rows 1 and 2.
	const rows = [
		dated(1, 3, '2026-07-02'),
		dated(2, 500, '2026-06-20'),
		dated(3, 40, '2026-03-01'),
		dated(4, 7, '2024-05-05')
	];

	it('narrows the rows and the KPI numbers by the page filter, without reading again', async () => {
		const { getList } = setup(rows);
		const filter = $state<DashboardFilter>({ period: 'all', selection: {} });
		const data = createDashboardData({ filter: () => filter });
		await data.load();

		// "all": the narrowed data and the read are one array, one set of numbers.
		expect(data.rows).toBe(data.all.rows);
		expect(data.stats).toEqual(data.all.stats);
		expect(data.stats).toMatchObject({ count: 4, stockTotal: 550 });

		filter.period = '30d';
		expect(data.rows.map((row) => row.id)).toEqual([1, 2]);
		expect(data.stats).toMatchObject({ count: 2, stockTotal: 503 });
		// What is not narrowed stays as it was read; the server's count is never narrowed.
		expect(data.all.rows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
		expect(data.all.stats).toMatchObject({ count: 4, stockTotal: 550 });
		expect(data.totalCount).toBe(4);
		// Narrowing by the period is not a truncation (#882 D3): 2 of 4 rows shown, all 4 were read.
		expect(data.truncated).toBe(false);
		expect(data.all.truncated).toBe(false);

		filter.period = '12m';
		expect(data.rows.map((row) => row.id)).toEqual([1, 2, 3]);

		expect(getList).toHaveBeenCalledTimes(1);
		data.dispose();
	});

	it('draws nothing narrowed for a document that is not told the period (the pop-out route)', async () => {
		setup(rows);
		const data = createDashboardData();
		await data.load();
		expect(data.rows).toBe(data.all.rows);
		expect(data.rows).toHaveLength(4);
		data.dispose();
	});

	// These tests are compiled without reactivity (vitest runs them in node, like every logic test
	// of this app), so 'is drawn again' is checked as what it follows from: WHICH object a widget
	// reads. A widget given `data` reads the narrowed rows, the signal the period changes; a widget
	// given `data.all` reads only the read itself, which a change of the period does not touch.
	// The redraw on screen is the e2e scenario 13k6 (smoke.spec.ts).
	it('hands the KPI strip and every usesPeriod widget the same rows, and the others the read as it is', async () => {
		setup(rows);
		const filter = $state<DashboardFilter>({ period: 'all', selection: {} });
		const data = createDashboardData({ filter: () => filter });
		await data.load();
		const readBefore = data.all.rows;

		// The registry of this copy (a preset may have removed the charts or the memo), plus one
		// widget of each kind so both sides are checked whatever is registered.
		const defs: Pick<DashboardWidgetDef, 'id' | 'usesPeriod'>[] = [
			...DASHBOARD_WIDGETS,
			{ id: 'test:uses-period', usesPeriod: true },
			{ id: 'test:ignores-period' }
		];

		filter.period = '30d';

		for (const def of defs) {
			const given = dashboardDataFor(def, data);
			if (def.usesPeriod) {
				// The period's rows: the same ones the KPI strip draws (no selection here).
				expect(given, def.id).toBe(data.byPeriod);
				expect(
					given.rows.map((row) => row.id),
					def.id
				).toEqual([1, 2]);
				expect(given.stats, def.id).toEqual(data.stats);
				expect(given.rows, def.id).toEqual(data.rows);
			} else {
				// The read itself: the same array as before the period changed.
				expect(given, def.id).toBe(data.all);
				expect(given.rows, def.id).toBe(readBefore);
				expect(given.rows, def.id).toHaveLength(4);
			}
		}
		data.dispose();
	});
});

describe('the widgets take the data as a prop (#716 W1)', () => {
	const lib = fileURLToPath(new URL('..', import.meta.url));
	// No directory: a preset that removed every optional widget (scripts/scaffold.mjs).
	const svelteFiles = (dir: string): string[] =>
		(existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []).flatMap((entry) =>
			entry.isDirectory()
				? svelteFiles(`${dir}/${entry.name}`)
				: entry.name.endsWith('.svelte')
					? [`${dir}/${entry.name}`]
					: []
		);
	const sources = [
		`${lib}/banto/dashboardWidgets.ts`,
		`${lib}/banto/dashboardKpis.ts`,
		`${lib}/components/DashboardKpiStrip.svelte`,
		...svelteFiles(`${lib}/components/dashboard`)
	];

	it('finds the registrations and the strip', () => {
		expect(sources.length).toBeGreaterThanOrEqual(3);
	});

	it.each(sources)('%s does not read data itself', (file) => {
		// A call, or the provider module's import: a doc comment may name the functions.
		const source = readFileSync(file, 'utf8');
		expect(source).not.toMatch(
			/\b(createListResource|createDashboardData|getDataProvider|fetch)\(|itemsAdmin/
		);
	});
});

describe('the selection of the page (#882 C1)', () => {
	const row = (id: number, name: string, price: number): Item => ({
		...item(id, price, 1),
		name,
		updatedAt: id === 4 ? '2024-01-01' : '2026-07-02'
	});
	const rows = [
		row(1, 'Alpha one', 50),
		row(2, 'Alpha two', 120),
		row(3, 'Beta one', 120),
		row(4, 'Beta two', 250)
	];
	const ids = (data: { rows: Item[] }) => data.rows.map((r) => r.id);

	it('narrows the KPI strip by everything, and each dimension-showing widget by the others only', async () => {
		setup(rows);
		const filter = $state<DashboardFilter>({
			period: '30d',
			selection: { category: 'Alpha', priceBucket: '100-149' }
		});
		const data = createDashboardData({ filter: () => filter });
		await data.load();

		expect(ids(data)).toEqual([2]);
		expect(data.stats.count).toBe(1);
		// Not by its own dimension: the category chart keeps every category of the chosen band.
		expect(ids(data.without('category'))).toEqual([2, 3]);
		expect(data.without('category').stats.count).toBe(2);
		expect(ids(data.without('priceBucket'))).toEqual([1, 2]);
		// Period only (a usesPeriod widget that ignores the selection), and the read itself.
		expect(ids(data.byPeriod)).toEqual([1, 2, 3]);
		expect(ids(data.all)).toEqual([1, 2, 3, 4]);

		// Changing the selection reads nothing again.
		filter.selection = {};
		expect(ids(data)).toEqual([1, 2, 3]);
		expect(data.rows).toEqual(data.byPeriod.rows);
		data.dispose();
	});

	it('hands each widget the data its registration asks for', async () => {
		setup(rows);
		const filter = $state<DashboardFilter>({ period: 'all', selection: { category: 'Beta' } });
		const data = createDashboardData({ filter: () => filter });
		await data.load();

		expect(dashboardDataFor({ usesSelection: true }, data)).toBe(data);
		expect(dashboardDataFor({ usesSelection: true, selects: 'category' }, data)).toBe(
			data.without('category')
		);
		expect(ids(dashboardDataFor({ usesSelection: true, selects: 'category' }, data))).toEqual([
			1, 2, 3, 4
		]);
		expect(ids(dashboardDataFor({ usesSelection: true, selects: 'priceBucket' }, data))).toEqual([
			3, 4
		]);
		// A widget that only uses the period never sees the selection.
		expect(dashboardDataFor({ usesPeriod: true }, data)).toBe(data.byPeriod);
		expect(ids(dashboardDataFor({ usesPeriod: true }, data))).toEqual([1, 2, 3, 4]);
		expect(dashboardDataFor({}, data)).toBe(data.all);
		data.dispose();
	});

	it('is the page state only: nothing of it is in the saved arrangement', () => {
		// No file: a preset that removed the dock (scripts/scaffold.mjs) has no saved arrangement.
		const file = fileURLToPath(new URL('./dashboardLayout.ts', import.meta.url));
		const layout = existsSync(file) ? readFileSync(file, 'utf8') : '';
		expect(layout).not.toMatch(/selection|DashboardFilter|dashboardPeriod/);
	});
});
