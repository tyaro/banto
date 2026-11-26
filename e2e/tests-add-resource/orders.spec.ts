/**
 * `pnpm banto add resource orders` の生成直後の E2E（Issue #715）。
 *
 * 前提: このスペックは **生成後のコピーでだけ動く**。`orders` は生成器
 * （scripts/fixtures/add-resource/orders.json）が作るリソースなので、素のリポジトリには
 * 存在しない。ふだんの `pnpm e2e`（--project=chromium）には入らず、CI の
 * template-acceptance `add-resource` ジョブが、生成→ビルド→`pnpm e2e:add-resource` の順で
 * 走らせる。手元で試すときも、先に生成して pnpm build と banto-serve のビルドを済ませる
 * （docs/recipes/add-resource.md「生成器で足す」）。
 *
 * 見るのは「生成した画面が実際に動く」ことだけ: 最初の管理者でログイン → ナビから一覧 →
 * フォームで 1 件作成 → 一覧にその行。ラベルはフィクスチャの `label.ja` と同じ文字列で引く。
 * 待ちは locator の auto-retry のみ（sleep なし）。
 */
import { expect, test } from '@playwright/test';
import { loginAsFirstAdmin } from '../first-admin';

// フィクスチャ（scripts/fixtures/add-resource/orders.json）の ja ラベル。
const RESOURCE_LABEL = '注文（受注）';
const FIELD_CUSTOMER = '顧客名（法人名）';
const FIELD_SUMMARY = '概要';
const FIELD_QUANTITY = '数量（個）';
const FIELD_ORDERED_ON = '受注日';

const CUSTOMER = `E2E顧客-${Date.now()}`;

test('生成した orders: ナビから一覧が開き、フォームで作った 1 件が一覧に出る', async ({ page }) => {
	// サーバーの起動前に `banto-serve create-admin` で作ったアカウント（first-admin.ts）。
	await loginAsFirstAdmin(page);

	// ナビに生成した項目が出て、開くと一覧（空）が出る。
	await page
		.getByRole('navigation', { name: '主要ナビゲーション' })
		.getByRole('link', { name: RESOURCE_LABEL })
		.click();
	await expect(page).toHaveURL(/\/orders$/);
	await expect(page.getByRole('grid')).toBeVisible();
	// 0 件の一覧には次の一手（#712）。管理者なので「新規作成」が出る。
	await expect(page.locator('[data-empty-action="create"]')).toBeVisible();

	// フォームで必須欄を埋めて 1 件作る。
	await page.getByRole('button', { name: '新規作成' }).click();
	await expect(page).toHaveURL(/\/orders\/new$/);
	await page.getByLabel(FIELD_CUSTOMER).fill(CUSTOMER);
	await page.getByLabel(FIELD_SUMMARY).fill('E2E の注文');
	await page.getByLabel(FIELD_QUANTITY).fill('3');
	await page.getByLabel(FIELD_ORDERED_ON).fill('2026-01-15');
	await page.getByRole('button', { name: '保存' }).click();

	// 一覧に戻り、作った行が出る。
	await expect(page).toHaveURL(/\/orders$/);
	await expect(page.getByRole('row').filter({ hasText: CUSTOMER })).toBeVisible();
});
