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
 * which `--project` is selected; set `BANTO_E2E_SERVERS=visual` to start
 * only the `vite preview` entry, as CI's visual job does), so running just
 * the smoke suite still spins up the idle preview server - harmless as long as `build/` already
 * exists, which the smoke suite already requires (see below). Root
 * `package.json`'s `e2e` script pins `--project=chromium` so a plain
 * `pnpm e2e` never runs the visual suite (and vice versa for `e2e:visual`).
 *
 * ---
 *
 * `chromium` project scope (docs/roadmap.md M18, docs/history/improvements.md §4):
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
 * against a fresh temp-directory SQLite file: the scenarios create their own
 * accounts and records, and a database left over from a previous run would
 * already hold them.
 *
 * The first administrator: a new database has no account and needs no login,
 * and `banto-serve` logs nobody in while that is so (ADR-0034 §5/§6). The
 * servers of the suites that log in are therefore started through
 * `serve-with-first-admin.mjs`, which runs `banto-serve create-admin` on the
 * fresh database first (ADR-0034 §7) - the account is `E2E_ADMIN`
 * (first-admin.ts), and the database is login-required from then on.
 */
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_ADMIN } from './first-admin';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..');

const PORT = 8799;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// `public-viewer` project (viewer-public-plan.md §3.1-8, Issue #189): a SECOND
// `banto-serve` on its own port and its own fresh DB, started with
// `BANTO_VIEWER_PUBLIC=1`. It has to be a separate server: viewer-public is a
// settings-DB flag with no REST route to toggle it (server settings are
// desktop-only), and switching it on the smoke server would change scenario
// 1's "unauthenticated visit shows the login screen" premise.
//
// Its database keeps ZERO accounts and stays in no-login mode: the server
// listens only because public viewing is on, and serves it read-only. The
// scenarios that log in next to public viewing run in `public-viewer-login`,
// against a THIRD `banto-serve` whose database got its administrator from
// `create-admin` (login required, public viewing on).
const PUBLIC_VIEWER_LOGIN_PORT = 8797;
const PUBLIC_VIEWER_LOGIN_BASE_URL = `http://127.0.0.1:${PUBLIC_VIEWER_LOGIN_PORT}`;
const PUBLIC_VIEWER_PORT = 8798;
const PUBLIC_VIEWER_BASE_URL = `http://127.0.0.1:${PUBLIC_VIEWER_PORT}`;

// `visual` project (browser demo mode, vite preview - see doc comment above).
const VISUAL_PORT = 4173;
// Specs that take `toHaveScreenshot` baselines (Issue #798). ONLY these belong to the
// `visual` project; every other spec under ./visual runs in `visual-ui`. Add a new
// screenshot spec HERE, so `visual-baselines.yml` (which selects `--project=visual`)
// and ci.yml regenerate and verify exactly the same files.
const SNAPSHOT_SPECS = ['**/visual.spec.ts'];
const VISUAL_BASE_URL = `http://127.0.0.1:${VISUAL_PORT}`;

// `demo` project (Issue #553): the same app as a DEMO build (`VITE_BANTO_DEMO=1`,
// which `isDemoBuild()` reads at build time). The `visual` preview above is a
// production-style build, so demo-only UI (the annotation drawer) needs its
// own server: `vite dev` with the flag set, on its own port.
const DEMO_PORT = 4174;
const DEMO_BASE_URL = `http://127.0.0.1:${DEMO_PORT}`;

// `SqliteConnectOptions::create_if_missing` (crates/banto-storage/src/
// sqlite.rs) creates the DB *file* but not missing parent directories, so
// the temp dir itself must exist before banto-serve starts.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-e2e-'));
const dbPath = path.join(dbDir, 'banto-e2e.sqlite3');
// Same temp dir (one teardown removes both), separate file: the two servers
// must never share a users table.
const publicViewerLoginDbPath = path.join(dbDir, 'banto-e2e-public-viewer-login.sqlite3');
const publicViewerDbPath = path.join(dbDir, 'banto-e2e-public-viewer.sqlite3');
// Read by global-teardown.ts to remove `dbDir` again after the run - see
// that file's doc comment for why an env var, not a direct import.
process.env.BANTO_E2E_DB_DIR = dbDir;

