<script lang="ts">
	/**
	 * 別の端末からの接続確認の、端末側のページ（Issue #219 段階 1 / PR-C3）。
	 * spec §11.4（LAN 設定の UX）、lan-reach-check-design §4.3・D2。
	 *
	 * `(app)` の外（`login` と同じ階層）に置き、認証の guard を通らない。
	 * URL のフラグメント（`#t=<トークン>`）からトークンを取り、すぐに
	 * `history.replaceState` で URL から消してから `POST /api/reach-check` へ
	 * 送り、結果のコードごとの短い文言だけを出す（`reach.ts`）。ログイン・
	 * セッションは作らず、ナビゲーションやアプリの中身も出さない。トークンが
	 * 無い・形が違うときは送らない。文言はすべて messages 経由（conventions §13）。
	 */
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { postReachCheck, takeReachToken, type ReachResult } from './reach';

	type PageState =
		{ kind: 'checking' } | { kind: 'noToken' } | { kind: 'done'; result: ReachResult | 'failed' };

	let pageState = $state<PageState>({ kind: 'checking' });

	$effect(() => {
		untrack(() => {
			const token = takeReachToken(window.location, window.history);
			if (token === null) {
				pageState = { kind: 'noToken' };
				return;
			}
			void postReachCheck(token).then((result) => {
				pageState = { kind: 'done', result };
			});
		});
	});

	function resultText(result: ReachResult | 'failed'): string {
		switch (result) {
			case 'recorded':
				return m['reach.recorded']();
			case 'selfAccess':
				return m['reach.selfAccess']();
			case 'unusable':
				return m['reach.unusable']();
			case 'hostMismatch':
				return m['reach.hostMismatch']();
			case 'rateLimited':
				return m['reach.rateLimited']();
			case 'failed':
				return m['reach.failed']();
		}
	}
</script>

<svelte:head>
	<title>{m['reach.title']()}</title>
</svelte:head>

<main class="reach-page">
	<div class="reach-card">
		<h1>{m['reach.title']()}</h1>
		<div role="status" aria-live="polite">
			{#if pageState.kind === 'checking'}
				<p data-reach="checking">{m['reach.checking']()}</p>
			{:else if pageState.kind === 'noToken'}
				<p class="problem" data-reach="noToken">{m['reach.noToken']()}</p>
			{:else}
				<p
					class:problem={pageState.result !== 'recorded'}
					class:success={pageState.result === 'recorded'}
					data-reach={pageState.result}
				>
					{resultText(pageState.result)}
				</p>
			{/if}
		</div>
		<p class="note">{m['reach.note']()}</p>
	</div>
</main>

<style>
	.reach-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: var(--banto-space-4);
		box-sizing: border-box;
	}

	.reach-card {
		width: min(28rem, 100%);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		padding: var(--banto-space-6);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-md);
	}

	h1 {
		margin: 0;
		font-size: var(--banto-font-size-lg);
		text-wrap: balance;
	}

	p {
		margin: 0;
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}

	.success {
		color: var(--banto-success);
		font-weight: 600;
	}

	.problem {
		color: var(--banto-danger);
	}

	.note {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}
</style>
