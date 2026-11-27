/**
 * The dashboard's ONE dock of widgets (#716 W2, docs/design/downstream-requests-2026-11-plan.md
 * §4.13.3・§4.13.5), in a real browser: the arrangement is saved per user under the new key
 * (`dashboard.widgets`) from `onLayoutCommit` alone (#791 K4, `@banto/dock-svelte`'s
 * `createDockLayoutStore`).
 *
 *  - The seeded default is not written to the provider; adding / hiding a widget from the View
 *    menu and moving one are saved and come back after a reload; "reset layout" DELETES what was
 *    saved (`reset: 'remove'`).
 *  - A value under the keys of the dock before W2 (`dock.dashboard`) is not read; neither is
 *    another user's first-paint copy; a saved value that names a widget the registry does not
 *    have falls back to the default.
 *  - Kiosk: nothing can be rearranged, no View menu.
 *  - A narrow page: the widgets the arrangement shows, stacked in one column - the saved
 *    arrangement is not written, and the memo's draft survives the switch. The switch waits for
 *    an IME composition in the memo to end, and for the memo's close question to be answered.
 *  - Keyboard only: add, move, hide.
 *
 * In demo mode both copies are in localStorage: the store's first-paint copy (written at once)
 * and the `UiSettingsProvider` copy (500ms after the last report). Every write and removal of
 * either is recorded by an init script.
 *
 * The widgets used are the memo and the list (`在庫の少ない商品`): neither needs `@banto/charts`,
 * so this spec also holds in a copy scaffolded without the charts. (It is removed with the dock.)
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeKiosk, primeThemeAndAuth } from '../visual/theme';

const LAYOUT_KEY = 'banto.dashboard.widgets:acct:demo';
const PROVIDER_KEY = 'banto.ui.dashboard.widgets';
/** The keys of the dashboard's dock before W2: never read, never written. */
const OLD_LAYOUT_KEY = 'banto.dock.dashboard:acct:demo';
const OLD_PROVIDER_KEY = 'banto.ui.dock.dashboard';
const MEMO = 'メモ';
const LIST = '在庫の少ない商品';
const RESET = 'レイアウトを既定に戻す';
/** Longer than the store's debounce (500ms). */
const AFTER_DEBOUNCE_MS = 800;

interface StorageOp {
	op: 'set' | 'remove';
	key: string;
	value?: string;
}

async function ops(page: Page, key: string): Promise<StorageOp[]> {
	return page.evaluate(
		(k) =>
			(window as unknown as { __layoutOps: StorageOp[] }).__layoutOps.filter((w) => w.key === k),
		key
	);
}

const stored = (page: Page, key: string): Promise<string | null> =>
	page.evaluate((k) => window.localStorage.getItem(k), key);

/** Record every `setItem` / `removeItem` of the layout's keys (the old ones too). */
async function recordStorage(page: Page): Promise<void> {
	await page.addInitScript(
		({ keys }) => {
			const w = window as unknown as { __layoutOps: StorageOp[] };
			w.__layoutOps = [];
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (keys.includes(key)) w.__layoutOps.push({ op: 'set', key, value });
				setItem.call(this, key, value);
			};
			const removeItem = Storage.prototype.removeItem;
			Storage.prototype.removeItem = function (key: string) {
				if (keys.includes(key)) w.__layoutOps.push({ op: 'remove', key });
				removeItem.call(this, key);
			};
		},
		{ keys: [LAYOUT_KEY, PROVIDER_KEY, OLD_LAYOUT_KEY, OLD_PROVIDER_KEY] }
	);
}

const dockHost = (page: Page): Locator => page.locator('.dock-wrapper [data-dock-host]');
const stack = (page: Page): Locator => page.locator('[data-dashboard-stack]');
const pane = (page: Page, id: string): Locator =>
	dockHost(page).locator(`[data-dock-drop-id="${id}"]`);
const viewButton = (page: Page): Locator =>
	page.getByRole('main').getByRole('button', { name: '表示', exact: true });

