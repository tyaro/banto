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
 * Flakiness: no explicit `waitForTimeout`/`sleep` anywhere in this file -
 * every wait is either Playwright's built-in locator auto-retry
 * (`expect(locator)...`) or a real event (`page.waitForEvent('download')`,
 * `page.once('dialog', ...)`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';

// #209: this ordinary account must not be confused with a synthetic session.
const ADMIN_USERNAME = 'public';
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

// M20 attachments scenario (docs/attachments-plan.md §4 unit D): a
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

function minimalPngBuffer(): Buffer {
	return Buffer.from(MIN_PNG_BASE64, 'base64');
}

/** Open a filterable column's header filter and apply a "contains" filter (the default op) with `value`. Mirrors a user clicking the ▾ icon, typing, and clicking 適用 (FilterPopover.svelte). */
async function applyColumnFilter(page: Page, columnHeader: string, value: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label }).click();
	const dialog = page.getByRole('dialog', { name: label });
	await dialog.getByPlaceholder('値を入力').fill(value);
	await dialog.getByRole('button', { name: '適用' }).click();
}

/** Reopen a column's filter and clear it (クリア), leaving the grid unfiltered on that column. */
async function clearColumnFilter(page: Page, columnHeader: string): Promise<void> {
	const label = `${columnHeader}の絞り込み`;
	await page.getByRole('button', { name: label }).click();
	await page.getByRole('dialog', { name: label }).getByRole('button', { name: 'クリア' }).click();
}

/** A grid data row (role="row") whose rendered text contains `text` - matches both the header row and data rows structurally, so callers should pass text unique to a data row. */
function rowWithText(page: Page, text: string): Locator {
	return page.getByRole('row').filter({ hasText: text });
}

