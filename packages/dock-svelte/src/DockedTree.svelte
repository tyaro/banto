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
	 * tracking AND the split-divider resize below are sessions of the host's
	 * single `GestureOwner` (`core/gesture.svelte.ts`, shared-primitives-
	 * upstream-plan §3.3, #433): it holds the window-level listeners (rather
	 * than `setPointerCapture`, for the same reason `HeaderCell.svelte`
	 * documents - a stray double-click can wedge capture and break a later,
	 * unrelated drag), only the owning pointer moves or commits, and Esc /
	 * pointercancel / blur / unmount cancel (a tab click is not performed; a
	 * divider drag is undone).
	 *
	 * Keyboard (#433-b, shared-primitives-upstream-plan §3.3 / D5-a), read only
	 * from the focused control's own keydown (never a window listener, plan
	 * §4.3), skipping Ctrl / Alt / Meta combinations, consumed keys and IME
	 * composition:
	 *  - the divider is a WAI-ARIA Window Splitter: a focusable `separator`
	 *    whose `aria-valuenow` / `-valuemin` / `-valuemax` are the first pane's
	 *    share (in %) of the pair it separates; the arrows of its axis move it
	 *    by `KEY_STEP_FRACTION` of the split (Shift: `KEY_STEP_LARGE_FRACTION`),
	 *    Home / End to the minimum / maximum. Each press is one `divider` step
	 *    of the `GestureOwner` (`instant`): asked through `canStartGesture`,
	 *    reported to `onGestureEnd`, refused while another gesture is active.
	 *  - the tab strip uses a roving tabindex (the active tab is the one Tab
	 *    stop); Left / Right (wrapping) and Home / End select and focus a tab.
	 *
	 * "Closing" a docked pane (the ✕ button) has no first-class "hidden but
	 * still docked" state in the Phase A model (unlike a floating window's
	 * `open` flag) - a `DockPanelNode` doesn't carry one. Rather than add one,
	 * this reuses two already-existing `DockState` methods unchanged:
	 * `undockPanel` (removes it from the tree, appends it to `floating`) then
	 * `close` (marks that floating window `open: false`). The panel is fully
	 * recoverable afterwards through the same floating open/close toggle any
	 * other closed window uses - no data is lost, and no Phase A method
	 * needed changing. Since #432 the ✕ goes through the host's pane lifecycle
	 * (`core/lifecycle.ts`): `hide` for a `keepMounted` pane (the content is
	 * re-mounted in the hidden floating window, since it leaves the tree),
	 * `close` otherwise, both asked through `beforePanelChange`.
	 *
	 * Tab switches (click and arrows) are lifecycle requests too (`tab-switch`).
	 * The tab body renders each tab in its own wrapper keyed by the panel id:
	 * the active one, plus every `keepMounted` one with `hidden` + `inert`
	 * (#432, shared-primitives-upstream-plan §3.5 / D3-c), so switching tabs
	 * keeps a `keepMounted` pane's DOM. The wrapper is `display: contents`
	 * while shown, so the active tab lays out exactly as before.
	 *
	 * Collapsing (#663 ③-B): a panel / tabs group that is a child of a split can be
	 * collapsed to a band (`node.collapsed`). The SAME header element stays - only its
	 * look changes (a header-high strip in a column split, a header-wide vertical strip
	 * with a vertical-rl title in a row split) - so the collapse button is one element
	 * for the whole life of the region and keeps the DOM focus when pressed. The body
	 * stays mounted but `hidden` + `inert`; the band is not a drag source (no drag from
	 * it) and not a drop target (no `data-dock-drop-id`; `data-dock-no-drop` makes a
	 * drop on it a no-op). The split gives the freed space to the open children through
	 * flex (`flex-grow` = the saved `sizes` over the open children's sum, the band is
	 * `flex: 0 0 <header height>`), so
	 * `sizes` are never rewritten; a divider next to a band is disabled, and the pixel
	 * -> fraction conversion of the other dividers uses only the room the open children
	 * share (`pxToFraction`).
	 *
	 * Auto-hide (#694 PR-3): a region that is not collapsed shows a pin button in its header
	 * (unless a pane in it says `autoHide: false`). Pressing it moves the region to the band
	 * on its side (`DockAutoHide.svelte`) through the lifecycle (`PanelLifecycle.autoHide`);
	 * the button leaves with the region, so the focus then goes to the band tab of the region's
	 * front pane - only when nothing else took it (`document.body`).
	 */
	import { tick, untrack, type Snippet } from 'svelte';
	import { activePanelOf, autoHideEdge, mainRegionId } from './core/autohide';
	import { pixelDeltaToFraction } from './core/geometry';
	import { MIN_PANE_FRACTION, isRegionCollapsed } from './core/tree';
	import { getDragController } from './core/drag.svelte';
	import { getGestureOwner } from './core/gesture.svelte';
	import { getPanelLifecycle } from './core/lifecycle';
	import { canArrange, getDockPolicy, isMainPane, resolveCapabilities } from './core/policy';
	import type { DockState } from './state.svelte';
	import type { DockNode, PanelContent } from './types';
	import DockedTree from './DockedTree.svelte';
	import DockPanelMenu from './DockPanelMenu.svelte';
	import { defaultDockMessages, type DockMessages } from './messages';

	interface Props {
		node: DockNode;
		dock: DockState;
		panel: Snippet<[PanelContent]>;
		iconContent?: Snippet<[string]>;
		/** Pop-out affordance (spec §5.3 v2), forwarded unchanged from `DockHost` - see its doc comment. Absent in browser mode (no button rendered). */
		onPopOut?: (content: PanelContent) => void;
		/** The direction of the split this node is a child of (`undefined` for the root): the orientation of its band when collapsed (#663 ③-B). */
		parentDirection?: 'row' | 'column';
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings, threaded into recursive `DockedTree` instances. Defaults reproduce today's Japanese output. */
		messages?: Partial<DockMessages>;
	}

	let {
		node,
		dock,
		panel,
		iconContent,
		onPopOut,
		parentDirection,
		messages = {}
	}: Props = $props();

	// i18n layer 1: an override bundle merged over the defaults. `$derived`, so a
	// parent that swaps `messages` later (a locale switch) is followed.
	const t = $derived({ ...defaultDockMessages, ...messages });

	const DRAG_THRESHOLD_PX = 5;
	/** Divider keyboard step (Window Splitter): a fraction of the whole split, and with Shift. */
	const KEY_STEP_FRACTION = 0.02;
	const KEY_STEP_LARGE_FRACTION = 0.1;
	const drag = getDragController();
	const gesture = getGestureOwner();
	const policy = getDockPolicy();
	const lifecycle = getPanelLifecycle();
	/** Per-pane capabilities from the host's `capabilities` prop (all allowed when absent). */
	const capsOf = (id: string) => resolveCapabilities(policy, id);

	// Collapsed to a band (#663 ③-B). Only a panel / tab group can be; the state lives in the tree.
	const bodyId = $props.id();
	const collapsed = $derived(node.type !== 'split' && node.collapsed === true);
	/** May this region be collapsed now (a split child with another open child, and every pane's `collapse` capability)? Expanding is always allowed. */
	const canCollapse = $derived(
		node.type !== 'split' &&
			(node.type === 'tabs' ? node.children.map((c) => c.id) : [node.id]).every(
				(id) => capsOf(id).collapse
			) &&
			dock.canCollapseDocked(node.id)
	);
	/**
	 * Sum of the saved `sizes` of the open (not collapsed) children of this split. CSS flex
	 * hands out only `sum(flex-grow)` of the free room when the grow factors add up to less
	 * than 1, so the open children grow by `sizes[i] / openGrowShare` (they fill the room the
	 * bands leave; with no band this is the saved share as before). `sizes` stay untouched.
	 */
	const openGrowShare = $derived(
		node.type === 'split'
			? node.children.reduce(
					(sum, c, i) => (isRegionCollapsed(c) ? sum : sum + (node.sizes[i] ?? 0)),
					0
				)
			: 0
	);
	function growOf(i: number): number {
		const share = node.type === 'split' ? (node.sizes[i] ?? 0) : 0;
		return openGrowShare > 0 ? share / openGrowShare : share;
	}
	/** The band's title: the pane's, or the front tab's. */
	const regionTitle = $derived(
		node.type === 'panel'
			? node.title
			: node.type === 'tabs'
				? (node.children[node.activeIndex]?.title ?? '')
				: ''
	);
	let collapseBtnEl: HTMLButtonElement | null = $state(null);

	function toggleCollapsed(): void {
		if (node.type === 'split') return;
		dock.setDockedCollapsed(node.id, !collapsed);
	}

	/** May this region be auto-hidden (#694 PR-3): every pane in it allows `autoHide`. */
	const canAutoHide = $derived(
		node.type === 'panel'
			? capsOf(node.id).autoHide
			: node.type === 'tabs'
				? node.children.every((c) => capsOf(c.id).autoHide)
				: false
	);

	/**
	 * The pin button (#694 PR-3): auto-hide this region to the band on its side (seen from
	 * the main region, `isMainPane`), through `beforePanelChange`. The slid-out size is the
	 * region's current share of the docked area along that axis. The region (and the focused
	 * pin button) leaves the DOM; the focus then goes to the band tab of its front pane -
	 * unless something else took it meanwhile.
	 */
	function autoHide(frameEl: HTMLElement | null): void {
		if (node.type === 'split') return;
		const root = dock.layout.docked;
		const mainId = mainRegionId(root, (id) => isMainPane(policy, id));
		const edge = autoHideEdge(root, node.id, mainId);
		const area = frameEl?.closest('.docked-layer')?.getBoundingClientRect();
		const own = frameEl?.getBoundingClientRect();
		const horizontal = edge === 'left' || edge === 'right';
		const whole = horizontal ? area?.width : area?.height;
		const part = horizontal ? own?.width : own?.height;
		const size = whole && part ? part / whole : undefined;
		const host = frameEl?.closest<HTMLElement>('[data-dock-host]') ?? null;
		const front = activePanelOf(node).id;
		void lifecycle.autoHide(node.id, { edge, size, mainId }).then(async (outcome) => {
			if (outcome !== 'applied') return;
			await tick();
			const active = document.activeElement;
			if (active && active !== document.body && active.isConnected) return;
			const tabs = host?.querySelectorAll<HTMLElement>('[data-dock-band-tab]') ?? [];
			[...tabs].find((el) => el.dataset.dockBandTab === front)?.focus();
		});
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
		if (event.button !== 0 || event.isPrimary === false || gesture.active) return;
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const frameRect = frameEl.getBoundingClientRect();
		// `move: false` (consumer capability): never becomes a drag, but a plain click (tab select) still works.
		const canMove = capsOf(content.id).move;
		let dragging = false;
		let refused = false;

		gesture.begin(event, {
			kind: 'drag-candidate',
			panelId: content.id,
			move(moveEvent) {
				if (dragging) {
					drag.update(moveEvent.clientX, moveEvent.clientY);
					return;
				}
				if (!canMove || refused) return;
				if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX)
					return;
				// `canStartGesture` is asked here, as `drag`; a refusal ignores the rest of the press.
				if (!gesture.setKind('drag')) {
					refused = true;
					return;
				}
				dragging = true;
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
			},
			commit(upEvent) {
				if (dragging) drag.commit(upEvent.clientX, upEvent.clientY);
				else if (!refused) onPlainClick?.();
			},
			cancel() {
				drag.cancel();
			}
		});
	}

	// --- split divider resize (a plain incremental pointer drag, unrelated to docking) ---
	let splitEl: HTMLDivElement | null = $state(null);

	/**
	 * A `divider` session: each owning-pointer move writes `dock.resizeSplit`
	 * live, as a fraction of the split's size read from layout at that moment
	 * (not a reactive size binding, which can lag a window resize); the release
	 * applies its own last delta the same way. Cancel (Esc / pointercancel /
	 * blur / unmount) puts back only this split's sizes from before the press (#433).
	 */
	function startDivider(
		event: PointerEvent,
		dividerIndex: number,
		direction: 'row' | 'column'
	): void {
		if (event.button !== 0 || event.isPrimary === false || gesture.active) return;
		event.preventDefault();
		if (dividerDisabled(dividerIndex)) return;
		const splitId = node.id;
		let last = direction === 'row' ? event.clientX : event.clientY;
		const step = (e: PointerEvent) => {
			const pos = direction === 'row' ? e.clientX : e.clientY;
			const deltaPx = pos - last;
			last = pos;
			dock.resizeSplit(splitId, dividerIndex, pxToFraction(deltaPx, direction));
		};
		const began = gesture.begin(event, {
			kind: 'divider',
			move: step,
			commit: (e) => {
				activeDivider = null;
				step(e);
			},
			cancel: () => {
				activeDivider = null;
			},
			restore: (snapshot) => dock.restoreSplitSizes(splitId, snapshot)
		});
		if (began) activeDivider = dividerIndex;
	}

	/** The divider whose drag is running in THIS split (#663 ③-B: cancelled when a region next to it is collapsed). */
	let activeDivider: number | null = $state(null);

	/** A divider next to a collapsed band, or of a host that may not be rearranged (`arrange`), cannot be moved (neither by pointer nor by keyboard). */
	function dividerDisabled(i: number): boolean {
		if (node.type !== 'split') return false;
		if (!canArrange(policy)) return true;
		const a = node.children[i];
		const b = node.children[i + 1];
		return (a !== undefined && isRegionCollapsed(a)) || (b !== undefined && isRegionCollapsed(b));
	}

	$effect(() => {
		const i = activeDivider;
		if (i === null) return;
		// Collapsing a region next to the divider in the middle of its drag: the units the drag
		// was measured in no longer hold, so undo it (the press-time sizes come back).
		if (dividerDisabled(i)) untrack(() => gesture.cancel('api'));
	});

	/**
	 * A pixel distance along the split's axis as a change in `sizes` (a fraction of the
	 * split's total). `sizes` are shares of the WHOLE split, but collapsed bands are fixed
	 * strips that take their pixels first: the open children share only what is left, and
	 * their shares add up to `openShare`, so `px / openPx * openShare` is the matching change.
	 * Without a band it is plain `px / size`.
	 */
	function pxToFraction(px: number, direction: 'row' | 'column'): number {
		const vertical = direction === 'row';
		const size = vertical ? (splitEl?.clientWidth ?? 0) : (splitEl?.clientHeight ?? 0);
		if (node.type !== 'split' || !node.children.some(isRegionCollapsed)) {
			return pixelDeltaToFraction(px, size);
		}
		let bandPx = 0;
		for (const el of splitEl?.querySelectorAll<HTMLElement>(':scope > .split-child.collapsed') ??
			[]) {
			bandPx += vertical ? el.clientWidth : el.clientHeight;
		}
		let openShare = 0;
		node.children.forEach((c, i) => {
			if (!isRegionCollapsed(c)) openShare += node.type === 'split' ? (node.sizes[i] ?? 0) : 0;
		});
		return pixelDeltaToFraction(px, size - bandPx) * openShare;
	}

	/** A key the dock may handle: not consumed, not IME composition, no Ctrl / Alt / Meta. */
	function isPlainKey(event: KeyboardEvent): boolean {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
		return !(event.altKey || event.ctrlKey || event.metaKey);
	}

	/** The divider's Window Splitter values: the first pane's share (in %) of the pair it separates. */
	function splitterValues(sizes: number[], i: number): { now: number; min: number; max: number } {
		const pair = (sizes[i] ?? 0) + (sizes[i + 1] ?? 0);
		if (pair <= 0 || pair < 2 * MIN_PANE_FRACTION) return { now: 50, min: 50, max: 50 };
		const min = Math.round((MIN_PANE_FRACTION / pair) * 100);
		return { now: Math.round(((sizes[i] ?? 0) / pair) * 100), min, max: 100 - min };
	}

	function handleDividerKeydown(
		event: KeyboardEvent,
		dividerIndex: number,
		direction: 'row' | 'column'
	): void {
		if (node.type !== 'split' || !isPlainKey(event) || dividerDisabled(dividerIndex)) return;
		const back = direction === 'row' ? 'ArrowLeft' : 'ArrowUp';
		const forward = direction === 'row' ? 'ArrowRight' : 'ArrowDown';
		let step = event.shiftKey ? KEY_STEP_LARGE_FRACTION : KEY_STEP_FRACTION;
		// The step is a share of the visible split: with a band next to it, a different share of `sizes`.
		if (node.children.some(isRegionCollapsed)) {
			const size = direction === 'row' ? (splitEl?.clientWidth ?? 0) : (splitEl?.clientHeight ?? 0);
			step = pxToFraction(step * size, direction);
		}
		// Home / End: `resizeSplit` clamps to the pair's minimum / maximum.
		let delta: number;
		if (event.key === back) delta = -step;
		else if (event.key === forward) delta = step;
		else if (event.key === 'Home') delta = -1;
		else if (event.key === 'End') delta = 1;
		else return;
		event.preventDefault();
		const splitId = node.id;
		gesture.instant('divider', null, () => dock.resizeSplit(splitId, dividerIndex, delta));
	}

	let tabStripEl: HTMLDivElement | null = $state(null);

	function handleTabKeydown(event: KeyboardEvent, index: number): void {
		// Only the tab itself - not its nested close / pop-out buttons.
		if (node.type !== 'tabs' || event.target !== event.currentTarget || !isPlainKey(event)) return;
		const count = node.children.length;
		let next: number;
		if (event.key === 'ArrowRight') next = (index + 1) % count;
		else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else return;
		event.preventDefault();
		const to = node.children[next]?.id;
		if (to === undefined) return;
		// Focus follows only once the switch is applied (it may be refused or held).
		void lifecycle.switchTab(node.id, to, () => {
			// The tabs are keyed by id, so the element already exists.
			const tabs = tabStripEl?.querySelectorAll<HTMLElement>('[role="tab"]');
			const target = [...(tabs ?? [])].find((el) => el.dataset.dockTabId === to);
			target?.focus();
		});
	}

	let panelFrameEl: HTMLDivElement | null = $state(null);
	let tabsFrameEl: HTMLDivElement | null = $state(null);

	// Collapsing hides the body and replaces the tab strip / the pop-out and close buttons: if the DOM
	// focus is anywhere in this region except the collapse button, hand it to the button first (`.pre`:
	// the focused element is still rendered here). A focus the host put outside the region is left alone.
	$effect.pre(() => {
		if (!collapsed) return;
		untrack(() => {
			const active = document.activeElement;
			const frame = node.type === 'panel' ? panelFrameEl : tabsFrameEl;
			if (!active || !collapseBtnEl || !frame || active === collapseBtnEl) return;
			if (frame.contains(active)) collapseBtnEl.focus();
		});
	});
</script>

{#if node.type === 'panel'}
	<div
		class="dock-pane"
		class:collapsed
		class:band-row={collapsed && parentDirection === 'row'}
		data-dock-drop-id={collapsed ? undefined : node.id}
		data-dock-no-drop={collapsed ? '' : undefined}
		bind:this={panelFrameEl}
		role="group"
		aria-label={node.title}
	>
		<!--
			role="toolbar": this is a drag handle wrapping a real close/pop-out
			<button> group, not a button itself - `role="button"` here would trip
			axe's nested-interactive rule (a `button`-rolled element's children
			are ARIA-presentational, which conflicts with the nested buttons being
			real, operable controls). `toolbar` is a plain grouping role (no
			`childrenPresentational`) that still requires (and gets, via
			`aria-label`) an accessible name, without claiming to itself be a
			single interactive control. Dragging stays pointer-only (see the
			module doc comment); the close/pop-out buttons remain the keyboard
			entry points. Not itself put in the tab order (no roving-tabindex
			management here, unlike a "real" toolbar's expected keyboard model) -
			svelte-ignore below, since axe has no equivalent complaint (a toolbar
			isn't required to be focusable itself, only its interactive children
			are, and they already are).
		-->
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div
			class="titlebar"
			role="toolbar"
			aria-label={node.title}
			onpointerdown={(event) => !collapsed && panelFrameEl && armDrag(event, panelFrameEl, node)}
		>
			{#if node.icon}
				<span class="icon" aria-hidden="true">
					{#if iconContent}
						{@render iconContent(node.icon)}
					{:else}
						{node.icon}
					{/if}
				</span>
			{/if}
			<span class="title">{node.title}</span>
			{#if !collapsed}
				<DockPanelMenu panelId={node.id} title={node.title} {t} />
			{/if}
			{#if !collapsed && canAutoHide}
				<button
					type="button"
					class="pin-btn"
					data-dock-autohide-for={node.id}
					aria-label={t.autoHidePane(node.title)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => autoHide(panelFrameEl)}
				>
					📌
				</button>
			{/if}
			{#if canArrange(policy)}
				<button
					type="button"
					class="collapse-btn"
					bind:this={collapseBtnEl}
					aria-label={collapsed ? t.expandPane(node.title) : t.collapsePane(node.title)}
					aria-expanded={!collapsed}
					aria-controls={bodyId}
					disabled={!collapsed && !canCollapse}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={toggleCollapsed}
				>
					{collapsed ? '▸' : '▾'}
				</button>
			{/if}
			{#if !collapsed && onPopOut && capsOf(node.id).undock}
				<button
					type="button"
					class="popout-btn"
					aria-label={t.popOut(node.title)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => onPopOut?.(node)}
				>
					⧉
				</button>
			{/if}
			{#if !collapsed && capsOf(node.id).close}
				<button
					type="button"
					class="close-btn"
					aria-label={t.close(node.title)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => void lifecycle.closeButton(node.id)}
				>
					✕
				</button>
			{/if}
		</div>
		<!-- role="region" + tabindex="0": the pane's content can overflow and
		     scroll, and axe's scrollable-region-focusable rule requires a
		     scrollable region to be reachable (and thus scrollable) via
		     keyboard, not just pointer/wheel. Svelte's own a11y check disagrees
		     (a landmark role "shouldn't" carry tabindex) - this is the
		     WAI-ARIA-recognized scrollable-region pattern axe itself expects,
		     so the svelte-check warning is the one to suppress. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="body"
			id={bodyId}
			role="region"
			aria-label={node.title}
			tabindex="0"
			hidden={collapsed}
			inert={collapsed}
		>
			{@render panel(node)}
		</div>
	</div>
{:else if node.type === 'tabs'}
	{@const active = node.children[node.activeIndex]}
	<div
		class="dock-pane"
		class:collapsed
		class:band-row={collapsed && parentDirection === 'row'}
		data-dock-drop-id={collapsed ? undefined : node.id}
		data-dock-no-drop={collapsed ? '' : undefined}
		bind:this={tabsFrameEl}
		role="group"
		aria-label={active?.title}
	>
		<!--
			Each `.tab` keeps `role="tab"` (required by the `tablist`/`tab` ARIA
			pattern) even though - like the plain-panel titlebar above - the
			active tab nests real close/pop-out <button>s, which is technically
			the same nested-interactive shape axe flags there. Unlike the
			titlebar, `tab` can't be swapped for a non-interactive grouping role
			without giving up tab semantics entirely, and splitting the buttons
			out of the DOM subtree would be a real restructure, not a role/aria
			tweak. Left as-is: no docked layout in this app ever starts (or is
			driven to, in the scanned flows) a tabbed group, so this shape is
			never exercised by the axe scan in `e2e/visual/a11y.spec.ts` - flagged
			here for whoever next touches tab-strip interaction/keyboard support.
		-->
		<div class="tab-header">
			{#if collapsed}
				{#if active?.icon}
					<span class="icon" aria-hidden="true">
						{#if iconContent}
							{@render iconContent(active.icon)}
						{:else}
							{active.icon}
						{/if}
					</span>
				{/if}
				<span class="title">{active?.title}</span>
			{:else}
				<div class="tab-strip" role="tablist" bind:this={tabStripEl}>
					{#each node.children as child, i (child.id)}
						<div
							class="tab"
							class:active={i === node.activeIndex}
							role="tab"
							data-dock-tab-id={child.id}
							tabindex={i === node.activeIndex ? 0 : -1}
							aria-selected={i === node.activeIndex}
							aria-label={child.title}
							onpointerdown={(event) =>
								tabsFrameEl &&
								armDrag(
									event,
									tabsFrameEl,
									child,
									() => void lifecycle.switchTab(node.id, child.id)
								)}
							onkeydown={(event) => handleTabKeydown(event, i)}
						>
							{#if child.icon}
								<span class="icon" aria-hidden="true">
									{#if iconContent}
										{@render iconContent(child.icon)}
									{:else}
										{child.icon}
									{/if}
								</span>
							{/if}
							<span class="title">{child.title}</span>
							{#if i === node.activeIndex}
								<DockPanelMenu panelId={child.id} title={child.title} {t} />
								{#if onPopOut && capsOf(child.id).undock}
									<button
										type="button"
										class="popout-btn"
										aria-label={t.popOut(child.title)}
										onpointerdown={(event) => event.stopPropagation()}
										onclick={() => onPopOut?.(child)}
									>
										⧉
									</button>
								{/if}
								{#if capsOf(child.id).close}
									<button
										type="button"
										class="close-btn"
										aria-label={t.close(child.title)}
										onpointerdown={(event) => event.stopPropagation()}
										onclick={() => void lifecycle.closeButton(child.id)}
									>
										✕
									</button>
								{/if}
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			{#if !collapsed && canAutoHide}
				<button
					type="button"
					class="pin-btn"
					data-dock-autohide-for={node.id}
					aria-label={t.autoHidePane(regionTitle)}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={() => autoHide(tabsFrameEl)}
				>
					📌
				</button>
			{/if}
			{#if canArrange(policy)}
				<button
					type="button"
					class="collapse-btn"
					bind:this={collapseBtnEl}
					aria-label={collapsed ? t.expandPane(regionTitle) : t.collapsePane(regionTitle)}
					aria-expanded={!collapsed}
					aria-controls={bodyId}
					disabled={!collapsed && !canCollapse}
					onpointerdown={(event) => event.stopPropagation()}
					onclick={toggleCollapsed}
				>
					{collapsed ? '▸' : '▾'}
				</button>
			{/if}
		</div>
		<!-- Same scrollable-region-focusable rationale (and svelte-ignore) as the `panel` branch's `.body` above. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="body"
			id={bodyId}
			role="region"
			aria-label={active?.title}
			tabindex="0"
			hidden={collapsed}
			inert={collapsed}
		>
			{#each node.children as child, i (child.id)}
				{@const shown = i === node.activeIndex}
				{#if shown || lifecycle.keepMounted(child.id)}
					<div class="tab-content" hidden={!shown} inert={!shown}>
						{@render panel(child)}
					</div>
				{/if}
			{/each}
		</div>
	</div>
{:else}
	<div
		class="dock-split"
		class:row={node.direction === 'row'}
		class:column={node.direction === 'column'}
		bind:this={splitEl}
	>
		{#each node.children as child, i (child.id)}
			{@const band = isRegionCollapsed(child)}
			<!-- A collapsed child is a fixed band (header size); the open ones share the rest by `sizes`. -->
			<div
				class="split-child"
				class:collapsed={band}
				style:flex-grow={band ? 0 : growOf(i)}
				style:flex-shrink={band ? 0 : undefined}
				style:flex-basis={band ? 'var(--banto-dock-titlebar-height)' : '0%'}
			>
				<DockedTree
					node={child}
					{dock}
					{panel}
					{iconContent}
					{onPopOut}
					{messages}
					parentDirection={node.direction}
				/>
			</div>
			{#if i < node.children.length - 1}
				{@const values = splitterValues(node.sizes, i)}
				{@const locked = dividerDisabled(i)}
				<!-- A focusable separator is an interactive widget (WAI-ARIA Window Splitter, #433-b). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					class="divider"
					class:row={node.direction === 'row'}
					class:column={node.direction === 'column'}
					class:locked
					role="separator"
					tabindex={locked ? -1 : 0}
					aria-disabled={locked ? 'true' : undefined}
					aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
					aria-label={t.resizeHandle()}
					aria-valuenow={values.now}
					aria-valuemin={values.min}
					aria-valuemax={values.max}
					onpointerdown={(event) => startDivider(event, i, node.direction)}
					onkeydown={(event) => handleDividerKeydown(event, i, node.direction)}
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
		gap: var(--banto-space-2);
		height: var(--banto-dock-titlebar-height);
		padding: 0 var(--banto-space-2) 0 var(--banto-space-3);
		background: var(--banto-surface-raised);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
		color: var(--banto-text);
		user-select: none;
		touch-action: none;
		cursor: move;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.titlebar:hover {
		background: var(--banto-surface-hover);
	}

	/* A layout no-op while shown (the active tab lays out as before #432). */
	.tab-content {
		display: contents;
	}

	.tab-content[hidden] {
		display: none;
	}

	/* The strip's row: the tab strip (or, collapsed, the front tab's label) and the collapse button. */
	.tab-header {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		height: var(--banto-dock-titlebar-height);
		padding-right: var(--banto-space-2);
		background: var(--banto-surface-raised);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		user-select: none;
	}

	.tab-strip {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		align-items: stretch;
		align-self: stretch;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.tab {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		padding: 0 var(--banto-space-2) 0 var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
		color: var(--banto-text-muted);
		border-right: var(--banto-border-width) solid var(--banto-border);
		user-select: none;
		touch-action: none;
		cursor: pointer;
		max-width: 12rem;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.tab:hover:not(.active) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.tab.active {
		color: var(--banto-text);
		background: var(--banto-dock-tab-active-bg);
		box-shadow: inset 0 calc(-1 * var(--banto-border-width-strong)) 0 var(--banto-primary);
	}

	.icon {
		flex: 0 0 auto;
		font-size: var(--banto-font-size-md);
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.close-btn,
	.popout-btn,
	.pin-btn,
	.collapse-btn {
		flex: 0 0 auto;
		width: var(--banto-dock-button-size, 20px);
		height: var(--banto-dock-button-size, 20px);
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
		font-size: var(--banto-font-size-xs);
		touch-action: none;
		transition:
			background var(--banto-duration-fast) var(--banto-ease-out),
			color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.close-btn:hover {
		background: color-mix(in srgb, var(--banto-danger) 15%, transparent);
		color: var(--banto-danger);
	}

	.popout-btn:hover,
	.pin-btn:hover,
	.collapse-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
		color: var(--banto-primary-text);
	}

	.collapse-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.close-btn:focus-visible,
	.popout-btn:focus-visible,
	.pin-btn:focus-visible,
	.collapse-btn:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* Collapsed to a band (#663 ③-B). The header stays the same element; only its look changes. */
	.body[hidden] {
		display: none;
	}

	.dock-pane.collapsed .titlebar {
		cursor: default;
	}

	/* In a row split the band is a strip as wide as a header is high, the title running down. */
	.dock-pane.band-row .titlebar,
	.dock-pane.band-row .tab-header {
		flex: 1 1 auto;
		min-height: 0;
		height: auto;
		flex-direction: column;
		padding: var(--banto-space-2) 0;
		border-bottom: none;
		border-right: var(--banto-border-width) solid var(--banto-border);
	}

	.dock-pane.band-row .title {
		flex: 1 1 auto;
		min-height: 0;
		writing-mode: vertical-rl;
	}

	.dock-pane.band-row .collapse-btn {
		order: -1;
	}

	.body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: auto;
		background: var(--banto-surface);
	}

	.body:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
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
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.divider:hover {
		background: var(--banto-dock-divider-hover);
	}

	.divider.locked {
		cursor: default;
	}

	.divider:focus-visible {
		outline: none;
		background: var(--banto-dock-divider-hover);
		box-shadow: var(--banto-focus-ring);
	}

	/* `ThreePaneDock`'s `.divider-probe` measures this width (#892): change both together. */
	.divider.row {
		width: 6px;
		cursor: col-resize;
	}

	.divider.column {
		height: 6px;
		cursor: row-resize;
	}
</style>
