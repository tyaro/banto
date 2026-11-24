/**
 * `EventProvider` (spec §3.5): server -> client change notifications.
 * Exactly two event kinds ship in v1 - mirrors
 * `crates/banto-server/src/events.rs::ServerEvent` field-for-field (`kind`
 * tag, snake_case variant names) so the wire shape needs no translation.
 *
 * Two implementations, picked by environment the same way `DataProvider` is
 * (`setup.ts`'s three-way detection):
 * - `createTauriEventProvider`: Webview only, no network - relays Tauri's
 *   `banto://event` events (emitted by `src-tauri`'s broadcast-forwarding
 *   task).
 * - `createSseEventProvider`: LAN browser - reads `GET /api/events` itself
 *   (see sse-parser.ts for why not `EventSource`).
 *
 * `connectEvents` is the one bridge either implementation is wired through
 * into the rest of admin-core: resource-changed -> `invalidate`, notice ->
 * `notify`.
 */
import { invalidate, invalidateAll } from './invalidate';
import { notify } from './registry.svelte';
import type { NotificationKind } from './provider';
import { createSseStream } from './sse-stream';
import { getSessionController } from './sessionController.svelte';

export type AppEvent =
	| { kind: 'resource_changed'; resource: string }
	| { kind: 'notice'; level: string; message: string };

/**
 * Optional callbacks for things that happen to the subscription itself
 * rather than events it carries (Issue #241).
 */
export interface EventSubscriptionHooks {
	/**
	 * The server rejected the stream's session (`/api/events` answered
	 * `401`): the session is no longer valid. Called once per rejected token;
	 * the provider stops reconnecting with that token and resumes only when a
	 * different token appears (a new login). `connectEvents` wires this to
	 * `getSessionController().signal('unauthorized')`.
	 */
	onUnauthorized?: () => void;
	/**
	 * The token this stream was using disappeared from storage without this
	 * stream being rejected - typically another tab sharing the "Remember me"
	 * token (localStorage) confirmed the revocation and cleared it first
	 * (review of #242). Called once per disappearance, and only for a token
	 * this stream had actually used: the first wait before any login and a
	 * new login replacing the token are not disappearances. `connectEvents`
	 * wires this to `getSessionController().signal('credentialCleared')`.
	 */
	onTokenCleared?: () => void;
	/**
	 * The stream was re-established after an earlier connection of the same
	 * session had been lost (Issue #289). Broadcast events are not replayed,
	 * so changes made while disconnected were never delivered: the consumer
	 * must re-read what it shows. Called once per successful reconnect, never
	 * for the first connection, nor for the first connection after a `401` /
	 * cleared token / new login (a new session loads its data itself).
	 * `connectEvents` wires this to `invalidateAll()`.
	 */
	onReconnected?: () => void;
	/**
	 * An established stream was lost (Issue #637): it ended or failed while
	 * its token was still the stored one. Called once per lost stream - the
	 * failed reconnect attempts that follow are not reported again - and
	 * never for a stream this provider ended itself (unsubscribe, a token
	 * switch), a `401`, a logout (the token is gone), or a first connection
	 * that never opened. Paired with `onReconnected` when the same session's
	 * stream comes back; a different session's first stream does not call
	 * `onReconnected`, so a listener must also accept other evidence of
	 * recovery (`createConnectionMonitor` takes a request's answer).
	 */
	onDisconnected?: () => void;
}

/** What `connectEvents` tells about the stream itself (Issue #637); `ConnectionMonitor` implements it. */
export interface StreamConnectionListener {
	reportStreamDisconnected(): void;
	reportStreamReconnected(): void;
}

/** Backend-agnostic subscription to `AppEvent`s. Returns an unsubscribe function. */
export interface EventProvider {
	subscribe(handler: (event: AppEvent) => void, hooks?: EventSubscriptionHooks): () => void;
}

function isAppEvent(value: unknown): value is AppEvent {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return kind === 'resource_changed' || kind === 'notice';
}

