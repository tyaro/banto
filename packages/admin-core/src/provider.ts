/**
 * DataProvider/AuthProvider/Notifier contracts (spec §3.2, §3.3, §3.4).
 * UI-agnostic: no Svelte imports here.
 */
import type { ListParams, ListResult } from './types';

/** Backend-agnostic CRUD abstraction. Implementations throw `ProviderError`. */
export interface DataProvider {
	getList<T>(resource: string, params: ListParams): Promise<ListResult<T>>;
	getOne<T>(resource: string, id: string | number): Promise<T>;
	create<T>(resource: string, values: Record<string, unknown>): Promise<T>;
	update<T>(resource: string, id: string | number, values: Record<string, unknown>): Promise<T>;
	deleteOne(resource: string, id: string | number): Promise<void>;
}

export interface Identity {
	id: string;
	name: string;
	/**
	 * Spec M10 RBAC: the account's role (`'admin' | 'editor' | 'viewer'`,
	 * lowercase, matching `admin_template_core::users::Role::as_str`/the
	 * Tauri `Identity`/REST `/api/auth/identity` wire shape). Optional here
	 * so this generic contract stays usable by an `AuthProvider` that has no
	 * concept of roles at all — callers that care (this app's
	 * `$lib/permissions.ts`) must treat a missing/unrecognized value as the
	 * least-privileged role (fail closed), not assume it is always present.
	 */
	role?: string;
}

/** Authentication abstraction used by the route guard and login page. */
export interface AuthProvider {
	login(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
	logout(): Promise<void>;
	check(): Promise<boolean>;
	getIdentity(): Promise<Identity | null>;

	/**
	 * Has an account been created yet (spec §3.3/§8.2)? Optional so
	 * pre-existing `AuthProvider` implementations stay valid: the login page
	 * only calls this via `authProvider.status?.()` and falls back to the
	 * normal login form when it is absent (or resolves `{ initialized: true }`).
	 */
	status?(): Promise<{ initialized: boolean }>;

	/**
	 * Create the first account and log in as it (spec §8.2's first-run
	 * setup). `params` is whatever shape the concrete provider's backend
	 * expects (username/password/displayName for the built-in providers).
	 */
	setup?(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;

	/** Change the current session's password. */
	changePassword?(current: string, next: string): Promise<{ success: boolean; error?: string }>;
}

export type NotificationKind = 'success' | 'error' | 'info';

/** Toast/notification sink, wired by the app (e.g. to a toast store). */
export interface Notifier {
	notify(kind: NotificationKind, message: string): void;
}
