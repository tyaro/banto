/**
 * Auto-hide (#694 PR-3, the "unpinned" tool window of Visual Studio / GX Works3).
 * Pure.
 *
 * A docked REGION - a panel that is not a tab, or a whole tab group - can be
 * auto-hidden: it leaves the docked tree (`removeRegion`, the split it leaves
 * shrinks as for a close) and goes to `DockLayout.autoHidden` with the edge band
 * it sits in. Its panes show as tabs in that band; pressing one slides the pane
 * out over the docked tree (`DockState.openFlyout`, not saved). Pinning it again
 * puts the region back at its place.
 *
 * The place is not here (#782 PR8b): `DockState` keeps the region in its shadow
 * tree as tombstones marked `band` (`core/shadow.ts`, saved as
 * `DockLayout.dockedWithAutoHidden`, `core/bandTree.ts`), so it comes back into
 * the split / tab group it left at the share it held there, whatever order panes
 * come back in. A region with no place left (the layout was assigned from
 * outside, or read without its tree) docks at its default place, else along its
 * edge. `autoHideRegionInLayout` only makes the layout: for one built as a whole
 * (`threePane.ts`'s narrow display).
 *
 * The band is chosen by where the region is relative to the MAIN region (the one
 * the app protects with `capabilities`, see `mainRegionId`), or to the middle of
 * the docked tree when there is none: the side of the larger offset of the two
 * centres, measured on the tree's own split shares (`regionRects`; no DOM).
 */
import { collectPanelIds, findNode, findParent, removePanel } from './tree';
import type {
	DockAutoHidden,
	DockEdge,
	DockLayout,
	DockNode,
	DockPanelNode,
	DockTabGroupNode
} from '../types';

/** A docked region: a panel that is not a tab, or a tab group. */
export type DockRegion = DockPanelNode | DockTabGroupNode;

/** Default size of the slid-out pane, as a share of the docked area along the edge's axis. */
export const AUTO_HIDE_FLYOUT_RATIO = 0.3;
const MIN_FLYOUT = 0.1;
const MAX_FLYOUT = 0.9;

/** A slid-out size kept in range (`AUTO_HIDE_FLYOUT_RATIO` when missing or not a number). */
export function clampFlyoutSize(size: number | undefined): number {
	if (size === undefined || !Number.isFinite(size) || size <= 0) return AUTO_HIDE_FLYOUT_RATIO;
	return Math.min(MAX_FLYOUT, Math.max(MIN_FLYOUT, size));
}

/** The region that holds `id` in `root`: the region itself, a bare pane, or a tab's group. `null` for a split / unknown id. */
export function regionOf(root: DockNode | null, id: string): DockRegion | null {
	const node = findNode(root, id);
	if (!node || node.type === 'split') return null;
	if (node.type === 'panel') {
		const parent = findParent(root, id);
		if (parent?.type === 'tabs') return parent;
	}
	return node;
}

/** The pane ids of a region (a panel's own id, or the tabs in order). */
export function regionPanelIds(region: DockRegion): string[] {
	return region.type === 'tabs' ? region.children.map((c) => c.id) : [region.id];
}

/** The pane shown when the region is slid out / in front: the panel, or the group's active tab. */
export function activePanelOf(region: DockRegion): DockPanelNode {
	return region.type === 'tabs'
		? (region.children[region.activeIndex] ?? region.children[0])
		: region;
}

interface UnitRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Every region's rect in the unit square, from the split shares (collapsed bands are ignored). */
export function regionRects(root: DockNode | null): Map<string, UnitRect> {
	const out = new Map<string, UnitRect>();
	const visit = (node: DockNode, r: UnitRect): void => {
		if (node.type !== 'split') {
			out.set(node.id, r);
			return;
		}
		const total = node.sizes.reduce((a, b) => a + b, 0);
		let at = 0;
		node.children.forEach((child, i) => {
			const share =
				total > 0 ? (node.sizes[i] ?? 0) / total : 1 / Math.max(1, node.children.length);
			const part: UnitRect =
				node.direction === 'row'
					? { x: r.x + at * r.w, y: r.y, w: share * r.w, h: r.h }
					: { x: r.x, y: r.y + at * r.h, w: r.w, h: share * r.h };
			at += share;
			visit(child, part);
		});
	};
	if (root) visit(root, { x: 0, y: 0, w: 1, h: 1 });
	return out;
}

