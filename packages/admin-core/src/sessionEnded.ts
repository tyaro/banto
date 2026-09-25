/**
 * "The session ended while a screen was open" (Issue #241).
 *
 * The protected-route guard (`resolveProtectedSession`) only runs when the
 * app navigates. A session revoked in the background (Issue #204: the
 * account was deleted/demoted, or its password changed/reset) is noticed
 * first by the event stream (`/api/events` answers `401`, or the token it
 * was using was cleared by another tab), not by a navigation. `confirmSessionEnded` turns that signal into the guard's own
 * path:
 *
 * 1. it asks `AuthProvider.check()` - the ONE place that decides validity
 *    and clears the stored token (`createHttpAuthProvider` clears it on a
 *    `401` or a `200 false`, and keeps it when the server could not verify);
 * 2. only when `check()` CONFIRMS the session is invalid (`false`) does it
 *    tell `onSessionEnded` listeners. The app re-runs its route guard there
 *    (e.g. SvelteKit `invalidateAll()`), which sends the screen to the login
 *    page (or a public-viewer session) exactly like a navigation would.
 *    A rejected `check()` (500 / unreachable) tells no one yet: the token
 *    stays, and the confirmation is retried (see "Retries" below).
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
 *
 * Retries (review of #242): the event stream reports once, so a confirmation
 * that could not verify must not be the last word. `connectEvents` drives
 * `createSessionEndConfirmation`, which retries with backoff until the
 * outcome is known. A late `false` for an abandoned check still clears the
 * token (the HTTP provider's side effect); the next retry then sees no token,
 * `check()` resolves `false` without a request, and listeners are notified -
 * the notification follows the cleared token within one retry delay.
 */
import { getAuthProvider } from './registry.svelte';

type Listener = () => void;

/** How long a confirmation waits for `check()` before giving up. */
export const CONFIRM_TIMEOUT_MS = 10_000;

const listeners = new Set<Listener>();
let inFlight: Promise<SessionEndOutcome> | null = null;

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

/** Result of one confirmation. */
export type SessionEndOutcome =
	/** `check()` resolved `false`: the session ended, listeners were notified. */
	| 'ended'
	/** `check()` resolved `true`: the (current) session is valid. */
	| 'valid'
	/** `check()` rejected or did not answer in time: nothing is known yet. */
	| 'unknown';

/**
 * Confirm through `AuthProvider.check()` that the session ended and, only if
 * it did, notify `onSessionEnded` listeners. Never rejects. Concurrent calls
 * share one confirmation. A single attempt: `createSessionEndConfirmation`
 * retries an `'unknown'` outcome.
 */
export function confirmSessionEnded(): Promise<SessionEndOutcome> {
	if (inFlight) return inFlight;
	const run = (async (): Promise<SessionEndOutcome> => {
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
			// time): not an ending. A late answer to an abandoned check still
			// has its effect - a late `false` clears the token - and the next
			// attempt then finds no token and confirms without a request.
			return 'unknown';
		} finally {
			clearTimeout(timer);
		}
		if (valid) return 'valid';
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// One broken listener must not stop the others.
			}
		}
		return 'ended';
	})();
	inFlight = run;
	void run.finally(() => {
		if (inFlight === run) inFlight = null;
	});
	return run;
}

/** First delay before retrying an `'unknown'` confirmation. */
export const CONFIRM_RETRY_INITIAL_MS = 1_000;
/** Longest delay between retries (the delay doubles up to this). */
export const CONFIRM_RETRY_MAX_MS = 30_000;

export interface SessionEndConfirmation {
	/** Start confirming, unless a confirmation is already running. */
	start(): void;
	/** Stop retrying (e.g. the event subscription ended). */
	stop(): void;
}

/**
 * A confirmation that keeps going until it knows (review of #242): runs
 * `confirmSessionEnded()` and, while the outcome is `'unknown'` (the server
 * could not verify, was unreachable, or did not answer in time), retries
 * after `CONFIRM_RETRY_INITIAL_MS`, doubling up to `CONFIRM_RETRY_MAX_MS` -
 * the server is asked again once it recovers, without asking it too often
 * while it cannot answer. Stops at `'ended'` (listeners notified) or
 * `'valid'`. `start()` while running is a no-op, so repeated signals never
 * stack loops.
 */
export function createSessionEndConfirmation(): SessionEndConfirmation {
	let running = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function attempt(delayMs: number): Promise<void> {
		timer = null;
		const outcome = await confirmSessionEnded();
		if (stopped) return;
		if (outcome !== 'unknown') {
			running = false;
			return;
		}
		timer = setTimeout(() => void attempt(Math.min(delayMs * 2, CONFIRM_RETRY_MAX_MS)), delayMs);
	}

	return {
		start() {
			if (running || stopped) return;
			running = true;
			void attempt(CONFIRM_RETRY_INITIAL_MS);
		},
		stop() {
			stopped = true;
			running = false;
			if (timer !== null) clearTimeout(timer);
			timer = null;
		}
	};
}
