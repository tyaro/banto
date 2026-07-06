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
import { invalidate } from './invalidate';
import { notify } from './registry.svelte';
import type { NotificationKind } from './provider';
import { createSseParser } from './sse-parser';

export type AppEvent =
	| { kind: 'resource_changed'; resource: string }
	| { kind: 'notice'; level: string; message: string };

/** Backend-agnostic subscription to `AppEvent`s. Returns an unsubscribe function. */
export interface EventProvider {
	subscribe(handler: (event: AppEvent) => void): () => void;
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

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_TOKEN_WAIT_DELAY_MS = 500;
const SSE_HEADERS = { 'X-Banto-Client': 'banto' } as const;

/**
 * `EventProvider` for a LAN browser client: connects to `GET /api/events`
 * (spec §11.3) via `fetch` + a `ReadableStream` reader (not `EventSource`,
 * see sse-parser.ts's doc comment for why), auto-reconnecting on
 * disconnect/error. While `getToken()` returns `null` (not logged in yet),
 * connecting is skipped and retried after `reconnectDelayMs` instead of
 * failing loudly - the same token is shared with `HttpDataProvider`/
 * `HttpAuthProvider`.
 */
export function createSseEventProvider(options: SseEventProviderOptions): EventProvider {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;
	const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	const tokenWaitDelayMs = options.tokenWaitDelayMs ?? DEFAULT_TOKEN_WAIT_DELAY_MS;

	return {
		subscribe(handler: (event: AppEvent) => void): () => void {
			let stopped = false;
			let controller: AbortController | null = null;
			let timer: ReturnType<typeof setTimeout> | null = null;

			function dispatch(payload: string): void {
				try {
					const parsed: unknown = JSON.parse(payload);
					if (isAppEvent(parsed)) handler(parsed);
				} catch {
					// Malformed payload (should not happen against banto-server):
					// ignore rather than tear down the whole connection over it.
				}
			}

			function scheduleReconnect(delayMs: number = reconnectDelayMs): void {
				if (stopped) return;
				timer = setTimeout(() => void connectOnce(), delayMs);
			}

			async function connectOnce(): Promise<void> {
				const token = options.getToken();
				if (token === null) {
					scheduleReconnect(tokenWaitDelayMs);
					return;
				}

				controller = new AbortController();
				try {
					const response = await fetchFn(`${baseUrl}/api/events`, {
						headers: { ...SSE_HEADERS, Authorization: `Bearer ${token}` },
						signal: controller.signal
					});
					if (!response.ok || !response.body) {
						scheduleReconnect();
						return;
					}

					const parser = createSseParser();
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					while (!stopped) {
						const { done, value } = await reader.read();
						if (done) break;
						for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
							dispatch(payload);
						}
					}
				} catch {
					// Network failure or abort() from unsubscribe - either way, fall
					// through to the reconnect scheduling below (a no-op if stopped).
				}
				scheduleReconnect();
			}

			void connectOnce();

			return () => {
				stopped = true;
				if (timer !== null) clearTimeout(timer);
				controller?.abort();
			};
		}
	};
}

const NOTIFICATION_KINDS = new Set<NotificationKind>(['success', 'error', 'info']);

function toNotificationKind(level: string): NotificationKind {
	return NOTIFICATION_KINDS.has(level as NotificationKind) ? (level as NotificationKind) : 'info';
}

/**
 * Bridge an `EventProvider` into the rest of admin-core (spec §3.5):
 * `resource_changed` -> `invalidate(resource)` (so `ListResource`/
 * `WindowedListResource` subscribers refetch); `notice` -> `notify(...)`
 * (falls back to `'info'` for an unrecognized `level`). Returns the
 * `EventProvider`'s own unsubscribe function.
 */
export function connectEvents(provider: EventProvider): () => void {
	return provider.subscribe((event) => {
		if (event.kind === 'resource_changed') {
			invalidate(event.resource);
		} else {
			notify(toNotificationKind(event.level), event.message);
		}
	});
}
