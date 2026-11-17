/**
 * Issue #637 PR-2: the pure rules behind the connection banner - when it
 * shows (mode x status), whether a recovery re-reads the screen and says
 * "reconnected", and the toast for a save that failed on a lost connection.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError, validation, type ConnectionStatus } from '@banto/admin-core';
import {
	RECOVERY_REFRESH_COOLDOWN_MS,
	RECOVERY_TOAST_COOLDOWN_MS,
	connectionBannerKind,
	decideRecovery,
	saveErrorMessage
} from './connectionRecovery';
import type { BantoMode } from './setup';

describe('connectionBannerKind', () => {
	const statuses: ConnectionStatus[] = ['online', 'reconnecting', 'offline'];
	const modes: BantoMode[] = ['tauri', 'server', 'demo'];

	it('shows only in server mode, and only while not online', () => {
		for (const mode of modes) {
			for (const status of statuses) {
				const expected = mode === 'server' && status !== 'online' ? status : null;
				expect(connectionBannerKind(mode, status), `${mode}/${status}`).toBe(expected);
			}
		}
	});
});

describe('decideRecovery', () => {
	const base = { now: 100_000, lastRefreshAt: null, lastToastAt: null };

	it('re-reads once when a request or the browser brought it back', () => {
		expect(decideRecovery({ ...base, cause: 'request' })).toEqual({ refresh: true, toast: true });
	});

	it('does not re-read when the stream came back (connectEvents already did)', () => {
		expect(decideRecovery({ ...base, cause: 'stream' })).toEqual({ refresh: false, toast: true });
	});

	it('does not re-read twice within the cooldown; exactly the cooldown is outside it', () => {
		const at = (gap: number) =>
			decideRecovery({
				cause: 'request',
				now: 100_000,
				lastRefreshAt: 100_000 - gap,
				lastToastAt: null
			}).refresh;
		expect(at(0)).toBe(false);
		expect(at(RECOVERY_REFRESH_COOLDOWN_MS - 1)).toBe(false);
		expect(at(RECOVERY_REFRESH_COOLDOWN_MS)).toBe(true);
	});

	it('says "reconnected" once per cooldown', () => {
		const at = (gap: number) =>
			decideRecovery({
				cause: 'request',
				now: 100_000,
				lastRefreshAt: null,
				lastToastAt: 100_000 - gap
			}).toast;
		expect(at(RECOVERY_TOAST_COOLDOWN_MS - 1)).toBe(false);
		expect(at(RECOVERY_TOAST_COOLDOWN_MS)).toBe(true);
	});
});

describe('saveErrorMessage', () => {
	const guidance = () => 'guidance';

	it('gives a lost connection its own guidance', () => {
		for (const networkFailure of ['network', 'timeout'] as const) {
			const err = new ProviderError(
				{ kind: 'other', message: 'サーバーに接続できません' },
				{ networkFailure }
			);
			expect(saveErrorMessage(err, guidance)).toBe('guidance');
		}
	});

	it('keeps every other failure as it was', () => {
		const server = new ProviderError({ kind: 'other', message: 'boom' });
		expect(saveErrorMessage(server, guidance)).toBe('boom');
		expect(saveErrorMessage(validation([{ field: 'a', message: 'bad' }]), guidance)).not.toBe(
			'guidance'
		);
		expect(saveErrorMessage(new Error('x'), guidance)).toBe('Error: x');
	});
});
