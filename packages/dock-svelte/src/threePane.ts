/**
 * The three-pane screen on a dock (#663 ④, docs/design/three-pane-dock-plan.md §4.1 / §4.4 /
 * §4.7 / §4.9): the pure half of `ThreePaneDock.svelte` - its default layout, the reconciling of a
 * saved layout with today's panes, the saved value's shape and the strings the component adds to
 * `DockMessages`. No runes, no DOM.
 *
 * The panes are `left` (pick the target), `center` (work on it: the main region, never closed,
 * collapsed, auto-hidden or floated) and `right` (the selected row's details), plus the app's own
 * extra panels (`ThreePaneExtraPanel`, plan §4.9), whose ids must not be one of the three.
 */
import { autoHiddenPanelIds, autoHideRegionInLayout } from './core/autohide';
import { cascadePosition, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH } from './core/geometry';
import { dockShareOf } from './core/defaultPlace';
import {
	collectPanelIds,
	dockPanelAtEdge,
	expandRegionOf,
	findNode,
	findParent,
	isRegionCollapsed,
	MIN_PANE_FRACTION,
	normalizeSizes,
	removePanel
} from './core/tree';
import { validateDockLayout, withLayoutVersion } from './core/validate';
import type { DockMessages } from './messages';
import type {
	DockAutoHidden,
	DockEdge,
	DockLayout,
	DockNode,
	DockPanelNode,
	DockSplitNode,
	DockTabGroupNode,
	FloatingWindow
} from './types';

/** The ids of the three panes (fixed: a saved layout names them). */
export const THREE_PANE_IDS = { left: 'left', center: 'center', right: 'right' } as const;

/** Defaults shared with `@banto/ui`'s `ThreePaneLayout` (plan §6-4: same widths). */
export const THREE_PANE_DEFAULTS = {
	leftWidth: 280,
	rightWidth: 360,
	/** The centre keeps at least this many px of the default layout (the sides shrink first). */
	centerMinWidth: 320,
	/**
	 * `sideWidthUnit: 'px'` (#892): a side shrunk to leave the centre its `centerMinWidth` keeps at
	 * least this many px (or its own width, when that is smaller).
	 */
	sideMinWidth: 120,
	/** Used when the host is not measured yet (hidden, jsdom). */
	hostWidth: 1280,
	hostHeight: 720
} as const;

/** One of the three panes, as the layout names it. */
export interface ThreePanePaneDef {
	title: string;
	icon?: string;
}

/**
 * A pane besides the three (plan §4.9, e.g. a log). Placed by `initial` the first time (no saved
 * layout, or a saved layout that does not know it yet); after that the saved layout decides.
 */
export interface ThreePaneExtraPanelDef {
	/** Unique, and not `left` / `center` / `right`. */
	id: string;
	title: string;
	icon?: string;
	/** `hidden` (default): a closed floating window (the View menu opens it). `floating`: an open one. `{ edge }`: docked along that outer edge. */
	initial?: 'hidden' | 'floating' | { edge: DockEdge };
	/** Floating window size in px (default 360 x 280). */
	width?: number;
	height?: number;
}

/** The panes a layout is made of. A missing `left` / `right` = no such pane (no snippet). */
export interface ThreePanePanels {
	left?: ThreePanePaneDef | null;
	center: ThreePanePaneDef;
	right?: ThreePanePaneDef | null;
	extra?: readonly ThreePaneExtraPanelDef[];
}

export interface ThreePaneDockLayoutOptions {
	/** The host's width in px; `<= 0` (not measured yet) = `THREE_PANE_DEFAULTS.hostWidth`. */
	hostWidth: number;
	/** Used to place floating extra panels; `<= 0` or omitted = `THREE_PANE_DEFAULTS.hostHeight`. */
	hostHeight?: number;
	/** Default-layout width of the left pane in px (turned into a share of `hostWidth`). Default 280. */
	leftWidth?: number;
	/** Default-layout width of the right pane in px. Default 360. */
	rightWidth?: number;
	panels: ThreePanePanels;
	/** `false` = the default layout has the left pane hidden (it comes back to its docked place). Default `true`. */
	leftOpen?: boolean;
	/** Same for the right pane. Default `true`. */
	rightOpen?: boolean;
}

/** Id of the default layout's root split (deterministic: a reset compares equal to a fresh default). */
const ROOT_ID = 'three-pane:root';

function paneNode(id: string, def: ThreePanePaneDef): DockPanelNode {
	return {
		type: 'panel',
		id,
		title: def.title,
		...(def.icon !== undefined ? { icon: def.icon } : {})
	};
}

/**
 * Throws when an extra panel's id is one of the three panes' or appears twice (plan §4.9: a
 * development-time error, the app's mistake).
 */
