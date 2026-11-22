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
 *
 * `reference` picks a record of another resource from a searched list (a
 * combobox): the value is the record's id as the option gave it (a number
 * stays a number), `null` when nothing is chosen. The candidates and the name
 * shown for a stored value come from `FieldDef.search` / `FieldDef.resolve`.
 *
 * `file` attaches files to the record (downstream-requests-2026-11-plan
 * §4.12). Its value is a `FileFieldValue` - the files the record already has
 * plus the chosen ones not uploaded yet - and is NEVER part of what a form
 * submits: files only travel through the injected `FieldDef.file.client`.
 * A form has at most one `file` field.
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
	| 'reference'
	| 'file'
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

/** One candidate of a `reference` field. `value` is what the store keeps; its type is kept (`2` and `'2'` differ). */
export interface ReferenceOption {
	value: string | number;
	label: string;
	/** Second line under the label (a code, a category). */
	description?: string;
}

/**
 * A file the record already has. A STRUCTURAL subset of `@banto/attachments`'
 * `AttachmentMeta` (forms imports no other package, conventions §4), so the
 * app's attachment metadata fits as it is.
 */
export interface FileFieldMeta {
	id: number;
	fileName: string;
	sizeBytes: number;
	mime?: string;
}

/** A chosen file that is not uploaded yet. */
export interface PendingFile {
	/** Identifies the entry in the list (unique in the page; made by forms). */
	key: string;
	file: File;
	/** Why the last upload of this file failed (what the client rejected with). Absent: not tried yet. */
	error?: string;
}

/**
 * Value of a `file` field. Not sent with the form: `FormStore.submitValues`
 * (what `BantoForm` hands to `onSubmit`) leaves the field out.
 */
export interface FileFieldValue {
	/**
	 * The files the record has, as the client listed them. `null`: not known
	 * (the list has not arrived, or failed) - `required` is not judged then.
	 */
	existing: FileFieldMeta[] | null;
	/** Chosen, not uploaded. While a visible field has any, the form is dirty. */
	pending: PendingFile[];
}

/**
 * The transport of a `file` field, injected by the app. A STRUCTURAL subset of
 * `@banto/attachments`' `AttachmentsClient`: the app's attachments client
 * (`attachmentsAdmin.ts`) can be passed as it is. forms holds no data contract
 * and adds no operation: these are the existing attachment routes / commands,
 * so their authorisation, audit and limits apply unchanged. A rejection is
 * shown as it is (its `message`).
 */
export interface FileFieldClient {
	list(resource: string, resourceId: string): Promise<FileFieldMeta[]>;
	upload(resource: string, resourceId: string, file: File): Promise<FileFieldMeta>;
	remove(id: number): Promise<void>;
}

/**
 * Settings of a `file` field (`FieldDef.file`).
 *
 * `accept` / `maxFileSize` / `maxFiles` (and the field's `required`) are
 * checked ON SCREEN ONLY, to help the input. The attachments API works per
 * record, not per field, so the server does not enforce them: another client,
 * or an upload that fails after the record was created, can leave a record
 * without a "required" file. An app that must guarantee one puts that check in
 * its own server contract. What the server does enforce (its size limit, the
 * type by magic bytes, authorisation, the parent's existence) is shown as the
 * client's rejection, also when it is stricter than these.
 */
export interface FileFieldConfig {
	client: FileFieldClient;
	/** The resource the files hang on (`AttachmentsClient`'s `resource`). */
	resource: string;
	/**
	 * Allowed kinds, like `<input accept>`: comma-separated `.ext`, `type/*`
	 * or `type/subtype` (matched against the name and the type the browser
	 * reports). Omitted: any.
	 */
	accept?: string;
	/** Largest size of one file, in bytes. */
	maxFileSize?: number;
	/** Most files the field holds (existing + chosen). `1`: the picker takes one file. */
	maxFiles?: number;
	/**
	 * Asked before a file the record has is deleted (deleting is immediate).
	 * Default: `window.confirm(message)`.
	 */
	confirmRemove?: (message: string, file: FileFieldMeta) => boolean | Promise<boolean>;
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
	/**
	 * reference: the candidates for the typed text (`''` when nothing is typed
	 * yet: return the first few). `signal` is aborted when a newer search
	 * replaces this one or the field goes away; a result that arrives after
	 * that is dropped either way. A rejection shows the failure message.
	 * forms holds no data contract: the app builds this from its own source.
	 */
	search?: (query: string, signal: AbortSignal) => Promise<ReferenceOption[]>;
	/**
	 * reference: the option of a stored value, for the name shown when the form
	 * opens on an existing value or the value is set from outside. `null` (no
	 * such record) or a rejection: the value itself is shown.
	 */
	resolve?: (value: string | number, signal: AbortSignal) => Promise<ReferenceOption | null>;
	/** file: the client the files go through and the on-screen limits. Required for a `file` field. */
	file?: FileFieldConfig;
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
