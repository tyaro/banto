/**
 * The menu bar layout for a LAN viewer-public session (nav-menubar-plan.md
 * §4.11, §7.2): the header nav takes `navSections()` as is - the allowlisted
 * entries only, and no admin nav. The synthetic viewer's stored layout is
 * answered by a route (its `GET /api/ui-settings/shell.navLayout`), so the
 * server keeps nothing from this file. Own context; the scenario file
 * (public-viewer.spec.ts) is not affected.
 */
import { expect, test } from '@playwright/test';

test('viewer-public: the menu bar shows the allowlisted entries only, no admin nav', async ({
	browser
}) => {
	const context = await browser.newContext({ reducedMotion: 'reduce' });
	const page = await context.newPage();
	try {
		await page.route('**/api/ui-settings/shell.navLayout', async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			await route.fulfill({ json: { value: 'menubar', revision: 'e2e' } });
		});
		await page.addInitScript(() => window.localStorage.setItem('banto.navLayout', 'menubar'));

		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.getByRole('banner').getByText('閲覧者')).toBeVisible();

		const nav = page.getByRole('banner').getByRole('navigation', { name: '主要ナビゲーション' });
		await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('aside')).toHaveCount(0);
		await expect(page.getByRole('navigation', { name: '管理ナビゲーション' })).toHaveCount(0);

		// Everything in the bar, "その他" included when it shows: allowlisted paths only.
		const more = nav.getByRole('button', { name: /その他/ });
		if (await more.isVisible()) await more.click();
		const paths = await nav
			.getByRole('link')
			.evaluateAll((links) =>
				links.map((link) => new URL((link as HTMLAnchorElement).href).pathname)
			);
		expect(paths).toContain('/dashboard');
		for (const hidden of ['/settings', '/tree', '/users', '/audit-log']) {
			expect(paths).not.toContain(hidden);
		}
	} finally {
		await context.close();
	}
});
