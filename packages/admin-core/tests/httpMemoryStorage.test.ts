import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpAuthProvider, createHttpDataProvider } from '../src/providers/http';

/**
 * Issue #838 (downstream-requests-2026-11-plan §4.14, §10 B1):
 * `createHttpAuthProvider({ storage: 'memory' })` keeps the bearer token in
 * a variable of the provider only. This file covers what is specific to
 * `'memory'`: web storage is never touched, no `storage` listener is added,
 * and `login()` sends `remember: false`. The overtaking scenarios run for
 * both stores in `httpRevision.test.ts` and `sessionRaces.test.ts`.
 */

const KEY = 'banto.auth.token';

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** A `Storage` whose every member access is recorded - reads, writes, `length`, anything. */
function watchedStorage(name: string, touched: string[]): Storage {
	return new Proxy({} as Storage, {
		get(_target, property) {
			touched.push(`${name}.${String(property)}`);
			return () => null;
		},
		set(_target, property) {
			touched.push(`${name}.${String(property)}=`);
			return true;
		},
		has(_target, property) {
			touched.push(`${name} has ${String(property)}`);
			return false;
		},
		deleteProperty(_target, property) {
			touched.push(`${name} delete ${String(property)}`);
			return true;
		},
		ownKeys() {
			touched.push(`${name} keys`);
			return [];
		}
	});
}

/** A fake server: login and grant answer a token, identity answers per token. */
function server(identityStatus: () => number = () => 200) {
	const calls: { path: string; token: string | null; body: unknown }[] = [];
	let minted = 0;
	const fetchFn = vi.fn(
		async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
			const path = url.replace(/^.*?(\/api\/)/, '/api/');
			const token = init?.headers?.Authorization?.replace('Bearer ', '') ?? null;
			calls.push({
				path,
				token,
				body: init?.body === undefined ? undefined : JSON.parse(init.body)
			});
			if (path === '/api/auth/login') {
				minted += 1;
				return json(200, { success: true, token: `tok-${minted}` });
			}
			if (path.startsWith('/api/auth/grant/')) {
				minted += 1;
				return json(200, { success: true, token: `grant-${minted}` });
			}
			if (path === '/api/auth/identity') {
				const status = identityStatus();
				return status === 200
					? json(200, { id: 'a', name: 'A', role: 'admin' })
					: json(status, { kind: 'unauthorized', message: 'no' });
			}
			if (path === '/api/auth/status') return json(200, { grants: { publicViewer: true } });
			if (path === '/api/auth/change-password') {
				return json(401, { kind: 'unauthorized', message: 'no' });
			}
			if (path === '/api/auth/logout') return new Response(null, { status: 204 });
			return json(200, { items: [], total: 0 });
		}
	);
	return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("storage: 'memory' never touches web storage (#838)", () => {
	let touched: string[];
	let addEventListener: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		touched = [];
		vi.stubGlobal('localStorage', watchedStorage('localStorage', touched));
		vi.stubGlobal('sessionStorage', watchedStorage('sessionStorage', touched));
		addEventListener = vi.fn();
		vi.stubGlobal('window', { addEventListener, removeEventListener: vi.fn() });
	});

	it('the watched storage records an access (the check below can fail)', () => {
		const { fetchFn } = server();
		const auth = createHttpAuthProvider({ fetchFn });

		expect(auth.getToken()).toBeNull();

		expect(touched).toEqual(['localStorage.getItem', 'sessionStorage.getItem']);
		expect(addEventListener).toHaveBeenCalledWith('storage', expect.any(Function));
	});

	it('every operation of the provider runs without one access and without a storage listener', async () => {
		let identityStatus = 200;
		const { calls, fetchFn } = server(() => identityStatus);
		const auth = createHttpAuthProvider({ fetchFn, storage: 'memory', storageKey: 'unused.key' });
		const changed = vi.fn();
		auth.onCredentialChanged(changed);
		const data = createHttpDataProvider({ getToken: auth.getToken, fetchFn });

		// Nothing stored yet: resolve() answers none, a grant enters.
		await expect(auth.resolve()).resolves.toMatchObject({ status: 'none' });
		await auth.status?.();
		await expect(auth.enterGrant?.('publicViewer')).resolves.toEqual({ success: true });
		expect(auth.getToken()).toBe('grant-1');
		await auth.logout();
		expect(auth.getToken()).toBeNull();

		// Login (Remember me asked for) -> resolve -> a data request -> logout.
		await expect(
			auth.login({ username: 'a', password: 'pw', remember: true })
		).resolves.toMatchObject({ success: true });
		expect(auth.getToken()).toBe('tok-2');
		await expect(auth.resolve()).resolves.toMatchObject({ status: 'active' });
		await data.getList('items', { sort: [], filters: [] });
		expect(calls.at(-1)).toMatchObject({ path: '/api/items/list', token: 'tok-2' });
		await auth.logout();
		expect(auth.getToken()).toBeNull();

		// The clearing paths: a 401 from change-password, a 401 from resolve().
		await auth.login({ username: 'a', password: 'pw' });
		await auth.changePassword?.('old', 'new');
		expect(auth.getToken()).toBeNull();
		await auth.login({ username: 'a', password: 'pw' });
		identityStatus = 401;
		const before = auth.credentialRevision();
		const answer = await auth.resolve();
		expect(answer).toMatchObject({ status: 'none', checked: before });
		expect(answer.current).not.toBe(before);
		expect(auth.getToken()).toBeNull();

		expect(touched).toEqual([]);
		expect(addEventListener).not.toHaveBeenCalled();
		expect(changed).toHaveBeenCalled();
	});
});

