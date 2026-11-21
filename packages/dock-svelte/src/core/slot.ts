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
 *    side it was on, with the same share of the space the two had (a new split
 *    around it, never spliced into the split it is in now). With an `outer`,
 *    around the node holding that one made of nothing but the panels the slot
 *    names on that side (#727: the whole child of the split again, say the row
 *    of `column[row[a,b], c]`, not the anchor `b` alone).
 *  - `outer` (#721): where the container itself was (a `split` / `root` slot),
 *    the pane put there as a bare pane - when every pane of the container was
 *    taken out, so neither the container nor any anchor is docked. The panes
 *    shown after it join it through the anchors (a bare anchor becomes a tab
 *    group / split again). Then the `outer` of that one - the place of the
 *    container around it (#727: nested, at most `MAX_SLOT_DEPTH` deep).
 *  - an empty docked tree: the pane becomes its root (any slot kind).
 *  - otherwise `null` - the caller opens it as a floating window instead.
 *
 * The last pane taken out of a container (#721) is a bare pane by then (the
 * container collapsed when its other panes left), so `captureDockSlot` finds
 * the container in the slots of the panes taken out before it (`hidden`) and
 * records the container's slot for it, not the place the bare pane has now
 * (that becomes its `outer`). The same holds for a container that is all that
 * is left of a gone split (#727): its `outer` is that split's place. And a
 * hidden pane counts among the panels of the child of a split it belongs to
 * (`remnantPanes`), so the slots taken there name the whole child.
 */
import { collectPanelIds, findNode, findParent } from './tree';
import type { DockNode, DockPanelNode, DockSlot, DockSplitNode, DockTabGroupNode } from '../types';

/**
 * How deep a slot may be: the slot itself and its `outer` chain (#727 nests `outer`). `validate.ts`
 * rejects a saved slot deeper than this; `captureDockSlot` never writes one.
 */
export const MAX_SLOT_DEPTH = 8;

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
			outer: placeOf(root, parent, before, 1)
		};
	}
	// A lone tab leaves its group too: the group is what sits in the split.
	const unit = parent?.type === 'tabs' ? parent : node;
	return (
		lastTabSlot(root, unit, panelId, before) ??
		lastSplitSlot(root, unit, before, 0) ??
		hereOf(root, unit, before, 0)
	);
}

/**
 * Where `node` (a panel, tab group or split that is a split's child or the root) is now: its
 * `unitSlot`, with `outer` = where its split is, and so on up (#727: nested `outer`), while the
 * slot is less than `MAX_SLOT_DEPTH` deep (`depth` = how deep the returned slot is).
 */
function hereOf(
	root: DockNode | null,
	node: DockNode,
	hidden: HiddenDockSlot[],
	depth: number
): DockSlot {
	const slot = unitSlot(root, node, hidden);
	if (slot.kind !== 'split' || depth + 1 >= MAX_SLOT_DEPTH) return slot;
	const split = findParent(root, node.id);
	return split ? { ...slot, outer: placeOf(root, split, hidden, depth + 1) } : slot;
}

/**
 * Where the container `node` is, for an `outer`: the slot of the gone split it is all that is left
 * of (`lastSplitSlot`, #727 - say `column[row[a,b], c]` with `c` hidden: the row is the root now,
 * but its place is beside `c`), else where it is now (`hereOf`). Only when every panel of `node`
 * is named by a slot of that split: a pane docked into `node` since (say `d` was all that was left
 * of a row, and `b` was shown beside it in a new column) means `node` is not what is left of it.
 */
function placeOf(
	root: DockNode | null,
	node: DockNode,
	hidden: HiddenDockSlot[],
	depth: number
): DockSlot {
	const last = lastSplitSlot(root, node, hidden, depth);
	if (last?.kind === 'split') {
		const named = new Set(
			hidden
				.filter((h) => stillHidden(root, h))
				.flatMap((h) => {
					const out: string[] = [];
					for (let s: DockSlot | undefined = h.slot; s && s.kind !== 'root'; s = s.outer)
						if (s.kind === 'split' && s.splitId === last.splitId) out.push(...slotNames(s));
					return out;
				})
		);
		const parts = node.type === 'split' ? node.children : [node];
		if (parts.every((c) => named.has(c.id) || collectPanelIds(c).some((id) => named.has(id))))
			return last;
	}
	return hereOf(root, node, hidden, depth);
}

/**
 * `slot` and its `outer` chain, nearest first, without the root. A chain cut at `MAX_SLOT_DEPTH`
 * goes on with the place another hidden pane remembers for the split it was cut at (`placeOfGone`,
 * Codex P2 on #732): every walk over the chain on the capture side goes through here.
 */
function chainOf(
	root: DockNode | null,
	slot: DockSlot,
	hidden: HiddenDockSlot[]
): Exclude<DockSlot, { kind: 'root' }>[] {
	const out: Exclude<DockSlot, { kind: 'root' }>[] = [];
	const seen = new Set<string>();
	let s: DockSlot | undefined = slot;
	while (s && s.kind !== 'root') {
		const key = s.kind === 'tab' ? s.groupId : s.splitId;
		if (seen.has(key)) break;
		seen.add(key);
		out.push(s);
		s = s.outer ?? (s.kind === 'split' ? placeOfGone(root, s, hidden) : undefined);
	}
	return out;
}

