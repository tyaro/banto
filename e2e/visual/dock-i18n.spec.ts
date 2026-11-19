/**
 * The dock's own strings follow the locale (Issue #729): in `en`, the title-bar buttons and the
 * "panel actions" menu of `/dashboard` (DockHost) and `/tree/workspace-dock` (ThreePaneDock) are
 * English - no Japanese from `defaultDockMessages` is left. No pixels (the ja look is unchanged
 * and covered by the existing visual specs).
 */
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

const JAPANESE = /[぀-ヿ一-鿿]/;

async function openEn(page: Page, path: string) {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await page.addInitScript(() => localStorage.setItem('banto.locale', 'en'));
	await page.goto(path);
	await expect(page.locator('[data-dock-host]')).toBeVisible();
}

for (const path of ['/dashboard', '/tree/workspace-dock']) {
	test(`dock buttons and menu are English in en (${path})`, async ({ page }) => {
		await openEn(page, path);
		const host = page.locator('[data-dock-host]');
		const menuButton = host.getByRole('button', { name: /^Panel actions for / }).first();
		await expect(menuButton).toBeVisible();
		// No dock-drawn button keeps a Japanese accessible name. Only the dock's own chrome counts:
		// anything inside a pane / window body (`.body` of DockedTree / DockWindow, e.g. BantoTree's
		// "Collapse <row name>" with demo-data names) is the app's content, not a dock string. The
		// panel names inside `{title}` are today's (English) panel titles, not data.
		const names = await host
			.locator('button[aria-label]')
			.evaluateAll((els) =>
				els.filter((e) => !e.closest('.body')).map((e) => e.getAttribute('aria-label') ?? '')
			);
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((n) => JAPANESE.test(n))).toEqual([]);
		// The menu's items are English too.
		const menu = page.getByRole('menu', { name: /^Panel actions for / });
		await expect(async () => {
			if (!(await menu.isVisible())) {
				await menuButton.focus();
				await page.keyboard.press('Enter');
			}
			await expect(menu).toBeVisible({ timeout: 1000 });
		}).toPass();
		const items = await menu.getByRole('menuitem').allTextContents();
		expect(items.length).toBeGreaterThan(0);
		expect(items.filter((t) => JAPANESE.test(t))).toEqual([]);
	});
}
