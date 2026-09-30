/**
 * The logout (Issue #260 実装-2; independent audit P2-1; CI of #265).
 *
 * Order: `logout()` -> `endSession()` (ticket-guarded) -> `goto('/login')`,
 * with `isLoggingOut()` true for the whole sequence.
 *
 * - While logging out, the protected layout's generation check (wiring ①,
 *   `(app)/+layout.svelte`) does not call `invalidateAll()`. Otherwise the
 *   logout's own hold would re-run the loads, and SvelteKit lets such an
 *   invalidation win over the `goto('/login')` started right after it -
 *   with public viewing on, the re-run minted a public-viewer session and
 *   the tab stayed on the protected screen (E2E public-viewer 5a).
 * - The login screen appears only AFTER the logout finished. An earlier
 *   version navigated first and logged out afterwards; a login submitted on
 *   that screen while the logout request was still in flight lost the
 *   provider's compare-and-set to it ("another session was confirmed
 *   first", CI smoke scenario 7).
 * - `endSession()` runs only while a ticket taken before `logout()` is still
 *   current (I-18): a session confirmed meanwhile - e.g. another tab's login
 *   (S-17/S-51) - is left alone, and a rejected `logout()` is decided the same
 *   way (`try/finally`). With a standard provider the logout's own token
 *   clear is reported and the controller confirms `none` itself (the ticket
 *   is stale by then); `endSession()` only runs for a provider that cannot
 *   report it (the compatibility adapter, e.g. the demo provider). v2.0.0
 *   replaces this with `resolveSettled()` (I-10).
 */
import {
	endSession,
	getAuthProvider,
	getSessionController,
	type AuthProvider,
	type SessionController
} from '@banto/admin-core';

let loggingOut = $state(0);

/** Reactive: a logout is running in this tab (wiring ① holds its re-load meanwhile). */
export function isLoggingOut(): boolean {
	return loggingOut > 0;
}

/** Log out, end the session if nothing else was confirmed meanwhile, then go to the login screen. */
export async function logoutAndLeave(
	goToLogin: () => Promise<void>,
	provider: AuthProvider = getAuthProvider(),
	controller: SessionController = getSessionController()
): Promise<void> {
	loggingOut += 1;
	try {
		const ticket = controller.ticket();
		try {
			await provider.logout();
		} finally {
			if (controller.isCurrent(ticket)) endSession();
		}
		await goToLogin();
	} finally {
		loggingOut -= 1;
	}
}
