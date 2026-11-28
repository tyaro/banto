/**
 * Form presentation setting: with "dialog" chosen (settings -> appearance), a
 * row's detail opens as a centred dialog instead of the drawer. Same content,
 * same close rules (Esc, unsaved-changes guard). The `demo` project
 * (`vite dev`, VITE_BANTO_DEMO=1), admin role.
 */
import { expect, test, type Page } from '@playwright/test';
import { primeFormDialog, primeThemeAndAuth } from '../visual/theme';

test.setTimeout(120_000);

const openButtonOfRow0 = '.row[aria-rowindex="2"] [data-resource-open] button';

async function openFirstRow(page: Page) {
	await page.goto('/items');
	const grid = page.getByRole('grid').first();
	await expect(grid.locator('.row [role="gridcell"]').first()).toBeVisible({ timeout: 60_000 });
	// Hydration is late on the dev server: retry the click until the dialog is there.
	const dialog = page.getByRole('dialog');
	await expect(async () => {
		await grid.locator(openButtonOfRow0).click();
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	return dialog;
}

test.describe('dialog presentation', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await primeFormDialog(page);
	});

	test('a row opens as a centred dialog that fits the viewport, saves and closes with Esc', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1000, height: 420 });
		const dialog = await openFirstRow(page);
		const box = await dialog.boundingBox();
		expect(box).toBeTruthy();
		const viewport = page.viewportSize()!;
		// Centred (not stuck to the right edge like the drawer) and inside the viewport.
		expect(box!.x).toBeGreaterThan(1);
		expect(box!.x + box!.width).toBeLessThan(viewport.width - 1);
		expect(box!.y).toBeGreaterThanOrEqual(0);
		expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

		// Edit and save.
		const field = dialog.getByRole('textbox').first();
		await field.fill('ダイアログで保存');
		await dialog.getByRole('button', { name: '保存' }).click();
		await expect(dialog.getByRole('textbox').first()).toHaveValue('ダイアログで保存');

		// Esc closes it (nothing unsaved any more).
		// (retry: a press right after the save can land while the save is settling)
		await expect(async () => {
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 2_000 });
		}).toPass({ timeout: 20_000 });
	});

	test('the dialog stays inside the narrowest viewport that still opens one', async ({ page }) => {
		// Below 768px a row opens the detail page instead (no drawer, no dialog).
		await page.setViewportSize({ width: 800, height: 640 });
		const dialog = await openFirstRow(page);
		const box = await dialog.boundingBox();
		expect(box).toBeTruthy();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(800);
	});
});

test('choosing "dialog" in the appearance settings opens the next row as a dialog', async ({
	page
}) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.goto('/settings');
	const group = page.getByRole('radiogroup', { name: '入力の表示' });
	await expect(async () => {
		await group.getByText('ダイアログ').click();
		await expect(group.getByRole('radio', { name: 'ダイアログ' })).toBeChecked({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await page.goto('/items');
	const grid = page.getByRole('grid').first();
	await expect(grid.locator('.row [role="gridcell"]').first()).toBeVisible({ timeout: 60_000 });
	const dialog = page.getByRole('dialog');
	await expect(async () => {
		await grid.locator(openButtonOfRow0).click();
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	const box = await dialog.boundingBox();
	expect(box!.x + box!.width).toBeLessThan(page.viewportSize()!.width - 1);
});

test('the default is still the drawer (docked to the right edge)', async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	const dialog = await openFirstRow(page);
	const box = await dialog.boundingBox();
	const viewport = page.viewportSize()!;
	expect(box!.x + box!.width).toBeGreaterThanOrEqual(viewport.width - 1);
});
