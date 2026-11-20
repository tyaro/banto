/**
 * Bulk delete on the resource list (#713 C-3): the selected rows are deleted
 * through the SAME one-record operation the detail form uses
 * (`DataProvider.deleteOne`), one after another. No bulk endpoint exists, so
 * each delete keeps its own permission check, optimistic-lock `version` check
 * and audit entry on both transports (conventions §1).
 *
 * Pure and UI-agnostic: the page supplies the delete call and shows the
 * confirmation / summary.
 */
import type { RowId } from '@banto/grid-svelte';

export interface BulkDeleteResult {
	/** Ids that were deleted, in the order they were processed. */
	deleted: RowId[];
	/** Ids whose delete failed (denied, conflict, not found, network ...). */
	failed: RowId[];
}

/**
 * Delete `ids` strictly one at a time (never in parallel). A failure does not
 * stop the run: the remaining ids are still attempted, and the failed ones are
 * reported. Duplicate ids are processed once.
 */
export async function runBulkDelete(
	ids: readonly RowId[],
	deleteOne: (id: RowId) => Promise<void>
): Promise<BulkDeleteResult> {
	const result: BulkDeleteResult = { deleted: [], failed: [] };
	for (const id of new Set(ids)) {
		try {
			await deleteOne(id);
			result.deleted.push(id);
		} catch {
			result.failed.push(id);
		}
	}
	return result;
}
