/**
 * Phase 0 visual regression (visual-refresh-plan.md Phase 0,
 * visual-refresh-design.md §12.1). Runs against the `visual` project's
 * `vite preview` server (browser demo mode, spec §11.1's third
 * environment - InMemory data seeded from the deterministic `sampleData.ts`
 * PRNG, fixed admin/admin auth) so screenshots never depend on a live
 * SQLite backend or wall-clock time.
 *
 * No `waitForLoadState('networkidle')` anywhere - demo mode has no SSE and
 * (per the project doc comment) no ongoing network traffic to go idle on.
 * Instead each test waits for a concrete visible element (the thing that
 * only appears once its data has actually rendered) plus a short, fixed
 * settle (`page.waitForTimeout`) for the layout/paint to finish - CSS
 * transitions are already zeroed by `reducedMotion: 'reduce'`
 * (banto.css §2.3), so this settle is purely for chart/dock layout math,
 * not animation.
 */
import { expect, test } from '@playwright/test';
import {
	DIAGONAL_MATRIX,
	VIEWPORTS,
	comboLabel,
	primeDensity,
	primeKiosk,
	primeLauncher,
	primeMenubar,
	primeTheme,
	primeThemeAndAuth,
	type LauncherPosition,
	type ThemeCombo
} from './theme';

/** Chart/dock layout settle after the data-dependent element becomes visible. */
const SETTLE_MS = 300;

// login / dashboard use the diagonal pair like every other screen (#798): the
// theme/preset pairs are decided by tokens, and shooting all 4 cost ~12 extra
// Linux-only baselines per change for little extra signal.
test.describe('login', () => {
	for (const combo of DIAGONAL_MATRIX) {
		for (const viewport of VIEWPORTS) {
			const label = `${comboLabel(combo)} ${viewport.width}x${viewport.height}`;
			test(`login ${label}`, async ({ page }) => {
				await page.setViewportSize(viewport);
				await primeTheme(page, combo);
				await page.goto('/login');
				await expect(page.getByRole('heading', { name: 'Banto' })).toBeVisible();
				await expect(page.getByLabel('ユーザー名')).toBeVisible();
				await page.waitForTimeout(SETTLE_MS);
				await expect(page).toHaveScreenshot(
					`login-${comboLabel(combo)}-${viewport.width}x${viewport.height}.png`,
					{
						fullPage: true,
						// The release number changes independently of this layout.
						mask: [page.locator('.login-version')]
					}
				);
			});
		}
	}
});

test.describe('dashboard', () => {
	for (const combo of DIAGONAL_MATRIX) {
		for (const viewport of VIEWPORTS) {
			const label = `${comboLabel(combo)} ${viewport.width}x${viewport.height}`;
			test(`dashboard ${label}`, async ({ page }) => {
				await page.setViewportSize(viewport);
				await primeThemeAndAuth(page, combo);
				await page.goto('/dashboard');
				await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
				// Charts/KPIs render once the 10k-row seeded dataset finishes
				// loading (createListResource) - wait for a chart's <svg> instead
				// of a network signal (demo mode has no network round trip at all).
				await expect(page.locator('svg').first()).toBeVisible();
				await page.waitForTimeout(SETTLE_MS);
				await expect(page).toHaveScreenshot(
					`dashboard-${comboLabel(combo)}-${viewport.width}x${viewport.height}.png`,
					{ fullPage: true }
				);
			});
		}
	}
});

// Kiosk shell (display-preset-plan.md D1-b): one screenshot, not the full
// matrix - this only proves the ON state renders (collapsed sidebar,
// compact header, no search pill, fullscreen button) at the baseline
// viewport; the default-OFF path is already covered by every other test in
// this file (none of them prime the kiosk key, so they stay byte-for-byte
// unaffected by this unit per display-preset-plan.md's design principle).
test.describe('kiosk shell', () => {
	test('dashboard kiosk light-standard 1440x900', async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await primeKiosk(page);
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('svg').first()).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('dashboard-kiosk-light-standard-1440x900.png', {
			fullPage: true
		});
	});

	// #624 PR-2: the large KPI must not overflow a phone-width tile.
	test('dashboard kiosk light-standard 375x812', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await primeKiosk(page);
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('svg').first()).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('dashboard-kiosk-light-standard-375x812.png', {
			fullPage: true
		});
	});
});

// Compact density (#623): the only full-page shot with density 'compact'.
// Every other test keeps the 'standard' density `primeTheme` sets.
test.describe('compact density', () => {
	test('dashboard compact light-standard 1440x900', async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await primeDensity(page, 'compact');
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('data-banto-density', 'compact');
		await expect(page.locator('svg').first()).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('dashboard-compact-light-standard-1440x900.png', {
			fullPage: true
		});
	});
});

