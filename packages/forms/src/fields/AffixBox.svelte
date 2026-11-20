<script lang="ts">
	/**
	 * Draws a number field's `prefix` / `suffix` around its input. Display only:
	 * the text is `aria-hidden` (so it stays out of the label's name when the
	 * input sits inside a `<label>`) and is read through the input's
	 * `aria-describedby` instead (see `describedByWithAffix`). Renders just the
	 * input when the field has neither.
	 */
	import type { Snippet } from 'svelte';
	import type { FieldDef } from '../types';

	interface Props {
		def: Pick<FieldDef, 'prefix' | 'suffix'>;
		/** The input's id; the affix ids are derived from it. */
		id: string;
		children: Snippet;
	}

	let { def, id, children }: Props = $props();
</script>

{#if def.prefix || def.suffix}
	<span class="box banto-affix">
		{#if def.prefix}<span id="{id}-prefix" class="affix" aria-hidden="true">{def.prefix}</span>{/if}
		{@render children()}
		{#if def.suffix}<span id="{id}-suffix" class="affix" aria-hidden="true">{def.suffix}</span>{/if}
	</span>
{:else}
	{@render children()}
{/if}

<style>
	.box {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		min-width: 0;
	}

	.box :global(input) {
		flex: 1 1 auto;
		min-width: 0;
	}

	.affix {
		flex: none;
		color: var(--banto-text-muted);
		white-space: nowrap;
	}
</style>
