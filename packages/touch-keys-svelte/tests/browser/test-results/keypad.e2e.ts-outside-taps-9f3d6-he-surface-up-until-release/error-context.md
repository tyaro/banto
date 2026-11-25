# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: keypad.e2e.ts >> outside taps (§7.2.1) >> pressing the surface keeps the field focused and the surface up until release
- Location: packages\touch-keys-svelte\tests\browser\keypad.e2e.ts:98:2

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-touch-keys-surface]')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('[data-touch-keys-surface]') with timeout 5000ms
  - waiting for locator('[data-touch-keys-surface]')

```

```yaml
- main:
  - heading "touch-keys fixture" [level=1]
  - text: 数量
  - spinbutton "数量": "12"
  - status: "12"
  - text: 単価
  - spinbutton "単価": "0.05"
  - text: メモ
  - textbox "メモ"
  - button "保存"
  - button "明細を開く"
- status: 保存しました
```

# Test source

```ts
  7   | import { expect, test, type Locator, type Page } from '@playwright/test';
  8   | 
  9   | const surface = (page: Page): Locator => page.locator('[data-touch-keys-surface]');
  10  | const key = (page: Page, name: string): Locator =>
  11  | 	surface(page).getByRole('button', { name, exact: true });
  12  | const log = (page: Page): Promise<string[]> =>
  13  | 	page.evaluate(() => (window as unknown as { __log: string[] }).__log.slice());
  14  | const clearLog = (page: Page): Promise<void> =>
  15  | 	page.evaluate(() => {
  16  | 		(window as unknown as { __log: string[] }).__log.length = 0;
  17  | 	});
  18  | const activeId = (page: Page): Promise<string> =>
  19  | 	page.evaluate(() => document.activeElement?.id ?? '');
  20  | 
  21  | async function centre(target: Locator): Promise<{ x: number; y: number }> {
  22  | 	const box = await target.boundingBox();
  23  | 	if (!box) throw new Error('no box');
  24  | 	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  25  | }
  26  | 
  27  | async function tapAt(page: Page, target: Locator): Promise<void> {
  28  | 	const { x, y } = await centre(target);
  29  | 	await page.touchscreen.tap(x, y);
  30  | }
  31  | 
  32  | async function openOn(page: Page, id: string): Promise<void> {
  33  | 	await page.locator(`#${id}`).tap();
  34  | 	await expect(surface(page)).toBeVisible();
  35  | }
  36  | 
  37  | async function press(page: Page, keys: string[]): Promise<void> {
  38  | 	for (const k of keys) await key(page, k).tap();
  39  | }
  40  | 
  41  | test.describe('outside taps (§7.2.1)', () => {
  42  | 	test('a tap where the save button is closes the keys only; the next tap saves', async ({
  43  | 		page
  44  | 	}) => {
  45  | 		await page.goto('/');
  46  | 		await openOn(page, 'qty');
  47  | 		await press(page, ['7']);
  48  | 		await clearLog(page);
  49  | 
  50  | 		await tapAt(page, page.locator('#save'));
  51  | 		await expect(surface(page)).toHaveCount(0);
  52  | 		await expect(page.locator('#qty')).toHaveValue('12');
  53  | 		// no input / change / submit / blur: only the cancel
  54  | 		expect(await log(page)).toEqual(['cancel:qty:outside']);
  55  | 
  56  | 		await tapAt(page, page.locator('#save'));
  57  | 		await expect.poll(() => log(page)).toContain('submit:main=12');
  58  | 	});
  59  | 
  60  | 	test('inside a Modal: the keys close, the Modal stays, nothing is submitted', async ({
  61  | 		page
  62  | 	}) => {
  63  | 		await page.goto('/?placement=bottom');
  64  | 		await page.locator('#open-modal').tap();
  65  | 		const dialog = page.getByRole('dialog', { name: '明細' });
  66  | 		await expect(dialog).toBeVisible();
  67  | 		await openOn(page, 'm-qty');
  68  | 		await press(page, ['9']);
  69  | 		await clearLog(page);
  70  | 
  71  | 		await tapAt(page, page.locator('#m-save'));
  72  | 		await expect(surface(page)).toHaveCount(0);
  73  | 		await expect(dialog).toBeVisible();
  74  | 		await expect(page.locator('#m-qty')).toHaveValue('3');
  75  | 		expect(await log(page)).toEqual(['cancel:m-qty:outside']);
  76  | 
  77  | 		// a tap where the Modal's scrim is: still only the keys close
  78  | 		await openOn(page, 'm-qty');
  79  | 		await page.touchscreen.tap(8, 8);
  80  | 		await expect(surface(page)).toHaveCount(0);
  81  | 		await expect(dialog).toBeVisible();
  82  | 
  83  | 		await tapAt(page, page.locator('#m-save'));
  84  | 		await expect.poll(() => log(page)).toContain('submit:mform=3');
  85  | 	});
  86  | 
  87  | 	test('a tap on another keypad field moves the keys there in one tap', async ({ page }) => {
  88  | 		await page.goto('/');
  89  | 		await openOn(page, 'qty');
  90  | 		await clearLog(page);
  91  | 		await tapAt(page, page.locator('#price'));
  92  | 		await expect(surface(page).getByRole('group', { name: 'テンキー 単価' })).toBeVisible();
  93  | 		expect(await activeId(page)).toBe('price');
  94  | 		expect(await log(page)).toEqual(['cancel:qty:outside', 'blur:qty', 'open:price']);
  95  | 		await expect(page.locator('#price')).toHaveAttribute('inputmode', 'none');
  96  | 	});
  97  | 
  98  | 	test('pressing the surface keeps the field focused and the surface up until release', async ({
  99  | 		page
  100 | 	}) => {
  101 | 		await page.goto('/');
  102 | 		await openOn(page, 'qty');
  103 | 		await clearLog(page);
  104 | 		const { x, y } = await centre(page.locator('#save'));
  105 | 		await page.mouse.move(x, y);
  106 | 		await page.mouse.down();
> 107 | 		await expect(surface(page)).toBeVisible();
      |                               ^ Error: expect(locator).toBeVisible() failed
  108 | 		expect(await activeId(page)).toBe('qty');
  109 | 		expect(await log(page)).toEqual([]);
  110 | 		await page.mouse.up();
  111 | 		await expect(surface(page)).toHaveCount(0);
  112 | 		expect(await log(page)).toEqual(['cancel:qty:outside']);
  113 | 	});
  114 | });
  115 | 
  116 | test.describe('layers (§7.1, §7.3)', () => {
  117 | 	test('Esc closes the keys first, then the Modal', async ({ page }) => {
  118 | 		await page.goto('/?placement=bottom');
  119 | 		await page.locator('#open-modal').tap();
  120 | 		const dialog = page.getByRole('dialog', { name: '明細' });
  121 | 		await openOn(page, 'm-qty');
  122 | 		await page.keyboard.press('Escape');
  123 | 		await expect(surface(page)).toHaveCount(0);
  124 | 		await expect(dialog).toBeVisible();
  125 | 		expect(await log(page)).toContain('cancel:m-qty:cancel-key');
  126 | 		await page.keyboard.press('Escape');
  127 | 		await expect(dialog).toHaveCount(0);
  128 | 	});
  129 | 
  130 | 	test('the keys are in front of the Modal and the toast', async ({ page }) => {
  131 | 		await page.goto('/');
  132 | 		await page.locator('#open-modal').tap();
  133 | 		await openOn(page, 'm-qty');
  134 | 		const onTop = async (target: Locator): Promise<boolean> => {
  135 | 			const { x, y } = await centre(target);
  136 | 			return page.evaluate(
  137 | 				([px, py]) =>
  138 | 					document.elementFromPoint(px, py)?.closest('[data-touch-keys-surface]') !== null,
  139 | 				[x, y]
  140 | 			);
  141 | 		};
  142 | 		expect(await onTop(page.locator('#toast'))).toBe(true);
  143 | 		expect(await onTop(page.getByRole('dialog', { name: '明細' }))).toBe(true);
  144 | 		expect(await onTop(page.locator('#m-save'))).toBe(true);
  145 | 	});
  146 | });
  147 | 
  148 | test.describe('focus and writing (§6.2, §7.2)', () => {
  149 | 	test('keys never move focus; confirm writes once and reaches bind:value', async ({ page }) => {
  150 | 		await page.goto('/');
  151 | 		await openOn(page, 'qty');
  152 | 		await expect(page.locator('#qty')).toHaveAttribute('inputmode', 'none');
  153 | 		await clearLog(page);
  154 | 		for (const k of ['7', '5', '1文字消す']) {
  155 | 			await key(page, k).tap();
  156 | 			expect(await activeId(page)).toBe('qty');
  157 | 		}
  158 | 		expect(await log(page)).toEqual([]);
  159 | 		await key(page, '確定').tap();
  160 | 		await expect(surface(page)).toHaveCount(0);
  161 | 		await expect(page.locator('#qty')).toHaveValue('7');
  162 | 		await expect(page.locator('#bound')).toHaveText('7');
  163 | 		expect(await activeId(page)).toBe('qty');
  164 | 		expect(await log(page)).toEqual(['input:qty', 'change:qty', 'confirm:qty=7']);
  165 | 	});
  166 | 
  167 | 	test('type="number" with min=0.05 step=0.10: 0.10 cannot be confirmed, 0.15 is valid for the browser too', async ({
  168 | 		page
  169 | 	}) => {
  170 | 		await page.goto('/');
  171 | 		await openOn(page, 'price');
  172 | 		await press(page, ['0', '.', '1', '0']);
  173 | 		await expect(key(page, '確定')).toBeDisabled();
  174 | 		await press(page, ['全部消す', '0', '.', '1', '5']);
  175 | 		await expect(key(page, '確定')).toBeEnabled();
  176 | 		await key(page, '確定').tap();
  177 | 		await expect(page.locator('#price')).toHaveValue('0.15');
  178 | 		expect(
  179 | 			await page.locator('#price').evaluate((el: HTMLInputElement) => el.validity.valid)
  180 | 		).toBe(true);
  181 | 	});
  182 | 
  183 | 	test('bottom placement: docked to the bottom edge, publishes the inset while open', async ({
  184 | 		page
  185 | 	}) => {
  186 | 		await page.goto('/?placement=bottom');
  187 | 		const inset = (): Promise<string> =>
  188 | 			page.evaluate(() =>
  189 | 				document.documentElement.style.getPropertyValue('--banto-touch-keys-inset-bottom')
  190 | 			);
  191 | 		expect(await inset()).toBe('');
  192 | 		await openOn(page, 'qty');
  193 | 		const panel = await surface(page).locator('.panel').boundingBox();
  194 | 		expect(panel).not.toBeNull();
  195 | 		expect(Math.round(panel!.y + panel!.height)).toBe(1100);
  196 | 		expect(Math.round(panel!.width)).toBe(1024);
  197 | 		expect(await inset()).toBe(`${Math.round(panel!.height)}px`);
  198 | 		await key(page, '取り消し').tap();
  199 | 		await expect(surface(page)).toHaveCount(0);
  200 | 		expect(await inset()).toBe('');
  201 | 	});
  202 | });
  203 | 
  204 | test.describe('hardware Enter (§6.3)', () => {
  205 | 	test('with an unconfirmed change: closes only; a second Enter submits the old value once', async ({
  206 | 		page
  207 | 	}) => {
```