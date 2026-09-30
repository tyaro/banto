/**
 * Issue #215/#255 5th review: an auth answer that was requested for one
 * session and arrives after this tab moved on to another (logout, then a
 * login as B whose session is established and rendered) must not start,
 * end or change B's session scope - its owner, its generation (what
 * `(app)/+layout.svelte` compares against the generation its load
 * confirmed), or its saved list view state.
 *
 * Issue #260 実装-2: the pre-#260 API (`establishSession`,
 * `resolveProtectedSession`, `confirmSessionEnded`) now delegates to the
 * SessionController, which asks ONE question (`AuthProvider.resolve()`)
 * instead of `check()` + `getIdentity()` and shares one in-flight probe
 * among concurrent requests (single-flight, I-9). The scenarios are kept;
 * the fake provider answers through `resolve()` (`probes[n]`: an identity
 * answers `active`, `null` answers `none`), and the two "same turn" cases
 * describe the single-flight behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderError } from '../src/errors';
import { loadListViewState, saveListViewState } from '../src/listViewState';
import { createHttpAuthProvider } from '../src/providers/http';
import type {
	AuthProvider,
	CredentialRevision,
	DataProvider,
	Identity,
	ResolvedAuth
} from '../src/provider';
import { initBanto } from '../src/registry.svelte';
import { resetDefaultSessionController } from '../src/sessionController.svelte';
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

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A value whose promise the test settles later. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** An AuthProvider whose `resolve()` answers come from a queue the test controls (`null` = `none`). */
function makeAuth() {
	const probes: ReturnType<typeof deferred<Identity | null>>[] = [];
	const revision = '1.0' as CredentialRevision;
	const auth: AuthProvider = {
		login: async () => ({ success: true }),
		logout: async () => {},
		check: vi.fn(async () => true),
		getIdentity: vi.fn(async () => null),
		resolve: vi.fn(async (): Promise<ResolvedAuth> => {
			const answer = deferred<Identity | null>();
			probes.push(answer);
			const identity = await answer.promise;
			return identity
				? { status: 'active', checked: revision, current: revision, identity }
				: { status: 'none', checked: revision, current: revision };
		}),
		credentialRevision: () => revision,
		onCredentialChanged: () => () => {}
	};
	return { auth, probes };
}

/** Log out of A and establish B's session (its load finished and rendered): returns B's scope. */
async function switchToBob(
	auth: AuthProvider,
	probes: ReturnType<typeof deferred<Identity | null>>[]
): Promise<SessionScope> {
	endSession(); // the logout
	const before = probes.length;
	const bobLoad = establishSession(auth);
	await vi.waitFor(() => expect(probes.length).toBeGreaterThan(before));
	probes[probes.length - 1].resolve(BOB);
	await expect(bobLoad).resolves.toMatchObject({ current: true, identity: BOB });
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
	resetDefaultSessionController();
	endSession();
	beginSession(ALICE);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a late answer for A's session leaves B's session alone (#255 5th review)", () => {
	it('establishSession: A’s pending identity resolved after B’s load is not applied', async () => {
		const { auth, probes } = makeAuth();
		const aliceLoad = establishSession(auth);
		await vi.waitFor(() => expect(probes).toHaveLength(1));

		const bob = await switchToBob(auth, probes);
		probes[0].resolve(ALICE);
		await flush();

		await expect(aliceLoad).resolves.toMatchObject({ current: false, identity: null });
		expectBobUntouched(bob);
	});

	it('establishSession: an answer made stale by a session change (no newer load) asks the current session again', async () => {
		const { auth, probes } = makeAuth();
		const load = establishSession(auth);
		await vi.waitFor(() => expect(probes).toHaveLength(1));
		endSession();
		beginSession(BOB); // e.g. established by some other path meanwhile
		const generation = sessionGeneration();

		probes[0].resolve(ALICE);
		await vi.waitFor(() => expect(probes).toHaveLength(2));
		probes[1].resolve(BOB);

		await expect(load).resolves.toMatchObject({ current: true, identity: BOB });
		expect(currentSessionScope().owner).toBe('account:bob');
		expect(sessionGeneration()).toBe(generation);
	});

	it('resolveProtectedSession: A’s late `none` does not end B’s session; B is checked instead', async () => {
		const { auth, probes } = makeAuth();
		const guard = resolveProtectedSession(auth);
		await vi.waitFor(() => expect(probes).toHaveLength(1));

		// The logout supersedes the guard's request; it asks again and joins
		// B's load (single-flight) - B's answer settles both.
		const bob = await switchToBob(auth, probes);
		probes[0].resolve(null);
		await flush();

		await expect(guard).resolves.toBe('session');
		expect(probes).toHaveLength(2);
		expectBobUntouched(bob);
	});

	it('confirmSessionEnded: A’s late `none` does not end B’s session nor notify', async () => {
		const { auth, probes } = makeAuth();
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const confirmation = confirmSessionEnded();
		await vi.waitFor(() => expect(probes).toHaveLength(1));

		const bob = await switchToBob(auth, probes);
		// B's layout subscribes after the logout's `none`.
		const ended = vi.fn();
		const off = onSessionEnded(ended);
		probes[0].resolve(null);
		await flush();

		await expect(confirmation).resolves.toBe('valid');
		expect(ended).not.toHaveBeenCalled();
		expectBobUntouched(bob);
		off();
	});

	it('confirmSessionEnded: a `none` for the session still current ends it (unchanged behavior)', async () => {
		const { auth, probes } = makeAuth();
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const alice = currentSessionScope();
		const confirmation = confirmSessionEnded();
		await vi.waitFor(() => expect(probes).toHaveLength(1));
		probes[0].resolve(null);
		await expect(confirmation).resolves.toBe('ended');
		expect(isCurrentSessionScope(alice)).toBe(false);
		expect(currentSessionScope().owner).toBeNull();
	});
});

