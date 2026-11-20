/**
 * Bulk delete on the resource list (#713): the decisions of the flow, kept out
 * of `ResourceListPage` so they can be tested without a component.
 *
 * The delete is ONE all-or-nothing `DataProvider.deleteMany` request
 * (`POST /api/<resource>/bulk-delete` / `<resource>_bulk_delete`): the role
 * check, the optimistic-lock check of every record and the audit entry are the
 * backend's, the same on both transports (conventions §1). Nothing here
 * deletes one record at a time.
 *
 * Pure and UI-agnostic: the page supplies the provider calls, the confirmation
 * dialog and the session check, and turns the outcome into a notice.
 */
import { isProviderError } from '@banto/admin-core';
import type {
	DeleteManyItem,
	DeleteManyResult,
	DeleteManyTarget,
	FilterState,
	ListParams,
	ListResult,
	SortState
} from '@banto/admin-core';
import type { RowId } from '@banto/grid-svelte';
import { lockVersionOf } from './conflict';

/**
 * The most records one request may delete: the server's `MAX_BULK_DELETE_ROWS`
 * (`core/src/items.rs`). Checked here first so the user is told before the
 * confirmation, not by a `bad_request` after it.
 */
export const BULK_DELETE_MAX_ROWS = 1000;

/** Rows per `getList` call while collecting a whole filtered result. */
export const BULK_DELETE_COLLECT_PAGE_SIZE = 500;

/**
 * Is the bulk delete offered on this list? All three, or neither the
 * checkboxes nor the bar are shown:
 * - the resource definition opts in (`bulkDelete: true`). The HTTP and Tauri
 *   providers have `deleteMany` for EVERY resource name, so the method alone
 *   does not say the resource's backend implements it;
 * - the provider has `deleteMany` (it is optional);
 * - the user may delete (`resourcePermissions().delete`).
 */
export function bulkDeleteOffered(input: {
	resourceOptIn: boolean | undefined;
	provider: { deleteMany?: unknown };
	canDelete: boolean;
}): boolean {
	return (
		input.resourceOptIn === true &&
		typeof input.provider.deleteMany === 'function' &&
		input.canDelete
	);
}

/**
 * The `version` of each selected row AS IT WAS WHEN THE ROW WAS SELECTED
 * (`null` = the row was seen and carries no version: an unversioned resource).
 * Looked up at selection time because, in server mode, a selected row can
 * leave the loaded window before the delete is pressed - looking it up then
 * would find nothing and send the record without its check.
 */
export type VersionCapture = ReadonlyMap<RowId, number | null>;

/**
 * The capture after a selection change: ids no longer selected are dropped,
 * ids already captured keep their version, and each newly selected id takes
 * the version of the row `rowOf` shows now. An id whose row is not found gets
 * no entry (`deleteItemsFromCapture` then refuses to send).
 */
export function updateVersionCapture(
	previous: VersionCapture,
	selectedIds: readonly RowId[],
	rowOf: (id: RowId) => Record<string, unknown> | null | undefined
): Map<RowId, number | null> {
	const next = new Map<RowId, number | null>();
	for (const id of selectedIds) {
		const kept = previous.get(id);
		if (kept !== undefined) {
			next.set(id, kept);
			continue;
		}
		const row = rowOf(id);
		if (row) next.set(id, lockVersionOf(row) ?? null);
	}
	return next;
}

/**
 * The capture after THIS page saved rows (an inline edit or a paste): a
 * selected row the user just changed themselves carries its new version, so
 * their own edit is not reported back to them as someone else's change.
 */
export function refreshCapturedVersions(
	previous: VersionCapture,
	savedRows: readonly Record<string, unknown>[]
): Map<RowId, number | null> {
	const next = new Map(previous);
	for (const row of savedRows) {
		const id = row.id as RowId;
		if (next.has(id)) next.set(id, lockVersionOf(row) ?? null);
	}
	return next;
}

export type DeleteItemsResult =
	{ ok: true; items: DeleteManyItem[] } | { ok: false; reason: 'versionMissing' };

function toItem(id: RowId, version: number | null | undefined): DeleteManyItem {
	return version === null || version === undefined ? { id } : { id, version };
}

/**
 * `items` must be all versioned or all unversioned: in a versioned resource a
 * record sent without `version` would be deleted unchecked.
 */
function allOrNoneVersioned(items: readonly DeleteManyItem[]): boolean {
	const versioned = items.filter((item) => item.version !== undefined).length;
	return versioned === 0 || versioned === items.length;
}

