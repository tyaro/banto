/**
 * Demo build: the users and audit-log screens show read-only sample data
 * instead of an "unavailable" dead end (Issue #712, conventions §10); writes
 * are refused by the provider with the demo message. Runs against `vite dev`
 * with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('users: sample users are listed and creating one is refused', async ({ page }) => {
	await page.goto('/users');
	await expect(page.getByText('デモの見本データです。ユーザーの追加')).toBeVisible({
		timeout: 60_000
	});
	await expect(page.getByText('sato', { exact: true }).first()).toBeVisible();

	const create = page.locator('section.create');
	await create.getByLabel('ユーザー名').fill('newuser');
	await create.getByLabel('パスワード（8文字以上）').fill('password123');
	await create.getByLabel('表示名').fill('New User');
	await create.getByRole('button', { name: '作成' }).click();
	await expect(page.getByText('デモモードでは利用できません')).toBeVisible();
});

test('audit-log: sample rows are listed read-only', async ({ page }) => {
	await page.goto('/audit-log');
	await expect(page.getByText('デモの見本データです。この画面は読み取り専用')).toBeVisible({
		timeout: 60_000
	});
	await expect(page.getByTestId('audit-count-note')).toContainText(/40\s*件/);
});
