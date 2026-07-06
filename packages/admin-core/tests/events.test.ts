import { describe, expect, it, vi } from 'vitest';
import { connectEvents, createSseEventProvider, createTauriEventProvider, type AppEvent, type EventProvider } from '../src/events';
import { onInvalidate } from '../src/invalidate';
import { initBanto } from '../src/registry.svelte';
import type { AuthProvider, DataProvider, Notifier } from '../src/provider';

function stubProviders(notifier?: Notifier): void {
	const dataProvider: DataProvider = {
		getList: async () => ({ rows: [], totalCount: 0 }),
		getOne: async () => ({}) as never,
		create: async () => ({}) as never,
		update: async () => ({}) as never,
		deleteOne: async () => {}
	};
	const authProvider: AuthProvider = {
		login: async () => ({ success: true }),
		logout: async () => {},
		check: async () => true,
		getIdentity: async () => null
	};
	initBanto({ dataProvider, authProvider, resources: [], notifier });
}

describe('createTauriEventProvider', () => {
	it('listens on banto://event and forwards AppEvent payloads only', async () => {
		let capturedCb: ((e: { payload: unknown }) => void) | null = null;
		const unlistenFn = vi.fn();
		const listen = vi.fn(async (eventName: string, cb: (e: { payload: unknown }) => void) => {
			expect(eventName).toBe('banto://event');
			capturedCb = cb;
			return unlistenFn;
		});

		const provider = createTauriEventProvider({ listen });
		const handler = vi.fn();
		const unsubscribe = provider.subscribe(handler);

		await Promise.resolve();
		await Promise.resolve();

		capturedCb!({ payload: { kind: 'resource_changed', resource: 'items' } });
		expect(handler).toHaveBeenCalledWith({ kind: 'resource_changed', resource: 'items' });

		capturedCb!({ payload: { unrelated: true } });
		expect(handler).toHaveBeenCalledTimes(1);

		unsubscribe();
		await Promise.resolve();
		expect(unlistenFn).toHaveBeenCalledTimes(1);
	});

	it('tears down immediately if unsubscribed before listen() resolves', async () => {
		const unlistenFn = vi.fn();
		let resolveListen!: (fn: () => void) => void;
		const listen = vi.fn(
			() =>
				new Promise<() => void>((resolve) => {
					resolveListen = resolve;
				})
		);

		const provider = createTauriEventProvider({ listen });
		const unsubscribe = provider.subscribe(vi.fn());
		unsubscribe();
		resolveListen(unlistenFn);
		await Promise.resolve();
		expect(unlistenFn).toHaveBeenCalledTimes(1);
	});
});

describe('createSseEventProvider', () => {
	function fakeStreamResponse(chunks: string[]): Response {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			}
		});
		return new Response(stream);
	}

	it('does not connect while getToken() returns null', async () => {
		const fetchFn = vi.fn();
		const provider = createSseEventProvider({ getToken: () => null, fetchFn, reconnectDelayMs: 5 });
		const unsubscribe = provider.subscribe(vi.fn());
		await Promise.resolve();
		expect(fetchFn).not.toHaveBeenCalled();
		unsubscribe();
	});

	it('connects with Authorization + X-Banto-Client headers and dispatches parsed events', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(fakeStreamResponse(['data: {"kind":"notice","level":"info","message":"hi"}\n\n']));
		const provider = createSseEventProvider({ getToken: () => 'tok123', fetchFn, baseUrl: 'http://x' });
		const handler = vi.fn();
		const unsubscribe = provider.subscribe(handler);

		await vi.waitFor(() => expect(handler).toHaveBeenCalled());

		expect(fetchFn).toHaveBeenCalledWith(
			'http://x/api/events',
			expect.objectContaining({
				headers: expect.objectContaining({ 'X-Banto-Client': 'banto', Authorization: 'Bearer tok123' })
			})
		);
		expect(handler).toHaveBeenCalledWith({ kind: 'notice', level: 'info', message: 'hi' });
		unsubscribe();
	});

	it('aborts the in-flight request on unsubscribe', async () => {
		let capturedSignal: AbortSignal | undefined;
		const fetchFn: typeof fetch = vi.fn((_input, init) => {
			capturedSignal = init?.signal ?? undefined;
			return new Promise<Response>(() => {
				// never resolves - simulates a still-open connection
			});
		});
		const provider = createSseEventProvider({ getToken: () => 'tok', fetchFn });
		const unsubscribe = provider.subscribe(vi.fn());

		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
		unsubscribe();
		expect(capturedSignal?.aborted).toBe(true);
	});
});

describe('connectEvents', () => {
	it('dispatches resource_changed to invalidate()', () => {
		stubProviders();
		let handler: ((event: AppEvent) => void) | null = null;
		const fakeProvider: EventProvider = {
			subscribe: (h) => {
				handler = h;
				return vi.fn();
			}
		};
		const invalidated = vi.fn();
		onInvalidate('items', invalidated);

		connectEvents(fakeProvider);
		handler!({ kind: 'resource_changed', resource: 'items' });

		expect(invalidated).toHaveBeenCalledTimes(1);
	});

	it('dispatches notice to the notifier, falling back to info for an unrecognized level', () => {
		const seen: { kind: string; message: string }[] = [];
		stubProviders({ notify: (kind, message) => seen.push({ kind, message }) });
		let handler: ((event: AppEvent) => void) | null = null;
		const fakeProvider: EventProvider = {
			subscribe: (h) => {
				handler = h;
				return vi.fn();
			}
		};

		connectEvents(fakeProvider);
		handler!({ kind: 'notice', level: 'error', message: 'oops' });
		handler!({ kind: 'notice', level: 'weird', message: 'fallback' });

		expect(seen).toEqual([
			{ kind: 'error', message: 'oops' },
			{ kind: 'info', message: 'fallback' }
		]);
	});

	it('returns the provider unsubscribe function', () => {
		stubProviders();
		const unsub = vi.fn();
		const fakeProvider: EventProvider = { subscribe: () => unsub };
		const result = connectEvents(fakeProvider);
		result();
		expect(unsub).toHaveBeenCalledTimes(1);
	});
});
