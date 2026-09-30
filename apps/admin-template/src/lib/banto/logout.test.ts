/**
 * Issue #260 実装-2 (independent audit P2-1): the logout goes to /login
 * first, so another login can be confirmed while the logout request is in
 * flight. The logout must then leave that session alone (S-17/S-51, I-18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	currentSessionScope,
	getSessionController,
	initBanto,
	loadListViewState,
	resolveSettled,
	saveListViewState,
	type AuthProvider,
	type CredentialRevision,
	type DataProvider,
	type Identity,
	type ResolvedAuth
} from '@banto/admin-core';
import { logoutAndEndSession } from './logout';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function memoryStorage(): Storage {
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

const ALICE: Identity = { id: 'alice', name: 'Alice' };
const BOB: Identity = { id: 'bob', name: 'Bob' };

/** A standard provider: answers and the logout response are settled by the test. */
function standardProvider() {
	let revision = 1;
	const listeners = new Set<() => void>();
	const probes: {
		checked: CredentialRevision;
		answer: ReturnType<typeof deferred<ResolvedAuth>>;
	}[] = [];
	const logoutGate = deferred<void>();
	const rev = () => `${revision}.0` as CredentialRevision;
	const provider: AuthProvider = {
		login: async () => ({ success: true }),
		logout: vi.fn(() => logoutGate.promise),
		check: async () => true,
		getIdentity: async () => null,
		resolve: () => {
			const answer = deferred<ResolvedAuth>();
			probes.push({ checked: rev(), answer });
			return answer.promise;
		},
		credentialRevision: rev,
		onCredentialChanged(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
	return {
		provider,
		logoutGate,
		active(identity: Identity) {
			const probe = probes[probes.length - 1];
			probe.answer.resolve({
				status: 'active',
				checked: probe.checked,
				current: probe.checked,
				identity
			});
		},
		/** Another login stored its token (reported, I-19). */
		login() {
			revision += 1;
			for (const listener of [...listeners]) listener();
		}
	};
}

beforeEach(() => {
	vi.stubGlobal('sessionStorage', memoryStorage());
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('logoutAndEndSession (I-10, I-18)', () => {
	it('S-51: a login confirmed while the logout is in flight is not ended by it (generation and saved state kept)', async () => {
		const p = standardProvider();
		initBanto({ dataProvider: {} as DataProvider, authProvider: p.provider, resources: [] });
		const controller = getSessionController();
		const first = resolveSettled(controller);
		p.active(ALICE);
		await first;

		const logout = logoutAndEndSession();
		// On the login screen meanwhile: B logs in and is confirmed.
		p.login();
		p.active(BOB);
		await flush();
		expect(controller.snapshot.owner).toBe('account:bob');
		const scope = currentSessionScope();
		saveListViewState(scope, 'items:server', { sort: [], filters: [] });
		const generation = controller.snapshot.generation;

		// The late logout response (the provider's compare-and-set kept B's token).
		p.logoutGate.resolve();
		await logout;

		expect(controller.snapshot).toMatchObject({
			status: 'active',
			owner: 'account:bob',
			generation
		});
		expect(loadListViewState(scope, 'items:server')).not.toBeNull();
	});

	it('S-17: a provider that cannot report the logout (compatibility adapter) still ends the session', async () => {
		let valid = true;
		const legacy: AuthProvider = {
			login: async () => ({ success: true }),
			logout: vi.fn(async () => {
				valid = false;
			}),
			check: async () => valid,
			getIdentity: async () => ALICE
		};
		initBanto({ dataProvider: {} as DataProvider, authProvider: legacy, resources: [] });
		const controller = getSessionController();
		await resolveSettled(controller);
		expect(controller.snapshot.status).toBe('active');

		await logoutAndEndSession();
		expect(controller.snapshot.status).toBe('none');
	});

	it('a rejected logout is decided by the same ticket (ended when nothing else happened), and rethrown', async () => {
		const legacy: AuthProvider = {
			login: async () => ({ success: true }),
			logout: vi.fn(async () => {
				throw new Error('network');
			}),
			check: async () => true,
			getIdentity: async () => ALICE
		};
		initBanto({ dataProvider: {} as DataProvider, authProvider: legacy, resources: [] });
		const controller = getSessionController();
		await resolveSettled(controller);

		await expect(logoutAndEndSession()).rejects.toThrow('network');
		expect(controller.snapshot.status).toBe('none');
	});
});
