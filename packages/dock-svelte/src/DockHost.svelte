<script lang="ts">
	/**
	 * Host container for the whole dock layout (spec §5.2/§5.3). Measures
	 * itself via `bind:clientWidth`/`bind:clientHeight` (same plain-reactive-
	 * binding pattern as @banto/charts' ChartContainer.svelte - no separate
	 * ResizeObserver wiring needed).
	 *
	 * Two layers, in DOM/paint order (M8 Phase B adds the first):
	 *  1. The docked tree (`DockedTree`, if `dock.layout.docked` isn't
	 *     `null`) filling the whole host.
	 *  2. Every OPEN floating window (`dock.layout.floating`, M7), absolutely
	 *     positioned on top, in array order (render order = z-order - the
	 *     last one is frontmost and simply painted last). Unchanged from M7:
	 *     when `docked` is `null` the host looks exactly like it did before
	 *     Phase B.
	 * The `panel` snippet receives a `PanelContent` (id/title/icon) so a
	 * docked pane and a floating window can share the exact same content -
	 * DockHost itself has no notion of what a panel contains.
	 *
	 * DockHost owns the single `DragController` (`core/drag.svelte.ts`) for
	 * the whole tree - both `DockedTree` panes/tabs and `DockWindow`
	 * titlebars start a drag through it (via Svelte context, `setContext` in
	 * this file / `getContext` in theirs) - and renders the drag ghost +
	 * snap-guide overlay here, on top of everything else, from the
	 * controller's reactive `state` snapshot. Both the ghost and the guide
	 * are `pointer-events: none`: `core/drag.svelte.ts` hit-tests drop
	 * targets with `elementFromPoint`, so anything that could occlude the
	 * real target under the cursor would break that.
	 */
	import type { Snippet } from 'svelte';
	import { createDragController, setDragController } from './core/drag.svelte';
	import type { DockState } from './state.svelte';
	import type { PanelContent } from './types';
	import DockedTree from './DockedTree.svelte';
	import DockWindow from './DockWindow.svelte';

	interface Props {
		dock: DockState;
		panel: Snippet<[PanelContent]>;
	}

	let { dock, panel }: Props = $props();

	let hostW: number = $state(0);
	let hostH: number = $state(0);
	let hostEl: HTMLDivElement | null = $state(null);

	const openWindows = $derived(dock.layout.floating.filter((w) => w.open));

	// `dock` is a stable DockState instance for this component's lifetime, so
	// capturing it once to build the drag controller is intentional.
	// svelte-ignore state_referenced_locally
	const drag = createDragController(dock, () => hostEl);
	setDragController(drag);
</script>

<div class="dock-host" data-dock-host bind:this={hostEl} bind:clientWidth={hostW} bind:clientHeight={hostH}>
	{#if dock.layout.docked}
		<div class="docked-layer">
			<DockedTree node={dock.layout.docked} {dock} {panel} />
		</div>
	{/if}

	{#each openWindows as win, index (win.id)}
		<DockWindow {win} {dock} {hostW} {hostH} frontmost={index === openWindows.length - 1} {panel} />
	{/each}

	{#if drag.state}
		{#if drag.state.guideRect}
			<div
				class="snap-guide"
				aria-hidden="true"
				style:left={`${drag.state.guideRect.x}px`}
				style:top={`${drag.state.guideRect.y}px`}
				style:width={`${drag.state.guideRect.width}px`}
				style:height={`${drag.state.guideRect.height}px`}
			></div>
		{/if}
		<div
			class="drag-ghost"
			aria-hidden="true"
			style:left={`${drag.state.clientX}px`}
			style:top={`${drag.state.clientY}px`}
		>
			{#if drag.state.icon}<span class="icon">{drag.state.icon}</span>{/if}
			<span class="title">{drag.state.title}</span>
		</div>
	{/if}
</div>

<style>
	.dock-host {
		position: relative;
		overflow: hidden;
		width: 100%;
		height: 100%;
		background: var(--banto-bg);
		border: 1px solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
	}

	.docked-layer {
		position: absolute;
		inset: 0;
	}

	.snap-guide {
		position: absolute;
		background: var(--banto-dock-snap-fill);
		border: 2px solid var(--banto-dock-snap-border);
		border-radius: var(--banto-radius);
		box-sizing: border-box;
		pointer-events: none;
		z-index: 20;
	}

	.drag-ghost {
		position: fixed;
		transform: translate(14px, 14px);
		display: flex;
		align-items: center;
		gap: 0.35rem;
		max-width: 16rem;
		padding: 0.35rem 0.65rem;
		background: var(--banto-dock-ghost-bg);
		border: 1px solid var(--banto-dock-ghost-border);
		border-radius: var(--banto-radius);
		box-shadow: var(--banto-dock-shadow);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--banto-text);
		pointer-events: none;
		z-index: 30;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