export interface TauriEventListenOptions {
	/**
	 * Injected so this module has no `@tauri-apps/api` dependency of its own
	 * (same pattern as `providers/tauri.ts`'s injected `invoke`). Pass
	 * `@tauri-apps/api/event`'s `listen`.
	 */
	listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
}

const TAURI_EVENT_NAME = 'banto://event';

/**
 * `EventProvider` for the Tauri webview: listens on the `banto://event`
 * Tauri event, which `src-tauri`'s setup forwards from its
 * `broadcast::Sender<ServerEvent>` (the same channel the REST/SSE side
 * uses) via `app_handle.emit(...)`.
 */
export function createTauriEventProvider(options: TauriEventListenOptions): EventProvider {
	return {
		subscribe(handler: (event: AppEvent) => void): () => void {
			let disposed = false;
			let unlisten: (() => void) | null = null;

			options
				.listen(TAURI_EVENT_NAME, (e) => {
					if (isAppEvent(e.payload)) handler(e.payload);
				})
				.then((fn) => {
					// subscribe()'s caller may have already unsubscribed before the
					// async `listen()` call resolved - tear down immediately rather
					// than leaking a live Tauri listener.
					if (disposed) fn();
					else unlisten = fn;
				});

			return () => {
				disposed = true;
				unlisten?.();
			};
		}
	};
}

export interface SseEventProviderOptions {
	baseUrl?: string;
	getToken: () => string | null;
	fetchFn?: typeof fetch;
	/** Delay before reconnecting after a stream ends/fails. Default 3000. */
	reconnectDelayMs?: number;
	/**
	 * Poll interval while `getToken()` is still null (user not logged in
	 * yet). Kept much shorter than `reconnectDelayMs` so the stream opens
	 * almost immediately after login - broadcast events are not replayed,
	 * so every second of gap between login and the stream opening is a
	 * window where another client's change would be silently missed until
	 * the next event. Default 500.
	 */
	tokenWaitDelayMs?: number;
}

/**
 * `EventProvider` for a LAN browser client: reads `GET /api/events`
 * (spec §11.3) with `createSseStream` (sse-stream.ts, Issue #936) - `fetch`
 * + a `ReadableStream` reader (not `EventSource`, see sse-parser.ts's doc
 * comment for why), auto-reconnecting on disconnect/error. While
 * `getToken()` returns `null` (not logged in yet), connecting is skipped and
 * retried after `tokenWaitDelayMs` instead of failing loudly - the same
 * token is shared with `HttpDataProvider`/`HttpAuthProvider`.
 *
 * The reconnect policy (Issue #241: `401`, a cleared token, any other
 * failure; Issue #591: a new login's token while a stream is open) is
 * `createSseStream`'s - see its doc comment. It was moved there unchanged:
 * the hooks are called at the same moments and the same number of times as
 * before. What `createSseStream` adds on top (design §5.2.1) also applies
 * here: an answer or a frame that arrives after the token changed is
 * dropped instead of being handed to the next session. This provider passes
 * neither `onSessionChange`, `onForbidden` nor the stale options
 * (`/api/events` carries "something changed" notices, not displayed values,
 * and never answers `403`).
 */
export function createSseEventProvider(options: SseEventProviderOptions): EventProvider {
	const fetchFn = options.fetchFn ?? fetch;

	return {
		subscribe(handler: (event: AppEvent) => void, hooks?: EventSubscriptionHooks): () => void {
			return createSseStream<AppEvent>({
				path: '/api/events',
				baseUrl: options.baseUrl,
				fetchFn,
				getToken: () => options.getToken(),
				reconnectDelayMs: options.reconnectDelayMs,
				tokenWaitDelayMs: options.tokenWaitDelayMs,
				// `/api/events` names no events; a name would be ignored as before.
				parse: (data) => {
					const parsed: unknown = JSON.parse(data);
					return isAppEvent(parsed) ? parsed : null;
				},
				onEvent: handler,
				onUnauthorized: () => hooks?.onUnauthorized?.(),
				onTokenCleared: () => hooks?.onTokenCleared?.(),
				onReconnected: () => hooks?.onReconnected?.(),
				onDisconnected: () => hooks?.onDisconnected?.()
			});
		}
	};
}

