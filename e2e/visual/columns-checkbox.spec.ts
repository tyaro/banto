/** The column menu is a Menu of menuitemcheckbox items: it stays open on pick, keeps the last-column lock and returns focus to its trigger. Its second group pins columns to the left (#713). */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

for (const [index, locale] of ['ja', 'en'].entries()) {
	const copy: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(`../../apps/admin-template/messages/${locale}.json`, import.meta.url),
			'utf8'
		)
	);
	test(`column menu items preserve keyboard interaction and the last visible column (${locale})`, async ({
		page
	}) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[index]);
		await page.addInitScript((locale) => localStorage.setItem('banto.locale', locale), locale);
		await page.goto('/items');
		const trigger = page.getByRole('button', { name: copy['grid.columnsMenuButton'] });
		const menu = page.getByRole('menu', { name: copy['grid.columnsMenuTitle'], exact: true });
		// The press can land before hydration, so retry the open.
		await expect(async () => {
			await trigger.focus();
			await trigger.press('Enter');
			await expect(menu).toBeVisible({ timeout: 1000 });
		}).toPass();
		// The "shown columns" group; the group after it pins columns (#713).
		const items = menu
			.getByRole('group', { name: copy['resource.columnsShowGroup'], exact: true })
			.getByRole('menuitemcheckbox');
		expect(await items.count()).toBeGreaterThan(2);
		const first = items.first();
		await expect(first).toBeFocused();
		// The focused item is marked by the hover background (MenuItem has no outline).
		await expect(first).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		// Picking an item toggles it and leaves the menu open.
		await first.press('Space');
		await expect(first).toHaveAttribute('aria-checked', 'false');
		await expect(menu).toBeVisible();
		await first.press('Space');
		await expect(first).toHaveAttribute('aria-checked', 'true');
		for (const item of (await items.all()).slice(0, -1)) await item.click();
		const last = items.last();
		await expect(last).toHaveAttribute('aria-checked', 'true');
		await expect(last).toBeDisabled();
		await expect(last).toHaveAttribute('title', copy['grid.columnsMenuLastColumn']);
		await page.emulateMedia({ forcedColors: 'active' });
		await first.focus();
		// Re-enter by keyboard (the clicks above dropped focus-visible), then check
		// that forced colors still mark the focused item with a solid outline.
		await page.keyboard.press('End');
		await page.keyboard.press('Home');
		await expect(first).toBeFocused();
		await expect(first).toHaveCSS('outline-style', 'solid');
		await expect(first).toHaveCSS('outline-width', '2px');
		await first.press('Space');
		await expect(first).toHaveAttribute('aria-checked', 'true');
		await expect(last).toBeEnabled();
		// Pinning the last column moves it to the front of both groups (the menu
		// lists pinned columns first, like the grid). The menu stays open and
		// focus stays on the picked item although its node moved.
		const pins = menu
			.getByRole('group', { name: copy['resource.columnsPinGroup'], exact: true })
			.getByRole('menuitemcheckbox');
		await expect(pins).toHaveCount(await items.count());
		const pinName = (await pins.last().innerText()).trim();
		await expect(pins.last()).toHaveAttribute('aria-checked', 'false');
		await pins.last().focus();
		await pins.last().press('Space');
		await expect(pins.first()).toHaveText(pinName);
		await expect(pins.first()).toHaveAttribute('aria-checked', 'true');
		await expect(pins.first()).toBeFocused();
		await expect(items.first()).toHaveText(pinName);
		await expect(menu).toBeVisible();
		// Unpinning puts it back in its slot.
		await pins.first().press('Space');
		await expect(pins.last()).toHaveText(pinName);
		await expect(pins.last()).toHaveAttribute('aria-checked', 'false');
		await expect(pins.last()).toBeFocused();
		await first.press('Escape');
		await expect(menu).toBeHidden();
		await expect(trigger).toBeFocused();
	});
}