async function openViewMenu(page: Page): Promise<Locator> {
	await viewButton(page).click();
	const menu = page.getByRole('menu', { name: '表示' });
	await expect(menu).toBeVisible();
	return menu;
}

/** Toggle one widget's checkbox in the View menu, then close the menu. */
async function toggleWidget(page: Page, name: string): Promise<void> {
	const menu = await openViewMenu(page);
	await menu.getByRole('menuitemcheckbox', { name, exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
}

async function openDashboard(page: Page): Promise<void> {
	await page.goto('/dashboard');
	await expect(dockHost(page)).toBeVisible({ timeout: 60_000 });
	// The default is seeded and mirrored into the first-paint copy.
	await expect.poll(() => stored(page, LAYOUT_KEY)).toContain('"docked":{');
}

/** A layout with one docked panel, as the dock serializes it. */
const onePanelLayout = (id: string, title: string): string =>
	JSON.stringify({ version: 4, floating: [], docked: { type: 'panel', id, title } });

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await recordStorage(page);
	await page.setViewportSize({ width: 1440, height: 900 });
});

test('add, hide and move are saved and survive a reload; reset deletes the saved value', async ({
	page
}) => {
	await openDashboard(page);
	const seeded = await stored(page, LAYOUT_KEY);
	// The default the store put in is not a user's change.
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await stored(page, PROVIDER_KEY)).toBeNull();
	// The default docks both; the memo sits right of the list.
	await expect(pane(page, 'memo')).toBeVisible();
	await expect(pane(page, 'lowStock')).toBeVisible();
	const defaultBox = await pane(page, 'lowStock').boundingBox();
	if (!defaultBox) throw new Error('list pane not visible');

	// Move: the list to the dock's left edge (the first item of its panel menu). First, while the
	// memo is docked next to it: a copy without the charts has only these two panes, and the only
	// pane of a dock has nowhere to move.
	const hostBox = await dockHost(page).boundingBox();
	if (!hostBox) throw new Error('dock not visible');
	await dockHost(page)
		.getByRole('button', { name: `${LIST}のパネルの操作`, exact: true })
		.click();
	await page
		.getByRole('menu', { name: `${LIST}のパネルの操作`, exact: true })
		.getByRole('menuitem', { name: '左端にドッキング', exact: true })
		.click();
	// The left quarter of the dock, at its full height.
	await expect
		.poll(async () => (await pane(page, 'lowStock').boundingBox())?.width ?? 9999)
		.toBeLessThan(hostBox.width * 0.3);
	const edgeBox = await pane(page, 'lowStock').boundingBox();
	if (!edgeBox) throw new Error('list pane not visible');
	expect(Math.abs(edgeBox.x - hostBox.x)).toBeLessThan(8);
	expect(edgeBox.height).toBeGreaterThan(hostBox.height - 16);
	await expect.poll(() => stored(page, LAYOUT_KEY)).not.toBe(seeded);
	const movedOnly = await stored(page, LAYOUT_KEY);
	await expect.poll(() => stored(page, PROVIDER_KEY)).toBe(movedOnly);
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	// One change, one write.
	expect(await ops(page, PROVIDER_KEY)).toEqual([
		{ op: 'set', key: PROVIDER_KEY, value: movedOnly! }
	]);

	// Hide: uncheck the memo (its text is untouched, so the close has nothing to settle).
	await toggleWidget(page, MEMO);
	await expect(pane(page, 'memo')).toHaveCount(0);
	await expect.poll(() => stored(page, PROVIDER_KEY)).not.toBe(movedOnly);
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	const moved = await stored(page, PROVIDER_KEY);
	expect(await stored(page, LAYOUT_KEY)).toBe(moved);
	const movedBox = await pane(page, 'lowStock').boundingBox();

	// The saved arrangement is what a reload shows (the provider's copy wins).
	await page.reload();
	await expect(dockHost(page)).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => stored(page, LAYOUT_KEY)).toBe(moved);
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	// Applying the saved layout is not a change to save.
	expect(await ops(page, PROVIDER_KEY)).toEqual([]);
	await expect(pane(page, 'memo')).toHaveCount(0);
	await expect.poll(() => pane(page, 'lowStock').boundingBox()).toEqual(movedBox);

	// Add: the memo again. A widget hidden from the default goes back to its place there.
	await toggleWidget(page, MEMO);
	await expect(pane(page, 'memo')).toBeVisible();
	await expect.poll(() => stored(page, PROVIDER_KEY)).not.toBe(moved);
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	const added = await stored(page, PROVIDER_KEY);
	await page.reload();
	await expect(dockHost(page)).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => stored(page, LAYOUT_KEY)).toBe(added);
	await expect(pane(page, 'memo')).toBeVisible();

	// "Reset layout": the saved value is DELETED (not the default written), once.
	const menu = await openViewMenu(page);
	await menu.getByRole('menuitem', { name: RESET, exact: true }).click();
	await expect(menu).toHaveCount(0);
	await expect.poll(() => stored(page, PROVIDER_KEY)).toBeNull();
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await ops(page, PROVIDER_KEY)).toEqual([{ op: 'remove', key: PROVIDER_KEY }]);
	// The list is back in its default place, at its default size (whatever this copy's default
	// is: with the charts it is the third row, without them the only one).
	await expect.poll(() => pane(page, 'lowStock').boundingBox()).toEqual(defaultBox);
	await expect(pane(page, 'memo')).toBeVisible();

	// Nothing saved: a reload shows the default again, and still writes nothing.
	await page.reload();
	await expect(dockHost(page)).toBeVisible({ timeout: 60_000 });
	await expect(pane(page, 'memo')).toBeVisible();
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await stored(page, PROVIDER_KEY)).toBeNull();
	expect(await stored(page, LAYOUT_KEY)).toBe(seeded);
});

