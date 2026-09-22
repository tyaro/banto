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
	/**
	 * Synthetic LAN viewer session marker (viewer-public-plan §3.1-6).
	 * Supplied by the session issuer, never inferred from an account id or
	 * role: a real account can also have the username `public`. Missing is
	 * false for providers that do not implement public-viewer sessions.
	 */
	publicViewer?: boolean;
}

/**
 * Fixed `id` of the synthetic viewer identity issued by
 * `AuthProvider.enterPublicViewer()` (viewer-public-plan §2.2/§3.1-6,
 * ADR-0012): `POST /api/auth/public-viewer` mints a token bound to
 * `{ id: "public", name: "public", role: "viewer" }`.
 * This is a display/audit identifier, not a session discriminator: real
 * account identities use usernames and can have the same id. Use the
 * issuer-provided `Identity.publicViewer` marker to distinguish sessions.
 */
export const PUBLIC_VIEWER_ID = 'public';

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
	 *
	 * `viewerPublic` (viewer-public-plan §3.1-2/-6, ADR-0012) reports whether
	 * `server.viewerPublic` is ON - i.e. whether `enterPublicViewer()` below
	 * can currently succeed. Optional/possibly-absent for the same backward-
	 * compatibility reason as `initialized`: an older backend's
	 * `/api/auth/status` response has no such field, and a caller must treat
	 * a missing value as `false` (fail closed - no public viewer entry).
	 */
	status?(): Promise<{ initialized: boolean; viewerPublic?: boolean }>;

	/**
	 * Create the first account and log in as it (spec §8.2's first-run
	 * setup). `params` is whatever shape the concrete provider's backend
	 * expects (username/password/displayName for the built-in providers).
	 */
	setup?(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;

	/** Change the current session's password. */
	changePassword?(current: string, next: string): Promise<{ success: boolean; error?: string }>;

	/**
	 * Mint the synthetic `{ id: PUBLIC_VIEWER_ID, role: 'viewer' }` session
	 * used by LAN "viewer-public" access (viewer-public-plan §2.1-2.2,
	 * ADR-0012): no credentials, no bearer token required on the request.
	 * Resolves `true` and leaves the provider logged in as that identity on
	 * success; resolves `false` on any failure (403 when
	 * `server.viewerPublic` is OFF, or a network error) without throwing -
	 * callers (the `(app)` route guard) fall back to the normal `/login`
	 * redirect in that case.
	 *
	 * Optional and implemented ONLY by the HTTP provider
	 * (`createHttpAuthProvider`): the Tauri window has no LAN-facing surface
	 * for this (M11's desktop synthetic session already covers "no login in
	 * this window"), and the plain-browser demo provider has no backend to
	 * call. Both leave this undefined = unsupported, same convention as
	 * `setup`/`changePassword` being absent on a provider that doesn't need
	 * them.
	 */
	enterPublicViewer?(): Promise<boolean>;
}

export type NotificationKind = 'success' | 'error' | 'info' | 'warning';

/**
 * Toast/notification sink, wired by the app (e.g. to a toast store). The app
 * calls `notify(kind, message)` directly for in-tab toasts; a server can also
 * push a toast to every connected client by broadcasting a
 * `ServerEvent::Notice { level, message }` (see `connectEvents`, which bridges
 * `notice` -> `notify`). `level` maps to `NotificationKind` when it is one of
 * the four kinds, else falls back to `'info'`.
 */
export interface Notifier {
	notify(kind: NotificationKind, message: string): void;
}
