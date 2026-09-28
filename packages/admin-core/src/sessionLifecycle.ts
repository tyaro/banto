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
import type { Identity } from './provider';
import { sessionOwnerKey, transitionSessionScope } from './sessionScope.svelte';

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
