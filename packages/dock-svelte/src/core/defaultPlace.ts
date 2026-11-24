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
 *
 * Several panes of one default split hidden together (#939): each kept its share of what was left
 * of the split when it was hidden, so taken as they are the shares only give the sizes back when
 * the panes are shown last-hidden first (in another order the later ones take too much and the
 * earlier ones shrink). `shareAmongHidden` reads them in the order the panes were hidden in (the
 * order of the closed windows) and gives the share to show a pane with while its default siblings
 * are still hidden, and the shares those keep from then on: hidden one after the other and shown
 * in any order, every pane has the share it had before the first was hidden.
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

/**
 * The share to show the hidden pane `panelId` with among its default siblings that are hidden too
 * (#939, the top of this file), and what those keep once it is shown. `hidden`: the panes hidden
 * from the dock with the share each keeps (`FloatingWindow.dockShare`), in the order they were
 * hidden in - `panelId` among them; `present`: the panes of the tree (places included).
 *
 * The split is the one `placeAtDefault` puts the pane into: the innermost container around its
 * default place with another child that holds a pane of `present`. A child of it none of whose
 * panes is in `present` is hidden as a whole: it left the split when the last of its panes was
 * hidden, with the share that pane keeps - a share of the split without the children hidden
 * before it. From these the share every hidden child had of the split with all of them there
 * follows, and from that:
 *  - `share`: the pane's share of the split without the children still hidden;
 *  - `others`: for the panes of the children hidden after it, the share of the split with the
 *    pane back (they were hidden when it was out; unchanged ones are left out).
 * `null`: nothing to work out - the pane keeps no usable share, has no default place, joins a tab
 * group, goes to an edge, or no default sibling hidden after it is still hidden (its share is
 * right as it is, exactly).
 */
export function shareAmongHidden(
	defaults: DockNode | null,
	panelId: string,
	present: ReadonlySet<string>,
	hidden: readonly { id: string; share: number }[]
): { share: number; others: Map<string, number> } | null {
	if (defaults === null || hidden.length < 2) return null;
	const own = hidden.find((h) => h.id === panelId);
	if (!own || !usable(own.share)) return null;
	const path = pathTo(defaults, panelId);
	if (path === null) return null;
	const step = [...path]
		.reverse()
		.find(({ container, index }) => nearestDocked(container, index, present) !== null);
	if (!step || step.container.type !== 'split') return null;
	// The children hidden as a whole, in the order they left the split.
	const regions: { mine: boolean; at: number; raw: number; members: number[] }[] = [];
	step.container.children.forEach((child, i) => {
		const ids = new Set(collectPanelIds(child));
		if ([...ids].some((id) => present.has(id))) return;
		const members = hidden
			.map((h, at) => (ids.has(h.id) && usable(h.share) ? at : -1))
			.filter((at) => at !== -1);
		if (members.length === 0) return;
		const at = Math.max(...members);
		const mine = i === step.index;
		regions.push({ mine, at, raw: mine ? own.share : hidden[at].share, members });
	});
	regions.sort((a, b) => a.at - b.at);
	const me = regions.findIndex((r) => r.mine);
	if (me === -1 || me === regions.length - 1) return null;
	// Of the split with every hidden child there: a child's share, and what the ones before it hold.
	const whole: number[] = [];
	const before: number[] = [];
	let sum = 0;
	for (const region of regions) {
		before.push(sum);
		whole.push(region.raw * (1 - sum));
		sum += whole[whole.length - 1];
	}
	const share = whole[me] / (1 - (sum - whole[me]));
	if (!usable(share)) return null;
	const others = new Map<string, number>();
	for (let k = me + 1; k < regions.length; k++) {
		// Its share was of the split without the children before it; now the pane is not one of them.
		const factor = (1 - before[k]) / (1 - (before[k] - whole[me]));
		for (const at of regions[k].members) {
			const next = hidden[at].share * factor;
			if (usable(next) && next !== hidden[at].share) others.set(hidden[at].id, next);
		}
	}
	return { share, others };
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
	const mixed = shows.includes(false) && shows.includes(true);
	const among = mixed && shown > 0;
	// Without a share to take: the default share against the default siblings that show - or,
	// when none of them shows (what shows beside the places is from elsewhere), against the places.
	const all = collectPanelIds(docked);
	const showing = new Set(all.filter((id) => !away.has(id)));
	const siblingShows = split.children.some(
		(child, i) => i !== index && collectPanelIds(child).some((id) => showing.has(id))
	);
	const there = mixed && siblingShows ? showing : new Set(all);
	const held = usable(share) ? share : defaultShare(split, index, there);
	return replaceNodeById(tree, splitId, (node) => {
		if (node.type !== 'split') return node;
		const at = node.children.findIndex((c) => c.id === panel.id);
		if (at === -1 || node.children.length !== old.length + 1) return node;
		if (mixed && !among) {
			// The children that show hold 0 together ("Shares of 0", `core/shadow.ts`): they show
			// evenly, and a share of what shows cannot be kept in a total of 0. As for any write to
			// such a split, the ones that show - the pane too - take the even part of it, their count
			// out of all its children, and the places share the rest in the proportion they had.
			const count = shows.filter(Boolean).length;
			const part = (count + 1) / (scaled.length + 1);
			const rest = scaled.map((s, i) => (shows[i] ? ((1 - held) * part) / count : s * (1 - part)));
			return { ...node, sizes: [...rest.slice(0, at), held * part, ...rest.slice(at)] };
		}
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
