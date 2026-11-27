<script lang="ts">
	/**
	 * Three-pane frame (Issue #631 PR-1; props and the width rules in
	 * `threePane.ts`): left = pick the target, centre = work on it (under a
	 * band with the two pane toggles and the target's name), right = details
	 * of the selected row. Shapes banto-industrial banto-hub's `SplitPane`
	 * (#378 / #381) into a package part: the frame decides narrow by its **own**
	 * width (ResizeObserver, not the viewport), so it works inside a dock
	 * window or next to a sidebar too.
	 *
	 * - Wide: panes in a row, each side foldable from its toggle and
	 *   resizable from a `role="separator"` handle (drag, ←/→, Home / End).
	 * - Narrow (`<= narrowBreakpoint`): the side panes become drawers over the
	 *   centre (left from the left edge, right from the right edge), one at a
	 *   time, with a scrim. Open = focus moves in, the centre goes `inert`; Esc,
	 *   the scrim or the app (`leftDrawerOpen = false`) closes and focus goes
	 *   back to where it was (else the toggle). A modal drawer is a
	 *   `role="dialog"` `aria-modal="true"` that traps focus (#1045: Tab wraps inside;
	 *   with nothing focusable inside, the pane itself holds focus). A non-modal layer that follows
	 *   `layering.ts`'s promises: `data-esc-layer` while open, Esc at window
	 *   level (modal drawers only; a non-modal drawer closes on Esc only with
	 *   focus inside it) that yields to a layer above, `visibility: hidden` + `inert` when
	 *   closed, never transitioning `visibility` on open.
	 *
	 * The panes stay mounted across every switch (wide <-> narrow, fold,
	 * drawer), so a tree keeps its expansion and scroll.
	 */
	import { tick, untrack } from 'svelte';
	import IconButton from './IconButton.svelte';
	import PanelLeft from './icons/PanelLeft.svelte';
	import PanelRight from './icons/PanelRight.svelte';
	import {
		attachFocusTrap,
		focusablesIn,
		hasVisibleLayerAbove,
		inertOutside,
		restoreFocus
	} from './layering';
	import { defaultUiMessages } from './messages';
	import {
		clampPaneWidth,
		fitPaneWidths,
		isNarrowWidth,
		paneMaxWidth,
		THREE_PANE_DEFAULTS as D,
		type ThreePaneLayoutProps
	} from './threePane';

	type Side = 'left' | 'right';

	let {
		left,
		right,
		children,
		title,
		titleContent,
		leftWidth = $bindable(D.leftWidth),
		rightWidth = $bindable(D.rightWidth),
		leftMinWidth = D.leftMinWidth,
		leftMaxWidth = D.leftMaxWidth,
		rightMinWidth = D.rightMinWidth,
		rightMaxWidth = D.rightMaxWidth,
		centerMinWidth = D.centerMinWidth,
		leftOpen = $bindable(true),
		rightOpen = $bindable(true),
		leftCollapsed = $bindable(false),
		rightCollapsed = $bindable(false),
		leftDrawerOpen = $bindable(false),
		rightDrawerOpen = $bindable(false),
		leftDrawerModal = true,
		rightDrawerModal = true,
		narrowBreakpoint = D.narrowBreakpoint,
		narrowOverride,
		narrow = $bindable(false),
		leftToggleEl = $bindable(),
		rightToggleEl = $bindable(),
		onToggle,
		resizeStep = D.resizeStep,
		messages
	}: ThreePaneLayoutProps = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });
	const uid = $props.id();
	const leftId = `${uid}-left`;
	const rightId = `${uid}-right`;

	let rootEl: HTMLDivElement | undefined = $state();
	let bandEl: HTMLDivElement | undefined = $state();
	let leftEl: HTMLElement | undefined = $state();
	let rightEl: HTMLElement | undefined = $state();

	/** Frame width from the ResizeObserver; `null` until measured. */
	let frameWidth: number | null = $state(null);
	const isNarrow = $derived(narrowOverride ?? isNarrowWidth(frameWidth, narrowBreakpoint));

	/** A pane exists only while its snippet is given and the app has it `open`. */
	const leftShown = $derived(!!left && leftOpen);
	const rightShown = $derived(!!right && rightOpen);

	$effect.pre(() => {
		const value = isNarrow;
		untrack(() => {
			if (narrow !== value) narrow = value;
		});
	});

	/*
	 * The drawers slide only once the layout has settled: not on the first
	 * measurement (a frame that mounts narrow would slide its panes away on
	 * load) and not on a wide <-> narrow switch - only on open / close.
	 */
	let settled = $state(false);
	$effect(() => {
		void isNarrow;
		settled = false;
		if (typeof requestAnimationFrame !== 'function') return;
		let id = requestAnimationFrame(() => {
			id = requestAnimationFrame(() => (settled = true));
		});
		return () => cancelAnimationFrame(id);
	});

	$effect(() => {
		const node = rootEl;
		if (!node) return;
		const read = (width: number | undefined) => {
			// 0 = not laid out (a hidden tab): keep the last answer.
			if (width !== undefined && width > 0) frameWidth = width;
		};
		read(node.getBoundingClientRect().width);
		if (typeof ResizeObserver !== 'function') return;
		const observer = new ResizeObserver((entries) => {
			read(entries[0]?.contentRect.width ?? node.getBoundingClientRect().width);
		});
		observer.observe(node);
		return () => observer.disconnect();
	});

	// --- widths -------------------------------------------------------------

	const leftAsked = $derived(clampPaneWidth(leftWidth, leftMinWidth, leftMaxWidth));
	const rightAsked = $derived(clampPaneWidth(rightWidth, rightMinWidth, rightMaxWidth));
	const leftInRow = $derived(leftShown && !isNarrow && !leftCollapsed);
	const rightInRow = $derived(rightShown && !isNarrow && !rightCollapsed);
	const shown = $derived(
		fitPaneWidths({
			available: frameWidth,
			left: leftInRow ? leftAsked : 0,
			right: rightInRow ? rightAsked : 0,
			leftMin: clampPaneWidth(leftMinWidth, leftMinWidth, leftMaxWidth),
			rightMin: clampPaneWidth(rightMinWidth, rightMinWidth, rightMaxWidth),
			centerMin: centerMinWidth
		})
	);
	const leftMax = $derived(
		paneMaxWidth({
			available: frameWidth,
			max: leftMaxWidth,
			min: leftMinWidth,
			other: shown.right,
			centerMin: centerMinWidth
		})
	);
	const rightMax = $derived(
		paneMaxWidth({
			available: frameWidth,
			max: rightMaxWidth,
			min: rightMinWidth,
			other: shown.left,
			centerMin: centerMinWidth
		})
	);
	/** Narrow: the drawer's width is the asked-for one (CSS caps it to the frame). */
	const leftStyleWidth = $derived(isNarrow ? leftAsked : shown.left);
	const rightStyleWidth = $derived(isNarrow ? rightAsked : shown.right);

	function setWidth(side: Side, value: number): void {
		if (side === 'left') leftWidth = clampPaneWidth(value, leftMinWidth, leftMax);
		else rightWidth = clampPaneWidth(value, rightMinWidth, rightMax);
	}

	function handleKeydown(side: Side, event: KeyboardEvent): void {
		const now = side === 'left' ? shown.left : shown.right;
		const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
		const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
		let next: number;
		if (event.key === grow) next = now + resizeStep;
		else if (event.key === shrink) next = now - resizeStep;
		else if (event.key === 'Home') next = side === 'left' ? leftMinWidth : rightMinWidth;
		else if (event.key === 'End') next = side === 'left' ? leftMax : rightMax;
		else return;
		event.preventDefault();
		setWidth(side, next);
	}

	/** The drag in progress: removing it ends the drag (pointer up, narrow, fold, unmount). */
	let dragging: { side: Side; stop: () => void } | null = $state(null);

	function startDrag(side: Side, event: PointerEvent): void {
		if (event.button !== 0 || dragging) return;
		const handle = event.currentTarget as HTMLElement;
		event.preventDefault();
		// Click and focus agree: the handle the pointer took is the one the keys move.
		handle.focus();
		const startX = event.clientX;
		const startWidth = side === 'left' ? shown.left : shown.right;
		const pointerId = event.pointerId;
		const onMove = (move: PointerEvent) => {
			if (move.pointerId !== pointerId) return;
			const delta = move.clientX - startX;
			setWidth(side, side === 'left' ? startWidth + delta : startWidth - delta);
		};
		const onEnd = (end: PointerEvent) => {
			if (end.pointerId === pointerId) stop();
		};
		const stop = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onEnd);
			window.removeEventListener('pointercancel', onEnd);
			if (dragging?.stop === stop) dragging = null;
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onEnd);
		window.addEventListener('pointercancel', onEnd);
		dragging = { side, stop };
	}

	// A drag ends when its handle goes away (narrow, folded) or the frame unmounts.
	$effect(() => {
		const drag = dragging;
		if (drag && (drag.side === 'left' ? !leftInRow : !rightInRow)) drag.stop();
	});
	$effect(() => () => untrack(() => dragging)?.stop());

	// --- open / fold --------------------------------------------------------

	const leftOverlay = $derived(leftShown && isNarrow && leftDrawerOpen);
	const rightOverlay = $derived(rightShown && isNarrow && rightDrawerOpen);
	const anyOverlay = $derived(leftOverlay || rightOverlay);
	/** An open drawer that is modal: centre `inert`, scrim, focus moves in. */
	const modalOverlay = $derived(
		(leftOverlay && leftDrawerModal) || (rightOverlay && rightDrawerModal)
	);
	const leftHidden = $derived(isNarrow ? !leftDrawerOpen : leftCollapsed);
	const rightHidden = $derived(isNarrow ? !rightDrawerOpen : rightCollapsed);

	function toggle(side: Side): void {
		// Before the state changes; `open` is what the pane will be after the press.
		const wasOpen = isNarrow
			? side === 'left'
				? leftDrawerOpen
				: rightDrawerOpen
			: !(side === 'left' ? leftCollapsed : rightCollapsed);
		onToggle?.(side, !wasOpen);
		if (isNarrow) {
			if (side === 'left') {
				leftDrawerOpen = !leftDrawerOpen;
				if (leftDrawerOpen) rightDrawerOpen = false;
			} else {
				rightDrawerOpen = !rightDrawerOpen;
				if (rightDrawerOpen) leftDrawerOpen = false;
			}
		} else if (side === 'left') leftCollapsed = !leftCollapsed;
		else rightCollapsed = !rightCollapsed;
	}

	function closeDrawers(): void {
		leftDrawerOpen = false;
		rightDrawerOpen = false;
	}

	/*
	 * Drawer state outside the narrow layout means nothing, so it is reset on
	 * the way to wide (else the drawer would reappear open on the next narrow,
	 * and an app reading `leftDrawerOpen` would see a stale `true`). In the
	 * narrow layout one drawer at a time: whichever was opened last stays.
	 *
	 * Nothing is touched until the frame has been measured: before that
	 * `isNarrow` is false only because the width is unknown, and resetting then
	 * would throw away a drawer the app asked to start open. Once measured, a
	 * frame that starts wide still drops a stale open (drawers never show wide).
	 */
	let lastLeftOpen = false;
	$effect.pre(() => {
		const measured = frameWidth !== null;
		const narrowNow = isNarrow;
		const l = leftDrawerOpen;
		const r = rightDrawerOpen;
		const lGone = !leftShown;
		const rGone = !rightShown;
		untrack(() => {
			// A pane the app took away (`open = false`) leaves no stale drawer state behind.
			if (lGone && leftDrawerOpen) leftDrawerOpen = false;
			if (rGone && rightDrawerOpen) rightDrawerOpen = false;
			if (!measured) return;
			if (!narrowNow) {
				if (l) leftDrawerOpen = false;
				if (r) rightDrawerOpen = false;
			} else if (l && r) {
				if (!lastLeftOpen) rightDrawerOpen = false;
				else leftDrawerOpen = false;
			}
			lastLeftOpen = leftDrawerOpen;
		});
	});

	// The band's toggles, handed out for the app (read-only output).
	$effect(() => {
		void bandEl;
		void leftShown;
		void rightShown;
		const l = toggleOf('left') ?? undefined;
		const r = toggleOf('right') ?? undefined;
		untrack(() => {
			if (leftToggleEl !== l) leftToggleEl = l;
			if (rightToggleEl !== r) rightToggleEl = r;
		});
	});

	function toggleOf(side: Side): HTMLElement | null {
		return (
			bandEl?.querySelector<HTMLElement>(
				`[aria-controls="${side === 'left' ? leftId : rightId}"]`
			) ?? null
		);
	}

	/*
	 * Focus follows the panes (layering.ts promises 5 / 6). Decided before the
	 * DOM update (`$effect.pre`): once `inert` is on, the browser has already
	 * dropped focus to `<body>` and "was it inside?" can no longer be told.
	 * Moved after it (`tick()`), when the target is no longer inert.
	 *
	 * - A drawer opens: remember the focused element, focus the first
	 *   focusable inside (or the pane).
	 * - A pane hides (drawer closes, fold, wide -> narrow) with focus inside -
	 *   or, for a drawer, with focus already dropped (a scrim click): back to
	 *   the remembered element, else the toggle (always present in the band).
	 * - Transitions only: the effect also reads the width, which changes often.
	 */
	type Track = {
		ready: boolean;
		hidden: boolean;
		overlay: boolean;
		modal: boolean;
		trigger: HTMLElement | null;
	};
	const tracks: Record<Side, Track> = {
		left: { ready: false, hidden: false, overlay: false, modal: false, trigger: null },
		right: { ready: false, hidden: false, overlay: false, modal: false, trigger: null }
	};

	function follow(
		side: Side,
		hidden: boolean,
		overlay: boolean,
		modal: boolean,
		measured: boolean
	): void {
		const track = tracks[side];
		const pane = side === 'left' ? leftEl : rightEl;
		// Unmeasured: the state is a placeholder (wide). Wait for the real one, so
		// a drawer that starts open is the baseline, not an "opening" that takes focus.
		if (!measured) return;
		if (!track.ready) {
			Object.assign(track, { ready: true, hidden, overlay, modal });
			return;
		}
		// A non-modal drawer opens beside the work: focus stays where it is.
		if (overlay && modal && !track.overlay) {
			const active = document.activeElement;
			track.trigger = active instanceof HTMLElement && active !== document.body ? active : null;
			void tick().then(() => {
				if (!pane || !(side === 'left' ? leftOverlay : rightOverlay)) return;
				(focusablesIn(pane)[0] ?? pane).focus();
			});
		}
		if (hidden && !track.hidden) {
			const active = document.activeElement;
			const inside = !!pane && active instanceof Node && pane.contains(active);
			const dropped = track.overlay && track.modal && (!active || active === document.body);
			const target = track.overlay ? track.trigger : null;
			track.trigger = null;
			if (inside || dropped) {
				void tick().then(() => restoreFocus(target, () => toggleOf(side)));
			}
		} else if (!overlay && track.overlay) {
			// Drawer gone because the frame went wide: the pane is in the row now.
			track.trigger = null;
		}
		track.hidden = hidden;
		track.overlay = overlay;
		track.modal = modal;
	}

	$effect.pre(() => {
		const hidden = leftHidden;
		const overlay = leftOverlay;
		const modal = leftDrawerModal;
		const measured = frameWidth !== null;
		untrack(() => follow('left', hidden, overlay, modal, measured));
	});
	$effect.pre(() => {
		const hidden = rightHidden;
		const overlay = rightOverlay;
		const modal = rightDrawerModal;
		const measured = frameWidth !== null;
		untrack(() => follow('right', hidden, overlay, modal, measured));
	});

	/*
	 * Esc closes the open drawer (layering.ts promises 1-3): the pane's own
	 * keydown consumes and stops it (other window handlers never see it); for a
	 * modal drawer the window listener covers focus elsewhere (a non-modal one
	 * closes only with focus inside, so the centre's own Esc is left alone). Both yield to a layer above (a
	 * Modal opened from the drawer, a menu).
	 */
	$effect(() => {
		if (!anyOverlay) return;
		const pane = leftOverlay ? leftEl : rightEl;
		if (!pane) return;
		// Only one drawer is open at a time; which one decides the modality.
		const modal = leftOverlay ? leftDrawerModal : rightDrawerModal;
		const onPane = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			if (hasVisibleLayerAbove({ except: pane })) return;
			event.preventDefault();
			event.stopPropagation();
			closeDrawers();
		};
		const onWindow = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			if (hasVisibleLayerAbove({ except: pane })) return;
			event.preventDefault();
			closeDrawers();
		};
		pane.addEventListener('keydown', onPane);
		// A non-modal drawer sits beside live work in the centre (a grid cell
		// edit, a search box): their Esc must not close it, so no window listener.
		if (modal) window.addEventListener('keydown', onWindow);
		// A modal drawer traps focus (#1045): Tab wraps inside, and with nothing focusable the
		// pane itself keeps it (it is `tabindex="-1"`), so focus never leaves for the shell behind
		// the scrim or falls to `<body>`.
		const detachTrap = modal ? attachFocusTrap(pane) : null;
		// ...and the shell around the layout (header, sidebar) goes inert too: the scrim only covers
		// the layout, and `aria-modal` hides the rest from assistive technology, so clicks must stop.
		const releaseOutside = modal && rootEl ? inertOutside(rootEl) : null;
		return () => {
			detachTrap?.();
			releaseOutside?.();
			pane.removeEventListener('keydown', onPane);
			if (modal) window.removeEventListener('keydown', onWindow);
		};
	});
