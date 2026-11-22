/**
 * Saving a dock layout per signed-in user (three-pane-dock-plan §4.4, #663 段階 ④
 * PR-5; spec §12.1 M12). Moved out of the dashboard page so the three-pane dock
 * screens (`dock.threePane.<画面キー>`) reuse the same rules.
 *
 * Two copies of one layout:
 * - the `UiSettingsProvider` value under `settingKey` (settings DB via Tauri/REST,
 *   localStorage in demo mode) - the copy that counts;
 * - a localStorage copy under `${storageKey}:${owner}` - only for the first paint,
 *   before the provider answers.
 *
 * The copies belong to the session's user, never to the browser
 * (three-pane-dock-plan §4.4, cross-review P2; the same rules as
 * `recentCommands.ts` / admin-core's `listViewState.ts`):
 * - The session scope (`currentSessionScope()`: the confirmed owner and the
 *   controller's generation) is captured when the store is created. The local copy
 *   is read and written only under that owner's key; with no confirmed owner it is
 *   not used at all (the default is drawn). `local` (login-not-required) and grant
 *   kinds such as `publicViewer` are owners like any other key.
 * - The old ownerless key (`storageKey` itself) belongs to nobody: it is removed,
 *   never read.
 * - The provider read result, a debounced write and the unmount flush are used
 *   only while that scope is still the live session (`isCurrentSessionScope`).
 *   A result or a pending write that outlived its session is dropped, so one
 *   user's layout is never shown to, or saved as the base for, another user.
 *   (The provider itself also drops a held write whose session changed - #707.)
 * - The provider read wins over the first paint (and over a move made before it
 *   answered - as before). A `null`, an error or a rejected value restores the
 *   default; the local copy is never kept as a substitute.
 *
 * What gets saved: a layout APPLIED by the store (the local copy, the provider
 * value, a seeded or restored default) is the baseline and is not written back to
 * the provider; only a change from it (a user's move, `reset()`) is, 500ms after
 * the layout stops changing, plus a flush on unmount. The local copy mirrors every
 * layout shown.
 *
 * Wiring (no environment branch here - conventions §10): the page passes
 * `getUiSettings` from `setup.ts`; the session scope defaults to admin-core's
 * controller. `storage`/`scope`/`isCurrent` exist for tests.
 */
import {
	currentSessionScope,
	isCurrentSessionScope,
	type SessionScope,
	type UiSettingsProvider
} from '@banto/admin-core';
import { collectPanelIds, type DockLayout } from '@banto/dock-svelte';

/** The part of `DockState` the store drives. */
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

export interface DockLayoutStoreOptions {
	/** The dock whose layout is saved. The local copy (if any) is applied to it at creation. */
	dock: DockLayoutTarget;
	/** localStorage prefix; the copy lives at `${storageKey}:${owner}`. The bare key is the old ownerless copy (removed). */
	storageKey: string;
	/** `UiSettingsProvider` key (`[A-Za-z0-9._-]{1,64}`), e.g. `dock.dashboard`. */
	settingKey: string;
	/** The provider, read at each use (`setup.ts` swaps it in once wired). */
	provider: () => UiSettingsProvider;
	/** The default layout, or `null` while it cannot be built yet (the host is not measured). */
	defaultLayout: () => DockLayout | null;
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
	/** Defaults to `currentSessionScope()` at creation. */
	scope?: SessionScope;
	/** Defaults to `isCurrentSessionScope`. */
	isCurrent?: (scope: SessionScope) => boolean;
}

export interface DockLayoutStore {
	/** The session the store works for (captured at creation). */
	readonly scope: SessionScope;
	/** Read the provider once and apply the answer (see the module doc). Call after mount. */
	load(): Promise<void>;
	/** Seed the default if nothing was restored. Call when the host size may have become known; seeds at most once. */
	seedIfEmpty(): void;
	/** Report the current serialized layout (call on every change of `dock.serialize()`). */
	changed(json: string): void;
	/** "Reset layout": the default as a user change (it is saved). */
	reset(): void;
	/** Unmount: flush a pending write if the session is still the same, then stop. */
	dispose(): void;
}

