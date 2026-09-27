import { describe, expect, it, vi } from 'vitest';

/**
 * Issue #244: `systemInfoStore.available` used to be a `readonly` field
 * (`readonly available = isSystemInfoAvailable();`), evaluated exactly once
 * when this module was first imported. Route-level code splitting can import
 * this module before `bantoReady` (setup.ts) resolves and sets the real
 * `getBantoMode()` result - the field then froze at the default `'demo'`
 * reading (`available === false`) forever, hiding the System Info card and
 * skipping its `settings/+layout.svelte` load effect (E2E 11a flake).
 *
 * This mocks `$lib/banto/setup` (a mutable `mode` the test controls) so it
 * can reproduce that exact ordering: import the store while the mode is
 * still `'demo'` (module loaded ahead of `bantoReady`), THEN flip the mode
 * to `'server'` (bantoReady resolves) without re-importing the module - the
 * regression is `available` never reflecting that later flip.
 */
const setupMock = vi.hoisted(() => ({ mode: 'demo' as 'demo' | 'server' | 'tauri' }));

vi.mock('$lib/banto/setup', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode
}));

describe('systemInfoStore.available (Issue #244)', () => {
	it('reflects a mode change to server AFTER import, without a re-import', async () => {
		setupMock.mode = 'demo'; // simulates this module loading before bantoReady resolves
		vi.resetModules();
		const { systemInfoStore } = await import('./systemInfoStore.svelte');

		expect(systemInfoStore.available).toBe(false);

		setupMock.mode = 'server'; // simulates bantoReady resolving with a real backend
		expect(systemInfoStore.available).toBe(true);
	});

	it('is false again once demo mode is current, still without a re-import', async () => {
		setupMock.mode = 'server';
		vi.resetModules();
		const { systemInfoStore } = await import('./systemInfoStore.svelte');

		expect(systemInfoStore.available).toBe(true);

		setupMock.mode = 'demo';
		expect(systemInfoStore.available).toBe(false);
	});
});
