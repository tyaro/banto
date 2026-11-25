/**
 * Number keypad in a real browser (touch-keypad-design §14.3): what jsdom cannot
 * show - hit testing, the top layer, real focus, the browser's number validation,
 * and the real `@banto/ui` Modal underneath.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const surface = (page: Page): Locator => page.locator('[data-touch-keys-surface]');
const key = (page: Page, name: string): Locator =>
	surface(page).getByRole('button', { name, exact: true });
const log = (page: Page): Promise<string[]> =>
	page.evaluate(() => (window as unknown as { __log: string[] }).__log.slice());
const clearLog = (page: Page): Promise<void> =>
	page.evaluate(() => {
		(window as unknown as { __log: string[] }).__log.length = 0;
	});
const activeId = (page: Page): Promise<string> =>
	page.evaluate(() => document.activeElement?.id ?? '');

async function centre(target: Locator): Promise<{ x: number; y: number }> {
	const box = await target.boundingBox();
	if (!box) throw new Error('no box');
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tapAt(page: Page, target: Locator): Promise<void> {
	const { x, y } = await centre(target);
	await page.touchscreen.tap(x, y);
}

async function openOn(page: Page, id: string): Promise<void> {
	await page.locator(`#${id}`).tap();
	await expect(surface(page)).toBeVisible();
}

async function press(page: Page, keys: string[]): Promise<void> {
	for (const k of keys) await key(page, k).tap();
}

test.describe('outside taps (§7.2.1)', () => {
	test('a tap where the save button is closes the keys only; the next tap saves', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await press(page, ['7']);
		await clearLog(page);

		await tapAt(page, page.locator('#save'));
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#qty')).toHaveValue('12');
		// no input / change / submit / blur: only the cancel
		expect(await log(page)).toEqual(['cancel:qty:outside']);

		await tapAt(page, page.locator('#save'));
		await expect.poll(() => log(page)).toContain('submit:main=12');
	});

	test('inside a Modal: the keys close, the Modal stays, nothing is submitted', async ({
		page
	}) => {
		await page.goto('/?placement=bottom');
		await page.locator('#open-modal').tap();
		const dialog = page.getByRole('dialog', { name: '明細' });
		await expect(dialog).toBeVisible();
		await openOn(page, 'm-qty');
		await press(page, ['9']);
		await clearLog(page);

		await tapAt(page, page.locator('#m-save'));
		await expect(surface(page)).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(page.locator('#m-qty')).toHaveValue('3');
		expect(await log(page)).toEqual(['cancel:m-qty:outside']);

		// a tap where the Modal's scrim is: still only the keys close
		await openOn(page, 'm-qty');
		await page.touchscreen.tap(8, 8);
		await expect(surface(page)).toHaveCount(0);
		await expect(dialog).toBeVisible();

		await tapAt(page, page.locator('#m-save'));
		await expect.poll(() => log(page)).toContain('submit:mform=3');
	});

	test('a tap on another keypad field moves the keys there in one tap', async ({ page }) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await clearLog(page);
		await tapAt(page, page.locator('#price'));
		await expect(surface(page).getByRole('group', { name: 'テンキー 単価' })).toBeVisible();
		expect(await activeId(page)).toBe('price');
		expect(await log(page)).toEqual(['cancel:qty:outside', 'blur:qty', 'open:price']);
		await expect(page.locator('#price')).toHaveAttribute('inputmode', 'none');
	});

	test('pressing the surface keeps the field focused and the surface up until release', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await clearLog(page);
		const { x, y } = await centre(page.locator('#save'));
		await page.mouse.move(x, y);
		await page.mouse.down();
		await expect(surface(page)).toBeVisible();
		expect(await activeId(page)).toBe('qty');
		expect(await log(page)).toEqual([]);
		await page.mouse.up();
		await expect(surface(page)).toHaveCount(0);
		expect(await log(page)).toEqual(['cancel:qty:outside']);
	});
});

test.describe('layers (§7.1, §7.3)', () => {
	test('Esc closes the keys first, then the Modal', async ({ page }) => {
		await page.goto('/?placement=bottom');
		await page.locator('#open-modal').tap();
		const dialog = page.getByRole('dialog', { name: '明細' });
		await openOn(page, 'm-qty');
		await page.keyboard.press('Escape');
		await expect(surface(page)).toHaveCount(0);
		await expect(dialog).toBeVisible();
		expect(await log(page)).toContain('cancel:m-qty:cancel-key');
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
	});

	test('the keys are in front of the Modal and the toast', async ({ page }) => {
		await page.goto('/');
		await page.locator('#open-modal').tap();
		await openOn(page, 'm-qty');
		const onTop = async (target: Locator): Promise<boolean> => {
			const { x, y } = await centre(target);
			return page.evaluate(
				([px, py]) =>
					document.elementFromPoint(px, py)?.closest('[data-touch-keys-surface]') !== null,
				[x, y]
			);
		};
		expect(await onTop(page.locator('#toast'))).toBe(true);
		expect(await onTop(page.getByRole('dialog', { name: '明細' }))).toBe(true);
		expect(await onTop(page.locator('#m-save'))).toBe(true);
	});
});

test.describe('focus and writing (§6.2, §7.2)', () => {
	test('keys never move focus; confirm writes once and reaches bind:value', async ({ page }) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await expect(page.locator('#qty')).toHaveAttribute('inputmode', 'none');
		await clearLog(page);
		for (const k of ['7', '5', '1文字消す']) {
			await key(page, k).tap();
			expect(await activeId(page)).toBe('qty');
		}
		expect(await log(page)).toEqual([]);
		await key(page, '確定').tap();
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#qty')).toHaveValue('7');
		await expect(page.locator('#bound')).toHaveText('7');
		expect(await activeId(page)).toBe('qty');
		expect(await log(page)).toEqual(['input:qty', 'change:qty', 'confirm:qty=7']);
	});

	test('type="number" with min=0.05 step=0.10: 0.10 cannot be confirmed, 0.15 is valid for the browser too', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'price');
		await press(page, ['0', '.', '1', '0']);
		await expect(key(page, '確定')).toBeDisabled();
		await press(page, ['全部消す', '0', '.', '1', '5']);
		await expect(key(page, '確定')).toBeEnabled();
		await key(page, '確定').tap();
		await expect(page.locator('#price')).toHaveValue('0.15');
		expect(await page.locator('#price').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
			true
		);
	});

	test('bottom placement: docked to the bottom edge, publishes the inset while open', async ({
		page
	}) => {
		await page.goto('/?placement=bottom');
		const inset = (): Promise<string> =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue('--banto-touch-keys-inset-bottom')
			);
		expect(await inset()).toBe('');
		await openOn(page, 'qty');
		const panel = await surface(page).locator('.panel').boundingBox();
		expect(panel).not.toBeNull();
		expect(Math.round(panel!.y + panel!.height)).toBe(1100);
		expect(Math.round(panel!.width)).toBe(1024);
		expect(await inset()).toBe(`${Math.round(panel!.height)}px`);
		await key(page, '取り消し').tap();
		await expect(surface(page)).toHaveCount(0);
		expect(await inset()).toBe('');
	});
});

test.describe('hardware Enter (§6.3)', () => {
	test('with an unconfirmed change: closes only; a second Enter submits the old value once', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await press(page, ['7']);
		await clearLog(page);
		await page.keyboard.press('Enter');
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#qty')).toHaveValue('12');
		expect(await log(page)).toEqual(['cancel:qty:hardware-input']);
		await page.keyboard.press('Enter');
		expect((await log(page)).filter((e) => e.startsWith('submit'))).toEqual(['submit:main=12']);
	});

	test('opened only: closes and submits once', async ({ page }) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await clearLog(page);
		await page.keyboard.press('Enter');
		await expect(surface(page)).toHaveCount(0);
		expect(await log(page)).toEqual(['cancel:qty:hardware-input', 'submit:main=12']);
	});

	test('opened only, Enter held down: one submit; the next press submits once more', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await clearLog(page);
		await page.keyboard.down('Enter');
		await page.keyboard.down('Enter'); // repeat
		await page.keyboard.down('Enter'); // repeat
		await page.keyboard.up('Enter');
		await expect(surface(page)).toHaveCount(0);
		expect(await log(page)).toEqual(['cancel:qty:hardware-input', 'submit:main=12']);
		await page.keyboard.press('Enter');
		expect((await log(page)).filter((e) => e.startsWith('submit'))).toEqual([
			'submit:main=12',
			'submit:main=12'
		]);
	});

	test('scanner shape: typed characters go into the field, the Enter submits once', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await press(page, ['7']);
		await clearLog(page);
		await page.keyboard.type('9');
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#qty')).toHaveValue('129');
		await page.keyboard.press('Enter');
		expect((await log(page)).filter((e) => e.startsWith('submit'))).toEqual(['submit:main=129']);
	});

	test('a held-down Enter (auto-repeat) never submits', async ({ page }) => {
		await page.goto('/');
		await openOn(page, 'qty');
		await press(page, ['7']);
		await clearLog(page);
		await page.keyboard.down('Enter');
		await page.keyboard.down('Enter'); // repeat
		await page.keyboard.down('Enter'); // repeat
		await page.keyboard.up('Enter');
		await expect(surface(page)).toHaveCount(0);
		expect(await log(page)).toEqual(['cancel:qty:hardware-input']);
		await page.keyboard.press('Enter');
		expect((await log(page)).filter((e) => e.startsWith('submit'))).toEqual(['submit:main=12']);
	});
});

test('axe: no WCAG A / AA violation with the keys open', async ({ page }) => {
	for (const url of ['/', '/?placement=bottom']) {
		await page.goto(url);
		await openOn(page, 'qty');
		const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
		expect(results.violations, url).toEqual([]);
	}
});

test.describe('openOnFocus (grid-touch-edit-design §4.2)', () => {
	test('one tap on a button opens the keys on the field it shows and focuses', async ({ page }) => {
		await page.goto('/');
		await clearLog(page);
		await page.locator('#reveal').tap();
		await expect(surface(page)).toBeVisible();
		expect(await activeId(page)).toBe('shown');
		expect(await page.locator('#shown').getAttribute('inputmode')).toBe('none');
		expect(await log(page)).toContain('open:shown');
		await key(page, '4').tap();
		await key(page, '確定').tap();
		await expect(page.locator('#shown')).toHaveValue('4');
	});
	test('a field without the option stays closed, and a keyboard-made click does not open', async ({
		page
	}) => {
		await page.goto('/');
		await page.locator('#reveal-plain').tap();
		await expect(page.locator('#shown-plain')).toBeFocused();
		await expect(surface(page)).toBeHidden();
		await page.locator('#reveal').focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('#shown')).toBeFocused();
		await expect(surface(page)).toBeHidden();
	});
});
