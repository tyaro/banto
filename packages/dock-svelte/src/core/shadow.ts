/**
 * The shadow tree S of the docked layout (Issue #782 PR2; downstream-requests-2026-11-plan §4.11,
 * property tests per ADR-0033). Pure functions only, no Svelte imports, like `tree.ts`: every
 * function returns a NEW tree (or the same object when nothing changes) and never mutates its
 * input. Nothing uses this module yet - `DockState` is wired to it from #782 PR4 on.
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
 *    that still holds a tombstone never folds.
 *  - A drop is made against what the user sees, so its target is named by an id of the
 *    projection. `dockIntoShadow` maps it to S by the decision of #780: a drop at a side acts on
 *    the OUTERMOST node of S whose projection is exactly the target, found BEFORE the moved pane
 *    is taken out; a drop at the center (a tab) acts on the target's tab group / leaf itself.
 *  - A resize of a shown split is written back to the shown children only
 *    (`writeShadowSizes` / `resizeShadowSplit`); the tombstones keep their share of S.
 *
 * Ids of new split / tab group nodes come from an injected `makeId`, as in `tree.ts`.
 */
import type {
	DockEdge,
	DockNode,
	DockPanelNode,
	DockSplitNode,
	DockTabGroupNode,
	DropRegion
} from '../types';
import {
	EDGE_DOCK_RATIO,
	defaultMakeId,
	findNode,
	findParent,
	normalizeCollapsed,
	resizeSplit
} from './tree';

/** A leaf of S: a docked pane, or - with `away` - the place of a pane that is hidden or floated (a tombstone). */
export interface ShadowPanelNode extends DockPanelNode {
	/** Written only when `true`. A tombstone is never `collapsed`. */
	away?: true;
}

/** A tab group of S. `activeIndex` counts every child of S and points at a shown one whenever one shows. */
export interface ShadowTabGroupNode extends Omit<DockTabGroupNode, 'children'> {
	children: ShadowPanelNode[];
}

/** A split of S. `sizes` has one share per child of S (tombstones included) and adds up to 1. */
export interface ShadowSplitNode extends Omit<DockSplitNode, 'children'> {
	children: ShadowNode[];
}

/** A node of the shadow tree. A `DockNode` is a `ShadowNode` with no tombstone in it. */
export type ShadowNode = ShadowPanelNode | ShadowTabGroupNode | ShadowSplitNode;

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
		if (shown.length === 1) {
			return node.collapsed === true ? { ...shown[0], collapsed: true } : shown[0];
		}
		if (shown.length === node.children.length) return node;
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
 * The docked tree the user sees: S without its tombstones. A tab group with one shown tab shows
 * as that pane, a split with one shown child as that child (not flattened into a split around it,
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
	if (!s) return s;
	const path = pathTo(s, panelId);
	const leaf = path?.at(-1);
	if (!path || leaf?.type !== 'panel' || leaf.away === true) return s;
	const gone: ShadowPanelNode = { ...withoutCollapsed(leaf), away: true };
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

function anchorOf(s: ShadowNode, targetId: string, movedId: string): Anchor | null {
	const visible = projectNode(s);
	if (visible === null) return null;
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
	panel: ShadowPanelNode,
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
 *  - A target that does not show (a stale id, or the moved pane itself) falls back to the first
 *    shown leaf, as `tree.ts#resolveTarget` does. When nothing shows at all, S as a whole is
 *    wrapped half / half with the pane at that side (`center` = `right`); an empty S becomes the pane.
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
	const held = s ? anchorOf(s, targetId, panel.id) : null;
	const rest = s ? removeNode(s, panel.id) : null;
	if (rest === null) return panel;
	const visible = projectNode(rest);
	if (visible === null) {
		return wrap(rest, panel, region === 'center' ? 'right' : region, 0.5, makeId);
	}
	let anchor = held;
	if (anchor === null) {
		let first = visible;
		while (first.type === 'split') first = first.children[0];
		anchor = anchorOf(rest, first.id, panel.id)!;
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
		const sizes = parent.sizes.slice();
		sizes.splice(index, 0, 0);
		const next = { ...parent, children, sizes: evenAmongShown(children, sizes) };
		return settleCollapsed(replaceNode(rest, parent.id, () => next))!;
	}
	const split = wrap(target, panel, region, 0.5, makeId);
	return settleCollapsed(replaceNode(rest, target.id, () => split))!;
}

/** `sizes` with the shown children sharing evenly what they have together; the others keep theirs. */
function evenAmongShown(children: ShadowNode[], sizes: number[]): number[] {
	const shown = children.map(isShown);
	const count = shown.filter(Boolean).length;
	if (count === children.length) return evenSizes(count);
	const total = sizes.reduce((sum, size, i) => (shown[i] ? sum + size : sum), 0);
	if (!(total > 0)) return evenSizes(children.length);
	return sizes.map((size, i) => (shown[i] ? total / count : size));
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

// ----- sizes ---------------------------------------------------------------------------------

/**
 * Write the sizes of a split as the user sees it back to S: `sizes` has one share per SHOWN child
 * of the split `splitId` (the `sizes` of that split in the projection). The shown children share
 * what they have together in S in that proportion; the tombstones keep their share, so a pane that
 * comes back takes the same part of the split as before. The same S when the split is not in it or
 * `sizes` does not have one positive-sum share per shown child.
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
	if (sizes.length !== shown.filter(Boolean).length || !(sum > 0)) return s;
	let next: number[];
	if (sizes.length === split.children.length) {
		next = sizes.slice();
	} else {
		const total = split.sizes.reduce((acc, size, i) => (shown[i] ? acc + size : acc), 0);
		let k = 0;
		next = split.sizes.map((size, i) => (shown[i] ? (sizes[k++] / sum) * total : size));
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
