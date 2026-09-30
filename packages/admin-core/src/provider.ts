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

/**
 * Which credential an `AuthProvider` answer is about (Issue #260,
 * docs/session-controller-design.md §5.2, I-23). OPAQUE: compare two values
 * with `===` only - never parse, order or do arithmetic on them. A provider
 * builds it from its own internal counters (HTTP: a counter of its own token
 * writes and cross-tab `storage` events; Tauri: the max `seq` observed from
 * the Rust session slot plus a local counter).
 */
export type CredentialRevision = string & { readonly __brand: 'CredentialRevision' };

/**
 * The kind of a session (design §5.1). `'local'` is the Tauri
 * auth-disabled mode's synthetic session; apps may add their own kinds.
 */
export type SessionKind = 'account' | 'publicViewer' | 'local' | (string & {});

/**
 * One round-trip answer about the current session (`AuthProvider.resolve`,
 * design §2.1/§5.2):
 * - `checked`: the revision read on entry - the credential this answer
 *   validated;
 * - `current`: the revision after this call's OWN clearing of a revoked
 *   credential (equal to `checked` when it cleared nothing). So
 *   `current !== checked` iff this call cleared the credential it checked.
 */
export type ResolvedAuth =
	| { status: 'none'; checked: CredentialRevision; current: CredentialRevision }
	| {
			status: 'active';
			checked: CredentialRevision;
			current: CredentialRevision;
			identity: Identity;
			kind?: SessionKind;
	  };

/** Result of `login`/`setup`. `superseded` (Issue #260): see `AuthProvider.login`. */
export interface AuthOperationResult {
	success: boolean;
	error?: string;
	/**
	 * The credentials were accepted, but the credential this operation
	 * started from was replaced before it could store its own (another
	 * login/logout finished first, here or in another tab). Nothing was
	 * stored; `success` is `false`. Absent means `false`.
	 */
	superseded?: boolean;
}

/** Authentication abstraction used by the route guard and login page. */
export interface AuthProvider {
	/**
	 * Log in. Issue #260 (#259, I-7): a provider that tracks a
	 * `credentialRevision` stores the new credential only if the revision is
	 * still the one read when this call started; otherwise it stores nothing
	 * and resolves `{ success: false, superseded: true }`.
	 */
	login(params: Record<string, unknown>): Promise<AuthOperationResult>;
	logout(): Promise<void>;
	/**
	 * Is the current session valid? Resolves `false` ONLY when that is
	 * established (no session, or the backend answered "not valid" / `401`).
	 * Rejects (with a `ProviderError`) when validity could not be determined -
	 * the backend failed to check the account (Issue #204: a DB error is a
	 * `500`, not a revocation) or could not be reached. Callers must not treat
	 * a rejection as "logged out": the session and its stored token are kept
	 * (see `resolveProtectedSession`).
	 */
	check(): Promise<boolean>;
	/**
	 * Who the current session belongs to. Resolves `null` ONLY when that is
	 * established: there is no session (no token, or the backend answered
	 * `401`), or the provider has no notion of identity at all. Rejects
	 * (with a `ProviderError`) when the identity could not be fetched - the
	 * backend failed (`500`) or could not be reached - the same split as
	 * `check()` (Issue #215/#255 6th review). Callers must not treat a
	 * rejection as "nobody": `establishSession` leaves the session scope and
	 * the saved list view state untouched and the route guard shows its
	 * retryable error page.
	 */
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
	setup?(params: Record<string, unknown>): Promise<AuthOperationResult>;

	/** Change the current session's password. */
	changePassword?(current: string, next: string): Promise<{ success: boolean; error?: string }>;

