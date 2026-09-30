/**
 * "The session ended while a screen was open" (Issue #241), as a view of the
 * default `SessionController` (Issue #260 実装-2, design §5.4).
 *
 * - `onSessionEnded(listener)` - notified when the controller commits `none`
 *   after `active`/`unknown` (a background revocation confirmed, a hold that
 *   was confirmed `none`, a logout). It is a thin wrapper over
 *   `controller.subscribe` with no state or confirmation of its own (I-1).
 *   S-34 (design §4.5): the pre-#260 "unheard ending" re-probe is gone;
 *   instead, a subscription made while the session is ALREADY `none` is
 *   notified once, asynchronously (never inside the subscribing call, which
 *   is typically a component's `$effect`), if it is still subscribed and the
 *   session is still `none` by then. Kept in v2.0.0.
 * - `confirmSessionEnded()` / `createSessionEndConfirmation()` - the
 *   pre-#260 background confirmation (removed in v2.0.0; `connectEvents`
 *   uses `controller.signal()` from 実装-3). Each attempt is a signal-caused
 *   request to the controller (only a probe started after the request can
 *   answer it, I-9); `createSessionEndConfirmation` keeps its own backoff
 *   and `stop()`, exactly as before.
 */
import {
	defaultSessionInternals,
	getSessionController,
	type ResolveResult
} from './sessionController.svelte';
import { MAX_STALE_RETRIES } from './sessionLifecycle';

type Listener = () => void;

/** How long a confirmation waits for the provider before giving up (the controller's default probe deadline). */
export const CONFIRM_TIMEOUT_MS = 10_000;

function call(listener: Listener): void {
	try {
		listener();
	} catch {
		// One broken listener must not stop the others.
	}
}

/**
 * Subscribe to "the current session was confirmed ended". Returns an
 * unsubscribe function. See the module doc for the S-34 "already ended when
 * subscribing" notification.
 */
export function onSessionEnded(listener: Listener): () => void {
	const controller = getSessionController();
	let subscribed = true;
	const off = controller.subscribe((snapshot, previous) => {
		if (snapshot.status === 'none' && previous.status !== 'none') call(listener);
	});
	if (controller.snapshot.status === 'none') {
		const generation = controller.snapshot.generation;
		queueMicrotask(() => {
			// Still subscribed, and still the same ended session (a transition
			// meanwhile was delivered by the subscription itself).
			if (
				subscribed &&
				controller.snapshot.status === 'none' &&
				controller.snapshot.generation === generation
			) {
				call(listener);
			}
		});
	}
	return () => {
		subscribed = false;
		off();
	};
}

/** Result of one confirmation. */
export type SessionEndOutcome =
	/** The controller confirmed `none` (listeners were notified if the session was not already `none`). */
	| 'ended'
	/** The controller confirmed an active session. */
	| 'valid'
	/** The provider could not answer (rejected or timed out): nothing is known yet. */
	| 'unknown';

function outcomeOf(result: Exclude<ResolveResult, { outcome: 'superseded' }>): SessionEndOutcome {
	if (result.outcome === 'unverified') return 'unknown';
	return result.snapshot.status === 'none' ? 'ended' : 'valid';
}

async function confirmOnce(): Promise<SessionEndOutcome> {
	const internals = defaultSessionInternals();
	for (let attempt = 0; attempt < MAX_STALE_RETRIES; attempt++) {
		const result = await internals.legacyResolveSignal();
		if (result.outcome !== 'superseded') return outcomeOf(result);
	}
	return 'unknown';
}

/**
 * Confirm through the controller that the session ended. Never rejects.
 * Each call is a signal-caused request: it is answered only by a probe that
 * started after it (an older in-flight probe is aborted and replaced, I-9).
 * A single attempt: `createSessionEndConfirmation` retries `'unknown'`.
 */
export function confirmSessionEnded(): Promise<SessionEndOutcome> {
	return confirmOnce();
}

/** First delay before retrying an `'unknown'` confirmation. */
export const CONFIRM_RETRY_INITIAL_MS = 1_000;
/** Longest delay between retries (the delay doubles up to this). */
export const CONFIRM_RETRY_MAX_MS = 30_000;

export interface SessionEndConfirmation {
	/** A new signal that the session may have ended: confirm it (now, if waiting on a backoff). */
	start(): void;
	/** Stop retrying (e.g. the event subscription ended). */
	stop(): void;
}

let legacyClock = 0;

/**
 * A confirmation that keeps going until it knows (review of #242): retries
 * an `'unknown'` outcome after `CONFIRM_RETRY_INITIAL_MS`, doubling up to
 * `CONFIRM_RETRY_MAX_MS`; confirms again when a signal arrived while its
 * attempt was in flight. One attempt at a time per confirmation.
 */
export function createSessionEndConfirmation(): SessionEndConfirmation {
	let running = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let latestSignalAt = 0;

	async function attempt(delayMs: number): Promise<void> {
		timer = null;
		const startedAt = ++legacyClock;
		const outcome = await confirmOnce();
		if (stopped) return;
		if (latestSignalAt > startedAt) {
			void attempt(CONFIRM_RETRY_INITIAL_MS);
			return;
		}
		if (outcome !== 'unknown') {
			running = false;
			return;
		}
		timer = setTimeout(() => void attempt(Math.min(delayMs * 2, CONFIRM_RETRY_MAX_MS)), delayMs);
	}

	return {
		start() {
			if (stopped) return;
			latestSignalAt = ++legacyClock;
			if (!running) {
				running = true;
				void attempt(CONFIRM_RETRY_INITIAL_MS);
			} else if (timer !== null) {
				clearTimeout(timer);
				void attempt(CONFIRM_RETRY_INITIAL_MS);
			}
		},
		stop() {
			stopped = true;
			running = false;
			if (timer !== null) clearTimeout(timer);
			timer = null;
		}
	};
}
