/**
 * #1036: the grid's header row is `position: sticky; top: 0`. It does not
 * scroll away: it covers the top of the grid, and a row scrolled under it is
 * out of sight. jsdom has no layout, so only a real browser shows that
 *
 * - an action key (Enter) on an active cell wholly behind the header only
 *   brings it out; the next press acts,
 * - a move to the row above (ArrowUp) shows that row under the header, not
 *   behind it,
 * - a held key (real auto-repeat keydowns) does not act until it is pressed anew.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

const prefix = '/__grid-sticky-header-fixture/';
const requireGrid = createRequire(
	new URL('../../packages/grid-svelte/package.json', import.meta.url)
);
const themeCss = readFileSync(
	new URL('../../packages/theme/src/css/banto.css', import.meta.url),
	'utf8'
).replace(
	"@import './banto-glass.css';",
	readFileSync(new URL('../../packages/theme/src/css/banto-glass.css', import.meta.url), 'utf8')
);
let bundleDir: string;

test.beforeAll(async () => {
	bundleDir = mkdtempSync(path.join(tmpdir(), 'banto-grid-sticky-header-'));
	// Use the grid's existing dev dependency, without adding a root/runtime dependency.
	const { build } = await import(pathToFileURL(requireGrid.resolve('vite')).href);
	await build({
		configFile: fileURLToPath(
			new URL(
				'../../packages/grid-svelte/tests/browser/sticky-header/vite.config.mjs',
				import.meta.url
			)
		),
		build: { outDir: bundleDir, emptyOutDir: true },
		logLevel: 'warn'
	});
});
test.afterAll(() => {
	if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

async function start(page: Page) {
	await page.route(`**${prefix}**`, async (route) => {
		const relative =
			decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length)) ||
			'index.html';
		const filename = path.resolve(bundleDir, relative);
		if (!filename.startsWith(`${bundleDir}${path.sep}`)) return route.abort();
		await route.fulfill({
			path: filename,
			contentType: filename.endsWith('.js')
				? 'application/javascript'
				: filename.endsWith('.css')
					? 'text/css'
					: 'text/html'
		});
	});
	await page.goto(prefix);
	await page.addStyleTag({ content: themeCss });
	const grid = page.getByRole('grid');
	await expect(grid).toBeVisible();
	const header = grid.locator('.header-row');
	const cell = (row: number) => grid.locator(`[data-cell-row="${row}"][data-cell-field="name"]`);
	const headerHeight = (await header.boundingBox())!.height;
	// The row, not the cell: the row is taller by its border.
	const rowHeight = (await cell(0).locator('xpath=..').boundingBox())!.height;
	// The case under test needs a row that fits behind the header.
	expect(rowHeight).toBeLessThanOrEqual(headerHeight);
	return {
		grid,
		header,
		cell,
		rowHeight,
		opened: page.getByTestId('opened'),
		status: grid.locator('xpath=..').locator('[role="status"]'),
		scrollTo: async (top: number) => {
			await grid.evaluate((el, value) => {
				el.scrollTop = value;
			}, top);
			await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(top);
		}
	};
}

/** Screen position of `target` against the bottom edge of the sticky header. */
async function belowHeader(header: Locator, target: Locator) {
	const headerBox = (await header.boundingBox())!;
	const box = (await target.boundingBox())!;
	return {
		top: box.y - (headerBox.y + headerBox.height),
		bottom: box.y + box.height - (headerBox.y + headerBox.height)
	};
}

test('Enter on a cell wholly behind the sticky header only shows it; the next Enter opens the row', async ({
	page
}) => {
	const { grid, header, cell, rowHeight, opened, status, scrollTo } = await start(page);
	// A click opens the row as well: count from here.
	await cell(0).click();
	await expect(opened).toHaveText('1');
	await expect(grid).toBeFocused();

	// Scrolled by one row, less than the header's height: row 0 is in the DOM
	// and inside the grid's box, but all of it is behind the header.
	await scrollTo(rowHeight);
	expect((await belowHeader(header, cell(0))).bottom).toBeLessThanOrEqual(0.5);

	await page.keyboard.press('Enter');
	await expect
		.poll(async () => (await belowHeader(header, cell(0))).top)
		.toBeGreaterThanOrEqual(-0.5);
	await expect(opened).toHaveText('1');
	await expect(status).not.toHaveText('');
	await expect(cell(0)).toHaveClass(/active/);

	await page.keyboard.press('Enter');
	await expect(opened).toHaveText('1,1');
});

test('Enter acts at once while a part of the row shows under the header', async ({ page }) => {
	const { header, cell, rowHeight, opened, scrollTo } = await start(page);
	await cell(0).click();
	await expect(opened).toHaveText('1');
	await scrollTo(rowHeight - 6);
	const edge = await belowHeader(header, cell(0));
	expect(edge.top).toBeLessThan(0);
	expect(edge.bottom).toBeGreaterThan(0);

	await page.keyboard.press('Enter');
	await expect(opened).toHaveText('1,1');
});

test('ArrowUp to the row above shows it under the header, not behind it', async ({ page }) => {
	const { header, cell, rowHeight, scrollTo } = await start(page);
	await cell(6).click();
	// Row 6 is the first row under the header; row 5 is behind it.
	await scrollTo(6 * rowHeight);
	expect((await belowHeader(header, cell(5))).bottom).toBeLessThanOrEqual(0.5);

	await page.keyboard.press('ArrowUp');
	await expect(cell(5)).toHaveClass(/active/);
	await expect
		.poll(async () => (await belowHeader(header, cell(5))).top)
		.toBeGreaterThanOrEqual(-0.5);
});

test('holding Enter down does not open the row; the next press does', async ({ page }) => {
	const { header, cell, rowHeight, opened, scrollTo } = await start(page);
	await cell(0).click();
	await expect(opened).toHaveText('1');
	await scrollTo(rowHeight);

	// A second `down` of a key that is already down is an auto-repeat keydown.
	await page.keyboard.down('Enter');
	await expect
		.poll(async () => (await belowHeader(header, cell(0))).top)
		.toBeGreaterThanOrEqual(-0.5);
	await page.keyboard.down('Enter');
	await page.keyboard.down('Enter');
	await expect(opened).toHaveText('1');
	await page.keyboard.up('Enter');
	await expect(opened).toHaveText('1');

	await page.keyboard.press('Enter');
	await expect(opened).toHaveText('1,1');
});
