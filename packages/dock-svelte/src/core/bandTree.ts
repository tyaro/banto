/**
 * The saved form of the places of the regions in the edge bands (Issue #782 PR8b;
 * `DockLayout.dockedWithAutoHidden`). Pure, no Svelte imports.
 *
 * `DockState` keeps a region auto-hidden to an edge band in its shadow tree S (`core/shadow.ts`)
 * as tombstones marked `band`: the panes of the region, each a leaf `away` and `band`, in the
 * split / tab group they were in - a tab group with the group itself and its id. A layout is saved
 * with that tree, without the tombstones of the floating windows (`bandTreeOf`: their places are
 * not saved), and read back when the tree still shows the docked tree saved with it
 * (`readBandTree`). A tree that does not is dropped as a whole - no place is guessed from it: the
 * regions then dock at their default place, or along their edge (`DockState.restoreAutoHidden`).
 */
import type { DockNode, ShadowNode, ShadowPanelNode } from '../types';
import { findShadowPanel, removeFromShadow, shadowPanelIds, writeShadowView } from './shadow';

/** The panes of S that are in an edge band (the tombstones marked `band`), in tree order. */
export function shadowBandIds(s: ShadowNode | null): string[] {
	if (!s) return [];
	if (s.type !== 'panel') return s.children.flatMap((c) => shadowBandIds(c));
	return s.away === true && s.band === true ? [s.id] : [];
}

/**
 * What a layout is saved with for S: S without the tombstones of the floating windows (each taken
 * out as `removeFromShadow` does - its share goes to its siblings, a split / tab group left with
 * one child folds), so what it shows is what S shows. `null` when S holds no pane of an edge band:
 * nothing is saved then. S itself when it holds no other tombstone.
 */
export function bandTreeOf(s: ShadowNode | null): ShadowNode | null {
	if (s === null) return null;
	let out: ShadowNode | null = s;
	let any = false;
	for (const id of shadowPanelIds(s, 'away')) {
		if (findShadowPanel(s, id)?.band === true) any = true;
		else out = removeFromShadow(out, id);
	}
	return any ? out : null;
}

