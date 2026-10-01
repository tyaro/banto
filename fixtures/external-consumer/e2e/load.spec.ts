/**
 * 外部利用 fixture（#271）の合格条件:
 *
 * 1. `data-testid="banto-loaded"` が描画される（`.svelte.ts` を持つ 5 パッケージと
 *    theme のモジュールグラフをブラウザが読み込み終えた）。
 * 2. その間に `console.error` と `pageerror` が 1 件も出ない（504 の
 *    Outdated Optimize Dep・動的 import の失敗はここに出る）。
 *
 * dev ログの検査（依存オプティマイザのエラーが無いこと）は CI の別ステップが行う。
 */
import { expect, test } from '@playwright/test';

test('@banto/* を Git 依存で導入した dev サーバでページが描画される', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
	});
	page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

	const response = await page.goto('/');
	expect(response?.status()).toBe(200);

	try {
		// マーカーか SvelteKit のエラー画面（#150 では 500）のどちらかが出るまで待つ。
		// エラー画面ならタイムアウトまで待たずに次の検査で落とす。
		await page
			.getByTestId('banto-loaded')
			.or(page.getByRole('heading', { level: 1, name: /^\d{3}$/ }))
			.first()
			.waitFor({ timeout: 90_000 });
		await expect(page.getByTestId('banto-loaded')).toHaveText(
			'function,function,function,function,function,function,function,function,light',
			{ timeout: 5_000 }
		);
		// 描画後に遅れて出るエラー（遅延した動的 import の失敗など）も拾う。
		await page.waitForLoadState('networkidle');
	} finally {
		// マーカーが出ずに落ちたときも、原因（504・動的 import の失敗）をログに残す。
		if (errors.length > 0) console.log(`ブラウザのエラー:\n${errors.join('\n')}`);
	}

	expect(errors, errors.join('\n')).toEqual([]);
});
