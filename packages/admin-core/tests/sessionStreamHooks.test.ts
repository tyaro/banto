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

	it('the same 401 heard on /api/events and on an app stream ends the session once', async () => {
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

		eventsHooks!.onUnauthorized!();
		appHooks.onUnauthorized!();
		// The second signal replaces the first confirmation; it does not add one.
		const live = p.probes.filter((probe) => !probe.settled && !probe.signal?.aborted);
		expect(live).toHaveLength(1);
		p.none(p.probes.length - 1, { clear: true });
		await flush();
		expect(ended).toHaveBeenCalledTimes(1);
		expect(getSessionController().snapshot.status).toBe('none');
		off();
	});
});
