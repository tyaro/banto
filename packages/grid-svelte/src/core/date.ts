/**
 * Dates for grid cells (date-time-pickers §5.1 / §5.3 / §5.10): the canonical
 * `YYYY-MM-DD` check and the lenient parse of typed, pasted and imported
 * text, used by `parseCellInput` (cell commit, paste, CSV import) and the
 * schema column validator (`fieldValidator`).
 *
 * A copy of `@banto/ui`'s `datetime.ts` `isIsoDate` / `parseDateText` (and
 * of `@banto/forms`' `date.ts`) - grid cannot import either (conventions §4,
 * shared-primitives-upstream-plan §2.1) - kept in lockstep by
 * `tests/date.test.ts`, which runs the same cases through ui's copy. Change
 * the three together.
 *
 * - Canonical: `YYYY-MM-DD`, years 0001-9999, a real calendar day. String
 *   order = date order, so `min` / `max` are plain string comparisons.
 * - Lenient (D7): year-month-day with `-` `/` `.` or no separator, one-digit
 *   month / day, full-width digits and signs through NFKC. Other orders are
 *   refused. The year-less `M/D` / `M-D` (current year) is for typed text
 *   only: {@link parseCellDate} refuses it for paste and CSV import (§5.10,
 *   "this year" is ambiguous for imported data).
 */

const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidParts(year: number, month: number, day: number): boolean {
	return (
		Number.isInteger(year) &&
		Number.isInteger(month) &&
		Number.isInteger(day) &&
		year >= MIN_YEAR &&
		year <= MAX_YEAR &&
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth(year, month)
	);
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEARLESS_DATE = /^(\d{1,2})([-/])(\d{1,2})$/;

/** Is `value` a canonical `YYYY-MM-DD` real calendar day? Strict: no lenient forms. */
export function isIsoDate(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = CANONICAL_DATE.exec(value);
	return !!match && isValidParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Typed text -> canonical `YYYY-MM-DD`, or `null` when it is not a date
 * (blank text is also `null`; callers check blank first). `currentYear` fills
 * the year of `M/D` / `M-D` (defaults to the local current year).
 */
export function parseDateText(text: string, currentYear?: number): string | null {
	const s = text.normalize('NFKC').trim();
	let match = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(s);
	let parts: [number, number, number] | null = null;
	if (match) {
		parts = [Number(match[1]), Number(match[3]), Number(match[4])];
	} else if ((match = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
		parts = [Number(match[1]), Number(match[2]), Number(match[3])];
	} else if ((match = YEARLESS_DATE.exec(s))) {
		const year = currentYear ?? new Date().getFullYear();
		parts = [year, Number(match[1]), Number(match[3])];
	}
	if (!parts || !isValidParts(...parts)) return null;
	return `${pad(parts[0], 4)}-${pad(parts[1], 2)}-${pad(parts[2], 2)}`;
}

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
