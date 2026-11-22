/**
 * Public entry point for @banto/dock-svelte (spec §5).
 * M7 shipped floating pseudo-windows only (draggable/resizable, focus/
 * z-order, open/close, JSON layout serialize/restore) inside a host
 * container - no Tauri native windows (spec §5.3, still future work).
 * M8 Phase A adds the docked layout tree's pure data model + operations
 * (`core/tree.ts`, `core/dropzones.ts`) and the matching `DockState`
 * methods, as a sibling of `floating` (no breaking format change - see
 * `types.ts`). Phase B builds the drag-and-drop/snap-guide/tab-bar UI on top
 * of this; no new .svelte components ship in Phase A.
 */
export { default as DockHost } from './DockHost.svelte';
/**
 * Whether a node is inside a `persistent` pane the dock is re-arranging right now (#763): tells
 * the `blur` of a re-arrangement (browsers without `Element.moveBefore()`) from the user leaving.
 */
export { isDockRearranging } from './core/persistent';
/** Gesture hook types of `DockHost` (`canStartGesture` / `onGestureEnd`; #433-b, shared-primitives-upstream-plan §3.3). */
export type {
	GestureCancelReason as DockCancelReason,
	GestureKind as DockGestureKind
} from './core/gesture.svelte';
/**
 * Pane lifecycle types of `DockHost` (`beforePanelChange` / `hidePanel` /
 * `closePanel`; #432, shared-primitives-upstream-plan §3.5 / §4.2 / D3-c / D4).
 * `structureKey` is the structure an async answer is checked against;
 * `DockState.structureRevision` counts its changes (a structure that came back
 * to the same shape still makes the answer stale).
 */
export { structureKey, type DockPanelChange, type DockPanelChangeOutcome } from './core/lifecycle';
export { DockState, createDockState } from './state.svelte';
/**
 * The three-pane screen on a dock (#663 ④, three-pane-dock-plan §4.1 / §4.4 / §4.8 / §4.9):
 * `ThreePaneDock` and its pure half (the default layout, reconciling a saved layout, the saved
 * value, the View menu items' shape).
 */
export { default as ThreePaneDock, type ThreePaneExtraPanel } from './ThreePaneDock.svelte';
export {
	assertExtraPanelIds,
	defaultThreePaneDockMessages,
	reconcileThreePaneLayout,
	THREE_PANE_DEFAULTS,
	THREE_PANE_IDS,
	threePaneDockLayout,
	threePaneSavedLayout,
	THREE_PANE_NARROW_BREAKPOINT,
	threePaneNarrowLayout,
	isThreePaneNarrow,
	type ThreePaneNarrowLayoutOptions,
	type ThreePaneDockLayoutOptions,
	type ThreePaneDockMessages,
	type ThreePaneExtraPanelDef,
	type ThreePaneLayoutCommitReason,
	type ThreePanePaneDef,
	type ThreePanePanels,
	type ThreePaneRestoreStatus,
	type ThreePaneSavedLayout,
	type ThreePaneViewMenuItem,
	type ThreePaneViewMenuLabels
} from './threePane';
export { defaultDockMessages, type DockMessages } from './messages';
/**
 * `DockHost.movePanel(panelId, target)` (#663 ④): re-dock a pane without a drag, through the
 * drag's own drop path (the "panel actions" menu uses it too).
 */
export type { DockMoveOutcome, DockMoveTarget } from './core/move.svelte';

export {
	applyDrag,
	applyResize,
	bringToFront,
	cascadePosition,
	clampWindowToHost,
	displayWindowGeometry,
	DEFAULT_MIN_HEIGHT,
	DEFAULT_MIN_VISIBLE,
	DEFAULT_MIN_WIDTH,
	DEFAULT_WINDOW_HEIGHT,
	DEFAULT_WINDOW_WIDTH,
	type ClampOptions
} from './core/geometry';

export {
	canCollapseRegion,
	collapse,
	collectPanelIds,
	defaultMakeId,
	dockPanelAtEdge,
	dockPanelIntoTree,
	EDGE_DOCK_RATIO,
	expandRegionOf,
	findNode,
	findParent,
	isRegionCollapsed,
	MIN_PANE_FRACTION,
	moveTabWithinGroup,
	normalizeCollapsed,
	normalizeSizes,
	removePanel,
	resizeSplit,
	setActiveTab,
	setRegionCollapsed,
	splitInsert
} from './core/tree';

export {
	validateDockLayout,
	type DockLayoutIssue,
	type DockLayoutIssueCode,
	type DockLayoutValidation
} from './core/validate';

/** The cross guide on a docked pane (#694 PR-2; `computeDropRegion` is the pre-PR-2 band rule, kept for compatibility). */
export {
	computeDropRegion,
	crossButtons,
	GUIDE_BUTTON_GAP,
	GUIDE_BUTTON_MIN,
	GUIDE_BUTTON_SIZE,
	GUIDE_INSET,
	guideButtonSize,
	hitGuideButton,
	type CrossOptions,
	type GuideButton,
	type GuideSizing,
	readGuideSizing
} from './core/dropzones';

/** Outer-edge drop targets of the whole host (#694 PR-1, buttons since PR-2). */
export { computeEdgeDrop, edgeButtons } from './core/edges';

/** The remembered docked place of a hidden pane (#663; `DockState.dismiss` / `show` use these), and of a whole region (#694 PR-3, auto-hide). */
export {
	captureDockSlot,
	captureRegionSlot,
	restoreDockSlot,
	restoreRegionSlot
} from './core/slot';

/** Auto-hide of a docked region to an edge band (#694 PR-3; `DockState.autoHideRegion` / `restoreAutoHidden` use these). */
export {
	AUTO_HIDE_FLYOUT_RATIO,
	autoHideEdge,
	mainRegionId,
	regionOf,
	removeRegion,
	type AutoHideOptions,
	type DockRegion
} from './core/autohide';

export { type DockCapabilities } from './core/policy';

export type {
	DockAutoHidden,
	DockEdge,
	DockLayoutCommitReason,
	DockLayout,
	DockNode,
	DockPanelInfo,
	DockPanelNode,
	DockSlot,
	DockSplitNode,
	DockTabGroupNode,
	DropRegion,
	FloatingWindow,
	FloatingWindowDef,
	PanelContent,
	ResizeEdge
} from './types';
