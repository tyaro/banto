<script lang="ts">
	import { Tooltip } from '../../src/index';

	let { text = 'Saves the draft', describe = true }: { text?: string; describe?: boolean } =
		$props();
</script>

<Tooltip {text} {describe}>
	{#snippet children(trigger)}
		<button type="button" {...trigger}>Save</button>
	{/snippet}
</Tooltip>
<button type="button">Elsewhere</button>
