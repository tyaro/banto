/**
 * Schema types for @banto/forms (spec §7.2). A `FormSchema` is shared with
 * a resource definition's `schema` (spec §3.1) so one definition drives both
 * the grid columns (future) and the form UI.
 */

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox';

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
	readonly?: boolean;
	/** select */
	options?: FieldOption[];
	/** number: value bounds. text/textarea: length bounds. */
	min?: number;
	max?: number;
	/** text: RegExp source. */
	pattern?: string;
	/** Custom validation; return an error message, or null when valid. */
	validate?: (value: unknown, values: Record<string, unknown>) => string | null;
}

export interface FormSchema {
	fields: FieldDef[];
}

export interface FieldError {
	field: string;
	message: string;
}
