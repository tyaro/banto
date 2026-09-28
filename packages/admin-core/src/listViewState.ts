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
import type { AuthProvider } from './provider';
import type { FilterOp, FilterState, SortDirection, SortState } from './types';

/** Every key this module ever writes starts with this - `clearAllListViewState` sweeps by it alone. */
const NAMESPACE = 'banto.listView.';
const SNAPSHOT_PREFIX = NAMESPACE;
const MODE_PREFIX = `${NAMESPACE}mode.`;
const LAST_OPENED_PREFIX = `${NAMESPACE}lastOpened.`;
const LAST_EDITED_PREFIX = `${NAMESPACE}lastEdited.`;

export interface ListViewSnapshot {
	sort: SortState[];
	filters: FilterState[];
	/** Client-mode-only grouping column id (grid-svelte `GridState.groupBy`). Omit for a list with no grouping concept. */
	groupBy?: string | null;
}

const SORT_DIRECTIONS: ReadonlySet<SortDirection> = new Set(['asc', 'desc']);
// Mirrors `FilterOp` (types.ts) exactly - kept as its own literal list (not
// derived from the type, which doesn't exist at runtime) so an op added to
// one and not the other is a compile error at the call site below, not a
// silently-accepted new string here.
const FILTER_OPS: ReadonlySet<FilterOp> = new Set([
	'eq',
	'ne',
	'lt',
	'lte',
	'gt',
	'gte',
	'contains',
	'starts_with',
	'in',
	'is_null',
	'not_null'
]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

/**
 * A saved payload is untrusted input (#215/#255 review): a column can be
 * renamed/removed between sessions, a hand-edited/corrupted `sessionStorage`
 * entry can carry any shape at all, and a future version of this module
 * could change `FilterOp`'s members. Validate every ELEMENT's shape, not
 * just "the arrays exist" - a single malformed sort/filter entry (missing
 * `field`, an unrecognized `op`, a `direction` that isn't `asc`/`desc`, no
 * `value` key at all) rejects the WHOLE snapshot rather than risk feeding a
 * half-formed `FilterState`/`SortState` into `DataProvider.getList` or
 * `@banto/grid-svelte`'s `filterRows` (an unknown `op` there matches
 * nothing, silently emptying the grid instead of failing loudly - #215).
 */
function isSortState(value: unknown): value is SortState {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		isNonEmptyString(candidate.field) &&
		typeof candidate.direction === 'string' &&
		SORT_DIRECTIONS.has(candidate.direction as SortDirection)
	);
}

function isFilterState(value: unknown): value is FilterState {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		isNonEmptyString(candidate.field) &&
		typeof candidate.op === 'string' &&
		FILTER_OPS.has(candidate.op as FilterOp) &&
		'value' in candidate
	);
}

