/**
 * Issue #637: the connection state's rules (pure) and the monitor that
 * feeds them from requests, the SSE stream and the browser's online/offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	connectionStatusOf,
	createConnectionMonitor,
	DEFAULT_FAILURE_THRESHOLD,
	initialConnectionState,
	nextConnectionState,
	type ConnectionEventTarget,
	type ConnectionState
} from '../src/connectionMonitor.svelte';
import { connectEvents, createSseEventProvider, type EventProvider } from '../src/events';
import type { HttpRequestResult } from '../src/providers/http';

const ok = (startedAt: number): HttpRequestResult => ({ ok: true, startedAt });
const fail = (
	startedAt: number,
	failure: 'network' | 'timeout' = 'network'
): HttpRequestResult => ({
	ok: false,
	failure,
	startedAt
});

/** A minimal window stand-in for `online` / `offline`. */
function fakeWindow(): ConnectionEventTarget & {
	fire(type: 'online' | 'offline'): void;
	count(): number;
} {
	const listeners = new Map<string, Set<() => void>>();
	return {
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		fire(type) {
			for (const l of [...(listeners.get(type) ?? [])]) l();
		},
		count() {
			let n = 0;
			for (const set of listeners.values()) n += set.size;
			return n;
		}
	};
}

describe('nextConnectionState / connectionStatusOf (pure rules)', () => {
	const T = DEFAULT_FAILURE_THRESHOLD;
	const start = initialConnectionState(true);

	it('starts online, or offline when the browser has no network', () => {
		expect(connectionStatusOf(start, T)).toBe('online');
		expect(connectionStatusOf(initialConnectionState(false), T)).toBe('offline');
	});

	it('one request failure is not a disconnect; the threshold exactly is', () => {
		const one = nextConnectionState(start, { type: 'request', result: fail(0), at: 1 });
		expect(connectionStatusOf(one, T)).toBe('online');
		const two = nextConnectionState(one, { type: 'request', result: fail(1), at: 2 });
		expect(two.consecutiveFailures).toBe(2);
		expect(connectionStatusOf(two, 2)).toBe('reconnecting');
		expect(connectionStatusOf(two, 3)).toBe('online');
	});

	it('a threshold below 1 (or not finite) still needs at least one failure', () => {
		expect(connectionStatusOf(start, 0)).toBe('online');
		const one = nextConnectionState(start, { type: 'request', result: fail(0), at: 1 });
		expect(connectionStatusOf(one, 0)).toBe('reconnecting');
		expect(connectionStatusOf(one, Number.NaN)).toBe('online'); // falls back to the default 2
	});

	it('a success in between resets the run of failures', () => {
		let s: ConnectionState = start;
		s = nextConnectionState(s, { type: 'request', result: fail(0), at: 1 });
		s = nextConnectionState(s, { type: 'request', result: ok(2), at: 3 });
		s = nextConnectionState(s, { type: 'request', result: fail(4), at: 5 });
		expect(s.consecutiveFailures).toBe(1);
		expect(connectionStatusOf(s, T)).toBe('online');
	});

	it('a stream loss disconnects at once; a stream reconnect recovers', () => {
		const lost = nextConnectionState(start, { type: 'streamDisconnected', at: 10 });
		expect(connectionStatusOf(lost, T)).toBe('reconnecting');
		expect(lost.lastFailureAt).toBe(10);
		const back = nextConnectionState(lost, { type: 'streamReconnected', at: 20 });
		expect(connectionStatusOf(back, T)).toBe('online');
		expect(back.lastSuccessAt).toBe(20);
	});

	it('offline wins over reconnecting; online clears only the browser flag', () => {
		let s = nextConnectionState(start, { type: 'streamDisconnected', at: 1 });
		s = nextConnectionState(s, { type: 'browserOffline', at: 2 });
		expect(connectionStatusOf(s, T)).toBe('offline');
		s = nextConnectionState(s, { type: 'browserOnline', at: 3 });
		expect(connectionStatusOf(s, T)).toBe('reconnecting'); // the stream has not come back yet
	});

	it('discards a success sent before the last failure evidence (stale)', () => {
		const lost = nextConnectionState(start, { type: 'streamDisconnected', at: 100 });
		const stale = nextConnectionState(lost, { type: 'request', result: ok(99), at: 101 });
		expect(stale).toBe(lost);
		// sent at exactly the same moment counts
		const fresh = nextConnectionState(lost, { type: 'request', result: ok(100), at: 101 });
		expect(connectionStatusOf(fresh, T)).toBe('online');
	});

	it('discards a failure sent before the last success (a request that hung through an outage already over)', () => {
		let s = nextConnectionState(start, { type: 'request', result: fail(0), at: 1 });
		s = nextConnectionState(s, { type: 'request', result: fail(1), at: 2 });
		s = nextConnectionState(s, { type: 'streamReconnected', at: 50 });
		const late = nextConnectionState(s, { type: 'request', result: fail(10, 'timeout'), at: 60 });
		expect(late).toBe(s);
		expect(connectionStatusOf(late, T)).toBe('online');
	});

	it('an answer clears the browser offline flag too (the server answered)', () => {
		const off = nextConnectionState(start, { type: 'browserOffline', at: 1 });
		const s = nextConnectionState(off, { type: 'request', result: ok(2), at: 3 });
		expect(connectionStatusOf(s, T)).toBe('online');
	});

	it('online without having been offline changes nothing', () => {
		expect(nextConnectionState(start, { type: 'browserOnline', at: 1 })).toBe(start);
	});
});

