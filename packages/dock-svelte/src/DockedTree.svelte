<script lang="ts">
	/**
	 * Recursive renderer for the docked layout tree (M8 Phase B, spec §5.1/
	 * §5.2). One `DockedTree` instance per `DockNode`; a `split` renders its
	 * `children` as further `DockedTree` instances (self-import - each
	 * recursive level is its own component instance, so per-instance
	 * `$state` - e.g. the split's measured size for divider dragging - never
	 * leaks between siblings).
	 *
	 * `panel` and `tabs` frames are the only DRAG SOURCES and DROP TARGETS in
	 * the docked tree (a bare `split` has no rendered surface of its own -
	 * same invariant `core/tree.ts#resolveTarget` already relies on). Each
	 * such frame carries `data-dock-drop-id={node.id}` for
	 * `core/drag.svelte.ts`'s `elementFromPoint`-based hit testing.
	 *
	 * Titlebar/tab pointerdown arms a drag CANDIDATE; only once the pointer
	 * moves past `DRAG_THRESHOLD_PX` does it become a real drag (via the
	 * shared `DragController`, see `core/drag.svelte.ts`) - below that
	 * threshold a plain pointerup is just a tab click (`setActiveTab`),
	 * mirroring grid-svelte's `HeaderCell.svelte` convention. Both threshold
	 * tracking AND the split-divider resize below use window-level
	 * pointermove/pointerup listeners rather than `setPointerCapture`, for
	 * the same reason `HeaderCell.svelte` documents (a stray double-click can
	 * wedge capture and break a later, unrelated drag).
	 *
	 * "Closing" a docked pane (the ✕ button) has no first-class "hidden but
	 * still docked" state in the Phase A model (unlike a floating window's
	 * `open` flag) - a `DockPanelNode` doesn't carry one. Rather than add one,
	 * this reuses two already-existing `DockState` methods unchanged:
	 * `undockPanel` (removes it from the tree, appends it to `floating`) then
	 * `close` (marks that floating window `open: false`). The panel is fully
	 * recoverable afterwards through the same floating open/close toggle any
	 * other closed window uses - no data is lost, and no Phase A method
	 * needed changing.
	 */
	import type { Snippet } from 'svelte';
	import { pixelDeltaToFraction } from './core/geometry';
	import { getDragController } from './core/drag.svelte';
	import type { DockState } from './state.svelte';
	import type { DockNode, PanelContent } from './types';
	import DockedTree from './DockedTree.svelte';

	interface Props {
		node: DockNode;
		dock: DockState;
		panel: Snippet<[PanelContent]>;
		/** Pop-out affordance (spec §5.3 v2), forwarded unchanged from `DockHost` - see its doc comment. Absent in browser mode (no button rendered). */
		onPopOut?: (content: PanelContent) => void;
	}

	let { node, dock, panel, onPopOut }: Props = $props();

	const DRAG_THRESHOLD_PX = 5;
	const drag = getDragController();

	/** Undock-then-close - see the module doc comment on why this is the "close a docked panel" behavior. */
	function closeDockedPanel(id: string): void {
		dock.undockPanel(id);
		dock.close(id);
	}

	/**
	 * Arms a drag candidate on a titlebar/tab pointerdown. `frameEl` is the
	 * pane/tabs-group frame's own element (the one carrying
	 * `data-dock-drop-id`) - its bounding rect at pointerdown time supplies
	 * both the "size to use if this becomes a floating window" and the
	 * "original grab point" the controller needs (see
	 * `core/drag.svelte.ts#DragStartOptions`). `onPlainClick` runs if the
	 * pointer never crosses the threshold (a tab-select click, or nothing for
	 * a plain panel titlebar).
	 */
	function armDrag(
		event: PointerEvent,
		frameEl: HTMLElement,
		content: PanelContent,
		onPlainClick?: () => void
	): void {
		if (event.button !== 0) return;
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const pointerId = event.pointerId;
		const frameRect = frameEl.getBoundingClientRect();
		let dragging = false;

		function onMove(moveEvent: PointerEvent) {
			if (moveEvent.pointerId !== pointerId) return;
			if (dragging) return;
			if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return;
			dragging = true;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			drag.start({
				panelId: content.id,
				title: content.title,
				icon: content.icon,
				source: 'docked',
				width: frameRect.width,
				height: frameRect.height,
				clientX: moveEvent.clientX,
				clientY: moveEvent.clientY,
				originClientX: frameRect.left,
				originClientY: frameRect.top
			});
		}

		function onUp(upEvent: PointerEvent) {
			if (upEvent.pointerId !== pointerId) return;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			if (!dragging) onPlainClick?.();
		}

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// --- split divider resize (a plain incremental pointer drag, unrelated to docking) ---
	let splitW: number = $state(0);
	let splitH: number = $state(0);

	function startDivider(event: PointerEvent, dividerIndex: number, direction: 'row' | 'column'): void {
		if (event.button !== 0) return;
		event.preventDefault();
		const pointerId = event.pointerId;
		const containerSize = direction === 'row' ? splitW : splitH;
		let last = direction === 'row' ? event.clientX : event.clientY;

		function onMove(moveEvent: PointerEvent) {
			if (moveEvent.pointerId !== pointerId) return;
			const pos = direction === 'row' ? moveEvent.clientX : moveEvent.clientY;
			const deltaPx = pos - last;
			last = pos;
			dock.resizeSplit(node.id, dividerIndex, pixelDeltaToFraction(deltaPx, containerSize));
		}
		function onUp(upEvent: PointerEvent) {
			if (upEvent.pointerId !== pointerId) return;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	let panelFrameEl: HTMLDivElement | null = $state(null);
	let tabsFrameEl: HTMLDivElement | null = $state(null);
</script>

{#if node.type === 'panel'}
	<div class="dock-pane" data-dock-drop-id={node.id} bind:this={panelFrameEl} role="group" aria-label={node.title}>
		<div
			class="titlebar"
			role="button"
			tabindex="-1"
			aria-label={node.title}
			onpointerdown={(event) => panelFrameEl && armDrag(event, panelFrameEl, node)}
		>
			{#if node.icon}
				<span class="icon" aria-hidden="true">{node.icon}</span>
			{/if}
			<span class="title">{node.title}</span>
			{#if onPopOut}
				<button
					type="button"
					class="popout-btn"
					aria-label={`${node.title}を別ウィンドウで開く`}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => onPopOut?.(node)}
				>
					⧉
				</button>
			{/if}
			<button
				type="button"
				class="close-btn"
				aria-label={`${node.title}を閉じる`}
				onpointerdown={(event) => event.stopPropagation()}
				onclick={() => closeDockedPanel(node.id)}
			>
				✕
			</button>
		</div>
		<div class="body">
			{@render panel(node)}
		</div>
	</div>
{:else if node.type === 'tabs'}
	{@const active = node.children[node.activeIndex]}
	<div class="dock-pane" data-dock-drop-id={node.id} bind:this={tabsFrameEl} role="group" aria-label={active?.title}>
		<div class="tab-strip" role="tablist">
			{#each node.children as child, i (child.id)}
				<div
					class="tab"
					class:active={i === node.activeIndex}
					role="tab"
					tabindex="-1"
					aria-selected={i === node.activeIndex}
					aria-label={child.title}
					onpointerdown={(event) =>
						tabsFrameEl && armDrag(event, tabsFrameEl, child, () => dock.setActiveTab(node.id, i))}
				>
					{#if child.icon}
						<span class="icon" aria-hidden="true">{child.icon}</span>
					{/if}
					<span class="title">{child.title}</span>
					{#if i === node.activeIndex}
						{#if onPopOut}
							<button
								type="button"
								class="popout-btn"
								aria-label={`${child.title}を別ウィンドウで開く`}
								onpointerdown={(event) => event.stopPropagation()}
								onclick={() => onPopOut?.(child)}
							>
								⧉
							</button>
						{/if}
						<button
							type="button"
							class="close-btn"
							aria-label={`${child.title}を閉じる`}
							onpointerdown={(event) => event.stopPropagation()}
							onclick={() => closeDockedPanel(child.id)}
						>
							✕
						</button>
					{/if}
				</div>
			{/each}
		</div>
		<div class="body">
			{#if active}
				{@render panel(active)}
			{/if}
		</div>
	</div>
{:else}
	<div
		class="dock-split"
		class:row={node.direction === 'row'}
		class:column={node.direction === 'column'}
		bind:clientWidth={splitW}
		bind:clientHeight={splitH}
	>
		{#each node.children as child, i (child.id)}
			<div class="split-child" style:flex-grow={node.sizes[i] ?? 0} style:flex-basis="0%">
				<DockedTree node={child} {dock} {panel} {onPopOut} />
			</div>
			{#if i < node.children.length - 1}
				<div
					class="divider"
					class:row={node.direction === 'row'}
					class:column={node.direction === 'column'}
					role="separator"
					aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
					aria-label="パネルのサイズ変更"
					onpointerdown={(event) => startDivider(event, i, node.direction)}
				></div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.dock-pane {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		background: var(--banto-surface);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.titlebar {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		height: var(--banto-dock-titlebar-height);
		padding: 0 0.4rem 0 0.7rem;
		background: var(--banto-surface-raised);
		border-bottom: 1px solid var(--banto-border);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--banto-text);
		user-select: none;
		touch-action: none;
		cursor: move;
	}

	.tab-strip {
		flex: 0 0 auto;
		display: flex;
		align-items: stretch;
		height: var(--banto-dock-titlebar-height);
		background: var(--banto-surface-raised);
		border-bottom: 1px solid var(--banto-border);
		overflow-x: auto;
		overflow-y: hidden;
	}

	.tab {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0 0.5rem 0 0.7rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--banto-text-muted);
		border-right: 1px solid var(--banto-border);
		user-select: none;
		touch-action: none;
		cursor: pointer;
		max-width: 12rem;
	}

	.tab.active {
		color: var(--banto-text);
		background: var(--banto-dock-tab-active-bg);
		box-shadow: inset 0 -2px 0 var(--banto-primary);
	}

	.icon {
		flex: 0 0 auto;
		font-size: 0.9rem;
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.close-btn,
	.popout-btn {
		flex: 0 0 auto;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--banto-radius);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
		font-size: 0.7rem;
		touch-action: none;
	}

	.close-btn:hover {
		background: color-mix(in srgb, var(--banto-danger) 15%, transparent);
		color: var(--banto-danger);
	}

	.popout-btn:hover {
		background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
		color: var(--banto-primary);
	}

	.close-btn:focus-visible,
	.popout-btn:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: auto;
		background: var(--banto-surface);
	}

	.dock-split {
		display: flex;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}

	.dock-split.row {
		flex-direction: row;
	}

	.dock-split.column {
		flex-direction: column;
	}

	.split-child {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.divider {
		flex: 0 0 auto;
		background: var(--banto-dock-divider);
		touch-action: none;
	}

	.divider:hover {
		background: var(--banto-dock-divider-hover);
	}

	.divider.row {
		width: 6px;
		cursor: col-resize;
	}

	.divider.column {
		height: 6px;
		cursor: row-resize;
	}
</style>
