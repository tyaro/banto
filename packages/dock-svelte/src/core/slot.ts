/**
 * The remembered docked place of a hidden pane (#663 ①-A, spec §5.2). Pure.
 *
 * When a docked pane leaves the screen (✕, `hidePanel` / `closePanel`, a
 * View-menu checkbox) the tree forgets it (`removePanel` collapses the
 * split / tab group it leaves), so `captureDockSlot` records where it was
 * BEFORE the removal, and `restoreDockSlot` puts it back there later - the
 * way VS Code / Visual Studio reopen a closed tool window in its old place.
 *
 * A slot names its place by ids that survive the removal: the tab group (or
 * split) it was in, the neighbouring node, and `anchors` (panel ids next to
 * it, nearest first) for when those container ids are gone. Restoring tries,
 * in order:
 *
 *  - `tab`: the same tab group (`groupId`) at the old index; else the tab group
 *    of the first anchor still docked (a bare anchor panel becomes a tab group
 *    again); the restored tab is made active.
 *  - `split`: the same split (`splitId`, same direction) at the old index; else
 *    next to the old neighbour (`neighborId`) or the first anchor still docked,
 *    on the same side, with the same share of the space the two had.
 *  - an empty docked tree: the pane becomes its root (any slot kind).
 *  - otherwise `null` - the caller opens it as a floating window instead.
 */
import { collectPanelIds, findNode, findParent } from './tree';
import type { DockNode, DockPanelNode, DockSlot, DockSplitNode, DockTabGroupNode } from '../types';

/** The smallest / largest share a restored pane takes of the space it splits (keeps both sides visible). */
const MIN_SHARE = 0.05;

function clampShare(size: number): number {
	if (!Number.isFinite(size)) return 0.5;
	return Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, size));
}

/** Ids next to `index` in `ids`, nearest first (after before before at the same distance). */
function byDistance(ids: string[], index: number): string[] {
	const out: string[] = [];
	for (let d = 1; d < ids.length; d++) {
		if (index + d < ids.length) out.push(ids[index + d]);
		if (index - d >= 0) out.push(ids[index - d]);
	}
	return out;
}

/**
 * Where the docked panel `panelId` is in `root`, described so `restoreDockSlot`
 * can put it back after it was removed. `null` when it is not a docked panel.
 * Call it BEFORE removing the panel.
 */
export function captureDockSlot(root: DockNode | null, panelId: string): DockSlot | null {
	const node = findNode(root, panelId);
	if (!node || node.type !== 'panel') return null;
	const parent = findParent(root, panelId);
	if (parent?.type === 'tabs' && parent.children.length > 1) {
		const ids = parent.children.map((c) => c.id);
		const index = ids.indexOf(panelId);
		return { kind: 'tab', groupId: parent.id, index, anchors: byDistance(ids, index) };
	}
	// A lone tab leaves its group too: the group is what sits in the split.
	const unit: DockNode = parent?.type === 'tabs' ? parent : node;
	const split = findParent(root, unit.id);
	if (!split || split.type !== 'split') return { kind: 'root' };
	const index = split.children.findIndex((c) => c.id === unit.id);
	const hasNext = index + 1 < split.children.length;
	const neighbor = split.children[hasNext ? index + 1 : index - 1];
	const neighborIds = collectPanelIds(neighbor);
	return {
		kind: 'split',
		splitId: split.id,
		direction: split.direction,
		index,
		neighborId: neighbor.id,
		side: hasNext ? 'before' : 'after',
		size: split.sizes[index] ?? 1 / split.children.length,
		// Nearest first: the neighbour's panels on the side that touched the pane.
		anchors: hasNext ? neighborIds : neighborIds.reverse()
	};
}

/** A docked panel (not a tab group / split) with this id. */
function isDockedPanel(root: DockNode, id: string): boolean {
	return findNode(root, id)?.type === 'panel';
}

/** A panel inside a tab group stands for its group (a split never holds a tab directly). */
function liftOutOfTabs(root: DockNode, node: DockNode): DockNode {
	if (node.type !== 'panel') return node;
	const parent = findParent(root, node.id);
	return parent?.type === 'tabs' ? parent : node;
}

/** Replace the node `id` (reachable through splits) by `replace(node)`. */
function replaceNode(root: DockNode, id: string, replace: (node: DockNode) => DockNode): DockNode {
	if (root.id === id) return replace(root);
	if (root.type !== 'split') return root;
	let changed = false;
	const children = root.children.map((c) => {
		const next = replaceNode(c, id, replace);
		if (next !== c) changed = true;
		return next;
	});
	return changed ? { ...root, children } : root;
}

function freeId(root: DockNode, wanted: string, makeId: () => string): string {
	return findNode(root, wanted) ? makeId() : wanted;
}

