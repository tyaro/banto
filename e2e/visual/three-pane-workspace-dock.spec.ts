/**
 * The three-pane screen on a dock at `/tree/workspace-dock` (Issue #663 stage ④ PR-6,
 * docs/design/three-pane-dock-plan.md §6): floating and re-docking the side panes from the toolbar
 * and the keyboard-operable panel menu, the centre staying the same DOM element through every
 * rearrangement (§4.2), the layout saved per user and reset from the View menu (§4.4), the narrow
 * display (§4.5), kiosk (`arrange={false}`), and the unsaved-settings confirm that panel operations
 * never trigger (§4.7). Same `visual` project as three-pane-workspace.spec.ts (vite preview,
 * browser demo mode as admin, reduced motion). No pixels: the screenshots are in visual.spec.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeKiosk, primeThemeAndAuth } from './theme';

const PATH = '/tree/workspace-dock';
/** The demo's own localStorage copy of the layout (`${storageKey}:${owner}`, demo mode's admin). */
const LAYOUT_KEY = 'banto.dock.threePane.workspace:account:admin';
/** The `UiSettingsProvider` copy in demo mode (`createLocalUiSettings`, prefix `banto.ui.`): written 500ms after the last change. */
const PROVIDER_KEY = 'banto.ui.dock.threePane.workspace';

const TREE = '対象のツリー';
const DETAIL = '選んだ行の詳細';

function host(page: Page) {
	return page.locator('[data-dock-host]');
}

function tree(page: Page) {
	return page.getByRole('tree');
}

function row(page: Page, name: string) {
	return tree(page).getByRole('treeitem', { name, exact: true });
}

/** A floating pane (a window): a dialog named by its title. */
function windowOf(page: Page, title: string) {
	return page.getByRole('dialog', { name: title, exact: true });
}

/** A docked pane's region. */
function pane(page: Page, id: 'left' | 'center' | 'right') {
	return host(page).locator(`[data-dock-drop-id="${id}"]`);
}

async function open(page: Page, search = ''): Promise<void> {
	await page.goto(`${PATH}${search}`);
	await expect(tree(page)).toBeVisible();
	await expect(pane(page, 'center')).toBeVisible();
}

async function search(page: Page): Promise<string> {
	return page.evaluate(() => window.location.search);
}

function toolbarButton(page: Page, name: string) {
	return page.getByRole('group', { name: 'パネルの表示と配置', exact: true }).getByRole('button', {
		name,
		exact: true
	});
}

/** Tag the centre's element so a later check can tell it from a re-created one. */
async function markCenter(page: Page): Promise<void> {
	await page.evaluate(() => {
		const el = document.querySelector('[data-testid="workspace-dock-center"]');
		if (!el) throw new Error('no centre');
		(el as unknown as { __mark: string }).__mark = 'same';
	});
}

/** The tagged element is still the one on screen, connected, and sits in the centre pane. */
async function centerIsSame(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const el = document.querySelector('[data-testid="workspace-dock-center"]');
		return (
			el !== null &&
			el.isConnected &&
			(el as unknown as { __mark?: string }).__mark === 'same' &&
			el.closest('[data-dock-drop-id="center"]') !== null
		);
	});
}

function viewMenuButton(page: Page) {
	return page.getByRole('button', { name: '表示', exact: true });
}

async function chooseView(page: Page, item: string): Promise<void> {
	await viewMenuButton(page).click();
	const entry = page
		.getByRole('menuitemcheckbox', { name: item, exact: true })
		.or(page.getByRole('menuitem', { name: item, exact: true }));
	await entry.click();
}

/** Open a pane's "panel actions" menu from the keyboard (Enter on its button). */
async function openPaneMenu(page: Page, title: string) {
	const button = host(page).getByRole('button', { name: `${title}のパネルの操作`, exact: true });
	const menu = page.getByRole('menu', { name: `${title}のパネルの操作`, exact: true });
	await expect(async () => {
		if (!(await menu.isVisible())) {
			await button.focus();
			await page.keyboard.press('Enter');
		}
		await expect(menu).toBeVisible({ timeout: 1000 });
	}).toPass();
	await expect(menu.getByRole('menuitem').first()).toBeFocused();
	return menu;
}

/** The layout saved in this browser's copy (the first-paint copy; the provider holds the same text in demo mode). */
async function savedLayout(page: Page): Promise<string | null> {
	return page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY);
}

/** The settings provider's copy (the one that counts; the debounced write has landed once this equals the local copy). */
async function providerLayout(page: Page): Promise<string | null> {
	return page.evaluate((key) => window.localStorage.getItem(key), PROVIDER_KEY);
}

