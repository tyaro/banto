import { describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import {
	createHttpUiSettings,
	createLocalUiSettings,
	createTauriUiSettings
} from '../src/providers/uiSettings';

/** In-memory Storage stand-in: Node has no global localStorage (same helper as http.test.ts). */
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

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { 'content-type': 'application/json' }
	});
}

describe('createLocalUiSettings', () => {
	it('get resolves null for a key that was never set', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await expect(provider.get('theme.mode')).resolves.toBeNull();
	});

	it('set then get round-trips the value', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await provider.set('theme.mode', 'dark');
		await expect(provider.get('theme.mode')).resolves.toBe('dark');
	});

	it('stores under the banto.ui. prefix so app keys never collide', async () => {
		const storage = makeMemoryStorage();
		const provider = createLocalUiSettings({ storage });
		await provider.set('dock.dashboard', '{"version":2}');
		expect(storage.getItem('banto.ui.dock.dashboard')).toBe('{"version":2}');
	});

	it('rejects a key outside [A-Za-z0-9._-]{1,64} with a ProviderError', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await expect(provider.get('bad key!')).rejects.toSatisfy(isProviderError);
		await expect(provider.set('a'.repeat(65), 'v')).rejects.toSatisfy(isProviderError);
	});
});

describe('createTauriUiSettings', () => {
	// #786: the command answers `{ value, revision }`; the provider's shape is
	// still the old one (a string), so the revision is dropped here.
	it('get calls ui_settings_get with { key } and returns the stored string', async () => {
		const invoke = vi.fn().mockResolvedValue({ value: 'glass', revision: 'a1b2' });
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.get('theme.preset')).resolves.toBe('glass');
		expect(invoke).toHaveBeenCalledWith('ui_settings_get', { key: 'theme.preset' });
	});

	it('get maps an unset key ({ value: null, revision: "0" }) to null', async () => {
		const invoke = vi.fn().mockResolvedValue({ value: null, revision: '0' });
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.get('theme.preset')).resolves.toBeNull();
	});

	it('set calls ui_settings_set with { key, value } (no ifRevision) and resolves to undefined', async () => {
		const invoke = vi.fn().mockResolvedValue({ revision: 'c3d4' });
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.set('theme.mode', 'dark')).resolves.toBeUndefined();

		expect(invoke).toHaveBeenCalledWith('ui_settings_set', { key: 'theme.mode', value: 'dark' });
	});

	it('rethrows a rejected invoke() carrying an ErrorBody as a ProviderError', async () => {
		const invoke = vi.fn().mockRejectedValue({ kind: 'unauthorized' });
		const provider = createTauriUiSettings({ invoke });

		try {
			await provider.get('theme.mode');
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) expect(err.body).toEqual({ kind: 'unauthorized' });
		}
	});

	it('rejects an invalid key locally without calling invoke', async () => {
		const invoke = vi.fn();
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.set('のテーマ', 'x')).rejects.toSatisfy(isProviderError);
		expect(invoke).not.toHaveBeenCalled();
	});
});

