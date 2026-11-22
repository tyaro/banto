/**
 * Pure validation functions for schema-driven forms (spec §7.2). No Svelte
 * imports — usable standalone and easy to unit test. Default messages are
 * Japanese; override via the `messages` param for i18n injection.
 */
import { formatDateTimeText, isIsoDate, isIsoDateTime, isIsoTime, isOnTimeStep } from './date';
import { fileProblem, fileValueOf, formatFileSize, newPendingFile } from './fields/file';
import { isFieldVisible } from './layout';
import type { FieldDef, FieldError, FormSchema, PendingFile } from './types';

export interface ValidationMessages {
	required?: (def: FieldDef) => string;
	min?: (def: FieldDef, min: number) => string;
	max?: (def: FieldDef, max: number) => string;
	minLength?: (def: FieldDef, min: number) => string;
	maxLength?: (def: FieldDef, max: number) => string;
	pattern?: (def: FieldDef) => string;
	/** number: the raw text is not a number (only `FormDraft.commit` parses raw text; shared-primitives-upstream-plan §3.5). */
	notANumber?: (def: FieldDef) => string;
	/** date: the value is not a canonical `YYYY-MM-DD` real day (date-time-pickers §5.3). */
	dateInvalid?: (def: FieldDef) => string;
	/** date: earlier than `min` (canonical `YYYY-MM-DD`). */
	dateMin?: (def: FieldDef, min: string) => string;
	/** date: later than `max` (canonical `YYYY-MM-DD`). */
	dateMax?: (def: FieldDef, max: string) => string;
	/** date / datetime: `isDateDisabled` refused the day. */
	dateDisabled?: (def: FieldDef, date: string) => string;
	/** time: the value is not a canonical `HH:mm` (00:00-23:59). */
	timeInvalid?: (def: FieldDef) => string;
	/** time: earlier than `min` (canonical `HH:mm`). */
	timeMin?: (def: FieldDef, min: string) => string;
	/** time: later than `max` (canonical `HH:mm`). */
	timeMax?: (def: FieldDef, max: string) => string;
	/** time / datetime: the time is off the `step` grid counted from 00:00 (`step` in minutes). */
	timeStep?: (def: FieldDef, step: number) => string;
	/** datetime: the value is not a canonical `YYYY-MM-DDTHH:mm`. */
	dateTimeInvalid?: (def: FieldDef) => string;
	/** datetime: earlier than `min`; `min` is shown as `YYYY-MM-DD HH:mm`. */
	dateTimeMin?: (def: FieldDef, min: string) => string;
	/** datetime: later than `max`; `max` is shown as `YYYY-MM-DD HH:mm`. */
	dateTimeMax?: (def: FieldDef, max: string) => string;
	/** draft: the field's `visibleWhen` never settles (showing and hiding it flip each other), so nothing is committed (#714). */
	visibilityUnsettled?: (def: FieldDef) => string;
	/** file: a file is larger than `FieldDef.file.maxFileSize` (bytes). On screen only (§4.12). */
	fileTooLarge?: (def: FieldDef, maxBytes: number) => string;
	/** file: a file's kind is not in `FieldDef.file.accept`. On screen only. */
	fileTypeNotAccepted?: (def: FieldDef, accept: string) => string;
	/** file: more files than `FieldDef.file.maxFiles`. On screen only. */
	fileTooMany?: (def: FieldDef, max: number) => string;
}

const defaultMessages: Required<ValidationMessages> = {
	required: () => '必須項目です',
	min: (_def, min) => `${min}以上で入力してください`,
	max: (_def, max) => `${max}以下で入力してください`,
	minLength: (_def, min) => `${min}文字以上で入力してください`,
	maxLength: (_def, max) => `${max}文字以内で入力してください`,
	pattern: () => '形式が正しくありません',
	notANumber: () => '数値を入力してください',
	dateInvalid: () => '日付を YYYY-MM-DD の形で入力してください',
	dateMin: (_def, min) => `${min}以降の日付を入力してください`,
	dateMax: (_def, max) => `${max}以前の日付を入力してください`,
	dateDisabled: () => 'この日付は選べません',
	timeInvalid: () => '時刻を HH:mm の形で入力してください',
	timeMin: (_def, min) => `${min}以降の時刻を入力してください`,
	timeMax: (_def, max) => `${max}以前の時刻を入力してください`,
	timeStep: (_def, step) => `${step}分刻みの時刻を入力してください`,
	dateTimeInvalid: () => '日時を YYYY-MM-DD HH:mm の形で入力してください',
	dateTimeMin: (_def, min) => `${min}以降の日時を入力してください`,
	dateTimeMax: (_def, max) => `${max}以前の日時を入力してください`,
	visibilityUnsettled: () => '表示の条件が定まらないため保存できません。値を見直してください',
	fileTooLarge: (_def, maxBytes) => `${formatFileSize(maxBytes)}以下のファイルを選んでください`,
	fileTypeNotAccepted: (_def, accept) => `この種類のファイルは選べません（${accept}）`,
	fileTooMany: (_def, max) => `ファイルは${max}件までです`
};

