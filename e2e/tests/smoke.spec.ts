/**
 * M18 Phase B smoke E2E (docs/roadmap.md M18, docs/improvements.md §4).
 *
 * Runs against a real `banto-serve --features embed-ui` (LAN/REST mode, no
 * mocked DataProvider - see playwright.config.ts's doc comment) with a
 * brand-new SQLite database, so scenario 1 legitimately hits the first-run
 * setup screen. All ten scenarios share ONE browser page/session and run in
 * file order (`describe.serial` + `workers: 1`, config-wide): later
 * scenarios rely on state earlier ones created (the admin account, the
 * item, the viewer account, the audit trail, ...), the same way a person
 * clicking through the app once would. This is intentionally NOT a
 * from-scratch-state-per-test suite - keep new scenarios in this ordering
 * discipline rather than trying to make them independent.
 *
 * Deliberately scoped to a smoke pass (one scenario per screen, ~10 tests
 * total, per roadmap M18's non-scope note) - not exhaustive coverage of any
 * one feature (M14 audit log, M15 CSV, M16 command palette, M17 backups
 * already have their own focused unit/integration tests elsewhere).
 *
 * Flakiness: no explicit `waitForTimeout`/`sleep` anywhere in this file -
 * every wait is either Playwright's built-in locator auto-retry
 * (`expect(locator)...`) or a real event (`page.waitForEvent('download')`,
 * `page.once('dialog', ...)`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';

const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'E2eAdminPass1';
const ADMIN_DISPLAY_NAME = 'E2E管理者';

const VIEWER_USERNAME = 'e2e-viewer';
const VIEWER_PASSWORD = 'E2eViewerPass1';
const VIEWER_DISPLAY_NAME = 'E2E閲覧者';

// Timestamped so a stray leftover row from an interrupted previous run (this
// suite always starts from a fresh DB, so that shouldn't happen, but the
// name doubling as the grid-filter needle makes it worth being paranoid)
// can never collide with the row this run creates.
const ITEM_NAME = `E2Eテスト商品-${Date.now()}`;
const ITEM_PRICE = 1200;
const ITEM_PRICE_UPDATED = 1500;
const ITEM_STOCK = 10;

/** Open a filterable column's header filter and apply a "contains" filter (the default op) with `value`. Mirrors a user clicking the ▾ icon, typing, and clicking 適用 (FilterPopover.svelte). */
async function applyColumnFilter(page: Page, columnHeader: string, value: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label }).click();
	const dialog = page.getByRole('dialog', { name: label });
	await dialog.getByPlaceholder('値を入力').fill(value);
	await dialog.getByRole('button', { name: '適用' }).click();
}

/** Reopen a column's filter and clear it (クリア), leaving the grid unfiltered on that column. */
async function clearColumnFilter(page: Page, columnHeader: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label }).click();
	await page.getByRole('dialog', { name: label }).getByRole('button', { name: 'クリア' }).click();
}

/** A grid data row (role="row") whose rendered text contains `text` - matches both the header row and data rows structurally, so callers should pass text unique to a data row. */
function rowWithText(page: Page, text: string): Locator {
	return page.getByRole('row').filter({ hasText: text });
}

/** Opens the header's user menu and clicks "ログアウト" (Header.svelte moved logout off a bare header button into the shared Menu component - visual-refresh-design.md §8.2). */
async function logout(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
	await page.getByRole('menuitem', { name: 'ログアウト' }).click();
}

