/**
 * The shadow tree S of the docked layout (Issue #782 PR2; downstream-requests-2026-11-plan §4.11,
 * property tests per ADR-0033). Pure functions only, no Svelte imports, like `tree.ts`: every
 * function returns a NEW tree (or the same object when nothing changes) and never mutates its
 * input. `DockState` keeps an S beside its layout (#782 PR4, `#followShadow`) and, since #782 PR6,
 * makes its changes on it - floating a pane out and back, moves, drops, divider drags, showing a
 * hidden pane at its default place: the docked tree it assigns is the projection of S.
 *
 * S is the docked tree with every pane that has a docked place in it: the panes that are docked
 * now, and the panes that are outside (hidden or floated) but go back to a place in the dock.
 * The second kind is a leaf marked `away` - a tombstone. What the user sees (`layout.docked`) is
 * the projection of S (`projectShadow`): the tombstones are left out, a split / tab group left
 * with one shown child shows as that child, and a split's `sizes` are shared again among the
 * children that show.
 *
 *  - Hiding / floating a pane and putting it back only set and clear the mark (`markAway` /
 *    `markPresent`). The tree's shape and every `sizes` stay, so the order panes come back in
 *    cannot matter, and coming back restores the ratios exactly. S keeps the ratios as they
 *    were: no minimum share is applied to them (plan §9.2, the known failure 4 of #782).
 *  - A pane that leaves for good, or moves to another container, is taken out of S and its
 *    share goes to its siblings in proportion (`removeFromShadow`, the rule of #743). Only then
 *    does a split / tab group of S fold - when it has one child left in S, shown or not. A split
 *    that still holds a tombstone never folds. A pane put back into the split it was a child of
 *    has not left it (#782: a new order inside one split is a move in S): the tombstones of that
 *    split keep their share.
 *  - A drop is made against what the user sees, so its target is named by an id of the
 *    projection. `dockIntoShadow` maps it to S by the decision of #780: a drop at a side acts on
 *    the OUTERMOST node of S whose projection is exactly the target, found BEFORE the moved pane
 *    is taken out; a drop at the center (a tab) acts on the target's tab group / leaf itself.
 *  - A resize of a shown split is written back to the shown children only
 *    (`writeShadowSizes` / `resizeShadowSplit`); the tombstones keep their share of S.
 *
 * Shares of 0. A saved layout may hold a share of 0 (`validate.ts` only refuses a negative one),
 * e.g. `row[a, b, c]` with `[0, 0, 1]`. The promise (review of PR #826):
 *
 *  - S keeps a 0 as it is. It is not repaired on the way in (no minimum share is applied to S, see
 *    above), and the marks never write a share: hide `c`, show it again, and S is `[0, 0, 1]`.
 *  - The projection shows children that have 0 together evenly, as `tree.ts#removePanel` does.
 *  - Only a WRITE to such a split - a resize of it, or a pane put into it as a sibling - gives the
 *    shown children a share, because the proportion the user sees and sets cannot be kept in a
 *    total of 0: together they take the even part of the split (their count out of all its
 *    children in S), in the proportion written, and the tombstones share the rest in the
 *    proportion they had. This is the one case where a write changes the share of a tombstone.
 *    From then on the split is like any other. (`shownShares`.)
 *
 * Ids of new split / tab group nodes come from an injected `makeId`, as in `tree.ts`.
 *
 * The saved form. Since #782 PR8b a layout is saved with S itself, for the regions in its edge
 * bands: the tree without the tombstones of the floating windows (`DockLayout.dockedWithAutoHidden`,
 * `core/bandTree.ts`). No layout holds a slot any more, and `DockState` no longer makes S from
 * slots; what follows is left for the name of a floated pane's place (`DockState.homeSlot`) and
 * goes with it in #782 PR8c.
 *
 * The slots (#782 PR3): the docked tree the user sees, and a `DockSlot` for every pane that is out
 * of it - `deflateShadow` (S -> the projection and one slot per tombstone) and `inflateShadow`
 * (the docked tree and the slots -> S). A slot written here names every split / tab group above
 * the tombstone by id, with the tombstone's place and share IN S (`index`, `share`) and every
 * other pane of that container (`anchors` / `otherAnchors`, the ones away included), so it does
 * not change while panes are only hidden and shown, and `inflateShadow(deflateShadow(S))` is S
 * again - as far as a slot can say it (see `deflateShadow`).
 */
import { placeAtDefault } from './defaultPlace';
import { MAX_SLOT_DEPTH } from './slot';
import type {
	DockEdge,
	DockNode,
	DockPanelNode,
	DockSlot,
	DockSplitNode,
	DockTabGroupNode,
	DropRegion,
	ShadowNode,
	ShadowPanelNode,
	ShadowSplitNode,
	ShadowTabGroupNode
} from '../types';
import {
	EDGE_DOCK_RATIO,
	defaultMakeId,
	findNode,
	findParent,
	normalizeCollapsed,
	resizeSplit
} from './tree';

// The nodes of S are in `types.ts` since #782 PR8b: a saved layout holds a tree of them
// (`DockLayout.dockedWithAutoHidden`, `core/bandTree.ts`). A tombstone marked `band` is a pane in
// an edge band (`DockState.autoHideRegion`): a tombstone like any other here - only `markAway`
// sets the mark, and a leaf put into S anew has none.
export type { ShadowNode, ShadowPanelNode, ShadowSplitNode, ShadowTabGroupNode } from '../types';

// ----- small helpers -------------------------------------------------------------------------

function evenSizes(count: number): number[] {
	return Array.from({ length: count }, () => 1 / count);
}

function normalized(sizes: number[]): number[] {
	const sum = sizes.reduce((a, b) => a + b, 0);
	if (!(sum > 0)) return evenSizes(sizes.length);
	return sizes.map((s) => s / sum);
}

function withoutCollapsed<T extends { collapsed?: boolean }>(node: T): T {
	if (node.collapsed === undefined) return node;
	const next = { ...node };
	delete next.collapsed;
	return next;
}

/** A leaf as it is when it is put into S anew: shown, not collapsed. */
function shownLeaf(panel: DockPanelNode): ShadowPanelNode {
	const next: ShadowPanelNode = { ...panel };
	delete next.collapsed;
	delete next.away;
	delete next.band;
	return next;
}

/** Does anything of `node` show (is its projection not empty)? */
function isShown(node: ShadowNode): boolean {
	return node.type === 'panel' ? node.away !== true : node.children.some(isShown);
}

/** How many children of `node` show (0 for a leaf). */
function shownCount(node: ShadowNode): number {
	return node.type === 'panel' ? 0 : node.children.filter(isShown).length;
}

/** The nodes from `root` down to the node `id` (both included), or `null`. */
function pathTo(root: ShadowNode, id: string): ShadowNode[] | null {
	if (root.id === id) return [root];
	if (root.type === 'panel') return null;
	for (const child of root.children) {
		const path = pathTo(child, id);
		if (path) return [root, ...path];
	}
	return null;
}

function idsOf(node: ShadowNode, into = new Set<string>()): Set<string> {
	into.add(node.id);
	if (node.type !== 'panel') node.children.forEach((c) => idsOf(c, into));
	return into;
}

/** `root` with the node `id` replaced (the same object when `id` is not in it or `replace` returns its argument). */
function replaceNode(
	root: ShadowNode,
	id: string,
	replace: (node: ShadowNode) => ShadowNode
): ShadowNode {
	if (root.id === id) return replace(root);
	if (root.type === 'panel') return root;
	if (root.type === 'tabs') {
		const children = root.children.map((c) => (c.id === id ? (replace(c) as ShadowPanelNode) : c));
		return children.some((c, i) => c !== root.children[i]) ? { ...root, children } : root;
	}
	const children = root.children.map((c) => replaceNode(c, id, replace));
	return children.some((c, i) => c !== root.children[i]) ? { ...root, children } : root;
}

/**
 * The active tab of a group whose child `index` may not show: `index` itself when it shows, else
 * the next shown tab after it, else the last shown one before it (what `tree.ts#removePanel` does
 * to a group that loses its active tab). `index` clamped when nothing shows.
 */
function shownActive(children: ShadowPanelNode[], index: number): number {
	const at = Math.min(Math.max(index, 0), Math.max(children.length - 1, 0));
	if (children[at]?.away !== true) return at;
	for (let i = at + 1; i < children.length; i++) if (children[i].away !== true) return i;
	for (let i = at - 1; i >= 0; i--) if (children[i].away !== true) return i;
	return at;
}

// ----- reading -------------------------------------------------------------------------------

/** S of a docked tree with nothing outside it: the tree itself. */
export function shadowOf(docked: DockNode | null): ShadowNode | null {
	return docked;
}

/** The leaf of the pane `panelId` in S (shown or a tombstone), or `null`. */
export function findShadowPanel(s: ShadowNode | null, panelId: string): ShadowPanelNode | null {
	if (!s) return null;
	const leaf = pathTo(s, panelId)?.at(-1);
	return leaf?.type === 'panel' ? leaf : null;
}

/** Every pane of S in tree order: `shown` ones, the ones `away` (tombstones), or `all`. */
export function shadowPanelIds(
	s: ShadowNode | null,
	which: 'all' | 'shown' | 'away' = 'all'
): string[] {
	if (!s) return [];
	if (s.type !== 'panel') return s.children.flatMap((c) => shadowPanelIds(c, which));
	const away = s.away === true;
	return which === 'all' || (which === 'away') === away ? [s.id] : [];
}

// ----- projection ----------------------------------------------------------------------------

