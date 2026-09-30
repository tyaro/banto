/**
 * The pre-#260 session moves, kept as thin delegations to the default
 * `SessionController` until v2.0.0 removes them (Issue #260 実装-2, design
 * §5.4/§7.1 - so admin-template and derived apps keep working).
 *
 * - `beginSession(identity)` / `endSession()` - commit `active` / `none`
 *   through the controller's single writer (an "external" transition: a
 *   pending `resolve()` gets `superseded`).
 * - `establishSession(auth, apply)` - `resolveSettled()` on the controller
 *   bound to `auth`; applies the confirmed identity in the same continuation
 *   as an `isCurrent(ticket)` check.
 *
 * New code uses `getSessionController()` / `resolveSettled()` instead.
 */
import type { AuthProvider, Identity } from './provider';
import {
	bindDefaultSessionProvider,
	defaultSessionInternals,
	resolveSettled,
	SessionChangedError
} from './sessionController.svelte';
import type { SessionScope } from './sessionScope.svelte';

export { SessionChangedError } from './sessionController.svelte';

/** Confirm the live session belongs to `identity` (an external commit of `active` on the default controller). */
export function beginSession(identity: Identity | null): void {
	defaultSessionInternals().legacyBegin(identity);
}

/** End the live session: an external commit of `none` (new generation, saved list view state dropped). */
export function endSession(): void {
	defaultSessionInternals().legacyEnd();
}

/** How many times an answer may be discarded because the session changed while it was pending, before giving up. */
export const MAX_STALE_RETRIES = 3;

let establishSequence = 0;

/** A rejection value for the pre-#260 API, which reports "could not verify" by throwing. */
export function toThrowable(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Confirm who the live session belongs to - the one call a route guard
 * makes after `resolveProtectedSession` (admin-template: `sessionStore.load()`).
 *
 * Delegates to `resolveSettled()` on the default controller bound to `auth`.
 * `{ current: false }` when a newer `establishSession` started meanwhile
 * (the newer one owns the result). Otherwise `{ current: true, identity,
 * scope }` for the confirmed session (`identity` is `null` for a confirmed
 * `none`), with `apply` run in the same continuation as the check that the
 * confirmation is still current (no `await` in between). "Could not verify"
 * (a provider rejection, a deadline, `SessionChangedError`) is thrown and
 * changes nothing - the route guard shows its retryable error page.
 */
export async function establishSession(
	auth: AuthProvider,
	apply?: (identity: Identity | null) => void
): Promise<{ current: boolean; identity: Identity | null; scope: SessionScope | null }> {
	const { controller } = bindDefaultSessionProvider(auth);
	const sequence = ++establishSequence;
	for (let attempt = 0; attempt < MAX_STALE_RETRIES; attempt++) {
		const result = await resolveSettled(controller);
		// From here to `return`: one continuation, no `await`.
		if (sequence !== establishSequence) return { current: false, identity: null, scope: null };
		if (result.outcome === 'unverified') throw toThrowable(result.error);
		if (!controller.isCurrent(result.ticket)) continue;
		const identity = result.snapshot.status === 'active' ? result.snapshot.identity : null;
		apply?.(identity);
		return {
			current: true,
			identity,
			scope: Object.freeze({ generation: result.snapshot.generation, owner: result.snapshot.owner })
		};
	}
	throw new SessionChangedError();
}
