/**
 * `UiSettingsProvider` (spec §12.1, M12): a tiny string key/value abstraction
 * for UI settings (theme mode/preset, dock layout, ...), so their
 * persistence can move from localStorage to the backend `settings` table
 * without the UI caring which one is active.
 *
 * Three implementations, matching the app's three environments (spec §11.1):
 * - `createLocalUiSettings()`  - localStorage, key prefix `banto.ui.`
 *   (plain-browser demo mode, and the offline fallback).
 * - `createTauriUiSettings()`  - `ui_settings_get`/`ui_settings_set` Tauri
 *   commands (session required, any role). Same injected-`invoke` convention
 *   as `providers/tauri.ts` - no `@tauri-apps/api` dependency here.
 * - `createHttpUiSettings()`   - `GET/PUT /api/ui-settings/{key}` REST routes
 *   (authenticated, any role). Same CSRF header + bearer-token conventions
 *   as `providers/http.ts`.
 *
 * Keys are `[A-Za-z0-9._-]{1,64}` (the backend validates too; validating
 * here as well turns a typo into an immediate, local error instead of a
 * round-tripped 4xx). Errors are normalized to `ProviderError` like every
 * other provider - callers that treat settings persistence as best-effort
 * (the app's settings store) simply catch and ignore.
 *
 * Wire shape (Issue #786, v8.0.0): the backend answers a read with
 * `{ value, revision }` and a write with `{ revision }` (REST and the Tauri
 * commands alike), and takes an optional `ifRevision` for conditional writes
 * plus a delete. The Tauri and HTTP adapters below read that shape and DROP
 * the revision: this interface is still the old one (`get` -> string | null,
 * `set` -> void, unconditional), so existing callers keep working. The
 * revision-aware interface (and `remove`) replaces it in a later change.
 *
 * Write ordering (#707; Tauri and HTTP providers): writes are serialized per
 * key so a late-arriving older write can never overwrite a newer one.
 * - At most one write per key is in flight. A value arriving meanwhile is held
 *   (only the latest one); when the in-flight write finishes (success or
 *   failure) the held value is sent. Intermediate values are never sent.
 *   Different keys do not wait for each other.
 * - Session check: a session key is captured when `set` is called. If it
 *   differs right before sending (logout / another user), the held write is
 *   dropped, not sent. HTTP uses the bearer token (no token = dropped too).
 *   Tauri uses the optional `getSessionRevision` (normally
 *   `authProvider.credentialRevision()`); without it the session is not
 *   checked (as before) and the Tauri command saves for whoever is logged in.
 * - `get(key)` waits until that key's writes (the in-flight one and the held
 *   one) are done, then reads. A failed write never makes `get` reject.
 * - `set` resolves when its write was sent and succeeded, or was superseded by
 *   a later value (an intermediate value, never sent). It rejects when its own
 *   write was sent and failed, or was dropped for a session difference / no
 *   token (`ProviderError` kind `unauthorized`, same outcome as the old 401), so
 *   callers never treat an unsent value as saved.
 * - Key validation still fails immediately, at the `set`/`get` call.
 */
import { ProviderError, type ErrorBody } from '../errors';

