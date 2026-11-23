/**
 * Saving a dock layout (three-pane-dock-plan §4.4; downstream-requests-2026-11-plan §4.6, #791 K4;
 * spec §12.1 M12). The app wires the dock's `onLayoutCommit` to `commit` - the store never reads
 * `serialize()` from an effect - and gives a settings provider by its shape (admin-core's
 * `UiSettingsProvider` fits; this package does not import it, conventions §4).
 *
 * Two copies of one layout:
 * - the provider's value under `settingKey` - the copy that counts;
 * - optionally (`storageKey`) a localStorage copy - only for the first paint, before the
 *   provider answers.
 *
 * With an owner (`scope` / `isCurrent`) the copies belong to the session's user, never to the
 * browser (three-pane-dock-plan §4.4, cross-review P2):
 * - The local copy lives at `${storageKey}:${scope.owner}`; with no confirmed owner
 *   (`owner: null`) it is not used at all (the default is drawn). The bare `storageKey` then
 *   belongs to nobody: it is removed, never read.
 * - The provider read result, a debounced write and the unmount flush are used only while
 *   `isCurrent(scope)` holds. A result or a pending write that outlived its session is dropped,
 *   so one user's layout is never shown to, or saved as the base for, another user.
 *
 * Without `scope` (an app with one key and no accounts, #791 decision 12) the local copy lives
 * at the bare `storageKey`. Without `isCurrent`, the provider's own `sessionGuard()` (taken when
 * the store is created) answers "still the same session?"; a provider without one is always
 * current.
 *
 * The provider read wins over the first paint (and over a move made before it answered). A
 * `null`, an error or a rejected value restores the default; the local copy is never kept as a
 * substitute.
 *
 * What gets saved: a layout APPLIED by the store (the local copy, the provider value, a seeded
 * or restored default) is the baseline and is not written back; a `commit` whose layout differs
 * from it is, 500ms after the last one, plus a flush on `dispose`. `'reset'` is always saved -
 * as the reported default, or (`reset: 'remove'`) by deleting what was saved. Writes are
 * unconditional (no `ifRevision`): a layout is "the last arrangement wins", also across tabs.
 */
import { collectPanelIds } from './core/tree';
import type { ThreePaneLayoutCommitReason } from './threePane';
import type { DockLayout } from './types';

/** The part of `DockState` the store drives (`createThreePaneLayoutTarget` adapts a `ThreePaneDock`). */
export interface DockLayoutTarget {
	layout: DockLayout;
	readonly autoHidden: readonly { node: { id: string } }[];
	hydrate(json: string): boolean;
	serialize(): string;
	/**
	 * For a target that applies a layout later than the `hydrate` / `layout` assignment returns
	 * (a `ThreePaneDock`'s async `restoreLayout`, or a value held until mount): the store registers a
	 * listener once, and the target calls it when what it applied is in place - `serialize()` then
	 * answers the layout really shown, and the store takes that as its baseline (unless a user's
	 * change came in meanwhile). Until then `serialize()` must keep answering what it answered right
	 * after the assignment. `DockState` applies synchronously and omits it.
	 */
	onApplied?(listener: () => void): void;
}

/**
 * The settings provider, by shape (`@banto/admin-core`'s `UiSettingsProvider` and
 * `createLocalUiSettings()` fit). `remove` and `sessionGuard` are optional.
 */
export interface DockLayoutSettings {
	get(key: string): Promise<{ readonly value: string | null }>;
	set(key: string, value: string): Promise<unknown>;
	/** Delete the stored value. Needed for `reset: 'remove'`; without it the default is saved. */
	remove?(key: string): Promise<unknown>;
	/** Captures the session now; the returned function answers "still that session?". */
	sessionGuard?(): () => boolean;
}

/** The owner of the saved copies (`@banto/admin-core`'s `SessionScope` fits). */
export interface DockLayoutScope {
	/** Stable key of the signed-in user; `null` = no confirmed owner (the local copy is not used). */
	readonly owner: string | null;
}