// 6th review (P2 1): the check and the write must be ONE continuation. With
// the controller, the guard and a load in flight together share ONE probe,
// so "the guard's `none` and B's identity in the same turn" is one answer
// that both see; the state is that answer and the next load confirms B.
describe('an old guard settled in the same turn as the next identity (#255 6th review)', () => {
	it('the guard and B’s load share one answer; the next load confirms B', async () => {
		const { auth, probes } = makeAuth();
		const guard = resolveProtectedSession(auth);
		const bobLoad = establishSession(auth);
		await vi.waitFor(() => expect(probes).toHaveLength(1));

		probes[0].resolve(null);
		await expect(guard).resolves.toBe('login');
		await expect(bobLoad).resolves.toMatchObject({ current: true, identity: null });

		const nextLoad = establishSession(auth);
		await vi.waitFor(() => expect(probes).toHaveLength(2));
		probes[1].resolve(BOB);
		await expect(nextLoad).resolves.toMatchObject({ current: true, identity: BOB });
		expect(currentSessionScope().owner).toBe('account:bob');
	});

	it('confirmSessionEnded and B’s load share the confirmation’s probe (it started after the signal)', async () => {
		const { auth, probes } = makeAuth();
		initBanto({ dataProvider: {} as DataProvider, authProvider: auth, resources: [] });
		const confirmation = confirmSessionEnded();
		const bobLoad = establishSession(auth);
		await vi.waitFor(() => expect(probes).toHaveLength(1));
		probes[0].resolve(BOB);

		await expect(bobLoad).resolves.toMatchObject({ current: true, identity: BOB });
		const bob = currentSessionScope();
		await expect(confirmation).resolves.toBe('valid');
		expect(isCurrentSessionScope(bob)).toBe(true);
		expect(bob.owner).toBe('account:bob');
		expect(probes).toHaveLength(1);
	});
});

// 6th review (P2 2): an identity that could not be FETCHED (a 500, a network
// failure) is not "nobody" - the session scope and the saved state stay as
// they are, and the same identity confirmed on the retry restores it.
describe('a transient identity failure keeps the session and its saved state (#255 6th review)', () => {
	function httpAuth(responses: (() => Promise<Response>)[]): AuthProvider {
		sessionStorage.setItem('banto.auth.token', 'token-a');
		vi.stubGlobal('localStorage', makeMemoryStorage());
		const fetchFn = vi.fn(async (url: string) => {
			if (url.endsWith('/api/auth/identity')) return responses.shift()!();
			throw new Error(`unexpected ${url}`);
		});
		return createHttpAuthProvider({ fetchFn: fetchFn as unknown as typeof fetch });
	}

	it.each([
		['a 500', async () => new Response('boom', { status: 500 })],
		[
			'a network failure',
			async () => {
				throw new TypeError('Failed to fetch');
			}
		]
	])('%s, then the same identity again', async (_label, failure) => {
		const alice = currentSessionScope();
		saveListViewState(alice, 'items:server', {
			sort: [{ field: 'price', direction: 'desc' }],
			filters: []
		});
		const auth = httpAuth([
			failure,
			async () => new Response(JSON.stringify(ALICE), { status: 200 })
		]);

		await expect(establishSession(auth)).rejects.toSatisfy(isProviderError);
		expect(isCurrentSessionScope(alice)).toBe(true);
		expect(sessionGeneration()).toBe(alice.generation);
		expect(storage.getItem('banto.listView.items:server')).not.toBeNull();

		await expect(establishSession(auth)).resolves.toMatchObject({ current: true, identity: ALICE });
		expect(isCurrentSessionScope(alice)).toBe(true);
		expect(loadListViewState(alice, 'items:server')?.sort).toEqual([
			{ field: 'price', direction: 'desc' }
		]);
	});

	it('HTTP getIdentity: a 401 is still "no session" (null), not a failure', async () => {
		const auth = httpAuth([async () => new Response('', { status: 401 })]);
		await expect(auth.getIdentity()).resolves.toBeNull();
	});

	it("an ownerless session (identity null) does not drop the previous owner's entries", () => {
		const alice = currentSessionScope();
		saveListViewState(alice, 'items:server', { sort: [], filters: [] });
		beginSession(null);
		expect(currentSessionScope().owner).toBeNull();
		expect(storage.getItem('banto.listView.items:server')).not.toBeNull();
		beginSession(ALICE);
		expect(loadListViewState(currentSessionScope(), 'items:server')).not.toBeNull();
	});
});
