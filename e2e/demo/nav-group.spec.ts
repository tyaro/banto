/**
 * Nav group in the demo build (nav-menubar-plan D8-b, PR-5): the demo-only
 * entries (/ui-demo, /chart-gallery) carry `group: 'nav.group.demo'`, so the
 * sidebar shows them under a heading and the dock rules them off inside the
 * one main nav. A production build has no group, so
 * its sidebar and dock are unchanged (the existing visual baselines cover
 * that). Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeLauncher, primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('sidebar: the demo entries sit under a heading, the others stay flat', async ({ page }) => {
	await page.goto('/dashboard');
	const nav = page.getByRole('navigation', { name: '主要ナビゲーション' });
	const group = nav.getByRole('group', { name: '見本' });
	await expect(group).toBeVisible({ timeout: 60_000 });
	await expect(group.getByRole('link')).toHaveText(['UI 部品の見本', 'チャート見本']);
	// The visible heading is decoration: the group's name comes from role="group".
	await expect(group.locator('.section-heading')).toHaveText('見本');
	await expect(group.locator('.section-heading')).toHaveAttribute('aria-hidden', 'true');
	// Standalone entries are not inside the group.
	await expect(group.getByRole('link', { name: 'ダッシュボード' })).toHaveCount(0);
	await expect(nav.getByRole('link', { name: '設定' })).toBeVisible();
	// Only the demo group has a heading in the main nav.
	await expect(nav.locator('.section-heading')).toHaveCount(1);
});

test('dock: the demo entries are ruled off inside the one main nav', async ({ page }) => {
	await primeLauncher(page);
	await page.goto('/dashboard');
	await expect(page.locator('.launcher')).toBeVisible({ timeout: 60_000 });
	// One main nav landmark; the demo group is not a nav of its own.
	await expect(
		page.locator('.launcher').getByRole('navigation', { name: '主要ナビゲーション' })
	).toHaveCount(1);
	await expect(page.locator('.launcher').getByRole('navigation', { name: '見本' })).toHaveCount(0);
	const main = page.locator('.launcher').getByRole('navigation', { name: '主要ナビゲーション' });
	await expect(main.getByRole('link', { name: 'UI 部品の見本' })).toBeVisible({ timeout: 60_000 });
	await expect(main.getByRole('link', { name: 'チャート見本' })).toBeVisible();
	// Rules inside main: before the demo group and before the standalone item after it (settings).
	await expect(main.locator('.launcher__separator')).toHaveCount(2);
	// Plus one rule between the main nav and the admin nav.
	await expect(page.locator('.launcher .launcher__separator')).toHaveCount(3);
});
