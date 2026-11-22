/**
 * Where a pane hidden from the docked tree comes back (#782 PR5): its place in the DEFAULT layout,
 * not the place it was hidden from. Pure functions over the docked tree (`core/tree.ts`).
 *
 * The default layout's docked tree `defaults` says where every pane belongs. A pane shown again
 * goes, in this order:
 *
 *  1. beside the nearest pane that is docked now, in the order of the default tree. The containers
 *     of the pane in `defaults` are tried from the innermost out; in the first one that has another
 *     child with a docked pane, the nearest such child is taken (by index; of two as near, the one
 *     before). A tab group: the pane joins that tab's group, on its default side of the tab.
 *     A split: the pane goes on its default side of what that child is now (`joinSplit`);
 *  2. along the outer edge its default place is at (`defaultEdge`: the first / last child of a
 *     split, innermost first - `ThreePaneDock`'s left pane on the left, a panel with an `initial`
 *     edge on that edge), when no pane of the default tree is docked;
 *  3. nowhere in the tree (`null`: the caller opens it floating) - no default layout, a pane the
 *     default tree does not hold (hidden or floating by default), or no edge to go to.
 *
 * Panes of a default tree that were only hidden come back to the default shape whatever the order
 * they are shown in: the tree is, at every step, the default tree without the panes still hidden
 * (`tests/default-place.test.ts`). This needs the default tree's split / tab group ids to be
 * distinct: a split made here takes the id of the default container it stands for (when free), and
 * a pane is not spliced into a split that stands for another default container. Once panes were
 * moved by hand the result is a place beside the nearest default sibling, nothing more.
 *
 * The size: `share` (what the pane held of its split when it was hidden, `dockShareOf`) of the
 * split it lands in, the others keeping their ratio; without one (`1`, not finite, out of `[0, 1)`)
 * its default share against the default siblings docked now.
 */
import type { DockEdge, DockNode, DockPanelNode, DockSplitNode, DockTabGroupNode } from '../types';
import {
	collectPanelIds,
	defaultMakeId,
	dockPanelAtEdge,
	dockPanelIntoTree,
	findNode,
	findParent,
	moveTabWithinGroup,
	replaceNodeById,
	splitInsert
} from './tree';

type Container = DockSplitNode | DockTabGroupNode;
interface Step {
	container: Container;
	index: number;
}

/** The containers of the panel `id` in `node`, outermost first, with the index of the child that holds it; `null` = not in it. */
function pathTo(node: DockNode, id: string): Step[] | null {
	if (node.type === 'panel') return node.id === id ? [] : null;
	for (let index = 0; index < node.children.length; index++) {
		const rest = pathTo(node.children[index], id);
		if (rest) return [{ container: node, index }, ...rest];
	}
	return null;
}

/** A share to take as it is: `0` too (a split may hold one, #782 PR2), not `1` ("none to speak of"). */
const usable = (share: number | undefined): share is number =>
	share !== undefined && Number.isFinite(share) && share >= 0 && share < 1;

/**
 * The share the docked pane `panelId` holds of its split (its tab group's, for a tab), `0 <= n <= 1`:
 * what a closed window keeps as `FloatingWindow.dockShare` when the pane is hidden. `0` is a share
 * like any other (cross-review of PR #863: hidden and shown again, the pane is at `0` again). `1` =
 * no split around it (the root, an unknown id), sizes that say nothing (all `0`, not finite) - or
 * the whole of its split, which comes back the same way: by its default share.
 */
export function dockShareOf(docked: DockNode | null, panelId: string): number {
	const group = findParent(docked, panelId);
	const regionId = group?.type === 'tabs' ? group.id : panelId;
	const split = findParent(docked, regionId);
	if (split?.type !== 'split') return 1;
	const index = split.children.findIndex((c) => c.id === regionId);
	const total = split.sizes.reduce((a, b) => a + b, 0);
	const share = (split.sizes[index] ?? 0) / total;
	return usable(share) ? share : 1;
}

/** Is the panel `panelId` docked in the default tree `defaults` (so `placeAtDefault` may dock it)? */
export function hasDefaultPlace(defaults: DockNode | null, panelId: string): boolean {
	return defaults !== null && pathTo(defaults, panelId) !== null;
}

