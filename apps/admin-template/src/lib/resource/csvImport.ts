/**
 * CSV import of a resource list (spec M15 Phase C, ADR-0030 §4 stage 5): the
 * pure part behind `ResourceListPage`'s import button and
 * `ResourceImportPanel`'s confirmation panel. Offered only when the definition
 * has `csv.import` and the role has the `import` permission (create AND edit).
 *
 * The preview and the request are built from **the same validated rows**
 * (issue #218): `buildImportPreview` parses the file once, the panel renders
 * `previewRows(rows)` and the request is `toImportPayload(rows)` - no second
 * parse for the preview.
 *
 * Columns: the header is mapped against the list's columns (`resourceColumns`,
 * minus the synthetic "open" link), so a round-tripped CSV export re-imports
 * cleanly. `id` is parsed by hand (blank = create, otherwise update), read-only
 * columns (`updatedAt`) are recognized but never written back, and only the
 * editable columns go through `convertCsvRow`.
 */
import { convertCsvRow, mapCsvHeader, parseCsv, type GridColumn } from '@banto/grid-svelte';
import type { FormSchema } from '@banto/forms';
import type { StatusBadgeVariant } from '@banto/ui';
import * as m from '#lib/paraglide/messages.js';
import type {
	AppResourceDefinition,
	ResourceCsvImport,
	ResourceImportResult,
	ResourceImportRow,
	ResourceRow
} from './types';

/** 確認パネルに描画する先頭行数。大量データでも確認画面を重くしないための上限。 */
export const IMPORT_PREVIEW_ROW_LIMIT = 10;

export interface ImportRowPreview {
	/** 1-based CSV line number, header counted as line 1 (so the first data row is line 2). */
	csvLine: number;
	/** Absent = create, present = update (spec M15). */
	id?: string | number;
	/** Converted values of the editable columns the header names, keyed by field. */
	values: Record<string, unknown>;
	errors: { columnId: string; message: string }[];
}

export interface ImportPreviewState {
	fileName: string;
	/** Header cells that matched no known column - shown as "無視される列". */
	ignoredHeaders: string[];
	/** Required fields missing from the header entirely - fatal, `rows` is left empty. */
	missingRequired: string[];
	/** Fields this import writes (editable columns the header names), in header order. */
	writtenFields: string[];
	rows: ImportRowPreview[];
	/**
	 * Row errors of a submitted import (null before the first submit). With
	 * `applied` null the batch was rolled back (all-or-nothing, spec M15);
	 * otherwise `run` applied part of it.
	 */
	serverErrors: { row: number; message: string }[] | null;
	/** Rows a partly-failed `run` did apply. Running again would repeat them, so the run button stays off. */
	applied: { created: number; updated: number } | null;
}

/** Field names the header must contain: `csv.import.required`, else the schema's required, writable fields. */
export function requiredImportFields(
	definition: Pick<AppResourceDefinition, 'schema'>,
	options: Pick<ResourceCsvImport, 'required'>
): string[] {
	if (options.required) return [...options.required];
	const schema = definition.schema as FormSchema;
	return schema.fields.filter((field) => field.required && !field.readonly).map((f) => f.name);
}

/** Field names the preview table shows: `csv.import.preview`, else the required fields. */
export function previewImportFields(
	definition: Pick<AppResourceDefinition, 'schema'>,
	options: Pick<ResourceCsvImport, 'required' | 'preview'>
): string[] {
	return options.preview ? [...options.preview] : requiredImportFields(definition, options);
}

/** Schema fields of type `number` (right-aligned in the preview table). */
export function numericFields(definition: Pick<AppResourceDefinition, 'schema'>): Set<string> {
	const schema = definition.schema as FormSchema;
	return new Set(schema.fields.filter((f) => f.type === 'number').map((f) => f.name));
}

/**
 * The `id` cell: blank means "no id -> create". It is not run through
 * `convertCsvRow` - the list's `id` column has no editor, so an empty cell
 * would come out as a literal string or a conversion failure, neither of which
 * is "create" (spec M15: "id あり→UPDATE / なし→INSERT").
 */
export function parseIdCell(
	raw: string,
	idType: 'integer' | 'string' = 'integer'
): { id?: string | number; error?: string } {
	const trimmed = raw.trim();
	if (trimmed === '') return {};
	if (idType === 'string') return { id: trimmed };
	const num = Number(trimmed);
	if (!Number.isFinite(num) || !Number.isInteger(num)) {
		return { error: m['resource.importIdInvalid']() };
	}
	return { id: num };
}

