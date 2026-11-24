/**
 * Selectable chart marks (`onMarkActivate` / `markLabel` of BarChart and
 * PieChart; docs/design/crossfilter-drilldown-design.md §4.3, D2) on the
 * `/chart-gallery/marks` sample page. Assertion-only: no screenshots (the
 * existing screens must keep their baselines; the focus ring is checked by
 * computed style, not pixels).
 *
 * Covered: click, Tab (one stop per chart, roving tabindex), arrow / Home /
 * End, Enter and Space call the handler, the focus ring and tooltip, and an
 * axe scan with a mark focused. A hydration-late first input is retried with
 * `toPass` (#810).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeThemeAndAuth } from './theme';

const BAR_GROUP = 'カテゴリ別の在庫数の棒グラフ。印を選べます';
const PIE_GROUP = 'カテゴリ別の構成の円グラフ。印を選べます';

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.goto('/chart-gallery/marks');
	await expect(page.getByRole('heading', { name: '印を選べるチャート' })).toBeVisible();
});

function marks(page: Page, group: string): Locator {
	return page.getByRole('group', { name: group }).getByRole('button');
}

const selected = (page: Page) => page.getByTestId('chart-marks-selected');

test('the charts become groups of buttons named by markLabel', async ({ page }) => {
	await expect(marks(page, BAR_GROUP)).toHaveCount(4);
	await expect(marks(page, PIE_GROUP)).toHaveCount(4);
	await expect(marks(page, BAR_GROUP).first()).toHaveAccessibleName('Aを選ぶ（120）');
	await expect(marks(page, PIE_GROUP).nth(3)).toHaveAccessibleName('Dを選ぶ（15）');
	// roving tabindex: exactly one tab stop per chart
	await expect(page.getByRole('group', { name: BAR_GROUP }).locator('[tabindex="0"]')).toHaveCount(
		1
	);
	await expect(page.getByRole('group', { name: BAR_GROUP }).locator('[tabindex="-1"]')).toHaveCount(
		3
	);
});

test('click selects a bar and a slice', async ({ page }) => {
	await expect(selected(page)).toHaveText('まだ選んでいません');
	await expect(async () => {
		await marks(page, BAR_GROUP).nth(1).click({ timeout: 2_000 });
		await expect(selected(page)).toHaveText('選んだ印: B（80）', { timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await marks(page, PIE_GROUP).nth(2).click();
	await expect(selected(page)).toHaveText('選んだ印: C（45）');
});

test('keyboard only: Tab stops once per chart, arrows move, Enter / Space select', async ({
	page
}) => {
	const bars = marks(page, BAR_GROUP);
	// The first key press needs a hydrated page too: focus, press and the move are retried together (#810).
	await expect(async () => {
		await bars.first().focus({ timeout: 2_000 });
		await expect(bars.first()).toBeFocused({ timeout: 2_000 });
		await page.keyboard.press('ArrowRight');
		await expect(bars.nth(1)).toBeFocused({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await page.keyboard.press('Enter');
	await expect(selected(page)).toHaveText('選んだ印: B（80）');

	await page.keyboard.press('End');
	await expect(bars.nth(3)).toBeFocused();
	await page.keyboard.press('Space');
	await expect(selected(page)).toHaveText('選んだ印: D（15）');
	// no wrap-around at the end
	await page.keyboard.press('ArrowDown');
	await expect(bars.nth(3)).toBeFocused();
	await page.keyboard.press('Home');
	await expect(bars.first()).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await expect(bars.first()).toBeFocused();

	// the roving tab stop follows the focus, and Tab leaves the chart in one press
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Tab');
	await expect(page.getByRole('group', { name: BAR_GROUP }).locator(':focus')).toHaveCount(0);
	await expect(marks(page, PIE_GROUP).first()).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(bars.nth(1)).toBeFocused();
});

test('the focused mark shows a focus ring and the tooltip', async ({ page }) => {
	const bars = marks(page, BAR_GROUP);
	await expect(async () => {
		await bars.first().focus({ timeout: 2_000 });
		await expect(bars.first()).toBeFocused({ timeout: 2_000 });
		await page.keyboard.press('ArrowRight');
		await expect(bars.nth(1)).toBeFocused({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });

	const ring = (index: number) =>
		bars.nth(index).evaluate((g) => {
			const path = g.querySelector('path') as SVGPathElement;
			const cs = getComputedStyle(path);
			return { stroke: cs.stroke, width: cs.strokeWidth };
		});
	const focused = await ring(1);
	const other = await ring(2);
	expect(focused.width).toBe('3px');
	expect(other.width).toBe('2px');
	expect(focused.stroke).not.toBe(other.stroke);
	// the group itself draws no native outline (its bounding box would be wrong)
	expect(await bars.nth(1).evaluate((g) => getComputedStyle(g).outlineStyle)).toBe('none');
	expect(await bars.nth(1).evaluate((g) => getComputedStyle(g).cursor)).toBe('pointer');

	const tooltip = page.locator('.banto-barchart .chart-tooltip');
	await expect(tooltip).toContainText('B');
	await expect(tooltip).toContainText('80');
	// the pointer entering and leaving another mark does not hide the focused mark's tooltip
	await bars.nth(2).hover();
	await expect(tooltip).toContainText('C');
	await page.mouse.move(0, 0);
	await expect(bars.nth(1)).toBeFocused();
	await expect(tooltip).toContainText('B');
	await expect(tooltip).toContainText('80');
	await page.keyboard.press('Tab');
	await expect(tooltip).toHaveCount(0);
});

test('no axe violations with a mark focused', async ({ page }) => {
	const bars = marks(page, BAR_GROUP);
	await expect(async () => {
		await bars.first().focus({ timeout: 2_000 });
		await expect(bars.first()).toBeFocused({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
	expect(
		results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
	).toEqual([]);
});
