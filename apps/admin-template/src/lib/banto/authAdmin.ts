/**
 * Thin wrapper around the src-tauri auth-mode commands (spec M11: login-not-
 * required mode + desktop autologin). Every export here only makes sense
 * inside the Tauri webview - callers must guard with `isTauri()` (setup.ts)
 * first, same as `serverAdmin.ts`'s embedded-server controls (spec §11.4):
 * a LAN browser client/the plain-browser demo have no desktop process of
 * their own to configure autologin or a windowless "trust this device" mode
 * for, so those environments get a fixed "デスクトップアプリでのみ変更でき
 * ます" note instead of calling any of these.
 *
 * Unlike `serverAdmin.ts`, rejections here are normalized to `ProviderError`
 * (same convention as `providers/tauri.ts`/`usersAdmin.ts`) rather than left
 * as the raw `ErrorBody`-shaped value a Tauri command rejects with - the
 * settings page needs `err.message` to be the exact Japanese string the
 * exclusivity guards (`auth_config_apply`/`server_apply`'s Rust-side checks)
 * produce, e.g. "認証無効モード中はLANアクセスを有効化できません", so it can
 * be shown in a toast as-is.
 */
import { invoke } from '@tauri-apps/api/core';
import { isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';
import type { Role } from '../permissions';

/**
 * A per-user permission key (Issue #697, user-permissions-plan §8-1), e.g.
 * `equipment.operate`: a second axis next to the role, granted by an admin.
 * Named `UserPermission` so it is not mistaken for the resource-operation
 * `ResourcePermissions` (`lib/resource/permissions.ts`). The server decides;
 * the screen only hides what the session cannot do.
 *
 * The single definition: here, not in `usersAdmin.ts`, because the display
 * preset removes that file while this one stays (`usersAdmin.ts` re-exports it).
 */
export type UserPermission = string;

/** Mirrors `banto_admin_services::permissions::PermissionEntry`: one permission the app registered (`GET /api/permissions` / `permissions_catalog`). */
export interface PermissionEntry {
	key: UserPermission;
	/** Message key of the display name (the app's own messages). */
	labelKey: string;
	/** Message key of the description. */
	descriptionKey: string;
}

/** Mirrors src-tauri's `AuthSettings` (camelCase on the wire, spec M11). */
export interface AuthSettings {
	disabled: boolean;
	disabledRole: Role;
	autologinEnabled: boolean;
	autologinUsername: string | null;
	/**
	 * The permissions login-not-required mode's session holds (Issue #697),
	 * sorted, only keys the app registers. Empty for the template (it
	 * registers none).
	 */
	disabledPermissions: UserPermission[];
	/**
	 * Whether an administrator account that can log in exists (ADR-0034 §6).
	 * Requiring a login (`disabled: false`) is refused without one, so the
	 * settings screen says why and points at user management instead of
	 * letting the save fail.
	 */
	hasAdminAccount: boolean;
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

/** Same type guard as providers/tauri.ts / usersAdmin.ts (spec §10/§11.1). */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

function toProviderError(err: unknown): ProviderError {
	if (isProviderError(err)) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	try {
		return (await invoke(cmd, args)) as T;
	} catch (err) {
		throw toProviderError(err);
	}
}

/** Current auth-mode settings. Any authenticated role may call this (it only feeds a settings-screen display). */
export function getAuthSettings(): Promise<AuthSettings> {
	return call<AuthSettings>('auth_config_get');
}

/**
 * Toggle login-not-required mode and its synthetic-identity role. `admin`-only, EXCEPT while the mode is currently on (escape hatch - see `auth_config_apply`'s Rust doc comment).
 *
 * `permissions` (Issue #697) = the keys that mode's session holds. Omit it to leave them as they are: the command then gets no `permissions` argument at all. A key the app did not register is a `validation` error and nothing is saved.
 */
export function applyAuthSettings(
	disabled: boolean,
	disabledRole: Role,
	permissions?: UserPermission[]
): Promise<AuthSettings> {
	return call<AuthSettings>('auth_config_apply', {
		disabled,
		disabledRole,
		...(permissions === undefined ? {} : { permissions })
	});
}

/** The permissions the app registered (`permissions_catalog`; `admin`-only, empty for the template). Empty = the permissions field is not shown. */
export function getPermissionCatalog(): Promise<PermissionEntry[]> {
	return call<PermissionEntry[]>('permissions_catalog');
}

/** Enable desktop autologin for `username`/`password` (verified against the real account store first - a bad credential surfaces as a `ProviderError` with `kind: 'validation'`). `admin`-only. */
export function enableAutologin(username: string, password: string): Promise<void> {
	return call<void>('autologin_enable', { username, password });
}

/** Disable desktop autologin and remove its stored credential from the OS keyring. `admin`-only. */
export function disableAutologin(): Promise<void> {
	return call<void>('autologin_disable');
}