export interface DockLayoutStoreOptions<S extends DockLayoutScope = DockLayoutScope> {
	/** The dock whose layout is saved. The local copy (if any) is applied to it at creation. */
	dock: DockLayoutTarget;
	/** Provider key (`[A-Za-z0-9._-]{1,64}` for admin-core's providers), e.g. `dock.dashboard`. */
	settingKey: string;
	/** The provider, read at each use (an app may swap it in once wired). */
	provider: () => DockLayoutSettings;
	/** The default layout, or `null` while it cannot be built yet (the host is not measured). */
	defaultLayout: () => DockLayout | null;
	/**
	 * localStorage key of the first-paint copy: `${storageKey}:${scope.owner}` with a `scope`, the
	 * bare key without one. Left out: no local copy (the first paint is the default until the
	 * provider answers - enough for a provider that answers from localStorage itself).
	 */
	storageKey?: string;
	/**
	 * The session the copies belong to, captured by the app when the store is created (admin-core:
	 * `currentSessionScope()`). Left out: no owner - one key, one local copy.
	 */
	scope?: S;
	/**
	 * Whether `scope` is still the live session (admin-core: `isCurrentSessionScope`). Used only
	 * with a `scope`. Left out (or no `scope`): the provider's `sessionGuard()`, else always.
	 */
	isCurrent?: (scope: S) => boolean;
	/**
	 * What `commit(layout, 'reset')` does: `'save'` (default) writes the reported default like a
	 * user's change (also when it is what was shown); `'remove'` deletes the provider's value and
	 * the local copy instead (a provider without `remove` gets the default saved).
	 */
	reset?: 'save' | 'remove';
	/**
	 * Adjust the default before it becomes the baseline (e.g. "start with the log pane as a band on
	 * a low screen"): called each time the store has put the default in (a seed, nothing usable
	 * saved) - for a target with `onApplied`, once that default is in place - right before the
	 * baseline is taken, so what it changes synchronously is not saved as a user's change. Not
	 * called for a stored layout, nor for a reset the user asked for.
	 */
	beforeBaseline?: () => void;
	/**
	 * Check / repair a stored value before it is applied: return the JSON to hydrate,
	 * or `null` to reject it (a rejected provider value restores the default). The
	 * dock's own `hydrate` validation still runs after it. Default: as stored.
	 */
	validate?: (json: string) => string | null;
	/** Debounce of the provider write. Default 500ms. */
	debounceMs?: number;
	/** Defaults to the global `localStorage` (`null` = none). */
	storage?: Storage | null;
}

export interface DockLayoutStore {
	/** Read the provider once and apply the answer (see the module doc). Call after mount. */
	load(): Promise<void>;
	/** Seed the default if nothing was restored. Call when the host size may have become known; seeds at most once. */
	seedIfEmpty(): void;
	/**
	 * The dock's `onLayoutCommit`: pass it as is (`onLayoutCommit={store.commit}`). `layout` is the
	 * value to save (`DockHost`: the layout; `ThreePaneDock`: the `ThreePaneSavedLayout`), stored as
	 * its JSON text. `'user'` / `'narrow-switch'` are saved when the text differs from the baseline;
	 * `'reset'` always (the `reset` option). A report after `dispose` (the host unmounts after the
	 * page's cleanup and reports a change not yet reported) is sent at once.
	 */
	commit(layout: unknown, reason: ThreePaneLayoutCommitReason): void;
	/** Unmount: flush a pending write if the session is still the same, then stop loading / seeding. */
	dispose(): void;
}

export const DOCK_LAYOUT_SAVE_DEBOUNCE_MS = 500;

const EMPTY_LAYOUT: DockLayout = { version: 4, floating: [], docked: null };