function projectNode(node: ShadowNode): DockNode | null {
	if (node.type === 'panel') return node.away === true ? null : node;
	if (node.type === 'tabs') {
		const shown = node.children.filter((c) => c.away !== true);
		if (shown.length === 0) return null;
		// Every tab shows: the group as it is - one with a single tab too (`validate.ts` takes such
		// a group in a saved layout, and `DockState` keeps it).
		if (shown.length === node.children.length) return node;
		if (shown.length === 1) {
			return node.collapsed === true ? { ...shown[0], collapsed: true } : shown[0];
		}
		const before = node.children.slice(0, node.activeIndex).filter((c) => c.away !== true).length;
		return { ...node, children: shown, activeIndex: Math.min(before, shown.length - 1) };
	}
	const kept: DockNode[] = [];
	const sizes: number[] = [];
	node.children.forEach((child, i) => {
		const shown = projectNode(child);
		if (shown === null) return;
		kept.push(shown);
		sizes.push(node.sizes[i] ?? 0);
	});
	if (kept.length === 0) return null;
	if (kept.length === 1) return kept[0].type === 'split' ? kept[0] : withoutCollapsed(kept[0]);
	if (kept.length === node.children.length) {
		return kept.every((k, i) => k === node.children[i]) ? node : { ...node, children: kept };
	}
	return { ...node, children: kept, sizes: normalized(sizes) };
}

/**
 * The docked tree the user sees: S without its tombstones. A tab group with tombstones and one
 * shown tab shows as that pane (a group of one tab, with no tombstone, stays a group: a saved
 * layout may hold one), a split with one shown child as that child (not flattened into a split around it,
 * exactly like `tree.ts#collapse`), and a split's `sizes` are the shares of its shown children,
 * scaled to add up to 1. A split / tab group that shows keeps its id of S. `collapsed` flags follow
 * `tree.ts#normalizeCollapsed`. An S without tombstones projects to itself (the same object).
 */
export function projectShadow(s: ShadowNode | null): DockNode | null {
	return s === null ? null : normalizeCollapsed(projectNode(s));
}

/**
 * Drop the `collapsed` flags of S that its projection does not show (a region that became the
 * only shown child, a tombstone, a tab inside a group): `DockState` clears those for good, so
 * they must not come back when a sibling does. Called at the end of every change.
 */
function settleCollapsed(s: ShadowNode | null): ShadowNode | null {
	if (s === null) return null;
	const flagged = new Set<string>();
	const collect = (node: DockNode | null): void => {
		if (node === null) return;
		if (node.type !== 'split') {
			if (node.collapsed === true) flagged.add(node.id);
			return;
		}
		node.children.forEach(collect);
	};
	collect(projectShadow(s));
	const settle = (node: ShadowNode, inTabs: boolean): ShadowNode => {
		if (node.type === 'panel') {
			return !inTabs && node.away !== true && flagged.has(node.id) ? node : withoutCollapsed(node);
		}
		if (node.type === 'tabs') {
			const children = node.children.map((c) => settle(c, true) as ShadowPanelNode);
			const base = children.some((c, i) => c !== node.children[i]) ? { ...node, children } : node;
			const shown = node.children.filter((c) => c.away !== true);
			const keep = flagged.has(node.id) || (shown.length === 1 && flagged.has(shown[0].id));
			return keep ? base : withoutCollapsed(base);
		}
		const children = node.children.map((c) => settle(c, false));
		return children.some((c, i) => c !== node.children[i]) ? { ...node, children } : node;
	};
	return settle(s, false);
}

// ----- the mark ------------------------------------------------------------------------------

/**
 * The pane `panelId` leaves the dock but keeps its place (hidden, or floated): its leaf becomes a
 * tombstone. Nothing else of S changes - no split folds, no `sizes` move - except that a tab group
 * whose active tab left shows the next shown tab. The same S when the pane is not in it or is
 * away already.
 */
export function markAway(s: ShadowNode | null, panelId: string): ShadowNode | null {
	return marked(s, panelId, false);
}

/**
 * `markAway` for a pane that goes to an edge band (#782 PR8b, `DockState.autoHideRegion`): its
 * tombstone is marked `band` too. The mark only says where the pane is - S treats the tombstone
 * as any other.
 */
export function markInBand(s: ShadowNode | null, panelId: string): ShadowNode | null {
	return marked(s, panelId, true);
}

function marked(s: ShadowNode | null, panelId: string, band: boolean): ShadowNode | null {
	if (!s) return s;
	const path = pathTo(s, panelId);
	const leaf = path?.at(-1);
	if (!path || leaf?.type !== 'panel' || leaf.away === true) return s;
	const gone: ShadowPanelNode = { ...withoutCollapsed(leaf), away: true };
	if (band) gone.band = true;
	const group = path.at(-2);
	if (group?.type !== 'tabs') return settleCollapsed(replaceNode(s, panelId, () => gone));
	const children = group.children.map((c) => (c.id === panelId ? gone : c));
	const activeIndex = shownActive(children, group.activeIndex);
	return settleCollapsed(replaceNode(s, group.id, () => ({ ...group, children, activeIndex })));
}

/**
 * The pane `panelId` comes back to its place: its tombstone becomes a shown leaf again (with the
 * `title` / `icon` of `panel` when given - they may have changed while it was away), and in a tab
 * group it becomes the active tab. The same S when the pane is not in it (the caller then has no
 * docked place for it) or is shown already.
 */
export function markPresent(
	s: ShadowNode | null,
	panelId: string,
	panel?: Pick<DockPanelNode, 'title' | 'icon'>
): ShadowNode | null {
	if (!s) return s;
	const path = pathTo(s, panelId);
	const leaf = path?.at(-1);
	if (!path || leaf?.type !== 'panel' || leaf.away !== true) return s;
	const back = shownLeaf(leaf);
	if (panel) {
		back.title = panel.title;
		if (panel.icon === undefined) delete back.icon;
		else back.icon = panel.icon;
	}
	const group = path.at(-2);
	if (group?.type !== 'tabs') return settleCollapsed(replaceNode(s, panelId, () => back));
	const children = group.children.map((c) => (c.id === panelId ? back : c));
	const activeIndex = children.indexOf(back);
	return settleCollapsed(replaceNode(s, group.id, () => ({ ...group, children, activeIndex })));
}

// ----- taking out ----------------------------------------------------------------------------

/** A split / tab group of S with no child is gone, with one child it is that child (`tree.ts#collapse`, over S). */
function fold(node: ShadowSplitNode | ShadowTabGroupNode): ShadowNode | null {
	if (node.children.length === 0) return null;
	if (node.children.length > 1) return node;
	if (node.type === 'split') {
		const only = node.children[0];
		return only.type === 'split' ? only : withoutCollapsed(only);
	}
	return node.collapsed === true ? { ...node.children[0], collapsed: true } : node.children[0];
}

function removeNode(node: ShadowNode, panelId: string): ShadowNode | null {
	if (node.type === 'panel') return node.id === panelId ? null : node;
	if (node.type === 'tabs') {
		const idx = node.children.findIndex((c) => c.id === panelId);
		if (idx === -1) return node;
		const children = node.children.filter((_, i) => i !== idx);
		const activeIndex = shownActive(
			children,
			idx < node.activeIndex ? node.activeIndex - 1 : node.activeIndex
		);
		return fold({ ...node, children, activeIndex });
	}
	const results = node.children.map((c) => removeNode(c, panelId));
	if (results.every((r, i) => r === node.children[i])) return node;
	const kept: ShadowNode[] = [];
	const sizes: number[] = [];
	results.forEach((r, i) => {
		if (r === null) return;
		kept.push(r);
		sizes.push(node.sizes[i] ?? 0);
	});
	return fold({
		...node,
		children: kept,
		sizes: kept.length === node.children.length ? node.sizes : normalized(sizes)
	});
}

/**
 * The pane `panelId` gives up its place (it is closed for good, its definition is gone, or it is
 * about to be put somewhere else): its leaf - shown or a tombstone - is taken out of S and its
 * share goes to its siblings in S in proportion (#743). A split / tab group left with one child in
 * S folds into that child, with none it is gone; one that still has two (a tombstone counts) stays.
 * `null` when S becomes empty; the same S when the pane is not in it.
 */
export function removeFromShadow(s: ShadowNode | null, panelId: string): ShadowNode | null {
	if (!s) return null;
	const next = removeNode(s, panelId);
	return next === s ? s : settleCollapsed(next);
}

// ----- putting in / moving -------------------------------------------------------------------

/** The place in S of a drop target, held across the removal of the moved pane. */
interface Anchor {
	/** A shown pane of the target that is not the moved one. */
	rep: string;
	/** Every id under the outermost node of S whose projection is exactly the target. */
	ids: Set<string>;
}

/**
 * The region of the projection a drop on `targetId` acts on, as `tree.ts#resolveTarget`: a pane in
 * a (shown) tab group stands for the group, a split for its first leaf. `null` when `targetId` does
 * not show.
 */
function visibleRegion(
	visible: DockNode,
	targetId: string
): DockPanelNode | DockTabGroupNode | null {
	let node = findNode(visible, targetId);
	if (node === null) return null;
	while (node.type === 'split') node = node.children[0];
	if (node.type === 'panel') {
		const parent = findParent(visible, node.id);
		if (parent?.type === 'tabs') return parent;
	}
	return node;
}

