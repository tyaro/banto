import { describe, expect, it, vi } from 'vitest';
import { isNetworkError, isProviderError, ProviderError } from '../src/errors';
import {
	createHttpUiSettings,
	createLocalUiSettings,
	createTauriUiSettings,
	uiSettingConflict,
	updateUiSetting,
	type UiSettingSnapshot,
	type UiSettingsProvider
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

/** The wire body of a failed condition (REST 409 / the Tauri command's error, #786). */
function conflictBody(current: UiSettingSnapshot) {
	return { kind: 'conflict', message: 'ui setting changed', current };
}

describe('createLocalUiSettings', () => {
	it('get answers { value: null, revision: "0" } for a key that was never set', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await expect(provider.get('theme.mode')).resolves.toEqual({ value: null, revision: '0' });
	});

	it('set answers a revision, and get returns the value with that revision', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		const written = await provider.set('theme.mode', 'dark');
		expect(written.revision).toEqual(expect.any(String));
		expect(written.revision).not.toBe('0');
		await expect(provider.get('theme.mode')).resolves.toEqual({
			value: 'dark',
			revision: written.revision
		});
		// Reading does not change the revision.
		await expect(provider.get('theme.mode')).resolves.toEqual({
			value: 'dark',
			revision: written.revision
		});
	});

	it('every write changes the revision, even with the same value', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		const first = await provider.set('theme.mode', 'dark');
		const second = await provider.set('theme.mode', 'dark');
		expect(second.revision).not.toBe(first.revision);
	});

	it('stores the value as is under the banto.ui. prefix so app keys never collide', async () => {
		const storage = makeMemoryStorage();
		const provider = createLocalUiSettings({ storage });
		await provider.set('dock.dashboard', '{"version":2}');
		expect(storage.getItem('banto.ui.dock.dashboard')).toBe('{"version":2}');
	});

	it('a conditional set writes only while the revision still matches', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		const first = await provider.set('k', 'a', { ifRevision: '0' });
		const second = await provider.set('k', 'b', { ifRevision: first.revision as string });

		// The first revision is stale now.
		const stale = await provider
			.set('k', 'c', { ifRevision: first.revision as string })
			.catch((error: unknown) => error);
		expect(uiSettingConflict(stale)).toEqual({ value: 'b', revision: second.revision });
		// "only while nothing is stored" fails too, once something is.
		const again = await provider.set('k', 'c', { ifRevision: '0' }).catch((e: unknown) => e);
		expect(uiSettingConflict(again)).toEqual({ value: 'b', revision: second.revision });
		await expect(provider.get('k')).resolves.toEqual({ value: 'b', revision: second.revision });
	});

	it('remove deletes the value and answers "0"; a recreated key does not accept the old revision', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		const before = await provider.set('k', 'a');
		await expect(provider.remove('k')).resolves.toEqual({ revision: '0' });
		await expect(provider.get('k')).resolves.toEqual({ value: null, revision: '0' });
		// Removing nothing succeeds.
		await expect(provider.remove('k')).resolves.toEqual({ revision: '0' });

		await provider.set('k', 'a');
		const stale = await provider
			.set('k', 'b', { ifRevision: before.revision as string })
			.catch((e: unknown) => e);
		expect(uiSettingConflict(stale)?.value).toBe('a');
	});

	it('a conditional remove with a stale revision is a conflict and deletes nothing', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		const first = await provider.set('k', 'a');
		const second = await provider.set('k', 'b');
		const stale = await provider
			.remove('k', { ifRevision: first.revision as string })
			.catch((e: unknown) => e);
		expect(uiSettingConflict(stale)).toEqual({ value: 'b', revision: second.revision });
		await expect(provider.remove('k', { ifRevision: second.revision as string })).resolves.toEqual({
			revision: '0'
		});
	});

	it('a value written by something else gets a new revision (the old one stops matching)', async () => {
		const storage = makeMemoryStorage();
		const provider = createLocalUiSettings({ storage });
		const mine = await provider.set('k', 'a');
		storage.setItem('banto.ui.k', 'primed'); // e.g. a test priming the key directly
		const read = await provider.get('k');
		expect(read.value).toBe('primed');
		expect(read.revision).not.toBe(mine.revision);
		expect(read.revision).not.toBe('0');
		await expect(provider.get('k')).resolves.toEqual(read);
		await expect(
			provider.set('k', 'b', { ifRevision: mine.revision as string })
		).rejects.toMatchObject({ body: { kind: 'conflict' } });
	});

	it('rejects a key outside [A-Za-z0-9._-]{1,64} with a ProviderError', async () => {
		const provider = createLocalUiSettings({ storage: makeMemoryStorage() });
		await expect(provider.get('bad key!')).rejects.toSatisfy(isProviderError);
		await expect(provider.set('a'.repeat(65), 'v')).rejects.toSatisfy(isProviderError);
		await expect(provider.remove('a/b')).rejects.toSatisfy(isProviderError);
	});
});

