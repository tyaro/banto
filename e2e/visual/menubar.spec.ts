/**
 * The menu bar layout of the app shell (nav-menubar-plan.md §3, §4, §7.2) in
 * a real browser: the header nav replacing the sidebar, links and
 * `aria-current`, the admin group's dropdown, the overflow into "その他", the
 * arrow-key help (D3-c), the <=900px drawer (D10-a) and the drawer that
 * stands in while even "その他" does not fit (§4.9). Same `visual` project as
 * launcher.spec.ts (vite preview, browser demo mode as admin, reduced
 * motion). No pixels: the screenshots are in visual.spec.ts.
 *
 * Counts of top items are never asserted - they depend on font metrics, which
 * differ between OSes (§7.2). The "見本" group (D7-b) is demo-build only and
 * is checked in e2e/demo/menubar-groups.spec.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeMenubar, primeThemeAndAuth } from './theme';

/** The production build's main nav, in order (demo-only entries are filtered out). */
const MAIN_LINKS = ['ダッシュボード', '商品', 'ツリービュー', '設定'];
const MAIN_PATHS = ['/dashboard', '/items', '/tree', '/settings'];

function mainNav(page: Page): Locator {
	return page.getByRole('navigation', { name: '主要ナビゲーション' });
}

function adminNav(page: Page): Locator {
	return page.getByRole('navigation', { name: '管理ナビゲーション' });
}

function drawerButton(page: Page): Locator {
	return page.locator('header').getByRole('button', { name: 'サイドバーを開く' });
}

async function gotoDashboard(page: Page): Promise<void> {
	await page.goto('/dashboard');
	await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
	await expect(mainNav(page).getByRole('link', { name: 'ダッシュボード' })).toBeVisible();
}

/**
 * Leaves the bar a fixed, small room. The production nav has few entries, so
 * a viewport just above 900px may or may not overflow depending on the OS
 * fonts; capping the bar (still above the "その他" button's width, so not the
 * §4.9 fallback) makes the overflow certain without counting items.
 */
async function narrowTheBar(page: Page): Promise<void> {
	await page.addStyleTag({ content: 'header .menubar { max-width: 280px; }' });
}

async function focusedText(page: Page): Promise<string> {
	return page.evaluate(
		() => (document.activeElement as HTMLElement | null)?.innerText.trim() ?? ''
	);
}

