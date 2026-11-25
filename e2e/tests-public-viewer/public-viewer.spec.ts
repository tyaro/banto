/**
 * Viewer-public mode E2E (docs/design/viewer-public-plan.md §3.1-8, Issue #189,
 * ADR-0012). The synthetic viewer session is the `publicViewer` grant
 * (`POST /api/auth/grant/publicViewer`, ADR-0017).
 *
 * Runs against the SECOND `banto-serve` playwright.config.ts starts with
 * `BANTO_VIEWER_PUBLIC=1` (own port, own fresh SQLite DB - see the config's
 * doc comment for why the smoke server cannot double as this one). Like the
 * smoke suite it is one shared page in file order.
 *
 * The database has ZERO accounts from the first scenario to the last, and
 * stays in no-login mode (a new database's default, ADR-0034 §5 - the
 * display-only app's shape): the server listens only because public viewing
 * is on, serves it read-only, and logs nobody in (§6). The scenarios that log
 * in next to public viewing are in `with-login/` (their own server, whose
 * database got an administrator from `banto-serve create-admin`).
 *
 * What it proves, end to end, on the real REST/SSE path:
 *   1. an unauthenticated LAN browser lands on the dashboard as the synthetic
 *      `viewer` (no login screen, header shows "ログイン" instead of the user
 *      menu, role chip says 閲覧者);
 *   2. the screen allowlist (`NavItem.publicViewer`) holds - `/items` is
 *      visible but read-only, `/users` bounces back to the dashboard;
 *   2a. a public screen opened while the server is unreachable shows the
 *      startup splash with 再接続, then enters as the viewer (Issue #321);
 *   3. the write surface stays closed - `POST /api/items` with the public
 *      token is 403;
 *   4. "ログイン" leads to the login form, where nobody can log in and no
 *      account can be created: there is no setup form and no setup route, and
 *      the database still has no account afterwards;
 *   5. the viewer may save its own UI settings (a display preference, not
 *      business data).
 *
 * No `waitForTimeout`/`sleep`: every wait is a locator auto-retry.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { E2E_ADMIN } from '../first-admin';

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

		// The Ctrl+K palette follows the same allowlist (navSections()): it lists
		// the public screen but not the ones the route guard would bounce.
		await page.keyboard.press('Control+K');
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		await expect(palette).toBeVisible();
		await expect(palette.getByText('ダッシュボード', { exact: true })).toBeVisible();
		await expect(palette.getByText('ツリービュー', { exact: true })).toHaveCount(0);
		await expect(palette.getByText('設定', { exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(palette).toHaveCount(0);
	});

	// Issue #321: a wall monitor opening its screen while the server is
	// unreachable (power-on order, a restart). The splash offers 再接続 on that
	// URL - never the demo (#286), never a blank page - and once the server is
	// back the reconnect enters the synthetic viewer on the same screen. Own
	// page: no stored token, like the monitor's first visit.
	test('2a. a public screen opened while the server is unreachable offers reconnect, then enters as the viewer', async ({
		browser
	}) => {
		const monitor = await browser.newPage({ reducedMotion: 'reduce' });
		try {
			const serverDown = (route: Route) => route.abort('connectionrefused');
			await monitor.route('**/api/**', serverDown);
			await monitor.goto('/items');
			await expect(monitor.getByRole('status')).toHaveText('起動中…');
			// 3 probes 1.5 s apart (STARTUP_AUTO_RETRIES) before the screen appears.
			await expect(monitor.getByRole('alert')).toContainText('サーバーに接続できません', {
				timeout: 15_000
			});
			await expect(monitor).toHaveURL(/\/items$/);
			await monitor.unroute('**/api/**', serverDown);

			await monitor.getByRole('alert').getByRole('button', { name: '再接続' }).click();
			await expect(monitor).toHaveURL(/\/items$/);
			await expect(monitor.getByRole('grid')).toBeVisible();
			await expect(monitor.getByRole('banner').getByText('閲覧者')).toBeVisible();
			await expect(loginButton(monitor)).toBeVisible();
		} finally {
			await monitor.close();
		}
	});

	// nav-launcher-plan.md §4.9/§7.2: the dock shows the same allowlist as the
	// sidebar. Own page with the dock chosen: the local cache is primed and the
	// stored setting is answered as 'launcher' (a read with nothing stored
	// resets the layout to the sidebar, §3).
	test('2b. with the dock layout, only the allowlisted entries appear in the dock', async ({
		browser
	}) => {
		const monitor = await browser.newPage({ reducedMotion: 'reduce' });
		try {
			await monitor.addInitScript(() => {
				window.localStorage.setItem('banto.navLayout', 'launcher');
			});
			await monitor.route('**/api/ui-settings/shell.navLayout', (route) =>
				route.request().method() === 'GET'
					? route.fulfill({ json: { value: 'launcher', revision: 'e2e' } })
					: route.continue()
			);
			await monitor.goto('/dashboard');
			await expect(monitor.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(monitor.locator('.launcher')).toBeVisible();
			await expect(monitor.locator('aside')).toHaveCount(0);

			const nav = monitor.getByRole('navigation', { name: '主要ナビゲーション' });
			await expect(nav.getByRole('link')).toHaveCount(2);
			await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toBeVisible();
			await expect(nav.getByRole('link', { name: '商品' })).toBeVisible();
			await expect(monitor.getByRole('navigation', { name: '管理ナビゲーション' })).toHaveCount(0);
			await expect(monitor.getByRole('link', { name: '設定' })).toHaveCount(0);
		} finally {
			await monitor.close();
		}
	});

	test('3. a non-public screen bounces back to the first public one', async () => {
		await page.goto('/users');
		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test('4. the public token cannot write: POST /api/items is 403', async () => {
		const mint = await page.request.post('/api/auth/grant/publicViewer', {
			headers: CLIENT_HEADER
		});
		expect(mint.ok()).toBe(true);
		const { token } = (await mint.json()) as { success: boolean; token: string };
		expect(token).toBeTruthy();

		const identity = await page.request.get('/api/auth/identity', {
			headers: { ...CLIENT_HEADER, Authorization: `Bearer ${token}` }
		});
		expect(identity.ok()).toBe(true);
		expect(await identity.json()).toMatchObject({
			id: 'public',
			role: 'viewer',
			kind: 'publicViewer'
		});

		const write = await page.request.post('/api/items', {
			headers: { ...CLIENT_HEADER, Authorization: `Bearer ${token}` },
			data: { name: 'should-not-exist', price: 1, stock: 1 }
		});
		expect(write.status()).toBe(403);
	});

	test('5. "ログイン" reaches the login form, but nobody logs in and no account can be created', async () => {
		await page.goto('/dashboard');
		await loginButton(page).click();
		await expect(page).toHaveURL(/\/login$/);

		// The login form - there is no first-run setup form any more.
		await expect(page.getByLabel('表示名')).toHaveCount(0);
		await expect(page.getByLabel('パスワード（確認）')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'アカウントを作成' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: '閲覧のみで続ける' })).toBeVisible();

		// No account exists, and none logs in while the server needs no login.
		await page.getByLabel('ユーザー名').fill(E2E_ADMIN.username);
		await page.getByLabel('パスワード', { exact: true }).fill(E2E_ADMIN.password);
		await page.getByRole('button', { name: 'ログイン', exact: true }).click();
		await expect(page.locator('form').getByRole('alert')).toContainText('ログイン不要モード');
		await expect(page).toHaveURL(/\/login$/);

		// Over REST: the login is refused, and the setup route is gone.
		const login = await page.request.post('/api/auth/login', {
			headers: CLIENT_HEADER,
			data: { username: E2E_ADMIN.username, password: E2E_ADMIN.password }
		});
		expect(await login.json()).toMatchObject({ success: false });
		const setup = await page.request.post('/api/auth/setup', {
			headers: CLIENT_HEADER,
			data: {
				username: E2E_ADMIN.username,
				password: E2E_ADMIN.password,
				displayName: E2E_ADMIN.displayName
			}
		});
		expect(setup.ok()).toBe(false);
		// Still no account: the same login is refused again.
		const again = await page.request.post('/api/auth/login', {
			headers: CLIENT_HEADER,
			data: { username: E2E_ADMIN.username, password: E2E_ADMIN.password }
		});
		expect(await again.json()).toMatchObject({ success: false });

		// Back into the synthetic session.
		await page.getByRole('button', { name: '閲覧のみで続ける' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(loginButton(page)).toBeVisible();
	});

	test('6. the viewer may save its own UI settings, and still cannot write business or admin data', async () => {
		const mint = await page.request.post('/api/auth/grant/publicViewer', {
			headers: CLIENT_HEADER
		});
		const { token } = (await mint.json()) as { token: string };
		const auth = { ...CLIENT_HEADER, Authorization: `Bearer ${token}` };

		const put = await page.request.put('/api/ui-settings/theme', {
			headers: auth,
			data: { value: 'dark' }
		});
		expect(put.ok()).toBe(true);
		const got = await page.request.get('/api/ui-settings/theme', { headers: auth });
		expect(await got.json()).toMatchObject({ value: 'dark' });

		const user = await page.request.post('/api/users', {
			headers: auth,
			data: { username: 'intruder', password: 'IntruderPass1', displayName: 'x', role: 'admin' }
		});
		expect(user.status()).toBe(403);
		const users = await page.request.post('/api/users/list', { headers: auth, data: {} });
		expect(users.status()).toBe(403);
	});
});
