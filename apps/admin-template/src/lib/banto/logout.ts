/**
 * The logout's session side (Issue #260 実装-2, independent audit P2-1).
 *
 * Callers (`Header.svelte`, `commands.ts`) first `goto('/login')` - so the
 * protected layout's generation check (wiring ①) cannot re-run the loads
 * over that navigation - and then call this. Because the tab is already on
 * the login screen while the logout request is in flight, ANOTHER login (B)
 * can be confirmed before the logout answers. The provider's compare-and-set
 * keeps B's token (S-21), and this must not end B's session either:
 *
 * - a ticket is taken BEFORE `logout()` and `endSession()` runs only while it
 *   is still current (I-18: check and apply in one continuation). B's login
 *   (or any other transition) makes it stale, so B is left alone (S-17/S-51).
 * - `try/finally`: a rejected `logout()` is handled the same way (the
 *   provider cleared its token locally or did not; either way the ticket
 *   decides).
 * - With a standard provider the logout's own token clear is reported
 *   (`onCredentialChanged`), the controller holds and confirms `none` itself,
 *   and the ticket is already stale - `endSession()` only runs for a provider
 *   that cannot report it (the compatibility adapter, e.g. the demo
 *   provider). v2.0.0 replaces this with `resolveSettled()` (I-10).
 */
import {
	endSession,
	getAuthProvider,
	getSessionController,
	type AuthProvider,
	type SessionController
} from '@banto/admin-core';

export async function logoutAndEndSession(
	provider: AuthProvider = getAuthProvider(),
	controller: SessionController = getSessionController()
): Promise<void> {
	const ticket = controller.ticket();
	try {
		await provider.logout();
	} finally {
		if (controller.isCurrent(ticket)) endSession();
	}
}
