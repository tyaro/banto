/**
 * Shared `SystemInfo` (M-review 2026-08 §2.4) load state. Module singleton
 * (same "module singleton populated once, read from anywhere" pattern as
 * `$lib/session.svelte.ts`/`$lib/settings.svelte.ts`), needed here because
 * the settings-split refactor (choiapp-feedback-2026-09 §3) put its two
 * readers in different components:
 * - `ConnectivitySection.svelte`'s System Info card, which owns the load
 *   effect (mirrors the audit/backups cards' availability gate).
 * - `DataSection.svelte`'s `backupPostgresDialect` gate (spec M17: built-in
 *   backup/restore is SQLite-only).
 *
 * `isBackupsAvailable()`/`isSystemInfoAvailable()` share the exact same
 * "real backend, not the plain-browser demo" condition, so whenever
 * DataSection's backups card can render, ConnectivitySection's System Info
 * card is also present (admin-gated like DataSection, but unconditionally
 * rendered for any admin - see `+page.svelte`'s `showConnectivity`) and has
 * already kicked off this load.
 */
import { getSystemInfo, isSystemInfoAvailable, type SystemInfo } from '$lib/banto/systemAdmin';

class SystemInfoStore {
	readonly available = isSystemInfoAvailable();
	value: SystemInfo | null = $state(null);

	async load(): Promise<void> {
		// Module singleton (unlike the former page-local `$state(null)`): a
		// revisit of /settings would otherwise render the PREVIOUS response
		// while this fetch is pending (stale uptime/sessions/metrics, or
		// drafts seeded from an old AuthSettings that a save could then
		// overwrite). Reset first so consumers see "unknown" until it lands -
		// same lifecycle the old per-mount state had (Copilot review on PR #197).
		this.value = null;
		this.value = await getSystemInfo();
	}
}

export const systemInfoStore = new SystemInfoStore();
