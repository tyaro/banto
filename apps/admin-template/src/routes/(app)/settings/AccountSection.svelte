<script lang="ts">
	/**
	 * アカウントカテゴリ（choiapp-feedback-2026-09 §3）: パスワード変更 /
	 * 自動ログイン。`+page.svelte` の `<section id="account">` ラッパーから
	 * 描画される（settings-split refactor: markup/state/CSS の移動のみ、
	 * 挙動は変えない）。
	 *
	 * `authSettingsStore`（authSettingsStore.svelte.ts）は
	 * SecuritySection.svelte と共有する - このセクションは自動ログインの
	 * 表示にだけ読み、有効化/無効化後は `load()` で再取得するのみ（disable
	 * mode 自体の draft/保存は SecuritySection が所有）。
	 */
	import { KeyRound } from '@lucide/svelte';
	import { getAuthProvider } from '@banto/admin-core';
	import * as m from '$lib/paraglide/messages';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';
	import { toastStore } from '$lib/toast.svelte';
	import { sessionStore } from '$lib/session.svelte';
	import { isAdmin } from '$lib/permissions';
	import { enableAutologin, disableAutologin } from '$lib/banto/authAdmin';
	import { errorMessage, tauri } from './shared';
	import { authSettingsStore } from './authSettingsStore.svelte';

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
			await authSettingsStore.load();
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
			await authSettingsStore.load();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			disablingAutologin = false;
		}
	}
</script>

<div class="settings-grid">
	<SurfaceCard>
		<div class="card-head">
			<KeyRound size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.passwordHeading']()}</h3>
				<p>{m['settings.passwordDesc']()}</p>
			</div>
		</div>
		{#if sessionStore.publicViewer}
			<!-- viewer-public-plan §3.1-6 (ADR-0012): "change-password は失敗
			     する（users に行が無い）" - this page is not in the
			     public-viewer nav allowlist so it should be unreachable
			     anyway; hide the account UI here too as a second line of
			     defense (belt-and-braces). -->
		{:else if sessionStore.authDisabled}
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
						{authSettingsStore.value?.autologinEnabled
							? m['settings.autologinEnabledWith']({
									username: authSettingsStore.value.autologinUsername ?? ''
								})
							: m['settings.autologinStatusDisabled']()}
					</strong>
				</p>

				{#if authSettingsStore.value?.autologinEnabled}
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
						<button type="submit" class="banto-btn banto-btn--primary" disabled={enablingAutologin}>
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
