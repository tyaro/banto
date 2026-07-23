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
	import type { DockMessages } from './messages';

	interface Props {
		dock: DockState;
		panel: Snippet<[PanelContent]>;
		/**
		 * Optional pop-out affordance (spec §5.3 v2: "ウィンドウ分離"モード).
		 * When provided, both `DockWindow` titlebars and `DockedTree` pane
		 * titlebars/tab strips render an extra ⧉ button BEFORE the close
		 * button, calling this with that panel's `PanelContent` on click. This
		 * package has zero Tauri knowledge and no opinion on what "popping
		 * out" means - it just forwards the click. The caller (the app) is
		 * expected to hide/undock the panel and open a real native window for
		 * it, then call `dock.open(id)` again once that window closes -
		 * see apps/admin-template's dashboard page for the reference wiring.
		 * When this prop is omitted (e.g. plain-browser mode), nothing extra
		 * renders at all - zero layout/behavior change from before this prop
		 * existed.
		 */
		onPopOut?: (content: PanelContent) => void;
		/** i18n layer 1 (docs/i18n-plan.md §3.2): overrides for this component's visible strings, threaded down to `DockedTree` and `DockWindow`. Defaults reproduce today's Japanese output. */
		messages?: Partial<DockMessages>;
	}

	let { dock, panel, onPopOut, messages = {} }: Props = $props();

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

<div
	class="dock-host"
	data-dock-host
	bind:this={hostEl}
	bind:clientWidth={hostW}
	bind:clientHeight={hostH}
>
	{#if dock.layout.docked}
		<div class="docked-layer">
			<DockedTree node={dock.layout.docked} {dock} {panel} {onPopOut} {messages} />
		</div>
	{/if}

	{#each openWindows as win, index (win.id)}
		<DockWindow
			{win}
			{dock}
			{hostW}
			{hostH}
			frontmost={index === openWindows.length - 1}
			{panel}
			{onPopOut}
			{messages}
		/>
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
		border-radius: var(--banto-radius-lg);
	}

	.docked-layer {
		position: absolute;
		inset: 0;
	}

	/* Snap guide follows the pointer every move - no transition, it must track instantly. */
	.snap-guide {
		position: absolute;
		background: var(--banto-dock-snap-fill);
		border: 2px solid var(--banto-dock-snap-border);
		border-radius: var(--banto-radius-md);
		box-sizing: border-box;
		pointer-events: none;
		z-index: 20;
	}

	/* Drag ghost follows the pointer every move - no transition, same reason as .snap-guide. */
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
		border-radius: var(--banto-radius-md);
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
