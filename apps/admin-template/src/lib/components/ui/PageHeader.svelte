<script lang="ts">
	/**
	 * Page-level heading with an optional description and action slot
	 * (visual-refresh-design.md §6.1). Carries the single view-transition
	 * name used app-wide (§11.1) so the heading cross-fades between pages.
	 *
	 * No app-specific store imports (session/settings/etc.) - kept
	 * promotable to a shared package per plan Phase 1.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		/** Primary action first in DOM order; layout wraps under narrow widths. */
		actions?: Snippet;
	}

	let { title, description, actions }: Props = $props();
</script>

<header class="page-header">
	<div>
		<h1>{title}</h1>
		{#if description}
			<p>{description}</p>
		{/if}
	</div>
	{#if actions}
		<div class="actions">
			{@render actions()}
		</div>
	{/if}
</header>

<style>
	.page-header {
		view-transition-name: page-header;
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem 1rem;
	}

	h1 {
		margin: 0;
		font-size: 1.15rem;
		line-height: 1.5;
		font-weight: 600;
		font-feature-settings: 'palt';
		text-wrap: balance;
	}

	p {
		margin: 0.25rem 0 0;
		color: var(--banto-text-muted);
		font-size: 0.85rem;
		text-wrap: pretty;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
</style>
