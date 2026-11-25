/**
 * `@banto/grid-svelte` + `@banto/touch-keys-svelte` wired by the app (#964 W1,
 * grid-touch-edit-design §9): the grid of the /ui-demo TouchKeysHost card, with
 * the real `TouchKeysHost` and real touch input. The two packages do not know
 * each other; the card's `resolve` (`openOnFocus` on `data-grid-editor`) and
 * `onconfirm` (blur that editor) are the whole wiring, and only this file sees
 * them work together:
 *
 * - one tap starts the edit AND opens the keys (the host's `openOnFocus`
 *   window is long enough for the grid's click handler and Svelte's flush),
 * - the keys' confirm commits the cell without moving, focus back on the grid,
 * - a refused save keeps the draft, a slow save does not steal focus back,
 * - the keys' cancel closes only the keys; a physical Esc closes both.
 *
 * Each package's own behaviour is covered next to it (`e2e/visual/grid-tap-edit`,
 * `pnpm e2e:touch-keys`). Runs against `vite dev` with VITE_BANTO_DEMO=1 (the
 * `demo` project). `pnpm scaffold` deletes this file together with the card.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);
test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

const surface = (page: Page): Locator => page.locator('[data-touch-keys-surface]');
const key = (page: Page, name: string): Locator =>
	surface(page).getByRole('button', { name, exact: true });

async function tapKeys(page: Page, keys: string[]): Promise<void> {
	for (const k of keys) await key(page, k).tap();
}

interface Sample {
	card: Locator;
	grid: Locator;
	cell: (row: number, field: string) => Locator;
}

/**
 * Opens the card and waits until the page is hydrated. Hydration is late on the
 * dev server, and the proof must not touch the grid: a retried tap on a cell
 * would hide a first tap that started the edit without opening the keys. So the
 * retry runs on the card's plain quantity field, and the grid gets ONE tap.
 */
async function openSample(page: Page): Promise<Sample> {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-touch-keys');
	const qty = card.locator('#ui-demo-touch-qty');
	await expect(qty).toBeVisible({ timeout: 60_000 });
	await expect(async () => {
		await qty.tap();
		await expect(surface(page)).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 60_000 });
	await key(page, '取り消し').tap();
	await expect(surface(page)).toHaveCount(0);

	const grid = card.getByRole('grid');
	await grid.scrollIntoViewIfNeeded();
	return {
		card,
		grid,
		cell: (row, field) => grid.locator(`[data-cell-row="${row}"][data-cell-field="${field}"]`)
	};
}

test('one tap opens the keypad on the cell; confirm commits it and the grid keeps focus', async ({
	page
}) => {
	const { grid, cell } = await openSample(page);

	// A mouse click only selects: no editor, no keys.
	await cell(1, 'qty').click();
	await expect(cell(1, 'qty')).toHaveClass(/active/);
	await expect(grid.locator('[data-grid-editor]')).toHaveCount(0);
	await expect(surface(page)).toHaveCount(0);

	// One tap: the editor and the keypad (the number column is `type="number"`).
	await cell(0, 'qty').tap();
	const editor = cell(0, 'qty').getByRole('spinbutton');
	await expect(editor).toBeFocused();
	await expect(surface(page)).toBeVisible();
	await expect(surface(page).getByRole('group', { name: /^テンキー/ })).toBeVisible();

	await tapKeys(page, ['全部消す', '5', '0', '確定']);
	await expect(surface(page)).toHaveCount(0);
	await expect(grid.locator('[data-grid-editor]')).toHaveCount(0);
	await expect(cell(0, 'qty')).toHaveText('50');
	// No move: the edited cell stays active and the arrow keys go on from it.
	await expect(grid).toBeFocused();
	await expect(cell(0, 'qty')).toHaveClass(/active/);
	await page.keyboard.press('ArrowDown');
	await expect(cell(1, 'qty')).toHaveClass(/active/);

	// Started from the keyboard (Enter), the edit opens no keys; a mouse
	// double-click is a pointer-made click like the tap, so it does.
	await page.keyboard.press('Enter');
	await expect(cell(1, 'qty').getByRole('spinbutton')).toBeFocused();
	await expect(surface(page)).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(grid.locator('[data-grid-editor]')).toHaveCount(0);
	await cell(2, 'qty').dblclick();
	await expect(cell(2, 'qty').getByRole('spinbutton')).toBeFocused();
	await expect(surface(page)).toBeVisible();
});

test('a refused save keeps the draft with its error; the keys reopen on the editor', async ({
	page
}) => {
	const { grid, cell } = await openSample(page);
	await cell(1, 'qty').tap();
	await expect(surface(page)).toBeVisible();
	// Over the stock of 500: the sample's save throws.
	await tapKeys(page, ['全部消す', '9', '9', '9', '確定']);
	await expect(surface(page)).toHaveCount(0);

	const editor = cell(1, 'qty').getByRole('spinbutton');
	await expect(editor).toHaveValue('999');
	await expect(editor).toHaveAttribute('aria-invalid', 'true');
	// The error region is drawn outside the grid's scroller.
	await expect(page.getByRole('alert').filter({ hasText: '500' })).toBeVisible();
	await expect(editor).toBeFocused();

	// A tap on the editor opens the keys on the draft as it is now.
	await editor.tap();
	await expect(surface(page)).toBeVisible();
	await tapKeys(page, ['全部消す', '6', '0', '確定']);
	await expect(grid.locator('[data-grid-editor]')).toHaveCount(0);
	await expect(cell(1, 'qty')).toHaveText('60');
	await expect(grid).toBeFocused();
});

test('the keys’ cancel closes only the keys; a physical Escape closes the edit as well', async ({
	page
}) => {
	const { grid, cell } = await openSample(page);
	await cell(2, 'qty').tap();
	const editor = cell(2, 'qty').getByRole('spinbutton');
	await expect(surface(page)).toBeVisible();

	await tapKeys(page, ['全部消す', '7', '取り消し']);
	await expect(surface(page)).toHaveCount(0);
	// The edit is as it was before the keys opened: still open, the value untouched.
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue('8');

	// Keys open again, then one Escape on the hardware keyboard: the grid takes
	// it (the editor has focus), the editor goes away and the keys follow it.
	await editor.tap();
	await expect(surface(page)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(surface(page)).toHaveCount(0);
	await expect(grid.locator('[data-grid-editor]')).toHaveCount(0);
	await expect(cell(2, 'qty')).toHaveText('8');
	await expect(grid).toBeFocused();
	await expect(cell(2, 'qty')).toHaveClass(/active/);
});

test('a text cell gets the text keyboard; focus moved during a slow save stays where it went', async ({
	page
}) => {
	const { card, grid, cell } = await openSample(page);
	await cell(2, 'lot').tap();
	await expect(cell(2, 'lot').getByRole('textbox')).toBeFocused();
	await expect(surface(page)).toHaveAttribute('data-touch-keys-surface', 'bottom');

	// The lot column saves after a short wait. The switch is tapped meanwhile:
	// the save's end must not pull focus back to the grid.
	await tapKeys(page, ['a', 'b', '確定']);
	const toggle = card.getByTestId('ui-demo-touch-keys-enabled');
	await toggle.tap();
	await expect(cell(2, 'lot')).toHaveText('ab');
	await expect(grid.locator('[data-grid-editor]')).toHaveCount(0);
	await expect(toggle).toBeFocused();
});
