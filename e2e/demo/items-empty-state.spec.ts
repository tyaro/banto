/**
 * Empty list on items (#712): a search with no match says so and offers no
 * first steps. (A list with no rows at all is covered by the add-resource spec:
 * the demo's items are never empty.) The `demo` project (`vite dev`,
 * VITE_BANTO_DEMO=1), admin role.
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('items: a search with no match shows no first-step buttons', async ({ page }) => {
	await page.goto('/items');
	await expect(page.getByRole('checkbox', { name: /を選択$/ }).first()).toBeVisible({
		timeout: 60_000
	});
	const box = page.getByPlaceholder('検索…').first();
	await expect(async () => {
		await box.fill('zzzz-no-such-item');
		await expect(page.getByText('該当するデータがありません')).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await expect(page.locator('[data-empty-action]')).toHaveCount(0);
});