function isSnapshot(value: unknown): value is ListViewSnapshot {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	if (!Array.isArray(candidate.sort) || !candidate.sort.every(isSortState)) return false;
	if (!Array.isArray(candidate.filters) || !candidate.filters.every(isFilterState)) return false;
	if (
		candidate.groupBy !== undefined &&
		candidate.groupBy !== null &&
		typeof candidate.groupBy !== 'string'
	) {
		return false;
	}
	return true;
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

/**
 * Load a previously-saved snapshot for `key`, or `null` if there is none (or
 * it's invalid - see `isSnapshot`'s doc comment).
 *
 * `knownFields`, when given, drops any `sort`/`filters` entry whose `field`
 * isn't in it (#215/#255 review: a column removed/renamed since the
 * snapshot was saved must not restore a filter/sort the current screen has
 * no column for) - the REST of the snapshot still loads; only the stale
 * entries disappear. Omit it to skip this check (the caller has no fixed
 * column set to check against, or already trusts the source).
 */
export function loadListViewState(
	key: string,
	knownFields?: readonly string[],
	storage?: Storage | null
): ListViewSnapshot | null {
	const store = resolveStorage(storage);
	if (!store) return null;
	const parsed = readJson(store, `${SNAPSHOT_PREFIX}${key}`);
	if (!isSnapshot(parsed)) return null;
	if (!knownFields) return parsed;
	const known = new Set(knownFields);
	return {
		...parsed,
		sort: parsed.sort.filter((entry) => known.has(entry.field)),
		filters: parsed.filters.filter((entry) => known.has(entry.field))
	};
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
 * Drop EVERY key this module has ever written - every snapshot (any
 * resource/mode), every active-mode marker, every last-opened-id marker,
 * and any pending last-edited-record marker.
 *
 * #215/#255 review: `sessionStorage` outlives logout/session-end (it is
 * tab-scoped, not identity-scoped), so without this a second identity
 * logging into the SAME tab - a different account, a re-entered public
 * viewer, a fresh login after the previous session expired - would silently
 * inherit whoever was there before: their filter text, sort, and which row
 * they had open. Called automatically at every identity-transition point
 * admin-core itself owns (`registry.svelte.ts`'s `initBanto` wraps
 * `AuthProvider.login`/`setup`/`enterPublicViewer`/`logout` to call this on
 * success; `sessionGate.ts`'s `resolveProtectedSession` calls it when a
 * guard finds no valid session at all; `sessionEnded.ts` calls it the moment
 * a background revocation is confirmed) - a derived app gets this for free
 * by using those APIs as already documented, no extra wiring of its own.
 */
export function clearAllListViewState(storage?: Storage | null): void {
	const store = resolveStorage(storage);
	if (!store) return;
	const keysToRemove: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const key = store.key(i);
		if (key && key.startsWith(NAMESPACE)) keysToRemove.push(key);
	}
	for (const key of keysToRemove) {
		try {
			store.removeItem(key);
		} catch {
			// Ignore.
		}
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

/**
 * Wraps `provider` so every method that BEGINS or ENDS a session
 * (`login`/`setup`/`enterPublicViewer` on success, `logout` unconditionally)
 * also calls `onTransition` (defaults to `clearAllListViewState` - see that
 * function's doc comment for why). `registry.svelte.ts`'s `initBanto`
 * applies this to whatever `AuthProvider` the app passes in (with its own
 * `onTransition` that ALSO bumps `sessionGeneration()`, Issue #215/#255
 * review's fix 2), so every existing call site (`getAuthProvider().logout()`,
 * the login page's `getAuthProvider().login()`, `resolveProtectedSession`'s
 * own `enterPublicViewer()` call) gets this for free without change.
 *
 * A failed `login`/`setup` (`{ success: false }`) does NOT call `onTransition`
 * - no identity actually changed, so wiping the CURRENT (still valid, if any)
 * session's list state over a mistyped password would be pure UX loss.
 * `logout` has no such signal (`Promise<void>`) and always represents
 * "this identity is done with this tab" from the caller's perspective even
 * if the network call itself fails, so it always calls it.
 *
 * Every wrapped method delegates to the original one first and only then
 * calls `onTransition`, so a rejection from the original method propagates
 * exactly as before (nothing fires for a login/logout that never actually
 * completed) - existing call sites that already `await` these calls without
 * their own try/catch (`Header.svelte`, `commands.ts`) are unaffected.
 *
 * #215/#255 review (fix 1): a plain `{ ...provider }` spread breaks any
 * `AuthProvider` that isn't a flat object of arrow functions - a class
 * instance's methods live on its PROTOTYPE (`{ ...provider }` only copies
 * OWN enumerable properties, so `check`/`getIdentity`/etc. would be
 * missing entirely and calling them would throw), and even a plain object
 * whose methods read/write shared `this` state (e.g. `login()` sets
 * `this.signedIn = true`, `check()` reads it) would split that state
 * between the copied `check` (still bound to the ORIGINAL `provider` as
 * its lexical/property owner, but invoked as `wrapped.check()` - a method
 * call sets `this` from the call-site object, so it would silently run
 * against the WRAPPER instead) - the very state the real object relies on.
 * A `Proxy` fixes this generally: every property access - the four we
 * override AND any other method/property the concrete `AuthProvider` adds -
 * resolves through `Reflect.get`/`.bind(provider)` against the ORIGINAL
 * `provider` as receiver, so `this` inside any method (prototype or own,
 * known or not) is always the real instance, never the proxy.
 */
export function withListViewStateClearing(
	provider: AuthProvider,
	onTransition: () => void = clearAllListViewState
): AuthProvider {
	const overrides: Partial<AuthProvider> = {
		logout: async () => {
			try {
				await provider.logout();
			} finally {
				onTransition();
			}
		},
		login: async (params: Record<string, unknown>) => {
			const result = await provider.login(params);
			if (result.success) onTransition();
			return result;
		}
	};
	if (provider.setup) {
		overrides.setup = async (params: Record<string, unknown>) => {
			const result = await provider.setup!(params);
			if (result.success) onTransition();
			return result;
		};
	}
	if (provider.enterPublicViewer) {
		overrides.enterPublicViewer = async () => {
			const entered = await provider.enterPublicViewer!();
			if (entered) onTransition();
			return entered;
		};
	}

	return new Proxy(provider, {
		get(target, prop, _receiver) {
			if (prop in overrides) return overrides[prop as keyof AuthProvider];
			// Reflect.get walks the prototype chain (so a class instance's
			// prototype methods resolve too, unlike `{ ...provider }`), and
			// passing `target` (not the proxy) as the receiver is what makes
			// a getter/accessor on `provider` see the REAL instance as `this`.
			const value: unknown = Reflect.get(target, prop, target);
			// A method called as `wrapper.foo()` would otherwise run with
			// `this === wrapper` (the proxy) - rebinding to `target` here is
			// what keeps `this`-based shared state (fix 1's second failure
			// mode) working exactly as it would unwrapped.
			return typeof value === 'function' ? value.bind(target) : value;
		},
		has(target, prop) {
			return prop in overrides || prop in target;
		}
	}) as AuthProvider;
}
