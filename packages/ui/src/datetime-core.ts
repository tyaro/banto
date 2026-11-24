/**
 * The date / time text rules shared by `@banto/ui`, `@banto/forms` and
 * `@banto/grid-svelte` (date-time-pickers §5.1 / §5.3 / §5.6): the canonical
 * `YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm` checks, the lenient parse of
 * typed text and the time step. Pure functions, no Svelte, no imports.
 *
 * ONE source, three files (Issue #811). Packages cannot import each other
 * (conventions §4), so `packages/ui/src/datetime-core.ts` is the original and
 * `scripts/sync-datetime-core.mjs` copies it to
 * `packages/forms/src/datetime-core.ts` and
 * `packages/grid-svelte/src/core/datetime-core.ts` under a "generated" banner.
 * Edit the ui file only, then run `pnpm sync:datetime-core`; CI fails when a
 * copy differs (`pnpm check:datetime-core`). Each package re-exports what it
 * needs through its own module (`datetime.ts` / `date.ts` / `core/date.ts`)
 * and adds what only it needs there, so keep this file free of anything one
 * package alone uses.
 *
 * - Canonical date: `YYYY-MM-DD`, years 0001-9999, a real calendar day, a wall
 *   date with no time zone. Fixed width, so string order = date order (`min`
 *   / `max` are plain string comparisons); nothing goes through `Date.parse`.
 * - Lenient (typed text only, D7): year-month-day with `-` `/` `.` or no
 *   separator, one-digit month / day, `M/D` / `M-D` for the current year,
 *   full-width digits and signs through NFKC. Other orders (`MM/DD/YYYY`) are
 *   refused - their meaning depends on the locale.
 * - Times: canonical `HH:mm` (00:00-23:59, 24-hour, no seconds); typed `H:mm`,
 *   `HHmm`, `Hmm`, `H`. A date and time is canonical `YYYY-MM-DDTHH:mm` (a
 *   wall-clock time, D4), typed as a date, a space or `T`, and a time; it is
 *   shown with a space (`2026-11-07 09:30`).
 * - The same rules are in Rust (`banto_core::datetime`), checked against the
 *   shared table `crates/banto-core/tests/datetime-cases.json`.
 */

export interface DateParts {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
}

export interface TimeParts {
	hour: number; // 0-23
	minute: number; // 0-59
}

export interface DateTimeParts {
	/** Canonical `YYYY-MM-DD`. */
	date: string;
	/** Canonical `HH:mm`. */
	time: string;
}

export const MIN_YEAR = 1;
export const MAX_YEAR = 9999;

export function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1-12) of `year`. */
export function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
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

export const pad = (n: number, width: number) => String(n).padStart(width, '0');

// --- Dates ------------------------------------------------------------------