describe('createConnectionMonitor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('online -> reconnecting -> offline -> online, recovering once', () => {
		const win = fakeWindow();
		const monitor = createConnectionMonitor({ eventTarget: win, isOnline: () => true });
		const recovered = vi.fn();
		monitor.onRecovered(recovered);
		expect(monitor.status).toBe('online');

		monitor.reportStreamDisconnected();
		expect(monitor.status).toBe('reconnecting');
		win.fire('offline');
		expect(monitor.status).toBe('offline');
		win.fire('online');
		expect(monitor.status).toBe('reconnecting');

		vi.advanceTimersByTime(10);
		monitor.reportStreamReconnected();
		expect(monitor.status).toBe('online');
		expect(recovered).toHaveBeenCalledTimes(1);
		expect(monitor.recoveries).toBe(1);
	});

	it('one request failure keeps it online; the second in a row disconnects; an answer recovers', () => {
		const monitor = createConnectionMonitor({ eventTarget: null, isOnline: () => true });
		const recovered = vi.fn();
		monitor.onRecovered(recovered);
		monitor.reportRequest(fail(Date.now()));
		expect(monitor.status).toBe('online');
		expect(monitor.state.lastFailureAt).toBe(1_000);
		monitor.reportRequest(fail(Date.now(), 'timeout'));
		expect(monitor.status).toBe('reconnecting');

		vi.advanceTimersByTime(5);
		monitor.reportRequest(ok(Date.now()));
		expect(monitor.status).toBe('online');
		expect(monitor.state.lastSuccessAt).toBe(1_005);
		expect(recovered).toHaveBeenCalledTimes(1);
	});

	it('a request answered while the stream is still reconnecting recovers, and the later stream reconnect does not recover twice', () => {
		const monitor = createConnectionMonitor({ eventTarget: null, isOnline: () => true });
		const recovered = vi.fn();
		monitor.onRecovered(recovered);
		monitor.reportStreamDisconnected();
		vi.advanceTimersByTime(1);
		monitor.reportRequest(ok(Date.now()));
		monitor.reportStreamReconnected();
		monitor.reportRequest(ok(Date.now()));
		expect(monitor.status).toBe('online');
		expect(recovered).toHaveBeenCalledTimes(1);
		expect(monitor.recoveries).toBe(1);
	});

	it('a request sent before the stream was lost does not end the disconnect', () => {
		const monitor = createConnectionMonitor({ eventTarget: null, isOnline: () => true });
		const sentAt = Date.now();
		vi.advanceTimersByTime(3);
		monitor.reportStreamDisconnected();
		monitor.reportRequest(ok(sentAt));
		expect(monitor.status).toBe('reconnecting');
	});

	it('starts offline when navigator.onLine is false, and the offline event alone is enough', () => {
		vi.stubGlobal('navigator', { onLine: false });
		const off = createConnectionMonitor({ eventTarget: null });
		expect(off.status).toBe('offline');

		vi.stubGlobal('navigator', { onLine: true });
		const win = fakeWindow();
		const monitor = createConnectionMonitor({ eventTarget: win });
		expect(monitor.status).toBe('online');
		win.fire('offline');
		expect(monitor.status).toBe('offline');
	});

	it('offline then online with nothing failed in between is a recovery', () => {
		const win = fakeWindow();
		const monitor = createConnectionMonitor({ eventTarget: win, isOnline: () => true });
		const recovered = vi.fn();
		monitor.onRecovered(recovered);
		win.fire('offline');
		win.fire('online');
		expect(monitor.status).toBe('online');
		expect(recovered).toHaveBeenCalledTimes(1);
	});

	it('works without window or navigator (SSR) and starts online', () => {
		vi.stubGlobal('window', undefined);
		vi.stubGlobal('navigator', undefined);
		const monitor = createConnectionMonitor();
		expect(monitor.status).toBe('online');
		monitor.reportStreamDisconnected();
		expect(monitor.status).toBe('reconnecting');
		monitor.dispose();
	});

	it('listens on window by default and dispose() removes the listeners and ignores later reports', () => {
		const win = fakeWindow();
		vi.stubGlobal('window', win);
		const monitor = createConnectionMonitor({ isOnline: () => true });
		expect(win.count()).toBe(2);
		const recovered = vi.fn();
		monitor.onRecovered(recovered);
		monitor.dispose();
		expect(win.count()).toBe(0);
		monitor.reportStreamDisconnected();
		expect(monitor.status).toBe('online');
		monitor.dispose(); // idempotent
	});

	it('an unsubscribed recovery listener is not called', () => {
		const monitor = createConnectionMonitor({ eventTarget: null, isOnline: () => true });
		const recovered = vi.fn();
		const off = monitor.onRecovered(recovered);
		off();
		monitor.reportStreamDisconnected();
		monitor.reportStreamReconnected();
		expect(recovered).not.toHaveBeenCalled();
		expect(monitor.recoveries).toBe(1);
	});

	it('honours failureThreshold', () => {
		const monitor = createConnectionMonitor({
			eventTarget: null,
			isOnline: () => true,
			failureThreshold: 3
		});
		monitor.reportRequest(fail(Date.now()));
		monitor.reportRequest(fail(Date.now()));
		expect(monitor.status).toBe('online');
		monitor.reportRequest(fail(Date.now()));
		expect(monitor.status).toBe('reconnecting');
	});
});

