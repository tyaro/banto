/**
 * Demo-build annotation drawer (Issue #553, step 4): the developer-facing
 * explanations that used to sit on the screens open from a "?" button in the
 * PageHeader. Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo`
 * project); the production-build counterpart is visual/annotation-absent.spec.ts.
 *
 * The dev server hydrates late, so a click made before hydration is lost:
 * open inside `toPass()` and re-click until the dialog is there.
 */
import { expect, test, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

async function openAnnotation(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'この画面の解説' });
	await expect(async () => {
		if (!(await dialog.isVisible())) {
			await page.getByRole('button', { name: 'この画面の解説' }).click({ timeout: 2_000 });
		}
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	return dialog;
}

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('items: ? opens the drawer with the grid explanation and CSV rules', async ({ page }) => {
	await page.goto('/items');
	const dialog = await openAnnotation(page);
	await expect(dialog).toContainText('セル編集');
	await expect(dialog).toContainText('少しずつ読み込む');
	await expect(dialog).toContainText('1件でもエラーがあると全体が取り消されます');
	// The explanation is no longer printed on the page itself.
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(page.getByText('セル編集（ダブルクリック/Enter）')).toHaveCount(0);
});

test('dashboard: ? opens the drawer with the demo explanation', async ({ page }) => {
	await page.goto('/dashboard');
	const dialog = await openAnnotation(page);
	await expect(dialog).toContainText('から集計したダッシュボードです');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(page.getByText('このデモについて')).toHaveCount(0);
});

test('a page without an annotation has no ? button', async ({ page }) => {
	await page.goto('/ui-demo');
	await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'この画面の解説' })).toHaveCount(0);
});