function anchorOf(
	s: ShadowNode,
	visible: DockNode | null,
	targetId: string,
	movedId: string
): Anchor | null {
	// The moved pane itself is no target, and neither is its tab group in its name (`tree.ts`
	// looks the id up after the removal): only the group's own id stands for the other tabs.
	if (visible === null || targetId === movedId) return null;
	const region = visibleRegion(visible, targetId);
	if (region === null) return null;
	const rep =
		region.type === 'panel' ? region.id : region.children.find((c) => c.id !== movedId)?.id;
	if (rep === undefined || rep === movedId) return null;
	const path = pathTo(s, rep)!;
	// The target's region in S: its tab group when it is in one (even when it is the only tab that
	// shows), else its leaf. Then outwards while the node around it shows nothing else (#780).
	let at = path.length - 1;
	if (at > 0 && path[at - 1].type === 'tabs') at -= 1;
	while (at > 0 && shownCount(path[at - 1]) === 1) at -= 1;
	return { rep, ids: idsOf(path[at]) };
}

function wrap(
	target: ShadowNode,
	panel: ShadowPanelNode | ShadowTabGroupNode,
	side: DockEdge,
	ratio: number,
	makeId: () => string
): ShadowSplitNode {
	const before = side === 'left' || side === 'top';
	return {
		type: 'split',
		id: makeId(),
		direction: side === 'left' || side === 'right' ? 'row' : 'column',
		children: before ? [panel, target] : [target, panel],
		sizes: before ? [ratio, 1 - ratio] : [1 - ratio, ratio]
	};
}

/**
 * Put the pane `dropped` into S at `region` of the target `targetId` - an id of the PROJECTION (a
 * shown pane, a shown tab group, or a shown split = its first leaf), as a drop names it. The pane's
 * own leaf in S, shown or a tombstone, is taken out first (`removeFromShadow`): this is both
 * "dock a pane from outside" and "move a docked pane" (`DockState.dockPanel` / `dockExisting`).
 *
 *  - A side (`left` / `right` / `top` / `bottom`) acts on the outermost node of S whose projection
 *    is exactly the target, as S was BEFORE the pane was taken out (#780: in
 *    `column[row[a†, b†, c], d, e†]`, `c` to the right of `d` gives `column[row[a†, b†], row[d, c],
 *    e†]` - `c` stays beside `d` whatever comes back first). When that node's parent in S is a
 *    split in the drop's direction the pane becomes its sibling, and the SHOWN children of that
 *    split share what they had evenly (`tree.ts#splitInsert` shares evenly; the tombstones keep
 *    theirs). Else the node is wrapped in a new half / half split.
 *  - `center` acts on the target itself: appended to its tab group of S (a group with one shown
 *    tab included), or a new group is made of the target's leaf and the pane. The pane becomes the
 *    active tab and the group is expanded.
 *  - A split as the target must still show as a split once the pane is taken out (as
 *    `dockExisting` resolves it: `tree.ts#resolveTarget` after `removePanel`). Its first leaf is
 *    then the first leaf of what is left - `a` to the right of `S` in `row[x, column(S)[a, b, c]]`
 *    gives `row[x, column(S)[row[b, a], c]]`. A split the removal folds, or leaves with one shown
 *    child, is a stale id.
 *  - A target that does not show (a stale id, or the moved pane itself) falls back to the first
 *    shown leaf, as `tree.ts#resolveTarget` does. When nothing shows at all, S as a whole is
 *    wrapped half / half with the pane at that side (`center` = `right`); an empty S becomes the pane.
 *  - A pane that was a direct child of a split and becomes a sibling in that same split again has
 *    only changed its place in it: the children that do not show keep the share they had before
 *    the pane was taken out, and the shown ones (the pane included) share the rest evenly -
 *    `row[a†, b, c]` with `[.4, .2, .4]`, `b` to the right of `c`, is `row[a†, c, b]` with
 *    `[.4, .3, .3]`. Any other move takes the pane out of its container first (#743).
 *
 * With no tombstone in S the projection of the result is `dockPanelIntoTree(removePanel(...))`,
 * except for a drop on the moved pane's own two-tab group (there the other tab is the target,
 * where `tree.ts` falls back to the first leaf of the tree).
 */
export function dockIntoShadow(
	s: ShadowNode | null,
	dropped: DockPanelNode,
	targetId: string,
	region: DropRegion,
	makeId: () => string = defaultMakeId
): ShadowNode {
	const panel = shownLeaf(dropped);
	const seen = s ? projectNode(s) : null;
	const held = s ? anchorOf(s, seen, targetId, panel.id) : null;
	const home = s ? homeOf(s, panel.id) : null;
	const rest = s ? removeNode(s, panel.id) : null;
	if (rest === null) return panel;
	const visible = projectNode(rest);
	if (visible === null) {
		return wrap(rest, panel, region === 'center' ? 'right' : region, 0.5, makeId);
	}
	let anchor = held;
	if (findNode(seen, targetId)?.type === 'split') {
		// A split stands for its first leaf, and that is the first leaf of what is left of it - if
		// it is left. The node found before the removal is kept when there was one (#780).
		const again = anchorOf(rest, visible, targetId, panel.id);
		anchor = again === null ? null : (held ?? again);
	}
	if (anchor === null) {
		let first = visible;
		while (first.type === 'split') first = first.children[0];
		anchor = anchorOf(rest, visible, first.id, panel.id)!;
	}
	const path = pathTo(rest, anchor.rep)!;
	const leaf = path.length - 1;

	if (region === 'center') {
		const group = path[leaf - 1];
		if (group?.type === 'tabs') {
			const children = [...group.children, panel];
			const next = { ...withoutCollapsed(group), children, activeIndex: children.length - 1 };
			return settleCollapsed(replaceNode(rest, group.id, () => next))!;
		}
		const tabs: ShadowTabGroupNode = {
			type: 'tabs',
			id: makeId(),
			children: [withoutCollapsed(path[leaf] as ShadowPanelNode), panel],
			activeIndex: 1
		};
		return settleCollapsed(replaceNode(rest, anchor.rep, () => tabs))!;
	}

	// What is left of the node found before the removal: outwards from the target's leaf while the
	// node was part of it (a removal only takes nodes out, so those are the innermost ones).
	let at = leaf;
	while (at > 0 && anchor.ids.has(path[at - 1].id)) at -= 1;
	const target = path[at];
	const parent = at > 0 ? path[at - 1] : null;
	const direction = region === 'left' || region === 'right' ? 'row' : 'column';
	if (parent?.type === 'split' && parent.direction === direction) {
		const index = parent.children.indexOf(target) + (region === 'left' || region === 'top' ? 0 : 1);
		const children = parent.children.slice();
		children.splice(index, 0, panel);
		// Back in the split it was a child of: the shares are the ones from before the removal, so
		// nothing of the pane's share has gone to a tombstone. Else it comes in with nothing.
		const before = home?.id === parent.id ? children.map((c) => home.sizes.get(c.id)) : [];
		let sizes: number[];
		if (before.length > 0 && before.every((size) => size !== undefined)) {
			sizes = before as number[];
		} else {
			sizes = parent.sizes.slice();
			sizes.splice(index, 0, 0);
		}
		const next = { ...parent, children, sizes: evenAmongShown(children, sizes) };
		return settleCollapsed(replaceNode(rest, parent.id, () => next))!;
	}
	const split = wrap(target, panel, region, 0.5, makeId);
	return settleCollapsed(replaceNode(rest, target.id, () => split))!;
}

/** The split the pane `panelId` is a direct child of, with the share of each child by id; else `null`. */
function homeOf(s: ShadowNode, panelId: string): { id: string; sizes: Map<string, number> } | null {
	const parent = pathTo(s, panelId)?.at(-2);
	if (parent?.type !== 'split') return null;
	return {
		id: parent.id,
		sizes: new Map(parent.children.map((c, i) => [c.id, parent.sizes[i] ?? 0]))
	};
}

/**
 * `sizes` of the children of a split of S, with its shown children given `weights` (one per shown
 * child, in order, adding up to more than 0) as the proportion among them. They share what they
 * have together and the others keep theirs. When they have 0 together (see "Shares of 0" at the
 * top) they take the even part of the split - their count out of all the children - and the
 * others share the rest in the proportion they had.
 */
function shownShares(children: ShadowNode[], sizes: number[], weights: number[]): number[] {
	const shown = children.map(isShown);
	const sum = weights.reduce((a, b) => a + b, 0);
	const all = sizes.reduce((a, b) => a + b, 0);
	if (!(all > 0)) return evenSizes(children.length);
	let total = sizes.reduce((acc, size, i) => (shown[i] ? acc + size : acc), 0);
	let others = 1;
	if (!(total > 0)) {
		total = (all * weights.length) / children.length;
		others = (all - total) / all;
	}
	let k = 0;
	return sizes.map((size, i) => (shown[i] ? (weights[k++] / sum) * total : size * others));
}

/** `sizes` with the shown children sharing evenly what they have together; the others keep theirs. */
function evenAmongShown(children: ShadowNode[], sizes: number[]): number[] {
	const count = children.filter(isShown).length;
	if (count === children.length) return evenSizes(count);
	return shownShares(children, sizes, evenSizes(count));
}

/**
 * Put the pane `dropped` along an outer edge of the whole host (`tree.ts#dockPanelAtEdge`,
 * `DockState.dockPanelAtEdge` / `dockExistingAtEdge`): its own leaf in S is taken out first, then
 * ALL of S - tombstones included - is wrapped in a new split with the pane at `edge`, taking
 * `EDGE_DOCK_RATIO`. So the pane stays a direct child of the root, and every pane that comes back
 * later comes back inside the other child (#777 / #781, the known failures 2, 3 and 7 of #782).
 * An empty S becomes the pane. The projection of the result is `dockPanelAtEdge(removePanel(...))`
 * of the projection.
 */
export function dockAtShadowEdge(
	s: ShadowNode | null,
	dropped: DockPanelNode,
	edge: DockEdge,
	makeId: () => string = defaultMakeId
): ShadowNode {
	const panel = shownLeaf(dropped);
	const rest = s ? removeNode(s, panel.id) : null;
	if (rest === null) return panel;
	return settleCollapsed(wrap(rest, panel, edge, EDGE_DOCK_RATIO, makeId))!;
}