export function assertExtraPanelIds(extra: readonly ThreePaneExtraPanelDef[] = []): void {
	const reserved = new Set<string>(Object.values(THREE_PANE_IDS));
	const seen = new Set<string>();
	for (const p of extra) {
		if (reserved.has(p.id))
			throw new Error(
				`ThreePaneDock: the extra panel id "${p.id}" is reserved for the three panes (left / center / right)`
			);
		if (seen.has(p.id))
			throw new Error(`ThreePaneDock: the extra panel id "${p.id}" is used twice`);
		seen.add(p.id);
	}
}

/** The shares (0-1) of the default row for the sides that exist: the centre keeps `centerMinWidth`. */
function sideShares(
	width: number,
	left: number | null,
	right: number | null
): { left: number; right: number } {
	const l = Math.max(0, left ?? 0);
	const r = Math.max(0, right ?? 0);
	const room = Math.max(0, width - THREE_PANE_DEFAULTS.centerMinWidth);
	const scale = l + r > room && l + r > 0 ? room / (l + r) : 1;
	return { left: (l * scale) / width, right: (r * scale) / width };
}

/** A floating window for an extra panel (open or closed), cascaded by `index`. */
function extraWindow(
	def: ThreePaneExtraPanelDef,
	index: number,
	hostW: number,
	hostH: number,
	open: boolean
): FloatingWindow {
	const width = def.width ?? DEFAULT_WINDOW_WIDTH;
	const height = def.height ?? DEFAULT_WINDOW_HEIGHT;
	const { x, y } = cascadePosition(index, hostW, hostH, width, height);
	return {
		id: def.id,
		title: def.title,
		...(def.icon !== undefined ? { icon: def.icon } : {}),
		x,
		y,
		width,
		height,
		open
	};
}

/** A docked pane taken out as a closed window hidden from the dock (`DockState.dismiss`'s shape). */
function hiddenWindow(root: DockNode | null, node: DockPanelNode, index: number): FloatingWindow {
	return {
		id: node.id,
		title: node.title,
		...(node.icon !== undefined ? { icon: node.icon } : {}),
		x: index * 24,
		y: index * 24,
		width: DEFAULT_WINDOW_WIDTH,
		height: DEFAULT_WINDOW_HEIGHT,
		open: false,
		dockShare: dockShareOf(root, node.id)
	};
}

/**
 * The default layout (plan §4.1, §6-4): left | centre | right in a row, the sides at
 * `leftWidth` / `rightWidth` px of `hostWidth` as shares (shrunk so the centre keeps
 * `centerMinWidth`), a side with `*Open: false` hidden (shown, it docks at its default place), and the extra
 * panels by their `initial`. Throws for a reserved / duplicated extra id. `resetLayout` and a
 * saved layout that cannot be repaired use it.
 */
export function threePaneDockLayout(options: ThreePaneDockLayoutOptions): DockLayout {
	const { panels } = options;
	assertExtraPanelIds(panels.extra);
	const width = options.hostWidth > 0 ? options.hostWidth : THREE_PANE_DEFAULTS.hostWidth;
	const height =
		options.hostHeight !== undefined && options.hostHeight > 0
			? options.hostHeight
			: THREE_PANE_DEFAULTS.hostHeight;
	const left = panels.left ? paneNode(THREE_PANE_IDS.left, panels.left) : null;
	const right = panels.right ? paneNode(THREE_PANE_IDS.right, panels.right) : null;
	const center = paneNode(THREE_PANE_IDS.center, panels.center);
	const shares = sideShares(
		width,
		left ? (options.leftWidth ?? THREE_PANE_DEFAULTS.leftWidth) : null,
		right ? (options.rightWidth ?? THREE_PANE_DEFAULTS.rightWidth) : null
	);
	const children: DockNode[] = [];
	const sizes: number[] = [];
	if (left) {
		children.push(left);
		sizes.push(shares.left);
	}
	children.push(center);
	sizes.push(1 - shares.left - shares.right);
	if (right) {
		children.push(right);
		sizes.push(shares.right);
	}
	let docked: DockNode =
		children.length === 1
			? center
			: normalizeSizes({ type: 'split', id: ROOT_ID, direction: 'row', children, sizes });

	const floating: FloatingWindow[] = [];
	for (const [node, open] of [
		[left, options.leftOpen ?? true],
		[right, options.rightOpen ?? true]
	] as const) {
		if (!node || open) continue;
		floating.push(hiddenWindow(docked, node, floating.length));
		docked = removePanel(docked, node.id) ?? center;
	}

	for (const def of panels.extra ?? []) {
		const initial = def.initial ?? 'hidden';
		if (typeof initial === 'object') {
			docked = dockPanelAtEdge(
				docked,
				paneNode(def.id, def),
				initial.edge,
				() => `three-pane:edge:${def.id}`
			);
		} else {
			floating.push(extraWindow(def, floating.length, width, height, initial === 'floating'));
		}
	}
	return { version: 4, floating, docked };
}

