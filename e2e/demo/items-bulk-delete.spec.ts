/**
 * Bulk delete on the items list (#713): select two rows, confirm, and they
 * are gone. The list sends ONE `DataProvider.deleteMany` request; in the demo
 * build that is the in-memory provider's (same all-or-nothing contract as the
 * server), admin role - the `demo` project (`vite dev`, VITE_BANTO_DEMO=1).
 * "Select all matching" is server mode only; its flow is covered by
 * `lib/resource/bulkDelete.test.ts`.
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('items: two selected rows are deleted from the bulk bar after a confirmation', async ({
	page
}) => {
	await page.goto('/items');
	// Row checkboxes are named "<row>を選択"; the header one is "...をすべて選択".
	const rowBoxes = page.getByRole('checkbox', { name: /を選択$/ });
	await expect(rowBoxes.first()).toBeVisible({ timeout: 60_000 });
	const firstName = (await rowBoxes.nth(0).getAttribute('aria-label')) ?? '';
	const secondName = (await rowBoxes.nth(1).getAttribute('aria-label')) ?? '';
	expect(firstName).not.toBe('');
	expect(secondName).not.toBe(firstName);

	const bar = page.getByRole('group', { name: '一括操作' });
	// The dev server hydrates late, so a click made before hydration is lost.
	await expect(async () => {
		if (!(await rowBoxes.nth(0).isChecked())) await rowBoxes.nth(0).click();
		await expect(bar).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await rowBoxes.nth(1).click();
	await expect(bar).toContainText('2件を選択中');

	await bar.getByRole('button', { name: '2件を削除' }).click();
	const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
	await expect(dialog.getByText('選んだ2件を削除しますか？')).toBeVisible();
	await dialog.getByRole('button', { name: '削除', exact: true }).click();

	await expect(page.getByText('2件を削除しました')).toBeVisible();
	await expect(bar).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: firstName, exact: true })).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: secondName, exact: true })).toHaveCount(0);
});