describe('uiSettingConflict', () => {
	it('is null for anything that is not a ui-settings conflict', () => {
		expect(uiSettingConflict(new Error('x'))).toBeNull();
		expect(uiSettingConflict(new ProviderError({ kind: 'unauthorized' }))).toBeNull();
		// A conflict without a `{ value, revision }` current (another resource's shape).
		expect(
			uiSettingConflict(
				new ProviderError({ kind: 'conflict', message: 'x', current: { id: 1, version: 3 } })
			)
		).toBeNull();
		expect(uiSettingConflict(new ProviderError({ kind: 'conflict', message: 'x' }))).toBeNull();
	});
});

describe('createTauriUiSettings', () => {
	it('get calls ui_settings_get with { key } and returns { value, revision }', async () => {
		const invoke = vi.fn().mockResolvedValue({ value: 'glass', revision: 'a1b2' });
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.get('theme.preset')).resolves.toEqual({
			value: 'glass',
			revision: 'a1b2'
		});
		expect(invoke).toHaveBeenCalledWith('ui_settings_get', { key: 'theme.preset' });
	});

	it('get passes an unset key through as { value: null, revision: "0" }', async () => {
		const invoke = vi.fn().mockResolvedValue({ value: null, revision: '0' });
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.get('theme.preset')).resolves.toEqual({ value: null, revision: '0' });
	});

	it('set calls ui_settings_set with { key, value } (no ifRevision) and returns the revision', async () => {
		const invoke = vi.fn().mockResolvedValue({ revision: 'c3d4' });
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.set('theme.mode', 'dark')).resolves.toEqual({ revision: 'c3d4' });
		expect(invoke).toHaveBeenCalledWith('ui_settings_set', { key: 'theme.mode', value: 'dark' });
	});

	it('a conditional set passes ifRevision, and a conflict carries the current value', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce({ revision: 'r2' })
			.mockRejectedValueOnce(conflictBody({ value: 'other', revision: 'r9' }));
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.set('k', 'a', { ifRevision: 'r1' })).resolves.toEqual({
			revision: 'r2'
		});
		expect(invoke).toHaveBeenCalledWith('ui_settings_set', {
			key: 'k',
			value: 'a',
			ifRevision: 'r1'
		});

		const error = await provider.set('k', 'b', { ifRevision: 'r1' }).catch((e: unknown) => e);
		expect(isProviderError(error)).toBe(true);
		expect(uiSettingConflict(error)).toEqual({ value: 'other', revision: 'r9' });
	});

	it('remove calls ui_settings_delete (ifRevision only when given) and returns { revision: "0" }', async () => {
		const invoke = vi.fn().mockResolvedValue({ revision: '0' });
		const provider = createTauriUiSettings({ invoke });

		await expect(provider.remove('k')).resolves.toEqual({ revision: '0' });
		expect(invoke).toHaveBeenLastCalledWith('ui_settings_delete', { key: 'k' });
		await expect(provider.remove('k', { ifRevision: 'r1' })).resolves.toEqual({ revision: '0' });
		expect(invoke).toHaveBeenLastCalledWith('ui_settings_delete', { key: 'k', ifRevision: 'r1' });
	});

	it('a conditional remove that lost is a conflict with the current value', async () => {
		const invoke = vi.fn().mockRejectedValue(conflictBody({ value: 'x', revision: 'r5' }));
		const provider = createTauriUiSettings({ invoke });

		const error = await provider.remove('k', { ifRevision: 'r1' }).catch((e: unknown) => e);
		expect(uiSettingConflict(error)).toEqual({ value: 'x', revision: 'r5' });
	});

	it('refuses an answer that is not the #786 shape (a pre-v8 backend)', async () => {
		const provider = createTauriUiSettings({ invoke: vi.fn().mockResolvedValue('dark') });
		await expect(provider.get('theme.mode')).rejects.toSatisfy(isProviderError);
		const old = createTauriUiSettings({ invoke: vi.fn().mockResolvedValue(null) });
		await expect(old.set('theme.mode', 'dark')).rejects.toSatisfy(isProviderError);
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
		await expect(provider.remove('のテーマ')).rejects.toSatisfy(isProviderError);
		expect(invoke).not.toHaveBeenCalled();
	});
});

