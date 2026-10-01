/**
 * 外部利用 fixture（#271）の Playwright 設定。
 *
 * fixture 自身の `vite dev` を webServer として起動し、ブラウザで開いて
 * `@banto/*` のモジュールグラフが読み込めたかを確かめる。#150 の型の壊れ
 * （dev の依存オプティマイザでだけ出るもの）は、dev の `/` が 200 のまま
 * 動的 import が 504（Outdated Optimize Dep）→ SvelteKit のクライアント側 500
 * 画面、という形で出るため、HTTP の応答だけでは判定できない（実測）。
 *
 * - `@playwright/test` は banto ルートの devDependency を使う（fixture には
 *   入れない）。ルートで `pnpm install` してから、ルートで
 *   `pnpm exec playwright test --config=fixtures/external-consumer/playwright.config.ts`
 *   として実行する。
 * - dev サーバの出力はファイルに残す（`dev.log`、exclude 無しは
 *   `dev-no-exclude.log`）。CI はこのログに依存オプティマイザのエラー
 *   （`error while updating dependencies`・`js_parse_error`）が無いことも確かめる。
 * - `--force` で依存オプティマイザのキャッシュ（node_modules/.vite）を毎回
 *   作り直す。前回の実行のキャッシュが残っていると、壊れを見逃しうるため。
 * - 既存のサーバは再利用しない（固定ポート 4319・strictPort）。
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4319;
const noExclude = process.env.BANTO_FIXTURE_NO_EXCLUDE === '1';
const devLog = noExclude ? 'dev-no-exclude.log' : 'dev.log';

export default defineConfig({
	testDir: './e2e',
	outputDir: './test-results',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: `pnpm exec vite dev --force > ${devLog} 2>&1`,
		cwd: dirname,
		url: `http://127.0.0.1:${PORT}/`,
		reuseExistingServer: false,
		timeout: 180_000
	}
});