/**
 * The band a region goes to (module doc): the side of the region's centre seen
 * from the main region's centre (or the tree's middle when `mainId` is missing,
 * unknown, or the region itself). The larger offset wins; a tie goes to left /
 * right. A region in the middle (the only region) goes to the left.
 */
export function autoHideEdge(
	root: DockNode | null,
	regionId: string,
	mainId?: string | null
): DockEdge {
	const rects = regionRects(root);
	const region = rects.get(regionId);
	if (!region) return 'left';
	const main = mainId && mainId !== regionId ? rects.get(mainId) : undefined;
	const mx = main ? main.x + main.w / 2 : 0.5;
	const my = main ? main.y + main.h / 2 : 0.5;
	const dx = region.x + region.w / 2 - mx;
	const dy = region.y + region.h / 2 - my;
	const EPS = 1e-9;
	if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return 'left';
	if (Math.abs(dx) + EPS >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
	return dy < 0 ? 'top' : 'bottom';
}

/**
 * The main region of `root` for `autoHideEdge`: the first region (tree order)
 * whose panes all say `isMain` (`DockHost`: `move`, `undock` and `close` are all
 * `false` in `capabilities`). `null` when none does.
 */
export function mainRegionId(
	root: DockNode | null,
	isMain: (panelId: string) => boolean
): string | null {
	const visit = (node: DockNode): string | null => {
		if (node.type === 'split') {
			for (const child of node.children) {
				const found = visit(child);
				if (found !== null) return found;
			}
			return null;
		}
		return regionPanelIds(node).every(isMain) ? node.id : null;
	};
	return root ? visit(root) : null;
}

/** `root` without the region `regionId` (splits it leaves shrink as for a close). `root` when it is not a region. */
export function removeRegion(root: DockNode | null, regionId: string): DockNode | null {
	const region = regionOf(root, regionId);
	if (!region || region.id !== regionId) return root;
	return regionPanelIds(region).reduce<DockNode | null>((r, id) => removePanel(r, id), root);
}

/** The auto-hidden entry that holds `id` (its region id or one of its pane ids), with its index. */
export function findAutoHidden(
	layout: DockLayout,
	id: string
): { entry: DockAutoHidden; index: number } | null {
	const list = layout.autoHidden ?? [];
	for (let index = 0; index < list.length; index++) {
		const entry = list[index];
		if (entry.node.id === id || regionPanelIds(entry.node).includes(id)) return { entry, index };
	}
	return null;
}

/** Every pane id in the bands, in band order. */
export function autoHiddenPanelIds(layout: DockLayout): string[] {
	return (layout.autoHidden ?? []).flatMap((e) => regionPanelIds(e.node));
}

function withAutoHidden(layout: DockLayout, list: DockAutoHidden[]): DockLayout {
	const next: DockLayout = { ...layout };
	if (list.length > 0) next.autoHidden = list;
	else delete next.autoHidden;
	return next;
}

function bare<T extends DockRegion>(node: T): T {
	if (node.collapsed === undefined) return node;
	const next = { ...node };
	delete next.collapsed;
	return next;
}

export interface AutoHideOptions {
	/** The band; omitted = `autoHideEdge` from `mainId`. */
	edge?: DockEdge;
	/** The slid-out size (a share of the docked area); omitted = the default. */
	size?: number;
	/** The main region for `autoHideEdge`. */
	mainId?: string | null;
}

/**
 * `layout` with the region `regionId` moved from the docked tree to its band
 * (module doc). `null` when `regionId` is not a region of the tree (a tab inside
 * a group, a split, an unknown id). The layout holds no place for the region
 * (`dockedWithAutoHidden` is not written here): `DockState.autoHideRegion` keeps one.
 */
export function autoHideRegionInLayout(
	layout: DockLayout,
	regionId: string,
	options: AutoHideOptions = {}
): DockLayout | null {
	const root = layout.docked;
	const region = regionOf(root, regionId);
	if (!region || region.id !== regionId) return null;
	const edge = options.edge ?? autoHideEdge(root, regionId, options.mainId);
	const entry: DockAutoHidden = { node: bare(region), edge };
	if (options.size !== undefined && Number.isFinite(options.size) && options.size > 0)
		entry.size = clampFlyoutSize(options.size);
	return withAutoHidden({ ...layout, docked: removeRegion(root, regionId) }, [
		...(layout.autoHidden ?? []),
		entry
	]);
}

/**
 * The ids of `layout` that are not in its docked tree: the floating windows, and the regions in
 * the edge bands with their panes. A layout holds an id once (`validateDockLayout`), so a split /
 * tab group made in the docked tree takes none of them (`core/defaultPlace.ts`'s `taken`).
 */
export function idsOutOfDocked(layout: DockLayout): Set<string> {
	const taken = new Set<string>(layout.floating.map((w) => w.id));
	for (const entry of layout.autoHidden ?? []) {
		taken.add(entry.node.id);
		if (entry.node.type === 'tabs') for (const tab of entry.node.children) taken.add(tab.id);
	}
	return taken;
}

/**
 * `layout` with the pane `panelId` taken out of its band (for a close / hide of
 * an auto-hidden pane). A group that is left with one pane keeps it as a bare
 * panel; an emptied entry is dropped. The entry it was in is returned too.
 * `null` when the pane is not auto-hidden.
 */
export function removeAutoHiddenPane(
	layout: DockLayout,
	panelId: string
): { layout: DockLayout; pane: DockPanelNode; entry: DockAutoHidden } | null {
	const found = findAutoHidden(layout, panelId);
	// A group id is not a pane.
	if (!found || (found.entry.node.type === 'tabs' && found.entry.node.id === panelId)) return null;
	const { entry, index } = found;
	const list = (layout.autoHidden ?? []).slice();
	const node = entry.node;
	let pane: DockPanelNode;
	if (node.type === 'panel') {
		pane = node;
		list.splice(index, 1);
	} else {
		const at = node.children.findIndex((c) => c.id === panelId);
		pane = node.children[at];
		const children = node.children.filter((_, i) => i !== at);
		let activeIndex = node.activeIndex > at ? node.activeIndex - 1 : node.activeIndex;
		activeIndex = Math.min(Math.max(activeIndex, 0), children.length - 1);
		if (children.length === 0) list.splice(index, 1);
		else
			list[index] = {
				...entry,
				node: children.length === 1 ? children[0] : { ...node, children, activeIndex }
			};
	}
	return { layout: withAutoHidden(layout, list), pane, entry };
}

/** `layout` with the auto-hidden group that holds `panelId` showing that pane (its `activeIndex`). The same layout when nothing changes. */
export function setAutoHiddenActive(layout: DockLayout, panelId: string): DockLayout {
	const found = findAutoHidden(layout, panelId);
	if (!found || found.entry.node.type !== 'tabs') return layout;
	const node = found.entry.node;
	const at = node.children.findIndex((c) => c.id === panelId);
	if (at === -1 || at === node.activeIndex) return layout;
	const list = (layout.autoHidden ?? []).slice();
	list[found.index] = { ...found.entry, node: { ...node, activeIndex: at } };
	return { ...layout, autoHidden: list };
}

/** All pane ids known to `layout`: docked, auto-hidden and floating. */
export function allPanelIds(layout: DockLayout): string[] {
	return [
		...collectPanelIds(layout.docked),
		...autoHiddenPanelIds(layout),
		...layout.floating.map((w) => w.id)
	];
}
