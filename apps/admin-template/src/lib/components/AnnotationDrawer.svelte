<script lang="ts">
	/**
	 * Per-page annotations for developers looking at the demo (Issue #553,
	 * step 4): the explanation opens in a right-hand Drawer from the page's
	 * `AnnotationButton`. Put this at the page ROOT, not inside PageHeader's
	 * actions (see annotation.svelte.ts). Renders nothing outside the demo build.
	 */
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';
	import { Drawer } from '@banto/ui';
	import { isDemoBuild } from '#lib/banto/environment.js';
	import * as m from '#lib/paraglide/messages.js';
	import { annotation } from './annotation.svelte.js';

	let { children }: { children: Snippet } = $props();

	const overlayMessages = { overlayClose: () => m['common.close']() };

	// Leaving the page must not leave the next page's drawer open.
	onDestroy(() => (annotation.open = false));
</script>

{#if isDemoBuild()}
	<Drawer
		open={annotation.open}
		title={m['annotation.title']()}
		onclose={() => (annotation.open = false)}
		messages={overlayMessages}
	>
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
