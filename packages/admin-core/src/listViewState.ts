/**
 * Session-scoped list view state (Issue #215): so a "list -> detail -> save
 * -> list" round trip restores the sort/filters the user had set instead of
 * starting over, and the row just opened/edited can be found again.
 *
 * Deliberately generic - keyed by an opaque `key` string the caller composes
 * (e.g. `${resource}:${mode}`), not tied to `@banto/grid-svelte`'s
 * `GridState` or any one resource - so any list screen (admin-template's
 * items/users/audit-log, or a derived app's own resource) can reuse the same
 * mechanism instead of each wiring its own ad hoc persistence.
 *
 * Backed by `sessionStorage`, not `localStorage`: this is working context for
 * the CURRENT tab/session (spec's own "同一セッション" framing for #215), not
 * a durable per-user preference synced to a backend - that role already
 * belongs to `UiSettingsProvider` (providers/uiSettings.ts). Column layout
 * (order/widths/hidden) is deliberately NOT part of `ListViewSnapshot` -
 * that's issue #168's scope; this only carries what changes which rows/order
 * are shown (sort/filters/groupBy) plus a lightweight work-position marker
 * (`lastOpenedId`).
 *
 * Every read/write is best-effort: a full, disabled, or private-mode
 * `sessionStorage` silently no-ops rather than breaking the page (same
 * stance as `providers/uiSettings.ts`'s localStorage backend and
 * `apps/admin-template/src/lib/banto/locale.ts`'s FOUC cache). `storage` is
 * an optional override (defaults to the global `sessionStorage`) purely so
 * tests can inject a fake without touching global state - same convention as
 * `LocalUiSettingsOptions.storage`.
 */
import type { FilterState, SortState } from './types';

const SNAPSHOT_PREFIX = 'banto.listView.';
const MODE_PREFIX = 'banto.listView.mode.';
const LAST_OPENED_PREFIX = 'banto.listView.lastOpened.';
const LAST_EDITED_PREFIX = 'banto.listView.lastEdited.';

export interface ListViewSnapshot {
	sort: SortState[];
	filters: FilterState[];
	/** Client-mode-only grouping column id (grid-svelte `GridState.groupBy`). Omit for a list with no grouping concept. */
	groupBy?: string | null;
}

function isSnapshot(value: unknown): value is ListViewSnapshot {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.sort) && Array.isArray(candidate.filters);
}

/** The global `sessionStorage`, or `null` when unavailable (SSR, disabled storage, ...). Never throws. */
function defaultStorage(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
	return storage === undefined ? defaultStorage() : storage;
}

