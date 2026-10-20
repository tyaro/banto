/**
 * Sidebar toggle at the left end of the header: ONE button that folds the
 * sidebar above 900px and opens/closes the drawer at <=900px. Same `visual`
 * project as the other specs here (vite preview, browser demo mode).
 */
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeKiosk, primeThemeAndAuth } from './theme';

async function gotoDashboard(page: Page): Promise<void> {
	await page.goto('/dashboard');
	await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}

test.describe('sidebar toggle in the header', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	});

	test('>900px: the header button folds / unfolds the sidebar', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoDashboard(page);
		const aside = page.locator('#app-sidebar');
		const header = page.locator('header');
		const collapse = header.getByRole('button', { name: 'サイドバーをたたむ' });
		await expect(collapse).toHaveAttribute('aria-expanded', 'true');
		await expect(collapse).toHaveAttribute('aria-controls', 'app-sidebar');
		const wide = (await aside.boundingBox())!.width;

		await collapse.click();
		const expand = header.getByRole('button', { name: 'サイドバーを開く' });
		await expect(expand).toHaveAttribute('aria-expanded', 'false');
		await expect.poll(async () => (await aside.boundingBox())!.width).toBeLessThan(wide);

		await expand.click();
		await expect(header.getByRole('button', { name: 'サイドバーをたたむ' })).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await expect.poll(async () => (await aside.boundingBox())!.width).toBe(wide);

		// The old footer button is gone.
		await expect(aside.getByRole('button')).toHaveCount(0);
	});

	test('<=900px: the same button opens / closes the drawer, Esc closes it', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 900 });
		await gotoDashboard(page);
		const aside = page.locator('#app-sidebar');
		const header = page.locator('header');
		const open = header.getByRole('button', { name: 'サイドバーを開く' });
		await expect(open).toHaveAttribute('aria-expanded', 'false');
		await expect(aside).not.toHaveClass(/overlay-open/);

		await open.click();
		await expect(aside).toHaveClass(/overlay-open/);
		const close = header.getByRole('button', { name: 'サイドバーを閉じる' });
		await expect(close).toHaveAttribute('aria-expanded', 'true');

		// The drawer (z-index above the header) covers the button, as the old
		// hamburger was: pointer users close via the backdrop, keyboard users
		// via the still-focused button.
		await close.focus();
		await page.keyboard.press('Enter');
		await expect(aside).not.toHaveClass(/overlay-open/);
		await expect(open).toHaveAttribute('aria-expanded', 'false');

		await open.click();
		await expect(aside).toHaveClass(/overlay-open/);
		await page.keyboard.press('Escape');
		await expect(aside).not.toHaveClass(/overlay-open/);
	});

	test('keyboard: the toggle is the first focusable control in the header', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoDashboard(page);
		const first = page.locator('header').locator('a, button, [tabindex]').first();
		await expect(first).toHaveAccessibleName('サイドバーをたたむ');
		await first.focus();
		await expect(first).toBeFocused();
	});

	test('kiosk compact header keeps the toggle', async ({ page }) => {
		await primeKiosk(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoDashboard(page);
		await expect(page.locator('header').getByRole('button', { name: /サイドバー/ })).toBeVisible();
	});
});
