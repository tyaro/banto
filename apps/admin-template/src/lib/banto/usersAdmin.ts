/**
 * Client for the `admin`-only user-management API (spec M10 RBAC). Same
 * split as serverAdmin.ts: Tauri webview calls `invoke()` directly (the
 * `users_*` commands, `apps/admin-template/src-tauri/src/lib.rs`), a LAN
 * browser client served by the embedded server calls `fetch()` against
 * `/api/users/*` (`apps/admin-template/core/src/rest.rs`), reusing the same
 * bearer-token/CSRF-header mechanism `@banto/admin-core`'s
 * `createHttpDataProvider`/`createHttpAuthProvider` use.
 *
 * Deliberately NOT built on `@banto/admin-core`'s generic
 * `DataProvider`/`getDataProvider()` (unlike items): the wire shapes here
 * don't fit that resource-CRUD convention -
 * `users_create`/`users_update`/`users_reset_password` take individual named
 * arguments rather than a `values` bag, `users_list` takes no `ListParams`,
 * and the REST routes are plain `/api/users[...]`, not
 * `/api/{resource}/list`. A small dedicated client mirroring
 * providers/tauri.ts + providers/http.ts's error handling is simpler and
 * clearer than bending the generic contract to fit.
 *
 * Plain `vite dev`/`vite preview` (spec §11.1's third environment, no Rust
 * backend at all): there is no account database to manage, so every export
 * here throws/rejects with a `ProviderError` carrying `DEMO_MODE_MESSAGE`;
 * `isUsersAdminAvailable()` lets the users page check this up front instead
 * of always trying and catching.
 */
import { invoke } from '@tauri-apps/api/core';
import { getAuthProvider, isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';
import { CSRF_HEADER, getBantoMode } from './setup';

export type Role = 'admin' | 'editor' | 'viewer';

/**
 * The per-user permission types (Issue #697) live in `authAdmin.ts`, which
 * every scaffold preset keeps (display drops this file); re-exported here so
 * the users screen imports them from one place.
 */
import type { PermissionEntry, UserPermission } from './authAdmin';
export type { PermissionEntry, UserPermission } from './authAdmin';

/** Mirrors `admin_template_core::users::UserKind` (`users.kind`). */
export type UserKind = 'account' | 'builtin';

/** Mirrors `admin_template_core::users::UserSummary` (camelCase on the wire). */
export interface UserSummary {
	id: number;
	username: string;
	displayName: string;
	role: Role;
	/**
	 * `'builtin'` for the one built-in `admin` row (ADR-0034 §2): read-only, it
	 * cannot log in, be edited or be deleted (the server refuses either way).
	 * Decide by this, never by the username.
	 */
	kind: UserKind;
	createdAt: string;
	/** Optimistic-lock version (Issue #651); send back the one read when the form opened. */
	version: number;
	/**
	 * The permissions stored for the account (Issue #697), sorted - including
	 * keys the app no longer registers (show those as unregistered).
	 */
	permissions: UserPermission[];
}

/** Mirrors `users_create`'s `UserIdentityView` (Tauri and REST alike) - no `createdAt` (see its doc comment). */
export interface CreatedUser {
	id: number;
	username: string;
	displayName: string;
	role: Role;
}

export interface CreateUserInput {
	username: string;
	password: string;
	displayName: string;
	role: Role;
}

export interface UpdateUserInput {
	displayName: string;
	role: Role;
	/** The `UserSummary.version` the form was opened with (Issue #651). Omitted -> overwrite as before. */
	version?: number;
	/**
	 * The permissions to store for the account (Issue #697): the complete set,
	 * not a diff. Omitted -> unchanged (REST leaves the field out, Tauri sends
	 * `null`), so an older caller keeps working. A key the app does not
	 * register is a `validation` error; the same `version` guards it.
	 */
	permissions?: UserPermission[];
}

export const DEMO_MODE_MESSAGE = 'デモモードでは利用できません';

function demoModeError(): ProviderError {
	return new ProviderError({ kind: 'other', message: DEMO_MODE_MESSAGE });
}

/** Is this environment backed by a real account database (Tauri or the embedded server)? False in plain-browser demo mode. */
export function isUsersAdminAvailable(): boolean {
	return getBantoMode() !== 'demo';
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
	if (isProviderError(err)) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	try {
		return (await invoke(cmd, args)) as T;
	} catch (err) {
		throw toProviderError(err);
	}
}

const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

interface HttpInit {
	method: string;
	body?: unknown;
	/** `reset-password` returns `200 {success}`, `delete` returns `204` - both callers that don't need the body pass this. */
	expectNoContent?: boolean;
}

/** Bearer token shared with whichever `AuthProvider` is active - only `createHttpAuthProvider`'s result exposes `getToken()` (spec §11.1); other providers have none, which is fine (`getBantoMode() === 'server'` is only true when it's the http provider). */
function currentToken(): string | null {
	const auth = getAuthProvider() as { getToken?: () => string | null };
	return auth.getToken ? auth.getToken() : null;
}

async function httpRequest<T>(path: string, init: HttpInit): Promise<T> {
	const hasBody = init.body !== undefined;
	const headers: Record<string, string> = { ...CSRF_HEADER };
	if (hasBody) headers['Content-Type'] = 'application/json';
	const token = currentToken();
	if (token) headers.Authorization = `Bearer ${token}`;

	let response: Response;
	try {
		response = await fetch(path, {
			method: init.method,
			headers,
			body: hasBody ? JSON.stringify(init.body) : undefined
		});
	} catch {
		throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
	}

	if (!response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new ProviderError({
				kind: 'other',
				message: `${response.status} ${response.statusText}`
			});
		}
		if (isErrorBody(body)) throw new ProviderError(body);
		throw new ProviderError({
			kind: 'other',
			message: `${response.status} ${response.statusText}`
		});
	}

	if (init.expectNoContent) return undefined as T;
	return (await response.json()) as T;
}

