<script lang="ts">
	import type { Component } from 'svelte';
	import type { ThemeDensity, ThemeMode, ThemePreset } from '@banto/theme';
	import {
		Check,
		DatabaseBackup,
		KeyRound,
		Monitor,
		Moon,
		Palette,
		Rows3,
		Rows4,
		ScrollText,
		ShieldAlert,
		Sparkles,
		Sun,
		Wifi
	} from '@lucide/svelte';
	import { getAuthProvider, isProviderError } from '@banto/admin-core';
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
		{ value: 'light', label: 'ライト' },
		{ value: 'dark', label: 'ダーク' },
		{ value: 'system', label: 'システムに従う' }
	];

	// M12 preset axis (standard/glass), orthogonal to light/dark above.
	const presets: { value: ThemePreset; label: string }[] = [
		{ value: 'standard', label: 'スタンダード' },
		{ value: 'glass', label: 'ガラス' }
	];

	// Density axis (visual-refresh-design.md §4.3), orthogonal to
	// theme/preset. settings.setThemeDensity() persistence is unchanged -
	// this page only adds the picker UI.
	const densities: { value: ThemeDensity; label: string }[] = [
		{ value: 'standard', label: '標準' },
		{ value: 'compact', label: 'コンパクト' }
	];

	const modeIcons: Record<ThemeMode, Component> = { light: Sun, dark: Moon, system: Monitor };
	const densityIcons: Record<ThemeDensity, Component> = { standard: Rows3, compact: Rows4 };

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
			passwordError = 'パスワードは8文字以上で入力してください';
			return;
		}
		if (newPassword !== newPasswordConfirm) {
			passwordError = 'パスワードが一致しません';
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
				toastStore.push('success', 'パスワードを変更しました');
			} else {
				passwordError = result.error ?? 'パスワードの変更に失敗しました';
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
		{ value: 'admin', label: '管理者' },
		{ value: 'editor', label: '編集者' },
		{ value: 'viewer', label: '閲覧者' }
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
		if (
			disabledDraft &&
			!window.confirm(
				'ログイン不要モードを有効にすると、この端末を開いた人は誰でもログインなしで操作できるようになります。この端末を完全に信頼できる場合のみ続行してください。'
			)
		) {
			return;
		}

		applyingAuth = true;
		try {
			applyAuthSettingsToDrafts(await applyAuthSettings(disabledDraft, disabledRoleDraft));
			sessionStore.authDisabled = authSettings?.disabled ?? false;
			toastStore.push('success', '認証設定を更新しました');
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
			toastStore.push('success', '自動ログインを有効にしました');
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
			toastStore.push('success', '自動ログインを解除しました');
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
			toastStore.push('success', '監査ログの保持ポリシーを更新しました');
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			applyingAudit = false;
		}
	}

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
			toastStore.push('success', 'バックアップを作成しました');
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
				toastStore.push('info', `このOSでは非対応です。手動で開いてください: ${result.path}`);
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
		return window.confirm(
			`${sourceDescription}\n\n現在のデータは適用時に自動バックアップされます。適用には再起動が必要です。よろしいですか？`
		);
	}

	async function handleRestoreFromExisting(fileName: string): Promise<void> {
		if (!confirmRestore(`このバックアップからリストアします: ${fileName}`)) return;
		stagingRestore = true;
		try {
			await stageRestoreFromBackup(fileName);
			toastStore.push('success', 'リストアをステージしました（再起動後に適用されます）');
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
		if (!confirmRestore(`アップロードしたファイルからリストアします: ${file.name}`)) return;

		stagingRestore = true;
		try {
			await uploadAndStageRestore(file);
			toastStore.push('success', 'リストアをステージしました（再起動後に適用されます）');
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
			toastStore.push('success', 'リストアの予約を取り消しました');
			pendingRestore = null;
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			cancellingRestore = false;
		}
	}
</script>

<div class="page">
	<PageHeader title="設定" description="テーマ、LANアクセス、バックアップなど、この端末の動作を設定します。" />

	<div class="settings-grid">
		<SurfaceCard>
			<div class="card-head">
				<Palette size={20} aria-hidden="true" />
				<div>
					<h2>テーマ</h2>
					<p>配色モード・プリセット・表示密度を切り替えます。</p>
				</div>
			</div>

			<div class="options mode-options" role="radiogroup" aria-label="テーマ">
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

			<h3>プリセット</h3>
			<div class="options preset-options" role="radiogroup" aria-label="テーマプリセット">
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

			<h3>表示密度</h3>
			<div class="options density-options" role="radiogroup" aria-label="表示密度">
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
				設定はこの端末に即時保存され、ログイン中は設定DB（Tauri/LANサーバ）にも保存されて他クライアントと共有されます（仕様
				§12.1 / M12）。
			</p>
		</SurfaceCard>

		{#if tauri && isAdmin(sessionStore.role) && vibrancyStatus?.supported}
			<SurfaceCard>
				<div class="card-head">
					<Sparkles size={20} aria-hidden="true" />
					<div>
						<h2>ウィンドウ効果</h2>
						<p>デスクトップアプリのウィンドウ背面の描画です（Windowsのみ）。</p>
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
					ウィンドウのアクリル効果（Windows）
				</label>
				<p class="note">
					ウィンドウ背面を OS
					のアクリル（すりガラス）効果で描画します。ガラスプリセットと組み合わせると、デスクトップが透ける本物のガラス感になります（M12、Windows
					のみ）。
				</p>
			</SurfaceCard>
		{/if}

		{#if isAdmin(sessionStore.role)}
			<SurfaceCard>
				<div class="card-head">
					<Wifi size={20} aria-hidden="true" />
					<div>
						<h2>LANアクセス（組み込みWebサーバ）</h2>
						<p>同一LAN内の他端末のブラウザからこの画面を利用できるようにします。</p>
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
						LANアクセスを有効にする
					</label>
					{#if authSettings?.disabled}
						<p class="note">ログイン不要モード有効中は使用できません。</p>
					{/if}

					<div class="server-fields">
						<label class="field">
							バインドアドレス
							<select class="banto-input" bind:value={bindDraft}>
								<option value="127.0.0.1">127.0.0.1 のみ</option>
								<option value="0.0.0.0">0.0.0.0（LAN公開）</option>
							</select>
						</label>

						<label class="field">
							ポート番号
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
						保存して適用
					</button>

					{#if serverError}
						<p class="error">{serverError}</p>
					{/if}

					{#if serverStatus}
						<p class="status">
							状態: <strong>{serverStatus.running ? '稼働中' : '停止中'}</strong>
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
					<p class="note">サーバー設定はデスクトップアプリでのみ変更できます。</p>
				{/if}
				<p class="note">
					有効化すると、同一LAN内の他端末のブラウザからREST API + SSEで同じ画面を利用できます（仕様
					§11）。信頼できるLANでのみ有効にしてください。
				</p>
			</SurfaceCard>
		{/if}

		{#if tauri && isAdmin(sessionStore.role)}
			<SurfaceCard>
				<div class="card-head">
					<KeyRound size={20} aria-hidden="true" />
					<div>
						<h2>自動ログイン</h2>
						<p>起動時に指定アカウントで自動的にログインします（デスクトップのみ）。</p>
					</div>
				</div>

				{#if sessionStore.authDisabled}
					<p class="note">ログイン不要モードでは自動ログインは不要です。</p>
				{:else}
					<p class="status">
						状態:
						<strong>
							{authSettings?.autologinEnabled
								? `有効（${authSettings.autologinUsername ?? ''}）`
								: '無効'}
						</strong>
					</p>

					{#if authSettings?.autologinEnabled}
						<button
							type="button"
							class="banto-btn banto-btn--secondary"
							onclick={submitDisableAutologin}
							disabled={disablingAutologin}
						>
							自動ログインを解除
						</button>
					{:else}
						<form onsubmit={submitEnableAutologin}>
							<label class="field">
								ユーザー名
								<input
									class="banto-input"
									type="text"
									bind:value={autologinUsername}
									autocomplete="username"
								/>
							</label>
							<label class="field">
								パスワード
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
								自動ログインを有効化
							</button>
						</form>
					{/if}

					<p class="note">
						資格情報はOSのキーリングに保存されます。起動時にこのアカウントで自動的にログインします。
					</p>
				{/if}
			</SurfaceCard>
		{/if}

		{#if auditAvailable && isAdmin(sessionStore.role)}
			<SurfaceCard>
				<div class="card-head">
					<ScrollText size={20} aria-hidden="true" />
					<div>
						<h2>監査ログの保持ポリシー</h2>
						<p>記録を自動的に整理する保持日数・上限行数を設定します。</p>
					</div>
				</div>

				<div class="server-fields">
					<label class="field">
						保持日数
						<input class="banto-input" type="number" min="0" bind:value={retentionDaysDraft} />
					</label>
					<label class="field">
						上限行数
						<input class="banto-input" type="number" min="0" bind:value={retentionRowsDraft} />
					</label>
				</div>

				<button
					type="button"
					class="banto-btn banto-btn--primary"
					onclick={saveAuditConfig}
					disabled={applyingAudit}
				>
					保存
				</button>

				{#if auditError}
					<p class="error">{auditError}</p>
				{/if}

				{#if auditConfig}
					<p class="status">
						現在の設定:
						<strong>
							{auditConfig.retentionDays !== null ? `${auditConfig.retentionDays}日` : '無期限'}
							/ {auditConfig.retentionRows !== null
								? `${auditConfig.retentionRows.toLocaleString()}件`
								: '無制限'}
						</strong>
					</p>
				{/if}

				<p class="note">
					0を入力すると、その項目は無制限になります（既定は90日 /
					10万件）。古い記録は一覧の表示時に自動的に整理されます。記録の一覧は「監査ログ」画面から確認できます。
				</p>
			</SurfaceCard>
		{/if}

		<div class="danger-zone">
			<SurfaceCard>
				<div class="card-head card-head--danger">
					<ShieldAlert size={20} aria-hidden="true" />
					<div>
						<h2>Danger zone</h2>
						<p>影響の大きい操作です。実行前に内容をよく確認してください。</p>
					</div>
				</div>

				{#if tauri && canManageAuthMode}
					<div class="danger-section">
						<h3>認証を無効化</h3>

						<label class="switch-row">
							<input
								type="checkbox"
								role="switch"
								class="banto-switch"
								bind:checked={disabledDraft}
							/>
							ログイン不要モードを有効にする
						</label>

						<div class="server-fields">
							<label class="field">
								起動時のロール
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
							保存して適用
						</button>

						{#if authError}
							<p class="error">{authError}</p>
						{/if}

						{#if authSettings}
							<p class="status">
								状態: <strong
									>{authSettings.disabled
										? '有効（ログイン画面なし）'
										: '無効（通常のログインが必要）'}</strong
								>
							</p>
						{/if}

						<p class="note warning">
							この端末を完全に信頼できる場合のみ有効化してください。LANアクセスとは同時に有効化できません。
						</p>
					</div>
				{/if}

				{#if backupsAvailable && isAdmin(sessionStore.role)}
					<div class="danger-section">
						<h3><DatabaseBackup size={14} aria-hidden="true" />バックアップ/リストア</h3>

						<div class="backup-toolbar">
							<button
								type="button"
								class="banto-btn banto-btn--primary"
								onclick={handleCreateBackup}
								disabled={creatingBackup}
							>
								{creatingBackup ? '作成中…' : '今すぐバックアップ'}
							</button>
							{#if tauri}
								<button
									type="button"
									class="banto-btn banto-btn--secondary"
									onclick={handleOpenBackupsFolder}
								>
									フォルダを開く
								</button>
							{/if}
						</div>

						{#if backupsError}
							<p class="error">{backupsError}</p>
						{/if}

						{#if pendingRestore}
							<p class="pending-restore">
								再起動後に適用されます: <strong>{pendingRestore.stagedAt}</strong>（{formatBytes(
									pendingRestore.sizeBytes
								)}）
								<button
									type="button"
									class="banto-btn banto-btn--secondary"
									onclick={handleCancelRestore}
									disabled={cancellingRestore}
								>
									取消
								</button>
							</p>
						{/if}

						{#if loadingBackups}
							<p class="note">読み込み中…</p>
						{:else if backups.length === 0}
							<p class="note">バックアップはまだありません。</p>
						{:else}
							<ul class="backup-list">
								{#each backups as backup (backup.fileName)}
									<li>
										<div class="backup-info">
											<span class="file-name">{backup.fileName}</span>
											<span class="meta">{formatBytes(backup.sizeBytes)} ・ {backup.createdAt}</span
											>
										</div>
										<div class="backup-actions">
											{#if !tauri}
												<button
													type="button"
													class="banto-btn banto-btn--secondary"
													onclick={() => handleDownloadBackup(backup.fileName)}
												>
													ダウンロード
												</button>
											{/if}
											<button
												type="button"
												class="banto-btn banto-btn--danger"
												onclick={() => handleRestoreFromExisting(backup.fileName)}
												disabled={stagingRestore}
											>
												このバックアップからリストア
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
									ファイルからリストア
								</button>
								<input
									class="file-input"
									type="file"
									accept=".sqlite3"
									bind:this={restoreFileInput}
									onchange={handleRestoreFileChange}
								/>
							</div>
						{/if}

						<p class="note">
							DBファイル横の backups/ ディレクトリにオンラインバックアップを作成します（VACUUM
							INTO、稼働中でも安全）。リストアはアップロード/選択したファイルを検証（整合性チェック+スキーマ確認）した上でステージし、次回起動時に自動適用します（稼働中のDB差し替えは行いません）。適用直前の現DBは自動的にバックアップされます（仕様
							M17）。
						</p>
					</div>
				{/if}

				<div class="danger-section">
					<h3>アカウント（パスワード変更）</h3>
					{#if sessionStore.authDisabled}
						<p class="note">ログイン不要モードではアカウントがないため、パスワード変更はできません。</p>
					{:else if changePassword}
						<form onsubmit={submitChangePassword}>
							<label class="field">
								現在のパスワード
								<input
									class="banto-input"
									type="password"
									bind:value={currentPassword}
									autocomplete="current-password"
								/>
							</label>
							<label class="field">
								新しいパスワード（8文字以上）
								<input
									class="banto-input"
									type="password"
									bind:value={newPassword}
									autocomplete="new-password"
								/>
							</label>
							<label class="field">
								新しいパスワード（確認）
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

							<button
								type="submit"
								class="banto-btn banto-btn--primary"
								disabled={changingPassword}
							>
								パスワードを変更
							</button>
						</form>
					{:else}
						<p class="note">この環境ではパスワード変更に対応していません。</p>
					{/if}
				</div>
			</SurfaceCard>
		</div>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
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

	.card-head h2 {
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

	h3 {
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
		color: var(--banto-primary);
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

	/* Danger zone (plan Phase 5): high-impact operations - auth disable,
	   restore, password change - grouped and visually separated with the
	   danger border. Only styling; every action inside keeps its original
	   handler/confirm dialog. */
	.danger-zone {
		grid-column: 1 / -1;
	}

	.danger-zone :global(.surface-card) {
		border-color: var(--banto-danger);
	}

	.danger-section + .danger-section {
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--banto-border);
	}
</style>
