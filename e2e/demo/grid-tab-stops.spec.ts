/**
 * #1016 item 5: BantoGrid is three tab stops - the grid element (the body),
 * the header row (a roving tabindex) and the bulk bar - so the bar is two
 * Tabs away from the grid element however many columns and rows there are.
 * In a real browser, on the items list of the demo build: the Tab order, the
 * arrow keys of the header, and that nothing inside a row takes a Tab. The
 * decisions themselves are unit-tested in packages/grid-svelte
 * (tests/tab-stops.test.ts).
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

/** Where the focus is, in the terms of this spec. */
type Place = 'grid' | 'header' | 'row' | 'bar' | 'outside';

test('Tab: grid element -> header -> bulk bar; the header walks with the arrow keys', async ({
	page
}) => {
	await page.goto('/items');
	const grid = page.getByRole('grid').first();
	await expect(grid).toBeVisible({ timeout: 60_000 });
	await expect(grid.locator('.row [role="gridcell"]').first()).toBeVisible({ timeout: 60_000 });
	const frame = page.locator('.banto-grid-frame').first();
	const place = (): Promise<Place> =>
		frame.evaluate((el) => {
			const focused = document.activeElement;
			const gridEl = el.querySelector('[role="grid"]');
			if (!focused || !el.contains(focused)) return 'outside';
			if (focused === gridEl) return 'grid';
			if (focused.closest('.header-row')) return 'header';
			if (focused.closest('.bulk-bar')) return 'bar';
			return focused.closest('.row') ? 'row' : 'outside';
		});

	const stops = grid.locator('.header-row [data-banto-grid-header-stop]');
	// Hydrated: the header has its one tab stop, and the rows have none.
	await expect(grid.locator('.header-row [tabindex="0"]')).toHaveCount(1);
	await expect(stops.first()).toHaveAttribute('type', 'checkbox');
	await expect(stops.first()).toHaveAttribute('tabindex', '0');
	const count = await stops.count();
	expect(count).toBeGreaterThan(4);
	await expect
		.poll(() =>
			grid.evaluate(
				(el) =>
					[
						...el.querySelectorAll<HTMLElement>(
							'.rows-block > .row :is(a[href], button, input, select, textarea, [tabindex])'
						)
					].filter((control) => control.tabIndex >= 0).length
			)
		)
		.toBe(0);

	// Select a row with the keyboard (Space on the active cell): the bar appears.
	await grid.focus();
	await expect(grid).toHaveAttribute('aria-activedescendant', /.+/);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Space');
	const bar = frame.locator('.bulk-bar');
	await expect(bar).toBeVisible();
	await expect(grid.locator('.rows-block > .row input[type="checkbox"]:checked')).toHaveCount(1);

	// Forward: two Tabs from the grid element to the bar.
	expect(await place()).toBe('grid');
	await page.keyboard.press('Tab');
	expect(await place()).toBe('header');
	await expect(stops.first()).toBeFocused();
	await page.keyboard.press('Tab');
	expect(await place()).toBe('bar');
	// Backward: the same stops.
	await page.keyboard.press('Shift+Tab');
	await expect(stops.first()).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	expect(await place()).toBe('grid');

	// The header: arrows walk every control in order, Home / End jump.
	await page.keyboard.press('Tab');
	for (let i = 1; i < count; i++) {
		await page.keyboard.press('ArrowRight');
		await expect(stops.nth(i)).toBeFocused();
	}
	await page.keyboard.press('ArrowRight');
	await expect(stops.nth(count - 1)).toBeFocused();
	await page.keyboard.press('Home');
	await expect(stops.first()).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await expect(stops.nth(2)).toBeFocused();
	await expect(grid.locator('.header-row [tabindex="0"]')).toHaveCount(1);
	await expect(stops.nth(2)).toHaveAttribute('tabindex', '0');

	// The control touched last is where Tab comes back to, from either side.
	await page.keyboard.press('Tab');
	expect(await place()).toBe('bar');
	await page.keyboard.press('Shift+Tab');
	await expect(stops.nth(2)).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	expect(await place()).toBe('grid');
	await page.keyboard.press('Tab');
	await expect(stops.nth(2)).toBeFocused();

	// The whole way through never stops in a row.
	await grid.focus();
	const seen: Place[] = [];
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('Tab');
		const at = await place();
		seen.push(at);
		if (at === 'outside') break;
	}
	expect(seen).not.toContain('row');
	expect(seen[0]).toBe('header');
	expect(seen[1]).toBe('bar');
	expect(seen.filter((at) => at === 'header')).toHaveLength(1);
});

test('the controls of a row are reached from the active cell, not with Tab', async ({ page }) => {
	await page.goto('/items');
	const grid = page.getByRole('grid').first();
	await expect(grid).toBeVisible({ timeout: 60_000 });
	const openButton = grid.locator('.rows-block > .row [data-resource-open] button').first();
	await expect(openButton).toBeVisible({ timeout: 60_000 });
	await expect(openButton).toHaveAttribute('tabindex', '-32768');

	// The mouse still focuses and presses it as before (covered by the drawer
	// specs); from the keyboard: F2 on its cell goes in, Escape comes back.
	const cell = openButton.locator('xpath=ancestor::*[@role="gridcell"][1]');
	const field = await cell.getAttribute('data-cell-field');
	expect(field).toBeTruthy();
	await grid.focus();
	await expect(grid).toHaveAttribute('aria-activedescendant', /.+/);
	for (let i = 0; i < 20; i++) {
		if ((await grid.locator('.cell.active').getAttribute('data-cell-field')) === field) break;
		await page.keyboard.press(i === 0 ? 'Home' : 'ArrowRight');
	}
	await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', field!);
	await page.keyboard.press('F2');
	await expect(openButton).toBeFocused();
	const active = await grid.getAttribute('aria-activedescendant');
	await page.keyboard.press('Escape');
	await expect(grid).toBeFocused();
	await expect(grid).toHaveAttribute('aria-activedescendant', active!);
	// Shift+Tab from the control goes to the grid element, not to the header.
	await page.keyboard.press('F2');
	await expect(openButton).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(grid).toBeFocused();
});
