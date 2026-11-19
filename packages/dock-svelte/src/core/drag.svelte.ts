/**
 * Unified dock-drag controller (M8 Phase B, spec §5.2: drag a panel to dock/
 * undock/retab it, with a live snap-guide preview). Both `DockedTree.svelte`
 * (docked panes/tabs) and `DockWindow.svelte` (floating titlebars) start a
 * drag through this ONE controller so there's a single place that knows how
 * to resolve a drop - no duplicated hit-testing or drop logic in either
 * component (the task's explicit ask: "Keep the drag controller in ONE
 * place").
 *
 * Hit-testing choice: `document.elementFromPoint` + `closest
 * ('[data-dock-drop-id]')`, NOT a manual registry of `{id, getRect}`. Reasons:
 *  - It's automatically correct about DOM stacking/occlusion: a floating
 *    window painted on top of the docked tree (or another floating window)
 *    naturally wins the hit test without this module having to track z-order
 *    itself.
 *  - Docked drop targets are exactly the elements `DockedTree` already
 *    stamps with `data-dock-drop-id` (one per panel-pane or tabs-group -
 *    see that file); no separate registration/unregistration lifecycle to
 *    leak.
 *  - The "floating area" fallback is just "inside the host but didn't hit a
 *    `[data-dock-drop-id]` element" - one more `.contains()` check, no extra
 *    bookkeeping.
 * The pane under the pointer only says WHERE the guide goes: since #694 PR-2 a
 * drag docks only on a guide button - the cross in the middle of that pane
 * (`core/dropzones.ts#crossButtons`) or one of the host's OUTER-EDGE buttons
 * (#694 PR-1/PR-2, `core/edges.ts`; offered only when something else is docked,
 * tested before the cross, a drop there wraps the docked root, `#finishEdge`).
 * Both are laid out and hit-tested by geometry here, only while a drag is in
 * progress. A release in the host off every button floats the pane (or moves the
 * floating window), like a release on free space.
 * The one thing this requires of callers: the drag ghost, the guide buttons and
 * the snap-guide overlay MUST be `pointer-events: none` (see `DockHost.svelte`), otherwise
 * they'd be the element under the cursor and everything below would be
 * unreachable.
 *
 * No live mutation during the drag: `dock.move`/`dockPanel`/etc. are only
 * ever called once, from `commit()` on the owning pointer's pointerup (a
 * structure change - dock / undock / move a docked pane - only once the host's
 * pane lifecycle agrees, #432: refused = the pane stays where it was). Every intermediate
 * pointermove only updates this controller's own `$state` snapshot (read by
 * `DockHost` to position the ghost chip + snap-guide overlay) - the real
 * panel never moves mid-drag, matching the task's explicit ask.
 *
 * Listeners: this controller has none of its own. The `GestureOwner`
 * (`core/gesture.svelte.ts`, shared-primitives-upstream-plan §3.3, #433)
 * owns the pointer and routes the owning pointer's moves to `update`, its
 * release to `commit`, and Esc / pointercancel / blur / unmount to `cancel` -
 * so a different pointer's pointerup can no longer finish a drag, and an Esc
 * that a higher layer already consumed is no longer taken.
 */
import { getContext, setContext, tick } from 'svelte';
import { displayWindowGeometry, dropRegionRect, type Rect } from './geometry';
import type { DockPanelChange, DockPanelChangeOutcome, PanelLifecycle } from './lifecycle';
import { captureDockSlot, restoreDockSlot } from './slot';
import { resolveCapabilities, type DockPolicy } from './policy';
import {
	collectPanelIds,
	dockPanelAtEdge,
	EDGE_DOCK_RATIO,
	dockPanelIntoTree,
	findNode,
	findParent,
	removePanel
} from './tree';
import type { DockState } from '../state.svelte';
import type { DockEdge, DockNode, DockPanelNode, DockSlot, DropRegion } from '../types';
import { crossButtons, hitGuideButton, rectsOverlap, type GuideButton } from './dropzones';
import { edgeButtons } from './edges';

/** Where a drag originated - determines which `DockState` method finishes it (see `#finish`). */
export type DragSource = 'floating' | 'docked';