/** May a split / tab group made now take the default id `id`: no node of the docked tree has it, and nothing else of the layout (`taken`). */
const isFree = (docked: DockNode, taken: ReadonlySet<string>, id: string): boolean =>
	!taken.has(id) && findNode(docked, id) === null;

/** The nearest child of `container` other than `index` that holds a docked pane, with those panes in default order. */
function nearestDocked(
	container: Container,
	index: number,
	docked: ReadonlySet<string>
): { index: number; ids: string[] } | null {
	const order = container.children
		.map((_, i) => i)
		.filter((i) => i !== index)
		.sort((a, b) => Math.abs(a - index) - Math.abs(b - index) || a - b);
	for (const i of order) {
		const ids = collectPanelIds(container.children[i]).filter((id) => docked.has(id));
		if (ids.length > 0) return { index: i, ids };
	}
	return null;
}

/** `panel` as a tab of the group the docked tab `besideId` is in, on its default side of that tab; the active tab. */
function joinTabs(
	docked: DockNode,
	group: DockTabGroupNode,
	index: number,
	besideId: string,
	panel: DockPanelNode,
	makeId: () => string,
	taken: ReadonlySet<string>
): DockNode {
	const tree = dockPanelIntoTree(docked, panel, besideId, 'center', () =>
		isFree(docked, taken, group.id) ? group.id : makeId()
	);
	const joined = findParent(tree, panel.id);
	if (joined?.type !== 'tabs') return tree;
	const at = joined.children.findIndex((c) => c.id === besideId);
	const to = group.children.findIndex((c) => c.id === besideId) > index ? at : at + 1;
	return moveTabWithinGroup(tree, joined.id, joined.children.length - 1, to) ?? tree;
}

/**
 * `panel` on its default side of what the child `beside.index` of the default split `split` is in
 * `docked` now: the largest part of the tree that holds only panes of that child, around its pane
 * nearest to `panel` in default order. Spliced into the split around that part when it runs the
 * same way and is not another default split; else a new split is made around the part (with the
 * id of `split` when free).
 */
function joinSplit(
	docked: DockNode,
	defaults: DockNode,
	split: DockSplitNode,
	index: number,
	beside: { index: number; ids: string[] },
	panel: DockPanelNode,
	share: number | undefined,
	makeId: () => string,
	taken: ReadonlySet<string>,
	away: ReadonlySet<string>
): DockNode {
	const before = beside.index > index;
	const anchorId = before ? beside.ids[0] : beside.ids[beside.ids.length - 1];
	const part = new Set(collectPanelIds(split.children[beside.index]));
	const group = findParent(docked, anchorId);
	let target: DockNode | null = group?.type === 'tabs' ? group : findNode(docked, anchorId);
	if (target === null) return docked;
	for (;;) {
		const parent = findParent(docked, target.id);
		if (!parent || !collectPanelIds(parent).every((id) => part.has(id))) break;
		target = parent;
	}
	const parent = findParent(docked, target.id);
	const flatten =
		parent?.type === 'split' &&
		parent.direction === split.direction &&
		(parent.id === split.id || findNode(defaults, parent.id)?.type !== 'split');
	const splitId = flatten ? parent.id : isFree(docked, taken, split.id) ? split.id : makeId();
	const region =
		split.direction === 'row' ? (before ? 'left' : 'right') : before ? 'top' : 'bottom';
	const tree = splitInsert(docked, target, panel, region, () => splitId, flatten);
	// The children the pane joins, and which of them show. With places (`away`) AND panes that show
	// among them, the share is a share of what shows; else of the whole split.
	const joined = flatten && parent?.type === 'split' ? parent.children : [target];
	const shows = joined.map((c) => collectPanelIds(c).some((id) => !away.has(id)));
	const old = flatten && parent?.type === 'split' ? parent.sizes : [1];
	const total = old.reduce((a, b) => a + b, 0);
	const scaled = old.map((s) => (total > 0 ? s / total : 1 / old.length));
	const shown = scaled.reduce((sum, s, i) => (shows[i] ? sum + s : sum), 0);
	const among = shows.includes(false) && shown > 0;
	const there = collectPanelIds(docked).filter((id) => !among || !away.has(id));
	const held = usable(share) ? share : defaultShare(split, index, new Set(there));
	return replaceNodeById(tree, splitId, (node) => {
		if (node.type !== 'split') return node;
		const at = node.children.findIndex((c) => c.id === panel.id);
		if (at === -1 || node.children.length !== old.length + 1) return node;
		// `held` of what shows, as a share of the whole split: every other child - a place too -
		// gives way in proportion. This undoes what taking the pane out did (`removeFromShadow`,
		// #743), so a place holds what it held before the pane was hidden.
		const part = among ? shown : 1;
		const own = (held * part) / (1 - held + held * part);
		const rest = scaled.map((s) => s * (1 - own));
		return { ...node, sizes: [...rest.slice(0, at), own, ...rest.slice(at)] };
	});
}