export const DOCK_LAYOUT_SAVE_DEBOUNCE_MS = 500;

const EMPTY_LAYOUT: DockLayout = { version: 2, floating: [], docked: null };

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

export function createDockLayoutStore(options: DockLayoutStoreOptions): DockLayoutStore {
	const { dock, storageKey, settingKey } = options;
	const validate = options.validate ?? ((json: string) => json);
	const debounceMs = options.debounceMs ?? DOCK_LAYOUT_SAVE_DEBOUNCE_MS;
	const storage = resolveStorage(options.storage);
	const scope = options.scope ?? currentSessionScope();
	const isCurrent = options.isCurrent ?? isCurrentSessionScope;
	const localKey = scope.owner === null ? null : `${storageKey}:${scope.owner}`;

	/** The serialized layout the store applied last (not a user change). */
	let baseline: string | null = null;
	let pending: string | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seeded = false;
	let loading = false;
	let disposed = false;

	function live(): boolean {
		return !disposed && isCurrent(scope);
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
		const json = pending;
		dropPending();
		// A write armed for a session that is gone is dropped, not sent.
		if (json === null || !isCurrent(scope)) return;
		void options
			.provider()
			.set(settingKey, json)
			.catch(() => {});
	}

	/** Apply `json` (validated) as the baseline; `false` when rejected. */
	function applyStored(json: string): boolean {
		const repaired = validate(json);
		if (repaired === null || !dock.hydrate(repaired)) return false;
		baseline = dock.serialize();
		return true;
	}

	/** Apply the default as the baseline - or an empty layout to be seeded once the host is measured. */
	function applyDefault(): void {
		const layout = options.defaultLayout();
		if (layout === null) {
			dock.layout = EMPTY_LAYOUT;
			seeded = false;
		} else {
			dock.layout = layout;
			seeded = true;
		}
		baseline = dock.serialize();
	}

	// Creation: the old ownerless copy is nobody's - drop it; then the first paint
	// from this owner's copy (nothing without an owner, or when it is rejected).
	removeKey(storageKey);
	if (isCurrent(scope)) {
		const local = readLocal();
		if (local !== null && !applyStored(local)) removeKey(localKey);
	}
	// What the dock starts with is applied, not a user change.
	baseline = dock.serialize();
	// A target that finishes applying later: what it shows once done is still the applied layout,
	// not a user change - unless one came in meanwhile (`changed` / `reset` cleared the baseline).
	dock.onApplied?.(() => {
		if (baseline === null || !live()) return;
		baseline = dock.serialize();
		writeLocal(baseline);
	});

	return {
		scope,

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
			// Nothing saved, unusable or unreadable: the default, never this browser's
			// copy (`changed` then mirrors the default into this owner's copy).
			applyDefault();
		},

		seedIfEmpty() {
			if (seeded || disposed) return;
			const layout = options.defaultLayout();
			if (layout === null) return;
			seeded = true;
			// A restored layout stays; after seeding, a panel the user removed stays removed.
			if (!isEmptyLayout(dock)) return;
			dock.layout = layout;
			baseline = dock.serialize();
		},

		changed(json) {
			if (!live()) {
				dropPending();
				return;
			}
			writeLocal(json);
			if (json === baseline) {
				// Back at what was applied: nothing to save.
				dropPending();
				return;
			}
			baseline = null;
			pending = json;
			clearTimeout(timer);
			timer = setTimeout(flush, debounceMs);
		},

		reset() {
			if (disposed) return;
			const layout = options.defaultLayout();
			if (layout === null) return;
			dock.layout = layout;
			if (!live()) return;
			// An explicit reset is saved even when the default is what is shown already
			// (e.g. the read failed and the default was drawn): otherwise the next good
			// read brings the old layout back. `changed` does not fire for an equal JSON.
			const json = dock.serialize();
			baseline = null;
			writeLocal(json);
			pending = json;
			clearTimeout(timer);
			timer = setTimeout(flush, debounceMs);
		},

		dispose() {
			if (disposed) return;
			flush();
			disposed = true;
		}
	};
}