export interface DragStartOptions {
	panelId: string;
	title: string;
	icon?: string;
	source: DragSource;
	/** Size to give the resulting floating window if this drag ends over empty floating space (the dragged pane/window's own current size). */
	width: number;
	height: number;
	/** Pointer position (client/viewport coords) at the moment the drag actually starts (i.e. once the move threshold is crossed, not the original pointerdown). */
	clientX: number;
	clientY: number;
	/** The dragged element's own bounding-rect top-left (client coords) at drag start - preserves the original "grab point" when the panel lands in floating space (see `grabDx`/`grabDy` below). */
	originClientX: number;
	originClientY: number;
}

/** Reactive snapshot of the in-progress drag, read by `DockHost` to render the ghost chip + snap-guide overlay. `null` when no drag is active. */
export interface DragSnapshot {
	panelId: string;
	title: string;
	icon?: string;
	source: DragSource;
	clientX: number;
	clientY: number;
	width: number;
	height: number;
	/** Pointer-to-origin offset captured at drag start (see `DragStartOptions`). */
	grabDx: number;
	grabDy: number;
	/** `data-dock-drop-id` of the docked pane/tabs-group under the pointer (the one `crossButtons` is drawn on), if any. */
	hoverTargetId: string | null;
	/** The cross button the pointer is on (#694 PR-2); `null` = off the buttons (no dock into `hoverTargetId`). */
	hoverRegion: DropRegion | null;
	/** True when a release here floats the pane / moves the window: in the host, on no guide button and no collapsed band. */
	hoverFloating: boolean;
	/** The outer-edge button being hovered (#694 PR-1/PR-2, `core/edges.ts`); wins over `hoverRegion` / `hoverFloating`. */
	hoverEdge: DockEdge | null;
	/** Host-relative outer-edge buttons `DockHost` draws; empty = no outer-edge drop offered for this drag (nothing else docked, or the host is too small). */
	edgeButtons: GuideButton<DockEdge>[];
	/** Host-relative cross buttons on `hoverTargetId` (#694 PR-2), minus the ones its panes' capabilities withhold and the ones under an outer-edge button. */
	crossButtons: GuideButton[];
	/** Host-relative snap-guide rectangle to render, or `null` if nothing to show (e.g. dragged outside the host entirely). */
	guideRect: Rect | null;
}

/**
 * Read right before a move is applied (#663 ④, `DockHost.movePanel`): `false` = the move is no
 * longer allowed (a window locked, a capability withdrawn while `beforePanelChange` waited -
 * neither is part of `structureKey`), so nothing is applied and the outcome is `stale`.
 */
export type MoveGuard = () => boolean;

/**
 * Run `request` with an `apply` that first reads `guard`; without a lifecycle (`request`
 * returns `undefined`) it applies at once. An apply the guard stopped turns `applied` into `stale`.
 */
function guarded(
	guard: MoveGuard | undefined,
	request: (run: () => void) => Promise<DockPanelChangeOutcome> | undefined,
	apply: () => void
): Promise<DockPanelChangeOutcome> {
	let stopped = false;
	const run = () => {
		if (guard && !guard()) stopped = true;
		else apply();
	};
	const pending = request(run);
	if (!pending) {
		run();
		return Promise.resolve(stopped ? 'stale' : 'applied');
	}
	if (!guard) return pending;
	return pending.then((outcome) => (outcome === 'applied' && stopped ? 'stale' : outcome));
}

export class DragController {
	#dock: DockState;
	#getHostEl: () => HTMLElement | null;
	state: DragSnapshot | null = $state(null);

	#getPolicy: () => DockPolicy | undefined;
	#getLifecycle: () => PanelLifecycle | undefined;

	/**
	 * `getPolicy` supplies the host's clamp options and pane capabilities (see
	 * `core/policy.ts`); absent = package defaults, everything allowed.
	 * `getLifecycle` is the host's pane lifecycle (`core/lifecycle.ts`, #432):
	 * a drop that changes the structure (dock / undock / move a docked pane)
	 * goes through its `request`; absent = applied directly.
	 */
	constructor(
		dock: DockState,
		getHostEl: () => HTMLElement | null,
		getPolicy: () => DockPolicy | undefined = () => undefined,
		getLifecycle: () => PanelLifecycle | undefined = () => undefined
	) {
		this.#dock = dock;
		this.#getHostEl = getHostEl;
		this.#getPolicy = getPolicy;
		this.#getLifecycle = getLifecycle;
	}