/**
 * The two hooks that tell the default `SessionController` that a stream's
 * session is over (Issue #936, design §5.4): spread them into
 * `createSseStream`'s options.
 *
 * ```ts
 * createSseStream({ path: '/api/app/values', ..., ...sessionStreamHooks() });
 * ```
 *
 * They are the same two signals `connectEvents` sends for `/api/events`
 * (`signal('unauthorized')` / `signal('credentialCleared')`; the controller
 * then confirms with a probe, ADR-0014). A screen that reads an app stream
 * WITHOUT `/api/events` open must pass them, or a revoked session goes
 * unnoticed; passing them next to `/api/events` is harmless. The contract
 * when two streams report the same revocation: at most ONE confirmation is
 * in flight and the session ends ONCE - not "one request in total". A signal
 * means "an answer that started before now may be out of date", so the
 * second signal aborts the confirmation the first one started and starts
 * its own: N streams cost up to N `GET /api/auth/identity` in a row, of
 * which only the last is used. `createSseStream` itself stays unaware of
 * the controller (conventions §4/§5).
 */
export function sessionStreamHooks(): Pick<
	EventSubscriptionHooks,
	'onUnauthorized' | 'onTokenCleared'
> {
	return {
		onUnauthorized: () => getSessionController().signal('unauthorized'),
		onTokenCleared: () => getSessionController().signal('credentialCleared')
	};
}

// Keep in sync with the `NotificationKind` union in provider.ts: a `notice`
// event's `level` maps to the kind when it is one of these, else `'info'`.
const NOTIFICATION_KINDS = new Set<NotificationKind>(['success', 'error', 'info', 'warning']);

function toNotificationKind(level: string): NotificationKind {
	return NOTIFICATION_KINDS.has(level as NotificationKind) ? (level as NotificationKind) : 'info';
}

/**
 * Bridge an `EventProvider` into the rest of admin-core (spec §3.5):
 * `resource_changed` -> `invalidate(resource)` (so `ListResource`/
 * `WindowedListResource` subscribers refetch); `notice` -> `notify(...)`
 * (falls back to `'info'` for an unrecognized `level`). A stream the server
 * rejected (`onUnauthorized`, Issue #241) or whose token another tab cleared
 * (`onTokenCleared`) is a signal to the default `SessionController`
 * (Issue #260 実装-3, design §6.1): `signal('unauthorized')` /
 * `signal('credentialCleared')`. The controller confirms the session with a
 * probe started after the signal (`AuthProvider.resolve()`, which clears a
 * revoked token) and, while the server cannot verify, retries with backoff
 * until it knows; a confirmed `none` moves the generation, which the app's
 * protected layout turns into a re-run of its route guard (wiring ①). The
 * stream itself stays stopped for a rejected token. Returns an unsubscribe
 * function (the controller's background confirmation is not tied to it).
 *
 * `options.connection` (Issue #637, e.g. a `createConnectionMonitor()`)
 * hears the stream's loss and its same-session return; the bridge itself
 * knows nothing more about it.
 */
export function connectEvents(
	provider: EventProvider,
	options?: { connection?: StreamConnectionListener }
): () => void {
	const connection = options?.connection;
	const unsubscribe = provider.subscribe(
		(event) => {
			if (event.kind === 'resource_changed') {
				invalidate(event.resource);
			} else {
				notify(toNotificationKind(event.level), event.message);
			}
		},
		{
			...sessionStreamHooks(),
			// Issue #289: a reconnect cannot recover what was broadcast while
			// the stream was down, so re-read every subscribed resource once
			// (same path as `resource_changed`). Not for an ended session.
			onReconnected: () => {
				connection?.reportStreamReconnected();
				if (getSessionController().snapshot.status !== 'none') invalidateAll();
			},
			onDisconnected: () => connection?.reportStreamDisconnected()
		}
	);
	return unsubscribe;
}
