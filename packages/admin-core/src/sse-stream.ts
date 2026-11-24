/**
 * `createSseStream<T>`: the generic reader for a server-sent-events stream
 * of the app's own (Issue #936, docs/design/sse-stream-design.md §5; the
 * server half is `banto_server::sse`, #935).
 *
 * It is the reconnect/session rules of `/api/events` (`createSseEventProvider`
 * in events.ts, which now runs on top of this) made reusable for any path:
 * `fetch` + a `ReadableStream` reader (not `EventSource`, see sse-parser.ts),
 * the `Authorization` + `X-Banto-Client` headers on every request, and the
 * same handling of a `401`, a cleared token, a new login and a lost stream.
 * On top of those it adds what a stream of *displayed values* needs and a
 * stream of "something changed" notices did not:
 *
 * - an owner check before every callback, so that a response or a frame of
 *   the previous session is never handed to the next one (§5.2.1);
 * - `onSessionChange` / `onForbidden`, the two moments at which the caller
 *   must drop the values it shows (§5.2.1, §5.2.2);
 * - `staleAfterMs` / `onStale` / `valueStamp`, to tell "the producer stopped"
 *   apart from "the connection came back" (§5.5).
 *
 * This module knows nothing about the session controller, the connection
 * monitor or any app (conventions §4/§5): wiring is the caller's
 * (`sessionStreamHooks()` in events.ts is the two-line helper for the
 * session side). It holds no user-facing text (conventions §13).
 */
import { createSseMessageParser, type SseMessage } from './sse-parser';

