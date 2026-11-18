<!--
	Test-only stand-in for a View menu (#663): one checkbox per `dock.panels`
	row, checked = `visible`. A change calls `onToggle(id, checked)`, which the
	test wires to `DockHost.setPanelVisible`. Proves `panels` is reactive (the
	checkboxes follow the ✕ button) without depending on `@banto/ui`.
-->
<script lang="ts">
	import type { DockState } from '../src/state.svelte';

	let { dock, onToggle }: { dock: DockState; onToggle: (id: string, visible: boolean) => void } =
		$props();
</script>

<ul data-testid="view-menu">
	{#each dock.panels as row (row.id)}
		<li>
			<label>
				<input
					type="checkbox"
					checked={row.visible}
					data-placement={row.placement}
					onchange={(e) => onToggle(row.id, e.currentTarget.checked)}
				/>
				{row.title}
			</label>
		</li>
	{/each}
</ul>
