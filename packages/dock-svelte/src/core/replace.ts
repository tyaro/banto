/**
 * Which panes a whole-layout replacement touches (#663 ④, three-pane-dock-plan §4.4 / §4.1:
 * `ThreePaneDock`'s `resetLayout` / `restoreLayout` go through `DockHost.replaceLayout`). Pure.
 *
 * A replacement can take every pane anywhere, so it is described pane by pane, from what is
 * MOUNTED now (`core/mounts.ts`' mount keys for the docked tree, `float:<id>` for a floating
 * window that is open or kept, `band:<id>` for an auto-hidden pane that is slid out or kept) to
 * where the pane is after:
 *
 * - its content survives (same mount key, or a `persistent` pane that stays on screen) and it
 *   stays on screen = not asked;
 * - it stays mounted but leaves the screen = `tab-switch` (it becomes a background tab),
 *   `auto-hide` `to: 'band'` or `hide`, `remount: false`;
 * - it is re-mounted = `dock` (floating / band -> tree), `undock` (-> floating window),
 *   `auto-hide` `to: 'band'` (-> band), `move-docked` (another place in the tree), `tab-switch`
 *   when it ends as a background tab, all `remount: true`;
 * - it leaves the screen and is not kept = `hide`, `remount: true` (a `persistent` pane:
 *   `remount: false`; `closePanel` is the only discard).
 *
 * A pane that is not mounted now (a background tab, a closed window, a band pane not slid out)
 * has nothing to lose and is not listed. Order: docked panes (tree order), band panes, floating
 * windows (z-order).
 */
import { autoHiddenPanelIds } from './autohide';
import type { DockPanelChange } from './lifecycle';
import { mountedPanes, type PaneMount } from './mounts';
import { collectPanelIds } from './tree';
import type { DockLayout, DockNode } from '../types';

type Where = 'docked' | 'band' | 'floating';

interface Mount extends PaneMount {
	where: Where;
}

/** Every pane whose content is mounted in `layout`, by id, in the module doc's order. */
function mounted(
	layout: DockLayout,
	keepMounted: (panelId: string) => boolean,
	flyout: string | null
): Map<string, Mount> {
	const out = new Map<string, Mount>();
	for (const [id, m] of mountedPanes(layout.docked, keepMounted))
		out.set(id, { ...m, where: 'docked' });
	for (const id of autoHiddenPanelIds(layout)) {
		const shown = id === flyout;
		if (shown || keepMounted(id)) out.set(id, { key: `band:${id}`, shown, where: 'band' });
	}
	for (const w of layout.floating) {
		if (out.has(w.id)) continue;
		if (w.open || keepMounted(w.id))
			out.set(w.id, { key: `float:${w.id}`, shown: w.open, where: 'floating' });
	}
	return out;
}

/** Where the pane is in `layout` (mounted or not), `null` = not on screen. */
function placeOf(layout: DockLayout, id: string): Where | null {
	if (collectPanelIds(layout.docked).includes(id)) return 'docked';
	if (autoHiddenPanelIds(layout).includes(id)) return 'band';
	return layout.floating.some((w) => w.id === id && w.open) ? 'floating' : null;
}

/** The tab group holding the docked pane `id` in `root`, with its active pane. */
function groupOf(root: DockNode | null, id: string): { groupId: string; active: string } | null {
	if (!root) return null;
	if (root.type === 'tabs') {
		if (!root.children.some((c) => c.id === id)) return null;
		return { groupId: root.id, active: root.children[root.activeIndex]?.id ?? '' };
	}
	if (root.type === 'split') {
		for (const child of root.children) {
			const found = groupOf(child, id);
			if (found) return found;
		}
	}
	return null;
}

/**
 * The changes `before` -> `after` makes to the panes mounted in `before` (module doc).
 * `flyout` = the auto-hidden pane slid out now (`DockState.flyoutPanel`); it stays slid out only
 * when it is still auto-hidden after.
 */
export function layoutChanges(
	before: DockLayout,
	after: DockLayout,
	keepMounted: (panelId: string) => boolean,
	persistent: (panelId: string) => boolean = () => false,
	flyout: string | null = null
): DockPanelChange[] {
	const keep = (id: string) => keepMounted(id) || persistent(id);
	const was = mounted(before, keep, flyout);
	const flyoutAfter = flyout !== null && autoHiddenPanelIds(after).includes(flyout) ? flyout : null;
	const now = mounted(after, keep, flyoutAfter);
	const changes: DockPanelChange[] = [];
	for (const [id, mount] of was) {
		const next = now.get(id);
		const place = placeOf(after, id);
		const kept = persistent(id) ? place !== null : next !== undefined && next.key === mount.key;
		const shownAfter = next?.shown === true;
		const group = place === 'docked' ? groupOf(after.docked, id) : null;
		const background = group !== null && group.active !== id;
		if (kept) {
			if (!mount.shown || shownAfter) continue;
			if (background && group)
				changes.push({
					kind: 'tab-switch',
					groupId: group.groupId,
					from: id,
					to: group.active,
					remount: false
				});
			else if (place === 'band' && mount.where !== 'band')
				changes.push({ kind: 'auto-hide', panelId: id, to: 'band', remount: false });
			else if (place !== 'band') changes.push({ kind: 'hide', panelId: id, remount: false });
			continue;
		}
		if (place === null) {
			changes.push({ kind: 'hide', panelId: id, remount: !persistent(id) });
		} else if (background && group && mount.shown) {
			changes.push({
				kind: 'tab-switch',
				groupId: group.groupId,
				from: id,
				to: group.active,
				remount: true
			});
		} else if (place === 'docked') {
			changes.push({
				kind: mount.where === 'docked' ? 'move-docked' : 'dock',
				panelId: id,
				remount: true
			});
		} else if (place === 'band') {
			changes.push({ kind: 'auto-hide', panelId: id, to: 'band', remount: true });
		} else {
			changes.push({ kind: 'undock', panelId: id, remount: true });
		}
	}
	return changes;
}
