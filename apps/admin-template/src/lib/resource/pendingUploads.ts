/**
 * #714 F2: files whose upload to a just-created record failed, carried from the
 * create form to that record's edit form (`ResourceDetail`). The files live
 * only in memory (a `File` cannot be stored), so a reload loses them - the
 * edit form then simply has no leftovers.
 *
 * Tied to the session that created the record: a different session (another
 * user, or the same one after a logout) never sees them - a `File` the
 * previous user chose must not reappear for someone else.
 */
import { isCurrentSessionScope, type SessionScope } from '@banto/admin-core';
import type { FileFieldValue } from '@banto/forms';

type Pending = FileFieldValue['pending'];

const handoffs = new Map<string, { scope: SessionScope; pending: Pending }>();

const keyOf = (resource: string, id: number): string => `${resource}/${id}`;

/** Remember the files that did not upload for the record just created (by `scope`'s session). */
export function stashPendingUploads(
	scope: SessionScope,
	resource: string,
	id: number,
	pending: Pending
): void {
	if (pending.length > 0 && isCurrentSessionScope(scope)) {
		handoffs.set(keyOf(resource, id), { scope, pending });
	}
}

/** Are there files stashed for this record by the live session? (A stale entry is dropped.) */
export function hasPendingUploads(resource: string, id: number): boolean {
	const key = keyOf(resource, id);
	const entry = handoffs.get(key);
	if (!entry) return false;
	if (isCurrentSessionScope(entry.scope)) return true;
	handoffs.delete(key);
	return false;
}

/** The files stashed for this record (and forget them), or `null`. */
export function takePendingUploads(resource: string, id: number): Pending | null {
	if (!hasPendingUploads(resource, id)) return null;
	const key = keyOf(resource, id);
	const entry = handoffs.get(key);
	handoffs.delete(key);
	return entry?.pending ?? null;
}