/** What a saved three-pane layout is stored as (plan §4.4). `layout` is `DockState`'s layout object. */
export interface ThreePaneSavedLayout {
	schema: 1;
	/** The panes the layout was saved with (the three and the extra ones). */
	panels: string[];
	layout: DockLayout;
}

/**
 * Why `ThreePaneDock`'s `onLayoutCommit` reports a value to save (#791): `DockHost`'s reasons
 * (`'user'`, `'reset'` = `resetLayout`), and `'narrow-switch'` = the value changed when the narrow
 * / wide display was switched (e.g. the default measured again at the width it came back at).
 */
export type ThreePaneLayoutCommitReason = 'user' | 'reset' | 'narrow-switch';

/** The value to save for `layout` (plan §4.4). */
export function threePaneSavedLayout(layout: DockLayout): ThreePaneSavedLayout {
	const ids = new Set<string>(collectPanelIds(layout.docked));
	for (const entry of layout.autoHidden ?? [])
		for (const id of entry.node.type === 'tabs'
			? entry.node.children.map((c) => c.id)
			: [entry.node.id])
			ids.add(id);
	for (const w of layout.floating) ids.add(w.id);
	return { schema: 1, panels: [...ids], layout: withLayoutVersion(layout) };
}

/**
 * How `reconcileThreePaneLayout` used the saved value: `restored` as it was, `repaired` (unknown
 * panes dropped, missing ones added, the centre put back on screen, titles refreshed don't count),
 * or `default` (nothing usable: not a layout, invalid, or the centre is not in the docked tree).
 */
export type ThreePaneRestoreStatus = 'restored' | 'repaired' | 'default';

/** Unwrap a saved value: a `ThreePaneSavedLayout`, a bare `DockLayout`, or either as JSON text. */
function unwrap(saved: unknown): unknown {
	let value = saved;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (typeof value === 'object' && value !== null && 'schema' in value) {
		const wrapped = value as { schema?: unknown; layout?: unknown };
		if (wrapped.schema !== 1) return undefined;
		return typeof wrapped.layout === 'string' ? unwrap(wrapped.layout) : wrapped.layout;
	}
	return value;
}

function retitle(node: DockNode, defs: Map<string, ThreePanePaneDef>): DockNode {
	if (node.type === 'panel') {
		const def = defs.get(node.id);
		if (!def) return node;
		const next: DockPanelNode = { ...node, title: def.title };
		if (def.icon !== undefined) next.icon = def.icon;
		else delete next.icon;
		return next;
	}
	if (node.type === 'tabs')
		return { ...node, children: node.children.map((c) => retitle(c, defs) as DockPanelNode) };
	return { ...node, children: node.children.map((c) => retitle(c, defs)) };
}

/** An auto-hidden region without the unknown panes; `null` = nothing left. */
function pruneAutoHidden(
	entry: DockAutoHidden,
	known: (id: string) => boolean
): DockAutoHidden | null {
	const node = entry.node;
	if (node.type === 'panel') return known(node.id) ? entry : null;
	const children = node.children.filter((c) => known(c.id));
	if (children.length === node.children.length) return entry;
	if (children.length === 0) return null;
	if (children.length === 1) return { ...entry, node: children[0] };
	const active = node.children[node.activeIndex]?.id;
	const activeIndex = Math.max(
		0,
		children.findIndex((c) => c.id === active)
	);
	return { ...entry, node: { ...node, children, activeIndex } };
}

/** A unique node id in `root` starting from `base`. */
function freshId(root: DockNode | null, base: string): string {
	let id = base;
	for (let n = 2; findNode(root, id); n++) id = `${base}:${n}`;
	return id;
}

/** Dock `node` on the `side` of the whole tree with `share` of the row (the default place of a side pane). */
function dockAtSide(
	root: DockNode,
	node: DockPanelNode,
	side: 'left' | 'right',
	share: number
): DockNode {
	const s = Math.min(Math.max(share, 0.05), 0.5);
	if (root.type === 'split' && root.direction === 'row') {
		const rest = root.sizes.map((v) => v * (1 - s));
		const children = side === 'left' ? [node, ...root.children] : [...root.children, node];
		const sizes = side === 'left' ? [s, ...rest] : [...rest, s];
		return normalizeSizes({ ...root, children, sizes });
	}
	return normalizeSizes({
		type: 'split',
		id: freshId(root, `three-pane:${side}`),
		direction: 'row',
		children: side === 'left' ? [node, root] : [root, node],
		sizes: side === 'left' ? [s, 1 - s] : [1 - s, s]
	});
}

