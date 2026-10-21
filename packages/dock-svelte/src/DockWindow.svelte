<script lang="ts">
	/**
	 * Internal chrome for one floating pseudo-window: titlebar (icon + title +
	 * close button) + scrollable body + 8 resize handles (4 edges, 4
	 * corners). Not exported from index.ts - DockHost is the only public
	 * surface.
	 *
	 * Resize and the title-bar drag are sessions of the host's single
	 * `GestureOwner` (`core/gesture.svelte.ts`, shared-primitives-upstream-plan
	 * §3.3, #433), which holds the window-level listeners (no
	 * setPointerCapture - see grid-svelte's HeaderCell.svelte for why: it is
	 * per-element and a stray double-click can wedge a later, unrelated drag),
	 * checks the owning pointer, and cancels on Esc / pointercancel / blur /
	 * unmount by restoring the pre-gesture layout. Each resize event applies an INCREMENTAL delta
	 * (this event's client position minus the previous one, not the original
	 * pointerdown position) so that once the pointer re-enters the host's
	 * valid range after dragging past a clamp boundary, the window immediately
	 * starts following it again instead of staying stuck until the cumulative
	 * delta "catches up".
	 *
	 * Titlebar drag (M8 Phase B) no longer live-moves the window itself -
	 * it's a drag SOURCE for the shared `DragController` (`core/drag.svelte.
	 * ts`), same as a docked pane's titlebar/tab in `DockedTree.svelte`, so a
	 * floating window can also be dropped onto the docked tree to dock it. A
	 * plain reposition (dropped back into empty floating space) is applied
	 * once, on release, via the existing `dock.move` - unchanged from M7.
	 *
	 * Front-most: `pointerdown` AND `focusin` on the root bring the window to
	 * the front (#433: Tab / a click into a back window's input must raise it
	 * too). `DockHost` keeps the window DOM order stable and stacks by
	 * z-index, so raising never moves the focused element in the DOM.
	 */
	import type { Snippet } from 'svelte';
	import { getDragController } from './core/drag.svelte';
	import { displayWindowGeometry } from './core/geometry';
	import { getGestureOwner } from './core/gesture.svelte';
	import { getDockPolicy, resolveCapabilities } from './core/policy';
	import type { DockState } from './state.svelte';
	import type { FloatingWindow, PanelContent, ResizeEdge } from './types';
	import { defaultDockMessages, type DockMessages } from './messages';

	interface Props {
		win: FloatingWindow;
		dock: DockState;
		hostW: number;
		hostH: number;
		frontmost: boolean;
		/** Stacking order inside the host's floating layer (1 = back). `DockHost` derives it from the window's index in `layout.floating` (= z-order) while keeping the DOM order stable. */
		zIndex: number;
		panel: Snippet<[PanelContent]>;
		/** Pop-out affordance (spec §5.3 v2), forwarded unchanged from `DockHost` - see its doc comment. Absent in browser mode (no button rendered). */
		onPopOut?: (content: PanelContent) => void;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<DockMessages>;
	}

	let {
		win,
		dock,
		hostW,
		hostH,
		frontmost,
		zIndex,
		panel,
		onPopOut,
		messages = {}
	}: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultDockMessages, ...messages };

	const DRAG_THRESHOLD_PX = 5;
	const drag = getDragController();
	const gesture = getGestureOwner();
	const policy = getDockPolicy();

	// What is DRAWN: the saved preference clamped to the current host. The saved
	// layout is untouched (shared-primitives-upstream-plan §3.2, #434).
	const shown = $derived(displayWindowGeometry(win, hostW, hostH, policy.clamp));
	const caps = $derived(resolveCapabilities(policy, win.id));

	function focusThis(): void {
		dock.focus(win.id);
	}

	let windowEl: HTMLDivElement | null = $state(null);

	/**
	 * Title-bar press: a `drag-candidate` session on the shared GestureOwner
	 * that becomes a `drag` (ghost + snap guide via the DragController) once the
	 * owning pointer crosses `DRAG_THRESHOLD_PX`. Commit / cancel rules are the
	 * owner's (`core/gesture.svelte.ts`, #433): only this pointer's pointerup
	 * drops; Esc / pointercancel / blur / unmount drop nothing.
	 */
	function handleTitlebarPointerDown(event: PointerEvent) {
		if (event.button !== 0 || event.isPrimary === false || gesture.active) return;
		event.preventDefault();
		focusThis();
		// `move: false` (consumer capability): the title bar still focuses the window but never starts a drag.
		if (!caps.move || !windowEl) return;

		const startX = event.clientX;
		const startY = event.clientY;
		const winRect = windowEl.getBoundingClientRect();
		let dragging = false;

		gesture.begin(event, {
			kind: 'drag-candidate',
			panelId: win.id,
			activeLayer: windowEl,
			move(moveEvent) {
				if (dragging) {
					drag.update(moveEvent.clientX, moveEvent.clientY);
					return;
				}
				if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX)
					return;
				dragging = true;
				gesture.setKind('drag');
				drag.start({
					panelId: win.id,
					title: win.title,
					icon: win.icon,
					source: 'floating',
					width: shown.width,
					height: shown.height,
					clientX: moveEvent.clientX,
					clientY: moveEvent.clientY,
					originClientX: winRect.left,
					originClientY: winRect.top
				});
			},
			commit(upEvent) {
				if (dragging) drag.commit(upEvent.clientX, upEvent.clientY);
			},
			cancel() {
				drag.cancel();
			}
		});
	}

	/**
	 * Resize handle press: a `resize` session. Each owning-pointer move applies
	 * an INCREMENTAL delta (see the module doc) against the host size read from
	 * layout at that moment (`gesture.measureHost()`), not the `hostW`/`hostH`
	 * props - those follow the ResizeObserver and can lag behind a window
	 * resize. The release applies its own last delta against a freshly measured
	 * host, so the committed geometry is clamped to the host as it is NOW.
	 * Cancel puts back only this window's geometry from before the press (#433).
	 */
	function handleResizePointerDown(event: PointerEvent, edge: ResizeEdge) {
		// The handle sits on the window's own edge, so a pointerdown here would
		// otherwise also bubble into the root's focus handler - harmless (focus
		// is idempotent) but stopped anyway for clarity.
		event.stopPropagation();
		if (event.button !== 0 || event.isPrimary === false || gesture.active) return;
		event.preventDefault();
		focusThis();

		let lastX = event.clientX;
		let lastY = event.clientY;
		const step = (e: PointerEvent) => {
			const dx = e.clientX - lastX;
			const dy = e.clientY - lastY;
			lastX = e.clientX;
			lastY = e.clientY;
			const host = gesture.measureHost();
			dock.resize(win.id, edge, dx, dy, host.width, host.height, policy.clamp);
		};
		gesture.begin(event, {
			kind: 'resize',
			panelId: win.id,
			activeLayer: windowEl,
			move: step,
			commit: step,
			restore: (snapshot) => dock.restoreWindowGeometry(win.id, snapshot)
		});
	}

	const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
