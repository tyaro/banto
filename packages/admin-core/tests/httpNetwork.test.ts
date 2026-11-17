/**
 * Issue #637: telling "the server never answered" (a `fetch` rejection or
 * the request's own deadline) apart from every answer the server gave, and
 * reporting it to `onRequestResult`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNetworkError, isProviderError, ProviderError } from '../src/errors';
import {
	createHttpAuthProvider,
	createHttpDataProvider,
	DEFAULT_REQUEST_TIMEOUT_MS,
	type HttpRequestResult
} from '../src/providers/http';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function abortError(): DOMException {
	return new DOMException('The operation was aborted.', 'AbortError');
}

/** A `fetch` that never answers, and rejects like the real one when its signal aborts. */
function hangingFetch() {
	return vi.fn(
		(_url: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(abortError());
				signal?.addEventListener('abort', () => reject(abortError()), { once: true });
			})
	);
}

/** A response whose headers arrived but whose body never does (until aborted). */
function stallingBodyFetch() {
	return vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
		Promise.resolve({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: () =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
				})
		} as unknown as Response)
	);
}

function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		}
	} as Storage;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('sessionStorage', makeMemoryStorage());
	vi.stubGlobal('localStorage', makeMemoryStorage());
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('isNetworkError', () => {
	it('is false for an unmarked ProviderError and for non-ProviderErrors', () => {
		expect(isNetworkError(new ProviderError({ kind: 'other', message: 'x' }))).toBe(false);
		expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(false);
		expect(isNetworkError(null)).toBe(false);
	});

	it('is true for a marked ProviderError, which keeps the kind and message', () => {
		const err = new ProviderError({ kind: 'other', message: 'm' }, { networkFailure: 'timeout' });
		expect(isNetworkError(err)).toBe(true);
		expect(err.body).toEqual({ kind: 'other', message: 'm' });
		expect(err.message).toBe('m');
	});
});