/**
 * The request records of a selection, from the versions captured when the
 * rows were selected. Refuses (`versionMissing`) when a selected id was never
 * captured, or when only some of the rows carry a version.
 */
export function deleteItemsFromCapture(
	selectedIds: readonly RowId[],
	capture: VersionCapture
): DeleteItemsResult {
	const items: DeleteManyItem[] = [];
	for (const id of new Set(selectedIds)) {
		const version = capture.get(id);
		if (version === undefined) return { ok: false, reason: 'versionMissing' };
		items.push(toItem(id, version));
	}
	if (!allOrNoneVersioned(items)) return { ok: false, reason: 'versionMissing' };
	return { ok: true, items };
}

/** The list's conditions: the grid's sort and filters plus the page's search. */
export interface ListConditions {
	sort: SortState[];
	filters: FilterState[];
	search?: string;
}

export type CollectResult =
	| { kind: 'ok'; items: DeleteManyItem[] }
	| { kind: 'tooMany' }
	| { kind: 'versionMissing' }
	/** The result moved while it was read (a repeated id, a changed count): the set is not trustworthy. */
	| { kind: 'changed' };

/**
 * Every record the conditions match, with the `version` just read, for
 * "select all matching" - page by page. `tooMany` as soon as the result is
 * known to exceed `max` (the first page's `totalCount`, or the rows actually
 * collected). `changed` when the result moved while it was read: a row met
 * twice, a `totalCount` that differs from the first page's, or a collected
 * count that is not the `totalCount` - the set could be missing rows.
 */
export async function collectMatchingItems(
	getList: (params: ListParams) => Promise<ListResult<Record<string, unknown>>>,
	conditions: ListConditions,
	options: { max?: number; pageSize?: number } = {}
): Promise<CollectResult> {
	const max = options.max ?? BULK_DELETE_MAX_ROWS;
	const pageSize = options.pageSize ?? BULK_DELETE_COLLECT_PAGE_SIZE;
	const byId = new Map<RowId, DeleteManyItem>();
	let offset = 0;
	let firstTotal: number | undefined;
	// One page more than `max` rows need: a result that keeps growing ends too.
	const maxPages = Math.ceil(max / pageSize) + 1;
	for (let page = 0; page < maxPages; page++) {
		const result = await getList({
			pagination: { offset, limit: pageSize },
			sort: conditions.sort,
			filters: conditions.filters,
			search: conditions.search
		});
		if (result.totalCount > max) return { kind: 'tooMany' };
		if (firstTotal !== undefined && result.totalCount !== firstTotal) return { kind: 'changed' };
		firstTotal = result.totalCount;
		for (const row of result.rows) {
			const id = row.id as RowId;
			if (byId.has(id)) return { kind: 'changed' };
			byId.set(id, toItem(id, lockVersionOf(row)));
		}
		if (byId.size > max) return { kind: 'tooMany' };
		offset += result.rows.length;
		if (result.rows.length === 0 || offset >= result.totalCount) {
			if (byId.size !== result.totalCount) return { kind: 'changed' };
			const items = [...byId.values()];
			return allOrNoneVersioned(items) ? { kind: 'ok', items } : { kind: 'versionMissing' };
		}
	}
	return { kind: 'tooMany' };
}

/**
 * "Still the session (and the screen) the delete was started in?" Call it
 * when the user presses delete - BEFORE the confirmation - and ask the
 * returned function right before the request: `false` when the session ended
 * or changed owner while the dialog was open (logout, another login, another
 * tab), or when the page was torn down. The delete must then not be sent: it
 * would run with the NEW session's rights on the old session's selection.
 */
export function captureSendGuard<Scope>(session: {
	capture: () => Scope;
	isCurrent: (scope: Scope) => boolean;
	isDestroyed: () => boolean;
	/**
	 * The list's and selection's generation (anything that changes whenever
	 * the search, mode, sort, filters or selection change), compared with
	 * `Object.is`. The send is refused once it differs from the press.
	 */
	view?: () => unknown;
}): () => boolean {
	const scope = session.capture();
	const sameView = captureViewGuard(session.view ?? (() => 0));
	return () => !session.isDestroyed() && session.isCurrent(scope) && sameView();
}

/**
 * "Still the list and selection the delete was pressed on?" Captured at the
 * press; `false` once `view()` returns something else (the user searched,
 * changed mode or filters, or changed the selection). What was read or asked
 * for the old list must not be confirmed, sent or used to clear the new
 * selection.
 */
