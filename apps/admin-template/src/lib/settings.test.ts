/**
 * Settings store: the navigation layout and the launcher opacity
 * (nav-launcher-plan.md §3, §7.1, D7). Node environment - localStorage and
 * the root element are small fakes, the theme appliers are no-ops and the
 * `UiSettingsProvider` is a mock. The store is a module singleton that reads
 * localStorage at import, so each test re-imports it after seeding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	get: vi.fn<(key: string) => Promise<string | null>>(),
	set: vi.fn<(key: string, value: string) => Promise<void>>()
}));

vi.mock('./banto/setup', () => ({
	getUiSettings: () => ({ get: mocks.get, set: mocks.set })
}));

vi.mock('@banto/theme', async (importOriginal) => ({
	...(await importOriginal<typeof import('@banto/theme')>()),
	applyTheme: vi.fn(),
	applyPreset: vi.fn(),
	applyDensity: vi.fn(),
	watchSystemTheme: vi.fn(() => () => {})
}));

const OPACITY_TOKEN = '--banto-shell-launcher-opacity';

let store: Map<string, string>;
let rootStyle: Map<string, string>;

function fakeStorage(): Storage {
	return {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key: string) => store.get(key) ?? null,
		key: (index: number) => [...store.keys()][index] ?? null,
		removeItem: (key: string) => void store.delete(key),
		setItem: (key: string, value: string) => void store.set(key, String(value))
	};
}

async function loadSettings(seed: Record<string, string> = {}) {
	for (const [key, value] of Object.entries(seed)) store.set(key, value);
	vi.resetModules();
	return (await import('./settings.svelte')).settings;
}

/** Provider stub: `values` answers by key (missing = never saved = null). */
function providerHolds(values: Record<string, string>): void {
	mocks.get.mockImplementation(async (key) => values[key] ?? null);
}

beforeEach(() => {
	store = new Map();
	rootStyle = new Map();
	vi.stubGlobal('localStorage', fakeStorage());
	vi.stubGlobal('document', {
		documentElement: {
			style: { setProperty: (name: string, value: string) => rootStyle.set(name, value) }
		}
	});
	mocks.get.mockReset();
	mocks.set.mockReset();
	mocks.set.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('settings: navigation layout and launcher opacity', () => {
	it('defaults to the sidebar and 50% with nothing stored', async () => {
		const settings = await loadSettings();
		expect(settings.navLayout).toBe('sidebar');
		expect(settings.launcherOpacity).toBe(50);
	});

	it('loads valid stored values', async () => {
		const settings = await loadSettings({
			'banto.navLayout': 'launcher',
			'banto.launcherOpacity': '80'
		});
		expect(settings.navLayout).toBe('launcher');
		expect(settings.launcherOpacity).toBe(80);
	});

	it.each([['dock'], ['']])('an unknown layout %j falls back to the default', async (stored) => {
		const settings = await loadSettings({ 'banto.navLayout': stored });
		expect(settings.navLayout).toBe('sidebar');
	});

	it.each([['35'], ['105'], ['42'], ['50.5'], ['abc'], ['-50']])(
		'an off-grid opacity %j falls back to the default',
		async (stored) => {
			const settings = await loadSettings({ 'banto.launcherOpacity': stored });
			expect(settings.launcherOpacity).toBe(50);
		}
	);

	it('init() writes the opacity token on the root element', async () => {
		const settings = await loadSettings({ 'banto.launcherOpacity': '70' });
		settings.init();
		expect(rootStyle.get(OPACITY_TOKEN)).toBe('70%');
	});

	it('setNavLayout writes localStorage and the provider', async () => {
		const settings = await loadSettings();
		settings.setNavLayout('launcher');
		expect(settings.navLayout).toBe('launcher');
		expect(store.get('banto.navLayout')).toBe('launcher');
		expect(mocks.set).toHaveBeenCalledWith('shell.navLayout', 'launcher');
	});

	it('previewLauncherOpacity applies live without a provider write; setLauncherOpacity commits', async () => {
		const settings = await loadSettings();
		settings.previewLauncherOpacity(65);
		expect(settings.launcherOpacity).toBe(65);
		expect(rootStyle.get(OPACITY_TOKEN)).toBe('65%');
		expect(store.get('banto.launcherOpacity')).toBe('65');
		expect(mocks.set).not.toHaveBeenCalled();

		settings.setLauncherOpacity(90);
		expect(rootStyle.get(OPACITY_TOKEN)).toBe('90%');
		expect(mocks.set).toHaveBeenCalledWith('shell.launcherOpacity', '90');
	});

	it('an off-grid opacity passed to the setter falls back to the default', async () => {
		const settings = await loadSettings({ 'banto.launcherOpacity': '80' });
		settings.setLauncherOpacity(33);
		expect(settings.launcherOpacity).toBe(50);
		expect(rootStyle.get(OPACITY_TOKEN)).toBe('50%');
		expect(mocks.set).toHaveBeenCalledWith('shell.launcherOpacity', '50');
	});

	it('syncFromProvider: the provider value wins over localStorage', async () => {
		const settings = await loadSettings({
			'banto.navLayout': 'sidebar',
			'banto.launcherOpacity': '50'
		});
		providerHolds({ 'shell.navLayout': 'launcher', 'shell.launcherOpacity': '75' });
		await settings.syncFromProvider();
		expect(settings.navLayout).toBe('launcher');
		expect(settings.launcherOpacity).toBe(75);
		expect(store.get('banto.navLayout')).toBe('launcher');
		expect(rootStyle.get(OPACITY_TOKEN)).toBe('75%');
		expect(mocks.set).not.toHaveBeenCalled();
	});

	it('syncFromProvider: nothing saved for this user resets both to the defaults, without writing back (§3)', async () => {
		const settings = await loadSettings({
			'banto.navLayout': 'launcher',
			'banto.launcherOpacity': '80'
		});
		providerHolds({});
		await settings.syncFromProvider();
		expect(settings.navLayout).toBe('sidebar');
		expect(settings.launcherOpacity).toBe(50);
		expect(store.get('banto.navLayout')).toBe('sidebar');
		expect(store.get('banto.launcherOpacity')).toBe('50');
		expect(rootStyle.get(OPACITY_TOKEN)).toBe('50%');
		expect(mocks.set).not.toHaveBeenCalled();
	});

	it('syncFromProvider: other settings keep the old rule (a missing key leaves them alone)', async () => {
		const settings = await loadSettings({ 'banto.kiosk': 'true' });
		providerHolds({});
		await settings.syncFromProvider();
		expect(settings.kiosk).toBe(true);
	});

	it('syncFromProvider: a failed read keeps the local values', async () => {
		const settings = await loadSettings({
			'banto.navLayout': 'launcher',
			'banto.launcherOpacity': '80'
		});
		mocks.get.mockRejectedValue(new Error('offline'));
		await settings.syncFromProvider();
		expect(settings.navLayout).toBe('launcher');
		expect(settings.launcherOpacity).toBe(80);
		expect(store.get('banto.navLayout')).toBe('launcher');
	});
});