/** Options of `createSseStream` (Issue #936, design §5.2). */
export interface SseStreamOptions<T> {
	/**
	 * The path appended to `baseUrl`. Must start with a single `/`, and
	 * `baseUrl + path`, once RESOLVED the way `fetch` resolves it, must stay
	 * on the origin of `baseUrl` (of the page, when `baseUrl` is empty).
	 * Anything else throws a `TypeError` before any request is made: the
	 * bearer token is sent to this URL, so it must not be able to name another
	 * host - including through what URL parsing removes (a tab or a newline
	 * between two slashes still makes `//host/x` to a browser). Never put a
	 * token or any other secret in its query string (conventions §6).
	 * `fetchFn` is given the resolved, absolute URL that passed this check
	 * (the text itself only where there is no page to resolve against).
	 */
	path: string;
	/**
	 * Origin of the server, without a trailing slash. Default `''` (same
	 * origin). It is the origin the bearer token may be sent to; a value that
	 * does not parse as a URL with a host throws a `TypeError`.
	 */
	baseUrl?: string;
	/** Default: the global `fetch`. */
	fetchFn?: typeof fetch;
	/** The stored bearer token, or `null` while not logged in. Read often (a local read). */
	getToken: () => string | null;
	/**
	 * Turn one event into a value: `data` is the `data:` payload, `event` the
	 * `event:` name (`undefined` if none). Returning `null` or throwing drops
	 * that one event; the connection stays open.
	 */
	parse: (data: string, event: string | undefined) => T | null;
	/**
	 * A value of the CURRENT session arrived. An exception thrown here is
	 * swallowed (it must not tear down the connection), same as the handler
	 * of `createSseEventProvider`.
	 */
	onEvent: (value: T) => void;
	/**
	 * The session this stream was reading has ended or was replaced: a `401`,
	 * the token disappearing, or a different token appearing. Called once per
	 * change, always before the first `onEvent` of the next session, and
	 * noticed within `tokenWaitDelayMs` while a stream is open. The caller
	 * MUST invalidate every value it received from this stream and still
	 * shows or caches (the owner check only stops values that have not been
	 * delivered yet; a value already on screen is out of this reader's
	 * reach). Not called when the stream is stopped, nor for a disconnect and
	 * reconnect under the same token.
	 */
	onSessionChange?: () => void;
	/**
	 * The open request was refused with `403` while the token is still this
	 * stream's own: the permission is missing or was taken away
	 * (`SseContext::require_permission`, design §5.2.2). Called once on
	 * entering the refused state, not again for the `403`s of the retries
	 * that follow. The caller MUST invalidate the values it shows from this
	 * stream, exactly as for `onSessionChange` (the session did not change,
	 * so `onSessionChange` is NOT called), and may show "no permission".
	 * When the permission returns, the stream opens and the current value
	 * arrives through `onEvent` again. Do not read a permission-guarded
	 * stream without this hook.
	 */
	onForbidden?: () => void;
	/**
	 * Delay before retrying after a `403`. Default: `reconnectDelayMs`. Every
	 * refused retry is one `denied` line in the server's audit log, so a
	 * permission-guarded stream should pass something longer (about 30 s).
	 */
	forbiddenRetryDelayMs?: number;
	/**
	 * `true`: a stream opened. `false`: a stream that had opened ended, for
	 * whatever reason (lost, closed by the server, replaced by a new login's
	 * stream). Never called after the stream is stopped.
	 */
	onConnection?: (connected: boolean) => void;
	/** Same meaning and same number of calls as `EventSubscriptionHooks.onUnauthorized`. */
	onUnauthorized?: () => void;
	/** Same meaning and same number of calls as `EventSubscriptionHooks.onTokenCleared`. */
	onTokenCleared?: () => void;
	/** Same meaning and same number of calls as `EventSubscriptionHooks.onReconnected`. */
	onReconnected?: () => void;
	/** Same meaning and same number of calls as `EventSubscriptionHooks.onDisconnected`. */
	onDisconnected?: () => void;
	/**
	 * When set, `onStale(true)` is called once when this long has passed
	 * since the last NEW value (or since the stream first opened, if none
	 * came), and `onStale(false)` at the next new value (design §5.5). The
	 * clock keeps running across disconnects, reconnects, session changes and
	 * `403`s - how old a value is has nothing to do with the connection - and
	 * reconnecting alone never clears it. Rule of thumb: three times the
	 * producer's period. Not set: no timer is created and `onStale` is never
	 * called.
	 */
	staleAfterMs?: number;
	/** See `staleAfterMs`. `onStale(false)` is called right after the `onEvent` of the value that ended it. */
	onStale?: (stale: boolean) => void;
	/**
	 * The producer's mark on a value (e.g. the time the producer made it).
	 * When given, only a value whose mark differs from the last one seen
	 * under the same `event` name counts as NEW: the value a `watch_frames`
	 * stream re-sends on every reconnect does not clear `onStale`. (It is
	 * still passed to `onEvent`.) When omitted, every value counts as new,
	 * and `onStale` then only says "nothing is being received" - it does NOT
	 * vouch for freshness, since a reconnect's re-sent value clears it. The
	 * first value after the stream is created has nothing to compare with
	 * and always counts as new. Marks are compared with `Object.is`; they are
	 * kept across session changes. Only called when `staleAfterMs` is set.
	 */
	valueStamp?: (value: T, event: string | undefined) => string | number;
	/** Delay before reconnecting after a stream ends/fails. Default 3000. */
	reconnectDelayMs?: number;
	/**
	 * Poll interval for the token: while waiting for a login, and while a
	 * stream is open (to notice a new login's token). Default 500.
	 */
	tokenWaitDelayMs?: number;
}

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_TOKEN_WAIT_DELAY_MS = 500;
const SSE_HEADERS = { 'X-Banto-Client': 'banto' } as const;

/**
 * Stands in for the page's origin where there is none (tests, SSR). How a
 * path-only reference resolves does not depend on WHICH http(s) origin it is
 * resolved against, so "stays on this origin" answers the question for any.
 */
const PLACEHOLDER_ORIGIN = 'http://banto.invalid';

/**
 * The URL to request: `baseUrl + path`, refused (`TypeError`) unless it
 * resolves to the origin the bearer token is meant for. The comparison is
 * made on the PARSED URL (WHATWG URL Standard - what `fetch` does with the
 * string), not on the text: parsing drops tabs and newlines and reads a
 * backslash as `/`, so a path can name another host although its text
 * starts with a single `/`.
 *
 * What is returned is the URL that was CHECKED, as an absolute URL, so that
 * `fetch` does not resolve the text a second time: it would do so against
 * the document's base URL, which a `<base href>` can point at another origin
 * than `location.origin`. Only where there is nothing to resolve against (no
 * page and a `baseUrl` that is not absolute: tests, SSR) the text is returned
 * as it is - there is no document base to disagree with there.
 */
