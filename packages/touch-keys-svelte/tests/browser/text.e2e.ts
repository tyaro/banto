/**
 * Text keyboard and password fields in a real browser (touch-keypad-design §14.3):
 * real hit testing and focus, the docked placement, a narrow screen, and the
 * acceptance of §5.5 - all 95 printable ASCII characters typed with the keys.
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

async function tapAt(page: Page, target: Locator): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('no box');
	await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function openOn(page: Page, id: string): Promise<void> {
	await page.locator(`#${id}`).tap();
	await expect(surface(page)).toBeVisible();
}

async function press(page: Page, keys: string[]): Promise<void> {
	for (const k of keys) await key(page, k).tap();
}

/** Types `text` with the on-screen keys, switching layout and case as a user would. */
async function typeText(page: Page, text: string): Promise<void> {
	let layout: 'alnum' | 'symbol' = 'alnum';
	let upper = false;
	for (const char of text) {
		if (char === ' ') {
			await key(page, '空白').tap();
			continue;
		}
		const isLetter = /[a-z]/i.test(char);
		const want = isLetter || /[0-9]/.test(char) ? 'alnum' : 'symbol';
		if (want !== layout) {
			await key(page, want === 'alnum' ? '英数' : '記号').tap();
			layout = want;
		}
		if (isLetter && (char === char.toUpperCase()) !== upper) {
			await key(page, upper ? '小文字' : '大文字').tap();
			upper = !upper;
		}
		await key(page, char).tap();
	}
}

test.describe('text keyboard (§9)', () => {
	test('docked to the bottom; keys never move focus; confirm writes once and reaches bind:value', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'memo');
		await expect(surface(page)).toHaveAttribute('data-touch-keys-surface', 'bottom');
		await expect(page.locator('#memo')).toHaveAttribute('inputmode', 'none');
		const panel = await surface(page).locator('.panel').boundingBox();
		expect(Math.round(panel!.y + panel!.height)).toBe(1100);
		// with room to spare, a key is the full key size (48px by default), not squeezed
		for (const name of ['1', 'q', 'a', 'm']) {
			const box = await key(page, name).boundingBox();
			expect([Math.round(box!.width), Math.round(box!.height)], name).toEqual([48, 48]);
		}
		await clearLog(page);
		for (const k of ['d', '大文字', 'E', '記号', '@', '英数', '空白', '1文字消す']) {
			await key(page, k).tap();
			expect(await activeId(page)).toBe('memo');
		}
		expect(await log(page)).toEqual([]); // no blur, no input: the keys only edit the draft
		await key(page, '確定').tap();
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#memo')).toHaveValue('abcdE@');
		await expect(page.locator('#memo-bound')).toHaveText('abcdE@');
		expect(await activeId(page)).toBe('memo');
		expect(await log(page)).toEqual(['input:memo', 'change:memo', 'confirm:memo=abcdE@']);
	});

	test('maxlength: the keys stop at the bound and the browser agrees with the value', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'code');
		await typeText(page, 'ab12cd');
		await expect(surface(page).getByTestId('count')).toHaveText('4 / 4');
		await key(page, '確定').tap();
		await expect(page.locator('#code')).toHaveValue('ab12');
		expect(await page.locator('#code').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(
			true
		);
	});

	test('a tap outside the docked keyboard closes it only; the next tap saves', async ({ page }) => {
		await page.goto('/');
		await openOn(page, 'memo');
		await press(page, ['d']);
		await clearLog(page);
		await tapAt(page, page.locator('#save'));
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#memo')).toHaveValue('abc');
		expect(await log(page)).toEqual(['cancel:memo:outside']);
		await tapAt(page, page.locator('#save'));
		await expect.poll(() => log(page)).toContain('submit:main=12');
	});

	test('one tap moves from the text keyboard to the number keypad and back', async ({ page }) => {
		await page.goto('/');
		await openOn(page, 'memo');
		await tapAt(page, page.locator('#qty'));
		await expect(surface(page).getByRole('group', { name: 'テンキー 数量' })).toBeVisible();
		expect(await activeId(page)).toBe('qty');
		await tapAt(page, page.locator('#memo'));
		await expect(surface(page).getByRole('group', { name: '文字キーボード メモ' })).toBeVisible();
		expect(await activeId(page)).toBe('memo');
	});

	test('hardware Enter with an unconfirmed change closes only; typing on a real keyboard takes over', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'memo');
		await press(page, ['d']);
		await clearLog(page);
		await page.keyboard.press('Enter');
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#memo')).toHaveValue('abc');
		expect(await log(page)).toEqual(['cancel:memo:hardware-input']);

		await openOn(page, 'memo');
		await press(page, ['d']);
		await page.keyboard.type('xy');
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#memo')).toHaveValue('abcxy');
	});
});

