/**
 * The "history of this record" list in the detail drawer (#591, stage 2):
 * the audit log read through `listAuditLog`, narrowed to one resource and one
 * record. No diff view here (that is C-5); the drawer lists time / user /
 * action / result / origin only.
 *
 * Plain TypeScript (no runes) so the filter and the stale-answer rule can be
 * unit-tested; `ResourceHistory.svelte` only draws the state this keeps.
 */
import type { ListParams } from '@banto/admin-core';
import type { AuditLogEntry, AuditLogList } from '#lib/banto/auditLogAdmin.js';

/** One page: the drawer shows the latest entries, the audit-log screen has the rest. */
export const HISTORY_PAGE_SIZE = 50;

/**
 * Newest first, one resource, one record. `eq`, not `contains`: a substring
 * match would list the history of id 10 and 100 under id 1.
 */
export function recordHistoryParams(
	resource: string,
	id: string | number,
	limit: number = HISTORY_PAGE_SIZE
): ListParams {
	return {
		pagination: { offset: 0, limit },
		sort: [
			{ field: 'ts', direction: 'desc' },
			{ field: 'id', direction: 'desc' }
		],
		filters: [
			{ field: 'resource', op: 'eq', value: resource },
			{ field: 'entityId', op: 'eq', value: String(id) }
		]
	};
}

export type RecordHistoryState =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'ready'; rows: AuditLogEntry[]; total: number }
	| { status: 'error'; error: unknown };

type ListFn = (
	params: ListParams,
	asOfId?: number | null,
	signal?: AbortSignal
) => Promise<AuditLogList>;

export interface RecordHistoryLoader {
	/** Start a read; the previous one (if still running) is dropped, aborted where it can be. */
	load(resource: string, id: string | number): Promise<void>;
	/** Drop whatever is running; nothing is reported afterwards. */
	dispose(): void;
}

/**
 * A loader that reports to `onChange`. Each `load` takes a new generation: an
 * answer (or failure) of an older generation is thrown away, so moving between
 * rows quickly never shows another record's history. The REST call is aborted
 * through the signal; a Tauri `invoke()` cannot be, its late answer is just
 * ignored here.
 */
export function createRecordHistoryLoader(
	list: ListFn,
	onChange: (state: RecordHistoryState) => void
): RecordHistoryLoader {
	let generation = 0;
	let controller: AbortController | null = null;

	function drop(): number {
		controller?.abort();
		controller = null;
		return ++generation;
	}

	return {
		async load(resource, id) {
			const mine = drop();
			const own = new AbortController();
			controller = own;
			onChange({ status: 'loading' });
			try {
				const result = await list(recordHistoryParams(resource, id), null, own.signal);
				if (mine !== generation) return;
				onChange({ status: 'ready', rows: result.rows, total: result.totalCount });
			} catch (error) {
				if (mine !== generation) return;
				onChange({ status: 'error', error });
			}
		},
		dispose() {
			drop();
		}
	};
}