test('the keys of the dock before W2 are not read (and left alone)', async ({ page }) => {
	// What the old dashboard saved: only the memo, docked. Both of its copies.
	const old = onePanelLayout('memo', MEMO);
	await page.addInitScript(
		({ keys, value }) => {
			for (const key of keys) window.localStorage.setItem(key, value);
		},
		{ keys: [OLD_LAYOUT_KEY, OLD_PROVIDER_KEY], value: old }
	);
	await openDashboard(page);
	// The default, not the old arrangement: the list is docked next to the memo.
	await expect(pane(page, 'lowStock')).toBeVisible();
	await expect(pane(page, 'memo')).toBeVisible();
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await stored(page, PROVIDER_KEY)).toBeNull();
	// Not converted, not deleted.
	expect(await stored(page, OLD_LAYOUT_KEY)).toBe(old);
	expect(await stored(page, OLD_PROVIDER_KEY)).toBe(old);
	expect((await ops(page, OLD_LAYOUT_KEY)).concat(await ops(page, OLD_PROVIDER_KEY))).toHaveLength(
		2
	); // this test's own two writes
});

test("another user's copy is not read; a saved value with an unregistered widget falls back to the default", async ({
	page
}) => {
	// Another user's first-paint copy in this browser, and an ownerless one: only the list.
	const others = onePanelLayout('lowStock', LIST);
	// The provider's value names a widget the registry does not have (removed by the author).
	const stale = JSON.stringify({
		version: 4,
		floating: [],
		docked: {
			type: 'split',
			id: 'root',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [
				{ type: 'panel', id: 'memo', title: MEMO },
				{ type: 'panel', id: 'removedWidget', title: 'Removed' }
			]
		}
	});
	await page.addInitScript(
		({ othersValue, staleValue, providerKey }) => {
			window.localStorage.setItem('banto.dashboard.widgets:acct:someone-else', othersValue);
			window.localStorage.setItem('banto.dashboard.widgets', othersValue);
			// Only on the first load: the reload below must see what the page left.
			if (window.sessionStorage.getItem('__primed') === null) {
				window.sessionStorage.setItem('__primed', '1');
				window.localStorage.setItem(providerKey, staleValue);
			}
		},
		{ othersValue: others, staleValue: stale, providerKey: PROVIDER_KEY }
	);
	await openDashboard(page);
	// The default: the memo is there (the other user's copy has only the list), and no pane of
	// the unregistered widget.
	await expect(pane(page, 'memo')).toBeVisible();
	await expect(pane(page, 'lowStock')).toBeVisible();
	await expect(pane(page, 'removedWidget')).toHaveCount(0);
	await expect(page.getByText('不明なパネルです')).toHaveCount(0);
	expect(await stored(page, 'banto.dashboard.widgets:acct:someone-else')).toBe(others);
	// Falling back is not a save: the stale value stays until the user changes the arrangement.
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await stored(page, PROVIDER_KEY)).toBe(stale);

	// The user's next change replaces it.
	await toggleWidget(page, MEMO);
	await expect.poll(() => stored(page, PROVIDER_KEY)).not.toBe(stale);
	expect(await stored(page, PROVIDER_KEY)).not.toContain('removedWidget');
});

