/**
 * M18 Phase B smoke E2E (docs/roadmap.md M18, docs/history/improvements.md §4).
 *
 * Runs against a real `banto-serve --features embed-ui` (LAN/REST mode, no
 * mocked DataProvider - see playwright.config.ts's doc comment) with a
 * brand-new SQLite database, so scenario 1 legitimately hits the first-run
 * setup screen. All scenarios share ONE browser page/session and run in
 * file order (`describe.serial` + `workers: 1`, config-wide): later
 * scenarios rely on state earlier ones created (the admin account, the
 * item, the viewer account, the audit trail, ...), the same way a person
 * clicking through the app once would. This is intentionally NOT a
 * from-scratch-state-per-test suite - keep new scenarios in this ordering
 * discipline rather than trying to make them independent.
 *
 * Deliberately scoped to a smoke pass (one scenario per screen, ~11 tests
 * total, per roadmap M18's non-scope note) - not exhaustive coverage of any
 * one feature (M14 audit log, M15 CSV, M16 command palette, M17 backups,
 * M20 attachments already have their own focused unit/integration tests
 * elsewhere).
 *
 * Flakiness: no explicit `waitForTimeout`/`sleep` in this file except one -
 * every wait is either Playwright's built-in locator auto-retry
 * (`expect(locator)...`) or a real event (`page.waitForEvent('download')`,
 * `page.once('dialog', ...)` for the unsaved-changes prompt, still a
 * `window.confirm`). The exception is scenario 13b's "the event
 * stream sends nothing more" check, which can only be observed over a window.
 */
import { expect, test, type Dialog, type Locator, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import { createFirstAdmin } from '../first-run-setup';
import {
	chooseItemsMode,
	chooseItemsMoreAction,
	expectItemsMode,
	type ItemsViewLabels
} from '../items-view-mode';
import { reloadAndReadIdentity } from '../reload-identity';
import { expectCheckOutageKeepsTheSession } from './session-check-outage';

// items の「表示」メニュー（読み込み方の切り替え、#553）。
const CLIENT_MODE: ItemsViewLabels = {
	trigger: '表示',
	item: '全件を読み込む（グループ化できる）'
};
const SERVER_MODE: ItemsViewLabels = {
	trigger: '表示',
	item: '少しずつ読み込む（大量データ向け）'
};

// An ordinary account. (Until v8.0.0 this was `public`, to show that an
// account sharing the viewer-public grant's fixed id is not taken for a
// synthetic session - #209. That name is reserved now, ADR-0034 §4: the
// account cannot be created. The rule itself - a session is judged by how it
// was issued, never by its name - is covered by the Rust tests.)
const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'E2eAdminPass1';
const ADMIN_DISPLAY_NAME = 'E2E管理者';

const VIEWER_USERNAME = 'e2e-viewer';
const VIEWER_PASSWORD = 'E2eViewerPass1';
const VIEWER_DISPLAY_NAME = 'E2E閲覧者';

// Timestamped so a stray leftover row from an interrupted previous run (this
// suite always starts from a fresh DB, so that shouldn't happen, but the
// name doubling as the grid-filter needle makes it worth being paranoid)
// can never collide with the row this run creates.
const ITEM_NAME = `E2Eテスト商品-${Date.now()}`;
const ITEM_PRICE = 1200;
const ITEM_PRICE_UPDATED = 1500;
const ITEM_STOCK = 10;

// Issue #215 scenario 3c: a dedicated item so its filter/sort round trip
// never touches (or is touched by) scenario 3's own item, which scenario 3
// deletes at its end.
const ROUNDTRIP_ITEM_NAME = `E2E往復テスト商品-${Date.now()}`;

// M20 attachments scenario (docs/design/attachments-plan.md §4 unit D): a
// dedicated item so uploads/deletes never touch the item scenario 3 already
// created and deleted.
const ATTACHMENT_ITEM_NAME = `E2E添付テスト商品-${Date.now()}`;
const PNG_FILE_NAME = 'attachment-test.png';
const PNG_FILE_NAME_2 = 'attachment-test-2.png';
const TXT_FILE_NAME = 'attachment-note.txt';

// Smallest possible valid PNG (1x1, black pixel) inlined as base64 rather
// than a committed binary fixture (spec's unit D guidance: prefer
// `setInputFiles({ name, mimeType, buffer })` over adding a binary to the
// repo) - real bytes so the server's `image::guess_format`/thumbnail
// pipeline (banto-attachments) actually exercises its real decode path,
// not a fake MIME label.
const MIN_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * The dashboard's View menu (#663 ①-C). With the default sidebar layout it is
 * the 「表示」 button in the page header (the menu bar would carry it instead).
 */
function dashboardViewMenu(page: Page): { open: () => Promise<Locator> } {
	const button = page.getByRole('main').getByRole('button', { name: '表示', exact: true });
	const menu = page.getByRole('menu', { name: '表示' });
	return {
		async open() {
			await button.click();
			await expect(menu).toBeVisible();
			return menu;
		}
	};
}

/** Puts the dashboard's dock back to the default layout from the View menu. */
async function resetDashboardLayout(page: Page): Promise<void> {
	const menu = await dashboardViewMenu(page).open();
	await menu.getByRole('menuitem', { name: 'レイアウトを既定に戻す' }).click();
	await expect(menu).toHaveCount(0);
}

/** Toggles one panel's checkbox in the dashboard's View menu, then closes the menu. */
async function toggleDashboardPanel(page: Page, name: string): Promise<void> {
	const menu = await dashboardViewMenu(page).open();
	await menu.getByRole('menuitemcheckbox', { name, exact: true }).click();
	// A checkbox keeps the menu open (ui Menu); Escape closes it.
	await expect(menu).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
}

function minimalPngBuffer(): Buffer {
	return Buffer.from(MIN_PNG_BASE64, 'base64');
}

/** Open a filterable column's header filter and apply a "contains" filter (the default op) with `value`. Mirrors a user clicking the ▾ icon, typing, and clicking 適用 (FilterPopover.svelte). */
async function applyColumnFilter(page: Page, columnHeader: string, value: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label, exact: true }).click();
	const dialog = page.getByRole('dialog', { name: label });
	await dialog.getByPlaceholder('値を入力').fill(value);
	await dialog.getByRole('button', { name: '適用' }).click();
}

/** Same as `applyColumnFilter` but for a number-typed column: picks `op` (FilterPopover.svelte's `<select>`, e.g. `'gte'`) before filling the numeric value. */
async function applyNumberFilter(
	page: Page,
	columnHeader: string,
	op: string,
	value: number
): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label, exact: true }).click();
	const dialog = page.getByRole('dialog', { name: label });
	await dialog.getByRole('combobox').selectOption(op);
	await dialog.getByPlaceholder('値を入力').fill(String(value));
	await dialog.getByRole('button', { name: '適用' }).click();
}

/** Reopen a column's filter and clear it (クリア), leaving the grid unfiltered on that column. */
async function clearColumnFilter(page: Page, columnHeader: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label, exact: true }).click();
	await page.getByRole('dialog', { name: label }).getByRole('button', { name: 'クリア' }).click();
}

/** A grid data row (role="row") whose rendered text contains `text` - matches both the header row and data rows structurally, so callers should pass text unique to a data row. */
function rowWithText(page: Page, text: string): Locator {
	return page.getByRole('row').filter({ hasText: text });
}

/** #591: the id of a grid data row (its ID cell), as text. */
async function rowItemId(row: Locator): Promise<string> {
	const id = (await row.locator('[data-cell-field="id"]').innerText()).trim();
	expect(id).toMatch(/^\d+$/);
	return id;
}

/** #591: the row's "open" button (the first column), which opens the record in the list's drawer. */
function openButtonOf(row: Locator, id: string): Locator {
	return row.getByRole('button', { name: `ID ${id} を開く`, exact: true });
}

/** #591: the list's detail drawer for item `id` (its title is the accessible name). */
function itemDrawer(page: Page, id: string): Locator {
	return page.getByRole('dialog', { name: `商品 ID ${id}`, exact: true });
}

/** #591: click the row's open button until the drawer shows (a click before hydration does nothing). */
async function openInDrawer(page: Page, row: Locator, id: string): Promise<Locator> {
	const drawer = itemDrawer(page, id);
	await expect(async () => {
		if (!(await drawer.isVisible())) await openButtonOf(row, id).click();
		await expect(drawer).toBeVisible({ timeout: 1_000 });
	}).toPass();
	return drawer;
}

/** Opens the header's user menu and clicks "ログアウト" (Header.svelte moved logout off a bare header button into the shared Menu component - visual-refresh-design.md §8.2). */
async function logout(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
	await page.getByRole('menuitem', { name: 'ログアウト' }).click();
}

/** Issue #260 実装-3 (wiring ②): the change-of-user notice (messages/ja.json `session.ownerChanged`). */
const OWNER_CHANGED_NOTICE = '別のユーザーでログインされました';

/** Issue #214: the unsaved-changes guard's prompt (messages/ja.json `unsaved.confirmLeave`). */
const LEAVE_PROMPT = '保存していない変更があります。変更を破棄してこの画面から移動しますか？';

/**
 * Answers `window.confirm` dialogs from a queue and records every message, so
 * a test can assert both that a prompt appeared and that NO unexpected one
 * did. A dialog with no queued answer is dismissed (= "stay"), which also
 * makes an unexpected prompt fail the following URL assertion.
 */
function trackDialogs(page: Page): {
	messages: string[];
	answer(accept: boolean): void;
	stop(): void;
} {
	const messages: string[] = [];
	const answers: boolean[] = [];
	const onDialog = (dialog: Dialog) => {
		messages.push(dialog.message());
		void (answers.shift() ? dialog.accept() : dialog.dismiss());
	};
	page.on('dialog', onDialog);
	return {
		messages,
		answer: (accept) => answers.push(accept),
		stop: () => page.off('dialog', onDialog)
	};
}

/**
 * Answers the in-page confirm dialog (`@banto/ui` ConfirmDialog, Issue #556)
 * that replaced `window.confirm` for deletes and the like. The click that opens
 * it is retried (`toPass`): a click that lands before hydration does nothing.
 * `type` fills the type-to-confirm text box first (user delete).
 */
async function confirmInDialog(
	page: Page,
	trigger: Locator,
	options: { title: string; confirm: string; type?: string }
): Promise<void> {
	const dialog = page.getByRole('alertdialog', { name: options.title });
	await expect(async () => {
		if (!(await dialog.isVisible())) await trigger.click();
		await expect(dialog).toBeVisible({ timeout: 1_000 });
	}).toPass();
	if (options.type !== undefined) await dialog.getByRole('textbox').fill(options.type);
	await dialog.getByRole('button', { name: options.confirm, exact: true }).click();
	await expect(dialog).toBeHidden();
}

