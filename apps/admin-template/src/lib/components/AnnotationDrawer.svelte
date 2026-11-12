<script lang="ts">
	/**
	 * Per-page annotations for developers looking at the demo (Issue #553,
	 * step 4): a "?" button for a PageHeader's `actions` that opens the page's
	 * explanation in a right-hand Drawer. Renders nothing outside the demo
	 * build (`isDemoBuild()`, a build-time constant), so a product build never
	 * shows developer-facing prose. A page with no annotation does not use it.
	 */
	import type { Snippet } from 'svelte';
	import { Drawer } from '@banto/ui';
	import { CircleQuestionMark } from '@lucide/svelte';
	import { isDemoBuild } from '#lib/banto/environment.js';
	import * as m from '#lib/paraglide/messages.js';

	let { children }: { children: Snippet } = $props();

	let open = $state(false);
</script>

{#if isDemoBuild()}
	<button
		type="button"
		class="banto-btn banto-btn--ghost annotation-trigger"
		aria-label={m['annotation.open']()}
		title={m['annotation.open']()}
		aria-haspopup="dialog"
		data-testid="annotation-open"
		onclick={() => (open = true)}
	>
		<CircleQuestionMark size={16} aria-hidden="true" />
	</button>
	<Drawer {open} title={m['annotation.title']()} onclose={() => (open = false)}>
		<div class="annotation-body" data-testid="annotation-body">
			{@render children()}
		</div>
	</Drawer>
{/if}

<style>
	.annotation-body {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		color: var(--banto-text);
		font-size: var(--banto-font-size-sm);
		line-height: 1.7;
	}

	.annotation-body :global(p) {
		margin: 0;
	}
</style>
