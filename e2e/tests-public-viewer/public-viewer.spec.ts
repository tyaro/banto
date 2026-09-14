/**
 * Viewer-public mode E2E (docs/viewer-public-plan.md §3.1-8, Issue #189,
 * ADR-0012).
 *
 * Runs against the SECOND `banto-serve` playwright.config.ts starts with
 * `BANTO_VIEWER_PUBLIC=1` (own port, own fresh SQLite DB - see the config's
 * doc comment for why the smoke server cannot double as this one). Like the
 * smoke suite it is one shared page in file order: scenario 1 relies on the
 * DB having ZERO users (the display-only app's setup-skipped shape), later
 * scenarios build on the admin account scenario 4 creates.
 *
 * What it proves, end to end, on the real REST/SSE path:
 *   1. an unauthenticated LAN browser lands on the dashboard as the synthetic
 *      `viewer` (no login screen, header shows "ログイン" instead of the user
 *      menu, role chip says 閲覧者);
 *   2. the screen allowlist (`NavItem.publicViewer`) holds - `/items` is
 *      visible but read-only, `/users` bounces back to the dashboard;
 *   3. the write surface stays closed - `POST /api/items` with the public
 *      token is 403;
 *   4. "ログイン" leads to the normal login/setup screen and a real account
 *      gets the normal UI back; logging out again offers "閲覧のみで続ける",
 *      which re-enters the synthetic session.
 *
 * No `waitForTimeout`/`sleep`: every wait is a locator auto-retry.
 */
import { expect, test, type Page } from '@playwright/test';

const ADMIN_USERNAME = 'e2e-pv-admin';
const ADMIN_PASSWORD = 'E2ePvAdminPass1';
const ADMIN_DISPLAY_NAME = 'E2E閲覧公開管理者';

const CLIENT_HEADER = { 'X-Banto-Client': 'banto' };

/** The header's "ログイン" button that replaces the user menu for the synthetic viewer (Header.svelte, plan §3.1-6). */
function loginButton(page: Page) {
	return page.getByRole('banner').getByRole('button', { name: 'ログイン' });
}

test.describe.serial('Banto viewer-public mode', () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage({ reducedMotion: 'reduce' });
	});

	test.afterAll(async () => {
		await page?.close();
	});

	test('1. an unauthenticated visit enters the dashboard as the synthetic viewer', async () => {
		await page.goto('/dashboard');

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		// Synthetic session: role chip 閲覧者, "ログイン" instead of the user menu.
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
	});

	test('2. items is visible read-only and the admin nav is hidden', async () => {
		await page.goto('/items');
		await expect(page).toHaveURL(/\/items$/);
		// viewer role: the grid renders, the create button does not.
		await expect(page.getByRole('grid')).toBeVisible();
		await expect(page.getByRole('button', { name: '新規作成' })).toHaveCount(0);
		// Allowlist: no admin nav, and settings is not public either.
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: '設定' })).toHaveCount(0);
	});

	test('3. a non-public screen bounces back to the first public one', async () => {
		await page.goto('/users');
		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test('4. the public token cannot write: POST /api/items is 403', async () => {
		const mint = await page.request.post('/api/auth/public-viewer', { headers: CLIENT_HEADER });
		expect(mint.ok()).toBe(true);
		const { token } = (await mint.json()) as { success: boolean; token: string };
		expect(token).toBeTruthy();

		const identity = await page.request.get('/api/auth/identity', {
			headers: { ...CLIENT_HEADER, Authorization: `Bearer ${token}` }
		});
		expect(await identity.json()).toMatchObject({ id: 'public', role: 'viewer' });

		const write = await page.request.post('/api/items', {
			headers: { ...CLIENT_HEADER, Authorization: `Bearer ${token}` },
			data: { name: 'should-not-exist', price: 1, stock: 1 }
		});
		expect(write.status()).toBe(403);
	});

	test('5. "ログイン" reaches the setup screen; a real account restores the normal UI', async () => {
		await page.goto('/dashboard');
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);

		// Zero users -> setup form (same as smoke scenario 1).
		await page.getByLabel('表示名').fill(ADMIN_DISPLAY_NAME);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード（8文字以上）').fill(ADMIN_PASSWORD);
		await page.getByLabel('パスワード（確認）').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'アカウントを作成' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(loginButton(page)).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
	});

	test('6. logging out offers "閲覧のみで続ける", which re-enters the synthetic session', async () => {
		await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
		await page.getByRole('menuitem', { name: 'ログアウト' }).click();
		await expect(page).toHaveURL(/\/login$/);

		await page.getByRole('button', { name: '閲覧のみで続ける' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();
	});
});
