/**
 * The protected-route decision as an app composes it on v2.0.0 (design §6.1,
 * admin-template's `(app)/+layout.ts`): `resolveSettled()`, then - only for
 * a confirmed `none` - `publicViewerFallback()`. `unverified` is handled
 * first (the 503 retry page), and only a confirmed `none` goes to /login.
 * The removed `resolveProtectedSession` made this decision inside the
 * package; tests that used it run this composition instead.
 */
import type { AuthProvider } from '../src/provider';
import {
	getSessionController,
	publicViewerFallback,
	resolveSettled,
	type ResolveResult,
	type SessionController
} from '../src/sessionController.svelte';

export type GuardOutcome =
	| { route: 'session' | 'publicViewer' | 'login'; generation: number }
	| { route: 'unverified'; error: unknown };

export async function protectedGuard(
	provider: Pick<AuthProvider, 'status' | 'enterPublicViewer'>,
	controller: SessionController = getSessionController()
): Promise<GuardOutcome> {
	let result: Exclude<ResolveResult, { outcome: 'superseded' }> = await resolveSettled(controller, {
		cause: 'navigation'
	});
	if (result.outcome === 'unverified') return { route: 'unverified', error: result.error };
	if (result.snapshot.status === 'none') {
		result = await publicViewerFallback(controller, provider, result.ticket);
		if (result.outcome === 'unverified') return { route: 'unverified', error: result.error };
		if (result.snapshot.status !== 'active') {
			return { route: 'login', generation: result.snapshot.generation };
		}
	}
	return {
		route: result.snapshot.kind === 'publicViewer' ? 'publicViewer' : 'session',
		generation: result.snapshot.generation
	};
}

/** Just the route (for tests that only care where the guard sends the screen). */
export async function guardRoute(
	provider: Pick<AuthProvider, 'status' | 'enterPublicViewer'>,
	controller?: SessionController
): Promise<GuardOutcome['route']> {
	return (await protectedGuard(provider, controller)).route;
}