test.describe.serial('Banto LAN/REST smoke', () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		// This manually-created shared page bypasses the config's `use`
		// context options, so reduced motion must be passed here explicitly.
		// Without it, View Transitions (visual-refresh-design.md §11.1) freeze
		// the OLD page's snapshot for the crossfade after each navigation and
		// locators can pin an element from the outgoing page (e.g. getByLabel
		// substring-matching a grid filter button right after goto /items/new).
		page = await browser.newPage({ reducedMotion: 'reduce' });
	});

	test.afterAll(async () => {
		// Optional chaining: if beforeAll throws before `page` is assigned, an
		// unguarded page.close() raises a TypeError here that masks the real
		// failure cause (e.g. a missing Playwright browser).
		await page?.close();
	});

	test('1. first-run setup creates the admin account and reaches the dashboard', async () => {
		await createFirstAdmin(page, {
			displayName: ADMIN_DISPLAY_NAME,
			username: ADMIN_USERNAME,
			password: ADMIN_PASSWORD
		});
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		// With public viewing disabled, reload restores the ordinary account
		// from the identity endpoint.
		expect(await reloadAndReadIdentity(page)).toMatchObject({
			id: ADMIN_USERNAME,
			role: 'admin',
			kind: 'account'
		});
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
	});

	test('2. logout returns to the login screen, then login restores the session', async () => {
		// #609 B-7: an admin notice is saved once and visible before login.
		await page.goto('/settings/appearance');
		await page.getByRole('textbox', { name: 'お知らせ' }).fill('本日 18 時から保守します');
		await page.getByRole('button', { name: 'お知らせを保存' }).click();
		await expect(
			page.getByText('ログイン画面のお知らせを保存しました', { exact: true })
		).toBeVisible();
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByText('本日 18 時から保守します')).toBeVisible();
		await expect(page.locator('.login-context')).toContainText('接続先');
		await expect(page.locator('.login-context')).toContainText('バージョン');

		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await page.goto('/settings/appearance');
		await page.getByRole('textbox', { name: 'お知らせ' }).fill('');
		await page.getByRole('button', { name: 'お知らせを保存' }).click();
		await expect(
			page.getByText('ログイン画面のお知らせを保存しました', { exact: true })
		).toBeVisible();
	});

	test('3. items: create, appears in the grid, edit, delete', async () => {
		await page.goto('/items');
		await page.getByRole('button', { name: '新規作成' }).click();
		await expect(page).toHaveURL(/\/items\/new$/);

		await page.getByLabel('商品名').fill(ITEM_NAME);
		await page.getByLabel('価格').fill(String(ITEM_PRICE));
		await page.getByLabel('在庫').fill(String(ITEM_STOCK));
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		// Server-mode grid, 1,000 seeded demo rows: filter by name (unique,
		// timestamped) rather than scrolling/scanning for the new row.
		await applyColumnFilter(page, '商品名', ITEM_NAME);
		const row = rowWithText(page, ITEM_NAME);
		await expect(row).toBeVisible();

		// #591: the row's open button (the first column) opens the drawer.
		const itemId = await rowItemId(row);
		const href = `/items/${itemId}`;
		const openButton = openButtonOf(row, itemId);

		// Keyboard edit completion returns focus for the next action (#212,
		// spec §4.5). Use real server saves before continuing without a mouse.
		const grid = page.getByRole('grid');
		const priceCell = row.locator('[data-cell-field="price"]');
		const editor = grid.locator('.cell-editor');
		// Hold every list response while saving two different columns (#212,
		// PR #225 P1). A successful update must become the next edit's row
		// before refresh completes, otherwise its full payload loses a save.
		let releaseLists!: () => void;
		const listGate = new Promise<void>((resolve) => {
			releaseLists = resolve;
		});
		let heldLists = 0;
		const listUrl = /\/api\/items\/list$/;
		const pendingLists = new Set<Promise<void>>();
		await page.route(listUrl, (route) => {
			const pending = (async () => {
				if (route.request().method() !== 'POST') return route.continue();
				const response = await route.fetch();
				heldLists++;
				await listGate;
				await route.fulfill({ response });
			})();
			pendingLists.add(pending);
			return pending.finally(() => pendingLists.delete(pending));
		});
		try {
			await priceCell.dblclick();
			await editor.fill(String(ITEM_PRICE + 1));
			await page.keyboard.press('Tab');
			await expect(grid).toBeFocused();
			await expect.poll(() => heldLists).toBeGreaterThan(0);
			await page.keyboard.press('F2');
			await expect(editor).toHaveValue(String(ITEM_STOCK));
			await editor.fill(String(ITEM_STOCK + 1));
			await page.keyboard.press('Enter');
			await expect(grid).toBeFocused();
			const saved = await page.evaluate(async (url) => {
				const token =
					localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
				const response = await fetch(`/api${url}`, {
					headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
				});
				if (!response.ok) throw new Error(`get item failed: ${response.status}`);
				return response.json();
			}, href);
			expect(saved).toMatchObject({ price: ITEM_PRICE + 1, stock: ITEM_STOCK + 1 });
			// Restore through the same keyboard path, still without any list
			// response reaching the app, for the existing CRUD assertions below.
			await page.keyboard.press('F2');
			await expect(editor).toHaveValue(String(ITEM_STOCK + 1));
			await editor.fill(String(ITEM_STOCK));
			await page.keyboard.press('Shift+Tab');
			await expect(grid).toBeFocused();
			await page.keyboard.press('F2');
			await expect(editor).toHaveValue(String(ITEM_PRICE + 1));
			await editor.fill(String(ITEM_PRICE));
			await page.keyboard.press('Enter');
			await expect(grid).toBeFocused();
		} finally {
			releaseLists();
			// Finish the held replies before disabling network interception.
			while (pendingLists.size > 0) await Promise.all([...pendingLists]);
			await page.unrouteAll({ behavior: 'wait' });
		}
		await priceCell.dblclick();
		for (const price of [ITEM_PRICE + 1, ITEM_PRICE]) {
			await expect(editor).toBeFocused();
			await editor.fill(String(price));
			await page.keyboard.press('Enter');
			await expect(grid).toBeFocused();
			// The saved row is available even before the provider's refresh.
			await expect(priceCell).toHaveText(`¥${price.toLocaleString('en-US')}`);
			await page.keyboard.press('F2');
			await expect(editor).toHaveValue(String(price));
		}
		await editor.fill('9999');
		await page.keyboard.press('Escape');
		await expect(editor).toHaveCount(0);
		await expect(grid).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'stock');
		await page.keyboard.press('F2');
		await expect(editor).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(grid).toBeFocused();
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'updatedAt');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('F2');
		await expect(editor).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(grid).toBeFocused();
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'price');

		// Non-editing Tab follows native focus order (spec §4.5, #211).
		// jsdom cannot perform default Tab navigation, so exercise both grid
		// boundaries here, with one filtered row to keep the sequence bounded.
		const createButton = page.getByRole('button', { name: '新規作成' });
		// The applied filter's chip x sits between "New" and the grid (#555 B-2).
		const chipRemove = page.getByRole('button', { name: /の絞り込みを外す$/ });
		await expect(chipRemove).toHaveCount(1);
		await row.locator('[data-cell-field="name"]').click();
		await expect(grid).toBeFocused();
		await page.keyboard.press('Home');
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'open');
		await page.keyboard.press('Shift+Tab');
		await expect(chipRemove).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(createButton).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(chipRemove).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(grid).toBeFocused();
		await page.keyboard.press('End');
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'updatedAt');

		// Keep header sort/filter controls and the row's open button reachable. Tab
		// events bubbling from those controls must not move the selected cell
		// or trap focus either; the non-sortable actions header is not a tab stop.
		// #713: items offers the bulk delete, so the grid is `selectable` - the
		// header's "select all" checkbox is the first tab stop of the header row
		// and the row's checkbox comes before its open button.
		const headerControls = await grid
			.getByRole('row')
			.first()
			.locator('[tabindex="0"], button, input[type="checkbox"]')
			.all();
		expect(headerControls.length).toBeGreaterThan(0);
		await expect(headerControls[0]).toHaveAttribute('type', 'checkbox');
		const rowCheckbox = row.getByRole('checkbox');
		await expect(rowCheckbox).toHaveCount(1);
		const gridTabStops = [...headerControls, rowCheckbox, openButton];
		for (const control of gridTabStops) {
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
		}
		await page.keyboard.press('Tab');
		await expect(grid.locator(':focus')).toHaveCount(0);
		for (const control of [...[...gridTabStops].reverse(), grid, chipRemove, createButton]) {
			await page.keyboard.press('Shift+Tab');
			await expect(control).toBeFocused();
		}
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'updatedAt');

		// Activate controls reached by Tab while an editable cell remains
		// selected: Enter must act on the focused control, not start editing.
		await row.locator('[data-cell-field="name"]').click();
		// The "select all" checkbox, then the ID header.
		await page.keyboard.press('Tab');
		await expect(headerControls[0]).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(grid.getByRole('button', { name: 'ID', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		// Column headers: "select all", the open button's, then ID.
		await expect(grid.getByRole('columnheader').nth(2)).toHaveAttribute('aria-sort', 'ascending');
		await expect(grid.locator('.cell-editor')).toHaveCount(0);
		await expect(row).toBeVisible();
		await row.locator('[data-cell-field="name"]').click();
		// Checkbox, ID sort, ID filter, name sort, name filter.
		for (const control of headerControls.slice(0, 5)) {
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
		}
		await expect(grid.getByRole('button', { name: '商品名の絞り込み', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		const filterDialog = page.getByRole('dialog', { name: '商品名の絞り込み' });
		await expect(filterDialog).toBeVisible();
		await expect(grid.locator('.cell-editor')).toHaveCount(0);
		// #213: keyboard events inside the filter retain native control
		// behavior even while an editable grid cell remains selected.
		const filterInput = filterDialog.getByPlaceholder('値を入力');
		const filterOperator = filterDialog.getByRole('combobox');
		await filterInput.fill(ITEM_NAME);
		for (const [key, caret] of [
			['Home', 0],
			['ArrowRight', 1],
			['ArrowLeft', 0],
			['End', ITEM_NAME.length]
		] as const) {
			await page.keyboard.press(key);
			await expect(filterInput).toBeFocused();
			await expect
				.poll(() => filterInput.evaluate((input: HTMLInputElement) => input.selectionStart))
				.toBe(caret);
			await expect(row.locator('.cell.active')).toHaveAttribute('data-cell-field', 'name');
			await expect(editor).toHaveCount(0);
		}
		await page.keyboard.press('Shift+Tab');
		await expect(filterOperator).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(filterOperator).toHaveValue('starts_with');
		await page.keyboard.press('ArrowDown');
		await expect(filterOperator).toHaveValue('eq');
		await page.keyboard.press('Tab');
		await expect(filterInput).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(filterDialog.getByRole('button', { name: '適用', exact: true })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(filterInput).toBeFocused();
		await expect(row.locator('.cell.active')).toHaveAttribute('data-cell-field', 'name');
		await expect(editor).toHaveCount(0);
		const appliedFilter = page.waitForRequest(
			(request) =>
				new URL(request.url()).pathname === '/api/items/list' && request.method() === 'POST'
		);
		await page.keyboard.press('Enter');
		expect((await appliedFilter).postDataJSON().filters).toEqual([
			{ field: 'name', op: 'eq', value: ITEM_NAME }
		]);
		await expect(filterDialog).toHaveCount(0);
		await expect(grid.locator('.cell-editor')).toHaveCount(0);
		await expect(row).toBeVisible();
		await row.locator('[data-cell-field="name"]').click();
		for (const control of gridTabStops) {
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
		}

		// Edit in the drawer (#591): Enter on the focused open button opens it
		// next to the list with `?id=`; a save keeps it open and refreshes the
		// row; closing gives focus back to the button. Then independently
		// re-open the record (by URL, the detail page) to confirm the new value
		// actually persisted server-side.
		await page.keyboard.press('Enter');
		const drawer = itemDrawer(page, itemId);
		await expect(drawer).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`/items[?]id=${itemId}$`));
		const drawerPrice = drawer.getByRole('spinbutton', { name: /^価格/ });
		await expect(drawerPrice).toHaveValue(String(ITEM_PRICE));
		await drawerPrice.fill(String(ITEM_PRICE_UPDATED));
		await drawer.getByRole('button', { name: '保存', exact: true }).click();
		await expect(row.locator('[data-cell-field="price"]')).toHaveText(
			`¥${ITEM_PRICE_UPDATED.toLocaleString('en-US')}`
		);
		await expect(drawer).toBeVisible();

		// History tab (#591 stage 2, admin only): this record's audit log,
		// narrowed by resource and entityId. The save above is on the list.
		await drawer.getByRole('tab', { name: '履歴', exact: true }).click();
		const historyTable = drawer.getByRole('table', { name: /履歴/ });
		await expect(async () => {
			await expect(historyTable).toBeVisible();
			await expect(
				historyTable.getByRole('cell', { name: '更新', exact: true }).first()
			).toBeVisible();
		}).toPass();
		// #597: the update row carries what changed (the price, before -> after),
		// under the form's label, not the internal field name. This record can
		// have several update rows (earlier steps and retries reuse the id), so
		// take the newest one that carries the new price (the list is ts desc).
		const historyChanges = drawer
			.getByTestId('audit-changes-inline')
			.filter({ hasText: String(ITEM_PRICE_UPDATED) })
			.first();
		await expect(historyChanges).toContainText('価格');
		await expect(historyChanges).toContainText(String(ITEM_PRICE));
		await expect(historyChanges).toContainText(String(ITEM_PRICE_UPDATED));
		// The link to the audit-log screen carries the record scope; it is
		// followed after the drawer flow below (same page: the token lives in this
		// tab's sessionStorage).
		const auditHref = await drawer
			.getByRole('link', { name: '監査ログで全部見る' })
			.getAttribute('href');
		expect(auditHref).toContain(`recordResource=items&recordId=${itemId}`);
		await drawer.getByRole('tab', { name: '詳細', exact: true }).click();
		await expect(drawerPrice).toHaveValue(String(ITEM_PRICE_UPDATED));

		await drawer.getByRole('button', { name: '閉じる', exact: true }).first().click();
		await expect(drawer).toBeHidden();
		await expect(page).toHaveURL(/\/items$/);
		await expect(openButton).toBeFocused();

		// The audit-log screen starts filtered to this record and the query
		// leaves the URL.
		await page.goto(auditHref!);
		await expect(page).toHaveURL(/\/audit-log$/);
		const activeFilters = page.getByRole('group', { name: '適用中の絞り込み' });
		await expect(activeFilters.getByText('記録先リソース')).toBeVisible();
		await expect(activeFilters.getByText('記録先ID')).toBeVisible();
		await expect(activeFilters.getByRole('button', { name: 'すべて解除' })).toBeVisible();
		await expect(page.getByTestId('audit-count-note')).toContainText(/\d/);
		await expect(rowWithText(page, 'items').first()).toBeVisible();
		// Every row shown belongs to this record: no other item's history. The
		// whole cell text must equal the id (a string `hasNotText` is a substring
		// match, so id 1 would let 10 / 100 through).
		await expect(page.locator('[data-cell-field="entityId"]').first()).toHaveText(String(itemId));
		await expect(
			page
				.locator('[data-cell-field="entityId"]')
				.filter({ hasNotText: new RegExp(`^\\s*${itemId}\\s*$`) })
		).toHaveCount(0);

		// #597: selecting the update row shows the field table (field / before /
		// after) instead of the raw JSON. This record can have several update
		// rows (earlier steps and retries reuse the id), so look through them for
		// the one whose price went ITEM_PRICE -> ITEM_PRICE_UPDATED.
		await expect(async () => {
			const updateRows = rowWithText(page, '更新');
			const count = await updateRows.count();
			expect(count).toBeGreaterThan(0);
			let found = false;
			for (let i = 0; i < count && !found; i++) {
				await updateRows.nth(i).click();
				const changes = page.getByTestId('audit-changes');
				// An update that changed nothing shows a note instead of the table.
				await expect(changes.or(page.getByText('変更された欄はありません'))).toBeVisible();
				const priceRow = changes
					.getByRole('row')
					.filter({ hasText: '価格' })
					.filter({ hasText: String(ITEM_PRICE) })
					.filter({ hasText: String(ITEM_PRICE_UPDATED) });
				found = (await priceRow.count()) > 0;
			}
			expect(found).toBe(true);
		}).toPass();

		// #597 stage 2: the detail's 「対象を開く」 opens that record in the
		// list's drawer (`?id=`).
		await page.getByTestId('audit-open-target').click();
		await expect(page).toHaveURL(new RegExp(`/items[?]id=${itemId}$`));
		await expect(itemDrawer(page, itemId)).toBeVisible();

		await page.goto(href);
		await expect(page.getByLabel('価格')).toHaveValue(String(ITEM_PRICE_UPDATED));

		// Delete (the in-page confirm dialog, Issue #556).
		await confirmInDialog(page, page.getByRole('button', { name: '削除' }), {
			title: '削除の確認',
			confirm: '削除'
		});
		await expect(page).toHaveURL(/\/items$/);

		await page.goto(href);
		await expect(page.getByText('商品が見つかりません')).toBeVisible();
	});

	// Issue #214: leaving the item form with unsaved input asks first. "Stay"
	// keeps the input, "leave" moves; no prompt after a save, after undoing
	// the edit, or for a clean form.
	test('3a. items: unsaved input asks before leaving, save and a clean form do not', async () => {
		const dialogs = trackDialogs(page);
		const unsaved = page.getByText('未保存の変更があります');
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		try {
			await page.goto('/items/new');
			const name = page.getByLabel('商品名');
			await expect(name).toBeVisible();
			await expect(unsaved).toHaveCount(0);

			await name.fill('E2E未保存の入力');
			await expect(unsaved).toBeVisible();

			// Stay: the navigation is cancelled and the input survives.
			dialogs.answer(false);
			await mainNav.getByRole('link', { name: 'ダッシュボード' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/items\/new$/);
			await expect(name).toHaveValue('E2E未保存の入力');
			await expect(page.getByRole('button', { name: '保存' })).toBeEnabled();

			// Leave via the form's own "back to list" (= cancel).
			dialogs.answer(true);
			await page.getByRole('link', { name: '一覧へ戻る' }).click();
			await expect(page).toHaveURL(/\/items$/);
			expect(dialogs.messages).toHaveLength(2);

			// Typing and then undoing the edit is not "unsaved".
			await page.getByRole('button', { name: '新規作成' }).click();
			await expect(page).toHaveURL(/\/items\/new$/);
			await page.getByLabel('商品名').fill('一時的');
			await expect(unsaved).toBeVisible();
			await page.getByLabel('商品名').fill('');
			await expect(unsaved).toHaveCount(0);
			// Blur first: the now-empty required field shows its error on
			// blur, which shifts the footer - clicking straight away would let
			// that layout shift swallow the click.
			await page.getByLabel('商品名').blur();
			await expect(page.getByText('必須項目です')).toBeVisible();
			await page.getByRole('link', { name: '一覧へ戻る' }).click();
			await expect(page).toHaveURL(/\/items$/);

			// A successful save goes back to the list without a prompt.
			await page.getByRole('button', { name: '新規作成' }).click();
			await expect(page).toHaveURL(/\/items\/new$/);
			await page.getByLabel('商品名').fill(`E2E未保存ガード-${Date.now()}`);
			await page.getByLabel('価格').fill('10');
			await page.getByLabel('在庫').fill('1');
			const created = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/items' &&
					response.request().method() === 'POST'
			);
			await page.getByRole('button', { name: '保存' }).click();
			const createdId = ((await (await created).json()) as { id: number }).id;
			await expect(page).toHaveURL(/\/items$/);
			expect(dialogs.messages).toHaveLength(2);

			// Keep the item count at its seed baseline for later scenarios.
			await page.evaluate(async (id) => {
				const token =
					localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
				const res = await fetch(`/api/items/${id}`, {
					method: 'DELETE',
					headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
				});
				if (!res.ok) throw new Error(`delete failed: ${res.status}`);
			}, createdId);
		} finally {
			dialogs.stop();
		}
	});

	// Owner review on PR #232: agreeing to leave while a save is in flight,
	// then the save finishing BEFORE the chosen screen has loaded, must still
	// end on the chosen screen - not be overridden by the post-save goto back
	// to the list. The save reply and the chosen screen's code (its route
	// chunk - this page was freshly loaded, so the dashboard's is not in the
	// module cache yet) are both held so the order is fixed:
	// agree to leave -> save succeeds -> the chosen screen finishes loading.
	test('3b. items: a save that finishes after agreeing to leave does not override the chosen screen', async () => {
		const dialogs = trackDialogs(page);
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		let releaseSave!: () => void;
		const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
		let releaseChunks!: () => void;
		const chunkGate = new Promise<void>((resolve) => (releaseChunks = resolve));
		let chunkHeld = false;
		let createdId: number | undefined;
		try {
			await page.goto('/items/new');
			await page.getByLabel('商品名').fill(`E2E離脱中の保存-${Date.now()}`);
			await page.getByLabel('価格').fill('10');
			await page.getByLabel('在庫').fill('1');

			await page.route('**/api/items', async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				await saveGate;
				return route.continue();
			});
			const created = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/items' &&
					response.request().method() === 'POST'
			);
			await page.getByRole('button', { name: '保存' }).click();

			// Hold every app chunk requested from now on: the chosen screen
			// cannot finish loading until they are released.
			await page.route('**/_app/immutable/**', async (route) => {
				chunkHeld = true;
				await chunkGate;
				return route.continue();
			});
			dialogs.answer(true);
			await mainNav.getByRole('link', { name: 'ダッシュボード' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect.poll(() => chunkHeld).toBe(true);

			// The save wins the race while the dashboard is still loading.
			releaseSave();
			createdId = ((await (await created).json()) as { id: number }).id;
			await expect(page.getByText('保存しました')).toBeVisible();

			releaseChunks();
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(page).toHaveURL(/\/dashboard$/);
			expect(dialogs.messages).toHaveLength(1);
		} finally {
			releaseSave();
			releaseChunks();
			await page.unrouteAll({ behavior: 'wait' });
			dialogs.stop();
		}
		// A late goto('/items') would have replaced the dashboard by now:
		// every request it makes has been let through above.
		await expect(page).toHaveURL(/\/dashboard$/);

		// Keep the item count at its seed baseline for later scenarios.
		await page.evaluate(async (id) => {
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const res = await fetch(`/api/items/${id}`, {
				method: 'DELETE',
				headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
			});
			if (!res.ok) throw new Error(`delete failed: ${res.status}`);
		}, createdId!);
	});

	// Issue #215: a list -> detail -> save -> list round trip must restore
	// the filter/sort the user had (not reset to the page's defaults), mark
	// the row that was just worked on, and - if the save moved the row
	// outside the still-active filter - explain that instead of silently
	// clearing the filter. サーバーモード grid (the page's default), which is
	// also what scenario 3 above exercises.
	test('3c. items: a save round trip restores the filter/sort and marks the row; an edit that no longer matches the filter is explained, not hidden by clearing it', async () => {
		await page.goto('/items');
		await page.getByRole('button', { name: '新規作成' }).click();
		await expect(page).toHaveURL(/\/items\/new$/);
		await page.getByLabel('商品名').fill(ROUNDTRIP_ITEM_NAME);
		await page.getByLabel('価格').fill('800');
		await page.getByLabel('在庫').fill('3');
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		// Narrow to just this row (name filter) and add a second, numeric
		// filter that price=800 currently satisfies - so editing price alone
		// can later violate ONLY the second filter without the row ever
		// leaving view via the first. Also sort - a second axis of "state"
		// that must survive the round trip alongside the filters.
		await applyColumnFilter(page, '商品名', ROUNDTRIP_ITEM_NAME);
		await applyNumberFilter(page, '価格', 'gte', 500);
		const row = rowWithText(page, ROUNDTRIP_ITEM_NAME);
		await expect(row).toBeVisible();

		const grid = page.getByRole('grid');
		// Substring match on the columnheader is stable across a sort toggle
		// (no other column's name contains "価格"); the inner `.cell-body` is
		// clicked directly rather than by accessible name, since HeaderCell
		// appends the sort arrow to THAT name once sorted (e.g. "価格 ▲"),
		// which would make an `exact: true` button-name lookup stop matching
		// after the first click.
		const priceHeader = grid.getByRole('columnheader', { name: '価格' });
		const priceSortBody = priceHeader.locator('.cell-body');
		await priceSortBody.click();
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		await priceSortBody.click();
		await expect(priceHeader).toHaveAttribute('aria-sort', 'descending');

		const itemId = await rowItemId(row);
		const href = `/items/${itemId}`;

		// Edit 1 (in the list's drawer, #591): price still satisfies both
		// filters (name unaffected, price 850 >= 500) - the row must still be
		// there, under the same filters and sort, AND marked as the one just
		// worked on (rowClass `resource-row-last-opened`, ResourceListPage.svelte).
		const drawer = await openInDrawer(page, row, itemId);
		await drawer.getByRole('spinbutton', { name: /^価格/ }).fill('850');
		await drawer.getByRole('button', { name: '保存', exact: true }).click();
		await expect(row.locator('[data-cell-field="price"]')).toHaveText('¥850');
		// The list can show the new price (SSE refresh) before the save's own
		// answer settles, and the drawer ignores closing while a save is in
		// flight - wait for the save to finish, as test 4 does.
		await expect(drawer.getByText('未保存の変更があります')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(drawer).toBeHidden();
		await expect(page).toHaveURL(/\/items$/);

		await expect(priceHeader).toHaveAttribute('aria-sort', 'descending');
		await expect(row).toBeVisible();
		await expect(row).toHaveClass(/resource-row-last-opened/);
		await page.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
		await expect(
			page.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
		).toHaveValue(ROUNDTRIP_ITEM_NAME);
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: '価格の絞り込み', exact: true }).click();
		await expect(
			page.getByRole('dialog', { name: '価格の絞り込み' }).getByPlaceholder('値を入力')
		).toHaveValue('500');
		await page.keyboard.press('Escape');
		await expect(page.getByText(/現在の絞り込み条件に当てはまりません/)).toHaveCount(0);

		// Edit 2 (on the detail page, the round trip of #215): price now FAILS
		// the 価格>=500 filter (still passes the name filter). The row must
		// disappear from view (真面目にフィルタが効いて いる証拠) - but the
		// filter itself must NOT be reset, and a notice must explain why this
		// item no longer shows.
		await page.goto(href);
		await expect(page.getByLabel('価格')).toHaveValue('850');
		await page.getByLabel('価格').fill('100');
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await expect(row).toHaveCount(0);
		await expect(
			page.getByText(new RegExp(`商品 #${itemId} は現在の絞り込み条件に当てはまりません`))
		).toBeVisible();
		await page.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
		await expect(
			page.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
		).toHaveValue(ROUNDTRIP_ITEM_NAME);
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: '価格の絞り込み', exact: true }).click();
		await expect(
			page.getByRole('dialog', { name: '価格の絞り込み' }).getByPlaceholder('値を入力')
		).toHaveValue('500');
		await page.keyboard.press('Escape');

		// Dismissing the notice hides it without touching the filters again.
		await page.locator('.filter-exclusion-notice').getByRole('button', { name: '閉じる' }).click();
		await expect(page.locator('.filter-exclusion-notice')).toHaveCount(0);
		await page.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
		await expect(
			page.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
		).toHaveValue(ROUNDTRIP_ITEM_NAME);
		await page.keyboard.press('Escape');

		// Cleanup: clear the filters and sort (leaves the grid exactly as
		// later scenarios expect it - unfiltered, unsorted) and delete the
		// item via the API, same pattern scenario 3a/3b use for their own
		// leftover items.
		await clearColumnFilter(page, '商品名');
		await clearColumnFilter(page, '価格');
		await priceSortBody.click(); // desc -> removed (toggleSort)
		await expect(priceHeader).not.toHaveAttribute('aria-sort', 'descending');
		await page.evaluate(async (id) => {
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const res = await fetch(`/api/items/${id}`, {
				method: 'DELETE',
				headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
			});
			if (!res.ok) throw new Error(`delete failed: ${res.status}`);
		}, itemId);
	});

	// Issue #215/#255 review (fix 2): a detail-page save's response can
	// arrive after this tab's session has already moved on - the user (or
	// someone else) logged out and a login (same or different account)
	// completed while the request was still in flight. That response must
	// not resurrect the OLD session's "last edited row" marker under the
	// NEW session, or the exclusion-notice check (scenario 3c) would run
	// against a row that has nothing to do with what's on screen now.
	test('3d. items: a save response that arrives after logout+re-login does not resurrect the last-edited marker', async () => {
		await page.goto('/items');
		await page.getByRole('button', { name: '新規作成' }).click();
		await expect(page).toHaveURL(/\/items\/new$/);
		const STALE_SAVE_ITEM_NAME = `E2E陳腐化保存-${Date.now()}`;
		await page.getByLabel('商品名').fill(STALE_SAVE_ITEM_NAME);
		await page.getByLabel('価格').fill('300');
		await page.getByLabel('在庫').fill('2');
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await applyColumnFilter(page, '商品名', STALE_SAVE_ITEM_NAME);
		const row = rowWithText(page, STALE_SAVE_ITEM_NAME);
		const itemId = await rowItemId(row);
		const href = `/items/${itemId}`;

		await page.goto(href);
		await expect(page.getByLabel('価格')).toHaveValue('300');

		let releaseSave!: () => void;
		const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
		// Fulfill with a FAKE success instead of `route.continue()`: the real
		// backend revokes the bearer token on logout, so a request that was
		// only IN FLIGHT before the logout below would come back 401 either
		// way once actually forwarded - which would make this test pass
		// regardless of whether the fix exists (confirmed while writing this
		// test: `result.ok` was already `false` via the real server, so the
		// marker-write code this scenario targets was never even reached).
		// Faking the response is what actually exercises "a save that
		// SUCCEEDS after the session moved on", the case the fix guards.
		await page.route(`**/api/items/${itemId}`, async (route) => {
			if (route.request().method() !== 'PUT') return route.continue();
			await saveGate;
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					id: Number(itemId),
					name: STALE_SAVE_ITEM_NAME,
					price: 850,
					stock: 2,
					updatedAt: '2026-01-01'
				})
			});
		});
		try {
			await page.getByLabel('価格').fill('850');
			await page.getByRole('button', { name: '保存' }).click();
			// The click starts `formResource.submit()`, which is now held at
			// the route above - no response yet, so nothing to `waitForResponse`
			// on until `releaseSave()` below.

			// Logging out is a FORCED navigation (unsavedChanges.ts:
			// "every path to /login means the session is ending") - no
			// confirm dialog, unlike scenario 3b's leave-to-dashboard case.
			await logout(page);
			await expect(page).toHaveURL(/\/login$/);

			// Re-login as the SAME account: the owner matches again, so only
			// the session generation (the logout ended the session; the
			// detail page's captured scope is stale) and the page's own
			// teardown keep the old save from writing its marker.
			await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await page.getByRole('button', { name: 'ログイン' }).click();
			await expect(page).toHaveURL(/\/dashboard$/);

			// NOW let the held (faked-success) save resolve - after both the
			// logout and the next login have fully completed.
			releaseSave();

			// A deliberate, bounded exception to this file's no-waitForTimeout
			// policy (like scenario 13b's own exception): there is no visible
			// UI signal for "handleSubmit's `.then` continuation has run" once
			// its page has already navigated away twice - `expect.poll` would
			// wrongly PASS on its very first check (before the write has had a
			// chance to happen) rather than catch a write that happens a
			// moment later, since a poll stops at its first matching read.
			await page.waitForTimeout(500);
			expect(
				await page.evaluate(() => sessionStorage.getItem('banto.listView.lastEdited.items'))
			).toBeNull();
			// The dashboard is still what's on screen - the stale save did not
			// drag this tab back to /items either (guard.canAutoNavigate is
			// false once the user has already left, same as scenario 3b).
			await expect(page).toHaveURL(/\/dashboard$/);
		} finally {
			releaseSave();
			await page.unrouteAll({ behavior: 'wait' });
		}

		await page.goto('/items');
		await page.evaluate(() => sessionStorage.removeItem('banto.listView.lastEdited.items'));
		await page.evaluate(async (id) => {
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const res = await fetch(`/api/items/${id}`, {
				method: 'DELETE',
				headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
			});
			if (!res.ok) throw new Error(`delete failed: ${res.status}`);
		}, itemId);
	});

	// #555 B-2 review: in SERVER mode the chip's x must reach the fetch too
	// (BantoGrid only reports header-driven changes).
	test('3d2. items: server mode - the filter chip x brings the rows back', async () => {
		await page.goto('/items');
		await expectItemsMode(page, SERVER_MODE, true);
		const openButtons = page.getByRole('button', { name: /^ID \d+ を開く$/ });
		await expect(openButtons.first()).toBeVisible();
		await applyColumnFilter(page, '商品名', 'zz-no-such-item-zz');
		await expect(openButtons).toHaveCount(0);
		const chipRemove = page.getByRole('button', { name: '商品名の絞り込みを外す' });
		await expect(chipRemove).toBeVisible();
		await chipRemove.click();
		await expect(chipRemove).toHaveCount(0);
		await expect(openButtons.first()).toBeVisible();
	});

	// #555 (4): the dashboard's 在庫僅少 tile opens /items on the `low-stock`
	// view (the view id leaves the URL once applied), then a saved view round
	// trip: save the current view, find it checked in the menu, delete it.
	test('3d3. items: the low-stock tile opens its view; a saved view can be saved and deleted', async () => {
		await page.goto('/dashboard');
		await page.getByRole('link', { name: /^在庫僅少/ }).click();
		await expect(page).toHaveURL(/\/items$/);
		const chipRemove = page.getByRole('button', { name: '在庫の絞り込みを外す', exact: true });
		await expect(chipRemove).toBeVisible();

		const viewsTrigger = page.getByRole('button', { name: 'ビュー', exact: true });
		async function expectViewChecked(name: string): Promise<void> {
			const item = page.getByRole('menuitemradio', { name, exact: true });
			await expect(async () => {
				if (!(await item.isVisible())) await viewsTrigger.click();
				await expect(item).toHaveAttribute('aria-checked', 'true', { timeout: 1000 });
			}).toPass();
		}
		await expectViewChecked('在庫僅少（50未満）');

		await page.getByRole('menuitem', { name: '今の表示を保存…', exact: true }).click();
		const saveDialog = page.getByRole('dialog', { name: '今の表示をビューとして保存' });
		await saveDialog.getByLabel('ビューの名前').fill('e2e 在庫僅少');
		await saveDialog.getByRole('button', { name: '保存', exact: true }).click();
		await expect(saveDialog).toBeHidden();

		await expectViewChecked('e2e 在庫僅少');
		await page.getByRole('menuitem', { name: '「e2e 在庫僅少」を削除', exact: true }).click();
		const confirmDialog = page.getByRole('alertdialog', { name: 'ビューの削除' });
		await confirmDialog.getByRole('button', { name: '削除', exact: true }).click();
		await expect(confirmDialog).toBeHidden();

		const savedItem = page.getByRole('menuitemradio', { name: 'e2e 在庫僅少', exact: true });
		const lowStockItem = page.getByRole('menuitemradio', {
			name: '在庫僅少（50未満）',
			exact: true
		});
		await expect(async () => {
			if (!(await lowStockItem.isVisible())) await viewsTrigger.click();
			await expect(lowStockItem).toBeVisible({ timeout: 1000 });
		}).toPass();
		await expect(savedItem).toHaveCount(0);
		await page.keyboard.press('Escape');

		// Cleanup: the view's filter and sort live on in this session's list
		// state; later scenarios expect the unfiltered, unsorted list.
		await page.evaluate(() => {
			for (const key of Object.keys(sessionStorage)) {
				if (key.startsWith('banto.listView.items:')) sessionStorage.removeItem(key);
			}
		});
	});

	// Issue #215/#255 review (fix 3): the CLIENT grid filters/shows rows
	// through `toItemRow()` (adds the synthetic `category` field), not the
	// raw `Item`. The exclusion check must run the SAME derivation, or a
	// category-filtered row whose non-category field was the only thing
	// saved gets wrongly flagged as excluded even though it's still plainly
	// visible in the grid.
	test('3e. items: client mode - saving a field other than category keeps a category-filtered row visible, no false exclusion notice', async () => {
		await page.goto('/items');
		await chooseItemsMode(page, CLIENT_MODE);
		await expectItemsMode(page, CLIENT_MODE, true);

		await applyColumnFilter(page, 'カテゴリ', '緑茶');
		const row = page.getByRole('row').filter({ hasText: '緑茶' }).first();
		await expect(row).toBeVisible();
		const itemId = await rowItemId(row);
		// The item id is unique, unlike the row's name/category text (many
		// seeded rows share e.g. "緑茶 350ml") - identify the row again after
		// the save by its open button, not by text.
		const rowAfterSave = (): Locator =>
			page.getByRole('row').filter({ has: page.locator(`[data-resource-open="${itemId}"]`) });

		// #591: saved in the list's drawer, the exclusion check runs in the
		// page itself (`checkFilterExclusion` with the client `toRow`).
		const drawer = await openInDrawer(page, row, itemId);
		const drawerPrice = drawer.getByRole('spinbutton', { name: /^価格/ });
		await expect(drawerPrice).not.toHaveValue('');
		const currentPrice = await drawerPrice.inputValue();
		await drawerPrice.fill(String(Number(currentPrice) + 1));
		await drawer.getByRole('button', { name: '保存', exact: true }).click();
		await expect(drawer.getByText('未保存の変更があります')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(drawer).toBeHidden();

		// Still visible under the same カテゴリ filter, and no false "この行
		// は現在の絞り込み条件に当てはまりません" notice.
		await expectItemsMode(page, CLIENT_MODE, true);
		await expect(rowAfterSave()).toBeVisible();
		await expect(page.getByText(/現在の絞り込み条件に当てはまりません/)).toHaveCount(0);

		await clearColumnFilter(page, 'カテゴリ');
		// Cleanup: leave the page in the same サーバー default later scenarios
		// expect (mode is itself session-persisted, Issue #215).
		await chooseItemsMode(page, SERVER_MODE);
		await expectItemsMode(page, SERVER_MODE, true);
	});

	// #591 (B-3): the list's detail drawer. `?id=` opens it (and a missing id
	// shows not-found in it), previous / next (buttons and Alt+Up/Down while
	// focus is inside) follow the list's order and stop at the ends, unsaved
	// edits ask before closing or moving (in-page confirm), "open as a page"
	// goes to the detail route, and under 768px `?id=` goes to that page.
	test('3e2. items: the detail drawer - ?id=, previous/next, unsaved confirm, expand, narrow screens', async () => {
		await page.goto('/items');
		await expectItemsMode(page, SERVER_MODE, true);
		const rows = page.getByRole('row').filter({ has: page.locator('[data-resource-open]') });
		await expect(rows.nth(2)).toBeVisible();
		const firstId = await rowItemId(rows.nth(0));
		const secondId = await rowItemId(rows.nth(1));
		const thirdId = await rowItemId(rows.nth(2));
		const anyDrawer = page.getByRole('dialog', { name: /^商品 ID / });
		const previous = anyDrawer.getByRole('button', { name: '前の行（Alt+↑）', exact: true });
		const next = anyDrawer.getByRole('button', { name: '次の行（Alt+↓）', exact: true });

		// `?id=` opens the drawer over the list.
		await page.goto(`/items?id=${secondId}`);
		await expect(itemDrawer(page, secondId)).toBeVisible();
		await expect(rows.nth(1)).toHaveClass(/resource-row-last-opened/);

		// Next (button), then back up with the keyboard from inside the form.
		await next.click();
		await expect(itemDrawer(page, thirdId)).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`/items[?]id=${thirdId}$`));
		await expect(rows.nth(2)).toHaveClass(/resource-row-last-opened/);
		const price = anyDrawer.getByRole('spinbutton', { name: /^価格/ });
		await expect(price).not.toHaveValue('');
		await price.focus();
		await page.keyboard.press('Alt+ArrowUp');
		await expect(itemDrawer(page, secondId)).toBeVisible();
		// No refocus: the replaced form must not drop focus out of the drawer,
		// or the next shortcut would not reach it (#592 review).
		await expect(anyDrawer.locator(':focus')).toHaveCount(1);
		await page.keyboard.press('Alt+ArrowUp');
		await expect(itemDrawer(page, firstId)).toBeVisible();
		// The first row: nothing before it.
		await expect(previous).toBeDisabled();
		await expect(next).toBeEnabled();

		// Unsaved edits: closing asks; "cancel" keeps the edit and the drawer.
		const edited = anyDrawer.getByRole('spinbutton', { name: /^価格/ });
		await expect(edited).not.toHaveValue('');
		const original = await edited.inputValue();
		await edited.fill(String(Number(original) + 7));
		const discard = page.getByRole('alertdialog', { name: '未保存の変更' });
		await anyDrawer.getByRole('button', { name: '閉じる', exact: true }).first().click();
		await expect(discard).toBeVisible();
		await discard.getByRole('button', { name: 'キャンセル', exact: true }).click();
		await expect(discard).toBeHidden();
		await expect(itemDrawer(page, firstId)).toBeVisible();
		await expect(edited).toHaveValue(String(Number(original) + 7));
		// Moving asks too; discarding moves without saving.
		await next.click();
		await expect(discard).toBeVisible();
		await discard.getByRole('button', { name: '変更を取り消す', exact: true }).click();
		await expect(itemDrawer(page, secondId)).toBeVisible();
		await expect(rows.nth(0).locator('[data-cell-field="price"]')).not.toHaveText(
			`¥${(Number(original) + 7).toLocaleString('en-US')}`
		);
		// A clean drawer closes on Esc and gives focus back to the grid.
		await page.keyboard.press('Escape');
		await expect(anyDrawer).toBeHidden();
		await expect(page).toHaveURL(/\/items$/);

		// A missing id: not-found inside the drawer, no neighbours.
		await page.goto('/items?id=999999999');
		const missing = itemDrawer(page, '999999999');
		await expect(missing.getByText('商品が見つかりません')).toBeVisible();
		await expect(previous).toBeDisabled();
		await expect(next).toBeDisabled();
		await missing.getByRole('button', { name: '閉じる', exact: true }).last().click();
		await expect(missing).toBeHidden();
		await expect(page).toHaveURL(/\/items$/);

		// "Open as a page" goes to the detail route.
		await openInDrawer(page, rows.nth(0), firstId);
		await anyDrawer.getByRole('button', { name: 'ページで開く', exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/items/${firstId}$`));
		await expect(page.getByRole('heading', { name: '商品を編集' })).toBeVisible();

		// Under 768px the drawer is not used: `?id=` goes to the detail page.
		const viewport = page.viewportSize();
		try {
			await page.setViewportSize({ width: 600, height: 800 });
			await page.goto(`/items?id=${secondId}`);
			await expect(page).toHaveURL(new RegExp(`/items/${secondId}$`));
			await expect(page.getByRole('heading', { name: '商品を編集' })).toBeVisible();
		} finally {
			if (viewport) await page.setViewportSize(viewport);
		}
	});

	// Issue #290: SvelteKit reuses the page component between two URLs of the
	// same route (items/1 -> items/2 only updates `page.params`). The detail
	// page reads its id once at setup, so without the (app) layout keying the
	// page on its params the URL moved on while the form, attachments and
	// save target stayed on the previous record (a save then PUT the WRONG id).
	// Every hop here is a client-side navigation (anchor click handled by
	// SvelteKit / history), never a full page load.
	test('3f. items: moving between two detail URLs (SPA) keeps URL, form and save target on the same record', async () => {
		const dialogs = trackDialogs(page);
		/** Click a plain anchor to `href`: SvelteKit turns it into a client-side navigation. */
		const spa = (href: string) =>
			page.evaluate((href) => {
				const a = document.createElement('a');
				a.href = href;
				document.body.appendChild(a);
				a.click();
				a.remove();
			}, href);
		const readItem = (id: number) =>
			page.evaluate(async (id) => {
				const token =
					localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
				const res = await fetch(`/api/items/${id}`, {
					headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
				});
				return (await res.json()) as { name: string };
			}, id);
		const name = page.getByLabel('商品名');
		try {
			await page.goto('/dashboard');
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			const a = await readItem(1);
			const b = await readItem(2);
			expect(a.name).not.toBe(b.name);

			// Saves are answered by the test (echoing the body), so the seed data
			// is untouched and the request path says which record was targeted.
			const puts: string[] = [];
			await page.route('**/api/items/*', async (route) => {
				const request = route.request();
				if (request.method() !== 'PUT') return route.fallback();
				puts.push(new URL(request.url()).pathname);
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: request.postData() ?? '{}'
				});
			});

			// B -> A directly (the case that reuses the component).
			await spa('/items/2');
			await expect(page).toHaveURL(/\/items\/2$/);
			await expect(name).toHaveValue(b.name);
			await spa('/items/1');
			await expect(page).toHaveURL(/\/items\/1$/);
			await expect(name).toHaveValue(a.name);

			// The user-visible form is A's, so the save must target A.
			await name.fill(`${a.name}-3f`);
			await page.getByRole('button', { name: '保存' }).click();
			await expect(page).toHaveURL(/\/items$/);
			expect(puts).toEqual(['/api/items/1']);

			// History: A -> list -> B, then back to the list and back to A.
			await spa('/items/1');
			await expect(page).toHaveURL(/\/items\/1$/);
			await expect(name).toHaveValue(a.name);
			await spa('/items');
			await expect(page).toHaveURL(/\/items$/);
			await spa('/items/2');
			await expect(page).toHaveURL(/\/items\/2$/);
			await expect(name).toHaveValue(b.name);
			await page.goBack();
			await expect(page).toHaveURL(/\/items$/);
			await page.goBack();
			await expect(page).toHaveURL(/\/items\/1$/);
			await expect(name).toHaveValue(a.name);

			// An unsaved edit is still guarded when the move is to ANOTHER detail
			// URL: staying keeps the edit and the URL.
			await name.fill('E2E未保存-3f');
			dialogs.answer(false);
			await spa('/items/2');
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/items\/1$/);
			await expect(name).toHaveValue('E2E未保存-3f');
			// Leaving discards it and shows B.
			dialogs.answer(true);
			await spa('/items/2');
			await expect(page).toHaveURL(/\/items\/2$/);
			await expect(name).toHaveValue(b.name);
			expect(dialogs.messages).toHaveLength(2);

			// A slow answer for the page we already left must not land on the
			// page we are on now: hold B's GET, move on to A, then release it.
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/api/items/2', async (route) => {
				if (route.request().method() !== 'GET') return route.fallback();
				await gate;
				await route.fallback();
			});
			await spa('/items');
			await expect(page).toHaveURL(/\/items$/);
			await spa('/items/2');
			await expect(page).toHaveURL(/\/items\/2$/);
			await spa('/items/1');
			await expect(page).toHaveURL(/\/items\/1$/);
			await expect(name).toHaveValue(a.name);
			release();
			await page.waitForTimeout(300);
			await expect(page).toHaveURL(/\/items\/1$/);
			await expect(name).toHaveValue(a.name);

			// An id that cannot be a record, between two valid ones: not found,
			// and the next valid id loads normally (no stale "valid" state).
			await spa('/items/abc');
			await expect(page.getByText('が見つかりません').first()).toBeVisible();
			await expect(name).toHaveCount(0);
			await spa('/items/2');
			await expect(page).toHaveURL(/\/items\/2$/);
			await expect(name).toHaveValue(b.name);
		} finally {
			dialogs.stop();
			await page.unroute('**/api/items/*');
			await page.unroute('**/api/items/2');
		}
	});

	// date-time-pickers PR-6 (§5.9): the 更新日 column filters by a day range.
	// Both days are inclusive on screen; the request carries the half-open
	// `between` with the day after the end day. With the calendar open over
	// the filter popover, Esc closes only the calendar and the next Esc the
	// popover (§5.8 promise 1 inside FilterPopover).
	test('3g. items: 更新日 filters by a day range (between), Esc closes the calendar before the popover', async () => {
		await page.goto('/items');
		// Before hydration a click does nothing: chooseItemsMode retries until it takes.
		await chooseItemsMode(page, SERVER_MODE);
		await expectItemsMode(page, SERVER_MODE, true);
		const grid = page.getByRole('grid');
		const dayCells = grid.locator('[data-cell-field="updatedAt"]');
		await expect(dayCells.first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
		const day = (await dayCells.first().textContent())!.trim();
		const next = new Date(`${day}T00:00:00Z`);
		next.setUTCDate(next.getUTCDate() + 1);
		const nextDay = next.toISOString().slice(0, 10);

		const filterButton = page.getByRole('button', { name: '更新日の絞り込み', exact: true });
		const dialog = page.getByRole('dialog', { name: '更新日の絞り込み' });
		await expect(async () => {
			if (!(await dialog.isVisible())) await filterButton.click();
			await expect(dialog).toBeVisible({ timeout: 1000 });
		}).toPass();
		const range = dialog.getByRole('group', { name: '期間' });
		const start = range.getByRole('textbox', { name: '開始日' });
		const end = range.getByRole('textbox', { name: '終了日' });
		await expect(start).toBeFocused();

		// The calendar over the popover: Esc 1 closes it only.
		const calendar = page.getByRole('dialog', { name: '日付の選択' });
		await end.focus();
		await page.keyboard.press('Alt+ArrowDown');
		await expect(calendar).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(calendar).toBeHidden();
		await expect(dialog).toBeVisible();
		await expect(end).toBeFocused();

		// An end before the start is refused in the popover, nothing is sent.
		await start.fill('2999-01-01');
		await end.fill(day);
		await page.keyboard.press('Enter');
		await expect(dialog.getByRole('alert')).toHaveText(
			'終了日は開始日と同じ日かそれより後にしてください'
		);
		await expect(dialog).toBeVisible();

		// One day, typed leniently: the request ends at the next day.
		await start.fill(day.replaceAll('-', '/'));
		await end.fill(day);
		const applied = page.waitForRequest(
			(request) =>
				new URL(request.url()).pathname === '/api/items/list' && request.method() === 'POST'
		);
		await page.keyboard.press('Enter');
		expect((await applied).postDataJSON().filters).toContainEqual({
			field: 'updatedAt',
			op: 'between',
			value: [day, nextDay]
		});
		await expect(dialog).toHaveCount(0);
		await expect(filterButton).toBeFocused();
		await expect(dayCells.first()).toHaveText(day);
		const shown = await dayCells.allTextContents();
		expect(shown.length).toBeGreaterThan(0);
		expect(new Set(shown.map((text) => text.trim()))).toEqual(new Set([day]));

		// Reopened, the popover shows the inclusive end day; Esc 2 closes it.
		await filterButton.click();
		await expect(start).toHaveValue(day);
		await expect(end).toHaveValue(day);
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(filterButton).toBeFocused();

		await clearColumnFilter(page, '更新日');
		await expect(dialog).toHaveCount(0);
	});

	test('4. CSV export downloads a UTF-8-BOM CSV file', async () => {
		await page.goto('/items');

		const downloadPromise = page.waitForEvent('download');
		await chooseItemsMoreAction(page, 'その他の操作', 'CSVエクスポート');
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(/^items-\d{8}-\d{4}\.csv$/);
		const filePath = await download.path();
		expect(filePath).not.toBeNull();

		// csvForExcel (packages/grid-svelte/src/core/csv.ts) prefixes a UTF-8
		// BOM so Excel on Japanese Windows opens the file without mojibake -
		// verify the actual downloaded bytes, not just the in-app helper.
		const firstBytes = fs.readFileSync(filePath!).subarray(0, 3);
		expect(Buffer.from(firstBytes)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
	});

	test('4b. CSV import: the preview shows the first 10 rows, new/update labels, and cancel imports nothing', async () => {
		await page.goto('/items');

		// 12 data rows: 11 new (no id) + 1 update (id 1) -> over the 10-row
		// preview limit (issue #218). Cancelled below, never executed, so no
		// later scenario's data changes.
		const lines = ['id,name,price,stock', '1,プレビュー更新,150,7'];
		for (let i = 1; i <= 11; i++) lines.push(`,プレビュー新規${i},${100 + i},${i}`);
		await page.locator('input[type="file"][accept=".csv,.txt"]').setInputFiles({
			name: 'preview.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(lines.join('\n'), 'utf-8')
		});

		const panel = page.locator('section.import-panel');
		await expect(panel).toBeVisible();
		await expect(panel.getByText('新規 11件 / 更新 1件 / エラー 0件（全12行）')).toBeVisible();
		// Issue #553: the import rules sit in the confirmation panel itself
		// (production build too, where the page-level annotation is gone).
		await expect(panel.getByTestId('import-rules')).toContainText(
			'1件でもエラーがあると全体が取り消されます'
		);
		await expect(panel.getByText('全12行中 先頭10行を表示')).toBeVisible();
		const table = panel.getByRole('table', { name: '取込内容のプレビュー（先頭の行）' });
		// header row + 10 shown rows (the 12-row file is cut at the limit)
		await expect(table.getByRole('row')).toHaveCount(11);
		await expect(table.getByRole('row', { name: /更新.*プレビュー更新/ })).toBeVisible();
		await expect(table.getByRole('cell', { name: '新規', exact: true }).first()).toBeVisible();
		await expect(table.getByText('プレビュー新規9')).toBeVisible();
		await expect(table.getByText('プレビュー新規10')).toHaveCount(0);
		await expect(panel.getByText('1件は既存レコードの更新です', { exact: false })).toBeVisible();

		await panel.getByRole('button', { name: 'キャンセル' }).click();
		await expect(panel).toHaveCount(0);
	});

	test('5. user management: create a viewer account and preserve selection across replies', async () => {
		test.setTimeout(60_000);
		await page.goto('/users');

		// Scoped to the create form (not just page.getByLabel(...)): the
		// grid's ユーザー名/表示名 column filter buttons below (aria-label
		// "<列名>の絞り込み") also match those label texts by substring,
		// which makes an unscoped getByLabel ambiguous once the grid is on
		// the same page (users/+page.svelte's "section.create").
		const createForm = page.locator('section.create');
		await expect(createForm.getByLabel('パスワード（8文字以上）')).toHaveCSS(
			'border-bottom-width',
			'2px'
		);
		const createFont = await createForm
			.getByLabel('ユーザー名')
			.evaluate((element) => getComputedStyle(element).fontSize);
		await createForm.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
		await createForm.getByLabel('パスワード（8文字以上）').fill(VIEWER_PASSWORD);
		await createForm.getByLabel('表示名').fill(VIEWER_DISPLAY_NAME);
		await createForm.getByLabel('ロール').selectOption('viewer');
		await createForm.getByRole('button', { name: '作成' }).click();

		await expect(rowWithText(page, VIEWER_USERNAME)).toBeVisible();

		// #206: a reply for an earlier selection must not replace the panel
		// while leaving another user's draft attached to the wrong identity.
		const panel = page.locator('.edit-column');
		const displayName = panel.getByLabel('表示名', { exact: true });
		const role = panel.getByLabel('ロール');
		const save = panel.getByRole('button', { name: '保存', exact: true });
		const viewerRow = rowWithText(page, VIEWER_USERNAME);
		const adminRow = rowWithText(page, ADMIN_USERNAME);
		async function selectUserRow(username: string): Promise<void> {
			await rowWithText(page, username).locator('[data-cell-field="username"]').click();
			// Activate the selected read-only row through the grid's keyboard
			// contract; assert the panel before testing asynchronous mutations.
			await page.keyboard.press('Enter');
			await expect(panel.getByRole('heading', { level: 2 })).toContainText(username);
		}
		const viewerId = Number(await viewerRow.locator('[data-cell-field="id"]').innerText());
		const adminId = Number(await adminRow.locator('[data-cell-field="id"]').innerText());
		expect(viewerId).toBeGreaterThan(0);
		expect(adminId).toBeGreaterThan(0);

		for (const outcome of ['success', 'failure', 'reselect'] as const) {
			await selectUserRow(VIEWER_USERNAME);
			await expect(displayName).toHaveCSS('font-size', createFont);
			await expect(role).toHaveCSS('border-bottom-width', '2px');
			const savedName = `${VIEWER_DISPLAY_NAME}-${outcome}`;
			await displayName.fill(savedName);
			if (outcome === 'reselect') await role.selectOption('editor');
			let releaseReply!: () => void;
			const replyGate = new Promise<void>((resolve) => (releaseReply = resolve));
			let requestArrived!: () => void;
			const arrived = new Promise<void>((resolve) => (requestArrived = resolve));
			const pendingReplies = new Set<Promise<void>>();
			await page.route(`**/api/users/${viewerId}`, (route) => {
				if (route.request().method() !== 'PUT') return route.continue();
				const pending = (async () => {
					// Successful saves reach the real API, including its normal auth
					// and CSRF headers; only delivery of the reply is delayed.
					const response = outcome === 'failure' ? null : await route.fetch();
					if (response) expect(response.ok()).toBe(true);
					requestArrived();
					await replyGate;
					if (response) await route.fulfill({ response });
					else
						await route.fulfill({
							status: 500,
							json: { kind: 'other', message: 'E2E delayed user save failure' }
						});
				})();
				pendingReplies.add(pending);
				return pending.finally(() => pendingReplies.delete(pending));
			});
			try {
				await save.click();
				await arrived;
				await selectUserRow(ADMIN_USERNAME);
				if (outcome === 'reselect') await selectUserRow(VIEWER_USERNAME);
				const targetUsername = outcome === 'reselect' ? VIEWER_USERNAME : ADMIN_USERNAME;
				const targetId = outcome === 'reselect' ? viewerId : adminId;
				const targetRole = outcome === 'reselect' ? 'viewer' : 'admin';
				const draft = `E2E newer ${outcome} draft`;
				await displayName.fill(draft);
				await expect(role).toHaveValue(targetRole);
				const lateReply = page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname === `/api/users/${viewerId}` &&
						response.request().method() === 'PUT'
				);
				releaseReply();
				await (await lateReply).finished();
				if (outcome === 'failure') {
					await expect(
						page.getByText('E2E delayed user save failure', { exact: true })
					).toBeVisible();
				} else {
					await expect(viewerRow.locator('[data-cell-field="displayName"]')).toHaveText(savedName);
				}
				await expect(panel.getByRole('heading', { level: 2 })).toContainText(targetUsername);
				await expect(displayName).toHaveValue(draft);
				if (outcome === 'reselect') {
					// An ID-only guard would accept the old A reply and replace
					// this new selection's saved-role badge with editor.
					await expect(panel.locator('.role-row')).toHaveText('閲覧者');
				}
				await expect(role).toHaveValue(targetRole);
				await expect(save).toBeEnabled();

				const subsequentSave = page.waitForRequest(
					(request) =>
						/\/api\/users\/\d+$/.test(new URL(request.url()).pathname) && request.method() === 'PUT'
				);
				await save.click();
				const request = await subsequentSave;
				expect(new URL(request.url()).pathname).toBe(`/api/users/${targetId}`);
				expect(request.postDataJSON()).toEqual({
					displayName: draft,
					role: targetRole,
					version: expect.any(Number)
				});
				await expect(
					rowWithText(page, targetUsername).locator('[data-cell-field="displayName"]')
				).toHaveText(draft);
				if (outcome === 'success') {
					await expect(viewerRow.locator('[data-cell-field="displayName"]')).toHaveText(savedName);
				}
			} finally {
				releaseReply();
				while (pendingReplies.size > 0) await Promise.all([...pendingReplies]);
				await page.unrouteAll({ behavior: 'wait' });
			}
		}

		// A password-reset reply must also leave the newly selected user's
		// password draft alone. Reset only the viewer to its existing password.
		await selectUserRow(VIEWER_USERNAME);
		const password = panel.getByLabel('新しいパスワード（8文字以上）', { exact: true });
		await expect(password).toHaveCSS('font-size', createFont);
		await expect(password).toHaveCSS('border-bottom-width', '2px');
		await password.fill(VIEWER_PASSWORD);
		let releaseReset!: () => void;
		const resetGate = new Promise<void>((resolve) => (releaseReset = resolve));
		let resetArrived!: () => void;
		const resetStarted = new Promise<void>((resolve) => (resetArrived = resolve));
		const pendingResets = new Set<Promise<void>>();
		await page.route(`**/api/users/${viewerId}/reset-password`, (route) => {
			const pending = (async () => {
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				resetArrived();
				await resetGate;
				await route.fulfill({ response });
			})();
			pendingResets.add(pending);
			return pending.finally(() => pendingResets.delete(pending));
		});
		try {
			await panel.getByRole('button', { name: 'パスワードをリセット', exact: true }).click();
			await resetStarted;
			await selectUserRow(ADMIN_USERNAME);
			await password.fill('E2E unsent admin password');
			releaseReset();
			await expect(page.getByText('パスワードをリセットしました', { exact: true })).toBeVisible();
			await expect(panel.getByRole('heading', { level: 2 })).toContainText(ADMIN_USERNAME);
			await expect(password).toHaveValue('E2E unsent admin password');
		} finally {
			releaseReset();
			while (pendingResets.size > 0) await Promise.all([...pendingResets]);
			await page.unrouteAll({ behavior: 'wait' });
		}

		// Later scenarios log into the viewer account; preserve both roles and
		// restore display names through the same UI after exercising the race.
		for (const [username, name] of [
			[VIEWER_USERNAME, VIEWER_DISPLAY_NAME],
			[ADMIN_USERNAME, ADMIN_DISPLAY_NAME]
		]) {
			await selectUserRow(username);
			await displayName.fill(name);
			await save.click();
			await expect(
				rowWithText(page, username).locator('[data-cell-field="displayName"]')
			).toHaveText(name);
		}
	});

	test('5a. users: a row click right after opening the page opens its edit panel (#236)', async () => {
		await page.goto('/users');
		// No wait between the page load and the click: the click must work in
		// the state the user first sees.
		const grid = page.getByRole('grid');
		const cell = rowWithText(page, ADMIN_USERNAME).locator('[data-cell-field="username"]');
		await expect(cell).toBeVisible();
		// Precondition that makes this scenario meaningful: the grid sits below
		// the create form and runs past the bottom of the viewport. Focusing it
		// on pointerdown without `preventScroll` scrolled the page between press
		// and release, so the click landed on the grid instead of the cell and
		// onRowClick never ran (the cell was still selected). If the layout ever
		// fits the whole grid on screen, this fails instead of passing vacuously.
		const gridBottom = await grid.evaluate((element) => element.getBoundingClientRect().bottom);
		const viewportHeight = page.viewportSize()!.height;
		expect(gridBottom).toBeGreaterThan(viewportHeight);
		// The clicked cell itself must be fully on screen. Otherwise click()'s
		// own actionability scroll would move the page too, and the scrollY
		// comparison below could no longer tell it from a focus() scroll.
		const cellBox = await cell.boundingBox();
		expect(cellBox, 'the clicked cell must have a layout box').not.toBeNull();
		expect(
			cellBox!.y >= 0 && cellBox!.y + cellBox!.height <= viewportHeight,
			`precondition: the clicked cell (y=${cellBox!.y}, height=${cellBox!.height}) must lie fully inside the ${viewportHeight}px viewport, or click() auto-scrolls and the scroll check below is meaningless`
		).toBe(true);
		const scrollBefore = await page.evaluate(() => window.scrollY);

		await cell.click();

		await expect(page.locator('.edit-column').getByRole('heading', { level: 2 })).toContainText(
			ADMIN_USERNAME
		);
		expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
	});

	test('5b. delayed deletion preserves another user but closes a reselected deleted user', async () => {
		test.setTimeout(60_000);
		await page.goto('/users');
		const createForm = page.locator('section.create');
		const panel = page.locator('.edit-column');
		const displayName = panel.getByLabel('表示名', { exact: true });
		async function selectUserRow(username: string): Promise<void> {
			await rowWithText(page, username).locator('[data-cell-field="username"]').click();
			await page.keyboard.press('Enter');
			await expect(panel.getByRole('heading', { level: 2 })).toContainText(username);
		}

		for (const reselect of [false, true]) {
			// Real disposable accounts: the existing viewer is needed by scenario 6.
			const username = `e2e-delete-${reselect ? 'reselect' : 'other'}`;
			await createForm.getByLabel('ユーザー名').fill(username);
			await createForm.getByLabel('パスワード（8文字以上）').fill(VIEWER_PASSWORD);
			await createForm.getByLabel('表示名').fill('E2E削除対象');
			await createForm.getByLabel('ロール').selectOption('viewer');
			await createForm.getByRole('button', { name: '作成' }).click();
			const deletedRow = rowWithText(page, username);
			await expect(deletedRow).toBeVisible();
			const id = Number(await deletedRow.locator('[data-cell-field="id"]').innerText());
			expect(id).toBeGreaterThan(0);
			await selectUserRow(username);

			let releaseDelete!: () => void;
			const replyGate = new Promise<void>((resolve) => (releaseDelete = resolve));
			let deleteArrived!: () => void;
			const deleted = new Promise<void>((resolve) => (deleteArrived = resolve));
			const pendingReplies = new Set<Promise<void>>();
			// Matched by pathname: the DELETE carries `?version=` (Issue #651),
			// which a `**/api/users/${id}` glob would not match.
			await page.route(
				(url) => url.pathname === `/api/users/${id}`,
				(route) => {
					if (route.request().method() !== 'DELETE') return route.continue();
					const pending = (async () => {
						// Delete in the real database now, but let the user change
						// selection before the browser receives the success response.
						const response = await route.fetch();
						expect(response.status()).toBe(204);
						deleteArrived();
						await replyGate;
						await route.fulfill({ response });
					})();
					pendingReplies.add(pending);
					return pending.finally(() => pendingReplies.delete(pending));
				}
			);
			try {
				// Cannot be undone: the dialog asks for the user name (Issue #556).
				await confirmInDialog(page, panel.getByRole('button', { name: '削除', exact: true }), {
					title: 'ユーザーの削除',
					confirm: '削除',
					type: username
				});
				await deleted;
				await selectUserRow(ADMIN_USERNAME);
				if (reselect) await selectUserRow(username);
				const draft = 'E2E draft during deletion';
				await displayName.fill(draft);
				releaseDelete();
				// Row removal establishes that the delayed callback and its list
				// refresh completed before inspecting the selected edit panel.
				await expect(deletedRow).toHaveCount(0);
				if (reselect) {
					await expect(
						panel.getByText('ユーザーを選択してください', { exact: true })
					).toBeVisible();
					await expect(panel.locator('input, select, button')).toHaveCount(0);
				} else {
					await expect(panel.getByRole('heading', { level: 2 })).toContainText(ADMIN_USERNAME);
					await expect(displayName).toHaveValue(draft);
					await expect(panel.getByLabel('ロール')).toHaveValue('admin');
					await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
				}
			} finally {
				releaseDelete();
				while (pendingReplies.size > 0) await Promise.all([...pendingReplies]);
				await page.unrouteAll({ behavior: 'wait' });
			}
		}
	});

	test('6. viewer role: no admin nav entries, no items create button; #215 list state does not leak to a different user logging in', async () => {
		// #215/#255 review (P2): the admin sets a filter/sort and opens a row
		// right before logging out - none of it may resurrect for the VIEWER
		// who logs into this same tab next (it would show them the admin's
		// search term and which row the admin had open).
		await page.goto('/items');
		await applyColumnFilter(page, '商品名', '茶');
		const grid = page.getByRole('grid');
		const priceHeader = grid.getByRole('columnheader', { name: '価格' });
		await priceHeader.locator('.cell-body').click();
		await expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');
		// #591: opening the row in the drawer marks it as the last opened one.
		const teaRow = rowWithText(page, '茶').first();
		const teaDrawer = await openInDrawer(page, teaRow, await rowItemId(teaRow));
		await page.keyboard.press('Escape');
		await expect(teaDrawer).toBeHidden();
		await expect(page).toHaveURL(/\/items$/);
		await expect(page.locator('.resource-row-last-opened')).toHaveCount(1);

		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
		await page.getByLabel('パスワード').fill(VIEWER_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		// Sidebar.svelte hides adminOnly nav entries entirely (not just
		// disabled) for non-admin roles.
		await expect(page.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: '監査ログ' })).toHaveCount(0);

		await page.goto('/items');
		await expect(page.getByRole('button', { name: '新規作成' })).toHaveCount(0);

		// The filter, sort and highlighted row the admin left behind must all
		// be gone - saved list state carries its owner and is only restored
		// for the identity the guard confirmed (the logout also cleared it;
		// scenario 6a covers the case where no logout happened in this tab).
		await page.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
		await expect(
			page.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
		).toHaveValue('');
		await page.keyboard.press('Escape');
		await expect(grid.getByRole('columnheader', { name: '価格' })).toHaveAttribute(
			'aria-sort',
			'none'
		);
		await expect(page.locator('.resource-row-last-opened')).toHaveCount(0);

		// M20 attachments (attachments-plan §2.1: "閲覧 = viewer 以上、追加/削除 = editor
		// 以上"): open any seeded demo item (the grid always has 1,000 rows,
		// so this doesn't depend on scenario 3's item, which is deleted by
		// now) and confirm the panel renders read-only - no upload affordance.
		// #591: in the list's drawer (its `detailAfter`), read-only too.
		const anyRow = page
			.getByRole('row')
			.filter({ has: page.locator('[data-resource-open]') })
			.first();
		const viewerDrawer = await openInDrawer(page, anyRow, await rowItemId(anyRow));
		await expect(viewerDrawer.getByRole('heading', { name: '添付ファイル' })).toBeVisible();
		await expect(viewerDrawer.getByLabel('添付ファイルをアップロード')).toHaveCount(0);
		await expect(viewerDrawer.getByRole('button', { name: 'アップロード' })).toHaveCount(0);
		await expect(viewerDrawer.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(viewerDrawer).toBeHidden();
	});

	// Issue #215/#255 4th review (P2 1): two tabs of ONE browser share the
	// "Remember me" token (localStorage) but not their sessionStorage. The
	// first tab saves the admin's list state; the second tab logs the admin
	// out and logs in as the viewer with Remember me - an identity change the
	// first tab's own login/logout never saw. Opening the list in the first
	// tab again then passes the guard with the VIEWER's valid token, and must
	// not restore the admin's search term, sort or highlighted row: saved
	// state carries its owner and is only restored for the identity the
	// guard confirmed. (Issue #260 実装-2: the first tab now also follows the
	// other tab's logout to /login on its own - see below.)
	test('6a. items: after another tab switches the Remember me user, reloading this tab does not restore the previous user list state', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const first = await context.newPage();
		const second = await context.newPage();
		try {
			// Hold the first tab's event stream open without ever answering:
			// otherwise a reconnect that happens to fall between the second
			// tab's logout and login would find the token gone, end the first
			// tab's session and clear its state by itself - the stream is not
			// the path under test (the shared token's `storage` event is).
			await first.route('**/api/events', () => {});

			await first.goto('/login');
			await first.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await first.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await first.getByLabel('ログイン状態を保持する（30日間）').check();
			await first.getByRole('button', { name: 'ログイン' }).click();
			await expect(first).toHaveURL(/\/dashboard$/);

			await first.goto('/items');
			await applyColumnFilter(first, '商品名', '茶');
			const firstGrid = first.getByRole('grid');
			const firstPrice = firstGrid.getByRole('columnheader', { name: '価格' });
			await firstPrice.locator('.cell-body').click();
			await expect(firstPrice).toHaveAttribute('aria-sort', 'ascending');
			// #591: the drawer's ResourceDetail records the opened row when it is created.
			const firstTeaRow = rowWithText(first, '茶').first();
			const firstDrawer = await openInDrawer(first, firstTeaRow, await rowItemId(firstTeaRow));
			await first.keyboard.press('Escape');
			await expect(firstDrawer).toBeHidden();
			await expect(first).toHaveURL(/\/items$/);
			await expect(first.locator('.resource-row-last-opened')).toHaveCount(1);
			const savedState = () =>
				first.evaluate(() =>
					Object.keys(sessionStorage)
						.filter((key) => key.startsWith('banto.listView.'))
						.map((key) => sessionStorage.getItem(key))
						.join('\n')
				);
			expect(await savedState(), 'precondition: the admin state is saved').toContain('茶');

			// The second tab: same shared token, so it opens as the admin; then
			// the admin logs out there and the viewer logs in with Remember me.
			await second.goto('/dashboard');
			await expect(second.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
			await logout(second);
			await expect(second).toHaveURL(/\/login$/);
			// Issue #260 実装-2 (S-39, I-5): the first tab is no longer left
			// unaware - the shared token's `storage` event holds its session,
			// the confirmation finds no token, and its layout re-runs the guard
			// (generation check), which sends it to /login too.
			await expect(first).toHaveURL(/\/login$/);
			await second.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await second.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await second.getByLabel('ログイン状態を保持する（30日間）').check();
			await second.getByRole('button', { name: 'ログイン' }).click();
			await expect(second).toHaveURL(/\/dashboard$/);

			// Opening the list again in the first tab passes the guard as the
			// viewer (the shared Remember me token).
			await first.goto('/items');
			await expect(first).toHaveURL(/\/items$/);
			await expect(firstGrid).toBeVisible();
			await expect(first.getByRole('button', { name: '新規作成' })).toHaveCount(0);

			await first.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
			await expect(
				first.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
			).toHaveValue('');
			await first.keyboard.press('Escape');
			await expect(firstPrice).toHaveAttribute('aria-sort', 'none');
			await expect(first.locator('.resource-row-last-opened')).toHaveCount(0);
			expect(await savedState(), "the admin's search term is gone").not.toContain('茶');
		} finally {
			await context.close();
		}
	});

	// Issue #215/#255 6th review: the session is still valid (check() passes)
	// but its identity cannot be fetched for a moment (a 500). That is not
	// "nobody is signed in": the guard shows its retryable error page, and
	// nothing about the session - owner, generation, saved list state - is
	// changed, so the retry restores the list exactly as it was.
	test('6b. items: an identity outage keeps the list state, and the retry restores it', async () => {
		await page.goto('/items');
		await applyColumnFilter(page, '商品名', '茶');
		await expect(rowWithText(page, '茶').first()).toBeVisible();

		const outage = (route: Route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ kind: 'other', message: 'identity outage' })
			});
		await page.route('**/api/auth/identity', outage);
		await page.reload();
		await expect(page.getByText('ログイン状態を確認できませんでした')).toBeVisible();
		await expect(page).toHaveURL(/\/items$/);

		await page.unroute('**/api/auth/identity', outage);
		await page.getByRole('button', { name: '再試行' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await page.getByRole('button', { name: '商品名の絞り込み', exact: true }).click();
		await expect(
			page.getByRole('dialog', { name: '商品名の絞り込み' }).getByPlaceholder('値を入力')
		).toHaveValue('茶');
		await page.keyboard.press('Escape');
		await clearColumnFilter(page, '商品名');
	});

	test('7. admin: audit log shows the login and items records', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		await page.goto('/audit-log');

		// action is stored/filtered on its raw wire value ('login'); the grid
		// cell renders it through actionLabel() as 'ログイン'.
		await applyColumnFilter(page, 'アクション', 'login');
		await expect(rowWithText(page, 'ログイン').first()).toBeVisible();

		// Filters AND together, so the previous one must be cleared before a
		// resource-only filter is applied, or nothing would match.
		await clearColumnFilter(page, 'アクション');
		await applyColumnFilter(page, 'リソース', 'items');
		await expect(rowWithText(page, 'items').first()).toBeVisible();
	});

	test('7a. audit log: a 0-row filter recovers when cleared, and reload shows failures and new records', async () => {
		// Issue #248. Continues on /audit-log from scenario 7 (resource filter set).
		const countNote = page.getByTestId('audit-count-note');
		const reload = page.getByRole('button', { name: '再読み込み', exact: true });
		await clearColumnFilter(page, 'リソース');
		await expect(countNote).toContainText('件の記録があります');

		// A filter that matches nothing is a real 0-row result, not "not loaded".
		await applyColumnFilter(page, 'アクション', 'no-such-action');
		await expect(countNote).toHaveText('該当する記録はありません（0件）。');
		// Clearing it must reach the server although the grid now reports an
		// empty window {0, 0} (the old page made no request here).
		await clearColumnFilter(page, 'アクション');
		await expect(countNote).toContainText('件の記録があります');
		const before = Number((await countNote.innerText()).replace(/[^0-9]/g, ''));
		expect(before).toBeGreaterThan(0);

		// A failed read is shown on the page (not only as a toast) and
		// "再読み込み" recovers from it.
		await page.route('**/api/audit-log/list**', (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ kind: 'other', message: 'e2e: list failed' })
			})
		);
		await reload.click();
		await expect(
			page.getByRole('alert').filter({ hasText: '監査ログを読み込めませんでした' })
		).toBeVisible();
		await page.unrouteAll({ behavior: 'wait' });

		// Record one more entry (a no-op retention-policy save is audited as
		// settings_change). The list keeps its snapshot until "再読み込み".
		await page.evaluate(async () => {
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const headers = {
				'X-Banto-Client': 'banto',
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			};
			const current = await fetch('/api/audit-log/config', { headers });
			if (!current.ok) throw new Error(`get config failed: ${current.status}`);
			const saved = await fetch('/api/audit-log/config', {
				method: 'PUT',
				headers,
				body: JSON.stringify(await current.json())
			});
			if (!saved.ok) throw new Error(`put config failed: ${saved.status}`);
		});
		await reload.click();
		await expect(
			page.getByRole('alert').filter({ hasText: '監査ログを読み込めませんでした' })
		).toHaveCount(0);
		await expect(countNote).toContainText(
			`${(before + 1).toLocaleString('ja-JP')}件の記録があります`
		);
		await expect(rowWithText(page, '設定変更').first()).toBeVisible();
	});

	// #591 stage 2: the drawer's 履歴 tab (the audit log of the record) is for
	// admins only. An editor and a viewer see the detail directly - no tablist,
	// no 履歴 tab - and the form is still there (editable / read-only).
	test('7b. items drawer: editor and viewer get no 履歴 tab, the detail is shown as is', async () => {
		test.setTimeout(60_000);
		const EDITOR_USERNAME = 'e2e-editor';
		const EDITOR_PASSWORD = 'E2eEditorPass1';

		// The editor account is created through the API from the admin's own
		// session (scenario 5 keeps the users list as the later scenarios expect).
		const editorId = await page.evaluate(
			async ({ username, password }) => {
				const token =
					localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
				const created = await fetch('/api/users', {
					method: 'POST',
					headers: {
						'X-Banto-Client': 'banto',
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						username,
						password,
						displayName: 'E2E編集者',
						role: 'editor'
					})
				});
				if (!created.ok) throw new Error(`create editor failed: ${created.status}`);
				return ((await created.json()) as { id: number }).id;
			},
			{ username: EDITOR_USERNAME, password: EDITOR_PASSWORD }
		);

		async function loginAs(username: string, password: string): Promise<void> {
			await logout(page);
			await expect(page).toHaveURL(/\/login$/);
			await page.getByLabel('ユーザー名').fill(username);
			await page.getByLabel('パスワード').fill(password);
			await page.getByRole('button', { name: 'ログイン' }).click();
			await expect(page).toHaveURL(/\/dashboard$/);
		}

		// The same row is opened for every role (its id is fixed from the
		// admin's first look), so only the role differs between the drawers.
		let targetId: string | null = null;
		async function openTargetRowDrawer(): Promise<Locator> {
			await page.goto('/items');
			const rows = page.getByRole('row').filter({ has: page.locator('[data-resource-open]') });
			if (targetId === null) targetId = await rowItemId(rows.first());
			const row = rows.filter({ has: page.locator(`[data-resource-open="${targetId}"]`) }).first();
			return openInDrawer(page, row, targetId);
		}

		let cleanupError: unknown;
		try {
			// Control: the admin sees the 履歴 tab on that very row, so the
			// locator is right and only the role explains its absence below.
			const adminDrawer = await openTargetRowDrawer();
			await expect(adminDrawer.getByRole('tab', { name: '履歴', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(adminDrawer).toBeHidden();

			await loginAs(EDITOR_USERNAME, EDITOR_PASSWORD);
			const editorDrawer = await openTargetRowDrawer();
			await expect(editorDrawer.getByRole('tablist')).toHaveCount(0);
			await expect(editorDrawer.getByRole('tab', { name: '履歴', exact: true })).toHaveCount(0);
			await expect(editorDrawer.getByRole('spinbutton', { name: /^価格/ })).toBeEditable();
			await expect(editorDrawer.getByRole('button', { name: '保存', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(editorDrawer).toBeHidden();

			await loginAs(VIEWER_USERNAME, VIEWER_PASSWORD);
			const viewerDrawer = await openTargetRowDrawer();
			await expect(viewerDrawer.getByRole('tablist')).toHaveCount(0);
			await expect(viewerDrawer.getByRole('tab', { name: '履歴', exact: true })).toHaveCount(0);
			await expect(viewerDrawer.getByRole('spinbutton', { name: /^価格/ })).not.toBeEditable();
			await expect(viewerDrawer.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
			await page.keyboard.press('Escape');
			await expect(viewerDrawer).toBeHidden();
		} finally {
			// Cleanup must not hide the original failure: if a role check failed
			// the drawer is still open and its overlay covers the header, so
			// close it first, and let the original exception win over any
			// cleanup error.
			try {
				if (targetId !== null) {
					const openDrawer = itemDrawer(page, targetId);
					if (await openDrawer.isVisible()) {
						await page.keyboard.press('Escape');
						await expect(openDrawer).toBeHidden({ timeout: 5_000 });
					}
				}
				// Later scenarios continue as the admin, and the editor is removed again.
				await loginAs(ADMIN_USERNAME, ADMIN_PASSWORD);
				await page.evaluate(async (id) => {
					const token =
						localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
					const res = await fetch(`/api/users/${id}`, {
						method: 'DELETE',
						headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
					});
					if (!res.ok) throw new Error(`delete editor failed: ${res.status}`);
				}, editorId);
			} catch (error) {
				// Rethrown below only when the test body itself passed.
				cleanupError = error;
			}
		}
		if (cleanupError !== undefined) throw cleanupError;
	});

	test('8. items detail: attachments upload, thumbnail, history, and delete', async () => {
		await page.goto('/items');
		await page.getByRole('button', { name: '新規作成' }).click();
		await expect(page).toHaveURL(/\/items\/new$/);

		await page.getByLabel('商品名').fill(ATTACHMENT_ITEM_NAME);
		await page.getByLabel('価格').fill(String(ITEM_PRICE));
		await page.getByLabel('在庫').fill(String(ITEM_STOCK));
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await applyColumnFilter(page, '商品名', ATTACHMENT_ITEM_NAME);
		const row = rowWithText(page, ATTACHMENT_ITEM_NAME);
		await expect(row).toBeVisible();
		const itemId = await rowItemId(row);
		const href = `/items/${itemId}`;

		await page.goto(href);
		await expect(page.getByRole('heading', { name: '添付ファイル' })).toBeVisible();
		await expect(page.getByText('添付ファイルはありません')).toBeVisible();

		const uploadInput = page.getByLabel('添付ファイルをアップロード');

		// 1. Upload a PNG image - it goes into the thumbnail grid as an <img>
		// (AttachmentsPanel.svelte's `grouped.withThumbnail`).
		await uploadInput.setInputFiles({
			name: PNG_FILE_NAME,
			mimeType: 'image/png',
			buffer: minimalPngBuffer()
		});
		await expect(page.getByRole('img', { name: PNG_FILE_NAME, exact: true })).toBeVisible();

		// 2. Upload a non-image file - it goes into the plain file-row list
		// with its name and an extension badge (`fileTypeLabel`), not the
		// thumbnail grid.
		await uploadInput.setInputFiles({
			name: TXT_FILE_NAME,
			mimeType: 'text/plain',
			buffer: Buffer.from('e2e attachment smoke test\n', 'utf-8')
		});
		const fileRow = page.locator('.file-row').filter({ hasText: TXT_FILE_NAME });
		await expect(fileRow).toBeVisible();
		await expect(fileRow.getByText('TXT', { exact: true })).toBeVisible();

		// 3. Delete the text file first (the in-page confirm dialog the app
		// injects as `confirmDelete`, Issue #556). Partial state: the
		// file-row list empties out but the PNG thumbnail is still there.
		await confirmInDialog(page, fileRow.getByRole('button', { name: '削除' }), {
			title: '削除の確認',
			confirm: '削除'
		});
		await expect(fileRow).toHaveCount(0);
		await expect(page.getByRole('img', { name: PNG_FILE_NAME, exact: true })).toBeVisible();

		// 4. Delete the PNG too - the panel returns to its empty-state copy.
		const thumbTile = page.locator('.thumb-tile').filter({ hasText: PNG_FILE_NAME });
		await confirmInDialog(page, thumbTile.getByRole('button', { name: '削除' }), {
			title: '削除の確認',
			confirm: '削除'
		});
		await expect(page.getByText('添付ファイルはありません')).toBeVisible();

		// The parent record's history includes both actions on the removed file.
		await page.goto('/items');
		await applyColumnFilter(page, '商品名', ATTACHMENT_ITEM_NAME);
		const historyRow = rowWithText(page, ATTACHMENT_ITEM_NAME);
		const drawer = await openInDrawer(page, historyRow, itemId);
		await drawer.getByRole('tab', { name: '履歴', exact: true }).click();
		const historyTable = drawer.getByRole('table', { name: /履歴/ });
		await expect(
			historyTable.getByRole('cell', { name: `添付ファイル：作成（${TXT_FILE_NAME}）` })
		).toBeVisible();
		await expect(
			historyTable.getByRole('cell', { name: `添付ファイル：削除（${TXT_FILE_NAME}）` })
		).toBeVisible();
		await page.goto(href);

		// 5. Re-upload one attachment and deliberately leave it in place: the
		// cleanup step below deletes the item itself while it still owns an
		// attachment, exercising the demo wiring's orphan cleanup
		// (`delete_for_record("items", id)`, attachments-plan §3.8) rather than only ever
		// deleting items with zero attachments.
		await uploadInput.setInputFiles({
			name: PNG_FILE_NAME_2,
			mimeType: 'image/png',
			buffer: minimalPngBuffer()
		});
		await expect(page.getByRole('img', { name: PNG_FILE_NAME_2, exact: true })).toBeVisible();

		// Cleanup: delete the scenario item (`.form-panel`-scoped - the
		// attachment tile above has its own same-labelled "削除" button, so an
		// unscoped getByRole would be ambiguous). Deleting an item that still
		// has an attachment must not error.
		await confirmInDialog(page, page.locator('.form-panel').getByRole('button', { name: '削除' }), {
			title: '削除の確認',
			confirm: '削除'
		});
		await expect(page).toHaveURL(/\/items$/);

		await page.goto(href);
		await expect(page.getByText('商品が見つかりません')).toBeVisible();
	});

	test('8b. items: files chosen on the create form upload after the save; a failed upload is retried on the edit form (#714)', async () => {
		const name = `E2Eファイル欄商品-${Date.now()}`;
		const fillItem = async () => {
			await page.goto('/items/new');
			await page.getByLabel('商品名').fill(name);
			await page.getByLabel('価格').fill(String(ITEM_PRICE));
			await page.getByLabel('在庫').fill(String(ITEM_STOCK));
		};
		const group = page.getByRole('group', { name: '添付ファイル' });
		const png = { name: PNG_FILE_NAME, mimeType: 'image/png', buffer: minimalPngBuffer() };

		// 1. A chosen file waits on the create form, then uploads once the record exists.
		await fillItem();
		await group.locator('input[type=file]').setInputFiles(png);
		await expect(
			group.getByText('選んだファイルは、保存のあとでアップロードされます')
		).toBeVisible();
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await applyColumnFilter(page, '商品名', name);
		const row = rowWithText(page, name);
		const id = await rowItemId(row);
		await page.goto(`/items/${id}`);
		await expect(page.getByRole('img', { name: PNG_FILE_NAME, exact: true })).toBeVisible();
		await confirmInDialog(page, page.locator('.form-panel').getByRole('button', { name: '削除' }), {
			title: '削除の確認',
			confirm: '削除'
		});
		await expect(page).toHaveURL(/\/items$/);

		// 2. The upload fails once: the record stays, its edit form opens with the file
		// still pending and the reason shown; 再試行 uploads it.
		let refuse = true;
		await page.route('**/api/attachments?*', async (route) => {
			if (refuse && route.request().method() === 'POST') await route.abort('failed');
			else await route.continue();
		});
		await fillItem();
		await group.locator('input[type=file]').setInputFiles(png);
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items\/\d+$/);
		const failed = page.getByRole('group', { name: '添付ファイル' });
		await expect(failed.getByRole('alert')).toHaveText('サーバーに接続できません');
		refuse = false;
		await failed.getByRole('button', { name: `${PNG_FILE_NAME}: 再試行` }).click();
		await expect(failed.getByRole('alert')).toHaveCount(0);
		await expect(failed.getByText(PNG_FILE_NAME)).toBeVisible();
		await page.unroute('**/api/attachments?*');

		// Cleanup: the item and its attachment.
		await confirmInDialog(
			page,
			page.locator('.form-panel').getByRole('button', { name: '削除', exact: true }),
			{
				title: '削除の確認',
				confirm: '削除'
			}
		);
		await expect(page).toHaveURL(/\/items$/);
	});

	test('8c. items: a second save while the files of a create are still uploading does not create the record twice (#714)', async () => {
		const name = `E2E二重保存商品-${Date.now()}`;
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let uploadHeld: () => void = () => {};
		const uploadStarted = new Promise<void>((resolve) => (uploadHeld = resolve));
		await page.route('**/api/attachments?*', async (route) => {
			if (route.request().method() === 'POST') {
				uploadHeld();
				await held;
			}
			await route.continue();
		});
		await page.goto('/items/new');
		await page.getByLabel('商品名').fill(name);
		await page.getByLabel('価格').fill(String(ITEM_PRICE));
		await page.getByLabel('在庫').fill(String(ITEM_STOCK));
		await page
			.getByRole('group', { name: '添付ファイル' })
			.locator('input[type=file]')
			.setInputFiles({ name: PNG_FILE_NAME, mimeType: 'image/png', buffer: minimalPngBuffer() });
		await page.getByRole('button', { name: '保存' }).click();
		// The record exists, the upload is held: Enter in a field must not save again.
		await uploadStarted;
		await page.getByLabel('商品名').press('Enter');
		await page.getByLabel('商品名').press('Enter');
		release();
		await expect(page).toHaveURL(/\/items$/);
		await page.unroute('**/api/attachments?*');

		await applyColumnFilter(page, '商品名', name);
		await expect(rowWithText(page, name)).toHaveCount(1);
		const id = await rowItemId(rowWithText(page, name));
		await page.goto(`/items/${id}`);
		await confirmInDialog(
			page,
			page.locator('.form-panel').getByRole('button', { name: '削除', exact: true }),
			{ title: '削除の確認', confirm: '削除' }
		);
		await expect(page).toHaveURL(/\/items$/);
	});

	test('9. command palette: search and navigate to the audit log', async () => {
		await page.goto('/items');
		// The Ctrl+K listener lives on (app)/+layout.svelte's `<svelte:window>`,
		// which only mounts after the route guard's async work (bantoReady,
		// the session confirmation) resolves - later than page.goto()'s "load"
		// event. Wait for a page-specific element first so the keypress below
		// isn't racing that mount.
		await expect(page.getByRole('button', { name: '新規作成' })).toBeVisible();

		await page.keyboard.press('Control+K');
		const search = page.getByPlaceholder('画面・操作を検索…');
		await expect(search).toBeVisible();
		await search.fill('監査');
		await search.press('Enter');

		await expect(page).toHaveURL(/\/audit-log$/);
	});

	// Issue #435 PR-11: Ctrl+K is a command of the app's shortcut dispatcher.
	// The open palette is its `ownerLayer`, so the key that closes it still
	// works from the palette's own search box (`allowInEditable`); an IME
	// composition never toggles it; a held key toggles once and its repeats are
	// still kept from the browser.
	test('9a. command palette: Ctrl+K closes it from its own search box; IME and held keys do not toggle it', async () => {
		await page.goto('/items');
		await expect(page.getByRole('button', { name: '新規作成' })).toBeVisible();
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		const search = page.getByPlaceholder('画面・操作を検索…');

		/** Dispatch a synthetic Ctrl+K keydown at the focused element; was it consumed? */
		const ctrlK = (init: { isComposing?: boolean; repeat?: boolean }) =>
			page.evaluate((extra) => {
				const event = new KeyboardEvent('keydown', {
					key: 'k',
					code: 'KeyK',
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
					...extra
				});
				(document.activeElement ?? document.body).dispatchEvent(event);
				return event.defaultPrevented;
			}, init);

		await page.keyboard.press('Control+K');
		await expect(palette).toBeVisible();
		await search.fill('監');
		await expect(search).toBeFocused();
		await page.keyboard.press('Control+K');
		await expect(palette).toHaveCount(0);

		// Composing: left to the IME / browser, nothing toggles.
		expect(await ctrlK({ isComposing: true })).toBe(false);
		await expect(palette).toHaveCount(0);
		// An auto-repeat: consumed (no browser Ctrl+K), but it does not toggle.
		expect(await ctrlK({ repeat: true })).toBe(true);
		await expect(palette).toHaveCount(0);
	});

	// #711 (B-5): the palette finds a record by what is typed and opens it in the
	// list's drawer; the record then shows under "recently opened" for an empty
	// query. The record is created here and deleted at the end.
	test('9b. command palette: search a record, open it in the drawer, then find it under recent records', async () => {
		const name = `E2Eパレット商品-${Date.now()}`;
		await page.goto('/items/new');
		await page.getByLabel('商品名').fill(name);
		await page.getByLabel('価格').fill('100');
		await page.getByLabel('在庫').fill('1');
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);
		await expect(page.getByRole('button', { name: '新規作成' })).toBeVisible();

		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		// The Ctrl+K listener may not be mounted yet right after the navigation.
		await expect(async () => {
			await page.keyboard.press('Control+K');
			await expect(palette).toBeVisible({ timeout: 1_000 });
		}).toPass();
		await page.getByPlaceholder('画面・操作を検索…').fill(name);
		// The hit appears under the resource's heading (the source is debounced).
		const hit = palette.getByRole('option', { name, exact: true });
		await expect(hit).toBeVisible();
		await hit.click();

		await expect(page).toHaveURL(/\/items\?id=\d+$/);
		const id = new URL(page.url()).searchParams.get('id') ?? '';
		await expect(itemDrawer(page, id)).toBeVisible();

		// Empty query: the record just opened is the first thing offered.
		await page.keyboard.press('Escape');
		await expect(itemDrawer(page, id)).toHaveCount(0);
		await expect(async () => {
			await page.keyboard.press('Control+K');
			await expect(palette).toBeVisible({ timeout: 1_000 });
		}).toPass();
		await expect(palette.getByText('最近開いたレコード', { exact: true })).toBeVisible();
		await expect(palette.getByRole('option', { name, exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(palette).toHaveCount(0);

		// Cleanup.
		await page.goto(`/items/${id}`);
		await confirmInDialog(page, page.locator('.form-panel').getByRole('button', { name: '削除' }), {
			title: '削除の確認',
			confirm: '削除'
		});
		await expect(page).toHaveURL(/\/items$/);
	});

	test('10. header: the sun/moon button pins the opposite theme and sets data-theme', async () => {
		await page.goto('/settings');

		// The button shows the OPPOSITE of the theme on screen (the colour-mode
		// picker left the settings page). This run's browser follows a light OS,
		// so it starts as "switch to dark" and, once pressed, offers the way back.
		await page.getByRole('button', { name: 'ダークモードに切り替え' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect(page.getByRole('button', { name: 'ライトモードに切り替え' })).toBeVisible();
	});

	// Issue #214: the account page's password form is the save-type settings
	// form this LAN/REST run can reach (サーバ・接続 / セキュリティ drafts are
	// desktop-only). Unsaved input asks before switching category; a failed
	// save keeps it unsaved; "discard" and a successful save do not ask.
	test('10a. settings: unsaved password input asks before switching category', async () => {
		const dialogs = trackDialogs(page);
		const unsaved = page.getByText('未保存の変更があります');
		const categoryNav = page.getByRole('navigation', { name: '設定カテゴリ' });
		const current = page.getByLabel('現在のパスワード');
		const next = page.getByLabel('新しいパスワード（8文字以上）');
		const confirmNext = page.getByLabel('新しいパスワード（確認）');
		const changePassword = '**/api/auth/change-password';
		try {
			await categoryNav.getByRole('link', { name: 'アカウント' }).click();
			await expect(page).toHaveURL(/\/settings\/account$/);
			await expect(unsaved).toHaveCount(0);

			// Current credentials alone (including browser autofill) are not a
			// replacement password draft and must not block navigation.
			await current.fill('typed-but-not-saved');
			await expect(unsaved).toHaveCount(0);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect(page).toHaveURL(/\/settings\/appearance$/);
			expect(dialogs.messages).toHaveLength(0);
			await categoryNav.getByRole('link', { name: 'アカウント' }).click();
			await expect(page).toHaveURL(/\/settings\/account$/);
			await current.fill('typed-but-not-saved');
			await next.fill('E2eUnsavedNew1');
			await expect(unsaved).toBeVisible();

			dialogs.answer(false);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/settings\/account$/);
			await expect(current).toHaveValue('typed-but-not-saved');

			// A failed save keeps the input and the unsaved marker (network
			// failure stubbed: no password attempt reaches the server).
			await confirmNext.fill('E2eUnsavedNew1');
			await page.route(changePassword, (route) => route.abort());
			try {
				await page.getByRole('button', { name: 'パスワードを変更' }).click();
				await expect(page.locator('.settings-page .error')).toBeVisible();
			} finally {
				await page.unroute(changePassword);
			}
			await expect(unsaved).toBeVisible();
			await expect(current).toHaveValue('typed-but-not-saved');

			// Explicit discard clears it: switching category no longer asks.
			await page.getByRole('button', { name: '変更を取り消す' }).click();
			await expect(current).toHaveValue('');
			await expect(unsaved).toHaveCount(0);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect(page).toHaveURL(/\/settings\/appearance$/);
			expect(dialogs.messages).toHaveLength(1);

			// A successful save (stubbed, so the admin password stays as is)
			// clears the form: switching category does not ask either.
			await categoryNav.getByRole('link', { name: 'アカウント' }).click();
			await expect(page).toHaveURL(/\/settings\/account$/);
			await current.fill(ADMIN_PASSWORD);
			await next.fill('E2eUnsavedNew1');
			await confirmNext.fill('E2eUnsavedNew1');
			await page.route(changePassword, (route) =>
				route.fulfill({ status: 200, json: { success: true } })
			);
			try {
				await page.getByRole('button', { name: 'パスワードを変更' }).click();
				await expect(current).toHaveValue('');
			} finally {
				await page.unroute(changePassword);
			}
			await expect(unsaved).toHaveCount(0);
			await categoryNav.getByRole('link', { name: '外観・言語' }).click();
			await expect(page).toHaveURL(/\/settings\/appearance$/);
			expect(dialogs.messages).toHaveLength(1);
		} finally {
			dialogs.stop();
		}
	});

	test('11. backups: create a backup and see it in the list', async () => {
		// settings-routes step 2 (choiapp-feedback-2026-09 §3.2): backups live
		// on the データ管理 category's own route now, not on `/settings`
		// (which redirects to 外観・言語).
		await page.goto('/settings/data');

		const backupRows = page.locator('.backup-list li');
		await expect(backupRows).toHaveCount(0);

		await page.getByRole('button', { name: '今すぐバックアップ' }).click();
		await expect(backupRows).toHaveCount(1);
	});

	// Copilot review on PR #198 (settings-routes step 2): authSettingsStore/
	// systemInfoStore used to be loaded by whichever section's own mount
	// effect happened to own the fetch (SecuritySection/ConnectivitySection),
	// which silently no-oped on a direct visit to any OTHER category's route
	// since that section never mounts there. The fix moved both initial
	// loads to the persistent `settings/+layout.svelte`. Assert that
	// directly - not via scenario 11's `/settings/data` visit above, which
	// would still pass even if the layout-level load were broken as long as
	// ConnectivitySection had happened to run first in the same session -
	// by going straight to `/settings/connectivity` and confirming the
	// System Info card (systemInfoStore) is populated, plus that the nav
	// marks the current category via `aria-current` (base-aware `isActive`).
	test('11a. settings: a direct visit to /settings/connectivity loads System Info via the layout', async () => {
		await page.goto('/settings/connectivity');

		await expect(page.getByRole('link', { name: 'サーバ・接続' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(page.getByText('sqlite', { exact: false })).toBeVisible();
	});

	// M19 report demo (docs/design/report-plan.md §3.6, docs/template-scope.md §3):
	// items -> 日報 -> the report renders. Deliberately does NOT trigger
	// window.print() (report-plan §3.6) - only confirms the template rendered real
	// data, not the print dialog itself. Placed last: by this point
	// scenarios 3 and 8 have each created then deleted exactly one item
	// (net zero), so the grid is back to its 1,000-row seed baseline and
	// the report's total-count string is deterministic.
	test('12. items: 日報 report renders a heading, totals, and a category table', async () => {
		await page.goto('/items');
		await chooseItemsMoreAction(page, 'その他の操作', '日報');
		await expect(page).toHaveURL(/\/items\/report$/);

		await expect(page.getByRole('heading', { level: 1, name: /^日報/ })).toBeVisible();
		await expect(page.getByText('1,000件')).toBeVisible();

		// PRODUCT_BASES seeds exactly 12 categories (db.rs) and byCategory
		// (dashboard.ts) never folds them, so the rendered category table has
		// exactly 12 data rows.
		const categoryRows = page.locator('.report-body table').first().locator('tbody tr');
		await expect(categoryRows).toHaveCount(12);
	});

	// Nav badge (choiapp-feedback-2026-09 §4.1): a `resource_changed` server
	// event for a resource whose page is NOT on screen shows an
	// unseen-updates badge on that resource's sidebar entry
	// (#lib/navBadges.svelte.ts), and visiting the page clears it. The
	// "another client" is simulated by calling the REST API directly from
	// the page context with the session's own bearer token - the server
	// broadcasts the same SSE event either way. Creates then deletes one
	// item (net zero), so scenario 14's state is untouched.
	test('13. sidebar: an item change from another client shows an unseen-updates badge', async () => {
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

		const badge = page.locator('.nav-badge');
		await expect(badge).toHaveCount(0);

		const createdId = await page.evaluate(async () => {
			// Same lookup order as admin-core's `createHttpAuthProvider().getToken`
			// (localStorage only when "remember me" was used - this login wasn't).
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const res = await fetch('/api/items', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Banto-Client': 'banto',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ name: 'E2Eバッジ確認商品', price: 100, stock: 1 })
			});
			if (!res.ok) throw new Error(`create failed: ${res.status}`);
			return ((await res.json()) as { id: number }).id;
		});

		// SSE delivery -> onInvalidate('items') -> badge on 商品 (the
		// auto-retrying expect absorbs the event latency).
		await expect(badge).toHaveText('1');

		// Cleanup while still on the dashboard: the delete broadcasts another
		// resource_changed, so the same badge counts it too.
		await page.evaluate(async (id) => {
			const token =
				localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
			const res = await fetch(`/api/items/${id}`, {
				method: 'DELETE',
				headers: { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` }
			});
			if (!res.ok) throw new Error(`delete failed: ${res.status}`);
		}, createdId);
		await expect(badge).toHaveText('2');

		// Landing on the page marks the changes as seen.
		await page.goto('/items');
		await expect(badge).toHaveCount(0);
	});

	// Issue #204 review: a session the server could not verify (500 from the
	// session check - `/api/auth/identity` since Issue #260 実装-2) stays - regular and "Remember me" tokens alike - and
	// resumes after "再試行". Public viewing is OFF on this server, so the old
	// behavior would have bounced to /login.
	test('13a. an auth-check outage keeps the session instead of logging out', async () => {
		await expectCheckOutageKeepsTheSession(page, false);

		await logout(page);
		await expect(page).toHaveURL(/\/login$/);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByLabel('ログイン状態を保持する（30日間）').check();
		await page.getByRole('button', { name: 'ログイン' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);

		await expectCheckOutageKeepsTheSession(page, true);
	});

	// Issue #321 (follow-up to #286): a protected screen opened directly while
	// the server is unreachable. The route guard used to wait for startup, and
	// on a first load SvelteKit draws nothing until the loads finish - so the
	// screen stayed blank with no way to reconnect. Now the splash shows
	// "起動中…" then "サーバーに接続できません" + 再接続 on the protected URL
	// itself (never demo, #286), and once the server is back the reconnect
	// opens that same screen with the session kept (Remember me from 13a).
	test('13a2. a protected screen opened while the server is unreachable offers reconnect and then opens', async () => {
		const serverDown = (route: Route) => route.abort('connectionrefused');
		await page.route('**/api/**', serverDown);
		try {
			await page.goto('/dashboard');
			await expect(page.getByRole('status')).toHaveText('起動中…');
			const unreachable = page.getByRole('alert');
			// 3 probes 1.5 s apart (STARTUP_AUTO_RETRIES) before the screen appears.
			await expect(unreachable).toContainText('サーバーに接続できません', { timeout: 15_000 });
			await expect(page).toHaveURL(/\/dashboard$/);
			await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
		} finally {
			await page.unroute('**/api/**', serverDown);
		}

		await page.getByRole('alert').getByRole('button', { name: '再接続' }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.getByText('サーバーに接続できません')).toHaveCount(0);
	});

	// Issue #637 (D-4): a LAN browser that loses the server shows a banner under
	// the header, a failed save keeps what was typed (form and grid cell) and
	// says the connection is the reason, and once requests are answered again
	// the banner goes, "再接続しました" is toasted once, and the same input saves.
	// Requests are made to fail with `page.route`; the already-open event stream
	// is untouched, so it is the requests that tell the page.
	test('13a3. #637: a lost connection shows the banner; failed saves keep the input; retry brings it back', async () => {
		const DRAFT_NAME = `E2E切断テスト商品-${Date.now()}`;
		const banner = page.getByTestId('connection-region');
		const serverDown = (route: Route) => route.abort('connectionrefused');

		await page.goto('/items/new');
		await expect(page.getByTestId('connection-region')).toBeAttached();
		await expect(banner.getByRole('button', { name: '再試行', exact: true })).toHaveCount(0);
		await page.getByLabel('商品名').fill(DRAFT_NAME);
		await page.getByLabel('価格').fill('321');
		await page.getByLabel('在庫').fill('7');

		await page.route('**/api/**', serverDown);
		try {
			// One failed request is not a disconnect; the second is.
			await page.getByRole('button', { name: '保存' }).click();
			await expect(page.getByText('接続できないため保存できませんでした').first()).toBeVisible();
			await page.getByRole('button', { name: '保存' }).click();
			await expect(banner).toContainText('サーバーに接続できません。再接続しています…');
			await expect(banner).toContainText('再読み込みすると、編集中の内容は消えます。');
			await expect(page).toHaveURL(/\/items\/new$/);
			// The draft is still there.
			await expect(page.getByLabel('商品名')).toHaveValue(DRAFT_NAME);
			await expect(page.getByLabel('価格')).toHaveValue('321');
			await expect(page.getByLabel('在庫')).toHaveValue('7');
			// Retrying while it is still down changes nothing.
			await banner.getByRole('button', { name: '再試行', exact: true }).click();
			await expect(banner).toContainText('サーバーに接続できません。再接続しています…');
		} finally {
			await page.unroute('**/api/**', serverDown);
		}

		await banner.getByRole('button', { name: '再試行', exact: true }).click();
		await expect(banner.getByRole('button', { name: '再試行', exact: true })).toHaveCount(0);
		await expect(page.getByText('再接続しました', { exact: true })).toHaveCount(1);
		await expect(page.getByLabel('商品名')).toHaveValue(DRAFT_NAME);

		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		// The grid cell: a failed inline save keeps the typed value in the editor.
		await applyColumnFilter(page, '商品名', DRAFT_NAME);
		const row = rowWithText(page, DRAFT_NAME);
		await expect(row).toBeVisible();
		const itemId = await rowItemId(row);
		const editor = page.getByRole('grid').locator('.cell-editor');
		await page.route('**/api/**', serverDown);
		try {
			await row.locator('[data-cell-field="price"]').dblclick();
			await editor.fill('654');
			await page.keyboard.press('Enter');
			await expect(editor).toBeVisible();
			await expect(editor).toHaveValue('654');
			await expect(page.getByText('接続できないため保存できませんでした').first()).toBeVisible();
		} finally {
			await page.unroute('**/api/**', serverDown);
		}
		await editor.press('Enter');
		await expect(editor).toHaveCount(0);
		await expect(row.locator('[data-cell-field="price"]')).toContainText('654');

		// Clean up so later scenarios see the data they expect.
		await page.goto(`/items/${itemId}`);
		await confirmInDialog(page, page.getByRole('button', { name: '削除' }), {
			title: '削除の確認',
			confirm: '削除'
		});
		await expect(page).toHaveURL(/\/items$/);
	});

	// Issue #638 (optimistic lock): two clients edit the same item. (a) The
	// detail form's second save opens the diff dialog, and "choose per field"
	// saves one field from each side. (b) A grid cell edit on a row someone
	// else changed is not saved: the row shows the latest values and a toast
	// says why - also when their change already reached this list through
	// the SSE refresh while the editor was open. (c) A delete of a record
	// someone else changed is refused and the form shows their record.
	test('13a5. #638: concurrent edits - the diff dialog, a refused cell edit, a refused delete', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const NAME = `E2E楽観ロック商品-${Date.now()}`;
		const CONFLICT_TITLE = '他の人が先に変更しました';
		const NOT_SAVED = '他の人が変更したため保存しませんでした。最新の値を表示しています。';
		const NOT_DELETED = '他の人が変更したため削除しませんでした。最新の値を表示しています。';

		/** REST call with a page's session (no `version` = overwrite, like another client). */
		async function api(
			method: string,
			path: string,
			body?: unknown,
			on: Page = page
		): Promise<Record<string, unknown>> {
			return on.evaluate(
				async ({ method, path, body }) => {
					const token =
						localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
					const res = await fetch(path, {
						method,
						headers: {
							'Content-Type': 'application/json',
							'X-Banto-Client': 'banto',
							Authorization: `Bearer ${token}`
						},
						body: body === undefined ? undefined : JSON.stringify(body)
					});
					if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
					return res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
				},
				{ method, path, body }
			);
		}

		await page.goto('/items');
		const created = await api('POST', '/api/items', { name: NAME, price: 100, stock: 10 });
		const id = String(created.id);

		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const other = await context.newPage();
		try {
			await other.goto('/login');
			await other.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await other.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await other.getByRole('button', { name: 'ログイン' }).click();
			await expect(other).toHaveURL(/\/dashboard$/);

			// (a) Both open the record; this page saves first.
			await page.goto(`/items/${id}`);
			await other.goto(`/items/${id}`);
			await expect(page.getByLabel('価格')).toHaveValue('100');
			await expect(other.getByLabel('価格')).toHaveValue('100');
			await page.getByLabel('価格').fill('200');
			await page.getByLabel('在庫').fill('20');
			await page.getByRole('button', { name: '保存', exact: true }).click();
			await expect(page).toHaveURL(/\/items$/);

			// The other client saves on the version it loaded: the dialog shows
			// the two fields this page changed (not the name, only theirs).
			await other.getByLabel('商品名').fill(`${NAME}-B`);
			await other.getByLabel('価格').fill('300');
			await other.getByLabel('在庫').fill('30');
			await other.getByRole('button', { name: '保存', exact: true }).click();
			const dialog = other.getByRole('dialog', { name: CONFLICT_TITLE, exact: true });
			await expect(dialog).toBeVisible();
			const table = dialog.getByTestId('conflict-changes');
			await expect(table.getByRole('row')).toHaveCount(3);
			await expect(table.getByRole('row', { name: /価格/ })).toContainText('200');
			await expect(table.getByRole('row', { name: /価格/ })).toContainText('300');

			await dialog.getByRole('button', { name: '項目ごとに選ぶ', exact: true }).click();
			await dialog.getByRole('radio', { name: '「価格」は相手の値を残す', exact: true }).check();
			await expect(
				dialog.getByRole('radio', { name: '「在庫」はあなたの値を残す', exact: true })
			).toBeChecked();
			await dialog.getByRole('button', { name: '選んだ値で保存', exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(other).toHaveURL(/\/items$/);
			await expect
				.poll(async () => {
					const saved = await api('GET', `/api/items/${id}`);
					return { name: saved.name, price: saved.price, stock: saved.stock };
				})
				.toEqual({ name: `${NAME}-B`, price: 200, stock: 30 });

			// (b) This page opens a price editor; the other client then saves the
			// same row, and the SSE refresh brings it into this list while the
			// editor is still open (the name cell changes). Enter must not save
			// the draft on the refreshed row's newer version: it was typed
			// against the old row, so it is refused and the latest value shows.
			await applyColumnFilter(page, '商品名', NAME);
			const row = rowWithText(page, `${NAME}-B`);
			await expect(row.locator('[data-cell-field="price"]')).toHaveText('¥200');
			const editor = page.getByRole('grid').locator('.cell-editor');
			await expect(async () => {
				if (!(await editor.isVisible())) await row.locator('[data-cell-field="price"]').dblclick();
				await expect(editor).toBeVisible({ timeout: 1_000 });
			}).toPass();
			await editor.fill('555');
			await api('PUT', `/api/items/${id}`, { name: `${NAME}-B2`, price: 777, stock: 30 }, other);
			await expect(row.locator('[data-cell-field="name"]')).toHaveText(`${NAME}-B2`);
			await expect(editor).toBeVisible();
			await editor.press('Enter');
			await expect(page.getByText(NOT_SAVED, { exact: true }).first()).toBeVisible();
			await expect(editor).toHaveCount(0);
			await expect(row.locator('[data-cell-field="price"]')).toHaveText('¥777');
			expect((await api('GET', `/api/items/${id}`)).price).toBe(777);

			// (c) A delete of a record someone else changed after it was opened.
			await page.goto(`/items/${id}`);
			await expect(page.getByLabel('価格')).toHaveValue('777');
			await api('PUT', `/api/items/${id}`, { name: `${NAME}-C`, price: 777, stock: 30 });
			await confirmInDialog(page, page.getByRole('button', { name: '削除', exact: true }), {
				title: '削除の確認',
				confirm: '削除'
			});
			await expect(page.getByText(NOT_DELETED, { exact: true }).first()).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`/items/${id}$`));
			await expect(page.getByLabel('商品名')).toHaveValue(`${NAME}-C`);

			// The form now holds the latest version: deleting again goes through.
			await confirmInDialog(page, page.getByRole('button', { name: '削除', exact: true }), {
				title: '削除の確認',
				confirm: '削除'
			});
			await expect(page).toHaveURL(/\/items$/);
		} finally {
			await context.close();
		}
	});

	// Issue #637: the browser's own offline state is its own banner, and it goes
	// when the network is back (`online` event) without any request being sent.
	test('13a4. #637: the browser going offline shows its own banner and clears when it is back', async () => {
		const banner = page.getByTestId('connection-region');
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(banner.getByText('ネットワークに接続されていません')).toHaveCount(0);

		await page.context().setOffline(true);
		try {
			await expect(banner).toContainText('ネットワークに接続されていません');
			await expect(banner).toContainText('再読み込みすると、編集中の内容は消えます。');
		} finally {
			await page.context().setOffline(false);
		}
		await expect(banner.getByText('ネットワークに接続されていません')).toHaveCount(0);
		await expect(page.getByText('再接続しました', { exact: true })).toHaveCount(1);
	});

	// Issue #241: a session revoked while its screen is open. A second
	// browser (its own storage) logs in as the viewer with "Remember me"; the
	// admin page then resets that account's password (Issue #204: this ends
	// every session of the account). The viewer's event stream is closed by
	// the server's periodic revalidation (15 s), its reconnect gets a `401`,
	// the session check confirms it (`/api/auth/identity` answers `200 null`
	// since Issue #260 実装-2) and clears the stored token, and the route
	// guard sends the open screen to /login. The stream must then stop
	// retrying (it used to retry every 3 s forever).
	test('13b. a session revoked from another session leaves its open screen for the login page', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const other = await context.newPage();
		try {
			const events: { at: number; status: number }[] = [];
			const checks: { status: number; body: string }[] = [];
			other.on('response', async (response) => {
				const path = new URL(response.url()).pathname;
				if (path === '/api/events') events.push({ at: Date.now(), status: response.status() });
				if (path === '/api/auth/identity') {
					checks.push({ status: response.status(), body: await response.text() });
				}
			});

			await other.goto('/login');
			await other.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await other.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await other.getByLabel('ログイン状態を保持する（30日間）').check();
			const streamOpened = other.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/events' && response.status() === 200
			);
			await other.getByRole('button', { name: 'ログイン' }).click();
			await expect(other).toHaveURL(/\/dashboard$/);
			await streamOpened;
			expect(
				await other.evaluate(() => localStorage.getItem('banto.auth.token')),
				'a Remember me token'
			).toBeTruthy();

			// Reset the viewer's password (to the same value, so nothing else in
			// this suite changes) from the admin's own session.
			await page.evaluate(
				async ({ username, password }) => {
					const token =
						localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
					const headers = { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` };
					const list = await fetch('/api/users', { headers });
					if (!list.ok) throw new Error(`list failed: ${list.status}`);
					const body = (await list.json()) as
						{ id: number; username: string }[] | { rows: { id: number; username: string }[] };
					const rows = Array.isArray(body) ? body : body.rows;
					const viewer = rows.find((row) => row.username === username);
					if (!viewer) throw new Error('viewer account not found');
					const reset = await fetch(`/api/users/${viewer.id}/reset-password`, {
						method: 'POST',
						headers: { ...headers, 'Content-Type': 'application/json' },
						body: JSON.stringify({ newPassword: password })
					});
					if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
				},
				{ username: VIEWER_USERNAME, password: VIEWER_PASSWORD }
			);

			// Up to one revalidation interval (15 s) + one reconnect (3 s).
			await expect(other).toHaveURL(/\/login$/, { timeout: 40_000 });
			expect(
				await other.evaluate(() => ({
					local: localStorage.getItem('banto.auth.token'),
					session: sessionStorage.getItem('banto.auth.token')
				})),
				'the revoked token is cleared'
			).toEqual({ local: null, session: null });
			expect(checks, 'the session check confirmed the revocation').toContainEqual({
				status: 200,
				body: 'null'
			});

			// The stream stops: after its one 401 there is no further request.
			// The only fixed wait in this file - "nothing more happens" needs a
			// window; 2 reconnect intervals (3 s each) plus margin.
			const rejected = events.filter((event) => event.status === 401);
			expect(rejected, 'exactly one rejected reconnect').toHaveLength(1);
			await other.waitForTimeout(7_000);
			expect(events.filter((event) => event.at > rejected[0].at)).toEqual([]);
			expect(events.filter((event) => event.status === 401)).toHaveLength(1);
		} finally {
			await context.close();
		}
	});

	// Review of #242: two tabs of ONE browser share the "Remember me" token
	// (localStorage). The first tab's stream gets the `401`, confirms and
	// clears the shared token; the second tab's reconnect then finds no token
	// at all (no `401` of its own) and must still leave for /login. The second
	// tab's `/api/events` requests are aborted after the reset so it cannot
	// take the `401` path itself - only the "token disappeared" path.
	test('13c. a revoked Remember me session shared by two tabs sends both to the login page', async ({
		browser
	}) => {
		test.setTimeout(120_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const first = await context.newPage();
		const second = await context.newPage();
		try {
			const isEvents = (url: string) => new URL(url).pathname === '/api/events';
			const secondEventStatuses: number[] = [];
			second.on('response', (response) => {
				if (isEvents(response.url())) secondEventStatuses.push(response.status());
			});

			await first.goto('/login');
			await first.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await first.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await first.getByLabel('ログイン状態を保持する（30日間）').check();
			const firstStream = first.waitForResponse(
				(response) => isEvents(response.url()) && response.status() === 200
			);
			await first.getByRole('button', { name: 'ログイン' }).click();
			await expect(first).toHaveURL(/\/dashboard$/);
			await firstStream;

			const secondStream = second.waitForResponse(
				(response) => isEvents(response.url()) && response.status() === 200
			);
			await second.goto('/dashboard');
			await expect(second.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
			await secondStream;
			const shared = await first.evaluate(() => localStorage.getItem('banto.auth.token'));
			expect(shared, 'one shared Remember me token').toBeTruthy();
			expect(await second.evaluate(() => localStorage.getItem('banto.auth.token'))).toBe(shared);

			// From here on the second tab cannot reach the server's `401`.
			await second.route('**/api/events', (route) => route.abort());

			await page.evaluate(
				async ({ username, password }) => {
					const token =
						localStorage.getItem('banto.auth.token') ?? sessionStorage.getItem('banto.auth.token');
					const headers = { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` };
					const list = await fetch('/api/users', { headers });
					if (!list.ok) throw new Error(`list failed: ${list.status}`);
					const body = (await list.json()) as
						{ id: number; username: string }[] | { rows: { id: number; username: string }[] };
					const rows = Array.isArray(body) ? body : body.rows;
					const viewer = rows.find((row) => row.username === username);
					if (!viewer) throw new Error('viewer account not found');
					const reset = await fetch(`/api/users/${viewer.id}/reset-password`, {
						method: 'POST',
						headers: { ...headers, 'Content-Type': 'application/json' },
						body: JSON.stringify({ newPassword: password })
					});
					if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
				},
				{ username: VIEWER_USERNAME, password: VIEWER_PASSWORD }
			);

			await expect(first).toHaveURL(/\/login$/, { timeout: 40_000 });
			expect(
				await first.evaluate(() => localStorage.getItem('banto.auth.token')),
				'the first tab cleared the shared token'
			).toBeNull();
			// The second tab's stream ends at the server's next revalidation;
			// its reconnect finds the token gone.
			await expect(second).toHaveURL(/\/login$/, { timeout: 40_000 });
			expect(
				await second.evaluate(() => ({
					local: localStorage.getItem('banto.auth.token'),
					session: sessionStorage.getItem('banto.auth.token')
				}))
			).toEqual({ local: null, session: null });
			expect(secondEventStatuses, 'the second tab never got a 401 itself').not.toContain(401);
		} finally {
			await context.close();
		}
	});

	// Third review of #242: the revocation is confirmed while the FIRST
	// protected load is still waiting for its guard's check (judged valid by
	// the server, delivered late) - before the protected layout subscribes to
	// `onSessionEnded`. Once the held answer lets the route through and the
	// layout mounts, it must still leave for /login.
	test('13d. a revocation confirmed before the protected layout mounts still reaches it', async ({
		browser
	}) => {
		test.setTimeout(120_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		try {
			const isPath = (url: string, path: string) => new URL(url).pathname === path;
			await tab.goto('/login');
			await tab.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await tab.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await tab.getByLabel('ログイン状態を保持する（30日間）').check();
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);

			// Revocation seen by the stream, then its confirmation's check.
			const rejected = tab.waitForResponse(
				(response) => isPath(response.url(), '/api/events') && response.status() === 401,
				{ timeout: 60_000 }
			);
			let held = 0;
			let released!: () => void;
			const guardReleased = new Promise<void>((resolve) => (released = resolve));
			// Issue #260 実装-2: deterministic within the guard's 10 s deadline.
			// Every authorized stream request is held until the account is
			// revoked, then sent on - so the NEW document's stream gets its own
			// 401 right away instead of at the server's next revalidation (up to
			// 15 s later, past the guard's deadline: the retry page instead of
			// /login). Holding only the FIRST such request (the 実装-2 form)
			// assumed the dashboard document had already opened its stream when
			// this route was registered; when it had not (CI of #266 after
			// 73919f1, reproduced locally by registering the route before the
			// login), its request took the one hold and was dropped by the
			// navigation, and the new document's stream went through unheld.
			let revokedNow!: () => void;
			const revoked = new Promise<void>((resolve) => (revokedNow = resolve));
			await tab.route('**/api/events', async (route) => {
				if (!route.request().headers()['authorization']) return route.continue();
				await revoked;
				// The dashboard document's request may be gone with its navigation.
				await route.continue().catch(() => {});
			});
			// Issue #260 実装-2: the guard's session check is `/api/auth/identity`.
			await tab.route('**/api/auth/identity', async (route) => {
				// The confirmation's own check passes through; only the guard's
				// first check is held.
				if (held > 0 || !route.request().headers()['authorization']) return route.continue();
				held += 1;
				// The first guard's check of the next load: the server judges the
				// session valid now...
				const response = await route.fetch();
				expect(await response.json()).not.toBeNull();
				// ...then it is revoked, the stream gets its 401 and the
				// confirmation clears the token - all before this answer arrives.
				await page.evaluate(
					async ({ username, password }) => {
						const token =
							localStorage.getItem('banto.auth.token') ??
							sessionStorage.getItem('banto.auth.token');
						const headers = { 'X-Banto-Client': 'banto', Authorization: `Bearer ${token}` };
						const list = await fetch('/api/users', { headers });
						const body = (await list.json()) as
							{ id: number; username: string }[] | { rows: { id: number; username: string }[] };
						const rows = Array.isArray(body) ? body : body.rows;
						const viewer = rows.find((row) => row.username === username);
						if (!viewer) throw new Error('viewer account not found');
						const reset = await fetch(`/api/users/${viewer.id}/reset-password`, {
							method: 'POST',
							headers: { ...headers, 'Content-Type': 'application/json' },
							body: JSON.stringify({ newPassword: password })
						});
						if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
					},
					{ username: VIEWER_USERNAME, password: VIEWER_PASSWORD }
				);
				revokedNow();
				await rejected;
				await expect
					.poll(() => tab.evaluate(() => localStorage.getItem('banto.auth.token')), {
						timeout: 10_000
					})
					.toBeNull();
				// The confirmation's signal-caused check replaced the guard's
				// probe, and the SessionController aborted it (I-22), so this
				// request may be gone already - fulfilling it is best effort.
				await route.fulfill({ response }).catch(() => {});
				released();
			});

			// A fresh load of a protected screen: the guard waits on the held check.
			await tab.goto('/items', { waitUntil: 'commit' });
			await guardReleased;
			// Issue #260 実装-2: the held (stale) `valid` answer is never applied.
			// The confirmation's signal-caused probe replaced the guard's probe
			// (I-9/I-22) and answered the guard too, so it goes straight to
			// /login - not through the retry page (all within its deadline).
			await expect(tab).toHaveURL(/\/login$/, { timeout: 10_000 });
			await expect(tab.getByRole('button', { name: '再試行' })).toHaveCount(0);
			expect(
				await tab.evaluate(() => ({
					local: localStorage.getItem('banto.auth.token'),
					session: sessionStorage.getItem('banto.auth.token')
				}))
			).toEqual({ local: null, session: null });
		} finally {
			await context.close();
		}
	});

	// Issue #260 (design §6.1, §8.4): the protected layout re-runs its load
	// whenever `snapshot.generation` differs from the generation that load
	// confirmed (wiring ①, since 実装-2), and reports a change of user the
	// controller recorded (wiring ②, 実装-3). These orders change the
	// generation without ever passing through `none`.
	async function loginRemembered(tab: Page, username: string, password: string): Promise<void> {
		await tab.goto('/login');
		await tab.getByLabel('ユーザー名').fill(username);
		await tab.getByLabel('パスワード').fill(password);
		await tab.getByLabel('ログイン状態を保持する（30日間）').check();
		await tab.getByRole('button', { name: 'ログイン' }).click();
		await expect(tab).toHaveURL(/\/dashboard$/);
	}

	// S-79: another tab logs in as a different user (the shared Remember me
	// token is replaced). This tab holds its session (unknown, g+1) on the
	// `storage` event, re-runs its load and confirms the new user (g+2) -
	// never passing through `none`. The page is rebuilt for the new user
	// instead of staying hidden behind the generation gate.
	test('13e. S-79: another tab’s login as a different user rebuilds this tab for that user', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(tab.getByRole('link', { name: 'ユーザー管理' })).toHaveCount(0);

			// #258: a command palette left open by the previous user must not
			// outlive the switch (its query/selection/history are that user's).
			await tab.keyboard.press('Control+K');
			await expect(tab.getByRole('dialog', { name: 'コマンドパレット' })).toBeVisible();

			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);

			await expect(tab.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);
			await expect(tab.getByRole('dialog', { name: 'コマンドパレット' })).toHaveCount(0);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			// S-35 (wiring ②, 実装-3): the change of user is told once.
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(1);
			// This tab did not clear the shared token (I-17).
			expect(await tab.evaluate(() => localStorage.getItem('banto.auth.token'))).toBe(
				await other.evaluate(() => localStorage.getItem('banto.auth.token'))
			);
		} finally {
			await context.close();
		}
	});

	// S-80: another tab logs in again as the SAME user. The owner does not
	// change, but the hold and the re-confirmation move the generation by 2,
	// so the page is rebuilt (its in-memory state does not survive) - and is
	// shown again, not hidden.
	test('13f. S-80: another tab’s re-login as the same user rebuilds this tab’s page', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			const heading = tab.getByRole('heading', { name: 'ダッシュボード' });
			await expect(heading).toBeVisible();
			await heading.evaluate((element) => element.setAttribute('data-s80', 'before'));
			expect(await tab.locator('[data-s80]').count()).toBe(1);

			await loginRemembered(other, VIEWER_USERNAME, VIEWER_PASSWORD);

			await expect(tab.locator('[data-s80]')).toHaveCount(0);
			await expect(heading).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				VIEWER_DISPLAY_NAME
			);
			// S-59: the same user - no change-of-user notice.
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	/**
	 * The built client chunk (`_app/immutable/nodes/N.hash.js`) of one route file.
	 * Reads SvelteKit's build internals (layout as of SvelteKit 3: the node
	 * entries stay in `generated/build/client/nodes/`, the Vite manifest keys
	 * them as `generated/build/client-optimized/nodes/`); revisit on a kit
	 * upgrade if this throws.
	 */
	function nodeChunkOf(routeFile: string): string {
		const kit = new URL('../../apps/admin-template/.svelte-kit/', import.meta.url);
		const nodes = new URL('generated/build/client/nodes/', kit);
		const manifest = JSON.parse(
			fs.readFileSync(new URL('output/client/.vite/manifest.json', kit), 'utf8')
		) as Record<string, { file: string }>;
		for (const name of fs.readdirSync(nodes)) {
			if (!fs.readFileSync(new URL(name, nodes), 'utf8').includes(routeFile)) continue;
			const entry = manifest[`.svelte-kit/generated/build/client-optimized/nodes/${name}`];
			if (entry) return entry.file;
		}
		throw new Error(`no client chunk for ${routeFile} - run the admin-template build first`);
	}

	// S-74: the protected load confirmed the session (generation g), but the
	// page cannot mount yet (its client chunk is held). Meanwhile another tab
	// logs out - the shared token disappears - and this tab confirms `none`
	// (g+2) with nothing subscribed. When the layout finally mounts, wiring ①
	// sees g ≠ g+2 and re-runs the load, which sends the tab to /login: the
	// generation gate does not keep the screen hidden.
	test('13g. S-74: an ending confirmed before the protected layout mounts still sends it to /login', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await other.goto('/login');

			const chunk = nodeChunkOf('routes/(app)/dashboard/+page.svelte');
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let requested!: () => void;
			const chunkRequested = new Promise<void>((resolve) => (requested = resolve));
			await tab.route(`**/${chunk}`, async (route) => {
				requested();
				await released;
				await route.continue();
			});
			const sessionChecks: number[] = [];
			tab.on('response', (response) => {
				if (new URL(response.url()).pathname === '/api/auth/identity') {
					sessionChecks.push(response.status());
				}
			});

			await tab.goto('/dashboard', { waitUntil: 'commit' });
			await chunkRequested;
			// The guard confirmed the viewer (Issue #260 実装-3: one confirmation
			// per load - there is no separate `sessionStore.load()` any more).
			await expect.poll(() => sessionChecks.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
			expect(sessionChecks.every((status) => status === 200)).toBe(true);

			// Another tab logs out: the shared Remember me token disappears.
			await other.evaluate(() => localStorage.removeItem('banto.auth.token'));
			release();

			await expect(tab).toHaveURL(/\/login$/, { timeout: 20_000 });
		} finally {
			await context.close();
		}
	});

	/** Make this page's session checks fail (a 500) until `unroute`d. */
	async function failSessionChecks(tab: Page): Promise<() => Promise<void>> {
		const outage = async (route: Route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ kind: 'storage', message: 'database is locked' })
			});
		};
		await tab.route('**/api/auth/identity', outage);
		return () => tab.unroute('**/api/auth/identity', outage);
	}

	// S-36 / S-81 (Issue #260 実装-3, design §6.1 wiring ②③, I-24): another
	// tab logs in as a different user while this tab cannot confirm it (the
	// session check answers 500). This tab never shows the old user's screen:
	// its load ends on the retry page (503). The background confirmation later
	// confirms the new user - the retry page is NOT replaced on its own - and
	// the real "再試行" button (an in-document `refreshAll()` that keeps the
	// SessionController) rebuilds the screen for the new user and tells them
	// once: the change was recorded while no protected layout was mounted.
	test('13h. S-36/S-81: a switch that cannot be confirmed waits on the retry page; 再試行 opens the new user and tells them once', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

			const restore = await failSessionChecks(tab);
			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);

			// S-36: the retry page, on the same URL - not the viewer's screen, not /login.
			await expect(tab.getByText('ログイン状態を確認できませんでした')).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);

			// The server recovers; the background confirmation (backoff) confirms
			// the admin. The retry page stays until the user retries.
			const confirmed = tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/auth/identity' && response.status() === 200,
				{ timeout: 60_000 }
			);
			await restore();
			await confirmed;
			await expect(tab.getByText('ログイン状態を確認できませんでした')).toBeVisible();
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);

			// S-81: the real retry button.
			await tab.getByRole('button', { name: '再試行' }).click();
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);
			await expect(tab.getByRole('link', { name: 'ユーザー管理' })).toBeVisible();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(1);
		} finally {
			await context.close();
		}
	});

	// S-83 (I-24): an unhandled change of user (A -> B, recorded while this tab
	// was on the retry page) is discarded when `none` is confirmed - here the
	// other tab logs out. The user goes home from the retry page, lands on
	// /login and signs in explicitly: no change-of-user notice for the old
	// A -> B, and the fresh login is not sent anywhere else.
	test('13i. S-83: a change of user left unhandled does not outlive a confirmed logout', async ({
		browser
	}) => {
		test.setTimeout(90_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		try {
			await loginRemembered(tab, VIEWER_USERNAME, VIEWER_PASSWORD);
			await expect(tab.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

			const restore = await failSessionChecks(tab);
			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);
			await expect(tab.getByText('ログイン状態を確認できませんでした')).toBeVisible();
			const confirmed = tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/auth/identity' && response.status() === 200,
				{ timeout: 60_000 }
			);
			await restore();
			await confirmed; // A -> B recorded, not handled (no protected layout)

			// The other tab logs out: the shared token disappears, this tab confirms `none`.
			await logout(other);
			await expect(other).toHaveURL(/\/login$/);

			await tab.getByRole('link', { name: 'トップへ戻る' }).click();
			await expect(tab).toHaveURL(/\/login$/);
			await tab.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await tab.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);
			await expect(tab.getByText(OWNER_CHANGED_NOTICE)).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	// Issue #326: the generation moves WHILE a navigation is in flight - here
	// another tab logs in again (the shared Remember me token is replaced)
	// while this tab's move from the item form to the list is still loading
	// (the list's client chunk is held). Wiring ① must not start
	// `refreshAll()` in the middle of that navigation: SvelteKit 2.70
	// would abort it and leave its internal "navigating" flag set, after
	// which `beforeNavigate` - the unsaved-changes guard - is skipped. The
	// move completes, the re-run happens after it, and leaving a form with
	// unsaved input still asks.
	test('13j. #326: a generation change during a navigation keeps the move and the unsaved-changes guard', async ({
		browser
	}) => {
		test.setTimeout(60_000);
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const other = await context.newPage();
		const dialogs = trackDialogs(tab);
		try {
			await loginRemembered(tab, ADMIN_USERNAME, ADMIN_PASSWORD);
			await tab.goto('/items/new');
			await expect(tab.getByLabel('商品名')).toBeVisible();

			const chunk = nodeChunkOf('routes/(app)/items/+page.svelte');
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let requested!: () => void;
			const chunkRequested = new Promise<void>((resolve) => (requested = resolve));
			await tab.route(`**/${chunk}`, async (route) => {
				requested();
				await released;
				await route.continue();
			});

			// The form is clean: the move to the list starts without a prompt
			// and waits on the held chunk.
			await tab.getByRole('link', { name: '一覧へ戻る' }).click();
			await chunkRequested;

			// Another tab logs in again: this tab holds its session (the
			// generation moves) and confirms it again with the server.
			const reconfirmed = tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/auth/identity' && response.status() === 200
			);
			await loginRemembered(other, ADMIN_USERNAME, ADMIN_PASSWORD);
			await reconfirmed;
			release();

			// The move completed (the re-run did not send the tab back to the
			// form) and the list is shown for the re-confirmed session.
			await expect(tab).toHaveURL(/\/items$/);
			await expect(tab.getByRole('button', { name: '新規作成' })).toBeVisible();
			await expect(tab.getByRole('button', { name: 'ユーザーメニューを開く' })).toContainText(
				ADMIN_DISPLAY_NAME
			);

			// The unsaved-changes guard still runs: "stay" keeps the input.
			await tab.getByRole('button', { name: '新規作成' }).click();
			await expect(tab).toHaveURL(/\/items\/new$/);
			const name = tab.getByLabel('商品名');
			await expect(name).toBeVisible();
			await name.fill('E2E未保存-326');
			await expect(tab.getByText('未保存の変更があります')).toBeVisible();
			dialogs.answer(false);
			await tab
				.getByRole('navigation', { name: '主要ナビゲーション' })
				.getByRole('link', { name: 'ダッシュボード' })
				.click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(tab).toHaveURL(/\/items\/new$/);
			await expect(name).toHaveValue('E2E未保存-326');
		} finally {
			dialogs.stop();
			await context.close();
		}
	});

	// nav-launcher-plan.md §3/§7.2: the dock is a per-user setting on the real
	// REST provider. Chosen in 外観, it navigates and survives a reload; a user
	// who never chose one gets the default sidebar on the same browser (the
	// localStorage cache is shared, the provider's "nothing stored" resets it);
	// the first user gets the dock back on their next login. Own context, and
	// the admin's setting is put back to the sidebar at the end so the shared
	// page of the scenarios below keeps the default.
	test('13k. dock layout: chosen per user, kept across a reload, not inherited by another user', async ({
		browser
	}) => {
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		const tab = await context.newPage();
		const layoutGroup = () => tab.getByRole('radiogroup', { name: 'ナビゲーションの表示形式' });
		const savedLayout = () =>
			tab.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/ui-settings/shell.navLayout' &&
					response.request().method() === 'PUT'
			);
		try {
			await loginRemembered(tab, ADMIN_USERNAME, ADMIN_PASSWORD);
			await tab.goto('/settings');
			let saved = savedLayout();
			await layoutGroup().getByText('ドック', { exact: true }).click();
			expect((await saved).status()).toBe(204);
			await expect(tab.locator('.launcher')).toBeVisible();
			await expect(tab.locator('aside')).toHaveCount(0);
			await expect(tab.locator('html')).toHaveAttribute('data-banto-shell-nav', 'launcher');

			const nav = tab.getByRole('navigation', { name: '主要ナビゲーション' });
			await nav.getByRole('link', { name: '商品' }).click();
			await expect(tab).toHaveURL(/\/items$/);
			await expect(nav.getByRole('link', { name: '商品' })).toHaveAttribute('aria-current', 'page');

			await tab.reload();
			await expect(tab.getByRole('grid')).toBeVisible();
			await expect(tab.locator('.launcher')).toBeVisible();

			// Another user on the same browser: nothing stored for them -> sidebar.
			await logout(tab);
			await expect(tab).toHaveURL(/\/login$/);
			await tab.getByLabel('ユーザー名').fill(VIEWER_USERNAME);
			await tab.getByLabel('パスワード').fill(VIEWER_PASSWORD);
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.locator('aside')).toBeVisible();
			await expect(tab.locator('.launcher')).toHaveCount(0);
			await expect(tab.locator('html')).not.toHaveAttribute('data-banto-shell-nav', 'launcher');

			// The admin gets their own choice back, then restores the default.
			await logout(tab);
			await expect(tab).toHaveURL(/\/login$/);
			await tab.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
			await tab.getByLabel('パスワード').fill(ADMIN_PASSWORD);
			await tab.getByRole('button', { name: 'ログイン' }).click();
			await expect(tab).toHaveURL(/\/dashboard$/);
			await expect(tab.locator('.launcher')).toBeVisible();

			await tab.goto('/settings');
			saved = savedLayout();
			await layoutGroup().getByText('サイドバー', { exact: true }).click();
			expect((await saved).status()).toBe(204);
			await expect(tab.locator('aside')).toBeVisible();
		} finally {
			await context.close();
		}
	});

	// #624: the touch density is chosen in 外観, lands on <html> and survives a
	// reload. The admin's setting is put back to the standard density at the end.
	test('13k2. touch density: chosen in 外観, kept across a reload', async () => {
		const densityGroup = () => page.getByRole('radiogroup', { name: '表示密度' });
		await page.goto('/settings/appearance');
		await densityGroup().getByText('タッチ', { exact: true }).click();
		await expect(page.locator('html')).toHaveAttribute('data-banto-density', 'touch');
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-banto-density', 'touch');
		await expect(densityGroup().getByRole('radio', { name: 'タッチ' })).toBeChecked();
		// Dock window buttons are a tap target: at least the small control height.
		await page.goto('/dashboard');
		const dockButton = page.locator('.dock-wrapper .close-btn, .dock-wrapper .popout-btn').first();
		await dockButton.scrollIntoViewIfNeeded();
		expect((await dockButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
		await page.goto('/settings/appearance');
		await densityGroup().getByText('標準', { exact: true }).click();
		await expect(page.locator('html')).toHaveAttribute('data-banto-density', 'standard');
	});

	// Issue #432 PR-10 (shared-primitives-upstream-plan §3.5・D9): the dashboard
	// メモ pane keeps unapplied input across the dock's structure changes (the
	// draft is owned by the page, the pane is re-created), a close settles it
	// (apply / discard / cancel), and leaving the page asks. The apply is held
	// open by routing the memo's ui-settings PUT, so input typed while it is in
	// flight must keep the pane open and dirty after v1 is saved.
	test('13l. dashboard memo: unapplied input survives dock / undock / tabs; close settles it; leaving asks', async () => {
		test.setTimeout(90_000);
		const dialogs = trackDialogs(page);
		const mainNav = page.getByRole('navigation', { name: '主要ナビゲーション' });
		const memoWindow = page.getByRole('dialog', { name: 'メモ' });
		const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
		const workspace = page.locator('.workspace');
		const unsaved = workspace.getByText('未保存の変更があります');
		const settleDialog = page.getByRole('dialog', { name: '保存していないメモ' });

		/** Press at `from`, cross the dock's drag threshold, release at `to`. */
		async function drag(
			from: { x: number; y: number },
			to: { x: number; y: number }
		): Promise<void> {
			await page.mouse.move(from.x, from.y);
			await page.mouse.down();
			await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
			await page.mouse.move(to.x, to.y, { steps: 12 });
			await page.mouse.up();
		}
		async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
			const box = await locator.boundingBox();
			if (!box) throw new Error('not visible');
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		}

		const memoPath = '/api/ui-settings/dashboard.memo';
		let releasePut: () => void = () => {};
		const putHeld = new Promise<void>((resolve) => (releasePut = resolve));
		const putBodies: string[] = [];
		const holdPut = async (route: Route) => {
			if (route.request().method() !== 'PUT') return route.continue();
			putBodies.push(route.request().postData() ?? '');
			await putHeld;
			await route.continue();
		};

		try {
			await page.goto('/dashboard');
			await resetDashboardLayout(page);
			await page.locator('.dock-wrapper').scrollIntoViewIfNeeded();
			await expect(memoWindow).toBeVisible();
			await expect(unsaved).toHaveCount(0);

			await memoInput.fill('unsaved');
			await expect(unsaved).toBeVisible();

			// dock: the floating title bar onto the centre button of the 月別更新件数 pane's cross
			// guide (#694 PR-2: drawn at the centre of the pane).
			const titlebar = memoWindow.locator('.titlebar');
			const barBox = await titlebar.boundingBox();
			if (!barBox) throw new Error('no title bar');
			await drag(
				{ x: barBox.x + 30, y: barBox.y + barBox.height / 2 },
				await centerOf(page.locator('[data-dock-drop-id="monthly"]'))
			);
			await expect(memoWindow).toHaveCount(0);
			const memoTab = page.getByRole('tab', { name: 'メモ' });
			await expect(memoTab).toBeVisible();
			await expect(memoInput).toHaveValue('unsaved');
			await expect(unsaved).toBeVisible();

			// tab switch away and back (the pane is re-created both times).
			await page.getByRole('tab', { name: '月別更新件数' }).click();
			await expect(memoInput).toHaveCount(0);
			await memoTab.click();
			await expect(memoInput).toHaveValue('unsaved');

			// undock: the tab onto another floating window (= free floating space,
			// the docked tree fills the host). The window opens at the top left, over
			// the tab strip, so it is first moved down with the keyboard move mode
			// (geometry only - a pointer drag over a docked pane could land on its cross guide).
			await toggleDashboardPanel(page, 'トレンド');
			const trendWindow = page.getByRole('dialog', { name: 'トレンド' });
			await expect(trendWindow).toBeVisible();
			// The mode buttons are visually hidden until focused (#433-b).
			await trendWindow.getByRole('button', { name: /^トレンドをキーボードで移動/ }).focus();
			await page.keyboard.press('Enter');
			await page.keyboard.press('Shift+ArrowDown', { delay: 20 });
			await page.keyboard.press('Shift+ArrowDown', { delay: 20 });
			await page.keyboard.press('Shift+ArrowDown', { delay: 20 });
			await page.keyboard.press('Enter');
			await memoTab.click({ trial: true }); // the tab is not covered any more
			await drag(
				await centerOf(memoTab),
				await centerOf(trendWindow.getByRole('region', { name: 'トレンド', exact: true }))
			);
			await expect(memoWindow).toBeVisible();
			await expect(memoTab).toHaveCount(0);
			await expect(memoInput).toHaveValue('unsaved');
			await expect(unsaved).toBeVisible();
			// A pane with nothing unapplied closes without a question (the View
			// menu's checkbox goes through the same lifecycle as ✕).
			await toggleDashboardPanel(page, 'トレンド');
			await expect(trendWindow).toHaveCount(0);
			await expect(settleDialog).toHaveCount(0);

			// close -> apply, typing while the save is in flight: v1 is saved, the
			// pane stays open with the later input still unapplied.
			await page.route(`**${memoPath}`, holdPut);
			await memoWindow.getByRole('button', { name: 'メモを閉じる' }).click();
			await expect(settleDialog).toBeVisible();
			await settleDialog.getByRole('button', { name: '保存して閉じる' }).click();
			await expect(settleDialog).toHaveCount(0);
			await expect.poll(() => putBodies.length).toBe(1);
			await memoInput.fill('unsaved v2');
			const saved = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === memoPath && response.request().method() === 'PUT'
			);
			releasePut();
			expect((await saved).ok()).toBe(true);
			expect((JSON.parse(putBodies[0]!) as { value: string }).value).toBe('unsaved');
			await expect(
				workspace.getByText('保存中に入力した内容は、まだ保存されていません。')
			).toBeVisible();
			await expect(memoWindow).toBeVisible();
			await expect(memoInput).toHaveValue('unsaved v2');
			await expect(unsaved).toBeVisible();
			await page.unroute(`**${memoPath}`, holdPut);

			// close -> discard: closes, and the reopened memo shows what was saved.
			await memoWindow.getByRole('button', { name: 'メモを閉じる' }).click();
			await settleDialog.getByRole('button', { name: '破棄して閉じる' }).click();
			await expect(memoWindow).toHaveCount(0);
			const viewMenu = await dashboardViewMenu(page).open();
			const memoCheckbox = viewMenu.getByRole('menuitemcheckbox', { name: 'メモ', exact: true });
			await expect(memoCheckbox).toHaveAttribute('aria-checked', 'false');
			await memoCheckbox.click();
			await expect(memoCheckbox).toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('Escape');
			await expect(memoWindow).toBeVisible();
			await expect(memoInput).toHaveValue('unsaved');
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);

			// Hiding the dirty memo from the View menu asks too. The checkbox keeps
			// its menu open, so asking closes it first: the question is the only
			// layer (no menu over the scrim) and holds focus; Esc cancels it and
			// focus goes back to the menu's button.
			await memoInput.fill('menu check');
			const memoItem = (await dashboardViewMenu(page).open()).getByRole('menuitemcheckbox', {
				name: 'メモ',
				exact: true
			});
			await memoItem.click();
			await expect(settleDialog).toBeVisible();
			await expect(page.getByRole('menu', { name: '表示' })).toHaveCount(0);
			await expect(settleDialog.locator(':focus')).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(settleDialog).toHaveCount(0);
			await expect(
				page.getByRole('main').getByRole('button', { name: '表示', exact: true })
			).toBeFocused();
			await expect(memoWindow).toBeVisible();
			await expect(memoInput).toHaveValue('menu check');

			// Leaving with unapplied input asks (the router guard): stay, then leave.
			await memoInput.fill('leave check');
			dialogs.answer(false);
			await mainNav.getByRole('link', { name: '商品' }).click();
			await expect.poll(() => dialogs.messages).toEqual([LEAVE_PROMPT]);
			await expect(page).toHaveURL(/\/dashboard$/);
			await expect(memoInput).toHaveValue('leave check');
			dialogs.answer(true);
			await mainNav.getByRole('link', { name: '商品' }).click();
			await expect(page).toHaveURL(/\/items$/);
			expect(dialogs.messages).toHaveLength(2);
		} finally {
			dialogs.stop();
			await page.unroute(`**${memoPath}`, holdPut);
			releasePut();
		}
	});

	// #694 PR-3: the pin on a docked pane's header auto-hides it to the band on
	// its side; the band tab slides it out over the docked tree, Esc slides it
	// back (the focus returns to the tab), and its pin puts it back in its place.
	test('13l2. dashboard dock: unpin to the edge band, slide out, Esc, pin back', async () => {
		await page.goto('/dashboard');
		await resetDashboardLayout(page);
		const wrapper = page.locator('.dock-wrapper');
		await wrapper.scrollIntoViewIfNeeded();
		const pane = wrapper.locator('[data-dock-drop-id="priceBuckets"]');
		await expect(pane).toBeVisible();

		await wrapper.getByRole('button', { name: '価格帯分布を自動で隠す（ピンを外す）' }).click();
		await expect(pane).toHaveCount(0);
		const band = wrapper.getByRole('group', { name: '右に自動で隠したパネル' });
		const tab = band.getByRole('button', { name: '価格帯分布' });
		await expect(tab).toBeVisible();
		await expect(tab).toBeFocused();

		await tab.click();
		const flyout = wrapper.locator('[data-dock-flyout="priceBuckets"]');
		await expect(flyout).toBeVisible();
		await expect(tab).toHaveAttribute('aria-expanded', 'true');

		await page.keyboard.press('Escape');
		await expect(flyout).toHaveCount(0);
		await expect(tab).toBeFocused();

		await tab.click();
		await expect(flyout).toBeVisible();
		await flyout
			.getByRole('button', { name: '価格帯分布を元の場所に固定（ピンを留める）' })
			.click();
		await expect(pane).toBeVisible();
		await expect(band).toHaveCount(0);

		await resetDashboardLayout(page);
	});

	// Issue #435 PR-11: Ctrl+S in the memo is the pane's save button as a
	// command of the app's shortcut dispatcher - taken inside the textarea, the
	// same serialized save. With nothing to save (or a held key) it is still
	// kept from the browser's "save page"; an IME composition is left alone.
	// Ctrl+K is taken in the textarea too, but not while another modal (the
	// memo's close prompt) is on screen.
	test('13m. dashboard memo: Ctrl+S saves from the textarea; Ctrl+K does not open over the close prompt', async () => {
		const memoWindow = page.getByRole('dialog', { name: 'メモ' });
		const memoInput = page.getByRole('textbox', { name: 'メモの本文' });
		const workspace = page.locator('.workspace');
		const unsaved = workspace.getByText('未保存の変更があります');
		const settleDialog = page.getByRole('dialog', { name: '保存していないメモ' });
		const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
		const memoPath = '/api/ui-settings/dashboard.memo';
		const putBodies: string[] = [];
		const recordPut = async (route: Route) => {
			if (route.request().method() === 'PUT') putBodies.push(route.request().postData() ?? '');
			await route.continue();
		};

		/** Dispatch a synthetic Ctrl+S keydown at the focused element; was it consumed? */
		const ctrlS = (init: { isComposing?: boolean; repeat?: boolean }) =>
			page.evaluate((extra) => {
				const event = new KeyboardEvent('keydown', {
					key: 's',
					code: 'KeyS',
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
					...extra
				});
				(document.activeElement ?? document.body).dispatchEvent(event);
				return event.defaultPrevented;
			}, init);

		try {
			await page.route(`**${memoPath}`, recordPut);
			await page.goto('/dashboard');
			await resetDashboardLayout(page);
			await page.locator('.dock-wrapper').scrollIntoViewIfNeeded();
			await expect(memoWindow).toBeVisible();
			await memoInput.fill('saved with ctrl+s');
			await expect(unsaved).toBeVisible();

			// Composing: not taken, nothing saved.
			await memoInput.focus();
			expect(await ctrlS({ isComposing: true })).toBe(false);
			await expect(unsaved).toBeVisible();
			expect(putBodies).toHaveLength(0);

			// Ctrl+S in the textarea saves; the unsaved notice goes away.
			const saved = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === memoPath && response.request().method() === 'PUT'
			);
			await memoInput.press('Control+S');
			expect((await saved).ok()).toBe(true);
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);
			expect((JSON.parse(putBodies[0]!) as { value: string }).value).toBe('saved with ctrl+s');

			// Nothing to save, and a held key: consumed, nothing sent.
			expect(await ctrlS({})).toBe(true);
			expect(await ctrlS({ repeat: true })).toBe(true);
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);

			// Ctrl+K from the textarea opens and closes the palette.
			await memoInput.focus();
			await page.keyboard.press('Control+K');
			await expect(palette).toBeVisible();
			await page.keyboard.press('Control+K');
			await expect(palette).toHaveCount(0);

			// Another modal on screen (the close prompt): Ctrl+K does not open the palette.
			await memoInput.fill('typed again');
			await memoWindow.getByRole('button', { name: 'メモを閉じる' }).click();
			await expect(settleDialog).toBeVisible();
			await page.keyboard.press('Control+K');
			await expect(palette).toHaveCount(0);
			await settleDialog.getByRole('button', { name: 'キャンセル' }).click();
			await expect(settleDialog).toHaveCount(0);

			// Leave clean for the next test (back to the stored text).
			await memoInput.fill('saved with ctrl+s');
			await expect(unsaved).toHaveCount(0);
			expect(putBodies).toHaveLength(1);
		} finally {
			await page.unroute(`**${memoPath}`, recordPut);
		}
	});

	// #694 PR-1/PR-2: a drop on the outer left button of the dock host wraps the whole
	// docked tree and the pane spans that side (full height, a quarter of the width).
	test('13m2. dock: a floating pane dropped on the outer left edge spans the full height', async () => {
		const memoWindow = page.getByRole('dialog', { name: 'メモ' });
		await page.goto('/dashboard');
		await resetDashboardLayout(page);
		await page.locator('.dock-wrapper').scrollIntoViewIfNeeded();
		await expect(memoWindow).toBeVisible();
		const host = page.locator('.dock-wrapper [data-dock-host]');
		const hostBox = await host.boundingBox();
		const barBox = await memoWindow.locator('.titlebar').boundingBox();
		if (!hostBox || !barBox) throw new Error('not visible');

		try {
			const from = { x: barBox.x + 30, y: barBox.y + barBox.height / 2 };
			// The left outer button: 8 px in from the side, 32 px, at mid height (`core/edges.ts`).
			const to = { x: hostBox.x + 24, y: hostBox.y + hostBox.height / 2 };
			await page.mouse.move(from.x, from.y);
			await page.mouse.down();
			await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
			await page.mouse.move(to.x, to.y, { steps: 12 });
			// Only during the drag: the four outer buttons, the left one active.
			await expect(host.locator('.guide-button.outer')).toHaveCount(4);
			await expect(host.locator('.guide-button.outer.active')).toHaveAttribute(
				'data-dock-edge',
				'left'
			);
			await page.mouse.up();
			await expect(host.locator('.guide-button')).toHaveCount(0);

			await expect(memoWindow).toHaveCount(0);
			const memoPane = host.locator('[data-dock-drop-id="memo"]');
			await expect(memoPane).toBeVisible();
			const paneBox = await memoPane.boundingBox();
			if (!paneBox) throw new Error('memo pane not visible');
			expect(Math.abs(paneBox.x - hostBox.x)).toBeLessThan(8);
			expect(paneBox.height).toBeGreaterThan(hostBox.height - 16);
			// A quarter of the host (`EDGE_DOCK_RATIO`), not half.
			expect(paneBox.width).toBeLessThan(hostBox.width * 0.3);
		} finally {
			await resetDashboardLayout(page);
		}
	});

	// #663 ④: the same moves with the keyboard only - the "panel actions" menu on the title bar
	// (a WAI-ARIA menu button): dock at the outer left edge, float, and dock back where it was.
	// Each result is read out by the host's polite live region.
	test('13m3. dock: keyboard only - panel actions menu docks at the left edge, floats, docks back', async () => {
		const memoWindow = page.getByRole('dialog', { name: 'メモ' });
		await page.goto('/dashboard');
		await resetDashboardLayout(page);
		await page.locator('.dock-wrapper').scrollIntoViewIfNeeded();
		await expect(memoWindow).toBeVisible();
		const host = page.locator('.dock-wrapper [data-dock-host]');
		const live = host.locator('[aria-live="polite"]');
		const menuButton = host.getByRole('button', { name: 'メモのパネルの操作', exact: true });
		const menu = page.getByRole('menu', { name: 'メモのパネルの操作', exact: true });
		/** Focus the button, Enter: the menu opens with the focus on its first item. */
		async function openMenu(): Promise<void> {
			await expect(async () => {
				if (!(await menu.isVisible())) {
					await menuButton.focus();
					await page.keyboard.press('Enter');
				}
				await expect(menu).toBeVisible({ timeout: 1000 });
			}).toPass();
			await expect(menu.getByRole('menuitem').first()).toBeFocused();
		}

		try {
			// 1. Outer left edge (the first item).
			await openMenu();
			await expect(
				menu.getByRole('menuitem', { name: '左端にドッキング', exact: true })
			).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(menu).toHaveCount(0);
			await expect(memoWindow).toHaveCount(0);
			const memoPane = host.locator('[data-dock-drop-id="memo"]');
			await expect(memoPane).toBeVisible();
			const hostBox = await host.boundingBox();
			const paneBox = await memoPane.boundingBox();
			if (!hostBox || !paneBox) throw new Error('not visible');
			expect(Math.abs(paneBox.x - hostBox.x)).toBeLessThan(8);
			expect(paneBox.width).toBeLessThan(hostBox.width * 0.3);
			await expect(live).toHaveText('メモを左端にドッキングしました');
			// The focus is on the moved pane's title bar (its menu button).
			await expect(menuButton).toBeFocused();

			// 2. Float it (the last item of a docked pane's menu).
			await openMenu();
			await page.keyboard.press('End');
			await expect(menu.getByRole('menuitem', { name: '浮かせる', exact: true })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(memoWindow).toBeVisible();
			await expect(live).toHaveText('メモを浮かせました');

			// 3. Back where it was floated from (the left edge), via Esc once to check it closes.
			await openMenu();
			await page.keyboard.press('Escape');
			await expect(menu).toHaveCount(0);
			await expect(menuButton).toBeFocused();
			await openMenu();
			await page.keyboard.press('End');
			await expect(
				menu.getByRole('menuitem', { name: '元の場所に戻す', exact: true })
			).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(memoWindow).toHaveCount(0);
			await expect(memoPane).toBeVisible();
			const backBox = await memoPane.boundingBox();
			if (!backBox) throw new Error('memo pane not visible');
			expect(Math.abs(backBox.x - hostBox.x)).toBeLessThan(8);
			await expect(live).toHaveText('メモを元の場所に戻しました');
		} finally {
			await resetDashboardLayout(page);
		}
	});

	// PR-B3 (i18n layer ②, ADR-0005): the settings
	// language picker actually switches the whole UI locale. Deliberately LAST:
	// Paraglide's setLocale() persists the choice to this shared page's
	// localStorage and reloads every screen, so switching to English here can't
	// disturb the Japanese-asserting scenarios above (which run first).
	test('14. settings: the language picker switches the whole UI to English', async () => {
		await page.goto('/settings');

		// The <select> is still labelled in Japanese (表示言語) at this point. Its
		// option labels (日本語 / English) are intentionally NOT translated, so
		// switch by value. selectOption fires the change handler -> setLocale('en')
		// -> a full reload into English (Paraglide's default).
		const languageSelect = page.getByLabel('表示言語');
		await expect(languageSelect).toBeVisible();
		await languageSelect.selectOption('en');

		// After the reload the page renders in English: the page header
		// (nav.settings) and the language card heading (settings.languageHeading)
		// both flip. Asserting a keyed string proves the switch reached the UI,
		// not just localStorage.
		await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Language', exact: true })).toBeVisible();
	});
});
