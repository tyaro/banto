/**
 * app.html's static "loading" line (Issue #1024) exists only so a screen reader never meets an
 * empty document (NVDA then reads the URL). Once the app is drawn it must be gone, in the main
 * window's pages and in the pop-out panel window's page alike. No pixels.
 */
import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

for (const path of ['/dashboard', '/panel/monthly']) {
	test(`the static loading line does not remain once drawn (${path})`, async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await page.goto(path);
		await expect(
			page.locator('main, [data-dock-host], header, [role="banner"]').first()
		).toBeVisible();
		await expect(page.locator('#banto-boot-status')).toHaveCount(0);
		await expect(page.getByText(/^(読み込み中|Loading)$/)).toHaveCount(0);
	});
}

test('the static loading line follows the locale before the app draws', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('banto.locale', 'en'));
	await page.route('**/*.js', (route) => route.abort());
	await page.goto('/dashboard');
	await expect(page.locator('#banto-boot-status')).toHaveText('Loading');
});
