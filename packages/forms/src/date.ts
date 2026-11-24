/**
 * Dates and times for schema forms (date-time-pickers §5.1 / §5.3 / §5.6):
 * the canonical `YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm` checks, the
 * lenient parse of typed text and the time step, used by `validateField`
 * (the format / step checks) and `FormDraft.commit` (the normalisation of
 * raw text).
 *
 * The rules themselves are `datetime-core.ts`: a generated copy of
 * `@banto/ui`'s file of the same name (forms cannot import ui, conventions
 * §4), written by `scripts/sync-datetime-core.mjs` and checked in CI (Issue
 * #811). Do not edit the copy - edit ui's, then `pnpm sync:datetime-core`.
 * This module is what the rest of forms imports: the part of the core forms
 * uses.
 */
export {
	formatDateTimeText,
	isIsoDate,
	isIsoDateTime,
	isIsoTime,
	isOnTimeStep,
	nativeTimeStep,
	normalizeTimeStep,
	parseDateText,
	parseDateTimeText,
	parseTimeText
} from './datetime-core';
