/**
 * Bridges `ThreePaneDock` to `createDockLayoutStore` (three-pane-dock-plan §4.4, #663 ④ PR-6;
 * in this package since #791 K4).
 *
 * The store drives a `DockState` as is (`DockHost`): the saved text is `DockState.serialize()`
 * and applying a saved layout is `DockState.hydrate()`. A `ThreePaneDock` saves
 * `layoutSnapshot()` (`{ schema: 1, panels, layout }`; while narrow, the kept wide layout - never the
 * narrow display) and restores through `restoreLayout()` (reconciled with today's panes, the centre
 * repaired). This adapter is the `DockLayoutTarget` the store drives:
 *
 * - before the dock is mounted a stored value only becomes `initialLayout` (the dock reconciles it at
 *   mount, so nothing is mounted twice);
 * - after it, a stored value is installed with `restoreLayout` (not when it is already what is shown);
 * - `serialize()` is the text of `layoutSnapshot()` - the store's baseline (what is saved is the
 *   value the dock's `onLayoutCommit` reports, passed to the store's `commit` - #791);
 *   while a layout is being applied (until `attach`, or until the last `restoreLayout` settles,
 *   resolved or rejected) it keeps answering what it answered right after the assignment, and the
 *   end is reported with `onApplied` so the store re-takes its baseline from what is really shown
 *   (a swap is never saved as a user's change);
 * - the store's "default" is a sentinel layout: assigning it means `restoreLayout(undefined)` (the
 *   dock's own measured default), skipped when the dock still shows the default it started with.
 *
 * Wiring: `initialLayout={target.initialLayout}`, `onLayoutCommit={store.commit}`, and once the
 * dock is mounted `target.attach()` then `store.load()`. "Reset layout" is the dock's own
 * `resetLayout()` (reported as `'reset'`).
 */
import type { DockLayoutTarget } from './layoutStore';
import type { DockLayout } from './types';

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
}

export function createThreePaneLayoutTarget(
	dockState: ThreePaneDockStateLike,
	getApi: () => ThreePaneLayoutApi | undefined
): ThreePaneLayoutTarget {
	const defaultLayout: DockLayout = { version: 4, floating: [], docked: null };
	let initial: string | undefined;
	/**
	 * While a layout is being applied (installed with `restoreLayout`, or held for the mount):
	 * what `serialize()` answers until it is in - what it answered right after the assignment, so
	 * the store's baseline holds and the swap is not read as a user's change.
	 */
	let frozen: string | null = null;
	/** The latest `restoreLayout` in flight (an earlier one finishing does not end the freeze). */
	let inFlight: Promise<void> | null = null;
	let attached = false;
	let firstSnapshot: string | null = null;
	let onApplied: (() => void) | undefined;

	const snapshot = (api: ThreePaneLayoutApi): string => JSON.stringify(api.layoutSnapshot());

	/** The text `serialize()` gives right now (mounted). */
	function current(api: ThreePaneLayoutApi): string {
		const text = snapshot(api);
		return frozen ?? text;
	}

	/** The dock is on screen, started from the default and nothing has changed it since. */
	function showsStartDefault(api: ThreePaneLayoutApi): boolean {
		return initial === undefined && firstSnapshot !== null && snapshot(api) === firstSnapshot;
	}

	/** `restoreLayout(saved)`; `answer` is what `serialize()` says until it (and any later one) is done. */
	function install(api: ThreePaneLayoutApi, saved: unknown, answer: string): void {
		frozen = answer;
		let started: Promise<unknown>;
		try {
			started = Promise.resolve(api.restoreLayout(saved));
		} catch (error) {
			started = Promise.reject(error);
		}
		// A rejected restore still ends the freeze: whatever is shown then is what was applied.
		const run: Promise<void> = started
			.then(
				() => {},
				() => {}
			)
			.then(() => {
				if (inFlight !== run) return;
				inFlight = null;
				frozen = null;
				onApplied?.();
			});
		inFlight = run;
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
			if (next !== defaultLayout) return;
			const api = getApi();
			if (!api || !attached) {
				// Not mounted yet: the dock starts from its default (`attach` reports it as applied).
				initial = undefined;
				return;
			}
			// An install still running would land after this check: install anyway.
			if (inFlight === null && showsStartDefault(api)) return;
			install(api, undefined, current(api));
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
			if (!api || !attached) {
				initial = json;
				return true;
			}
			// An install still running would land after this check: install anyway.
			if (inFlight === null && snapshot(api) === json) return true;
			install(api, json, json);
			return true;
		},
		serialize(): string {
			const api = getApi();
			// Until `attach` the held value is the answer.
			if (!api || !attached) return initial ?? '';
			return current(api);
		},
		attach() {
			const api = getApi();
			if (!api || attached) return;
			attached = true;
			firstSnapshot = snapshot(api);
			// The dock reconciled `initialLayout` (or measured its default) at mount: that is what was
			// applied - unless an install started before `attach` is still running.
			if (inFlight === null) onApplied?.();
		},
		onApplied(listener: () => void) {
			onApplied = listener;
		}
	};
}
