/**
 * Theme lab (Issue #690): /theme-lab in the demo build. The knobs change the
 * preview (a nested data-theme element) and the exported CSS, never the shell.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 *
 * The dev server hydrates late, so an input made before hydration is lost:
 * the first change goes inside `toPass()` and repeats until it shows.
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('the page opens with nothing to export, and the sidebar lists it', async ({ page }) => {
	await page.goto('/theme-lab');
	await expect(
		page.getByRole('heading', { name: 'プレビュー', level: 2, exact: true })
	).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('theme-lab-export-default')).toBeVisible();
	await expect(page.getByTestId('theme-lab-css')).toHaveText(':root {\n}\n');
	const nav = page.getByRole('navigation', { name: '主要ナビゲーション' });
	await expect(nav.getByRole('link', { name: 'テーマを試す', exact: true })).toBeVisible();
});

test('hue: the export and the preview change, the shell does not', async ({ page }) => {
	await page.goto('/theme-lab');
	const hue = page.getByRole('spinbutton', { name: 'ブランド色相', exact: true });
	await expect(async () => {
		await hue.fill('150', { timeout: 2_000 });
		await expect(page.getByTestId('theme-lab-css')).toContainText('--banto-brand-hue: 150;', {
			timeout: 2_000
		});
	}).toPass({ timeout: 60_000 });
	await expect(page.getByTestId('theme-lab-export-default')).toHaveCount(0);

	const preview = page.getByTestId('theme-lab-preview');
	const hueOf = (selector: string) =>
		page.evaluate(
			(sel) =>
				getComputedStyle(document.querySelector(sel) as Element)
					.getPropertyValue('--banto-brand-hue')
					.trim(),
			selector
		);
	await expect(preview).toHaveAttribute('style', /--banto-brand-hue: 150/);
	expect(await hueOf('[data-testid="theme-lab-preview"]')).toBe('150');
	expect(await hueOf('html')).toBe('258');

	// back to the default: nothing to export again
	await page.getByRole('button', { name: '既定に戻す', exact: true }).click();
	await expect(page.getByTestId('theme-lab-css')).toHaveText(':root {\n}\n');
});

test('density, light / dark and corner radius reach the preview and the export', async ({
	page
}) => {
	await page.goto('/theme-lab');
	const preview = page.getByTestId('theme-lab-preview');
	await expect(async () => {
		await page.getByText('compact', { exact: true }).click({ timeout: 2_000 });
		await expect(preview).toHaveAttribute('data-banto-density', 'compact', { timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await expect(page.getByTestId('theme-lab-css')).toContainText("applyDensity('compact')");

	await page.getByText('ダーク', { exact: true }).click();
	await expect(preview).toHaveAttribute('data-theme', 'dark');
	// the shell stays in the theme the test primed
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

	await page.getByTestId('theme-lab-radius').fill('12');
	await expect(page.getByTestId('theme-lab-css')).toContainText('--banto-radius-md: 12px;');
	await expect(page.getByTestId('theme-lab-css')).toContainText('--banto-radius-lg: 20px;');
});

test('contrast: ratios are listed and the default hue passes', async ({ page }) => {
	await page.goto('/theme-lab');
	const list = page.getByTestId('theme-lab-contrast');
	await expect(list).toBeVisible({ timeout: 60_000 });
	await expect(list.getByText('primary の上の文字', { exact: true })).toBeVisible();
	await expect(page.getByTestId('theme-lab-contrast-note')).toHaveText('すべて 4.5:1 以上です。');
});

// The preview carries its own density: the values do not come from the shell.
const previewPx = (page: import('@playwright/test').Page, name: string) =>
	page.evaluate((n) => {
		const el = document.querySelector('[data-testid="theme-lab-preview"]') as HTMLElement;
		const probe = document.createElement('div');
		probe.style.width = `var(${n})`;
		el.appendChild(probe);
		const px = getComputedStyle(probe).width;
		probe.remove();
		return px;
	}, name);

test('density: standard in the preview holds while the shell is compact', async ({ page }) => {
	await page.goto('/theme-lab');
	await expect(page.getByTestId('theme-lab-preview')).toBeVisible({ timeout: 60_000 });
	await page.evaluate(() => document.documentElement.setAttribute('data-banto-density', 'compact'));
	expect(await previewPx(page, '--banto-control-height')).toBe('36px');
	expect(await previewPx(page, '--banto-space-4')).toBe('14px');
});

test('density: touch in the preview is 16px based while the shell is standard', async ({
	page
}) => {
	await page.goto('/theme-lab');
	const preview = page.getByTestId('theme-lab-preview');
	await expect(async () => {
		await page.getByText('touch', { exact: true }).click({ timeout: 2_000 });
		await expect(preview).toHaveAttribute('data-banto-density', 'touch', { timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	expect(await previewPx(page, '--banto-space-4')).toBe('16px');
	expect(await previewPx(page, '--banto-control-height')).toBe('48px');
	const lg = parseFloat(await previewPx(page, '--banto-font-size-lg'));
	expect(lg).toBeGreaterThan(18.2);
	expect(lg).toBeLessThan(18.4);
	// BantoGrid sets its row height inline from the rowHeight prop, not the CSS variable
	await expect(preview.locator('[role="row"][aria-rowindex="2"]')).toHaveCSS('height', '52px');
});

test('density: compact, standard and reset in the preview hold while the shell is touch', async ({
	page
}) => {
	await page.goto('/theme-lab');
	const preview = page.getByTestId('theme-lab-preview');
	await expect(preview).toBeVisible({ timeout: 60_000 });
	// the shell's touch block also sets values compact leaves alone (control-height-sm, font size)
	await page.evaluate(() => document.documentElement.setAttribute('data-banto-density', 'touch'));

	await expect(async () => {
		await page.getByText('compact', { exact: true }).click({ timeout: 2_000 });
		await expect(preview).toHaveAttribute('data-banto-density', 'compact', { timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	expect(await previewPx(page, '--banto-control-height')).toBe('32px');
	expect(await previewPx(page, '--banto-control-height-sm')).toBe('28px');
	expect(await previewPx(page, '--banto-space-4')).toBe('10.5px');
	expect(await previewPx(page, '--banto-font-size')).toBe('14px');

	const expectStandard = async () => {
		await expect(preview).not.toHaveAttribute('data-banto-density');
		expect(await previewPx(page, '--banto-control-height')).toBe('36px');
		expect(await previewPx(page, '--banto-control-height-sm')).toBe('28px');
		expect(await previewPx(page, '--banto-space-4')).toBe('14px');
		expect(await previewPx(page, '--banto-font-size')).toBe('14px');
	};
	await page.getByText('標準', { exact: true }).click();
	await expectStandard();

	await page.getByText('compact', { exact: true }).click();
	await expect(preview).toHaveAttribute('data-banto-density', 'compact');
	await page.getByRole('button', { name: '既定に戻す', exact: true }).click();
	await expectStandard();
});
