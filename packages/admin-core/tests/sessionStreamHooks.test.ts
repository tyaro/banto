/**
 * Issue #936 (design §5.4): `sessionStreamHooks()` wires an app stream's
 * `401` / cleared token to the default `SessionController`, the same two
 * signals `connectEvents` sends for `/api/events`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	connectEvents,
	sessionStreamHooks,
	type EventProvider,
	type EventSubscriptionHooks
} from '../src/events';
import { createSseStream } from '../src/sse-stream';
import { onSessionEnded } from '../src/sessionEnded';
import { initBanto } from '../src/registry.svelte';
import type { DataProvider } from '../src/provider';
import {
	getSessionController,
	resetDefaultSessionController,
	resolveSettled
} from '../src/sessionController.svelte';
import { ALICE, flush, makeProbeProvider } from './sessionHarness';

async function signedIn() {
	const p = makeProbeProvider();
	initBanto({ dataProvider: {} as DataProvider, authProvider: p.provider, resources: [] });
	const first = resolveSettled(getSessionController());
	p.active(0, ALICE);
	await first;
	return p;
}

describe('sessionStreamHooks', () => {
	beforeEach(() => {
		resetDefaultSessionController();
	});

	it('returns exactly the two session hooks', () => {
		expect(Object.keys(sessionStreamHooks()).sort()).toEqual(['onTokenCleared', 'onUnauthorized']);
	});

	it('an app stream answered 401 starts a confirmation, which ends the session', async () => {
		const p = await signedIn();
		const ended = vi.fn();
		const off = onSessionEnded(ended);
		const fetchFn = vi.fn(async () => new Response(null, { status: 401 }));
		const stop = createSseStream<string>({
			path: '/api/app/values',
			fetchFn,
			getToken: () => 'revoked',
			parse: (data) => data,
			onEvent: () => {},
			...sessionStreamHooks()
		});
		await flush();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(p.probes).toHaveLength(2);
		p.none(1, { clear: true });
		await flush();
		expect(ended).toHaveBeenCalledTimes(1);
		expect(getSessionController().snapshot.status).toBe('none');
		stop();
		off();
	});

	it('onTokenCleared signals the controller too', async () => {
		const p = await signedIn();
		sessionStreamHooks().onTokenCleared!();
		expect(p.probes).toHaveLength(2);
		p.active(1, ALICE);
		await flush();
		expect(getSessionController().snapshot.status).toBe('active');
	});

	// Design §5.4 (review of #945): the contract is "one confirmation in
	// flight, the session ends once", NOT "one request in total". Each signal
	// retires the confirmation in flight and starts its own, so two streams
	// hearing the same revocation make two requests, the first one aborted.
	it('the same 401 heard on /api/events and on an app stream: the confirmation is redone, never doubled; the session ends once', async () => {
		const p = await signedIn();
		const ended = vi.fn();
		const off = onSessionEnded(ended);
		let eventsHooks: EventSubscriptionHooks | undefined;
		const provider: EventProvider = {
			subscribe: (_handler, hooks) => {
				eventsHooks = hooks;
				return vi.fn();
			}
		};
		connectEvents(provider);
		const appHooks = sessionStreamHooks();

		const live = () => p.probes.filter((probe) => !probe.settled && !probe.signal?.aborted);
		expect(p.probes).toHaveLength(1); // the sign-in's

		eventsHooks!.onUnauthorized!();
		expect(p.probes).toHaveLength(2);
		expect(live()).toHaveLength(1);

		appHooks.onUnauthorized!();
		// Counted in full, aborted ones included: the second signal started a
		// second request ...
		expect(p.probes).toHaveLength(3);
		// ... after aborting the first, so there is still one in flight.
		expect(p.probes[1].signal?.aborted).toBe(true);
		expect(p.probes[2].signal?.aborted).toBe(false);
		expect(live()).toHaveLength(1);

		p.none(2, { clear: true });
		await flush();
		expect(ended).toHaveBeenCalledTimes(1);
		expect(getSessionController().snapshot.status).toBe('none');
		// Nothing more is asked once the answer is in.
		expect(p.probes).toHaveLength(3);
		off();
	});
});