/** The tab groups / splits a slot names by its `outer` chain (`chainOf`), nearest first. */
function slotContainers(root: DockNode | null, slot: DockSlot, hidden: HiddenDockSlot[]): string[] {
	return chainOf(root, slot, hidden).map((s) => (s.kind === 'tab' ? s.groupId : s.splitId));
}

/** The ids of `node` and every node inside it. */
function nodeIds(node: DockNode): string[] {
	return node.type === 'panel' ? [node.id] : [node.id, ...node.children.flatMap(nodeIds)];
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
		outer: placeOf(root, unit, hidden, 1)
	};
}

/**
 * The last child `unit` of a split (#721, the split version of `lastTabSlot`): the panes in
 * `hidden` remember a split that is gone and name `unit` (or a panel in it) as their neighbour
 * or an anchor. The split's children are rebuilt from their slots (`splitOrder`), and the slot is
 * a child of that split, with `outer` = where `unit` is now. `size` is an even share (the share
 * the last child had is not known); `share` (#733) what the hidden children's shares leave. The
 * most recent such split (the last in `hidden`) wins.
 * Only when `unit` is the whole surviving child: no pane (or container) named by any slot of
 * that split - a hidden pane's own slot or an `outer` of it, nested too - is docked outside it.
 * `null` when there is none.
 */
function lastSplitSlot(
	root: DockNode | null,
	unit: DockNode,
	hidden: HiddenDockSlot[],
	depth: number
): DockSlot | null {
	// Every id in `unit`: its panels and the tab groups / splits inside it (#727: `unit` may be a
	// container, `placeOf`).
	const own = new Set(nodeIds(unit));
	const named = slotNames;
	// The slots of gone splits: a hidden pane's own, and (#727) an `outer` of it - the place of a
	// container every pane of which is hidden (its most recent one per container; `child` = that
	// container, standing in for it in the split).
	const byKey = new Map<string, HiddenDockSlot & { child?: string }>();
	for (const h of hidden) {
		if (!stillHidden(root, h)) continue;
		let child: string | undefined;
		// A pane named inside the container that is docked: the container is not all hidden.
		let left = false;
		for (const s of chainOf(root, h.slot, hidden)) {
			if (left) break;
			if (
				s.kind === 'split' &&
				!findNode(root, s.splitId) &&
				(child === undefined || !findNode(root, child))
			) {
				const key = JSON.stringify([child ?? null, child === undefined ? h.id : '', s.splitId]);
				byKey.delete(key);
				byKey.set(key, { id: h.id, slot: s, child });
			}
			child = s.kind === 'tab' ? s.groupId : s.splitId;
			left = slotNames(s).some((id) => findNode(root, id) !== null);
		}
	}
	const gone = [...byKey.values()];
	// Not a split that was inside `unit` (#727: its slot's `outer` chain names `unit`, say a row
	// gone from inside a column that is `unit`).
	const inside = (slot: DockSlot): boolean =>
		slotContainers(root, slot, hidden).slice(1).includes(unit.id);
	const candidates = gone.filter(
		(h) => h.slot.kind === 'split' && named(h.slot).some((id) => own.has(id)) && !inside(h.slot)
	);
	// The innermost one (#727): not a split another one was inside (say `in` of `column[row(in)[a,b],
	// c]` over `s` once `a` and `c` are hidden), else the most recent.
	const around = (h: HiddenDockSlot): boolean => {
		const id = slotContainers(root, h.slot, hidden)[0];
		return candidates.some(
			(o) => o !== h && slotContainers(root, o.slot, hidden).slice(1).includes(id)
		);
	};
	const last = candidates.filter((h) => !around(h)).at(-1) ?? candidates.at(-1);
	if (!last || last.slot.kind !== 'split') return null;
	const { splitId, direction } = last.slot;
	const pending = gone.filter(
		(h) => h.slot.kind === 'split' && h.slot.splitId === splitId && h.slot.direction === direction
	);
	// `unit` must be all that is left of the split's surviving child (Codex P2 on #725, twice): a
	// pane named by ANY slot of the split that is docked outside `unit` (say `unit` is one pane
	// of a surviving column) means the child is still there, so `unit` keeps its slot in that
	// child. One old slot is not enough: a pane hidden when it was taken (so not named there) may
	// be docked again beside `unit` - a newer slot of the split names it. The `outer` slots count
	// too (Codex P2 on #725 again): a tab group / split hidden as a whole remembers its
	// place in the split there, with the panes beside it (say `d` shown again into the column
	// it shares with `unit`). Any slot naming the split, whatever its direction: when in doubt,
	// keep the slot in the current split, as before #721.
	const whole = (id: string) => own.has(id) || !findNode(root, id);
	const evidence = hidden
		.filter((h) => stillHidden(root, h))
		.flatMap((h) => {
			const chain: Extract<DockSlot, { kind: 'split' }>[] = [];
			for (let s: DockSlot | undefined = h.slot; s && s.kind !== 'root'; s = s.outer)
				if (s.kind === 'split' && s.splitId === splitId) chain.push(s);
			return chain;
		});
	if (!evidence.every((slot) => named(slot).every(whole))) return null;
	// And `unit` is where the split was (Codex P2 on #725): every slot of the split remembers the
	// split's own place as `outer` - the root, or a child of a split - and `unit` is there now.
	// Else (`unit` docked into another split since, say a row it shares with a pane shown again
	// later, or a slot without `outer`) the split's place is not known: no guess.
	const parent = findParent(root, unit.id);
	// A split around it that is gone too (#727, nested `outer`): its own place, and so on out. A
	// chain cut at `MAX_SLOT_DEPTH` (Codex P2 on #732) goes on with the place another hidden pane
	// remembers for the last split it names.
	const atOuter = (slot: DockSlot | undefined): boolean => {
		let outer = slot;
		const seen = new Set<string>();
		while (outer?.kind === 'split' && !findNode(root, outer.splitId) && !seen.has(outer.splitId)) {
			seen.add(outer.splitId);
			outer = outer.outer ?? placeOfGone(root, outer, hidden);
		}
		return outer?.kind === 'root'
			? parent === null
			: outer?.kind === 'split' &&
					parent?.type === 'split' &&
					parent.id === outer.splitId &&
					parent.direction === outer.direction;
	};
	if (
		!pending.every(
			(h) => h.slot.kind === 'split' && atOuter(h.slot.outer ?? placeOfGone(root, h.slot, hidden))
		)
	)
		return null;
	const ids = splitOrder([unit], pending);
	// The other hidden panes of a container standing in for it (`remnantPanes`).
	const remnants = new Map<string, string[]>();
	for (const e of pending) {
		if (e.child === undefined || !ids.includes(e.id)) continue;
		const more = hidden.filter(
			(h) =>
				h.id !== e.id &&
				!ids.includes(h.id) &&
				stillHidden(root, h) &&
				slotContainers(root, h.slot, hidden).includes(e.child!)
		);
		if (more.length > 0)
			remnants.set(
				e.id,
				more.map((h) => h.id)
			);
	}
	// `size` an even share of the reconstructed children, as before; #733: `share` what the hidden
	// children's shares leave of the whole split (only when theirs are all known).
	const rest = 1 - pendingShare(pending, ids);
	const slot = withShare(
		splitSlotAt([unit], ids, unit.id, splitId, direction, 1 / ids.length, remnants),
		rest
	);
	if (depth + 1 >= MAX_SLOT_DEPTH) return slot;
	// The split's place: inside a split that is gone too (#727), that one's place as the newest
	// slot remembers it; else where `unit` is now.
	const place = last.slot.outer ?? placeOfGone(root, last.slot, hidden);
	const outer =
		place?.kind === 'split' && !findNode(root, place.splitId)
			? cut(place, depth + 1, (gone) => placeOfGone(root, gone, hidden))
			: hereOf(root, unit, hidden, depth + 1);
	return { ...slot, outer };
}