/** Insert into an existing split at `index`, giving the pane `share` and scaling the others. */
function insertIntoSplit(
	split: DockSplitNode,
	panel: DockPanelNode,
	index: number,
	share: number
): DockSplitNode {
	const at = Math.min(Math.max(index, 0), split.children.length);
	const total = split.sizes.reduce((a, b) => a + b, 0);
	const scaled = split.sizes.map((s) => (total > 0 ? s / total : 1 / split.sizes.length));
	const sizes = scaled.map((s) => s * (1 - share));
	sizes.splice(at, 0, share);
	const children = split.children.slice();
	children.splice(at, 0, panel);
	return { ...split, children, sizes };
}

function restoreTab(
	root: DockNode,
	panel: DockPanelNode,
	slot: Extract<DockSlot, { kind: 'tab' }>,
	makeId: () => string
): DockNode | null {
	const insert = (group: DockTabGroupNode): DockNode => {
		const at = Math.min(Math.max(slot.index, 0), group.children.length);
		const children = group.children.slice();
		children.splice(at, 0, panel);
		return replaceNode(root, group.id, () => ({ ...group, children, activeIndex: at }));
	};
	const group = findNode(root, slot.groupId);
	if (group?.type === 'tabs') return insert(group);
	const anchor = slot.anchors.find((id) => isDockedPanel(root, id));
	if (anchor === undefined) return null;
	const target = liftOutOfTabs(root, findNode(root, anchor)!);
	if (target.type === 'tabs') return insert(target);
	// The anchor is a bare panel now (its group collapsed): make the group again.
	const at = Math.min(Math.max(slot.index, 0), 1);
	const children: DockPanelNode[] =
		at === 0 ? [panel, target as DockPanelNode] : [target as DockPanelNode, panel];
	const tabs: DockTabGroupNode = {
		type: 'tabs',
		id: freeId(root, slot.groupId, makeId),
		children,
		activeIndex: at
	};
	return replaceNode(root, target.id, () => tabs);
}

function restoreSplit(
	root: DockNode,
	panel: DockPanelNode,
	slot: Extract<DockSlot, { kind: 'split' }>,
	makeId: () => string
): DockNode | null {
	const share = clampShare(slot.size);
	const same = findNode(root, slot.splitId);
	if (same?.type === 'split' && same.direction === slot.direction) {
		// Still there (it had 3+ children): next to the old neighbour when it is a child, else at the old index.
		const n = same.children.findIndex((c) => c.id === slot.neighborId);
		const index = n === -1 ? slot.index : slot.side === 'before' ? n : n + 1;
		return replaceNode(root, same.id, () => insertIntoSplit(same, panel, index, share));
	}
	const found =
		findNode(root, slot.neighborId) ??
		(() => {
			const anchor = slot.anchors.find((id) => isDockedPanel(root, id));
			return anchor === undefined ? null : findNode(root, anchor);
		})();
	if (!found) return null;
	const neighbor = liftOutOfTabs(root, found);
	const parent = findParent(root, neighbor.id);
	if (parent?.type === 'split' && parent.direction === slot.direction) {
		// Splice in beside the neighbour, splitting the neighbour's space (keeps the tree shallow).
		const n = parent.children.findIndex((c) => c.id === neighbor.id);
		const room = parent.sizes[n] ?? 0;
		const sizes = parent.sizes.slice();
		const children = parent.children.slice();
		const at = slot.side === 'before' ? n : n + 1;
		sizes[n] = room * (1 - share);
		sizes.splice(at, 0, room * share);
		children.splice(at, 0, panel);
		return replaceNode(root, parent.id, () => ({ ...parent, children, sizes }));
	}
	const split: DockSplitNode = {
		type: 'split',
		id: freeId(root, slot.splitId, makeId),
		direction: slot.direction,
		children: slot.side === 'before' ? [panel, neighbor] : [neighbor, panel],
		sizes: slot.side === 'before' ? [share, 1 - share] : [1 - share, share]
	};
	return replaceNode(root, neighbor.id, () => split);
}

/**
 * Put `panel` back into `root` at `slot` (module doc for the order of tries).
 * Returns the new root, or `null` when the place is gone (the caller falls
 * back to a floating window). `panel` must not be in `root` already.
 */
export function restoreDockSlot(
	root: DockNode | null,
	panel: DockPanelNode,
	slot: DockSlot,
	makeId: () => string
): DockNode | null {
	if (root === null) return panel;
	if (findNode(root, panel.id)) return null;
	if (slot.kind === 'tab') return restoreTab(root, panel, slot, makeId);
	if (slot.kind === 'split') return restoreSplit(root, panel, slot, makeId);
	return null;
}
