<script lang="ts">
	import type { ThemeMode } from '@banto/theme';
	import { getAuthProvider } from '@banto/admin-core';
	import { settings } from '$lib/settings.svelte';
	import { isTauri } from '$lib/banto/setup';
	import { applyServerSettings, getServerStatus, type ServerStatus } from '$lib/banto/serverAdmin';
	import { toastStore } from '$lib/toast.svelte';
	import { sessionStore } from '$lib/session.svelte';
	import { isAdmin } from '$lib/permissions';

	const modes: { value: ThemeMode; label: string }[] = [
		{ value: 'light', label: 'ライト' },
		{ value: 'dark', label: 'ダーク' },
		{ value: 'system', label: 'システムに従う' }
	];

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
	const firstLanUrl = $derived(serverStatus?.urls.find((url) => !url.includes('127.0.0.1')) ?? null);
	const firstLanQrSvg = $derived(
		firstLanUrl ? (serverStatus?.qrSvgs.find((entry) => entry.url === firstLanUrl)?.svg ?? null) : null
	);
</script>

<div class="sections">
	<section>
		<h2>テーマ</h2>
		<div class="options" role="radiogroup" aria-label="テーマ">
			{#each modes as mode (mode.value)}
				<label class:selected={settings.themeMode === mode.value}>
					<input
						type="radio"
						name="theme"
						value={mode.value}
						checked={settings.themeMode === mode.value}
						onchange={() => settings.setThemeMode(mode.value)}
					/>
					{mode.label}
				</label>
			{/each}
		</div>
		<p class="note">
			保存先はM0ではlocalStorage。M6でSettingsProvider（ローカルSQLite設定DB）に移行します（仕様
			§12.1）。
		</p>
	</section>

	{#if isAdmin(sessionStore.role)}
		<section>
			<h2>LANアクセス（組み込みWebサーバ）</h2>
			{#if tauri}
				<label class="toggle">
					<input type="checkbox" bind:checked={enabledDraft} />
					LANアクセスを有効にする
				</label>

				<div class="server-fields">
					<label class="field">
						バインドアドレス
						<select bind:value={bindDraft}>
							<option value="127.0.0.1">127.0.0.1 のみ</option>
							<option value="0.0.0.0">0.0.0.0（LAN公開）</option>
						</select>
					</label>

					<label class="field">
						ポート番号
						<input type="number" min="1" max="65535" bind:value={portDraft} />
					</label>
				</div>

				<button type="button" onclick={saveAndApply} disabled={applying}>保存して適用</button>

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
		</section>
	{/if}

	<section>
		<h2>アカウント</h2>
		{#if changePassword}
			<form onsubmit={submitChangePassword}>
				<label class="field">
					現在のパスワード
					<input type="password" bind:value={currentPassword} autocomplete="current-password" />
				</label>
				<label class="field">
					新しいパスワード（8文字以上）
					<input type="password" bind:value={newPassword} autocomplete="new-password" />
				</label>
				<label class="field">
					新しいパスワード（確認）
					<input type="password" bind:value={newPasswordConfirm} autocomplete="new-password" />
				</label>

				{#if passwordError}
					<p class="error">{passwordError}</p>
				{/if}

				<button type="submit" disabled={changingPassword}>パスワードを変更</button>
			</form>
		{:else}
			<p class="note">この環境ではパスワード変更に対応していません。</p>
		{/if}
	</section>
</div>

<style>
	.sections {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 560px;
	}

	section {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
		padding: 1rem 1.25rem;
	}

	h2 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
	}

	.options {
		display: flex;
		gap: 0.5rem;
	}

	.options label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.8rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		cursor: pointer;
		font-size: 0.875rem;
	}

	.options label.selected {
		border-color: var(--banto-primary);
		color: var(--banto-primary);
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
	}

	.options input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.server-fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.75rem 0;
	}

	section form {
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

	.field select,
	.field input {
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		background: var(--banto-bg);
		color: var(--banto-text);
	}

	button {
		padding: 0.5rem 1rem;
		border: none;
		border-radius: var(--banto-radius);
		background: var(--banto-primary);
		color: var(--banto-text-inverse);
		font-weight: 600;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		background: var(--banto-primary-hover);
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
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
		border-radius: var(--banto-radius);
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
</style>