</script>

<div
	class="three-pane"
	class:three-pane--narrow={isNarrow}
	class:three-pane--dragging={dragging !== null}
	class:three-pane--settled={settled}
	bind:this={rootEl}
>
	{#if left && leftOpen}
		<aside
			bind:this={leftEl}
			id={leftId}
			class="three-pane__side three-pane__side--left"
			class:is-open={leftOverlay}
			aria-label={t.threePaneLeft()}
			style:--three-pane-width="{leftStyleWidth}px"
			hidden={!isNarrow && leftCollapsed}
			inert={leftHidden}
			tabindex="-1"
			data-esc-layer={leftOverlay ? '' : undefined}
			role={leftOverlay && leftDrawerModal ? 'dialog' : undefined}
			aria-modal={leftOverlay && leftDrawerModal ? 'true' : undefined}
		>
			<div class="three-pane__body">{@render left()}</div>
			{#if leftInRow}
				<!-- A focusable separator (with aria-valuenow) is a widget in ARIA; Svelte's table lists it as static. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					class="three-pane__handle three-pane__handle--left"
					role="separator"
					tabindex="0"
					aria-orientation="vertical"
					aria-label={t.threePaneResizeLeft()}
					aria-controls={leftId}
					aria-valuenow={Math.round(shown.left)}
					aria-valuemin={Math.round(clampPaneWidth(leftMinWidth, leftMinWidth, leftMaxWidth))}
					aria-valuemax={Math.round(leftMax)}
					onpointerdown={(event) => startDrag('left', event)}
					onkeydown={(event) => handleKeydown('left', event)}
				></div>
			{/if}
		</aside>
	{/if}

	<div class="three-pane__center" inert={modalOverlay}>
		<div class="three-pane__band" bind:this={bandEl}>
			{#if leftShown}
				<IconButton
					label={t.threePaneLeft()}
					icon={PanelLeft}
					expanded={!leftHidden}
					controls={leftId}
					onclick={() => toggle('left')}
				/>
			{/if}
			<div class="three-pane__title">
				{#if titleContent}{@render titleContent()}{:else if title}{title}{/if}
			</div>
			{#if rightShown}
				<IconButton
					label={t.threePaneRight()}
					icon={PanelRight}
					expanded={!rightHidden}
					controls={rightId}
					onclick={() => toggle('right')}
				/>
			{/if}
		</div>
		<div class="three-pane__body">{@render children()}</div>
	</div>

	{#if right && rightOpen}
		<aside
			bind:this={rightEl}
			id={rightId}
			class="three-pane__side three-pane__side--right"
			class:is-open={rightOverlay}
			aria-label={t.threePaneRight()}
			style:--three-pane-width="{rightStyleWidth}px"
			hidden={!isNarrow && rightCollapsed}
			inert={rightHidden}
			tabindex="-1"
			data-esc-layer={rightOverlay ? '' : undefined}
			role={rightOverlay && rightDrawerModal ? 'dialog' : undefined}
			aria-modal={rightOverlay && rightDrawerModal ? 'true' : undefined}
		>
			{#if rightInRow}
				<!-- A focusable separator (with aria-valuenow) is a widget in ARIA; Svelte's table lists it as static. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					class="three-pane__handle three-pane__handle--right"
					role="separator"
					tabindex="0"
					aria-orientation="vertical"
					aria-label={t.threePaneResizeRight()}
					aria-controls={rightId}
					aria-valuenow={Math.round(shown.right)}
					aria-valuemin={Math.round(clampPaneWidth(rightMinWidth, rightMinWidth, rightMaxWidth))}
					aria-valuemax={Math.round(rightMax)}
					onpointerdown={(event) => startDrag('right', event)}
					onkeydown={(event) => handleKeydown('right', event)}
				></div>
			{/if}
			<div class="three-pane__body">{@render right()}</div>
		</aside>
	{/if}

	{#if modalOverlay}
		<!-- Pointer-only: Esc is the keyboard's way out (layering.ts). `data-three-pane-scrim` is the hook for apps and tests. -->
		<div
			class="three-pane__scrim"
			role="presentation"
			data-three-pane-scrim=""
			onclick={closeDrawers}
		></div>
	{/if}
</div>

<style>
	.three-pane {
		/* Own stacking context: the drawers sit over the centre only, never
		   over the app's Modal / Drawer / menus (--banto-z-*). */
		position: relative;
		isolation: isolate;
		display: flex;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		color: var(--banto-text);
		background: var(--banto-surface);
	}

	.three-pane--dragging {
		cursor: col-resize;
		user-select: none;
	}

	.three-pane__side {
		position: relative;
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		width: var(--three-pane-width);
		min-width: 0;
		min-height: 0;
		background: var(--banto-surface);
		outline: none;
	}

	.three-pane__side[hidden] {
		display: none;
	}

	.three-pane__side--left {
		border-right: var(--banto-border-width) solid var(--banto-border);
	}

	.three-pane__side--right {
		border-left: var(--banto-border-width) solid var(--banto-border);
	}

	.three-pane__center {
		flex: 1 1 0;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.three-pane__band {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		min-height: var(--banto-control-height);
		padding: var(--banto-space-1) var(--banto-space-2);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
	}

	.three-pane__title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.three-pane__body {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
	}

	/* The handle straddles the pane's edge (no width of its own in the row). */
	.three-pane__handle {
		--three-pane-handle: 8px;
		position: absolute;
		inset-block: 0;
		z-index: 1;
		width: var(--three-pane-handle);
		cursor: col-resize;
		touch-action: none;
	}

	.three-pane__handle--left {
		right: calc(var(--three-pane-handle) / -2);
	}

	.three-pane__handle--right {
		left: calc(var(--three-pane-handle) / -2);
	}

	.three-pane__handle:hover,
	.three-pane__handle:focus-visible,
	.three-pane--dragging .three-pane__handle {
		background: color-mix(in srgb, var(--banto-primary) 35%, transparent);
	}

	.three-pane__handle:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* Narrow: the side panes become drawers over the centre. */
	.three-pane--narrow .three-pane__side {
		position: absolute;
		inset-block: 0;
		z-index: 2;
		width: min(var(--three-pane-width), calc(100% - var(--banto-space-8)));
		visibility: hidden;
		box-shadow: var(--banto-shadow-lg);
	}

	/* Slide only on open / close (`settled`), not on load or a layout switch. */
	.three-pane--settled.three-pane--narrow .three-pane__side {
		transition:
			transform var(--banto-duration-base) var(--banto-ease-out),
			visibility var(--banto-duration-base) var(--banto-ease-out);
	}

	.three-pane--narrow .three-pane__side--left {
		left: 0;
		transform: translateX(-100%);
	}

	.three-pane--narrow .three-pane__side--right {
		right: 0;
		transform: translateX(100%);
	}

	/* Open: visible from the first frame (layering.ts promise 6). */
	.three-pane--narrow .three-pane__side.is-open {
		transform: none;
		visibility: visible;
	}

	.three-pane--settled.three-pane--narrow .three-pane__side.is-open {
		transition:
			transform var(--banto-duration-base) var(--banto-ease-out),
			visibility 0s;
	}

	.three-pane__scrim {
		position: absolute;
		inset: 0;
		z-index: 1;
		background: var(--banto-scrim);
	}
</style>
