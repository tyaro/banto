<script lang="ts" module>
	/**
	 * Visual tier (#623): `primary` = emphasised (shadow md), `default` = the
	 * standard card, `subtle` = flat auxiliary (border only, subtle surface).
	 */
	export type SurfaceCardTone = 'primary' | 'default' | 'subtle';
</script>

<script lang="ts">
	/**
	 * Generic elevated surface for section/card content
	 * (visual-refresh-design.md §6.4). The Glass preset repaints
	 * `--banto-surface` etc. globally, so no branching is needed here.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: SurfaceCardTone;
		title?: string;
		description?: string;
		children: Snippet;
		footer?: Snippet;
	}

	let { tone = 'default', title, description, children, footer }: Props = $props();
</script>

<section class="surface-card" data-tone={tone}>
	{#if title || description}
		<header>
			{#if title}
				<h2>{title}</h2>
			{/if}
			{#if description}
				<p>{description}</p>
			{/if}
		</header>
	{/if}
	<div class="body">
		{@render children()}
	</div>
	{#if footer}
		<footer>
			{@render footer()}
		</footer>
	{/if}
</section>

<style>
	.surface-card {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-card-default-shadow);
		padding: var(--banto-space-5);
		/* Glass preset (spec M12): cards are in the translucent scope
		   (plan §3.3) - no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.surface-card[data-tone='primary'] {
		box-shadow: var(--banto-card-primary-shadow);
	}

	.surface-card[data-tone='subtle'] {
		background: var(--banto-card-subtle-bg);
		box-shadow: var(--banto-card-subtle-shadow);
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-base);
		font-weight: 600;
		font-feature-settings: 'palt';
	}

	header p {
		margin: var(--banto-space-1) 0 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--banto-space-2);
		padding-top: var(--banto-space-3);
		border-top: var(--banto-border-width) solid var(--banto-border);
	}
</style>
