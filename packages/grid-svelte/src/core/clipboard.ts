/**
 * Pure TSV clipboard helpers for Excel-like range copy/paste (spec §4.5).
 * No Svelte imports — usable standalone and easy to unit test.
 */
import type { CellEditorType, CellRange, GridColumn } from '../types';

/**
 * Build a TSV string for `range` from `rows`/`orderedColumns`. Copies the
 * RAW value via `getValue` (typically `getColumnValue`), never
 * `column.format`: formatted display strings (e.g. "¥1,200", localized
 * dates) are lossy to re-parse, and would break paste round-trip fidelity
 * (copy a cell, paste it back into the same or another compatible column).
 */
export function rangeToTsv<TRow>(
	rows: TRow[],
	orderedColumns: GridColumn<TRow>[],
	range: CellRange,
	getValue: (row: TRow, column: GridColumn<TRow>) => unknown
): string {
	const lines: string[] = [];
	for (let r = range.rowStart; r <= range.rowEnd; r++) {
		const row = rows[r];
		const cells: string[] = [];
		for (let f = range.fieldStart; f <= range.fieldEnd; f++) {
			const column = orderedColumns[f];
			if (!row || !column) {
				cells.push('');
				continue;
			}
			const raw = getValue(row, column);
			cells.push(raw === null || raw === undefined ? '' : String(raw));
		}
		lines.push(cells.join('\t'));
	}
	return lines.join('\n');
}

/**
 * Parse pasted TSV text into a 2D string array (rows of cells). Handles
 * `\r\n`/`\r` line endings and a trailing newline. Known limitation (v1): no
 * quoted-cell handling (a tab or newline embedded in a quoted field, as in
 * RFC 4180-style CSV/TSV) — copying a plain grid cell value never produces
 * one, so this is deferred until a real need for it appears.
 */
export function parseTsv(text: string): string[][] {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
	if (trimmed === '') return [[]];
	return trimmed.split('\n').map((line) => line.split('\t'));
}

/**
 * Parse one pasted/typed cell's raw text for `editor`. `number` rejects
 * empty strings and non-numeric input (NaN); `checkbox` accepts
 * 'true'/'false'/'1'/'0' only; 'date'/'text'/'select' pass the string
 * through unchanged (select's option-value typing is reconciled by the
 * caller against `column.editorOptions`).
 */
export function parseCellInput(
	raw: string,
	editor: CellEditorType
): { ok: true; value: unknown } | { ok: false } {
	if (editor === 'number') {
		if (raw.trim() === '') return { ok: false };
		const num = Number(raw);
		if (Number.isNaN(num)) return { ok: false };
		return { ok: true, value: num };
	}
	if (editor === 'checkbox') {
		if (raw === 'true' || raw === '1') return { ok: true, value: true };
		if (raw === 'false' || raw === '0') return { ok: true, value: false };
		return { ok: false };
	}
	return { ok: true, value: raw };
}