test.describe('menu bar layout (primed)', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await primeMenubar(page);
	});

	test('replaces the sidebar: brand and both navs in the header, no hamburger', async ({
		page
	}) => {
		await gotoDashboard(page);
		await expect(page.locator('aside')).toHaveCount(0);
		const header = page.locator('header');
		await expect(header.getByText('Banto', { exact: true })).toBeVisible();
		await expect(drawerButton(page)).toHaveCount(0);
		await expect(header.getByRole('navigation', { name: '主要ナビゲーション' })).toBeVisible();
		await expect(header.getByRole('navigation', { name: '管理ナビゲーション' })).toBeVisible();
		// D6: the search is the icon only, the page title stays.
		await expect(header.locator('.search-pill')).toBeHidden();
		await expect(header.getByRole('button', { name: /コマンドパレットを開く/ })).toBeVisible();
		await expect(header.locator('.page-title')).toHaveText('ダッシュボード');
	});

	test('a top link navigates and moves aria-current', async ({ page }) => {
		await gotoDashboard(page);
		const nav = mainNav(page);
		await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await nav.getByRole('link', { name: '商品' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await expect(nav.getByRole('link', { name: '商品' })).toHaveAttribute('aria-current', 'page');
		await expect(nav.getByRole('link', { name: 'ダッシュボード' })).not.toHaveAttribute(
			'aria-current',
			'page'
		);
	});

	test('the admin group opens on click, Esc closes it and returns focus (D4, §4.7)', async ({
		page
	}) => {
		await gotoDashboard(page);
		const button = adminNav(page).getByRole('button', { name: '管理' });
		await expect(button).toHaveAttribute('aria-expanded', 'false');
		await button.click();
		await expect(button).toHaveAttribute('aria-expanded', 'true');
		const users = adminNav(page).getByRole('link', { name: 'ユーザー管理' });
		await expect(users).toBeVisible();
		await expect(adminNav(page).getByRole('link', { name: '監査ログ' })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await expect(users).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(users).toBeHidden();
		await expect(button).toBeFocused();
		await expect(button).toHaveAttribute('aria-expanded', 'false');

		await button.click();
		await users.click();
		await expect(page).toHaveURL(/\/users$/);
		await button.click();
		await expect(users).toHaveAttribute('aria-current', 'page');
	});

	test('arrow keys move along the top row; Tab still stops at every item (D3-c)', async ({
		page
	}) => {
		await gotoDashboard(page);
		const first = mainNav(page).getByRole('link', { name: 'ダッシュボード' });
		await first.focus();
		await page.keyboard.press('ArrowRight');
		await expect(first).not.toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(first).toBeFocused();
		await page.keyboard.press('End');
		await expect(first).not.toBeFocused();
		await page.keyboard.press('Home');
		await expect(first).toBeFocused();
		// Wraps: left of the first item is the last one.
		await page.keyboard.press('ArrowLeft');
		const last = await focusedText(page);
		await page.keyboard.press('Home');
		await page.keyboard.press('End');
		expect(await focusedText(page)).toBe(last);
		// No roving tabindex: Tab from the first item reaches the second.
		await page.keyboard.press('Home');
		await page.keyboard.press('Tab');
		await expect(first).not.toBeFocused();
		expect(await focusedText(page)).not.toBe('');
	});

	test('narrower: the rest goes into "その他", every link stays reachable', async ({ page }) => {
		await gotoDashboard(page);
		await narrowTheBar(page);
		const nav = mainNav(page);
		const more = nav.getByRole('button', { name: /その他/ });
		await expect(more).toBeVisible();
		await expect(drawerButton(page)).toHaveCount(0);

		// Keyboard: Enter opens, Tab walks into the links, Esc closes and returns.
		await more.focus();
		await page.keyboard.press('Enter');
		await expect(more).toHaveAttribute('aria-expanded', 'true');
		await page.keyboard.press('Tab');
		const focusedHref = await page.evaluate(() =>
			document.activeElement?.closest('[popover]')
				? document.activeElement.getAttribute('href')
				: null
		);
		expect(focusedHref).not.toBeNull();
		await page.keyboard.press('Escape');
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		await expect(more).toBeFocused();

		// Top links + the links in "その他" = the whole main nav (no count of either).
		await more.click();
		await expect(more).toHaveAttribute('aria-expanded', 'true');
		await expect(nav.locator('[popover] a[href]').first()).toBeVisible();
		const hrefs = await nav
			.getByRole('link')
			.evaluateAll((links) =>
				links.map((link) => new URL((link as HTMLAnchorElement).href).pathname)
			);
		expect(hrefs.sort()).toEqual([...MAIN_PATHS].sort());

		// A link inside "その他" navigates; the button then shows the active look.
		const moved = nav.locator('[popover] a[href]').last();
		const href = await moved.getAttribute('href');
		await moved.click();
		// `/settings` redirects to its first section, so allow a sub-path.
		await expect(page).toHaveURL(new RegExp(`${href}(/[^/]+)?$`));
		await expect(more).toHaveClass(/active/);
	});

	test('<=900px: the hamburger opens the sidebar drawer (D10-a)', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 });
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('header nav')).toHaveCount(0);
		await drawerButton(page).click();
		const nav = mainNav(page);
		await expect(nav.getByRole('link', { name: '商品' })).toBeVisible();
		await nav.getByRole('link', { name: '商品' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await expect(drawerButton(page)).toHaveAttribute('aria-expanded', 'false');
	});

	test('wider than 900px but too narrow even for "その他": the drawer stands in, then the bar comes back (§4.9)', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1000, height: 800 });
		await gotoDashboard(page);
		await expect(drawerButton(page)).toHaveCount(0);

		await page.evaluate(() => (document.documentElement.style.fontSize = '250%'));
		await expect(drawerButton(page)).toBeVisible();
		// The bar is hidden (one main nav landmark at a time) until the drawer opens.
		await expect(mainNav(page)).toHaveCount(0);
		await drawerButton(page).click();
		const nav = mainNav(page);
		for (const name of MAIN_LINKS) {
			await expect(nav.getByRole('link', { name })).toBeVisible();
		}
		await page.keyboard.press('Escape');
		await expect(drawerButton(page)).toHaveAttribute('aria-expanded', 'false');

		await page.evaluate(() => (document.documentElement.style.fontSize = ''));
		await expect(drawerButton(page)).toHaveCount(0);
		await expect(page.locator('aside')).toHaveCount(0);
		await expect(mainNav(page).getByRole('link', { name: 'ダッシュボード' })).toBeVisible();
	});

	test('an open admin dropdown closes when the drawer stands in (§4.9)', async ({ page }) => {
		await page.setViewportSize({ width: 1000, height: 800 });
		await gotoDashboard(page);
		const button = adminNav(page).getByRole('button', { name: '管理' });
		await button.click();
		const users = adminNav(page).getByRole('link', { name: 'ユーザー管理' });
		await expect(users).toBeVisible();

		await page.evaluate(() => (document.documentElement.style.fontSize = '250%'));
		await expect(drawerButton(page)).toBeVisible();
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toBeHidden();
	});
});

test('the 外観 card switches to the menu bar and back', async ({ page }) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await page.goto('/settings/appearance');
	const group = page.getByRole('radiogroup', { name: 'ナビゲーションの表示形式' });
	await group.getByText('メニューバー', { exact: true }).click();
	await expect(page.locator('aside')).toHaveCount(0);
	await expect(
		page.locator('header').getByRole('navigation', { name: '主要ナビゲーション' })
	).toBeVisible();
	// No sub-settings for the menu bar (§3).
	await expect(page.getByText('ドックの位置')).toHaveCount(0);
	await group.getByText('サイドバー', { exact: true }).click();
	await expect(page.locator('aside')).toBeVisible();
	await expect(page.locator('header nav')).toHaveCount(0);
});
