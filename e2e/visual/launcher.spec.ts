/**
 * The dock layout of the app shell (nav-launcher-plan.md §3, §4, §7.2) in a
 * real browser: tooltip hover / Esc / keyboard behaviour (WCAG 1.4.13 and
 * `:focus-visible` specificity cannot be checked in jsdom), navigation and
 * `aria-current`, the <=900px tab bar, the toast lifted above the bar and
 * the settings card (radio + opacity slider). Same `visual` project as the
 * other specs here (vite preview, browser demo mode, reduced motion - so
 * the tooltip transitions take 0ms and magnification is off). No pixels:
 * the screenshots are in visual.spec.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeLauncher, primeThemeAndAuth } from './theme';

function mainNav(page: Page): Locator {
	return page.getByRole('navigation', { name: '主要ナビゲーション' });
}

/** The launcher's `<li>` for an app path (`data-launcher-item` is the item id = its path). */
function launcherItem(page: Page, path: string): Locator {
	return page.locator(`.launcher [data-launcher-item="${path}"]`);
}

function tooltipOf(item: Locator): Locator {
	return item.locator('.launcher__tooltip');
}

async function visibilityOf(locator: Locator): Promise<string> {
	return locator.evaluate((el) => getComputedStyle(el).visibility);
}

async function gotoDashboard(page: Page): Promise<void> {
	await page.goto('/dashboard');
	await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
	await expect(page.locator('.launcher')).toBeVisible();
}

test.describe('dock layout (primed)', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await primeLauncher(page);
	});

	test('replaces the sidebar: brand in the header, no hamburger, root marked for the toasts', async ({
		page
	}) => {
		await gotoDashboard(page);
		await expect(page.locator('aside')).toHaveCount(0);
		await expect(page.locator('header').getByText('Banto', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'サイドバーを開く' })).toHaveCount(0);
		await expect(page.locator('html')).toHaveAttribute('data-banto-shell-nav', 'launcher');
		// Admin session in demo mode: both groups.
		await expect(page.getByRole('navigation', { name: '管理ナビゲーション' })).toBeVisible();
	});

	test('a dock link navigates and moves aria-current', async ({ page }) => {
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

	test('tooltip stays while the pointer moves onto it, and hides once it leaves (§4.4)', async ({
		page
	}) => {
		await gotoDashboard(page);
		const item = launcherItem(page, '/items');
		const tooltip = tooltipOf(item);
		await item.hover();
		await expect(tooltip).toBeVisible();

		const from = await item.boundingBox();
		const to = await tooltip.boundingBox();
		if (!from || !to) throw new Error('no layout for the item or its tooltip');
		// Straight up across the gap between the item and its tooltip.
		await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
		await expect(tooltip).toBeVisible();

		await page.mouse.move(to.x + to.width / 2, 200, { steps: 4 });
		await expect(tooltip).toBeHidden();
	});

	test('Esc hides a hovered tooltip while focus stays in a page input; a small move does not bring it back', async ({
		page
	}) => {
		await page.goto('/items/new');
		const name = page.getByLabel('商品名');
		await expect(name).toBeVisible();
		await name.fill('ドックのテスト');
		await expect(name).toBeFocused();

		const item = launcherItem(page, '/dashboard');
		const tooltip = tooltipOf(item);
		await item.hover();
		await expect(tooltip).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(tooltip).toBeHidden();
		await expect(name).toBeFocused();
		await expect(name).toHaveValue('ドックのテスト');

		const box = await item.boundingBox();
		if (!box) throw new Error('no layout for the item');
		await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 2);
		await expect(tooltip).toBeHidden();
	});

	test('with the command palette open, Esc closes the palette and leaves the tooltip alone', async ({
		page
	}) => {
		await gotoDashboard(page);
		const item = launcherItem(page, '/items');
		await item.hover();
		await expect(tooltipOf(item)).toBeVisible();

		await page.keyboard.press('Control+K');
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		await expect(palette).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(palette).toBeHidden();
		// The launcher yielded to the layer above: it did not mark the item quiet.
		await expect(item).not.toHaveClass(/launcher__item--quiet/);
	});

	test('a keyboard-shown tooltip hides on Esc, focus stays, and the next item shows its own (§7.2-3)', async ({
		page
	}) => {
		await gotoDashboard(page);
		await page.mouse.move(700, 200);

		const links = page.locator('.launcher a.launcher__link');
		await expect(links.first()).toBeVisible();
		// Tab until focus reaches the dock (it precedes .main in the DOM, §4.7).
		for (let i = 0; i < 20; i++) {
			await page.keyboard.press('Tab');
			if (await links.first().evaluate((el) => el === document.activeElement)) break;
		}
		const first = links.nth(0);
		const second = links.nth(1);
		await expect(first).toBeFocused();
		const firstTooltip = first.locator('xpath=..').locator('.launcher__tooltip');
		await expect.poll(() => visibilityOf(firstTooltip)).toBe('visible');

		await page.keyboard.press('Escape');
		await expect.poll(() => visibilityOf(firstTooltip)).toBe('hidden');
		await expect(first).toBeFocused();

		await page.keyboard.press('Tab');
		await expect(second).toBeFocused();
		const secondTooltip = second.locator('xpath=..').locator('.launcher__tooltip');
		await expect.poll(() => visibilityOf(secondTooltip)).toBe('visible');
	});

	test('a toast is lifted above the bar', async ({ page }) => {
		await page.goto('/ui-demo');
		await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
		await page.getByRole('button', { name: '成功を表示' }).click();
		const toast = page.locator('.toast-host .toast').first();
		await expect(toast).toBeVisible();
		const toastBox = await toast.boundingBox();
		const barBox = await page.locator('.launcher__bar').boundingBox();
		if (!toastBox || !barBox) throw new Error('no layout for the toast or the bar');
		expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(barBox.y);
	});

	test('<=900px: a full-width tab bar, no hamburger, toasts above it', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 });
		await gotoDashboard(page);
		await expect(page.getByRole('button', { name: 'サイドバーを開く' })).toHaveCount(0);
		const bar = await page.locator('.launcher__bar').boundingBox();
		if (!bar) throw new Error('no layout for the bar');
		expect(bar.width).toBeGreaterThanOrEqual(768 - 1);
		expect(Math.round(bar.y + bar.height)).toBe(1024);
		// The page keeps room for the bar below its content.
		const reserve = await page
			.locator('main')
			.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom));
		expect(reserve).toBeGreaterThanOrEqual(bar.height);

		await page.goto('/ui-demo');
		await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
		await page.getByRole('button', { name: '成功を表示' }).click();
		const toast = page.locator('.toast-host .toast').first();
		await expect(toast).toBeVisible();
		const toastBox = await toast.boundingBox();
		const tabBar = await page.locator('.launcher__bar').boundingBox();
		if (!toastBox || !tabBar) throw new Error('no layout for the toast or the tab bar');
		expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(tabBar.y);
	});
});

