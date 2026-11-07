/**
 * Pure validation functions for schema-driven forms (spec §7.2). No Svelte
 * imports — usable standalone and easy to unit test. Default messages are
 * Japanese; override via the `messages` param for i18n injection.
 */
import { isIsoDate } from './date';
import type { FieldDef, FieldError, FormSchema } from './types';

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
	/** date: `isDateDisabled` refused the day. */
	dateDisabled?: (def: FieldDef, date: string) => string;
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
	dateDisabled: () => 'この日付は選べません'
};

/**
 * Matches Rust's `input.name.trim()` semantics (items.rs's
 * `validate_item_input`): a whitespace-only string is empty. Only strings are
 * trimmed - non-string falsy values (`0`, `false`) must NOT be treated as
 * empty.
 */
function isEmpty(value: unknown): boolean {
	if (typeof value === 'string') return value.trim() === '';
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

/** Validate every field in the schema, returning one FieldError per invalid field, in schema order. */
export function validateAll(
	schema: FormSchema,
	values: Record<string, unknown>,
	messages: ValidationMessages = {}
): FieldError[] {
	const errors: FieldError[] = [];
	for (const def of schema.fields) {
		const message = validateField(def, values[def.name], values, messages);
		if (message) errors.push({ field: def.name, message });
	}
	return errors;
}

/** Message for raw date text that does not parse (used by `FormDraft.commit`). */
export function dateInvalidMessage(def: FieldDef, messages: ValidationMessages = {}): string {
	return (messages.dateInvalid ?? defaultMessages.dateInvalid)(def);
}

/** Message for raw number text that does not parse (used by `FormDraft.commit`). */
export function notANumberMessage(def: FieldDef, messages: ValidationMessages = {}): string {
	return (messages.notANumber ?? defaultMessages.notANumber)(def);
}
