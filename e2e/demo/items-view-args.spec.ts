/**
 * Links that open an items view with arguments (#882 D1): `?view=<id>&arg.<name>=<value>`.
 *  - the list is narrowed by the link, and only `view` / `arg.*` leave the URL (`id` stays);
 *  - a link that cannot be applied changes nothing and says so;
 *  - the count on the boundary rows (price cut points, the day after `after`) is the same in the
 *    client and the server load mode and is the count the data itself gives;
 *  - a view with a required argument is not in the "Views" menu.
 * The `demo` project (vite dev, VITE_BANTO_DEMO=1): the in-memory provider answers the server mode
 * with the same filter contract as the real server (the real server's side: smoke.spec.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { generateSampleItems } from '../../apps/admin-template/src/lib/banto/sampleData';
import { chooseItemsMode } from '../items-view-mode';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(180_000);

const labels = {
	trigger: '表示',
	client: '全件を読み込む（グループ化できる）',
	server: '少しずつ読み込む（大量データ向け）'
};
const NOT_APPLICABLE = 'このリンクの絞り込みを適用できません';

const rows = generateSampleItems();
const BANDS = [
	{ id: '0-99', has: (price: number) => price <= 99 },
	{ id: '100-149', has: (price: number) => price >= 100 && price <= 149 },
	{ id: '150-199', has: (price: number) => price >= 150 && price <= 199 },
	{ id: '200-', has: (price: number) => price >= 200 }
];

/** The day after `day` (`YYYY-MM-DD`). */
function dayAfter(day: string): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
/** Low-stock rows (stock < 50) updated AFTER `day` (that day not included). */
function lowStockAfter(day: string): number {
	return rows.filter((row) => row.stock < 50 && row.updatedAt.slice(0, 10) > day).length;
}
// A day that has low-stock rows, so that "the day itself" and "the day after" count differently.
const boundaryDay = rows.find((row) => row.stock < 50)!.updatedAt.slice(0, 10);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

/** The list's row count: the grid's `aria-rowcount` (header row included). */
async function listCount(page: Page): Promise<number> {
	const grid = page.getByRole('grid').first();
	await expect(grid).toHaveAttribute('aria-rowcount', /^\d+$/);
	return Number(await grid.getAttribute('aria-rowcount')) - 1;
}

/** Open `/items` in the given load mode (the mode is remembered across the later full loads). */
async function openItems(page: Page, mode: 'client' | 'server'): Promise<void> {
	await page.goto('/items');
	await expect(page.getByRole('grid').first()).toBeVisible({ timeout: 60_000 });
	await chooseItemsMode(page, { trigger: labels.trigger, item: labels[mode] });
}

/** Follow `href` as an in-app link (the page is already open, no reload). */
async function followLink(page: Page, href: string): Promise<void> {
	await page.evaluate((target) => {
		const a = document.createElement('a');
		a.href = target;
		a.id = 'e2e-view-link';
		a.textContent = 'e2e link';
		document.body.appendChild(a);
	}, href);
	await page.locator('#e2e-view-link').click();
	await page.locator('#e2e-view-link').evaluate((el) => el.remove());
}

for (const mode of ['client', 'server'] as const) {
	test.describe(`${mode} load mode`, () => {
		test('price-band links count exactly the rows of each band (cut points included)', async ({
			page
		}) => {
			await openItems(page, mode);
			let sum = 0;
			for (const band of BANDS) {
				const expected = rows.filter((row) => band.has(row.price)).length;
				sum += expected;
				await page.goto(`/items?view=price-band&arg.band=${band.id}`);
				await expect.poll(() => listCount(page), { timeout: 30_000 }).toBe(expected);
				// The link's own parameters are gone once applied.
				await expect(page).toHaveURL(/\/items$/);
			}
			expect(sum).toBe(rows.length);
		});

		test('low-stock with after: the day itself is out, the next day is in', async ({ page }) => {
			await openItems(page, mode);
			const next = dayAfter(boundaryDay);
			expect(lowStockAfter(boundaryDay)).toBeGreaterThan(lowStockAfter(next));
			for (const day of [boundaryDay, next]) {
				await page.goto(`/items?view=low-stock&arg.after=${day}`);
				await expect.poll(() => listCount(page), { timeout: 30_000 }).toBe(lowStockAfter(day));
			}
			// Without the argument: the plain view, as before.
			await page.goto('/items?view=low-stock');
			await expect
				.poll(() => listCount(page), { timeout: 30_000 })
				.toBe(rows.filter((row) => row.stock < 50).length);
		});

		test('a link that cannot be applied keeps the current conditions and says so', async ({
			page
		}) => {
			await page.goto('/items?view=low-stock');
			await expect(page.getByRole('grid').first()).toBeVisible({ timeout: 60_000 });
			await chooseItemsMode(page, { trigger: labels.trigger, item: labels[mode] });
			const lowStock = rows.filter((row) => row.stock < 50).length;
			await expect.poll(() => listCount(page), { timeout: 30_000 }).toBe(lowStock);

			const bad = [
				'/items?view=price-band', // required argument missing
				'/items?view=price-band&arg.band=nope', // unknown value (filtersFor says null)
				'/items?view=price-band&arg.band=100-149&arg.band=150-199', // repeated
				'/items?view=price-band&arg.band=', // empty
				'/items?view=low-stock&arg.after=2026-02-31' // not a day
			];
			for (const href of bad) {
				await followLink(page, href);
				await expect(page.getByText(NOT_APPLICABLE).first()).toBeVisible();
				await expect(page).toHaveURL(/\/items$/);
				// Nothing was applied: still the low-stock list.
				expect(await listCount(page)).toBe(lowStock);
			}
		});

		test('only view and arg.* leave the URL; id stays', async ({ page }) => {
			await openItems(page, mode);
			await page.goto('/items?id=1&view=price-band&arg.band=100-149');
			await expect(page).toHaveURL(/\/items\?id=1$/, { timeout: 30_000 });
		});
	});
}

test('a view with a required argument is not in the Views menu', async ({ page }) => {
	await page.goto('/items');
	await expect(page.getByRole('grid').first()).toBeVisible({ timeout: 60_000 });
	const trigger = page.getByRole('button', { name: 'ビュー', exact: true });
	const lowStock = page.getByRole('menuitemradio', { name: '在庫僅少（50未満）', exact: true });
	await expect(async () => {
		if (!(await lowStock.isVisible())) await trigger.click();
		await expect(lowStock).toBeVisible({ timeout: 1000 });
	}).toPass();
	await expect(page.getByRole('menuitemradio', { name: '価格帯', exact: true })).toHaveCount(0);
	await expect(page.getByRole('menuitem', { name: '価格帯', exact: true })).toHaveCount(0);
});
