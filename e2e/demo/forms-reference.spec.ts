/**
 * BantoForm reference type (#714) on the /ui-demo reference card, in a real
 * browser: typing lists the candidates, arrows + Enter pick one, the id is
 * what is submitted, Esc closes, nothing found is said, and a mouse click
 * picks (the press must not blur the box first). The races and the rest of
 * the decisions are unit-tested in packages/forms.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

async function openReference(page: Page) {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-reference');
	const owner = card.getByRole('combobox', { name: /担当者/ });
	await expect(owner).toBeVisible({ timeout: 60_000 });
	// The deputy's name is resolved from its stored id once the page hydrated.
	await expect(card.getByRole('combobox', { name: '代理' })).toHaveValue('Inoue Mei', {
		timeout: 60_000
	});
	await card.scrollIntoViewIfNeeded();
	return { card, owner };
}

/** Type into the box and wait for the list (the top-layer popover) to open. */
async function search(page: Page, box: Locator, text: string) {
	await box.fill(text);
	await expect(box).toHaveAttribute('aria-expanded', 'true');
	return page.getByRole('listbox', { name: '担当者の候補' });
}

/** The panel the list and the messages are in. */
const panel = (page: Page) => page.locator('[data-reference-list]');

test('typing lists the candidates; arrows and Enter pick one; the id is submitted', async ({
	page
}) => {
	const { card, owner } = await openReference(page);
	const list = await search(page, owner, 'ao');
	await expect(list.getByRole('option')).toHaveText([/Aoki Sakura/, /Aoyama Ken/]);
	await expect(owner).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);
	// The list is as wide as the box and right under it.
	const boxRect = (await owner.boundingBox())!;
	const listRect = (await panel(page).boundingBox())!;
	expect(Math.abs(listRect.x - boxRect.x)).toBeLessThan(1);
	expect(Math.abs(listRect.width - boxRect.width)).toBeLessThan(1);
	expect(listRect.y).toBeGreaterThanOrEqual(boxRect.y + boxRect.height);

	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	const second = list.getByRole('option').nth(1);
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(owner).toHaveAttribute('aria-activedescendant', (await second.getAttribute('id'))!);
	await expect(owner).toBeFocused();

	// Enter picks and does not submit the form.
	await page.keyboard.press('Enter');
	await expect(owner).toHaveValue('Aoyama Ken');
	await expect(list).toBeHidden();
	await expect(owner).toHaveAttribute('aria-expanded', 'false');
	const values = page.getByTestId('ui-demo-reference-values');
	await expect(values).toHaveText('まだ無い');

	await card.getByRole('button', { name: '送信' }).click();
	await expect(values).toHaveText('{"owner":102,"deputy":103}');
});

test('Esc closes the list; typed text alone is not a value', async ({ page }) => {
	const { card, owner } = await openReference(page);
	const list = await search(page, owner, 'sato');
	await expect(list.getByRole('option')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(list).toBeHidden();
	await expect(owner).toHaveValue('sato');
	await expect(owner).toBeFocused();

	// Leaving without a pick: the text goes, and the required field is empty.
	await page.keyboard.press('Tab');
	await expect(owner).toHaveValue('');
	await card.getByRole('button', { name: '送信' }).click();
	await expect(card.locator('.error')).toHaveText('必須項目です');
	await expect(page.getByTestId('ui-demo-reference-values')).toHaveText('まだ無い');
});

test('says when nothing matches', async ({ page }) => {
	const { card, owner } = await openReference(page);
	await owner.fill('zzz');
	await expect(panel(page)).toHaveText('「zzz」に該当する候補がありません');
	// No listbox without options, so the combobox is not expanded.
	await expect(page.getByRole('option')).toHaveCount(0);
	await expect(owner).toHaveAttribute('aria-expanded', 'false');
	// The same text is read out (role="status") while the panel shows it.
	await expect(card.locator('[data-reference-status]').first()).toHaveText(
		'「zzz」に該当する候補がありません'
	);
	await page.keyboard.press('Escape');
	await expect(panel(page)).toBeHidden();
	await expect(card.locator('[data-reference-status]').first()).toHaveText('');
});

test('a mouse click picks an option, and clearing the box clears the value', async ({ page }) => {
	const { card, owner } = await openReference(page);
	const list = await search(page, owner, 'tokyo');
	await expect(list.getByRole('option')).toHaveCount(3);
	await list.getByRole('option', { name: /Suzuki Ren/ }).click();
	await expect(owner).toHaveValue('Suzuki Ren');
	await expect(owner).toBeFocused();
	await expect(list).toBeHidden();

	// The deputy opens on a stored id: empty it and leave -> null.
	const deputy = card.getByRole('combobox', { name: '代理' });
	await deputy.fill('');
	await page.keyboard.press('Escape');
	await card.getByRole('button', { name: '送信' }).click();
	await expect(page.getByTestId('ui-demo-reference-values')).toHaveText(
		'{"owner":106,"deputy":null}'
	);
});