/** The tab group each tab of `s` is in, by the tab's id (a pane that is not a tab has no entry). */
function tabGroupsByTab(
	s: ShadowNode,
	into = new Map<string, ShadowNode>()
): Map<string, ShadowNode> {
	if (s.type === 'tabs') for (const tab of s.children) into.set(tab.id, s);
	else if (s.type === 'split') for (const child of s.children) tabGroupsByTab(child, into);
	return into;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `raw` as a shadow tree whose only tombstones are marked `band`, with every split's `sizes`
 * scaled to add up to 1; `undefined` when it is not one (the shape of a node, an id twice, a
 * tombstone without `band` or a `band` that is not a tombstone). A value that contains itself
 * ends at the node met twice (`visited`, as `validateDockLayout` ends the docked tree): the tree
 * may be as deep as the docked tree it is saved with - no depth of its own is refused (Codex
 * cross-review of PR #876).
 */
function shapeOf(
	raw: unknown,
	seen: Set<string>,
	visited: WeakSet<object>,
	inTabs: boolean
): ShadowNode | undefined {
	if (!isRecord(raw) || visited.has(raw)) return undefined;
	visited.add(raw);
	if (typeof raw.id !== 'string' || raw.id === '' || seen.has(raw.id)) return undefined;
	seen.add(raw.id);
	if (raw.collapsed !== undefined && typeof raw.collapsed !== 'boolean') return undefined;
	if (raw.type === 'panel') {
		if (typeof raw.title !== 'string') return undefined;
		if (raw.icon !== undefined && typeof raw.icon !== 'string') return undefined;
		if (raw.away !== undefined && raw.away !== true) return undefined;
		if (raw.band !== undefined && raw.band !== true) return undefined;
		if ((raw.away === true) !== (raw.band === true)) return undefined;
		const leaf: ShadowPanelNode = { type: 'panel', id: raw.id, title: raw.title };
		if (raw.icon !== undefined) leaf.icon = raw.icon as string;
		if (raw.away === true) {
			leaf.away = true;
			leaf.band = true;
		} else if (raw.collapsed === true && !inTabs) leaf.collapsed = true;
		return leaf;
	}
	if (inTabs || !Array.isArray(raw.children)) return undefined;
	const children: ShadowNode[] = [];
	for (let i = 0; i < raw.children.length; i++) {
		const child = shapeOf(raw.children[i], seen, visited, raw.type === 'tabs');
		if (child === undefined) return undefined;
		children.push(child);
	}
	if (raw.type === 'tabs') {
		const active = raw.activeIndex;
		if (children.length === 0) return undefined;
		if (typeof active !== 'number' || !Number.isInteger(active)) return undefined;
		if (active < 0 || active >= children.length) return undefined;
		return {
			type: 'tabs',
			id: raw.id,
			children: children as ShadowPanelNode[],
			activeIndex: active,
			...(raw.collapsed === true ? { collapsed: true } : {})
		};
	}
	if (raw.type !== 'split') return undefined;
	if (raw.direction !== 'row' && raw.direction !== 'column') return undefined;
	const sizes = raw.sizes;
	if (children.length < 2 || !Array.isArray(sizes) || sizes.length !== children.length) {
		return undefined;
	}
	let total = 0;
	for (let i = 0; i < sizes.length; i++) {
		const size: unknown = sizes[i];
		if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined;
		total += size;
	}
	if (!Number.isFinite(total)) return undefined;
	return {
		type: 'split',
		id: raw.id,
		direction: raw.direction,
		children,
		sizes:
			total > 0
				? (sizes as number[]).map((size) => size / total)
				: sizes.map(() => 1 / sizes.length)
	};
}

/**
 * S for a layout read as a whole (`DockState.hydrate`, its constructor, `validateDockLayout`):
 * `raw` - the layout's `dockedWithAutoHidden`, untrusted - when it is a tree that shows `docked`
 * and whose tombstones are panes of `regions` (the pane ids of each entry of `autoHidden`).
 * `undefined` otherwise: the layout is read without it.
 *
 *  - "Shows `docked`": without its tombstones it has the panes, splits and tab groups of `docked`,
 *    by id, nested the same way. What moves no pane is taken from `docked` and written onto the
 *    tree (`writeShadowView`): the shares of the children that show, the active tabs and the
 *    order of the tabs, titles, icons and `collapsed` flags. The tombstones keep their share.
 *  - Every tombstone is marked `away` and `band`, and is a pane of one of `regions`.
 *  - A region with only some of its panes in the tree has no place: those are taken out.
 *  - A region of several panes is a tab group: its tombstones are tabs of ONE tab group of the
 *    tree (whatever its id - S gives a group another id when the band's would show twice). A tree
 *    that holds them apart - in two splits, or one as a bare pane - is not read at all: pinned
 *    back, the tabs would come out in different places (cross-review of PR #876).
 *
 * Never throws (a tree too deep for the stack is not read either), and never changes `raw` (the
 * result shares no node with it).
 */
export function readBandTree(
	raw: unknown,
	docked: DockNode | null,
	regions: readonly (readonly string[])[]
): ShadowNode | undefined {
	if (raw === undefined || raw === null) return undefined;
	try {
		let s: ShadowNode | null = shapeOf(raw, new Set(), new WeakSet(), false) ?? null;
		if (s === null) return undefined;
		const band = new Set(shadowBandIds(s));
		const known = new Set(regions.flat());
		for (const id of band) if (!known.has(id)) return undefined;
		const groups = tabGroupsByTab(s);
		for (const ids of regions) {
			const held = ids.filter((id) => band.has(id));
			if (held.length === ids.length) {
				const group = groups.get(ids[0]);
				if (ids.length > 1 && (group === undefined || ids.some((id) => groups.get(id) !== group)))
					return undefined;
				continue;
			}
			for (const id of held) s = removeFromShadow(s, id);
		}
		if (s === null || shadowBandIds(s).length === 0) return undefined;
		return writeShadowView(s, docked) ?? undefined;
	} catch {
		return undefined;
	}
}
