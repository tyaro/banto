/**
 * Small pieces shared by the two block-fetching list resources
 * (`windowed.svelte.ts` and `snapshot.svelte.ts`, spec §4.1). Internal:
 * not exported from the package entry point.
 */
import { isProviderError, ProviderError } from './errors';

/** The largest valid JavaScript array length (2 ** 32 - 1). */
export const MAX_ARRAY_LENGTH = 0xffff_ffff;

/** Anything thrown or rejected, as the `ProviderError` a resource records. */
export function toProviderError(err: unknown): ProviderError {
	return isProviderError(err) ? err : new ProviderError({ kind: 'other', message: String(err) });
}

/**
 * Default text of the failure a block request records when it has not
 * answered within `ms`. `SnapshotListResource` lets the app replace it
 * (`messages.timeout`); `WindowedListResource` uses it as is.
 */
export function defaultTimeoutMessage(ms: number): string {
	return `list request timed out after ${ms} ms`;
}

/** Default text of the failure recorded for an answer that cannot be written. */
export const DEFAULT_MALFORMED_MESSAGE = 'malformed list result';

/** The failure a block request records when it has not answered within `ms`. */
export function timeoutError(ms: number): ProviderError {
	return new ProviderError({ kind: 'other', message: defaultTimeoutMessage(ms) });
}

/** Whether `ms` enables a request time limit (`0`, a negative number, `NaN` or `Infinity` disable it). */
export function hasTimeLimit(ms: number): boolean {
	return ms > 0 && Number.isFinite(ms);
}

/**
 * Whether a list answer can be written at `offset` without throwing:
 * `rows` is an array, `totalCount` is a non-negative integer that is also a
 * valid array length (a safe integer is not enough - `2 ** 32` passes that
 * and then throws `RangeError` on `rows.length = ...`), and the rows written
 * at `offset` stay within that limit too.
 */
export function isWritableList(result: unknown, offset: number): boolean {
	if (result === null || typeof result !== 'object') return false;
	const { rows, totalCount } = result as { rows?: unknown; totalCount?: unknown };
	return (
		Array.isArray(rows) &&
		typeof totalCount === 'number' &&
		Number.isInteger(totalCount) &&
		totalCount >= 0 &&
		totalCount <= MAX_ARRAY_LENGTH &&
		offset + rows.length <= MAX_ARRAY_LENGTH
	);
}