export async function listUsers(): Promise<UserSummary[]> {
	if (!isUsersAdminAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<UserSummary[]>('users_list');
	return httpRequest<UserSummary[]>('/api/users', { method: 'GET' });
}

export async function createUser(input: CreateUserInput): Promise<CreatedUser> {
	if (!isUsersAdminAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<CreatedUser>('users_create', {
			username: input.username,
			password: input.password,
			displayName: input.displayName,
			role: input.role
		});
	}
	return httpRequest<CreatedUser>('/api/users', { method: 'POST', body: input });
}

export async function updateUser(id: number, input: UpdateUserInput): Promise<UserSummary> {
	if (!isUsersAdminAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<UserSummary>('users_update', {
			id,
			displayName: input.displayName,
			role: input.role,
			version: input.version ?? null,
			permissions: input.permissions ?? null
		});
	}
	return httpRequest<UserSummary>(`/api/users/${id}`, { method: 'PUT', body: input });
}

/**
 * The permissions the app registered (Issue #697; REST `GET /api/permissions`,
 * Tauri `permissions_catalog`), in registration order. Empty for the
 * template itself - the users screen then shows no permission field at all.
 */
export async function listPermissionCatalog(): Promise<PermissionEntry[]> {
	if (!isUsersAdminAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<PermissionEntry[]>('permissions_catalog');
	return httpRequest<PermissionEntry[]>('/api/permissions', { method: 'GET' });
}

export async function resetUserPassword(id: number, newPassword: string): Promise<void> {
	if (!isUsersAdminAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		await invokeCommand<void>('users_reset_password', { id, newPassword });
		return;
	}
	// REST responds `200 {success}` (rest.rs's ResetPasswordResponse), not
	// 204 - but the body carries no information this client needs beyond
	// "the request succeeded", which a non-2xx status already rules out.
	await httpRequest<{ success: boolean }>(`/api/users/${id}/reset-password`, {
		method: 'POST',
		body: { newPassword }
	});
}

/** `version` (Issue #651): the version the row had when it was last read; a stale one is a `conflict` ProviderError and nothing is deleted. */
export async function deleteUser(id: number, version?: number): Promise<void> {
	if (!isUsersAdminAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		await invokeCommand<void>('users_delete', { id, version: version ?? null });
		return;
	}
	const query = version === undefined ? '' : `?version=${encodeURIComponent(String(version))}`;
	await httpRequest<void>(`/api/users/${id}${query}`, {
		method: 'DELETE',
		expectNoContent: true
	});
}

/**
 * Issue #651: after our own save succeeded, may the open form's base version
 * advance to the saved version? Only when the form is still on the same user,
 * was opened from exactly the version we sent, and nothing was written in
 * between (saved === sent + 1). Otherwise the base is left alone.
 */
export function shouldAdvanceEditVersion(args: {
	selectedId: number | null | undefined;
	targetId: number;
	editVersion: number;
	sentVersion: number;
	savedVersion: number;
}): boolean {
	return (
		args.selectedId === args.targetId &&
		args.editVersion === args.sentVersion &&
		args.savedVersion === args.sentVersion + 1
	);
}

/** One checkbox row of the permission field. */
export interface PermissionRow {
	key: UserPermission;
	/** Display name: the app's message for the entry's `labelKey`, else the key itself. */
	label: string;
	/** Description from the entry's `descriptionKey`; `null` when the app has no such message. */
	description: string | null;
	/** `false`: the account holds this key but the app no longer registers it. */
	registered: boolean;
}

/**
 * Look up an app-registered message key. `source` is the Paraglide `messages`
 * namespace (injected so this stays testable); a key it does not have - or
 * one that throws - gives `null`, never the key's own text.
 */
export function lookupMessage(source: Record<string, unknown>, key: string): string | null {
	const candidate = Object.hasOwn(source, key) ? source[key] : undefined;
	if (typeof candidate !== 'function') return null;
	try {
		const text: unknown = (candidate as () => unknown)();
		return typeof text === 'string' && text !== '' ? text : null;
	} catch {
		return null;
	}
}

/**
 * The rows of the permission field: every catalog entry (registration order),
 * then the keys the account holds (`held`: the server's state, NOT the draft,
 * so unchecking one does not make its row vanish under the cursor) that the
 * catalog no longer lists, sorted, marked unregistered.
 */
export function permissionRows(
	catalog: readonly PermissionEntry[],
	held: readonly UserPermission[],
	messages: Record<string, unknown>
): PermissionRow[] {
	const registered = new Set(catalog.map((entry) => entry.key));
	const rows: PermissionRow[] = catalog.map((entry) => ({
		key: entry.key,
		label: lookupMessage(messages, entry.labelKey) ?? entry.key,
		description: lookupMessage(messages, entry.descriptionKey),
		registered: true
	}));
	for (const key of [...new Set(held)].sort()) {
		if (!registered.has(key)) rows.push({ key, label: key, description: null, registered: false });
	}
	return rows;
}

/** `draft` with `key` checked or unchecked: sorted, no duplicates, a new array. */
export function withPermission(
	draft: readonly UserPermission[],
	key: UserPermission,
	checked: boolean
): UserPermission[] {
	const next = new Set(draft);
	if (checked) next.add(key);
	else next.delete(key);
	return [...next].sort();
}

/**
 * Replay the changes `draft` made against `oldBase` on top of `newBase`
 * (sorted, no duplicates): keys checked in the draft but not in `oldBase` are
 * added, keys `oldBase` had but the draft unchecked are removed, everything
 * else follows `newBase`. Used when the base moves under an open form (our
 * own save finished after the user reselected the account), so the next
 * complete-set save keeps both.
 */
export function rebasePermissions(
	draft: readonly UserPermission[],
	oldBase: readonly UserPermission[],
	newBase: readonly UserPermission[]
): UserPermission[] {
	const before = new Set(oldBase);
	const after = new Set(draft);
	const next = new Set(newBase);
	for (const key of after) if (!before.has(key)) next.add(key);
	for (const key of before) if (!after.has(key)) next.delete(key);
	return [...next].sort();
}

/** Same set of keys, whatever the order. */
export function samePermissions(
	a: readonly UserPermission[],
	b: readonly UserPermission[]
): boolean {
	const left = new Set(a);
	const right = new Set(b);
	return left.size === right.size && [...left].every((key) => right.has(key));
}

/**
 * The `permissions` to send on save: the draft when it differs from what the
 * form was opened with (`base`), otherwise `undefined` so the server leaves
 * them alone. `draft === null` means the form has no trustworthy copy (after
 * a conflict, until the list is re-read) - nothing is sent, so a stale choice
 * can never overwrite someone else's change.
 */
export function permissionsToSend(
	draft: readonly UserPermission[] | null,
	base: readonly UserPermission[]
): UserPermission[] | undefined {
	if (draft === null || samePermissions(draft, base)) return undefined;
	return [...new Set(draft)].sort();
}