// Touch density (#624): the only full-page shot with density 'touch'.
// The three-pane screen pattern (#631 PR③): a target and a row picked in the list tab,
// so the tree badges, the table and the right pane's details are all on screen.
test.describe('three-pane workspace', () => {
	for (const size of ['1440x900', '1366x768'] as const) {
		test(`tree workspace light-standard ${size}`, async ({ page }) => {
			const [width, height] = size.split('x').map(Number);
			await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
			await page.setViewportSize({ width, height });
			await page.goto('/tree/workspace?target=line-a-press&row=line-a-press-3');
			await expect(page.getByRole('tree')).toBeVisible();
			await expect(page.getByText('3.9 mm/s', { exact: true }).last()).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`tree-workspace-light-standard-${size}.png`);
		});
	}
});

// The same screen on a dock (#663 ④ PR-6, three-pane-dock-plan §4.10): the default layout, the tree
// floated as a window, and the narrow display (the baselines are generated by visual-baselines.yml).
test.describe('three-pane workspace on a dock', () => {
	const PICKED = '/tree/workspace-dock?target=line-a-press&row=line-a-press-3';

	test('tree workspace dock light-standard 1440x900', async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(PICKED);
		await expect(page.getByRole('tree')).toBeVisible();
		await expect(page.getByText('3.9 mm/s', { exact: true }).last()).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('tree-workspace-dock-light-standard-1440x900.png');
	});

	test('tree workspace dock tree floated light-standard 1440x900', async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(PICKED);
		await expect(page.getByRole('tree')).toBeVisible();
		await page.getByRole('button', { name: 'ツリーを切り離す', exact: true }).click();
		await expect(page.getByRole('dialog', { name: '対象のツリー', exact: true })).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('tree-workspace-dock-floated-light-standard-1440x900.png');
	});

	test('tree workspace dock narrow light-standard 800x900', async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await page.setViewportSize({ width: 800, height: 900 });
		await page.goto(PICKED);
		await expect(page.getByRole('tab', { name: '一覧', exact: true })).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('tree-workspace-dock-narrow-light-standard-800x900.png');
	});
});

test.describe('touch density', () => {
	test('dashboard touch light-standard 1440x900', async ({ page }) => {
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await primeDensity(page, 'touch');
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('data-banto-density', 'touch');
		await expect(page.locator('svg').first()).toBeVisible();
		await page.waitForTimeout(SETTLE_MS);
		await expect(page).toHaveScreenshot('dashboard-touch-light-standard-1440x900.png', {
			fullPage: true
		});
	});
});

// Dock layout (nav-launcher-plan.md §7.3): the diagonal at the baseline
// viewport plus the <=900px tab bar, and one shot per other edge (D4, one
// combo each). Primed like the kiosk shell, so every other test here keeps
// the default sidebar.
const LAUNCHER_SHOTS: {
	combo: ThemeCombo;
	viewport: { width: number; height: number };
	position: LauncherPosition;
}[] = [
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 1440, height: 900 }, position: 'bottom' },
	{ combo: DIAGONAL_MATRIX[1], viewport: { width: 1440, height: 900 }, position: 'bottom' },
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 768, height: 1024 }, position: 'bottom' },
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 1440, height: 900 }, position: 'left' },
	{ combo: DIAGONAL_MATRIX[1], viewport: { width: 1440, height: 900 }, position: 'right' },
	{ combo: DIAGONAL_MATRIX[1], viewport: { width: 1440, height: 900 }, position: 'top' }
];

