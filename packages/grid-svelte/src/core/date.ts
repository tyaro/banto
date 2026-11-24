/**
 * Dates and times for grid cells (date-time-pickers §5.1 / §5.3 / §5.6 /
 * §5.10): the canonical `YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm` checks,
 * the lenient parse of typed, pasted and imported text and the time step,
 * used by `parseCellInput` (cell commit, paste, CSV import) and the schema
 * column validator (`fieldValidator`).
 *
 * The rules themselves are `datetime-core.ts`: a generated copy of
 * `@banto/ui`'s file of the same name (grid cannot import ui, conventions
 * §4), written by `scripts/sync-datetime-core.mjs` and checked in CI (Issue
 * #811). Do not edit the copy - edit ui's, then `pnpm sync:datetime-core`.
 * This module is what the rest of grid imports: the part of the core grid
 * uses, plus the two cell parsers only grid needs.
 *
 * The year-less `M/D` / `M-D` (current year) is for typed text only:
 * {@link parseCellDate} refuses it for paste and CSV import (§5.10, "this
 * year" is ambiguous for imported data).
 */
import { DATETIME_TEXT, YEARLESS_DATE, parseDateText, parseDateTimeText } from './datetime-core';

export {
	daysInMonth,
	formatDateTimeText,
	isIsoDate,
	isIsoDateTime,
	isIsoTime,
	isOnTimeStep,
	nativeTimeStep,
	normalizeTimeStep,
	pad,
	parseDateText,
	parseDateTimeText,
	parseTimeText
} from './datetime-core';

/**
 * A cell's text -> canonical `YYYY-MM-DD`, or `null` when it is not a date.
 * Pasted and imported text (`typed` false) never fills in "this year": the
 * year-less form is refused (§5.10). Typed text (`typed` true, the editor's
 * commit) takes it like the injected input does - Tab commits the draft
 * before the input's own blur would have normalised it.
 */
export function parseCellDate(text: string, typed = false): string | null {
	if (!typed && YEARLESS_DATE.test(text.normalize('NFKC').trim())) return null;
	return parseDateText(text);
}

/**
 * A cell's text -> canonical `YYYY-MM-DDTHH:mm`, or `null`. Like
 * {@link parseCellDate}, a year-less date part (`11/7 9:30`) is taken only
 * when `typed` (paste and CSV import never guess the year, §5.10).
 */
export function parseCellDateTime(text: string, typed = false): string | null {
	if (!typed) {
		const match = DATETIME_TEXT.exec(text.normalize('NFKC').trim());
		if (match && YEARLESS_DATE.test(match[1])) return null;
	}
	return parseDateTimeText(text);
}
