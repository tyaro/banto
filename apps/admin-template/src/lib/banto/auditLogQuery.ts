/**
 * The audit-log screen's URL query (#591 stage 2 follow-up): the drawer's
 * "see all in the audit log" link opens `/audit-log?resource=items&entityId=42`,
 * and the screen starts with the grid filtered to that record.
 *
 * Plain TypeScript so the rule can be unit-tested; the page applies the
 * result and removes the parameters from the URL (like `?view=`).
 */
import type { FilterState } from '@banto/grid-svelte';

/** Query parameter names; the same as the grid column ids they filter. */
export const AUDIT_QUERY_RESOURCE = 'resource';
export const AUDIT_QUERY_ENTITY_ID = 'entityId';

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
	return filters;
}

/** Does the URL carry either parameter (so the page has something to remove)? */
export function hasAuditLogQuery(params: Pick<URLSearchParams, 'get' | 'has'>): boolean {
	return params.has(AUDIT_QUERY_RESOURCE) || params.has(AUDIT_QUERY_ENTITY_ID);
}

/**
 * The link the record drawer's history tab offers: the audit-log path with
 * both parameters, URL-encoded. `base` is `resolveAppPath('/audit-log')`.
 */
export function auditLogLink(base: string, resource: string, id: string | number): string {
	const query = new URLSearchParams({
		[AUDIT_QUERY_RESOURCE]: resource,
		[AUDIT_QUERY_ENTITY_ID]: String(id)
	});
	return `${base}?${query.toString()}`;
}
