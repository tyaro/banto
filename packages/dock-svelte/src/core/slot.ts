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
 *  - `split`: the same split (`splitId`, same direction), next to its child
 *    holding the old neighbour (`neighborId`) or the nearest anchor (either
 *    side, `anchors` / `otherAnchors`), else at the old index; when the split is
 *    gone, next to the old neighbour or the nearest anchor still docked, on the
 *    side it was on, with the same share of the space the two had.
 *  - `outer` (#721): where the container itself was (a `split` / `root` slot),
 *    the pane put there as a bare pane - when every pane of the container was
 *    taken out, so neither the container nor any anchor is docked. The panes
 *    shown after it join it through the anchors (a bare anchor becomes a tab
 *    group / split again).
 *  - an empty docked tree: the pane becomes its root (any slot kind).
 *  - otherwise `null` - the caller opens it as a floating window instead.
 *
 * The last pane taken out of a container (#721) is a bare pane by then (the
 * container collapsed when its other panes left), so `captureDockSlot` finds
 * the container in the slots of the panes taken out before it (`hidden`) and
 * records the container's slot for it, not the place the bare pane has now
 * (that becomes its `outer`).
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
	const before = [...hidden].filter((h) => h.id !== panelId);
	const parent = findParent(root, panelId);
	if (parent?.type === 'tabs' && parent.children.length > 1) {
		let ids = parent.children.map((c) => c.id);
		for (const h of before) {
			if (h.slot.kind !== 'tab' || h.slot.groupId !== parent.id) continue;
			ids = mergeOrder(ids, slotOrder(h.id, h.slot));
		}
		const index = ids.indexOf(panelId);
		return {
			kind: 'tab',
			groupId: parent.id,
			index,
			anchors: byDistance(ids, index),
			outer: unitSlot(root, parent, before)
		};
	}
	// A lone tab leaves its group too: the group is what sits in the split.
	const unit = parent?.type === 'tabs' ? parent : node;
	return (
		lastTabSlot(root, unit, panelId, before) ??
		lastSplitSlot(root, unit, before) ??
		withOuter(unitSlot(root, unit, before), root, unit, before)
	);
}

/** A split slot of `unit` with `outer` = where its split is (`unitSlot` of the split); a root slot as it is. */
function withOuter(
	slot: DockSlot,
	root: DockNode | null,
	unit: DockNode,
	hidden: HiddenDockSlot[]
): DockSlot {
	if (slot.kind !== 'split') return slot;
	const split = findParent(root, unit.id);
	return split ? { ...slot, outer: unitSlot(root, split, hidden) } : slot;
}

/** A hidden pane that is not docked (a stale entry for a docked one is ignored). */
function stillHidden(root: DockNode | null, h: HiddenDockSlot): boolean {
	return !findNode(root, h.id);
}

/**
 * The last pane `panelId` of a tab group (#721): `unit` (the pane, or its group of one) is all
 * that is left of a group the panes in `hidden` remember (their `tab` slot names the pane as an
 * anchor, and the group is gone or is `unit`). The group's old order is rebuilt from their slots,
 * and the pane's slot is a tab of that group, with `outer` = where `unit` is now. The most recent
 * such group (the last in `hidden`) wins. `null` when there is none.
 */
function lastTabSlot(
	root: DockNode | null,
	unit: DockNode,
	panelId: string,
	hidden: HiddenDockSlot[]
): DockSlot | null {
	const mine = hidden.filter(
		(h) =>
			h.slot.kind === 'tab' &&
			stillHidden(root, h) &&
			h.slot.anchors.includes(panelId) &&
			(h.slot.groupId === unit.id || !findNode(root, h.slot.groupId))
	);
	const last = mine.at(-1);
	if (!last || last.slot.kind !== 'tab') return null;
	const groupId = last.slot.groupId;
	let ids = [panelId];
	for (const h of mine) {
		if (h.slot.kind === 'tab' && h.slot.groupId === groupId)
			ids = mergeOrder(ids, slotOrder(h.id, h.slot));
	}
	const index = ids.indexOf(panelId);
	return {
		kind: 'tab',
		groupId,
		index,
		anchors: byDistance(ids, index),
		outer: unitSlot(root, unit, hidden)
	};
}

/**
 * The last child `unit` of a split (#721, the split version of `lastTabSlot`): the panes in
 * `hidden` remember a split that is gone and name `unit` (or a panel in it) as their neighbour
 * or an anchor. The split's children are rebuilt from their slots (`splitOrder`), and the slot is
 * a child of that split, with `outer` = where `unit` is now. `size` is an even share (the share
 * the last child had is not known). The most recent such split (the last in `hidden`) wins.
 * `null` when there is none.
 */
