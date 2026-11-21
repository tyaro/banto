import { expect, type Page } from '@playwright/test';

/**
 * 初回セットアップ画面（空の DB の /login）で最初の管理者を作る。
 * smoke.spec.ts のシナリオ 1 と tests-add-resource が共有する（手順の二重管理を避ける）。
 * 作成後は /dashboard に着くところまで待つ。
 */
export async function createFirstAdmin(
	page: Page,
	account: { displayName: string; username: string; password: string }
): Promise<void> {
	await page.goto('/login');

	// Fresh DB -> AuthProvider.status() reports uninitialized -> the login
	// page renders the setup form, not the login form (login/+page.svelte).
	await expect(page.getByRole('heading', { name: 'Banto' })).toBeVisible();
	await expect(page.getByLabel('表示名')).toBeVisible();

	await page.getByLabel('表示名').fill(account.displayName);
	await page.getByLabel('ユーザー名').fill(account.username);
	await page.getByLabel('パスワード（8文字以上）').fill(account.password);
	await page.getByLabel('パスワード（確認）').fill(account.password);
	await page.getByRole('button', { name: 'アカウントを作成' }).click();

	await expect(page).toHaveURL(/\/dashboard$/);
}
