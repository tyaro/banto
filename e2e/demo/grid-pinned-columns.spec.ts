/**
 * BantoGrid pinned columns (#713) on the /ui-demo grid card, in a real
 * browser: on a narrow window the checkbox column and the pinned code column
 * stay at the left edge while the other columns scroll under them, and the
 * boundary shadow is there only while the grid is scrolled sideways. The
 * decisions themselves are unit-tested in packages/grid-svelte.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	// Narrow enough that the grid's columns do not fit its card.
	await page.setViewportSize({ width: 620, height: 900 });
});

test('the pinned column stays in place and the shadow follows the scroll', async ({ page }) => {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-grid-date');
	const grid = card.getByRole('grid');
	const pinnedCell = card.getByRole('gridcell', { name: 'A-100', exact: true });
	await expect(pinnedCell).toBeVisible({ timeout: 60_000 });
	await pinnedCell.scrollIntoViewIfNeeded();

	const pinnedHeader = card.getByRole('columnheader').nth(1);
	const checkbox = card.getByRole('checkbox', { name: 'A-100を選択' });
	const scrolledCell = card.locator('[data-cell-row="0"][data-cell-field="due"]');

	// The grid really scrolls sideways at this width.
	expect(await grid.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
	await expect(pinnedCell).toHaveCSS('position', 'sticky');
	await expect(pinnedHeader).toHaveCSS('position', 'sticky');
	await expect(pinnedCell).toHaveCSS('box-shadow', 'none');
	await expect(pinnedHeader).toHaveCSS('box-shadow', 'none');

	const cellX = (await pinnedCell.boundingBox())!.x;
	const headerX = (await pinnedHeader.boundingBox())!.x;
	const checkboxX = (await checkbox.boundingBox())!.x;
	const scrolledX = (await scrolledCell.boundingBox())!.x;

	await grid.evaluate((el) => {
		el.scrollLeft = 120;
	});
	await expect(grid).toHaveClass(/scrolled-x/);
	await expect(pinnedCell).not.toHaveCSS('box-shadow', 'none');
	await expect(pinnedHeader).not.toHaveCSS('box-shadow', 'none');

	// The pinned block did not move; the next column went 120px under it.
	expect((await pinnedCell.boundingBox())!.x).toBe(cellX);
	expect((await pinnedHeader.boundingBox())!.x).toBe(headerX);
	expect((await checkbox.boundingBox())!.x).toBe(checkboxX);
	expect((await scrolledCell.boundingBox())!.x).toBe(scrolledX - 120);
	// What is under the pinned cell is covered: the pinned cell is on top there.
	const box = (await pinnedCell.boundingBox())!;
	const topField = await page.evaluate(
		([x, y]) =>
			document
				.elementFromPoint(x, y)
				?.closest('[data-cell-field]')
				?.getAttribute('data-cell-field'),
		[box.x + box.width - 4, box.y + box.height / 2]
	);
	expect(topField).toBe('code');

	// Back at the left edge the shadow goes away.
	await grid.evaluate((el) => {
		el.scrollLeft = 0;
	});
	await expect(grid).not.toHaveClass(/scrolled-x/);
	await expect(pinnedCell).toHaveCSS('box-shadow', 'none');
});

test('a keyboard move does not leave the active cell under the pinned block', async ({ page }) => {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-grid-date');
	const grid = card.getByRole('grid');
	const pinnedCell = card.getByRole('gridcell', { name: 'A-100', exact: true });
	await expect(pinnedCell).toBeVisible({ timeout: 60_000 });
	await pinnedCell.scrollIntoViewIfNeeded();

	// The dev server hydrates late, so a press made before hydration is lost.
	await expect(async () => {
		await pinnedCell.click();
		await expect(card.locator('.cell.active')).toHaveAttribute('data-cell-field', 'code', {
			timeout: 2_000
		});
	}).toPass({ timeout: 60_000 });

	// To the last column and back: every step keeps the active cell in view,
	// right of the pinned block.
	await grid.press('End');
	await expect(card.locator('.cell.active')).toHaveAttribute('data-cell-field', 'express');
	expect(await grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
	const pinnedBox = (await pinnedCell.boundingBox())!;
	for (const field of ['progress', 'state', 'shippedAt', 'due']) {
		await grid.press('ArrowLeft');
		const active = card.locator('.cell.active');
		await expect(active).toHaveAttribute('data-cell-field', field);
		const activeBox = (await active.boundingBox())!;
		expect(activeBox.x).toBeGreaterThanOrEqual(pinnedBox.x + pinnedBox.width - 0.5);
	}
	// Onto the pinned column itself: nothing scrolls.
	const before = await grid.evaluate((el) => el.scrollLeft);
	await grid.press('ArrowLeft');
	await expect(card.locator('.cell.active')).toHaveAttribute('data-cell-field', 'code');
	expect(await grid.evaluate((el) => el.scrollLeft)).toBe(before);
});
