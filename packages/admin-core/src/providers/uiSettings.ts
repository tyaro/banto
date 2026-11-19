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
 * Write ordering (#707; Tauri and HTTP providers): writes are serialized per
 * key so a late-arriving older write can never overwrite a newer one.
 * - At most one write per key is in flight. A value arriving meanwhile is held
 *   (only the latest one); when the in-flight write finishes (success or
 *   failure) the held value is sent. Intermediate values are never sent.
 *   Different keys do not wait for each other.
 * - HTTP only: the token is captured when `set` is called. If `getToken()`
 *   differs right before sending (logout / another user), or there is no
 *   token, the write is dropped, not sent. Tauri has no token; session checks
 *   stay in the Tauri command (it rejects writes after logout).
 * - `get(key)` waits until that key's writes (the in-flight one and the held
 *   one) are done, then reads. A failed write never makes `get` reject.
 * - `set` resolves when its write was sent and succeeded, or was dropped
 *   (token mismatch / no token / superseded by a later value); it rejects only
 *   when its own write was sent and failed.
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
	/** Token captured at `set` time (HTTP only; `null` = no token). */
	token: string | null;
	settle: Array<{ resolve: () => void; reject: (reason: unknown) => void }>;
}

/**
 * Wraps a raw (unserialized) provider with the per-key write serialization
 * described in the file header. Module-private; shared by the Tauri and HTTP
 * providers. `getToken` is omitted for Tauri (no token: nothing is ever
 * dropped for a session change, see header).
 */
function serializeWrites(
	inner: UiSettingsProvider,
	getToken?: () => string | null
): UiSettingsProvider {
	/** Keys with a write in flight -> the latest value held meanwhile (or null). */
	const held = new Map<string, PendingWrite | null>();
	/** Keys with a write in flight -> the drain promise `get` waits on (never rejects). */
	const drains = new Map<string, Promise<void>>();

	function shouldDrop(write: PendingWrite): boolean {
		if (!getToken) return false;
		return write.token === null || write.token === '' || getToken() !== write.token;
	}

	async function drain(key: string, first: PendingWrite): Promise<void> {
		let item: PendingWrite | null = first;
		while (item) {
			const current: PendingWrite = item;
			if (shouldDrop(current)) {
				// Session changed (or none) since the write was accepted: drop it.
				current.settle.forEach((s) => s.resolve());
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
			const token = getToken ? getToken() : null;
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

// --- Tauri invoke ----------------------------------------------------------

export interface TauriUiSettingsOptions {
	/** Injected so this module has no `@tauri-apps/api` dependency of its own (same as `TauriInvokeOptions`). */
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * `UiSettingsProvider` over the `ui_settings_get`/`ui_settings_set` Tauri
 * commands (spec M12: session required, any role).
 */
export function createTauriUiSettings(options: TauriUiSettingsOptions): UiSettingsProvider {
	async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
		try {
			return (await options.invoke(cmd, args)) as T;
		} catch (err) {
			throw toProviderError(err);
		}
	}

	return serializeWrites({
		async get(key: string): Promise<string | null> {
			assertValidKey(key);
			return (await call<string | null>('ui_settings_get', { key })) ?? null;
		},

		async set(key: string, value: string): Promise<void> {
			assertValidKey(key);
			await call<void>('ui_settings_set', { key, value });
		}
	});
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
 * - `get` -> `GET {base}/api/ui-settings/{key}` -> `{"value": string | null}`
 * - `set` -> `PUT {base}/api/ui-settings/{key}` with `{"value": string}` -> `204`
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
				const body = (await response.json()) as { value: string | null };
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
		options.getToken
	);
}
