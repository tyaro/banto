/**
 * Toast background stays opaque in the dark theme (#794). success / error /
 * warning lay a translucent tint over the surface; the tint must sit on top of
 * an opaque layer (`--banto-surface-overlay`), or content behind the toast
 * shows through. Checked on computed style, not on an image, so no baseline is
 * involved. Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'dark', preset: 'standard' });
});

/** Alpha of a computed colour: rgba() or `color(... / a)`; 1 when none is written. */
function alphaOf(color: string): number {
	const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)/);
	if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
	const rgba = color.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/);
	if (rgba) return Number(rgba[1]);
	return 1;
}

// Order of the buttons in the /ui-demo ToastHost card.
const BUTTON_ORDER = ['success', 'error', 'info', 'warning'];

for (const kind of ['success', 'error', 'warning'] as const) {
	test(`dark: the ${kind} toast has an opaque bottom layer`, async ({ page }) => {
		await page.goto('/ui-demo');
		const button = page
			.getByTestId('ui-demo-toast-undone')
			.locator('xpath=ancestor::*[contains(@class,"row")][1]')
			.locator('button')
			.nth(BUTTON_ORDER.indexOf(kind));
		await expect(button).toBeVisible({ timeout: 60_000 });
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await button.click();
		const toast = page.locator(`.toast[data-kind="${kind}"]`);
		await expect(toast).toBeVisible();
		const style = await toast.evaluate((el) => {
			const s = getComputedStyle(el);
			return { color: s.backgroundColor, image: s.backgroundImage };
		});
		// The bottom layer (background-color) must be opaque; the tint is the gradient above it.
		expect(alphaOf(style.color), `background-color ${style.color}`).toBe(1);
		expect(style.image).toContain('gradient');
	});
}
