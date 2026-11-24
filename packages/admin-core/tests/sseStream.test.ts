/**
 * Issue #936 (docs/design/sse-stream-design.md §5, §6): `createSseStream`.
 *
 * The order of answers, frames, token changes and timers is decided by the
 * test's statements: `fetch` is answered by hand, bodies are fed by hand and
 * the clock is fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSseStream, type SseStreamOptions } from '../src/sse-stream';

interface Value {
	v: number;
	/** The producer's mark (`valueStamp`). */
	at?: number;
	skip?: boolean;
}

const encoder = new TextEncoder();

function frame(value: Value, event?: string): string {
	return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
}

interface Body {
	send(text: string): void;
	end(): void;
}

interface Call {
	url: string;
	headers: Record<string, string>;
	signal: AbortSignal;
	/** Answer `200` with a body the test feeds; the body fails when the request is aborted (like `fetch`). */
	open(): Body;
	status(code: number): void;
	fail(): void;
}

function manualFetch(): { fetchFn: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((resolve, reject) => {
			const signal = init!.signal!;
			calls.push({
				url: String(input),
				headers: init!.headers as Record<string, string>,
				signal,
				open() {
					let controller!: ReadableStreamDefaultController<Uint8Array>;
					const stream = new ReadableStream<Uint8Array>({
						start(c) {
							controller = c;
						}
					});
					signal.addEventListener('abort', () => {
						try {
							controller.error(new DOMException('aborted', 'AbortError'));
						} catch {
							// already closed/cancelled
						}
					});
					resolve(new Response(stream));
					return {
						send: (text) => controller.enqueue(encoder.encode(text)),
						end: () => controller.close()
					};
				},
				status: (code) => resolve(new Response(null, { status: code })),
				fail: () => reject(new TypeError('Failed to fetch'))
			});
		})) as typeof fetch;
	return { fetchFn, calls };
}

/** The real timer, taken before the clock is faked: `micro()` waits on it. */
const realSetTimeout = globalThis.setTimeout;

/** Let promise continuations (and stream reads) settle without moving the fake clock. */
async function micro(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}

/**
 * Move the clock (firing what is due), then let continuations run.
 * `tick(1)` after a token-watch tick fires the "reconnect at once" timer:
 * a 0ms timer set while the fake clock is advancing is due 1ms later.
 */
async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await micro();
}

function start(over: Partial<SseStreamOptions<Value>> = {}) {
	const net = manualFetch();
	const log: string[] = [];
	const state: { token: string | null } = { token: 'A' };
	const stop = createSseStream<Value>({
		path: '/api/app/values',
		baseUrl: 'http://x',
		fetchFn: net.fetchFn,
		getToken: () => state.token,
		parse: (data) => {
			const value = JSON.parse(data) as Value;
			return value.skip ? null : value;
		},
		onEvent: (value) => log.push(`event:${value.v}`),
		onSessionChange: () => log.push('sessionChange'),
		onForbidden: () => log.push('forbidden'),
		onConnection: (connected) => log.push(`connection:${connected}`),
		onUnauthorized: () => log.push('unauthorized'),
		onTokenCleared: () => log.push('tokenCleared'),
		onReconnected: () => log.push('reconnected'),
		onDisconnected: () => log.push('disconnected'),
		onStale: (stale) => log.push(`stale:${stale}`),
		...over
	});
	return { ...net, log, stop, state };
}

