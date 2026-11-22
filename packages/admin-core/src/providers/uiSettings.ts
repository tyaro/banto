/**
 * `UiSettingsProvider` (spec §12.1, M12; Issue #786): a tiny string key/value
 * abstraction for UI settings (theme mode/preset, dock layout, ...), so their
 * persistence can move from localStorage to the backend `ui_settings` table
 * without the UI caring which one is active.
 *
 * Shape (v8.0.0, Issue #786 - it replaced the old `get -> string | null` /
 * `set -> void` interface):
 * - `get(key)` -> `{ value, revision }`. Nothing stored: `value: null`,
 *   `revision: "0"` ({@link UI_SETTING_ABSENT_REVISION}).
 * - `set(key, value, { ifRevision? })` -> `{ revision }` (the new revision).
 *   Without `ifRevision` the write is unconditional (last write wins). With
 *   it, the write happens only while the stored revision is still that one
 *   (`"0"` = only while nothing is stored); otherwise it rejects with a
 *   `ProviderError` of kind `conflict` whose `current` is the value as it is
 *   now - read it with {@link uiSettingConflict}.
 * - `remove(key, { ifRevision? })` -> `{ revision: "0" }`. Same condition.
 * A revision is an opaque string that changes on every write. Never compute
 * with it or compare it for order; only hand it back as `ifRevision`.
 *
 * Three implementations, matching the app's three environments (spec §11.1):
 * - `createLocalUiSettings()`  - localStorage, key prefix `banto.ui.`
 *   (plain-browser demo mode, and the offline fallback).
 * - `createTauriUiSettings()`  - `ui_settings_get` / `ui_settings_set` /
 *   `ui_settings_delete` Tauri commands (session required, any role). Same
 *   injected-`invoke` convention as `providers/tauri.ts` - no
 *   `@tauri-apps/api` dependency here.
 * - `createHttpUiSettings()`   - `GET/PUT/DELETE /api/ui-settings/{key}` REST
 *   routes (authenticated, any role). Same CSRF header + bearer-token
 *   conventions as `providers/http.ts`.
 *
 * Keys are `[A-Za-z0-9._-]{1,64}` (the backend validates too; validating
 * here as well turns a typo into an immediate, local error instead of a
 * round-tripped 4xx). Errors are normalized to `ProviderError` like every
 * other provider - callers that treat settings persistence as best-effort
 * (the app's settings store) simply catch and ignore.
 *
 * Write ordering (#707; Tauri and HTTP providers): writes (`set` and
 * `remove`) are serialized per key so a late-arriving older write can never
 * overwrite a newer one.
 * - At most one write per key is in flight; the others wait in a queue and are
 *   sent in the order they were accepted. Different keys do not wait for each
 *   other.
 * - Only an UNCONDITIONAL `set` that is still waiting can be superseded: when
 *   the next write accepted for that key is also unconditional (a `set` or a
 *   `remove`), the waiting value is never sent and its `set` resolves to
 *   `{ revision: null, superseded: true }` - "not sent", told apart from a
 *   real revision by the type (`revision` is `null`, so it cannot be passed
 *   on as an `ifRevision` by mistake).
 * - A CONDITIONAL write (`ifRevision` given) is never superseded and never
 *   supersedes: it is always sent, in order, and resolves only with the
 *   server's own answer (a revision or a `conflict`). A `remove` is never
 *   superseded either.
 * - Session check: a session key is captured when the write is accepted. If
 *   it differs right before sending (logout / another user), the write is
 *   dropped, not sent. HTTP uses the bearer token (no token = dropped too).
 *   Tauri uses the optional `getSessionRevision` (normally
 *   `authProvider.credentialRevision()`); without it the session is not
 *   checked and the Tauri command saves for whoever is logged in.
 * - `get(key)` waits until that key's writes (the in-flight one and the
 *   queued ones) are done, then reads. A failed write never makes `get` reject.
 * - A write rejects when it was sent and failed, or was dropped for a session
 *   difference / no token (`ProviderError` kind `unauthorized`, same outcome
 *   as a 401), so callers never treat an unsent value as saved.
 * - Key validation still fails immediately, at the call.
 *
 * `updateUiSetting(provider, key, apply)` is the read-apply-conditional-write
 * loop on top of this (see its doc: `apply` must be idempotent).
 */
import { ProviderError, type ErrorBody } from '../errors';

