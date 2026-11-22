/**
 * Saving the `ThreePaneDock` layout from `onLayoutCommit` on /tree/workspace-dock (#791 first half,
 * docs/design/downstream-requests-2026-11-plan.md §4.6), in a real browser: only a settled layout
 * is ever written - not a step of a divider drag, and never the narrow display while the dock
 * switches narrow / wide with the focus inside the frame (the root cause: the switch waits a tick
 * for the focus repair, and `layoutSnapshot()` used to answer with the narrow display meanwhile).
 * "Reset layout" (reason `'reset'`) saves the default.
 *
 * The page writes two copies to localStorage in demo mode (`dockLayoutStore.svelte.ts`): its own
 * first-paint copy at once, and the `UiSettingsProvider` copy 500ms after the last report. Every
 * write of either is recorded by an init script, so a wrong value written and overwritten right
 * after is still seen.
 */
import { expect, test, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

const LAYOUT_KEY = 'banto.dock.threePane.workspace:acct:demo';
const PROVIDER_KEY = 'banto.ui.dock.threePane.workspace';
const TREE = '対象のツリー';

interface SavedLayout {
	schema: number;
	layout: {
		docked: { type: string; sizes?: number[] } | null;
		autoHidden?: unknown[];
		floating: { id: string; open: boolean }[];
	};
}

/** Every value written under the two keys, in order. */
async function writes(page: Page): Promise<{ key: string; value: string }[]> {
	return page.evaluate(
		() => (window as unknown as { __layoutWrites: { key: string; value: string }[] }).__layoutWrites
	);
}

const stored = (page: Page, key: string): Promise<string | null> =>
	page.evaluate((k) => window.localStorage.getItem(k), key);

/** The narrow display: the centre docked alone, the sides in edge bands. Never a value to save. */
function isNarrowDisplay(value: string): boolean {
	const saved = JSON.parse(value) as SavedLayout;
	return saved.layout.docked?.type !== 'split' || (saved.layout.autoHidden?.length ?? 0) > 0;
}

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.addInitScript(
		({ keys }) => {
			const w = window as unknown as { __layoutWrites: { key: string; value: string }[] };
			w.__layoutWrites = [];
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (keys.includes(key)) w.__layoutWrites.push({ key, value });
				setItem.call(this, key, value);
			};
		},
		{ keys: [LAYOUT_KEY, PROVIDER_KEY] }
	);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/tree/workspace-dock?target=line-a-press');
	await expect(page.getByTestId('workspace-dock-center')).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => stored(page, LAYOUT_KEY)).not.toBeNull();
});

test('a divider drag is saved once it ends, not while it moves', async ({ page }) => {
	const host = page.locator('[data-dock-host]');
	const initial = await stored(page, LAYOUT_KEY);
	const before = (await writes(page)).length;
	const divider = host.getByRole('separator').first();
	const box = (await divider.boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 40, y, { steps: 4 });
	// Longer than the provider's debounce, the button still down: nothing is written.
	await page.waitForTimeout(800);
	await page.mouse.move(x + 80, y, { steps: 4 });
	expect((await writes(page)).length).toBe(before);
	await page.mouse.up();
	await expect.poll(() => stored(page, LAYOUT_KEY)).not.toBe(initial);
	const moved = await stored(page, LAYOUT_KEY);
	await expect.poll(() => stored(page, PROVIDER_KEY)).toBe(moved);
	// One report for the whole drag: one write of each copy.
	const after = (await writes(page)).slice(before);
	expect(after.map((w) => w.key).sort()).toEqual([LAYOUT_KEY, PROVIDER_KEY].sort());
	expect(new Set(after.map((w) => w.value))).toEqual(new Set([moved]));
});

test('narrow and back with the focus in the frame never saves the narrow display; reset saves the default', async ({
	page
}) => {
	const host = page.locator('[data-dock-host]');
	const initial = await stored(page, LAYOUT_KEY);
	await page
		.getByRole('group', { name: 'パネルの表示と配置', exact: true })
		.getByRole('button', { name: 'ツリーを切り離す', exact: true })
		.click();
	await expect(page.getByRole('dialog', { name: TREE, exact: true })).toBeVisible();
	await expect.poll(() => stored(page, LAYOUT_KEY)).toContain('"open":true');
	const wide = await stored(page, LAYOUT_KEY);
	await expect.poll(() => stored(page, PROVIDER_KEY)).toBe(wide);

	const focusCentre = async () => {
		const tab = host.locator('[data-dock-drop-id="center"]').getByRole('tab').first();
		await tab.focus();
		await expect(tab).toBeFocused();
	};
	await focusCentre();
	await page.setViewportSize({ width: 800, height: 900 });
	await expect(host.getByRole('button', { name: TREE, exact: true })).toBeVisible();
	await expect(page.getByRole('dialog', { name: TREE, exact: true })).toHaveCount(0);
	await page.waitForTimeout(800);
	await focusCentre();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(page.getByRole('dialog', { name: TREE, exact: true })).toBeVisible();
	await page.waitForTimeout(800);

	const all = await writes(page);
	expect(all.filter((w) => isNarrowDisplay(w.value))).toEqual([]);
	expect(await stored(page, LAYOUT_KEY)).toBe(wide);
	expect(await stored(page, PROVIDER_KEY)).toBe(wide);

	// "Reset layout" from the View menu: the dock reports `'reset'`, the page saves the default.
	await page.getByRole('button', { name: '表示', exact: true }).click();
	await page.getByRole('menuitem', { name: 'レイアウトを既定に戻す', exact: true }).click();
	await expect(page.getByRole('dialog', { name: TREE, exact: true })).toHaveCount(0);
	await expect.poll(() => stored(page, LAYOUT_KEY)).toBe(initial);
	await expect.poll(() => stored(page, PROVIDER_KEY)).toBe(initial);
});