/**
 * `dockAtShadowEdge` for a whole region - a pane, or a tab group with its id and active tab
 * (#782 PR8b: a region back from an edge band whose place is gone and that has no default place):
 * the leaves S has for its panes are taken out first, then all of S is wrapped with the region at
 * `edge`. The region shows, not collapsed.
 */
export function dockRegionAtShadowEdge(
	s: ShadowNode | null,
	region: DockPanelNode | DockTabGroupNode,
	edge: DockEdge,
	makeId: () => string = defaultMakeId
): ShadowNode {
	if (region.type === 'panel') return dockAtShadowEdge(s, region, edge, makeId);
	const group: ShadowTabGroupNode = {
		...withoutCollapsed(region),
		children: region.children.map(shownLeaf)
	};
	let rest = s;
	for (const tab of group.children) rest = rest ? removeNode(rest, tab.id) : null;
	if (rest === null) return group;
	return settleCollapsed(wrap(rest, group, edge, EDGE_DOCK_RATIO, makeId))!;
}

// ----- the default place (#782 PR6) ------------------------------------------------------------

/**
 * S with the pane `panel` (not in it) at its place in the default layout `defaults`:
 * `core/defaultPlace.ts#placeAtDefault` worked out ON S, so a tombstone is a pane that is there. The
 * pane lands beside the place of a default sibling that is floated out as it would beside the
 * sibling itself - `row[a, b, c]`, `b` hidden, `a` floated, `b` shown: `row[a†, b, c]`, and `a`
 * comes back before `b` -, whole parts of the tree are taken with their tombstones ("beside what a
 * default child is now", always wrapped when the split around is another default split), and a
 * split / tab group of S that does not show keeps its id from being taken twice. `share` is the
 * pane's share of what SHOWS of the split it lands in (`dockShareOf` of the docked tree, what a
 * closed window keeps); the other children, tombstones too, give way in proportion - the reverse
 * of `removeFromShadow`. `null`: no default place (the caller opens it floating).
 *
 * A pane in an edge band (a tombstone marked `band`, #782 PR8b) counts as one that shows for the
 * share: `DockState.dismiss` takes the share with the regions in the bands counted (they are part
 * of the layout, and saved with their places - unlike a floated pane's), so a pane hidden and
 * shown again holds what it held whether a region beside it went to its band before or after.
 */
export function placeInShadowAtDefault(
	s: ShadowNode | null,
	defaults: DockNode | null,
	panel: DockPanelNode,
	share?: number,
	makeId: () => string = defaultMakeId,
	taken: ReadonlySet<string> = new Set()
): ShadowNode | null {
	// `tree.ts` moves the leaves of the tree it is given as they are, so the marks stay on them.
	const placed: ShadowNode | null = placeAtDefault(
		s,
		defaults,
		shownLeaf(panel),
		share,
		makeId,
		taken,
		new Set(shadowPanelIds(s, 'away').filter((id) => findShadowPanel(s, id)?.band !== true))
	);
	return placed === null ? null : settleCollapsed(placed);
}

// ----- sizes ---------------------------------------------------------------------------------

/**
 * Write the sizes of a split as the user sees it back to S: `sizes` has one share per SHOWN child
 * of the split `splitId` (the `sizes` of that split in the projection). The shown children share
 * what they have together in S in that proportion; the tombstones keep their share, so a pane that
 * comes back takes the same part of the split as before. The one exception is a split whose shown
 * children have 0 together ("Shares of 0" at the top): a proportion other than the even one they
 * show with gives them the even part of the split, and the tombstones the rest. The same S when
 * the split is not in it or `sizes` does not have one share per shown child - each finite and not
 * negative, adding up to more than 0. `sizes` need not add up to 1: only its proportion is taken,
 * so the `sizes` of a split of S always add up to 1.
 */
export function writeShadowSizes(
	s: ShadowNode | null,
	splitId: string,
	sizes: number[]
): ShadowNode | null {
	if (!s) return s;
	const split = pathTo(s, splitId)?.at(-1);
	if (split?.type !== 'split') return s;
	const shown = split.children.map(isShown);
	const sum = sizes.reduce((a, b) => a + b, 0);
	if (sizes.length !== shown.filter(Boolean).length) return s;
	if (!sizes.every((size) => Number.isFinite(size) && size >= 0)) return s;
	if (!(sum > 0) || !Number.isFinite(sum)) return s;
	let next: number[];
	if (sizes.length === split.children.length) {
		next = sum === 1 ? sizes.slice() : sizes.map((size) => size / sum);
	} else {
		const total = split.sizes.reduce((acc, size, i) => (shown[i] ? acc + size : acc), 0);
		// Nothing to write: with 0 together they show evenly already.
		if (!(total > 0) && sizes.every((size) => size === sizes[0])) return s;
		next = shownShares(split.children, split.sizes, sizes);
	}
	if (next.every((size, i) => size === split.sizes[i])) return s;
	return replaceNode(s, splitId, () => ({ ...split, sizes: next }));
}

/**
 * `tree.ts#resizeSplit` on the projection, written back to S: `dividerIndex` counts the SHOWN
 * children of the split `splitId`, and `deltaFraction` / `MIN_PANE_FRACTION` are fractions of
 * what shows. The same S when the split does not show as a split or the divider is out of range.
 */
export function resizeShadowSplit(
	s: ShadowNode | null,
	splitId: string,
	dividerIndex: number,
	deltaFraction: number
): ShadowNode | null {
	if (!s) return s;
	const before = findNode(projectNode(s), splitId);
	if (before?.type !== 'split') return s;
	const after = resizeSplit(before, splitId, dividerIndex, deltaFraction);
	if (after === before || after?.type !== 'split') return s;
	return writeShadowSizes(s, splitId, after.sizes);
}

/**
 * S with the `sizes` of its split `splitId` as they are in `from`, an S of before (a cancelled
 * divider drag, #782 PR6): the tombstones' shares too, which a write to a split whose shown
 * children had 0 together changed ("Shares of 0" at the top). The same S when the sizes are the
 * same already; `undefined` when the split is not in both with the same children in the same order
 * (the caller then writes what shows only).
 */
export function copyShadowSizes(
	s: ShadowNode | null,
	splitId: string,
	from: ShadowNode | null
): ShadowNode | null | undefined {
	const now = s ? pathTo(s, splitId)?.at(-1) : undefined;
	const then = from ? pathTo(from, splitId)?.at(-1) : undefined;
	if (!s || now?.type !== 'split' || then?.type !== 'split') return undefined;
	if (now.children.length !== then.children.length) return undefined;
	if (!now.children.every((child, i) => child.id === then.children[i].id)) return undefined;
	if (
		now.sizes.length === then.sizes.length &&
		now.sizes.every((size, i) => size === then.sizes[i])
	)
		return s;
	return replaceNode(s, splitId, () => ({ ...now, sizes: then.sizes.slice() }));
}

/**
 * S with a new id (`makeId`) for every split / tab group whose id is in `taken` - the ids of the
 * layout that are not in the docked tree (`core/autohide.ts#idsOutOfDocked`). S keeps a split / tab
 * group that does not show, with its id; while it is out of sight the id is free for the layout (a
 * floating window may take it), so it is checked when a step may show it again (#782 PR6: a layout
 * holds an id once, `validateDockLayout`). The same S when no id is taken.
 */
export function withFreeShadowIds(
	s: ShadowNode | null,
	taken: ReadonlySet<string>,
	makeId: () => string = defaultMakeId
): ShadowNode | null {
	if (s === null || taken.size === 0) return s;
	const free = (node: ShadowNode): ShadowNode => {
		if (node.type === 'panel') return node;
		const base = taken.has(node.id) ? { ...node, id: makeId() } : node;
		if (base.type === 'tabs') return base;
		const children = base.children.map(free);
		return children.some((c, i) => c !== base.children[i]) ? { ...base, children } : base;
	};
	return free(s);
}

/**
 * `docked` without the `collapsed` flags S cannot hold (`writeShadowView`): the flag of a region
 * that is the only child of a split of `s` that shows. `docked` itself when it has none. What
 * `DockState` compares the projection of S with: such a flag lives on the docked tree alone, and
 * is no reason to make S again (#782 PR6).
 */
export function withoutLoneFlags(docked: DockNode | null, s: ShadowNode | null): DockNode | null {
	if (docked === null || s === null) return docked;
	const lone = new Set<string>();
	const visit = (node: ShadowNode): void => {
		if (node.type !== 'split') return;
		const shown = node.children.filter(isShown);
		const only = shown.length === 1 ? projectNode(shown[0]) : null;
		if (only && only.type !== 'split') lone.add(only.id);
		node.children.forEach(visit);
	};
	visit(s);
	if (lone.size === 0) return docked;
	const strip = (node: DockNode): DockNode => {
		if (node.type === 'split') {
			const children = node.children.map(strip);
			return children.some((c, i) => c !== node.children[i]) ? { ...node, children } : node;
		}
		return lone.has(node.id) ? withoutCollapsed(node) : node;
	};
	return strip(docked);
}

// ----- following the docked tree (#782 PR4) ----------------------------------------------------

/** Two shares that are the same but for the last digits (a projection scales `sizes` to add up to 1). */
const SAME_SHARE = 1e-9;

const sameShares = (a: number[], b: number[]): boolean =>
	a.length === b.length && a.every((size, i) => Math.abs(size - b[i]) <= SAME_SHARE);

