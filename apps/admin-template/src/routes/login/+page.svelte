<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { getAuthProvider } from '@banto/admin-core';
	import { bantoReady, getBantoMode } from '$lib/banto/setup';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';

	// Undecided until `status()` resolves (or is absent, treated as
	// "already initialized" - see below): render nothing rather than
	// flashing one form then the other.
	let mode: 'loading' | 'setup' | 'login' = $state('loading');

	let username = $state('');
	let password = $state('');
	let displayName = $state('');
	let passwordConfirm = $state('');
	let error: string | null = $state(null);
	let submitting = $state(false);

	// "ログイン状態を保持する" (spec M11 "LAN Remember me"): only meaningful
	// for a LAN browser client (`createHttpAuthProvider` switches its token's
	// storage between sessionStorage/localStorage based on this flag). Inside
	// the Tauri webview a session already lives exactly as long as the window
	// does, and the plain-browser demo provider has no persistence story at
	// all - showing the checkbox there would offer a choice that does
	// nothing, so it's gated on `getBantoMode() === 'server'`. Set once
	// `bantoReady` resolves (below) - `getBantoMode()` reads the real
	// environment only after that probe finishes, same as `mode`.
	let showRemember = $state(false);
	let remember = $state(false);

	// The demo-credentials panel only applies where those credentials
	// actually work (plain-browser demo mode) - on a Tauri/LAN login they
	// would be misleading noise.
	let showDemoNote = $state(false);

	$effect(() => {
		void (async () => {
			await bantoReady; // provider selection (spec §11.1's three-way probe) must finish first
			showRemember = getBantoMode() === 'server';
			showDemoNote = getBantoMode() === 'demo';
			const status = await getAuthProvider().status?.();
			// No `status()` on this provider (an older/custom AuthProvider,
			// spec §3.3's members are optional for backward compatibility):
			// behave as if an account already exists, i.e. the normal login
			// form.
			mode = status && !status.initialized ? 'setup' : 'login';
		})();
	});

	async function submitLogin(event: SubmitEvent) {
		event.preventDefault();
		error = null;
		submitting = true;
		try {
			const params: Record<string, unknown> = { username, password };
			// Only sent when the checkbox is actually shown (LAN browser mode -
			// see `showRemember` above); omitting it elsewhere keeps the wire
			// body identical to the pre-M11 shape.
			if (showRemember && remember) params.remember = true;
			const result = await getAuthProvider().login(params);
			if (result.success) {
				goto(`${base}/dashboard`);
			} else {
				error = result.error ?? 'ログインに失敗しました';
			}
		} finally {
			submitting = false;
		}
	}

	async function submitSetup(event: SubmitEvent) {
		event.preventDefault();
		error = null;

		if (password.length < 8) {
			error = 'パスワードは8文字以上で入力してください';
			return;
		}
		if (password !== passwordConfirm) {
			error = 'パスワードが一致しません';
			return;
		}

		submitting = true;
		try {
			const setup = getAuthProvider().setup;
			if (!setup) {
				error = 'この環境では初期セットアップに対応していません';
				return;
			}
			const result = await setup({ username, password, displayName });
			if (result.success) {
				goto(`${base}/dashboard`);
			} else {
				error = result.error ?? 'セットアップに失敗しました';
			}
		} finally {
			submitting = false;
		}
	}
</script>

