/**
 * Issue #637 PR-2: the connection store's recovery wiring over the real
 * `createConnectionMonitor` - one re-read and one toast per recovery, none
 * of the re-read when the stream came back, and no pile-up when it flaps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invalidateAll = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock('@banto/admin-core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@banto/admin-core')>()),
	invalidateAll
}));
vi.mock('#lib/toast.svelte.js', () => ({ toastStore: { push } }));
vi.mock('#lib/paraglide/messages.js', () => ({ 'connection.recovered': () => 'reconnected' }));

import {
	connectionMonitoring,
	connectionStatus,
	startConnectionMonitor
} from './connection.svelte';

const failed = (startedAt: number) => ({
	ok: false as const,
	failure: 'network' as const,
	startedAt
});
const answered = (startedAt: number) => ({ ok: true as const, startedAt });

describe('connection store', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		invalidateAll.mockClear();
		push.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('is online while no monitor exists', () => {
		expect(connectionStatus()).toBe('online');
		expect(connectionMonitoring()).toBe(false); // Tauri / demo: no banner region at all
	});

	it('a monitor exists from start until dispose', () => {
		const wiring = startConnectionMonitor();
		expect(connectionMonitoring()).toBe(true);
		wiring.dispose();
		expect(connectionMonitoring()).toBe(false);
	});

	it('a request failing twice shows reconnecting; its answer re-reads once and toasts once', () => {
		const wiring = startConnectionMonitor();
		wiring.reportRequest(failed(Date.now()));
		expect(connectionStatus()).toBe('online'); // one failure is not a disconnect
		wiring.reportRequest(failed(Date.now()));
		expect(connectionStatus()).toBe('reconnecting');

		vi.advanceTimersByTime(1000);
		wiring.reportRequest(answered(Date.now()));
		expect(connectionStatus()).toBe('online');
		expect(invalidateAll).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledWith('success', 'reconnected');

		// More answers while online are not recoveries.
		wiring.reportRequest(answered(Date.now()));
		expect(invalidateAll).toHaveBeenCalledTimes(1);
		wiring.dispose();
		expect(connectionStatus()).toBe('online');
	});

	it('the stream coming back toasts but does not re-read (connectEvents did)', () => {
		const wiring = startConnectionMonitor();
		wiring.stream.reportStreamDisconnected();
		expect(connectionStatus()).toBe('reconnecting');
		vi.advanceTimersByTime(3000);
		wiring.stream.reportStreamReconnected();
		expect(connectionStatus()).toBe('online');
		expect(invalidateAll).not.toHaveBeenCalled();
		expect(push).toHaveBeenCalledTimes(1);
		wiring.dispose();
	});

	it('a stream return and a request answer together recover once', () => {
		const wiring = startConnectionMonitor();
		wiring.stream.reportStreamDisconnected();
		vi.advanceTimersByTime(1000);
		wiring.stream.reportStreamReconnected();
		wiring.reportRequest(answered(Date.now())); // already online: no second recovery
		expect(push).toHaveBeenCalledTimes(1);
		expect(invalidateAll).not.toHaveBeenCalled();
		wiring.dispose();
	});

	it('a flapping connection re-reads and toasts once, not on every recovery', () => {
		const wiring = startConnectionMonitor();
		for (let i = 0; i < 3; i++) {
			wiring.stream.reportStreamDisconnected();
			vi.advanceTimersByTime(10);
			wiring.reportRequest(answered(Date.now())); // recovered by a request
			vi.advanceTimersByTime(10);
		}
		expect(invalidateAll).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledTimes(1);

		// Past both cooldowns it is a new recovery again.
		vi.advanceTimersByTime(11_000);
		wiring.stream.reportStreamDisconnected();
		vi.advanceTimersByTime(10);
		wiring.reportRequest(answered(Date.now()));
		expect(invalidateAll).toHaveBeenCalledTimes(2);
		expect(push).toHaveBeenCalledTimes(2);
		wiring.dispose();
	});

	it('a stream return counts as the latest re-read for the cooldown', () => {
		const wiring = startConnectionMonitor();
		wiring.stream.reportStreamDisconnected();
		vi.advanceTimersByTime(10);
		wiring.stream.reportStreamReconnected(); // connectEvents re-reads here
		vi.advanceTimersByTime(10);
		wiring.stream.reportStreamDisconnected();
		vi.advanceTimersByTime(10);
		wiring.reportRequest(answered(Date.now())); // 20ms later: no second re-read
		expect(invalidateAll).not.toHaveBeenCalled();
		wiring.dispose();
	});

	it('the browser going offline and back toasts once, with or without the stream', () => {
		const win = new EventTarget();
		vi.stubGlobal('window', win);
		for (const streamLost of [false, true]) {
			push.mockClear();
			invalidateAll.mockClear();
			const wiring = startConnectionMonitor();
			win.dispatchEvent(new Event('offline'));
			expect(connectionStatus()).toBe('offline');
			if (streamLost) wiring.stream.reportStreamDisconnected();
			win.dispatchEvent(new Event('online'));
			if (streamLost) {
				expect(connectionStatus()).toBe('reconnecting');
				wiring.stream.reportStreamReconnected();
			}
			expect(connectionStatus(), `streamLost=${streamLost}`).toBe('online');
			expect(push).toHaveBeenCalledTimes(1);
			wiring.dispose();
		}
		vi.unstubAllGlobals();
	});

	it('a second start disposes the first monitor', () => {
		const first = startConnectionMonitor();
		const second = startConnectionMonitor();
		first.stream.reportStreamDisconnected(); // ignored: disposed
		expect(connectionStatus()).toBe('online');
		second.stream.reportStreamDisconnected();
		expect(connectionStatus()).toBe('reconnecting');
		second.dispose();
	});
});
