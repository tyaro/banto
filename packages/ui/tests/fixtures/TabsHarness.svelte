<script lang="ts">
	import { Tabs, type TabItem } from '../../src/index';

	let {
		tabs,
		value = $bindable(),
		activation = 'automatic',
		onchange,
		keepMounted = false
	}: {
		tabs: TabItem[];
		value?: string;
		activation?: 'automatic' | 'manual';
		onchange?: (id: string) => void;
		keepMounted?: boolean;
	} = $props();
</script>

<Tabs {tabs} bind:value label="Sections" {activation} {onchange} {keepMounted}>
	{#snippet panel(id)}
		<p>Panel {id}</p>
	{/snippet}
</Tabs>
<output data-testid="value">{value ?? ''}</output>
