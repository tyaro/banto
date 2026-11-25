/** Isolated auth HTTP responses keep the login form's coverage independent of a DB. */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeTheme } from './theme';

async function labelBounds(control: Locator) {
	return control.evaluate((element) => {
		// A password box sits in a `.banto-affix` wrapper (PasswordInput): its label follows the wrapper.
		const anchor = element.closest('.banto-affix') ?? element;
		const label = anchor.nextElementSibling!.getBoundingClientRect();
		const field = element.getBoundingClientRect();
		return {
			top: label.top,
			bottom: label.bottom,
			valueTop: field.top + parseFloat(getComputedStyle(element).paddingTop)
		};
	});
}

async function clearOfValue(control: Locator) {
	const box = await labelBounds(control);
	expect(box.bottom).toBeLessThan(box.valueTop);
}

async function stubAuth(page: Page) {
	const submissions: Record<string, unknown>[] = [];
	await page.route('**/api/auth/check', (route) =>
		route.fulfill({ status: 401, json: { kind: 'unauthorized', message: 'Not signed in' } })
	);
	await page.route('**/api/auth/identity', (route) =>
		route.fulfill({ status: 401, json: { kind: 'unauthorized', message: 'Not signed in' } })
	);
	await page.route('**/api/auth/status', (route) => route.fulfill({ json: { grants: {} } }));
	await page.route('**/api/auth/login', async (route) => {
		submissions.push(route.request().postDataJSON());
		await route.fulfill({
			status: 401,
			json: { kind: 'other', message: 'Credentials rejected for this test' }
		});
	});
	return submissions;
}

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	{
		test(`login controls keep labels and keyboard submission at 320px (${locale})`, async ({
			page
		}) => {
			await page.setViewportSize({ width: 320, height: 700 });
			await primeTheme(page, DIAGONAL_MATRIX[index]);
			await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
			const submissions = await stubAuth(page);
			await page.goto('/login');
			const username = page.getByRole('textbox', { name: copy['common.username'], exact: true });
			await expect(username).toBeVisible();
			await expect(username).toHaveAttribute('autocomplete', 'username');
			const empty = await labelBounds(username);
			await username.focus();
			expect((await labelBounds(username)).top).toBeLessThan(empty.top);
			await username.fill('operator');
			await username.blur();
			await clearOfValue(username);
			await username.fill('');
			await username.blur();
			expect((await labelBounds(username)).top).toBeCloseTo(empty.top, 0);

			// Check the inner field width and both sides of the card breakpoint.
			await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
			for (const width of [320, 481, 768, 961, 1440]) {
				await page.setViewportSize({ width, height: 700 });
				for (const control of await page.locator('.banto-field-control').all()) {
					await control.fill('input-value');
					await clearOfValue(control);
				}
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					width
				);
			}
			await page.setViewportSize({ width: 320, height: 700 });
			await username.fill('operator');
			const password = page.getByLabel(copy['common.password'], { exact: true });
			await expect(password).toHaveAttribute('autocomplete', 'current-password');
			// One form only: no account-creation fields (there is no first-run setup).
			await expect(page.locator('input[autocomplete="new-password"]')).toHaveCount(0);

			const alert = page.locator('form').getByRole('alert');
			await username.focus();
			await username.press('Tab');
			await expect(password).toBeFocused();
			await password.fill('password-for-test');
			// The eye button (#944): Tab after the box, a press swaps the type, never submits.
			await expect(password).toHaveAttribute('type', 'password');
			const reveal = page.getByRole('button', { name: copy['passwordInput.show'], exact: true });
			await expect(reveal).toHaveAttribute('aria-pressed', 'false');
			await password.press('Tab');
			await expect(reveal).toBeFocused();
			await reveal.press('Enter');
			await expect(password).toHaveAttribute('type', 'text');
			await expect(password).toHaveValue('password-for-test');
			const hide = page.getByRole('button', { name: copy['passwordInput.hide'], exact: true });
			await expect(hide).toHaveAttribute('aria-pressed', 'true');
			expect(submissions).toEqual([]);
			expect(
				(await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations
			).toEqual([]);
			await hide.press('Space');
			await expect(password).toHaveAttribute('type', 'password');
			const remember = page.getByRole('checkbox', { name: copy['auth.remember'], exact: true });
			await reveal.press('Tab');
			await expect(remember).toBeFocused();
			await page.getByText(copy['auth.remember'], { exact: true }).click();
			await expect(remember).toBeChecked();
			await remember.press('Space');
			await expect(remember).not.toBeChecked();
			await remember.press('Space');
			await remember.press('Tab');
			await expect(
				page.getByRole('button', { name: copy['auth.login'], exact: true })
			).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(alert).toHaveText('Credentials rejected for this test');
			expect(submissions).toEqual([
				{ username: 'operator', password: 'password-for-test', remember: true }
			]);
			await remember.uncheck();
			await page.getByRole('button', { name: copy['auth.login'], exact: true }).click();
			await expect.poll(() => submissions.length).toBe(2);
			expect(submissions[1]).toEqual({ username: 'operator', password: 'password-for-test' });
			const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
			expect(results.violations).toEqual([]);
		});
	}
}
