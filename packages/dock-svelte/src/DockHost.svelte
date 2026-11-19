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
	 *     positioned on top inside a pointer-transparent floating layer. The
	 *     array order is still the z-order (last = frontmost, which is what is
	 *     saved), but it is applied as `z-index`; the DOM order is the order in
	 *     which windows were first seen and never changes when a window is
	 *     raised (#433, shared-primitives-upstream-plan §3.3: raising on
	 *     `focusin` must not move the focused element - moving a node drops its
	 *     focus in browsers - nor reshuffle the Tab order). When `docked` is
	 *     `null` the host looks exactly like it did before Phase B.
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
	 *
	 * DockHost also owns the single `GestureOwner` (`core/gesture.svelte.ts`,
	 * #433): every pointer gesture of the tree (title-bar / tab drag, floating
	 * resize, split divider) is one session of it - one at a time, only the
	 * owning pointer commits, Esc / pointercancel / blur / hidden cancel - and
	 * unmounting the host cancels the active session (undoing only that
	 * gesture's own target) and removes its listeners. The keyboard paths
	 * (#433-b, shared-primitives-upstream-plan §3.3 / D5) are sessions of the
	 * same owner, and the three gesture hooks below (`canStartGesture`,
	 * `onGestureEnd`, `isEscapeBlocked`) are passed to it through getters, so
	 * they always read the live props.
	 *
	 * DockHost also owns the single `PanelLifecycle` (`core/lifecycle.ts`, #432,
	 * shared-primitives-upstream-plan §3.5 / §4.2 / D3-c / D4): every structure
	 * change of the dock UI (dock / undock / move a docked pane / tab switch /
	 * hide / close) asks `beforePanelChange` first and waits for an IME
	 * composition to end; the content of `keepMounted` panes stays mounted
	 * (`hidden` + `inert`) while their tab is not shown or their floating window
	 * is hidden - those hidden windows are rendered here too. The ✕ button hides
	 * a `keepMounted` pane and closes (discards) any other; `hidePanel` /
	 * `closePanel` below are the same two actions for an app's own UI.
	 *
	 * Persistent panes (#663 ④, three-pane-dock-plan §4.2 C, `core/persistent.ts`):
	 * the `panel` snippet of a pane the consumer marks `persistent` is rendered
	 * once, into a hidden stash at the end of the host, and the tree (docked pane,
	 * tab, floating window, auto-hide slide-out) only draws an empty receptacle for
	 * it; the content element is moved into the receptacle while one is mounted and
	 * back to the stash when none is. Focus and scroll are put back after a move.
	 *
	 * Which guard applies first (README "Pane lifecycle"): `capabilities` decide
	 * whether the control exists at all (no ✕, no drag); then a `drag` does not
	 * start while `isStructureChangeDeferred()` is true; then `canStartGesture`
	 * may refuse the gesture; then `beforePanelChange` decides, when the gesture
	 * commits (after the gesture closed) or a button is pressed, whether the
	 * layout changes.
	 */
	import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
	import { createDragController, setDragController } from './core/drag.svelte';
	import {
		GestureOwner,
		setGestureOwner,
		type GestureCancelReason as DockCancelReason,
		type GestureKind as DockGestureKind
	} from './core/gesture.svelte';
	import type { ClampOptions } from './core/geometry';
	import {
		PanelLifecycle,
		setPanelLifecycle,
		type DockPanelChange,
		type DockPanelChangeOutcome
	} from './core/lifecycle';
	import { PersistentContents } from './core/persistent';
	import { collectPanelIds } from './core/tree';
	import { autoHiddenPanelIds, mainRegionId, regionOf, regionPanelIds } from './core/autohide';
	import {
		isMainPane,
		resolveCapabilities,
		setDockPolicy,
		type DockCapabilities,
		type DockPolicy
	} from './core/policy';
	import { adoptLayout, forgetHomeSlots, type DockState } from './state.svelte';
	import type { DockLayout, DockNode, PanelContent } from './types';
	import { validateDockLayout } from './core/validate';
	import DockAutoHide from './DockAutoHide.svelte';
	import DockedTree from './DockedTree.svelte';
	import DockWindow from './DockWindow.svelte';
	import { defaultDockMessages, type DockMessages } from './messages';
	import {
		PanelMover,
		setPanelMover,
		titleBarFocusTarget,
		type DockMoveOutcome,
		type DockMoveTarget
	} from './core/move.svelte';

	interface Props {
		dock: DockState;
		panel: Snippet<[PanelContent]>;
		/** Optional app-owned renderer for persisted icon strings. Defaults to the original text glyph. */
		iconContent?: Snippet<[string]>;
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
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings, threaded down to `DockedTree` and `DockWindow`. Defaults reproduce today's Japanese output. */
		messages?: Partial<DockMessages>;
		/**
		 * Clamp policy for floating windows (shared-primitives-upstream-plan §3.2,
		 * #434): minimum size, px that must stay visible, and what to do when the
		 * host is narrower than the minimum. Omitted = the package's generic
		 * defaults (`DEFAULT_MIN_*`); an app passes its own numbers. It is applied
		 * when DRAWING (the saved x/y/width/height are not rewritten, so a host
		 * that shrinks and grows back restores the preferred placement) and when
		 * the user moves/resizes (the result then becomes the new preference).
		 */
		clamp?: ClampOptions;
		/**
		 * Per-pane capabilities (close / move / undock; default all allowed). For
		 * a pane an app must keep, such as a central canvas:
		 * `(id) => (id === 'canvas' ? { close: false, move: false } : undefined)`.
		 * UI affordances only - see `DockCapabilities`.
		 */
		capabilities?: (panelId: string) => DockCapabilities | undefined;
		/**
		 * May this gesture start (exclusion with drawing, another DnD or a higher
		 * layer; shared-primitives-upstream-plan §3.3, #433)? `false` = it does
		 * not start: nothing moves, no listener is added, `onGestureEnd` is not
		 * called. `panelId` is the window / pane's id, `null` for a divider. A
		 * title-bar or tab press is asked as `drag` once it crosses the drag
		 * threshold (until then it may still be a plain click - a tab selection -
		 * and is not asked); a refused drag ignores the rest of that press.
		 * Omitted = always allowed.
		 */
		canStartGesture?: (kind: DockGestureKind, panelId: string | null) => boolean;
		/**
		 * Called exactly once when a gesture ends, after the layout reflects the
		 * outcome (committed, or the target restored): `commit`, or `cancel` with
		 * the reason. Also called with `drag-candidate` / `commit` for a press
		 * that never became a drag (a click), and with `divider` / `commit` for
		 * each keyboard step on a divider. The gesture is already closed, so the
		 * hook may start another one or unmount the host.
		 */
		onGestureEnd?: (
			kind: DockGestureKind,
			outcome: 'commit' | 'cancel',
			reason?: DockCancelReason
		) => void;
		/**
		 * Must the dock leave this Esc alone (`true` = yield it to a higher layer;
		 * shared-primitives-upstream-plan §3.3 / §4.3)? Asked only while a gesture
		 * is active and the Esc was not already consumed (`defaultPrevented`) nor
		 * part of IME composition. `activeLayer` is the gesture's floating window
		 * root (`role="dialog"`), `null` for a docked pane or a divider. Every
		 * floating window is a NON-modal `role="dialog"`, so a check that counts
		 * any dialog counts the gesture's own window (and, for a divider, any open
		 * floating window) and Esc never cancels. With `@banto/ui` an app passes
		 * `(el) => el ? hasVisibleLayerAbove({ except: el }) : hasVisibleModalLayer() || hasVisibleMenuLayer()`.
		 * Omitted = only `defaultPrevented` is honoured.
		 */
		isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean;
		/**
		 * Asked before every structure change the dock UI makes (shared-primitives-
		 * upstream-plan §3.5, #432): a drop that docks / undocks / moves a docked
		 * pane, a tab switch, a hide and a close. Only `true` (or a promise that
		 * resolves to `true`) lets it through; anything else - `false`, a throw, a
		 * rejection - leaves the layout as it is. The app shows its own confirm UI.
		 * An async answer is applied only if the layout's structure did not change
		 * while it was pending, and never after the host unmounted. Geometry-only
		 * changes (move / resize, dividers) and the app's own `DockState` calls
		 * are not asked. Omitted = always allowed.
		 */
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
		/**
		 * Panes whose content stays mounted - `hidden` + `inert`, the same DOM
		 * nodes - while their tab is not the active one or their floating window
		 * is hidden (D3-c): IME state, selection, scroll and unfinished input
		 * survive. For such a pane the ✕ button HIDES (D4-a); `closePanel`
		 * discards the content. Moving between the docked tree and the floating
		 * layer (dock / undock) still re-mounts (`persistent` does not). Omitted = none (today's behaviour).
		 */
		keepMounted?: (panelId: string) => boolean;
		/**
		 * Panes whose content is never re-mounted by the dock (#663 ④,
		 * three-pane-dock-plan §4.2 C) - `keepMounted` and more: the `panel`
		 * snippet is rendered ONCE outside the docked tree and the same DOM element
		 * is moved (`appendChild`) into whichever place shows the pane, so undock /
		 * dock, a drop on an outer edge, a split made around it, auto-hide and a tab
		 * switch keep its DOM and component state. The focus inside it and the scroll
		 * offsets of its scrolled elements are put back after a move. Changes about
		 * such a pane say `remount: false`, and it is not asked as `reparent`.
		 * `closePanel` still discards it. An `iframe` inside is reloaded by every
		 * move (browsers reload a moved `iframe`). Omitted = none.
		 */
		persistent?: (panelId: string) => boolean;
		/**
		 * `true` = hold structure changes now (shared-primitives-upstream-plan §3.5 /
		 * §4.2): a `drag` does not start, and a requested change waits - it is
		 * asked and applied after the next `compositionend` / `focusout` on the
		 * document (or `resumeDeferredChange()`). Omitted = an IME composition is
		 * in progress in the document.
		 */
		isStructureChangeDeferred?: () => boolean;
		/**
		 * `false` = the user cannot rearrange the layout (#663 ④, three-pane-dock-plan §4.5, e.g. a
		 * kiosk): every `capabilities` field reads `false` (no ✕, drag, float, pop-out, pin, collapse,
		 * "panel actions" menu, drop target), dividers and floating windows do not move or resize
		 * (pointer or keyboard), and the collapse / lock buttons and an auto-hidden pane's pin-back
		 * button are not drawn. Switching a tab, raising a window and sliding an auto-hidden pane out
		 * still work. `movePanel` / `autoHidePanel` / `pinPanel` resolve `unavailable` / `refused`;
		 * the app's own `showPanel` / `hidePanel` / `closePanel` / `setPanelVisible` /
		 * `replaceLayout` (and `DockState` calls) are not affected. Turning it off cancels a gesture
		 * in progress and makes every request still being asked `stale`; a focus on a control that
		 * goes away moves to its pane. Default `true`.
		 */
		arrange?: boolean;
	}

	let {
		dock,
		panel,
		iconContent,
		onPopOut,
		messages = {},
		clamp,
		capabilities,
		canStartGesture,
		onGestureEnd,
		isEscapeBlocked,
		beforePanelChange,
		keepMounted,
		persistent,
		isStructureChangeDeferred,
		arrange = true
	}: Props = $props();

	// Published through context; getters keep reading the live props.
	const policy: DockPolicy = {
		get clamp() {
			return clamp;
		},
		get capabilities() {
			return capabilities;
		},
		get arrange() {
			return arrange;
		}
	};
	setDockPolicy(policy);

	let hostW: number = $state(0);
	let hostH: number = $state(0);
	let hostEl: HTMLDivElement | null = $state(null);

	// svelte-ignore state_referenced_locally
	const lifecycle = new PanelLifecycle(dock, () => ({
		beforePanelChange,
		keepMounted,
		persistent,
		isStructureChangeDeferred
	}));
	setPanelLifecycle(lifecycle);
	onMount(() => lifecycle.attach());
	onDestroy(() => lifecycle.dispose());

	// Persistent panes (module doc, `core/persistent.ts`).
	const persistentContents = new PersistentContents();
	onDestroy(() => persistentContents.dispose());
	// Before the tree's blocks update for a structure change (`.pre`, and declared before the
	// template), record the focus inside each persistent content: the move drops it.
	$effect.pre(() => {
		// Read every source first: a short-circuit would leave one untracked (conventions §8).
		const layout = dock.layout;
		const flyout = dock.flyoutPanel;
		const discarded = lifecycle.discarded.size;
		void [layout, flyout, discarded];
		untrack(() => persistentContents.snapshot());
	});

	/** Edges that hold an auto-hidden band (#694 PR-3): the docked layer is inset by them. */
	const bandEdges = $derived(new Set(dock.autoHidden.map((e) => e.edge)));
	const BAND = 'var(--banto-dock-titlebar-height)';

	const openWindows = $derived(dock.layout.floating.filter((w) => w.open));
	/** Open windows plus hidden ones whose content is kept (`keepMounted`, not discarded by `close`). */
	const mountedWindows = $derived(
		dock.layout.floating.filter((w) => w.open || lifecycle.isRetained(w.id))
	);
	// A pane shown again (open floating or docked) is kept again by a later hide.
	$effect(() => {
		const shown = [
			...openWindows.map((w) => w.id),
			...collectPanelIds(dock.layout.docked),
			...autoHiddenPanelIds(dock.layout)
		];
		untrack(() => lifecycle.forgetDiscarded(shown));
	});

	// Stable DOM order (see the module doc): the first time an id is seen it
	// gets the next sequence number and keeps it. A plain Map, not state - it
	// only ever grows, and nothing reacts to it directly.
	const domSeq = new Map<string, number>();
	const renderedWindows = $derived.by(() => {
		for (const w of mountedWindows) if (!domSeq.has(w.id)) domSeq.set(w.id, domSeq.size);
		return [...mountedWindows].sort((a, b) => (domSeq.get(a.id) ?? 0) - (domSeq.get(b.id) ?? 0));
	});
	/** id → stacking position (index in `layout.floating`'s open windows = z-order). */
	const zOrder = $derived(new Map(openWindows.map((w, i) => [w.id, i])));

	/**
	 * The persistent panes whose content is alive: every pane the tree may draw a
	 * receptacle for (docked, auto-hidden, open or kept floating windows), by id.
	 */
	const persistentPanes = $derived.by((): PanelContent[] => {
		const isPersistent = persistent;
		if (!isPersistent) return [];
		const out: PanelContent[] = [];
		const visit = (node: DockNode | null): void => {
			if (!node) return;
			if (node.type === 'panel') out.push(node);
			else node.children.forEach(visit);
		};
		visit(dock.layout.docked);
		for (const entry of dock.layout.autoHidden ?? []) visit(entry.node);
		out.push(...mountedWindows);
		// One entry per id (a keyed `{#each}`), even for a layout that names a pane twice.
		const byId = new Map<string, PanelContent>();
		for (const content of out)
			if (!byId.has(content.id) && isPersistent(content.id)) byId.set(content.id, content);
		return [...byId.values()];
	});

	// `dock` is a stable DockState instance for this component's lifetime, so
	// capturing it once to build the drag controller is intentional.
	// svelte-ignore state_referenced_locally
	const drag = createDragController(
		dock,
		() => hostEl,
		() => policy,
		() => lifecycle
	);
	setDragController(drag);

	// The keyboard path for re-docking (#663 ④): the same drop methods as `drag`.
	// svelte-ignore state_referenced_locally
	const mover = new PanelMover(
		dock,
		drag,
		() => hostEl,
		() => policy,
		{ messages: () => ({ ...defaultDockMessages, ...messages }) }
	);
	setPanelMover(mover);

	// svelte-ignore state_referenced_locally
	const gesture = new GestureOwner(
		dock,
		() => hostEl,
		() => ({
			// A `drag` may end in dock / undock: not started while structure changes are held (IME).
			canStart: (kind, panelId) =>
				!(kind === 'drag' && lifecycle.isDeferred()) &&
				(canStartGesture ? canStartGesture(kind, panelId) : true),
			isEscapeBlocked,
			onEnd: (session, outcome, reason) => onGestureEnd?.(session.kind, outcome, reason)
		})
	);
	setGestureOwner(gesture);
	onDestroy(() => gesture.dispose());

	// `arrange` turned off (#663 ④, three-pane-dock-plan §4.5): a gesture in progress is cancelled
	// (its target goes back to how it was) and a change still being asked is not applied (`stale`).
	// Before the controls go away (`.pre`), note the pane holding the DOM focus; after, a focus they
	// dropped goes to that pane (its tab, or its body), else to the first docked pane's. A focus the
	// app put elsewhere meanwhile is left alone.
	let arrangeFocusPanel: string | null = null;
	$effect.pre(() => {
		const allowed = arrange;
		if (allowed) return;
		untrack(() => {
			if (gesture.active) gesture.cancel('api');
			lifecycle.invalidatePending();
			const active = document.activeElement;
			if (!hostEl || !active || !hostEl.contains(active)) return;
			const owner = active.closest<HTMLElement>(
				'[data-dock-drop-id], [data-dock-window-id], [data-dock-flyout]'
			);
			arrangeFocusPanel =
				owner?.dataset.dockDropId ??
				owner?.dataset.dockWindowId ??
				owner?.dataset.dockFlyout ??
				null;
		});
	});
	$effect(() => {
		const allowed = arrange;
		if (allowed) return;
		untrack(() => {
			const from = arrangeFocusPanel;
			arrangeFocusPanel = null;
			if (from === null || !hostEl) return;
			const dropped = () => !document.activeElement || document.activeElement === document.body;
			if (!dropped()) return;
			const flyout = [...hostEl.querySelectorAll<HTMLElement>('[data-dock-flyout]')].find(
				(el) => el.dataset.dockFlyout === from
			);
			(
				flyout?.querySelector<HTMLElement>('[role="region"]') ?? titleBarFocusTarget(hostEl, from)
			)?.focus();
			if (!dropped()) return;
			const first = collectPanelIds(dock.layout.docked)[0];
			if (first) titleBarFocusTarget(hostEl, first)?.focus();
		});
	});

	/**
	 * Hide a pane through `beforePanelChange` (`hide`): a `keepMounted` floating
	 * window keeps its content mounted (`hidden` + `inert`); a docked pane
	 * becomes a closed floating window (re-mounted) that remembers its docked
	 * place for `showPanel` (#663). Geometry is kept.
	 */
	export function hidePanel(panelId: string): Promise<DockPanelChangeOutcome> {
		return lifecycle.hide(panelId);
	}

	/**
	 * Close a pane through `beforePanelChange` (`close`): its content is
	 * discarded even when `keepMounted`, until the pane is opened again.
	 * Geometry is kept.
	 */
	export function closePanel(panelId: string): Promise<DockPanelChangeOutcome> {
		return lifecycle.close(panelId);
	}

	/**
	 * Show a pane wherever it belongs (#663): a pane hidden from the docked
	 * tree goes back to its remembered docked place (a floating window when
	 * that place is gone), a closed floating window opens, an open one comes to
	 * front, a docked background tab becomes the active tab (asked as a
	 * `tab-switch`). Re-docking a pane as the active tab of a tab group is
	 * asked first as a `tab-switch` from the group's active pane (like a tab
	 * click: refused = it stays hidden; held during IME composition). Putting a
	 * `keepMounted` pane's still-mounted content back into the tree is asked as
	 * a `dock` change; anything else is not asked (like `dock.open`). DOM focus
	 * is not moved.
	 */
	export function showPanel(panelId: string): Promise<DockPanelChangeOutcome> {
		return lifecycle.show(panelId);
	}

	/**
	 * A View menu's checkbox (#663): `true` = `showPanel`, `false` = the ✕
	 * button (hide for a `keepMounted` pane, close otherwise, through
	 * `beforePanelChange`). A pane whose `capabilities` say `close: false` is
	 * not taken off the screen (`refused`), like its missing ✕ button.
	 * `options.isCurrent` (PR #723 review) is re-read right before the change is applied (and
	 * before each further request it makes): `false` = `stale`, nothing changed - e.g. the app
	 * asked for the opposite meanwhile and the pane is already where that wants it.
	 */
	export function setPanelVisible(
		panelId: string,
		visible: boolean,
		options: { isCurrent?: () => boolean } = {}
	): Promise<DockPanelChangeOutcome> {
		if (!visible && dock.isVisible(panelId) && capabilities?.(panelId)?.close === false) {
			return Promise.resolve('refused');
		}
		return lifecycle.guarded(options.isCurrent, () => lifecycle.setVisible(panelId, visible));
	}

	/**
	 * Auto-hide the docked region holding `panelId` to the band on its side (#694 PR-3, the
	 * pin button): asked through `beforePanelChange` (`reparent` of the panes it pushes out,
	 * then `auto-hide` `to: 'band'`). A region whose panes do not all allow `autoHide` is
	 * `refused`, like its missing pin button. DOM focus is not moved.
	 */
	export function autoHidePanel(panelId: string): Promise<DockPanelChangeOutcome> {
		const region = regionOf(dock.layout.docked, panelId);
		if (!region) return Promise.resolve('stale');
		if (!regionPanelIds(region).every((id) => resolveCapabilities(policy, id).autoHide)) {
			return Promise.resolve('refused');
		}
		const mainId = mainRegionId(dock.layout.docked, (id) => isMainPane(policy, id));
		return lifecycle.autoHide(region.id, { mainId });
	}

	/** Pin the auto-hidden region holding `panelId` back in its docked place (#694 PR-3), asked through `beforePanelChange`. DOM focus is not moved. */
	export function pinPanel(panelId: string): Promise<DockPanelChangeOutcome> {
		if (!arrange) return Promise.resolve('refused');
		return lifecycle.restoreAutoHidden(panelId);
	}

	/**
	 * Move a pane without a drag (#663 ④, the "panel actions" menu uses it too): to an outer edge
	 * (`{ edge }`), into the tab group of a docked pane (`{ tabWith }`), next to a docked pane's
	 * region (`{ splitWith, side }`), out as a floating window (`{ float: true }`), or a window
	 * floated from the tree back to where it was (`{ back: true }`; remembered while this host is
	 * mounted). It goes through the drag's own drop path: the same capabilities (`move`, `undock`,
	 * the target's `dropCenter` / `dropSplit`), a locked window does not move, and the same
	 * `beforePanelChange` requests (the panes it pushes out, then `dock` / `move-docked` /
	 * `undock`). A move the drag would not offer resolves `unavailable` and changes nothing; a
	 * refusal or a structure change while it was asked changes nothing either. The result is
	 * announced in the host's `aria-live="polite"` region. DOM focus is only repaired (a focus the
	 * move dropped goes to the moved pane's title bar).
	 */
	export function movePanel(panelId: string, target: DockMoveTarget): Promise<DockMoveOutcome> {
		return mover.move(panelId, target);
	}

	/**
	 * Whether `movePanel(panelId, target)` would be offered now (the same rules; reactive). Nothing is
	 * asked, changed or announced (#663 ④: `ThreePaneDock.dockBack` picks its target with it).
	 */
	export function canMovePanel(panelId: string, target: DockMoveTarget): boolean {
		return mover.offers(panelId, target);
	}

	/**
	 * Replace the whole layout (#663 ④, three-pane-dock-plan §4.4: `ThreePaneDock`'s `resetLayout` /
	 * `restoreLayout`) through `beforePanelChange`: every pane whose content the replacement takes
	 * off the screen or re-mounts is asked first (`hide` / `close` / `tab-switch` / `dock` / `undock` /
	 * `move-docked` / `auto-hide`, `core/replace.ts`), one after the other as one decision; a
	 * refusal, or a structure change while it is asked (`stale`), leaves the layout as it is. A
	 * `persistent` pane that stays on screen is not asked. `next` is checked by `validateDockLayout`
	 * first: an invalid one resolves `invalid` and changes nothing. DOM focus is only repaired (a
	 * focus the replacement dropped from the host goes to `focusPanel`'s title bar, default the
	 * first docked pane's); a focus the app took elsewhere meanwhile is left alone.
	 * `options.saved`: `next` is a saved layout (`serialize()` / `savedLayout()`), not one built from
	 * today's: its shares do not count the floated panes' places (#739), so they are dropped in the
	 * same step that puts it in, as by `hydrate` - a save reacting to the change never sees the new
	 * layout with the old places. Leave it off for a layout made from the live one.
	 * `options.isCurrent` is re-read before each request and right before the replacement is
	 * applied: `false` = `stale`, nothing changed (like `setPanelVisible`'s).
	 */
	export async function replaceLayout(
		next: DockLayout,
		options: { focusPanel?: string; isCurrent?: () => boolean; saved?: boolean } = {}
	): Promise<DockPanelChangeOutcome | 'invalid'> {
		const checked = validateDockLayout(next);
		if (!checked.ok) return 'invalid';
		const layout = checked.layout;
		const active = document.activeElement;
		const focusWasInHost = !!hostEl && !!active && hostEl.contains(active);
		const outcome = await lifecycle.guarded(options.isCurrent, () =>
			lifecycle.requestReplace(
				() => layout,
				(l) => {
					if (options.saved) forgetHomeSlots(dock);
					adoptLayout(dock, l);
				}
			)
		);
		if (outcome !== 'applied' || !focusWasInHost) return outcome;
		await tick();
		const now = document.activeElement;
		if (hostEl?.isConnected && (!now || now === document.body)) {
			const to = options.focusPanel ?? collectPanelIds(dock.layout.docked)[0];
			if (to) titleBarFocusTarget(hostEl, to)?.focus();
		}
		return outcome;
	}

	/** Retry a change held by `isStructureChangeDeferred` now (a custom predicate turned false without a composition / focus event). */
	export function resumeDeferredChange(): void {
		lifecycle.resumeDeferred();
	}
</script>

<div
	class="dock-host"
	data-dock-host
	bind:this={hostEl}
	bind:clientWidth={hostW}
	bind:clientHeight={hostH}
>
	{#if dock.layout.docked}
		<div
			class="docked-layer"
			style:top={bandEdges.has('top') ? BAND : undefined}
			style:bottom={bandEdges.has('bottom') ? BAND : undefined}
			style:left={bandEdges.has('left') ? BAND : undefined}
			style:right={bandEdges.has('right') ? BAND : undefined}
		>
			<DockedTree
				node={dock.layout.docked}
				{dock}
				panel={treePanel}
				{iconContent}
				{onPopOut}
				{messages}
			/>
		</div>
	{/if}

	<!-- Edge bands and slide-outs of auto-hidden regions (#694 PR-3): above the docked tree, below floating windows. -->
	<DockAutoHide {dock} panel={treePanel} {iconContent} {messages} />

	<div class="floating-layer">
		{#each renderedWindows as win (win.id)}
			{@const z = zOrder.get(win.id) ?? 0}
			<DockWindow
				{win}
				{dock}
				{hostW}
				{hostH}
				hidden={!win.open}
				frontmost={win.open && z === openWindows.length - 1}
				zIndex={z + 1}
				panel={treePanel}
				{iconContent}
				{onPopOut}
				{messages}
			/>
		{/each}
	</div>

	<!-- The result of a move (#663 ④, `movePanel` / the panel actions menu), read out politely. -->
	<div class="dock-live" aria-live="polite" aria-atomic="true">{mover.announcement}</div>

	<!-- Persistent panes (module doc): each content is rendered here once and moved into its receptacle. -->
	<div class="persistent-stash" hidden>
		{#each persistentPanes as content (content.id)}
			<!-- The id as a `@const` (a derived string): the attachment re-runs only if it changes, not
			     on every new node object of the same pane (that would move the content out and back). -->
			{@const id = content.id}
			<div class="persistent-home">
				<div
					class="persistent-content"
					data-dock-persistent={id}
					{@attach persistentContents.content(id)}
				>
					{@render panel(content)}
				</div>
			</div>
		{/each}
	</div>

	{#if drag.state}
		<!-- Guide buttons (#694 PR-1/PR-2): the host's outer-edge buttons and the cross on the pane
		     under the pointer. Drawn only during a drag and never hit-tested (`pointer-events: none`,
		     `aria-hidden`): `core/drag.svelte.ts` tests them by geometry. -->
		{#each drag.state.edgeButtons as b (b.region)}
			<div
				class="guide-button outer region-{b.region}"
				class:active={drag.state.hoverEdge === b.region}
				data-dock-edge={b.region}
				aria-hidden="true"
				style:left={`${b.rect.x}px`}
				style:top={`${b.rect.y}px`}
				style:width={`${b.rect.width}px`}
				style:height={`${b.rect.height}px`}
			>
				<span class="glyph"></span>
			</div>
		{/each}
		{#each drag.state.crossButtons as b (b.region)}
			<div
				class="guide-button region-{b.region}"
				class:active={drag.state.hoverRegion === b.region}
				data-dock-cross={b.region}
				aria-hidden="true"
				style:left={`${b.rect.x}px`}
				style:top={`${b.rect.y}px`}
				style:width={`${b.rect.width}px`}
				style:height={`${b.rect.height}px`}
			>
				<span class="glyph"></span>
			</div>
		{/each}
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
			{#if drag.state.icon}
				<span class="icon">
					{#if iconContent}
						{@render iconContent(drag.state.icon)}
					{:else}
						{drag.state.icon}
					{/if}
				</span>
			{/if}
			<span class="title">{drag.state.title}</span>
		</div>
	{/if}
</div>

<!-- What the tree draws for a pane: an empty receptacle for a persistent one (module doc), else the app's snippet. -->
{#snippet treePanel(content: PanelContent)}
	{@const id = content.id}
	{#if persistent?.(id)}
		<!-- `id` as a `@const` for the same reason as in the stash. -->
		<div
			class="persistent-slot"
			data-dock-persistent-slot={id}
			{@attach persistentContents.slot(id)}
		></div>
	{:else}
		{@render panel(content)}
	{/if}
{/snippet}

<style>
	.dock-host {
		position: relative;
		overflow: hidden;
		width: 100%;
		height: 100%;
		background: var(--banto-bg);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
	}

	/* Its own stacking context (#694 PR-3): a pane's positioned content with a positive
	   z-index (e.g. a chart's reset-zoom button) stays inside the docked layer, below the
	   auto-hide slide-out (later in the DOM) and the floating layer (z-index 1). Except while
	   a pane shows a modal (`@banto/ui` OverlayPanel renders in place, `position: fixed` +
	   `--banto-z-modal`): the layer is not isolated then, so the modal and its scrim stay
	   above the floating windows (the scrim covers the rest anyway). */
	.docked-layer {
		position: absolute;
		inset: 0;
	}

	/* A persistent pane's receptacle and content add no box: the app's content lays out as if
	   it were rendered in place. */
	.persistent-slot,
	.persistent-content {
		display: contents;
	}

	.docked-layer:not(:has([aria-modal='true'])) {
		isolation: isolate;
	}

	/* Its own stacking context (z-index 1) so the windows' z-index (1..n) stays
	   below the snap guide / ghost and never competes with the page; it lets
	   pointers through to the docked tree, the windows opt back in. */
	.floating-layer {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
	}

	/* Visually hidden, still read (the usual "sr-only" shape: a 1px box clipped away). */
	.dock-live {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	/* Snap guide follows the pointer every move - no transition, it must track instantly. */
	.snap-guide {
		position: absolute;
		background: var(--banto-dock-snap-fill);
		border: var(--banto-border-width-strong) solid var(--banto-dock-snap-border);
		border-radius: var(--banto-radius-md);
		box-sizing: border-box;
		pointer-events: none;
		z-index: 20;
	}

	/* Guide buttons (#694 PR-1/PR-2): only during a drag, above the snap guide so they stay
	   visible over the region they preview. Placed and sized by the controller (a shape,
	   `core/dropzones.ts`); the glyph shows which part of the target the drop takes. */
	.guide-button {
		position: absolute;
		box-sizing: border-box;
		background: var(--banto-surface-raised);
		border: var(--banto-border-width) solid var(--banto-dock-snap-border);
		border-radius: var(--banto-radius-sm);
		box-shadow: var(--banto-dock-shadow);
		pointer-events: none;
		z-index: 21;
	}

	.guide-button.active {
		background: var(--banto-dock-snap-fill);
		border-width: var(--banto-border-width-strong);
	}

	.guide-button .glyph {
		position: absolute;
		inset: 20%;
		box-sizing: border-box;
		border: var(--banto-border-width) solid var(--banto-dock-snap-border);
		border-radius: var(--banto-radius-sm);
	}

	/* The part of the target the drop takes: half of a pane, a quarter of the host. */
	.region-left .glyph {
		right: 50%;
		background: var(--banto-dock-snap-fill);
	}

	.region-right .glyph {
		left: 50%;
		background: var(--banto-dock-snap-fill);
	}

	.region-top .glyph {
		bottom: 50%;
		background: var(--banto-dock-snap-fill);
	}

	.region-bottom .glyph {
		top: 50%;
		background: var(--banto-dock-snap-fill);
	}

	.region-center .glyph {
		background: var(--banto-dock-snap-fill);
	}

	.outer.region-left .glyph {
		right: 65%;
	}

	.outer.region-right .glyph {
		left: 65%;
	}

	.outer.region-top .glyph {
		bottom: 65%;
	}

	.outer.region-bottom .glyph {
		top: 65%;
	}

	/* Drag ghost follows the pointer every move - no transition, same reason as .snap-guide. */
	.drag-ghost {
		position: fixed;
		transform: translate(var(--banto-space-4), var(--banto-space-4));
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		max-width: 16rem;
		padding: var(--banto-space-1) var(--banto-space-3);
		background: var(--banto-dock-ghost-bg);
		border: var(--banto-border-width) solid var(--banto-dock-ghost-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-dock-shadow);
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
		color: var(--banto-text);
		pointer-events: none;
		z-index: 30;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
