/**
 * The protected-route session decision (spec §8.1, viewer-public-plan
 * §3.1-6, Issue #204), kept out of the app's `+layout.ts` so it is testable
 * here against real providers.
 */
import type { AuthProvider } from './provider';
import { endSession, MAX_STALE_RETRIES, SessionChangedError } from './sessionLifecycle';
import { currentSessionScope, isCurrentSessionScope } from './sessionScope.svelte';

/**
 * How a protected route may proceed:
 * - `'session'`: the existing session is valid;
 * - `'publicViewer'`: there was no valid session and a synthetic public
 *   viewer session was entered instead (`server.viewerPublic` ON, ADR-0012);
 * - `'login'`: no valid session and none could be entered - send the user to
 *   the login screen.
 */
export type ProtectedSessionOutcome = 'session' | 'publicViewer' | 'login';

/**
 * Decide how a protected route proceeds.
 *
 * Only a session that `check()` CONFIRMED invalid (`false`) falls through to
 * the public-viewer entry or the login screen. When `check()` rejects - the
 * backend could not verify the account (Issue #204: a DB error is a `500`,
 * not a revocation) or was unreachable - this rejects with that error BEFORE
 * touching anything else: no `status()`, no `enterPublicViewer()` (which
 * would replace the stored token, "Remember me" included), no redirect. The
 * caller shows the error and offers a retry; the session resumes once the
 * backend can answer again.
 *
 * Issue #215/#255 (4th review): once `check()` has CONFIRMED the session is
 * not valid, whoever was signed in in this tab is gone - whether the guard
 * then enters a public-viewer session or sends the tab to /login.
 * `endSession()` (`sessionLifecycle.ts`) runs right here, before either: it
 * starts a new session generation (screens and in-flight saves of the old
 * session can no longer write) and drops the saved list view state. The
 * public-viewer session that may follow is confirmed as a NEW owner by the
 * app's own `establishSession()`.
 *
 * 5th review: a `false` that arrives after the session changed (this tab
 * logged out and in as someone else while the check was pending) is about
 * the PREVIOUS session and is not acted on - see `checkCurrentSession`
 * below. If the session keeps changing, this rejects with
 * `SessionChangedError`, which the caller treats like any other "could not
 * verify" rejection (the retryable error page).
 */
export async function resolveProtectedSession(
	auth: AuthProvider
): Promise<ProtectedSessionOutcome> {
	if (await checkCurrentSession(auth)) return 'session';
	endSession();
	const status = await auth.status?.();
	const entered = status?.viewerPublic ? await auth.enterPublicViewer?.() : false;
	return entered ? 'publicViewer' : 'login';
}

/**
 * `auth.check()`, but a `false` is only trusted if the session scope did not
 * change while the check was pending (Issue #215/#255 5th review). The
 * answer is about the token the check was SENT with: if this tab logged out
 * and in as someone else meanwhile, a late `false` for the previous session
 * must not end the new one (the HTTP provider already keeps the new token -
 * `clearTokenIfCurrent`). Such an answer is discarded and the CURRENT
 * session is checked again, up to `MAX_STALE_RETRIES` times; a `true` needs
 * no such care (the caller then fetches the identity of whatever session is
 * current, `establishSession`).
 */
async function checkCurrentSession(auth: AuthProvider): Promise<boolean> {
	for (let attempt = 0; attempt < MAX_STALE_RETRIES; attempt++) {
		const scope = currentSessionScope();
		if (await auth.check()) return true;
		if (isCurrentSessionScope(scope)) return false;
	}
	throw new SessionChangedError();
}