/**
 * Make a saved layout fit today's panes (plan §4.4, §4.7): checked by `validateDockLayout`; panes
 * it does not know (anywhere: docked, auto-hidden, floating) are dropped; titles and icons are
 * today's; a missing side pane is docked at its default side, a missing extra panel added as a
 * closed floating window; the centre is put back on screen when it is collapsed or a background
 * tab. A value that is not a usable layout, or whose centre is not in the docked tree (floating,
 * closed, auto-hidden, missing - the UI never allows those), gives the default layout. Never
 * throws for a bad saved value (only for a reserved / duplicated extra id, like the default).
 *
 * A hidden pane (a closed window with `dockShare`) remembers no place (#782 PR5), so dropping one
 * changes nothing for the others. Also what `ThreePaneDock` fits today's layout with (`syncPanels`),
 * assigned back with `dock.layout = ...`: the shadow tree follows that assignment (#782 PR7).
 */
export function reconcileThreePaneLayout(
	saved: unknown,
	options: ThreePaneDockLayoutOptions
): { layout: DockLayout; status: ThreePaneRestoreStatus } {
	return reconcile(saved, options);
}

/**
 * The default places of today's panes, for `DockState.defaultLayout` (#782 PR5; not exported from
 * the package): the default layout with both sides docked - a side that starts hidden
 * (`*Open: false`) still belongs beside the centre. An extra panel that starts `hidden` /
 * `floating` has no docked place (shown again after it was docked and hidden, it opens floating).
 */
export function threePaneDefaultPlaces(options: ThreePaneDockLayoutOptions): DockLayout {
	return threePaneDockLayout({ ...options, leftOpen: true, rightOpen: true });
}

function reconcile(
	saved: unknown,
	options: ThreePaneDockLayoutOptions
): { layout: DockLayout; status: ThreePaneRestoreStatus } {
	const fallback = () => ({ layout: threePaneDockLayout(options), status: 'default' as const });
	const { panels } = options;
	assertExtraPanelIds(panels.extra);
	const raw = unwrap(saved);
	if (raw === undefined || raw === null) return fallback();
	const checked = validateDockLayout(raw);
	if (!checked.ok) return fallback();

	const defs = new Map<string, ThreePanePaneDef>();
	if (panels.left) defs.set(THREE_PANE_IDS.left, panels.left);
	defs.set(THREE_PANE_IDS.center, panels.center);
	if (panels.right) defs.set(THREE_PANE_IDS.right, panels.right);
	for (const p of panels.extra ?? []) defs.set(p.id, p);
	const known = (id: string) => defs.has(id);

	let changed = false;
	let layout = checked.layout;

	// Unknown panes out.
	let docked = layout.docked;
	for (const id of collectPanelIds(docked)) {
		if (!known(id)) {
			docked = removePanel(docked, id);
			changed = true;
		}
	}
	const floating = layout.floating.filter((w) => known(w.id));
	if (floating.length !== layout.floating.length) changed = true;
	const autoHidden: DockAutoHidden[] = [];
	for (const entry of layout.autoHidden ?? []) {
		const kept = pruneAutoHidden(entry, known);
		if (kept !== entry) changed = true;
		if (kept) autoHidden.push(kept);
	}

	// The centre must be docked; on screen is repaired below.
	if (findNode(docked, THREE_PANE_IDS.center)?.type !== 'panel') return fallback();
	const centreGroup = findParent(docked, THREE_PANE_IDS.center);
	if (centreGroup?.type === 'tabs') {
		// A tab group would let a click on another tab hide the centre (`dropCenter: false` only
		// stops new merges): the centre leaves the group and is split in beside it (PR #723 review).
		docked = centreOutOfTabs(docked!, centreGroup);
		changed = true;
	}
	const expanded = expandRegionOf(docked, THREE_PANE_IDS.center);
	if (expanded !== docked) {
		docked = expanded;
		changed = true;
	}

	// Titles / icons are today's (a locale change renames the panes).
	docked = docked ? retitle(docked, defs) : docked;
	const titled = (w: FloatingWindow): FloatingWindow => {
		const def = defs.get(w.id)!;
		const next: FloatingWindow = { ...w, title: def.title };
		if (def.icon !== undefined) next.icon = def.icon;
		else delete next.icon;
		return next;
	};
	const floatingTitled = floating.map(titled);
	const autoHiddenTitled = autoHidden.map((e) => ({
		...e,
		node: retitle(e.node, defs) as DockAutoHidden['node']
	}));

	// Missing panes in.
	const present = new Set<string>([
		...collectPanelIds(docked),
		...floatingTitled.map((w) => w.id),
		...autoHiddenTitled.flatMap((e) =>
			e.node.type === 'tabs' ? e.node.children.map((c) => c.id) : [e.node.id]
		)
	]);
	const width = options.hostWidth > 0 ? options.hostWidth : THREE_PANE_DEFAULTS.hostWidth;
	const height =
		options.hostHeight !== undefined && options.hostHeight > 0
			? options.hostHeight
			: THREE_PANE_DEFAULTS.hostHeight;
	const shares = sideShares(
		width,
		options.leftWidth ?? THREE_PANE_DEFAULTS.leftWidth,
		options.rightWidth ?? THREE_PANE_DEFAULTS.rightWidth
	);
	for (const side of ['left', 'right'] as const) {
		const def = panels[side];
		if (!def || present.has(side)) continue;
		docked = dockAtSide(docked!, paneNode(side, def), side, shares[side]);
		changed = true;
	}
	for (const def of panels.extra ?? []) {
		if (present.has(def.id)) continue;
		floatingTitled.push(extraWindow(def, floatingTitled.length, width, height, false));
		changed = true;
	}

	// The places of the regions in the edge bands go with the layout as they were saved
	// (`dockedWithAutoHidden`, #782 PR8b): `validateDockLayout` keeps the tree while it still shows
	// the docked tree - not when a pane was dropped from or added to it above (the regions then
	// dock at their default place).
	const places = checked.layout.dockedWithAutoHidden;
	layout = withLayoutVersion({
		version: 4,
		floating: floatingTitled,
		docked,
		...(autoHiddenTitled.length > 0 ? { autoHidden: autoHiddenTitled } : {}),
		...(autoHiddenTitled.length > 0 && places !== undefined ? { dockedWithAutoHidden: places } : {})
	});
	// The result went through the same checks as any restored layout.
	const final = validateDockLayout(layout);
	if (!final.ok) return fallback();
	return { layout: final.layout, status: changed ? 'repaired' : 'restored' };
}

