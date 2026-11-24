/**
 * Dates for the pickers (date-time-pickers §5.1 / §5.3 / §5.5): parsing,
 * the calendar arithmetic, the month grid and the `Intl` names. Pure
 * functions, no Svelte - the main unit-test target.
 *
 * The text rules (the canonical checks, the lenient parse, the formats) are
 * `datetime-core.ts`, the one source also copied to forms and grid (Issue
 * #811); this module re-exports them and adds what only the pickers need.
 *
 * - A date is the canonical string `YYYY-MM-DD` (years 0001-9999), a wall
 *   date with no time zone. Fixed width, so string order = date order;
 *   nothing here goes through `Date.parse` (§2.2's UTC / local mix-up).
 * - The arithmetic is integer days since 1970-01-01 (Howard Hinnant's
 *   `days_from_civil` / `civil_from_days`) - no `Date`, so no time zone and
 *   no two-digit-year quirks. `Date` is used only to hand a day to `Intl`,
 *   always at UTC noon with `timeZone: 'UTC'`.
 * - Lenient parsing is for typed input only (D7): year-month-day order with
 *   `-` `/` `.` or no separator, one-digit month / day, `M/D` / `M-D` for the
 *   current year, full-width digits and signs through NFKC. Other orders
 *   (`MM/DD/YYYY`) are refused - their meaning depends on the locale - and
 *   display is always ISO.
 * - Names come from `Intl.DateTimeFormat(locale)`; there is no locale branch
 *   here (conventions §13) - the caller passes the BCP 47 tag.
 */

import * as core from './datetime-core';
import {
	MAX_YEAR,
	MIN_YEAR,
	daysInMonth,
	formatDate,
	formatTime,
	normalizeTimeStep,
	parseIsoDate,
	parseIsoTime,
	type DateParts
} from './datetime-core';

// The parse / format rules shared with forms and grid live in
// `datetime-core.ts` (the one source, Issue #811). The three `isIso*` and
// `formatDateTimeText` below are thin wrappers that keep this package's
// signatures (`string` in, `boolean` out - no type guard; `null` -> `''`).
export {
	daysInMonth,
	formatDate,
	formatTime,
	isLeapYear,
	normalizeTimeStep,
	parseDateText,
	parseDateTimeText,
	parseIsoDate,
	parseIsoDateTime,
	parseIsoTime,
	parseTimeText,
	type DateParts,
	type DateTimeParts,
	type TimeParts
} from './datetime-core';

/** Weekday index: 0 = Sunday ... 6 = Saturday (the `Date#getDay` numbering). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Is `value` a canonical `YYYY-MM-DD` real calendar day? */
export function isIsoDate(value: string): boolean {
	return core.isIsoDate(value);
}

/** Empty for the pickers: `null`, `undefined`, `''` or only white space (D6). */
export function isBlankDateText(text: string | null | undefined): boolean {
	return text == null || text.trim() === '';
}

// --- Day numbers (Howard Hinnant, http://howardhinnant.github.io/date_algorithms.html) ---

