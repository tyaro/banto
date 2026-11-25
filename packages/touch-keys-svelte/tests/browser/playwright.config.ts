/**
 * Playwright config of the touch-keys browser fixture (touch-keypad-design §14.3).
 *
 * - `@playwright/test` and `@axe-core/playwright` are the banto root's devDependencies
 *   (same as `fixtures/external-consumer`): run from the repository root with
 *   `pnpm e2e:touch-keys`.
 * - The page is this folder's own vite dev server (fixed port, never reused), opened in
 *   a touch context (`hasTouch`). Synthetic touch only: the OS keyboard and a real
 *   panel are checked on a device (§14.4).
 * - Specs are `*.e2e.ts` so the package's vitest run does not pick them up.
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4329;

export default defineConfig({
	testDir: dirname,
	testMatch: '*.e2e.ts',
	outputDir: path.join(dirname, 'test-results'),
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: [['list']],
	use: {
		...devices['Desktop Chrome'],
		baseURL: `http://127.0.0.1:${PORT}`,
		hasTouch: true,
		// Tall enough that the centred Modal and the bottom-docked keys do not overlap.
		viewport: { width: 1024, height: 1100 },
		trace: 'retain-on-failure'
	},
	webServer: {
		command: `pnpm exec vite --config tests/browser/vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
		cwd: path.resolve(dirname, '../..'),
		url: `http://127.0.0.1:${PORT}`,
		reuseExistingServer: false,
		timeout: 60_000
	}
});