/**
 * Where the gone split of `slot` was, when `slot` is where a hidden pane's `outer` chain was cut at
 * `MAX_SLOT_DEPTH` (so it has no `outer`): by the newest slot of a hidden pane that names that
 * split with an `outer` (Codex P2 on #732). `undefined` when none does, or when `slot` is not cut
 * there (say an older JSON slot without `outer`: its split's place is not known, as before).
 */
function placeOfGone(
	root: DockNode | null,
	slot: Extract<DockSlot, { kind: 'split' }>,
	hidden: HiddenDockSlot[]
): DockSlot | undefined {
	if (slot.outer) return slot.outer;
	const cutHere = hidden.some((h) => {
		let s: DockSlot | undefined = h.slot;
		for (let level = 0; s && level < MAX_SLOT_DEPTH - 1; level++)
			s = s.kind === 'root' ? undefined : s.outer;
		return s === slot;
	});
	if (!cutHere) return undefined;
	for (const h of [...hidden].reverse()) {
		if (!stillHidden(root, h)) continue;
		for (let s: DockSlot | undefined = h.slot; s && s.kind !== 'root'; s = s.outer)
			if (
				s.kind === 'split' &&
				s.splitId === slot.splitId &&
				s.direction === slot.direction &&
				s.outer
			)
				return s.outer;
	}
	return undefined;
}

/**
 * `slot` as the slot `depth` deep: its `outer` chain cut at `MAX_SLOT_DEPTH`. Where the chain was
 * cut before, at a shallower place now (Codex P2 on #732), it goes on with `onwards` (the place
 * another hidden pane remembers for that split, `placeOfGone`).
 */
function cut(
	slot: DockSlot,
	depth: number,
	onwards: (gone: Extract<DockSlot, { kind: 'split' }>) => DockSlot | undefined
): DockSlot {
	if (slot.kind === 'root') return slot;
	const { outer: own, ...rest } = slot;
	if (depth + 1 >= MAX_SLOT_DEPTH) return rest;
	const outer = own ?? (slot.kind === 'split' ? onwards(slot) : undefined);
	return outer ? { ...rest, outer: cut(outer, depth + 1, onwards) } : rest;
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
	const slot = unitSlot(root, node);
	// No `share` (#739 review): the panes hidden from the split are not known here, so the share of
	// the whole split is not either - a pane later hidden from the band (`dismiss` copies this slot)
	// comes back by `size`, as before #733.
	if (slot.kind !== 'split' || slot.share === undefined) return slot;
	const { share: _share, ...rest } = slot;
	return rest;
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
	const pending = splitPending(root, split, [...hidden]);
	const ids = splitOrder(split.children, pending);
	// #733: `share`, of the whole split, the hidden panes' shares counted - the docked children
	// share what they left. `size` stays the share among the docked children, as before.
	const rest = 1 - pendingShare(pending, ids);
	const size = split.sizes[own] ?? 1 / split.children.length;
	const slot = splitSlotAt(
		split.children,
		ids,
		unit.id,
		split.id,
		split.direction,
		size,
		remnantPanes(root, split, [...hidden], ids)
	);
	return withShare(slot, rest * size);
}

