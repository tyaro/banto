<script lang="ts">
	import { Tabs, type TabItem } from '../../src/index';

	let {
		tabs,
		value = $bindable(),
		activation = 'automatic',
		onchange,
		keepMounted = false,
		hideSingleTab = false
	}: {
		tabs: TabItem[];
		value?: string;
		activation?: 'automatic' | 'manual';
		onchange?: (id: string) => void;
		keepMounted?: boolean;
		hideSingleTab?: boolean;
	} = $props();
</script>

<Tabs {tabs} bind:value label="Sections" {activation} {onchange} {keepMounted} {hideSingleTab}>
	{#snippet panel(id)}
		<p>Panel {id}</p>
		<input data-testid="field-{id}" />
	{/snippet}
</Tabs>
<output data-testid="value">{value ?? ''}</output>
