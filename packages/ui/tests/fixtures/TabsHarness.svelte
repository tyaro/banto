<script lang="ts">
	import { Tabs, type TabItem } from '../../src/index';

	let {
		tabs,
		value = $bindable(),
		activation = 'automatic',
		onchange
	}: {
		tabs: TabItem[];
		value?: string;
		activation?: 'automatic' | 'manual';
		onchange?: (id: string) => void;
	} = $props();
</script>

<Tabs {tabs} bind:value label="Sections" {activation} {onchange}>
	{#snippet panel(id)}
		<p>Panel {id}</p>
	{/snippet}
</Tabs>
<output data-testid="value">{value ?? ''}</output>
