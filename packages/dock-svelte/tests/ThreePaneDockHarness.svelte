<!--
	Test-only harness for `ThreePaneDock.test.ts` (#663 ④): the snippets cannot be written from a
	`.ts` test, so this wrapper renders the three panes (and the extra panels named in `extraIds`)
	with a text input each, binds `leftOpen` / `rightOpen` / `dock`, and exposes the component
	(`api()`) and the bound values (`open()`, `setOpen()`).
-->
<script lang="ts">
	import ThreePaneDock from '../src/ThreePaneDock.svelte';
	import type { DockPanelChange } from '../src/core/lifecycle';
	import type { DockCapabilities } from '../src/core/policy';
	import type { DockState } from '../src/state.svelte';
	import type { ThreePaneExtraPanelDef, ThreePaneRestoreStatus } from '../src/threePane';

	let {
		dock,
		withLeft = true,
		withRight = true,
		extra = [],
		initialLayout,
		initialLeftOpen = true,
		beforePanelChange,
		capabilities,
		onRestore
	}: {
		dock?: DockState;
		withLeft?: boolean;
		withRight?: boolean;
		extra?: ThreePaneExtraPanelDef[];
		initialLayout?: unknown;
		initialLeftOpen?: boolean;
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
		capabilities?: (id: string) => DockCapabilities | undefined;
		onRestore?: (status: ThreePaneRestoreStatus | 'fresh') => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let leftOpen = $state(initialLeftOpen);
	let rightOpen = $state(true);
	let ref: ReturnType<typeof ThreePaneDock> | undefined = $state();

	export function api(): ReturnType<typeof ThreePaneDock> {
		if (!ref) throw new Error('ThreePaneDock is not mounted');
		return ref;
	}

	export function open(): { left: boolean; right: boolean } {
		return { left: leftOpen, right: rightOpen };
	}

	export function setOpen(side: 'left' | 'right', value: boolean): void {
		if (side === 'left') leftOpen = value;
		else rightOpen = value;
	}

	const panels = $derived(extra.map((def) => ({ ...def, content: extraContent })));
</script>

{#snippet leftContent()}
	<div data-pane="left">LEFT<input aria-label="left input" /></div>
{/snippet}
{#snippet rightContent()}
	<div data-pane="right">RIGHT<input aria-label="right input" /></div>
{/snippet}
{#snippet extraContent()}
	<div data-pane="extra">EXTRA</div>
{/snippet}

<ThreePaneDock
	bind:this={ref}
	{dock}
	bind:leftOpen
	bind:rightOpen
	left={withLeft ? leftContent : undefined}
	right={withRight ? rightContent : undefined}
	{panels}
	{initialLayout}
	{beforePanelChange}
	{capabilities}
	{onRestore}
>
	<div data-pane="center">CENTER<input aria-label="center input" /></div>
</ThreePaneDock>