/**
 * `slot` with `share` (#733, `DockSlot`) when it is known (a number in (0, 1]); without, when the
 * shares of the panes hidden from the split are not all known (one of them a slot taken before
 * #733) - it then comes back by `size`, as before.
 */
function withShare(
	slot: Extract<DockSlot, { kind: 'split' }>,
	share: number
): Extract<DockSlot, { kind: 'split' }> {
	const next = { ...slot };
	delete next.share;
	return share > 1e-9 && share <= 1 ? { ...next, share } : next;
}

/** The ids a slot names: a tab slot's anchors, a split slot's neighbour and anchors (both sides). */
function slotNames(slot: DockSlot): string[] {
	return slot.kind === 'tab'
		? [...slot.anchors]
		: slot.kind === 'split'
			? [slot.neighborId, ...slot.anchors, ...(slot.otherAnchors ?? [])]
			: [];
}

/**
 * The hidden panes that belong to a child of `split` (#727): a pane hidden out of a container
 * docked in that child, or one whose container (or one around it, by its `outer` chain) was a
 * child of `split` and is gone, its panes left beside the pane named there (say
 * `column[row[a,b], c]` with `a` hidden: `b` is all that is left of the row).
 * Keyed by that child's id, so a slot taken in `split` counts them among the panels of that child
 * (`anchors` / `otherAnchors`) - and `restoreSplit` wraps the whole child again once they are
 * back. The ones counted in `split` already (`ids`) are left out.
 */
function remnantPanes(
	root: DockNode | null,
	split: DockSplitNode,
	hidden: HiddenDockSlot[],
	ids: string[]
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const docked = (id: string) => findNode(root, id) !== null;
	// The containers each hidden pane's slot names, by its `outer` chain.
	const containers = new Map(hidden.map((h) => [h.id, slotContainers(root, h.slot, hidden)]));
	for (const h of hidden) {
		if (docked(h.id) || ids.includes(h.id)) continue;
		// Hidden out of a tab group / split still docked inside a child: one of that child's panes
		// (say `row[column[a,b,c], d]` with `a` hidden: `d`'s slot names it with `b` and `c`). Or
		// out of one that is gone, inside one still docked there (Codex P2 on #732: `b` of
		// `column[row[a,column[row[b,c],d]],e]`, its row gone, is still one of the panes of `a`'s
		// row): the nearest container of its `outer` chain that is docked.
		const containersOf = slotContainers(root, h.slot, hidden);
		const [own] = containersOf;
		const near = containersOf.find(docked);
		const holder =
			near === undefined ? undefined : split.children.find((c) => nodeIds(c).includes(near));
		if (holder) {
			out.set(holder.id, [...(out.get(holder.id) ?? []), h.id]);
			continue;
		}
		if (own !== undefined && docked(own)) continue;
		// The ids named on the way out: the pane's own container may name a pane left in the child
		// when the one around it names only hidden panes (say a tab group inside the gone split).
		const names: string[] = [];
		const chain = chainOf(root, h.slot, hidden);
		for (const [level, s] of chain.entries()) {
			names.push(...slotNames(s));
			const outer: DockSlot | undefined = chain[level + 1];
			if (
				outer?.kind !== 'split' ||
				outer.splitId !== split.id ||
				outer.direction !== split.direction
			)
				continue;
			const container = s.kind === 'tab' ? s.groupId : s.splitId;
			if (docked(container)) break;
			// The child left of the container; or, every pane of it hidden, the hidden pane that
			// stands for it among `ids` (`splitPending`: one per container).
			const child =
				split.children.find((c) => collectPanelIds(c).some((id) => names.includes(id)))?.id ??
				ids.find((id) => !docked(id) && containers.get(id)?.includes(container));
			if (child !== undefined) out.set(child, [...(out.get(child) ?? []), h.id]);
			break;
		}
	}
	return out;
}

/**
 * The hidden panes counted among the children of `split`, each with its split slot there: the
 * ones whose slot is in `split`, and (Codex P2 on #725) a container every pane of which is
 * hidden - its last pane remembers the container (a `tab` slot, or a split slot of a gone
 * split) and the container's place in `split` as `outer`. That place stays counted, so the panes
 * hidden after it keep it among their anchors. One entry per container: its most recent slot,
 * and only when that one remembers `split`. The container may be further out along the `outer`
 * chain (Codex P2 on #732, the second one: `g` of `row[b,c,column[tabs[d,e],tabs[f,g]]]`, hidden
 * last of the column, remembers its tab group, the group's place in the gone column, and the
 * column's place in the row): every container of the chain counts, the inner ones gone too. A
 * chain cut at `MAX_SLOT_DEPTH` goes on with `placeOfGone`.
 */
