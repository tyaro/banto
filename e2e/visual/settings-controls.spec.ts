import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

test('settings labels stay above selected values and password input', async ({ page }) => {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await page.goto('/settings/appearance');

	const language = page.getByLabel('表示言語');
	await expect(language).toHaveValue('ja');
	const selected = await language.evaluate((control) => {
		const label = (
			control.closest('.banto-affix') ?? control
		).nextElementSibling!.getBoundingClientRect();
		const field = control.getBoundingClientRect();
		return {
			labelBottom: label.bottom,
			valueTop: field.top + parseFloat(getComputedStyle(control).paddingTop)
		};
	});
	expect(selected.labelBottom).toBeLessThan(selected.valueTop);

	await page.goto('/settings/account');
	const password = page.getByLabel('現在のパスワード');
	await expect(password).toBeVisible();
	const labelTop = () =>
		password.evaluate(
			(control) =>
				(control.closest('.banto-affix') ?? control).nextElementSibling!.getBoundingClientRect().top
		);
	const emptyTop = await labelTop();
	await password.focus();
	const focusedTop = await labelTop();
	expect(focusedTop).toBeCloseTo(emptyTop, 0);
	await password.fill('入力テスト');
	await password.blur();
	expect(await labelTop()).toBeCloseTo(emptyTop, 0);
	await password.fill('');
	await password.blur();
	expect(await labelTop()).toBeCloseTo(emptyTop, 0);
	await page.getByRole('button', { name: 'パスワードを変更' }).click();
	await expect(page.locator('.settings-page .error')).toBeVisible();

	await page.setViewportSize({ width: 320, height: 700 });
	await page.goto('/settings/appearance');
	// A choice made before hydration is not picked up: retry select + check.
	const english = page.getByLabel('Display language');
	await expect(async () => {
		if (!(await english.isVisible())) {
			await page.getByLabel('表示言語').selectOption('en', { timeout: 2_000 });
		}
		await expect(english).toHaveValue('en', { timeout: 2_000 });
	}).toPass();
	await page.goto('/settings/account');
	const newPassword = page.getByLabel('New password (8+ characters)');
	await newPassword.fill('abcdefgh');
	await newPassword.blur();
	const narrow = await newPassword.evaluate((control) => {
		const label = (
			control.closest('.banto-affix') ?? control
		).nextElementSibling!.getBoundingClientRect();
		const field = control.getBoundingClientRect();
		return {
			labelBottom: label.bottom,
			valueTop: field.top + parseFloat(getComputedStyle(control).paddingTop)
		};
	});
	expect(narrow.labelBottom).toBeLessThan(narrow.valueTop);
});
