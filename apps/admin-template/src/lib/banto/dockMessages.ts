/**
 * i18n layer ② bridge for `@banto/dock-svelte` (docs/conventions.md §13): the
 * `messages` bundle for `DockHost` / `ThreePaneDock`, sourced from Paraglide
 * (`dock.*`). Shared by every page that mounts a dock, so no dock string stays
 * in the Japanese package default. A page overrides only what is its own
 * (e.g. the three pane names of `ThreePaneDock`) via `extra`.
 *
 * **App layer ONLY** (the package stays i18n-agnostic). Each entry is a thin
 * closure, so the message resolves at call time and follows the active locale.
 * Removed together with the dock by `scripts/scaffold.mjs` (`removeDock`).
 */
import type { DockMessages } from '@banto/dock-svelte';
import * as m from '#lib/paraglide/messages.js';

type Edge = 'left' | 'right' | 'top' | 'bottom';

const side = (edge: Edge): string =>
	({
		left: m['dock.sideLeft'],
		right: m['dock.sideRight'],
		top: m['dock.sideTop'],
		bottom: m['dock.sideBottom']
	})[edge]();

export function dockMessages<T extends object = object>(extra?: T): DockMessages & T {
	return {
		popOut: (title) => m['dock.popOut']({ title }),
		close: (title) => m['dock.close']({ title }),
		resizeHandle: () => m['dock.resizeHandle'](),
		moveWindow: (title) => m['dock.moveWindow']({ title }),
		resizeWindow: (title) => m['dock.resizeWindow']({ title }),
		lockWindow: (title) => m['dock.lockWindow']({ title }),
		unlockWindow: (title) => m['dock.unlockWindow']({ title }),
		pinWindow: (title) => m['dock.lockWindow']({ title }),
		unpinWindow: (title) => m['dock.unlockWindow']({ title }),
		collapseWindow: (title) => m['dock.collapseWindow']({ title }),
		expandWindow: (title) => m['dock.expandWindow']({ title }),
		collapsePane: (title) => m['dock.collapsePane']({ title }),
		expandPane: (title) => m['dock.expandPane']({ title }),
		autoHidePane: (title) => m['dock.autoHidePane']({ title }),
		pinPane: (title) => m['dock.pinPane']({ title }),
		autoHideBand: (edge) => m['dock.autoHideBand']({ side: side(edge) }),
		panelMenu: (title) => m['dock.panelMenu']({ title }),
		moveToEdge: (edge) => m['dock.moveToEdge']({ side: side(edge) }),
		moveToTabs: (target) => m['dock.moveToTabs']({ target }),
		moveToSplit: (target) => m['dock.moveToSplit']({ target }),
		splitSide: (s) => m['dock.splitSide']({ side: side(s) }),
		menuBack: () => m['dock.menuBack'](),
		floatPanel: () => m['dock.floatPanel'](),
		dockBack: () => m['dock.dockBack'](),
		movedToEdge: (title, edge) => m['dock.movedToEdge']({ title, side: side(edge) }),
		movedToTabs: (title, target) => m['dock.movedToTabs']({ title, target }),
		movedToSplit: (title, target, s) => m['dock.movedToSplit']({ title, target, side: side(s) }),
		floated: (title) => m['dock.floated']({ title }),
		dockedBack: (title) => m['dock.dockedBack']({ title }),
		moveCancelled: (title) => m['dock.moveCancelled']({ title }),
		moveStale: (title) => m['dock.moveStale']({ title }),
		moveUnavailable: (title) => m['dock.moveUnavailable']({ title }),
		...extra
	} as DockMessages & T;
}