/**
 * Take the centre out of the tab group `group` and put it beside what is left of the group, in a
 * new row split that keeps the group's place and share (the centre after a group holding the left
 * pane, before any other). The centre's tab never stays behind another one.
 */
function centreOutOfTabs(root: DockNode, group: DockTabGroupNode): DockNode {
	const centre = group.children.find((c) => c.id === THREE_PANE_IDS.center)!;
	const sibling = group.children.find((c) => c.id !== THREE_PANE_IDS.center);
	if (!sibling) {
		// A group of the centre alone (valid on its own): the centre takes the group's place.
		const alone: DockPanelNode = { ...centre };
		delete alone.collapsed;
		return replaceById(root, group.id, alone);
	}
	const rest = removePanel(root, THREE_PANE_IDS.center)!;
	// Two tabs leave a bare panel (the group's id is gone), more keep the group.
	const remaining = findNode(rest, group.id) ?? findNode(rest, sibling.id)!;
	const after = group.children.some((c) => c.id === THREE_PANE_IDS.left);
	const pane: DockPanelNode = { ...centre };
	delete pane.collapsed;
	return replaceById(rest, remaining.id, {
		type: 'split',
		id: freshId(rest, 'three-pane:center'),
		direction: 'row',
		children: after ? [remaining, pane] : [pane, remaining],
		sizes: after ? [0.4, 0.6] : [0.6, 0.4]
	});
}

function replaceById(root: DockNode, id: string, next: DockNode): DockNode {
	if (root.id === id) return next;
	if (root.type !== 'split') return root;
	return { ...root, children: root.children.map((c) => replaceById(c, id, next)) };
}

/** Narrow at this component width or below (plan §4.5; `@banto/ui`'s `ThreePaneLayout` default). */
export const THREE_PANE_NARROW_BREAKPOINT = 900;

/** Is `width` (`null` = not measured yet) narrow for `breakpoint`? Same rule as `ThreePaneLayout`. */
export function isThreePaneNarrow(width: number | null, breakpoint: number): boolean {
	return width !== null && width > 0 && width <= breakpoint;
}

/** Is the pane on screen in `layout`: docked, auto-hidden, or an open floating window? */
export function isPaneShown(layout: DockLayout, id: string): boolean {
	return (
		findNode(layout.docked, id)?.type === 'panel' ||
		autoHiddenPanelIds(layout).includes(id) ||
		layout.floating.some((w) => w.id === id && w.open)
	);
}

// --- `sideWidthUnit: 'px'` (#892): the sides keep their px when the width changes ---
//
// The saved value is unchanged (version 4, shares): the px are read off the shares at the width
// they are shown at and kept beside the layout, never in it. A px is the width the region is drawn
// at: the docked tree hands the open regions of a row what the edge bands of auto-hidden regions
// (left / right), the dividers and the bands of collapsed regions leave, in proportion to their
// shares (`DockedTree`'s flex), so the shares are worked out on that room (`ThreePaneRowFrame`).

/**
 * How `ThreePaneDock` keeps the widths of the sides when its width changes. `'share'` (default):
 * every region keeps its share, the sides grow and shrink with the component. `'px'`: the regions
 * of the centre's row (the outermost row on the way to it) beside its own keep their px, the centre's region takes the
 * rest (`fitThreePaneSideWidths`).
 */
export type ThreePaneSideWidthUnit = 'share' | 'px';

/**
 * What the docked tree takes off a row's width besides its regions, in px (measured by
 * `ThreePaneDock`; all 0 = the shares of the whole width, as in jsdom).
 */
