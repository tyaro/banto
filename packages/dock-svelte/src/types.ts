/**
 * Public types for @banto/dock-svelte (spec §5). M7 shipped floating pseudo-
 * windows only; M8 Phase A (this file) adds the docked layout tree
 * (spec §5.1: "Panel, Split, TabGroup の再帰的な組み合わせ") as a sibling of
 * `floating` rather than a replacement for it - exactly the forward-compat
 * path the M7 doc comment called out. `version` bumps 1 -> 2 accordingly;
 * `DockState.hydrate` (state.svelte.ts) accepts both shapes, migrating a v1
 * payload to v2 with `docked: null`. z-order is still just array order (last
 * = frontmost) - no numeric z field to keep in sync or serialize.
 *
 * M8 Phase A is the pure data model + tree operations only (core/tree.ts,
 * core/dropzones.ts, and the new DockState methods) - no drag UI, no new
 * .svelte components. Those are Phase B, built on top of this shape.
 */

/** One floating pseudo-window's persisted geometry + open/closed state. */
export interface FloatingWindow {
	/** Panel id, unique within a DockLayout. */
	id: string;
	title: string;
	/** Emoji, shown in the titlebar. */
	icon?: string;
	/** Position in px, relative to the DockHost's top-left. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Closed panels keep their geometry around so reopening restores it. */
	open: boolean;
	/**
	 * Where this pane was docked before it was hidden / closed (#663). Only set
	 * on a CLOSED window that came out of the docked tree; `DockState.show`
	 * puts the pane back there (`core/slot.ts`), `DockState.open` opens it
	 * floating and drops the slot. Optional: a layout without it (older JSON)
	 * reads as "no remembered place", so the layout `version` stays 2.
	 */
	dockSlot?: DockSlot;
	/**
	 * Locked by the user (#663 ②, renamed from `pinned` in #694 PR-3): the window's
	 * position and size are fixed - no title-bar drag, no resize, no keyboard move /
	 * resize. Tabs can still be dragged in and out and the window can be closed or
	 * raised. Optional and written only when `true`: a layout without it (older JSON)
	 * reads as not locked, so the layout `version` stays 2. Lives on the window, so it
	 * is gone when the window docks (a pane pulled out later starts unlocked).
	 */
	locked?: boolean;
	/**
	 * @deprecated Since #694 PR-3 the pin means "auto-hide" (a docked region); the
	 * window's position lock is `locked`. Still READ: `validateDockLayout` turns an
	 * older JSON's `pinned: true` into `locked: true` (and `DockState.isLocked` honours
	 * it on a layout assigned without validation). Never written. Removed in the next major.
	 */
	pinned?: boolean;
	/**
	 * Collapsed by the user (#663 ③-A): the window shows only its title bar. The
	 * saved `height` is untouched (expanding restores it); the body stays mounted
	 * but hidden. Optional and written only when `true`: a layout without it
	 * (older JSON) reads as expanded, so the layout `version` stays 2. Lives on
	 * the window, so it is gone when the window docks (a pane pulled out later
	 * starts expanded); closing and reopening keeps it.
	 */
	collapsed?: boolean;
}

/**
 * A remembered docked place (#663, `core/slot.ts`). Named by ids that survive
 * the pane's removal; `anchors` are panel ids next to it, nearest first, used
 * when the container ids are gone.
 *  - `tab`: a tab of the group `groupId`, at `index`.
 *  - `split`: child `index` of the split `splitId` (`direction`), on `side` of
 *    the node `neighborId`, with `size` (0-1) of the split's space. `anchors`
 *    are the panels on the neighbour's side, `otherAnchors` (optional, #720
 *    review) the ones on the other side, both nearest first; `index` counts
 *    the panes hidden out of the same split before it among the children.
 *  - `root`: the whole docked tree (it was the only docked pane).
 *
 * `outer` (optional, #721) on a `tab` / `split` slot: where the container itself
 * (the tab group / split) was, as a `split` / `root` slot - tried, with the pane
 * placed as a bare pane, when the container and every anchor are gone (all of
 * its panes were taken out). It may have an `outer` of its own (#727): the place
 * of the container around that one, tried next (at most 3 levels). A layout
 * without it (older JSON) works as before, so the layout `version` stays 2.
 */
export type DockSlot =
	| { kind: 'tab'; groupId: string; index: number; anchors: string[]; outer?: DockSlot }
	| {
			kind: 'split';
			splitId: string;
			direction: 'row' | 'column';
			index: number;
			neighborId: string;
			side: 'before' | 'after';
			size: number;
			anchors: string[];
			otherAnchors?: string[];
			outer?: DockSlot;
	  }
	| { kind: 'root' };

/**
 * One row of `DockState.panels` (#663): every pane the layout knows, for a
 * View menu with a checkbox per pane.
 */
export interface DockPanelInfo {
	id: string;
	title: string;
	icon?: string;
	/**
	 * `docked`: in the docked tree, or hidden with a remembered docked place
	 * (`show` tries to put it back there). `floating`: a floating window, open
	 * or closed, with no remembered docked place.
	 */
	placement: 'docked' | 'floating';
	/** In the docked tree (even as a background tab), auto-hidden to an edge band, or an open floating window = the checkbox is checked. */
	visible: boolean;
	/** Auto-hidden to a band on the host's edge (#694 PR-3; `placement` is `docked`). Written only when `true`. */
	autoHidden?: true;
}