describe('createHttpUiSettings', () => {
	it('get GETs {base}/api/ui-settings/{key} with CSRF + bearer headers and returns body.value', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { value: 'dark', revision: 'a1b2' }));
		const provider = createHttpUiSettings({
			baseUrl: 'http://h:8721',
			getToken: () => 'tok',
			fetchFn
		});

		await expect(provider.get('theme.mode')).resolves.toBe('dark');
		expect(fetchFn).toHaveBeenCalledWith('http://h:8721/api/ui-settings/theme.mode', {
			method: 'GET',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' }
		});
	});

	it('get maps {"value": null, "revision": "0"} (unset key) to null', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { value: null, revision: '0' }));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.get('theme.preset')).resolves.toBeNull();
	});

	// #786: the PUT answers `200 { revision }` (it was `204`); the old provider
	// shape resolves to undefined either way.
	it('set PUTs {base}/api/ui-settings/{key} with a {"value"} body and resolves on 200 {revision}', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { revision: 'c3d4' }));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.set('theme.preset', 'glass')).resolves.toBeUndefined();
		expect(fetchFn).toHaveBeenCalledWith('/api/ui-settings/theme.preset', {
			method: 'PUT',
			headers: {
				'X-Banto-Client': 'banto',
				'Content-Type': 'application/json',
				Authorization: 'Bearer tok'
			},
			body: JSON.stringify({ value: 'glass' })
		});
	});

	it('omits Authorization when getToken() returns null', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { value: null }));
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		await provider.get('theme.mode');

		const [, init] = fetchFn.mock.calls[0];
		expect(init.headers.Authorization).toBeUndefined();
	});

	it('maps a non-2xx ErrorBody JSON response to a matching ProviderError', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, { kind: 'unauthorized' }));
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		try {
			await provider.get('theme.mode');
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) expect(err.body).toEqual({ kind: 'unauthorized' });
		}
	});

	it('maps a network failure to kind "other" with a Japanese message', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		try {
			await provider.set('theme.mode', 'dark');
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err))
				expect(err.body).toEqual({ kind: 'other', message: 'サーバーに接続できません' });
		}
	});

	it('rejects an invalid key locally without calling fetch (it would otherwise mangle the URL)', async () => {
		const fetchFn = vi.fn();
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		await expect(provider.get('a/b')).rejects.toSatisfy(isProviderError);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

// --- write serialization (#707) --------------------------------------------

interface Deferred {
	promise: Promise<unknown>;
	resolve: (value?: unknown) => void;
	reject: (reason: unknown) => void;
}

function deferred(): Deferred {
	let resolve!: Deferred['resolve'];
	let reject!: Deferred['reject'];
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let queued microtasks (the drain loop's continuations) run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('createHttpUiSettings write serialization', () => {
	/** A fetch whose every call is a hand-resolved deferred; `calls` records method/url/body. */
	function makeFetch() {
		const pending: Deferred[] = [];
		const calls: Array<{ method: string; url: string; body?: string }> = [];
		const fetchFn = vi.fn((url: string, init: RequestInit) => {
			const d = deferred();
			pending.push(d);
			calls.push({ method: init.method as string, url, body: init.body as string | undefined });
			return d.promise as Promise<Response>;
		});
		return { fetchFn: fetchFn as unknown as typeof fetch, pending, calls };
	}
	const putBodies = (calls: Array<{ method: string; body?: string }>) =>
		calls.filter((c) => c.method === 'PUT').map((c) => c.body);
	const ok204 = () => new Response(null, { status: 204 });

	it('sends only the last value after the in-flight write; intermediate values are skipped', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const p1 = provider.set('theme.mode', 'a');
		const p2 = provider.set('theme.mode', 'b');
		const p3 = provider.set('theme.mode', 'c');
		await flush();
		expect(putBodies(calls)).toEqual(['{"value":"a"}']);

		pending[0].resolve(ok204());
		await flush();
		expect(putBodies(calls)).toEqual(['{"value":"a"}', '{"value":"c"}']);

		pending[1].resolve(ok204());
		await Promise.all([p1, p2, p3]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('sends different keys concurrently', async () => {
		const { fetchFn, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		void provider.set('theme.mode', 'dark');
		void provider.set('theme.preset', 'glass');
		await flush();
		expect(calls.map((c) => c.url)).toEqual([
			'/api/ui-settings/theme.mode',
			'/api/ui-settings/theme.preset'
		]);
	});

	it('drops a held write when the token changed: the sent set resolves, the dropped one rejects unauthorized', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		let token: string | null = 'tok';
		const provider = createHttpUiSettings({ getToken: () => token, fetchFn });

		const p1 = provider.set('theme.mode', 'a');
		const p2 = provider.set('theme.mode', 'b');
		await flush();
		token = 'other';
		pending[0].resolve(ok204());
		await expect(p1).resolves.toBeUndefined();
		await expect(p2).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		expect(putBodies(calls)).toEqual(['{"value":"a"}']);
	});

	it('drops a held write when the token became null', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		let token: string | null = 'tok';
		const provider = createHttpUiSettings({ getToken: () => token, fetchFn });

		const p1 = provider.set('theme.mode', 'a');
		const p2 = provider.set('theme.mode', 'b');
		await flush();
		token = null;
		pending[0].resolve(ok204());
		await expect(p1).resolves.toBeUndefined();
		await expect(p2).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		expect(calls).toHaveLength(1);
	});

	it('does not send when there is no token, and rejects unauthorized', async () => {
		const { fetchFn, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		await expect(provider.set('theme.mode', 'a')).rejects.toMatchObject({
			body: { kind: 'unauthorized' }
		});
		expect(calls).toHaveLength(0);
	});

	it('sends the next value after a failure; only the failed set rejects', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const p1 = provider.set('theme.mode', 'a');
		const p2 = provider.set('theme.mode', 'b');
		await flush();
		pending[0].reject(new TypeError('network down'));
		await expect(p1).rejects.toSatisfy(isProviderError);
		await flush();
		expect(putBodies(calls)).toEqual(['{"value":"a"}', '{"value":"b"}']);

		pending[1].resolve(ok204());
		await expect(p2).resolves.toBeUndefined();
	});

	it('get waits for the in-flight and held writes, then reads', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		void provider.set('theme.mode', 'a');
		void provider.set('theme.mode', 'b');
		const got = provider.get('theme.mode');
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT']);

		pending[0].resolve(ok204());
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);

		pending[1].resolve(ok204());
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'GET']);
		pending[2].resolve(jsonResponse(200, { value: 'b' }));
		await expect(got).resolves.toBe('b');
	});

	it('get still reads when the write failed', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const w = provider.set('theme.mode', 'a');
		const got = provider.get('theme.mode');
		await flush();
		pending[0].resolve(jsonResponse(500, { kind: 'storage', message: 'x' }));
		await expect(w).rejects.toSatisfy(isProviderError);
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);
		pending[1].resolve(jsonResponse(200, { value: 'old' }));
		await expect(got).resolves.toBe('old');
	});

	it('get does not wait for a write to another key', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		void provider.set('theme.mode', 'a');
		const got = provider.get('theme.preset');
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);
		pending[1].resolve(jsonResponse(200, { value: null }));
		await expect(got).resolves.toBeNull();
	});

	it('still rejects an invalid key immediately', async () => {
		const { fetchFn, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.set('bad key', 'x')).rejects.toSatisfy(isProviderError);
		await expect(provider.get('bad key')).rejects.toSatisfy(isProviderError);
		expect(calls).toHaveLength(0);
	});
});