export interface ThreePaneRowFrame {
	/** A collapsed region's band, and an auto-hide band on the left / right edge (`--banto-dock-titlebar-height`). */
	band: number;
	/** A divider between two regions of a row (`DockedTree`'s `.divider.row`). */
	divider: number;
}

const NO_FRAME: ThreePaneRowFrame = { band: 0, divider: 0 };

/**
 * The outermost row split on the way from the root to the centre - the root, or one under columns
 * only (an extra panel docked along the bottom edge), so it spans the component's width - and the
 * index of its child holding the centre. `null`: no such row (the centre alone, under columns only).
 */
function centreRow(layout: DockLayout): { row: DockSplitNode; centre: number } | null {
	let node = layout.docked;
	while (node?.type === 'split') {
		const centre = node.children.findIndex((c) =>
			collectPanelIds(c).includes(THREE_PANE_IDS.center)
		);
		if (centre < 0) return null;
		if (node.direction === 'row') return { row: node, centre };
		node = node.children[centre];
	}
	return null;
}

/**
 * The room of the centre's row at `width` (the docked area's): `all`, what its regions would share
 * with none collapsed (the width less the left / right edge bands and the dividers), and `open`,
 * what the open regions share (less the collapsed regions' bands too).
 */
function rowRoom(
	layout: DockLayout,
	row: DockSplitNode,
	width: number,
	frame: ThreePaneRowFrame
): { all: number; open: number } {
	const edges = new Set((layout.autoHidden ?? []).map((e) => e.edge));
	const edgeBands = (edges.has('left') ? 1 : 0) + (edges.has('right') ? 1 : 0);
	const all = width - frame.band * edgeBands - frame.divider * (row.children.length - 1);
	const collapsed = row.children.filter(isRegionCollapsed).length;
	return { all, open: all - frame.band * collapsed };
}

/**
 * The px child `i` of the centre's row is drawn at: open, its part of the open room (the open
 * regions share it by their shares); collapsed, the px it would show at (its share of `all`).
 */
function drawnPx(row: DockSplitNode, i: number, room: { all: number; open: number }): number {
	if (isRegionCollapsed(row.children[i])) return row.sizes[i] * room.all;
	const open = row.children.reduce(
		(sum, c, j) => (isRegionCollapsed(c) ? sum : sum + row.sizes[j]),
		0
	);
	return open > 0 ? (row.sizes[i] / open) * room.open : row.sizes[i] * room.all;
}

/**
 * Has the centre's row of `now` the children and the shares it had in `then` (a divider drag
 * cancelled puts the shares of its press back, #892)? `false` when either has no such row.
 */
export function isThreePaneRowAsIn(then: DockLayout, now: DockLayout): boolean {
	const a = centreRow(then)?.row;
	const b = centreRow(now)?.row;
	return (
		a !== undefined &&
		b !== undefined &&
		a.id === b.id &&
		a.children.length === b.children.length &&
		a.children.every((c, i) => c.id === b.children[i].id && a.sizes[i] === b.sizes[i])
	);
}

/** The px each side of the centre's row should have (by the child's id), kept beside the layout. */
export type ThreePaneSideWidths = ReadonlyMap<string, number>;

/**
 * The px of the sides after `next` was put in at `width`, given the layout seen before (`prev`, at
 * the same `width` or an older one) and the px kept then (`kept`):
 * - the centre's row has the children it had (`prev`'s ids, in order) and a side's share changed: the
 *   user (or the app) resized it - its px is read off the new share (`resized: true`);
 * - else a side kept (by id) keeps its px - a pane hidden, shown, collapsed, docked or moved
 *   elsewhere in the tree, the narrow display left, a width change - and a new one has its share's px.
 * Sides no longer in the row are kept (a pane shown again comes back at its px). `fallback` gives
 * the px of a side seen for the first time (by id), when it has one (`leftWidth` for a left
 * pane hidden in the default layout). No row holding the centre: `kept` as it is. `width` is the
 * docked area's; a px is the width drawn (`frame`, the module comment).
 */
export function followThreePaneSideWidths(
	prev: DockLayout | null,
	kept: ThreePaneSideWidths | null,
	next: DockLayout,
	width: number,
	fallback?: (id: string) => number | undefined,
	frame: ThreePaneRowFrame = NO_FRAME
): { widths: Map<string, number>; resized: boolean } {
	const widths = new Map(kept ?? []);
	const found = centreRow(next);
	if (!found || !(width > 0)) return { widths, resized: false };
	const { row, centre } = found;
	const before = prev ? centreRow(prev) : null;
	const prevSizes =
		before !== null &&
		before.row.id === row.id &&
		before.row.children.length === row.children.length &&
		before.row.children.every((c, i) => c.id === row.children[i].id)
			? before.row.sizes
			: null;
	const room = rowRoom(next, row, width, frame);
	let resized = false;
	row.children.forEach((child, i) => {
		if (i === centre) return;
		const px = drawnPx(row, i, room);
		if (prevSizes && Math.abs(prevSizes[i] - row.sizes[i]) > SHARE_EPSILON) {
			widths.set(child.id, px);
			resized = true;
		} else if (!widths.has(child.id)) widths.set(child.id, fallback?.(child.id) ?? px);
	});
	return { widths, resized };
}