describe('createHttpDataProvider: network failures (Issue #637)', () => {
	it('marks a fetch rejection as networkFailure "network", same body as before, and reports it', async () => {
		const results: HttpRequestResult[] = [];
		const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn,
			onRequestResult: (r) => results.push(r)
		});

		const err = await caught(provider.getOne('items', 1));
		expect(isNetworkError(err)).toBe(true);
		expect((err as ProviderError).networkFailure).toBe('network');
		expect((err as ProviderError).body).toEqual({
			kind: 'other',
			message: 'サーバーに接続できません'
		});
		expect(results).toEqual([{ ok: false, failure: 'network', startedAt: Date.now() }]);
	});

	it.each([400, 401, 403, 404, 422, 500, 503])(
		'an HTTP %i is an answer: not a network error, reported ok',
		async (status) => {
			const results: HttpRequestResult[] = [];
			const fetchFn = vi
				.fn()
				.mockResolvedValue(jsonResponse(status, { kind: 'other', message: 'e' }));
			const provider = createHttpDataProvider({
				getToken: () => null,
				fetchFn,
				onRequestResult: (r) => results.push(r)
			});
			const err = await caught(provider.getOne('items', 1));
			expect(isProviderError(err)).toBe(true);
			expect(isNetworkError(err)).toBe(false);
			expect(results).toEqual([{ ok: true, startedAt: Date.now() }]);
		}
	);

	it('an unparseable error body is still an answer', async () => {
		const results: HttpRequestResult[] = [];
		const fetchFn = vi.fn().mockResolvedValue(new Response('<html>', { status: 502 }));
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn,
			onRequestResult: (r) => results.push(r)
		});
		const err = await caught(provider.getOne('items', 1));
		expect(isNetworkError(err)).toBe(false);
		expect(results.map((r) => r.ok)).toEqual([true]);
	});

	it('a success is reported ok once', async () => {
		const results: HttpRequestResult[] = [];
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn,
			onRequestResult: (r) => results.push(r)
		});
		await provider.getOne('items', 1);
		expect(results).toEqual([{ ok: true, startedAt: Date.now() }]);
	});

	it('times out after the default 20 s as networkFailure "timeout", not a moment earlier', async () => {
		expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(20_000);
		const results: HttpRequestResult[] = [];
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn: hangingFetch(),
			onRequestResult: (r) => results.push(r)
		});
		const startedAt = Date.now();
		let settled: unknown = 'pending';
		provider.getOne('items', 1).catch((e) => (settled = e));

		await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
		expect(settled).toBe('pending');
		expect(results).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(isNetworkError(settled)).toBe(true);
		expect((settled as ProviderError).networkFailure).toBe('timeout');
		expect((settled as ProviderError).message).toBe('サーバーに接続できません');
		expect(results).toEqual([{ ok: false, failure: 'timeout', startedAt }]);
	});

	it('honours a custom timeoutMs', async () => {
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn: hangingFetch(),
			timeoutMs: 500
		});
		const pending = caught(provider.getOne('items', 1));
		await vi.advanceTimersByTimeAsync(500);
		expect(((await pending) as ProviderError).networkFailure).toBe('timeout');
	});

	it('a body that stalls after the headers times out too', async () => {
		const results: HttpRequestResult[] = [];
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn: stallingBodyFetch(),
			timeoutMs: 1000,
			onRequestResult: (r) => results.push(r)
		});
		const pending = caught(provider.getOne('items', 1));
		await vi.advanceTimersByTimeAsync(1000);
		expect(((await pending) as ProviderError).networkFailure).toBe('timeout');
		expect(results.map((r) => r.ok)).toEqual([false]);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		'timeoutMs %s disables the deadline and sends no signal',
		async (timeoutMs) => {
			const fetchFn = hangingFetch();
			const provider = createHttpDataProvider({ getToken: () => null, fetchFn, timeoutMs });
			let settled = false;
			provider.getOne('items', 1).catch(() => (settled = true));
			await vi.advanceTimersByTimeAsync(10 * DEFAULT_REQUEST_TIMEOUT_MS);
			expect(settled).toBe(false);
			expect(fetchFn.mock.calls[0][1]).not.toHaveProperty('signal');
		}
	);

	it('clears its timer once the request settles (no late abort, no leaked timer)', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
		const provider = createHttpDataProvider({ getToken: () => null, fetchFn });
		await provider.getOne('items', 1);
		expect(vi.getTimerCount()).toBe(0);
		const signal = (fetchFn.mock.calls[0][1] as RequestInit).signal as AbortSignal;
		await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
		expect(signal.aborted).toBe(false);
	});

	it('a malformed 200 body rejects as before (not a network error) and counts as an answer', async () => {
		const results: HttpRequestResult[] = [];
		const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn,
			onRequestResult: (r) => results.push(r)
		});
		const err = await caught(provider.getOne('items', 1));
		expect(err).toBeInstanceOf(SyntaxError);
		expect(results.map((r) => r.ok)).toEqual([true]);
	});

	it('a throwing listener does not change the request outcome', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 7 }));
		const provider = createHttpDataProvider({
			getToken: () => null,
			fetchFn,
			onRequestResult: () => {
				throw new Error('listener bug');
			}
		});
		await expect(provider.getOne('items', 7)).resolves.toEqual({ id: 7 });
	});
});

