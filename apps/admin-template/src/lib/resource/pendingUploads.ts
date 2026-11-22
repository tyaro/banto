/**
 * #714 F2: files whose upload to a just-created record failed, carried from the
 * create form to that record's edit form (`ResourceDetail`). The files live
 * only in memory (a `File` cannot be stored), so a reload loses them - the
 * edit form then simply has no leftovers. Taken once: the first edit form
 * opened for the record owns them.
 */
import type { FileFieldValue } from '@banto/forms';

type Pending = FileFieldValue['pending'];

const handoffs = new Map<string, Pending>();

const keyOf = (resource: string, id: number): string => `${resource}/${id}`;

/** Remember the files that did not upload for the record just created. */
export function stashPendingUploads(resource: string, id: number, pending: Pending): void {
	if (pending.length > 0) handoffs.set(keyOf(resource, id), pending);
}

/** The files stashed for this record (and forget them), or `null`. */
export function takePendingUploads(resource: string, id: number): Pending | null {
	const key = keyOf(resource, id);
	const pending = handoffs.get(key) ?? null;
	handoffs.delete(key);
	return pending;
}