/**
 * Are two docked trees the same: shape, ids, titles and icons, active tabs, `collapsed` flags, and
 * `sizes` within the last digits? How `DockState` checks that the projection of S is the tree the
 * user sees.
 */
export function sameDocked(a: DockNode | null, b: DockNode | null): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (a.type !== b.type || a.id !== b.id) return false;
	if (a.type === 'panel') {
		const other = b as DockPanelNode;
		return (
			a.title === other.title &&
			a.icon === other.icon &&
			(a.collapsed === true) === (other.collapsed === true)
		);
	}
	const kids = (b as DockSplitNode | DockTabGroupNode).children;
	if (a.children.length !== kids.length) return false;
	if (a.type === 'tabs') {
		const other = b as DockTabGroupNode;
		if (a.activeIndex !== other.activeIndex) return false;
		if ((a.collapsed === true) !== (other.collapsed === true)) return false;
	} else {
		const other = b as DockSplitNode;
		if (a.direction !== other.direction || !sameShares(a.sizes, other.sizes)) return false;
	}
	return a.children.every((child, i) => sameDocked(child, kids[i]));
}

/** A leaf of S as the docked tree shows it: `title` / `icon` of `seen`, the `collapsed` flag as `collapsed` says. */
function leafAs(leaf: ShadowPanelNode, seen: DockPanelNode, collapsed: boolean): ShadowPanelNode {
	if (
		leaf.title === seen.title &&
		leaf.icon === seen.icon &&
		(leaf.collapsed === true) === collapsed
	) {
		return leaf;
	}
	const next: ShadowPanelNode = { ...leaf, title: seen.title };
	if (seen.icon === undefined) delete next.icon;
	else next.icon = seen.icon;
	if (collapsed) next.collapsed = true;
	else delete next.collapsed;
	return next;
}

/** `node` with what `seen` - the node its projection is to be - shows, or `undefined` when their shapes differ. */
function viewOnto(node: ShadowNode, seen: DockNode): ShadowNode | undefined {
	if (node.type === 'panel') {
		if (node.away === true || seen.type !== 'panel' || seen.id !== node.id) return undefined;
		return leafAs(node, seen, seen.collapsed === true);
	}
	if (node.type === 'tabs') {
		const shown = node.children.filter((c) => c.away !== true);
		// With tombstones and one shown tab the group shows as that pane; its flag is the group's.
		if (shown.length === 1 && node.children.length > 1) {
			if (seen.type !== 'panel' || seen.id !== shown[0].id) return undefined;
			const leaf = leafAs(shown[0], seen, false);
			const children = node.children.map((c) => (c === shown[0] ? leaf : c));
			const next: ShadowTabGroupNode = { ...node, children, activeIndex: children.indexOf(leaf) };
			if (seen.collapsed === true) next.collapsed = true;
			else delete next.collapsed;
			return next;
		}
		if (seen.type !== 'tabs' || seen.id !== node.id) return undefined;
		if (seen.children.length !== shown.length) return undefined;
		const byId = new Map(shown.map((c) => [c.id, c]));
		const order: ShadowPanelNode[] = [];
		for (const tab of seen.children) {
			const leaf = byId.get(tab.id);
			if (!leaf) return undefined;
			byId.delete(tab.id);
			order.push(leafAs(leaf, tab, false));
		}
		// The tabs that show take the places of the ones that show, in the order seen; a tombstone
		// keeps its index in S.
		let k = 0;
		const children = node.children.map((c) => (c.away === true ? c : order[k++]));
		const active = order[seen.activeIndex];
		const activeIndex = active ? children.indexOf(active) : node.activeIndex;
		if (
			activeIndex === node.activeIndex &&
			(node.collapsed === true) === (seen.collapsed === true) &&
			children.every((c, i) => c === node.children[i])
		) {
			return node;
		}
		const next: ShadowTabGroupNode = { ...node, children, activeIndex };
		if (seen.collapsed === true) next.collapsed = true;
		else delete next.collapsed;
		return next;
	}
	const shown = node.children.map(isShown);
	const count = shown.filter(Boolean).length;
	if (count === 0) return undefined;
	if (count === 1) {
		// The split shows as its one shown child.
		const at = shown.indexOf(true);
		const child = viewOnto(node.children[at], seen);
		if (child === undefined) return undefined;
		if (child === node.children[at]) return node;
		return { ...node, children: node.children.map((c, i) => (i === at ? child : c)) };
	}
	if (seen.type !== 'split' || seen.id !== node.id || seen.direction !== node.direction) {
		return undefined;
	}
	if (seen.children.length !== count || seen.sizes.length !== count) return undefined;
	let k = 0;
	const children: ShadowNode[] = [];
	for (let i = 0; i < node.children.length; i++) {
		if (!shown[i]) {
			children.push(node.children[i]);
			continue;
		}
		const child = viewOnto(node.children[i], seen.children[k++]);
		if (child === undefined) return undefined;
		children.push(child);
	}
	let sizes = node.sizes;
	if (count === node.children.length) {
		if (!seen.sizes.every((size, i) => size === node.sizes[i])) sizes = seen.sizes.slice();
	} else {
		const now = normalized(node.sizes.filter((_, i) => shown[i]));
		const sum = seen.sizes.reduce((a, b) => a + b, 0);
		const valid = seen.sizes.every((size) => Number.isFinite(size) && size >= 0) && sum > 0;
		if (!valid) return undefined;
		if (!sameShares(now, seen.sizes)) sizes = shownShares(node.children, node.sizes, seen.sizes);
	}
	if (sizes === node.sizes && children.every((c, i) => c === node.children[i])) return node;
	return { ...node, children, sizes };
}

/**
 * S made to show the docked tree `docked`, when `docked` is the projection of S but for what a
 * change that moves no pane in or out sets: a split's `sizes` (a divider dragged, `sizes` put
 * back), a group's active tab and the order of its tabs, the `collapsed` flags, a pane's `title` /
 * `icon`. `undefined` when the shapes differ (another pane, split or nesting) - the caller then
 * has to build S again (`inflateShadow`).
 *
 * The tombstones keep what they have: their share of a split (`writeShadowSizes`' rule, the
 * "Shares of 0" exception included) and their index in a tab group - the tabs that show are put,
 * in the order seen, in the places of the tabs that show. The same S when nothing differs.
 *
 * One thing S cannot hold: the `collapsed` flag of a region that is the only shown child of a
 * split of S (the others are tombstones). `projectShadow` shows that child without its flag, as
 * `tree.ts#collapse` drops it when the split folds - but in the docked tree the region may be
 * collapsed AFTER the fold, beside its new siblings. `undefined` then. Such a flag lives on the
 * docked tree alone (#782 PR6): `DockState` writes the tree without it (`withoutLoneFlags`), so S
 * stays as it is, and carries the flag over the steps it makes on S.
 */
export function writeShadowView(
	s: ShadowNode | null,
	docked: DockNode | null
): ShadowNode | null | undefined {
	if (s === null || docked === null) {
		return docked === null && (s === null || !isShown(s)) ? s : undefined;
	}
	const next = viewOnto(s, docked);
	if (next === undefined) return undefined;
	const settled = next === s ? s : settleCollapsed(next);
	return sameDocked(projectShadow(settled), docked) ? settled : undefined;
}

// ----- an assignment from outside --------------------------------------------------------------

/**
 * S for a docked tree that was assigned from outside (`dock.layout = ...`, #782 PR7): `docked`
 * with the tombstones of `old` - the S before the assignment - put back by the container each
 * was in, and nothing else. No guess is made of what the assignment moved:
 *
 *  - the split / tab group a tombstone was in is still in `docked` (by its id, the same kind and
 *    direction): the tombstone goes into it at the index it had in S (at the end when the
 *    container has fewer children now), with the share it had there; the children that show
 *    share the rest as `docked` has them. Tombstones that had the whole of a split between them
 *    leave the children that show an even part;
 *  - the container did not show as itself before - all its other children were tombstones, so
 *    S showed the one child that was not in its place - and that child (by its id) is still in
 *    `docked`: the container is put around it again, with its id;
 *  - else the pane has no place in S any more: `unplaced` (the caller docks it at its default
 *    place, or not at all).
 *
 * A subtree of `old` with no pane showing is put back as a whole, by the container it was in.
 * `taken`: the ids of the layout that are not in `docked` (an edge band's, a floating window's) -
 * a container is not made again with one of them. The projection of the result is `docked`.
 *
 * `docked` may hold tombstones of its own (#782 PR8b: the tree a layout taken as a whole was saved
 * with, `core/bandTree.ts` - the places of its edge bands): a container of it that does not show
 * takes the tombstones of `old` too, and the result shows what `docked` shows.
 */