describe('createHttpUiSettings', () => {
	it('get GETs {base}/api/ui-settings/{key} with CSRF + bearer headers and returns { value, revision }', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { value: 'dark', revision: 'a1b2' }));
		const provider = createHttpUiSettings({
			baseUrl: 'http://h:8721',
			getToken: () => 'tok',
			fetchFn
		});

		await expect(provider.get('theme.mode')).resolves.toEqual({ value: 'dark', revision: 'a1b2' });
		expect(fetchFn).toHaveBeenCalledWith('http://h:8721/api/ui-settings/theme.mode', {
			method: 'GET',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' }
		});
	});

	it('get passes {"value": null, "revision": "0"} (unset key) through', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { value: null, revision: '0' }));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.get('theme.preset')).resolves.toEqual({ value: null, revision: '0' });
	});

	it('set PUTs {base}/api/ui-settings/{key} with a {"value"} body and returns the revision', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { revision: 'c3d4' }));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.set('theme.preset', 'glass')).resolves.toEqual({ revision: 'c3d4' });
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

	it('a conditional set sends ifRevision in the body, and a 409 carries the current value', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(200, { revision: 'r2' }))
			.mockResolvedValueOnce(jsonResponse(409, conflictBody({ value: 'other', revision: 'r9' })));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		await expect(provider.set('k', 'a', { ifRevision: 'r1' })).resolves.toEqual({
			revision: 'r2'
		});
		expect(fetchFn.mock.calls[0][1].body).toBe(JSON.stringify({ value: 'a', ifRevision: 'r1' }));

		const error = await provider.set('k', 'b', { ifRevision: 'r1' }).catch((e: unknown) => e);
		expect(isProviderError(error)).toBe(true);
		expect(uiSettingConflict(error)).toEqual({ value: 'other', revision: 'r9' });
	});

	it('a conflict whose row is gone answers { value: null, revision: "0" }', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(jsonResponse(409, conflictBody({ value: null, revision: '0' })));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const error = await provider.set('k', 'b', { ifRevision: 'r1' }).catch((e: unknown) => e);
		expect(uiSettingConflict(error)).toEqual({ value: null, revision: '0' });
	});

	it('remove DELETEs {base}/api/ui-settings/{key} (ifRevision as a query) and returns { revision: "0" }', async () => {
		const fetchFn = vi.fn(async () => jsonResponse(200, { revision: '0' }));
		const provider = createHttpUiSettings({
			getToken: () => 'tok',
			fetchFn: fetchFn as unknown as typeof fetch
		});

		await expect(provider.remove('k')).resolves.toEqual({ revision: '0' });
		expect(fetchFn).toHaveBeenLastCalledWith('/api/ui-settings/k', {
			method: 'DELETE',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' }
		});
		await expect(provider.remove('k', { ifRevision: 'a+b/c=' })).resolves.toEqual({
			revision: '0'
		});
		expect(fetchFn).toHaveBeenLastCalledWith('/api/ui-settings/k?ifRevision=a%2Bb%2Fc%3D', {
			method: 'DELETE',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' }
		});
	});

	it('a conditional remove that lost is a conflict with the current value', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(jsonResponse(409, conflictBody({ value: 'x', revision: 'r5' })));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const error = await provider.remove('k', { ifRevision: 'r1' }).catch((e: unknown) => e);
		expect(uiSettingConflict(error)).toEqual({ value: 'x', revision: 'r5' });
	});

	it('refuses an answer that is not the #786 shape (a pre-v8 server answering 204 / a bare value)', async () => {
		const noBody = vi.fn(async () => new Response(null, { status: 204 }));
		const old = createHttpUiSettings({
			getToken: () => 'tok',
			fetchFn: noBody as unknown as typeof fetch
		});
		await expect(old.set('theme.mode', 'dark')).rejects.toSatisfy(isProviderError);

		const bare = vi.fn().mockResolvedValue(jsonResponse(200, { value: 'dark' }));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn: bare });
		await expect(provider.get('theme.mode')).rejects.toSatisfy(isProviderError);
	});

	it('omits Authorization when getToken() returns null', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { value: null, revision: '0' }));
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

	it('maps a network failure to kind "other" with a Japanese message, marked as a network failure', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		try {
			await provider.set('theme.mode', 'dark');
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err))
				expect(err.body).toEqual({ kind: 'other', message: 'サーバーに接続できません' });
			expect(isNetworkError(err)).toBe(true);
		}
	});

	it('rejects an invalid key locally without calling fetch (it would otherwise mangle the URL)', async () => {
		const fetchFn = vi.fn();
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		await expect(provider.get('a/b')).rejects.toSatisfy(isProviderError);
		await expect(provider.remove('a/b')).rejects.toSatisfy(isProviderError);
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
	const wrote = (revision: string) => jsonResponse(200, { revision });

	it('sends only the last unconditional value after the in-flight write; the skipped one answers superseded, not a revision', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const p1 = provider.set('theme.mode', 'a');
		const p2 = provider.set('theme.mode', 'b');
		const p3 = provider.set('theme.mode', 'c');
		await flush();
		expect(putBodies(calls)).toEqual(['{"value":"a"}']);
		// The skipped value is settled at once: nothing will ever be sent for it.
		await expect(p2).resolves.toEqual({ revision: null, superseded: true });

		pending[0].resolve(wrote('r1'));
		await flush();
		expect(putBodies(calls)).toEqual(['{"value":"a"}', '{"value":"c"}']);

		pending[1].resolve(wrote('r2'));
		await expect(p1).resolves.toEqual({ revision: 'r1' });
		await expect(p3).resolves.toEqual({ revision: 'r2' });
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('never supersedes a conditional set: each one is sent, in order, and answers its own outcome', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const p1 = provider.set('k', 'a');
		const p2 = provider.set('k', 'b', { ifRevision: 'r0' });
		const p3 = provider.set('k', 'c', { ifRevision: 'r0' });
		const p4 = provider.set('k', 'd'); // unconditional, but the one before it is conditional
		await flush();
		expect(putBodies(calls)).toEqual(['{"value":"a"}']);

		pending[0].resolve(wrote('r1'));
		await flush();
		expect(putBodies(calls)).toEqual(['{"value":"a"}', '{"value":"b","ifRevision":"r0"}']);
		// The server refuses it: the caller sees the conflict, never a "went through".
		pending[1].resolve(jsonResponse(409, conflictBody({ value: 'a', revision: 'r1' })));
		const lost = await p2.catch((e: unknown) => e);
		expect(uiSettingConflict(lost)).toEqual({ value: 'a', revision: 'r1' });

		await flush();
		expect(putBodies(calls)[2]).toBe('{"value":"c","ifRevision":"r0"}');
		pending[2].resolve(jsonResponse(409, conflictBody({ value: 'a', revision: 'r1' })));
		await expect(p3).rejects.toMatchObject({ body: { kind: 'conflict' } });

		await flush();
		expect(putBodies(calls)[3]).toBe('{"value":"d"}');
		pending[3].resolve(wrote('r2'));
		await expect(p1).resolves.toEqual({ revision: 'r1' });
		await expect(p4).resolves.toEqual({ revision: 'r2' });
		expect(fetchFn).toHaveBeenCalledTimes(4);
	});

	it('a conditional set does not supersede a waiting unconditional one (both are sent, in order)', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const p1 = provider.set('k', 'a');
		const p2 = provider.set('k', 'b');
		const p3 = provider.set('k', 'c', { ifRevision: 'r0' });
		await flush();
		pending[0].resolve(wrote('r1'));
		await flush();
		pending[1].resolve(wrote('r2'));
		await flush();
		pending[2].resolve(jsonResponse(409, conflictBody({ value: 'b', revision: 'r2' })));
		await expect(p1).resolves.toEqual({ revision: 'r1' });
		await expect(p2).resolves.toEqual({ revision: 'r2' });
		await expect(p3).rejects.toMatchObject({ body: { kind: 'conflict' } });
		expect(putBodies(calls)).toEqual([
			'{"value":"a"}',
			'{"value":"b"}',
			'{"value":"c","ifRevision":"r0"}'
		]);
	});

	it('an unconditional remove supersedes a waiting unconditional set; the remove itself is always sent', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		const p1 = provider.set('k', 'a');
		const p2 = provider.set('k', 'b');
		const p3 = provider.remove('k');
		const p4 = provider.set('k', 'c'); // does not supersede the remove
		await flush();
		await expect(p2).resolves.toEqual({ revision: null, superseded: true });
		pending[0].resolve(wrote('r1'));
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
		pending[1].resolve(wrote('0'));
		await flush();
		pending[2].resolve(wrote('r2'));
		await expect(p1).resolves.toEqual({ revision: 'r1' });
		await expect(p3).resolves.toEqual({ revision: '0' });
		await expect(p4).resolves.toEqual({ revision: 'r2' });
		expect(putBodies(calls)).toEqual(['{"value":"a"}', '{"value":"c"}']);
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
		const p3 = provider.set('theme.mode', 'c', { ifRevision: 'r0' });
		const p4 = provider.remove('theme.mode');
		await flush();
		token = 'other';
		pending[0].resolve(wrote('r1'));
		await expect(p1).resolves.toEqual({ revision: 'r1' });
		await expect(p2).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		await expect(p3).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		await expect(p4).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		expect(calls).toHaveLength(1);
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
		pending[0].resolve(wrote('r1'));
		await expect(p1).resolves.toEqual({ revision: 'r1' });
		await expect(p2).rejects.toMatchObject({ body: { kind: 'unauthorized' } });
		expect(calls).toHaveLength(1);
	});

	it('does not send when there is no token, and rejects unauthorized', async () => {
		const { fetchFn, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => null, fetchFn });

		await expect(provider.set('theme.mode', 'a')).rejects.toMatchObject({
			body: { kind: 'unauthorized' }
		});
		await expect(provider.remove('theme.mode')).rejects.toMatchObject({
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

		pending[1].resolve(wrote('r2'));
		await expect(p2).resolves.toEqual({ revision: 'r2' });
	});

	it('get waits for the in-flight and queued writes, then reads', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		void provider.set('theme.mode', 'a');
		void provider.set('theme.mode', 'b', { ifRevision: 'r1' });
		const got = provider.get('theme.mode');
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT']);

		pending[0].resolve(wrote('r1'));
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);

		pending[1].resolve(wrote('r2'));
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'GET']);
		pending[2].resolve(jsonResponse(200, { value: 'b', revision: 'r2' }));
		await expect(got).resolves.toEqual({ value: 'b', revision: 'r2' });
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
		pending[1].resolve(jsonResponse(200, { value: 'old', revision: 'r0' }));
		await expect(got).resolves.toEqual({ value: 'old', revision: 'r0' });
	});

	it('get does not wait for a write to another key', async () => {
		const { fetchFn, pending, calls } = makeFetch();
		const provider = createHttpUiSettings({ getToken: () => 'tok', fetchFn });

		void provider.set('theme.mode', 'a');
		const got = provider.get('theme.preset');
		await flush();
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);
		pending[1].resolve(jsonResponse(200, { value: null, revision: '0' }));
		await expect(got).resolves.toEqual({ value: null, revision: '0' });
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

	it('sends one write per key at a time, only the last unconditional value, other keys in parallel', async () => {
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

		pending[0].resolve({ revision: 'r1' });
		await flush();
		expect(calls[2].args).toEqual({ key: 'theme.mode', value: 'c' });
		pending[1].resolve({ revision: 'q1' });
		pending[2].resolve({ revision: 'r2' });
		await expect(Promise.all([p1, p2, p3, q])).resolves.toEqual([
			{ revision: 'r1' },
			{ revision: null, superseded: true },
			{ revision: 'r2' },
			{ revision: 'q1' }
		]);
		expect(invoke).toHaveBeenCalledTimes(3);
	});

	it('never supersedes a conditional write: set and delete go out in order with their ifRevision', async () => {
		const { invoke, pending, calls } = makeInvoke();
		const provider = createTauriUiSettings({ invoke });

		const p1 = provider.set('k', 'a');
		const p2 = provider.set('k', 'b', { ifRevision: 'r0' });
		const p3 = provider.remove('k', { ifRevision: 'r0' });
		await flush();
		pending[0].resolve({ revision: 'r1' });
		await flush();
		expect(calls[1]).toEqual({
			cmd: 'ui_settings_set',
			args: { key: 'k', value: 'b', ifRevision: 'r0' }
		});
		pending[1].reject(conflictBody({ value: 'a', revision: 'r1' }));
		const lost = await p2.catch((e: unknown) => e);
		expect(uiSettingConflict(lost)).toEqual({ value: 'a', revision: 'r1' });
		await flush();
		expect(calls[2]).toEqual({
			cmd: 'ui_settings_delete',
			args: { key: 'k', ifRevision: 'r0' }
		});
		pending[2].reject(conflictBody({ value: 'a', revision: 'r1' }));
		await expect(p3).rejects.toMatchObject({ body: { kind: 'conflict' } });
		await expect(p1).resolves.toEqual({ revision: 'r1' });
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
		pending[1].resolve({ revision: 'r2' });
		await expect(p2).resolves.toEqual({ revision: 'r2' });
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
		await expect(got).resolves.toEqual({ value: 'old', revision: 'a1b2' });
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
			pending[0].resolve({ revision: 'r1' });
			await expect(p1).resolves.toEqual({ revision: 'r1' });
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
			pending[0].resolve({ revision: 'r1' });
			await flush();
			expect(calls[1].args).toEqual({ key: 'theme.mode', value: 'b' });
			pending[1].resolve({ revision: 'r2' });
			await Promise.all([p1, p2]);
		});

		it('does not check the session when omitted (as before)', async () => {
			const { invoke, pending, calls } = makeInvoke();
			const provider = createTauriUiSettings({ invoke });

			const p1 = provider.set('theme.mode', 'a');
			const p2 = provider.set('theme.mode', 'b');
			await flush();
			pending[0].resolve({ revision: 'r1' });
			await flush();
			expect(calls[1].args).toEqual({ key: 'theme.mode', value: 'b' });
			pending[1].resolve({ revision: 'r2' });
			await Promise.all([p1, p2]);
		});
	});
});