/** Two shares closer than this are the same (a rounding of `normalizeSizes`, not a resize). */
const SHARE_EPSILON = 1e-9;

/**
 * The shares of a row of `count` regions at `width` px, the one at `centre` taking what the others
 * (`px[i]`, the centre's ignored) leave:
 * - room for all: each side has its px exactly;
 * - else the sides shrink in proportion so the centre keeps `centerMinWidth`, none below
 *   `min(px, sideMinWidth)`;
 * - still too wide (a width below the minimums): the sides shrink so the centre keeps
 *   `MIN_PANE_FRACTION` of the row (the dock's own minimum share).
 * The shares sum to 1 and are all positive.
 */
export function threePaneSideShares(
	px: readonly number[],
	centre: number,
	width: number
): number[] {
	const w = width > 0 ? width : THREE_PANE_DEFAULTS.hostWidth;
	const wanted = px.map((p, i) => (i === centre ? 0 : Number.isFinite(p) && p > 1 ? p : 1));
	const total = wanted.reduce((a, b) => a + b, 0);
	const room = Math.max(0, w - THREE_PANE_DEFAULTS.centerMinWidth);
	let sides = wanted;
	if (total > room) {
		// Shrunk in proportion, a side reaching its floor held there and the rest shrunk further.
		const floors = wanted.map((p) => Math.min(p, THREE_PANE_DEFAULTS.sideMinWidth));
		const pinned = new Set<number>([centre]);
		for (;;) {
			const fixed = [...pinned].reduce((sum, i) => sum + (i === centre ? 0 : floors[i]), 0);
			const free = wanted.reduce((sum, p, i) => (pinned.has(i) ? sum : sum + p), 0);
			const scale = free > 0 ? Math.max(0, room - fixed) / free : 0;
			const below = wanted.findIndex((p, i) => !pinned.has(i) && p * scale < floors[i]);
			if (below < 0) {
				sides = wanted.map((p, i) => (i === centre ? 0 : pinned.has(i) ? floors[i] : p * scale));
				break;
			}
			// Pin every side under its floor at this scale at once (each round pins at least one).
			wanted.forEach((p, i) => {
				if (!pinned.has(i) && p * scale < floors[i]) pinned.add(i);
			});
		}
	}
	const most = w * (1 - MIN_PANE_FRACTION);
	const sum = sides.reduce((a, b) => a + b, 0);
	if (sum > most) sides = sides.map((p) => (p * most) / sum);
	const shares = sides.map((p) => p / w);
	shares[centre] = Math.max(MIN_PANE_FRACTION, 1 - shares.reduce((a, b) => a + b, 0));
	return shares;
}

/**
 * `layout` with the centre's row's sides drawn at their px (`widths`, by id; a side not in it keeps
 * the px it is drawn at) at `width` (the docked area's; `frame`, the module comment): the open
 * regions share the open room by `threePaneSideShares`; a collapsed side keeps the share it would
 * show at, so it comes back at its px. The same object when nothing changes, or there is no row
 * holding the centre. Only the row's `sizes` change: no structure, nothing re-mounted.
 */
export function fitThreePaneSideWidths(
	layout: DockLayout,
	widths: ThreePaneSideWidths,
	width: number,
	frame: ThreePaneRowFrame = NO_FRAME
): DockLayout {
	const found = centreRow(layout);
	if (!found || !(width > 0)) return layout;
	const { row, centre } = found;
	const room = rowRoom(layout, row, width, frame);
	const px = row.children.map((c, i) => widths.get(c.id) ?? drawnPx(row, i, room));
	const collapsed = row.children.map(isRegionCollapsed);
	// As if all were open: the collapsed sides' shares (the centre keeps its minimum share then).
	const sizes = threePaneSideShares(px, centre, room.all);
	if (collapsed.some(Boolean) && !collapsed[centre]) {
		// The open regions share the rest as they share the open room.
		const rest = 1 - sizes.reduce((sum, s, i) => (collapsed[i] ? sum + s : sum), 0);
		const open = row.children.flatMap((_, i) => (collapsed[i] ? [] : [i]));
		const parts = threePaneSideShares(
			open.map((i) => px[i]),
			open.indexOf(centre),
			room.open
		);
		open.forEach((i, k) => {
			sizes[i] = rest * parts[k];
		});
	}
	if (sizes.every((s, i) => Math.abs(s - row.sizes[i]) <= SHARE_EPSILON)) return layout;
	return { ...layout, docked: replaceById(layout.docked!, row.id, { ...row, sizes }) };
}

