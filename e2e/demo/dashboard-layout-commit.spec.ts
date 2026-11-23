/**
 * Saving the dashboard's `DockHost` layout from `onLayoutCommit` alone (#791 K4,
 * docs/design/downstream-requests-2026-11-plan.md §4.6), in a real browser: the page no longer
 * reads `dock.serialize()` from an effect - `@banto/dock-svelte`'s `createDockLayoutStore` takes
 * what the host reports. The seeded default is not written to the provider; a change that is not
 * a drag (a View menu checkbox = `setPanelVisible`) is saved once; "reset layout" is one write
 * (reason `'reset'`, never a second one as `'user'`); the saved layout comes back after a reload.
 *
 * In demo mode both copies are in localStorage: the store's first-paint copy (written at once)
 * and the `UiSettingsProvider` copy (500ms after the last report). Every write of either is
 * recorded by an init script.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

const LAYOUT_KEY = 'banto.dock.dashboard:acct:demo';
const PROVIDER_KEY = 'banto.ui.dock.dashboard';
const PANEL = 'トレンド';

async function writes(page: Page, key: string): Promise<string[]> {
	return page.evaluate(
		(k) =>
			(window as unknown as { __layoutWrites: { key: string; value: string }[] }).__layoutWrites
				.filter((w) => w.key === k)
				.map((w) => w.value),
		key
	);
}

const stored = (page: Page, key: string): Promise<string | null> =>
	page.evaluate((k) => window.localStorage.getItem(k), key);

async function openViewMenu(page: Page): Promise<Locator> {
	await page.getByRole('main').getByRole('button', { name: '表示', exact: true }).click();
	const menu = page.getByRole('menu', { name: '表示' });
	await expect(menu).toBeVisible();
	return menu;
}

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.addInitScript(
		({ keys }) => {
			const w = window as unknown as { __layoutWrites: { key: string; value: string }[] };
			w.__layoutWrites = [];
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (keys.includes(key)) w.__layoutWrites.push({ key, value });
				setItem.call(this, key, value);
			};
		},
		{ keys: [LAYOUT_KEY, PROVIDER_KEY] }
	);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/dashboard');
	await expect(page.locator('[data-dock-host]')).toBeVisible({ timeout: 60_000 });
	// The default is seeded once the host is measured, and mirrored into the first-paint copy.
	await expect.poll(() => stored(page, LAYOUT_KEY)).toContain('"docked":{');
});

test('the seeded default is not saved; a View menu change and a reset are one write each; a reload restores', async ({
	page
}) => {
	const host = page.locator('[data-dock-host]');
	const seeded = await stored(page, LAYOUT_KEY);
	// Longer than the debounce: the default the store put in is not a user's change.
	await page.waitForTimeout(800);
	expect(await stored(page, PROVIDER_KEY)).toBeNull();

	// Show one more pane from the View menu (`setPanelVisible`, not a gesture): the default has it closed.
	const menu = await openViewMenu(page);
	const checkbox = menu.getByRole('menuitemcheckbox', { name: PANEL, exact: true });
	await expect(checkbox).toHaveAttribute('aria-checked', 'false');
	await checkbox.click();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect.poll(() => stored(page, LAYOUT_KEY)).not.toBe(seeded);
	const changed = await stored(page, LAYOUT_KEY);
	await expect.poll(() => stored(page, PROVIDER_KEY)).toBe(changed);
	await page.waitForTimeout(800);
	expect(await writes(page, PROVIDER_KEY)).toEqual([changed]);

	// The saved layout is what a reload shows (the provider's copy wins).
	await page.reload();
	await expect(host).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => stored(page, LAYOUT_KEY)).toBe(changed);
	await page.waitForTimeout(800);
	// Applying the saved layout is not a change to save.
	expect(await writes(page, PROVIDER_KEY)).toEqual([]);
	const again = await openViewMenu(page);
	await expect(again.getByRole('menuitemcheckbox', { name: PANEL, exact: true })).toHaveAttribute(
		'aria-checked',
		'true'
	);

	// "Reset layout": one write of the default (`'reset'`), not followed by a `'user'` one.
	await again.getByRole('menuitem', { name: 'レイアウトを既定に戻す', exact: true }).click();
	await expect(again).toHaveCount(0);
	await expect.poll(() => stored(page, PROVIDER_KEY)).not.toBe(changed);
	await page.waitForTimeout(800);
	const reset = await writes(page, PROVIDER_KEY);
	expect(reset).toHaveLength(1);
	expect(await stored(page, LAYOUT_KEY)).toBe(reset[0]);
	const after = await openViewMenu(page);
	await expect(after.getByRole('menuitemcheckbox', { name: PANEL, exact: true })).toHaveAttribute(
		'aria-checked',
		'false'
	);
});
