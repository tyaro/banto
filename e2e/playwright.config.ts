/**
 * Playwright config for Banto's E2E suites: TWO independent projects that
 * never interfere with each other (visual-refresh-plan.md Phase 0).
 *
 * - `chromium` (testDir `./tests`): the M18 smoke suite described below.
 * - `visual` (testDir `./visual`): the Phase 0 visual-regression +
 *   axe-core project (visual-refresh-design.md §12). It runs against the
 *   SAME static build as `chromium`, but served by plain `vite preview`
 *   (browser demo mode - InMemory data + fixed admin/admin auth, spec
 *   §11.1's third environment) instead of `banto-serve`, so its screenshots
 *   never depend on a live SQLite backend. `pnpm --filter admin-template
 *   build` must run first here too - see visual/README.md.
 *
 * `webServer` is an array (Playwright starts every entry regardless of
 * which `--project` is selected), so running just the smoke suite still
 * spins up the idle preview server - harmless as long as `build/` already
 * exists, which the smoke suite already requires (see below). Root
 * `package.json`'s `e2e` script pins `--project=chromium` so a plain
 * `pnpm e2e` never runs the visual suite (and vice versa for `e2e:visual`).
 *
 * ---
 *
 * `chromium` project scope (docs/roadmap.md M18, docs/improvements.md §4):
 * a LAN/REST-mode smoke pass, NOT a mocked-frontend test. `pnpm --filter
 * admin-template build` produces the static SvelteKit build, and a `cargo
 * build -p admin-template-core --bin banto-serve --features embed-ui`
 * produces the binary this config's `webServer` launches directly (NOT
 * `cargo run` - launching the already-built binary keeps startup
 * near-instant and avoids a surprise recompile mid-test-run). Neither
 * build step runs from this config; run them first (see README/CI
 * workflow), same division of labor as `.claude/launch.json`'s
 * `banto-serve` entry.
 *
 * The whole suite runs single-worker/serial in one spec file
 * (`tests/smoke.spec.ts`) against one shared `page` - each scenario builds
 * on state the previous one created (the admin account, the item, the
 * viewer account, ...), mirroring how a person would actually click through
 * the app once. That is also why `webServer` always starts a fresh server
 * against a fresh temp-directory SQLite file: scenario 1 exercises the
 * first-run setup screen, which only appears against a database with zero
 * users - reusing a server/db left over from a previous run would skip it.
 */
import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..');

const PORT = 8799;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// `visual` project (browser demo mode, vite preview - see doc comment above).
const VISUAL_PORT = 4173;
const VISUAL_BASE_URL = `http://127.0.0.1:${VISUAL_PORT}`;

// `SqliteConnectOptions::create_if_missing` (crates/banto-storage/src/
// sqlite.rs) creates the DB *file* but not missing parent directories, so
// the temp dir itself must exist before banto-serve starts.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-e2e-'));
const dbPath = path.join(dbDir, 'banto-e2e.sqlite3');
// Read by global-teardown.ts to remove `dbDir` again after the run - see
// that file's doc comment for why an env var, not a direct import.
process.env.BANTO_E2E_DB_DIR = dbDir;

const bantoServeBin = path.join(
	repoRoot,
	'target',
	'debug',
	process.platform === 'win32' ? 'banto-serve.exe' : 'banto-serve'
);

