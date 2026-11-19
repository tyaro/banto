/**
 * Which docked panes a structure change pushes out (spec §5.2; #666). Pure.
 *
 * The docked tree is drawn by `DockedTree.svelte` recursively: the root by
 * its node type (an `{#if}` on `node.type`), every child of a split or a tab
 * group in a `{#each}` keyed by the child's id, and a tab's content only while
 * it is the active tab or `keepMounted`. So a pane's content survives a change
 * of the tree exactly when the chain that draws it is the same before and
 * after: the root's type, then the type and id of every node down to the pane
 * (its MOUNT KEY). When a new split or tab group is made around a pane (a drop
 * next to a bare pane, a pane put back beside it), the chain gets one more
 * link and the content is unmounted and mounted again - even `keepMounted`,
 * because a Svelte component cannot be moved to another parent. The dock UI
 * therefore asks `beforePanelChange` about those panes too (`displacedChanges`),
 * besides the pane being moved. A `persistent` pane (#663 ④, three-pane-dock-plan
 * §4.2 C) is the exception: its content is drawn outside the tree and only moved
 * into the new place, so it always survives.
 */
import type { DockPanelChange } from './lifecycle';
import type { DockNode } from '../types';

/** How a docked pane's content is drawn: the chain that mounts it, and whether it is on screen. */
export interface PaneMount {
	key: string;
	/** The bare pane or the active tab of its group (a collapsed region still counts: its content is only hidden). */
	shown: boolean;
}

/** Every docked pane whose content is mounted in `root`, by id (module doc). */
export function mountedPanes(
	root: DockNode | null,
	keepMounted: (panelId: string) => boolean
): Map<string, PaneMount> {
	const out = new Map<string, PaneMount>();
	const visit = (node: DockNode, chain: string): void => {
		if (node.type === 'panel') {
			out.set(node.id, { key: chain, shown: true });
			return;
		}
		if (node.type === 'tabs') {
			node.children.forEach((child, i) => {
				const shown = i === node.activeIndex;
				if (shown || keepMounted(child.id))
					out.set(child.id, { key: `${chain}/tab:${child.id}`, shown });
			});
			return;
		}
		for (const child of node.children) visit(child, `${chain}/${child.type}:${child.id}`);
	};
	if (root) visit(root, root.type);
	return out;
}

/**
 * The changes `before` -> `after` makes to docked panes other than `moving`
 * (the pane the user moves, asked about on its own), in tree order:
 *
 * - a pane on screen that becomes a background tab (the group's active tab
 *   before, or a bare pane wrapped into a new group) = `tab-switch` from it
 *   to the new active tab, `remount` when its content does not survive (not
 *   `keepMounted`, or its chain changed);
 * - any other mounted pane whose content does not survive (a pane, or the
 *   tabs of a group, that a new split is made around, or the one a split
 *   shrinks to when the moved pane leaves it) = `reparent` (`panelId` = this
 *   pane, `cause` = `moving`) with `remount: true` - it is not the pane being
 *   moved, but its parent changes, so it is mounted again.
 *
 * A pane that is not mounted before (a background tab that is not
 * `keepMounted`) has nothing to lose and is not listed, nor is a `persistent`
 * one whose parent changes (it is moved, not re-mounted).
 */
export function displacedChanges(
	before: DockNode | null,
	after: DockNode | null,
	moving: string,
	keepMounted: (panelId: string) => boolean,
	persistent: (panelId: string) => boolean = () => false
): DockPanelChange[] {
	const was = mountedPanes(before, keepMounted);
	const now = mountedPanes(after, keepMounted);
	const allTabs = tabPlacements(after);
	const changes: DockPanelChange[] = [];
	for (const [id, mount] of was) {
		if (id === moving) continue;
		const next = now.get(id);
		const survives = next !== undefined && (next.key === mount.key || persistent(id));
		const tabs = allTabs.get(id);
		if (mount.shown && tabs && tabs.active !== id) {
			changes.push({
				kind: 'tab-switch',
				groupId: tabs.groupId,
				from: id,
				to: tabs.active,
				remount: !survives
			});
		} else if (!survives) {
			changes.push({ kind: 'reparent', panelId: id, cause: moving, remount: true });
		}
	}
	return changes;
}

/** The tab group of every docked tab in `root` (mounted or not), with the group's active pane. */
function tabPlacements(root: DockNode | null): Map<string, { groupId: string; active: string }> {
	const out = new Map<string, { groupId: string; active: string }>();
	const visit = (node: DockNode): void => {
		if (node.type === 'tabs') {
			const active = node.children[node.activeIndex]?.id ?? '';
			for (const child of node.children) out.set(child.id, { groupId: node.id, active });
		} else if (node.type === 'split') node.children.forEach(visit);
	};
	if (root) visit(root);
	return out;
}
