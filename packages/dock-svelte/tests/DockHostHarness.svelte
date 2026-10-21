<!--
	Test-only harness for `DockHost.test.ts` (M-review 2026-08 M-8) and
	`DockHostReachability.test.ts`. `DockHost`'s `panel` prop is a
	`Snippet<[PanelContent]>`, which cannot be expressed from a `.ts` test file,
	so the component tests mount this wrapper instead and read assertions off the
	passed-in `DockState` (the reactive source of truth). `clamp` /
	`capabilities` are forwarded unchanged.
-->
<script lang="ts">
	import DockHost from '../src/DockHost.svelte';
	import type { ClampOptions } from '../src/core/geometry';
	import type { DockCapabilities } from '../src/core/policy';
	import type { DockState } from '../src/state.svelte';
	import type { PanelContent } from '../src/types';

	let {
		dock,
		clamp,
		capabilities
	}: {
		dock: DockState;
		clamp?: ClampOptions;
		capabilities?: (panelId: string) => DockCapabilities | undefined;
	} = $props();
</script>

<DockHost {dock} {panel} {clamp} {capabilities} />

{#snippet panel(content: PanelContent)}
	<div class="panel-body">{content.title}<input aria-label={`${content.title} input`} /></div>
{/snippet}
