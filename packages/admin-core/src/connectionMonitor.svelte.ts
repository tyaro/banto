/**
 * Connection state of a LAN browser client (Issue #637, design-ux-review
 * D-4): is the server reachable right now, and when did it come back?
 * Judged in the front end only - there is no `/api/health` - from three
 * inputs, none of which knows about this module:
 *
 * - the HTTP providers' `onRequestResult` (`reportRequest`): an answer of
 *   any status is "reachable", a `fetch` rejection or timeout is a failure;
 * - the SSE stream's `onDisconnected` / `onReconnected` (`connectEvents(...,
 *   { connection })`): the loss of an open stream is a disconnect at once;
 * - the browser's `online` / `offline` events (`navigator.onLine`).
 *
 * The rules are the pure `nextConnectionState` / `connectionStatusOf`; the
 * monitor only feeds them and keeps the result reactive. It never polls and
 * never reconnects anything: recovery is observed - the SSE provider's own
 * reconnect, the session controller's backoff probe, the user's next
 * request. The Tauri webview (`invoke`, nothing to lose) does not create
 * one; that choice is the caller's (`getBantoMode()`), not this module's.
 * Without `window` (SSR, tests) it starts `online` and listens to nothing.
 */
import type { HttpRequestResult } from './providers/http';
import type { StreamConnectionListener } from './events';

/**
 * - `online`: nothing says the server is unreachable.
 * - `reconnecting`: it is unreachable (the stream was lost, or
 *   `failureThreshold` requests in a row got no answer) and recovery is
 *   being waited for.
 * - `offline`: the browser itself reports no network.
 */
export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

export interface ConnectionState {
	/** The browser reported `offline` (or `navigator.onLine` was false at start) and nothing reached the server since. */
	readonly browserOffline: boolean;
	/** The SSE stream was lost and has not come back, and no request has been answered since. */
	readonly streamLost: boolean;
	/** Requests in a row that got no answer (stale ones excluded). */
	readonly consecutiveFailures: number;
	/** When the last evidence of unreachability arrived (a failure, a stream loss, `offline`). */
	readonly lastFailureAt: number | null;
	/** When the last evidence of reachability arrived (an answer, a stream reconnect). */
	readonly lastSuccessAt: number | null;
}

export type ConnectionEvent =
	| { type: 'request'; result: HttpRequestResult; at: number }
	| { type: 'streamDisconnected'; at: number }
	| { type: 'streamReconnected'; at: number }
	| { type: 'browserOffline'; at: number }
	| { type: 'browserOnline'; at: number };

/** Requests in a row without an answer before `reconnecting` (one failure is not a disconnect). */
export const DEFAULT_FAILURE_THRESHOLD = 2;

export function initialConnectionState(browserOnline: boolean): ConnectionState {
	return {
		browserOffline: !browserOnline,
		streamLost: false,
		consecutiveFailures: 0,
		lastFailureAt: null,
		lastSuccessAt: null
	};
}

/** `offline` wins over `reconnecting`, which wins over `online`. `threshold` is clamped to at least 1. */
export function connectionStatusOf(state: ConnectionState, threshold: number): ConnectionStatus {
	if (state.browserOffline) return 'offline';
	if (state.streamLost || state.consecutiveFailures >= normalizeThreshold(threshold)) {
		return 'reconnecting';
	}
	return 'online';
}

function normalizeThreshold(threshold: number): number {
	if (!Number.isFinite(threshold)) return DEFAULT_FAILURE_THRESHOLD;
	return Math.max(1, Math.floor(threshold));
}

function reachable(state: ConnectionState, at: number): ConnectionState {
	return {
		browserOffline: false,
		streamLost: false,
		consecutiveFailures: 0,
		lastFailureAt: state.lastFailureAt,
		lastSuccessAt: at
	};
}

/**
 * The transition rules (pure). Stale results are discarded (conventions §8):
 * a request's answer counts only if the request was sent at or after the
 * latest evidence the other way - a success sent before the last failure
 * may describe the server before it went away, and a failure sent before
 * the last success may be a request that hung through an outage that is
 * already over. Events without a `startedAt` (stream, browser) are
 * evidence at the moment they arrive.
 *
 * - an answer / a stream reconnect: everything clears (`browserOffline`
 *   too - the server answered, so there is a network);
 * - a request without an answer: one more in a row;
 * - a stream loss: `streamLost` at once (no threshold - the stream only
 *   reports the loss of a stream that was open);
 * - `offline`: `browserOffline`; `online`: clears it and the failures
 *   counted meanwhile (the network, not the server, failed them), so a
 *   quiet screen recovers on `online` alone; a lost stream stays lost until
 *   it reconnects.
 */
