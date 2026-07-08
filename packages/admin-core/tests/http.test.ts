import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import { createHttpAuthProvider, createHttpDataProvider } from '../src/providers/http';

interface Item {
	id: number;
	name: string;
	price: number;
}

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { 'content-type': 'application/json' }
	});
}

function noContentResponse(): Response {
	return new Response(null, { status: 204 });
}

/** In-memory Storage stand-in: Node has no global sessionStorage. */
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

beforeEach(() => {
	vi.stubGlobal('sessionStorage', makeMemoryStorage());
	vi.stubGlobal('localStorage', makeMemoryStorage());
});

describe('createHttpDataProvider', () => {
	it('getList POSTs {base}/api/{resource}/list with the ListParams body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { rows: [{ id: 1, name: 'a', price: 10 }], totalCount: 1 }));
		const provider = createHttpDataProvider({ baseUrl: 'http://h:8721', getToken: () => 'tok', fetchFn });

		const params = { sort: [], filters: [], pagination: { offset: 0, limit: 10 } };
		const result = await provider.getList<Item>('items', params);

		expect(fetchFn).toHaveBeenCalledWith('http://h:8721/api/items/list', {
			method: 'POST',
			headers: { 'X-Banto-Client': 'banto', 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
			body: JSON.stringify(params)
		});
		expect(result).toEqual({ rows: [{ id: 1, name: 'a', price: 10 }], totalCount: 1 });
	});

	it('getOne GETs {base}/api/{resource}/{id} with no body/Content-Type', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1, name: 'a', price: 10 }));
		const provider = createHttpDataProvider({ baseUrl: 'http://h', getToken: () => null, fetchFn });

		await provider.getOne<Item>('items', 1);

		expect(fetchFn).toHaveBeenCalledWith('http://h/api/items/1', {
			method: 'GET',
			headers: { 'X-Banto-Client': 'banto' },
			body: undefined
		});
	});

	it('omits Authorization when getToken() returns null', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {}));
		const provider = createHttpDataProvider({ getToken: () => null, fetchFn });
		await provider.getOne('items', 1);
		const [, init] = fetchFn.mock.calls[0];
		expect(init.headers.Authorization).toBeUndefined();
	});

	it('create POSTs {base}/api/{resource} with the values body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 2, name: 'b', price: 20 }));
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		await provider.create<Item>('items', { name: 'b', price: 20 });

		expect(fetchFn).toHaveBeenCalledWith('/api/items', {
			method: 'POST',
			headers: { 'X-Banto-Client': 'banto', 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
			body: JSON.stringify({ name: 'b', price: 20 })
		});
	});

	it('update PUTs {base}/api/{resource}/{id} with the values body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1, name: 'a', price: 30 }));
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		await provider.update<Item>('items', 1, { price: 30 });

		expect(fetchFn).toHaveBeenCalledWith('/api/items/1', {
			method: 'PUT',
			headers: { 'X-Banto-Client': 'banto', 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
			body: JSON.stringify({ price: 30 })
		});
	});

	it('deleteOne DELETEs {base}/api/{resource}/{id} and resolves on 204 without parsing a body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(noContentResponse());
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		await expect(provider.deleteOne('items', 1)).resolves.toBeUndefined();
		expect(fetchFn).toHaveBeenCalledWith('/api/items/1', {
			method: 'DELETE',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' },
			body: undefined
		});
	});

	it('maps a non-2xx ErrorBody JSON response to a matching ProviderError', async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(404, { kind: 'not_found', resource: 'items', id: '42' })
		);
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		try {
			await provider.getOne('items', 42);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) expect(err.body).toEqual({ kind: 'not_found', resource: 'items', id: '42' });
		}
	});

	it('maps a 401 unauthorized ErrorBody the same way as any other error kind', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, { kind: 'unauthorized' }));
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		try {
			await provider.getOne('items', 1);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) expect(err.body).toEqual({ kind: 'unauthorized' });
		}
	});

	it('maps a 403 forbidden ErrorBody (spec M10 RBAC) the same way as any other error kind', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(403, { kind: 'forbidden' }));
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		try {
			await provider.getOne('items', 1);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) {
				expect(err.body).toEqual({ kind: 'forbidden' });
				expect(err.message).toBe('この操作を行う権限がありません');
			}
		}
	});

	it('maps an unparseable non-2xx body to kind "other" with the HTTP status text', async () => {
		const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 500, statusText: 'Internal Server Error' }));
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		try {
			await provider.getOne('items', 1);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) {
				expect(err.body.kind).toBe('other');
				expect(err.body).toMatchObject({ kind: 'other', message: '500 Internal Server Error' });
			}
		}
	});

	it('maps a network failure to kind "other" with a Japanese message', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const provider = createHttpDataProvider({ getToken: () => 'tok', fetchFn });

		try {
			await provider.getOne('items', 1);
			expect.unreachable('expected a ProviderError to be thrown');
		} catch (err) {
			expect(isProviderError(err)).toBe(true);
			if (isProviderError(err)) expect(err.body).toEqual({ kind: 'other', message: 'サーバーに接続できません' });
		}
	});
});