function resolveStreamUrl(baseUrl: string, path: string): string {
	const refuse = (): never => {
		throw new TypeError(
			'createSseStream: `path` must start with a single "/" and stay on the origin of `baseUrl`'
		);
	};
	if (!path.startsWith('/') || path[1] === '/' || path[1] === '\\') refuse();
	const pageOrigin = (globalThis as { location?: { origin?: string } }).location?.origin;
	const hasPage = typeof pageOrigin === 'string' && pageOrigin !== '' && pageOrigin !== 'null';
	const fallback = hasPage ? pageOrigin : PLACEHOLDER_ORIGIN;
	const url = `${baseUrl}${path}`;
	let allowed: URL;
	let target: URL;
	try {
		// A `baseUrl` that is itself only a path (or empty) is on the page's origin.
		allowed = new URL(baseUrl === '' ? '/' : baseUrl, fallback);
		target = new URL(url, fallback);
	} catch {
		return refuse();
	}
	// `origin` is the string "null" for a non-http(s) scheme (a webview's
	// custom one), which would compare equal for any two hosts: compare the
	// parts. No user/password either (`fetch` refuses those anyway).
	if (
		allowed.host === '' ||
		target.protocol !== allowed.protocol ||
		target.host !== allowed.host ||
		target.username !== '' ||
		target.password !== ''
	) {
		refuse();
	}
	return hasPage || isAbsoluteUrl(baseUrl) ? target.href : url;
}