describe("storage: 'memory' is one document's token (#838)", () => {
	let windowTarget: EventTarget;

	function makeMemoryStorage(): Storage {
		const map = new Map<string, string>();
		return {
			getItem: (key) => map.get(key) ?? null,
			setItem: (key, value) => void map.set(key, value),
			removeItem: (key) => void map.delete(key),
			clear: () => map.clear(),
			key: (index) => Array.from(map.keys())[index] ?? null,
			get length() {
				return map.size;
			}
		} as Storage;
	}

	beforeEach(() => {
		vi.stubGlobal('sessionStorage', makeMemoryStorage());
		vi.stubGlobal('localStorage', makeMemoryStorage());
		windowTarget = new EventTarget();
		vi.stubGlobal('window', windowTarget);
	});

	it('a token another app left in web storage under the same key is not picked up, and stays', async () => {
		localStorage.setItem(KEY, 'other-app-remembered');
		sessionStorage.setItem(KEY, 'other-app-session');
		const { calls, fetchFn } = server();
		const auth = createHttpAuthProvider({ fetchFn, storage: 'memory' });

		expect(auth.getToken()).toBeNull();
		await expect(auth.resolve()).resolves.toMatchObject({ status: 'none' });
		expect(calls).toHaveLength(0);

		await auth.login({ username: 'a', password: 'pw' });
		await auth.logout();

		expect(localStorage.getItem(KEY)).toBe('other-app-remembered');
		expect(sessionStorage.getItem(KEY)).toBe('other-app-session');
	});

	it('a storage event (another tab, or a clear) does not advance the revision nor notify', async () => {
		const { fetchFn } = server();
		const auth = createHttpAuthProvider({ fetchFn, storage: 'memory' });
		const changed = vi.fn();
		auth.onCredentialChanged(changed);
		await auth.login({ username: 'a', password: 'pw' });
		changed.mockClear();
		const before = auth.credentialRevision();

		windowTarget.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
		windowTarget.dispatchEvent(Object.assign(new Event('storage'), { key: null }));

		expect(auth.credentialRevision()).toBe(before);
		expect(changed).not.toHaveBeenCalled();
		expect(auth.getToken()).toBe('tok-1');
	});

	it('two providers in one document do not share a token', async () => {
		const { fetchFn } = server();
		const first = createHttpAuthProvider({ fetchFn, storage: 'memory' });
		const second = createHttpAuthProvider({ fetchFn, storage: 'memory' });

		await first.login({ username: 'a', password: 'pw' });

		expect(first.getToken()).toBe('tok-1');
		expect(second.getToken()).toBeNull();
	});

	it('an unknown storage value is refused instead of falling back to web storage', () => {
		const { fetchFn } = server();
		expect(() =>
			createHttpAuthProvider({ fetchFn, storage: 'Memory' as unknown as 'memory' })
		).toThrow(/unknown storage/);
	});

	describe('the login body', () => {
		it.each([
			['remember: true', { username: 'a', password: 'pw', remember: true }],
			['remember: false', { username: 'a', password: 'pw', remember: false }],
			['no remember', { username: 'a', password: 'pw' }]
		])(
			"'memory' sends remember: false (%s) and does not change the caller's params",
			async (_l, params) => {
				const { calls, fetchFn } = server();
				const auth = createHttpAuthProvider({ fetchFn, storage: 'memory' });
				const given = { ...params };

				await expect(auth.login(params)).resolves.toEqual({ success: true, error: undefined });

				expect(calls[0]).toMatchObject({ path: '/api/auth/login' });
				expect(calls[0].body).toEqual({ username: 'a', password: 'pw', remember: false });
				expect(params).toEqual(given);
			}
		);

		it.each([
			['the default', undefined],
			["'web'", 'web' as const]
		])('%s sends the params exactly as given and keeps the storage rule', async (_l, storage) => {
			const { calls, fetchFn } = server();
			const auth = createHttpAuthProvider({ fetchFn, storage });

			await auth.login({ username: 'a', password: 'pw', remember: true });
			expect(calls[0].body).toEqual({ username: 'a', password: 'pw', remember: true });
			expect(localStorage.getItem(KEY)).toBe('tok-1');
			expect(sessionStorage.getItem(KEY)).toBeNull();

			await auth.login({ username: 'a', password: 'pw' });
			expect(calls[1].body).toEqual({ username: 'a', password: 'pw' });
			expect(sessionStorage.getItem(KEY)).toBe('tok-2');
			expect(localStorage.getItem(KEY)).toBeNull();
		});
	});
});
