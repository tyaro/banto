/**
 * Built-in cell presentation (#713): resolves a column's `renderer` / `tone`
 * and a row's value into a plain display model. Pure - BantoGrid.svelte only
 * draws the result, so the decisions (what is a ratio, which href is safe,
 * which tone applies) are unit-tested without a DOM (spec §4.1; the same
 * core/render split as `core/edit.ts`).
 *
 * Precedence between the ways a cell can be drawn is decided in
 * BantoGrid: `render` (snippet) > `cell` > inline editor > `renderer` > plain
 * text. This module only knows about `renderer` and `tone`.
 */
import type { CellTone, GridColumn } from '../types';
import { getColumnValue } from './sort';

export const CELL_TONES: readonly CellTone[] = ['success', 'warning', 'danger', 'info', 'neutral'];

export type CellView =
	| { kind: 'text'; text: string }
	| { kind: 'badge'; text: string }
	| {
			kind: 'progress';
			/** 0..1, clamped. */
			ratio: number;
			/** Visible label next to the bar (also the progressbar's `aria-valuetext`). */
			text: string;
	  }
	| { kind: 'boolean'; checked: boolean }
	| { kind: 'link'; text: string; href: string };

/** Display text: `format` when given, else the value as a string ('' for null / undefined). */
export function cellText<TRow>(column: GridColumn<TRow>, row: TRow): string {
	const raw = getColumnValue(row, column);
	if (column.format) return column.format(raw, row);
	if (raw === null || raw === undefined) return '';
	return String(raw);
}

/**
 * The tone of a cell: `column.tone(value, row)` limited to the known set.
 * Anything else (null, undefined, an unknown string from untyped callers)
 * means "no tone".
 */
export function resolveTone<TRow>(column: GridColumn<TRow>, row: TRow): CellTone | null {
	if (!column.tone) return null;
	const tone = column.tone(getColumnValue(row, column), row);
	return tone !== null && CELL_TONES.includes(tone) ? tone : null;
}

/**
 * Only http(s), mailto, tel and relative references become links. A
 * `javascript:` / `data:` href from row data would otherwise run on click.
 * Returns null for an empty or unsafe href.
 */
export function safeHref(href: string | null | undefined): string | null {
	if (typeof href !== 'string') return null;
	const trimmed = href.trim();
	if (trimmed === '') return null;
	// Browsers drop tabs / newlines inside a scheme ("java\tscript:").
	// eslint-disable-next-line no-control-regex
	const probe = trimmed.replace(/[\u0000- ]/g, '');
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
	if (!scheme) return trimmed;
	return ['http', 'https', 'mailto', 'tel'].includes(scheme[1].toLowerCase()) ? trimmed : null;
}

/** Number from a numeric value or numeric string; null when it is neither. */
function toNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * Resolve how a cell is drawn. Falls back to `{ kind: 'text' }` whenever the
 * value cannot be drawn the requested way (a non-numeric progress value, a
 * link without a safe href, a boolean column holding null) so a bad row
 * degrades to its text instead of a broken widget.
 */
export function resolveCellView<TRow>(column: GridColumn<TRow>, row: TRow): CellView {
	const text = cellText(column, row);
	const raw = getColumnValue(row, column);
	switch (column.renderer) {
		case 'badge':
			return text === '' ? { kind: 'text', text } : { kind: 'badge', text };
		case 'progress': {
			const n = toNumber(raw);
			if (n === null) return { kind: 'text', text };
			const max =
				column.progressMax !== undefined && column.progressMax > 0 ? column.progressMax : 1;
			const ratio = Math.min(1, Math.max(0, n / max));
			return {
				kind: 'progress',
				ratio,
				text: column.format ? text : `${Math.round(ratio * 100)}%`
			};
		}
		case 'boolean':
			if (typeof raw !== 'boolean') return { kind: 'text', text };
			return { kind: 'boolean', checked: raw };
		case 'link': {
			const href = column.href ? safeHref(column.href(row)) : null;
			return href
				? { kind: 'link', text: text === '' ? href : text, href }
				: { kind: 'text', text };
		}
		default:
			return { kind: 'text', text };
	}
}
