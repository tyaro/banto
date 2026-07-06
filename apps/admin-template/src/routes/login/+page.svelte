<script lang="ts">
	import { goto } from '$app/navigation';
	import { getAuthProvider } from '@banto/admin-core';
	import { bantoReady } from '$lib/banto/setup';

	let username = $state('');
	let password = $state('');
	let error: string | null = $state(null);
	let submitting = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = null;
		submitting = true;
		try {
			await bantoReady; // provider selection (spec §11.1's three-way probe) must finish first
			const result = await getAuthProvider().login({ username, password });
			if (result.success) {
				goto('/dashboard');
			} else {
				error = result.error ?? 'ログインに失敗しました';
			}
		} finally {
			submitting = false;
		}
	}
</script>

<div class="page">
	<form onsubmit={submit}>
		<h1>🏮 Banto</h1>
		<p class="note">
			admin / admin でログイン（Tauri時はRustコマンド、LANブラウザ時はREST/SSE、単体ブラウザ時はデモ実装）
		</p>

		<label>
			ユーザー名
			<input type="text" bind:value={username} autocomplete="username" />
		</label>

		<label>
			パスワード
			<input type="password" bind:value={password} autocomplete="current-password" />
		</label>

		{#if error}
			<p class="error">{error}</p>
		{/if}

		<button type="submit" disabled={submitting}>ログイン</button>
	</form>
</div>

<style>
	.page {
		min-height: 100vh;
		display: grid;
		place-items: center;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: 320px;
		padding: 2rem;
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
	}

	h1 {
		margin: 0;
		text-align: center;
		font-size: 1.5rem;
	}

	.note {
		margin: 0;
		text-align: center;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.875rem;
		color: var(--banto-text-muted);
	}

	input {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		background: var(--banto-bg);
		color: var(--banto-text);
	}

	input:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.error {
		margin: 0;
		text-align: center;
		color: var(--banto-danger);
		font-size: 0.8rem;
	}

	button {
		padding: 0.55rem;
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
</style>