<div class="login-page">
	<div class="login-card">
		<!-- Brand pane (visual-refresh-design.md §9): 3 fixed slots (logo mark,
		     app name, one-line tagline) so a template user rebranding this page
		     only ever touches these three. Purely decorative/duplicate of the
		     real <h1> below - hidden from assistive tech and hidden entirely
		     under 960px. -->
		<aside class="brand-pane" aria-hidden="true">
			<span class="brand-mark">
				<svg viewBox="0 0 24 24" width="22" height="22">
					<rect x="10" y="3" width="4" height="2" rx="1" />
					<circle cx="12" cy="12" r="6" />
					<rect x="10" y="19" width="4" height="2" rx="1" />
				</svg>
			</span>
			<p class="brand-name">Banto</p>
			<p class="tagline">業務データを、ひとつの管理画面に。</p>
		</aside>

		<div class="form-pane">
			{#if mode === 'setup'}
				<form onsubmit={submitSetup}>
					<h1>Banto</h1>
					<p class="note">初回起動です。管理者アカウントを作成してください。</p>

					<label>
						表示名
						<input class="banto-input" type="text" bind:value={displayName} autocomplete="name" />
					</label>

					<label>
						ユーザー名
						<input class="banto-input" type="text" bind:value={username} autocomplete="username" />
					</label>

					<label>
						パスワード（8文字以上）
						<input
							class="banto-input"
							type="password"
							bind:value={password}
							autocomplete="new-password"
						/>
					</label>

					<label>
						パスワード（確認）
						<input
							class="banto-input"
							type="password"
							bind:value={passwordConfirm}
							autocomplete="new-password"
						/>
					</label>

					{#if error}
						<p class="error">{error}</p>
					{/if}

					<button type="submit" class="banto-btn banto-btn--primary" disabled={submitting}>
						アカウントを作成
					</button>
				</form>
			{:else if mode === 'login'}
				<form onsubmit={submitLogin}>
					<h1>Banto</h1>
					<p class="note">
						Tauri/LANモードでは初回起動時に作成したアカウントでログインしてください。
					</p>

					<label>
						ユーザー名
						<input class="banto-input" type="text" bind:value={username} autocomplete="username" />
					</label>

					<label>
						パスワード
						<input
							class="banto-input"
							type="password"
							bind:value={password}
							autocomplete="current-password"
						/>
					</label>

					{#if showRemember}
						<label class="remember">
							<input type="checkbox" bind:checked={remember} />
							ログイン状態を保持する（30日間）
						</label>
					{/if}

					{#if error}
						<p class="error">{error}</p>
					{/if}

					<button type="submit" class="banto-btn banto-btn--primary" disabled={submitting}>
						ログイン
					</button>
				</form>

				{#if showDemoNote}
					<SurfaceCard title="デモ環境について">
						<p class="demo-note">
							単体ブラウザ（デモ）モードは <strong>admin / admin</strong> でログインできます。
						</p>
					</SurfaceCard>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.login-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.login-card {
		width: min(320px, 100%);
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-md);
		overflow: hidden;
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.brand-pane {
		display: none;
	}

	.form-pane {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 2rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	h1 {
		margin: 0;
		text-align: center;
		font-size: 1.5rem;
		font-feature-settings: 'palt';
		text-wrap: balance;
	}

	.note {
		margin: 0;
		text-align: center;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		text-wrap: pretty;
	}

	.demo-note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		text-wrap: pretty;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.875rem;
		color: var(--banto-text-muted);
	}

	.remember {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
	}

	.remember input {
		padding: 0;
		width: auto;
	}

	.error {
		margin: 0;
		text-align: center;
		color: var(--banto-danger);
		font-size: 0.8rem;
	}

	.banto-btn--primary {
		justify-content: center;
		height: var(--banto-control-height-lg);
	}

	/* Glass preset accent (spec M12): the submit button gets the accent
	   gradient; hover brightens it instead of swapping to the flat hover
	   color (a gradient has no single hover counterpart). Same pattern the
	   pre-refresh login page used with its own `button` selector. */
	:global([data-banto-preset='glass']) .banto-btn--primary {
		background: var(--banto-accent-gradient);
	}

	:global([data-banto-preset='glass']) .banto-btn--primary:hover:not(:disabled) {
		background: var(--banto-accent-gradient);
		filter: brightness(1.08);
	}

	@media (min-width: 961px) {
		.login-card {
			width: min(960px, 100%);
			display: grid;
			grid-template-columns: 5fr 4fr;
		}

		.brand-pane {
			display: flex;
			position: relative;
			flex-direction: column;
			justify-content: center;
			gap: 0.6rem;
			padding: 3rem;
			overflow: hidden;
			color: #fff;
			/* Background generated with no image assets (design.md §9): two
			   radial gradients + a conic mesh. The warm accent (rgb 237 106 52,
			   evoking the Banto lantern) and the dark conic base are the one
			   exception to token-only colors, scoped to this decorative pane. */
			background:
				radial-gradient(
					60% 80% at 20% 20%,
					color-mix(in srgb, var(--banto-primary) 28%, transparent),
					transparent
				),
				radial-gradient(50% 60% at 80% 90%, rgb(237 106 52 / 0.18), transparent),
				conic-gradient(from 210deg at 60% 40%, #171c26, #10131a);
		}

		.brand-pane::after {
			content: '';
			position: absolute;
			inset: 0;
			opacity: 0.05;
			mix-blend-mode: overlay;
			pointer-events: none;
			/* Inline SVG feTurbulence noise (design.md §9) - a data URI instead
			   of a shipped image asset. */
			background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
		}

		.brand-mark {
			position: relative;
			z-index: 1;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			height: 44px;
			border-radius: var(--banto-radius-lg);
			background: var(--banto-accent-gradient);
		}

		.brand-mark svg {
			fill: #fff;
		}

		.brand-name {
			position: relative;
			z-index: 1;
			margin: 0.5rem 0 0;
			font-size: 1.75rem;
			font-weight: 700;
			font-feature-settings: 'palt';
		}

		.tagline {
			position: relative;
			z-index: 1;
			margin: 0;
			color: rgb(255 255 255 / 0.75);
			font-size: 0.9rem;
			text-wrap: pretty;
		}

		.form-pane {
			justify-content: center;
			padding: 3rem;
		}
	}
</style>
