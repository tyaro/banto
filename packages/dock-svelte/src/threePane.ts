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
import { cascadePosition, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH } from './core/geometry';
import { captureDockSlot, type HiddenDockSlot } from './core/slot';
import {
	collectPanelIds,
	dockPanelAtEdge,
	expandRegionOf,
	findNode,
	findParent,
	normalizeSizes,
	removePanel
} from './core/tree';
import { validateDockLayout } from './core/validate';
import type { DockMessages } from './messages';
import type {
	DockAutoHidden,
	DockEdge,
	DockLayout,
	DockNode,
	DockPanelNode,
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

/** A docked pane taken out as a closed window that remembers its place (`DockState.dismiss`'s shape). */
function hiddenWindow(
	root: DockNode | null,
	node: DockPanelNode,
	index: number,
	hidden: HiddenDockSlot[]
): FloatingWindow {
	const slot = captureDockSlot(root, node.id, hidden);
	return {
		id: node.id,
		title: node.title,
		...(node.icon !== undefined ? { icon: node.icon } : {}),
		x: index * 24,
		y: index * 24,
		width: DEFAULT_WINDOW_WIDTH,
		height: DEFAULT_WINDOW_HEIGHT,
		open: false,
		...(slot ? { dockSlot: slot } : {})
	};
}

/**
 * The default layout (plan §4.1, §6-4): left | centre | right in a row, the sides at
 * `leftWidth` / `rightWidth` px of `hostWidth` as shares (shrunk so the centre keeps
 * `centerMinWidth`), a side with `*Open: false` hidden (it remembers its place), and the extra
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
	const hidden: HiddenDockSlot[] = [];
	for (const [node, open] of [
		[left, options.leftOpen ?? true],
		[right, options.rightOpen ?? true]
	] as const) {
		if (!node || open) continue;
		const win = hiddenWindow(docked, node, floating.length, hidden);
		if (win.dockSlot) hidden.push({ id: win.id, slot: win.dockSlot });
		floating.push(win);
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
	return { version: 2, floating, docked };
}

/** What a saved three-pane layout is stored as (plan §4.4). `layout` is `DockState`'s layout object. */
export interface ThreePaneSavedLayout {
	schema: 1;
	/** The panes the layout was saved with (the three and the extra ones). */
	panels: string[];
	layout: DockLayout;
}

/** The value to save for `layout` (plan §4.4). */
export function threePaneSavedLayout(layout: DockLayout): ThreePaneSavedLayout {
	const ids = new Set<string>(collectPanelIds(layout.docked));
	for (const entry of layout.autoHidden ?? [])
		for (const id of entry.node.type === 'tabs'
			? entry.node.children.map((c) => c.id)
			: [entry.node.id])
			ids.add(id);
	for (const w of layout.floating) ids.add(w.id);
	return { schema: 1, panels: [...ids], layout };
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
 */
export function reconcileThreePaneLayout(
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
		const index = centreGroup.children.findIndex((c) => c.id === THREE_PANE_IDS.center);
		if (centreGroup.activeIndex !== index) {
			const group = { ...centreGroup, activeIndex: index };
			docked = replaceById(docked!, group.id, group);
			changed = true;
		}
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

	layout = {
		version: 2,
		floating: floatingTitled,
		docked,
		...(autoHiddenTitled.length > 0 ? { autoHidden: autoHiddenTitled } : {})
	};
	// The result went through the same checks as any restored layout.
	const final = validateDockLayout(layout);
	if (!final.ok) return fallback();
	return { layout: final.layout, status: changed ? 'repaired' : 'restored' };
}

function replaceById(root: DockNode, id: string, next: DockNode): DockNode {
	if (root.id === id) return next;
	if (root.type !== 'split') return root;
	return { ...root, children: root.children.map((c) => replaceById(c, id, next)) };
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
