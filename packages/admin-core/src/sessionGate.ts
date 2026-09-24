/**
 * The protected-route session decision (spec §8.1, viewer-public-plan
 * §3.1-6, Issue #204), kept out of the app's `+layout.ts` so it is testable
 * here against real providers.
 */
import type { AuthProvider } from './provider';

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
 */
export async function resolveProtectedSession(
	auth: AuthProvider
): Promise<ProtectedSessionOutcome> {
	if (await auth.check()) return 'session';
	const status = await auth.status?.();
	const entered = status?.viewerPublic ? await auth.enterPublicViewer?.() : false;
	return entered ? 'publicViewer' : 'login';
}