describe('createHttpAuthProvider.resolve: timeout and the caller signal (Issue #637)', () => {
	beforeEach(() => {
		sessionStorage.setItem('banto.auth.token', 'tok');
	});

	it('without resolveTimeoutMs passes the caller signal through unchanged and has no deadline', async () => {
		const fetchFn = hangingFetch();
		const auth = createHttpAuthProvider({ fetchFn });
		const abort = new AbortController();
		let settled = false;
		auth.resolve({ signal: abort.signal }).catch(() => (settled = true));
		await vi.advanceTimersByTimeAsync(10 * DEFAULT_REQUEST_TIMEOUT_MS);
		expect(settled).toBe(false);
		expect((fetchFn.mock.calls[0][1] as RequestInit).signal).toBe(abort.signal);
		abort.abort();
	});

	it('a caller abort is the old unmarked error and is not reported', async () => {
		const results: HttpRequestResult[] = [];
		const auth = createHttpAuthProvider({
			fetchFn: hangingFetch(),
			resolveTimeoutMs: 1000,
			onRequestResult: (r) => results.push(r)
		});
		const abort = new AbortController();
		const pending = caught(auth.resolve({ signal: abort.signal }));
		abort.abort();
		const err = await pending;
		expect(isProviderError(err)).toBe(true);
		expect(isNetworkError(err)).toBe(false);
		expect((err as ProviderError).body).toEqual({
			kind: 'other',
			message: 'サーバーに接続できません'
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(results).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a signal already aborted on entry never counts as a timeout', async () => {
		const results: HttpRequestResult[] = [];
		const fetchFn = hangingFetch();
		const auth = createHttpAuthProvider({
			fetchFn,
			resolveTimeoutMs: 1000,
			onRequestResult: (r) => results.push(r)
		});
		const abort = new AbortController();
		abort.abort();
		const err = await caught(auth.resolve({ signal: abort.signal }));
		expect(isNetworkError(err)).toBe(false);
		expect(results).toEqual([]);
	});

	it('the deadline fires first: a timeout even if the caller aborts right after', async () => {
		const results: HttpRequestResult[] = [];
		const auth = createHttpAuthProvider({
			fetchFn: hangingFetch(),
			resolveTimeoutMs: 1000,
			onRequestResult: (r) => results.push(r)
		});
		const abort = new AbortController();
		const pending = caught(auth.resolve({ signal: abort.signal }));
		await vi.advanceTimersByTimeAsync(1000);
		abort.abort();
		const err = await pending;
		expect((err as ProviderError).networkFailure).toBe('timeout');
		expect(results.map((r) => r.ok)).toEqual([false]);
	});

	it('the caller aborts in the same tick as the deadline but first: the caller wins', async () => {
		const results: HttpRequestResult[] = [];
		const auth = createHttpAuthProvider({
			fetchFn: hangingFetch(),
			resolveTimeoutMs: 1000,
			onRequestResult: (r) => results.push(r)
		});
		const abort = new AbortController();
		// Both due at 1000 ms; this timer was queued first, so it fires first.
		setTimeout(() => abort.abort(), 1000);
		const pending = caught(auth.resolve({ signal: abort.signal }));
		await vi.advanceTimersByTimeAsync(1000);
		const err = await pending;
		expect(isNetworkError(err)).toBe(false);
		expect(results).toEqual([]);
	});

	it('removes its listener from the caller signal after settling', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'u', name: 'U' }));
		const auth = createHttpAuthProvider({ fetchFn, resolveTimeoutMs: 1000 });
		const abort = new AbortController();
		const remove = vi.spyOn(abort.signal, 'removeEventListener');
		await expect(auth.resolve({ signal: abort.signal })).resolves.toMatchObject({
			status: 'active'
		});
		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
		const inner = (fetchFn.mock.calls[0][1] as RequestInit).signal as AbortSignal;
		abort.abort();
		expect(inner.aborted).toBe(false);
	});

	it('a 401 is an answer (reported ok) and a fetch rejection is a marked network error', async () => {
		const results: HttpRequestResult[] = [];
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		const auth = createHttpAuthProvider({ fetchFn, onRequestResult: (r) => results.push(r) });
		await expect(auth.resolve()).resolves.toMatchObject({ status: 'none' });
		sessionStorage.setItem('banto.auth.token', 'tok2');
		const err = await caught(auth.resolve());
		expect((err as ProviderError).networkFailure).toBe('network');
		expect(results.map((r) => r.ok)).toEqual([true, false]);
	});

	it('without a stored token sends nothing and reports nothing', async () => {
		sessionStorage.clear();
		const results: HttpRequestResult[] = [];
		const fetchFn = vi.fn();
		const auth = createHttpAuthProvider({ fetchFn, onRequestResult: (r) => results.push(r) });
		await auth.resolve();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(results).toEqual([]);
	});
});
