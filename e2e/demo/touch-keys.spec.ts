/**
 * `@banto/touch-keys-svelte` on the /ui-demo TouchKeysHost card (#937 T7,
 * touch-keypad-design §4.2 b), in a real browser and inside the real app shell:
 * the number keypad, the alphanumeric and kana keyboards, the masked password
 * keyboard, the `enabled` switch and the card-only `resolve`. The keys' own
 * behaviour (outside taps, layers, hardware keys, touch) is covered by the
 * package's browser fixture (`pnpm e2e:touch-keys`); this file proves the wiring
 * into the template - the Paraglide bundle, `bind:value` and the app's CSS.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 * `pnpm scaffold` deletes this file together with the card.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

const surface = (page: Page): Locator => page.locator('[data-touch-keys-surface]');
const key = (page: Page, name: string): Locator =>
	surface(page).getByRole('button', { name, exact: true });

async function press(page: Page, keys: string[]): Promise<void> {
	for (const k of keys) await key(page, k).click();
}

async function openCard(page: Page): Promise<Locator> {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-touch-keys');
	await expect(card.locator('#ui-demo-touch-qty')).toBeVisible({ timeout: 60_000 });
	await card.scrollIntoViewIfNeeded();
	return card;
}

/** Hydration is late on the dev server: retry the press until the keys open. */
async function openKeys(page: Page, field: Locator): Promise<void> {
	await expect(async () => {
		await field.click();
		await expect(surface(page)).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
}

test('a number field opens the keypad; confirm writes through bind:value', async ({ page }) => {
	const card = await openCard(page);
	const qty = card.locator('#ui-demo-touch-qty');
	await openKeys(page, qty);
	// The heading comes from the Paraglide bundle (ja) and the field's label.
	await expect(surface(page).getByRole('group', { name: /^テンキー 数量/ })).toBeVisible();
	await expect(surface(page)).toHaveAttribute('data-touch-keys-surface', 'popup');

	await press(page, ['全部消す', '4', '2', '確定']);
	await expect(surface(page)).toHaveCount(0);
	await expect(qty).toHaveValue('42');
	await expect(card.getByTestId('ui-demo-touch-qty-value')).toContainText('42');

	// Out of range (max 999): confirm stays disabled, cancel writes nothing.
	await openKeys(page, qty);
	await press(page, ['全部消す', '1', '0', '0', '0']);
	await expect(key(page, '確定')).toBeDisabled();
	await press(page, ['取り消し']);
	await expect(surface(page)).toHaveCount(0);
	await expect(qty).toHaveValue('42');
});

test('a text field opens the alphanumeric keyboard, docked to the bottom', async ({ page }) => {
	const card = await openCard(page);
	const lot = card.locator('#ui-demo-touch-lot');
	await openKeys(page, lot);
	await expect(surface(page)).toHaveAttribute('data-touch-keys-surface', 'bottom');
	// layouts: ['alnum'] only - no kana on this field.
	await expect(key(page, 'カナ')).toHaveCount(0);

	await press(page, ['a', 'b', '1', '確定']);
	await expect(surface(page)).toHaveCount(0);
	await expect(lot).toHaveValue('ab1');
	await expect(card.getByTestId('ui-demo-touch-lot-value')).toContainText('ab1');
});

test('the kana field starts on kana; dakuten replaces the last character', async ({ page }) => {
	const card = await openCard(page);
	const kana = card.locator('#ui-demo-touch-kana');
	await openKeys(page, kana);
	await expect(key(page, 'カナ')).toHaveAttribute('aria-pressed', 'true');

	await press(page, ['カ', '濁点', 'ツ', '小書き', '確定']);
	await expect(kana).toHaveValue('ガッ');
	await expect(card.getByTestId('ui-demo-touch-kana-value')).toContainText('ガッ');
});

test('the password field gets masked keys: the draft shows no plain text', async ({ page }) => {
	const card = await openCard(page);
	const password = card.locator('#ui-demo-touch-password');
	await openKeys(page, password);
	// Kana never reaches a password keyboard (design §5.5).
	await expect(key(page, 'カナ')).toHaveCount(0);

	await press(page, ['a', 'b', 'c']);
	await expect(surface(page).getByTestId('draft')).not.toContainText('abc');
	await press(page, ['確定']);
	await expect(surface(page)).toHaveCount(0);
	await expect(password).toHaveValue('abc');
	await expect(card.getByTestId('ui-demo-touch-password-length')).toContainText('3');
});

test('the switch turns the keys off; fields outside the card never get them', async ({ page }) => {
	const card = await openCard(page);
	const qty = card.locator('#ui-demo-touch-qty');
	await openKeys(page, qty);
	await press(page, ['取り消し']);
	await expect(surface(page)).toHaveCount(0);

	// `resolve` limits the host to the card: another sample's field stays plain.
	const due = page.locator('#ui-demo-due-date');
	await due.scrollIntoViewIfNeeded();
	await due.click();
	await expect(due).toBeFocused();
	await expect(surface(page)).toHaveCount(0);

	await card.scrollIntoViewIfNeeded();
	await card.getByTestId('ui-demo-touch-keys-enabled').uncheck();
	await qty.click();
	await expect(qty).toBeFocused();
	await expect(surface(page)).toHaveCount(0);
	// A plain field again: the hardware keyboard types into it.
	await qty.fill('7');
	await expect(card.getByTestId('ui-demo-touch-qty-value')).toContainText('7');
});
