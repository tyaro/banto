/**
 * The audit-log screen's URL query (#591 stage 2 follow-up): the drawer's
 * "see all in the audit log" link opens `/audit-log?recordResource=items&recordId=42`,
 * and the screen starts with the grid filtered to that record.
 *
 * Plain TypeScript so the rule can be unit-tested; the page applies the
 * result and removes the parameters from the URL (like `?view=`).
 */
import type { FilterState } from '@banto/grid-svelte';
import type { AuditLogEntry } from './auditLogAdmin.js';

/** Query parameter names; the same as the grid column ids they filter. */
export const AUDIT_QUERY_RESOURCE = 'resource';
export const AUDIT_QUERY_ENTITY_ID = 'entityId';
export const AUDIT_QUERY_RECORD_RESOURCE = 'recordResource';
export const AUDIT_QUERY_RECORD_ID = 'recordId';

/** Display the same record scope that the server uses for history filters. */
export function auditRecordScope(row: AuditLogEntry): { resource: string; id: string | null } {
	if (row.detail) {
		try {
			const detail: unknown = JSON.parse(row.detail);
			if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
				const { parentResource, parentId } = detail as Record<string, unknown>;
				if (
					typeof parentResource === 'string' &&
					(typeof parentId === 'string' ||
						(typeof parentId === 'number' && Number.isInteger(parentId)))
				) {
					return { resource: parentResource, id: String(parentId) };
				}
			}
		} catch {
			// Historical malformed detail follows the row's canonical identity.
		}
	}
	return { resource: row.resource, id: row.entityId };
}

/** A longer value is not a record the audit log can hold: ignore it. */
const MAX_VALUE_LENGTH = 200;

function cleanValue(raw: string | null): string | null {
	if (raw === null) return null;
	const value = raw.trim();
	// Control characters never occur in a resource name or an entity id.
	// eslint-disable-next-line no-control-regex
	if (value === '' || value.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
		return null;
	}
	return value;
}

/**
 * The grid filters a URL asks for. `eq`, not `contains`, exactly as the
 * drawer's history reads (`recordHistoryParams`): a substring match would show
 * the history of id 10 and 100 under id 1. Either parameter alone is fine; an
 * empty / over-long / control-character value is dropped (no filter, not an
 * error); a repeated parameter uses its first value.
 */
export function auditLogFiltersFromQuery(
	params: Pick<URLSearchParams, 'get' | 'has'>
): FilterState[] {
	const filters: FilterState[] = [];
	const resource = cleanValue(params.get(AUDIT_QUERY_RESOURCE));
	if (resource !== null) filters.push({ field: 'resource', op: 'eq', value: resource });
	const entityId = cleanValue(params.get(AUDIT_QUERY_ENTITY_ID));
	if (entityId !== null) filters.push({ field: 'entityId', op: 'eq', value: entityId });
	const recordResource = cleanValue(params.get(AUDIT_QUERY_RECORD_RESOURCE));
	if (recordResource !== null)
		filters.push({ field: 'recordResource', op: 'eq', value: recordResource });
	const recordId = cleanValue(params.get(AUDIT_QUERY_RECORD_ID));
	if (recordId !== null) filters.push({ field: 'recordId', op: 'eq', value: recordId });
	return filters;
}

/** Does the URL carry either parameter (so the page has something to remove)? */
export function hasAuditLogQuery(params: Pick<URLSearchParams, 'get' | 'has'>): boolean {
	return (
		params.has(AUDIT_QUERY_RESOURCE) ||
		params.has(AUDIT_QUERY_ENTITY_ID) ||
		params.has(AUDIT_QUERY_RECORD_RESOURCE) ||
		params.has(AUDIT_QUERY_RECORD_ID)
	);
}

/**
 * The link the record drawer's history tab offers: the audit-log path with
 * both parameters, URL-encoded. `base` is `resolveAppPath('/audit-log')`.
 */
export function auditLogLink(base: string, resource: string, id: string | number): string {
	const query = new URLSearchParams({
		[AUDIT_QUERY_RECORD_RESOURCE]: resource,
		[AUDIT_QUERY_RECORD_ID]: String(id)
	});
	return `${base}?${query.toString()}`;
}