/** Days since 1970-01-01 of a proleptic Gregorian date. */
export function daysFromCivil({ year, month, day }: DateParts): number {
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const mp = (month + 9) % 12; // March = 0
	const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

/** Inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): DateParts {
	const z = days + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
	);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp < 10 ? mp + 3 : mp - 9;
	return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function requireDate(value: string): DateParts {
	const parts = parseIsoDate(value);
	if (!parts) throw new RangeError(`not a YYYY-MM-DD date: ${value}`);
	return parts;
}

const FIRST_DAY = daysFromCivil({ year: MIN_YEAR, month: 1, day: 1 });
const LAST_DAY = daysFromCivil({ year: MAX_YEAR, month: 12, day: 31 });

function fromDays(days: number): string {
	return formatDate(civilFromDays(Math.min(Math.max(days, FIRST_DAY), LAST_DAY)));
}

/** `date` + `n` days (clamped to 0001-01-01..9999-12-31). */
export function addDays(date: string, n: number): string {
	return fromDays(daysFromCivil(requireDate(date)) + n);
}

/** `date` + `n` months; the day is clamped to the target month's length (01-31 + 1 month = 02-28/29). */
export function addMonths(date: string, n: number): string {
	const { year, month, day } = requireDate(date);
	const index = year * 12 + (month - 1) + n;
	const targetYear = Math.floor(index / 12);
	if (targetYear < MIN_YEAR) return formatDate({ year: MIN_YEAR, month: 1, day: 1 });
	if (targetYear > MAX_YEAR) return formatDate({ year: MAX_YEAR, month: 12, day: 31 });
	const targetMonth = (index % 12) + 1;
	return formatDate({
		year: targetYear,
		month: targetMonth,
		day: Math.min(day, daysInMonth(targetYear, targetMonth))
	});
}

/** `date` + `n` years (02-29 -> 02-28 in a common year). */
export function addYears(date: string, n: number): string {
	return addMonths(date, n * 12);
}

/** Weekday of `date` (0 = Sunday). */
export function dayOfWeek(date: string): Weekday {
	// 1970-01-01 was a Thursday (4).
	const days = daysFromCivil(requireDate(date));
	return ((((days + 4) % 7) + 7) % 7) as Weekday;
}

/** The first day of `date`'s week, the week starting on `weekStartsOn`. */
export function startOfWeek(date: string, weekStartsOn: Weekday): string {
	const offset = (dayOfWeek(date) - weekStartsOn + 7) % 7;
	return addDays(date, -offset);
}

/** The last day of `date`'s week. */
export function endOfWeek(date: string, weekStartsOn: Weekday): string {
	return addDays(startOfWeek(date, weekStartsOn), 6);
}

/** `YYYY-MM-01` of `date`'s month. */
export function startOfMonth(date: string): string {
	const { year, month } = requireDate(date);
	return formatDate({ year, month, day: 1 });
}

/** Same year and month? */
export function isSameMonth(a: string, b: string): boolean {
	return a.slice(0, 7) === b.slice(0, 7);
}

/** Is `date` outside `[min, max]` (each bound optional, inclusive)? Plain string comparison (§5.1). */
export function isOutOfRange(date: string, min?: string | null, max?: string | null): boolean {
	return (!!min && date < min) || (!!max && date > max);
}

/** `date` moved into `[min, max]`. */
export function clampDate(date: string, min?: string | null, max?: string | null): string {
	if (min && date < min) return min;
	if (max && date > max) return max;
	return date;
}

/**
 * The month grid shown by the calendar: 6 weeks x 7 days of canonical dates,
 * starting on the `weekStartsOn` day on or before the 1st of the month of
 * `date` (so the leading / trailing days of the neighbouring months fill the
 * rows). Always 6 rows - the popover does not change height between months.
 * Positions before 0001-01-01 or after 9999-12-31 are `null` (empty slots):
 * clamping them would put 0001-01-01 under the wrong weekday or repeat
 * 9999-12-31.
 */
export function monthGrid(date: string, weekStartsOn: Weekday): (string | null)[][] {
	const first = daysFromCivil(requireDate(startOfMonth(date)));
	const offset = (((((first + 4) % 7) + 7) % 7) - weekStartsOn + 7) % 7;
	const start = first - offset;
	const weeks: (string | null)[][] = [];
	for (let w = 0; w < 6; w++) {
		const week: (string | null)[] = [];
		for (let d = 0; d < 7; d++) {
			const day = start + w * 7 + d;
			week.push(day < FIRST_DAY || day > LAST_DAY ? null : formatDate(civilFromDays(day)));
		}
		weeks.push(week);
	}
	return weeks;
}

/** The local time of day now as `HH:mm` (the device clock; where an empty time list starts, §5.4). */
export function currentTime(now: Date = new Date()): string {
	return minutesToTime(now.getHours() * 60 + now.getMinutes());
}

/** Today's local calendar date (the device clock, like the native date input). */
export function todayDate(now: Date = new Date()): string {
	return formatDate({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

// --- Intl -----------------------------------------------------------------

interface WeekInfoLocale {
	getWeekInfo?: () => { firstDay?: number };
	weekInfo?: { firstDay?: number };
}

/**
 * The first day of the week (D15): `explicit` if given, else the locale's
 * (`Intl.Locale#getWeekInfo()`, or the older `weekInfo` getter; `firstDay`
 * is 1 = Monday ... 7 = Sunday), else Sunday where neither exists.
 */
export function resolveWeekStart(locale: string, explicit?: number): Weekday {
	if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0 && explicit <= 6) {
		return explicit as Weekday;
	}
	try {
		const loc = new Intl.Locale(locale) as unknown as WeekInfoLocale;
		const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
		const firstDay = info?.firstDay;
		if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) {
			return (firstDay % 7) as Weekday;
		}
	} catch {
		// An invalid tag or no Intl.Locale: fall through.
	}
	return 0;
}

/** A `Date` for `Intl` only: UTC noon of the day (years below 100 included). */
function utcDate(parts: DateParts): Date {
	const d = new Date(Date.UTC(2000, 0, 1, 12));
	d.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	return d;
}

// Always the Gregorian calendar: the grid, the values and the parser are
// Gregorian, so a locale whose default calendar differs (`fa-IR` Persian,
// `ja-JP-u-ca-japanese`, `th-TH` Buddhist) must not label the same day as
// another calendar's month / year in the heading and the spoken name.
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const fixed: Intl.DateTimeFormatOptions = { ...options, calendar: 'gregory', timeZone: 'UTC' };
	try {
		return new Intl.DateTimeFormat(locale, fixed);
	} catch {
		return new Intl.DateTimeFormat(undefined, fixed);
	}
}

/** Long date for screen readers and the button name: `dateStyle: 'full'` ("2026年11月7日土曜日"). */
export function formatFullDate(date: string, locale: string): string {
	return formatter(locale, { dateStyle: 'full' }).format(utcDate(requireDate(date)));
}

/** The calendar heading: year and month ("2026年11月", "November 2026"). */
export function formatMonthYear(date: string, locale: string): string {
	return formatter(locale, { year: 'numeric', month: 'long' }).format(utcDate(requireDate(date)));
}

/** Weekday column headers in display order from `weekStartsOn`: short (shown) and long (`abbr`). */
export function weekdayNames(
	locale: string,
	weekStartsOn: Weekday
): { weekday: Weekday; short: string; long: string }[] {
	const short = formatter(locale, { weekday: 'short' });
	const long = formatter(locale, { weekday: 'long' });
	// 2023-01-01 was a Sunday.
	return Array.from({ length: 7 }, (_, i) => {
		const weekday = ((weekStartsOn + i) % 7) as Weekday;
		const date = utcDate({ year: 2023, month: 1, day: 1 + weekday });
		return { weekday, short: short.format(date), long: long.format(date) };
	});
}

// --- Times (date-time-pickers §5.1 / §5.3 / §5.6, D7 / D8) ------------------
//
// A time is the canonical string `HH:mm` (00:00-23:59, 24-hour, no seconds),
// a wall-clock time with no time zone. Fixed width, so string order = time
// order (`isOutOfRange` / `clampDate` work on it too). Display is always this
// form in every locale - no `Intl`, so neither the locale's `hourCycle`
// (`h12` "9:30 AM") nor its digits change what is shown (D7).

/** Minutes in a day: the step list ends before this (no wrap past 23:59). */
const MINUTES_PER_DAY = 24 * 60;

/** The list step when `step` is not given (D8: the list only; any minute is accepted). */
export const DEFAULT_TIME_STEP = 30;

/** Is `value` a canonical `HH:mm` (00:00-23:59)? */
export function isIsoTime(value: string): boolean {
	return core.isIsoTime(value);
}

/** Minutes since 00:00 of a canonical `HH:mm`. */
export function timeToMinutes(time: string): number {
	const parts = parseIsoTime(time);
	if (!parts) throw new RangeError(`not an HH:mm time: ${time}`);
	return parts.hour * 60 + parts.minute;
}

/** Canonical `HH:mm` of `minutes` since 00:00 (0-1439; out-of-day values throw). */
export function minutesToTime(minutes: number): string {
	if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) {
		throw new RangeError(`not a minute of the day: ${minutes}`);
	}
	return formatTime({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
}

/**
 * The times of the list: from 00:00 every `step` minutes (default
 * {@link DEFAULT_TIME_STEP}; an invalid step falls back to it), up to the
 * last one on or before 23:59 - a step that does not divide the day ends
 * early (step 25: ... 23:45, not 00:10) instead of wrapping into the next day, and a
 * step of a day or more leaves 00:00 alone.
 */
export function timeOptions(step?: number): string[] {
	const by = normalizeTimeStep(step) ?? DEFAULT_TIME_STEP;
	const times: string[] = [];
	for (let m = 0; m < MINUTES_PER_DAY; m += by) times.push(minutesToTime(m));
	return times;
}

/**
 * Is `time` on the `step` grid counted from 00:00 (D8)? No (valid) step: always true.
 * Unlike the shared `datetime-core` one (the forms / grid validators), a
 * `time` that is not canonical throws - the pickers only pass canonical times.
 */
export function isOnTimeStep(time: string, step?: number): boolean {
	const by = normalizeTimeStep(step);
	return by === undefined || timeToMinutes(time) % by === 0;
}

/**
 * The candidate nearest to `time` (smallest distance in minutes; a tie goes
 * to the earlier one), or `null` when there is none. Used to point the list
 * at the value when it opens (§5.4) - the value may be off the list's step.
 */
export function nearestTime(time: string, candidates: readonly string[]): string | null {
	const target = timeToMinutes(time);
	let best: string | null = null;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const distance = Math.abs(timeToMinutes(candidate) - target);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

// --- Date and time ----------------------------------------------------------
//
// A date and time is the canonical string `YYYY-MM-DDTHH:mm` (§5.1, D4): a
// wall-clock time with no time zone and no seconds - the `datetime-local`
// value. Fixed width, so string order = time order. It is shown and typed with
// a space in place of the `T` (`2026-11-07 09:30`, §5.3); the value keeps the
// `T`.

/** Is `value` a canonical `YYYY-MM-DDTHH:mm`? */
export function isIsoDateTime(value: string): boolean {
	return core.isIsoDateTime(value);
}

/** `YYYY-MM-DDTHH:mm` from a canonical date and time (no validation). */
export function joinDateTime(date: string, time: string): string {
	return `${date}T${time}`;
}

/**
 * How a value is shown in the text box: a canonical date and time with a
 * space for the `T` (`2026-11-07 09:30`, §5.3); anything else unchanged
 * (`null` -> `''`).
 */
export function formatDateTimeText(value: string | null | undefined): string {
	return value == null ? '' : core.formatDateTimeText(value);
}