test('kiosk: the arrangement is shown, nothing can be rearranged, no View menu', async ({
	page
}) => {
	await primeKiosk(page);
	await openDashboard(page);
	await expect(pane(page, 'memo')).toBeVisible();
	await expect(pane(page, 'lowStock')).toBeVisible();
	// No View menu: not in the page header (and the kiosk shell has no menu bar entry for it).
	await expect(viewButton(page)).toHaveCount(0);
	// No way to close, float, auto-hide or move a pane, and every divider is locked.
	const host = dockHost(page);
	await expect(host.getByRole('button', { name: `${MEMO}を閉じる` })).toHaveCount(0);
	await expect(host.getByRole('button', { name: `${MEMO}のパネルの操作` })).toHaveCount(0);
	await expect(host.getByRole('button', { name: /自動で隠す/ })).toHaveCount(0);
	await expect(host.locator('.divider:not(.locked)')).toHaveCount(0);
	await expect(host.locator('.divider.locked').first()).toHaveAttribute('aria-disabled', 'true');
	// A drag of the title bar moves nothing.
	const before = await pane(page, 'memo').boundingBox();
	if (!before) throw new Error('memo pane not visible');
	await page.mouse.move(before.x + 40, before.y + 12);
	await page.mouse.down();
	await page.mouse.move(before.x - 200, before.y - 200, { steps: 8 });
	await page.mouse.up();
	expect(await pane(page, 'memo').boundingBox()).toEqual(before);
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await stored(page, PROVIDER_KEY)).toBeNull();
});

