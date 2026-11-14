/**
 * The field-level diff an `update` audit record carries (#597):
 * `detail = { name, changes: [{ field, before, after } | { field, masked }] }`.
 *
 * Plain TypeScript so the parsing and the label lookup can be unit-tested; the
 * screens (audit-log detail, the drawer's history tab) only draw the result.
 * `detail` is the stored JSON text; a record without a `changes` array (older
 * records, other operations) gives `null` and the caller keeps its own display.
 */
import { resources } from '#lib/banto/resources/index.js';

export interface AuditChange {
	field: string;
	/** `true`: the value was deliberately not recorded (a secret field). */
	masked: boolean;
	before: unknown;
	after: unknown;
}

/** `null` when `detail` is not JSON or has no `changes` array. */
export function parseAuditChanges(detail: string | null | undefined): AuditChange[] | null {
	if (!detail) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(detail);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const changes = (parsed as { changes?: unknown }).changes;
	if (!Array.isArray(changes)) return null;
	const out: AuditChange[] = [];
	for (const entry of changes) {
		if (typeof entry !== 'object' || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.field !== 'string') continue;
		out.push({ field: e.field, masked: e.masked === true, before: e.before, after: e.after });
	}
	return out;
}

/**
 * The label a resource's form schema gives a field (the record is stored by
 * its internal name), else the internal name itself.
 */
export function auditFieldLabel(resource: string, field: string): string {
	const def = resources.find((r) => r.name === resource);
	// `ResourceDefinition.schema` is `unknown` (admin-core does not know the form library).
	const schema = def?.schema as { fields?: { name: string; label?: unknown }[] } | undefined;
	const label = schema?.fields?.find((f) => f.name === field)?.label;
	return typeof label === 'string' && label !== '' ? label : field;
}

/** A recorded value as text (`null`/missing as `-`; objects as JSON). */
export function formatAuditValue(value: unknown): string {
	if (value === null || value === undefined) return '-';
	if (typeof value === 'string') return value === '' ? '""' : value;
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}