function splitPending(
	root: DockNode | null,
	split: Pick<DockSplitNode, 'id' | 'direction'>,
	hidden: HiddenDockSlot[]
): PendingSlot[] {
	const docked = (id: string) => findNode(root, id) !== null;
	// Not a type guard: a split slot of another split is still a split slot.
	const inSplit = (slot: DockSlot | undefined): boolean =>
		slot?.kind === 'split' && slot.splitId === split.id && slot.direction === split.direction;
	const direct: HiddenDockSlot[] = [];
	// The most recent slot of each container, whatever its `outer` (Codex P2 on #725): an older
	// one may remember a place in `split` the container has left since (its last pane was docked
	// again elsewhere and hidden from there).
	// Keyed by the container, with the slots of the pane's chain up to it (the container's slot
	// last).
	const latest = new Map<string, { id: string; chain: Exclude<DockSlot, { kind: 'root' }>[] }>();
	for (const h of hidden) {
		const slot = h.slot;
		if (docked(h.id) || slot.kind === 'root') continue;
		if (inSplit(slot)) {
			direct.push(h);
			continue;
		}
		const chain = chainOf(root, slot, hidden);
		for (const [level, s] of chain.entries()) {
			const key = s.kind === 'tab' ? s.groupId : s.splitId;
			latest.delete(key);
			latest.set(key, { id: h.id, chain: chain.slice(0, level + 1) });
		}
	}
	// The container's own place is gone: neither it nor a pane it names is docked - nor one named
	// by the slot of a hidden pane it names, and so on (Codex P2 on #725). Say its last pane was
	// docked again into another container and hidden from there: the panes beside it then (`unit`
	// among them, maybe) hold the old place, so it is not counted as a sibling of its own.
	const slotOf = new Map(hidden.filter((h) => !docked(h.id)).map((h) => [h.id, h.slot]));
	const names = (slot: DockSlot): string[] =>
		slot.kind === 'tab'
			? [...slot.anchors]
			: slot.kind === 'split'
				? [slot.neighborId, ...slot.anchors, ...(slot.otherAnchors ?? [])]
				: [];
	const gone = (slot: DockSlot): boolean => {
		if (slot.kind === 'root' || docked(slot.kind === 'tab' ? slot.groupId : slot.splitId))
			return false;
		const seen = new Set<string>();
		const todo = names(slot);
		for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
			if (docked(id)) return false;
			if (seen.has(id)) continue;
			seen.add(id);
			const next = slotOf.get(id);
			if (next) todo.push(...names(next));
		}
		return true;
	};
	const counted = new Set(direct.map((h) => h.id));
	const outer: PendingSlot[] = [];
	for (const [container, { id, chain }] of latest.entries()) {
		const slot = chain[chain.length - 1];
		if (counted.has(id)) continue;
		const place =
			slot.outer ?? (slot.kind === 'split' ? placeOfGone(root, slot, hidden) : undefined);
		if (!place || !inSplit(place) || !chain.every(gone)) continue;
		counted.add(id);
		outer.push({ id, slot: place, container });
	}
	return [...direct, ...outer];
}

/** A hidden pane counted among a split's children (`splitPending`): for a container, the container's id. */
interface PendingSlot extends HiddenDockSlot {
	container?: string;
}

/**
 * The share of the split the pending panes placed among `ids` remember, summed (#733: a split
 * slot's `share` is its share of the whole split, the hidden children counted). `NaN` when one of
 * them has no `share` (a slot taken before #733: its `size` is a share of the split as it was
 * then, which cannot be added up with the others).
 */