test('a narrow page stacks the shown widgets in one column: the saved arrangement and the memo draft are kept', async ({
	page
}) => {
	await openDashboard(page);
	// A saved arrangement that differs from the default: the list hidden.
	await toggleWidget(page, LIST);
	await expect(pane(page, 'lowStock')).toHaveCount(0);
	await expect.poll(() => stored(page, PROVIDER_KEY)).not.toBeNull();
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	const saved = await stored(page, PROVIDER_KEY);
	const local = await stored(page, LAYOUT_KEY);
	const opsBefore = (await ops(page, PROVIDER_KEY)).length + (await ops(page, LAYOUT_KEY)).length;

	// Unapplied text in the docked memo.
	const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
	await memoInput.fill('typed while docked');

	// Narrow: no dock, no View menu; one column with what the arrangement shows.
	await page.setViewportSize({ width: 700, height: 900 });
	await expect(stack(page)).toBeVisible();
	await expect(dockHost(page)).toHaveCount(0);
	await expect(viewButton(page)).toHaveCount(0);
	await expect(stack(page).getByRole('heading', { name: MEMO, exact: true })).toBeVisible();
	await expect(stack(page).getByRole('heading', { name: LIST, exact: true })).toHaveCount(0);
	// One column: every card starts at the same x and no two share a row.
	const boxes = await stack(page)
		.locator('section')
		.evaluateAll((cards) =>
			cards.map((card) => {
				const rect = card.getBoundingClientRect();
				return { x: rect.x, top: rect.top, bottom: rect.bottom };
			})
		);
	expect(boxes.length).toBeGreaterThan(0);
	for (let i = 1; i < boxes.length; i++) {
		expect(boxes[i]!.x).toBe(boxes[0]!.x);
		expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom);
	}
	// The draft came along, and is still editable (the page owns it).
	await expect(memoInput).toHaveValue('typed while docked');
	await memoInput.fill('typed while stacked');

	// Wide again: the dock, with the arrangement as saved and the draft as typed.
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(dockHost(page)).toBeVisible();
	await expect(stack(page)).toHaveCount(0);
	await expect(viewButton(page)).toBeVisible();
	await expect(pane(page, 'lowStock')).toHaveCount(0);
	await expect(pane(page, 'memo')).toBeVisible();
	await expect(memoInput).toHaveValue('typed while stacked');
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await stored(page, PROVIDER_KEY)).toBe(saved);
	expect(await stored(page, LAYOUT_KEY)).toBe(local);
	// Nothing was written or removed on the way.
	expect((await ops(page, PROVIDER_KEY)).length + (await ops(page, LAYOUT_KEY)).length).toBe(
		opsBefore
	);

	// A page that OPENS narrow reads the saved arrangement too, and leaves it as it is.
	await memoInput.fill('');
	await page.setViewportSize({ width: 700, height: 900 });
	await page.reload();
	await expect(stack(page)).toBeVisible({ timeout: 60_000 });
	await expect(stack(page).getByRole('heading', { name: MEMO, exact: true })).toBeVisible();
	await expect(stack(page).getByRole('heading', { name: LIST, exact: true })).toHaveCount(0);
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	expect(await stored(page, PROVIDER_KEY)).toBe(saved);
	expect(await ops(page, PROVIDER_KEY)).toEqual([]);
});

/** The viewport width at which the dashboard's own box (`.page`) is `pageWidth` px wide. */
async function viewportWidthFor(page: Page, pageWidth: number): Promise<number> {
	const current = await page.locator('.page').evaluate((el) => el.clientWidth);
	return page.viewportSize()!.width - current + pageWidth;
}

const pageBoxWidth = (page: Page): Promise<number> =>
	page.locator('.page').evaluate((el) => el.clientWidth);