describe('createHttpAuthProvider', () => {
	it('login stores the returned token in sessionStorage on success', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, token: 'abc123' }));
		const provider = createHttpAuthProvider({ fetchFn });

		const result = await provider.login({ username: 'admin', password: 'admin' });

		expect(result).toEqual({ success: true });
		expect(provider.getToken()).toBe('abc123');
	});

	it('login does not store a token when the server rejects credentials', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: false, error: 'ユーザー名またはパスワードが違います' }));
		const provider = createHttpAuthProvider({ fetchFn });

		const result = await provider.login({ username: 'admin', password: 'wrong' });

		expect(result).toEqual({ success: false, error: 'ユーザー名またはパスワードが違います' });
		expect(provider.getToken()).toBeNull();
	});

	it('login posts to /api/auth/login with the CSRF header and JSON credentials', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, token: 't' }));
		const provider = createHttpAuthProvider({ baseUrl: 'http://h', fetchFn });

		await provider.login({ username: 'admin', password: 'admin' });

		expect(fetchFn).toHaveBeenCalledWith('http://h/api/auth/login', {
			method: 'POST',
			headers: { 'X-Banto-Client': 'banto', 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'admin', password: 'admin' })
		});
	});

	it('check returns false without calling fetch when there is no stored token', async () => {
		const fetchFn = vi.fn();
		const provider = createHttpAuthProvider({ fetchFn });

		await expect(provider.check()).resolves.toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('check calls GET /api/auth/check with the bearer token and returns its boolean body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, true));
		const provider = createHttpAuthProvider({ fetchFn });
		sessionStorage.setItem('banto.auth.token', 'tok');

		await expect(provider.check()).resolves.toBe(true);
		expect(fetchFn).toHaveBeenCalledWith('/api/auth/check', {
			method: 'GET',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' },
			body: undefined
		});
	});

	it('check clears the stored token and returns false on a 401', async () => {
		const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
		const provider = createHttpAuthProvider({ fetchFn });
		sessionStorage.setItem('banto.auth.token', 'stale-token');

		await expect(provider.check()).resolves.toBe(false);
		expect(provider.getToken()).toBeNull();
	});

	it('logout POSTs to /api/auth/logout and clears the stored token', async () => {
		const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		const provider = createHttpAuthProvider({ fetchFn });
		sessionStorage.setItem('banto.auth.token', 'tok');

		await provider.logout();

		expect(fetchFn).toHaveBeenCalledWith('/api/auth/logout', {
			method: 'POST',
			headers: { 'X-Banto-Client': 'banto', Authorization: 'Bearer tok' },
			body: undefined
		});
		expect(provider.getToken()).toBeNull();
	});

	it('logout clears the local token even if the network request fails', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const provider = createHttpAuthProvider({ fetchFn });
		sessionStorage.setItem('banto.auth.token', 'tok');

		await provider.logout();

		expect(provider.getToken()).toBeNull();
	});

	it('getIdentity returns null without calling fetch when there is no stored token', async () => {
		const fetchFn = vi.fn();
		const provider = createHttpAuthProvider({ fetchFn });

		await expect(provider.getIdentity()).resolves.toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('getIdentity calls GET /api/auth/identity and returns the parsed identity', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'admin', name: '管理者' }));
		const provider = createHttpAuthProvider({ fetchFn });
		sessionStorage.setItem('banto.auth.token', 'tok');

		await expect(provider.getIdentity()).resolves.toEqual({ id: 'admin', name: '管理者' });
	});

	it('getIdentity passes the role through unchanged (spec M10 RBAC)', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'owner', name: 'オーナー', role: 'admin' }));
		const provider = createHttpAuthProvider({ fetchFn });
		sessionStorage.setItem('banto.auth.token', 'tok');

		await expect(provider.getIdentity()).resolves.toEqual({ id: 'owner', name: 'オーナー', role: 'admin' });
	});

	it('uses a custom storageKey when provided', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, token: 'xyz' }));
		const provider = createHttpAuthProvider({ fetchFn, storageKey: 'custom.key' });

		await provider.login({ username: 'admin', password: 'admin' });

		expect(sessionStorage.getItem('custom.key')).toBe('xyz');
		expect(sessionStorage.getItem('banto.auth.token')).toBeNull();
	});

	it('login without remember stores the token in sessionStorage, not localStorage (spec M11)', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, token: 'sess-tok' }));
		const provider = createHttpAuthProvider({ fetchFn });

		await provider.login({ username: 'admin', password: 'admin' });

		expect(sessionStorage.getItem('banto.auth.token')).toBe('sess-tok');
		expect(localStorage.getItem('banto.auth.token')).toBeNull();
		expect(provider.getToken()).toBe('sess-tok');
	});

	it('login with remember:true stores the token in localStorage, not sessionStorage (spec M11)', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, token: 'remember-tok' }));
		const provider = createHttpAuthProvider({ fetchFn });

		await provider.login({ username: 'admin', password: 'admin', remember: true });

		expect(localStorage.getItem('banto.auth.token')).toBe('remember-tok');
		expect(sessionStorage.getItem('banto.auth.token')).toBeNull();
		expect(provider.getToken()).toBe('remember-tok');
	});

	it('getToken prefers a localStorage token over a sessionStorage one', async () => {
		const provider = createHttpAuthProvider({});
		localStorage.setItem('banto.auth.token', 'from-local');
		sessionStorage.setItem('banto.auth.token', 'from-session');

		expect(provider.getToken()).toBe('from-local');
	});

	it('logging in again without remember after a remembered login clears the stale localStorage token (spec M11)', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'remember-tok' }))
			.mockResolvedValueOnce(jsonResponse(200, { success: true, token: 'sess-tok' }));
		const provider = createHttpAuthProvider({ fetchFn });

		await provider.login({ username: 'admin', password: 'admin', remember: true });
		expect(localStorage.getItem('banto.auth.token')).toBe('remember-tok');

		await provider.login({ username: 'admin', password: 'admin' });
		expect(localStorage.getItem('banto.auth.token')).toBeNull();
		expect(sessionStorage.getItem('banto.auth.token')).toBe('sess-tok');
	});

	it('logout clears both localStorage and sessionStorage (spec M11)', async () => {
		const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		const provider = createHttpAuthProvider({ fetchFn });
		localStorage.setItem('banto.auth.token', 'remembered');
		sessionStorage.setItem('banto.auth.token', 'not-remembered');

		await provider.logout();

		expect(localStorage.getItem('banto.auth.token')).toBeNull();
		expect(sessionStorage.getItem('banto.auth.token')).toBeNull();
		expect(provider.getToken()).toBeNull();
	});

	it('status calls GET /api/auth/status and returns its body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { initialized: false }));
		const provider = createHttpAuthProvider({ fetchFn });

		await expect(provider.status?.()).resolves.toEqual({ initialized: false });
		expect(fetchFn).toHaveBeenCalledWith('/api/auth/status', {
			method: 'GET',
			headers: { 'X-Banto-Client': 'banto' },
			body: undefined
		});
	});

	it('status treats a network failure as already initialized (falls back to the login form)', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const provider = createHttpAuthProvider({ fetchFn });

		await expect(provider.status?.()).resolves.toEqual({ initialized: true });
	});

	it('setup POSTs to /api/auth/setup and stores the token on success', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, token: 'tok' }));
		const provider = createHttpAuthProvider({ fetchFn });

		const result = await provider.setup?.({
			username: 'owner',
			password: 'password123',
			displayName: 'オーナー'
		});

		expect(fetchFn).toHaveBeenCalledWith('/api/auth/setup', {
			method: 'POST',
			headers: { 'X-Banto-Client': 'banto', 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: 'owner', password: 'password123', displayName: 'オーナー' })
		});
		expect(result).toEqual({ success: true });
		expect(provider.getToken()).toBe('tok');
	});

	it('setup maps a 403 (allow_setup disabled) ErrorBody to { success: false, error }', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(jsonResponse(403, { kind: 'other', message: 'このサーバーでは初期セットアップが許可されていません' }));
		const provider = createHttpAuthProvider({ fetchFn });

		const result = await provider.setup?.({ username: 'owner', password: 'password123', displayName: 'オーナー' });

		expect(result).toEqual({ success: false, error: 'このサーバーでは初期セットアップが許可されていません' });
		expect(provider.getToken()).toBeNull();
	});

	it('setup maps a 422 validation ErrorBody to { success: false, error: <first field message> }', async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(422, {
				kind: 'validation',
				field_errors: [{ field: 'password', message: 'パスワードは8文字以上で入力してください' }]
			})
		);
		const provider = createHttpAuthProvider({ fetchFn });

		const result = await provider.setup?.({ username: 'owner', password: 'short', displayName: 'オーナー' });

		expect(result).toEqual({ success: false, error: 'パスワードは8文字以上で入力してください' });
	});

	it('changePassword POSTs to /api/auth/change-password with the bearer token and camelCase body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
		const provider = createHttpAuthProvider({ fetchFn });
		sessionStorage.setItem('banto.auth.token', 'tok');

		const result = await provider.changePassword?.('old-password', 'new-password1');

		expect(fetchFn).toHaveBeenCalledWith('/api/auth/change-password', {
			method: 'POST',
			headers: { 'X-Banto-Client': 'banto', 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
			body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password1' })
		});
		expect(result).toEqual({ success: true });
	});

	it('changePassword maps a 422 validation ErrorBody to { success: false, error: <first field message> }', async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse(422, {
				kind: 'validation',
				field_errors: [{ field: 'currentPassword', message: '現在のパスワードが違います' }]
			})
		);
		const provider = createHttpAuthProvider({ fetchFn });

		const result = await provider.changePassword?.('wrong', 'new-password1');

		expect(result).toEqual({ success: false, error: '現在のパスワードが違います' });
	});
});
