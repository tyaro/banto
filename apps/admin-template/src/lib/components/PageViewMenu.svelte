<script lang="ts" module>
	import type { PageViewMenuItem as Item } from '#lib/pageViewMenu.svelte.js';

	/** Re-exported so a page imports the component and its item type in one line. */
	export type PageViewMenuItem = Item;
</script>

<script lang="ts">
	/**
	 * A page's "View" menu (#663 ①-C, pageViewMenu.svelte.ts). Place it in
	 * PageHeader's `actions`: it registers the menu with the shell, which shows
	 * it in the menu bar when the bar is on screen; otherwise (sidebar /
	 * launcher layout, <=900px, insufficient bar) this renders the same items
	 * as a menu button here. Exactly one of the two exists at a time.
	 */
	import { Menu, MenuItem, MenuSeparator } from '@banto/ui';
	import { SlidersHorizontal } from '@lucide/svelte';
	import { usePageViewMenuHost } from '#lib/pageViewMenu.svelte.js';

	interface Props {
		label: string;
		items: PageViewMenuItem[];
	}

	let { label, items }: Props = $props();

	const host = usePageViewMenuHost();

	$effect(() => host?.register(() => ({ label, items })));
</script>

{#if !host?.inShell}
	<Menu {label} placement="bottom-end">
		{#snippet trigger(props)}
			<button {...props} type="button" class="banto-btn banto-btn--ghost view-trigger">
				<SlidersHorizontal size={14} aria-hidden="true" />
				{label}
			</button>
		{/snippet}
		{#each items as item (item.id)}
			{#if item.kind === 'separator'}
				<MenuSeparator />
			{:else if item.kind === 'checkbox'}
				<MenuItem
					kind="checkbox"
					label={item.label}
					checked={item.checked}
					disabled={item.disabled}
					title={item.title}
					onSelect={item.onSelect}
				/>
			{:else}
				<MenuItem
					label={item.label}
					icon={item.icon}
					danger={item.danger}
					disabled={item.disabled}
					title={item.title}
					onSelect={item.onSelect}
				/>
			{/if}
		{/each}
	</Menu>
{/if}

<style>
	.view-trigger {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
	}
</style>