describe('connectEvents({ connection }) wiring', () => {
	it('forwards the stream loss and its return to the listener', () => {
		let hooks: Parameters<EventProvider['subscribe']>[1];
		const provider: EventProvider = {
			subscribe(_handler, h) {
				hooks = h;
				return () => {};
			}
		};
		const connection = { reportStreamDisconnected: vi.fn(), reportStreamReconnected: vi.fn() };
		connectEvents(provider, { connection });
		hooks!.onDisconnected!();
		expect(connection.reportStreamDisconnected).toHaveBeenCalledTimes(1);
		hooks!.onReconnected!();
		expect(connection.reportStreamReconnected).toHaveBeenCalledTimes(1);
	});
});

describe('SSE provider: onDisconnected (Issue #637)', () => {
	function openStream(): { response: Response; close: () => void; error: () => void } {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			}
		});
		return {
			response: new Response(stream),
			close: () => controller.close(),
			error: () => controller.error(new TypeError('network error'))
		};
	}

	it('fires once per lost stream, not for the failed attempts after it, then onReconnected', async () => {
		const first = openStream();
		const second = openStream();
		let n = 0;
		const fetchFn = vi.fn(() => {
			n++;
			if (n === 1) return Promise.resolve(first.response);
			if (n <= 3) return Promise.reject(new TypeError('Failed to fetch'));
			return Promise.resolve(second.response);
		});
		const onDisconnected = vi.fn();
		const onReconnected = vi.fn();
		const provider = createSseEventProvider({
			getToken: () => 'tok',
			fetchFn,
			reconnectDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onDisconnected, onReconnected });
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
		expect(onDisconnected).not.toHaveBeenCalled();
		first.error();
		await vi.waitFor(() => expect(onReconnected).toHaveBeenCalledTimes(1));
		expect(onDisconnected).toHaveBeenCalledTimes(1);
		expect(fetchFn).toHaveBeenCalledTimes(4);
		unsub();
		await new Promise((r) => setTimeout(r, 20));
		expect(onDisconnected).toHaveBeenCalledTimes(1); // unsubscribing is not a loss
	});

	it('a first connection that never opened is not a loss', async () => {
		const fetchFn = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
		const onDisconnected = vi.fn();
		const provider = createSseEventProvider({
			getToken: () => 'tok',
			fetchFn,
			reconnectDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onDisconnected });
		await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3));
		unsub();
		expect(onDisconnected).not.toHaveBeenCalled();
	});

	it('a stream ended after a logout (token gone) is not a loss', async () => {
		const first = openStream();
		let token: string | null = 'tok';
		const fetchFn = vi.fn(() => Promise.resolve(first.response));
		const onDisconnected = vi.fn();
		const onTokenCleared = vi.fn();
		const provider = createSseEventProvider({
			getToken: () => token,
			fetchFn,
			reconnectDelayMs: 5,
			tokenWaitDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onDisconnected, onTokenCleared });
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
		token = null;
		first.close();
		await vi.waitFor(() => expect(onTokenCleared).toHaveBeenCalled());
		unsub();
		expect(onDisconnected).not.toHaveBeenCalled();
	});

	it('a token switch reopening the stream is not a loss', async () => {
		const first = openStream();
		const second = openStream();
		let token = 'a';
		// Like the real fetch, aborting the request errors its body.
		const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
			const next = fetchFn.mock.calls.length === 1 ? first : second;
			init?.signal?.addEventListener('abort', () => next.error(), { once: true });
			return Promise.resolve(next.response);
		});
		const onDisconnected = vi.fn();
		const provider = createSseEventProvider({
			getToken: () => token,
			fetchFn,
			reconnectDelayMs: 5,
			tokenWaitDelayMs: 5
		});
		const unsub = provider.subscribe(vi.fn(), { onDisconnected });
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
		token = 'b';
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
		unsub();
		expect(onDisconnected).not.toHaveBeenCalled();
	});
});