const auth = (call: Call) => call.headers.Authorization;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('createSseStream: reading', () => {
	it('reads any path with the two headers and hands parse the event name', async () => {
		const seen: (string | undefined)[] = [];
		const s = start({
			parse: (data, event) => {
				seen.push(event);
				return JSON.parse(data) as Value;
			}
		});
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0].url).toBe('http://x/api/app/values');
		expect(s.calls[0].headers).toMatchObject({
			'X-Banto-Client': 'banto',
			Authorization: 'Bearer A'
		});

		const body = s.calls[0].open();
		await micro();
		expect(s.log).toEqual(['connection:true']);

		body.send(frame({ v: 1 }, 'temperature') + frame({ v: 2 }));
		await micro();
		expect(seen).toEqual(['temperature', undefined]);
		expect(s.log).toEqual(['connection:true', 'event:1', 'event:2']);
		s.stop();
	});

	it('defaults to the same origin', () => {
		const net = manualFetch();
		const stop = createSseStream<Value>({
			path: '/api/app/values',
			fetchFn: net.fetchFn,
			getToken: () => 'A',
			parse: () => null,
			onEvent: () => {}
		});
		expect(net.calls[0].url).toBe('/api/app/values');
		stop();
	});

	// Review of #945: the check is on the RESOLVED URL. URL parsing drops a
	// tab/newline and reads `\\` as `/`, so these start with a single `/` as
	// text and still name `other.example` to `fetch`.
	it.each([
		'api/values',
		'//other.example/x',
		'/\\other.example/x',
		'https://other.example/x',
		'',
		'/\t/other.example/x',
		'/\n/other.example/x',
		'/\r/other.example/x',
		'/\r\n/other.example/x',
		'/\t\\other.example/x',
		'/\t\n\t/other.example/x'
	])('refuses a path that could name another host (%j)', (path) => {
		const net = manualFetch();
		expect(() =>
			createSseStream<Value>({
				path,
				fetchFn: net.fetchFn,
				getToken: () => 'A',
				parse: () => null,
				onEvent: () => {}
			})
		).toThrow(TypeError);
		expect(net.calls).toHaveLength(0);
	});

	it.each([
		['', '/\t/other.example/x'],
		['http:', '/\t/other.example/x'],
		['https://x@', '/other.example/x'],
		['http://user:pw@x', '/api/app/values'],
		['http://', '/api/app/values']
	])('refuses baseUrl %j + path %j: no request, so no bearer token', (baseUrl, path) => {
		const net = manualFetch();
		expect(() =>
			createSseStream<Value>({
				baseUrl,
				path,
				fetchFn: net.fetchFn,
				getToken: () => 'A',
				parse: () => null,
				onEvent: () => {}
			})
		).toThrow(TypeError);
		expect(net.calls).toHaveLength(0);
	});

	it.each([
		['', '/api/app/values', '/api/app/values'],
		['', '/api/app/values?unit=c#top', '/api/app/values?unit=c#top'],
		['http://x:8080', '/api/app/values', 'http://x:8080/api/app/values'],
		['https://x', '/a/../b//c', 'https://x/b//c'],
		['https://x', '/\tapi/app/values', 'https://x/api/app/values'],
		['tauri://localhost', '/api/app/values', 'tauri://localhost/api/app/values']
	])(
		'lets a same-origin URL through (%j + %j), as the URL that was checked',
		(baseUrl, path, url) => {
			const net = manualFetch();
			const stop = createSseStream<Value>({
				baseUrl,
				path,
				fetchFn: net.fetchFn,
				getToken: () => 'A',
				parse: () => null,
				onEvent: () => {}
			});
			expect(net.calls).toHaveLength(1);
			expect(net.calls[0].url).toBe(url);
			expect(auth(net.calls[0])).toBe('Bearer A');
			stop();
		}
	);

	it('with no baseUrl the allowed origin is the page’s', () => {
		vi.stubGlobal('location', { origin: 'https://app.example' });
		try {
			const net = manualFetch();
			const make = (path: string) =>
				createSseStream<Value>({
					path,
					fetchFn: net.fetchFn,
					getToken: () => 'A',
					parse: () => null,
					onEvent: () => {}
				});
			expect(() => make('/\t/other.example/x')).toThrow(TypeError);
			expect(() => make('/\n/app.example.other.example/x')).toThrow(TypeError);
			expect(net.calls).toHaveLength(0);
			// What `fetchFn` receives is the checked URL itself, absolute: `fetch`
			// would resolve a relative one against the document's base URL
			// (`<base href>`), which need not be `location.origin`.
			const stops = [make('/api/app/values'), make('/\tapi/../app/values?unit=c')];
			expect(net.calls.map((call) => call.url)).toEqual([
				'https://app.example/api/app/values',
				'https://app.example/app/values?unit=c'
			]);
			for (const call of net.calls) {
				expect(new URL(call.url).origin).toBe('https://app.example');
				expect(auth(call)).toBe('Bearer A');
			}
			for (const stop of stops) stop();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// Re-review of #945: a browser whose page has no usable origin is not
	// "no browser". A relative URL would be resolved by `fetch` against a
	// document nothing was checked with.
	it.each(['null', '', undefined])(
		'a page without a usable origin (location.origin = %j) needs an absolute baseUrl',
		(origin) => {
			vi.stubGlobal('location', { origin });
			try {
				const net = manualFetch();
				const make = (path: string, baseUrl?: string) =>
					createSseStream<Value>({
						path,
						baseUrl,
						fetchFn: net.fetchFn,
						getToken: () => 'A',
						parse: () => null,
						onEvent: () => {}
					});
				expect(() => make('/api/app/values')).toThrow(TypeError);
				expect(() => make('/api/app/values', '/prefix')).toThrow(TypeError);
				expect(net.calls).toHaveLength(0);
				const stop = make('/api/app/values', 'https://x');
				expect(net.calls.map((call) => call.url)).toEqual(['https://x/api/app/values']);
				stop();
			} finally {
				vi.unstubAllGlobals();
			}
		}
	);

	it('drops an event parse returns null for or throws on, and keeps the connection', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(
			'data: not json\n\n' + frame({ v: 1, skip: true }) + ': keep-alive\n\n' + frame({ v: 2 })
		);
		await micro();
		expect(s.log).toEqual(['connection:true', 'event:2']);
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0].signal.aborted).toBe(false);
		s.stop();
	});

	it('a throwing onEvent does not tear the connection down', async () => {
		const got: number[] = [];
		const s = start({
			onEvent: (value) => {
				got.push(value.v);
				if (value.v === 1) throw new Error('consumer bug');
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();
		body.send(frame({ v: 2 }));
		await micro();
		expect(got).toEqual([1, 2]);
		expect(s.calls).toHaveLength(1);
		s.stop();
	});

	it('waits for a token without reporting anything, then connects', async () => {
		const net = manualFetch();
		const log: string[] = [];
		let token: string | null = null;
		const stop = createSseStream<Value>({
			path: '/api/app/values',
			fetchFn: net.fetchFn,
			getToken: () => token,
			parse: () => null,
			onEvent: () => {},
			onSessionChange: () => log.push('sessionChange'),
			onTokenCleared: () => log.push('tokenCleared')
		});
		await tick(2000);
		expect(net.calls).toHaveLength(0);
		token = 'A';
		await tick(500);
		expect(net.calls).toHaveLength(1);
		expect(log).toEqual([]);
		stop();
	});
});

describe('createSseStream: the reconnect rules, on a path of the app', () => {
	it('same token: lost -> onConnection(false), onDisconnected; back -> onConnection(true), onReconnected', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();
		body.end();
		await micro();
		expect(s.log).toEqual(['connection:true', 'event:1', 'connection:false', 'disconnected']);

		await tick(2999);
		expect(s.calls).toHaveLength(1);
		await tick(1);
		expect(s.calls).toHaveLength(2);
		// Failed attempts are not reported again.
		s.calls[1].fail();
		await micro();
		await tick(3000);
		s.calls[2].status(503);
		await micro();
		expect(s.log).toHaveLength(4);

		await tick(3000);
		s.calls[3].open();
		await micro();
		expect(s.log.slice(4)).toEqual(['connection:true', 'reconnected']);
		expect(s.log).not.toContain('sessionChange');
		s.stop();
	});

	it('a first connection that never opened reports nothing', async () => {
		const s = start();
		s.calls[0].fail();
		await micro();
		await tick(3000);
		s.calls[1].status(500);
		await micro();
		expect(s.log).toEqual([]);
		s.stop();
	});

	it('401: reported once, the token is never sent again, a new login starts over', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.end();
		await micro();
		await tick(3000);
		s.calls[1].status(401);
		await micro();
		expect(s.log).toEqual([
			'connection:true',
			'connection:false',
			'disconnected',
			'sessionChange',
			'unauthorized'
		]);

		await tick(10_000);
		expect(s.calls).toHaveLength(2);

		s.state.token = 'B';
		await tick(500);
		expect(s.calls).toHaveLength(3);
		expect(auth(s.calls[2])).toBe('Bearer B');
		s.calls[2].open();
		await micro();
		// A new session's first stream: no onReconnected, no second onSessionChange.
		expect(s.log.slice(5)).toEqual(['connection:true']);
		s.stop();
	});

	it('a cleared token: the session ends for the caller within the token watch, onTokenCleared at the next connect', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();

		s.state.token = null;
		await tick(500);
		expect(s.log).toEqual(['connection:true', 'event:1', 'sessionChange']);
		// The open stream itself is left alone (the server ends it).
		expect(s.calls[0].signal.aborted).toBe(false);

		body.end();
		await micro();
		await tick(3000);
		expect(s.log.slice(3)).toEqual(['connection:false', 'tokenCleared']);

		await tick(5000);
		expect(s.calls).toHaveLength(1);
		s.state.token = 'B';
		await tick(500);
		expect(s.calls).toHaveLength(2);
		expect(s.log).toHaveLength(5);
		s.stop();
	});

	it('a new login while open: reopened at once with the new token', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();

		s.state.token = 'B';
		await tick(500);
		await tick(1);
		expect(s.calls[0].signal.aborted).toBe(true);
		expect(s.calls).toHaveLength(2);
		expect(auth(s.calls[1])).toBe('Bearer B');
		const next = s.calls[1].open();
		await micro();
		next.send(frame({ v: 2 }));
		await micro();
		expect(s.log).toEqual([
			'connection:true',
			'event:1',
			'sessionChange',
			'connection:false',
			'connection:true',
			'event:2'
		]);
		s.stop();
	});

	it('calls nothing after it is stopped', async () => {
		const s = start({ staleAfterMs: 1000 });
		const body = s.calls[0].open();
		await micro();
		expect(s.log).toEqual(['connection:true']);
		s.stop();
		expect(s.calls[0].signal.aborted).toBe(true);
		await micro();
		expect(() => body.send(frame({ v: 1 }))).toThrow();
		s.state.token = null;
		await tick(60_000);
		expect(s.log).toEqual(['connection:true']);
		expect(s.calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

// Design §5.2.1: nothing of the previous session reaches the next one.
describe('createSseStream: the owner check', () => {
	it('(1) a 200 that arrives after a new login opens nothing', async () => {
		const s = start();
		s.state.token = 'B';
		const late = s.calls[0].open();
		await micro();
		expect(s.log).toEqual(['sessionChange']);
		expect(() => late.send(frame({ v: 1 }))).toThrow(); // the body was cancelled

		await tick(1);
		expect(s.calls).toHaveLength(2);
		expect(auth(s.calls[1])).toBe('Bearer B');
		const body = s.calls[1].open();
		await micro();
		body.send(frame({ v: 2 }));
		await micro();
		expect(s.log).toEqual(['sessionChange', 'connection:true', 'event:2']);
		s.stop();
	});

	it('(1) a 200 that arrives after the token was cleared opens nothing', async () => {
		const s = start();
		s.state.token = null;
		s.calls[0].open();
		await micro();
		expect(s.log).toEqual(['sessionChange']);
		await tick(500);
		expect(s.log).toEqual(['sessionChange', 'tokenCleared']);
		await tick(5000);
		expect(s.calls).toHaveLength(1);
		s.stop();
	});

	it('(1) a 200 that arrives after stop opens nothing', async () => {
		const s = start();
		s.stop();
		s.calls[0].open();
		await micro();
		await tick(10_000);
		expect(s.log).toEqual([]);
		expect(s.calls).toHaveLength(1);
	});

	it('(2) a late 401 is the previous session’s: no onUnauthorized, the new token is used', async () => {
		const s = start();
		s.state.token = 'B';
		s.calls[0].status(401);
		await micro();
		expect(s.log).toEqual(['sessionChange']);

		await tick(1);
		expect(s.calls).toHaveLength(2);
		expect(auth(s.calls[1])).toBe('Bearer B');
		s.calls[1].open();
		await micro();
		expect(s.log).toEqual(['sessionChange', 'connection:true']);

		// A was not marked rejected by its late answer either.
		s.state.token = 'A';
		await tick(500);
		await tick(1);
		expect(auth(s.calls[2])).toBe('Bearer A');
		expect(s.log).not.toContain('unauthorized');
		s.stop();
	});

	it('(2) a late 401 after the token was cleared goes through onTokenCleared', async () => {
		const s = start();
		s.state.token = null;
		s.calls[0].status(401);
		await micro();
		await tick(500);
		expect(s.log).toEqual(['sessionChange', 'tokenCleared']);
		s.stop();
	});

	it('(3) a frame read after the token changed, before the token watch ticks, is dropped', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();

		s.state.token = 'B';
		body.send(frame({ v: 2 }));
		await micro(); // the clock has not moved: the 500ms watch has not run
		expect(s.log).toEqual(['connection:true', 'event:1', 'connection:false', 'sessionChange']);
		expect(s.calls[0].signal.aborted).toBe(true);

		await tick(1);
		expect(auth(s.calls[1])).toBe('Bearer B');
		const next = s.calls[1].open();
		await micro();
		next.send(frame({ v: 3 }));
		await micro();
		expect(s.log.slice(4)).toEqual(['connection:true', 'event:3']);
		expect(s.log).not.toContain('event:2');
		expect(s.log).not.toContain('disconnected');
		s.stop();
	});

	it('(3) a frame read after the token was cleared is dropped too', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		s.state.token = null;
		body.send(frame({ v: 1 }));
		await micro();
		expect(s.log).toEqual(['connection:true', 'connection:false', 'sessionChange']);
		await tick(500);
		expect(s.log.slice(3)).toEqual(['tokenCleared']);
		s.stop();
	});

	it('(4) two values in one read: the second is not delivered if the first onEvent changed the token', async () => {
		const got: number[] = [];
		const s = start({
			onEvent: (value) => {
				got.push(value.v);
				if (value.v === 1) s.state.token = 'B';
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }) + frame({ v: 2 }));
		await micro();
		expect(got).toEqual([1]);
		expect(s.log).toEqual(['connection:true', 'connection:false', 'sessionChange']);
		s.stop();
	});

	it('(4) two values in one read: the second is not delivered if the first onEvent stopped the stream', async () => {
		const got: number[] = [];
		const s = start({
			onEvent: (value) => {
				got.push(value.v);
				s.stop();
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }) + frame({ v: 2 }));
		await micro();
		expect(got).toEqual([1]);
		expect(s.log).toEqual(['connection:true']);
	});

	it('(5) onSessionChange: once per change, always before the next session’s first value', async () => {
		const s = start();
		const a = s.calls[0].open();
		await micro();
		a.send(frame({ v: 1 }));
		await micro();

		// A -> B (noticed by the token watch)
		s.state.token = 'B';
		await tick(500);
		await tick(1);
		const b = s.calls[1].open();
		await micro();
		b.send(frame({ v: 2 }));
		await micro();

		// B -> 401 -> C
		b.end();
		await micro();
		await tick(3000);
		s.calls[2].status(401);
		await micro();
		s.state.token = 'C';
		await tick(500);
		const c = s.calls[3].open();
		await micro();
		c.send(frame({ v: 3 }));
		await micro();

		// C -> cleared -> the same C again (a value of C after the report is a new session's)
		s.state.token = null;
		await tick(500);
		s.state.token = 'C';
		c.send(frame({ v: 4 }));
		await micro();
		s.state.token = 'D';
		await tick(500);
		await tick(1);
		const d = s.calls[4].open();
		await micro();
		d.send(frame({ v: 5 }));
		await micro();

		const events = s.log.filter((entry) => entry.startsWith('event:') || entry === 'sessionChange');
		expect(events).toEqual([
			'event:1',
			'sessionChange',
			'event:2',
			'sessionChange',
			'event:3',
			'sessionChange',
			'event:4',
			'sessionChange',
			'event:5'
		]);
		s.stop();
	});

	it('a disconnect and reconnect under the same token is not a session change', async () => {
		const s = start();
		for (let i = 0; i < 3; i++) {
			const body = s.calls[i].open();
			await micro();
			body.send(frame({ v: i }));
			await micro();
			body.end();
			await micro();
			await tick(3000);
		}
		expect(s.log).not.toContain('sessionChange');
		s.stop();
	});
});

// Design §5.2.1, review of #945: the check is made again every time code of
// the caller returns, and when the stream ends.
describe('createSseStream: the owner check after a callback of the caller', () => {
	const stales = (log: string[]) => log.filter((entry) => entry.startsWith('stale:'));
	const parseValue = (data: string) => JSON.parse(data) as Value;

	it('parse stops the stream: the value is not delivered, nothing follows', async () => {
		const holder: { stop?: () => void } = {};
		const s = start({
			parse: (data) => {
				holder.stop!();
				return parseValue(data);
			}
		});
		holder.stop = s.stop;
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }) + frame({ v: 2 }));
		await micro();
		await tick(10_000);
		expect(s.log).toEqual(['connection:true']);
		expect(s.calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('parse changes the session: the value is not delivered, the stream reopens for the new token', async () => {
		const s = start({
			parse: (data) => {
				s.state.token = 'B';
				return parseValue(data);
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();
		expect(s.log).toEqual(['connection:true', 'connection:false', 'sessionChange']);
		await tick(1);
		expect(s.calls).toHaveLength(2);
		expect(auth(s.calls[1])).toBe('Bearer B');
		s.stop();
	});

	it('parse throws after logging out: still dropped as the previous session’s', async () => {
		const s = start({
			parse: () => {
				s.state.token = null;
				throw new Error('bad');
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }) + frame({ v: 2 }));
		await micro();
		expect(s.log).toEqual(['connection:true', 'connection:false', 'sessionChange']);
		await tick(500);
		expect(s.log.slice(3)).toEqual(['tokenCleared']);
		s.stop();
	});

	it('valueStamp changes the session: no value, no mark, no clock for the old attempt', async () => {
		let switchAt: number | null = 200;
		const s = start({
			staleAfterMs: 1000,
			valueStamp: (value) => {
				if (value.at === switchAt) {
					switchAt = null;
					s.state.token = 'B';
				}
				return value.at ?? 0;
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1, at: 100 }));
		await micro();
		await tick(1000);
		expect(stales(s.log)).toEqual(['stale:true']);

		body.send(frame({ v: 2, at: 200 }));
		await micro();
		expect(s.log).not.toContain('event:2');
		expect(stales(s.log)).toEqual(['stale:true']);
		expect(s.log.slice(-2)).toEqual(['connection:false', 'sessionChange']);

		// The mark of the dropped value was not remembered: under B it is new.
		await tick(1);
		const b = s.calls[1].open();
		await micro();
		b.send(frame({ v: 2, at: 200 }));
		await micro();
		expect(s.log.slice(-2)).toEqual(['event:2', 'stale:false']);
		s.stop();
	});

	it('onEvent changes the session: its value does not restart the clock or end stale', async () => {
		const s = start({
			staleAfterMs: 1000,
			valueStamp: (value) => value.at ?? 0,
			onEvent: (value) => {
				s.log.push(`event:${value.v}`);
				if (value.v === 2 && s.state.token === 'A') s.state.token = 'B';
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1, at: 100 }));
		await micro();
		await tick(1000);
		expect(stales(s.log)).toEqual(['stale:true']);

		body.send(frame({ v: 2, at: 200 }) + frame({ v: 3, at: 300 }));
		await micro();
		expect(s.log.slice(-3)).toEqual(['event:2', 'connection:false', 'sessionChange']);
		expect(stales(s.log)).toEqual(['stale:true']);

		// B gets the same value re-sent: new to B (the mark was not kept), so
		// it is B's value that ends stale.
		await tick(1);
		const b = s.calls[1].open();
		await micro();
		b.send(frame({ v: 2, at: 200 }));
		await micro();
		expect(s.log.slice(-3)).toEqual(['connection:true', 'event:2', 'stale:false']);
		s.stop();
	});

	it('onEvent stops the stream: no onStale(false), no timer left', async () => {
		const holder: { stop?: () => void } = {};
		const s = start({
			staleAfterMs: 1000,
			onEvent: (value) => {
				s.log.push(`event:${value.v}`);
				holder.stop!();
			}
		});
		holder.stop = s.stop;
		const body = s.calls[0].open();
		await micro();
		await tick(1000);
		body.send(frame({ v: 1 }) + frame({ v: 2 }));
		await micro();
		expect(s.log).toEqual(['connection:true', 'stale:true', 'event:1']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('onConnection(true) changes the session: nothing is read from that stream', async () => {
		const s = start({
			onConnection: (connected) => {
				s.log.push(`connection:${connected}`);
				if (connected && s.state.token === 'A') s.state.token = 'B';
			}
		});
		const body = s.calls[0].open();
		await micro();
		expect(() => body.send(frame({ v: 1 }))).toThrow(); // cancelled
		expect(s.log).toEqual(['connection:true', 'connection:false', 'sessionChange']);
		await tick(1);
		expect(auth(s.calls[1])).toBe('Bearer B');
		s.stop();
	});

	it('a 401 whose onSessionChange logs in again is not reported as the new session’s', async () => {
		const s = start({
			onSessionChange: () => {
				s.log.push('sessionChange');
				if (s.state.token === 'A') s.state.token = 'B';
			}
		});
		s.calls[0].status(401);
		await micro();
		expect(s.log).toEqual(['sessionChange']);
		await tick(1);
		expect(s.calls).toHaveLength(2);
		expect(auth(s.calls[1])).toBe('Bearer B');
		const b = s.calls[1].open();
		await micro();
		b.send(frame({ v: 1 }));
		await micro();
		// One change, reported once; no `unauthorized` for B.
		expect(s.log).toEqual(['sessionChange', 'connection:true', 'event:1']);
		s.stop();
	});

	it('a 401 whose onSessionChange clears the token goes through onTokenCleared', async () => {
		const s = start({
			onSessionChange: () => {
				s.log.push('sessionChange');
				s.state.token = null;
			}
		});
		s.calls[0].status(401);
		await micro();
		expect(s.log).toEqual(['sessionChange']);
		await tick(500);
		expect(s.log).toEqual(['sessionChange', 'tokenCleared']);
		// A stays rejected: storing it again does not send it.
		s.state.token = 'A';
		await tick(5000);
		expect(s.calls).toHaveLength(1);
		s.stop();
	});

	it('a 401 whose onSessionChange stops the stream reports nothing more', async () => {
		const holder: { stop?: () => void } = {};
		const s = start({
			onSessionChange: () => {
				s.log.push('sessionChange');
				holder.stop!();
			}
		});
		holder.stop = s.stop;
		s.calls[0].status(401);
		await micro();
		await tick(10_000);
		expect(s.log).toEqual(['sessionChange']);
		expect(s.calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a 403 whose onForbidden changes the session does not sit out the refused delay', async () => {
		const s = start({
			forbiddenRetryDelayMs: 30_000,
			onForbidden: () => {
				s.log.push('forbidden');
				s.state.token = 'B';
			}
		});
		s.calls[0].status(403);
		await micro();
		expect(s.log).toEqual(['forbidden', 'sessionChange']);
		await tick(1);
		expect(auth(s.calls[1])).toBe('Bearer B');
		s.stop();
	});

	it('the token watch: an onSessionChange that stops the stream ends it there', async () => {
		const holder: { stop?: () => void } = {};
		const s = start({
			onSessionChange: () => {
				s.log.push('sessionChange');
				holder.stop!();
			}
		});
		holder.stop = s.stop;
		s.calls[0].open();
		await micro();
		s.state.token = 'B';
		await tick(500);
		await tick(10_000);
		expect(s.log).toEqual(['connection:true', 'sessionChange']);
		expect(s.calls).toHaveLength(1);
	});
});

describe('createSseStream: the owner check when the stream ends', () => {
	it('EOF right after a new login: onSessionChange at once, then the new token', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();

		// Before the token watch ticks.
		s.state.token = 'B';
		body.end();
		await micro();
		expect(s.log).toEqual(['connection:true', 'event:1', 'connection:false', 'sessionChange']);
		expect(vi.getTimerCount()).toBe(1); // the reconnect; the watch is gone

		await tick(1); // not `reconnectDelayMs`
		expect(s.calls).toHaveLength(2);
		expect(auth(s.calls[1])).toBe('Bearer B');
		const b = s.calls[1].open();
		await micro();
		b.send(frame({ v: 2 }));
		await micro();
		expect(s.log.slice(4)).toEqual(['connection:true', 'event:2']);
		expect(s.log).not.toContain('disconnected');
		expect(s.log).not.toContain('reconnected');
		s.stop();
	});

	it('EOF right after a logout: onSessionChange at once, onTokenCleared at the token wait', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();

		s.state.token = null;
		body.end();
		await micro();
		expect(s.log).toEqual(['connection:true', 'event:1', 'connection:false', 'sessionChange']);
		await tick(500);
		expect(s.log.slice(4)).toEqual(['tokenCleared']);
		expect(s.calls).toHaveLength(1);
		s.stop();
	});

	it('a failed fetch after a new login: onSessionChange at once, then the new token', async () => {
		const s = start();
		s.state.token = 'B';
		s.calls[0].fail();
		await micro();
		expect(s.log).toEqual(['sessionChange']);
		await tick(1);
		expect(auth(s.calls[1])).toBe('Bearer B');
		// B's own failure waits the usual delay (no tight loop).
		s.calls[1].fail();
		await micro();
		await tick(2999);
		expect(s.calls).toHaveLength(2);
		await tick(1);
		expect(s.calls).toHaveLength(3);
		expect(s.log).toEqual(['sessionChange']);
		s.stop();
	});

	it('EOF under the same token is still an ordinary loss', async () => {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.end();
		await micro();
		expect(s.log).toEqual(['connection:true', 'connection:false', 'disconnected']);
		await tick(2999);
		expect(s.calls).toHaveLength(1);
		await tick(1);
		expect(s.calls).toHaveLength(2);
		s.stop();
	});
});

// Design §5.2.2: a 403 under the same token.
describe('createSseStream: 403', () => {
	async function refusedAfterValue() {
		const s = start();
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();
		// The server closed the stream (the permission was taken away) ...
		body.end();
		await micro();
		await tick(3000);
		// ... and refuses the reconnect.
		s.calls[1].status(403);
		await micro();
		return s;
	}

	it('value shown -> 403: onForbidden once, not a session change; repeated 403s are silent; the value comes back with the permission', async () => {
		const s = await refusedAfterValue();
		expect(s.log).toEqual([
			'connection:true',
			'event:1',
			'connection:false',
			'disconnected',
			'forbidden'
		]);

		// Without forbiddenRetryDelayMs the retry interval is reconnectDelayMs.
		await tick(2999);
		expect(s.calls).toHaveLength(2);
		await tick(1);
		expect(s.calls).toHaveLength(3);
		expect(auth(s.calls[2])).toBe('Bearer A');
		s.calls[2].status(403);
		await micro();
		await tick(3000);
		s.calls[3].status(403);
		await micro();
		expect(s.log).toHaveLength(5);

		await tick(3000);
		const body = s.calls[4].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();
		expect(s.log.slice(5)).toEqual(['connection:true', 'reconnected', 'event:1']);
		expect(s.log).not.toContain('sessionChange');
		expect(s.log).not.toContain('unauthorized');

		// Refused again later: a new entry into the state is reported again.
		body.end();
		await micro();
		await tick(3000);
		s.calls[5].status(403);
		await micro();
		expect(s.log.slice(8)).toEqual(['connection:false', 'disconnected', 'forbidden']);
		s.stop();
	});

	it('a 403 on the very first connect is reported too', async () => {
		const s = start();
		s.calls[0].status(403);
		await micro();
		expect(s.log).toEqual(['forbidden']);
		s.stop();
	});

	it('forbiddenRetryDelayMs sets the retry interval after a 403 only', async () => {
		const s = start({ forbiddenRetryDelayMs: 30_000 });
		s.calls[0].status(403);
		await micro();
		await tick(29_999);
		expect(s.calls).toHaveLength(1);
		await tick(1);
		expect(s.calls).toHaveLength(2);
		// Another failure keeps the ordinary interval (and the refused state).
		s.calls[1].status(503);
		await micro();
		await tick(3000);
		expect(s.calls).toHaveLength(3);
		s.calls[2].status(403);
		await micro();
		expect(s.log).toEqual(['forbidden']);
		s.stop();
	});

	it('a 401 while refused takes its own path and leaves the refused state', async () => {
		const s = await refusedAfterValue();
		await tick(3000);
		s.calls[2].status(401);
		await micro();
		expect(s.log.slice(5)).toEqual(['sessionChange', 'unauthorized']);

		s.state.token = 'B';
		await tick(500);
		s.calls[3].status(403);
		await micro();
		expect(s.log.slice(7)).toEqual(['forbidden']);
		s.stop();
	});

	it('a cleared token while refused takes its own path', async () => {
		const s = await refusedAfterValue();
		s.state.token = null;
		await tick(3000);
		expect(s.log.slice(5)).toEqual(['sessionChange', 'tokenCleared']);
		expect(s.calls).toHaveLength(2);
		s.stop();
	});

	it('a new login while refused: session change, and its own 403 is reported again', async () => {
		const s = await refusedAfterValue();
		s.state.token = 'B';
		await tick(3000);
		expect(auth(s.calls[2])).toBe('Bearer B');
		expect(s.log.slice(5)).toEqual(['sessionChange']);
		s.calls[2].status(403);
		await micro();
		expect(s.log.slice(6)).toEqual(['forbidden']);
		s.stop();
	});

	it('a late 403 of the previous session is not reported', async () => {
		const s = start();
		s.state.token = 'B';
		s.calls[0].status(403);
		await micro();
		expect(s.log).toEqual(['sessionChange']);
		await tick(1);
		expect(auth(s.calls[1])).toBe('Bearer B');
		s.stop();
	});

	it('stopped while refused: nothing more', async () => {
		const s = await refusedAfterValue();
		s.stop();
		await tick(60_000);
		expect(s.log).toHaveLength(5);
		expect(s.calls).toHaveLength(2);
	});
});

// Design §5.5, one row of the table per test.
describe('createSseStream: staleAfterMs / onStale', () => {
	const stales = (log: string[]) => log.filter((entry) => entry.startsWith('stale:'));

	it('without staleAfterMs no timer is created and onStale is never called', async () => {
		const s = start({ valueStamp: (value) => value.at ?? 0 });
		expect(vi.getTimerCount()).toBe(0);
		const body = s.calls[0].open();
		await micro();
		expect(vi.getTimerCount()).toBe(1); // the token watch only
		body.send(frame({ v: 1, at: 1 }));
		await tick(60_000);
		expect(stales(s.log)).toEqual([]);
		s.stop();
	});

	it('the clock starts when the stream first opens: opened but nothing arrives is stale', async () => {
		const s = start({ staleAfterMs: 1000 });
		await tick(5000); // not open yet
		expect(stales(s.log)).toEqual([]);
		s.calls[0].open();
		await micro();
		await tick(999);
		expect(stales(s.log)).toEqual([]);
		await tick(1);
		expect(stales(s.log)).toEqual(['stale:true']);
		await tick(10_000);
		expect(stales(s.log)).toEqual(['stale:true']);
		s.stop();
	});

	it('a new value restarts the clock, and ends stale right after its onEvent', async () => {
		const s = start({ staleAfterMs: 1000 });
		const body = s.calls[0].open();
		await micro();
		await tick(600);
		body.send(frame({ v: 1 }));
		await micro();
		await tick(999);
		expect(stales(s.log)).toEqual([]);
		await tick(1);
		expect(s.log).toEqual(['connection:true', 'event:1', 'stale:true']);

		body.send(frame({ v: 2 }));
		await micro();
		expect(s.log.slice(3)).toEqual(['event:2', 'stale:false']);
		await tick(1000);
		expect(s.log.slice(5)).toEqual(['stale:true']);
		s.stop();
	});

	it('a keep-alive comment or a dropped event does not restart the clock', async () => {
		const s = start({ staleAfterMs: 1000 });
		const body = s.calls[0].open();
		await micro();
		await tick(600);
		body.send(': keep-alive\n\n' + frame({ v: 1, skip: true }) + 'data: not json\n\n');
		await micro();
		await tick(400);
		expect(stales(s.log)).toEqual(['stale:true']);
		body.send(': keep-alive\n\n' + frame({ v: 1, skip: true }));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true']);
		s.stop();
	});

	it('the clock keeps running while disconnected, and reconnecting alone does not end stale', async () => {
		const s = start({ staleAfterMs: 1000 });
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();
		body.end();
		await micro();
		await tick(1000);
		expect(stales(s.log)).toEqual(['stale:true']); // while waiting to reconnect

		await tick(2000);
		const next = s.calls[1].open();
		await micro();
		await tick(5000);
		expect(stales(s.log)).toEqual(['stale:true']);
		next.send(frame({ v: 2 }));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true', 'stale:false']);
		s.stop();
	});

	it('a session change, a 401 and a 403 leave the clock and the flag alone', async () => {
		const s = start({ staleAfterMs: 1000 });
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }));
		await micro();
		await tick(1000);
		expect(stales(s.log)).toEqual(['stale:true']);

		s.state.token = 'B';
		await tick(500);
		await tick(1);
		s.calls[1].status(403);
		await micro();
		await tick(3000);
		s.calls[2].status(401);
		await micro();
		s.state.token = 'C';
		await tick(500);
		const next = s.calls[3].open();
		await micro();
		expect(stales(s.log)).toEqual(['stale:true']);
		next.send(frame({ v: 2 }));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true', 'stale:false']);
		s.stop();
	});

	it('a session change does not restart a running clock either', async () => {
		const s = start({ staleAfterMs: 1000 });
		s.calls[0].open();
		await micro();
		await tick(400);
		s.state.token = 'B';
		await tick(500);
		await tick(1);
		s.calls[1].open();
		await micro();
		await tick(98);
		expect(stales(s.log)).toEqual([]);
		await tick(1);
		expect(stales(s.log)).toEqual(['stale:true']);
		s.stop();
	});

	it('stopping removes the clock', async () => {
		const s = start({ staleAfterMs: 1000 });
		s.calls[0].open();
		await micro();
		s.stop();
		expect(vi.getTimerCount()).toBe(0);
		await tick(5000);
		expect(stales(s.log)).toEqual([]);
	});
});

// Design §5.5: "the connection came back" is not "the value is new".
describe('createSseStream: valueStamp', () => {
	const stales = (log: string[]) => log.filter((entry) => entry.startsWith('stale:'));
	const stamped = { staleAfterMs: 1000, valueStamp: (value: Value) => value.at ?? 0 };

	it('a stopped producer: reconnects that re-send the same value neither end stale nor restart the clock', async () => {
		const s = start(stamped);
		let body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1, at: 100 }));
		await micro();

		// Re-sent on the same connection before the clock runs out: not restarted.
		await tick(600);
		body.send(frame({ v: 1, at: 100 }));
		await micro();
		await tick(400);
		expect(stales(s.log)).toEqual(['stale:true']);

		for (let i = 1; i <= 3; i++) {
			body.end();
			await micro();
			await tick(3000);
			body = s.calls[i].open();
			await micro();
			body.send(frame({ v: 1, at: 100 })); // watch_frames' current value, unchanged
			await micro();
		}
		// Every re-sent value was still handed over ...
		expect(s.log.filter((entry) => entry === 'event:1')).toHaveLength(5);
		// ... but none of them counted as new.
		expect(stales(s.log)).toEqual(['stale:true']);
		expect(vi.getTimerCount()).toBe(1); // the token watch; the stale clock was not re-armed

		// The producer is back: the mark changes.
		body.send(frame({ v: 2, at: 200 }));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true', 'stale:false']);
		s.stop();
	});

	it('remembers the mark per event name', async () => {
		const s = start({
			staleAfterMs: 1000,
			valueStamp: (value, event) => `${event ?? ''}@${value.at}`,
			parse: (data) => JSON.parse(data) as Value
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1, at: 100 }, 'temperature') + frame({ v: 2, at: 100 }, 'level'));
		await micro();
		await tick(1000);
		expect(stales(s.log)).toEqual(['stale:true']);

		// Each name's re-send is recognised although the other name came in between.
		body.send(frame({ v: 1, at: 100 }, 'temperature'));
		await micro();
		body.send(frame({ v: 2, at: 100 }, 'level'));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true']);

		// A new value of any one kind ends stale for the stream.
		body.send(frame({ v: 3, at: 200 }, 'level'));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true', 'stale:false']);
		s.stop();
	});

	it('the same mark under another name is a new value', async () => {
		const s = start(stamped);
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1, at: 100 }, 'temperature'));
		await micro();
		await tick(1000);
		body.send(frame({ v: 2, at: 100 }, 'level'));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true', 'stale:false']);
		s.stop();
	});

	it('the mark is kept across a session change', async () => {
		const s = start(stamped);
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1, at: 100 }));
		await micro();
		await tick(1000);
		s.state.token = 'B';
		await tick(500);
		await tick(1);
		const next = s.calls[1].open();
		await micro();
		next.send(frame({ v: 1, at: 100 }));
		await micro();
		expect(s.log.slice(-2)).toEqual(['connection:true', 'event:1']);
		expect(stales(s.log)).toEqual(['stale:true']);
		s.stop();
	});

	it('a throwing valueStamp drops that one event', async () => {
		const s = start({
			staleAfterMs: 1000,
			valueStamp: (value) => {
				if (value.at === undefined) throw new Error('no mark');
				return value.at;
			}
		});
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1 }) + frame({ v: 2, at: 1 }));
		await micro();
		expect(s.log).toEqual(['connection:true', 'event:2']);
		s.stop();
	});

	it('without valueStamp a reconnect’s re-sent value ends stale (onStale only says "receiving")', async () => {
		const s = start({ staleAfterMs: 1000 });
		const body = s.calls[0].open();
		await micro();
		body.send(frame({ v: 1, at: 100 }));
		await micro();
		await tick(1000);
		body.end();
		await micro();
		await tick(3000);
		const next = s.calls[1].open();
		await micro();
		next.send(frame({ v: 1, at: 100 }));
		await micro();
		expect(stales(s.log)).toEqual(['stale:true', 'stale:false']);
		s.stop();
	});
});
