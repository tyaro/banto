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

async function setDensity(page: Page, density: string): Promise<void> {
	await page.evaluate((d) => {
		document.documentElement.dataset.bantoDensity = d;
	}, density);
}

/**
 * Where the rendered data rows sit: the smallest row index, the largest gap
 * between each row's top (relative to the scrolling `.rows-viewport`) and
 * `index * rowHeight`, and whether scrollTop is still within range.
 */
async function rowLayout(page: Page, rowHeight: number) {
	return page.getByRole('grid').evaluate((el, h) => {
		const bodyTop = el.querySelector('.rows-viewport')!.getBoundingClientRect().top;
		const rows = [...el.querySelectorAll('[role="row"]:has([data-cell-row])')].map((row) => {
			const index = Number(row.querySelector('[data-cell-row]')!.getAttribute('data-cell-row'));
			return { index, error: Math.abs(row.getBoundingClientRect().top - bodyTop - index * h) };
		});
		return {
			count: rows.length,
			minIndex: Math.min(...rows.map((r) => r.index)),
			maxError: Math.max(...rows.map((r) => r.error)),
			scrollInRange: el.scrollTop <= el.scrollHeight - el.clientHeight + 1
		};
	}, rowHeight);
}

test('grid stays aligned when density changes while scrolled far down', async ({ page }) => {
	await primeThemeAndAuth(page, LIGHT_STANDARD);
	await primeDensity(page, 'touch');
	await page.goto('/items');
	await expectRowHeight(page, 52);
	// Scroll to the bottom so the rendered window starts well past row 0.
	await page.getByRole('grid').evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect.poll(async () => (await rowLayout(page, 52)).minIndex).toBeGreaterThan(0);

	await setDensity(page, 'compact');
	await expectRowHeight(page, 32);
	await expect
		.poll(async () => {
			const layout = await rowLayout(page, 32);
			return layout.count > 0 && layout.maxError <= 1 && layout.scrollInRange;
		})
		.toBe(true);
});

test('an open inline editor survives a density change', async ({ page }) => {
	await primeThemeAndAuth(page, LIGHT_STANDARD);
	await page.goto('/items');
	await expectRowHeight(page, 36);
	const grid = page.getByRole('grid');
	const cell = grid.locator('[data-cell-row="0"][data-cell-field="name"]');
	await cell.dblclick();
	// `.cell-editor` is the input itself.
	const editor = grid.locator('.cell-editor');
	await expect(editor).toHaveCount(1);
	await expect(editor).toBeFocused();

	await setDensity(page, 'touch');
	await expectRowHeight(page, 52);
	await expect(editor).toHaveCount(1);
	await expect(editor).toBeFocused();
	await expect
		.poll(async () => {
			const c = await cell.boundingBox();
			const e = await editor.boundingBox();
			if (!c || !e) return false;
			return (
				e.x >= c.x - 1 &&
				e.y >= c.y - 1 &&
				e.x + e.width <= c.x + c.width + 1 &&
				e.y + e.height <= c.y + c.height + 1
			);
		})
		.toBe(true);
	await editor.press('Escape');
	await expect(editor).toHaveCount(0);
});