/**
 * Matches Rust's `input.name.trim()` semantics (items.rs's
 * `validate_item_input`): a whitespace-only string is empty. Only strings are
 * trimmed - non-string falsy values (`0`, `false`) must NOT be treated as
 * empty.
 */
function isEmpty(value: unknown): boolean {
	if (typeof value === 'string') return value.trim() === '';
	// A multiselect with nothing chosen: `required` means "at least one".
	if (Array.isArray(value)) return value.length === 0;
	return value === undefined || value === null;
}

/** Validate a single field. Returns an error message, or null when valid. */
export function validateField(
	def: FieldDef,
	value: unknown,
	values: Record<string, unknown>,
	messages: ValidationMessages = {}
): string | null {
	const msg = { ...defaultMessages, ...messages };

	// file: the value is the record's files plus the chosen ones. These checks
	// only help the input - the server does not enforce them (§4.12).
	if (def.type === 'file') {
		const { existing, pending } = fileValueOf(value);
		const count = (existing?.length ?? 0) + pending.length;
		// `existing === null`: the record's files are not known, so "none" cannot be said.
		if (def.required && existing !== null && count === 0) return msg.required(def);
		const max = def.file?.maxFiles;
		if (max !== undefined && count > max) return msg.fileTooMany(def, max);
		for (const entry of pending) {
			const problem = fileProblemMessage(def, entry.file, messages);
			if (problem) return problem;
		}
		return def.validate?.(value, values) || null;
	}

	if (def.required && isEmpty(value)) {
		return msg.required(def);
	}

	// min/max/pattern only apply to values actually present; `required`
	// above already covers the "must not be empty" case.
	if (!isEmpty(value)) {
		// Bounds are read by the field's type (D9): numbers for number / text,
		// canonical strings for date. A bound of the other kind is ignored.
		const min = def.min;
		const max = def.max;
		if (def.type === 'number') {
			const num = typeof value === 'number' ? value : Number(value);
			if (typeof min === 'number' && num < min) return msg.min(def, min);
			if (typeof max === 'number' && num > max) return msg.max(def, max);
		}

		if (def.type === 'date') {
			// The FormStore path keeps text that did not parse as the value
			// (date-time-pickers §5.3), so a stale value is never submitted
			// silently: anything but a canonical real day is an error here.
			if (!isIsoDate(value)) return msg.dateInvalid(def);
			if (typeof min === 'string' && value < min) return msg.dateMin(def, min);
			if (typeof max === 'string' && value > max) return msg.dateMax(def, max);
			if (def.isDateDisabled?.(value)) return msg.dateDisabled(def, value);
		}

		// time / datetime: the same order as date - format, bounds (string
		// order = time order), disabled day, then the step (D8; Rust's
		// `banto_core::datetime` checks the same, datetime-cases.json).
		if (def.type === 'time') {
			if (!isIsoTime(value)) return msg.timeInvalid(def);
			if (typeof min === 'string' && value < min) return msg.timeMin(def, min);
			if (typeof max === 'string' && value > max) return msg.timeMax(def, max);
			if (def.step !== undefined && !isOnTimeStep(value, def.step))
				return msg.timeStep(def, def.step);
		}

		if (def.type === 'datetime') {
			if (!isIsoDateTime(value)) return msg.dateTimeInvalid(def);
			if (typeof min === 'string' && value < min)
				return msg.dateTimeMin(def, formatDateTimeText(min));
			if (typeof max === 'string' && value > max)
				return msg.dateTimeMax(def, formatDateTimeText(max));
			const [date, time] = value.split('T');
			if (def.isDateDisabled?.(date)) return msg.dateDisabled(def, date);
			if (def.step !== undefined && !isOnTimeStep(time, def.step))
				return msg.timeStep(def, def.step);
		}

		if (def.type === 'text' || def.type === 'textarea' || def.type === 'password') {
			const str = String(value);
			// Length bounds are checked against the TRIMMED length, matching
			// Rust's `trimmed_name.chars().count() > MAX_NAME_LEN` (items.rs)
			// exactly. `pattern` still tests the raw (untrimmed) string.
			//
			// 'password' shares this branch (M10 RBAC's user-management create
			// form uses `min: 8` for its password field) - trimming a password
			// is a little odd in principle, but matches every other field's
			// semantics and a password that is only whitespace should be
			// rejected either way.
			const trimmedLen = str.trim().length;
			if (typeof min === 'number' && trimmedLen < min) return msg.minLength(def, min);
			if (typeof max === 'number' && trimmedLen > max) return msg.maxLength(def, max);
			if (def.pattern && !new RegExp(def.pattern).test(str)) return msg.pattern(def);
		}
	}

	if (def.validate) {
		const custom = def.validate(value, values);
		if (custom) return custom;
	}

	return null;
}

