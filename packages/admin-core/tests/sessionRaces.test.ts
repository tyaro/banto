/**
 * Issue #215/#255 5th review: an auth answer that was requested for one
 * session and arrives after this tab moved on to another (logout, then a
 * login as B whose session is established and rendered) must not start,
 * end or change B's session scope - its owner, its generation (what
 * `(app)/+layout.svelte` compares against the generation its load
 * confirmed), or its saved list view state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadListViewState, saveListViewState } from '../src/listViewState';
import type { AuthProvider, DataProvider, Identity } from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import { confirmSessionEnded, onSessionEnded } from '../src/sessionEnded';
import { resolveProtectedSession } from '../src/sessionGate';
import { beginSession, endSession, establishSession } from '../src/sessionLifecycle';
import {
	currentSessionScope,
	isCurrentSessionScope,
	sessionGeneration,
	type SessionScope
} from '../src/sessionScope.svelte';

const ALICE: Identity = { id: 'alice', name: 'Alice' };
const BOB: Identity = { id: 'bob', name: 'Bob' };

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

/** A value whose promise the test resolves later. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/** An AuthProvider whose `check`/`getIdentity` answers come from queues the test controls. */
function makeAuth() {
	const checks: ReturnType<typeof deferred<boolean>>[] = [];
	const identities: ReturnType<typeof deferred<Identity | null>>[] = [];
	const auth: AuthProvider = {
		login: async () => ({ success: true }),
		logout: async () => {},
		check: vi.fn(() => {
			const answer = deferred<boolean>();
			checks.push(answer);
			return answer.promise;
		}),
		getIdentity: vi.fn(() => {
			const answer = deferred<Identity | null>();
			identities.push(answer);
			return answer.promise;
		})
	};
	return { auth, checks, identities };
}

/** Log out of A and establish B's session (its load finished and rendered): returns B's scope. */
async function switchToBob(
	auth: AuthProvider,
	identities: ReturnType<typeof deferred<Identity | null>>[]
): Promise<SessionScope> {
	endSession(); // the logout
	const bobLoad = establishSession(auth);
	await vi.waitFor(() => expect(identities.length).toBeGreaterThan(0));
	identities[identities.length - 1].resolve(BOB);
	await expect(bobLoad).resolves.toEqual({ current: true, identity: BOB });
	const bob = currentSessionScope();
	saveListViewState(bob, 'items:server', {
		sort: [{ field: 'price', direction: 'asc' }],
		filters: []
	});
	return bob;
}

function expectBobUntouched(bob: SessionScope): void {
	expect(isCurrentSessionScope(bob)).toBe(true);
	expect(currentSessionScope().owner).toBe('account:bob');
	expect(sessionGeneration()).toBe(bob.generation);
	expect(loadListViewState(bob, 'items:server')?.sort).toEqual([
		{ field: 'price', direction: 'asc' }
	]);
}

let storage: Storage;
beforeEach(() => {
	storage = makeMemoryStorage();
	vi.stubGlobal('sessionStorage', storage);
	endSession();
	beginSession(ALICE);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a late answer for A's session leaves B's session alone (#255 5th review)", () => {
	it('establishSession: A’s pending identity resolved after B’s load is not applied', async () => {
		const { auth, identities } = makeAuth();
		const aliceLoad = establishSession(auth);
		await vi.waitFor(() => expect(identities).toHaveLength(1));

		const bob = await switchToBob(auth, identities);
		identities[0].resolve(ALICE);

		await expect(aliceLoad).resolves.toEqual({ current: false, identity: null });
		expectBobUntouched(bob);
	});

	it('establishSession: an answer made stale by a session change (no newer load) asks the current session again', async () => {
		const { auth, identities } = makeAuth();
		const load = establishSession(auth);
		await vi.waitFor(() => expect(identities).toHaveLength(1));
		endSession();
		beginSession(BOB); // e.g. established by some other path meanwhile
		const generation = sessionGeneration();

		identities[0].resolve(ALICE);
		await vi.waitFor(() => expect(identities).toHaveLength(2));
		identities[1].resolve(BOB);

		await expect(load).resolves.toEqual({ current: true, identity: BOB });
		expect(currentSessionScope().owner).toBe('account:bob');
		expect(sessionGeneration()).toBe(generation);
	});

	it('resolveProtectedSession: A’s late `false` does not end B’s session; B is checked instead', async () => {
		const { auth, checks, identities } = makeAuth();
		const guard = resolveProtectedSession(auth);
		await vi.waitFor(() => expect(checks).toHaveLength(1));

		const bob = await switchToBob(auth, identities);
		checks[0].resolve(false);
		await vi.waitFor(() => expect(checks).toHaveLength(2));
		checks[1].resolve(true);

		await expect(guard).resolves.toBe('session');
		expectBobUntouched(bob);
	});

	it('confirmSessionEnded: A’s late `false` does not end B’s session nor notify', async () => {
		const { auth, checks, identities } = makeAuth();
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const ended = vi.fn();
		const off = onSessionEnded(ended);
		const confirmation = confirmSessionEnded();
		await vi.waitFor(() => expect(checks).toHaveLength(1));

		const bob = await switchToBob(auth, identities);
		checks[0].resolve(false);
		await vi.waitFor(() => expect(checks).toHaveLength(2));
		checks[1].resolve(true);

		await expect(confirmation).resolves.toBe('valid');
		expect(ended).not.toHaveBeenCalled();
		expectBobUntouched(bob);
		off();
	});

	it('confirmSessionEnded: a `false` for the session still current ends it (unchanged behavior)', async () => {
		const { auth, checks } = makeAuth();
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const alice = currentSessionScope();
		const confirmation = confirmSessionEnded();
		await vi.waitFor(() => expect(checks).toHaveLength(1));
		checks[0].resolve(false);
		await expect(confirmation).resolves.toBe('ended');
		expect(isCurrentSessionScope(alice)).toBe(false);
		expect(currentSessionScope().owner).toBeNull();
	});
});
