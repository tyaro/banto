<script lang="ts">
	import type { Component } from 'svelte';
	import type { ThemeDensity, ThemeMode, ThemePreset } from '@banto/theme';
	import {
		Check,
		DatabaseBackup,
		KeyRound,
		Languages,
		Monitor,
		Moon,
		Palette,
		Rows3,
		Rows4,
		ScrollText,
		Server,
		ShieldAlert,
		Sparkles,
		Sun,
		Wifi
	} from '@lucide/svelte';
	import { getAuthProvider, isProviderError } from '@banto/admin-core';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, locales, setLocale, type Locale } from '$lib/paraglide/runtime';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';
	import { settings } from '$lib/settings.svelte';
	import { isTauri } from '$lib/banto/setup';
	import { applyServerSettings, getServerStatus, type ServerStatus } from '$lib/banto/serverAdmin';
	import { applyVibrancy, getVibrancyStatus, type VibrancyStatus } from '$lib/banto/vibrancy';
	import {
		applyAuthSettings,
		disableAutologin,
		enableAutologin,
		getAuthSettings,
		type AuthDisabledRole,
		type AuthSettings
	} from '$lib/banto/authAdmin';
	import {
		getAuditConfig,
		isAuditLogAvailable,
		setAuditConfig,
		type AuditSettings
	} from '$lib/banto/auditLogAdmin';
	import { getSystemInfo, isSystemInfoAvailable, type SystemInfo } from '$lib/banto/systemAdmin';
	import {
		cancelPendingRestore,
		createBackup,
		downloadBackup,
		getPendingRestore,
		isBackupsAvailable,
		listBackups,
		openBackupsFolder,
		stageRestoreFromBackup,
		uploadAndStageRestore,
		type BackupInfo,
		type PendingRestoreInfo
	} from '$lib/banto/backupsAdmin';
	import { toastStore } from '$lib/toast.svelte';
	import { sessionStore } from '$lib/session.svelte';
	import { isAdmin } from '$lib/permissions';

	/**
	 * `validation` `ProviderError`s (e.g. a corrupt/foreign backup file
	 * rejected by `PRAGMA integrity_check`, spec M17) carry the server's
	 * actual reason in `field_errors`, not in `Error.message` (which is just
	 * the generic "validation failed" - see `packages/admin-core/src/errors.ts`'s
	 * `describe()`). Surface that reason instead so a toast shown from it is
	 * useful, not generic.
	 */
	function errorMessage(err: unknown): string {
		if (isProviderError(err)) {
			if (err.body.kind === 'validation' && err.body.field_errors.length > 0) {
				return err.body.field_errors.map((fe) => fe.message).join(' / ');
			}
			return err.message;
		}
		return String(err);
	}

	const modes: { value: ThemeMode; label: string }[] = [
		{ value: 'light', label: m['settings.modeLight']() },
		{ value: 'dark', label: m['settings.modeDark']() },
		{ value: 'system', label: m['settings.modeSystem']() }
	];

	// M12 preset axis (standard/glass), orthogonal to light/dark above.
	const presets: { value: ThemePreset; label: string }[] = [
		{ value: 'standard', label: m['settings.presetStandard']() },
		{ value: 'glass', label: m['settings.presetGlass']() }
	];

	// Density axis (visual-refresh-design.md §4.3), orthogonal to
	// theme/preset. settings.setThemeDensity() persistence is unchanged -
	// this page only adds the picker UI.
	const densities: { value: ThemeDensity; label: string }[] = [
		{ value: 'standard', label: m['settings.densityStandard']() },
		{ value: 'compact', label: m['settings.densityCompact']() }
	];

	const modeIcons: Record<ThemeMode, Component> = { light: Sun, dark: Moon, system: Monitor };
	const densityIcons: Record<ThemeDensity, Component> = { standard: Rows3, compact: Rows4 };

	// --- i18n layer ② (ADR-0005): the language picker ---------
	// Locale labels are shown in each language's OWN native name (日本語 /
	// English) rather than translated - a picker reads better when each option
	// names itself, so these two keys hold the same value in en.json and ja.json.
	// `getLocale()` is the resolved locale for this page load; changing it goes
	// through Paraglide's `setLocale()`, whose custom-banto strategy (locale.ts)
	// persists to localStorage + the M12 provider and reloads so every screen
	// re-renders in the new locale (the reload is Paraglide's default).
	const localeLabels: Record<Locale, () => string> = {
		ja: m['settings.languageJa'],
		en: m['settings.languageEn']
	};

	function changeLocale(next: Locale): void {
		if (next === getLocale()) return;
		setLocale(next);
	}

	// Optional on `AuthProvider` (spec §3.3): older/custom providers may not
	// implement it, in which case the section below shows a note instead of
	// the form (all three built-in providers - demo/Tauri/HTTP - do
	// implement it, demo's just always fails with a fixed message).
	const changePassword = getAuthProvider().changePassword;

	let currentPassword = $state('');
	let newPassword = $state('');
	let newPasswordConfirm = $state('');
	let passwordError: string | null = $state(null);
	let changingPassword = $state(false);

	async function submitChangePassword(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		passwordError = null;

		if (newPassword.length < 8) {
			passwordError = m['auth.passwordTooShort']();
			return;
		}
		if (newPassword !== newPasswordConfirm) {
			passwordError = m['auth.passwordMismatch']();
			return;
		}
		if (!changePassword) return;

		changingPassword = true;
		try {
			const result = await changePassword(currentPassword, newPassword);
			if (result.success) {
				currentPassword = '';
				newPassword = '';
				newPasswordConfirm = '';
				toastStore.push('success', m['settings.passwordChanged']());
			} else {
				passwordError = result.error ?? m['settings.passwordChangeFailed']();
			}
		} finally {
			changingPassword = false;
		}
	}

	// M6 Phase B (spec §11.4): the server controls only exist inside the Tauri
	// webview - a LAN browser client has nothing here to configure (it IS the
	// remote side of this same server). Decided once per page load; isTauri()
	// never changes at runtime.
	const tauri = isTauri();

	// --- M12: window vibrancy (Tauri only, admin only, Windows only) --------
	// The whole section renders only when `vibrancy_status()` reports
	// `supported: true` (spec §11.3: capability-hide, don't grey out).
	let vibrancyStatus = $state<VibrancyStatus | null>(null);
	let applyingVibrancy = $state(false);

	$effect(() => {
		if (!tauri || !isAdmin(sessionStore.role)) return;
		void (async () => {
			try {
				vibrancyStatus = await getVibrancyStatus();
			} catch {
				// An older backend without the command (Phase A not deployed
				// yet) or any failure: keep the section hidden, never broken.
				vibrancyStatus = null;
			}
		})();
	});

	async function toggleVibrancy(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const next = input.checked;
		applyingVibrancy = true;
		try {
			const enabled = await applyVibrancy(next);
			if (vibrancyStatus) vibrancyStatus = { ...vibrancyStatus, enabled };
		} catch (err) {
			toastStore.push('error', errorMessage(err));
			input.checked = vibrancyStatus?.enabled ?? false;
		} finally {
			applyingVibrancy = false;
		}
	}

	let serverStatus = $state<ServerStatus | null>(null);
	let bindDraft = $state('127.0.0.1');
	let portDraft = $state(8721);
	let enabledDraft = $state(false);
	let applying = $state(false);
	let serverError: string | null = $state(null);

	function applyStatusToDrafts(status: ServerStatus): void {
		serverStatus = status;
		enabledDraft = status.enabled;
		bindDraft = status.bind;
		portDraft = status.port;
	}

	$effect(() => {
		if (!tauri) return;
		void (async () => {
			try {
				applyStatusToDrafts(await getServerStatus());
			} catch (err) {
				serverError = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	async function saveAndApply(): Promise<void> {
		applying = true;
		serverError = null;
		try {
			applyStatusToDrafts(await applyServerSettings(enabledDraft, bindDraft, portDraft));
		} catch (err) {
			serverError = err instanceof Error ? err.message : String(err);
		} finally {
			applying = false;
		}
	}

	// The QR code shown is for the first LAN-reachable URL (i.e. not the
	// 127.0.0.1-only one) - that's the one another machine on the LAN would
	// actually need to scan; showing every URL's QR would just be noise.
	const firstLanUrl = $derived(
		serverStatus?.urls.find((url) => !url.includes('127.0.0.1')) ?? null
	);
	const firstLanQrSvg = $derived(
		firstLanUrl
			? (serverStatus?.qrSvgs.find((entry) => entry.url === firstLanUrl)?.svg ?? null)
			: null
	);

	// --- M11: login-not-required mode + desktop autologin (Tauri only) ------

	const authDisabledRoleOptions: { value: AuthDisabledRole; label: string }[] = [
		{ value: 'admin', label: m['role.admin']() },
		{ value: 'editor', label: m['role.editor']() },
		{ value: 'viewer', label: m['role.viewer']() }
	];

	let authSettings = $state<AuthSettings | null>(null);
	let disabledDraft = $state(false);
	let disabledRoleDraft = $state<AuthDisabledRole>('admin');
	let applyingAuth = $state(false);
	let authError: string | null = $state(null);

	function applyAuthSettingsToDrafts(next: AuthSettings): void {
		authSettings = next;
		disabledDraft = next.disabled;
		disabledRoleDraft = next.disabledRole;
	}

	async function reloadAuthSettings(): Promise<void> {
		applyAuthSettingsToDrafts(await getAuthSettings());
	}

	$effect(() => {
		if (!tauri) return;
		void (async () => {
			try {
				await reloadAuthSettings();
			} catch (err) {
				authError = errorMessage(err);
			}
		})();
	});

	// ESCAPE HATCH (spec M11, mirrors `auth_config_apply`'s Rust doc comment):
	// while login-not-required mode is CURRENTLY on, any role may still call
	// this - otherwise a synthetic session below `admin` (e.g. a kiosk set to
	// `viewer`) could never turn auth back on.
	const canManageAuthMode = $derived(isAdmin(sessionStore.role) || sessionStore.authDisabled);

	async function saveAuthSettings(): Promise<void> {
		if (disabledDraft && !window.confirm(m['settings.authDisableConfirm']())) {
			return;
		}

		applyingAuth = true;
		try {
			applyAuthSettingsToDrafts(await applyAuthSettings(disabledDraft, disabledRoleDraft));
			sessionStore.authDisabled = authSettings?.disabled ?? false;
			toastStore.push('success', m['settings.authSettingsUpdated']());
		} catch (err) {
			// 排他違反（LANアクセス有効中の有効化など）はサーバ側の日本語メッセージ
			// (kind: 'other') をそのままトーストに出す（spec M11）。
			toastStore.push('error', errorMessage(err));
		} finally {
			applyingAuth = false;
		}
	}

	let autologinUsername = $state('');
	let autologinPassword = $state('');
	let enablingAutologin = $state(false);
	let disablingAutologin = $state(false);

	async function submitEnableAutologin(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		enablingAutologin = true;
		try {
			await enableAutologin(autologinUsername, autologinPassword);
			autologinPassword = '';
			toastStore.push('success', m['settings.autologinEnabledToast']());
			await reloadAuthSettings();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			enablingAutologin = false;
		}
	}

	async function submitDisableAutologin(): Promise<void> {
		disablingAutologin = true;
		try {
			await disableAutologin();
			toastStore.push('success', m['settings.autologinDisabledToast']());
			await reloadAuthSettings();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			disablingAutologin = false;
		}
	}

	// --- M14: audit-log retention policy (Tauri + LAN browser) --------------
	// Unlike server/auth-mode settings above, this section is not
	// Tauri-only: `auditLogAdmin.ts` has a REST fallback
	// (`GET`/`PUT /api/audit-log/config`, spec M14 Phase B) so a LAN browser
	// admin can also see/change the retention policy, not just the desktop
	// app - so this section is gated on `auditAvailable` (real backend, not
	// the plain-browser demo) rather than `tauri`.
	const auditAvailable = isAuditLogAvailable();

	let auditConfig = $state<AuditSettings | null>(null);
	// 0 is the wire sentinel for "unlimited" on both fields (spec M14,
	// `SettingsService::set_audit_config`/`normalize_retention`) - shown to
	// the admin as a plain 0 with an explanatory note below, rather than a
	// separate checkbox, mirroring the Rust-side convention exactly.
	let retentionDaysDraft = $state(90);
	let retentionRowsDraft = $state(100_000);
	let applyingAudit = $state(false);
	let auditError: string | null = $state(null);

	function applyAuditConfigToDrafts(config: AuditSettings): void {
		auditConfig = config;
		retentionDaysDraft = config.retentionDays ?? 0;
		retentionRowsDraft = config.retentionRows ?? 0;
	}

	$effect(() => {
		if (!auditAvailable || !isAdmin(sessionStore.role)) return;
		void (async () => {
			try {
				applyAuditConfigToDrafts(await getAuditConfig());
			} catch (err) {
				auditError = errorMessage(err);
			}
		})();
	});

	async function saveAuditConfig(): Promise<void> {
		applyingAudit = true;
		auditError = null;
		try {
			applyAuditConfigToDrafts(
				await setAuditConfig({
					retentionDays: retentionDaysDraft > 0 ? retentionDaysDraft : null,
					retentionRows: retentionRowsDraft > 0 ? retentionRowsDraft : null
				})
			);
			toastStore.push('success', m['settings.auditUpdated']());
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			applyingAudit = false;
		}
	}

	// --- System Info (M-review 2026-08 §2.4, Tauri + LAN browser, admin only)
	// Read-only diagnostics: version, migration version, DB dialect+latency,
	// uptime, active LAN sessions, attachment storage. Same availability gate
	// as the audit/backups sections (real backend, not the plain-browser demo,
	// which has no live server to probe). Loaded once on mount for an admin.
	const systemInfoAvailable = isSystemInfoAvailable();

	let systemInfo = $state<SystemInfo | null>(null);
	let systemInfoError: string | null = $state(null);

	$effect(() => {
		if (!systemInfoAvailable || !isAdmin(sessionStore.role)) return;
		void (async () => {
			try {
				systemInfo = await getSystemInfo();
			} catch (err) {
				systemInfoError = errorMessage(err);
			}
		})();
	});

	// --- M17: SQLite backup/restore (Tauri + LAN browser, admin only) -------
	// Same availability gate as the audit-log section above (real backend,
	// not the plain-browser demo) - `backupsAdmin.ts`'s REST fallback means a
	// LAN browser admin gets this section too, not just the desktop app.
	const backupsAvailable = isBackupsAvailable();

	let backups = $state<BackupInfo[]>([]);
	let pendingRestore = $state<PendingRestoreInfo | null>(null);
	let loadingBackups = $state(false);
	let creatingBackup = $state(false);
	let stagingRestore = $state(false);
	let cancellingRestore = $state(false);
	let backupsError: string | null = $state(null);
	let restoreFileInput: HTMLInputElement | undefined = $state();

	// Built-in backup/restore is SQLite-only (V2 added PostgreSQL support to the
	// rest of the app, but not to the backup service, which errors explicitly on
	// PG). Swap the operation UI for a notice once the dialect is known via
	// System Info above; while it's unknown (demo mode, not yet loaded, or the
	// System Info fetch failed) keep showing the SQLite UI unchanged.
	const backupPostgresDialect = $derived(systemInfo?.dbDialect === 'postgres');

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let value = bytes;
		let unitIndex = -1;
		do {
			value /= 1024;
			unitIndex++;
		} while (value >= 1024 && unitIndex < units.length - 1);
		return `${value.toFixed(1)} ${units[unitIndex]}`;
	}

	async function reloadBackups(): Promise<void> {
		backups = await listBackups();
	}

	async function reloadPendingRestore(): Promise<void> {
		pendingRestore = await getPendingRestore();
	}

	$effect(() => {
		if (!backupsAvailable || !isAdmin(sessionStore.role)) return;
		void (async () => {
			loadingBackups = true;
			backupsError = null;
			try {
				await Promise.all([reloadBackups(), reloadPendingRestore()]);
			} catch (err) {
				backupsError = errorMessage(err);
			} finally {
				loadingBackups = false;
			}
		})();
	});

	async function handleCreateBackup(): Promise<void> {
		creatingBackup = true;
		backupsError = null;
		try {
			await createBackup();
			toastStore.push('success', m['backup.created']());
			await reloadBackups();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			creatingBackup = false;
		}
	}

	async function handleDownloadBackup(fileName: string): Promise<void> {
		try {
			await downloadBackup(fileName);
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		}
	}

	async function handleOpenBackupsFolder(): Promise<void> {
		try {
			const result = await openBackupsFolder();
			if (!result.opened) {
				toastStore.push('info', m['backup.openFolderUnsupported']({ path: result.path }));
			}
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		}
	}

	// Confirmation copy is fixed per spec M17 ("現在のデータは適用時に自動
	// バックアップされます。適用には再起動が必要です" must be explicit) -
	// only the leading line describing the source (existing file vs upload)
	// varies between the two callers below.
	function confirmRestore(sourceDescription: string): boolean {
		return window.confirm(m['backup.restoreConfirm']({ source: sourceDescription }));
	}

	async function handleRestoreFromExisting(fileName: string): Promise<void> {
		if (!confirmRestore(m['backup.restoreSourceExisting']({ fileName }))) return;
		stagingRestore = true;
		try {
			await stageRestoreFromBackup(fileName);
			toastStore.push('success', m['backup.restoreStaged']());
			await reloadPendingRestore();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			stagingRestore = false;
		}
	}

	function handleRestoreFileButtonClick(): void {
		restoreFileInput?.click();
	}

	async function handleRestoreFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file (e.g. after fixing it) later
		if (!file) return;
		if (!confirmRestore(m['backup.restoreSourceUpload']({ fileName: file.name }))) return;

		stagingRestore = true;
		try {
			await uploadAndStageRestore(file);
			toastStore.push('success', m['backup.restoreStaged']());
			await reloadPendingRestore();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			stagingRestore = false;
		}
	}

	async function handleCancelRestore(): Promise<void> {
		cancellingRestore = true;
		try {
			await cancelPendingRestore();
			toastStore.push('success', m['backup.restoreCancelled']());
			pendingRestore = null;
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			cancellingRestore = false;
		}
	}

	// --- Category sections (choiapp-feedback-2026-09 §3) -----------------------
	// Cards are grouped into titled category sections instead of one flat
	// grid. A section renders only when at least one of its cards does, and
	// the in-page category nav below mirrors exactly the rendered sections
	// (capability-hide, spec §11.3 - no greyed-out entries). Everything
	// stays on ONE page (anchor jumps, not tabs): every card keeps rendering
	// for the e2e smoke/visual/axe suites, and a settings page short enough
	// not to scroll simply ignores the anchors.
	const showConnectivity = $derived(isAdmin(sessionStore.role));
	const showData = $derived(isAdmin(sessionStore.role) && (auditAvailable || backupsAvailable));
	const showSecurity = $derived(tauri && canManageAuthMode);

	const sectionNavEntries = $derived(
		[
			{ id: 'appearance', label: m['settings.sectionAppearance'], visible: true },
			{ id: 'account', label: m['settings.sectionAccount'], visible: true },
			{ id: 'connectivity', label: m['settings.sectionConnectivity'], visible: showConnectivity },
			{ id: 'data', label: m['settings.sectionData'], visible: showData },
			{ id: 'security', label: m['settings.sectionSecurity'], visible: showSecurity }
		].filter((entry) => entry.visible)
	);
</script>

<div class="page">
	<PageHeader title={m['nav.settings']()} description={m['settings.pageDescription']()} />

	<nav class="section-nav" aria-label={m['settings.sectionNavAria']()}>
		{#each sectionNavEntries as entry (entry.id)}
			<a href="#{entry.id}">{entry.label()}</a>
		{/each}
	</nav>

	<section id="appearance" class="settings-section" aria-labelledby="appearance-heading">
		<h2 id="appearance-heading" class="section-heading">{m['settings.sectionAppearance']()}</h2>
		<div class="settings-grid">
			<SurfaceCard>
				<div class="card-head">
					<Palette size={20} aria-hidden="true" />
					<div>
						<h3>{m['settings.themeHeading']()}</h3>
						<p>{m['settings.themeDesc']()}</p>
					</div>
				</div>

				<div
					class="options mode-options"
					role="radiogroup"
					aria-label={m['settings.themeHeading']()}
				>
					{#each modes as mode (mode.value)}
						{@const ModeIcon = modeIcons[mode.value]}
						<label class="theme-option" class:selected={settings.themeMode === mode.value}>
							<input
								type="radio"
								name="theme"
								value={mode.value}
								checked={settings.themeMode === mode.value}
								onchange={() => settings.setThemeMode(mode.value)}
							/>
							<span class="theme-preview" data-preview-mode={mode.value} aria-hidden="true">
								<span class="preview-header"></span>
								<span class="preview-row">
									<span class="preview-sidebar"></span>
									<span class="preview-surface"></span>
								</span>
							</span>
							<ModeIcon size={14} aria-hidden="true" />{mode.label}
							{#if settings.themeMode === mode.value}
								<Check size={14} aria-hidden="true" />
							{/if}
						</label>
					{/each}
				</div>

				<h4>{m['settings.presetHeading']()}</h4>
				<div
					class="options preset-options"
					role="radiogroup"
					aria-label={m['settings.presetGroupAria']()}
				>
					{#each presets as preset (preset.value)}
						<label class="theme-option" class:selected={settings.themePreset === preset.value}>
							<input
								type="radio"
								name="theme-preset"
								value={preset.value}
								checked={settings.themePreset === preset.value}
								onchange={() => settings.setThemePreset(preset.value)}
							/>
							<span class="preset-preview" data-preset={preset.value} aria-hidden="true"></span>
							{preset.label}
							{#if settings.themePreset === preset.value}
								<Check size={14} aria-hidden="true" />
							{/if}
						</label>
					{/each}
				</div>

				<h4>{m['settings.densityHeading']()}</h4>
				<div
					class="options density-options"
					role="radiogroup"
					aria-label={m['settings.densityHeading']()}
				>
					{#each densities as density (density.value)}
						{@const DensityIcon = densityIcons[density.value]}
						<label class="theme-option" class:selected={settings.themeDensity === density.value}>
							<input
								type="radio"
								name="density"
								value={density.value}
								checked={settings.themeDensity === density.value}
								onchange={() => settings.setThemeDensity(density.value)}
							/>
							<DensityIcon size={16} aria-hidden="true" />{density.label}
							{#if settings.themeDensity === density.value}
								<Check size={14} aria-hidden="true" />
							{/if}
						</label>
					{/each}
				</div>

				<p class="note">
					{m['settings.themeNote']()}
				</p>
			</SurfaceCard>

			<SurfaceCard>
				<div class="card-head">
					<Languages size={20} aria-hidden="true" />
					<div>
						<h3>{m['settings.languageHeading']()}</h3>
						<p>{m['settings.languageDesc']()}</p>
					</div>
				</div>

				<label class="field">
					{m['settings.languageLabel']()}
					<select
						class="banto-input"
						value={getLocale()}
						onchange={(event) => changeLocale(event.currentTarget.value as Locale)}
					>
						{#each locales as loc (loc)}
							<option value={loc}>{localeLabels[loc]()}</option>
						{/each}
					</select>
				</label>

				<p class="note">
					{m['settings.languageNote']()}
				</p>
			</SurfaceCard>

			{#if tauri && isAdmin(sessionStore.role) && vibrancyStatus?.supported}
				<SurfaceCard>
					<div class="card-head">
						<Sparkles size={20} aria-hidden="true" />
						<div>
							<h3>{m['settings.vibrancyHeading']()}</h3>
							<p>{m['settings.vibrancyDesc']()}</p>
						</div>
					</div>
					<label class="switch-row">
						<input
							type="checkbox"
							role="switch"
							class="banto-switch"
							checked={vibrancyStatus.enabled}
							disabled={applyingVibrancy}
							onchange={toggleVibrancy}
						/>
						{m['settings.vibrancyToggle']()}
					</label>
					<p class="note">
						{m['settings.vibrancyNote']()}
					</p>
				</SurfaceCard>
			{/if}
		</div>
	</section>

	<section id="account" class="settings-section" aria-labelledby="account-heading">
		<h2 id="account-heading" class="section-heading">{m['settings.sectionAccount']()}</h2>
		<div class="settings-grid">
			<SurfaceCard>
				<div class="card-head">
					<KeyRound size={20} aria-hidden="true" />
					<div>
						<h3>{m['settings.passwordHeading']()}</h3>
						<p>{m['settings.passwordDesc']()}</p>
					</div>
				</div>
				{#if sessionStore.authDisabled}
					<p class="note">
						{m['settings.passwordChangeUnavailableAuth']()}
					</p>
				{:else if changePassword}
					<form onsubmit={submitChangePassword}>
						<label class="field">
							{m['settings.currentPassword']()}
							<input
								class="banto-input"
								type="password"
								bind:value={currentPassword}
								autocomplete="current-password"
							/>
						</label>
						<label class="field">
							{m['common.newPasswordMinLabel']()}
							<input
								class="banto-input"
								type="password"
								bind:value={newPassword}
								autocomplete="new-password"
							/>
						</label>
						<label class="field">
							{m['settings.newPasswordConfirm']()}
							<input
								class="banto-input"
								type="password"
								bind:value={newPasswordConfirm}
								autocomplete="new-password"
							/>
						</label>

						{#if passwordError}
							<p class="error">{passwordError}</p>
						{/if}

						<button type="submit" class="banto-btn banto-btn--primary" disabled={changingPassword}>
							{m['settings.changePassword']()}
						</button>
					</form>
				{:else}
					<p class="note">{m['settings.passwordChangeUnsupported']()}</p>
				{/if}
			</SurfaceCard>

			{#if tauri && isAdmin(sessionStore.role)}
				<SurfaceCard>
					<div class="card-head">
						<KeyRound size={20} aria-hidden="true" />
						<div>
							<h3>{m['settings.autologinHeading']()}</h3>
							<p>{m['settings.autologinDesc']()}</p>
						</div>
					</div>

					{#if sessionStore.authDisabled}
						<p class="note">{m['settings.autologinUnneeded']()}</p>
					{:else}
						<p class="status">
							{m['settings.statusLabel']()}
							<strong>
								{authSettings?.autologinEnabled
									? m['settings.autologinEnabledWith']({
											username: authSettings.autologinUsername ?? ''
										})
									: m['settings.autologinStatusDisabled']()}
							</strong>
						</p>

						{#if authSettings?.autologinEnabled}
							<button
								type="button"
								class="banto-btn banto-btn--secondary"
								onclick={submitDisableAutologin}
								disabled={disablingAutologin}
							>
								{m['settings.autologinDisable']()}
							</button>
						{:else}
							<form onsubmit={submitEnableAutologin}>
								<label class="field">
									{m['common.username']()}
									<input
										class="banto-input"
										type="text"
										bind:value={autologinUsername}
										autocomplete="username"
									/>
								</label>
								<label class="field">
									{m['common.password']()}
									<input
										class="banto-input"
										type="password"
										bind:value={autologinPassword}
										autocomplete="current-password"
									/>
								</label>
								<button
									type="submit"
									class="banto-btn banto-btn--primary"
									disabled={enablingAutologin}
								>
									{m['settings.autologinEnable']()}
								</button>
							</form>
						{/if}

						<p class="note">
							{m['settings.autologinNote']()}
						</p>
					{/if}
				</SurfaceCard>
			{/if}
		</div>
	</section>

	{#if showConnectivity}
		<section id="connectivity" class="settings-section" aria-labelledby="connectivity-heading">
			<h2 id="connectivity-heading" class="section-heading">
				{m['settings.sectionConnectivity']()}
			</h2>
			<div class="settings-grid">
				<SurfaceCard>
					<div class="card-head">
						<Wifi size={20} aria-hidden="true" />
						<div>
							<h3>{m['settings.lanHeading']()}</h3>
							<p>{m['settings.lanDesc']()}</p>
						</div>
					</div>
					{#if tauri}
						<label class="switch-row" class:disabled={authSettings?.disabled}>
							<input
								type="checkbox"
								role="switch"
								class="banto-switch"
								bind:checked={enabledDraft}
								disabled={authSettings?.disabled}
							/>
							{m['settings.lanToggle']()}
						</label>
						{#if authSettings?.disabled}
							<p class="note">{m['settings.lanDisabledByAuth']()}</p>
						{/if}

						<div class="server-fields">
							<label class="field">
								{m['settings.bindAddress']()}
								<select class="banto-input" bind:value={bindDraft}>
									<option value="127.0.0.1">{m['settings.bindLocalOnly']()}</option>
									<option value="0.0.0.0">{m['settings.bindLanPublic']()}</option>
								</select>
							</label>

							<label class="field">
								{m['settings.port']()}
								<input
									class="banto-input"
									type="number"
									min="1"
									max="65535"
									bind:value={portDraft}
								/>
							</label>
						</div>

						<button
							type="button"
							class="banto-btn banto-btn--primary"
							onclick={saveAndApply}
							disabled={applying}
						>
							{m['settings.saveAndApply']()}
						</button>

						{#if serverError}
							<p class="error">{serverError}</p>
						{/if}

						{#if serverStatus}
							<p class="status">
								{m['settings.statusLabel']()}
								<strong
									>{serverStatus.running
										? m['settings.running']()
										: m['settings.stopped']()}</strong
								>
							</p>
							{#if serverStatus.running}
								<ul class="urls">
									{#each serverStatus.urls as url (url)}
										<li><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
									{/each}
								</ul>
								{#if firstLanQrSvg}
									<!-- Server-generated QR SVG (Rust `qrcode` crate), not user input. -->
									<!-- eslint-disable-next-line svelte/no-at-html-tags -->
									<div class="qr">{@html firstLanQrSvg}</div>
								{/if}
							{/if}
						{/if}
					{:else}
						<p class="note">{m['settings.serverDesktopOnly']()}</p>
					{/if}
					<p class="note">
						{m['settings.lanNote']()}
					</p>
				</SurfaceCard>

				{#if systemInfoAvailable}
					<SurfaceCard>
						<div class="card-head">
							<Server size={20} aria-hidden="true" />
							<div>
								<h3>{m['settings.systemInfoHeading']()}</h3>
								<p>{m['settings.systemInfoDesc']()}</p>
							</div>
						</div>

						{#if systemInfoError}
							<p class="error">{systemInfoError}</p>
						{:else if systemInfo}
							<p class="status">
								{m['settings.systemInfoAppVersion']()} <strong>{systemInfo.appVersion}</strong>
							</p>
							<p class="status">
								{m['settings.systemInfoMigration']()}
								<strong>{systemInfo.migrationVersion ?? '—'}</strong>
							</p>
							<p class="status">
								{m['settings.systemInfoDatabase']()}
								<strong>
									{systemInfo.dbDialect} ({m['settings.systemInfoLatencyValue']({
										ms: systemInfo.dbLatencyMs.toFixed(1)
									})})
								</strong>
							</p>
							<p class="status">
								{m['settings.systemInfoUptime']()}
								<strong
									>{m['settings.systemInfoUptimeValue']({ secs: systemInfo.uptimeSecs })}</strong
								>
							</p>
							<p class="status">
								{m['settings.systemInfoSessions']()} <strong>{systemInfo.activeSessions}</strong>
							</p>
							<p class="status">
								{m['settings.systemInfoStorage']()}
								<strong>
									{systemInfo.attachmentBytes === null
										? '—'
										: formatBytes(systemInfo.attachmentBytes)}
								</strong>
							</p>
						{:else}
							<p class="note">{m['settings.systemInfoLoading']()}</p>
						{/if}

						<p class="note">{m['settings.systemInfoNote']()}</p>
					</SurfaceCard>
				{/if}
			</div>
		</section>
	{/if}

	{#if showData}
		<section id="data" class="settings-section" aria-labelledby="data-heading">
			<h2 id="data-heading" class="section-heading">{m['settings.sectionData']()}</h2>
			<div class="settings-grid">
				{#if auditAvailable}
					<SurfaceCard>
						<div class="card-head">
							<ScrollText size={20} aria-hidden="true" />
							<div>
								<h3>{m['settings.auditHeading']()}</h3>
								<p>{m['settings.auditDesc']()}</p>
							</div>
						</div>

						<div class="server-fields">
							<label class="field">
								{m['settings.retentionDays']()}
								<input class="banto-input" type="number" min="0" bind:value={retentionDaysDraft} />
							</label>
							<label class="field">
								{m['settings.retentionRows']()}
								<input class="banto-input" type="number" min="0" bind:value={retentionRowsDraft} />
							</label>
						</div>

						<button
							type="button"
							class="banto-btn banto-btn--primary"
							onclick={saveAuditConfig}
							disabled={applyingAudit}
						>
							{m['common.save']()}
						</button>

						{#if auditError}
							<p class="error">{auditError}</p>
						{/if}

						{#if auditConfig}
							<p class="status">
								{m['settings.currentConfig']()}
								<strong>
									{auditConfig.retentionDays !== null
										? m['audit.retentionDaysValue']({ days: auditConfig.retentionDays })
										: m['audit.retentionUnlimited']()}
									/ {auditConfig.retentionRows !== null
										? m['audit.retentionRowsValue']({
												rows: auditConfig.retentionRows.toLocaleString()
											})
										: m['audit.retentionRowsUnlimited']()}
								</strong>
							</p>
						{/if}

						<p class="note">
							{m['settings.auditNote']()}
						</p>
					</SurfaceCard>
				{/if}

				{#if backupsAvailable}
					<div class="danger-card">
						<SurfaceCard>
							<div class="card-head card-head--danger">
								<DatabaseBackup size={20} aria-hidden="true" />
								<div>
									<h3>{m['backup.heading']()}</h3>
									<p>{m['backup.desc']()}</p>
								</div>
							</div>

							{#if backupPostgresDialect}
								<p class="note">{m['backup.postgresNotice']()}</p>
							{:else}
								<div class="backup-toolbar">
									<button
										type="button"
										class="banto-btn banto-btn--primary"
										onclick={handleCreateBackup}
										disabled={creatingBackup}
									>
										{creatingBackup ? m['backup.creating']() : m['backup.createNow']()}
									</button>
									{#if tauri}
										<button
											type="button"
											class="banto-btn banto-btn--secondary"
											onclick={handleOpenBackupsFolder}
										>
											{m['backup.openFolder']()}
										</button>
									{/if}
								</div>

								{#if backupsError}
									<p class="error">{backupsError}</p>
								{/if}

								{#if pendingRestore}
									<p class="pending-restore">
										{m['backup.pendingApplied']()}<strong>{pendingRestore.stagedAt}</strong
										>（{formatBytes(pendingRestore.sizeBytes)}）
										<button
											type="button"
											class="banto-btn banto-btn--secondary"
											onclick={handleCancelRestore}
											disabled={cancellingRestore}
										>
											{m['backup.cancel']()}
										</button>
									</p>
								{/if}

								{#if loadingBackups}
									<p class="note">{m['common.loading']()}</p>
								{:else if backups.length === 0}
									<p class="note">{m['backup.empty']()}</p>
								{:else}
									<ul class="backup-list">
										{#each backups as backup (backup.fileName)}
											<li>
												<div class="backup-info">
													<span class="file-name">{backup.fileName}</span>
													<span class="meta"
														>{formatBytes(backup.sizeBytes)} ・ {backup.createdAt}</span
													>
												</div>
												<div class="backup-actions">
													{#if !tauri}
														<button
															type="button"
															class="banto-btn banto-btn--secondary"
															onclick={() => handleDownloadBackup(backup.fileName)}
														>
															{m['backup.download']()}
														</button>
													{/if}
													<button
														type="button"
														class="banto-btn banto-btn--danger"
														onclick={() => handleRestoreFromExisting(backup.fileName)}
														disabled={stagingRestore}
													>
														{m['backup.restoreFromThis']()}
													</button>
												</div>
											</li>
										{/each}
									</ul>
								{/if}

								{#if !tauri}
									<div class="restore-upload">
										<button
											type="button"
											class="banto-btn banto-btn--danger"
											onclick={handleRestoreFileButtonClick}
											disabled={stagingRestore}
										>
											{m['backup.restoreFromFile']()}
										</button>
										<input
											class="file-input"
											type="file"
											accept=".sqlite3"
											aria-label={m['backup.restoreFromFile']()}
											bind:this={restoreFileInput}
											onchange={handleRestoreFileChange}
										/>
									</div>
								{/if}

								<p class="note">
									{m['backup.note']()}
								</p>
							{/if}
						</SurfaceCard>
					</div>
				{/if}
			</div>
		</section>
	{/if}

	{#if showSecurity}
		<section id="security" class="settings-section" aria-labelledby="security-heading">
			<h2 id="security-heading" class="section-heading">{m['settings.sectionSecurity']()}</h2>
			<div class="settings-grid">
				<div class="danger-card">
					<SurfaceCard>
						<div class="card-head card-head--danger">
							<ShieldAlert size={20} aria-hidden="true" />
							<div>
								<h3>{m['settings.authDisableHeading']()}</h3>
								<p>{m['settings.authDisableDesc']()}</p>
							</div>
						</div>

						<label class="switch-row">
							<input
								type="checkbox"
								role="switch"
								class="banto-switch"
								bind:checked={disabledDraft}
							/>
							{m['settings.authDisableToggle']()}
						</label>

						<div class="server-fields">
							<label class="field">
								{m['settings.startupRole']()}
								<select
									class="banto-input"
									bind:value={disabledRoleDraft}
									disabled={!disabledDraft}
								>
									{#each authDisabledRoleOptions as option (option.value)}
										<option value={option.value}>{option.label}</option>
									{/each}
								</select>
							</label>
						</div>

						<button
							type="button"
							class="banto-btn banto-btn--primary"
							onclick={saveAuthSettings}
							disabled={applyingAuth}
						>
							{m['settings.saveAndApply']()}
						</button>

						{#if authError}
							<p class="error">{authError}</p>
						{/if}

						{#if authSettings}
							<p class="status">
								{m['settings.statusLabel']()}
								<strong
									>{authSettings.disabled
										? m['settings.authDisabledOn']()
										: m['settings.authDisabledOff']()}</strong
								>
							</p>
						{/if}

						<p class="note warning">
							{m['settings.authDisableNote']()}
						</p>
					</SurfaceCard>
				</div>
			</div>
		</section>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* In-page category jump nav (choiapp-feedback-2026-09 §3). Anchor links,
	   not tabs: every card stays rendered/scannable on one page. */
	.section-nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.section-nav a {
		padding: 0.3rem 0.7rem;
		border: 1px solid var(--banto-border);
		border-radius: 999px;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		font-weight: 600;
		text-decoration: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.section-nav a:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.section-nav a:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		/* Anchor jumps land below the sticky app header (Header.svelte). */
		scroll-margin-top: calc(var(--banto-shell-header-height) + 0.75rem);
	}

	.section-heading {
		margin: 0.5rem 0 0;
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--banto-text-muted);
	}

	.settings-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
		align-items: start;
		gap: 1rem;
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		margin-bottom: 0.25rem;
		color: var(--banto-text-muted);
	}

	.card-head h3 {
		margin: 0;
		font-size: 1rem;
		color: var(--banto-text);
	}

	.card-head p {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
	}

	.card-head--danger {
		color: var(--banto-danger);
	}

	h4 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 1rem 0 0.5rem;
		font-size: 0.875rem;
		color: var(--banto-text-muted);
	}

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.theme-option {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.4rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.theme-option.selected {
		border-color: var(--banto-primary);
		/* axe-core wcag2aa color-contrast (visual-refresh-plan.md §7.1): same
		   fix as Sidebar.svelte's .nav-item.active - plain --banto-primary text
		   on this tint background falls short of 4.5:1 (light theme). */
		color: var(--banto-primary-hover);
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
	}

	.theme-option input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	/* Mode picker previews intentionally hardcode static light/dark swatches
	   (visual-refresh-design.md §10): each card must always depict what
	   light/dark looks like, regardless of the CURRENTLY active theme - live
	   --banto-* tokens only ever hold one theme's values at a time, so they
	   can't represent "the other" theme here. Values mirror
	   packages/theme/src/css/banto.css's :root / [data-theme='dark'] blocks. */
	.theme-preview {
		flex-basis: 100%;
		display: flex;
		flex-direction: column;
		width: 80px;
		height: 48px;
		overflow: hidden;
		border: 1px solid var(--preview-border, var(--banto-border));
		border-radius: var(--banto-radius-sm);
		background: var(--preview-bg, var(--banto-surface));
	}

	.theme-preview .preview-header {
		height: 10px;
		background: var(--preview-header, var(--banto-surface));
		border-bottom: 1px solid var(--preview-border, var(--banto-border));
	}

	.theme-preview .preview-row {
		display: flex;
		flex: 1;
	}

	.theme-preview .preview-sidebar {
		width: 30%;
		background: var(--preview-sidebar, var(--banto-surface-subtle));
	}

	.theme-preview .preview-surface {
		flex: 1;
		background: var(--preview-surface-bg, var(--banto-surface));
	}

	.theme-preview[data-preview-mode='light'] {
		--preview-bg: #f6f7f9;
		--preview-header: #ffffff;
		--preview-sidebar: #eef1f5;
		--preview-surface-bg: #ffffff;
		--preview-border: #d9dde3;
	}

	.theme-preview[data-preview-mode='dark'] {
		--preview-bg: #15171b;
		--preview-header: #1e2127;
		--preview-sidebar: #23262d;
		--preview-surface-bg: #1e2127;
		--preview-border: #363b44;
	}

	.theme-preview[data-preview-mode='system'] {
		background: linear-gradient(135deg, #f6f7f9 0%, #f6f7f9 48%, #15171b 52%, #15171b 100%);
		border-color: var(--banto-border);
	}

	.theme-preview[data-preview-mode='system'] .preview-header,
	.theme-preview[data-preview-mode='system'] .preview-sidebar,
	.theme-preview[data-preview-mode='system'] .preview-surface {
		background: transparent;
		border-color: transparent;
	}

	/* Preset previews use live tokens (unlike the mode previews above): glass
	   vs standard is orthogonal to light/dark, so showing the CURRENT theme's
	   real surface/accent tokens with a fixed illustrative blur is enough to
	   convey the difference without hardcoding colors. */
	.preset-preview {
		flex-basis: 100%;
		position: relative;
		width: 80px;
		height: 48px;
		overflow: hidden;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-sm);
		background: var(--banto-accent-gradient);
	}

	.preset-preview::after {
		content: '';
		position: absolute;
		inset: 8px;
		border-radius: var(--banto-radius-sm);
		background: var(--banto-surface);
	}

	.preset-preview[data-preset='glass']::after {
		background: color-mix(in srgb, var(--banto-surface) 55%, transparent);
		backdrop-filter: blur(3px);
		-webkit-backdrop-filter: blur(3px);
	}

	.switch-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.switch-row.disabled {
		cursor: not-allowed;
		color: var(--banto-text-muted);
	}

	/* Common boolean-switch look (plan Phase 5: "boolean 設定は共通のスイッチ
	   表現へ揃える"). role="switch" is set on each usage site; the change
	   handlers/bindings there are unmodified. */
	.banto-switch {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		width: 36px;
		height: 20px;
		margin: 0;
		appearance: none;
		border: none;
		border-radius: 999px;
		background: var(--banto-border-strong);
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.banto-switch::before {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--banto-surface);
		transition: transform var(--banto-duration-fast) var(--banto-ease-out);
	}

	.banto-switch:checked {
		background: var(--banto-primary-solid);
	}

	.banto-switch:checked::before {
		transform: translateX(16px);
	}

	.banto-switch:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.banto-switch:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.server-fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.75rem 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 320px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
	}

	.backup-toolbar {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.pending-restore {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 0.75rem 0 0;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--banto-primary);
		border-radius: var(--banto-radius-md);
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
		font-size: 0.85rem;
	}

	.backup-list {
		list-style: none;
		margin: 0.75rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.backup-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.backup-info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.backup-info .file-name {
		font-size: 0.85rem;
		font-weight: 600;
		word-break: break-all;
	}

	.backup-info .meta {
		font-size: 0.75rem;
		color: var(--banto-text-muted);
	}

	.backup-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.restore-upload {
		margin-top: 0.75rem;
	}

	/* Visually hidden but still focusable/clickable via
	   restoreFileInput?.click() - same approach as the items page's CSVイン
	   ポート file input (spec M15). */
	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.status {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
	}

	.urls {
		margin: 0.4rem 0 0;
		padding-left: 1.2rem;
		font-size: 0.8rem;
	}

	.urls a {
		color: var(--banto-primary);
	}

	.qr {
		margin-top: 0.75rem;
		width: fit-content;
		/* Fixed white, not a --banto-* surface var: a QR code must stay
		   black-on-white to stay scannable in dark mode too. */
		background: #fff;
		padding: 0.5rem;
		border-radius: var(--banto-radius-md);
	}

	.error {
		margin: 0.5rem 0 0;
		color: var(--banto-danger);
		font-size: 0.8rem;
	}

	.note {
		margin: 0.75rem 0 0;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.note.warning {
		color: var(--banto-danger);
	}

	/* High-impact cards (successor of plan Phase 5's danger zone; the choi-app
	   feedback 2026-09 recategorization moved its cards into their own
	   categories - backup/restore under data, auth disable under security).
	   Only styling; every action inside keeps its original handler/confirm
	   dialog. */
	.danger-card :global(.surface-card) {
		border-color: var(--banto-danger);
	}
</style>