/** The revision of "nothing is stored" (a `get` of an unset key, the answer of `remove`). */
export const UI_SETTING_ABSENT_REVISION = '0';

/** A stored UI setting as it is now: the answer of `get`, and the `current` of a `conflict`. */
export interface UiSettingSnapshot {
	/** The stored string, or `null` when nothing is stored. */
	value: string | null;
	/** Opaque; changes on every write. `"0"` when nothing is stored. */
	revision: string;
}

export interface UiSettingWriteOptions {
	/**
	 * Write only while the stored revision is still this one (`"0"` = only
	 * while nothing is stored). Left out = unconditional (last write wins).
	 */
	ifRevision?: string;
}

/**
 * The answer of `set`. Either the write was sent and stored (`revision` is the
 * new revision), or - for an unconditional `set` only - it was superseded by
 * a later unconditional write before it was sent (`revision: null`,
 * `superseded: true`; nothing was sent for this call, the later write carries
 * the outcome). A conditional `set` never answers `superseded`.
 */
export type UiSettingWriteResult =
	{ revision: string; superseded?: false } | { revision: null; superseded: true };

/** The answer of `remove`: the revision of "nothing is stored" (`"0"`). */
export interface UiSettingRemoveResult {
	revision: string;
}

export interface UiSettingsProvider {
	/** The stored value and its revision (`{ value: null, revision: "0" }` when nothing is stored). */
	get(key: string): Promise<UiSettingSnapshot>;
	/**
	 * Store `value` under `key`. Unconditional without `ifRevision`; with it,
	 * rejects with a `conflict` `ProviderError` when the stored revision differs
	 * ({@link uiSettingConflict} reads the current value from the error).
	 */
	set(key: string, value: string, options?: UiSettingWriteOptions): Promise<UiSettingWriteResult>;
	/** Delete what is stored under `key` (same `ifRevision` condition as `set`). Deleting nothing succeeds. */
	remove(key: string, options?: UiSettingWriteOptions): Promise<UiSettingRemoveResult>;
}

function isSnapshot(value: unknown): value is UiSettingSnapshot {
	if (typeof value !== 'object' || value === null) return false;
	const { value: stored, revision } = value as { value?: unknown; revision?: unknown };
	return (stored === null || typeof stored === 'string') && typeof revision === 'string';
}

/**
 * Tell a failed conditional write apart: when `error` is the `conflict` of a
 * `set` / `remove` whose `ifRevision` did not match, returns the setting as it
 * is now (`{ value, revision }`; `value: null` / `"0"` when it was deleted),
 * otherwise `null`.
 */
export function uiSettingConflict(error: unknown): UiSettingSnapshot | null {
	if (!(error instanceof ProviderError) || error.body.kind !== 'conflict') return null;
	const current = error.body.current;
	return isSnapshot(current) ? { value: current.value, revision: current.revision } : null;
}

/** Wire contract for keys (matches the backend's `[A-Za-z0-9._-]{1,64}`). */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function assertValidKey(key: string): void {
	if (!KEY_PATTERN.test(key)) {
		throw new ProviderError({ kind: 'other', message: `invalid ui-settings key: ${key}` });
	}
}

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'conflict',
	'storage',
	'other'
]);

/** Same type guard as providers/tauri.ts / providers/http.ts (spec §10/§11.1). */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