test('an IME composition in the memo holds the switch at the 900px boundary, both ways', async ({
	page
}) => {
	await openDashboard(page);
	const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
	const unsaved = page.getByText('未保存の変更があります');
	// A real composition (Chromium's IME protocol), not `fill`: the text being converted is in the
	// textarea only, and reaches the page's draft when it is committed.
	const cdp = await page.context().newCDPSession(page);
	const compose = (text: string) =>
		cdp.send('Input.imeSetComposition', {
			text,
			selectionStart: text.length,
			selectionEnd: text.length
		});
	const commit = (text: string) => cdp.send('Input.insertText', { text });

	// The narrowest dock: the page 901px wide.
	const wide = await viewportWidthFor(page, 901);
	await page.setViewportSize({ width: wide, height: 900 });
	await expect.poll(() => pageBoxWidth(page)).toBe(901);
	await expect(dockHost(page)).toBeVisible();

	// 901 -> 900 while converting: the dock, and the very textarea, stay.
	await memoInput.click();
	await compose('にほんご');
	await memoInput.evaluate((el) => el.setAttribute('data-composing-here', ''));
	await page.setViewportSize({ width: wide - 1, height: 900 });
	await expect.poll(() => pageBoxWidth(page)).toBe(900);
	await page.waitForTimeout(400);
	await expect(dockHost(page)).toBeVisible();
	await expect(stack(page)).toHaveCount(0);
	await expect(page.locator('textarea[data-composing-here]')).toHaveCount(1);
	// Committed: the text is taken, then the display switches.
	await commit('日本語');
	await expect(stack(page)).toBeVisible();
	await expect(dockHost(page)).toHaveCount(0);
	await expect(memoInput).toHaveValue('日本語');
	await expect(unsaved).toBeVisible();

	// 900 -> 901 while converting: the stack, and its textarea, stay.
	await memoInput.focus();
	await page.keyboard.press('Control+End');
	await compose('です');
	await memoInput.evaluate((el) => el.setAttribute('data-composing-here', ''));
	await page.setViewportSize({ width: wide, height: 900 });
	await expect.poll(() => pageBoxWidth(page)).toBe(901);
	await page.waitForTimeout(400);
	await expect(stack(page)).toBeVisible();
	await expect(dockHost(page)).toHaveCount(0);
	await expect(page.locator('textarea[data-composing-here]')).toHaveCount(1);
	await commit('です');
	await expect(dockHost(page)).toBeVisible();
	await expect(stack(page)).toHaveCount(0);
	await expect(memoInput).toHaveValue('日本語です');
	await expect(unsaved).toBeVisible();
	// The narrowest dock holds the default's panes side by side (three in the second row with
	// the charts; the list and the memo in any copy).
	const list = await pane(page, 'lowStock').boundingBox();
	const memo = await pane(page, 'memo').boundingBox();
	if (!list || !memo) throw new Error('not visible');
	expect(memo.x).toBeGreaterThan(list.x + list.width - 1);
	expect(memo.width).toBeGreaterThan(250);
	// With the charts: each pane of the second row is at least as wide as its chart needs (W1's
	// measurements, plan §4.13.8) - the weights of `dashboardLayout.ts`, not equal thirds.
	for (const [id, minWidth] of [
		['stackedBar', 300],
		['priceBuckets', 320],
		['scatter', 200]
	] as const) {
		if ((await pane(page, id).count()) === 0) continue; // a copy without the charts
		expect((await pane(page, id).boundingBox())?.width ?? 0, id).toBeGreaterThanOrEqual(minWidth);
	}
});

test("the memo's close question holds the switch: discarding closes the pane as well", async ({
	page
}) => {
	await openDashboard(page);
	const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
	const settleDialog = page.getByRole('dialog', { name: '保存していないメモ' });
	await memoInput.fill('not saved');
	await dockHost(page)
		.getByRole('button', { name: `${MEMO}を閉じる` })
		.click();
	await expect(settleDialog).toBeVisible();

	// Narrow while the question is open: the dock that asked stays until it is answered.
	await page.setViewportSize({ width: 700, height: 900 });
	await page.waitForTimeout(400);
	await expect(settleDialog).toBeVisible();
	await expect(dockHost(page)).toBeVisible();
	await expect(stack(page)).toHaveCount(0);

	// Discard: the text is dropped AND the pane is closed; only then the stack takes over.
	await settleDialog.getByRole('button', { name: '破棄して閉じる' }).click();
	await expect(settleDialog).toHaveCount(0);
	await expect(stack(page)).toBeVisible();
	await expect(dockHost(page)).toHaveCount(0);
	await expect(stack(page).getByRole('heading', { name: MEMO, exact: true })).toHaveCount(0);
	await expect(memoInput).toHaveCount(0);

	// Wide again: the memo is closed in the arrangement, and reopening it shows no leftover text.
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(dockHost(page)).toBeVisible();
	await expect(pane(page, 'memo')).toHaveCount(0);
	await toggleWidget(page, MEMO);
	await expect(memoInput).toHaveValue('');
});

