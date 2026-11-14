import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '#lib/banto/serverAdmin.js';
import { LAN_SHARE_POLL_MS, LanShareStatus, lanShareSummary } from './lanShare.svelte';

// The module's singleton reads through the real IPC wrapper; these tests
// build their own `LanShareStatus` with a fake read instead.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/app', () => ({ getIdentifier: vi.fn() }));

function status(patch: Partial<ServerStatus> = {}): ServerStatus {
	return {
		enabled: true,
		running: true,
		bind: '0.0.0.0',
		port: 8721,
		viewerPublic: false,
		live: { bind: '0.0.0.0', port: 8721 },
		urls: ['http://127.0.0.1:8721', 'http://192.168.1.20:8721'],
		qrSvgs: [],
		uiEmbedded: true,
		generation: 1,
		sseConnections: 2,
		...patch
	};
}

describe('lanShareSummary (Issue #558)', () => {
	it('is sharing while a LAN URL is served with the web UI', () => {
		expect(lanShareSummary(status())).toEqual({ connections: 2 });
	});

	it('is not sharing when stopped, loopback-only, IPv6 or without the web UI', () => {
		expect(lanShareSummary(null)).toBeNull();
		expect(lanShareSummary(status({ running: false, urls: [] }))).toBeNull();
		expect(
			lanShareSummary(
				status({
					bind: '127.0.0.1',
					live: { bind: '127.0.0.1', port: 8721 },
					urls: ['http://127.0.0.1:8721']
				})
			)
		).toBeNull();
		// IPv6 binds get no URLs at all (connectivityScope.ts's module doc).
		expect(lanShareSummary(status({ live: { bind: '::', port: 8721 }, urls: [] }))).toBeNull();
		expect(lanShareSummary(status({ uiEmbedded: false }))).toBeNull();
	});

	it('reads an unreported or malformed count as unknown', () => {
		expect(lanShareSummary(status({ sseConnections: undefined }))).toEqual({ connections: null });
		expect(lanShareSummary(status({ sseConnections: -1 }))).toEqual({ connections: null });
		expect(lanShareSummary(status({ sseConnections: 1.5 }))).toEqual({ connections: null });
		expect(lanShareSummary(status({ sseConnections: 0 }))).toEqual({ connections: 0 });
	});
});

/** A read the test answers by hand, in any order. */
function manualReads() {
	const pending: { resolve: (s: ServerStatus) => void; reject: (e: unknown) => void }[] = [];
	const get = vi.fn(
		() =>
			new Promise<ServerStatus>((resolve, reject) => {
				pending.push({ resolve, reject });
			})
	);
	return { get, pending };
}

describe('LanShareStatus (Issue #558)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('reads at once, then every interval while watched', async () => {
		const reads = manualReads();
		const share = new LanShareStatus(reads.get);
		const stop = share.watch();
		expect(reads.get).toHaveBeenCalledTimes(1);
		reads.pending[0].resolve(status({ sseConnections: 1 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(share.summary).toEqual({ connections: 1 });

		await vi.advanceTimersByTimeAsync(LAN_SHARE_POLL_MS - 1);
		expect(reads.get).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(reads.get).toHaveBeenCalledTimes(2);
		reads.pending[1].resolve(status({ sseConnections: 3 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(share.summary).toEqual({ connections: 3 });
		stop();
	});

	it('never lets an older answer put back an older state', async () => {
		const reads = manualReads();
		const share = new LanShareStatus(reads.get);
		const stop = share.watch();
		share.refresh(); // a second read while the first is in flight
		reads.pending[1].resolve(status({ sseConnections: 5 }));
		await vi.advanceTimersByTimeAsync(0);
		reads.pending[0].resolve(status({ sseConnections: 1 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(share.summary).toEqual({ connections: 5 });
		// Only the latest read schedules the next one.
		await vi.advanceTimersByTimeAsync(LAN_SHARE_POLL_MS);
		expect(reads.get).toHaveBeenCalledTimes(3);
		stop();
	});

	it('shows nothing when the read fails, and keeps polling', async () => {
		const reads = manualReads();
		const share = new LanShareStatus(reads.get);
		const stop = share.watch();
		reads.pending[0].resolve(status());
		await vi.advanceTimersByTimeAsync(0);
		expect(share.summary).not.toBeNull();
		await vi.advanceTimersByTimeAsync(LAN_SHARE_POLL_MS);
		reads.pending[1].reject(new Error('forbidden'));
		await vi.advanceTimersByTimeAsync(0);
		expect(share.summary).toBeNull();
		await vi.advanceTimersByTimeAsync(LAN_SHARE_POLL_MS);
		expect(reads.get).toHaveBeenCalledTimes(3);
		stop();
	});

	it('stops with the last watcher: no timer left, an answer in flight is dropped', async () => {
		const reads = manualReads();
		const share = new LanShareStatus(reads.get);
		const first = share.watch();
		const second = share.watch();
		expect(reads.get).toHaveBeenCalledTimes(1); // one shared read
		reads.pending[0].resolve(status());
		await vi.advanceTimersByTimeAsync(0);

		first();
		first(); // stopping twice is harmless
		await vi.advanceTimersByTimeAsync(LAN_SHARE_POLL_MS);
		expect(reads.get).toHaveBeenCalledTimes(2); // still watched by `second`

		second();
		expect(share.summary).toBeNull();
		reads.pending[1].resolve(status({ sseConnections: 9 }));
		await vi.advanceTimersByTimeAsync(LAN_SHARE_POLL_MS * 3);
		expect(share.summary).toBeNull();
		expect(reads.get).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);

		share.refresh(); // nobody watches: nothing is read
		expect(reads.get).toHaveBeenCalledTimes(2);
	});
});