/** Opens the header's user menu and clicks "ログアウト" (Header.svelte moved logout off a bare header button into the shared Menu component - visual-refresh-design.md §8.2). */
async function logout(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'ユーザーメニューを開く' }).click();
	await page.getByRole('menuitem', { name: 'ログアウト' }).click();
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
		await page.goto('/login');

		// Fresh DB -> AuthProvider.status() reports uninitialized -> the login
		// page renders the setup form, not the login form (login/+page.svelte).
		await expect(page.getByRole('heading', { name: 'Banto' })).toBeVisible();
		await expect(page.getByLabel('表示名')).toBeVisible();

		await page.getByLabel('表示名').fill(ADMIN_DISPLAY_NAME);
		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード（8文字以上）').fill(ADMIN_PASSWORD);
		await page.getByLabel('パスワード（確認）').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'アカウントを作成' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		// With public viewing disabled, reload restores the ordinary account
		// from the identity endpoint even though its username is "public".
		const restoredIdentity = page.waitForResponse(
			(response) => new URL(response.url()).pathname === '/api/auth/identity'
		);
		await page.reload();
		const identity = await restoredIdentity;
		expect(identity.ok()).toBe(true);
		expect(await identity.json()).toMatchObject({
			id: 'public',
			role: 'admin',
			publicViewer: false
		});
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
	});

	test('2. logout returns to the login screen, then login restores the session', async () => {
		await logout(page);
		await expect(page).toHaveURL(/\/login$/);

		await page.getByLabel('ユーザー名').fill(ADMIN_USERNAME);
		await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'ログイン' }).click();

		await expect(page).toHaveURL(/\/dashboard$/);
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

		const openLink = row.getByRole('link', { name: '開く' });
		const href = await openLink.getAttribute('href');
		expect(href).toMatch(/^\/items\/\d+$/);
		const itemUrl = new RegExp(`${href}$`);

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
			}, href!);
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
		await row.locator('[data-cell-field="name"]').click();
		await expect(grid).toBeFocused();
		await page.keyboard.press('Home');
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'open');
		await page.keyboard.press('Shift+Tab');
		await expect(createButton).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(grid).toBeFocused();
		await page.keyboard.press('End');
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'updatedAt');

		// Keep header sort/filter controls and the row link reachable. Tab
		// events bubbling from those controls must not move the selected cell
		// or trap focus either; the non-sortable actions header is not a tab stop.
		const headerControls = await grid
			.getByRole('row')
			.first()
			.locator('[tabindex="0"], button')
			.all();
		expect(headerControls.length).toBeGreaterThan(0);
		for (const control of [...headerControls, openLink]) {
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
		}
		await page.keyboard.press('Tab');
		await expect(grid.locator(':focus')).toHaveCount(0);
		for (const control of [openLink, ...[...headerControls].reverse(), grid, createButton]) {
			await page.keyboard.press('Shift+Tab');
			await expect(control).toBeFocused();
		}
		await expect(grid.locator('.cell.active')).toHaveAttribute('data-cell-field', 'updatedAt');

		// Activate controls reached by Tab while an editable cell remains
		// selected: Enter must act on the focused control, not start editing.
		await row.locator('[data-cell-field="name"]').click();
		await page.keyboard.press('Tab');
		await expect(grid.getByRole('button', { name: 'ID', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(grid.getByRole('columnheader').nth(1)).toHaveAttribute('aria-sort', 'ascending');
		await expect(grid.locator('.cell-editor')).toHaveCount(0);
		await expect(row).toBeVisible();
		await row.locator('[data-cell-field="name"]').click();
		for (const control of headerControls.slice(0, 4)) {
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
		}
		await expect(grid.getByRole('button', { name: '商品名の絞り込み' })).toBeFocused();
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
		for (const control of [...headerControls, openLink]) {
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
		}

		// Edit: change price, save, and independently re-open the record (by
		// URL, not via the grid/filter again) to confirm the new value
		// actually persisted server-side.
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(itemUrl);
		await expect(page.getByLabel('価格')).toHaveValue(String(ITEM_PRICE));
		await page.getByLabel('価格').fill(String(ITEM_PRICE_UPDATED));
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await page.goto(href!);
		await expect(page.getByLabel('価格')).toHaveValue(String(ITEM_PRICE_UPDATED));

		// Delete (window.confirm - accept it before triggering the click).
		page.once('dialog', (dialog) => dialog.accept());
		await page.getByRole('button', { name: '削除' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await page.goto(href!);
		await expect(page.getByText('商品が見つかりません')).toBeVisible();
	});

	test('4. CSV export downloads a UTF-8-BOM CSV file', async () => {
		await page.goto('/items');

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'CSVエクスポート' }).click();
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

	test('5. user management: create a viewer account and preserve selection across replies', async () => {
		test.setTimeout(60_000);
		await page.goto('/users');

		// Scoped to the create form (not just page.getByLabel(...)): the
		// grid's ユーザー名/表示名 column filter buttons below (aria-label
		// "<列名>の絞り込み") also match those label texts by substring,
		// which makes an unscoped getByLabel ambiguous once the grid is on
		// the same page (users/+page.svelte's "section.create").
		const createForm = page.locator('section.create');
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
				expect(request.postDataJSON()).toEqual({ displayName: draft, role: targetRole });
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
			await page.route(`**/api/users/${id}`, (route) => {
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
			});
			try {
				page.once('dialog', (dialog) => dialog.accept());
				await panel.getByRole('button', { name: '削除', exact: true }).click();
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

	test('6. viewer role: no admin nav entries, no items create button', async () => {
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

		// M20 attachments (spec §3.1: "閲覧 = viewer 以上、追加/削除 = editor
		// 以上"): open any seeded demo item (the grid always has 1,000 rows,
		// so this doesn't depend on scenario 3's item, which is deleted by
		// now) and confirm the panel renders read-only - no upload affordance.
		await page.getByRole('link', { name: '開く' }).first().click();
		await expect(page.getByRole('heading', { name: '添付ファイル' })).toBeVisible();
		await expect(page.getByLabel('添付ファイルをアップロード')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'アップロード' })).toHaveCount(0);
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

	test('8. items detail: attachments upload, thumbnail, file row, and delete', async () => {
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
		const href = await row.getByRole('link', { name: '開く' }).getAttribute('href');
		expect(href).toMatch(/^\/items\/\d+$/);

		await page.goto(href!);
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

		// 3. Delete the text file first (confirm() - accept before the click,
		// same discipline as scenario 3's item delete). Partial state: the
		// file-row list empties out but the PNG thumbnail is still there.
		page.once('dialog', (dialog) => dialog.accept());
		await fileRow.getByRole('button', { name: '削除' }).click();
		await expect(fileRow).toHaveCount(0);
		await expect(page.getByRole('img', { name: PNG_FILE_NAME, exact: true })).toBeVisible();

		// 4. Delete the PNG too - the panel returns to its empty-state copy.
		const thumbTile = page.locator('.thumb-tile').filter({ hasText: PNG_FILE_NAME });
		page.once('dialog', (dialog) => dialog.accept());
		await thumbTile.getByRole('button', { name: '削除' }).click();
		await expect(page.getByText('添付ファイルはありません')).toBeVisible();

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
		page.once('dialog', (dialog) => dialog.accept());
		await page.locator('.form-panel').getByRole('button', { name: '削除' }).click();
		await expect(page).toHaveURL(/\/items$/);

		await page.goto(href!);
		await expect(page.getByText('商品が見つかりません')).toBeVisible();
	});

	test('9. command palette: search and navigate to the audit log', async () => {
		await page.goto('/items');
		// The Ctrl+K listener lives on (app)/+layout.svelte's `<svelte:window>`,
		// which only mounts after the route guard's async work (bantoReady,
		// sessionStore.load()) resolves - later than page.goto()'s "load"
		// event. Wait for a page-specific element first so the keypress below
		// isn't racing that mount.
		await expect(page.getByRole('button', { name: 'CSVエクスポート' })).toBeVisible();

		await page.keyboard.press('Control+K');
		const search = page.getByPlaceholder('コマンドを検索…');
		await expect(search).toBeVisible();
		await search.fill('監査');
		await search.press('Enter');

		await expect(page).toHaveURL(/\/audit-log$/);
	});

	test('10. settings: switching to the dark theme sets data-theme', async () => {
		await page.goto('/settings');

		// Not .getByLabel(...).check(): the radio inputs here are visually
		// hidden (`.options input { opacity: 0; pointer-events: none }`,
		// settings/+page.svelte) so their own `<label>` is the real click
		// target - clicking it activates the wrapped input via normal
		// label/control association.
		await page
			.getByRole('radiogroup', { name: 'テーマ' })
			.getByText('ダーク', { exact: true })
			.click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
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

	// M19 report demo (docs/report-plan.md §3.6, docs/template-scope.md §3):
	// items -> 日報 -> the report renders. Deliberately does NOT trigger
	// window.print() (spec §3.6) - only confirms the template rendered real
	// data, not the print dialog itself. Placed last: by this point
	// scenarios 3 and 8 have each created then deleted exactly one item
	// (net zero), so the grid is back to its 1,000-row seed baseline and
	// the report's total-count string is deterministic.
	test('12. items: 日報 report renders a heading, totals, and a category table', async () => {
		await page.goto('/items');
		await page.getByRole('button', { name: '日報' }).click();
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
	// ($lib/navBadges.svelte.ts), and visiting the page clears it. The
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