function readJson(storage: Storage, key: string): unknown {
	let raw: string | null;
	try {
		raw = storage.getItem(key);
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function writeJson(storage: Storage, key: string, value: unknown): void {
	try {
		storage.setItem(key, JSON.stringify(value));
	} catch {
		// Ignore: quota exceeded, disabled storage, private mode, ...
	}
}

/**
 * Persist `snapshot` for `key` (caller-composed, e.g. `items:server`).
 * `storage` is for tests only - omit it in application code.
 */
export function saveListViewState(
	key: string,
	snapshot: ListViewSnapshot,
	storage?: Storage | null
): void {
	const store = resolveStorage(storage);
	if (!store) return;
	writeJson(store, `${SNAPSHOT_PREFIX}${key}`, snapshot);
}

/** Load a previously-saved snapshot for `key`, or `null` if there is none (or it's invalid). */
export function loadListViewState(key: string, storage?: Storage | null): ListViewSnapshot | null {
	const store = resolveStorage(storage);
	if (!store) return null;
	const parsed = readJson(store, `${SNAPSHOT_PREFIX}${key}`);
	return isSnapshot(parsed) ? parsed : null;
}

/** Drop a saved snapshot for `key` (e.g. a caller offering its own "reset filters" action that should also forget the saved state). */
export function clearListViewState(key: string, storage?: Storage | null): void {
	const store = resolveStorage(storage);
	if (!store) return;
	try {
		store.removeItem(`${SNAPSHOT_PREFIX}${key}`);
	} catch {
		// Ignore.
	}
}

/**
 * Remember which named view (e.g. `'client' | 'server'`) was last active for
 * `resource`, so a page offering more than one presentation of the same list
 * (admin-template's items page: クライアント/サーバー toggle) reopens the
 * one the user had, not always its default - otherwise the restored
 * filters/sort of the OTHER mode would silently go unused.
 */
export function saveActiveListMode(resource: string, mode: string, storage?: Storage | null): void {
	const store = resolveStorage(storage);
	if (!store) return;
	try {
		store.setItem(`${MODE_PREFIX}${resource}`, mode);
	} catch {
		// Ignore.
	}
}

/** The last mode saved by `saveActiveListMode` for `resource`, or `null` if none. */
export function loadActiveListMode(resource: string, storage?: Storage | null): string | null {
	const store = resolveStorage(storage);
	if (!store) return null;
	try {
		return store.getItem(`${MODE_PREFIX}${resource}`);
	} catch {
		return null;
	}
}

/**
 * Remember the row most recently opened for `resource` (any detail/edit
 * screen for it - list navigation, a direct URL visit, whatever got there),
 * so a list page can highlight/find it again once the user comes back
 * (Issue #215's "直前の作業位置を見つけられるようにする"). Deliberately
 * ONE value per resource, not per list mode: only one of a page's
 * presentations (e.g. admin-template items' クライアント/サーバー grids) is
 * ever on screen at a time, and whichever the user returns to is the one
 * that should show the mark - there's nothing to disambiguate.
 *
 * Callers should set this from the DESTINATION screen (the detail/edit
 * page, on mount), not from the list's row-click handler: a link-styled
 * "開く" cell navigates via its own `href` and never runs a grid's
 * `onRowClick` callback when the grid also has editable columns
 * (`packages/grid-svelte/src/BantoGrid.svelte`'s `handleCellClick` doc
 * comment) - the detail page is the one place every "how did I get here"
 * path (a grid link click, a double-click on a read-only cell, a pasted
 * URL, the browser back button) reliably passes through.
 */
export function saveLastOpenedId(
	resource: string,
	id: string | number | null,
	storage?: Storage | null
): void {
	const store = resolveStorage(storage);
	if (!store) return;
	try {
		if (id === null) {
			store.removeItem(`${LAST_OPENED_PREFIX}${resource}`);
		} else {
			store.setItem(`${LAST_OPENED_PREFIX}${resource}`, JSON.stringify(id));
		}
	} catch {
		// Ignore.
	}
}

/** The id saved by `saveLastOpenedId` for `resource`, or `null` if none (or it's malformed). */
export function loadLastOpenedId(
	resource: string,
	storage?: Storage | null
): string | number | null {
	const store = resolveStorage(storage);
	if (!store) return null;
	const parsed = readJson(store, `${LAST_OPENED_PREFIX}${resource}`);
	return typeof parsed === 'string' || typeof parsed === 'number' ? parsed : null;
}

export interface LastEditedRecord {
	id: string | number;
	/**
	 * The row's field values AT SAVE TIME, so a list page can check them
	 * against its own restored filters (`@banto/grid-svelte`'s
	 * `filterRows`) without a round trip to the server: does this row still
	 * match the condition the user still has active? If not, the list must
	 * explain that instead of silently clearing the filter (#215's
	 * "編集結果が絞り込みの条件から外れた場合も、フィルタを勝手に解除しない"
	 * requirement).
	 */
	values: Record<string, unknown>;
}

function isLastEditedRecord(value: unknown): value is LastEditedRecord {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		(typeof candidate.id === 'string' || typeof candidate.id === 'number') &&
		typeof candidate.values === 'object' &&
		candidate.values !== null
	);
}

/**
 * Record the row a detail screen just saved. One-shot by design:
 * `takeLastEditedRecord` clears it on read, so a later revisit (without a
 * fresh save) shows nothing.
 */
export function noteLastEditedRecord(
	resource: string,
	record: LastEditedRecord,
	storage?: Storage | null
): void {
	const store = resolveStorage(storage);
	if (!store) return;
	writeJson(store, `${LAST_EDITED_PREFIX}${resource}`, record);
}

/** Read and clear the last-edited-record marker for `resource` (see `noteLastEditedRecord`). */
export function takeLastEditedRecord(
	resource: string,
	storage?: Storage | null
): LastEditedRecord | null {
	const store = resolveStorage(storage);
	if (!store) return null;
	const key = `${LAST_EDITED_PREFIX}${resource}`;
	const parsed = readJson(store, key);
	try {
		store.removeItem(key);
	} catch {
		// Ignore.
	}
	return isLastEditedRecord(parsed) ? parsed : null;
}
