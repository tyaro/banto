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
 * at the bare `storageKey`. Without `isCurrent`, the provider's own `sessionGuard()` answers
 * "still the same session?": one is taken when the store is created (the session the store works
 * for), and one from the provider in use when a read starts and when a write is armed (so a
 * provider swapped in later still binds what waits to its session). A provider without one is
 * always current.
 *
 * The provider read wins over the first paint (and over a move made before it answered) - but
 * not over a `'reset'` reported meanwhile: an explicit reset is kept and the answer is dropped.
 * A `null`, an error or a rejected value restores the default; the local copy is never kept as a
 * substitute.
 *
 * What gets saved: a layout APPLIED by the store (the local copy, the provider value, a seeded
 * or restored default) is the baseline and is not written back; a `commit` whose layout differs
 * from it is, 500ms after the last one, plus a flush on `dispose`. `'reset'` is always saved -
 * as the reported default, or (`reset: 'remove'`) by deleting what was saved. Writes are
 * unconditional (no `ifRevision`): a layout is "the last arrangement wins", also across tabs.
 * The store sends its own writes one at a time, in the order they were armed (a provider need
 * not order them).
 *
 * Whether it was saved (Issue #1019): `commit` answers a promise of what became of the write that
 * carries the reported layout (`DockLayoutSaveOutcome`). A dock that only passes `commit` as its
 * `onLayoutCommit` ignores it; an app that must not forget something until the layout is really
 * in the provider (admin-core's pop-out memory: a panel put back into the dock) waits for
 * `'saved'`. The store itself does not retry a failed write - the next report is a new write.
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
	 * after the assignment. `isDefault` says whether what landed is the default (`true`: also a
	 * stored value the target could not use) or a stored layout (`false`); left out, the store goes
	 * by what it asked for. `DockState` applies synchronously and omits `onApplied`.
	 */
	onApplied?(listener: (isDefault?: boolean) => void): void;
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
	/**
	 * The provider, read at each use (an app may swap it in once wired). A read and a write stay
	 * with the provider - and, by its `sessionGuard()`, the session - they started with.
	 */
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
	 * with a `scope`. Left out (or no `scope`): the provider's `sessionGuard()` - the one taken at
	 * creation, and the one taken from the provider in use when a read starts / a write is armed -
	 * else always.
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

/**
 * What became of a layout reported to `commit` (Issue #1019):
 * - `'saved'`: the provider took a write that holds this layout or a later one - the write this
 *   report was folded into (reports within the debounce share one write and one answer), a `set`
 *   or, for a reset with `reset: 'remove'`, the deletion.
 * - `'unchanged'`: nothing was sent, because the layout is the one the store itself applied (the
 *   provider's value, the local copy or the default). It does NOT say the provider holds it: the
 *   default drawn after a failed read is "unchanged" too.
 * - `'failed'`: the provider refused the write (it rejected or threw), or could not be reached.
 *   Nothing is retried.
 * - `'dropped'`: the write was not sent - the session it was armed for is gone, or the answer of
 *   `load()` replaced what was waiting (the read wins).
 */
export type DockLayoutSaveOutcome = 'saved' | 'unchanged' | 'failed' | 'dropped';

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
	 *
	 * The promise tells what became of it (`DockLayoutSaveOutcome`) and never rejects, so it may be
	 * left unawaited. It settles when the provider has answered the write - after the debounce, and
	 * after the writes sent before it - also for a write flushed by `dispose`.
	 */
	commit(layout: unknown, reason: ThreePaneLayoutCommitReason): Promise<DockLayoutSaveOutcome>;
	/** Unmount: flush a pending write if the session is still the same, then stop loading / seeding. */
	dispose(): void;
}

export const DOCK_LAYOUT_SAVE_DEBOUNCE_MS = 500;

const EMPTY_LAYOUT: DockLayout = { version: 4, floating: [], docked: null };

/** A write not sent yet: `json`, or - `remove` - the deletion (`json` is saved if the provider cannot). */
interface PendingWrite {
	json: string;
	remove: boolean;
	/** The provider it was armed for, and that provider's session then. */
	provider: DockLayoutSettings;
	sameSession: () => boolean;
	/**
	 * The `commit` promises this write answers: its own report's and those of the reports it
	 * replaced during the debounce (a later layout saved says the earlier one is no longer owed).
	 */
	waiters: ((outcome: DockLayoutSaveOutcome) => void)[];
}

/** `provider.sessionGuard()`, or "always" for a provider without one. */
function guardOf(provider: DockLayoutSettings): () => boolean {
	try {
		return provider.sessionGuard?.() ?? (() => true);
	} catch {
		return () => true;
	}
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
	const ownerCheck = options.isCurrent;
	/** The app says who is current (`scope` + `isCurrent`): the providers' guards are not asked. */
	const explicitOwner = scope !== undefined && ownerCheck !== undefined;
	const isCurrent: () => boolean = explicitOwner
		? () => ownerCheck(scope)
		: (() => {
				try {
					return guardOf(options.provider());
				} catch {
					return () => true;
				}
			})();
	/** The session of the provider in use now (always, when the app gave its own check). */
	const guardNow = (provider: DockLayoutSettings): (() => boolean) =>
		explicitOwner ? () => true : guardOf(provider);

	/** The serialized layout the store applied last (not a user change). */
	let baseline: string | null = null;
	/** What is being applied is the default (`beforeBaseline` may adjust it), not a stored value. */
	let applyingDefault = false;
	let pending: PendingWrite | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The store's writes go out one at a time, in order: the last one sent (settled or not). */
	let sending: Promise<void> | null = null;
	/** Counts the `'reset'` reports: one made while a read is pending wins over its answer. */
	let resets = 0;
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

	function settle(write: PendingWrite, outcome: DockLayoutSaveOutcome): void {
		for (const resolve of write.waiters.splice(0)) resolve(outcome);
	}

	function dropPending(): void {
		clearTimeout(timer);
		timer = undefined;
		const write = pending;
		pending = null;
		if (write !== null) settle(write, 'dropped');
	}

	/** A write armed for a session that is gone is dropped, not sent. */
	function stillWanted(write: PendingWrite): boolean {
		return isCurrent() && write.sameSession();
	}

	function send(write: PendingWrite): Promise<void> {
		if (!stillWanted(write)) {
			settle(write, 'dropped');
			return Promise.resolve();
		}
		let sent: Promise<unknown>;
		try {
			const { provider } = write;
			sent =
				write.remove && typeof provider.remove === 'function'
					? provider.remove(settingKey)
					: provider.set(settingKey, write.json);
		} catch {
			settle(write, 'failed');
			return Promise.resolve();
		}
		return Promise.resolve(sent).then(
			() => settle(write, 'saved'),
			() => settle(write, 'failed')
		);
	}

	function flush(): void {
		const write = pending;
		clearTimeout(timer);
		timer = undefined;
		pending = null;
		if (write === null) return;
		if (!stillWanted(write)) {
			settle(write, 'dropped');
			return;
		}
		// One at a time: an earlier write still on its way must not land after this one (a `set`
		// finishing after the `remove` that followed it would bring the old value back).
		const previous = sending;
		const mine: Promise<void> = previous === null ? send(write) : previous.then(() => send(write));
		sending = mine;
		void mine.then(() => {
			if (sending === mine) sending = null;
		});
	}

	function arm(json: string, wantRemove: boolean): Promise<DockLayoutSaveOutcome> {
		let provider: DockLayoutSettings;
		try {
			provider = options.provider();
		} catch {
			// No provider to write to. What was waiting stays armed, as before.
			return Promise.resolve('failed');
		}
		const remove = wantRemove && typeof provider.remove === 'function';
		baseline = null;
		// The write this one replaces is not sent: its reports are answered by this one.
		const waiters = pending?.waiters ?? [];
		const outcome = new Promise<DockLayoutSaveOutcome>((resolve) => waiters.push(resolve));
		pending = { json, remove, provider, sameSession: guardNow(provider), waiters };
		clearTimeout(timer);
		// After `dispose` nothing would flush a timer's write: send it now.
		if (disposed) flush();
		else timer = setTimeout(flush, debounceMs);
		return outcome;
	}

	function canRemove(): boolean {
		try {
			return typeof options.provider().remove === 'function';
		} catch {
			return false;
		}
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
	dock.onApplied?.((isDefault) => {
		if (baseline === null || !live()) return;
		if (isDefault !== undefined) applyingDefault = isDefault;
		takeBaseline();
		writeLocal(baseline);
	});

	return {
		async load() {
			if (loading || !live()) return;
			loading = true;
			const resetsBefore = resets;
			let remote: string | null;
			let sameSession: () => boolean = () => true;
			try {
				const provider = options.provider();
				sameSession = guardNow(provider);
				remote = (await provider.get(settingKey)).value;
			} catch {
				remote = null;
			}
			// Read for a session that is gone (or a page already unmounted): drop it.
			if (!live() || !sameSession()) return;
			// An explicit reset made while the read was pending stays: the answer is the layout the
			// user just asked to drop, and the reset's write (or deletion) is still to be sent.
			if (resets !== resetsBefore) return;
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
				return Promise.resolve('dropped');
			}
			const json = typeof layout === 'string' ? layout : JSON.stringify(layout);
			if (reason === 'reset') {
				// An explicit reset is saved even when the default is what is shown already (e.g. the
				// read failed and the default was drawn): otherwise the next good read brings the old
				// layout back.
				resets++;
				if (removeOnReset && canRemove()) removeKey(localKey);
				else writeLocal(json);
				return arm(json, removeOnReset);
			}
			writeLocal(json);
			if (json === baseline) {
				// What the store applied (a `DockHost` reports that too): nothing to save.
				dropPending();
				return Promise.resolve('unchanged');
			}
			return arm(json, false);
		},

		dispose() {
			if (disposed) return;
			flush();
			disposed = true;
		}
	};
}
