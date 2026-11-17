/**
 * The three-pane screen pattern at `/tree/workspace` (Issue #631 PR③): the
 * target and tab in the URL, the unsaved-settings confirm (and that a refusal
 * puts the tree's highlight, the tab and the focus back), the tree's context
 * menu opening exactly once from the mouse and the keyboard, and the narrow
 * layout (the tree as a drawer that leaves the target's name in the band).
 * Same `visual` project as menubar.spec.ts (vite preview, browser demo mode as
 * admin, reduced motion). No pixels: the screenshots are in visual.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

const PATH = '/tree/workspace';

function tree(page: Page) {
	return page.getByRole('tree');
}

/** A tree row by its exact name (the badge text is not part of the name: `label` keeps `aria-label`). */
function row(page: Page, name: string) {
	return tree(page).getByRole('treeitem', { name, exact: true });
}

function tab(page: Page, name: string) {
	return page.getByRole('tab', { name, exact: true });
}

async function open(page: Page, search = ''): Promise<void> {
	await page.goto(`${PATH}${search}`);
	await expect(tree(page)).toBeVisible();
}

/** `window.location` (not `page.url()` of the SvelteKit router) is the truth for the address bar. */
async function search(page: Page): Promise<string> {
	return page.evaluate(() => window.location.search);
}

async function activeIs(page: Page, selector: string): Promise<boolean> {
	return page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
}

/** The settings tab of the press: opened by URL, with the name field edited. */
async function editPressSettings(page: Page): Promise<void> {
	await open(page, '?target=line-a-press&tab=settings');
	const name = page.getByRole('textbox', { name: '表示名', exact: true });
	await name.fill('プレス機（改）');
	await expect(page.getByText('未保存の変更があります', { exact: true })).toBeVisible();
}