test.describe('dock layout', () => {
	for (const { combo, viewport, position } of LAUNCHER_SHOTS) {
		const size = `${viewport.width}x${viewport.height}`;
		// The bottom bar keeps its original names (existing baselines).
		const side = position === 'bottom' ? '' : `${position}-`;
		test(`dashboard launcher ${side}${comboLabel(combo)} ${size}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await primeThemeAndAuth(page, combo);
			await primeLauncher(page, position);
			await page.goto('/dashboard');
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(page.locator('svg').first()).toBeVisible();
			await expect(page.locator('.launcher')).toBeVisible();
			// Viewport shot scrolled to the end, not fullPage: a full-page capture
			// draws the fixed bar at the first viewport's bottom - mid-page - so it
			// would show neither where the dock sits nor that the page's last
			// content clears it (the shell's bottom reserve, plan §4.1).
			// The charts lay out after first paint (the page is one viewport tall
			// until then), so settle first, scroll, and wait until it really moved.
			// A top bar keeps the page start instead: that is where the shell's
			// top reserve shows (the content starts below the bar).
			await page.waitForTimeout(SETTLE_MS);
			if (position !== 'top') {
				await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
				await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
				await page.waitForTimeout(SETTLE_MS);
			}
			await expect(page).toHaveScreenshot(
				`dashboard-launcher-${side}${comboLabel(combo)}-${size}.png`
			);
		});
	}
});

// Menu bar layout (nav-menubar-plan.md §7.3): the diagonal at the baseline
// viewport, plus a narrower one where part of the main nav moves into
// "その他". Primed like the dock, so every other test here keeps the default
// sidebar. The dropdowns stay closed (an open popover's place depends on font
// metrics; the behaviour is covered by menubar.spec.ts).
const MENUBAR_SHOTS: { combo: ThemeCombo; viewport: { width: number; height: number } }[] = [
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 1440, height: 900 } },
	{ combo: DIAGONAL_MATRIX[1], viewport: { width: 1440, height: 900 } },
	{ combo: DIAGONAL_MATRIX[0], viewport: { width: 1024, height: 768 } }
];

test.describe('menu bar layout', () => {
	for (const { combo, viewport } of MENUBAR_SHOTS) {
		const size = `${viewport.width}x${viewport.height}`;
		test(`dashboard menubar ${comboLabel(combo)} ${size}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await primeThemeAndAuth(page, combo);
			await primeMenubar(page);
			await page.goto('/dashboard');
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await expect(page.locator('svg').first()).toBeVisible();
			const nav = page.getByRole('navigation', { name: '主要ナビゲーション' });
			await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`dashboard-menubar-${comboLabel(combo)}-${size}.png`);
		});
	}
});

interface DiagonalPage {
	name: string;
	path: string;
	heading: string;
}

// Plan Phase 0's thinning rule: everything except login/dashboard only
// shoots the diagonal (light/standard, dark/glass) at the one baseline
// viewport (1440x900).
const DIAGONAL_PAGES: DiagonalPage[] = [
	{ name: 'items', path: '/items', heading: '商品' },
	{ name: 'users', path: '/users', heading: 'ユーザー管理' },
	// settings-routes step 2 (choiapp-feedback-2026-09 §3.2): each category
	// is now its own route, so no single settings screenshot shows all of
	// them anymore - `/settings` (lands on appearance) plus one more
	// category per visibility tier (account: always visible; connectivity:
	// admin-only, but visible in this demo-mode admin session too).
	{ name: 'settings', path: '/settings', heading: '設定' },
	{ name: 'settings-account', path: '/settings/account', heading: '設定' },
	{ name: 'settings-connectivity', path: '/settings/connectivity', heading: '設定' },
	// @banto/ui catalog page (Issue #220 / ADR-0018 §6). Reached by URL: its
	// sidebar entry is demo-build-only (`demoOnly`), and this suite builds
	// without VITE_BANTO_DEMO, so the shared sidebar baselines stay unchanged.
	{ name: 'ui-demo', path: '/ui-demo', heading: 'UI 部品の見本' },
	// Chart types that are not on the dashboard (demo-only route, same rule as ui-demo).
	{ name: 'chart-gallery', path: '/chart-gallery', heading: 'チャート見本' }
];

test.describe('diagonal pages', () => {
	for (const combo of DIAGONAL_MATRIX) {
		for (const p of DIAGONAL_PAGES) {
			test(`${p.name} ${comboLabel(combo)} 1440x900`, async ({ page }) => {
				await primeThemeAndAuth(page, combo);
				await page.goto(p.path);
				await expect(page.getByRole('heading', { name: p.heading })).toBeVisible();
				// Chart-heavy page: wait for a drawn chart, not just the heading.
				if (p.name === 'chart-gallery') await expect(page.locator('svg').first()).toBeVisible();
				await page.waitForTimeout(SETTLE_MS);
				await expect(page).toHaveScreenshot(`${p.name}-${comboLabel(combo)}-1440x900.png`, {
					fullPage: true
				});
			});
		}
	}
});