const bantoServeBin = path.join(
	repoRoot,
	'target',
	'debug',
	process.platform === 'win32' ? 'banto-serve.exe' : 'banto-serve'
);

// First administrator (see the doc comment above): the `webServer` command of
// a suite that logs in, and the account it creates before the server starts.
const serveWithFirstAdmin = `node "${path.join(dirname, 'serve-with-first-admin.mjs')}" "${bantoServeBin}"`;
const FIRST_ADMIN_ENV = {
	BANTO_E2E_ADMIN_USERNAME: E2E_ADMIN.username,
	BANTO_E2E_ADMIN_PASSWORD: E2E_ADMIN.password,
	BANTO_E2E_ADMIN_DISPLAY_NAME: E2E_ADMIN.displayName
};
// End of the first-administrator wiring.

/**
 * `BANTO_E2E_SERVERS=visual` narrows `webServer` to the `vite preview` entry
 * (matched by its URL, not its position) - CI's separate visual job only
 * needs that, so it can skip building `banto-serve`. Unset (every local
 * `pnpm e2e*`) keeps all entries.
 */
// webServer の 1 件分の型（Playwright は名前では export していない）。配列リテラルから
// 推論させると、要素ごとに env の形が食い違って webServer に渡せなくなる。
type WebServer = Extract<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>[number];

