/**
 * Production-style build (no VITE_BANTO_DEMO): the annotation "?" button must
 * not exist, and the developer-facing explanations must not be printed on the
 * screens (Issue #553, step 4). The demo-build counterpart is
 * demo/annotation-drawer.spec.ts. Assertion-only: no screenshots.
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from './theme';

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

for (const path of ['/items', '/dashboard']) {
	test(`${path} has no annotation button and no developer notes`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByRole('main')).toBeVisible();
		await expect(page.getByRole('button', { name: 'この画面の解説' })).toHaveCount(0);
		await expect(page.getByText('セル編集（ダブルクリック/Enter）')).toHaveCount(0);
		await expect(page.getByText('このデモについて')).toHaveCount(0);
	});
}