/**
 * Parse `text` (a selected CSV file's contents) into the preview the user
 * confirms before anything is sent. `null` when the file has no rows at all.
 * `columns` is the list's base column set (`resourceColumns`, without
 * permission narrowing): `editable` there marks a writable schema field.
 */
export function buildImportPreview(
	definition: Pick<AppResourceDefinition, 'schema'>,
	options: Pick<ResourceCsvImport, 'required' | 'idType'>,
	columns: GridColumn<ResourceRow>[],
	fileName: string,
	text: string
): ImportPreviewState | null {
	const parsed = parseCsv(text);
	if (parsed.length === 0) return null;
	const [header, ...dataRows] = parsed;
	const csvColumns = columns.filter((column) => column.id !== 'open');
	// mapCsvHeader sees the FULL set, so a header naming `id` or a read-only
	// column is recognized, never misreported as an ignored column.
	const { mapped, unknown } = mapCsvHeader<ResourceRow>(header, csvColumns);

	const missingRequired = requiredImportFields(definition, options).filter(
		(field) => !mapped.some((entry) => entry.column.id === field)
	);

	const idMapping = mapped.find((entry) => entry.column.id === 'id');
	const valueMapping = mapped.filter((entry) => entry.column.id !== 'id' && entry.column.editable);
	const convertMessages = {
		convertError: (column: string, value: string) =>
			m['resource.importConvertError']({ column, value })
	};

	const rows: ImportRowPreview[] =
		missingRequired.length > 0
			? []
			: dataRows.map((cells, index) => {
					const { values, errors } = convertCsvRow<ResourceRow>(
						cells,
						valueMapping,
						convertMessages
					);
					const rowErrors = errors.map((e) => ({ columnId: e.columnId, message: e.message }));
					let id: string | number | undefined;
					if (idMapping) {
						const result = parseIdCell(cells[idMapping.index] ?? '', options.idType);
						if (result.error) rowErrors.push({ columnId: 'id', message: result.error });
						id = result.id;
					}
					return { csvLine: index + 2, id, values, errors: rowErrors };
				});

	return {
		fileName,
		ignoredHeaders: unknown,
		missingRequired,
		writtenFields: valueMapping.map((entry) => entry.column.id),
		rows,
		serverErrors: null,
		applied: null
	};
}

/** id あり = 既存レコードの更新、なし = 新規作成（spec M15）。 */
export function importRowKind(row: Pick<ImportRowPreview, 'id'>): 'create' | 'update' {
	return row.id === undefined ? 'create' : 'update';
}

/** 確認表に描画する先頭 `limit` 行。 */
export function previewRows(
	rows: ImportRowPreview[],
	limit: number = IMPORT_PREVIEW_ROW_LIMIT
): ImportRowPreview[] {
	return rows.slice(0, limit);
}

/** サーバーへ送る行（`csv.import.run` の引数）。プレビューと同じ `rows` から作る。 */
export function toImportPayload(rows: ImportRowPreview[]): ResourceImportRow[] {
	return rows.map((row) => ({ id: row.id, ...row.values }));
}

/** Can the previewed rows be sent? Never with a fatal header, a row error, or after a partial apply. */
export function canRunImport(preview: ImportPreviewState): boolean {
	return (
		preview.missingRequired.length === 0 &&
		!preview.rows.some((row) => row.errors.length > 0) &&
		preview.applied === null
	);
}

/** The preview after `run` returned: errors are kept on the panel, a partial apply is remembered. */
export function withImportResult(
	preview: ImportPreviewState,
	result: ResourceImportResult
): ImportPreviewState {
	const appliedCount = result.created + result.updated;
	return {
		...preview,
		serverErrors: result.errors,
		applied: appliedCount > 0 ? { created: result.created, updated: result.updated } : null
	};
}

/** The panel's success / warning / danger tint (design.md §Phase 4 CSV result panel). */
export function importStatusVariant(preview: ImportPreviewState): StatusBadgeVariant {
	if (preview.missingRequired.length > 0) return 'danger';
	if (preview.serverErrors && preview.serverErrors.length > 0) return 'danger';
	if (preview.rows.some((row) => row.errors.length > 0)) return 'warning';
	return 'success';
}
