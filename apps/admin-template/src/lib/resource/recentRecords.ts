/**
 * Recently opened records (#711: the command palette lists them for an empty
 * query), kept per signed-in user - the same shape and rules as
 * `#lib/recentCommands.ts` (Issue #258):
 *
 * - a READ returns only what was saved for the scope's owner (another user's
 *   list, or a corrupt entry, is invisible and dropped);
 * - a WRITE happens only while the scope is still the live session, and never
 *   for a scope without a confirmed owner (`owner === null`): off rather than
 *   guessing. Another owner's entry is replaced by the first write.
 *
 * Lives next to the resource screens (not in the palette's files) because
 * `ResourceDetail` writes it for every way of opening a record, and the
 * palette is an option that scaffold may remove (conventions §4): the screens
 * must not depend on it, the palette reads from here.
 *
 * Only what the palette needs to show a row is stored: the resource name, the
 * id and the title as it was when last opened. The palette never trusts it for
 * authorization - rows of a resource the role cannot read are filtered out at
 * read time, and opening one goes through the normal (guarded) list page.
 * Everything is best-effort: a full/disabled localStorage silently no-ops.
 */
import { isCurrentSessionScope, type SessionScope } from '@banto/admin-core';

export const RECENT_RECORDS_KEY = 'banto.recentRecords';
const MAX_RECENT_RECORDS = 10;

export interface RecentRecord {
	resource: string;
	id: string | number;
	title: string;
}

export interface RecentRecordsOptions {
	/** Defaults to the global `localStorage` (`null`/absent when unavailable). */
	storage?: Storage | null;
	/** Defaults to `isCurrentSessionScope`. */
	isCurrent?: (scope: SessionScope) => boolean;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
	if (storage !== undefined) return storage;
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is RecentRecord {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.resource === 'string' &&
		typeof entry.title === 'string' &&
		(typeof entry.id === 'string' || typeof entry.id === 'number')
	);
}

function parseEntry(raw: string | null): { owner: string; records: RecentRecord[] } | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const candidate = parsed as Record<string, unknown>;
		if (typeof candidate.owner !== 'string' || candidate.owner === '') return null;
		if (!Array.isArray(candidate.records)) return null;
		return { owner: candidate.owner, records: candidate.records.filter(isRecord) };
	} catch {
		return null;
	}
}

function readRaw(store: Storage): string | null {
	try {
		return store.getItem(RECENT_RECORDS_KEY);
	} catch {
		return null;
	}
}

/** Most-recent-first records saved for `scope`'s owner; `[]` for anyone else, an ownerless scope, or a corrupt entry. */
export function loadRecentRecords(
	scope: SessionScope,
	options: RecentRecordsOptions = {}
): RecentRecord[] {
	const store = resolveStorage(options.storage);
	if (!store || scope.owner === null) return [];
	const entry = parseEntry(readRaw(store));
	return entry !== null && entry.owner === scope.owner ? entry.records : [];
}

/** Move the record to the front (or insert it), capped at 10. No-op unless `scope` is the live session with a confirmed owner. */
export function recordRecentRecord(
	scope: SessionScope,
	record: RecentRecord,
	options: RecentRecordsOptions = {}
): void {
	const store = resolveStorage(options.storage);
	const isCurrent = options.isCurrent ?? isCurrentSessionScope;
	if (!store || scope.owner === null || !isCurrent(scope)) return;
	const kept = loadRecentRecords(scope, options).filter(
		(entry) => !(entry.resource === record.resource && String(entry.id) === String(record.id))
	);
	const records = [record, ...kept].slice(0, MAX_RECENT_RECORDS);
	try {
		store.setItem(RECENT_RECORDS_KEY, JSON.stringify({ owner: scope.owner, records }));
	} catch {
		// Best-effort convenience feature.
	}
}
