/**
 * `TauriDataProvider`/`TauriAuthProvider` (spec §3.2, §3.3, §10): map
 * `DataProvider`/`AuthProvider` calls onto Tauri `invoke()` using the
 * command naming convention `${resource}_list` / `_get` / `_create` /
 * `_update` / `_delete`, and `auth_login` / `auth_logout` / `auth_check` /
 * `auth_identity` for auth.
 *
 * No dependency on `@tauri-apps/api` here — the app injects its own
 * `invoke` function, so this module (and its tests) work without a Tauri
 * runtime present. Errors thrown by a Tauri command arrive as the
 * serialized `ErrorBody` shape (`crates/banto-core/src/error.rs`'s
 * `ErrorBody`, `Serialize`d directly since Tauri rejects with whatever
 * value the command's `Err` carries); these are rethrown as
 * `ProviderError` so callers only ever deal with one error shape,
 * regardless of which `DataProvider` implementation is active.
 */
import type { AuthProvider, DataProvider, Identity } from '../provider';
import type { ListParams, ListResult } from '../types';
import { ProviderError, type ErrorBody } from '../errors';

export interface TauriInvokeOptions {
	/** Injected so this module has no `@tauri-apps/api` dependency of its own. */
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'unauthorized',
	'forbidden',
	'storage',
	'other'
]);

/** Type guard: does `value` look like a wire `ErrorBody` (spec §3.2/§10)? */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

/** Normalize anything a rejected `invoke()` might throw into a `ProviderError`. */
function toProviderError(err: unknown): ProviderError {
	if (err instanceof ProviderError) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

/**
 * `auth_setup`/`auth_change_password` reject with `BantoError::Validation`
 * (spec §8.2) when the backend rejects a field (short password, wrong
 * current password, ...); `setup`/`changePassword` below surface the FIRST
 * field error's message as a plain `{ success: false, error }` result
 * (rather than rethrowing) so the login/settings forms can show it without
 * a try/catch of their own - other error kinds still rethrow, since those
 * are unexpected failures, not "form said no".
 */
function firstValidationMessage(err: ProviderError): string {
	if (err.body.kind === 'validation' && err.body.field_errors.length > 0) {
		return err.body.field_errors[0].message;
	}
	return err.message;
}

function makeCaller(invoke: TauriInvokeOptions['invoke']) {
	return async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		try {
			return (await invoke(cmd, args)) as T;
		} catch (err) {
			throw toProviderError(err);
		}
	};
}

/**
 * Standard `DataProvider` for the Tauri webview (spec §3.2): commands
 * follow the `${resource}_list` / `_get` / `_create` / `_update` / `_delete`
 * naming convention. Tauri v2 auto-converts JS camelCase invoke args to
 * snake_case Rust parameter names, so arg keys here are chosen to match
 * both sides without any conversion needed (`params`, `id`, `values`).
 */
export function createTauriDataProvider(options: TauriInvokeOptions): DataProvider {
	const call = makeCaller(options.invoke);

	return {
		getList<T>(resource: string, params: ListParams): Promise<ListResult<T>> {
			return call<ListResult<T>>(`${resource}_list`, { params });
		},

		getOne<T>(resource: string, id: string | number): Promise<T> {
			return call<T>(`${resource}_get`, { id });
		},

		create<T>(resource: string, values: Record<string, unknown>): Promise<T> {
			return call<T>(`${resource}_create`, { values });
		},

		update<T>(resource: string, id: string | number, values: Record<string, unknown>): Promise<T> {
			return call<T>(`${resource}_update`, { id, values });
		},

		deleteOne(resource: string, id: string | number): Promise<void> {
			return call<void>(`${resource}_delete`, { id });
		}
	};
}

/**
 * Standard `AuthProvider` for the Tauri webview (spec §3.3), backed by the
 * `auth_login` / `auth_logout` / `auth_check` / `auth_identity` /
 * `auth_status` / `auth_setup` / `auth_change_password` commands (spec §8.2).
 */
export function createTauriAuthProvider(options: TauriInvokeOptions): AuthProvider {
	const call = makeCaller(options.invoke);

	return {
		async login(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
			return call<{ success: boolean; error?: string }>('auth_login', params);
		},

		async logout(): Promise<void> {
			await call<void>('auth_logout');
		},

		async check(): Promise<boolean> {
			return call<boolean>('auth_check');
		},

		async getIdentity(): Promise<Identity | null> {
			const identity = await call<Identity | null>('auth_identity');
			return identity ?? null;
		},

		async status(): Promise<{ initialized: boolean }> {
			return call<{ initialized: boolean }>('auth_status');
		},

		async setup(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
			try {
				return await call<{ success: boolean; error?: string }>('auth_setup', params);
			} catch (err) {
				return { success: false, error: firstValidationMessage(toProviderError(err)) };
			}
		},

		async changePassword(
			current: string,
			next: string
		): Promise<{ success: boolean; error?: string }> {
			try {
				await call<void>('auth_change_password', { currentPassword: current, newPassword: next });
				return { success: true };
			} catch (err) {
				return { success: false, error: firstValidationMessage(toProviderError(err)) };
			}
		}
	};
}
