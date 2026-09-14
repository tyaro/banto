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
		// Module singleton (unlike the former page-local `$state(null)`): a
		// revisit of /settings would otherwise render the PREVIOUS response
		// while this fetch is pending (stale uptime/sessions/metrics, or
		// drafts seeded from an old AuthSettings that a save could then
		// overwrite). Reset first so consumers see "unknown" until it lands -
		// same lifecycle the old per-mount state had (Copilot review on PR #197).
		this.value = null;
		this.value = await getAuthSettings();
	}
}

export const authSettingsStore = new AuthSettingsStore();
