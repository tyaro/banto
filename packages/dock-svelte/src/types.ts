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
	 * Set on a CLOSED window whose pane was hidden from the docked tree or an edge band (#663,
	 * #782): `DockState.show` docks the pane at its default place (`DockState.defaultLayout`,
	 * `core/defaultPlace.ts`) - not where it was hidden from - and `DockState.open` opens it
	 * floating and drops this. The value is the share (`0 <= n <= 1`) it held of its split when it
	 * was hidden, which it takes again (`1` = none to speak of: its default share). The regions in
	 * the edge bands count as there for it (#782 PR8b; the floated panes do not), so it means the
	 * same whether a region beside the pane went to its band before the pane was hidden or after.
	 * A closed window without it opens floating.
	 */
	dockShare?: number;
	/**
	 * Locked by the user (#663 ②, renamed from `pinned` in #694 PR-3): the window's
	 * position and size are fixed - no title-bar drag, no resize, no keyboard move /
	 * resize. Tabs can still be dragged in and out and the window can be closed or
	 * raised. Optional and written only when `true`: a layout without it
	 * reads as not locked. Lives on the window, so it
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
	 * reads as expanded. Lives on
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
 *    the node `neighborId`, with `size` (0-1) of the split's space when it
 *    was taken. `share` (optional, #733, in (0, 1]): its share of the whole
 *    split, the panes hidden out of it then counted - put back while some of
 *    those are still out, it leaves their shares for them, so the split's
 *    sizes come back whatever order its panes are shown in. A slot without it
 *    (taken before #733, or beside one that was) comes back by `size` as
 *    before; a release before it reads `size` and ignores `share`. `anchors`
 *    are the panels on the neighbour's side, `otherAnchors` (optional, #720
 *    review) the ones on the other side, both nearest first; `index` counts
 *    the panes hidden out of the same split before it among the children.
 *  - `root`: the whole docked tree (it was the only docked pane).
 *
 * `outer` (optional, #721) on a `tab` / `split` slot: where the container itself
 * (the tab group / split) was, as a `split` / `root` slot - tried, with the pane
 * placed as a bare pane, when the container and every anchor are gone (all of
 * its panes were taken out). It may have an `outer` of its own (#727): the place
 * of the container around that one, tried next (the slot and its `outer` chain at
 * most `MAX_SLOT_DEPTH` (8) deep).
 *
 * No layout holds a slot since #782 PR8b (a closed window's went in PR5, an edge
 * band's here): it is the name `DockState.homeSlot` hands out for a floated pane's
 * place, and what `core/slot.ts` works on. Removed with those in #782 PR8c.
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
			share?: number;
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
	/** In the docked tree (even as a background tab), auto-hidden to an edge band, or an open floating window = the checkbox is checked (not "closed"; see `onScreen`). */
	visible: boolean;
	/**
	 * Really on screen (#792): the front tab of an uncollapsed docked region, an open floating
	 * window not collapsed to its title bar, or the auto-hidden pane slid out now. False for the
	 * rest of `visible` (collapsed region, background tab, auto-hidden and not slid out).
	 */
	onScreen: boolean;
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
	 * only when `true` (a layout without it reads as expanded). Gone when the
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
 * Why `DockHost`'s `onLayoutCommit` reports a layout (#791): `'user'` = a change that settled and
 * is neither a restore nor a reset (a gesture's end, a button of the dock UI, a method of the host,
 * the app's own `DockState` call); `'reset'` = a `replaceLayout` that said so (`commit: 'reset'`),
 * so the app may delete what it saved instead of saving the default.
 */
export type DockLayoutCommitReason = 'user' | 'reset';

/**
 * A docked region (a panel, or a tab group) auto-hidden to a band on the host's
 * edge (#694 PR-3, "unpinned" in Visual Studio's words): it is out of the docked
 * tree, its tabs sit in the band, and pressing one slides the pane out over the
 * docked tree. The pin button on the slid-out pane puts the region back where it
 * was: its place is kept in `DockLayout.dockedWithAutoHidden` (#782 PR8b; a slot
 * of its own until then).
 */
export interface DockAutoHidden {
	/** The region as it was in the tree (never `collapsed`). Its ids share the layout's id space. */
	node: DockPanelNode | DockTabGroupNode;
	/** The band it sits in. Where it docks when its place is gone and it has no default place. */
	edge: DockEdge;
	/** Size of the slid-out pane along the edge's axis, as a share (0-1] of the docked area. Omitted = `AUTO_HIDE_FLYOUT_RATIO`. */
	size?: number;
}

/**
 * A leaf of the shadow tree (`core/shadow.ts`, #782): a docked pane, or - with `away` - the place
 * of a pane that is out of the docked tree (a tombstone). `band` (#782 PR8b, only with `away`):
 * the pane is in an edge band (`DockLayout.autoHidden`), not a floating window.
 */
export interface ShadowPanelNode extends DockPanelNode {
	/** Written only when `true`. A tombstone is never `collapsed`. */
	away?: true;
	/** Written only when `true`, and only with `away`. */
	band?: true;
}

/** A tab group of the shadow tree. `activeIndex` counts every child and points at a shown one whenever one shows. */
export interface ShadowTabGroupNode extends Omit<DockTabGroupNode, 'children'> {
	children: ShadowPanelNode[];
}

/** A split of the shadow tree. `sizes` has one share per child (tombstones included) and adds up to 1. */
export interface ShadowSplitNode extends Omit<DockSplitNode, 'children'> {
	children: ShadowNode[];
}

/** A node of the shadow tree. A `DockNode` is a `ShadowNode` with no tombstone in it. */
export type ShadowNode = ShadowPanelNode | ShadowTabGroupNode | ShadowSplitNode;

/** Full serializable dock layout (spec §5.1: "レイアウト全体をJSONにシリアライズ/デシリアライズ可能に"). */
export interface DockLayout {
	/**
	 * The one version read and written (#782 PR8b): a layout of an earlier version (1 - 3) is not
	 * read - `validateDockLayout` refuses it, `DockState.hydrate` returns `false`, and the app shows
	 * its default layout. `DockState` writes 4 on every assignment.
	 */
	version: 4;
	/** Render order = z-order; last entry is frontmost. */
	floating: FloatingWindow[];
	/** The docked tree, or `null` when nothing is docked (host shows only floating windows). */
	docked: DockNode | null;
	/**
	 * Regions auto-hidden to the host's edge bands (#694 PR-3), in band order.
	 * Optional and written only when not empty.
	 */
	autoHidden?: DockAutoHidden[];
	/**
	 * Where the regions of `autoHidden` go back (#782 PR8b): the docked tree with the panes of
	 * those regions at their places, each a leaf marked `away` and `band` - a tab group with the
	 * group itself and its id -, and every split with a share for them too. So a region comes back
	 * into the split / tab group it left, at the share it held there, whatever was moved, shown or
	 * hidden meanwhile. Without its marked leaves it is `docked` (the same shape and ids).
	 *
	 * Written by `DockState` on every assignment, only while a region in a band has a place; never
	 * build or edit it. A layout whose tree does not show `docked` (say `docked` was edited by
	 * hand) is read without it: a region then docks at its default place (`DockState.defaultLayout`),
	 * else along its `edge`. The places of floating windows are not saved.
	 */
	dockedWithAutoHidden?: ShadowNode;
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
