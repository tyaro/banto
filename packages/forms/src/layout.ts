/**
 * Pure layout decisions for schema-driven forms (Issue #714): which fields
 * are visible, which values are submitted, and how the visible fields group
 * into sections and columns. No Svelte imports - `BantoForm` only renders the
 * result.
 */
import type { FieldDef, FormColumns, FormSchema, FormSection } from './types';

/** True unless the field has a `visibleWhen` that says no for these values. */
export function isFieldVisible(def: FieldDef, values: Record<string, unknown>): boolean {
	return def.visibleWhen ? def.visibleWhen(values) : true;
}

/** The names of the fields hidden for these values. */
export function hiddenFieldNames(schema: FormSchema, values: Record<string, unknown>): Set<string> {
	const hidden = new Set<string>();
	for (const def of schema.fields) if (!isFieldVisible(def, values)) hidden.add(def.name);
	return hidden;
}

/**
 * `values` without the keys of hidden fields. Keys that no field names (a
 * lock version, say) stay. A new object; `values` is not changed.
 */
export function submitValuesOf(
	schema: FormSchema,
	values: Record<string, unknown>
): Record<string, unknown> {
	const hidden = hiddenFieldNames(schema, values);
	if (hidden.size === 0) return { ...values };
	return Object.fromEntries(Object.entries(values).filter(([name]) => !hidden.has(name)));
}

/** Columns of a group: its own, else the form's, else 1; anything but 1-3 counts as 1. */
export function resolveColumns(own?: number, fallback?: number): FormColumns {
	for (const n of [own, fallback]) {
		if (n === 1 || n === 2 || n === 3) return n;
	}
	return 1;
}

export interface LayoutField {
	def: FieldDef;
	/** Position in `schema.fields`; stable under hiding, so element ids do not move. */
	index: number;
}

export interface LayoutGroup {
	/** `null` for the fields without a (known) section. */
	section: FormSection | null;
	columns: FormColumns;
	fields: LayoutField[];
}

/**
 * The visible fields as groups in render order: the fields without a section
 * first (in `fields` order), then each section in `sections` order. A group
 * with no visible field is left out, so a section whose fields are all
 * hidden loses its heading too. A `section` id that no section has counts
 * as no section.
 */
export function layoutOf(schema: FormSchema, values: Record<string, unknown>): LayoutGroup[] {
	const known = new Map((schema.sections ?? []).map((section) => [section.id, section]));
	const loose: LayoutField[] = [];
	const bySection = new Map<string, LayoutField[]>();
	schema.fields.forEach((def, index) => {
		if (!isFieldVisible(def, values)) return;
		const id = def.section !== undefined && known.has(def.section) ? def.section : undefined;
		if (id === undefined) loose.push({ def, index });
		else bySection.set(id, [...(bySection.get(id) ?? []), { def, index }]);
	});
	const groups: LayoutGroup[] = [];
	if (loose.length > 0)
		groups.push({ section: null, columns: resolveColumns(schema.columns), fields: loose });
	for (const section of schema.sections ?? []) {
		const fields = bySection.get(section.id);
		if (fields)
			groups.push({
				section,
				columns: resolveColumns(section.columns, schema.columns),
				fields
			});
	}
	return groups;
}

/**
 * Where focus goes when the field it was on gets hidden: the nearest visible
 * field before it in `fields` order, else the first visible one, else null
 * (nothing is visible; the caller leaves focus alone).
 */
export function focusFallbackName(
	schema: FormSchema,
	values: Record<string, unknown>,
	hiddenName: string
): string | null {
	const at = schema.fields.findIndex((def) => def.name === hiddenName);
	const visible = schema.fields.filter((def) => isFieldVisible(def, values));
	const before = visible.filter((def) => schema.fields.indexOf(def) < at);
	return (before.at(-1) ?? visible[0])?.name ?? null;
}
