/**
 * Read-only sample audit log for the plain-browser demo (Issue #712,
 * conventions §10). Only `auditLogAdmin.ts` imports this, and only in `demo`
 * mode: there is no audit database there, so the audit-log screen shows these
 * fixed rows instead of an "unavailable" dead end. Writes (the retention
 * policy) stay refused (`DEMO_MODE_MESSAGE`).
 *
 * Fixed values, no randomness. The rows use the real audit vocabulary
 * (`action`, `origin`, `result`, the `detail` JSON with `changes`) so the
 * screen's filters, paging and detail panel behave as they do for real data.
 * Filter/sort/paging reuse admin-core's InMemory list semantics.
 */
import { createInMemoryDataProvider, type ListParams } from '@banto/admin-core';
import type { AuditLogEntry, AuditLogList, AuditSettings } from '../auditLogAdmin';

interface Actor {
	id: number;
	name: string;
	role: string;
}

const ACTORS: readonly Actor[] = [
	{ id: 2, name: 'sato', role: 'admin' },
	{ id: 3, name: 'suzuki', role: 'editor' },
	{ id: 4, name: 'tanaka', role: 'editor' }
];

const ITEMS = ['ボルト M8', 'ワッシャー M8', '六角ナット M8', '平座金 M10', 'ばね座金 M10'];

/** Ids ascend with time, like the real table. */
function buildRows(): AuditLogEntry[] {
	const rows: AuditLogEntry[] = [];
	const base = Date.UTC(2026, 10, 1, 9, 0, 0);
	const push = (
		actor: Actor | null,
		action: string,
		resource: string,
		entityId: string | null,
		detail: unknown,
		result = 'ok',
		origin = 'rest'
	): void => {
		const id = rows.length + 1;
		rows.push({
			id,
			ts: new Date(base + id * 47 * 60 * 1000).toISOString(),
			actorUsername: actor?.name ?? null,
			actorId: actor?.id ?? null,
			actorRole: actor?.role ?? null,
			actorKind: actor ? 'account' : null,
			action,
			resource,
			entityId,
			detail: detail === null ? null : JSON.stringify(detail),
			origin,
			result
		});
	};

	for (let i = 0; i < 40; i += 1) {
		const actor = ACTORS[i % ACTORS.length];
		const item = String(100 + i);
		const name = ITEMS[i % ITEMS.length];
		switch (i % 8) {
			case 0:
				push(actor, 'login', 'auth', null, null);
				break;
			case 1:
				push(actor, 'create', 'items', item, {
					name,
					changes: [{ field: 'name', before: null, after: name }]
				});
				break;
			case 2:
				push(actor, 'update', 'items', item, {
					name,
					changes: [{ field: 'stock', before: 10 + i, after: 20 + i }]
				});
				break;
			case 3:
				push(actor, 'update', 'items', item, {
					name,
					changes: [{ field: 'price', before: 120, after: 135 }]
				});
				break;
			case 4:
				push(null, 'login_failed', 'auth', null, { username: 'guest' }, 'failed');
				break;
			case 5:
				push(actor, 'delete', 'items', item, {
					name,
					changes: [{ field: 'name', before: name, after: null }]
				});
				break;
			case 6:
				push(ACTORS[2], 'denied', 'users', null, { reason: 'forbidden' }, 'denied');
				break;
			default:
				push(actor, 'logout', 'auth', null, null, 'ok', 'tauri');
		}
	}
	return rows;
}

const ROWS: readonly AuditLogEntry[] = buildRows();
const ROWS_BY_ID = new Map(ROWS.map((row) => [row.id, row]));

/** The retention policy shown in demo (read-only). */
export const DEMO_AUDIT_SETTINGS: AuditSettings = { retentionDays: 365, retentionRows: 100000 };

/**
 * One block of the demo audit log: rows with `id <= asOfId` (all of them when
 * `asOfId` is null), filtered, sorted and paged by `params`.
 */
export async function demoAuditLogList(
	params: ListParams,
	asOfId: number | null
): Promise<AuditLogList> {
	const maxId = ROWS[ROWS.length - 1].id;
	const boundary = asOfId === null ? maxId : Math.min(asOfId, maxId);
	const provider = createInMemoryDataProvider(
		{
			audit_log: {
				rows: ROWS.filter((row) => row.id <= boundary).map((row) => ({
					...row,
					// The grid's hidden "record" columns filter on these (see
					// `auditRecordScope`); the demo rows have no parent record.
					recordResource: row.resource,
					recordId: row.entityId
				}))
			}
		},
		{ latencyMs: 0 }
	);
	const { rows, totalCount } = await provider.getList<{ id: number }>('audit_log', params);
	return {
		rows: rows.map((row) => ROWS_BY_ID.get(row.id) as AuditLogEntry),
		totalCount,
		asOfId: boundary,
		deletionEpoch: 0
	};
}
