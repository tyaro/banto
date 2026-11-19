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
 *  - `tab`: the same tab group (`groupId`), else the tab group of the first
 *    anchor still docked (a bare anchor panel becomes a tab group again). It
 *    goes next to the nearest anchor in that group, on the side it was on
 *    (right after a tab that was before it, right before one that was after
 *    it), so the old order is kept whatever else closed meanwhile; with no
 *    anchor in the group, at the old index. The restored tab is made active.
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
 * Was `anchor` before the pane in its old tab group? The inverse of
 * `byDistance`: a tab slot's `anchors` are the group's other ids in that
 * order, so with `index` and their count every anchor's old position is
 * known (no extra field: slots saved before this keep working).
 */
function wasBefore(slot: Extract<DockSlot, { kind: 'tab' }>, anchor: string): boolean {
	// The pane's own id cannot be an anchor; '' stands for it.
	const order = slotOrder('', slot);
	return order.indexOf(anchor) < order.indexOf('');
}

/** The tab group's order the slot of the hidden pane `id` remembers (the pane itself at `index`). */
function slotOrder(id: string, slot: Extract<DockSlot, { kind: 'tab' }>): string[] {
	const n = slot.anchors.length + 1;
	const index = Math.min(Math.max(slot.index, 0), n - 1);
	const positions = byDistance(
		Array.from({ length: n }, (_, i) => String(i)),
		index
	);
	const order = new Array<string>(n);
	order[index] = id;
	slot.anchors.forEach((anchor, k) => (order[Number(positions[k])] = anchor));
	return order;
}

/**
 * `base` with the ids of `other` it lacks, each put right after the nearest
 * id before it in `other` that `base` has (else right before the nearest one
 * after it). `base`'s own order is never changed.
 */
function mergeOrder(base: string[], other: string[]): string[] {
	const out = base.slice();
	for (let changed = true; changed;) {
		changed = false;
		other.forEach((id, i) => {
			if (out.includes(id)) return;
			for (let j = i - 1; j >= 0; j--) {
				const at = out.indexOf(other[j]);
				if (at !== -1) {
					out.splice(at + 1, 0, id);
					changed = true;
					return;
				}
			}
			for (let j = i + 1; j < other.length; j++) {
				const at = out.indexOf(other[j]);
				if (at !== -1) {
					out.splice(at, 0, id);
					changed = true;
					return;
				}
			}
		});
	}
	return out;
}

/** Where to put the pane among `ids`: beside the nearest anchor there, on its old side; else the old index. */
function tabIndex(slot: Extract<DockSlot, { kind: 'tab' }>, ids: string[]): number {
	for (const anchor of slot.anchors) {
		const i = ids.indexOf(anchor);
		if (i !== -1) return wasBefore(slot, anchor) ? i + 1 : i;
	}
	return Math.min(Math.max(slot.index, 0), ids.length);
}

/** A pane hidden from the dock and the place it remembers (`captureDockSlot`'s `hidden`). */
export interface HiddenDockSlot {
	id: string;
	slot: DockSlot;
}

/**
 * Where the docked panel `panelId` is in `root`, described so `restoreDockSlot`
 * can put it back after it was removed. `null` when it is not a docked panel.
 * Call it BEFORE removing the panel.
 *
 * `hidden` are the panes already hidden from the dock with their slots: the
 * ones that remember the same tab group are counted among its tabs (at the
 * place their slot says), so tabs hidden one after another and shown again in
 * any order come back in their old order. The same holds for panes hidden out
 * of the same split: they are counted among its children (next to the
 * neighbour their slot names), so the slot may name a hidden pane as its
 * neighbour, with the docked ones beyond it as `anchors`.
 */
export function captureDockSlot(
	root: DockNode | null,
	panelId: string,
	hidden: Iterable<HiddenDockSlot> = []
): DockSlot | null {
	const node = findNode(root, panelId);
	if (!node || node.type !== 'panel') return null;
	const parent = findParent(root, panelId);
	if (parent?.type === 'tabs' && parent.children.length > 1) {
		let ids = parent.children.map((c) => c.id);
		for (const h of hidden) {
			if (h.id === panelId || h.slot.kind !== 'tab' || h.slot.groupId !== parent.id) continue;
			ids = mergeOrder(ids, slotOrder(h.id, h.slot));
		}
		const index = ids.indexOf(panelId);
		return { kind: 'tab', groupId: parent.id, index, anchors: byDistance(ids, index) };
	}
	// A lone tab leaves its group too: the group is what sits in the split.
	return unitSlot(root, parent?.type === 'tabs' ? parent : node, hidden, panelId);
}