test('"save and close" holds the switch until the save is back: the pane closes first, then the stack takes over', async ({
	page
}) => {
	await openDashboard(page);
	const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
	const settleDialog = page.getByRole('dialog', { name: '保存していないメモ' });
	await memoInput.fill('kept');
	await dockHost(page)
		.getByRole('button', { name: `${MEMO}を閉じる` })
		.click();
	await expect(settleDialog).toBeVisible();

	// Hold the memo's save: the local provider writes under this Web Lock (the REST / Tauri
	// providers wait on the server instead).
	await page.evaluate(() => {
		const w = window as unknown as { __releaseSave: () => void };
		void navigator.locks.request(
			'banto.ui.dashboard.memo',
			() => new Promise<void>((resolve) => (w.__releaseSave = resolve))
		);
	});

	await settleDialog.getByRole('button', { name: '保存して閉じる' }).click();
	// The dialog is gone, but the save is still running: narrowing now must not swap yet.
	await expect(settleDialog).toHaveCount(0);
	await page.setViewportSize({ width: 700, height: 900 });
	await page.waitForTimeout(400);
	await expect(dockHost(page)).toBeVisible();
	await expect(stack(page)).toHaveCount(0);
	await expect(memoInput).toBeVisible();

	// The save comes back: the pane closes, and only then the stack takes over.
	await page.evaluate(() => (window as unknown as { __releaseSave: () => void }).__releaseSave());
	await expect(stack(page)).toBeVisible();
	await expect(dockHost(page)).toHaveCount(0);
	await expect(stack(page).getByRole('heading', { name: MEMO, exact: true })).toHaveCount(0);
	await expect(memoInput).toHaveCount(0);
	expect(await stored(page, 'banto.ui.dashboard.memo')).toBe('kept');
});

test('keyboard only: add a widget, move it, hide it', async ({ page }) => {
	await openDashboard(page);
	const host = dockHost(page);
	const live = host.locator('.dock-live[aria-live="polite"]');
	// Start without the memo, so that checking it is an "add".
	await toggleWidget(page, MEMO);
	await expect(pane(page, 'memo')).toHaveCount(0);

	/** Open the View menu and put the focus on the memo's checkbox, with keys only. */
	async function focusMemoCheckbox(): Promise<Locator> {
		await viewButton(page).focus();
		await page.keyboard.press('Enter');
		const menu = page.getByRole('menu', { name: '表示' });
		await expect(menu).toBeVisible();
		const checkbox = menu.getByRole('menuitemcheckbox', { name: MEMO, exact: true });
		// The reset action is last, behind a separator; the memo is the last checkbox.
		await page.keyboard.press('End');
		await page.keyboard.press('ArrowUp');
		await expect(checkbox).toBeFocused();
		return checkbox;
	}

	// Add.
	const unchecked = await focusMemoCheckbox();
	await expect(unchecked).toHaveAttribute('aria-checked', 'false');
	await page.keyboard.press('Enter');
	await expect(unchecked).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menu', { name: '表示' })).toHaveCount(0);
	await expect(pane(page, 'memo')).toBeVisible();

	// Move: the panel actions menu on the title bar, first item = the dock's left edge.
	const menuButton = host.getByRole('button', { name: `${MEMO}のパネルの操作`, exact: true });
	const panelMenu = page.getByRole('menu', { name: `${MEMO}のパネルの操作`, exact: true });
	await menuButton.focus();
	await page.keyboard.press('Enter');
	await expect(panelMenu).toBeVisible();
	await expect(
		panelMenu.getByRole('menuitem', { name: '左端にドッキング', exact: true })
	).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(live).toHaveText(`${MEMO}を左端にドッキングしました`);
	const hostBox = await host.boundingBox();
	const paneBox = await pane(page, 'memo').boundingBox();
	if (!hostBox || !paneBox) throw new Error('not visible');
	expect(Math.abs(paneBox.x - hostBox.x)).toBeLessThan(8);
	expect(paneBox.height).toBeGreaterThan(hostBox.height - 16);
	await expect(menuButton).toBeFocused();

	// Hide.
	const checked = await focusMemoCheckbox();
	await expect(checked).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Enter');
	await expect(checked).toHaveAttribute('aria-checked', 'false');
	await page.keyboard.press('Escape');
	await expect(pane(page, 'memo')).toHaveCount(0);

	// All three were saved as one arrangement.
	await page.waitForTimeout(AFTER_DEBOUNCE_MS);
	const saved = await stored(page, PROVIDER_KEY);
	expect(saved).not.toBeNull();
	expect(await stored(page, LAYOUT_KEY)).toBe(saved);
});