export interface ThreePaneNarrowLayoutOptions {
	panels: ThreePanePanels;
	/**
	 * The panes (besides the centre) to put in an edge band. Omitted = the left / right panes
	 * that are shown in the wide layout.
	 */
	shown?: readonly string[];
	/** For the closed windows of panes the wide layout does not float; `<= 0` = the defaults. */
	hostWidth?: number;
	hostHeight?: number;
}

/**
 * The narrow display (plan §4.5, §9 Q7), built from the wide layout `wide` and today's panes: the
 * centre docked alone; the panes in `shown` auto-hidden to an edge band - left on the left edge,
 * right on the right, an extra panel on its `initial` edge (else the right) - so their flyout is
 * the drawer; every other pane a closed floating window (its geometry kept from `wide` when it
 * floats there; no remembered docked place, no lock, not collapsed). `wide` itself is not changed:
 * the caller keeps it as the layout to save and to go back to.
 */
export function threePaneNarrowLayout(
	wide: DockLayout,
	options: ThreePaneNarrowLayoutOptions
): DockLayout {
	const { panels } = options;
	const defs = new Map<string, ThreePanePaneDef>();
	const homes = new Map<string, DockEdge>();
	if (panels.left) {
		defs.set(THREE_PANE_IDS.left, panels.left);
		homes.set(THREE_PANE_IDS.left, 'left');
	}
	if (panels.right) {
		defs.set(THREE_PANE_IDS.right, panels.right);
		homes.set(THREE_PANE_IDS.right, 'right');
	}
	for (const def of panels.extra ?? []) {
		defs.set(def.id, def);
		homes.set(def.id, typeof def.initial === 'object' ? def.initial.edge : 'right');
	}
	const shown = new Set(
		(
			options.shown ??
			[THREE_PANE_IDS.left, THREE_PANE_IDS.right].filter((id) => isPaneShown(wide, id))
		).filter((id) => defs.has(id))
	);

	let layout: DockLayout = {
		version: 4,
		floating: [],
		docked: paneNode(THREE_PANE_IDS.center, panels.center)
	};
	for (const [id, def] of defs) {
		if (!shown.has(id)) continue;
		const edge = homes.get(id) ?? 'right';
		const docked = dockPanelAtEdge(
			layout.docked,
			paneNode(id, def),
			edge,
			() => `three-pane:narrow:${id}`
		);
		layout = autoHideRegionInLayout({ ...layout, docked }, id, { edge }) ?? layout;
	}

	const width = (options.hostWidth ?? 0) > 0 ? options.hostWidth! : THREE_PANE_DEFAULTS.hostWidth;
	const height =
		(options.hostHeight ?? 0) > 0 ? options.hostHeight! : THREE_PANE_DEFAULTS.hostHeight;
	const floating: FloatingWindow[] = [];
	for (const [id, def] of defs) {
		if (shown.has(id)) continue;
		const was = wide.floating.find((w) => w.id === id);
		floating.push(
			was
				? {
						id,
						title: def.title,
						...(def.icon !== undefined ? { icon: def.icon } : {}),
						x: was.x,
						y: was.y,
						width: was.width,
						height: was.height,
						open: false
					}
				: extraWindow({ id, ...def }, floating.length, width, height, false)
		);
	}
	return { ...layout, floating };
}

/**
 * Strings `ThreePaneDock` adds to `DockMessages` (i18n layer 1, conventions §13): the panes'
 * names (their title bars and the View menu). The keys match `@banto/ui`'s `UiMessages`
 * (`threePaneLeft` / `threePaneRight`), so an app can pass the same functions to both.
 */
export interface ThreePaneDockMessages extends DockMessages {
	/** The left pane's title. */
	threePaneLeft?: () => string;
	/** The centre pane's title. */
	threePaneCenter?: () => string;
	/** The right pane's title. */
	threePaneRight?: () => string;
}

export const defaultThreePaneDockMessages = {
	threePaneLeft: () => '左のペイン',
	threePaneCenter: () => '中央のペイン',
	threePaneRight: () => '右のペイン'
} satisfies Required<
	Pick<ThreePaneDockMessages, 'threePaneLeft' | 'threePaneCenter' | 'threePaneRight'>
>;

/**
 * One item of `ThreePaneDock.viewMenuItems` (plan §4.8): structurally `@banto/ui`'s
 * `HeaderNavMenuItem` (checkbox / action / separator), without importing it (conventions §4).
 */
export type ThreePaneViewMenuItem =
	| { kind: 'checkbox'; id: string; label: string; checked: boolean; onSelect: () => void }
	| { kind: 'action'; id: string; label: string; onSelect: () => void }
	| { kind: 'separator'; id: string };

/** Labels `viewMenuItems` needs besides the panes' titles. */
export interface ThreePaneViewMenuLabels {
	/** "Reset layout" (the dashboard's `dashboard.resetLayout` key). */
	resetLayout: string;
}