function pendingShare(pending: HiddenDockSlot[], ids: string[]): number {
	let sum = 0;
	const counted = new Set<string>();
	for (const h of pending) {
		if (h.slot.kind !== 'split' || !ids.includes(h.id) || counted.has(h.id)) continue;
		counted.add(h.id);
		sum += h.slot.share ?? NaN;
	}
	return sum;
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
	size: number,
	remnants: Map<string, string[]> = new Map()
): Extract<DockSlot, { kind: 'split' }> {
	const index = ids.indexOf(unitId);
	const hasNext = index + 1 < ids.length;
	// Nearest first: the panels on each side (a hidden pane stands for itself).
	const panels = (side: string[], reverse: boolean) =>
		side.flatMap((id) => {
			const child = children.find((c) => c.id === id);
			if (!child) return [id, ...(remnants.get(id) ?? [])];
			const p = collectPanelIds(child);
			return [...(reverse ? p.reverse() : p), ...(remnants.get(id) ?? [])];
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
	makeId: () => string,
	size: number = slot.size
): DockNode | null {
	const share = clampShare(size);
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
	const neighbor = besideWhat(root, liftOutOfTabs(root, found), slot, before);
	// Always a new split around the neighbour, even inside a split of the same direction (a
	// row in a row from an edge dock, cross-review P2 on #725): splicing into that one would
	// merge the gone split into it.
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
 * What a pane of the gone split of `slot` goes beside, found `node` (#727): `node`, or the node
 * around it made of nothing but the panels the slot names on that side - the whole child of the
 * split again (say `column[row[a,b], c]`: `c` goes beside the row `a` and `b` are in again, not
 * beside `b`). Not above the split the gone one was in (`outer`), and only with an `outer` (a
 * slot without one - older JSON, a region's - goes beside `node`, as before).
 */
function besideWhat(
	root: DockNode,
	node: DockNode,
	slot: Extract<DockSlot, { kind: 'split' }>,
	before: boolean
): DockNode {
	if (!slot.outer) return node;
	const near = before === (slot.side === 'before');
	const named = new Set(near ? [slot.neighborId, ...slot.anchors] : (slot.otherAnchors ?? []));
	const stop = slot.outer.kind === 'split' ? slot.outer.splitId : null;
	let target = node;
	for (
		let parent = findParent(root, target.id);
		parent && parent.id !== stop && collectPanelIds(parent).every((id) => named.has(id));
		parent = findParent(root, parent.id)
	)
		target = parent;
	return target;
}

/**
 * The share a pane put back at the split slot `slot` takes of the space it splits (#733): `share`
 * is its share of the whole split, the panes hidden from it counted, so it is scaled up by the
 * share of the hidden children of the split still out (`hidden`, as `splitPending` counts them;
 * not the containers `mine` - the ones the pane itself comes back from). Say `row[a,b,c]` with `a`
 * and `b` hidden: `a` shown first takes 1/2 beside `c`, then `b` 1/3 of the row. When it has no
 * `share`, or one of those has none (a slot taken before #733, cross review on #739), or the
 * shares do not add up (a split changed since), `size` as before: its share of the split when it
 * was taken.
 */
function restoreShare(
	root: DockNode,
	slot: Extract<DockSlot, { kind: 'split' }>,
	hidden: HiddenDockSlot[],
	mine: Set<string>
): number {
	const share = slot.share;
	if (share === undefined) return slot.size;
	if (hidden.length === 0) return share;
	const pending = splitPending(
		root,
		{ id: slot.splitId, direction: slot.direction },
		hidden
	).filter((h) => h.container === undefined || !mine.has(h.container));
	const sum = pendingShare(
		pending,
		pending.map((h) => h.id)
	);
	return sum >= 0 && sum + share < 1 + 1e-9 ? Math.min(1, share / (1 - sum)) : slot.size;
}

/**
 * `slot` (a closed window's `dockSlot`) with every split level's `share` taken as a share of the
 * split without the panes of `all` that are not in `kept` (Codex P2 on #739): `share` counts the
 * shares of the panes hidden from the split (#733), the floated panes' `homeSlot`s among them, but
 * those are not saved - after `serialize` / `hydrate` they no longer count, and `restoreShare`
 * would scale it by a share the split has lost. Say `row[a .2, b .3, c .5]`, `a` floated and `b`
 * hidden: `b`'s share `.3` (of the whole row) is saved as `.375` (of `row[b,c]`). Counted as
 * `restoreShare` does (`splitPending` / `pendingShare`). A level whose shares do not add up (one
 * of them taken before #733, a split changed since) loses its `share`: it comes back by `size`,
 * which counts no hidden pane.
 */
export function slotWithoutShares(
	root: DockNode | null,
	slot: DockSlot,
	all: HiddenDockSlot[],
	kept: HiddenDockSlot[]
): DockSlot {
	if (slot.kind === 'root') return slot;
	const outer = slot.outer && slotWithoutShares(root, slot.outer, all, kept);
	const next: DockSlot = outer === slot.outer ? slot : { ...slot, outer };
	if (next.kind !== 'split' || next.share === undefined) return next;
	const split = { id: next.splitId, direction: next.direction };
	const sum = (hidden: HiddenDockSlot[]): number => {
		const pending = splitPending(root, split, hidden);
		return pendingShare(
			pending,
			pending.map((h) => h.id)
		);
	};
	const whole = sum(all);
	const gone = whole - sum(kept);
	if (gone === 0) return next;
	// `whole` is 1 when no child of the split is docked (they are all out).
	const ok = whole < 1 + 1e-9 && gone > 0 && gone < 1 - 1e-9;
	return withShare(next, ok ? next.share / (1 - gone) : NaN);
}

/**
 * How the slots of the panes out of the tree change when docked panes leave a split they share
 * with them (#743), or `null` when none does. A split slot's `share` is of the whole split, the
 * panes hidden from it counted (#733): a docked child that leaves the split for good - removed
 * from the layout, docked into another container - takes its part out of
 * the whole, so the shares of the panes still out are taken without it, as `slotWithoutShares`
 * does for a pane out of the tree that goes. Say `row[x .2, b .3, c .5]`, `b` hidden, `x` removed:
 * `b` comes back at `.375` (of `row[b, c]`), not `.3`.
 *
 * `root` is the tree before, `next` the one after, `pending` the panes out of the tree after (as
 * `splitPending` takes them). The part of a child is its size among the docked children times
 * what the pending shares leave (`1 - pendingShare`), counted on `root`; for a split that is gone
 * (what is left of it is the docked panes its slots name), the whole of what they leave.
 *
 * `back` are the panes out of the tree before that the same change puts back in their place (so
 * not in `pending`), with the slots they had: the docked children had only the room their shares
 * left too (cross-review P2 on #743). Say `row[a .1, b .2, c .3, d .4]`, `b` and `c` hidden, `c`
 * back and `a` removed at once: `a` and `d` had `.5` of the row, so `a` takes `.1` out and `b`
 * comes back at `.2 / .9`, as when `c` is shown first. Their shares are of the same whole as
 * those of `pending` (the caller takes both without the panes gone for good first).
 *
 * A child has not left while one of its panes is docked where the split is (in it; anywhere when
 * the split is gone after), or a pane out of the tree holds its place after: itself (hidden or
 * floated by the same change - whatever its slot is, also one that does not name the split, as the
 * `root` slot of the last docked pane), or one that remembers the container it was the last of (counted
 * for the split on `next` and not on `root`). `moved` is the docked pane the change moves
 * (`dockExisting` / `dockExistingAtEdge` - the trees alone do not tell which of two panes moved):
 * it has left unless it is a child of the same split again (or, the split gone with it, of a
 * split in the same direction with another of its children: a split of two made again around
 * them); `edge` = to an outer edge of the host, never the same split.
 *
 * `banded` are the panes auto-hidden to an edge band after: one of them has not left either. Its
 * band remembers its place and it comes back by `size` (a region's slot has no `share`, #739
 * review), so with the others' shares left as they are, hide `a` / auto-hide `b` / `b` back /
 * show `a` gives the old sizes again.
 */
export function slotsWithoutLeft(
	root: DockNode | null,
	next: DockNode | null,
	pending: HiddenDockSlot[],
	moved: { id: string; edge: boolean } | null = null,
	banded: ReadonlySet<string> = new Set(),
	back: HiddenDockSlot[] = []
): ((slot: DockSlot) => DockSlot) | null {
	if (root === null || pending.length === 0) return null;
	type SplitSlot = Extract<DockSlot, { kind: 'split' }>;
	interface Unit {
		/** The child itself when it is a pane (what `moved` can be). */
		panel: string | null;
		ids: string[];
		panels: string[];
		part: number;
	}
	const keyOf = (s: SplitSlot) => `${s.direction}:${s.splitId}`;
	const splits = new Map<string, Pick<DockSplitNode, 'id' | 'direction'>>();
	for (const h of pending)
		for (let s: DockSlot | undefined = h.slot; s && s.kind !== 'root'; s = s.outer)
			if (s.kind === 'split' && s.share !== undefined)
				splits.set(keyOf(s), { id: s.splitId, direction: s.direction });
	if (splits.size === 0) return null;
	const slotOf = new Map(pending.map((h) => [h.id, h.slot]));
	const dockedNext = new Set(collectPanelIds(next));
	// The panes out of the tree before: the ones still out, and the ones the change puts back.
	const before = [...pending, ...back.filter((h) => !slotOf.has(h.id))];
	/** The docked panes left of a split that is gone: the ones the slots of its panes name. */
	const remnant = (was: HiddenDockSlot[]): string[] =>
		[...new Set(was.flatMap((h) => slotNames(h.slot)))].filter(
			(id) => findNode(root, id)?.type === 'panel'
		);
	// The splits gone before whose one docked pane left is the one moved: it has left them
	// (cross-review P2 on #743). Their slots stop naming it, so the panes come back to the split's
	// own place (`outer`), not around the pane where it went.
	const lone = new Set<string>();
	if (moved !== null)
		for (const [key, split] of splits) {
			if (findNode(root, split.id)) continue;
			const named = remnant(splitPending(root, split, before));
			if (named.length === 1 && named[0] === moved.id) lone.add(key);
		}
	const forget = (slot: DockSlot): DockSlot => {
		if (lone.size === 0 || moved === null || slot.kind === 'root') return slot;
		const outer = slot.outer && forget(slot.outer);
		const out: DockSlot = outer === slot.outer ? slot : { ...slot, outer };
		if (out.kind !== 'split' || !lone.has(keyOf(out)) || !slotNames(out).includes(moved.id))
			return out;
		const others = (ids: string[]) => ids.filter((id) => id !== moved.id);
		return {
			...out,
			// No docked node: the id of the split itself (gone; found again, the pane goes into it).
			neighborId: out.neighborId === moved.id ? out.splitId : out.neighborId,
			anchors: others(out.anchors),
			...(out.otherAnchors ? { otherAnchors: others(out.otherAnchors) } : {})
		};
	};
	const pendingNext =
		lone.size > 0 ? pending.map((h) => ({ ...h, slot: forget(h.slot) })) : pending;
	/** What is left of each split: 1 - the part of the children that left. */
	const rest = new Map<string, number>();
	for (const [key, split] of splits) {
		const was = splitPending(root, split, before);
		const held = pendingShare(
			was,
			was.map((h) => h.id)
		);
		// Nothing out of it before, shares not all known, or no room left for a docked child.
		if (!(held > 1e-9) || held > 1 - 1e-9) continue;
		const node = findNode(root, split.id);
		let units: Unit[];
		if (node?.type === 'split' && node.direction === split.direction) {
			const total = node.sizes.reduce((a, b) => a + b, 0);
			units = node.children.map((c, i) => ({
				panel: c.type === 'panel' ? c.id : null,
				ids: nodeIds(c),
				panels: collectPanelIds(c),
				part: total > 0 ? ((node.sizes[i] ?? 0) / total) * (1 - held) : 0
			}));
		} else if (node) {
			continue;
		} else {
			const named = remnant(was);
			if (named.length === 0) continue;
			// One pane left of it: that pane is the child (`lone`). Moved, it has left - no other
			// child is docked for it to make the split again with (`movedAway`).
			units = [
				{
					panel: named.length === 1 ? named[0] : null,
					ids: named,
					panels: named,
					part: 1 - held
				}
			];
		}
		const after = findNode(next, split.id);
		const here =
			after?.type === 'split' && after.direction === split.direction
				? new Set(collectPanelIds(after))
				: dockedNext;
		// The panes out of the tree that hold a place in the split after and did not before, with
		// what their slots name below the split's level (the containers they stand for).
		const counted = new Set(was.map((h) => h.id));
		const holders = new Set<string>();
		for (const h of splitPending(next, split, pendingNext)) {
			if (counted.has(h.id)) continue;
			holders.add(h.id);
			for (let s = slotOf.get(h.id); s && s.kind !== 'root'; s = s.outer) {
				if (s.kind === 'split' && keyOf(s) === key) break;
				holders.add(s.kind === 'tab' ? s.groupId : s.splitId);
				for (const id of slotNames(s)) holders.add(id);
			}
		}
		const movedAway = (unit: Unit): boolean => {
			if (moved === null || unit.panel !== moved.id) return false;
			if (moved.edge) return true;
			const parent = findParent(next, moved.id);
			if (parent?.type !== 'split' || parent.direction !== split.direction) return true;
			if (parent.id === split.id) return false;
			if (after) return true;
			const others = units.filter((u) => u !== unit).flatMap((u) => u.panels);
			return !parent.children.some(
				(c) => c.id !== moved.id && collectPanelIds(c).some((id) => others.includes(id))
			);
		};
		let left = 0;
		for (const unit of units) {
			if (unit.panels.some((id) => here.has(id)) && !movedAway(unit)) continue;
			if (unit.panels.some((id) => banded.has(id))) continue;
			// One of its panes is out of the tree after: hidden or floated, it is still in the layout,
			// whatever its slot says - a `root` slot (the last docked pane: nothing left to name) is
			// not counted for the split by `splitPending` (Codex P2 on #776).
			if (unit.panels.some((id) => slotOf.has(id))) continue;
			if (unit.ids.some((id) => holders.has(id))) continue;
			left += unit.part;
		}
		if (left > 1e-9 && left < 1 - 1e-9) rest.set(key, 1 - left);
	}
	if (rest.size === 0 && lone.size === 0) return null;
	const shares = (slot: DockSlot): DockSlot => {
		if (slot.kind === 'root') return slot;
		const outer = slot.outer && shares(slot.outer);
		const out: DockSlot = outer === slot.outer ? slot : { ...slot, outer };
		if (out.kind !== 'split' || out.share === undefined) return out;
		const of = rest.get(keyOf(out));
		if (of === undefined) return out;
		const share = out.share / of;
		// Above 1: the shares did not add up (a split changed since) - it comes back by `size`.
		return withShare(out, share < 1 + 1e-9 ? Math.min(1, share) : NaN);
	};
	return (slot) => shares(forget(slot));
}

/**
 * Put `panel` back into `root` at `slot` (module doc for the order of tries).
 * Returns the new root, or `null` when the place is gone (the caller falls
 * back to a floating window). `panel` must not be in `root` already.
 *
 * `hidden` are the other panes out of the tree that remember a place (as for
 * `captureDockSlot`): the share it takes of a split leaves theirs for them
 * (#733), so a split's sizes come back whatever order its panes are shown in.
 */
export function restoreDockSlot(
	root: DockNode | null,
	panel: DockPanelNode,
	slot: DockSlot,
	makeId: () => string,
	hidden: Iterable<HiddenDockSlot> = []
): DockNode | null {
	if (root === null) return panel;
	if (findNode(root, panel.id)) return null;
	const others = [...hidden].filter((h) => h.id !== panel.id);
	// The containers the pane comes back from: a hidden pane standing for one of them is not a
	// sibling of its own (say `b` of `column[row[a,b], c]`, when `a` goes back to the row's place).
	const mine = new Set<string>();
	for (let s: DockSlot | undefined = slot; s && s.kind !== 'root'; s = s.outer)
		mine.add(s.kind === 'tab' ? s.groupId : s.splitId);
	const place = (s: DockSlot): DockNode | null =>
		s.kind === 'tab'
			? restoreTab(root, panel, s, makeId)
			: s.kind === 'split'
				? restoreSplit(root, panel, s, makeId, restoreShare(root, s, others, mine))
				: null;
	// The container's own place (#721) only after the container and the anchors; then the place of
	// the container around it (#727: nested `outer`), and so on, at most `MAX_SLOT_DEPTH` deep.
	let s: DockSlot | undefined = slot;
	for (let depth = 0; s && s.kind !== 'root' && depth < MAX_SLOT_DEPTH; depth++, s = s.outer) {
		const next = place(s);
		if (next) return next;
	}
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