test.describe.serial('Banto LAN/REST smoke', () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		// This manually-created shared page bypasses the config's `use`
		// context options, so reduced motion must be passed here explicitly.
		// Without it, View Transitions (visual-refresh-design.md §11.1) freeze
		// the OLD page's snapshot for the crossfade after each navigation and
		// locators can pin an element from the outgoing page (e.g. getByLabel
		// substring-matching a grid filter button right after goto /items/new).
		page = await browser.newPage({ reducedMotion: 'reduce' });
	});

	test.afterAll(async () => {
		await page.close();
	});

	test('1. first-run setup creates the admin account and reaches the dashboard', async () => {
		await page.goto('/login');

		// Fresh DB -> AuthProvider.status() reports uninitialized -> the login
		// page renders the setup form, not the login form (login/+page.svelte).
		await expect(page.getByRole('heading', { name: 'Banto' })).toBeVisible();
		await expect(page.getByLabel('表示名')).toBeVisible();

		await page.getByLabel('表示名').fill(ADMIN_DISPLAY_NAME);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード（8文字以上）').fill(ADMIN_PASSWORD);
		await page.getByLabel('パスワード（確認）').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'アカウントを作成' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
	});

	test('2. logout returns to the login screen, then login restores the session', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test('3. items: create, appears in the grid, edit, delete', async () => {
		await page.goto('/items');
		await page.getByRole('button', { name: '新規作成' }).click();
		await expect(page).toHaveURL(/\/items\/new$/);

		await page.getByLabel('商品名').fill(ITEM_NAME);
		await page.getByLabel('価格').fill(String(ITEM_PRICE));
		await page.getByLabel('在庫').fill(String(ITEM_STOCK));
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		// Server-mode grid, 1,000 seeded demo rows: filter by name (unique,
		// timestamped) rather than scrolling/scanning for the new row.
		await applyColumnFilter(page, '商品名', ITEM_NAME);
		const row = rowWithText(page, ITEM_NAME);
		await expect(row).toBeVisible();

		const openLink = row.getByRole('link', { name: '開く' });
		const href = await openLink.getAttribute('href');
		expect(href).toMatch(/^\/items\/\d+$/);
		const itemUrl = new RegExp(`${href}$`);

		// Edit: change price, save, and independently re-open the record (by
		// URL, not via the grid/filter again) to confirm the new value
		// actually persisted server-side.
		await openLink.click();
		await expect(page).toHaveURL(itemUrl);
		await page.getByLabel('価格').fill(String(ITEM_PRICE_UPDATED));
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await page.goto(href!);
		await expect(page.getByLabel('価格')).toHaveValue(String(ITEM_PRICE_UPDATED));

		// Delete (window.confirm - accept it before triggering the click).
		page.once('dialog', (dialog) => dialog.accept());
		await page.getByRole('button', { name: '削除' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await page.goto(href!);
		await expect(page.getByText('商品が見つかりません')).toBeVisible();
	});

	test('4. CSV export downloads a UTF-8-BOM CSV file', async () => {
		await page.goto('/items');

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'CSVエクスポート' }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(/^items-\d{8}-\d{4}\.csv$/);
		const filePath = await download.path();
		expect(filePath).not.toBeNull();

		// csvForExcel (packages/grid-svelte/src/core/csv.ts) prefixes a UTF-8
		// BOM so Excel on Japanese Windows opens the file without mojibake -
		// verify the actual downloaded bytes, not just the in-app helper.
		const firstBytes = fs.readFileSync(filePath!).subarray(0, 3);
		expect(Buffer.from(firstBytes)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
	});

	test('5. user management: create a viewer account', async () => {
		await page.goto('/users');

		// Scoped to the create form (not just page.getByLabel(...)): the
		// grid's ユーザー名/表示名 column filter buttons below (aria-label
		// "<列名>の絞り込み") also match those label texts by substring,
		// which makes an unscoped getByLabel ambiguous once the grid is on
		// the same page (users/+page.svelte's "section.create").
		const createForm = page.locator('section.create');
		await createForm.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
		await createForm.getByLabel('パスワード（8文字以上）').fill(VIEWER_PASSWORD);
		await createForm.getByLabel('表示名').fill(VIEWER_DISPLAY_NAME);
		await createForm.getByLabel('ロール').selectOption('viewer');
		await createForm.getByRole('button', { name: '作成' }).click();

		await expect(rowWithText(page, VIEWER_USERNAME)).toBeVisible();
	});

	test('6. viewer role: no admin nav entries, no items create button', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
		await page.getByLabel('パスワード').fill(VIEWER_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		// Sidebar.svelte hides adminOnly nav entries entirely (not just
		// disabled) for non-admin roles.
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: '監査ログ' })).toHaveCount(0);

		await page.goto('/items');
		await expect(page.getByRole('button', { name: '新規作成' })).toHaveCount(0);
	});

	test('7. admin: audit log shows the login and items records', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		await page.goto('/audit-log');

		// action is stored/filtered on its raw wire value ('login'); the grid
		// cell renders it through actionLabel() as 'ログイン'.
		await applyColumnFilter(page, 'アクション', 'login');
		await expect(rowWithText(page, 'ログイン').first()).toBeVisible();

		// Filters AND together, so the previous one must be cleared before a
		// resource-only filter is applied, or nothing would match.
		await clearColumnFilter(page, 'アクション');
		await applyColumnFilter(page, 'リソース', 'items');
		await expect(rowWithText(page, 'items').first()).toBeVisible();
	});

	test('8. command palette: search and navigate to the audit log', async () => {
		await page.goto('/items');
		// The Ctrl+K listener lives on (app)/+layout.svelte's `<svelte:window>`,
		// which only mounts after the route guard's async work (bantoReady,
		// sessionStore.load()) resolves - later than page.goto()'s "load"
		// event. Wait for a page-specific element first so the keypress below
		// isn't racing that mount.
		await expect(page.getByRole('button', { name: 'CSVエクスポート' })).toBeVisible();

		await page.keyboard.press('Control+K');
		const search = page.getByPlaceholder('コマンドを検索…');
		await expect(search).toBeVisible();
		await search.fill('監査');
		await search.press('Enter');

		await expect(page).toHaveURL(/\/audit-log$/);
	});

	test('9. settings: switching to the dark theme sets data-theme', async () => {
		await page.goto('/settings');

		// Not .getByLabel(...).check(): the radio inputs here are visually
		// hidden (`.options input { opacity: 0; pointer-events: none }`,
		// settings/+page.svelte) so their own `<label>` is the real click
		// target - clicking it activates the wrapped input via normal
		// label/control association.
		await page
			.getByRole('radiogroup', { name: 'テーマ' })
			.getByText('ダーク', { exact: true })
			.click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	});

	test('10. backups: create a backup and see it in the list', async () => {
		await page.goto('/settings');

		const backupRows = page.locator('.backup-list li');
		await expect(backupRows).toHaveCount(0);

		await page.getByRole('button', { name: '今すぐバックアップ' }).click();
		await expect(backupRows).toHaveCount(1);
	});
});
