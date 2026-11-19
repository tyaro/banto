/**
 * Bridges `ThreePaneDock` to `createDockLayoutStore` (three-pane-dock-plan §4.4, #663 ④ PR-6).
 *
 * The store was written for the dashboard's `DockHost`, where the saved text is `DockState.serialize()`
 * and applying a saved layout is `DockState.hydrate()`. A `ThreePaneDock` saves
 * `layoutSnapshot()` (`{ schema: 1, panels, layout }`; while narrow, the kept wide layout - never the
 * narrow display) and restores through `restoreLayout()` (reconciled with today's panes, the centre
 * repaired). This adapter is the `DockLayoutTarget` the store drives:
 *
 * - before the dock is mounted a stored value only becomes `initialLayout` (the dock reconciles it at
 *   mount, so nothing is mounted twice);
 * - after it, a stored value is installed with `restoreLayout` (not when it is already what is shown);
 * - `serialize()` is the text of `layoutSnapshot()` - what the page reports with `changed()`;
 * - the store's "default" is a sentinel layout: assigning it means `restoreLayout(undefined)` (the
 *   dock's own measured default), skipped when the dock still shows the default it started with.
 */
import type { DockLayout } from '@banto/dock-svelte';
import type { DockLayoutTarget } from '#lib/banto/dockLayoutStore.svelte.js';

/** The part of a mounted `ThreePaneDock` the adapter calls. */
export interface ThreePaneLayoutApi {
	layoutSnapshot(): unknown;
	restoreLayout(saved: unknown): Promise<unknown>;
}

/** The part of `DockState` the adapter reads. */
export interface ThreePaneDockStateLike {
	readonly layout: DockLayout;
	readonly autoHidden: readonly { node: { id: string } }[];
}

export interface ThreePaneLayoutTarget extends DockLayoutTarget {
	/** For `ThreePaneDock`'s `initialLayout` (read once at mount). `undefined` = the default. */
	readonly initialLayout: string | undefined;
	/** Return it from the store's `defaultLayout`. Never a real layout. */
	readonly defaultLayout: DockLayout;
	/** Call once the dock is mounted: remembers what it shows first. */
	attach(): void;
	/** Run `fn` with layout assignments ignored (the page already installed the layout, e.g. after `resetLayout()`). */
	withoutApplying<T>(fn: () => T): T;
}

export function createThreePaneLayoutTarget(
	dockState: ThreePaneDockStateLike,
	getApi: () => ThreePaneLayoutApi | undefined
): ThreePaneLayoutTarget {
	const defaultLayout: DockLayout = { version: 2, floating: [], docked: null };
	let initial: string | undefined;
	/** A stored value being installed: what `serialize()` answers until it is in (so it is not read as a user's change). */
	let applying: string | null = null;
	let suppress = false;
	let firstSnapshot: string | null = null;

	const snapshot = (api: ThreePaneLayoutApi): string => JSON.stringify(api.layoutSnapshot());

	/** The dock is on screen, started from the default and nothing has changed it since. */
	function showsStartDefault(api: ThreePaneLayoutApi): boolean {
		return initial === undefined && firstSnapshot !== null && snapshot(api) === firstSnapshot;
	}

	function install(api: ThreePaneLayoutApi, saved: unknown, text: string | null): void {
		applying = text;
		void api.restoreLayout(saved).finally(() => {
			if (applying === text) applying = null;
		});
	}

	return {
		get initialLayout() {
			return initial;
		},
		defaultLayout,
		get layout() {
			return dockState.layout;
		},
		set layout(next: DockLayout) {
			if (suppress || next !== defaultLayout) return;
			const api = getApi();
			if (!api) {
				initial = undefined;
				return;
			}
			if (showsStartDefault(api)) return;
			install(api, undefined, null);
		},
		get autoHidden() {
			return dockState.autoHidden;
		},
		hydrate(json: string): boolean {
			try {
				const value: unknown = JSON.parse(json);
				if (typeof value !== 'object' || value === null) return false;
			} catch {
				return false;
			}
			const api = getApi();
			if (!api) {
				initial = json;
				return true;
			}
			if (snapshot(api) !== json) install(api, json, json);
			return true;
		},
		serialize(): string {
			if (applying !== null) return applying;
			const api = getApi();
			return api ? snapshot(api) : (initial ?? '');
		},
		attach() {
			const api = getApi();
			if (api) firstSnapshot = snapshot(api);
		},
		withoutApplying<T>(fn: () => T): T {
			suppress = true;
			try {
				return fn();
			} finally {
				suppress = false;
			}
		}
	};
}