export interface UiSettingsProvider {
	/** Resolve the stored value for `key`, or `null` when nothing is stored yet. */
	get(key: string): Promise<string | null>;
	/** Store `value` under `key` (upsert). */
	set(key: string, value: string): Promise<void>;
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

// --- per-key write serialization (#707) ------------------------------------

interface PendingWrite {
	value: string;
	/** Session key captured at `set` time (`null` = none). */
	token: string | null;
	settle: Array<{ resolve: () => void; reject: (reason: unknown) => void }>;
}

/**
 * Wraps a raw (unserialized) provider with the per-key write serialization
 * described in the file header. Module-private; shared by the Tauri and HTTP
 * providers. `getSessionKey` identifies the session (HTTP: token, Tauri:
 * credential revision); when omitted nothing is dropped for a session change.
 * A write dropped for a session difference is rejected with `unauthorized`. `requireKey` additionally drops writes whose key was
 * empty/null at accept time (HTTP: no token).
 */
function serializeWrites(
	inner: UiSettingsProvider,
	getSessionKey?: () => string | null,
	requireKey = false
): UiSettingsProvider {
	/** Keys with a write in flight -> the latest value held meanwhile (or null). */
	const held = new Map<string, PendingWrite | null>();
	/** Keys with a write in flight -> the drain promise `get` waits on (never rejects). */
	const drains = new Map<string, Promise<void>>();

	function shouldDrop(write: PendingWrite): boolean {
		if (!getSessionKey) return false;
		if (requireKey && (write.token === null || write.token === '')) return true;
		return getSessionKey() !== write.token;
	}

	async function drain(key: string, first: PendingWrite): Promise<void> {
		let item: PendingWrite | null = first;
		while (item) {
			const current: PendingWrite = item;
			if (shouldDrop(current)) {
				// Session changed (or none) since the write was accepted: drop it, and
				// reject so the caller does not treat an unsent value as saved.
				const dropped = new ProviderError({ kind: 'unauthorized' });
				current.settle.forEach((s) => s.reject(dropped));
			} else {
				try {
					await inner.set(key, current.value);
					current.settle.forEach((s) => s.resolve());
				} catch (error) {
					current.settle.forEach((s) => s.reject(error));
				}
			}
			item = held.get(key) ?? null;
			held.set(key, null);
		}
		held.delete(key);
		drains.delete(key);
	}

	return {
		async get(key: string): Promise<string | null> {
			assertValidKey(key);
			// Wait while writes remain; a write accepted while waiting is awaited too.
			for (let d = drains.get(key); d; d = drains.get(key)) {
				await d;
			}
			return inner.get(key);
		},

		set(key: string, value: string): Promise<void> {
			try {
				assertValidKey(key);
			} catch (err) {
				return Promise.reject(err);
			}
			const token = getSessionKey ? getSessionKey() : null;
			return new Promise<void>((resolve, reject) => {
				const entry: PendingWrite = { value, token, settle: [{ resolve, reject }] };
				if (!held.has(key)) {
					held.set(key, null);
					// drain() runs synchronously up to its first await, so register it
					// only if it is still in flight (a dropped write ends without awaiting).
					const d = drain(key, entry);
					if (held.has(key)) drains.set(key, d);
					return;
				}
				// In flight: the held intermediate value is superseded (resolved as dropped).
				held.get(key)?.settle.forEach((s) => s.resolve());
				held.set(key, entry);
			});
		}
	};
}

// --- localStorage ----------------------------------------------------------

const LOCAL_PREFIX = 'banto.ui.';

export interface LocalUiSettingsOptions {
	/** Injected for tests; defaults to the global `localStorage`. */
	storage?: Storage;
}

/**
 * localStorage-backed `UiSettingsProvider` (demo mode / offline fallback).
 * Keys are prefixed `banto.ui.` so they never collide with the app's other
 * localStorage entries (`banto.theme`, `banto.dock.dashboard`, ...).
 */
export function createLocalUiSettings(options: LocalUiSettingsOptions = {}): UiSettingsProvider {
	function storage(): Storage {
		return options.storage ?? localStorage;
	}

	return {
		async get(key: string): Promise<string | null> {
			assertValidKey(key);
			return storage().getItem(`${LOCAL_PREFIX}${key}`);
		},

		async set(key: string, value: string): Promise<void> {
			assertValidKey(key);
			storage().setItem(`${LOCAL_PREFIX}${key}`, value);
		}
	};
}

/** What the backend answers a read with (REST body and Tauri command alike, #786). */
interface UiSettingWire {
	value: string | null;
	/** Changes on every write; `"0"` when nothing is stored. Not used by this interface yet. */
	revision: string;
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
 * `UiSettingsProvider` over the `ui_settings_get`/`ui_settings_set` Tauri
 * commands (spec M12: session required, any role).
 * - `get` -> `ui_settings_get { key }` -> `{ value: string | null, revision }`
 * - `set` -> `ui_settings_set { key, value }` -> `{ revision }` (no
 *   `ifRevision`: unconditional)
 * The revision is not used yet (see the file header, #786).
 */
export function createTauriUiSettings(options: TauriUiSettingsOptions): UiSettingsProvider {
	async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
		try {
			return (await options.invoke(cmd, args)) as T;
		} catch (err) {
			throw toProviderError(err);
		}
	}

	const { getSessionRevision } = options;
	return serializeWrites(
		{
			async get(key: string): Promise<string | null> {
				assertValidKey(key);
				const stored = await call<UiSettingWire>('ui_settings_get', { key });
				return stored.value ?? null;
			},

			async set(key: string, value: string): Promise<void> {
				assertValidKey(key);
				// Answers `{ revision }`; dropped until the provider carries it (#786).
				await call<unknown>('ui_settings_set', { key, value });
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
 * `UiSettingsProvider` over the embedded REST server (spec M12):
 * - `get` -> `GET {base}/api/ui-settings/{key}` -> `{"value": string | null, "revision": string}`
 * - `set` -> `PUT {base}/api/ui-settings/{key}` with `{"value": string}` -> `200 {"revision": string}`
 *   (no `ifRevision`: unconditional)
 * The revision is not used yet (see the file header, #786).
 * Same CSRF header (`X-Banto-Client: banto`) + `Authorization: Bearer`
 * conventions as `createHttpDataProvider`. Writes are serialized per key and
 * dropped on a token change / no token (see the file header, #707).
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

	return serializeWrites(
		{
			async get(key: string): Promise<string | null> {
				assertValidKey(key);
				let response: Response;
				try {
					response = await fetchFn(`${baseUrl}/api/ui-settings/${key}`, {
						method: 'GET',
						headers: headers(false)
					});
				} catch {
					throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
				}
				if (!response.ok) throw await errorFromResponse(response);
				const body = (await response.json()) as UiSettingWire;
				return body.value ?? null;
			},

			async set(key: string, value: string): Promise<void> {
				assertValidKey(key);
				let response: Response;
				try {
					response = await fetchFn(`${baseUrl}/api/ui-settings/${key}`, {
						method: 'PUT',
						headers: headers(true),
						body: JSON.stringify({ value })
					});
				} catch {
					throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
				}
				if (!response.ok) throw await errorFromResponse(response);
			}
		},
		options.getToken,
		true
	);
}