function toProviderError(err: unknown): ProviderError {
	if (err instanceof ProviderError) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

const UNEXPECTED_RESPONSE_MESSAGE = 'unexpected ui-settings response';

/** Reads an adapter answer, refusing anything that is not the #786 wire shape (e.g. a pre-v8 backend). */
function asSnapshot(body: unknown): UiSettingSnapshot {
	if (isSnapshot(body)) return { value: body.value, revision: body.revision };
	throw new ProviderError({ kind: 'other', message: UNEXPECTED_RESPONSE_MESSAGE });
}

function asRevision(body: unknown): { revision: string } {
	const revision =
		typeof body === 'object' && body !== null ? (body as { revision?: unknown }).revision : null;
	if (typeof revision === 'string') return { revision };
	throw new ProviderError({ kind: 'other', message: UNEXPECTED_RESPONSE_MESSAGE });
}

// --- per-key write serialization (#707) ------------------------------------

/** What an adapter sends, one call per request (no ordering of its own). */
interface RawUiSettings {
	get(key: string): Promise<UiSettingSnapshot>;
	set(key: string, value: string, ifRevision: string | undefined): Promise<{ revision: string }>;
	remove(key: string, ifRevision: string | undefined): Promise<{ revision: string }>;
}

interface QueuedWrite {
	/** `null` = remove. */
	value: string | null;
	ifRevision: string | undefined;
	/** Session key captured when the write was accepted (`null` = none). */
	token: string | null;
	resolve: (result: UiSettingWriteResult) => void;
	reject: (reason: unknown) => void;
}

/**
 * Wraps a raw (unserialized) adapter with the per-key write serialization
 * described in the file header. Module-private; shared by the Tauri and HTTP
 * providers. `getSessionKey` identifies the session (HTTP: token, Tauri:
 * credential revision); when omitted nothing is dropped for a session change.
 * A write dropped for a session difference is rejected with `unauthorized`.
 * `requireKey` additionally drops writes whose key was empty/null at accept
 * time (HTTP: no token).
 */
function serializeWrites(
	inner: RawUiSettings,
	getSessionKey?: () => string | null,
	requireKey = false
): UiSettingsProvider {
	/** Keys with a write in flight -> the writes accepted meanwhile, in order. */
	const queues = new Map<string, QueuedWrite[]>();
	/** Keys with a write in flight -> the drain promise `get` waits on (never rejects). */
	const drains = new Map<string, Promise<void>>();

	function shouldDrop(write: QueuedWrite): boolean {
		if (!getSessionKey) return false;
		if (requireKey && (write.token === null || write.token === '')) return true;
		return getSessionKey() !== write.token;
	}

	async function drain(key: string, first: QueuedWrite, queue: QueuedWrite[]): Promise<void> {
		for (let item: QueuedWrite | undefined = first; item; item = queue.shift()) {
			if (shouldDrop(item)) {
				// Session changed (or none) since the write was accepted: drop it, and
				// reject so the caller does not treat an unsent value as saved.
				item.reject(new ProviderError({ kind: 'unauthorized' }));
				continue;
			}
			try {
				const sent =
					item.value === null
						? await inner.remove(key, item.ifRevision)
						: await inner.set(key, item.value, item.ifRevision);
				item.resolve({ revision: sent.revision });
			} catch (error) {
				item.reject(error);
			}
		}
		queues.delete(key);
		drains.delete(key);
	}

	function accept(
		key: string,
		value: string | null,
		options: UiSettingWriteOptions | undefined
	): Promise<UiSettingWriteResult> {
		try {
			assertValidKey(key);
		} catch (err) {
			return Promise.reject(err);
		}
		const ifRevision = options?.ifRevision;
		const token = getSessionKey ? getSessionKey() : null;
		return new Promise<UiSettingWriteResult>((resolve, reject) => {
			const entry: QueuedWrite = { value, ifRevision, token, resolve, reject };
			const waiting = queues.get(key);
			if (!waiting) {
				const queue: QueuedWrite[] = [];
				queues.set(key, queue);
				// drain() runs synchronously up to its first await, so register it
				// only if it is still in flight (a dropped write ends without awaiting).
				const d = drain(key, entry, queue);
				if (queues.has(key)) drains.set(key, d);
				return;
			}
			// In flight. Only a waiting unconditional `set`, directly followed by
			// another unconditional write, is superseded (never sent). Anything
			// conditional keeps its place and is sent in order.
			const last = waiting[waiting.length - 1];
			if (
				ifRevision === undefined &&
				last !== undefined &&
				last.value !== null &&
				last.ifRevision === undefined
			) {
				waiting.pop();
				last.resolve({ revision: null, superseded: true });
			}
			waiting.push(entry);
		});
	}

	return {
		async get(key) {
			assertValidKey(key);
			// Wait while writes remain; a write accepted while waiting is awaited too.
			for (let d = drains.get(key); d; d = drains.get(key)) {
				await d;
			}
			return inner.get(key);
		},

		set(key, value, options) {
			return accept(key, value, options);
		},

		async remove(key, options) {
			// A remove is never superseded, so its answer always carries a revision.
			const result = await accept(key, null, options);
			return { revision: result.revision ?? UI_SETTING_ABSENT_REVISION };
		}
	};
}

// --- localStorage ----------------------------------------------------------

const LOCAL_PREFIX = 'banto.ui.';
/** Where the revision of `banto.ui.<key>` lives (not under `banto.ui.`, so it cannot collide with a key). */
const LOCAL_REVISION_PREFIX = 'banto.ui-rev.';

export interface LocalUiSettingsOptions {
	/** Injected for tests; defaults to the global `localStorage`. */
	storage?: Storage;
}

/** FNV-1a (32 bit) of the value: ties a stored revision to the value it was minted for. */
function fingerprint(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/** A random revision (never `"0"`). `getRandomValues` also exists on plain-http pages, unlike `randomUUID`. */
function newLocalRevision(): string {
	const bytes = new Uint8Array(12);
	const source = (globalThis as { crypto?: Crypto }).crypto;
	if (source?.getRandomValues) source.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return 'l' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * localStorage-backed `UiSettingsProvider` (demo mode / offline fallback).
 * Keys are prefixed `banto.ui.` so they never collide with the app's other
 * localStorage entries (`banto.theme`, `banto.dock.dashboard`, ...). The value
 * is stored as is under `banto.ui.<key>`; its revision lives beside it under
 * `banto.ui-rev.<key>` as `<revision>:<fingerprint of the value>`. A value
 * written by something else (a test priming `banto.ui.<key>`, another tool)
 * has no matching revision entry: it reads with a revision derived from the
 * value (`f<fingerprint>`), so a revision handed out before that change stops
 * matching, as it should, and `get` never writes.
 *
 * Each call checks and writes within one synchronous step, so a conditional
 * write is atomic against other tabs (localStorage is shared and synchronous).
 * Nothing is queued, so `set` never answers `superseded`.
 */
export function createLocalUiSettings(options: LocalUiSettingsOptions = {}): UiSettingsProvider {
	function storage(): Storage {
		return options.storage ?? localStorage;
	}

	function mint(key: string, value: string): string {
		const revision = newLocalRevision();
		storage().setItem(`${LOCAL_REVISION_PREFIX}${key}`, `${revision}:${fingerprint(value)}`);
		return revision;
	}

	function read(key: string): UiSettingSnapshot {
		const value = storage().getItem(`${LOCAL_PREFIX}${key}`);
		if (value === null) return { value: null, revision: UI_SETTING_ABSENT_REVISION };
		const entry = storage().getItem(`${LOCAL_REVISION_PREFIX}${key}`);
		const split = entry ? entry.lastIndexOf(':') : -1;
		if (entry && split > 0 && entry.slice(split + 1) === fingerprint(value)) {
			return { value, revision: entry.slice(0, split) };
		}
		// Not written through this provider: a revision derived from the value, so a
		// read never writes and stays stable until the value changes again.
		return { value, revision: `f${fingerprint(value)}` };
	}

	function check(key: string, ifRevision: string | undefined): void {
		if (ifRevision === undefined) return;
		const current = read(key);
		if (current.revision !== ifRevision) {
			throw new ProviderError({
				kind: 'conflict',
				message: `ui setting changed: ${key}`,
				current
			});
		}
	}

	return {
		async get(key) {
			assertValidKey(key);
			return read(key);
		},

		async set(key, value, writeOptions) {
			assertValidKey(key);
			check(key, writeOptions?.ifRevision);
			storage().setItem(`${LOCAL_PREFIX}${key}`, value);
			return { revision: mint(key, value) };
		},

		async remove(key, writeOptions) {
			assertValidKey(key);
			check(key, writeOptions?.ifRevision);
			storage().removeItem(`${LOCAL_PREFIX}${key}`);
			storage().removeItem(`${LOCAL_REVISION_PREFIX}${key}`);
			return { revision: UI_SETTING_ABSENT_REVISION };
		}
	};
}

// --- Tauri invoke ----------------------------------------------------------

export interface TauriUiSettingsOptions {
	/** Injected so this module has no `@tauri-apps/api` dependency of its own (same as `TauriInvokeOptions`). */
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
	/**
	 * ふつうは `authProvider.credentialRevision()`。受け付け時と送る直前で違えば、
	 * 控えた書き込みを送らずに捨てる（unauthorized で reject）。省略時はセッションを見ない（従来どおり）。
	 */
	getSessionRevision?: () => string;
}

/**
 * `UiSettingsProvider` over the `ui_settings_get` / `ui_settings_set` /
 * `ui_settings_delete` Tauri commands (spec M12: session required, any role).
 * - `get`    -> `ui_settings_get { key }` -> `{ value: string | null, revision }`
 * - `set`    -> `ui_settings_set { key, value, ifRevision? }` -> `{ revision }`
 * - `remove` -> `ui_settings_delete { key, ifRevision? }` -> `{ revision: "0" }`
 * A failed condition is the command's `conflict` error (`current` = `{ value, revision }`).
 * Writes are serialized per key (see the file header, #707).
 */
export function createTauriUiSettings(options: TauriUiSettingsOptions): UiSettingsProvider {
	async function call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
		try {
			return await options.invoke(cmd, args);
		} catch (err) {
			throw toProviderError(err);
		}
	}

	/** `ifRevision` is left out of the arguments when the write is unconditional. */
	function withCondition(
		args: Record<string, unknown>,
		ifRevision: string | undefined
	): Record<string, unknown> {
		return ifRevision === undefined ? args : { ...args, ifRevision };
	}

	const { getSessionRevision } = options;
	return serializeWrites(
		{
			async get(key) {
				assertValidKey(key);
				return asSnapshot(await call('ui_settings_get', { key }));
			},

			async set(key, value, ifRevision) {
				assertValidKey(key);
				return asRevision(await call('ui_settings_set', withCondition({ key, value }, ifRevision)));
			},

			async remove(key, ifRevision) {
				assertValidKey(key);
				return asRevision(await call('ui_settings_delete', withCondition({ key }, ifRevision)));
			}
		},
		getSessionRevision ? () => getSessionRevision() : undefined
	);
}

// --- REST (embedded server) ------------------------------------------------

const CLIENT_HEADER_NAME = 'X-Banto-Client';
const CLIENT_HEADER_VALUE = 'banto';
const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

export interface HttpUiSettingsOptions {
	/** Prefixed to every request path, e.g. `http://192.168.1.5:8721`. Defaults to `''` (same-origin). */
	baseUrl?: string;
	/** Shares the bearer token with whichever `AuthProvider` logged in (typically `createHttpAuthProvider`'s `getToken`). */
	getToken: () => string | null;
	fetchFn?: typeof fetch;
}

/**
 * `UiSettingsProvider` over the embedded REST server (spec M12, Issue #786):
 * - `get`    -> `GET {base}/api/ui-settings/{key}` -> `{"value": string | null, "revision": string}`
 * - `set`    -> `PUT {base}/api/ui-settings/{key}` with `{"value", "ifRevision"?}` -> `200 {"revision"}`
 * - `remove` -> `DELETE {base}/api/ui-settings/{key}[?ifRevision=...]` -> `200 {"revision": "0"}`
 * A failed condition is `409` with the `conflict` error body (`current` = `{ value, revision }`).
 * Same CSRF header (`X-Banto-Client: banto`) + `Authorization: Bearer`
 * conventions as `createHttpDataProvider`. Writes are serialized per key and
 * dropped on a token change / no token (see the file header, #707). A `fetch`
 * that never got an answer is a `ProviderError` with `networkFailure: 'network'`
 * (`isNetworkError`) - for a write, it may or may not have been stored.
 */
export function createHttpUiSettings(options: HttpUiSettingsOptions): UiSettingsProvider {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;

	function headers(hasBody: boolean): Record<string, string> {
		const result: Record<string, string> = { [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE };
		if (hasBody) result['Content-Type'] = 'application/json';
		const token = options.getToken();
		if (token) result.Authorization = `Bearer ${token}`;
		return result;
	}

	async function errorFromResponse(response: Response): Promise<ProviderError> {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return new ProviderError({
				kind: 'other',
				message: `${response.status} ${response.statusText}`
			});
		}
		if (isErrorBody(body)) return new ProviderError(body);
		return new ProviderError({
			kind: 'other',
			message: `${response.status} ${response.statusText}`
		});
	}

	async function request(
		method: 'GET' | 'PUT' | 'DELETE',
		path: string,
		body?: unknown
	): Promise<unknown> {
		let response: Response;
		try {
			response = await fetchFn(`${baseUrl}${path}`, {
				method,
				headers: headers(body !== undefined),
				...(body !== undefined ? { body: JSON.stringify(body) } : {})
			});
		} catch {
			throw new ProviderError(
				{ kind: 'other', message: NETWORK_ERROR_MESSAGE },
				{ networkFailure: 'network' }
			);
		}
		if (!response.ok) throw await errorFromResponse(response);
		try {
			return await response.json();
		} catch {
			throw new ProviderError({ kind: 'other', message: UNEXPECTED_RESPONSE_MESSAGE });
		}
	}

	return serializeWrites(
		{
			async get(key) {
				assertValidKey(key);
				return asSnapshot(await request('GET', `/api/ui-settings/${key}`));
			},

			async set(key, value, ifRevision) {
				assertValidKey(key);
				return asRevision(
					await request(
						'PUT',
						`/api/ui-settings/${key}`,
						ifRevision === undefined ? { value } : { value, ifRevision }
					)
				);
			},

			async remove(key, ifRevision) {
				assertValidKey(key);
				const query =
					ifRevision === undefined ? '' : `?ifRevision=${encodeURIComponent(ifRevision)}`;
				return asRevision(await request('DELETE', `/api/ui-settings/${key}${query}`));
			}
		},
		options.getToken,
		true
	);
}

// --- read -> apply -> conditional write ------------------------------------

export interface UpdateUiSettingOptions {
	/**
	 * How many conditional writes may be tried (the first one included) before
	 * giving up with the last error. Default 5.
	 */
	maxAttempts?: number;
}

/** What `updateUiSetting` stored (or found already stored). */
export interface UpdatedUiSetting {
	value: string;
	revision: string;
}

const DEFAULT_UPDATE_ATTEMPTS = 5;

/** Was the write refused for sure, so nothing was stored? (`conflict` is handled apart.) */
function isDefiniteRefusal(error: unknown): boolean {
	if (!(error instanceof ProviderError) || error.networkFailure !== undefined) return false;
	switch (error.body.kind) {
		case 'validation':
		case 'bad_request':
		case 'unauthorized':
		case 'forbidden':
		case 'not_found':
			return true;
		default:
			// `storage` / `other` (a 5xx, a lost answer): unknown whether it was stored.
			return false;
	}
}

/**
 * Change one UI setting without overwriting somebody else's change (Issue
 * #786): read -> `apply(current)` -> conditional write (`ifRevision` = the
 * revision just read) -> on `conflict`, apply again to the value the conflict
 * returned. `apply` receives the stored string (`null` when nothing is
 * stored) and returns the string to store. When it returns the value it was
 * given, nothing is written.
 *
 * **`apply` MUST be idempotent**: applying it to a value it was already
 * applied to must give that same value (set a key, add to a set, replace a
 * field - not "add 1", not "append"). It can run on its own result:
 * - A write whose answer was lost (network failure, 5xx) is NOT sent again.
 *   The setting is read again instead: if it holds exactly what was sent, the
 *   update is done (with the revision just read). If not, `apply` runs on that
 *   value - which may already contain this very change (the write was stored,
 *   then somebody else wrote on top of it).
 * - A `conflict` re-applies to the current value in the same way.
 * A change that cannot be made idempotent must carry its own operation id in
 * the value and drop the duplicate itself; the server keeps no operation log.
 *
 * Gives up after `maxAttempts` conditional writes (default 5) and rejects with
 * the last error (a `conflict` `ProviderError` when it kept losing). A refusal
 * (`validation`, `unauthorized`, `forbidden`, ...) and a failed read reject at
 * once. `apply` is called with nothing locked: keep it pure and synchronous.
 */
export async function updateUiSetting(
	provider: UiSettingsProvider,
	key: string,
	apply: (current: string | null) => string,
	options: UpdateUiSettingOptions = {}
): Promise<UpdatedUiSetting> {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_UPDATE_ATTEMPTS));
	let current = await provider.get(key);
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const next = apply(current.value);
		if (next === current.value) return { value: next, revision: current.revision };
		let written: UiSettingWriteResult;
		try {
			written = await provider.set(key, next, { ifRevision: current.revision });
		} catch (error) {
			lastError = error;
			if (error instanceof ProviderError && error.body.kind === 'conflict') {
				// Somebody else wrote first: go again from the value it returned.
				current = uiSettingConflict(error) ?? (await provider.get(key));
				continue;
			}
			if (isDefiniteRefusal(error)) throw error;
			// Unknown outcome: never send the same PUT again. Read instead.
			current = await provider.get(key);
			if (current.value === next) return { value: next, revision: current.revision };
			continue;
		}
		if (written.revision === null) {
			// A conditional write is never superseded (provider contract).
			throw new ProviderError({
				kind: 'other',
				message: 'ui-settings provider superseded a conditional write'
			});
		}
		return { value: next, revision: written.revision };
	}
	throw lastError;
}
