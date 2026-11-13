/** Applied filters show as chips above the grid; x removes one and the rows come back (#555 B-2). */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	test(`a filter chip appears, x removes it and the rows return (${locale})`, async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
		await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
		await page.goto('/items');
		const grid = page.getByRole('grid');
		const chips = page.getByRole('group', { name: copy['grid.filterChipsLabel'], exact: true });
		await expect(chips).toHaveCount(0);

		const header = copy['items.fieldName'];
		const label = copy['grid.filterAriaLabel'].replace('{header}', header);
		const trigger = grid.getByRole('button', { name: label, exact: true });
		const dialog = grid.getByRole('dialog', { name: label, exact: true });
		const value = dialog.getByRole('textbox', { name: copy['grid.filterValueLabel'], exact: true });
		const original = (
			await grid.locator('[data-cell-row="0"][data-cell-field="name"]').innerText()
		).trim();
		const rowsBefore = await grid.locator('[data-cell-field="name"]').count();

		// Hydration may not have finished: a key press before it does nothing.
		await expect(async () => {
			if (!(await value.isVisible())) await trigger.click();
			await value.fill(original, { timeout: 1000 });
		}).toPass();
		await value.press('Enter');

		await expect(chips).toBeVisible();
		await expect(chips).toContainText(header);
		await expect(chips).toContainText(original);
		const remove = chips.getByRole('button', {
			name: copy['grid.filterChipRemove'].replace('{header}', header),
			exact: true
		});
		await remove.focus();
		await remove.press('Enter');
		await expect(chips).toHaveCount(0);
		await expect(grid.locator('[data-cell-field="name"]')).toHaveCount(rowsBefore);
		await expect(grid).toBeFocused();
	});
}
