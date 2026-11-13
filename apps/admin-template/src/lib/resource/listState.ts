/**
 * Pure helpers of `ResourceListPage` (ADR-0030 §4, stage 4), kept out of the
 * component so they can be unit-tested without a DOM.
 */
import type { FilterState, SortState } from '@banto/grid-svelte';
import type { AppResourceDefinition, ListLoadMode } from './types';

/** The load modes a resource offers, in the definition's order. Default `['server']` (ADR-0030 decision 3). */
export function listLoadModes(definition: Pick<AppResourceDefinition, 'list'>): ListLoadMode[] {
	const modes = [...new Set(definition.list?.loadModes ?? [])];
	return modes.length > 0 ? modes : ['server'];
}

/**
 * The mode a list opens in: the one this session last used (Issue #215) when
 * the resource still offers it, otherwise `server` when offered (the side that
 * stays fast as the data grows), otherwise the first offered mode. A stale or
 * foreign saved value can never select a mode the resource does not have.
 */
export function initialLoadMode(
	saved: string | null,
	modes: readonly ListLoadMode[]
): ListLoadMode {
	const offered = modes.find((mode) => mode === saved);
	if (offered) return offered;
	return modes.includes('server') ? 'server' : (modes[0] ?? 'server');
}

/** Schema field names an inline edit may write back (every field that is not `readonly`). */
export function editableFieldNames(
	schema: { fields: readonly { name: string; readonly?: boolean }[] } | undefined
): string[] {
	return (schema?.fields ?? []).filter((field) => !field.readonly).map((field) => field.name);
}

/**
 * `DataProvider.update` expects the full editable value set: the base row's
 * editable values, overwritten by this save's changed columns. Columns outside
 * the schema (the row's id, a client-only derived field) are never sent.
 */
export function composeEditableValues(
	fields: readonly string[],
	row: Record<string, unknown>,
	changes: Record<string, unknown>
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of fields) values[field] = row[field];
	for (const [field, value] of Object.entries(changes)) {
		if (fields.includes(field)) values[field] = value;
	}
	return values;
}

/**
 * The sort / filters a CSV export forwards to `getList()`: only entries on a
 * real column of the resource. A client-only derived column (e.g. a grouping
 * field) has no server-side equivalent, and forwarding it would silently match
 * zero rows instead of the rows on screen.
 */
export function exportListParams(
	active: { sort: SortState[]; filters: FilterState[] },
	validFields: ReadonlySet<string>
): { sort: SortState[]; filters: FilterState[] } {
	return {
		sort: active.sort.filter((entry) => validFields.has(entry.field)),
		filters: active.filters.filter((entry) => validFields.has(entry.field))
	};
}
