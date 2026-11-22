/**
 * Viewer-public mode next to real accounts (docs/design/viewer-public-plan.md
 * §3.1-8, Issue #189, ADR-0012; grants: ADR-0017).
 *
 * Runs against the THIRD `banto-serve` playwright.config.ts starts: its
 * database got an administrator from `banto-serve create-admin` before the
 * server started (so login is required, ADR-0034 §7) and public viewing is
 * seeded on (`BANTO_VIEWER_PUBLIC=1`). The sibling suite one directory up
 * covers the database with no account at all.
 *
 * One shared page in file order, like the smoke suite. What it proves, end to
 * end, on the real REST/SSE path:
 *   1. "ログイン" leads from the synthetic viewer to the login form, and the
 *      account gets the normal UI back - with public viewing still on;
 *   1a. an auth-check outage keeps the login session (it does not fall back
 *      to the viewer);
 *   2. logging out offers "閲覧のみで続ける", which re-enters the synthetic
 *      session;
 *   3. a session that ends while a list is open moves to the synthetic viewer
 *      without carrying its search/sort/highlighted row over (Issue #215/#255);
 *   4. a late identity answer for the previous session does not replace the
 *      next login.
 *
 * No `waitForTimeout`/`sleep` except the one bounded window in scenario 4.
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../../first-admin';
import { reloadAndReadIdentity } from '../../reload-identity';
import { expectCheckOutageKeepsTheSession } from '../../tests/session-check-outage';

// The account `create-admin` made before the server started. (Until v8.0.0
// the account here was named `public`, the viewer-public grant's fixed id -
// #209. That name is reserved now, ADR-0034 §4.)
const ADMIN_USERNAME = E2E_ADMIN.username;
const ADMIN_PASSWORD = E2E_ADMIN.password;

/** Issue #260 実装-3 (wiring ②): the change-of-user notice (messages/ja.json `session.ownerChanged`). */
const OWNER_CHANGED_NOTICE = '別のユーザーでログインされました';

/** The header's "ログイン" button that replaces the user menu for the synthetic viewer (Header.svelte, plan §3.1-6). */
function loginButton(page: Page) {
	return page.getByRole('banner').getByRole('button', { name: 'ログイン' });
}