	/**
	 * A drop into the docked tree: also asks about the docked panes it pushes
	 * out - a new active tab, a pane a new split / tab group is made around
	 * (`PanelLifecycle.requestPlacement`, #666) - before `own`. Refused = the
	 * layout is not touched (the ghost is already gone). `guard` (`MoveGuard`) is read right
	 * before `apply`.
	 */
	#placement(
		panelId: string,
		own: DockPanelChange,
		preview: () => DockNode | null | undefined,
		target: unknown,
		apply: () => void,
		guard?: MoveGuard
	): Promise<DockPanelChangeOutcome> {
		const lifecycle = this.#getLifecycle();
		return guarded(
			guard,
			(run) => lifecycle?.requestPlacement(panelId, () => own, preview, run, target),
			apply
		);
	}

	/** True while a drag is in progress - handy guard for consumers that don't need the full snapshot. */
	get active(): boolean {
		return this.state !== null;
	}

	start(opts: DragStartOptions): void {
		// The GestureOwner allows one session at a time, so a second start
		// cannot normally happen; bail defensively anyway.
		if (this.state) return;

		this.state = {
			panelId: opts.panelId,
			title: opts.title,
			icon: opts.icon,
			source: opts.source,
			clientX: opts.clientX,
			clientY: opts.clientY,
			width: opts.width,
			height: opts.height,
			grabDx: opts.clientX - opts.originClientX,
			grabDy: opts.clientY - opts.originClientY,
			hoverTargetId: null,
			hoverRegion: null,
			hoverFloating: false,
			hoverEdge: null,
			edgeButtons: [],
			crossButtons: [],
			guideRect: null
		};
		this.#recomputeHover(opts.clientX, opts.clientY);
	}

	/** The owning pointer moved (routed by the `GestureOwner`). */
	update(clientX: number, clientY: number): void {
		this.#recomputeHover(clientX, clientY);
	}

	/**
	 * The owning pointer was released (routed by the `GestureOwner`): resolve
	 * the drop at the release point and apply it - the only `DockState` write
	 * of the whole drag. The ghost is cleared FIRST, so the layout change and
	 * anything it triggers never see a half-finished drag.
	 */
	commit(clientX: number, clientY: number): void {
		if (!this.state) return;
		this.#recomputeHover(clientX, clientY);
		const snapshot = this.state;
		this.state = null;
		if (snapshot) this.#finish(snapshot);
	}

	/** Cancel the current drag with no side effects (spec §5.2: Esc cancels / an invalid drop is a no-op). */
	cancel(): void {
		this.state = null;
	}

	#recomputeHover(clientX: number, clientY: number): void {
		if (!this.state) return;
		const hostEl = this.#getHostEl();
		const hitEl = document.elementFromPoint(clientX, clientY);
		const paneEl = (hitEl as Element | null)?.closest<HTMLElement>('[data-dock-drop-id]') ?? null;

		let hoverTargetId: string | null = null;
		let hoverRegion: DropRegion | null = null;
		let hoverFloating = false;
		let guideRect: Rect | null = null;
		let hoverEdge: DockEdge | null = null;
		let edges: GuideButton<DockEdge>[] = [];
		let cross: GuideButton[] = [];
		// A band of a collapsed region (#663 ③-B) is neither a pane to drop onto nor free
		// space (that would float the pane): the drop there is a no-op.
		const noDrop = (hitEl as Element | null)?.closest('[data-dock-no-drop]') != null;

		if (hostEl) {
			const hostRect = hostEl.getBoundingClientRect();
			const x = clientX - hostRect.left;
			const y = clientY - hostRect.top;
			const inHost = hitEl !== null && hostEl.contains(hitEl);
			// The outer-edge buttons (#694 PR-1/PR-2) are hit-tested first, by geometry only
			// (`core/edges.ts`): drawn `pointer-events: none`, only during a drag, and only when
			// something else is docked - with an empty tree (or only the dragged pane) a drop
			// behaves as before.
			if (this.#edgesOffered(this.state.panelId)) {
				edges = edgeButtons(hostRect.width, hostRect.height);
				hoverEdge = inHost ? hitGuideButton(edges, x, y) : null;
				if (hoverEdge)
					guideRect = dropRegionRect(
						{ x: 0, y: 0, width: hostRect.width, height: hostRect.height },
						hoverEdge,
						EDGE_DOCK_RATIO
					);
			}

			if (!noDrop && paneEl && hostEl.contains(paneEl)) {
				const paneRect = paneEl.getBoundingClientRect();
				const hostRelative: Rect = {
					x: paneRect.left - hostRect.left,
					y: paneRect.top - hostRect.top,
					width: paneRect.width,
					height: paneRect.height
				};
				hoverTargetId = paneEl.dataset.dockDropId ?? null;
				if (hoverTargetId !== null) {
					// An outer-edge button wins where they meet (a small pane on the host's border):
					// the cross buttons under one are not offered.
					cross = crossButtons(hostRelative, this.#crossOptions(hoverTargetId)).filter(
						(b) => !edges.some((e) => rectsOverlap(e.rect, b.rect))
					);
					if (!hoverEdge) {
						hoverRegion = hitGuideButton(cross, x, y);
						if (hoverRegion) guideRect = dropRegionRect(hostRelative, hoverRegion);
					}
				}
			}

			if (!hoverEdge && !hoverRegion && !noDrop && inHost) {
				hoverFloating = true;
				guideRect = {
					x: x - this.state.grabDx,
					y: y - this.state.grabDy,
					width: this.state.width,
					height: this.state.height
				};
			}
		}

		this.state = {
			...this.state,
			clientX,
			clientY,
			hoverTargetId,
			hoverRegion,
			hoverFloating,
			hoverEdge,
			edgeButtons: edges,
			crossButtons: cross,
			guideRect
		};
	}

	/**
	 * Which cross buttons the drop target `targetId` (a pane or a tab group) offers (#694 PR-2):
	 * `dropCenter` / `dropSplit` of its panes, every pane of a group must allow it.
	 */
	#crossOptions(targetId: string): { center: boolean; split: boolean } {
		const policy = this.#getPolicy();
		if (!policy?.capabilities) return { center: true, split: true };
		const ids = collectPanelIds(findNode(this.#dock.layout.docked, targetId));
		const caps = ids.map((id) => resolveCapabilities(policy, id));
		return { center: caps.every((c) => c.dropCenter), split: caps.every((c) => c.dropSplit) };
	}

	/** Whether a drop on the host's outer edges is offered for `panelId`: some OTHER pane is docked (there is a root to wrap). */
	#edgesOffered(panelId: string): boolean {
		return collectPanelIds(this.#dock.layout.docked).some((id) => id !== panelId);
	}

	/**
	 * Where each pane floated by `floatDocked` was docked (#663 ④, `DockHost.movePanel`'s
	 * `{ back: true }`): captured right before it leaves the tree, dropped when it docks again
	 * through this controller. Kept for the host's lifetime only (not part of the saved layout);
	 * a place that is gone by then is found out by `restoreDockSlot` (`placeBack` = not offered).
	 */
	readonly homeSlots = new Map<string, DockSlot>();

	/**
	 * An outer-edge drop (#694 PR-1). Wrapping the root re-mounts every docked pane whose chain
	 * changes, so `requestPlacement` asks them first (`reparent`), then the moved pane (`dock` /
	 * `move-docked`); the preview uses a fixed id for the new split so the re-checks compare the
	 * same tree. The apply is a no-op when the panel is gone by then (apply by id).
	 * `null` = not offered (nothing else docked): nothing is asked or changed. Also the keyboard
	 * path (`DockHost.movePanel`, #663 ④).
	 */
	placeAtEdge(
		panelId: string,
		source: DragSource,
		edge: DockEdge,
		guard?: MoveGuard
	): Promise<DockPanelChangeOutcome> | null {
		const dock = this.#dock;
		if (!this.#edgesOffered(panelId)) return null;
		const target = { edge };
		const wrap = (root: DockNode | null, node: DockPanelNode): DockNode =>
			dockPanelAtEdge(root, node, edge, () => `${panelId}:dropped`);
		const hostEl = this.#getHostEl();
		const withFocus = (apply: () => void) => () => {
			const active = document.activeElement;
			const frameId =
				hostEl && active && hostEl.contains(active)
					? (active.closest<HTMLElement>('[data-dock-drop-id]')?.dataset.dockDropId ?? null)
					: undefined;
			apply();
			this.homeSlots.delete(panelId);
			// `undefined` = the focus was not in the host: nothing to hand back.
			if (frameId !== undefined && hostEl)
				void tick().then(() => refocus(hostEl, frameId, panelId));
		};
		if (source === 'floating')
			return this.#placement(
				panelId,
				{ kind: 'dock', panelId, remount: true },
				() => {
					const win = dock.layout.floating.find((w) => w.id === panelId);
					if (!win) return undefined;
					return wrap(dock.layout.docked, {
						type: 'panel',
						id: win.id,
						title: win.title,
						icon: win.icon
					});
				},
				target,
				withFocus(() => dock.dockPanelAtEdge(panelId, edge)),
				guard
			);
		return this.#placement(
			panelId,
			{ kind: 'move-docked', panelId, remount: true },
			() => {
				const node = findNode(dock.layout.docked, panelId);
				if (node?.type !== 'panel') return undefined;
				const rest = removePanel(dock.layout.docked, panelId);
				if (!rest) return undefined;
				return wrap(rest, node);
			},
			target,
			withFocus(() => dock.dockExistingAtEdge(panelId, edge)),
			guard
		);
	}

	/**
	 * Which drops onto the docked pane / tab group `targetId` are offered (#694 PR-2, the cross
	 * guide's buttons): `center` = join it as a tab (`dropCenter`), `split` = split it
	 * (`dropSplit`). Also read by the keyboard path (#663 ④) so both offer the same targets.
	 */
	dropOptions(targetId: string): { center: boolean; split: boolean } {
		return this.#crossOptions(targetId);
	}

	/**
	 * A drop onto the docked pane / tab group `targetId` (a cross button, #694 PR-2): the docked
	 * panes it pushes out are asked first (#666), then the moved pane (`dock` / `move-docked`).
	 * Does not check the target's `dropCenter` / `dropSplit` (the caller offered only allowed
	 * buttons; see `dropOptions`). Also the keyboard path (`DockHost.movePanel`, #663 ④).
	 */
	placeOnto(
		panelId: string,
		source: DragSource,
		targetId: string,
		region: DropRegion,
		guard?: MoveGuard
	): Promise<DockPanelChangeOutcome> {
		const dock = this.#dock;
		const target = { to: targetId, region };
		// The tree the drop makes, for asking the panes it pushes out (#666). A fixed id for a
		// new split / tab group keeps it stable across the re-checks.
		const into = (root: DockNode | null, node: DockPanelNode): DockNode =>
			dockPanelIntoTree(root, node, targetId, region, () => `${panelId}:dropped`);
		if (source === 'floating')
			return this.#placement(
				panelId,
				{ kind: 'dock', panelId, remount: true },
				() => {
					const win = dock.layout.floating.find((w) => w.id === panelId);
					if (!win) return undefined;
					return into(dock.layout.docked, {
						type: 'panel',
						id: win.id,
						title: win.title,
						icon: win.icon
					});
				},
				target,
				() => {
					dock.dockPanel(panelId, targetId, region);
					this.homeSlots.delete(panelId);
				},
				guard
			);
		return this.#placement(
			panelId,
			{ kind: 'move-docked', panelId, remount: true },
			() => {
				const node = findNode(dock.layout.docked, panelId);
				if (node?.type !== 'panel') return undefined;
				return into(removePanel(dock.layout.docked, panelId), node);
			},
			target,
			() => dock.dockExisting(panelId, targetId, region),
			guard
		);
	}

	/**
	 * Float the docked pane `panelId` (a drop on free space): asks the pane a shrinking split /
	 * tab group leaves first (`reparent`, #682), then `undock`. Its docked place is remembered
	 * for `placeBack` (`homeSlots`). `null` = its `undock` capability withholds it: nothing
	 * changes. Also the keyboard path (`DockHost.movePanel`, #663 ④).
	 */
	floatDocked(
		panelId: string,
		geometry?: { x: number; y: number; width: number; height: number },
		guard?: MoveGuard
	): Promise<DockPanelChangeOutcome> | null {
		const policy = this.#getPolicy();
		// `undock: false` panes stay docked: a drop on free space is ignored.
		if (policy && !resolveCapabilities(policy, panelId).undock) return null;
		const dock = this.#dock;
		const apply = () => {
			const hidden = dock.layout.floating.flatMap((w) =>
				!w.open && w.dockSlot ? [{ id: w.id, slot: w.dockSlot }] : []
			);
			const slot = captureDockSlot(dock.layout.docked, panelId, hidden);
			dock.undockPanel(panelId, geometry);
			if (slot && dock.layout.floating.some((w) => w.id === panelId && w.open))
				this.homeSlots.set(panelId, slot);
		};
		const lifecycle = this.#getLifecycle();
		return guarded(
			guard,
			(run) =>
				lifecycle?.requestRemoval(
					panelId,
					() => ({ kind: 'undock', panelId, remount: true }),
					run,
					geometry ?? 'float'
				),
			apply
		);
	}

	/**
	 * The docked tree `placeBack(panelId)` would make now; `undefined` = nothing to do (no
	 * remembered place, not an open window, the place is gone, or the drag would not drop it
	 * there: `#backAllowed`). Re-read by the lifecycle before each step and before the apply,
	 * so a rule that changes while the answer waits makes it `stale`.
	 */
	#backPreview(panelId: string, slot: DockSlot | undefined): DockNode | undefined {
		const win = this.#dock.layout.floating.find((w) => w.id === panelId);
		if (!win || !win.open || !slot) return undefined;
		const node: DockPanelNode = { type: 'panel', id: win.id, title: win.title, icon: win.icon };
		const after = restoreDockSlot(
			this.#dock.layout.docked,
			node,
			slot,
			() => `${panelId}:restored`
		);
		return after && this.#backAllowed(after, panelId) ? after : undefined;
	}

	/**
	 * Would the drag drop `panelId` where `after` puts it (#663 ④)? The targets' `dropCenter` /
	 * `dropSplit`, as the cross guide offers them (`#crossOptions`): into a tab group = every
	 * other pane of the group allows `dropCenter`; into a split = a pane / tab group next to it
	 * allows `dropSplit` (a drop next to that one makes the same place); a new root split (the
	 * old root wrapped) = an outer-edge drop, always offered; the only pane = no target.
	 */
	#backAllowed(after: DockNode, panelId: string): boolean {
		const policy = this.#getPolicy();
		if (!policy?.capabilities) return true;
		const parent = findParent(after, panelId);
		if (!parent) return true;
		const allow = (nodes: DockNode[], key: 'dropCenter' | 'dropSplit') =>
			nodes.flatMap((n) => collectPanelIds(n)).every((id) => resolveCapabilities(policy, id)[key]);
		if (parent.type === 'tabs')
			return allow(
				parent.children.filter((c) => c.id !== panelId),
				'dropCenter'
			);
		if (parent.type !== 'split') return true;
		if (parent === after && !findNode(this.#dock.layout.docked, parent.id)) return true;
		const i = parent.children.findIndex((c) => c.id === panelId);
		return [parent.children[i - 1], parent.children[i + 1]].some(
			(n) => n !== undefined && allow([n], 'dropSplit')
		);
	}

	/**
	 * Dock the floating window `panelId` back where `floatDocked` took it from (#663 ④): asked
	 * like any other drop into the tree (the panes it pushes out, then `dock`). `null` = no
	 * remembered place, or the place is gone: nothing changes.
	 */
	placeBack(panelId: string, guard?: MoveGuard): Promise<DockPanelChangeOutcome> | null {
		const dock = this.#dock;
		const slot = this.homeSlots.get(panelId);
		if (!slot || this.#backPreview(panelId, slot) === undefined) return null;
		return this.#placement(
			panelId,
			{ kind: 'dock', panelId, remount: true },
			() => this.#backPreview(panelId, slot),
			{ back: slot },
			() => {
				if (dock.dockAtSlot(panelId, slot, () => `${panelId}:restored`))
					this.homeSlots.delete(panelId);
			},
			guard
		);
	}

	/** Whether `placeBack(panelId)` would do something now (a remembered place that still exists and the drag would drop it there). */
	canPlaceBack(panelId: string): boolean {
		return this.#backPreview(panelId, this.homeSlots.get(panelId)) !== undefined;
	}

	/** Whether an outer-edge drop is offered for `panelId` (some OTHER pane is docked). */
	edgesOffered(panelId: string): boolean {
		return this.#edgesOffered(panelId);
	}

	#finish(snapshot: DragSnapshot): void {
		const {
			panelId,
			source,
			hoverTargetId,
			hoverRegion,
			hoverFloating,
			width,
			height,
			clientX,
			clientY,
			grabDx,
			grabDy,
			hoverEdge
		} = snapshot;
		const hostEl = this.#getHostEl();

		if (hoverEdge) {
			void this.placeAtEdge(panelId, source, hoverEdge);
			return;
		}

		if (hoverTargetId && hoverRegion) {
			// Dropping a docked panel back onto its OWN group/pane, dead center,
			// is a no-op ("dropped back where it started") rather than a
			// pointless remove+reinsert - see the module doc on why this is the
			// one self-drop case worth guarding explicitly.
			if (source === 'docked' && hoverRegion === 'center') {
				const parent = findParent(this.#dock.layout.docked, panelId);
				const ownContainerId = parent?.id ?? panelId;
				if (ownContainerId === hoverTargetId) return;
			}
			void this.placeOnto(panelId, source, hoverTargetId, hoverRegion);
			return;
		}

		if (hoverFloating && hostEl) {
			const hostRect = hostEl.getBoundingClientRect();
			const x = clientX - hostRect.left - grabDx;
			const y = clientY - hostRect.top - grabDy;
			const policy = this.#getPolicy();
			if (source === 'docked') {
				void this.floatDocked(panelId, { x, y, width, height });
			} else {
				const win = this.#dock.layout.floating.find((w) => w.id === panelId);
				if (win) {
					const hostW = hostEl.clientWidth;
					const hostH = hostEl.clientHeight;
					// The drag started from where the window was DRAWN (clamped to the
					// host), so the delta is measured from there, not the saved x/y.
					const shown = displayWindowGeometry(win, hostW, hostH, policy?.clamp);
					this.#dock.move(panelId, x - shown.x, y - shown.y, hostW, hostH, policy?.clamp);
				}
			}
			return;
		}

		// No valid target (dragged outside the host entirely, or the host isn't
		// mounted) - snap back: no DockState call at all.
	}
}

