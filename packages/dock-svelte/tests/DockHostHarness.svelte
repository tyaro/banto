<!--
	Test-only harness for `DockHost.test.ts` (M-review 2026-08 M-8). `DockHost`'s
	`panel` prop is a `Snippet<[PanelContent]>`, which cannot be expressed from a
	`.ts` test file, so the component tests mount this wrapper instead and read
	assertions off the passed-in `DockState` (the reactive source of truth).
-->
<script lang="ts">
	import DockHost from '../src/DockHost.svelte';
	import type { DockState } from '../src/state.svelte';
	import type { PanelContent } from '../src/types';

	let { dock }: { dock: DockState } = $props();
</script>

<DockHost {dock} {panel} />

{#snippet panel(content: PanelContent)}
	<div class="panel-body">{content.title}</div>
{/snippet}
