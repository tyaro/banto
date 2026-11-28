/**
 * A dock taller than the viewport, and a slide-out next to floating windows (#1043), in a real
 * browser - the unit tests of `@banto/dock-svelte` have no layout and no painting order.
 *
 *  - The dashboard's dock is 900px high. In a 1280x800 viewport the outer-edge guide buttons of
 *    a drag are all on screen (the bottom one used to be at the bottom of the host, below the
 *    viewport), also after the page scrolled during the drag; a drop on the bottom one still
 *    docks the pane along the bottom of the HOST.
 *  - The slide-out of an auto-hidden pane is painted above a floating window lying over it, and
 *    closing it leaves the windows as they were.
 *
 * The widgets used are the memo and the list (`在庫の少ない商品`): neither needs `@banto/charts`.
 * (This spec is removed with the dock.)
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

const MEMO = 'メモ';
const LIST = '在庫の少ない商品';
const EDGES = ['left', 'right', 'top', 'bottom'] as const;

const dockHost = (page: Page): Locator => page.locator('.dock-wrapper [data-dock-host]');
const pane = (page: Page, id: string): Locator =>
	dockHost(page).locator(`[data-dock-drop-id="${id}"]`);
const outer = (page: Page, edge: string): Locator =>
	dockHost(page).locator(`.guide-button.outer[data-dock-edge="${edge}"]`);

async function openDashboard(page: Page): Promise<void> {
	await page.goto('/dashboard');
	await expect(dockHost(page)).toBeVisible({ timeout: 60_000 });
	await expect(pane(page, 'memo')).toBeVisible();
}

async function floatMemo(page: Page): Promise<Locator> {
	await dockHost(page)
		.getByRole('button', { name: `${MEMO}のパネルの操作`, exact: true })
		.click();
	await page
		.getByRole('menu', { name: `${MEMO}のパネルの操作`, exact: true })
		.getByRole('menuitem', { name: '浮かせる', exact: true })
		.click();
	const memoWindow = page.getByRole('dialog', { name: MEMO });
	await expect(memoWindow).toBeVisible();
	return memoWindow;
}

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.setViewportSize({ width: 1280, height: 800 });
});

test('the outer guide buttons of a dock taller than the viewport are all on screen', async ({
	page
}) => {
	await openDashboard(page);
	const memoWindow = await floatMemo(page);
	const hostBox = await dockHost(page).boundingBox();
	if (!hostBox) throw new Error('dock not visible');
	// The premise: the dock does not fit the viewport.
	expect(hostBox.y + hostBox.height).toBeGreaterThan(800);

	await memoWindow.locator('.titlebar').scrollIntoViewIfNeeded();
	const barBox = await memoWindow.locator('.titlebar').boundingBox();
	if (!barBox) throw new Error('memo window not visible');
	const from = { x: barBox.x + 30, y: barBox.y + barBox.height / 2 };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	try {
		await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
		for (const edge of EDGES) await expect(outer(page, edge)).toBeInViewport({ ratio: 1 });

		// The page scrolls under the drag (the wheel): the buttons follow what is on screen.
		await page.mouse.wheel(0, 150);
		await expect
			.poll(async () => (await dockHost(page).boundingBox())?.y ?? hostBox.y)
			.toBeLessThan(hostBox.y - 50);
		for (const edge of EDGES) await expect(outer(page, edge)).toBeInViewport({ ratio: 1 });

		const bottomBox = await outer(page, 'bottom').boundingBox();
		if (!bottomBox) throw new Error('bottom button not visible');
		await page.mouse.move(bottomBox.x + bottomBox.width / 2, bottomBox.y + bottomBox.height / 2, {
			steps: 12
		});
		await expect(dockHost(page).locator('.guide-button.outer.active')).toHaveAttribute(
			'data-dock-edge',
			'bottom'
		);
		// The preview shows on screen too.
		await expect(dockHost(page).locator('.snap-guide')).toBeInViewport();
	} finally {
		await page.mouse.up();
	}
	await expect(dockHost(page).locator('.guide-button')).toHaveCount(0);

	// Docked along the bottom of the host: its full width, at its bottom edge.
	await expect(memoWindow).toHaveCount(0);
	await expect(pane(page, 'memo')).toBeVisible();
	const after = await dockHost(page).boundingBox();
	const memoBox = await pane(page, 'memo').boundingBox();
	if (!after || !memoBox) throw new Error('not visible');
	expect(memoBox.width).toBeGreaterThan(after.width - 16);
	expect(Math.abs(memoBox.y + memoBox.height - (after.y + after.height))).toBeLessThan(8);
});

test('the top outer guide button is below the sticky header when the dock is scrolled under it', async ({
	page
}) => {
	await openDashboard(page);
	const memoWindow = await floatMemo(page);
	const header = page.locator('header').first();
	const headerBox = await header.boundingBox();
	if (!headerBox) throw new Error('header not visible');
	const headerBottom = headerBox.y + headerBox.height;

	await memoWindow.locator('.titlebar').scrollIntoViewIfNeeded();
	const barBox = await memoWindow.locator('.titlebar').boundingBox();
	if (!barBox) throw new Error('memo window not visible');
	const from = { x: barBox.x + 30, y: barBox.y + barBox.height / 2 };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	try {
		await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
		// The page scrolls under the drag until the dock's top is under the sticky header.
		await page.mouse.wheel(0, 260);
		await expect
			.poll(async () => ((await dockHost(page).boundingBox())?.y ?? 0) < headerBottom - 10)
			.toBe(true);
		await page.mouse.move(from.x + 20, from.y + 20, { steps: 2 });
		const topBox = await outer(page, 'top').boundingBox();
		if (!topBox) throw new Error('top button not visible');
		// Not under the header (#1058: it was at y=9..41, behind the 48px header).
		expect(topBox.y).toBeGreaterThanOrEqual(headerBottom);
		await expect(outer(page, 'top')).toBeInViewport({ ratio: 1 });
	} finally {
		await page.mouse.up();
	}
});

test('the slide-out of an auto-hidden pane is above a floating window lying over it', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 1300 });
	await openDashboard(page);
	const memoWindow = await floatMemo(page);

	await dockHost(page)
		.getByRole('button', { name: `${LIST}を自動で隠す（ピンを外す）`, exact: true })
		.click();
	const bandTab = dockHost(page).locator('[data-dock-band-tab="lowStock"]');
	await expect(bandTab).toBeVisible();
	await bandTab.click();
	const flyout = dockHost(page).locator('[data-dock-flyout="lowStock"]');
	await expect(flyout).toBeVisible();

	// Put the window over the slide-out without a press (a press outside slides it back): where
	// a window is drawn is its inline style. Only the test's own nudge - the layout is not touched.
	const flyoutBox = await flyout.boundingBox();
	const hostBox = await dockHost(page).boundingBox();
	if (!flyoutBox || !hostBox) throw new Error('not visible');
	await memoWindow.evaluate(
		(el, to) => {
			(el as HTMLElement).style.left = `${to.x}px`;
			(el as HTMLElement).style.top = `${to.y}px`;
		},
		{ x: flyoutBox.x - hostBox.x + 20, y: flyoutBox.y - hostBox.y + 40 }
	);
	const windowBox = await memoWindow.boundingBox();
	if (!windowBox) throw new Error('memo window not visible');
	// A point on both.
	const point = {
		x: Math.max(windowBox.x, flyoutBox.x) + 30,
		y: Math.max(windowBox.y, flyoutBox.y) + 30
	};
	expect(point.x).toBeLessThan(
		Math.min(windowBox.x + windowBox.width, flyoutBox.x + flyoutBox.width)
	);
	expect(point.y).toBeLessThan(
		Math.min(windowBox.y + windowBox.height, flyoutBox.y + flyoutBox.height)
	);
	const topmost = (at: { x: number; y: number }) =>
		page.evaluate(({ x, y }) => {
			const el = document.elementFromPoint(x, y);
			if (el?.closest('[data-dock-flyout]')) return 'flyout';
			if (el?.closest('[role="dialog"]')) return 'window';
			return 'other';
		}, at);
	expect(await topmost(point)).toBe('flyout');
	expect(await flyout.evaluate((el) => el.contains(document.activeElement))).toBe(true);

	// Closed: the window is there again, as it was.
	await page.keyboard.press('Escape');
	await expect(flyout).toHaveCount(0);
	expect(await topmost(point)).toBe('window');
});