</script>

<!--
	role="dialog": each floating window is a self-contained pseudo-window
	(spec §5.3: single-webview, not a real OS window). No focus trap - v1
	pseudo-windows are non-modal, so Tab is free to move between them and the
	rest of the page. tabindex="-1" satisfies the interactive-role a11y rule
	(a dialog must be programmatically focusable) without joining the natural
	Tab order - the titlebar's close button is the real keyboard entry point.
-->
<div
	class="dock-window"
	class:frontmost
	role="dialog"
	aria-label={win.title}
	tabindex="-1"
	bind:this={windowEl}
	style:left={`${shown.x}px`}
	style:top={`${shown.y}px`}
	style:width={`${shown.width}px`}
	style:height={`${shown.height}px`}
	style:z-index={zIndex}
	onpointerdown={focusThis}
	onfocusin={focusThis}
>
	<!--
		Titlebar + body live in `.frame`, which is what actually clips content
		to the window's rounded corners (`overflow: hidden`). The resize
		handles below are siblings of `.frame`, NOT inside it - they're
		positioned a few px OUTSIDE the window's own box (e.g. `right: -3px`)
		to make them easy to grab, and `.frame`'s overflow:hidden would clip
		them (and swallow their pointer events) if they were nested inside it.
	-->
	<div class="frame">
		<!--
			Dragging the titlebar is pointer-only in v1 (spec §5.2 describes free
			drag/resize for floating panels; no keyboard-move equivalent is
			specified). Same class of limitation as the resize handles below -
			suppressed rather than "fixed" by inventing a keyboard interaction
			that isn't part of this milestone's scope.
		-->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="titlebar" class:immovable={!caps.move} onpointerdown={handleTitlebarPointerDown}>
			{#if win.icon}
				<span class="icon" aria-hidden="true">{win.icon}</span>
			{/if}
			<span class="title">{win.title}</span>
			{#if onPopOut && caps.undock}
				<button
					type="button"
					class="popout-btn"
					aria-label={t.popOut(win.title)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => onPopOut?.(win)}
				>
					⧉
				</button>
			{/if}
			{#if caps.close}
				<button
					type="button"
					class="close-btn"
					aria-label={t.close(win.title)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => dock.close(win.id)}
				>
					✕
				</button>
			{/if}
		</div>

		<!-- role="region" + tabindex="0": same scrollable-region-focusable
		     rationale (and svelte-ignore, for the same landmark-vs-tabindex
		     disagreement between svelte-check and axe) as `DockedTree.svelte`'s
		     `.body`. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="body" role="region" aria-label={win.title} tabindex="0">
			{@render panel(win)}
		</div>
	</div>

	<!-- Resize handles: pointer-only in v1 (no keyboard resize equivalent yet), so hidden from assistive tech. -->
	{#each RESIZE_EDGES as edge (edge)}
		<div
			class={`handle handle-${edge}`}
			aria-hidden="true"
			onpointerdown={(event) => handleResizePointerDown(event, edge)}
		></div>
	{/each}
</div>

<style>
	.dock-window {
		position: absolute;
		/* DockHost's floating layer is pointer-transparent; the window itself is not. */
		pointer-events: auto;
		border-radius: var(--banto-radius-lg);
		border: 1px solid var(--banto-border);
		box-shadow: var(--banto-dock-shadow);
		background: var(--banto-surface);
		/* Glass preset (spec M12): blur what's behind the window when the
		   theme sets --banto-backdrop; `none` (the standard default) keeps
		   this a complete no-op. */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		transition: border-color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.dock-window.frontmost {
		border-color: color-mix(in srgb, var(--banto-primary) 55%, var(--banto-border));
	}

	.frame {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		overflow: hidden;
		border-radius: inherit;
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
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.titlebar.immovable {
		cursor: default;
	}

	.titlebar:hover {
		background: var(--banto-surface-hover);
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
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
		font-size: 0.75rem;
		touch-action: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
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
		overflow: auto;
		background: var(--banto-surface);
	}

	.body:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.handle {
		position: absolute;
		touch-action: none;
		z-index: 5;
	}

	.handle-n {
		top: -3px;
		left: 10px;
		right: 10px;
		height: 6px;
		cursor: ns-resize;
	}

	.handle-s {
		bottom: -3px;
		left: 10px;
		right: 10px;
		height: 6px;
		cursor: ns-resize;
	}

	.handle-e {
		right: -3px;
		top: 10px;
		bottom: 10px;
		width: 6px;
		cursor: ew-resize;
	}

	.handle-w {
		left: -3px;
		top: 10px;
		bottom: 10px;
		width: 6px;
		cursor: ew-resize;
	}

	.handle-ne {
		top: -5px;
		right: -5px;
		width: 10px;
		height: 10px;
		cursor: nesw-resize;
	}

	.handle-nw {
		top: -5px;
		left: -5px;
		width: 10px;
		height: 10px;
		cursor: nwse-resize;
	}

	.handle-se {
		bottom: -5px;
		right: -5px;
		width: 10px;
		height: 10px;
		cursor: nwse-resize;
	}

	.handle-sw {
		bottom: -5px;
		left: -5px;
		width: 10px;
		height: 10px;
		cursor: nesw-resize;
	}
</style>
