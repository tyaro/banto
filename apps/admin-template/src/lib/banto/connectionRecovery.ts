/**
 * The app's rules around the connection banner (Issue #637 PR-2), pure so
 * they are tested without a DOM. The state itself comes from
 * `@banto/admin-core`'s `createConnectionMonitor`; the wiring is
 * `connection.svelte.ts`.
 */
import { isNetworkError, isProviderError } from '@banto/admin-core';
import type { ConnectionStatus } from '@banto/admin-core';

/** What the banner shows: nothing (`null`), or why the server cannot be reached. */
export type ConnectionBannerKind = 'reconnecting' | 'offline';

/**
 * Which banner shows for a status. Whether there is anything to watch at
 * all (only the LAN browser has a monitor) is `connectionMonitoring()`'s
 * question, decided where the monitor is wired (`setup.ts`), not here.
 */
export function connectionBannerKind(status: ConnectionStatus): ConnectionBannerKind | null {
	return status === 'online' ? null : status;
}

/** Which input brought the connection back. */
export type RecoveryCause =
	/** The change stream reconnected: `connectEvents` already re-read every list. */
	| 'stream'
	/** A request was answered, or the browser said `online`: nothing re-read yet. */
	| 'request';

/** Two recoveries closer than this re-read the screen once. */
export const RECOVERY_REFRESH_COOLDOWN_MS = 2000;
/** Two recoveries closer than this say "reconnected" once. */
export const RECOVERY_TOAST_COOLDOWN_MS = 10_000;

export interface RecoveryInput {
	cause: RecoveryCause;
	now: number;
	/** When the screen was last re-read (by this rule or by the stream's own re-read); `null` if never. */
	lastRefreshAt: number | null;
	/** When "reconnected" was last said; `null` if never. */
	lastToastAt: number | null;
}

export interface RecoveryDecision {
	/** Call `invalidateAll()` once. */
	refresh: boolean;
	/** Show the "reconnected" toast. */
	toast: boolean;
}

function elapsed(now: number, last: number | null, cooldown: number): boolean {
	return last === null || now - last >= cooldown;
}

/**
 * The screen is re-read exactly once per recovery: not at all when the
 * stream came back (it did, already), and not again within the cooldown of
 * the previous re-read, so a connection that flaps does not hammer the
 * server or the user. A gap of exactly the cooldown is outside it.
 */
export function decideRecovery(input: RecoveryInput): RecoveryDecision {
	return {
		refresh:
			input.cause === 'request' &&
			elapsed(input.now, input.lastRefreshAt, RECOVERY_REFRESH_COOLDOWN_MS),
		toast: elapsed(input.now, input.lastToastAt, RECOVERY_TOAST_COOLDOWN_MS)
	};
}

/**
 * The toast for a failed save that is not a field validation error: a lost
 * connection gets its own guidance (`networkMessage`), every other failure
 * keeps the provider's message as before. The draft is never touched here -
 * the form and the grid cell keep what the user typed on a failed save.
 */
export function saveErrorMessage(err: unknown, networkMessage: () => string): string {
	if (isNetworkError(err)) return networkMessage();
	return isProviderError(err) ? err.message : String(err);
}
