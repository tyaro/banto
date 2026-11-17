/**
 * The LAN browser's connection state as the app shows it (Issue #637 PR-2,
 * design-ux-review D-4). `setup.ts` calls {@link startConnectionMonitor}
 * in the `server` branch only; Tauri and demo never create one, so
 * {@link connectionStatus} stays `online` and the banner never shows
 * (conventions §10: the mode decision stays in `setup.ts`).
 *
 * Recovery (rules in `connectionRecovery.ts`): the screen is re-read once
 * with `invalidateAll()` when a request or the browser's `online` brought
 * the connection back, never when the stream did (`connectEvents` already
 * re-reads on its reconnect); the "reconnected" toast is shown once.
 */
import {
	createConnectionMonitor,
	getSessionController,
	invalidateAll,
	type ConnectionMonitor,
	type ConnectionStatus,
	type HttpRequestResult,
	type StreamConnectionListener
} from '@banto/admin-core';
import * as m from '#lib/paraglide/messages.js';
import { toastStore } from '#lib/toast.svelte.js';
import { decideRecovery, type RecoveryCause } from './connectionRecovery';

/** How long the "try again" probe may wait for an answer. */
const RETRY_TIMEOUT_MS = 10_000;

let monitor = $state.raw<ConnectionMonitor | null>(null);
let retrying = false;

export interface ConnectionWiring {
	/** `onRequestResult` of the HTTP data and auth providers. */
	reportRequest: (result: HttpRequestResult) => void;
	/** `connectEvents(provider, { connection })`. */
	stream: StreamConnectionListener;
	/** Stop listening to the browser and forget the monitor (the banner goes). */
	dispose: () => void;
}

/**
 * Create the one monitor and return what `setup.ts` wires it to. A second
 * call disposes the first (a re-run of the startup must not leave two
 * monitors toasting).
 */
export function startConnectionMonitor(now: () => number = Date.now): ConnectionWiring {
	monitor?.dispose();
	const own = createConnectionMonitor();
	monitor = own;

	let cause: RecoveryCause = 'request';
	let lastRefreshAt: number | null = null;
	let lastToastAt: number | null = null;

	own.onRecovered(() => {
		const at = now();
		const decision = decideRecovery({ cause, now: at, lastRefreshAt, lastToastAt });
		// The stream's own re-read counts as the screen's latest re-read.
		if (decision.refresh || cause === 'stream') lastRefreshAt = at;
		if (decision.refresh) invalidateAll();
		if (decision.toast) {
			lastToastAt = at;
			toastStore.push('success', m['connection.recovered']());
		}
	});

	return {
		reportRequest: (result) => own.reportRequest(result),
		stream: {
			reportStreamDisconnected: () => own.reportStreamDisconnected(),
			reportStreamReconnected: () => {
				// `onRecovered` runs inside this call, so the cause is known there.
				cause = 'stream';
				try {
					own.reportStreamReconnected();
				} finally {
					cause = 'request';
				}
			}
		},
		dispose: () => {
			own.dispose();
			if (monitor === own) monitor = null;
		}
	};
}

/** Reactive. `online` whenever no monitor exists (Tauri, demo). */
export function connectionStatus(): ConnectionStatus {
	return monitor?.status ?? 'online';
}

/**
 * "Try again": one light request that already exists - the session probe
 * every navigation makes. Its answer (any status) is reported to the
 * monitor like any other request, which brings the status back and runs the
 * recovery above; a failure leaves the banner as it is. It moves no focus
 * and is ignored while the previous probe is still out.
 */
export async function retryConnection(): Promise<void> {
	if (retrying || !monitor) return;
	retrying = true;
	try {
		await getSessionController().resolve({ timeoutMs: RETRY_TIMEOUT_MS });
	} finally {
		retrying = false;
	}
}
