/**
 * The "見本" nav group (nav-menubar-plan.md D7-b, §4.10, §7.2) in the menu bar
 * layout. The group holds the demo-only entries (`/ui-demo`, `/chart-gallery`, `/theme-lab`),
 * so it exists only in a demo build: this runs in the `demo` project (`vite
 * dev` with VITE_BANTO_DEMO=1). The production-build behaviour of the bar is
 * in visual/menubar.spec.ts. Depends on the template's demo entries - a
 * derived app without them drops this file.
 *
 * The dev server hydrates late, so the first click is retried inside
 * `toPass()` until the dropdown is open.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeMenubar, primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

function mainNav(page: Page): Locator {
	return page.getByRole('navigation', { name: '主要ナビゲーション' });
}

async function openDropdown(button: Locator, link: Locator): Promise<void> {
	await expect(async () => {
		if (!(await link.isVisible())) await button.click({ timeout: 2_000 });
		await expect(link).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await primeMenubar(page);
});

test('the 見本 group opens, its links navigate, and the button shows the current page', async ({
	page
}) => {
	await page.goto('/dashboard');
	const nav = mainNav(page);
	const group = nav.getByRole('button', { name: '見本' });
	const uiDemo = nav.getByRole('link', { name: 'UI 部品の見本' });
	const gallery = nav.getByRole('link', { name: 'チャート見本' });
	await expect(group).toHaveAttribute('aria-expanded', 'false');
	// The group's links are not on the top row.
	await expect(uiDemo).toHaveCount(0);

	await openDropdown(group, uiDemo);
	await expect(group).toHaveAttribute('aria-expanded', 'true');
	await expect(gallery).toBeVisible();
	// Arrow keys move inside the open dropdown (D3-c).
	await page.keyboard.press('ArrowDown');
	await expect(uiDemo).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(gallery).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(gallery).toBeHidden();
	await expect(group).toBeFocused();

	await openDropdown(group, gallery);
	await gallery.click();
	await expect(page).toHaveURL(/\/chart-gallery$/);
	await expect(group).toHaveClass(/active/);
	// aria-current is on the link only, never on the group button (§4.8).
	await expect(group).not.toHaveAttribute('aria-current', /.*/);
	await openDropdown(group, gallery);
	await expect(gallery).toHaveAttribute('aria-current', 'page');
});

test('narrower: a group moved into その他 keeps its heading, links listed flat (D2-a)', async ({
	page
}) => {
	await page.goto('/dashboard');
	// A fixed, small room for the bar (above the "その他" button's width): the
	// overflow is then certain whatever the OS fonts (visual/menubar.spec.ts).
	await page.addStyleTag({ content: 'header .menubar { max-width: 280px; }' });
	const nav = mainNav(page);
	const more = nav.getByRole('button', { name: /その他/ });
	const section = nav.getByRole('group', { name: '見本' });
	const uiDemo = section.getByRole('link', { name: 'UI 部品の見本' });
	await openDropdown(more, uiDemo);
	await expect(section.getByRole('link', { name: 'チャート見本' })).toBeVisible();
	await uiDemo.click();
	await expect(page).toHaveURL(/\/ui-demo$/);
	await expect(more).toHaveClass(/active/);
});
