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
import { DASHBOARD_ROW_LIMIT, createDashboardData } from './dashboardData.svelte';
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