/** `YYYY-MM-DD` from parts (no validation - pass valid parts). */
export function formatDate(parts: DateParts): string {
	return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parts of a canonical `YYYY-MM-DD` that is a real calendar day, else `null`. Strict: no lenient forms. */
export function parseIsoDate(value: string): DateParts | null {
	const match = CANONICAL_DATE.exec(value);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	return isValidDateParts(year, month, day) ? { year, month, day } : null;
}

/** Is `value` a canonical `YYYY-MM-DD` real calendar day? Strict: no lenient forms. */
export function isIsoDate(value: unknown): value is string {
	return typeof value === 'string' && parseIsoDate(value) !== null;
}

/** The year-less `M/D` / `M-D` (after NFKC and trim): the year is filled in from "now". */
export const YEARLESS_DATE = /^(\d{1,2})([-/])(\d{1,2})$/;

/**
 * Typed text -> canonical `YYYY-MM-DD`, or `null` when it is not a date
 * (blank text is also `null`; callers check blank first to tell "empty" from
 * "invalid"). `currentYear` fills the year of `M/D` / `M-D` (defaults to the
 * local current year).
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
	if (!parts || !isValidDateParts(...parts)) return null;
	return formatDate({ year: parts[0], month: parts[1], day: parts[2] });
}

// --- Times ------------------------------------------------------------------

function isValidTimeParts(hour: number, minute: number): boolean {
	return (
		Number.isInteger(hour) &&
		Number.isInteger(minute) &&
		hour >= 0 &&
		hour <= 23 &&
		minute >= 0 &&
		minute <= 59
	);
}

/** `HH:mm` from parts (no validation - pass valid parts). */
export function formatTime(parts: TimeParts): string {
	return `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}`;
}

const CANONICAL_TIME = /^(\d{2}):(\d{2})$/;

/** Parts of a canonical `HH:mm` (00:00-23:59), else `null`. Strict: no lenient forms. */
export function parseIsoTime(value: string): TimeParts | null {
	const match = CANONICAL_TIME.exec(value);
	if (!match) return null;
	const [hour, minute] = [Number(match[1]), Number(match[2])];
	return isValidTimeParts(hour, minute) ? { hour, minute } : null;
}

/** Is `value` a canonical `HH:mm` (00:00-23:59)? Strict: no lenient forms. */
export function isIsoTime(value: unknown): value is string {
	return typeof value === 'string' && parseIsoTime(value) !== null;
}

/**
 * Typed text -> canonical `HH:mm`, or `null` when it is not a time (blank
 * text is also `null`). Accepted (§5.3): `H:mm` / `HH:mm`, `HHmm`, `Hmm`, and
 * `H` / `HH` alone (`9` -> `09:00`); full-width digits and `：` through NFKC.
 * 24-hour only: no `AM` / `PM`, no `24:00`, no seconds.
 */
export function parseTimeText(text: string): string | null {
	const s = text.normalize('NFKC').trim();
	const match =
		/^(\d{1,2}):(\d{2})$/.exec(s) ?? /^(\d{1,2})(\d{2})$/.exec(s) ?? /^(\d{1,2})()$/.exec(s);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = match[2] === '' ? 0 : Number(match[2]);
	return isValidTimeParts(hour, minute) ? formatTime({ hour, minute }) : null;
}

// --- Date and time ----------------------------------------------------------

const CANONICAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/** Date and time of a canonical `YYYY-MM-DDTHH:mm` (a real day, 00:00-23:59), else `null`. Strict. */
export function parseIsoDateTime(value: string): DateTimeParts | null {
	const match = CANONICAL_DATETIME.exec(value);
	if (!match || !isIsoDate(match[1]) || !isIsoTime(match[2])) return null;
	return { date: match[1], time: match[2] };
}

/** Is `value` a canonical `YYYY-MM-DDTHH:mm` (a real day, 00:00-23:59)? Strict. */
export function isIsoDateTime(value: unknown): value is string {
	return typeof value === 'string' && parseIsoDateTime(value) !== null;
}

/** A canonical date and time shown with a space (`2026-11-07 09:30`, §5.3); anything else unchanged. */
export function formatDateTimeText(value: string): string {
	const parts = parseIsoDateTime(value);
	return parts ? `${parts.date} ${parts.time}` : value;
}

/** A date part, then `T` or white space, then a time part (after NFKC, so a full-width space is a space). */
export const DATETIME_TEXT = /^([^\sT]+)(?:T|\s+)([^\sT]+)$/;

/**
 * Typed text -> canonical `YYYY-MM-DDTHH:mm`, or `null` when it is not a date
 * and time (blank text is also `null`). Accepted (§5.3): a date as
 * {@link parseDateText} reads it, then a space or `T`, then a time as
 * {@link parseTimeText} reads it (`2026/11/7 9:30`, `20261107 0930`, `11/7 9`
 * for this year, full-width). Both parts are required; seconds are refused
 * like {@link parseTimeText} does. `currentYear` fills the year of `M/D`.
 */
export function parseDateTimeText(text: string, currentYear?: number): string | null {
	const match = DATETIME_TEXT.exec(text.normalize('NFKC').trim());
	if (!match) return null;
	const date = parseDateText(match[1], currentYear);
	const time = parseTimeText(match[2]);
	return date !== null && time !== null ? `${date}T${time}` : null;
}

// --- Time step (D8) -----------------------------------------------------------

/** `step` as minutes (a positive integer), else `undefined` (not given / invalid: no step check, D8). */
export function normalizeTimeStep(step: number | null | undefined): number | undefined {
	return typeof step === 'number' && Number.isInteger(step) && step > 0 ? step : undefined;
}

/**
 * Is `time` on the `step` grid counted from 00:00 (D8)? No (valid) step: true.
 * A `time` that is not a canonical `HH:mm` (shape or range, e.g. `24:00`) is
 * off the grid (`false`); it never throws. With no step, though, anything
 * passes - callers check {@link isIsoTime} first.
 */
export function isOnTimeStep(time: string, step?: number): boolean {
	const by = normalizeTimeStep(step);
	if (by === undefined) return true;
	const parts = parseIsoTime(time);
	if (!parts) return false;
	return (parts.hour * 60 + parts.minute) % by === 0;
}

/**
 * The `step` attribute (seconds) for the native `time` / `datetime-local`
 * fallback (D3-a), or `undefined` to leave it off. A native input counts its
 * step from `min` (or, for `datetime-local` without one, from 1970-01-01T00:00),
 * while the validator counts it from each day's 00:00 (D8). They agree only
 * when the base is on the step grid - `min` absent or on it, and for a date
 * and time the step dividing the day - so otherwise no native step is given
 * (the validator still checks the step; the input simply offers every minute).
 */
export function nativeTimeStep(
	type: 'time' | 'datetime',
	step: number | undefined,
	min: string | undefined
): number | undefined {
	const by = normalizeTimeStep(step);
	if (by === undefined) return undefined;
	if (type === 'datetime' && (24 * 60) % by !== 0) return undefined;
	if (min !== undefined) {
		const time = type === 'datetime' ? (isIsoDateTime(min) ? min.slice(11) : null) : min;
		if (time === null || !isOnTimeStep(time, by)) return undefined;
	}
	return by * 60;
}
