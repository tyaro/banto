/**
 * The grid's row height follows the theme density (`--banto-grid-row-height`:
 * standard 36 / compact 32 / touch 52 px). Measurement only - no screenshots.
 */
import { expect, test, type Page } from '@playwright/test';
import { primeDensity, primeThemeAndAuth } from './theme';

const LIGHT_STANDARD = { theme: 'light', preset: 'standard' } as const;

/** Heights (px) of the rendered data rows, i.e. the `role="row"` elements that hold gridcells. */
async function dataRowHeights(page: Page): Promise<number[]> {
	return page
		.getByRole('grid')
		.locator('[role="row"]:has([data-cell-row])')
		.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
}

async function expectRowHeight(page: Page, expected: number): Promise<void> {
	await expect
		.poll(async () => {
			const heights = await dataRowHeights(page);
			return heights.length > 0 && heights.every((h) => h === expected) ? expected : heights;
		})
		.toBe(expected);
}

for (const [density, height] of [
	['standard', 36],
	['compact', 32],
	['touch', 52]
] as const) {
	test(`grid rows are ${height}px under ${density} density`, async ({ page }) => {
		await primeThemeAndAuth(page, LIGHT_STANDARD);
		await primeDensity(page, density);
		await page.goto('/items');
		await expect(page.getByRole('grid')).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('data-banto-density', density);
		await expectRowHeight(page, height);
	});
}

test('grid rows follow a density change while displayed', async ({ page }) => {
	await primeThemeAndAuth(page, LIGHT_STANDARD);
	await page.goto('/items');
	await expectRowHeight(page, 36);
	await page.evaluate(() => {
		document.documentElement.dataset.bantoDensity = 'touch';
	});
	await expectRowHeight(page, 52);
	await page.evaluate(() => {
		document.documentElement.dataset.bantoDensity = 'compact';
	});
	await expectRowHeight(page, 32);
});