test.describe('three-pane workspace on a dock', () => {
	test.beforeEach(async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await page.setViewportSize({ width: 1440, height: 900 });
	});

	test('the default layout is the tree, the centre tabs and the details, side by side', async ({
		page
	}) => {
		await open(page, '?target=line-a-press&row=line-a-press-3');
		const [l, c, r] = await Promise.all(
			(['left', 'center', 'right'] as const).map((id) => pane(page, id).boundingBox())
		);
		if (!l || !c || !r) throw new Error('a pane is not on screen');
		expect(l.x).toBeLessThan(c.x);
		expect(c.x).toBeLessThan(r.x);
		// the same default widths as the fixed ThreePaneLayout (280 / 360), within a border or two
		expect(Math.abs(l.width - 280)).toBeLessThan(12);
		expect(Math.abs(r.width - 360)).toBeLessThan(12);
		// no strip of toggles: the toolbar's buttons say what is shown through aria-pressed
		await expect(toolbarButton(page, TREE)).toHaveAttribute('aria-pressed', 'true');
		await expect(toolbarButton(page, DETAIL)).toHaveAttribute('aria-pressed', 'true');
		// the row picked in the URL fills the right pane
		await expect(pane(page, 'right').getByText('3.9 mm/s', { exact: true })).toBeVisible();
	});

	test('the toolbar floats the tree and docks it back; the View menu and the buttons share one state', async ({
		page
	}) => {
		await open(page, '?target=line-a-press');
		await markCenter(page);

		await toolbarButton(page, 'ツリーを切り離す').click();
		await expect(windowOf(page, TREE)).toBeVisible();
		await expect(pane(page, 'left')).toHaveCount(0);
		// still shown (a window): the pressed state and the View menu's check stay on
		await expect(toolbarButton(page, TREE)).toHaveAttribute('aria-pressed', 'true');
		await expect(row(page, 'プレス機')).toHaveAttribute('aria-selected', 'true');

		await toolbarButton(page, 'ツリーを元の場所に戻す').click();
		await expect(windowOf(page, TREE)).toHaveCount(0);
		await expect(pane(page, 'left')).toBeVisible();

		// the details: hidden from the toolbar, the View menu's check follows, shown again from the menu
		await toolbarButton(page, DETAIL).click();
		await expect(toolbarButton(page, DETAIL)).toHaveAttribute('aria-pressed', 'false');
		await expect(pane(page, 'right')).toHaveCount(0);
		await viewMenuButton(page).click();
		await expect(
			page.getByRole('menuitemcheckbox', { name: DETAIL, exact: true })
		).not.toBeChecked();
		await page.getByRole('menuitemcheckbox', { name: DETAIL, exact: true }).click();
		await expect(pane(page, 'right')).toBeVisible();
		await expect(toolbarButton(page, DETAIL)).toHaveAttribute('aria-pressed', 'true');

		expect(await centerIsSame(page)).toBe(true);
	});

	test('the centre is the same DOM element through float, dock, edge, auto-hide, tabs and reset', async ({
		page
	}) => {
		await open(page, '?target=line-a-press&tab=settings');
		const name = page.getByRole('textbox', { name: '表示名', exact: true });
		await name.fill('プレス機（改）');
		await name.focus();
		await markCenter(page);

		const same = async (step: string) => {
			expect(await centerIsSame(page), step).toBe(true);
			await expect(name, step).toHaveValue('プレス機（改）');
		};

		// float / dock back both sides
		await toolbarButton(page, 'ツリーを切り離す').click();
		await expect(windowOf(page, TREE)).toBeVisible();
		await same('float the tree');
		await toolbarButton(page, 'ツリーを元の場所に戻す').click();
		await expect(pane(page, 'left')).toBeVisible();
		await same('dock the tree back');

		// the details to the outer bottom edge (the panel menu), which wraps the whole tree around the centre
		let menu = await openPaneMenu(page, DETAIL);
		await menu.getByRole('menuitem', { name: '下端にドッキング', exact: true }).click();
		await expect(menu).toHaveCount(0);
		await same('dock the details at the bottom edge');

		// the details as a tab of the tree
		menu = await openPaneMenu(page, DETAIL);
		await menu.getByRole('menuitem', { name: `${TREE}とタブにまとめる`, exact: true }).click();
		await expect(menu).toHaveCount(0);
		await same('group the details with the tree as tabs');

		// auto-hide the tree group (the pin), slide out and back
		// (the region now has two tabs: the pin acts on the group, whichever tab is in front)
		await host(page)
			.getByRole('button', { name: /を自動で隠す（ピンを外す）$/ })
			.first()
			.click();
		await same('auto-hide the tree');

		// the narrow display and back (the centre is `persistent` there too)
		await page.setViewportSize({ width: 800, height: 900 });
		await expect(pane(page, 'center')).toBeVisible();
		await same('narrow display');
		await page.setViewportSize({ width: 1440, height: 900 });
		await same('wide again');

		// reset to the default
		await chooseView(page, 'レイアウトを既定に戻す');
		await expect(pane(page, 'left')).toBeVisible();
		await expect(pane(page, 'right')).toBeVisible();
		await same('reset the layout');
	});

	test('keyboard only: the panel menu docks the details at an edge, floats them, docks them back, and reads it out', async ({
		page
	}) => {
		await open(page, '?target=line-a-press');
		const live = host(page).locator('[aria-live="polite"]');

		let menu = await openPaneMenu(page, DETAIL);
		await expect(
			menu.getByRole('menuitem', { name: '左端にドッキング', exact: true })
		).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(live).toHaveText(`${DETAIL}を左端にドッキングしました`);
		const hostBox = await host(page).boundingBox();
		const paneBox = await pane(page, 'right').boundingBox();
		if (!hostBox || !paneBox) throw new Error('not visible');
		expect(Math.abs(paneBox.x - hostBox.x)).toBeLessThan(8);
		// the focus is on the moved pane's panel menu button
		await expect(
			host(page).getByRole('button', { name: `${DETAIL}のパネルの操作`, exact: true })
		).toBeFocused();

		menu = await openPaneMenu(page, DETAIL);
		await page.keyboard.press('End');
		await expect(menu.getByRole('menuitem', { name: '浮かせる', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(windowOf(page, DETAIL)).toBeVisible();
		await expect(live).toHaveText(`${DETAIL}を浮かせました`);

		menu = await openPaneMenu(page, DETAIL);
		await page.keyboard.press('End');
		await expect(menu.getByRole('menuitem', { name: '元の場所に戻す', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(windowOf(page, DETAIL)).toHaveCount(0);
		await expect(pane(page, 'right')).toBeVisible();
		await expect(live).toHaveText(`${DETAIL}を元の場所に戻しました`);
	});

	test('the layout is saved per user and screen, comes back on reload, and "reset layout" saves the default', async ({
		page
	}) => {
		await open(page);
		const initial = await savedLayout(page);
		await toolbarButton(page, 'ツリーを切り離す').click();
		await expect(windowOf(page, TREE)).toBeVisible();
		await expect.poll(() => savedLayout(page)).not.toBe(initial);
		// the saved value is the three-pane snapshot (`layoutSnapshot()`), not DockState.serialize()
		const parsed = JSON.parse((await savedLayout(page)) ?? 'null') as {
			schema: number;
			panels: string[];
		};
		expect(parsed.schema).toBe(1);
		expect([...parsed.panels].sort()).toEqual(['center', 'left', 'right']);
		const floated = await savedLayout(page);
		// the provider write is debounced: wait for it before leaving the page
		await expect.poll(() => providerLayout(page)).toBe(floated);

		await page.reload();
		await expect(windowOf(page, TREE)).toBeVisible();
		await expect(pane(page, 'center')).toBeVisible();
		// a re-read of what was just restored does not rewrite it
		await page.waitForTimeout(800);
		expect(await savedLayout(page)).toBe(floated);

		await chooseView(page, 'レイアウトを既定に戻す');
		await expect(windowOf(page, TREE)).toHaveCount(0);
		await expect(pane(page, 'left')).toBeVisible();
		await expect.poll(() => savedLayout(page)).toBe(initial);
		await expect.poll(() => providerLayout(page)).toBe(initial);
		await page.reload();
		await expect(pane(page, 'left')).toBeVisible();
		await expect(windowOf(page, TREE)).toHaveCount(0);
	});

	test('axe finds no violation docked, with a floating window, or with the panel menu open', async ({
		page
	}) => {
		await open(page, '?target=line-a-press&row=line-a-press-3');
		const scan = async () =>
			(
				await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa'])
					// the demo tree's count badge is 4.36:1 (muted text on the muted surface) - the same
					// parts as /tree/workspace, whose baselines this PR does not move: not this screen's
					.exclude('.workspace-tree .count')
					.analyze()
			).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
		expect(await scan()).toEqual([]);
		await toolbarButton(page, 'ツリーを切り離す').click();
		await expect(windowOf(page, TREE)).toBeVisible();
		expect(await scan()).toEqual([]);
		await openPaneMenu(page, DETAIL);
		expect(await scan()).toEqual([]);
	});

	test('a saved layout of another set of panes is read without breaking (unknown ids dropped, centre repaired)', async ({
		page
	}) => {
		await page.addInitScript(
			({ key }) => {
				if (window.localStorage.getItem(key) !== null) return;
				window.localStorage.setItem(
					key,
					JSON.stringify({
						schema: 1,
						panels: ['left', 'center', 'right', 'ghost'],
						layout: {
							version: 2,
							floating: [],
							docked: {
								type: 'split',
								id: 'root',
								direction: 'row',
								children: [
									{ type: 'panel', id: 'ghost', title: 'x' },
									{ type: 'panel', id: 'left', title: 'x' }
								],
								sizes: [0.5, 0.5]
							}
						}
					})
				);
			},
			{ key: LAYOUT_KEY }
		);
		await open(page);
		// the centre was missing: it is docked and open; the unknown pane is gone
		await expect(pane(page, 'center')).toBeVisible();
		await expect(pane(page, 'left')).toBeVisible();
		await expect(host(page).locator('[data-dock-drop-id="ghost"]')).toHaveCount(0);
	});

	test('at 800px the dock shows its narrow display, keeps the saved layout, and the tree is a flyout', async ({
		page
	}) => {
		await open(page, '?target=line-a-press');
		await toolbarButton(page, 'ツリーを切り離す').click();
		await expect(windowOf(page, TREE)).toBeVisible();
		await expect.poll(() => savedLayout(page)).toContain('"open":true');
		const wide = await savedLayout(page);

		await page.setViewportSize({ width: 800, height: 900 });
		// the centre alone, the sides in edge bands; nothing floating
		await expect(pane(page, 'center')).toBeVisible();
		await expect(windowOf(page, TREE)).toHaveCount(0);
		await expect(tree(page)).toBeHidden();
		const band = host(page).getByRole('button', { name: TREE, exact: true });
		await expect(band).toBeVisible();
		// what is saved is still the wide layout
		await page.waitForTimeout(800);
		expect(await savedLayout(page)).toBe(wide);

		// the band slides the tree out; a pick closes it again
		await band.click();
		await expect(tree(page)).toBeVisible();
		await row(page, '溶接機').click();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld');
		await expect(tree(page)).toBeHidden();

		// a row of the list slides the details out
		await page.getByRole('button', { name: '09:10', exact: true }).click();
		await expect(page.getByText('182 A', { exact: true }).last()).toBeVisible();

		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(windowOf(page, TREE)).toBeVisible();
		expect(await savedLayout(page)).toBe(wide);
	});

	test('panel operations never ask; unsaved settings still ask when leaving the target', async ({
		page
	}) => {
		await open(page, '?target=line-a-press&tab=settings');
		const name = page.getByRole('textbox', { name: '表示名', exact: true });
		await name.fill('プレス機（改）');
		await expect(page.getByText('未保存の変更があります', { exact: true })).toBeVisible();

		// float / dock back / hide / show the panes: no confirm, and the draft is untouched
		await toolbarButton(page, 'ツリーを切り離す').click();
		await toolbarButton(page, 'ツリーを元の場所に戻す').click();
		await toolbarButton(page, DETAIL).click();
		await toolbarButton(page, DETAIL).click();
		await expect(page.getByRole('alertdialog')).toHaveCount(0);
		await expect(name).toHaveValue('プレス機（改）');

		// leaving for another target asks, like /tree/workspace; cancelling keeps the screen
		await row(page, '溶接機').click();
		const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります', exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '編集に戻る', exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect.poll(() => search(page)).toBe('?target=line-a-press&tab=settings');
		await expect(name).toHaveValue('プレス機（改）');

		await row(page, '溶接機').click();
		await dialog.getByRole('button', { name: '破棄して移動', exact: true }).click();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld&tab=settings');
		await expect(name).toHaveValue('溶接機');
	});
});

test.describe('three-pane workspace on a dock: kiosk', () => {
	test('kiosk shows the saved layout and offers no way to rearrange it', async ({ page }) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await primeKiosk(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await open(page, '?target=line-a-press');
		await expect(pane(page, 'left')).toBeVisible();
		await expect(pane(page, 'right')).toBeVisible();
		await expect(viewMenuButton(page)).toHaveCount(0);
		await expect(page.getByRole('group', { name: 'パネルの表示と配置', exact: true })).toHaveCount(
			0
		);
		// no panel menu, ✕, pin, collapse and no dividers to drag
		await expect(
			host(page).getByRole('button', {
				name: /(パネルの操作|を閉じる|を自動で隠す（ピンを外す）|を帯に折りたたむ)$/
			})
		).toHaveCount(0);
		// the dividers are there but disabled (no pointer or keyboard resize)
		await expect(host(page).getByRole('separator', { disabled: false })).toHaveCount(0);
		// looking still works: a pick in the tree reaches the centre and the URL
		await row(page, '溶接機').click();
		await expect.poll(() => search(page)).toBe('?target=line-a-weld');
		await expect(
			pane(page, 'center').getByText('溶接機 の点検記録', { exact: false })
		).toBeVisible();
	});
});
