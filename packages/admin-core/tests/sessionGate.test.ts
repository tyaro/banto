import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import { createHttpAuthProvider } from '../src/providers/http';
import { createTauriAuthProvider } from '../src/providers/tauri';
import { resolveProtectedSession } from '../src/sessionGate';

/**
 * Issue #204 review: a session the backend could not VERIFY (a `500` from
 * `/api/auth/check` on a DB error, or an unreachable server) must not be
 * treated as logged out - no redirect to /login, no switch to a public viewer
 * session, no token cleared or replaced - and must resume once the backend
 * answers again. Only a confirmed-invalid session falls through.
 */

const KEY = 'banto.auth.token';

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

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** A fake LAN server for the four `/api/auth/*` routes the gate touches. */
function fakeServer(options: { viewerPublic: boolean }) {
	const state = {
		viewerPublic: options.viewerPublic,
		checkFails: false,
		unreachable: false,
		validTokens: new Set<string>(),
		calls: [] as string[]
	};
	const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
		const path = url.replace(/^.*?(\/api\/)/, '/api/');
		state.calls.push(path);
		if (state.unreachable) throw new TypeError('fetch failed');
		const token = init?.headers?.Authorization?.replace('Bearer ', '') ?? null;
		switch (path) {
			case '/api/auth/check':
				if (state.checkFails) {
					return json(500, { kind: 'storage', message: 'database is locked' });
				}
				return json(200, token !== null && state.validTokens.has(token));
			case '/api/auth/status':
				return json(200, { initialized: true, viewerPublic: state.viewerPublic });
			case '/api/auth/public-viewer':
				return state.viewerPublic
					? json(200, { success: true, token: 'public-token' })
					: json(403, { kind: 'forbidden' });
			default:
				return json(404, { kind: 'other', message: 'unexpected route' });
		}
	});
	return { state, fetchFn: fetchFn as unknown as typeof fetch };
}

function storedTokens() {
	return { local: localStorage.getItem(KEY), session: sessionStorage.getItem(KEY) };
}

beforeEach(() => {
	vi.stubGlobal('sessionStorage', makeMemoryStorage());
	vi.stubGlobal('localStorage', makeMemoryStorage());
});

describe('resolveProtectedSession (HTTP provider)', () => {
	for (const viewerPublic of [false, true]) {
		for (const remember of [false, true]) {
			const label = `viewerPublic ${viewerPublic ? 'ON' : 'OFF'}, ${remember ? 'Remember me' : 'regular'} token`;

			it(`${label}: a failed check keeps the token and resumes after recovery`, async () => {
				const { state, fetchFn } = fakeServer({ viewerPublic });
				const auth = createHttpAuthProvider({ fetchFn });
				(remember ? localStorage : sessionStorage).setItem(KEY, 'user-token');
				state.validTokens.add('user-token');
				const before = storedTokens();

				state.checkFails = true;
				const failure = await resolveProtectedSession(auth).catch((err: unknown) => err);
				expect(isProviderError(failure)).toBe(true);
				expect((failure as { body: { kind: string } }).body.kind).toBe('storage');
				expect(storedTokens(), 'no token cleared or replaced').toEqual(before);
				expect(state.calls, 'no status / public viewer entry after a failed check').toEqual([
					'/api/auth/check'
				]);

				state.checkFails = false;
				await expect(resolveProtectedSession(auth)).resolves.toBe('session');
				expect(storedTokens()).toEqual(before);
				expect(auth.getToken()).toBe('user-token');
			});

			it(`${label}: an unreachable server is an error too, not a logout`, async () => {
				const { state, fetchFn } = fakeServer({ viewerPublic });
				const auth = createHttpAuthProvider({ fetchFn });
				(remember ? localStorage : sessionStorage).setItem(KEY, 'user-token');
				state.validTokens.add('user-token');
				const before = storedTokens();

				state.unreachable = true;
				await expect(resolveProtectedSession(auth)).rejects.toSatisfy(isProviderError);
				expect(storedTokens()).toEqual(before);

				state.unreachable = false;
				await expect(resolveProtectedSession(auth)).resolves.toBe('session');
			});
		}

		it(`viewerPublic ${viewerPublic ? 'ON' : 'OFF'}: a session the server confirms invalid still falls through`, async () => {
			const { fetchFn } = fakeServer({ viewerPublic });
			const auth = createHttpAuthProvider({ fetchFn });
			sessionStorage.setItem(KEY, 'revoked-token');

			const outcome = await resolveProtectedSession(auth);
			if (viewerPublic) {
				expect(outcome).toBe('publicViewer');
				expect(auth.getToken()).toBe('public-token');
			} else {
				expect(outcome).toBe('login');
			}
		});
	}

	it('a 401 from check is a confirmed logout: the token is cleared', async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 401 }));
		const auth = createHttpAuthProvider({ fetchFn: fetchFn as unknown as typeof fetch });
		localStorage.setItem(KEY, 'expired-token');
		await expect(auth.check()).resolves.toBe(false);
		expect(storedTokens()).toEqual({ local: null, session: null });
	});
});

describe('resolveProtectedSession (Tauri provider)', () => {
	it('a failed auth_check rejects without consulting status or logging out', async () => {
		let checkFails = true;
		const invoke = vi.fn(async (command: string) => {
			if (command === 'auth_check') {
				if (checkFails) throw { kind: 'storage', message: 'database is locked' };
				return true;
			}
			if (command === 'auth_status') return { initialized: true };
			throw new Error(`unexpected command ${command}`);
		});
		const auth = createTauriAuthProvider({ invoke });

		await expect(resolveProtectedSession(auth)).rejects.toSatisfy(isProviderError);
		expect(invoke.mock.calls.map(([command]) => command)).toEqual(['auth_check']);

		checkFails = false;
		await expect(resolveProtectedSession(auth)).resolves.toBe('session');
	});

	it('a confirmed-invalid desktop session goes to login', async () => {
		const invoke = vi.fn(async (command: string) =>
			command === 'auth_check' ? false : { initialized: true }
		);
		await expect(resolveProtectedSession(createTauriAuthProvider({ invoke }))).resolves.toBe(
			'login'
		);
	});
});
