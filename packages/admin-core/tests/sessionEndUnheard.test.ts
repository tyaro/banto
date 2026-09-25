/**
 * Third review of #242: an ending confirmed before the protected layout
 * subscribes (the first guard's `check()` answered late) must still reach
 * that layout once it mounts - and must not log out a NEW login.
 *
 * Wires the real SSE provider, `connectEvents`, the real HTTP
 * `AuthProvider` and the real route-guard decision (`resolveProtectedSession`).
 * Its own file: `sessionEnded.ts` keeps module state (the unheard ending),
 * and vitest isolates modules per file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, createSseEventProvider } from '../src/events';
import { createHttpAuthProvider } from '../src/providers/http';
import { initBanto } from '../src/registry.svelte';
import { onSessionEnded } from '../src/sessionEnded';
import { resolveProtectedSession } from '../src/sessionGate';
import type { DataProvider } from '../src/provider';

const TOKEN_KEY = 'banto.auth.token';

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

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
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

describe('an ending confirmed before the protected layout subscribes (third review of #242)', () => {
	it('reaches the layout once it mounts, and a new login is not logged out by it', async () => {
		localStorage.setItem(TOKEN_KEY, 'A');
		const revoked = new Set<string>();
		let releaseGuard!: () => void;
		const guardHeld = new Promise<void>((resolve) => (releaseGuard = resolve));
		const checksFor: string[] = [];
		const bearer = (init?: RequestInit) =>
			((init?.headers as Record<string, string>).Authorization ?? '').replace('Bearer ', '');
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			const token = bearer(init);
			if (path.endsWith('/api/events')) {
				if (revoked.has(token)) return new Response(null, { status: 401 });
				return new Response(new ReadableStream({ start: (c) => c.close() }));
			}
			if (path.endsWith('/api/auth/check')) {
				checksFor.push(token);
				// The first guard's check: judged valid now, delivered later.
				if (checksFor.length === 1) {
					await guardHeld;
					return jsonResponse(200, true);
				}
				return jsonResponse(200, !revoked.has(token));
			}
			if (path.endsWith('/api/auth/status')) return jsonResponse(200, { initialized: true });
			throw new Error(`unexpected ${path}`);
		}) as unknown as typeof fetch;

		const auth = createHttpAuthProvider({ fetchFn });
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const disconnect = connectEvents(
			createSseEventProvider({
				getToken: auth.getToken,
				fetchFn,
				reconnectDelayMs: 100,
				tokenWaitDelayMs: 50
			})
		);

		// The first protected load starts; its check is held.
		const firstGuard = resolveProtectedSession(auth);
		await vi.advanceTimersByTimeAsync(20);
		// A is revoked: the stream's reconnect gets a 401, the confirmation
		// answers false and clears A - no listener exists yet.
		revoked.add('A');
		await vi.advanceTimersByTimeAsync(500);
		expect(auth.getToken()).toBeNull();
		expect(checksFor).toEqual(['A', 'A']);

		// The held true arrives: the guard lets the protected route through.
		releaseGuard();
		await expect(firstGuard).resolves.toBe('session');

		// The protected layout mounts and subscribes; its listener re-runs the
		// guard (what `invalidateAll()` does).
		const outcomes: string[] = [];
		const layout = vi.fn(() => {
			void resolveProtectedSession(auth).then((outcome) => outcomes.push(outcome));
		});
		const off = onSessionEnded(layout);
		expect(layout).not.toHaveBeenCalled(); // never synchronously in the subscription
		await vi.advanceTimersByTimeAsync(10);
		expect(layout).toHaveBeenCalledTimes(1);
		expect(outcomes).toEqual(['login']);
		off();

		// Heard: a later subscription does not replay it.
		const later = vi.fn();
		const offLater = onSessionEnded(later);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(later).not.toHaveBeenCalled();
		offLater();
		disconnect();
	});

	it('a new login before the layout mounts is not logged out by the older ending', async () => {
		localStorage.setItem(TOKEN_KEY, 'A');
		const revoked = new Set<string>(['A']);
		const bearer = (init?: RequestInit) =>
			((init?.headers as Record<string, string>).Authorization ?? '').replace('Bearer ', '');
		const checksFor: string[] = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			const token = bearer(init);
			if (path.endsWith('/api/events')) {
				if (revoked.has(token)) return new Response(null, { status: 401 });
				return new Response(new ReadableStream({ start: (c) => c.close() }));
			}
			if (path.endsWith('/api/auth/check')) {
				checksFor.push(token);
				return jsonResponse(200, !revoked.has(token));
			}
			throw new Error(`unexpected ${path}`);
		}) as unknown as typeof fetch;

		const auth = createHttpAuthProvider({ fetchFn });
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const disconnect = connectEvents(
			createSseEventProvider({
				getToken: auth.getToken,
				fetchFn,
				reconnectDelayMs: 100,
				tokenWaitDelayMs: 50
			})
		);
		// A is rejected and confirmed ended while nothing listens.
		await vi.advanceTimersByTimeAsync(50);
		expect(auth.getToken()).toBeNull();

		// A new login (B), then the protected layout mounts.
		localStorage.setItem(TOKEN_KEY, 'B');
		const layout = vi.fn();
		const off = onSessionEnded(layout);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(layout).not.toHaveBeenCalled();
		expect(auth.getToken()).toBe('B');
		expect(checksFor.at(-1)).toBe('B');

		// Forgotten: another mount does not check again.
		const checks = checksFor.length;
		off();
		const offAgain = onSessionEnded(vi.fn());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(checksFor.length).toBe(checks);
		offAgain();
		disconnect();
	});
});