export function captureViewGuard(view: () => unknown): () => boolean {
	const at = view();
	return () => Object.is(view(), at);
}

export type BulkDeleteFailure =
	{ kind: 'conflict' } | { kind: 'rejected'; message: string } | { kind: 'error'; message: string };

/**
 * What a failed `deleteMany` means for the user: `conflict` (a record changed
 * or is gone - nothing was deleted), `rejected` (`bad_request`: an empty,
 * repeated or over-limit target) or any other `error` (denied, network ...).
 */
export function bulkDeleteFailureOf(err: unknown): BulkDeleteFailure {
	if (isProviderError(err)) {
		if (err.body.kind === 'conflict') return { kind: 'conflict' };
		if (err.body.kind === 'bad_request') return { kind: 'rejected', message: err.message };
	}
	return { kind: 'error', message: errorMessageOf(err) };
}

function errorMessageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export type BulkDeleteOutcome =
	/** Deleted: empty the selection and reload. */
	| { kind: 'done'; deleted: number }
	/** The user closed the confirmation. Nothing sent. */
	| { kind: 'cancelled' }
	/** The session changed or the page is gone. Nothing sent, nothing to say. */
	| { kind: 'stale' }
	/** More than the limit. No confirmation shown, nothing sent. */
	| { kind: 'tooMany' }
	/** A versioned record without a known version. Nothing sent. */
	| { kind: 'versionMissing' }
	/** The matching rows moved while they were read. Nothing sent. */
	| { kind: 'changed' }
	/** "All matching" matched nothing by the time it was read. Nothing sent. */
	| { kind: 'noRows' }
	| BulkDeleteFailure;

export interface BulkDeleteRequest {
	/** The selected ids (`allMatching`: only the loaded ones - not used then). */
	ids: readonly RowId[];
	/** The grid's "all matching" mode: delete what `conditions` match. */
	allMatching: boolean;
	capture: VersionCapture;
	/** The list's conditions when delete was pressed (used by `allMatching`). */
	conditions: ListConditions;
}

export interface BulkDeleteDeps {
	getList: (params: ListParams) => Promise<ListResult<Record<string, unknown>>>;
	deleteMany: (target: DeleteManyTarget) => Promise<DeleteManyResult>;
	/** The confirmation dialog, with the number of records that will be sent. */
	confirm: (info: { count: number; allMatching: boolean }) => Promise<boolean>;
	/** `captureSendGuard`'s function, captured when delete was pressed. */
	canSend: () => boolean;
	max?: number;
	pageSize?: number;
}

/**
 * The whole flow of one press of "delete": work out the records (the captured
 * selection, or - in "all matching" mode - a fresh read of what the conditions
 * match), refuse what cannot be sent, confirm with the real count, check the
 * session, and send ONE request. Never throws.
 */
export async function runBulkDelete(
	request: BulkDeleteRequest,
	deps: BulkDeleteDeps
): Promise<BulkDeleteOutcome> {
	const max = deps.max ?? BULK_DELETE_MAX_ROWS;
	let items: DeleteManyItem[];
	if (request.allMatching) {
		let collected: CollectResult;
		try {
			collected = await collectMatchingItems(deps.getList, request.conditions, {
				max,
				pageSize: deps.pageSize
			});
		} catch (err) {
			return { kind: 'error', message: errorMessageOf(err) };
		}
		if (collected.kind !== 'ok') return collected;
		// The read took a while: do not open a dialog for a session that is gone
		// or a list that is no longer the one delete was pressed on.
		if (!deps.canSend()) return { kind: 'stale' };
		items = collected.items;
	} else {
		const built = deleteItemsFromCapture(request.ids, request.capture);
		if (!built.ok) return { kind: built.reason };
		items = built.items;
	}
	if (items.length === 0) return { kind: 'noRows' };
	if (items.length > max) return { kind: 'tooMany' };

	if (!(await deps.confirm({ count: items.length, allMatching: request.allMatching }))) {
		return { kind: 'cancelled' };
	}
	// The dialog can stay open for any length of time: the one check that
	// matters is here, right before the one request.
	if (!deps.canSend()) return { kind: 'stale' };
	try {
		const result = await deps.deleteMany({ kind: 'ids', items });
		return { kind: 'done', deleted: result.deleted };
	} catch (err) {
		return bulkDeleteFailureOf(err);
	}
}