/** A write not sent yet: `json`, or - `remove` - the deletion (`json` is saved if the provider cannot). */
interface PendingWrite {
	json: string;
	remove: boolean;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
	if (storage !== undefined) return storage;
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function isEmptyLayout(dock: DockLayoutTarget): boolean {
	return (
		collectPanelIds(dock.layout.docked).length === 0 &&
		// Auto-hidden panes (#694 PR-3) are in the layout too: only bands is not empty.
		dock.autoHidden.length === 0 &&
		dock.layout.floating.length === 0
	);
}

export function createDockLayoutStore<S extends DockLayoutScope = DockLayoutScope>(
	options: DockLayoutStoreOptions<S>
): DockLayoutStore {
	const { dock, settingKey, scope } = options;
	const storageKey = options.storageKey ?? null;
	const validate = options.validate ?? ((json: string) => json);
	const debounceMs = options.debounceMs ?? DOCK_LAYOUT_SAVE_DEBOUNCE_MS;
	const storage = storageKey === null ? null : resolveStorage(options.storage);
	const removeOnReset = options.reset === 'remove';
	const localKey =
		storageKey === null
			? null
			: scope === undefined
				? storageKey
				: scope.owner === null
					? null
					: `${storageKey}:${scope.owner}`;
	const isCurrent: () => boolean = (() => {
		const check = options.isCurrent;
		if (scope !== undefined && check) return () => check(scope);
		let guard: (() => boolean) | undefined;
		try {
			guard = options.provider().sessionGuard?.();
		} catch {
			guard = undefined;
		}
		return guard ?? (() => true);
	})();

	/** The serialized layout the store applied last (not a user change). */
	let baseline: string | null = null;
	/** What is being applied is the default (`beforeBaseline` may adjust it), not a stored value. */
	let applyingDefault = false;
	let pending: PendingWrite | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seeded = false;
	let loading = false;
	let disposed = false;

	function live(): boolean {
		return !disposed && isCurrent();
	}

	function readLocal(): string | null {
		if (!storage || localKey === null) return null;
		try {
			return storage.getItem(localKey);
		} catch {
			return null;
		}
	}

	function writeLocal(json: string): void {
		if (!storage || localKey === null) return;
		try {
			storage.setItem(localKey, json);
		} catch {
			// Best-effort first-paint cache.
		}
	}

	function removeKey(key: string | null): void {
		if (!storage || key === null) return;
		try {
			storage.removeItem(key);
		} catch {
			// Ignore.
		}
	}

	function dropPending(): void {
		clearTimeout(timer);
		timer = undefined;
		pending = null;
	}

	function flush(): void {
		const write = pending;
		dropPending();
		// A write armed for a session that is gone is dropped, not sent.
		if (write === null || !isCurrent()) return;
		let sent: Promise<unknown>;
		try {
			const provider = options.provider();
			sent =
				write.remove && typeof provider.remove === 'function'
					? provider.remove(settingKey)
					: provider.set(settingKey, write.json);
		} catch {
			return;
		}
		void Promise.resolve(sent).catch(() => {});
	}

	function canRemove(): boolean {
		try {
			return typeof options.provider().remove === 'function';
		} catch {
			return false;
		}
	}

	function arm(write: PendingWrite): void {
		baseline = null;
		pending = write;
		clearTimeout(timer);
		// After `dispose` nothing would flush a timer's write: send it now.
		if (disposed) flush();
		else timer = setTimeout(flush, debounceMs);
	}

	/** Take what the dock shows as the baseline (the default: after the app's `beforeBaseline`). */
	function takeBaseline(): void {
		if (applyingDefault) {
			try {
				options.beforeBaseline?.();
			} catch {
				// The app's hook: the default as it is stays the baseline.
			}
		}
		baseline = dock.serialize();
	}

	/** Apply `json` (validated) as the baseline; `false` when rejected. */
	function applyStored(json: string): boolean {
		const repaired = validate(json);
		if (repaired === null || !dock.hydrate(repaired)) return false;
		applyingDefault = false;
		baseline = dock.serialize();
		return true;
	}

	/** Put the default in as the baseline. A target with `onApplied` adjusts it (`beforeBaseline`) once it is in place. */
	function putDefault(layout: DockLayout): void {
		dock.layout = layout;
		seeded = true;
		applyingDefault = true;
		if (dock.onApplied) baseline = dock.serialize();
		else takeBaseline();
	}

	/** Apply the default as the baseline - or an empty layout to be seeded once the host is measured. */
	function applyDefault(): void {
		const layout = options.defaultLayout();
		if (layout === null) {
			dock.layout = EMPTY_LAYOUT;
			seeded = false;
			applyingDefault = false;
			baseline = dock.serialize();
		} else putDefault(layout);
		// The default is what is shown: mirror it (a `DockHost` also reports the change). A target
		// that applies later mirrors it from `onApplied`, once `serialize()` answers the default.
		if (!dock.onApplied) writeLocal(baseline!);
	}

	// Creation: with an owner the bare key is nobody's - drop it; then the first paint from this
	// owner's copy (nothing without a confirmed owner, or when it is rejected).
	if (scope !== undefined) removeKey(storageKey);
	let restored = false;
	if (isCurrent()) {
		const local = readLocal();
		if (local !== null) {
			restored = applyStored(local);
			if (!restored) removeKey(localKey);
		}
	}
	// What the dock starts with is applied, not a user change. A target that applies later
	// (`onApplied`) and starts without a stored value will show its own default.
	applyingDefault = !restored && !!dock.onApplied;
	baseline = dock.serialize();
	// A target that finishes applying later: what it shows once done is still the applied layout,
	// not a user change - unless one came in meanwhile (`commit` cleared the baseline).
	dock.onApplied?.(() => {
		if (baseline === null || !live()) return;
		takeBaseline();
		writeLocal(baseline);
	});

	return {
		async load() {
			if (loading || !live()) return;
			loading = true;
			let remote: string | null;
			try {
				remote = (await options.provider().get(settingKey)).value;
			} catch {
				remote = null;
			}
			// Read for a session that is gone (or a page already unmounted): drop it.
			if (!live()) return;
			// The read wins over the first paint and over a move made meanwhile.
			dropPending();
			if (remote !== null && applyStored(remote)) {
				writeLocal(baseline!);
				return;
			}
			// Nothing saved, unusable or unreadable: the default, never this browser's copy.
			applyDefault();
		},

		seedIfEmpty() {
			if (seeded || disposed) return;
			const layout = options.defaultLayout();
			if (layout === null) return;
			seeded = true;
			// A restored layout stays; after seeding, a panel the user removed stays removed.
			if (!isEmptyLayout(dock)) return;
			putDefault(layout);
		},

		commit(layout, reason) {
			if (!isCurrent()) {
				dropPending();
				return;
			}
			const json = typeof layout === 'string' ? layout : JSON.stringify(layout);
			if (reason === 'reset') {
				// An explicit reset is saved even when the default is what is shown already (e.g. the
				// read failed and the default was drawn): otherwise the next good read brings the old
				// layout back.
				const remove = removeOnReset && canRemove();
				if (remove) removeKey(localKey);
				else writeLocal(json);
				arm({ json, remove });
				return;
			}
			writeLocal(json);
			if (json === baseline) {
				// What the store applied (a `DockHost` reports that too): nothing to save.
				dropPending();
				return;
			}
			arm({ json, remove: false });
		},

		dispose() {
			if (disposed) return;
			flush();
			disposed = true;
		}
	};
}
