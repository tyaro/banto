/**
 * The protected-route session decision (spec §8.1, viewer-public-plan
 * §3.1-6, Issue #204), kept out of the app's `+layout.ts` so it is testable
 * here against real providers.
 */
import type { AuthProvider } from './provider';
import { endSession } from './sessionLifecycle';

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
 * app's own `beginSession()` after `getIdentity()`.
 */
export async function resolveProtectedSession(
	auth: AuthProvider
): Promise<ProtectedSessionOutcome> {
	if (await auth.check()) return 'session';
	endSession();
	const status = await auth.status?.();
	const entered = status?.viewerPublic ? await auth.enterPublicViewer?.() : false;
	return entered ? 'publicViewer' : 'login';
}
