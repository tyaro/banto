/**
 * Shared scenario for Issue #204's review: `/api/auth/check` failing (a 500 -
 * the server could not verify the account) must NOT look like a logout. Used
 * by the smoke suite (public viewing OFF) and the viewer-public suite (ON).
 *
 * Not a `*.spec.ts`: Playwright only collects spec files, so this module is
 * imported by both suites rather than run on its own.
 */
import { expect, type Page, type Route } from '@playwright/test';

const TOKEN_KEY = 'banto.auth.token';

async function storedTokens(page: Page): Promise<{ local: string | null; session: string | null }> {
	return page.evaluate((key) => {
		return { local: localStorage.getItem(key), session: sessionStorage.getItem(key) };
	}, TOKEN_KEY);
}

async function checkOutage(route: Route): Promise<void> {
	await route.fulfill({
		status: 500,
		contentType: 'application/json',
		body: JSON.stringify({ kind: 'storage', message: 'database is locked' })
	});
}

/**
 * With a logged-in page (a `remember` token in localStorage, otherwise in
 * sessionStorage), make ONLY `/api/auth/check` fail and navigate to a guarded
 * screen: the guard must show the retry page on that URL - no redirect to
 * /login, no switch to a public viewer session, no token cleared or replaced.
 * Once the check recovers, "再試行" resumes the SAME session.
 */
export async function expectCheckOutageKeepsTheSession(page: Page, remember: boolean) {
	const before = await storedTokens(page);
	expect(remember ? before.local : before.session, 'a stored login token').toBeTruthy();

	await page.route('**/api/auth/check', checkOutage);
	await page.goto('/items');
	await expect(page.getByText('ログイン状態を確認できませんでした')).toBeVisible();
	await expect(page).toHaveURL(/\/items$/);
	expect(await storedTokens(page), 'the token is neither cleared nor replaced').toEqual(before);

	await page.unroute('**/api/auth/check', checkOutage);
	await page.getByRole('button', { name: '再試行' }).click();
	await expect(page).toHaveURL(/\/items$/);
	await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
	expect(await storedTokens(page), 'the original session resumed').toEqual(before);
}
