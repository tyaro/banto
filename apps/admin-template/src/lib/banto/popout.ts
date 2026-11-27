/**
 * Pop-out panel windows (spec §5.3 v2 "ウィンドウ分離", Tauri only): this
 * app's binding of `@banto/admin-core`'s `createPanelPopOut` (ADR-0037).
 *
 * The behaviour is not here any more. The frontend half - open the window,
 * hear that it closed, put the panel back - is `@banto/admin-core`'s
 * `panelWindow.ts`; the Tauri half - one window per id, the
 * `banto://panel-closed` notice, the position / size memory, closing with
 * the main window - is the plugin `banto-tauri-panel`, registered in
 * `src-tauri/src/lib.rs` and allowed in `src-tauri/capabilities/default.json`
 * (`banto-tauri-panel:allow-open`, `banto-tauri-panel:allow-list`).
 *
 * This file only hands over what admin-core does not import itself:
 * `isTauri`, `invoke` and `listen`, a `localStorage` entry for the memory of
 * the popped-out panels (#1013), and Svelte's reactivity for `isPoppedOut`
 * (#1014). It keeps the `@tauri-apps/api` imports in `lib/banto`
 * (conventions §10), out of the route.
 *
 * It also holds the joint between the two packages that must not know each
 * other (conventions §4: admin-core imports no option): `createLayoutSaveWatch`
 * turns what `@banto/dock-svelte`'s layout store answers to each `commit`
 * into the promise admin-core's `restore` returns (#1019).
 */
import { createSubscriber } from 'svelte/reactivity';
import { invoke } from '@tauri-apps/api/core'; // safe to import outside Tauri (see setup.ts) - only ever CALLED when isTauri()
import {
	createPanelPopOut,
	type PanelPopOut,
	type PanelPopOutOptions,
	type PanelPopOutStorage,
	type PanelWindowContent
} from '@banto/admin-core';
import { isTauri } from './setup';

/**
 * The memory of the popped-out panel ids (#1013) as one `localStorage` entry:
 * a JSON array of ids, removed when it is empty. Anything else found under
 * the key reads as "nothing". A storage that throws is admin-core's to
 * survive (it treats the memory as best effort).
 */
export function panelPopOutLocalStorage(key: string): PanelPopOutStorage {
	return {
		load: () => {
			const raw = localStorage.getItem(key);
			if (raw === null) return [];
			const value: unknown = JSON.parse(raw);
			return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
		},
		save: (ids) => {
			if (ids.length === 0) localStorage.removeItem(key);
			else localStorage.setItem(key, JSON.stringify(ids));
		}
	};
}

/** `createLayoutSaveWatch()`: "the layout as it is from now on has been saved". */
export interface LayoutSaveWatch {
	/**
	 * Hand over what the layout store answered to a `commit`
	 * (`@banto/dock-svelte`'s `DockLayoutSaveOutcome`, by shape: only
	 * `'saved'` counts). Call it for EVERY report, in the order they are made.
	 */
	track: (outcome: Promise<string>) => void;
	/**
	 * Resolves `true` once a report made AFTER this call is saved. It stays
	 * pending while none is (a failed write, a write dropped with its session,
	 * no report at all): a later report that is saved still answers it, since
	 * that write carries the layout as it is then.
	 */
	next: () => Promise<boolean>;
}

/**
 * Joins the dock's layout store to the pop-out's `restore` (#1019). A panel
 * put back into the dock must stay in the pop-out's memory until the layout
 * that has it again is in the provider; the store answers that per `commit`,
 * but the report of a restored panel is made by the dock host, later, not by
 * `restore` itself. So the page routes every report through `track`, and
 * `restore` takes `next()` BEFORE it changes the dock and returns it:
 *
 * ```ts
 * const saves = createLayoutSaveWatch();
 * const reportLayout = (layout, reason) => saves.track(dockLayout.commit(layout, reason));
 * // <DockHost onLayoutCommit={reportLayout} />
 * restore: (id) => {
 * 	const saved = saves.next();
 * 	dock.open(id);
 * 	return saved;
 * }
 * ```
 *
 * Why "a report made after": a write already on its way when the panel came
 * back holds the layout without it, and its success says nothing. Why ANY
 * later report: each write holds the whole layout, so the first one that
 * lands settles it - also when the user has closed the panel again by then
 * (that is then what is saved, and what the next start must show).
 */
export function createLayoutSaveWatch(): LayoutSaveWatch {
	/** Reports handed to `track` so far. */
	let reports = 0;
	let waiting: { after: number; resolve: (saved: boolean) => void }[] = [];
	return {
		track: (outcome) => {
			const report = ++reports;
			void outcome.then(
				(result) => {
					if (result !== 'saved') return;
					const answered = waiting.filter((w) => w.after < report);
					waiting = waiting.filter((w) => w.after >= report);
					for (const w of answered) w.resolve(true);
				},
				() => {}
			);
		},
		next: () => {
			const after = reports;
			return new Promise<boolean>((resolve) => waiting.push({ after, resolve }));
		}
	};
}

export interface AppPanelPopOutOptions<C extends PanelWindowContent> extends Pick<
	PanelPopOutOptions<C>,
	'detach' | 'restore' | 'onError' | 'onListError'
> {
	/**
	 * `localStorage` key the popped-out panel ids are remembered under, so a
	 * panel that was out in a window when the app was closed is back in the
	 * dock at the next start (#1013). One key per dock, per user - the same
	 * owner as the dock's saved layout, since that layout is what lacks the
	 * panel. `null` = not remembered across a restart.
	 */
	storageKey: string | null;
}

/**
 * `createPanelPopOut` with this app's Tauri functions filled in. In a plain
 * browser the result's `onPopOut` is `undefined` (the dock then draws no
 * pop-out button), `connect()` registers nothing and `isPoppedOut` is always
 * `false`.
 *
 * `isPoppedOut` is reactive here: read in a `$derived` / `$effect` / the
 * template, it re-runs them when a panel is popped out or put back.
 */
export function createAppPanelPopOut<C extends PanelWindowContent>(
	options: AppPanelPopOutOptions<C>
): PanelPopOut<C> {
	const { storageKey, ...rest } = options;
	const popOut = createPanelPopOut<C>({
		isTauri,
		invoke,
		// Dynamic import: `listen` talks to a Tauri IPC channel that does not
		// exist in a browser tab (same reasoning as setup.ts's event provider).
		listen: async (event, cb) => (await import('@tauri-apps/api/event')).listen(event, cb),
		storage: storageKey === null ? undefined : panelPopOutLocalStorage(storageKey),
		...rest
	});
	// admin-core tells "the popped-out set changed" through a plain
	// subscription; this turns it into a dependency of whoever reads.
	const track = createSubscriber((update) => popOut.subscribe(update));
	return {
		...popOut,
		isPoppedOut: (id) => {
			track();
			return popOut.isPoppedOut(id);
		}
	};
}
