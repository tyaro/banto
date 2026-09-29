/**
 * The two moves of this tab's session scope (`sessionScope.svelte.ts`),
 * Issue #215/#255 4th review - redesign.
 *
 * - `beginSession(identity)` - the route guard confirmed a session AND
 *   resolved who it belongs to. The app calls it right after
 *   `AuthProvider.getIdentity()` on every guard run (admin-template:
 *   `$lib/session.svelte.ts`'s `sessionStore.load()`). The same owner again
 *   keeps the generation (a guard re-run on `invalidateAll()` must not
 *   invalidate the screens of an unchanged session); a different owner -
 *   however it changed: this tab's login, another tab's "Remember me"
 *   login, a reload, the move to the public viewer - starts a new
 *   generation and drops saved state owned by anyone else.
 * - `endSession()` - this tab's session is over: the user logged out, a
 *   background revocation was confirmed (`sessionEnded.ts`), or the guard
 *   found no session at all (`sessionGate.ts`). No owner until the next
 *   `beginSession`, a new generation, and all saved list view state goes.
 *
 * Neither wraps or otherwise touches the app's `AuthProvider` (the 2nd/3rd
 * rounds of #255 wrapped it in a `Proxy` to hook `login`/`logout`, which
 * broke class-based and frozen providers). Correctness does not depend on
 * every path calling these: saved state is matched against its owner on
 * read and screens check their captured scope before writing - these calls
 * only keep the generation/owner current and the storage tidy.
 */
import { clearAllListViewState, purgeListViewStateNotOwnedBy } from './listViewState';
import type { AuthProvider, Identity } from './provider';
import {
	currentSessionScope,
	isCurrentSessionScope,
	sessionOwnerKey,
	transitionSessionScope
} from './sessionScope.svelte';

/** Confirm the live session belongs to `identity` (`null` = signed in, but the provider cannot say as whom: nothing is saved or restored). */
export function beginSession(identity: Identity | null): void {
	const owner = sessionOwnerKey(identity);
	transitionSessionScope(owner, true);
	purgeListViewStateNotOwnedBy(owner);
}

/** End the live session: no owner, a new generation, and every saved list view state is dropped. */
export function endSession(): void {
	transitionSessionScope(null, false);
	clearAllListViewState();
}

/** How many times an answer may be discarded because the session changed while it was pending, before giving up. */
export const MAX_STALE_RETRIES = 3;

/** Thrown when the session kept changing under a pending auth answer `MAX_STALE_RETRIES` times - the caller shows its "could not verify" path (the route guard: a retryable error page). */
export class SessionChangedError extends Error {
	constructor() {
		super('The session changed repeatedly while its answer was pending.');
		this.name = 'SessionChangedError';
	}
}

let establishSequence = 0;

/**
 * Fetch who the live session belongs to and `beginSession` it - the one
 * call a route guard makes after `resolveProtectedSession` (admin-template:
 * `$lib/session.svelte.ts`'s `sessionStore.load()`).
 *
 * Issue #215/#255 5th review: `getIdentity()` answers about the token it was
 * SENT with. While it is pending, this tab can log out and log in as someone
 * else (and render that session) - applying the late answer would move the
 * owner back to the previous identity, start a new generation, drop the new
 * owner's saved state and hide its screen (`(app)/+layout.svelte`'s
 * generation gate). So an answer is applied only if
 * - no newer `establishSession` call has started since (the newer one owns
 *   the session - this one resolves `{ current: false }` and changes
 *   nothing), and
 * - the session scope is still the one captured when the request started;
 *   if it changed (a logout, a confirmed ending, another login's
 *   `beginSession`), the answer is discarded and the CURRENT session is
 *   asked again, up to `MAX_STALE_RETRIES` times (then `SessionChangedError`).
 *
 * `{ current: true }` means the identity was applied - the caller may show
 * it; `{ current: false }` means a newer call superseded this one - the
 * caller must not apply anything.
 */
export async function establishSession(
	auth: AuthProvider
): Promise<{ current: boolean; identity: Identity | null }> {
	const sequence = ++establishSequence;
	for (let attempt = 0; attempt < MAX_STALE_RETRIES; attempt++) {
		const scope = currentSessionScope();
		const identity = await auth.getIdentity();
		if (sequence !== establishSequence) return { current: false, identity: null };
		if (!isCurrentSessionScope(scope)) continue;
		beginSession(identity);
		return { current: true, identity };
	}
	throw new SessionChangedError();
}
