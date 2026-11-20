/**
 * BantoForm choice types (#714) on the /ui-demo choices card, in a real
 * browser: radio arrow keys, the segmented strip's name and selection, a
 * required multiselect submitting an array, and a number with a unit staying a
 * number. The pure decisions are unit-tested in packages/forms.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

async function openChoices(page: Page) {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-choices');
	await expect(card.getByRole('radiogroup', { name: /配送方法/ })).toBeVisible({ timeout: 60_000 });
	await card.scrollIntoViewIfNeeded();
	return card;
}

test('arrow keys move a radio group natively', async ({ page }) => {
	const card = await openChoices(page);
	const normal = card.getByRole('radio', { name: '通常' });
	const express = card.getByRole('radio', { name: 'お急ぎ' });
	await expect(normal).toBeChecked();
	// Hydration is late on the dev server: retry until the key moves the choice.
	await expect(async () => {
		await normal.focus();
		await page.keyboard.press('ArrowDown');
		await expect(express).toBeChecked({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await expect(express).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(card.getByRole('radio', { name: '店頭受取' })).toBeChecked();
});

test('segmented is a named radio group with a clearly chosen segment', async ({ page }) => {
	const card = await openChoices(page);
	const group = card.getByRole('radiogroup', { name: 'サイズ' });
	const m = group.getByRole('radio', { name: 'M' });
	const l = group.getByRole('radio', { name: 'L' });
	await expect(m).toBeChecked();
	await expect(async () => {
		await l.check();
		await expect(l).toBeChecked({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await expect(m).not.toBeChecked();
	// Not colour alone: the chosen segment is bold.
	const weight = (name: string) =>
		group
			.locator('label', { hasText: new RegExp(`^\\s*(✓\\s*)?${name}\\s*$`) })
			.evaluate((el) => Number(getComputedStyle(el).fontWeight));
	expect(await weight('L')).toBeGreaterThan(await weight('M'));
});

test('a multiselect needs one item and submits an array', async ({ page }) => {
	const card = await openChoices(page);
	const extras = card.getByRole('group', { name: /同梱物/ });
	await expect(extras).toHaveAccessibleDescription('1 つ以上選ぶ。');
	const values = page.getByTestId('ui-demo-choices-values');

	await expect(async () => {
		await card.getByRole('button', { name: '送信' }).click();
		await expect(card.locator('.error')).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await expect(values).toHaveText('まだ無い');
	await expect(extras).toHaveAccessibleDescription(/1 つ以上選ぶ。/);

	await extras.getByRole('checkbox', { name: '保証書' }).check();
	await extras.getByRole('checkbox', { name: 'メッセージカード' }).check();
	await card.getByRole('button', { name: '送信' }).click();
	// Options order, not click order.
	await expect(values).toContainText('"extras":["card","warranty"]');
});

test('a unit is shown and read, and the value stays a number', async ({ page }) => {
	const card = await openChoices(page);
	const weight = card.getByLabel('重量');
	await expect(weight).toHaveAccessibleDescription('kg 梱包を含む。');
	await expect(card.getByLabel('価格')).toHaveAccessibleDescription('¥');
	await expect(card.getByText('kg', { exact: true })).toBeVisible();

	await weight.fill('12.5');
	await card.getByLabel('価格').fill('980');
	await card
		.getByRole('group', { name: /同梱物/ })
		.getByRole('checkbox', { name: '取扱説明書' })
		.check();
	await card.getByRole('button', { name: '送信' }).click();
	const values = page.getByTestId('ui-demo-choices-values');
	await expect(values).toContainText('"weight":12.5');
	await expect(values).toContainText('"price":980');
});