function selectWebServers(servers: WebServer[]): WebServer[] {
	// `--project=add-resource` のときは banto-serve 1 本だけで足りる（2 本目の
	// banto-serve や vite の dev/preview を立てない）。明示の BANTO_E2E_SERVERS が優先。
	const wanted =
		process.env.BANTO_E2E_SERVERS ||
		(process.argv.includes('--project=add-resource') ? 'add-resource' : undefined);
	if (wanted === undefined || wanted === '') return servers;
	// Comma-separated names: `visual` (vite preview), `demo` (vite dev, Issue #553), `public-viewer` (2 本目の banto-serve, :8798), `public-viewer-login` (3 本目の banto-serve, :8797), `smoke` (banto-serve, :8799 = chromium project) and/or `add-resource` (smoke と同じ banto-serve, Issue #715).
	const urls: Record<string, string> = {
		visual: VISUAL_BASE_URL,
		demo: DEMO_BASE_URL,
		'public-viewer': PUBLIC_VIEWER_BASE_URL,
		'public-viewer-login': PUBLIC_VIEWER_LOGIN_BASE_URL,
		smoke: BASE_URL,
		'add-resource': BASE_URL
	};
	return wanted.split(',').map((name) => {
		const url = urls[name.trim()];
		const found = servers.filter((s) => s.url === url);
		if (url === undefined || found.length !== 1) {
			throw new Error(`BANTO_E2E_SERVERS=${wanted}: expected one webServer for "${name}"`);
		}
		return found[0];
	});
}

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
	// Upper bound only: every project below sets its own `workers` (Playwright 1.65
	// supports it per project). Serial ones are pinned to 1; `visual-ui` fans out.
	fullyParallel: false,
	workers: 4,
	// A single retry in CI absorbs shared-runner hiccups (slow first paint,
	// a cold-cache SQLite VACUUM INTO for the backup scenario) without
	// masking a genuinely broken scenario - locally we want an immediate,
	// unambiguous failure instead.
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI
		? [
				['github'],
				[
					'html',
					{
						open: 'never',
						// ci.yml runs two Playwright invocations in the visual job; a second report
						// folder keeps the later run from overwriting the first (Issue #798).
						outputFolder: path.join(
							dirname,
							process.env.BANTO_E2E_REPORT_DIR || 'playwright-report'
						)
					}
				]
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
		{ name: 'chromium', testDir: './tests', workers: 1, use: { ...devices['Desktop Chrome'] } },
		// Viewer-public mode (Issue #189): LAN/REST mode like `chromium`, but
		// against the second banto-serve started with BANTO_VIEWER_PUBLIC=1
		// (see `webServer` below). Own testDir so neither project can pick up
		// the other's specs.
		{
			name: 'public-viewer',
			testDir: './tests-public-viewer',
			testIgnore: ['**/with-login/**'],
			workers: 1,
			use: { ...devices['Desktop Chrome'], baseURL: PUBLIC_VIEWER_BASE_URL }
		},
		// Viewer-public next to real accounts: login / logout / session races,
		// against the third banto-serve (login required, public viewing on).
		{
			name: 'public-viewer-login',
			testDir: './tests-public-viewer/with-login',
			workers: 1,
			use: { ...devices['Desktop Chrome'], baseURL: PUBLIC_VIEWER_LOGIN_BASE_URL }
		},
		// `pnpm banto add resource` の生成直後の確認（Issue #715）。`tests-add-resource/` の
		// spec は生成した orders の画面を前提にするので、生成していない状態では動かない。
		// ふだんの `pnpm e2e`（--project=chromium）には入らず、CI の template-acceptance
		// `add-resource` ジョブだけが `pnpm e2e:add-resource` で走らせる。サーバーは
		// `chromium` と同じ banto-serve（BASE_URL、新しい DB）で、`selectWebServers` が
		// このプロジェクトのときはそれだけを立てる。
		{
			name: 'add-resource',
			testDir: './tests-add-resource',
			// 再試行しない: spec は作ったばかりの DB から始まるが、DB は実行全体で
			// 1 つ（webServer が共通）。再試行の 2 回目は 1 回目の行が残った DB で走り、
			// 最初の失敗の場所を隠すだけになる。
			retries: 0,
			workers: 1,
			use: { ...devices['Desktop Chrome'] }
		},
		// Demo-build-only UI (Issue #553), against `vite dev` with VITE_BANTO_DEMO=1.
		{
			name: 'demo',
			testDir: './demo',
			workers: 1,
			// Own outputDir (see visual-ui): ci.yml runs demo after `visual` even when it
			// failed, and must not clear the screenshot diffs.
			outputDir: path.join(dirname, 'test-results-demo'),
			use: { ...devices['Desktop Chrome'], baseURL: DEMO_BASE_URL }
		},
		// Phase 0 visual regression + axe-core (visual-refresh-design.md §12).
		// 1440x900 is the project-wide default viewport; individual specs
		// override it per visual-refresh-plan.md's Phase 0 matrix (1024x768,
		// 768x1024) via `test.use({ viewport })`.
		{
			name: 'visual',
			testDir: './visual',
			testMatch: SNAPSHOT_SPECS,
			// Screenshots stay stable with few workers (CPU contention shifts rendering).
			workers: 2,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 },
				reducedMotion: 'reduce',
				baseURL: VISUAL_BASE_URL
			},
			expect: {
				// §12.1: pixel-level tolerance for the whole project, so specs
				// only need to name the screenshot, not repeat these options.
				//
				// ABSOLUTE, not a ratio (choiapp-feedback-2026-09 §6). The former
				// `maxDiffPixelRatio: 0.001` was a share of the WHOLE fullPage
				// screenshot, so a tall page bought itself a proportionally larger
				// blind spot: the 1440x3255 dashboard tolerated ~4,700 differing
				// pixels, the 1440x900 items page ~1,300. Measured consequence: the
				// 2026-09 header status chips register as only 568-828 perceptually
				// different pixels (pixelmatch YIQ at the default `threshold: 0.2`),
				// so a visible new element slipped past every page's tolerance and
				// the baselines silently went stale.
				//
				// 250 sits below that 568 floor (so a chip/badge-sized change is
				// caught) and above the observed noise: re-rendering the same build
				// twice in one environment differs by exactly 0 pixels - Chromium is
				// deterministic given the same binary, fonts and `reducedMotion`, and
				// CI pins both the runner image and the Playwright version. The
				// buffer is there for incidental antialiasing, not for jitter.
				//
				// Trade-off accepted: a Playwright/Chromium/runner-image bump that
				// shifts rendering now turns this suite red instead of passing
				// unnoticed. That is the intended behavior - review the diff, then
				// regenerate via `.github/workflows/visual-baselines.yml`
				// (see e2e/visual/README.md).
				toHaveScreenshot: { animations: 'disabled', maxDiffPixels: 250 }
			}
		},
		// The rest of ./visual (functional + axe-core, no screenshots), run in
		// parallel against the same `vite preview` (Issue #798). Each test gets its
		// own browser context (own localStorage) and the data is the in-memory demo
		// store, so specs share no state. `BANTO_E2E_SERVERS=visual` serves both.
		{
			name: 'visual-ui',
			testDir: './visual',
			// Playwright clears a project's outputDir at the start of a run; a separate
			// one keeps this run from deleting the `visual` run's failure diffs.
			outputDir: path.join(dirname, 'test-results-ui'),
			testIgnore: SNAPSHOT_SPECS,
			fullyParallel: true,
			workers: 4,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 },
				reducedMotion: 'reduce',
				baseURL: VISUAL_BASE_URL
			}
		}
	],
	webServer: selectWebServers([
		{
			// `create-admin` on the fresh database, then the server (see
			// `serveWithFirstAdmin`): scenario 1 logs in as that account.
			command: serveWithFirstAdmin,
			url: BASE_URL,
			// Never reuse a leftover server: it would carry over yesterday's
			// database, and the suite assumes a brand-new one on every run.
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
				...FIRST_ADMIN_ENV
			}
		},
		{
			// Second banto-serve for the `public-viewer` project (Issue #189) -
			// same binary, own port/DB, viewer-public seeded ON at startup.
			// No account is ever created on this database: it stays in no-login
			// mode, and the server listens because public viewing is on.
			command: bantoServeBin,
			url: PUBLIC_VIEWER_BASE_URL,
			reuseExistingServer: false,
			timeout: 30_000,
			stdout: 'pipe',
			env: {
				PORT: String(PUBLIC_VIEWER_PORT),
				BANTO_BIND: '127.0.0.1',
				BANTO_DB: publicViewerDbPath,
				BANTO_VIEWER_PUBLIC: '1'
			}
		},
		{
			// Third banto-serve, for `public-viewer-login`: an administrator from
			// `create-admin` (login required) AND viewer-public seeded ON - the
			// "ログイン" path from the synthetic viewer back into the normal UI.
			command: serveWithFirstAdmin,
			url: PUBLIC_VIEWER_LOGIN_BASE_URL,
			reuseExistingServer: false,
			timeout: 30_000,
			stdout: 'pipe',
			env: {
				PORT: String(PUBLIC_VIEWER_LOGIN_PORT),
				BANTO_BIND: '127.0.0.1',
				BANTO_DB: publicViewerLoginDbPath,
				BANTO_VIEWER_PUBLIC: '1',
				...FIRST_ADMIN_ENV
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
		},
		{
			// Demo BUILD stand-in for the `demo` project: `isDemoBuild()` is
			// `import.meta.env.VITE_BANTO_DEMO === '1'`, which `vite dev` reads
			// from the environment at startup. Heavier to hydrate than a
			// prebuilt preview, so specs open overlays inside `toPass()`.
			command: `pnpm --filter admin-template dev --port ${DEMO_PORT} --strictPort --host 127.0.0.1`,
			cwd: repoRoot,
			url: DEMO_BASE_URL,
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
			stdout: 'pipe',
			env: { VITE_BANTO_DEMO: '1' }
		}
	])
});