// --- updateUiSetting (#786) ------------------------------------------------

/**
 * A server stand-in with real conditional-write semantics (revisions `r1`,
 * `r2`, ...). `beforeSet` runs once per `set`, before the condition is
 * checked - a test uses it to slip in another tab's write. `afterSet` runs
 * after the write was stored and may throw: the answer is lost, the write is
 * not.
 */
function fakeServer(initial: string | null = null) {
	let counter = 0;
	const state: UiSettingSnapshot = { value: initial, revision: initial === null ? '0' : 'r0' };
	const store = (value: string) => {
		state.value = value;
		state.revision = `r${++counter}`;
	};
	const hooks: {
		beforeSet?: (attempt: number) => void;
		afterSet?: (attempt: number) => void;
	} = {};
	const sets: Array<{ value: string; ifRevision?: string }> = [];
	let gets = 0;
	const provider: UiSettingsProvider = {
		async get() {
			gets++;
			return { ...state };
		},
		async set(_key, value, options) {
			sets.push({ value, ifRevision: options?.ifRevision });
			hooks.beforeSet?.(sets.length);
			if (options?.ifRevision !== undefined && options.ifRevision !== state.revision) {
				throw new ProviderError({ kind: 'conflict', message: 'changed', current: { ...state } });
			}
			store(value);
			const revision = state.revision;
			hooks.afterSet?.(sets.length);
			return { revision };
		},
		async remove() {
			state.value = null;
			state.revision = '0';
			return { revision: '0' };
		}
	};
	return { provider, state, store, hooks, sets, gets: () => gets };
}