test.describe('three-pane workspace', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	test('picking a target puts it in the URL, and a reload restores it with its tab', async ({
		page
	}) => {
		await open(page);
		await expect(page.getByText('対象を選んでください', { exact: true })).toBeVisible();

		await row(page, 'プレス機').click();
		await expect(row(page, 'プレス機')).toHaveAttribute('aria-selected', 'true');
		await expect.poll(() => search(page)).toBe('?target=line-a-press');

		await tab(page, '設定').click();
		await expect(tab(page, '設定')).toHaveAttribute('aria-selected', 'true');
		await expect.poll(() => search(page)).toBe('?target=line-a-press&tab=settings');

		await page.reload();
		await expect(tab(page, '設定')).toHaveAttribute('aria-selected', 'true');
		await expect(row(page, 'プレス機')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('heading', { name: 'プレス機 の設定', exact: true })).toBeVisible();
	});

	test('a row goes in the URL, fills the right pane, and Back/Forward follow targets (tabs replace)', async ({
		page
	}) => {
		await open(page);
		await row(page, '溶接機').click();
		await page.getByRole('button', { name: '09:10', exact: true }).click();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld&row=line-a-weld-1');
		await expect(page.getByText('182 A', { exact: true }).last()).toBeVisible();

		await row(page, 'CNC 旋盤').click();
		await expect.poll(() => search(page)).toBe('?target=line-b-cnc');
		await tab(page, '設定').click();
		await expect.poll(() => search(page)).toBe('?target=line-b-cnc&tab=settings');

		// the tab replaced its entry: one Back lands on the previous target, not on the list tab
		await page.goBack();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld&row=line-a-weld-1');
		await expect(row(page, '溶接機')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByText('182 A', { exact: true }).last()).toBeVisible();
		await page.goForward();
		await expect.poll(() => search(page)).toBe('?target=line-b-cnc&tab=settings');
	});

	test('bad values in the URL fall back to the defaults', async ({ page }) => {
		await open(page, '?target=nope&tab=settings&row=x');
		await expect(page.getByText('対象を選んでください', { exact: true })).toBeVisible();
		await open(page, '?target=line-a-press&tab=bogus&row=line-b-cnc-1');
		await expect(tab(page, '一覧')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByText('行を選んでいません', { exact: true })).toBeVisible();
	});

	test('unsaved settings: another target asks; cancel keeps the target, the tab and the focus', async ({
		page
	}) => {
		await editPressSettings(page);
		await row(page, '溶接機').click();

		const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります', exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '編集に戻る', exact: true }).click();
		await expect(dialog).toBeHidden();

		// the screen is exactly as before: URL, highlight, tab, draft, and the focus on the shown row
		await expect.poll(() => search(page)).toBe('?target=line-a-press&tab=settings');
		await expect(row(page, 'プレス機')).toHaveAttribute('aria-selected', 'true');
		await expect(row(page, '溶接機')).toHaveAttribute('aria-selected', 'false');
		await expect(tab(page, '設定')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue(
			'プレス機（改）'
		);
		await expect.poll(() => activeIs(page, '[role="treeitem"][aria-selected="true"]')).toBe(true);
	});

	test('unsaved settings: discarding moves to the other target and drops the draft', async ({
		page
	}) => {
		await editPressSettings(page);
		await row(page, '溶接機').click();
		const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります', exact: true });
		await dialog.getByRole('button', { name: '破棄して移動', exact: true }).click();

		await expect.poll(() => search(page)).toBe('?target=line-a-weld&tab=settings');
		await expect(row(page, '溶接機')).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue('溶接機');
		// and the old target's edit is gone for good
		await row(page, 'プレス機').click();
		await expect(page.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue(
			'プレス機'
		);
		await expect(page.getByRole('alertdialog')).toBeHidden();
	});

	test('unsaved settings: Back asks; discard walks the history (no new entry), cancel stays with the draft', async ({
		page
	}) => {
		await open(page);
		await row(page, '溶接機').click();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld');
		await row(page, 'プレス機').click();
		await expect.poll(() => search(page)).toBe('?target=line-a-press');
		await tab(page, '設定').click();
		const name = page.getByRole('textbox', { name: '表示名', exact: true });
		await name.fill('プレス機（改）');
		const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります', exact: true });

		// cancel: stay on the second target with the draft
		await page.goBack();
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '編集に戻る', exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect.poll(() => search(page)).toBe('?target=line-a-press&tab=settings');
		await expect(name).toHaveValue('プレス機（改）');

		// discard: land on the first target, and Forward still reaches the second one
		await page.goBack();
		await dialog.getByRole('button', { name: '破棄して移動', exact: true }).click();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld');
		await expect(dialog).toBeHidden();
		await page.goForward();
		await expect.poll(() => search(page)).toContain('target=line-a-press');
		await expect(dialog).toBeHidden();
	});

	test('unsaved settings: switching the tab asks; cancel keeps the settings tab focused', async ({
		page
	}) => {
		await editPressSettings(page);
		await tab(page, '一覧').click();
		const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります', exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '編集に戻る', exact: true }).click();
		await expect(tab(page, '設定')).toHaveAttribute('aria-selected', 'true');
		await expect.poll(() => search(page)).toBe('?target=line-a-press&tab=settings');
		await expect.poll(() => activeIs(page, '[role="tab"][aria-selected="true"]')).toBe(true);

		await tab(page, '一覧').click();
		await dialog.getByRole('button', { name: '破棄して移動', exact: true }).click();
		await expect(tab(page, '一覧')).toHaveAttribute('aria-selected', 'true');
		await expect.poll(() => search(page)).toBe('?target=line-a-press');
	});

	test('unsaved settings: leaving the page asks; cancel stays, discard leaves', async ({
		page
	}) => {
		await editPressSettings(page);
		await page
			.getByRole('navigation', { name: '主要ナビゲーション' })
			.getByRole('link', { name: 'ダッシュボード', exact: true })
			.click();
		const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります', exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '編集に戻る', exact: true }).click();
		await expect(page).toHaveURL(/\/tree\/workspace\?target=line-a-press&tab=settings$/);

		await page
			.getByRole('navigation', { name: '主要ナビゲーション' })
			.getByRole('link', { name: 'ダッシュボード', exact: true })
			.click();
		await dialog.getByRole('button', { name: '破棄して移動', exact: true }).click();
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test('unsaved settings: Back while the dialog is open does not leave two dialogs; a saved edit asks nothing', async ({
		page
	}) => {
		await open(page);
		await row(page, 'プレス機').click();
		await tab(page, '設定').click();
		await page.getByRole('textbox', { name: '表示名', exact: true }).fill('プレス機（改）');
		await page.getByRole('button', { name: '保存', exact: true }).click();
		await expect(page.getByText('保存しました', { exact: true })).toBeVisible();
		// saved = clean: another target needs no question
		await row(page, '溶接機').click();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld&tab=settings');
		await expect(page.getByRole('alertdialog')).toHaveCount(0);

		// dirty again, ask, then press Back with the dialog open: still at most one dialog, nothing lost
		await page.getByRole('textbox', { name: '表示名', exact: true }).fill('溶接機（改）');
		await row(page, 'プレス機（改）'.slice(0, 4)).click();
		await expect(page.getByRole('alertdialog')).toHaveCount(1);
		await page.goBack();
		await expect.poll(() => page.getByRole('alertdialog').count()).toBeLessThanOrEqual(1);
	});

	test('the tree row menu opens exactly once from the mouse, Shift+F10 and the ContextMenu key', async ({
		page
	}) => {
		await open(page);
		const menu = page.getByRole('menu', { name: 'プレス機 のメニュー', exact: true });

		await row(page, 'プレス機').click({ button: 'right' });
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();

		for (const key of ['Shift+F10', 'ContextMenu']) {
			await row(page, 'プレス機').focus();
			await page.keyboard.press(key);
			// a second, duplicate request would toggle the menu shut again: it must stay open
			await expect(async () => {
				await expect(menu).toBeVisible();
			}).toPass();
			await page.waitForTimeout(300);
			await expect(menu).toBeVisible();
			await page.getByRole('menuitem', { name: '名前を変更', exact: true }).click();
			await expect(menu).toBeHidden();
			await expect(
				page.getByText('「プレス機」の「名前を変更」を選びました', { exact: false })
			).toBeVisible();
			// the focus is back on the row, and the menu did not move the selection
			await expect.poll(() => activeIs(page, '[role="treeitem"]')).toBe(true);
			await expect(row(page, 'プレス機')).toHaveAttribute('aria-selected', 'false');
		}
	});

	test('a second right-click on another row reopens the menu for that row', async ({ page }) => {
		await open(page);
		// the lower row first: its menu opens below it, so the upper row stays reachable
		await row(page, '溶接機').click({ button: 'right' });
		await expect(page.getByRole('menu', { name: '溶接機 のメニュー', exact: true })).toBeVisible();
		await row(page, 'プレス機').click({ button: 'right' });
		await expect(
			page.getByRole('menu', { name: 'プレス機 のメニュー', exact: true })
		).toBeVisible();
		await expect(page.getByRole('menu', { name: '溶接機 のメニュー', exact: true })).toBeHidden();
	});

	test('at 800px the tree is a drawer, the target stays named in the band, and the confirm sits over an open drawer', async ({
		page
	}) => {
		await page.setViewportSize({ width: 800, height: 900 });
		await page.goto(`${PATH}?target=line-a-press&tab=settings`);
		await expect(tab(page, '設定')).toHaveAttribute('aria-selected', 'true');
		const toggle = page.getByRole('button', { name: '対象のツリー', exact: true });
		// the pane is a closed drawer: its tree is not reachable until opened
		await expect(tree(page)).toBeHidden();
		await expect(page.locator('.three-pane__title')).toHaveText('プレス機'); // the band names the target

		await page.getByRole('textbox', { name: '表示名', exact: true }).fill('プレス機（改）');
		await toggle.click();
		await expect(tree(page)).toBeVisible();
		await row(page, '溶接機').click();

		const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります', exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '編集に戻る', exact: true }).click();
		await expect(dialog).toBeHidden();
		// refused: the drawer is still open on the old target
		await expect(tree(page)).toBeVisible();
		await expect(row(page, 'プレス機')).toHaveAttribute('aria-selected', 'true');

		await row(page, '溶接機').click();
		await dialog.getByRole('button', { name: '破棄して移動', exact: true }).click();
		// taken: the drawer closes, and the band names the new target
		await expect(tree(page)).toBeHidden();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld&tab=settings');
		await expect(page.locator('.three-pane__title')).toHaveText('溶接機');
	});

	test('rapid picks settle on the last target and leave one URL entry per target', async ({
		page
	}) => {
		await open(page);
		await row(page, 'プレス機').click();
		await row(page, '溶接機').click();
		await row(page, '塗装炉').click();
		await expect.poll(() => search(page)).toBe('?target=line-a-paint');
		await expect(row(page, '塗装炉')).toHaveAttribute('aria-selected', 'true');
		await expect(tree(page).locator('[aria-selected="true"]')).toHaveCount(1);
	});
});
