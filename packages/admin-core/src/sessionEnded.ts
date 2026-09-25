/**
 * "The session ended while a screen was open" (Issue #241).
 *
 * The protected-route guard (`resolveProtectedSession`) only runs when the
 * app navigates. A session revoked in the background (Issue #204: the
 * account was deleted/demoted, or its password changed/reset) is noticed
 * first by the event stream (`/api/events` answers `401`), not by a
 * navigation. `confirmSessionEnded` turns that signal into the guard's own
 * path:
 *
 * 1. it asks `AuthProvider.check()` - the ONE place that decides validity
 *    and clears the stored token (`createHttpAuthProvider` clears it on a
 *    `401` or a `200 false`, and keeps it when the server could not verify);
 * 2. only when `check()` CONFIRMS the session is invalid (`false`) does it
 *    tell `onSessionEnded` listeners. The app re-runs its route guard there
 *    (e.g. SvelteKit `invalidateAll()`), which sends the screen to the login
 *    page (or a public-viewer session) exactly like a navigation would.
 *    A rejected `check()` (500 / unreachable) tells no one: the token stays
 *    and the next navigation shows the guard's retry screen.
 *
 * Duplicates: the event stream reports a rejected token once, and
 * concurrent calls here (e.g. a derived app's second stream noticing the same
 * revocation) share one in-flight confirmation, so listeners are notified at
 * most once per confirmation. A navigation that notices the revocation itself
 * does not come through here - its route guard already goes to the login
 * screen - and `check()` clears only the token it checked, so the two paths
 * cannot undo each other.
 *
 * A confirmation whose `check()` never answers gives up after
 * `CONFIRM_TIMEOUT_MS` (treated as "could not verify": no notification), so a
 * hung request cannot hold every later confirmation to its result.
 */
import { getAuthProvider } from './registry.svelte';

type Listener = () => void;

/** How long a confirmation waits for `check()` before giving up. */
export const CONFIRM_TIMEOUT_MS = 10_000;

const listeners = new Set<Listener>();
let inFlight: Promise<boolean> | null = null;

/**
 * Subscribe to "the current session was confirmed ended in the background".
 * Returns an unsubscribe function. Typical app wiring (inside the protected
 * layout, so it is only active while a protected screen is shown):
 * `onSessionEnded(() => void invalidateAll())`.
 */
export function onSessionEnded(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Confirm through `AuthProvider.check()` that the session ended and, only if
 * it did, notify `onSessionEnded` listeners. Resolves `true` when the end was
 * confirmed, `false` when the session is still valid or could not be
 * verified (never rejects). Concurrent calls share one confirmation.
 */
export function confirmSessionEnded(): Promise<boolean> {
	if (inFlight) return inFlight;
	const run = (async () => {
		let valid: boolean;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			valid = await Promise.race([
				getAuthProvider().check(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('timed out')), CONFIRM_TIMEOUT_MS);
				})
			]);
		} catch {
			// Could not verify (or no provider registered, or no answer in
			// time): not an ending.
			return false;
		} finally {
			clearTimeout(timer);
		}
		if (valid) return false;
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// One broken listener must not stop the others.
			}
		}
		return true;
	})();
	inFlight = run;
	void run.finally(() => {
		if (inFlight === run) inFlight = null;
	});
	return run;
}