export default defineConfig({
	testDir: './tests',
	// Explicit (not the './test-results'/'./playwright-report' defaults):
	// Playwright resolves those defaults relative to the process's current
	// working directory, not this config file's directory, and `pnpm e2e`
	// (root package.json) invokes this config via `--config=e2e/...` from
	// the repo root - an implicit default would litter the repo root
	// instead of staying under e2e/ (see .gitignore's `e2e/test-results/`).
	outputDir: path.join(dirname, 'test-results'),
	globalTeardown: path.join(dirname, 'global-teardown.ts'),
	fullyParallel: false,
	workers: 1,
	// A single retry in CI absorbs shared-runner hiccups (slow first paint,
	// a cold-cache SQLite VACUUM INTO for the backup scenario) without
	// masking a genuinely broken scenario - locally we want an immediate,
	// unambiguous failure instead.
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI
		? [
				['github'],
				['html', { open: 'never', outputFolder: path.join(dirname, 'playwright-report') }]
			]
		: [['list']],
	expect: {
		// Slightly above the 5s default: several assertions here wait on a
		// real SQLite round trip (grid filter -> server-mode fetch, backup
		// creation) rather than an in-memory mock.
		timeout: 10_000
	},
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		// View Transitions (visual-refresh-design.md §11.1) freeze the OLD
		// page's snapshot for the crossfade duration, so right after a
		// navigation the DOM briefly still shows the previous page - locators
		// can pin the wrong element in that window. reduced-motion makes
		// onNavigate skip startViewTransition entirely (and zeroes every
		// --banto-duration-* token), keeping the suite deterministic - the
		// same setting §12.1 prescribes for the visual-regression project.
		reducedMotion: 'reduce'
	},
	projects: [
		// M18 smoke suite (unchanged behavior): explicit testDir so adding the
		// `visual` project below can never pull tests/visual/*.spec.ts into the
		// wrong project or vice versa.
		{ name: 'chromium', testDir: './tests', use: { ...devices['Desktop Chrome'] } },
		// Phase 0 visual regression + axe-core (visual-refresh-design.md §12).
		// 1440x900 is the project-wide default viewport; individual specs
		// override it per visual-refresh-plan.md's Phase 0 matrix (1024x768,
		// 768x1024) via `test.use({ viewport })`.
		{
			name: 'visual',
			testDir: './visual',
			testMatch: /.*\.spec\.ts/,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 },
				reducedMotion: 'reduce',
				baseURL: VISUAL_BASE_URL
			},
			expect: {
				// §12.1: pixel-level tolerance for the whole project, so specs
				// only need to name the screenshot, not repeat these options.
				toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.001 }
			}
		}
	],
	webServer: [
		{
			command: bantoServeBin,
			url: BASE_URL,
			// Never reuse a leftover server: it would carry over yesterday's
			// (already-set-up) database, which breaks scenario 1's "database
			// starts empty" assumption on a second local run.
			reuseExistingServer: false,
			timeout: 30_000,
			// Playwright's default swallows webServer stdout, which turns any
			// "server never became ready" failure into an undebuggable 30s
			// timeout in CI logs. Piping it costs a few startup lines per run
			// and preserves the evidence (bind address, DB path) when it counts.
			stdout: 'pipe',
			env: {
				PORT: String(PORT),
				BANTO_BIND: '127.0.0.1',
				BANTO_DB: dbPath,
				// spec §8.2 / banto-serve.rs: POST /api/auth/setup is 403'd unless
				// explicitly opted into - required for scenario 1.
				BANTO_ALLOW_SETUP: '1'
			}
		},
		{
			// Browser demo mode (spec §11.1's third environment): no Rust
			// backend at all, so unlike `banto-serve` above this has no `env`/DB
			// to isolate - reusing a server left running from a previous local
			// run is safe (and convenient for `--update-snapshots` iteration).
			//
			// `--host 127.0.0.1` is load-bearing: vite's default host is
			// `localhost`, which on hosts whose `localhost` resolves to `::1`
			// first (GitHub's ubuntu runners) makes vite bind ONLY the IPv6
			// loopback - while Playwright polls the IPv4 `url` below and gets
			// ECONNREFUSED until the 30s webServer timeout kills the whole run.
			// Pinning the bind address to the exact address being polled keeps
			// the two sides agreeing everywhere.
			command: `pnpm --filter admin-template preview --port ${VISUAL_PORT} --strictPort --host 127.0.0.1`,
			cwd: repoRoot,
			url: VISUAL_BASE_URL,
			reuseExistingServer: !process.env.CI,
			timeout: 30_000,
			// Same rationale as the banto-serve entry above - vite's startup
			// banner records which host it actually bound.
			stdout: 'pipe'
		}
	]
});