/**
 * Validate every field in the schema, returning one FieldError per invalid
 * field, in schema order. A field hidden by `visibleWhen` is skipped (a
 * hidden `required` field is not an error).
 */
export function validateAll(
	schema: FormSchema,
	values: Record<string, unknown>,
	messages: ValidationMessages = {}
): FieldError[] {
	const errors: FieldError[] = [];
	for (const def of schema.fields) {
		if (!isFieldVisible(def, values)) continue;
		const message = validateField(def, values[def.name], values, messages);
		if (message) errors.push({ field: def.name, message });
	}
	return errors;
}

/** file: what the field's own limits (`accept`, `maxFileSize`) say against one file, or `null`. */
export function fileProblemMessage(
	def: FieldDef,
	file: { name: string; type: string; size: number },
	messages: ValidationMessages = {}
): string | null {
	const msg = { ...defaultMessages, ...messages };
	const problem = fileProblem(def.file, file);
	if (problem === 'type') return msg.fileTypeNotAccepted(def, def.file?.accept ?? '');
	if (problem === 'size') return msg.fileTooLarge(def, def.file?.maxFileSize ?? 0);
	return null;
}

/**
 * file: sort the files a picker returned into the ones the field takes (as
 * new pending entries) and the ones it refuses, each with its reason. A file
 * of the wrong kind or size is refused; so is every file past `maxFiles`
 * (counting the record's files and the ones already chosen).
 */
export function pickFiles(
	def: FieldDef,
	value: unknown,
	files: readonly File[],
	messages: ValidationMessages = {}
): { accepted: PendingFile[]; refused: Array<{ file: File; message: string }> } {
	const msg = { ...defaultMessages, ...messages };
	const { existing, pending } = fileValueOf(value);
	const max = def.file?.maxFiles;
	let room = max === undefined ? Infinity : max - (existing?.length ?? 0) - pending.length;
	const accepted: PendingFile[] = [];
	const refused: Array<{ file: File; message: string }> = [];
	for (const file of files) {
		const problem = fileProblemMessage(def, file, messages);
		if (problem) refused.push({ file, message: problem });
		else if (room <= 0) refused.push({ file, message: msg.fileTooMany(def, max ?? 0) });
		else {
			accepted.push(newPendingFile(file));
			room -= 1;
		}
	}
	return { accepted, refused };
}

/** Message for raw date text that does not parse (used by `FormDraft.commit`). */
export function dateInvalidMessage(def: FieldDef, messages: ValidationMessages = {}): string {
	return (messages.dateInvalid ?? defaultMessages.dateInvalid)(def);
}

/** Message for raw time text that does not parse (used by `FormDraft.commit`). */
export function timeInvalidMessage(def: FieldDef, messages: ValidationMessages = {}): string {
	return (messages.timeInvalid ?? defaultMessages.timeInvalid)(def);
}

/** Message for raw date-and-time text that does not parse (used by `FormDraft.commit`). */
export function dateTimeInvalidMessage(def: FieldDef, messages: ValidationMessages = {}): string {
	return (messages.dateTimeInvalid ?? defaultMessages.dateTimeInvalid)(def);
}

/** Message for a field whose `visibleWhen` never settles (used by `FormDraft.commitAll`, #714). */
export function visibilityUnsettledMessage(
	def: FieldDef,
	messages: ValidationMessages = {}
): string {
	return (messages.visibilityUnsettled ?? defaultMessages.visibilityUnsettled)(def);
}

/** Message for raw number text that does not parse (used by `FormDraft.commit`). */
export function notANumberMessage(def: FieldDef, messages: ValidationMessages = {}): string {
	return (messages.notANumber ?? defaultMessages.notANumber)(def);
}