/** A single docked panel - the leaf of the docked tree. Same id space as `FloatingWindow`: a panel is either docked or floating, never both at once. */
export interface DockPanelNode {
	type: 'panel';
	/** Panel id, unique within a DockLayout (shared id space with `FloatingWindow.id`). */
	id: string;
	title: string;
	/** Emoji, shown in the tab/titlebar. */
	icon?: string;
	/**
	 * Collapsed to a band by the user (#663 ③-B): a child of a split that shows only
	 * a band (icon, title, expand button). Meaningful only on a direct child of a
	 * `split` that has another open child; anywhere else `DockState` clears it. Written
	 * only when `true` (older JSON reads as expanded, `version` stays 2). Gone when the
	 * pane leaves the docked tree; the split's `sizes` are never touched.
	 */
	collapsed?: boolean;
}

/** A group of panels presented as tabs. Spec §5.1: tab groups only ever hold panels directly - no nested splits inside a tab group in v1. */
export interface DockTabGroupNode {
	type: 'tabs';
	/** Group id - distinct from any panel id, used to target the group itself (e.g. dropping onto its tab bar, or `setActiveTab`/`moveTab`). */
	id: string;
	children: DockPanelNode[];
	/** Index into `children` of the visible tab. */
	activeIndex: number;
	/** Collapsed to a band (#663 ③-B); the band shows the front tab's title. Same rules as `DockPanelNode.collapsed`. */
	collapsed?: boolean;
}

/**
 * A split container: 2+ children laid out side by side (`row`, divided by a
 * vertical divider) or stacked (`column`, horizontal divider). `sizes` are
 * fractional weights (same length as `children`, summing to ~1) - see
 * `core/tree.ts#normalizeSizes` for how drift gets repaired.
 */
export interface DockSplitNode {
	type: 'split';
	id: string;
	direction: 'row' | 'column';
	children: DockNode[];
	sizes: number[];
}

/** Recursive docked-layout node (spec §5.1: "Panel, Split, TabGroup の再帰的な組み合わせ"). */
export type DockNode = DockPanelNode | DockTabGroupNode | DockSplitNode;

/**
 * Which region of a drop target's rect a pointer is over (spec §5.2:
 * "画面端・グループ端にドロップして分割（上下左右スナップ）"). `center` means
 * "add as a tab to the target panel/group"; the 4 edges mean "split the
 * target in that direction". Computed by `core/dropzones.ts#computeDropRegion`
 * and consumed by `core/tree.ts#dockPanelIntoTree` - Phase B renders the
 * corresponding snap-guide overlay from the same value.
 */
export type DropRegion = 'center' | 'left' | 'right' | 'top' | 'bottom';

/**
 * An outer edge of the whole host (#694 PR-1): a drop there wraps the docked
 * root in a new split and the pane spans that side (`core/tree.ts#dockPanelAtEdge`).
 */
export type DockEdge = Exclude<DropRegion, 'center'>;

/**
 * A docked region (a panel, or a tab group) auto-hidden to a band on the host's
 * edge (#694 PR-3, "unpinned" in Visual Studio's words): it is out of the docked
 * tree, its tabs sit in the band, and pressing one slides the pane out over the
 * docked tree. The pin button on the slid-out pane puts the region back at `slot`.
 */
export interface DockAutoHidden {
	/** The region as it was in the tree (never `collapsed`). Its ids share the layout's id space. */
	node: DockPanelNode | DockTabGroupNode;
	/** The band it sits in. */
	edge: DockEdge;
	/** Where it goes back (a `split` / `root` slot of `core/slot.ts`). When that place is gone it docks at `edge` instead. */
	slot: DockSlot;
	/** Size of the slid-out pane along the edge's axis, as a share (0-1] of the docked area. Omitted = `AUTO_HIDE_FLYOUT_RATIO`. */
	size?: number;
}

/** Full serializable dock layout (spec §5.1: "レイアウト全体をJSONにシリアライズ/デシリアライズ可能に"). */
export interface DockLayout {
	/** Bump on breaking changes. v1 (M7) had no `docked` field; `DockState.hydrate` migrates it to `docked: null`. */
	version: 2;
	/** Render order = z-order; last entry is frontmost. */
	floating: FloatingWindow[];
	/** The docked tree, or `null` when nothing is docked (host shows only floating windows). */
	docked: DockNode | null;
	/**
	 * Regions auto-hidden to the host's edge bands (#694 PR-3), in band order.
	 * Optional and written only when not empty: a layout without it (older JSON)
	 * reads as "nothing auto-hidden", so the layout `version` stays 2.
	 */
	autoHidden?: DockAutoHidden[];
}

/** Definition passed to `DockState.ensureWindow` / `reset` for a window that may not exist in the layout yet. */
export interface FloatingWindowDef {
	id: string;
	title: string;
	icon?: string;
	/** Falls back to geometry.ts's DEFAULT_WINDOW_WIDTH/HEIGHT when omitted. */
	width?: number;
	height?: number;
}

/** Resize handle positions (4 edges + 4 corners; spec §5.2 "自由な位置・サイズ変更"). */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Minimal shape passed to the `panel` snippet (M8 Phase B). Both
 * `FloatingWindow` and `DockPanelNode` structurally satisfy this (they carry
 * extra fields the snippet doesn't need), so `DockHost` can share ONE
 * `Snippet<[PanelContent]>` prop between docked panes (`DockedTree`) and
 * floating windows (`DockWindow`) instead of the caller having to branch on
 * which chrome rendered it.
 */
export interface PanelContent {
	id: string;
	title: string;
	icon?: string;
}
