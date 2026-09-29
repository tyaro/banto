/**
 * Current session's identity/role (Svelte 5 runes), spec M10 RBAC.
 *
 * Populated once by `routes/(app)/+layout.ts`'s load() - right after its
 * `AuthProvider.check()` guard passes - so every page/component under the
 * `(app)` route group can read `sessionStore.role` reactively without
 * re-fetching identity itself (same "module singleton populated by the app
 * shell" pattern as `$lib/settings.svelte.ts`/`$lib/toast.svelte.ts`).
 *
 * Ordering note: SvelteKit does NOT guarantee a child route's `load()` waits
 * for an ancestor layout's `load()` to finish unless it calls `await
 * parent()` - so `routes/(app)/users/+page.ts` (the only other place that
 * needs `role` before its own `load()` returns) does exactly that rather
 * than reading `sessionStore.role` optimistically. Components that render
 * only after `(app)/+layout.ts` has resolved (Sidebar, page bodies) have no
 * such race - SvelteKit does not mount a route's components until its own
 * load() (and thus this store's `load()` call inside it) has resolved.
 */
import { establishSession, getAuthProvider, type Identity } from '@banto/admin-core';
import { parseRole, type Role } from './permissions';
import { isTauri } from './banto/setup';
import { getAuthSettings } from './banto/authAdmin';

class SessionStore {
	identity: Identity | null = $state(null);
	role: Role = $state('viewer');

	/**
	 * Login-not-required mode (spec M11), read via `auth_config_get`. Always
	 * `false` outside the Tauri webview - that mode is v1-scoped to the
	 * desktop window only (a LAN browser client/the plain-browser demo never
	 * have it on), and a failed read (e.g. an older backend without the
	 * command) fails closed to `false` too, so the UI it gates (hiding the
	 * logout button/password-change section) never disappears based on an
	 * error.
	 */
	authDisabled = $state(false);

	/**
	 * Is this the synthetic LAN "viewer-public" session (viewer-public-plan
	 * §2.2/§3.1-6, ADR-0012)? The issuer explicitly marks synthetic sessions
	 * with `identity.publicViewer`; usernames (including `public`) and roles
	 * cannot distinguish them from ordinary accounts (Issue #209). This is a
	 * session-layer concern (conventions §10: `publicViewer` lives here, not
	 * in the provider layer), consumed by the nav allowlist (`navigation.ts`),
	 * `Header.svelte`'s login button, and `settings/AccountSection.svelte`'s
	 * account-UI guard.
	 */
	publicViewer = $state(false);

	/**
	 * Fetch the current identity and derive `role` from it (fail closed - see
	 * `parseRole`), then `authDisabled` (Tauri only).
	 *
	 * Issue #215/#255: also tells admin-core who this session belongs to
	 * (`establishSession`) - on EVERY guard run, not only after this tab's
	 * own login, because the identity behind the shared "Remember me" token
	 * can change from another tab. Saved list view state is only restored
	 * for the owner confirmed here, and a changed owner starts a new session
	 * generation, which `(app)/+layout.svelte` uses to rebuild the screen.
	 *
	 * 5th review: the identity is applied only if it still answers for the
	 * current session - an answer that arrives after this tab logged out and
	 * in as someone else (whose load already finished) must not move the
	 * session back. `establishSession` discards such an answer; when a newer
	 * load has taken over (`current: false`), this one changes nothing here
	 * either.
	 *
	 * Resolves the generation of the session this load established (`null`
	 * when a newer load superseded it) - what the guard hands to
	 * `(app)/+layout.svelte`'s generation gate.
	 */
	async load(): Promise<number | null> {
		// Applied inside `establishSession`'s own continuation (6th review):
		// no other session can be established between confirming this
		// answer is current and recording it here. A rejection (the identity
		// could not be fetched) propagates and changes nothing - the guard
		// (`(app)/+layout.ts`) shows its retryable error page.
		const { current, scope } = await establishSession(getAuthProvider(), (identity) => {
			this.identity = identity;
			this.role = parseRole(identity);
			this.publicViewer = identity?.publicViewer === true;
		});
		if (!current || !scope) return null;
		const generation = scope.generation;

		if (!isTauri()) {
			this.authDisabled = false;
			return generation;
		}
		try {
			this.authDisabled = (await getAuthSettings()).disabled;
		} catch {
			this.authDisabled = false;
		}
		return generation;
	}
}

export const sessionStore = new SessionStore();
