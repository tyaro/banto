/**
 * app.html's static "loading" line (Issue #1024) exists only so a screen reader never meets an
 * empty document (NVDA then reads the URL). Once the app is drawn it must be gone, in the main
 * window's pages and in the pop-out panel window's page alike. No pixels.
 *
 * Its wording is the dictionary's `common.loading` (conventions §13), put into the static shell
 * by `src/hooks.server.ts` when the shell is rendered. So nothing here spells the wording out:
 * the expected text is read from `messages/<locale>.json`, for every locale of `project.inlang`.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

const APP = new URL('../../apps/admin-template/', import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, APP), 'utf8'));

const locales: string[] = readJson('project.inlang/settings.json').locales;
const loading: Record<string, string> = Object.fromEntries(
	locales.map((locale) => [locale, readJson(`messages/${locale}.json`)['common.loading']])
);

for (const path of ['/dashboard', '/panel/monthly']) {
	test(`the static loading line does not remain once drawn (${path})`, async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await page.goto(path);
		await expect(
			page.locator('main, [data-dock-host], header, [role="banner"]').first()
		).toBeVisible();
		await expect(page.locator('#banto-boot-status')).toHaveCount(0);
	});
}

test('the shell carries the loading wording of every locale, from the dictionary', async ({
	page
}) => {
	await page.route('**/*.js', (route) => route.abort());
	await page.goto('/dashboard');
	const carried = await page.locator('#banto-boot-status').getAttribute('data-messages');
	expect(JSON.parse(carried ?? '')).toEqual(loading);
	for (const locale of locales) expect(loading[locale]).toBeTruthy();
	// Nothing stored: the line is still not empty (the default display locale's wording).
	await expect(page.locator('#banto-boot-status')).toHaveText(
		loading[(await page.locator('html').getAttribute('lang')) ?? '']
	);
});

for (const locale of locales) {
	test(`the static loading line follows the locale before the app draws (${locale})`, async ({
		page
	}) => {
		await page.addInitScript((l) => localStorage.setItem('banto.locale', l), locale);
		await page.route('**/*.js', (route) => route.abort());
		await page.goto('/dashboard');
		await expect(page.locator('html')).toHaveAttribute('lang', locale);
		await expect(page.locator('#banto-boot-status')).toHaveText(loading[locale]);
	});
}
