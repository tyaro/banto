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
import { getAuthProvider, type Identity } from '@banto/admin-core';
import { parseRole, type Role } from './permissions';

class SessionStore {
	identity: Identity | null = $state(null);
	role: Role = $state('viewer');

	/** Fetch the current identity and derive `role` from it (fail closed - see `parseRole`). */
	async load(): Promise<void> {
		this.identity = await getAuthProvider().getIdentity();
		this.role = parseRole(this.identity);
	}
}

export const sessionStore = new SessionStore();
