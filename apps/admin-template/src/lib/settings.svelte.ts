/**
 * App settings store (Svelte 5 runes).
 *
 * Persistence (spec §12.1, M12): TWO layers per setting -
 * - localStorage, written synchronously on every change. This is the FOUC
 *   cache: app.html's inline script restores `banto.theme`/`banto.preset`/
 *   `banto.density` from it before first paint, and it is also the whole
 *   story in demo mode.
 * - the mode-matched `UiSettingsProvider` (`getUiSettings()`, setup.ts):
 *   Tauri settings DB / REST `settings` table, written fire-and-forget on
 *   every change (an unauthenticated write fails server-side and is
 *   swallowed - the local cache already has the value). Read back once per
 *   login via `syncFromProvider()` (called from the `(app)` route guard
 *   after `sessionStore.load()`), so a value saved from another
 *   client/session wins over this tab's stale localStorage.
 */
import {
	applyDensity,
	applyPreset,
	applyTheme,
	isThemeDensity,
	isThemeMode,
	isThemePreset,
	watchSystemTheme,
	type ThemeDensity,
	type ThemeMode,
	type ThemePreset
} from '@banto/theme';
import { getUiSettings } from './banto/setup';

const THEME_KEY = 'banto.theme';
const PRESET_KEY = 'banto.preset';
const DENSITY_KEY = 'banto.density';
const KIOSK_KEY = 'banto.kiosk';

/** `UiSettingsProvider` keys (wire contract, spec M12). */
const MODE_SETTING = 'theme.mode';
const PRESET_SETTING = 'theme.preset';
const DENSITY_SETTING = 'theme.density';
const KIOSK_SETTING = 'shell.kiosk';

/**
 * Kiosk shell default (display-preset-plan.md D1-b/§3.2). `false` here keeps
 * this unit's behavior byte-for-byte unchanged for every existing app -
 * `scripts/scaffold.mjs --preset display` (PR-D2, not yet implemented) flips
 * ONLY this constant to `true` so a fresh display-preset app boots straight
 * into the kiosk shell. Do not seed `kiosk` from anywhere else.
 */
export const KIOSK_DEFAULT = false;

function loadThemeMode(): ThemeMode {
	if (typeof localStorage === 'undefined') return 'system';
	const stored = localStorage.getItem(THEME_KEY);
	return isThemeMode(stored) ? stored : 'system';
}

function loadThemePreset(): ThemePreset {
	if (typeof localStorage === 'undefined') return 'standard';
	const stored = localStorage.getItem(PRESET_KEY);
	return isThemePreset(stored) ? stored : 'standard';
}

function loadThemeDensity(): ThemeDensity {
	if (typeof localStorage === 'undefined') return 'standard';
	const stored = localStorage.getItem(DENSITY_KEY);
	return isThemeDensity(stored) ? stored : 'standard';
}

function loadKiosk(): boolean {
	if (typeof localStorage === 'undefined') return KIOSK_DEFAULT;
	const stored = localStorage.getItem(KIOSK_KEY);
	if (stored === 'true') return true;
	if (stored === 'false') return false;
	return KIOSK_DEFAULT;
}

/** Best-effort provider write: an unauthenticated/offline failure is expected and ignored (localStorage already holds the value). */
function persistRemote(key: string, value: string): void {
	void getUiSettings()
		.set(key, value)
		.catch(() => {});
}

class Settings {
	themeMode: ThemeMode = $state(loadThemeMode());
	themePreset: ThemePreset = $state(loadThemePreset());
	themeDensity: ThemeDensity = $state(loadThemeDensity());
	kiosk: boolean = $state(loadKiosk());
	/**
	 * Kiosk shell (display-preset-plan.md D1-b): the fold is not itself
	 * persisted (unchanged from before this unit - it always started at
	 * `false`), so "unless the user has a persisted sidebarCollapsed value"
	 * never applies today. The initial value only is seeded from `kiosk` so a
	 * kiosk app starts collapsed; nothing re-forces it afterwards, so the
	 * user can still expand it via `toggleSidebar()`.
	 */
	sidebarCollapsed = $state(this.kiosk);

	#unwatchSystem: (() => void) | undefined;

	/** Apply + cache locally, WITHOUT the provider write (init/syncFromProvider must not echo values back). */
	#applyThemeMode(mode: ThemeMode) {
		this.themeMode = mode;
		localStorage.setItem(THEME_KEY, mode);
		applyTheme(mode);

		this.#unwatchSystem?.();
		this.#unwatchSystem = undefined;
		if (mode === 'system') {
			this.#unwatchSystem = watchSystemTheme(() => applyTheme('system'));
		}
	}

	#applyThemePreset(preset: ThemePreset) {
		this.themePreset = preset;
		localStorage.setItem(PRESET_KEY, preset);
		applyPreset(preset);
	}

	#applyThemeDensity(density: ThemeDensity) {
		this.themeDensity = density;
		localStorage.setItem(DENSITY_KEY, density);
		applyDensity(density);
	}

	/** Apply + cache locally, WITHOUT the provider write - same split as the theme appliers above. Deliberately does NOT touch `sidebarCollapsed` (only the field's initial value is seeded from `kiosk`; a value arriving later via `syncFromProvider()` must not yank a fold the user already changed this session). */
	#applyKiosk(kiosk: boolean) {
		this.kiosk = kiosk;
		localStorage.setItem(KIOSK_KEY, String(kiosk));
	}

	setThemeMode(mode: ThemeMode) {
		this.#applyThemeMode(mode);
		persistRemote(MODE_SETTING, mode);
	}

	setThemePreset(preset: ThemePreset) {
		this.#applyThemePreset(preset);
		persistRemote(PRESET_SETTING, preset);
	}

	setThemeDensity(density: ThemeDensity) {
		this.#applyThemeDensity(density);
		persistRemote(DENSITY_SETTING, density);
	}

	setKiosk(kiosk: boolean) {
		this.#applyKiosk(kiosk);
		persistRemote(KIOSK_SETTING, String(kiosk));
	}

	/** Call once on app mount to sync the DOM and start OS-theme watching. No provider write - nothing changed yet. */
	init() {
		this.#applyThemeMode(this.themeMode);
		this.#applyThemePreset(this.themePreset);
		this.#applyThemeDensity(this.themeDensity);
		this.#applyKiosk(this.kiosk);
	}

	/**
	 * Pull theme settings from the `UiSettingsProvider` and apply whatever it
	 * holds (updating the localStorage cache too). Called once per login from
	 * `routes/(app)/+layout.ts` - that's the earliest point the provider is
	 * guaranteed authenticated (`sessionStore.load()` just succeeded). A
	 * missing key (never saved) or any provider failure leaves the current
	 * (localStorage-seeded) values in place.
	 */
	async syncFromProvider(): Promise<void> {
		const ui = getUiSettings();
		try {
			const [mode, preset, density, kiosk] = await Promise.all([
				ui.get(MODE_SETTING),
				ui.get(PRESET_SETTING),
				ui.get(DENSITY_SETTING),
				ui.get(KIOSK_SETTING)
			]);
			if (isThemeMode(mode)) this.#applyThemeMode(mode);
			if (isThemePreset(preset)) this.#applyThemePreset(preset);
			if (isThemeDensity(density)) this.#applyThemeDensity(density);
			if (kiosk === 'true' || kiosk === 'false') this.#applyKiosk(kiosk === 'true');
		} catch {
			// Best-effort: offline/unauthenticated reads keep the local values.
		}
	}

	toggleSidebar() {
		this.sidebarCollapsed = !this.sidebarCollapsed;
	}
}

export const settings = new Settings();
