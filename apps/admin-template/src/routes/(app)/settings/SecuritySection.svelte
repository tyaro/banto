<script lang="ts">
	/**
	 * セキュリティカテゴリ（choiapp-feedback-2026-09 §3）: 認証を無効化（M11の
	 * escape hatch 含む）。`+page.svelte` の `<section id="security">`
	 * ラッパー（Tauri かつ管理可）から描画される（settings-split refactor:
	 * markup/state/CSS の移動のみ、挙動は変えない）。
	 *
	 * このセクションが `authSettingsStore`（authSettingsStore.svelte.ts、
	 * AccountSection.svelte / ConnectivitySection.svelte とも共有）の初期
	 * ロード effect と、実際にモードを変更する唯一のコントロールを持つ。
	 * `disabledDraft`/`disabledRoleDraft` は `authSettingsStore.value` が
	 * 変わるたび（このセクション自身の保存でも、AccountSection の自動ログイン
	 * 操作による再取得でも）下の `$effect` で再同期する - 元の単一
	 * `applyAuthSettingsToDrafts()` が両方を同時に更新していたのと同じ結合を
	 * 保つため。
	 */
	import { ShieldAlert } from '@lucide/svelte';
	import * as m from '$lib/paraglide/messages';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';
	import { applyAuthSettings, type AuthDisabledRole } from '$lib/banto/authAdmin';
	import { toastStore } from '$lib/toast.svelte';
	import { sessionStore } from '$lib/session.svelte';
	import { errorMessage, tauri } from './shared';
	import { authSettingsStore } from './authSettingsStore.svelte';

	const authDisabledRoleOptions: { value: AuthDisabledRole; label: string }[] = [
		{ value: 'admin', label: m['role.admin']() },
		{ value: 'editor', label: m['role.editor']() },
		{ value: 'viewer', label: m['role.viewer']() }
	];

	let disabledDraft = $state(false);
	let disabledRoleDraft = $state<AuthDisabledRole>('admin');
	let applyingAuth = $state(false);
	let authError: string | null = $state(null);

	$effect(() => {
		if (!tauri) return;
		void (async () => {
			try {
				await authSettingsStore.load();
			} catch (err) {
				authError = errorMessage(err);
			}
		})();
	});

	// Keep the disable-mode drafts in sync with the shared AuthSettings value
	// whenever it changes (see module doc comment above).
	$effect(() => {
		const value = authSettingsStore.value;
		if (value) {
			disabledDraft = value.disabled;
			disabledRoleDraft = value.disabledRole;
		}
	});

	async function saveAuthSettings(): Promise<void> {
		if (disabledDraft && !window.confirm(m['settings.authDisableConfirm']())) {
			return;
		}

		applyingAuth = true;
		try {
			authSettingsStore.value = await applyAuthSettings(disabledDraft, disabledRoleDraft);
			sessionStore.authDisabled = authSettingsStore.value?.disabled ?? false;
			toastStore.push('success', m['settings.authSettingsUpdated']());
		} catch (err) {
			// 排他違反（LANアクセス有効中の有効化など）はサーバ側の日本語メッセージ
			// (kind: 'other') をそのままトーストに出す（spec M11）。
			toastStore.push('error', errorMessage(err));
		} finally {
			applyingAuth = false;
		}
	}
</script>

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
				<input type="checkbox" role="switch" class="banto-switch" bind:checked={disabledDraft} />
				{m['settings.authDisableToggle']()}
			</label>

			<div class="server-fields">
				<label class="field">
					{m['settings.startupRole']()}
					<select class="banto-input" bind:value={disabledRoleDraft} disabled={!disabledDraft}>
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

			{#if authSettingsStore.value}
				<p class="status">
					{m['settings.statusLabel']()}
					<strong
						>{authSettingsStore.value.disabled
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