test.describe('narrow screen (§10)', () => {
	test.use({ viewport: { width: 360, height: 800 } });

	test('ten keys in a row shrink to fit: nothing is cut off or overlaps', async ({ page }) => {
		await page.goto('/');
		await openOn(page, 'memo');
		const row = await surface(page)
			.locator('.row')
			.first()
			.locator('button')
			.evaluateAll((buttons) =>
				buttons.map((b) => {
					const r = b.getBoundingClientRect();
					return { left: r.left, right: r.right };
				})
			);
		expect(row).toHaveLength(10);
		expect(row[0].left).toBeGreaterThanOrEqual(0);
		expect(row[9].right).toBeLessThanOrEqual(360);
		for (let i = 1; i < row.length; i++)
			expect(row[i].left).toBeGreaterThanOrEqual(row[i - 1].right);
		await typeText(page, 'q0p');
		await key(page, '確定').tap();
		await expect(page.locator('#memo')).toHaveValue('abcq0p');
	});
});

test.describe('password (§5.5)', () => {
	test('all 95 printable ASCII characters can be typed; the plain text stays out of the keys and the hooks', async ({
		page
	}) => {
		let all = '';
		for (let code = 0x20; code <= 0x7e; code++) all += String.fromCharCode(code);
		expect(all).toHaveLength(95);

		await page.goto('/');
		await openOn(page, 'pw');
		await clearLog(page);
		await typeText(page, all);
		await expect(surface(page).getByTestId('draft')).toHaveText('●'.repeat(95));
		await expect(surface(page).getByTestId('count')).toHaveText('95 文字');
		expect(await activeId(page)).toBe('pw');
		expect(await log(page)).toEqual([]);
		await key(page, '確定').tap();
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#pw')).toHaveValue(all);
		// the hook saw no text
		expect(await log(page)).toEqual(['input:pw', 'change:pw', 'confirm:pw=null']);
	});

	test('a typed draft is nowhere in the page outside the keys; reopening starts empty', async ({
		page
	}) => {
		const messages: string[] = [];
		page.on('console', (message) => messages.push(message.text()));
		await page.goto('/');
		await openOn(page, 'pw');
		await typeText(page, 'pA5$w');
		expect(await surface(page).evaluate((el) => el.outerHTML)).not.toContain('pA5$w');
		expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('pA5$w');
		await key(page, '取り消し').tap();
		await expect(page.locator('#pw')).toHaveValue('');
		await openOn(page, 'pw');
		await expect(surface(page).getByTestId('count')).toHaveText('0 文字');
		expect(messages.join('\n')).not.toContain('pA5$w');
	});
});

test.describe('the field decides (§6.5, §5.5)', () => {
	test('type="email": a text the browser refuses is not written and emits nothing; the keys stay open', async ({
		page
	}) => {
		await page.goto('/');
		await openOn(page, 'mail');
		await clearLog(page);
		await typeText(page, 'ab');
		await key(page, '確定').tap();
		await expect(surface(page)).toBeVisible();
		await expect(surface(page).getByRole('status')).toHaveText('入力の形式が合いません');
		await expect(page.locator('#mail')).toHaveValue('');
		expect(await log(page)).toEqual([]);

		await typeText(page, '@c');
		await expect(surface(page).getByRole('status')).toHaveText('');
		await key(page, '確定').tap();
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#mail')).toHaveValue('ab@c');
		expect(await log(page)).toEqual(['input:mail', 'change:mail', 'confirm:mail=ab@c']);
	});

	test('password: confirm is off until something is typed or cleared; only the clear-all key empties the field', async ({
		page
	}) => {
		await page.goto('/');
		await page.locator('#pw').evaluate((el) => {
			(el as HTMLInputElement).value = 'kept-1';
		});
		await openOn(page, 'pw');
		await clearLog(page);
		await expect(key(page, '確定')).toBeDisabled();
		await key(page, '取り消し').tap();
		await expect(page.locator('#pw')).toHaveValue('kept-1');

		await openOn(page, 'pw');
		await clearLog(page);
		await key(page, '全部消す').tap();
		await expect(key(page, '確定')).toBeEnabled();
		await key(page, '確定').tap();
		await expect(surface(page)).toHaveCount(0);
		await expect(page.locator('#pw')).toHaveValue('');
		expect(await log(page)).toEqual(['input:pw', 'change:pw', 'confirm:pw=null']);
	});
});

test('axe: no WCAG A / AA violation with the text keyboard open (plain, symbols, masked)', async ({
	page
}) => {
	await page.goto('/');
	await openOn(page, 'memo');
	let results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
	expect(results.violations, 'alnum').toEqual([]);
	await key(page, '記号').tap();
	results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
	expect(results.violations, 'symbol').toEqual([]);
	await key(page, '取り消し').tap();

	await page.goto('/?text=popup');
	await openOn(page, 'pw');
	await key(page, '記号').tap();
	results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
	expect(results.violations, 'masked').toEqual([]);
});
