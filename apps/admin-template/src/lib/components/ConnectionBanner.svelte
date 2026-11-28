<script lang="ts">
	/**
	 * Connection banner (Issue #637 PR-2, design-ux-review D-4): a full-width
	 * strip right under the header while the LAN browser cannot reach the
	 * server (`reconnecting`) or has no network (`offline`).
	 *
	 * - Shown only while a monitor exists (`connectionMonitoring`); Tauri and
	 *   demo never create one, so it is never in their DOM.
	 * - The sentence stays mounted (`role="status"`, polite; no control inside) so the
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
	import {
		connectionMonitoring,
		connectionStatus,
		retryConnection
	} from '#lib/banto/connection.svelte.js';
	import { connectionBannerKind } from '#lib/banto/connectionRecovery.js';

	const kind = $derived(connectionBannerKind(connectionStatus()));
</script>

{#if connectionMonitoring()}
	<!--
		The strip itself is not a live region: the "Retry" button must not sit inside one
		(Issue #1055: a modal makes everything outside it inert except live regions, and a
		live region holding a control would stay clickable behind it). Only the sentence is
		`role="status"`, and it stays mounted so a change of its text is what gets announced.
	-->
	<div
		class="connection-region"
		class:connection-banner={kind}
		data-connection={kind ?? undefined}
		data-testid="connection-region"
	>
		{#if kind === 'offline'}
			<WifiOff size={18} aria-hidden="true" />
		{:else if kind}
			<TriangleAlert size={18} aria-hidden="true" />
		{/if}
		<p class="message" role="status" aria-live="polite">
			{#if kind}
				<strong>
					{kind === 'offline' ? m['connection.offline']() : m['connection.reconnecting']()}
				</strong>
				<span class="warning">{m['connection.reloadWarning']()}</span>
			{/if}
		</p>
		{#if kind}
			<button
				type="button"
				class="banto-btn banto-btn--secondary banto-btn--sm"
				onclick={() => void retryConnection()}
			>
				{m['connection.retry']()}
			</button>
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
