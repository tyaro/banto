<script lang="ts">
	// Test harness: a keyed {#each} of items whose order the test changes
	// after mount (a column menu after the grid's columns are reordered).
	import { Menu, MenuItem } from '../../src/index';

	let { labels }: { labels: string[] } = $props();
</script>

<Menu label="Reorder">
	{#snippet trigger(props)}
		<button {...props} type="button">Open</button>
	{/snippet}
	{#each labels as label (label)}
		<MenuItem {label} kind="checkbox" checked={true} onSelect={() => {}} />
	{/each}
</Menu>
