/**
 * BantoForm layout (#714) on the /ui-demo form card, in a real browser:
 * `visibleWhen` shows a field and keeps a hidden one out of the submit, the
 * help text is the control's accessible description, and the columns fall
 * back to one on a narrow width. The pure decisions are unit-tested in
 * packages/forms.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

test('a hidden field is not submitted and the condition shows it', async ({ page }) => {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-form');
	const name = card.getByLabel('名称');
	await expect(name).toBeVisible({ timeout: 60_000 });
	await name.scrollIntoViewIfNeeded();

	const gift = card.getByLabel('ギフト包装');
	const wrap = card.getByLabel('包装メッセージ');
	await expect(wrap).toHaveCount(0);

	// Hydration is late on the dev server: retry until the checkbox reacts.
	await expect(async () => {
		if (!(await gift.isChecked())) await gift.click();
		await expect(wrap).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await wrap.fill('おめでとう');
	await gift.uncheck();
	await expect(wrap).toHaveCount(0);

	await name.fill('見本');
	await card.getByRole('button', { name: '送信' }).click();
	const submitted = page.getByTestId('ui-demo-form-submitted');
	await expect(submitted).toContainText('name');
	// The hidden field's key never reaches onSubmit (and its `required` did not block it).
	await expect(submitted).not.toContainText('wrap');

	// Shown again, it is required and its typed text is still there.
	await gift.check();
	await expect(wrap).toHaveValue('おめでとう');
});

test('the help text describes its control', async ({ page }) => {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-form');
	const name = card.getByLabel('名称');
	await expect(name).toBeVisible({ timeout: 60_000 });
	await expect(name).toHaveAccessibleDescription('40 文字まで。');
	// The section is a named group with its own description.
	const basics = card.getByRole('group', { name: '基本情報' });
	await expect(basics).toHaveAccessibleDescription('必須の項目を先に置く。');
});

test('two columns on a wide form, one column when narrow', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-form');
	const name = card.getByLabel('名称');
	const code = card.getByLabel('コード');
	await expect(name).toBeVisible({ timeout: 60_000 });
	await name.scrollIntoViewIfNeeded();

	const wide = [(await name.boundingBox())!, (await code.boundingBox())!];
	expect(wide[1].y).toBeLessThan(wide[0].y + wide[0].height);
	expect(wide[1].x).toBeGreaterThan(wide[0].x + wide[0].width - 1);

	await page.setViewportSize({ width: 420, height: 900 });
	await expect(async () => {
		const a = (await name.boundingBox())!;
		const b = (await code.boundingBox())!;
		expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
		expect(Math.abs(b.x - a.x)).toBeLessThan(2);
	}).toPass({ timeout: 10_000 });
});
