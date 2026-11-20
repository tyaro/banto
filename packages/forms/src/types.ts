/**
 * Schema types for @banto/forms (spec §7.2). A `FormSchema` is shared with
 * a resource definition's `schema` (spec §3.1) so one definition drives both
 * the grid columns (@banto/grid-svelte's `columnsFromSchema`, M23 - a
 * STRUCTURAL mirror of these types, kept dependency-free) and the form UI.
 */

/**
 * `time` is a canonical `HH:mm`, `datetime` a canonical `YYYY-MM-DDTHH:mm`
 * wall-clock time with no time zone (date-time-pickers §5.1, D4); like
 * `date`, an empty one is `null` (D6).
 *
 * `radio` is a single choice from `options` shown as a group (empty: `''`, like
 * `select`); `multiselect` is a group of checkboxes whose value is an array of
 * option values, in `options` order (empty: `[]`).
 */
export type FieldType =
	| 'text'
	| 'textarea'
	| 'number'
	| 'date'
	| 'time'
	| 'datetime'
	| 'select'
	| 'radio'
	| 'multiselect'
	| 'checkbox'
	| 'password';

/** The types whose value is a canonical date / time string, or `null` when empty (date-time-pickers D6). */
export function isTemporalType(type: FieldType): type is 'date' | 'time' | 'datetime' {
	return type === 'date' || type === 'time' || type === 'datetime';
}

/** Underline is opt-in and needs matching @banto/theme/css (ADR-0024). */
export type FormAppearance = 'default' | 'underline';

/** Number of columns a form or section lays its fields out in; narrow widths still fall back to one. */
export type FormColumns = 1 | 2 | 3;

export interface FieldOption {
	value: string | number;
	label: string;
}

export interface FieldDef {
	name: string;
	label: string;
	type: FieldType;
	required?: boolean;
	default?: unknown;
	placeholder?: string;
	/** UI-only: native readonly for text-like fields; select/radio/multiselect/checkbox remain disabled. Values still validate and submit. */
	readonly?: boolean;
	/** select / radio / multiselect */
	options?: FieldOption[];
	/** radio: `'segmented'` shows the choices as a row of buttons; the value and keyboard behaviour are the same. */
	variant?: 'segmented';
	/**
	 * number: text shown before / after the input (a currency sign, `kg`). Only
	 * the display: the value stays a plain number, and a screen reader reads
	 * the text after the label (through `aria-describedby`, ahead of `help`).
	 */
	prefix?: string;
	suffix?: string;
	/**
	 * number: value bounds. text/textarea/password: length bounds. date /
	 * time / datetime: the earliest / latest value as a canonical string
	 * (`YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm`), inclusive
	 * (date-time-pickers §5.6, D9). Read by the field's type: a bound of the
	 * other kind (a string on a number field, a number on a date field) is
	 * ignored.
	 */
	min?: number | string;
	max?: number | string;
	/**
	 * date / datetime: days that cannot be chosen (weekends, holidays); `date`
	 * is canonical `YYYY-MM-DD` (for datetime, the value's day) (§5.6).
	 */
	isDateDisabled?: (date: string) => boolean;
	/**
	 * time / datetime: minutes between allowed times, counted from 00:00
	 * (§5.6, D8). Given: the picker lists every `step` minutes and a value off
	 * the step is an error. Omitted: a 30-minute list and any minute accepted.
	 */
	step?: number;
	/** text: RegExp source. */
	pattern?: string;
	/** Custom validation; return an error message, or null when valid. */
	validate?: (value: unknown, values: Record<string, unknown>) => string | null;
	/** The `FormSection.id` this field belongs to. Omitted (or an unknown id): the field is not in a section. */
	section?: string;
	/** Take the whole row in a multi-column layout (a long textarea, say). */
	fullWidth?: boolean;
	/**
	 * Show the field only while this returns true for the current values.
	 * A hidden field is not rendered, not validated (`required` included), and
	 * left out of `FormStore.submitValues`; the value typed into it is kept, so
	 * showing it again brings the input back.
	 */
	visibleWhen?: (values: Record<string, unknown>) => boolean;
	/** Help text under the control; the control points at it with `aria-describedby`. */
	help?: string;
}

/** A titled group of fields. Fields join it with `FieldDef.section`; the DOM order is the section order. */
export interface FormSection {
	id: string;
	title: string;
	/** Short text under the title. */
	description?: string;
	/** Columns of this section; defaults to `FormSchema.columns`, then 1. */
	columns?: FormColumns;
}

export interface FormSchema {
	fields: FieldDef[];
	/**
	 * Titled groups, rendered in this order after the fields that have no
	 * section. Omitted: one plain group, as before. `fields` stays the flat
	 * list, so the store, validation and the grid columns read it unchanged.
	 */
	sections?: FormSection[];
	/** Default columns of every group (1 when omitted). */
	columns?: FormColumns;
}

export interface FieldError {
	field: string;
	message: string;
}
