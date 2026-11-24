<script lang="ts">
	// Test harness for the context menu (#889): a trigger-less Menu opened by
	// `openAt()` from a focusable "row" (the stand-in for a tree row / grid
	// cell, which BantoTree / BantoGrid focus before their callback).
	import { Menu, MenuItem } from '../../src/index';

	let {
		onEdit,
		onDelete,
		showRow = true
	}: { onEdit: () => void; onDelete: () => void; showRow?: boolean } = $props();

	let menu: ReturnType<typeof Menu> | undefined = $state();

	export function openAt(
		point: { x: number; y: number },
		options?: { returnFocus?: HTMLElement | null }
	): void {
		menu?.openAt(point, options);
	}
</script>

{#if showRow}
	<button type="button" data-testid="row">Row</button>
{/if}
<button type="button" data-testid="other">Other</button>

<Menu bind:this={menu} label="Row actions">
	<MenuItem label="Edit" onSelect={onEdit} />
	<MenuItem label="Archive" disabled onSelect={() => {}} />
	<MenuItem label="Delete" danger onSelect={onDelete} />
</Menu>