/**
 * After an outer-edge drop (#694 PR-1) re-mounted the docked panes: if the DOM focus was in the
 * host and is now lost (on `<body>` / nothing - the focused element was re-created), hand it to the
 * pane frame it was in (same `data-dock-drop-id`: a pane or a tab group keeps its id when wrapped),
 * else to the moved pane. In the frame: its active tab (roving tabindex) or its body region. A
 * focus that is still somewhere (the element survived, or the host / a hook moved it) is left alone.
 */
function refocus(hostEl: HTMLElement, frameId: string | null, movedId: string): void {
	const active = document.activeElement;
	if (active && active !== document.body) return;
	if (!hostEl.isConnected) return;
	const frames = [...hostEl.querySelectorAll<HTMLElement>('[data-dock-drop-id]')];
	const frame =
		(frameId !== null ? frames.find((el) => el.dataset.dockDropId === frameId) : undefined) ??
		frames.find((el) => el.dataset.dockDropId === movedId);
	const target =
		frame?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]') ??
		frame?.querySelector<HTMLElement>('[role="region"]');
	target?.focus();
}

export function createDragController(
	dock: DockState,
	getHostEl: () => HTMLElement | null,
	getPolicy?: () => DockPolicy | undefined,
	getLifecycle?: () => PanelLifecycle | undefined
): DragController {
	return new DragController(dock, getHostEl, getPolicy, getLifecycle);
}

const DRAG_CONTEXT_KEY = Symbol('banto-dock-drag');

/** Called once by `DockHost` so its descendants (`DockedTree`, `DockWindow`) can reach the same controller instance without prop-drilling through every recursive `DockedTree` level. */
export function setDragController(controller: DragController): void {
	setContext(DRAG_CONTEXT_KEY, controller);
}

/** Must be called during a descendant component's own initialization (top-level `<script>`), per Svelte context rules - not inside an event handler. */
export function getDragController(): DragController {
	const controller = getContext<DragController | undefined>(DRAG_CONTEXT_KEY);
	if (!controller) {
		throw new Error(
			'getDragController() called outside a DockHost tree - no DragController in context.'
		);
	}
	return controller;
}
