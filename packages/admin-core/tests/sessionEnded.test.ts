import { describe, expect, it, vi } from 'vitest';
import {
	CONFIRM_RETRY_INITIAL_MS,
	CONFIRM_TIMEOUT_MS,
	confirmSessionEnded,
	createSessionEndConfirmation,
	onSessionEnded
} from '../src/sessionEnded';
import { initBanto } from '../src/registry.svelte';
import type { AuthProvider, DataProvider } from '../src/provider';

function stubCheck(check: AuthProvider['check']): void {
	initBanto({
		dataProvider: {} as DataProvider,
		authProvider: {
			login: async () => ({ success: true }),
			logout: async () => {},
			check,
			getIdentity: async () => null
		},
		resources: []
	});
}

describe('confirmSessionEnded (Issue #241)', () => {
	it('resolves ended and notifies listeners only when check() resolves false', async () => {
		stubCheck(async () => false);
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		await expect(confirmSessionEnded()).resolves.toBe('ended');
		expect(ended).toHaveBeenCalledTimes(1);
		off();
	});

	it('resolves valid / unknown without notifying when the session is valid or could not be verified', async () => {
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		stubCheck(async () => true);
		await expect(confirmSessionEnded()).resolves.toBe('valid');
		stubCheck(async () => {
			throw new Error('500');
		});
		await expect(confirmSessionEnded()).resolves.toBe('unknown');

		expect(ended).not.toHaveBeenCalled();
		off();
	});

	it('concurrent confirmations share one check() and notify once', async () => {
		let answer!: (valid: boolean) => void;
		const check = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
		stubCheck(check);
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		const first = confirmSessionEnded();
		const second = confirmSessionEnded();
		expect(second).toBe(first);
		answer(false);
		await expect(Promise.all([first, second])).resolves.toEqual(['ended', 'ended']);
		expect(check).toHaveBeenCalledTimes(1);
		expect(ended).toHaveBeenCalledTimes(1);

		// Settled: a later revocation is confirmed afresh.
		const third = confirmSessionEnded();
		expect(third).not.toBe(first);
		answer(false);
		await third;
		expect(check).toHaveBeenCalledTimes(2);
		off();
	});

	it('an unsubscribed listener is not called, and one throwing listener does not stop the others', async () => {
		stubCheck(async () => false);
		const removed = vi.fn();
		const offRemoved = onSessionEnded(removed);
		offRemoved();
		const offThrowing = onSessionEnded(() => {
			throw new Error('broken listener');
		});
		const ended = vi.fn();
		const off = onSessionEnded(ended);

		await expect(confirmSessionEnded()).resolves.toBe('ended');
		expect(removed).not.toHaveBeenCalled();
		expect(ended).toHaveBeenCalledTimes(1);
		offThrowing();
		off();
	});

	it('gives up on a check() that never answers, so a later confirmation runs afresh', async () => {
		vi.useFakeTimers();
		try {
			const check = vi
				.fn<AuthProvider['check']>()
				.mockImplementationOnce(
					() =>
						new Promise<boolean>(() => {
							// hangs
						})
				)
				.mockResolvedValueOnce(false);
			stubCheck(check);
			const ended = vi.fn();
			const off = onSessionEnded(ended);

			const hung = confirmSessionEnded();
			await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
			await expect(hung).resolves.toBe('unknown');
			expect(ended).not.toHaveBeenCalled();

			await expect(confirmSessionEnded()).resolves.toBe('ended');
			expect(check).toHaveBeenCalledTimes(2);
			expect(ended).toHaveBeenCalledTimes(1);
			off();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('createSessionEndConfirmation (review of #242)', () => {
	it('retries an unknown outcome and stops at valid; start() while running adds no loop', async () => {
		vi.useFakeTimers();
		try {
			const check = vi
				.fn<AuthProvider['check']>()
				.mockRejectedValueOnce(new Error('500'))
				.mockResolvedValueOnce(true);
			stubCheck(check);
			const confirmation = createSessionEndConfirmation();
			confirmation.start();
			confirmation.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(check).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_INITIAL_MS);
			expect(check).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_INITIAL_MS * 10);
			expect(check).toHaveBeenCalledTimes(2);

			// Settled: a later start() confirms afresh.
			check.mockResolvedValueOnce(true);
			confirmation.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(check).toHaveBeenCalledTimes(3);
			confirmation.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('stop() cancels a pending retry', async () => {
		vi.useFakeTimers();
		try {
			const check = vi.fn<AuthProvider['check']>().mockRejectedValue(new Error('500'));
			stubCheck(check);
			const confirmation = createSessionEndConfirmation();
			confirmation.start();
			await vi.advanceTimersByTimeAsync(0);
			confirmation.stop();
			await vi.advanceTimersByTimeAsync(CONFIRM_RETRY_INITIAL_MS * 100);
			expect(check).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
