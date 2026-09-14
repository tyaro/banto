/**
 * Shared `AuthSettings` (M11 login-not-required mode) load state. Module
 * singleton (same pattern as `$lib/session.svelte.ts`), needed here because
 * the settings-split refactor (choiapp-feedback-2026-09 §3) has THREE
 * readers of the same loaded value in different components:
 * - `AccountSection.svelte`'s autologin card (read-only; also refreshes it
 *   via `load()` after enabling/disabling autologin).
 * - `ConnectivitySection.svelte`'s LAN-toggle gating (read-only:
 *   `value?.disabled`).
 * - `SecuritySection.svelte`, which owns the mutating controls
 *   (`disabledDraft`/`disabledRoleDraft`), the initial load effect, and
 *   re-syncs its own drafts via its own `$effect` whenever `.value` changes
 *   here - including when AccountSection's autologin actions call `load()`.
 */
import { getAuthSettings, type AuthSettings } from '$lib/banto/authAdmin';

class AuthSettingsStore {
	value: AuthSettings | null = $state(null);

	async load(): Promise<void> {
		this.value = await getAuthSettings();
	}
}

export const authSettingsStore = new AuthSettingsStore();