describe('createTauriUiSettings write serialization', () => {
	function makeInvoke() {
		const pending: Deferred[] = [];
		const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
		const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
			const d = deferred();
			pending.push(d);
			calls.push({ cmd, args });
			return d.promise;
		});
		return { invoke, pending, calls };
	}

	it('sends one write per key at a time, only the last held value, other keys in parallel', async () => {
		const { invoke, pending, calls } = makeInvoke();
		const provider = createTauriUiSettings({ invoke });

		const p1 = provider.set('theme.mode', 'a');
		const p2 = provider.set('theme.mode', 'b');
		const p3 = provider.set('theme.mode', 'c');
		const q = provider.set('theme.preset', 'glass');
		await flush();
		expect(calls.map((c) => c.args)).toEqual([
			{ key: 'theme.mode', value: 'a' },
			{ key: 'theme.preset', value: 'glass' }
		]);

		pending[0].resolve(undefined);
		await flush();
		expect(calls[2].args).toEqual({ key: 'theme.mode', value: 'c' });
		pending[1].resolve(undefined);
		pending[2].resolve(undefined);
		await Promise.all([p1, p2, p3, q]);
		expect(invoke).toHaveBeenCalledTimes(3);
	});

	it('sends the next value after a failure', async () => {
		const { invoke, pending, calls } = makeInvoke();
		const provider = createTauriUiSettings({ invoke });

		const p1 = provider.set('theme.mode', 'a');
		const p2 = provider.set('theme.mode', 'b');
		await flush();
		pending[0].reject({ kind: 'unauthorized', message: 'x' });
		await expect(p1).rejects.toSatisfy(isProviderError);
		await flush();
		expect(calls[1].args).toEqual({ key: 'theme.mode', value: 'b' });
		pending[1].resolve(undefined);
		await expect(p2).resolves.toBeUndefined();
	});

	it('get waits for the writes, and reads even if the write failed', async () => {
		const { invoke, pending, calls } = makeInvoke();
		const provider = createTauriUiSettings({ invoke });

		const w = provider.set('theme.mode', 'a');
		const got = provider.get('theme.mode');
		await flush();
		expect(calls.map((c) => c.cmd)).toEqual(['ui_settings_set']);
		pending[0].reject({ kind: 'storage', message: 'x' });
		await expect(w).rejects.toSatisfy(isProviderError);
		await flush();
		expect(calls.map((c) => c.cmd)).toEqual(['ui_settings_set', 'ui_settings_get']);
		pending[1].resolve({ value: 'old', revision: 'a1b2' });
		await expect(got).resolves.toBe('old');
	});

	describe('getSessionRevision', () => {
		it('drops the held write when the revision changed before it would be sent', async () => {
			const { invoke, pending, calls } = makeInvoke();
			let revision = 'rev-alice';
			const provider = createTauriUiSettings({ invoke, getSessionRevision: () => revision });

			const p1 = provider.set('theme.mode', 'a');
			const p2 = provider.set('theme.mode', 'b');
			await flush();
			revision = 'rev-bob';
			pending[0].resolve(undefined);
			await expect(p1).resolves.toBeUndefined();
			await expect(p2).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
			await flush();
			expect(calls.map((c) => c.args)).toEqual([{ key: 'theme.mode', value: 'a' }]);
		});

		it('sends the held write when the revision is unchanged', async () => {
			const { invoke, pending, calls } = makeInvoke();
			const provider = createTauriUiSettings({ invoke, getSessionRevision: () => 'rev-alice' });

			const p1 = provider.set('theme.mode', 'a');
			const p2 = provider.set('theme.mode', 'b');
			await flush();
			pending[0].resolve(undefined);
			await flush();
			expect(calls[1].args).toEqual({ key: 'theme.mode', value: 'b' });
			pending[1].resolve(undefined);
			await Promise.all([p1, p2]);
		});

		it('does not check the session when omitted (as before)', async () => {
			const { invoke, pending, calls } = makeInvoke();
			const provider = createTauriUiSettings({ invoke });

			const p1 = provider.set('theme.mode', 'a');
			const p2 = provider.set('theme.mode', 'b');
			await flush();
			pending[0].resolve(undefined);
			await flush();
			expect(calls[1].args).toEqual({ key: 'theme.mode', value: 'b' });
			pending[1].resolve(undefined);
			await Promise.all([p1, p2]);
		});
	});
});