export function regraftShadow(
	old: ShadowNode | null,
	docked: ShadowNode | null,
	taken: Iterable<string> = []
): InflatedShadow {
	const away = shadowPanelIds(old, 'away');
	if (old === null || away.length === 0) return { shadow: docked, unplaced: [] };
	if (docked === null)
		return !isShown(old) ? { shadow: old, unplaced: [] } : { shadow: null, unplaced: away };
	interface Unit {
		node: ShadowNode;
		index: number;
		share: number;
	}
	// The subtrees with nothing showing, by the container each is in - outer containers first.
	const groups: { parent: ShadowSplitNode | ShadowTabGroupNode; units: Unit[] }[] = [];
	const collect = (node: ShadowNode): void => {
		if (node.type === 'panel') return;
		const units: Unit[] = [];
		node.children.forEach((child, index) => {
			if (isShown(child)) return;
			units.push({ node: child, index, share: node.type === 'split' ? node.sizes[index] : 0 });
		});
		if (units.length > 0) groups.push({ parent: node, units });
		for (const child of node.children) if (isShown(child)) collect(child);
	};
	if (!isShown(old)) return { shadow: docked, unplaced: away };
	collect(old);
	let s: ShadowNode = docked;
	const used = new Set<string>(taken);
	idsOf(s, used);
	const unplaced: string[] = [];
	const find = (node: ShadowNode, id: string): ShadowNode | null => {
		if (node.id === id) return node;
		if (node.type === 'panel') return null;
		for (const child of node.children) {
			const hit = find(child, id);
			if (hit) return hit;
		}
		return null;
	};
	// Nothing of a subtree put back is in the tree already, and its containers take no id in use
	// (its panes are floating windows: their ids are theirs).
	const inTree = idsOf(s);
	const free = (node: ShadowNode): boolean =>
		!inTree.has(node.id) &&
		(node.type === 'panel' || (!used.has(node.id) && node.children.every(free)));
	const sameKind = (a: ShadowNode, b: ShadowNode): boolean =>
		a.type === b.type && (a.type !== 'split' || a.direction === (b as ShadowSplitNode).direction);
	for (const { parent, units } of groups) {
		let host = find(s, parent.id);
		const kind = (u: Unit): boolean => parent.type === 'split' || u.node.type === 'panel';
		if (host === null && !used.has(parent.id) && units.some((u) => kind(u) && free(u.node))) {
			// The container showed as its one child that was in place: around that child again.
			const shown = parent.children.filter(isShown);
			const was = shown.length === 1 ? projectShadow(shown[0]) : null;
			const now = was ? find(s, was.id) : null;
			// A tab of a group cannot hold a container: the group would not be one any more.
			if (now && (parent.type === 'split' || now.type === 'panel') && !tabOf(s, now.id)) {
				// A tab group shows as its one tab: the band flag of that tab is the group's then. A
				// split has no flag (`settleCollapsed` drops the one of its only child showing: S cannot
				// hold it, and `DockState` keeps it on the docked tree).
				const bare = { ...parent };
				delete (bare as { collapsed?: boolean }).collapsed;
				const around: ShadowNode =
					bare.type === 'split'
						? { ...bare, children: [now], sizes: [1] }
						: {
								...bare,
								children: [withoutCollapsed(now as ShadowPanelNode)],
								activeIndex: 0,
								...(now.type === 'panel' && now.collapsed === true ? { collapsed: true } : {})
							};
				s = replaceNode(s, now.id, () => around);
				used.add(parent.id);
				host = around;
			}
		}
		const fits = units.filter(
			(u) =>
				host !== null &&
				sameKind(host, parent) &&
				(host.type === 'split' || u.node.type === 'panel') &&
				free(u.node)
		);
		for (const u of units) if (!fits.includes(u)) unplaced.push(...shadowPanelIds(u.node));
		if (host === null || host.type === 'panel' || fits.length === 0) continue;
		for (const u of fits) {
			idsOf(u.node, used);
			idsOf(u.node, inTree);
		}
		if (host.type === 'tabs') {
			const children = [...host.children];
			let activeIndex = host.activeIndex;
			for (const u of fits) {
				const at = Math.min(u.index, children.length);
				children.splice(at, 0, u.node as ShadowPanelNode);
				if (at <= activeIndex) activeIndex++;
			}
			const group: ShadowTabGroupNode = { ...host, children, activeIndex };
			s = replaceNode(s, host.id, () => group);
			continue;
		}
		// The tombstones keep the share they had; the children that show share the rest as they
		// are. Shares that leave nothing for them give every child an even part.
		const said = fits.map((u) => (Number.isFinite(u.share) && u.share > 0 ? u.share : 0));
		const total = said.reduce((a, b) => a + b, 0);
		const count = host.children.length + fits.length;
		// A share of 0 is one ("Shares of 0" at the top): it does not unsettle the others.
		const sound = total < 1 - 1e-9;
		const room = sound ? 1 - total : host.children.length / count;
		const shares = sound
			? said
			: said.map((x) => (total > 0 ? (x / total) * (1 - room) : (1 - room) / fits.length));
		const mine = normalized(host.sizes);
		const children = [...host.children];
		const sizes = mine.map((x) => x * room);
		fits.forEach((u, k) => {
			const at = Math.min(u.index, children.length);
			children.splice(at, 0, u.node);
			sizes.splice(at, 0, shares[k]);
		});
		const split: ShadowSplitNode = { ...host, children, sizes };
		s = replaceNode(s, host.id, () => split);
	}
	return { shadow: settleCollapsed(s), unplaced };
}

/** Is the node `id` a tab of a tab group of `root`? */
function tabOf(root: ShadowNode, id: string): boolean {
	if (root.type === 'panel') return false;
	if (root.type === 'tabs') return root.children.some((c) => c.id === id);
	return root.children.some((c) => tabOf(c, id));
}

// ----- the saved form: slots -------------------------------------------------------------------

/** A pane that is out of the dock (hidden, or floated) and the docked place it goes back to. */
export interface ShadowAway {
	/** The pane as a docked leaf. Only `id`, `title` and `icon` are read. */
	panel: DockPanelNode;
	slot: DockSlot;
}

/** What `deflateShadow` makes of S: the two things a saved layout holds. */
export interface DeflatedShadow {
	/** The docked tree the user sees (`projectShadow`). */
	docked: DockNode | null;
	/** One entry per tombstone of S, in tree order. */
	away: ShadowAway[];
}

/** What `inflateShadow` makes of a docked tree and the slots of the panes out of it. */
export interface InflatedShadow {
	/** S: its projection is the docked tree given, and every pane that was placed is a tombstone in it. */
	shadow: ShadowNode | null;
	/** The panes whose slot names no place in this tree (ids, in the order given): they have no docked place. */
	unplaced: string[];
}

