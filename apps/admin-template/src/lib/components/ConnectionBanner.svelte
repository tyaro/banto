<script lang="ts">
	/**
	 * Connection banner (Issue #637 PR-2, design-ux-review D-4): a full-width
	 * strip right under the header while the LAN browser cannot reach the
	 * server (`reconnecting`) or has no network (`offline`).
	 *
	 * - Shown only in `server` mode (`connectionBannerKind`); Tauri and demo
	 *   have no monitor, so it is never in their DOM.
	 * - The region itself stays mounted (`role="status"`, polite) so the
	 *   change of its text is what gets announced - once per state change,
	 *   not on every render. Nothing here moves focus: the banner appears
	 *   and goes without touching what the user is typing in.
	 * - "Retry" sends one light request (`retryConnection`); it never
	 *   disables itself, so the focus stays where it is.
	 * - The warning says a reload drops the unsaved input: drafts live in
	 *   this tab's memory only (the owner's decision, not stored anywhere).
	 */
	import { WifiOff, TriangleAlert } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { connectionStatus, retryConnection } from '#lib/banto/connection.svelte.js';
	import { connectionBannerKind } from '#lib/banto/connectionRecovery.js';
	import { getBantoMode } from '#lib/banto/setup.js';

	// Fixed for the page's life (`bantoReady` resolved before the layout mounts).
	const mode = getBantoMode();
	const kind = $derived(connectionBannerKind(mode, connectionStatus()));
</script>

{#if mode === 'server'}
	<div class="connection-region" role="status" aria-live="polite" data-testid="connection-region">
		{#if kind}
			<div class="connection-banner" data-connection={kind}>
				{#if kind === 'offline'}
					<WifiOff size={18} aria-hidden="true" />
				{:else}
					<TriangleAlert size={18} aria-hidden="true" />
				{/if}
				<p class="message">
					<strong>
						{kind === 'offline' ? m['connection.offline']() : m['connection.reconnecting']()}
					</strong>
					<span class="warning">{m['connection.reloadWarning']()}</span>
				</p>
				<button
					type="button"
					class="banto-btn banto-btn--secondary banto-btn--sm"
					onclick={() => void retryConnection()}
				>
					{m['connection.retry']()}
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.connection-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2) var(--banto-space-3);
		padding: var(--banto-space-2) var(--banto-space-5);
		background: var(--banto-warning-tint);
		color: var(--banto-warning-tint-text);
		font-size: var(--banto-font-size-md);
	}

	.connection-banner :global(svg) {
		flex: none;
	}

	.message {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		overflow-wrap: anywhere;
	}

	.warning {
		margin-inline-start: var(--banto-space-2);
	}
</style>
