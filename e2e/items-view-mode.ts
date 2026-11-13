/**
 * /items の「表示」メニュー（読み込み方の切り替え）を操作する共有ヘルパ（#553）。
 * メニューはポップオーバーなので、ハイドレーション前のクリックは何も起こさない。
 * 開いて選ぶまでを `toPass()` で再試行する。
 */
import { expect, type Page } from '@playwright/test';

export interface ItemsViewLabels {
	/** 「表示」ボタンの名前（`resource.viewMenu`）。 */
	trigger: string;
	/** 選ぶ項目の名前（`resource.modeClient` / `resource.modeServer`）。 */
	item: string;
}

/** 「表示」メニューを開いて項目を選ぶ。選ぶとメニューは閉じる。 */
export async function chooseItemsMode(page: Page, labels: ItemsViewLabels): Promise<void> {
	const item = page.getByRole('menuitemradio', { name: labels.item, exact: true });
	await expect(async () => {
		if (!(await item.isVisible())) {
			await page.getByRole('button', { name: labels.trigger, exact: true }).click();
		}
		await item.click({ timeout: 1000 });
		await expect(item).toBeHidden({ timeout: 1000 });
	}).toPass();
}

/** 「表示」メニューを開き、項目が選択中（aria-checked）かを確かめて閉じる。 */
export async function expectItemsMode(
	page: Page,
	labels: ItemsViewLabels,
	checked: boolean
): Promise<void> {
	const item = page.getByRole('menuitemradio', { name: labels.item, exact: true });
	await expect(async () => {
		if (!(await item.isVisible())) {
			await page.getByRole('button', { name: labels.trigger, exact: true }).click();
		}
		await expect(item).toHaveAttribute('aria-checked', String(checked), { timeout: 1000 });
	}).toPass();
	await page.keyboard.press('Escape');
	await expect(item).toBeHidden();
}