function clamp01(x: number): number {
	return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** Ids next to `index` in `ids`, nearest first, the one after before the one before (`slot.ts#byDistance`: a tab slot's `anchors`). */
function byDistance(ids: string[], index: number): string[] {
	const out: string[] = [];
	for (let d = 1; d < ids.length; d++) {
		if (index + d < ids.length) out.push(ids[index + d]);
		if (index - d >= 0) out.push(ids[index - d]);
	}
	return out;
}

/** The slot of child `index` of `parent` in S, in the form `slot.ts` writes (`splitSlotAt`), with every pane of S counted. */
function slotIn(
	parent: ShadowSplitNode | ShadowTabGroupNode,
	index: number,
	outer: DockSlot | undefined
): DockSlot {
	if (parent.type === 'tabs') {
		const ids = parent.children.map((c) => c.id);
		return {
			kind: 'tab',
			groupId: parent.id,
			index,
			anchors: byDistance(ids, index),
			...(outer ? { outer } : {})
		};
	}
	const hasNext = index + 1 < parent.children.length;
	const next = parent.children.slice(index + 1).flatMap((c) => shadowPanelIds(c));
	const prev = parent.children
		.slice(0, index)
		.reverse()
		.flatMap((c) => shadowPanelIds(c).reverse());
	// `share`: of the whole split, as S has it. `size`: of what shows with it (what `slot.ts` reads
	// when there is no `share`). A share of 0 cannot be written as `share` (`validate.ts` wants it
	// above 0): it is left out, and `size` - 0 then - says it.
	const own = parent.sizes[index] ?? 0;
	const shown = parent.sizes.reduce(
		(acc, size, i) => (i !== index && isShown(parent.children[i]) ? acc + size : acc),
		0
	);
	return {
		kind: 'split',
		splitId: parent.id,
		direction: parent.direction,
		index,
		neighborId: parent.children[hasNext ? index + 1 : index - 1].id,
		side: hasNext ? 'before' : 'after',
		size: clamp01(own + shown > 0 ? own / (own + shown) : own),
		...(own > 0 && Number.isFinite(own) ? { share: Math.min(own, 1) } : {}),
		anchors: hasNext ? next : prev,
		...(hasNext && prev.length > 0 ? { otherAnchors: prev } : {}),
		...(outer ? { outer } : {})
	};
}

/** The slot of the leaf at the end of `path` (the nodes from the root of S down to it). */
function slotOfPath(path: ShadowNode[]): DockSlot {
	// Nearest first, as many containers as a slot may name. The root is named when there is room.
	const above = path.length - 1;
	const levels = Math.min(above, MAX_SLOT_DEPTH);
	let slot: DockSlot | undefined = above < MAX_SLOT_DEPTH ? { kind: 'root' } : undefined;
	for (let k = path.length - levels; k < path.length; k++) {
		const parent = path[k - 1] as ShadowSplitNode | ShadowTabGroupNode;
		slot = slotIn(parent, (parent.children as ShadowNode[]).indexOf(path[k]), slot);
	}
	return slot ?? { kind: 'root' };
}

/**
 * S as a layout is saved (#782 PR3): the docked tree the user sees, and for every tombstone the
 * pane and the `DockSlot` of its place - what `FloatingWindow.dockSlot` holds. The inverse is
 * `inflateShadow`.
 *
 * A slot is in the form `slot.ts` writes, read off S alone:
 *
 *  - a level for every split / tab group above the tombstone (`outer`, nearest first), ending
 *    with `root`, named by the ids of S;
 *  - `index` is the place among ALL the children of S, and `share` the share of the whole split
 *    as S has it (a share of 0 is written as `size: 0` without `share`);
 *  - `neighborId` is the next child of S (the one before for the last child), `anchors` /
 *    `otherAnchors` every pane on that side / the other side, nearest first - the panes away
 *    included. A tab slot's `anchors` are all the other tabs of S, by distance.
 *
 * So the slot of a tombstone does not depend on what else shows, but for `size` (its share of what
 * shows with it): hiding and showing other panes does not change it.
 *
 * What a slot cannot say, and so does not come back from `inflateShadow`:
 *  - the active tab of a group none of whose tabs show (it is the first tab then; a tab that
 *    comes back is made the active one anyway);
 *  - the place of a tombstone more than `MAX_SLOT_DEPTH` containers deep, when no container the
 *    slot still names can be found by its id or by a pane of it: the pane is `unplaced` then;
 *  - a tab group of one tab (a saved layout may hold one) whose tab is away: the tombstone comes
 *    back without the group (a slot cannot tell it from a group that lost its other tabs;
 *    `slot.ts` gives the pane back without a group too);
 *  - last digits of `sizes` (the projection's sizes are scaled to 1 and scaled back).
 */
export function deflateShadow(s: ShadowNode | null): DeflatedShadow {
	const away: ShadowAway[] = [];
	const walk = (node: ShadowNode, path: ShadowNode[]): void => {
		const here = [...path, node];
		if (node.type !== 'panel') return node.children.forEach((c) => walk(c, here));
		if (node.away === true) away.push({ panel: shownLeaf(node), slot: slotOfPath(here) });
	};
	if (s !== null) walk(s, []);
	return { docked: projectShadow(s), away };
}

/** A node of the tree `inflateShadow` builds. Changed in place; `finishWork` makes S of it. */
type Work = WorkLeaf | WorkBox;

interface WorkLeaf {
	box: false;
	id: string;
	node: ShadowPanelNode;
}

interface WorkBox {
	box: true;
	id: string;
	tabs: boolean;
	direction?: 'row' | 'column';
	children: Work[];
	/** The docked node it was made of (none for a container made again from a slot). */
	src?: DockSplitNode | DockTabGroupNode;
	/** A split: the size each child that shows has in the docked tree. */
	weights: Map<Work, number>;
	/** A tab group: the id of the active tab. */
	active?: string;
	collapsed?: boolean;
	/** A child was added, or it was made from a slot. */
	touched: boolean;
}

/** One container a slot names: the slot itself, or one of its `outer` chain. */
interface SlotLevel {
	id: string;
	tabs: boolean;
	direction?: 'row' | 'column';
	/** Every pane the slot says is in this container: the pane itself and the names of the levels up to here. */
	panels: Set<string>;
}

/** The place and share in S a slot gives the child of a container that holds the slot's pane. */
interface SlotRecord {
	index: number;
	share?: number;
	/**
	 * What the slot names beside the child, nearest first, and whether the child goes before it: in
	 * a split the old neighbour, then the anchors of either side (`slot.ts#restoreSplit`'s
	 * candidates); in a tab group the anchors, each on its old side (`slot.ts#tabIndex`).
	 */
	near?: { id: string; before: boolean }[];
}

/** The anchors of a tab slot with the side each was on: the other tabs by distance, the one after first (`slot.ts#wasBefore`). */
function nearTabs(slot: Extract<DockSlot, { kind: 'tab' }>): { id: string; before: boolean }[] {
	const count = slot.anchors.length + 1;
	const index = Math.min(Math.max(slot.index, 0), count - 1);
	const out: { id: string; before: boolean }[] = [];
	for (let d = 1; d < count; d++) {
		if (index + d < count) out.push({ id: slot.anchors[out.length], before: true });
		if (index - d >= 0) out.push({ id: slot.anchors[out.length], before: false });
	}
	return out;
}

/** The neighbour and the anchors of a split slot, nearest first (`slot.ts#splitAnchors`). */
function nearOf(slot: Extract<DockSlot, { kind: 'split' }>): { id: string; before: boolean }[] {
	const before = slot.side === 'before';
	const others = slot.otherAnchors ?? [];
	const out = [{ id: slot.neighborId, before }];
	for (let d = 0; d < Math.max(slot.anchors.length, others.length); d++) {
		if (d < slot.anchors.length) out.push({ id: slot.anchors[d], before });
		if (d < others.length) out.push({ id: others[d], before: !before });
	}
	return out;
}

function workOf(node: DockNode): Work {
	if (node.type === 'panel') return { box: false, id: node.id, node };
	const children = node.children.map(workOf);
	const weights = new Map<Work, number>();
	if (node.type === 'split') children.forEach((c, i) => weights.set(c, node.sizes[i] ?? 0));
	return {
		box: true,
		id: node.id,
		tabs: node.type === 'tabs',
		...(node.type === 'split' ? { direction: node.direction } : {}),
		children,
		src: node,
		weights,
		...(node.type === 'tabs' ? { active: node.children[node.activeIndex]?.id } : {}),
		touched: false
	};
}

function workLeaves(work: Work): WorkLeaf[] {
	return work.box ? work.children.flatMap(workLeaves) : [work];
}

function findWork(root: Work, id: string): Work | null {
	if (root.id === id) return root;
	if (!root.box) return null;
	for (const child of root.children) {
		const found = findWork(child, id);
		if (found) return found;
	}
	return null;
}

function workParent(root: Work, node: Work): WorkBox | null {
	if (!root.box) return null;
	if (root.children.includes(node)) return root;
	for (const child of root.children) {
		const found = workParent(child, node);
		if (found) return found;
	}
	return null;
}

/** The node whose panes are exactly `panels` (a container has two or more children, so at most one node). */
function workWithPanels(root: Work, panels: Set<string>): Work | null {
	const leaves = workLeaves(root);
	if (leaves.length < panels.size) return null;
	if (leaves.length === panels.size) return leaves.every((l) => panels.has(l.id)) ? root : null;
	if (!root.box) return null;
	for (const child of root.children) {
		const found = workWithPanels(child, panels);
		if (found) return found;
	}
	return null;
}

function slotLevels(
	paneId: string,
	slot: DockSlot
): { levels: SlotLevel[]; records: SlotRecord[] } {
	const levels: SlotLevel[] = [];
	const records: SlotRecord[] = [];
	const seen = new Set<string>();
	const names = new Set<string>([paneId]);
	for (let s: DockSlot | undefined = slot; s && s.kind !== 'root'; s = s.outer) {
		const id = s.kind === 'tab' ? s.groupId : s.splitId;
		// A tab group is never around a container; a chain that names a container twice ends there.
		if (seen.has(id) || (s.kind === 'tab' && levels.length > 0)) break;
		seen.add(id);
		s.anchors.forEach((a) => names.add(a));
		if (s.kind === 'split') {
			names.add(s.neighborId);
			s.otherAnchors?.forEach((a) => names.add(a));
		}
		levels.push({
			id,
			tabs: s.kind === 'tab',
			...(s.kind === 'split' ? { direction: s.direction } : {}),
			panels: new Set(names)
		});
		records.push({
			index: s.index,
			...(s.kind === 'split'
				? { share: s.share ?? s.size, near: nearOf(s) }
				: { near: nearTabs(s) })
		});
	}
	return { levels, records };
}

/**
 * Put the tombstone `leaf` into the tree at the place its slot names (`levels`, nearest first).
 * The tree is S cut down to the panes it has so far, so the container of a level is in it by its
 * id (it shows two or more children, or was made again already), or as the one node that holds
 * exactly the panes of it that are in the tree (it is made again around that node), or not at all
 * (none of its panes is here yet: the tombstone then stands for it one level up). A name of the
 * slot that is a container of the tree (`neighborId` may be one) stands for the panes in it.
 * `false` when no level fits; nothing is changed then.
 */
function placeTombstone(
	state: { root: Work | null },
	leaf: WorkLeaf,
	levels: SlotLevel[],
	reserved: Set<string>
): boolean {
	const root = state.root;
	if (root === null) {
		state.root = leaf;
		return true;
	}
	const present = new Set(workLeaves(root).map((l) => l.id));
	for (const level of levels) {
		const found = findWork(root, level.id);
		if (found?.box && found.tabs === level.tabs && found.direction === level.direction) {
			found.children.push(leaf);
			found.touched = true;
			return true;
		}
		const here = new Set<string>();
		for (const id of level.panels) {
			if (present.has(id)) here.add(id);
			else if (id !== level.id) {
				// Not a pane: the split / tab group the slot names as the neighbour, when it is here.
				const named = findWork(root, id);
				if (named?.box) workLeaves(named).forEach((l) => here.add(l.id));
			}
		}
		if (here.size === 0) continue;
		// The id is in use for something else: not the tree this slot was taken in.
		if (found || reserved.has(level.id)) return false;
		const at = workWithPanels(root, here);
		if (at === null) return false;
		const parent = workParent(root, at);
		if (parent?.tabs) return false;
		if (level.tabs && at.box) {
			// The group's id is gone but its tabs are a group: one more tab of it.
			if (!at.tabs) return false;
			at.children.push(leaf);
			at.touched = true;
			return true;
		}
		const made: WorkBox = {
			box: true,
			id: level.id,
			tabs: level.tabs,
			...(level.tabs ? {} : { direction: level.direction }),
			children: [at, leaf],
			weights: new Map(),
			touched: true
		};
		if (level.tabs && !at.box) {
			// A group shown as its one tab: the band flag of the pane is the group's.
			if (at.node.away !== true) made.active = at.id;
			if (at.node.collapsed === true) made.collapsed = true;
			at.node = withoutCollapsed(at.node);
		}
		if (parent === null) state.root = made;
		else {
			parent.children[parent.children.indexOf(at)] = made;
			const weight = parent.weights.get(at);
			parent.weights.delete(at);
			if (weight !== undefined) parent.weights.set(made, weight);
		}
		return true;
	}
	return false;
}

/** S of the tree `inflateShadow` built: the children in their order of S, the sizes of S. */
function finishWork(work: Work, records: Map<string, Map<string, SlotRecord>>): ShadowNode {
	if (!work.box) return work.node;
	const nodes = new Map(work.children.map((c) => [c, finishWork(c, records)]));
	if (!work.touched && work.src) {
		const children = work.children.map((c) => nodes.get(c)!);
		if (children.every((c, i) => c === work.src!.children[i])) return work.src;
		return { ...work.src, children } as ShadowNode;
	}
	// A child none of whose panes show is at the index its slots say; the ones that show keep
	// their order and fill the places between. The slots of one S say the same of a child whichever
	// pane of it is asked. Slots that differ (`slot.ts` takes one when a pane is hidden, and the
	// split may be resized before the next pane of the container goes): the one given last counts,
	// as in `slot.ts#splitPending` (the most recent slot of a container).
	const of = records.get(work.id);
	const entries = work.children.map((child) => {
		const leaves = workLeaves(child);
		const shown = leaves.some((l) => l.node.away !== true);
		let record: SlotRecord | undefined;
		if (!shown && of) {
			const ids = new Set(leaves.map((l) => l.id));
			for (const [id, said] of of) if (ids.has(id)) record = said;
		}
		return { child, shown, record };
	});
	const fixed = entries
		.filter((e) => e.record !== undefined)
		.sort((a, b) => a.record!.index - b.record!.index);
	const byIndex = [...fixed];
	const free = entries.filter((e) => e.record === undefined);
	const ordered: typeof entries = [];
	while (fixed.length + free.length > 0) {
		const next =
			fixed.length > 0 && (free.length === 0 || fixed[0].record!.index <= ordered.length)
				? fixed.shift()!
				: free.shift()!;
		ordered.push(next);
	}
	// The index only counts when the slot names nothing that is here: as `slot.ts#restoreSplit`
	// in a split still there and `slot.ts#tabIndex` in a tab group, such a child goes beside the
	// nearest one its slot names (the old neighbour, the anchors by distance) among the ones that show
	// and the ones placed before it (lower index). For the slots of one S that is the place the
	// index says. It is another one when the children that show were put in another order since
	// the slot was taken (`slot.ts` keeps the slot of a hidden pane as it was).
	const settled = new Set(entries.filter((e) => e.record === undefined));
	for (const entry of byIndex) {
		for (const c of entry.record!.near ?? []) {
			const beside = ordered.find((e) => settled.has(e) && findWork(e.child, c.id) !== null);
			if (beside === undefined) continue;
			ordered.splice(ordered.indexOf(entry), 1);
			const n = ordered.indexOf(beside);
			ordered.splice(c.before ? n : n + 1, 0, entry);
			break;
		}
		settled.add(entry);
	}
	if (work.tabs) {
		const children = ordered.map((e) => nodes.get(e.child) as ShadowPanelNode);
		const at = children.findIndex((c) => c.id === work.active);
		const activeIndex = shownActive(children, Math.max(at, 0));
		if (work.src) return { ...(work.src as DockTabGroupNode), children, activeIndex };
		return {
			type: 'tabs',
			id: work.id,
			children,
			activeIndex,
			...(work.collapsed === true ? { collapsed: true } : {})
		};
	}
	// The children that do not show have the share their slots say (one without takes the mean of
	// the others, or an even part); the ones that show share the rest as the docked tree has them.
	const usable = (x: number | undefined): x is number =>
		x !== undefined && Number.isFinite(x) && x >= 0;
	const hidden = ordered.filter((e) => !e.shown);
	const said = hidden.map((e) => e.record?.share);
	const known = said.filter(usable);
	const guess =
		known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1 / ordered.length;
	let shares = said.map((x) => (usable(x) ? x : guess));
	let total = shares.reduce((a, b) => a + b, 0);
	const scaleTo = (target: number): void => {
		shares = shares.map((x) => (total > 0 ? (x * target) / total : target / shares.length));
		total = target;
	};
	const weights = ordered.filter((e) => e.shown).map((e) => work.weights.get(e.child) ?? 0);
	const weight = weights.reduce((a, b) => a + b, 0);
	if (weights.length === 0) scaleTo(1);
	else if (total > 1) scaleTo(1);
	// Nothing left for the children that show: right only when they show evenly (shares of 0, see
	// the top). Else the slots are not of this tree, and every child takes an even part.
	if (
		weights.length > 0 &&
		!(1 - total > 0) &&
		weights.some((x) => Math.abs(x - weights[0]) > 1e-9)
	) {
		scaleTo(hidden.length / ordered.length);
	}
	const room = Math.max(1 - total, 0);
	let h = 0;
	let k = 0;
	const sizes = ordered.map((e) =>
		e.shown ? (weight > 0 ? (room * weights[k++]) / weight : room / weights.length) : shares[h++]
	);
	const children = ordered.map((e) => nodes.get(e.child)!);
	if (work.src) return { ...(work.src as DockSplitNode), children, sizes };
	return { type: 'split', id: work.id, direction: work.direction!, children, sizes };
}

/**
 * S of a layout as it is saved (#782 PR3): the docked tree, and the panes out of it with the
 * `DockSlot` each remembers (`away`: the closed windows with a `dockSlot`, the floated panes with
 * a place to go back to). Every pane whose slot names a place in this tree becomes a tombstone
 * there; the others are `unplaced` (no docked place: `show` opens such a pane floating). The
 * inverse of `deflateShadow`, and whatever the slots are:
 *
 *  - the projection of the result is `docked` (shape, ids, active tabs, sizes), but for a band
 *    flag (`collapsed`) on a region that is now the only child showing of a split made again -
 *    S has no such flag (see `settleCollapsed`) - and for a tab group of one tab in `docked` that
 *    a slot puts a tombstone into: it shows as the pane then (`projectShadow`);
 *  - the order of `away` does not matter when the slots are of one S. Slots `slot.ts` took at
 *    different times may say different things of one place: there `away` is read as the order
 *    the panes left in, and the last one counts (below);
 *  - with no pane to place the result is `docked` itself.
 *
 * A slot is read level by level, nearest first (the slot, then its `outer` chain). The container
 * of a level is looked for by its id (same kind and direction); else as the one node holding
 * exactly the panes the slot names for it that are in the tree, and it is made again around that
 * node with the slot's id; else, when none of its panes is in the tree, one level up, where the
 * tombstone stands for it until another one of it comes. So a split / tab group that was folded
 * away when its panes left is in S again, however deep (the known failure 6 of #782). No id is
 * made up: a container whose id is in use by something else is not made again. A name that is
 * a split / tab group of the tree (a `neighborId` may be one, and older JSON has such a slot with
 * no `anchors`) stands for the panes in it: the pane goes beside that container, left whole.
 *
 * In a container, a child that does not show goes to the `index` its slot says, among the ones
 * that show in their order; beside the nearest child its slot names (a split's neighbour, then
 * the anchors) when one is there - the same place for the slots of one S, and the one
 * `slot.ts#restoreSplit` / `restoreTab` take when the children were put in another order since
 * (`DockState` does not touch the slot of a hidden pane when a tab is moved). In a split it
 * has the `share` its slot says (`size` for a slot without), and the children that show share the
 * rest in the proportion of the docked tree. A child with several panes, none showing, is read
 * from the slot given last among theirs (`slot.ts#splitPending`: the most recent slot of a
 * container - the share after the last resize).
 *
 * A slot that fits nowhere - a `root` slot once something is docked, panes it names scattered
 * over other containers, an id in use - is not guessed at ("beside the nearest anchor" in another
 * container, as `slot.ts#restoreDockSlot` does). An entry for a pane that is docked, or a second entry for a
 * pane, is ignored.
 *
 * `taken` (#782 PR6): the ids of the layout that are not in `docked` - the regions in the edge
 * bands with their panes, the floating windows (`core/autohide.ts#idsOutOfDocked`). They are in
 * use: a tab group that went to a band with its id is not made again in S around a tab left docked
 * (the pane out of it is `unplaced`), or the layout would hold the id twice once that pane is back.
 */
export function inflateShadow(
	docked: DockNode | null,
	away: Iterable<ShadowAway>,
	taken: Iterable<string> = []
): InflatedShadow {
	const dockedIds = new Set(docked ? shadowPanelIds(docked) : []);
	const entries: { leaf: WorkLeaf; levels: SlotLevel[] }[] = [];
	const records = new Map<string, Map<string, SlotRecord>>();
	const reserved = new Set<string>();
	for (const { panel, slot } of away) {
		if (dockedIds.has(panel.id) || reserved.has(panel.id)) continue;
		reserved.add(panel.id);
		const { levels, records: said } = slotLevels(panel.id, slot);
		levels.forEach((level, i) => {
			const of = records.get(level.id) ?? new Map<string, SlotRecord>();
			of.set(panel.id, said[i]);
			records.set(level.id, of);
		});
		entries.push({
			leaf: { box: false, id: panel.id, node: { ...shownLeaf(panel), away: true } },
			levels
		});
	}
	if (entries.length === 0) return { shadow: docked, unplaced: [] };
	// In use by something else of the layout: a container is not made again with such an id.
	for (const id of taken) reserved.add(id);
	const state = { root: docked ? workOf(docked) : null };
	// A slot may fit only once another pane is in (its chain was cut short, or the panes it names
	// are away themselves).
	let pending = entries;
	for (let placed = true; placed && pending.length > 0;) {
		placed = false;
		const rest: typeof entries = [];
		for (const entry of pending) {
			if (placeTombstone(state, entry.leaf, entry.levels, reserved)) placed = true;
			else rest.push(entry);
		}
		pending = rest;
	}
	return {
		shadow: settleCollapsed(state.root ? finishWork(state.root, records) : null),
		unplaced: pending.map((e) => e.leaf.id)
	};
}