test.describe.serial('Banto viewer-public mode with accounts', () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage({ reducedMotion: 'reduce' });
	});

	test.afterAll(async () => {
		await page?.close();
	});

	test('0. an unauthenticated visit enters the dashboard as the synthetic viewer', async () => {
		await page.goto('/dashboard');
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();
		await expect(loginButton(page)).toBeVisible();
	});

	test('1. "ログイン" reaches the login form; the account restores the normal UI', async () => {
		await page.goto('/dashboard');
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);

		// The login form (there is no setup form): the account `create-admin` made.
		await expect(page.getByLabel('表示名')).toHaveCount(0);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン', exact: true }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(loginButton(page)).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
		// S-93: leaving the public viewer by signing in is not "another user
		// signed in" - no change-of-user notice (audit of #260 実装-3 P2-1).
		await expect(page.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);

		// Restoring an ordinary account must keep its normal UI while
		// anonymous public viewing is enabled on the same server.
		expect(await reloadAndReadIdentity(page)).toMatchObject({
			id: ADMIN_USERNAME,
			role: 'admin',
			kind: 'account'
		});
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(loginButton(page)).toHaveCount(0);
		await page.goto('/users');
		await expect(page).toHaveURL(/\/users$/);
		await expect(page.locator('section.create')).toBeVisible();
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/settings$/);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
	});

	// Issue #204 review: with public viewing ON, an auth-check outage (500) used
	// to fall through to enterGrant('publicViewer'), replacing the login token with a
	// viewer one (and wiping a "Remember me" token). It must keep the session.
	test('1a. an auth-check outage keeps the login session instead of switching to the viewer', async () => {
		await expectCheckOutageKeepsTheSession(page, false);

		await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
		await page.getByRole('menuitem', { name: 'ログアウト' }).click();
		await expect(page).toHaveURL(/\/login$/);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByLabel('ログイン状態を保持する（30日間）').check();
		await page.getByRole('button', { name: 'ログイン', exact: true }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		await expectCheckOutageKeepsTheSession(page, true);
	});

	test('2. logging out offers "閲覧のみで続ける", which re-enters the synthetic session', async () => {
		await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
		await page.getByRole('menuitem', { name: 'ログアウト' }).click();
		await expect(page).toHaveURL(/\/login$/);

		await page.getByRole('button', { name: '閲覧のみで続ける' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();

		expect(await reloadAndReadIdentity(page)).toMatchObject({
			id: 'public',
			role: 'viewer',
			kind: 'publicViewer'
		});
		await expect(loginButton(page)).toBeVisible();
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: '設定' })).toHaveCount(0);
		await page.goto('/users');
		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	// Issue #215/#255 4th review (P2 2): with public viewing ON, a session
	// that ends while /items is open is replaced by the synthetic viewer
	// session in place - SvelteKit re-runs the loads but would keep the same
	// page component, whose GridState still held the ended session's search
	// and sort (and its highlighted row), and the viewer's next sort used to
	// save that old search back. The page must be rebuilt for the new
	// session: nothing of the old one on screen, and nothing of it restored
	// after a round trip to another screen.
	test('3. a session that ends on /items moves to the viewer without its search, sort or highlighted row', async () => {
		test.setTimeout(120_000);
		const SEARCH = '茶';
		await page.goto('/dashboard');
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン', exact: true }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();

		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		await mainNav.getByRole('link', { name: '商品' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await page.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
		const nameFilter = page.getByRole('dialog', { name: '商品名の絞り込み' });
		await nameFilter.getByPlaceholder('値を入力').fill(SEARCH);
		await nameFilter.getByRole('button', { name: '適用' }).click();
		const priceHeader = page.getByRole('grid').getByRole('columnheader', { name: '価格' });
		await priceHeader.locator('.cell-body').click();
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		// #591: the row's open button shows the record in the list's drawer;
		// its ResourceDetail records the opened row when it is created.
		const openButton = page
			.getByRole('row')
			.filter({ hasText: SEARCH })
			.first()
			.getByRole('button', { name: /^ID \d+ を開く$/ });
		const drawer = page.getByRole('dialog', { name: /^商品 ID \d+$/ });
		await expect(async () => {
			if (!(await drawer.isVisible())) await openButton.click();
			await expect(drawer).toBeVisible({ timeout: 1_000 });
		}).toPass();
		await expect(page).toHaveURL(/\/items\?id=\d+$/);
		await page.keyboard.press('Escape');
		await expect(drawer).toBeHidden();
		await expect(page).toHaveURL(/\/items$/);
		await expect(page.locator('.resource-row-last-opened')).toHaveCount(1);

		// End this account's sessions from inside the session itself: a
		// password reset (to the same value) bumps the account's auth epoch
		// (Issue #204). The stream is closed at the server's next
		// revalidation (15 s), its reconnect gets a 401, check() confirms, and
		// the guard enters the synthetic viewer session - /items is public, so
		// the tab stays on it.
		await page.evaluate(
			async ({ username, password }) => {
				const token =
					localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
				const headers = { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` };
				const list = await fetch('/api/users', { headers });
				if (!list.ok) throw new Error(`list failed: ${list.status}`);
				const body = (await list.json()) as
					{ id: number; username: string }[] | { rows: { id: number; username: string }[] };
				const rows = Array.isArray(body) ? body : body.rows;
				const self = rows.find((row) => row.username === username);
				if (!self) throw new Error('admin account not found');
				const reset = await fetch(`/api/users/${self.id}/reset-password`, {
					method: 'POST',
					headers: { ...headers, 'Content-Type': 'application/json' },
					body: JSON.stringify({ newPassword: password })
				});
				if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
			},
			{ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
		);
		await expect(loginButton(page)).toBeVisible({ timeout: 40_000 });
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();
		await expect(page).toHaveURL(/\/items$/);

		const expectNoOldSession = async () => {
			await page.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
			await expect(
				page.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
			).toHaveValue('');
			await page.keyboard.press('Escape');
			await expect(page.locator('.resource-row-last-opened')).toHaveCount(0);
			const saved = await page.evaluate(() =>
				Object.keys(sessionStorage)
					.filter((key) => key.startsWith('banto.listView.'))
					.map((key) => sessionStorage.getItem(key))
					.join('\n')
			);
			expect(saved, 'the ended session search term is not saved').not.toContain(SEARCH);
		};

		// The page on screen was rebuilt for the viewer session.
		await expect(priceHeader).toHaveAttribute('aria-sort', 'none');
		await expectNoOldSession();

		// One sort as the viewer (the kept page used to save the old search
		// along with it), then a round trip through another screen.
		await priceHeader.locator('.cell-body').click();
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		await mainNav.getByRole('link', { name: 'ダッシュボード' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await mainNav.getByRole('link', { name: '商品' }).click();
		await expect(page).toHaveURL(/\/items$/);

		// The viewer's own sort is restored; nothing of the ended session is.
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		await expectNoOldSession();
	});

	// Issue #215/#255 5th review: the guard's identity request for the
	// PREVIOUS session (here the synthetic viewer, re-checked on a client-side
	// navigation) answers only after this tab has logged in as the admin and
	// shown the admin's dashboard. That late answer must not move the session
	// back to the viewer: no "ログイン" button, no lost dashboard (a changed
	// session generation would hide the page), the admin's menu stays.
	test('4. a late identity answer for the previous session does not replace the next login', async () => {
		test.setTimeout(60_000);
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		await page.goto('/dashboard');
		await expect(loginButton(page)).toBeVisible();

		let held = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/api/auth/identity', async (route) => {
			if (held > 0) return route.continue();
			held += 1;
			// Sent now, with the viewer's token; delivered after the login.
			const response = await route.fetch();
			await gate;
			await route.fulfill({ response });
		});
		try {
			// A public viewer's guard re-runs on every navigation; its identity
			// answer is held, so the tab stays on the dashboard.
			await mainNav.getByRole('link', { name: '商品' }).click();
			await expect.poll(() => held).toBe(1);
			await loginButton(page).click();
			await expect(page).toHaveURL(/\/login$/);
			await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await page.getByRole('button', { name: 'ログイン', exact: true }).click();
			await expect(page).toHaveURL(/\/dashboard$/);
			const userMenu = page.getByRole('button', { name: 'ユーザーメニューを開く' });
			await expect(userMenu).toBeVisible();
			await expect(page.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0); // S-93

			release();
			// Same bounded exception as smoke scenario 3d: nothing visible
			// signals "the late answer was processed", and a poll would pass on
			// its first read before a wrong write could happen.
			await page.waitForTimeout(500);
			await expect(page).toHaveURL(/\/dashboard$/);
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(userMenu).toBeVisible();
			await expect(loginButton(page)).toHaveCount(0);
		} finally {
			release();
			await page.unrouteAll({ behavior: 'wait' });
		}
	});
});