test('settings: choosing Dock shows the opacity slider, which applies live; Sidebar puts it back', async ({
	page
}) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
	const group = page.getByRole('radiogroup', { name: 'ナビゲーションの表示形式' });
	await expect(group).toBeVisible();
	await expect(page.getByRole('slider', { name: /ドックの不透明度/ })).toHaveCount(0);

	await group.getByText('ドック', { exact: true }).click();
	await expect(page.locator('.launcher')).toBeVisible();
	await expect(page.locator('aside')).toHaveCount(0);
	await expect(page.locator('html')).toHaveAttribute('data-banto-shell-nav', 'launcher');

	const slider = page.getByRole('slider', { name: /ドックの不透明度/ });
	await expect(slider).toHaveValue('50');
	await slider.fill('80');
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue('--banto-shell-launcher-opacity')
			)
		)
		.toBe('80%');
	await expect(page.locator('.launcher-preview')).toHaveAttribute(
		'style',
		/--banto-shell-launcher-opacity:\s*80%/
	);
	await expect(page.getByText('80%', { exact: true })).toBeVisible();

	// Kept across a reload (cache + demo provider).
	await page.reload();
	await expect(page.locator('.launcher')).toBeVisible();
	await expect(slider).toHaveValue('80');

	await page
		.getByRole('radiogroup', { name: 'ナビゲーションの表示形式' })
		.getByText('サイドバー', { exact: true })
		.click();
	await expect(page.locator('.launcher')).toHaveCount(0);
	await expect(page.locator('aside')).toBeVisible();
	await expect(page.locator('html')).not.toHaveAttribute('data-banto-shell-nav', 'launcher');
});