	/**
	 * Mint the synthetic `{ id: PUBLIC_VIEWER_ID, role: 'viewer' }` session
	 * used by LAN "viewer-public" access (viewer-public-plan §2.1-2.2,
	 * ADR-0012): no credentials, no bearer token required on the request.
	 * Resolves `{ success: true }` and leaves the provider logged in as that
	 * identity on success; resolves `{ success: false }` on any failure (403
	 * when `server.viewerPublic` is OFF, or a network error) without
	 * throwing - callers (the `(app)` route guard) fall back to the normal
	 * `/login` redirect in that case.
	 *
	 * Issue #260 (#259, design §5.2, S-20/S-52): the minted token is stored
	 * only while the credential revision is still `options.expectRevision`
	 * (default: the revision when this call started). Otherwise nothing is
	 * stored and it resolves `{ success: false, superseded: true }` - another
	 * session was established meanwhile; the caller must re-check it rather
	 * than fall back to `/login`.
	 *
	 * Optional and implemented ONLY by the HTTP provider
	 * (`createHttpAuthProvider`): the Tauri window has no LAN-facing surface
	 * for this (M11's desktop synthetic session already covers "no login in
	 * this window"), and the plain-browser demo provider has no backend to
	 * call. Both leave this undefined = unsupported, same convention as
	 * `setup`/`changePassword` being absent on a provider that doesn't need
	 * them.
	 */
	enterPublicViewer?(options?: {
		expectRevision?: CredentialRevision;
	}): Promise<{ success: boolean; superseded?: boolean }>;

	/**
	 * Issue #260 (design §2.1/§5.2): the current session in ONE round trip,
	 * tagged with which credential it is about. Resolves
	 * `{ status: 'none' }` only when that is established (no credential, or
	 * the backend confirmed it invalid - revoked, role changed, ...) and
	 * `{ status: 'active', identity }` for a valid one. REJECTS when the
	 * backend could not answer (a `500`, unreachable, a malformed answer) -
	 * with `StaleAnswerError` when the answer is about a credential that
	 * changed while it was in flight (a state-changing operation was still
	 * pending when it arrived, or the backend reported it stale).
	 *
	 * A `none` for a credential that was sent clears that credential with
	 * compare-and-set; the clear is NOT reported through
	 * `onCredentialChanged` but carried in the answer (`current !== checked`).
	 * A rejection never advances the revision (I-19). `signal` is the
	 * caller's per-request abort (a provider that cannot abort may ignore
	 * it).
	 *
	 * Optional in v1.x (Issue #260 実装-1); required together with
	 * `credentialRevision`/`onCredentialChanged` from v2.0.0. Wrap an
	 * implementation without them in `adaptLegacyAuthProvider`.
	 */
	resolve?(options?: { signal?: AbortSignal }): Promise<ResolvedAuth>;

	/**
	 * Issue #260 (I-23): the revision of the credential this provider holds
	 * now. Opaque - compare with `===` only. Never exposes the credential
	 * (token) itself.
	 */
	credentialRevision?(): CredentialRevision;

	/**
	 * Issue #260 (I-19): subscribe to credential changes. Called - only when
	 * the revision actually changed - from the continuation that received a
	 * state-changing operation's response (login/logout/setup/
	 * changePassword/enterPublicViewer), on a cross-tab `storage` change of
	 * the credential, and when a state-changing operation got no response.
	 * NOT called for `resolve()`'s own clearing or for a `resolve()`
	 * rejection. Returns the unsubscribe function.
	 */
	onCredentialChanged?(listener: () => void): () => void;
}

/**
 * The pre-#260 `AuthProvider` shape (no `resolve`/`credentialRevision`/
 * `onCredentialChanged`, `enterPublicViewer` resolving a boolean) - what
 * `adaptLegacyAuthProvider` accepts.
 */
export interface LegacyAuthProvider {
	login(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
	logout(): Promise<void>;
	check(): Promise<boolean>;
	getIdentity(): Promise<Identity | null>;
	status?(): Promise<{ initialized: boolean; viewerPublic?: boolean }>;
	setup?(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
	changePassword?(current: string, next: string): Promise<{ success: boolean; error?: string }>;
	enterPublicViewer?(): Promise<boolean>;
}

/** An `AuthProvider` with the three Issue #260 methods present. */
export type StandardAuthProvider = AuthProvider &
	Required<Pick<AuthProvider, 'resolve' | 'credentialRevision' | 'onCredentialChanged'>>;

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
