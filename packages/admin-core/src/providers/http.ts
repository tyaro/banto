/**
 * `HttpDataProvider`/`HttpAuthProvider` (spec §3.2, §3.3, §11.1): map
 * `DataProvider`/`AuthProvider` calls onto `fetch()` against
 * `admin-template-core::rest`'s route table, so a LAN browser client talks
 * to the exact same service layer/DB the Tauri webview does.
 *
 * Route table (`apps/admin-template/core/src/rest.rs`'s doc comment is the
 * source of truth):
 * - `getList`   -> `POST {base}/api/{resource}/list` with `ListParams` body
 * - `getOne`    -> `GET {base}/api/{resource}/{id}`
 * - `create`    -> `POST {base}/api/{resource}` with the values body
 * - `update`    -> `PUT {base}/api/{resource}/{id}` with the values body
 * - `deleteOne` -> `DELETE {base}/api/{resource}/{id}`, expects `204`
 *
 * Every request carries `X-Banto-Client: banto` (spec §11.2's CSRF
 * mitigation, `banto_server::csrf`) and, once logged in,
 * `Authorization: Bearer <token>`. No dependency on `@tauri-apps/api` or any
 * particular fetch global - both are injectable so this module (and its
 * tests) run with a mocked `fetchFn` and no real network.
 */
import type { AuthProvider, DataProvider, Identity } from '../provider';
import type { ListParams, ListResult } from '../types';
import { ProviderError, type ErrorBody } from '../errors';

const CLIENT_HEADER_NAME = 'X-Banto-Client';
const CLIENT_HEADER_VALUE = 'banto';
const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

const ERROR_KINDS = new Set(['not_found', 'validation', 'unauthorized', 'storage', 'other']);

/** Type guard: does `value` look like a wire `ErrorBody` (spec §10/§11.1)? */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

/** Parse a non-2xx `Response` into a `ProviderError`; an unparseable body maps to `kind: 'other'` with the HTTP status line. */
async function errorFromResponse(response: Response): Promise<ProviderError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return new ProviderError({ kind: 'other', message: `${response.status} ${response.statusText}` });
	}
	if (isErrorBody(body)) return new ProviderError(body);
	return new ProviderError({ kind: 'other', message: `${response.status} ${response.statusText}` });
}

function networkError(): ProviderError {
	return new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
}

function headersFor(token: string | null, hasBody: boolean): Record<string, string> {
	const headers: Record<string, string> = { [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE };
	if (hasBody) headers['Content-Type'] = 'application/json';
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

export interface HttpDataProviderOptions {
	/** Prefixed to every request path, e.g. `http://192.168.1.5:8721`. Defaults to `''` (same-origin). */
	baseUrl?: string;
	/** Shares the bearer token with whichever `AuthProvider` logged in (typically `createHttpAuthProvider`'s `getToken`). */
	getToken: () => string | null;
	fetchFn?: typeof fetch;
}

interface RequestInit {
	method: string;
	body?: unknown;
	/** `deleteOne` expects `204 No Content`: skip `response.json()` and resolve `undefined`. */
	expectNoContent?: boolean;
}

/** `DataProvider` backed by `fetch()` against the embedded REST server (spec §11.1). */
export function createHttpDataProvider(options: HttpDataProviderOptions): DataProvider {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;

	async function request<T>(path: string, init: RequestInit): Promise<T> {
		const hasBody = init.body !== undefined;
		let response: Response;
		try {
			response = await fetchFn(`${baseUrl}${path}`, {
				method: init.method,
				headers: headersFor(options.getToken(), hasBody),
				body: hasBody ? JSON.stringify(init.body) : undefined
			});
		} catch {
			throw networkError();
		}
		if (!response.ok) throw await errorFromResponse(response);
		if (init.expectNoContent) return undefined as T;
		return (await response.json()) as T;
	}

	return {
		getList<T>(resource: string, params: ListParams): Promise<ListResult<T>> {
			return request<ListResult<T>>(`/api/${resource}/list`, { method: 'POST', body: params });
		},

		getOne<T>(resource: string, id: string | number): Promise<T> {
			return request<T>(`/api/${resource}/${id}`, { method: 'GET' });
		},

		create<T>(resource: string, values: Record<string, unknown>): Promise<T> {
			return request<T>(`/api/${resource}`, { method: 'POST', body: values });
		},

		update<T>(resource: string, id: string | number, values: Record<string, unknown>): Promise<T> {
			return request<T>(`/api/${resource}/${id}`, { method: 'PUT', body: values });
		},

		deleteOne(resource: string, id: string | number): Promise<void> {
			return request<void>(`/api/${resource}/${id}`, { method: 'DELETE', expectNoContent: true });
		}
	};
}

export interface HttpAuthProviderOptions {
	baseUrl?: string;
	fetchFn?: typeof fetch;
	/** sessionStorage key the bearer token is kept under. Default `'banto.auth.token'`. */
	storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'banto.auth.token';

/**
 * `AuthProvider` backed by `fetch()` against `/api/auth/*` (spec §11.1/
 * §11.2). The bearer token returned by a successful login is kept in
 * `sessionStorage` (cleared on logout, and on a `401` from `check()` -
 * a stale/expired token should not keep failing silently forever). The
 * returned object exposes `getToken()` beyond the plain `AuthProvider`
 * interface so `createHttpDataProvider`/`createSseEventProvider` can share
 * the same token without a second source of truth.
 */
export function createHttpAuthProvider(
	options: HttpAuthProviderOptions = {}
): AuthProvider & { getToken(): string | null } {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;
	const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;

	function getToken(): string | null {
		return sessionStorage.getItem(storageKey);
	}

	function setToken(token: string | null): void {
		if (token) sessionStorage.setItem(storageKey, token);
		else sessionStorage.removeItem(storageKey);
	}

	function headers(hasBody: boolean): Record<string, string> {
		return headersFor(getToken(), hasBody);
	}

	return {
		async login(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/login`, {
					method: 'POST',
					headers: headers(true),
					body: JSON.stringify(params)
				});
			} catch {
				return { success: false, error: NETWORK_ERROR_MESSAGE };
			}
			if (!response.ok) {
				const err = await errorFromResponse(response);
				return { success: false, error: err.message };
			}
			const body = (await response.json()) as { success: boolean; error?: string; token?: string };
			if (body.success && body.token) setToken(body.token);
			return { success: body.success, error: body.error };
		},

		async logout(): Promise<void> {
			try {
				await fetchFn(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: headers(false) });
			} catch {
				// Network failure on logout still clears the local token below -
				// the goal is "this client no longer considers itself logged in".
			}
			setToken(null);
		},

		async check(): Promise<boolean> {
			const token = getToken();
			if (!token) return false;
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/check`, { method: 'GET', headers: headers(false) });
			} catch {
				return false;
			}
			if (response.status === 401) {
				setToken(null);
				return false;
			}
			if (!response.ok) return false;
			return (await response.json()) as boolean;
		},

		async getIdentity(): Promise<Identity | null> {
			const token = getToken();
			if (!token) return null;
			let response: Response;
			try {
				response = await fetchFn(`${baseUrl}/api/auth/identity`, { method: 'GET', headers: headers(false) });
			} catch {
				return null;
			}
			if (!response.ok) return null;
			return (await response.json()) as Identity | null;
		},

		getToken
	};
}