/** An idempotent change: put `tag` into a JSON array kept as a set. */
const addTag =
	(tag: string) =>
	(current: string | null): string => {
		const tags: string[] = current === null ? [] : (JSON.parse(current) as string[]);
		return tags.includes(tag) ? (current as string) : JSON.stringify([...tags, tag]);
	};

const lostAnswer = () =>
	new ProviderError({ kind: 'other', message: 'offline' }, { networkFailure: 'network' });

describe('updateUiSetting', () => {
	it('reads, applies, and writes with the revision it read', async () => {
		const server = fakeServer('["a"]');
		const result = await updateUiSetting(server.provider, 'tags', addTag('b'));

		expect(result).toEqual({ value: '["a","b"]', revision: 'r1' });
		expect(server.sets).toEqual([{ value: '["a","b"]', ifRevision: 'r0' }]);
	});

	it('creates the setting with ifRevision "0" when nothing is stored', async () => {
		const server = fakeServer();
		await updateUiSetting(server.provider, 'tags', addTag('a'));
		expect(server.sets).toEqual([{ value: '["a"]', ifRevision: '0' }]);
	});

	it('writes nothing when apply returns the value it was given', async () => {
		const server = fakeServer('["a"]');
		const result = await updateUiSetting(server.provider, 'tags', addTag('a'));
		expect(result).toEqual({ value: '["a"]', revision: 'r0' });
		expect(server.sets).toEqual([]);
	});

	it('on a conflict, re-applies to the value the conflict returned (no extra read) and keeps the other change', async () => {
		const server = fakeServer('["a"]');
		server.hooks.beforeSet = (attempt) => {
			if (attempt === 1) server.store('["a","other"]'); // another tab wrote first
		};
		const result = await updateUiSetting(server.provider, 'tags', addTag('b'));

		expect(result.value).toBe('["a","other","b"]');
		expect(server.state.value).toBe('["a","other","b"]');
		expect(server.sets).toEqual([
			{ value: '["a","b"]', ifRevision: 'r0' },
			{ value: '["a","other","b"]', ifRevision: 'r1' }
		]);
		expect(server.gets()).toBe(1);
	});

	it('gives up after maxAttempts conflicts with the last conflict, and never writes unconditionally', async () => {
		const server = fakeServer('[]');
		let n = 0;
		server.hooks.beforeSet = () => server.store(JSON.stringify([`other${++n}`]));

		const error = await updateUiSetting(server.provider, 'tags', addTag('b'), {
			maxAttempts: 3
		}).catch((e: unknown) => e);

		expect(uiSettingConflict(error)).toEqual({ value: '["other3"]', revision: 'r3' });
		expect(server.sets).toHaveLength(3);
		expect(server.sets.every((s) => s.ifRevision !== undefined)).toBe(true);
		expect(server.state.value).toBe('["other3"]');
	});

	it('a lost answer: does not send the PUT again; the re-read holds what was sent, so it is done', async () => {
		const server = fakeServer('["a"]');
		server.hooks.afterSet = () => {
			throw lostAnswer();
		};
		const apply = vi.fn(addTag('b'));
		const result = await updateUiSetting(server.provider, 'tags', apply);

		// Stored once, reported with the revision the re-read saw.
		expect(result).toEqual({ value: '["a","b"]', revision: 'r1' });
		expect(server.sets).toHaveLength(1);
		expect(server.gets()).toBe(2);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(server.state.value).toBe('["a","b"]');
	});

	it('a lost answer, then another tab wrote on top: the idempotent apply does not change the value twice', async () => {
		const server = fakeServer('["a"]');
		server.hooks.afterSet = (attempt) => {
			if (attempt !== 1) return;
			// Our write was stored; another tab then added its own tag on top of it.
			server.store(addTag('other')(server.state.value));
			throw lostAnswer();
		};
		const result = await updateUiSetting(server.provider, 'tags', addTag('b'));

		// `b` is in there exactly once, the other tab's tag survived, and nothing
		// more was sent (apply found its change already present).
		expect(result).toEqual({ value: '["a","b","other"]', revision: 'r2' });
		expect(server.state.value).toBe('["a","b","other"]');
		expect(server.sets).toHaveLength(1);
	});

	it('a lost answer for a write that was NOT stored: re-reads, then writes again with the fresh revision', async () => {
		const server = fakeServer('["a"]');
		let failed = false;
		server.hooks.beforeSet = () => {
			if (failed) return;
			failed = true;
			throw new ProviderError({ kind: 'storage', message: 'busy' }); // refused before storing
		};
		const result = await updateUiSetting(server.provider, 'tags', addTag('b'));

		expect(result).toEqual({ value: '["a","b"]', revision: 'r1' });
		expect(server.sets).toEqual([
			{ value: '["a","b"]', ifRevision: 'r0' },
			{ value: '["a","b"]', ifRevision: 'r0' }
		]);
		expect(server.gets()).toBe(2); // the second write came from a fresh read, not a blind resend
	});

	it('a non-idempotent apply WOULD double-apply after a lost answer (why the contract exists)', async () => {
		const server = fakeServer('1');
		server.hooks.afterSet = (attempt) => {
			if (attempt !== 1) return;
			server.store('12'); // stored as "2" by us, then changed by another tab
			throw lostAnswer();
		};
		const increment = (current: string | null) => String(Number(current ?? '0') + 1);
		const result = await updateUiSetting(server.provider, 'n', increment);
		// 1 -> 2 (ours) -> 12 (theirs) -> 13: our +1 was applied a second time.
		expect(result.value).toBe('13');
	});

	it('rejects at once on a refusal, without reading again', async () => {
		for (const kind of ['unauthorized', 'forbidden'] as const) {
			const server = fakeServer('["a"]');
			server.hooks.beforeSet = () => {
				throw new ProviderError({ kind });
			};
			await expect(updateUiSetting(server.provider, 'tags', addTag('b'))).rejects.toMatchObject({
				body: { kind }
			});
			expect(server.sets).toHaveLength(1);
			expect(server.gets()).toBe(1);
		}
	});

	it('rejects with the read error when the re-read after a lost answer fails', async () => {
		const server = fakeServer('["a"]');
		server.hooks.afterSet = () => {
			throw lostAnswer();
		};
		const readFailure = new ProviderError({ kind: 'other', message: 'still offline' });
		let reads = 0;
		const provider: UiSettingsProvider = {
			...server.provider,
			get: async (key) => {
				if (++reads > 1) throw readFailure;
				return server.provider.get(key);
			}
		};
		await expect(updateUiSetting(provider, 'tags', addTag('b'))).rejects.toBe(readFailure);
		expect(server.sets).toHaveLength(1);
	});

	it('gives up with the last error when the answer keeps getting lost before the write is stored', async () => {
		const server = fakeServer('["a"]');
		const failure = lostAnswer();
		server.hooks.beforeSet = () => {
			throw failure;
		};
		await expect(
			updateUiSetting(server.provider, 'tags', addTag('b'), { maxAttempts: 2 })
		).rejects.toBe(failure);
		expect(server.sets).toHaveLength(2);
	});

	it('refuses a provider that answers a conditional write with "superseded"', async () => {
		const provider: UiSettingsProvider = {
			get: async () => ({ value: null, revision: '0' }),
			set: async () => ({ revision: null, superseded: true }),
			remove: async () => ({ revision: '0' })
		};
		await expect(updateUiSetting(provider, 'tags', addTag('b'))).rejects.toSatisfy(isProviderError);
	});

	it('works end to end over the HTTP adapter: a 409 is re-applied to its `current`', async () => {
		const requests: Array<{ method: string; body?: string }> = [];
		const answers = [
			jsonResponse(200, { value: '["a"]', revision: 'r0' }),
			jsonResponse(409, conflictBody({ value: '["a","other"]', revision: 'r7' })),
			jsonResponse(200, { revision: 'r8' })
		];
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			requests.push({ method: init.method as string, body: init.body as string | undefined });
			return answers.shift() as Response;
		});
		const provider = createHttpUiSettings({
			getToken: () => 'tok',
			fetchFn: fetchFn as unknown as typeof fetch
		});

		await expect(updateUiSetting(provider, 'tags', addTag('b'))).resolves.toEqual({
			value: '["a","other","b"]',
			revision: 'r8'
		});
		expect(requests).toEqual([
			{ method: 'GET', body: undefined },
			{ method: 'PUT', body: JSON.stringify({ value: '["a","b"]', ifRevision: 'r0' }) },
			{ method: 'PUT', body: JSON.stringify({ value: '["a","other","b"]', ifRevision: 'r7' }) }
		]);
	});

	it('works end to end over the Tauri adapter: a lost answer is settled by a re-read, not a resend', async () => {
		const calls: string[] = [];
		const answers: Array<() => unknown> = [
			() => ({ value: null, revision: '0' }),
			() => {
				throw new Error('ipc closed'); // not an ErrorBody: outcome unknown
			},
			() => ({ value: '["b"]', revision: 'r1' })
		];
		const invoke = vi.fn(async (cmd: string) => {
			calls.push(cmd);
			return (answers.shift() as () => unknown)();
		});
		const provider = createTauriUiSettings({ invoke });

		await expect(updateUiSetting(provider, 'tags', addTag('b'))).resolves.toEqual({
			value: '["b"]',
			revision: 'r1'
		});
		expect(calls).toEqual(['ui_settings_get', 'ui_settings_set', 'ui_settings_get']);
	});
});
