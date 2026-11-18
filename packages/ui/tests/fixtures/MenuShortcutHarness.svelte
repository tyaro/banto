<script lang="ts">
	// Test harness: items with / without a shortcut for MenuItem keycap tests.
	import { Menu, MenuItem } from '../../src/index';
	import type { ShortcutPlatform } from '../../src/index';

	let { platform }: { platform?: ShortcutPlatform } = $props();
</script>

<Menu label="Edit menu">
	{#snippet trigger(props)}
		<button {...props} type="button">Open</button>
	{/snippet}
	<MenuItem label="Undo" shortcut="Mod+Shift+Z" {platform} onSelect={() => {}} />
	<MenuItem label="Redo" onSelect={() => {}} />
</Menu>