function isAbsoluteUrl(text: string): boolean {
	try {
		new URL(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read a server-sent-events stream at `options.path`, reconnecting for as
 * long as it is not stopped. Starts reading at once; returns the function
 * that stops it (nothing is called after that).
 *
 * While `getToken()` returns `null` (not logged in yet), connecting is
 * skipped and retried after `tokenWaitDelayMs` instead of failing loudly.
 *
 * Reconnect policy (Issue #241; moved here unchanged from
 * `createSseEventProvider`). Because the stream is read with `fetch`, the
 * HTTP status of every (re)connect is visible:
 * - `401`: the server's `require_auth` CONFIRMED the session invalid (a
 *   revoked, expired or logged-out token - a failed account lookup is a
 *   `500`, never a `401`, ADR-0014). Retrying with the same token can never
 *   succeed, so the stream stops using it: no more requests until
 *   `getToken()` returns a different token (a new login; the check is a
 *   local read, same as the not-logged-in wait). `onUnauthorized` is called
 *   once so the app can run its route guard.
 * - the token it had been using is gone from storage at the next
 *   (re)connect, without a `401` here: another tab sharing the "Remember
 *   me" token already confirmed the revocation and cleared it.
 *   `onTokenCleared` is called once so this tab confirms too (review of
 *   #242). Never for the wait before the first login.
 * - `403` (Issue #936): refused, see `onForbidden`. Retries after
 *   `forbiddenRetryDelayMs`.
 * - any other failure (`500`, `503`, a network error, the stream ending -
 *   e.g. the server's periodic revalidation closing it): the session could
 *   not be verified or the stream simply ended, so reconnect after
 *   `reconnectDelayMs`. A revoked session's stream ends on the server's next
 *   revalidation, and the reconnect then gets the `401`.
 * - `getToken()` returns a different non-null token while a stream is open
 *   (a login in this tab, e.g. from the public viewer's synthetic session,
 *   Issue #591): the stream is reopened at once with the new token, so the
 *   new session's revocation reaches it like any other (the server keeps a
 *   stream open as long as its OWN token stays valid).
 *
 * Owner check (Issue #936, design §5.2.1). Every connection attempt has a
 * generation and the token it was sent with. Each time a wait ends (the
 * `fetch` answering, every `reader.read()`), and before each value when one
 * read carries several, the attempt checks that it is still the one in
 * charge: not stopped, its generation is the current one, and `getToken()`
 * still returns its token. If not, the response or frame is DROPPED (the
 * body is cancelled) and no callback is called for it:
 * - a late `200` opens nothing (`onConnection(true)`/`onEvent` are not called);
 * - a late `401` is the previous session's: `onUnauthorized` is not called
 *   and the token now stored is not marked rejected - the stream reconnects
 *   with it at once (or, if the token is gone, reports `onTokenCleared`
 *   through the usual path);
 * - a frame read between a token change and the next tick of the token
 *   watch is dropped, and so is the rest of a read after an `onEvent` that
 *   changed the token.
 * The same check is repeated every time code of the caller returns (`parse`,
 * `valueStamp`, `onEvent` and every hook): what that code did - stop the
 * stream, log in, log out - decides whether the step that follows still
 * belongs to this attempt. If it does not, nothing more is done for the old
 * attempt: the value is not delivered, its mark and the stale clock are not
 * updated, a `401` is not reported through `onUnauthorized`, and the stream
 * is reopened for whatever token is stored now.
 * A stream that ENDS (the server closing it, a network error) is checked
 * too: if the token is no longer this attempt's, `onSessionChange` is called
 * then, not at the next attempt, and the stream reconnects at once with a
 * new token (after `tokenWaitDelayMs` if there is none).
 * The check is a synchronous comparison; it adds no timer.
 */
export function createSseStream<T>(options: SseStreamOptions<T>): () => void {
	// Checked once, before anything else: no request (and so no bearer token)
	// is ever made for a URL that failed it.
	const url = resolveStreamUrl(options.baseUrl ?? '', options.path);
	const fetchFn = options.fetchFn ?? fetch;
	const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	const tokenWaitDelayMs = options.tokenWaitDelayMs ?? DEFAULT_TOKEN_WAIT_DELAY_MS;
	const forbiddenRetryDelayMs = options.forbiddenRetryDelayMs ?? reconnectDelayMs;
	const { staleAfterMs } = options;

	let stopped = false;
	let controller: AbortController | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	// Design §5.2.1: the number of the connection attempt in charge.
	let generation = 0;
	// The last token the server answered `401` for (see the doc comment
	// above): never sent again.
	let rejectedToken: string | null = null;
	// The token this stream last connected with, while it is still the
	// one to watch for disappearing (`onTokenCleared`). Reset on a `401`,
	// whose own path (`onUnauthorized`) already covers that token.
	let usedToken: string | null = null;
	// The token of the session the caller may hold values of: set when a
	// token is put to use and at every delivery, cleared when
	// `onSessionChange` reports its end (so each end is reported once).
	let sessionToken: string | null = null;
	// A stream of the current session has been established before, so the
	// next successful connect is a reconnect (Issue #289). Reset whenever
	// the session ends or changes (401, cleared token, different token).
	let hasConnected = false;
	// Design §5.2.2: the last open request of this session was a `403`
	// (`onForbidden` has been called and is not called again until it leaves).
	let forbidden = false;
	// Issue #591: the open stream's watch for a new login's token, and
	// whether it aborted the stream for that (reconnect at once).
	let tokenWatch: ReturnType<typeof setInterval> | null = null;
	let switchedToken = false;
	// Design §5.5: the stale clock (armed when a stream first opens), whether
	// `onStale(true)` is the last thing said, and the last mark per name.
	let staleTimer: ReturnType<typeof setTimeout> | null = null;
	let staleArmed = false;
	let stale = false;
	const stamps = new Map<string | undefined, string | number>();

	/** The session the caller may hold values of is over (design §5.2.1). */
	function endSession(): void {
		forbidden = false;
		if (sessionToken === null) return;
		sessionToken = null;
		if (!stopped) options.onSessionChange?.();
	}

	function armStaleTimer(): void {
		if (staleAfterMs === undefined || stopped) return;
		if (staleTimer !== null) clearTimeout(staleTimer);
		staleTimer = setTimeout(() => {
			staleTimer = null;
			stale = true;
			options.onStale?.(true);
		}, staleAfterMs);
	}

	/**
	 * Hand one event to the caller. `mine` is the attempt's owner check
	 * (design §5.2.1): the caller made it just before, and it is made again
	 * here every time code of the app returns, because that code may have
	 * stopped the stream or changed the session. Returns `false` when the
	 * attempt is no longer the one in charge; nothing of this event is kept
	 * then that was not already handed over (no value, no mark, no clock).
	 */
	function deliver(message: SseMessage, token: string, mine: () => boolean): boolean {
		let value: T;
		const useStamp = staleAfterMs !== undefined && options.valueStamp !== undefined;
		let stamp: string | number | undefined;
		try {
			const parsed = options.parse(message.data, message.event);
			if (!mine()) return false;
			if (parsed === null) return true;
			value = parsed;
			if (useStamp) {
				stamp = options.valueStamp!(value, message.event);
				if (!mine()) return false;
			}
		} catch {
			// Malformed payload (should not happen against banto-server):
			// ignore rather than tear down the whole connection over it.
			return mine();
		}
		sessionToken = token;
		try {
			options.onEvent(value);
		} catch {
			// A throwing consumer must not tear down the connection either.
		}
		// The value was this session's and has been delivered, but if `onEvent`
		// ended the session (or stopped the stream), its freshness is not the
		// next session's to be told about: the mark is not remembered either,
		// so the same value re-sent to the next session counts as new there.
		if (!mine()) return false;
		if (staleAfterMs === undefined) return true;
		if (useStamp) {
			const event = message.event;
			if (stamps.has(event) && Object.is(stamps.get(event), stamp)) return true;
			stamps.set(event, stamp as string | number);
		}
		armStaleTimer();
		if (stale) {
			stale = false;
			options.onStale?.(false);
			return mine();
		}
		return true;
	}

	function scheduleReconnect(delayMs: number = reconnectDelayMs): void {
		if (stopped) return;
		timer = setTimeout(() => void connectOnce(), delayMs);
	}

	/**
	 * After dropping a response/frame that was not this session's any more
	 * (a no-op when the stream was stopped): the session is over for the
	 * caller now, without waiting for the next attempt to notice. A
	 * different token is a new login (connect with it at once, like the
	 * token watch does); a missing one goes through the token wait, whose
	 * next turn reports `onTokenCleared`.
	 */
	function dropStale(): void {
		endSession();
		reopen();
	}

	/** Connect again for whatever token is stored NOW (read after the callbacks). */
	function reopen(): void {
		scheduleReconnect(options.getToken() === null ? tokenWaitDelayMs : 0);
	}

	async function connectOnce(): Promise<void> {
		const attempt = ++generation;
		const token = options.getToken();
		/**
		 * Design §5.2.1: is this attempt still the one in charge? Asked after
		 * every wait AND every time a callback of the caller returns.
		 */
		const mine = (): boolean => !stopped && generation === attempt && options.getToken() === token;

		if (token === null && usedToken !== null) {
			usedToken = null;
			hasConnected = false;
			endSession();
			// `onSessionChange` may have logged in again: the cleared token is
			// then not the current state any more, and is not reported.
			if (mine()) options.onTokenCleared?.();
			if (!stopped && !mine()) {
				reopen();
				return;
			}
		}
		if (token === null || token === rejectedToken) {
			scheduleReconnect(tokenWaitDelayMs);
			return;
		}
		if (usedToken !== null && usedToken !== token) {
			hasConnected = false; // a new login
			endSession();
			if (!mine()) {
				// Stopped, or the token changed again inside `onSessionChange`
				// (`usedToken` is left as it was, so the next attempt sees it).
				reopen();
				return;
			}
		}
		usedToken = token;
		sessionToken = token;

		const attemptController = new AbortController();
		controller = attemptController;
		// Issue #637: this attempt opened a stream (so its end is a loss).
		let established = false;
		// Design §5.2.1: this attempt gave up a response/frame that was not its
		// session's any more.
		let dropped = false;
		try {
			const response = await fetchFn(url, {
				headers: { ...SSE_HEADERS, Authorization: `Bearer ${token}` },
				signal: attemptController.signal
			});
			if (!mine()) {
				// A late answer (stopped, or the token changed while waiting):
				// whatever its status, it is not this session's to act on.
				void response.body?.cancel().catch(() => {});
				dropStale();
				return;
			}
			if (response.status === 401) {
				void response.body?.cancel().catch(() => {});
				rejectedToken = token;
				hasConnected = false;
				endSession();
				if (!mine()) {
					// `onSessionChange` stopped the stream or changed the token:
					// this `401` is the previous session's now, and must not
					// reach the session controller as the new one's. `usedToken`
					// is left set, so a token that was cleared (not replaced)
					// still gets its `onTokenCleared` at the next attempt.
					reopen();
					return;
				}
				usedToken = null;
				options.onUnauthorized?.();
				scheduleReconnect(tokenWaitDelayMs);
				return;
			}
			if (response.status === 403) {
				void response.body?.cancel().catch(() => {});
				if (!forbidden) {
					forbidden = true;
					options.onForbidden?.();
					if (!mine()) {
						// The session changed inside `onForbidden`: do not sit out
						// the (long) refused delay on the previous session's answer.
						dropStale();
						return;
					}
				}
				scheduleReconnect(forbiddenRetryDelayMs);
				return;
			}
			if (!response.ok || !response.body) {
				scheduleReconnect();
				return;
			}

			// Reconnected: re-sync once, only while this token is still the live
			// one (a logout/user switch during the fetch must not refresh the old
			// session's view). Failed attempts never reach here, so repeated
			// failures cause no requests; one successful connect = one re-sync.
			const wasReconnect = hasConnected;
			hasConnected = true;
			established = true;
			forbidden = false;
			if (!staleArmed) {
				// Opened but nothing ever arrives also counts as "stopped".
				staleArmed = true;
				armStaleTimer();
			}
			options.onConnection?.(true);
			if (wasReconnect && mine()) options.onReconnected?.();
			if (!mine()) {
				// Stopped or the session changed inside those two hooks: read
				// nothing from this body (the end of this function reports it).
				dropped = true;
				void response.body.cancel().catch(() => {});
				throw new DOMException('not this attempt', 'AbortError');
			}

			// Issue #591: a login in this tab while the stream is open (the
			// public viewer's synthetic session -> a real account) replaces
			// the token without ending the stream, and the server never ends
			// a stream whose own token is still valid. Left alone, the stream
			// would stay on the previous token - the new session's
			// revocation would never reach it (no `401`). So while streaming,
			// watch for a DIFFERENT non-null token and reopen with it at once.
			// A cleared token (`null`) ends the session for the caller
			// (`onSessionChange`) but the stream itself is left to the existing
			// paths: the server ends a logged-out token's stream at its next
			// re-check, and the reconnect then reports `onTokenCleared`.
			tokenWatch = setInterval(() => {
				if (options.getToken() === token) return;
				endSession();
				// Read again: `onSessionChange` may have stopped the stream or
				// changed the token once more.
				const current = options.getToken();
				if (stopped || current === null || current === token) return;
				switchedToken = true;
				attemptController.abort();
			}, tokenWaitDelayMs);

			const parser = createSseMessageParser();
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			while (!stopped && !dropped) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!mine()) {
					dropped = true;
					break;
				}
				for (const message of parser.push(decoder.decode(value, { stream: true }))) {
					// Checked per value: the `onEvent` of the one before may have
					// changed the token or stopped the stream.
					if (!mine()) {
						dropped = true;
						break;
					}
					// ... and again inside, after each callback of the caller.
					if (!deliver(message, token, mine)) {
						dropped = true;
						break;
					}
				}
			}
			if (dropped) {
				void reader.cancel().catch(() => {});
				attemptController.abort();
			}
		} catch {
			// Network failure or abort() from unsubscribe / a token switch -
			// fall through to the reconnect scheduling below (a no-op if
			// stopped).
		} finally {
			if (tokenWatch !== null) clearInterval(tokenWatch);
			tokenWatch = null;
		}
		if (established && !stopped) options.onConnection?.(false);
		if (switchedToken) {
			switchedToken = false;
			scheduleReconnect(0);
			return;
		}
		// Design §5.2.1: the stream ended (EOF, a network error, a failed
		// `fetch`) and the token is not this attempt's any more - the values
		// the caller shows are the previous session's NOW, not at the next
		// attempt. Same handling as a dropped frame.
		if (dropped || !mine()) {
			dropStale();
			return;
		}
		// Issue #637: report the loss of an open stream once, unless this
		// stream ended it (stopped) or the session it belonged to is gone
		// (handled just above).
		if (established) options.onDisconnected?.();
		if (!stopped && !mine()) {
			dropStale();
			return;
		}
		scheduleReconnect();
	}

	void connectOnce();

	return () => {
		stopped = true;
		if (timer !== null) clearTimeout(timer);
		if (tokenWatch !== null) clearInterval(tokenWatch);
		if (staleTimer !== null) clearTimeout(staleTimer);
		controller?.abort();
	};
}