/** The share child `index` of the default split has against its siblings that hold a docked pane (`0.5` when it says nothing). */
function defaultShare(split: DockSplitNode, index: number, docked: ReadonlySet<string>): number {
	const own = split.sizes[index] ?? 0;
	let others = 0;
	split.children.forEach((child, i) => {
		if (i !== index && collectPanelIds(child).some((id) => docked.has(id)))
			others += split.sizes[i] ?? 0;
	});
	const share = own / (own + others);
	// `1` too: its default siblings docked now hold `0` of the default split.
	return Number.isFinite(share) && share >= 0 && share <= 1 ? share : 0.5;
}

/** The outer edge the default place is at: the first / last child of a split around it, innermost first. */
function defaultEdge(path: Step[]): DockEdge | null {
	for (let level = path.length - 1; level >= 0; level--) {
		const { container, index } = path[level];
		if (container.type !== 'split' || container.children.length < 2) continue;
		if (index === 0) return container.direction === 'row' ? 'left' : 'top';
		if (index === container.children.length - 1)
			return container.direction === 'row' ? 'right' : 'bottom';
	}
	return null;
}

/**
 * The docked tree with `panel` (not docked now) at its default place (see the top of this file),
 * or `null`: it has none, the caller opens it floating. `docked` is not changed. `makeId` is asked
 * only for a split / tab group whose default id is taken: by a node of `docked`, or by anything
 * else of the layout the tree is part of - `taken`, the ids out of the docked tree (the regions in
 * the edge bands with their panes, the floating windows). A layout holds an id once
 * (`validateDockLayout`), so the caller that has a layout gives them (`DockState.shownTree` does).
 *
 * `away` (#782 PR6, `core/shadow.ts#placeInShadowAtDefault`): the panes of `docked` that are only
 * the PLACE of a pane that is out of the tree. Such a pane is there like any other - the pane is
 * put beside it, in default order -, but a `share` is a share of what SHOWS: in a split with both,
 * the pane ends up with `share` of what the children that show have together, and every other
 * child, a place too, gives way in proportion (so a pane hidden and shown again leaves the split,
 * its places included, as it was).
 */
export function placeAtDefault(
	docked: DockNode | null,
	defaults: DockNode | null,
	panel: DockPanelNode,
	share?: number,
	makeId: () => string = defaultMakeId,
	taken: ReadonlySet<string> = new Set(),
	away: ReadonlySet<string> = new Set()
): DockNode | null {
	if (defaults === null) return null;
	const path = pathTo(defaults, panel.id);
	if (path === null) return null;
	if (docked === null) return dockPanelIntoTree(null, panel, panel.id, 'center', makeId);
	const present = new Set(collectPanelIds(docked));
	for (let level = path.length - 1; level >= 0; level--) {
		const { container, index } = path[level];
		const beside = nearestDocked(container, index, present);
		if (beside === null) continue;
		return container.type === 'tabs'
			? joinTabs(docked, container, index, beside.ids[0], panel, makeId, taken)
			: joinSplit(docked, defaults, container, index, beside, panel, share, makeId, taken, away);
	}
	const edge = defaultEdge(path);
	if (edge === null) return null;
	const tree = dockPanelAtEdge(docked, panel, edge, makeId);
	if (!usable(share) || tree.type !== 'split') return tree;
	return {
		...tree,
		sizes: tree.children[0].id === panel.id ? [share, 1 - share] : [1 - share, share]
	};
}
