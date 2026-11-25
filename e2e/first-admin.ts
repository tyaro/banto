import { expect, type Page } from '@playwright/test';

/**
 * The administrator account of the e2e databases.
 *
 * A new database has no account and needs no login (ADR-0034 §5), and
 * `banto-serve` logs nobody in while that is so. playwright.config.ts
 * therefore creates this account with `banto-serve create-admin` BEFORE the
 * server starts (`serve-with-first-admin.mjs`, ADR-0034 §7) - the same step an
 * operator of a headless install takes - which also makes the database
 * login-required. The specs then start at the ordinary login form.
 *
 * Shared by smoke.spec.ts (scenario 1), tests-add-resource and the
 * viewer-public "with login" suite, so the steps exist once.
 */
export const E2E_ADMIN = {
	displayName: 'E2E管理者',
	username: 'e2e-admin',
	password: 'E2eAdminPass1'
} as const;

/**
 * Log in as the account `create-admin` made, from the login form, and wait
 * for the dashboard. The page is the login form from the first visit: there
 * is no first-run setup screen.
 */
export async function loginAsFirstAdmin(page: Page): Promise<void> {
	await page.goto('/login');

	await expect(page.getByRole('heading', { name: 'Banto' })).toBeVisible();
	// The login form, not an account-creation form: no display name, no
	// password confirmation.
	await expect(page.getByLabel('表示名')).toHaveCount(0);
	await expect(page.getByLabel('パスワード（確認）')).toHaveCount(0);

	await page.getByLabel('ユーザー名').fill(E2E_ADMIN.username);
	await page.getByLabel('パスワード', { exact: true }).fill(E2E_ADMIN.password);
	await page.getByRole('button', { name: 'ログイン', exact: true }).click();

	await expect(page).toHaveURL(/\/dashboard$/);
}