test.describe('command palette', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`command-palette ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await primeThemeAndAuth(page, combo);
			await page.goto('/dashboard');
			await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
			await page.keyboard.press('Control+K');
			await expect(page.getByRole('dialog', { name: 'コマンドパレット' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`command-palette-${comboLabel(combo)}-1440x900.png`, {
				fullPage: true
			});
		});
	}
});

// @banto/ui DateInput with its calendar open (date-time-pickers §6, PR-1). The
// clock is pinned so the "today" ring (aria-current) is the same on every
// run; the selected day (the sample's fixed value) is a different day, so both
// states show. Viewport shot (not fullPage): the popover is in the top layer
// beside the field, and the closed card is already in the ui-demo baseline.
test.describe('date picker', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`ui-demo-date-picker ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await page.clock.setFixedTime(new Date('2026-11-10T10:00:00'));
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const opener = page.getByRole('button', { name: '日付を変更、2026年11月7日土曜日' });
			await opener.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await opener.click();
			await expect(page.getByRole('dialog', { name: '日付の選択' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`ui-demo-date-picker-${comboLabel(combo)}-1440x900.png`);
		});

		// The month and year views (#908), reached from the keyboard so no pointer
		// hovers a cell: Shift+Tab from the day goes back over the next-year and
		// next-month buttons to the heading's month button.
		test(`ui-demo-date-picker-views ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await page.clock.setFixedTime(new Date('2026-11-10T10:00:00'));
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const opener = page.getByRole('button', { name: '日付を変更、2026年11月7日土曜日' });
			await opener.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await opener.click();
			const dialog = page.getByRole('dialog', { name: '日付の選択' });
			await expect(dialog).toBeVisible();
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(dialog.getByRole('button', { name: '2026年11月' })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(dialog.getByRole('gridcell', { name: '2026年11月' })).toBeFocused();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(
				`ui-demo-date-picker-months-${comboLabel(combo)}-1440x900.png`
			);
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(dialog.getByRole('button', { name: '2026年' })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(dialog.getByRole('gridcell', { name: '2026年' })).toBeFocused();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(
				`ui-demo-date-picker-years-${comboLabel(combo)}-1440x900.png`
			);
		});
	}
});

// @banto/ui TimeInput with its list open (date-time-pickers §6, PR-2): the
// sample's fixed value (09:30) is the active option, centred in the list.
// Opened from the keyboard so no pointer hovers an option. Viewport shot, like
// the date picker above.
test.describe('time picker', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`ui-demo-time-picker ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const input = page.getByRole('combobox', { name: '開始時刻' });
			await input.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await input.focus();
			await page.keyboard.press('ArrowDown');
			await expect(page.getByRole('listbox', { name: '時刻の一覧' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(`ui-demo-time-picker-${comboLabel(combo)}-1440x900.png`);
		});
	}
});

// @banto/ui DateTimeInput with its dialog open (date-time-pickers §6, PR-5): the
// calendar and the time list side by side, on the sample's fixed value
// (2026-11-07 09:30, the active time centred in the list). The clock is pinned
// like the date picker's. Viewport shot, like the pickers above.
test.describe('date-time picker', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`ui-demo-datetime-picker ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await page.clock.setFixedTime(new Date('2026-11-10T10:00:00'));
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const opener = page.getByRole('button', {
				name: '日時を変更、2026年11月7日土曜日 09:30'
			});
			await opener.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await opener.click();
			await expect(page.getByRole('dialog', { name: '日時の選択' })).toBeVisible();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(
				`ui-demo-datetime-picker-${comboLabel(combo)}-1440x900.png`
			);
		});
	}
});

// @banto/ui DateRangePicker (Issue #910): the extended calendar - two months
// side by side, the sample's range crossing the month end - open, then with a
// start picked and the end previewed from the keyboard (so no pointer hovers
// a cell). Clock pinned for the "today" ring, as the date picker above.
test.describe('extended calendar', () => {
	for (const combo of DIAGONAL_MATRIX) {
		test(`ui-demo-date-range-picker ${comboLabel(combo)} 1440x900`, async ({ page }) => {
			await page.clock.setFixedTime(new Date('2026-11-10T10:00:00'));
			await primeThemeAndAuth(page, combo);
			await page.goto('/ui-demo');
			await expect(page.getByRole('heading', { name: 'UI 部品の見本' })).toBeVisible();
			const opener = page.getByRole('button', {
				name: '期間を変更、2026年11月28日土曜日～2026年12月3日木曜日'
			});
			await opener.scrollIntoViewIfNeeded();
			await page.waitForTimeout(SETTLE_MS);
			await opener.click();
			const dialog = page.getByRole('dialog', { name: '期間の選択' });
			await expect(dialog).toBeVisible();
			await expect(dialog.getByRole('gridcell', { name: '2026年11月28日土曜日' })).toBeFocused();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(
				`ui-demo-date-range-picker-${comboLabel(combo)}-1440x900.png`
			);
			await page.keyboard.press('Enter');
			await page.keyboard.press('ArrowDown');
			await expect(dialog.getByRole('gridcell', { name: '2026年12月5日土曜日' })).toBeFocused();
			await page.waitForTimeout(SETTLE_MS);
			await expect(page).toHaveScreenshot(
				`ui-demo-date-range-picker-preview-${comboLabel(combo)}-1440x900.png`
			);
		});
	}
});
