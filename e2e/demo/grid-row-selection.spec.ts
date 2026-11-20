/**
 * BantoGrid row selection and bulk bar (#713) on the /ui-demo grid card, in a
 * real browser: focus stays on the grid after a press on a checkbox, Space on
 * the active cell selects, the bar appears under the grid without moving the
 * rows, and a bulk action's `clear()` hands focus back to the grid. The
 * decisions themselves are unit-tested in packages/grid-svelte.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('checkbox, Space and the bulk bar work together with the keyboard', async ({ page }) => {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-grid-date');
	const grid = card.getByRole('grid');
	const bar = card.getByRole('group', { name: '一括操作' });
	const first = card.getByRole('checkbox', { name: 'A-100を選択' });
	await expect(first).toBeVisible({ timeout: 60_000 });
	await first.scrollIntoViewIfNeeded();

	const header = card.getByRole('checkbox', { name: '一覧の3件をすべて選択' });
	await expect(header).toHaveAttribute('title', '一覧の3件をすべて選択');
	const rowTop = (await first.boundingBox())!.y;

	// The dev server hydrates late, so a click made before hydration is lost.
	await expect(async () => {
		if (!(await first.isChecked())) await first.click();
		await expect(bar).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await expect(bar).toContainText('1件を選択中');
	await expect(card.getByRole('status')).toHaveText('1件を選択中');
	// The bar sits under the grid: the row did not move under the pointer.
	expect((await first.boundingBox())!.y).toBe(rowTop);
	// Focus stayed on the grid and the pressed row is the active one.
	await expect(grid).toBeFocused();
	await expect(header).toHaveJSProperty('indeterminate', true);

	// Arrow down to the next row, Space selects it; Space again deselects.
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Space');
	await expect(card.getByRole('checkbox', { name: 'B-200を選択' })).toBeChecked();
	await expect(bar).toContainText('2件を選択中');
	await page.keyboard.press('Space');
	await expect(card.getByRole('checkbox', { name: 'B-200を選択' })).not.toBeChecked();
	await page.keyboard.press('Space');
	await expect(bar).toContainText('2件を選択中');
	// Space did not open an editor on the (editable) active cell.
	await expect(card.locator('.cell.editing')).toHaveCount(0);

	// The checkbox itself is a tab stop and takes Space natively.
	const third = card.getByRole('checkbox', { name: 'C-300を選択' });
	await third.focus();
	await page.keyboard.press('Space');
	await expect(third).toBeChecked();
	await expect(header).toBeChecked();
	await expect(bar).toContainText('3件を選択中');

	// The bulk action runs with the ids and clears: bar gone, focus on the grid.
	await bar.getByRole('button', { name: '速達にする' }).click();
	await expect(bar).toHaveCount(0);
	await expect(grid).toBeFocused();
	await expect(first).not.toBeChecked();
	await expect(card.getByRole('status')).toHaveText('選択なし');

	// Header: select all, then the clear button.
	await header.click();
	await expect(bar).toContainText('3件を選択中');
	await bar.getByRole('button', { name: '選択を解除' }).click();
	await expect(bar).toHaveCount(0);
	await expect(grid).toBeFocused();
});
