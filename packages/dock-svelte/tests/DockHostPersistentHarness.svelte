<!--
	Test-only harness for `DockHostPersistent.test.ts` (#663 ④): like
	`DockHostHarness.svelte`, with `persistent` forwarded and every pane's content a
	`PersistentProbe` that counts its mounts (`onMounted`).
-->
<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import DockHost from '../src/DockHost.svelte';
	import type { DockCapabilities } from '../src/core/policy';
	import type { DockState } from '../src/state.svelte';
	import type { PanelContent } from '../src/types';
	import PersistentProbe from './PersistentProbe.svelte';

	type HostProps = ComponentProps<typeof DockHost>;

	let {
		dock,
		capabilities,
		beforePanelChange,
		keepMounted,
		persistent,
		onMounted
	}: {
		dock: DockState;
		capabilities?: (panelId: string) => DockCapabilities | undefined;
		beforePanelChange?: HostProps['beforePanelChange'];
		keepMounted?: HostProps['keepMounted'];
		persistent?: HostProps['persistent'];
		onMounted?: (id: string) => void;
	} = $props();

	let hostRef: ReturnType<typeof DockHost> | undefined = $state();

	export function host(): ReturnType<typeof DockHost> {
		if (!hostRef) throw new Error('DockHost is not mounted');
		return hostRef;
	}
</script>

<DockHost
	bind:this={hostRef}
	{dock}
	{panel}
	{capabilities}
	{beforePanelChange}
	{keepMounted}
	{persistent}
/>

{#snippet panel(content: PanelContent)}
	<PersistentProbe id={content.id} title={content.title} {onMounted} />
{/snippet}
