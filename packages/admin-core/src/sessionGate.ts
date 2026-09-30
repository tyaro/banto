/**
 * The pre-#260 protected-route decision (spec §8.1, viewer-public-plan
 * §3.1-6, Issue #204), kept as a delegation to the default
 * `SessionController` until v2.0.0 removes it (Issue #260 実装-2, design
 * §5.4/§7.1). New code: `resolveSettled()` + `publicViewerFallback()`.
 */
import type { AuthProvider } from './provider';
import {
	bindDefaultSessionProvider,
	resolveSettled,
	runPublicViewerFallback
} from './sessionController.svelte';
import { MAX_STALE_RETRIES, SessionChangedError, toThrowable } from './sessionLifecycle';

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
 * Decide how a protected route proceeds: `resolveSettled()` on the default
 * controller bound to `auth`, then - only for a CONFIRMED `none` - the
 * public-viewer policy (`publicViewerFallback`).
 *
 * "Could not verify" REJECTS (unchanged contract, design §7.1 実装-2 / P3-12):
 * the provider could not answer (Issue #204: a `500`, unreachable - nothing
 * is cleared, no `status()`, no public-viewer entry), the confirmation ran
 * out of time, or the session kept changing (`SessionChangedError`). A
 * confirmed `none` has already been committed by the controller (new
 * generation, saved list view state dropped) before the public-viewer entry,
 * and a minted public-viewer session is confirmed by the controller too.
 */
export async function resolveProtectedSession(
	auth: AuthProvider
): Promise<ProtectedSessionOutcome> {
	const { controller } = bindDefaultSessionProvider(auth);
	const first = await resolveSettled(controller);
	if (first.outcome === 'unverified') throw toThrowable(first.error);
	if (first.snapshot.status === 'active') return 'session';
	// The pre-#260 gate gave up after `MAX_STALE_RETRIES` checks in all: the
	// first confirmation above plus `maxRetries + 1` policy rounds.
	const { result, exhausted } = await runPublicViewerFallback(
		controller,
		auth,
		first.ticket,
		MAX_STALE_RETRIES - 2
	);
	if (result.outcome === 'unverified') throw toThrowable(result.error);
	if (exhausted) throw new SessionChangedError();
	if (result.snapshot.status === 'active') {
		return result.snapshot.kind === 'publicViewer' ? 'publicViewer' : 'session';
	}
	return 'login';
}