function lastSplitSlot(
	root: DockNode | null,
	unit: DockNode,
	hidden: HiddenDockSlot[]
): DockSlot | null {
	const own = new Set([unit.id, ...collectPanelIds(unit)]);
	const names = (slot: Extract<DockSlot, { kind: 'split' }>) =>
		own.has(slot.neighborId) ||
		slot.anchors.some((id) => own.has(id)) ||
		(slot.otherAnchors ?? []).some((id) => own.has(id));
	const mine = hidden.filter(
		(h) =>
			h.slot.kind === 'split' &&
			stillHidden(root, h) &&
			!findNode(root, h.slot.splitId) &&
			names(h.slot)
	);
	const last = mine.at(-1);
	if (!last || last.slot.kind !== 'split') return null;
	const { splitId, direction } = last.slot;
	const pending = mine.filter(
		(h) => h.slot.kind === 'split' && h.slot.splitId === splitId && h.slot.direction === direction
	);
	const ids = splitOrder([unit], pending);
	const slot = splitSlotAt([unit], ids, unit.id, splitId, direction, 1 / ids.length);
	return { ...slot, outer: unitSlot(root, unit, hidden) };
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

/** A split slot's anchors as places to try, nearest first (the neighbour's side first at each distance). */
interface Anchor {
	id: string;
	/** The pane goes before this one (else after it). */
	before: boolean;
}

function splitAnchors(slot: Extract<DockSlot, { kind: 'split' }>): Anchor[] {
	const near = slot.side === 'before';
	const others = slot.otherAnchors ?? [];
	const out: Anchor[] = [];
	for (let d = 0; d < Math.max(slot.anchors.length, others.length); d++) {
		if (d < slot.anchors.length) out.push({ id: slot.anchors[d], before: near });
		if (d < others.length) out.push({ id: others[d], before: !near });
	}
	return out;
}

/**
 * The `split` / `root` slot of `unit` (a panel or tab group that is a split's child or the root).
 * `hidden` (`captureDockSlot`'s, without the pane itself) remembering the same split are counted
 * among its children, beside the nearest of their anchors found there (#720 review): so every
 * pane hidden out of the split comes back in the old order whichever is shown first. The slot
 * records the panels on both sides (`anchors` on the neighbour's side, `otherAnchors` on the
 * other), and `index` is the place among those reconstructed children. With no hidden ones this
 * is the split's own children.
 */
function unitSlot(
	root: DockNode | null,
	unit: DockNode,
	hidden: Iterable<HiddenDockSlot> = []
): DockSlot {
	const split = findParent(root, unit.id);
	if (!split || split.type !== 'split') return { kind: 'root' };
	const own = split.children.findIndex((c) => c.id === unit.id);
	const pending = [...hidden].filter(
		(h) =>
			h.slot.kind === 'split' &&
			h.slot.splitId === split.id &&
			h.slot.direction === split.direction &&
			!findNode(root, h.id)
	);
	const ids = splitOrder(split.children, pending);
	return splitSlotAt(
		split.children,
		ids,
		unit.id,
		split.id,
		split.direction,
		split.sizes[own] ?? 1 / split.children.length
	);
}

/**
 * The ids of `children` with the panes in `pending` (split slots of the same split) put among
 * them, each beside the nearest of its neighbour / anchors found there (a hidden pane stands for
 * itself; one placed may anchor the next).
 */
function splitOrder(children: DockNode[], pending: HiddenDockSlot[]): string[] {
	const ids = children.map((c) => c.id);
	// Where a panel id (a hidden pane stands for itself) is among `ids`, or -1.
	const at = (id: string): number => {
		const i = ids.indexOf(id);
		if (i !== -1) return i;
		const child = children.find((c) => collectPanelIds(c).includes(id));
		return child ? ids.indexOf(child.id) : -1;
	};
	for (let changed = true; changed;) {
		changed = false;
		for (const h of pending) {
			if (ids.includes(h.id)) continue;
			const slot = h.slot as Extract<DockSlot, { kind: 'split' }>;
			const candidates = [
				{ id: slot.neighborId, before: slot.side === 'before' },
				...splitAnchors(slot)
			];
			for (const c of candidates) {
				const n = at(c.id);
				if (n === -1) continue;
				ids.splice(c.before ? n : n + 1, 0, h.id);
				changed = true;
				break;
			}
		}
	}
	return ids;
}

/** The split slot of the child `unitId` among `ids` (`children`' ids and hidden panes' ids). */
function splitSlotAt(
	children: DockNode[],
	ids: string[],
	unitId: string,
	splitId: string,
	direction: 'row' | 'column',
	size: number
): Extract<DockSlot, { kind: 'split' }> {
	const index = ids.indexOf(unitId);
	const hasNext = index + 1 < ids.length;
	// Nearest first: the panels on each side (a hidden pane stands for itself).
	const panels = (side: string[], reverse: boolean) =>
		side.flatMap((id) => {
			const child = children.find((c) => c.id === id);
			if (!child) return [id];
			const p = collectPanelIds(child);
			return reverse ? p.reverse() : p;
		});
	const next = panels(ids.slice(index + 1), false);
	const prev = panels(ids.slice(0, index).reverse(), true);
	return {
		kind: 'split',
		splitId,
		direction,
		index,
		neighborId: hasNext ? ids[index + 1] : ids[index - 1],
		side: hasNext ? 'before' : 'after',
		size,
		anchors: hasNext ? next : prev,
		...(hasNext && prev.length > 0 ? { otherAnchors: prev } : {})
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

/** The child of `split` that is or holds the node `id`, or `null`. */
function childHolding(root: DockNode, split: DockSplitNode, id: string): DockNode | null {
	let node = findNode(root, id);
	while (node) {
		const parent = findParent(root, node.id);
		if (parent?.id === split.id) return node;
		node = parent;
	}
	return null;
}

function restoreSplit(
	root: DockNode,
	panel: DockPanelNode | DockTabGroupNode,
	slot: Extract<DockSlot, { kind: 'split' }>,
	makeId: () => string
): DockNode | null {
	const share = clampShare(slot.size);
	// The old neighbour, then the anchors by distance (either side): the first one found decides.
	const candidates: Anchor[] = [
		{ id: slot.neighborId, before: slot.side === 'before' },
		...splitAnchors(slot)
	];
	const same = findNode(root, slot.splitId);
	if (same?.type === 'split' && same.direction === slot.direction) {
		// Still there: next to the nearest child holding an anchor (#720 review), else at the old index.
		for (const c of candidates) {
			const child = childHolding(root, same, c.id);
			if (!child) continue;
			const n = same.children.indexOf(child);
			return replaceNode(root, same.id, () =>
				insertIntoSplit(same, panel, c.before ? n : n + 1, share)
			);
		}
		return replaceNode(root, same.id, () => insertIntoSplit(same, panel, slot.index, share));
	}
	let found: DockNode | null = null;
	let before = slot.side === 'before';
	for (const [k, c] of candidates.entries()) {
		const node = findNode(root, c.id);
		// The neighbour may be a tab group / split; an anchor is a panel.
		if (!node || (k > 0 && node.type !== 'panel')) continue;
		found = node;
		before = c.before;
		break;
	}
	if (!found) return null;
	const neighbor = liftOutOfTabs(root, found);
	const parent = findParent(root, neighbor.id);
	if (parent?.type === 'split' && parent.direction === slot.direction) {
		// Splice in beside the neighbour, splitting the neighbour's space (keeps the tree shallow).
		const n = parent.children.findIndex((c) => c.id === neighbor.id);
		const room = parent.sizes[n] ?? 0;
		const sizes = parent.sizes.slice();
		const children = parent.children.slice();
		const at = before ? n : n + 1;
		sizes[n] = room * (1 - share);
		sizes.splice(at, 0, room * share);
		children.splice(at, 0, panel);
		return replaceNode(root, parent.id, () => ({ ...parent, children, sizes }));
	}
	const split: DockSplitNode = {
		type: 'split',
		id: freeId(root, slot.splitId, makeId),
		direction: slot.direction,
		children: before ? [panel, neighbor] : [neighbor, panel],
		sizes: before ? [share, 1 - share] : [1 - share, share]
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
	const place = (s: DockSlot): DockNode | null =>
		s.kind === 'tab'
			? restoreTab(root, panel, s, makeId)
			: s.kind === 'split'
				? restoreSplit(root, panel, s, makeId)
				: null;
	if (slot.kind === 'root') return null;
	// The container's own place (#721) only after the container and the anchors. One level: an
	// `outer` of an `outer` is not tried.
	return place(slot) ?? (slot.outer ? place(slot.outer) : null);
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