/**
 * Where the whole region `regionId` (a docked panel that is not a tab, or a tab
 * group) is in `root`, as a `split` / `root` slot (#694 PR-3: a region auto-hidden
 * to an edge band goes back here). `null` for a split, a tab inside a group, or an
 * unknown id. Call it BEFORE removing the region.
 */
export function captureRegionSlot(root: DockNode | null, regionId: string): DockSlot | null {
	const node = findNode(root, regionId);
	if (!node || node.type === 'split') return null;
	if (node.type === 'panel' && findParent(root, regionId)?.type === 'tabs') return null;
	return unitSlot(root, node);
}

/**
 * The `split` / `root` slot of `unit` (a panel or tab group that is a split's child or the root).
 * `hidden` (`captureDockSlot`'s, but `selfId`) remembering the same split are counted among its
 * children, next to the neighbour their slot names (#720 review): a pane hidden next to one
 * hidden before names that one as its neighbour, so both come back in the old order whichever is
 * shown first. With no hidden ones this is the split's own children.
 */
function unitSlot(
	root: DockNode | null,
	unit: DockNode,
	hidden: Iterable<HiddenDockSlot> = [],
	selfId?: string
): DockSlot {
	const split = findParent(root, unit.id);
	if (!split || split.type !== 'split') return { kind: 'root' };
	const own = split.children.findIndex((c) => c.id === unit.id);
	const ids = split.children.map((c) => c.id);
	const pending = [...hidden].filter(
		(h) =>
			h.id !== selfId &&
			h.slot.kind === 'split' &&
			h.slot.splitId === split.id &&
			h.slot.direction === split.direction &&
			!findNode(root, h.id)
	);
	for (let changed = true; changed;) {
		changed = false;
		for (const h of pending) {
			const slot = h.slot as Extract<DockSlot, { kind: 'split' }>;
			if (ids.includes(h.id)) continue;
			const n = ids.indexOf(slot.neighborId);
			if (n === -1) continue;
			ids.splice(slot.side === 'before' ? n : n + 1, 0, h.id);
			changed = true;
		}
	}
	const index = ids.indexOf(unit.id);
	const hasNext = index + 1 < ids.length;
	const side = hasNext ? ids.slice(index + 1) : ids.slice(0, index).reverse();
	// Nearest first: the panels on the side that touched the pane (a hidden pane stands for itself).
	const anchors = side.flatMap((id) => {
		const child = split.children.find((c) => c.id === id);
		if (!child) return [id];
		const panels = collectPanelIds(child);
		return hasNext ? panels : panels.reverse();
	});
	return {
		kind: 'split',
		splitId: split.id,
		direction: split.direction,
		index: own,
		neighborId: side[0],
		side: hasNext ? 'before' : 'after',
		size: split.sizes[own] ?? 1 / split.children.length,
		anchors
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
	panel: DockPanelNode | DockTabGroupNode,
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
		const at = tabIndex(
			slot,
			group.children.map((c) => c.id)
		);
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
	const at = tabIndex(slot, [target.id]);
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
	panel: DockPanelNode | DockTabGroupNode,
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

/**
 * Put the whole region `region` (a panel or a tab group, #694 PR-3) back into
 * `root` at a `split` / `root` slot from `captureRegionSlot`. An empty tree takes
 * it as its root. Returns `null` when the place is gone, the slot is a `tab` slot
 * or a `root` slot of a tree that is not empty, or one of the region's ids is in
 * `root` already - the caller then docks it elsewhere.
 */
export function restoreRegionSlot(
	root: DockNode | null,
	region: DockPanelNode | DockTabGroupNode,
	slot: DockSlot,
	makeId: () => string
): DockNode | null {
	if (root === null) return region;
	const ids =
		region.type === 'tabs' ? [region.id, ...region.children.map((c) => c.id)] : [region.id];
	if (ids.some((id) => findNode(root, id))) return null;
	if (slot.kind === 'split') return restoreSplit(root, region, slot, makeId);
	return null;
}
