/**
 * Shared theme/auth priming helpers for the `visual` project (Phase 0,
 * visual-refresh-design.md §12.1). Both `visual.spec.ts` and `a11y.spec.ts`
 * need the exact same "force a theme combo + skip the login form" setup, so
 * it lives here once rather than being copy-pasted per spec file.
 */
import type { Page } from '@playwright/test';

export type ThemeMode = 'light' | 'dark';
export type ThemePreset = 'standard' | 'glass';

export interface ThemeCombo {
	theme: ThemeMode;
	preset: ThemePreset;
}

/** All 4 combinations - used for login/dashboard (plan Phase 0's full matrix). */
export const FULL_MATRIX: ThemeCombo[] = [
	{ theme: 'light', preset: 'standard' },
	{ theme: 'dark', preset: 'standard' },
	{ theme: 'light', preset: 'glass' },
	{ theme: 'dark', preset: 'glass' }
];

/**
 * The diagonal thinning rule (plan Phase 0 / design §12.1): every other
 * screen only shoots light/standard and dark/glass, the two combinations
 * furthest apart, which still catches a broken variable somewhere in the
 * 4-way matrix without shooting all 4.
 */
export const DIAGONAL_MATRIX: ThemeCombo[] = [
	{ theme: 'light', preset: 'standard' },
	{ theme: 'dark', preset: 'glass' }
];

export const VIEWPORTS = [
	{ width: 1440, height: 900 },
	{ width: 1024, height: 768 },
	{ width: 768, height: 1024 }
] as const;

export function comboLabel(combo: ThemeCombo): string {
	return `${combo.theme}-${combo.preset}`;
}

/** localStorage keys app.html's FOUC script / settings.svelte.ts read (must match those files exactly). */
const THEME_KEY = 'banto.theme';
const PRESET_KEY = 'banto.preset';
const DENSITY_KEY = 'banto.density';
/** settings.svelte.ts's kiosk-shell key (display-preset-plan.md D1-b). Not part of app.html's FOUC script - kiosk only affects layout (sidebar fold/header height), not color, so there is nothing to avoid flashing. */
const KIOSK_KEY = 'banto.kiosk';
/** setup.ts's `AUTH_KEY` - the demo `AuthProvider`'s one sessionStorage flag. */
const DEMO_AUTH_KEY = 'banto.auth.demo';

/**
 * Forces the theme/preset (density is always 'standard' - this project
 * doesn't vary it) via `addInitScript`, so app.html's inline FOUC script
 * applies it before first paint on every navigation in this page/context.
 * Must be called before the test's first `page.goto()`.
 */
export async function primeTheme(page: Page, combo: ThemeCombo): Promise<void> {
	await page.addInitScript(
		({ theme, preset, themeKey, presetKey, densityKey }) => {
			window.localStorage.setItem(themeKey, theme);
			window.localStorage.setItem(presetKey, preset);
			window.localStorage.setItem(densityKey, 'standard');
		},
		{
			theme: combo.theme,
			preset: combo.preset,
			themeKey: THEME_KEY,
			presetKey: PRESET_KEY,
			densityKey: DENSITY_KEY
		}
	);
}

/**
 * `primeTheme` plus the demo-mode auth bypass (sets the same sessionStorage
 * flag `setup.ts`'s `demoAuthProvider.login()` sets), so protected pages
 * ((app) route group) render straight away instead of redirecting to
 * /login. Only meaningful against the `visual` project's vite-preview
 * server (browser demo mode, spec §11.1) - never used for the login screen
 * itself, which needs the real (empty) auth state.
 */
export async function primeThemeAndAuth(page: Page, combo: ThemeCombo): Promise<void> {
	await primeTheme(page, combo);
	await page.addInitScript(
		({ authKey }) => {
			window.sessionStorage.setItem(authKey, '1');
		},
		{ authKey: DEMO_AUTH_KEY }
	);
}

/**
 * Forces the kiosk shell on via localStorage (display-preset-plan.md D1-b) -
 * `settings.svelte.ts`'s `loadKiosk()` reads this key synchronously at
 * module init, the same mechanism `primeTheme` uses for theme/preset/density.
 * Call alongside `primeThemeAndAuth`, before the test's first `page.goto()`.
 */
export async function primeKiosk(page: Page): Promise<void> {
	await page.addInitScript(
		({ kioskKey }) => {
			window.localStorage.setItem(kioskKey, 'true');
		},
		{ kioskKey: KIOSK_KEY }
	);
}