export function nextConnectionState(
	state: ConnectionState,
	event: ConnectionEvent
): ConnectionState {
	switch (event.type) {
		case 'request': {
			const { result } = event;
			if (result.ok) {
				if (state.lastFailureAt !== null && result.startedAt < state.lastFailureAt) return state;
				return reachable(state, event.at);
			}
			if (state.lastSuccessAt !== null && result.startedAt < state.lastSuccessAt) return state;
			return {
				...state,
				consecutiveFailures: state.consecutiveFailures + 1,
				lastFailureAt: event.at
			};
		}
		case 'streamReconnected':
			return reachable(state, event.at);
		case 'streamDisconnected':
			return { ...state, streamLost: true, lastFailureAt: event.at };
		case 'browserOffline':
			return { ...state, browserOffline: true, lastFailureAt: event.at };
		case 'browserOnline':
			// The requests that failed while the browser had no network were
			// failed by that, not by the server: they stop counting. A lost
			// stream still counts (its own reconnect shows it came back).
			return state.browserOffline
				? { ...state, browserOffline: false, consecutiveFailures: 0 }
				: state;
	}
}

/** The `window` part the monitor listens on (`online` / `offline`). */
export interface ConnectionEventTarget {
	addEventListener(type: 'online' | 'offline', listener: () => void): void;
	removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

export interface ConnectionMonitorOptions {
	/** Requests in a row without an answer before `reconnecting`. Default `DEFAULT_FAILURE_THRESHOLD` (2); below 1 counts as 1. */
	failureThreshold?: number;
	/** Clock for the event times; must be the clock of `HttpRequestResult.startedAt`. Default `Date.now`. */
	now?: () => number;
	/** Where `online` / `offline` are heard. Default `window` when it exists; `null` listens to nothing. */
	eventTarget?: ConnectionEventTarget | null;
	/** Whether the browser has a network at start. Default `navigator.onLine` (`true` when unknown). */
	isOnline?: () => boolean;
}

export interface ConnectionMonitor extends StreamConnectionListener {
	/** Reactive. */
	readonly status: ConnectionStatus;
	/** Reactive: the full state, for "last failed at" displays. */
	readonly state: ConnectionState;
	/** Reactive: how many times the status came back to `online` (a counter an `$effect` can watch). */
	readonly recoveries: number;
	/** Pass as `onRequestResult` of `createHttpDataProvider` / `createHttpAuthProvider` (bound). */
	reportRequest(result: HttpRequestResult): void;
	/** `connectEvents(provider, { connection: monitor })` calls these two (bound). */
	reportStreamDisconnected(): void;
	reportStreamReconnected(): void;
	/**
	 * Called once each time the status goes from `reconnecting` / `offline`
	 * back to `online` (never for a report that keeps it `online`, so a
	 * stream reconnect and a request answer arriving together recover once).
	 * Returns an unsubscribe function.
	 */
	onRecovered(listener: () => void): () => void;
	/** Stop listening to `window`; later reports are ignored. */
	dispose(): void;
}

function defaultEventTarget(): ConnectionEventTarget | null {
	if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
	return window;
}

function defaultIsOnline(): boolean {
	if (typeof navigator === 'undefined') return true;
	return (navigator as { onLine?: unknown }).onLine !== false;
}

/**
 * Create a connection monitor (Issue #637). Wiring, for the LAN browser
 * (`server` mode) only:
 *
 * ```ts
 * const connection = createConnectionMonitor();
 * createHttpDataProvider({ getToken, onRequestResult: connection.reportRequest });
 * createHttpAuthProvider({ onRequestResult: connection.reportRequest });
 * connectEvents(createSseEventProvider({ getToken }), { connection });
 * ```
 */
export function createConnectionMonitor(options: ConnectionMonitorOptions = {}): ConnectionMonitor {
	const threshold = normalizeThreshold(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
	const now = options.now ?? Date.now;
	const target = options.eventTarget === undefined ? defaultEventTarget() : options.eventTarget;
	const isOnline = options.isOnline ?? defaultIsOnline;

	let state = $state<ConnectionState>(initialConnectionState(isOnline()));
	let recoveries = $state(0);
	let disposed = false;
	const listeners = new Set<() => void>();

	function apply(event: ConnectionEvent): void {
		if (disposed) return;
		const before = connectionStatusOf(state, threshold);
		const next = nextConnectionState(state, event);
		if (next === state) return;
		state = next;
		if (before !== 'online' && connectionStatusOf(next, threshold) === 'online') {
			recoveries += 1;
			for (const listener of [...listeners]) listener();
		}
	}

	const onOnline = (): void => apply({ type: 'browserOnline', at: now() });
	const onOffline = (): void => apply({ type: 'browserOffline', at: now() });
	target?.addEventListener('online', onOnline);
	target?.addEventListener('offline', onOffline);

	return {
		get status() {
			return connectionStatusOf(state, threshold);
		},
		get state() {
			return state;
		},
		get recoveries() {
			return recoveries;
		},
		reportRequest: (result) => apply({ type: 'request', result, at: now() }),
		reportStreamDisconnected: () => apply({ type: 'streamDisconnected', at: now() }),
		reportStreamReconnected: () => apply({ type: 'streamReconnected', at: now() }),
		onRecovered(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			target?.removeEventListener('online', onOnline);
			target?.removeEventListener('offline', onOffline);
		}
	};
}
