/**
 * Public types for @banto/grid-svelte.
 *
 * `SortState` / `FilterOp` / `FilterState` mirror the Rust types in
 * `crates/banto-core/src/params.rs` field-for-field so the same
 * client-side state can later drive server mode (spec §4.1, §10) without a
 * shape change. Keep these two definitions in sync by hand.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortState {
	field: string;
	direction: SortDirection;
}

export type FilterOp =
	| 'eq'
	| 'ne'
	| 'lt'
	| 'lte'
	| 'gt'
	| 'gte'
	| 'contains'
	| 'starts_with'
	| 'in'
	| 'is_null'
	| 'not_null';

export interface FilterState {
	field: string;
	op: FilterOp;
	value: unknown;
}

export type FilterType = 'text' | 'number';

/** Built-in cell editor kinds (spec §4.5). */
export type CellEditorType = 'text' | 'number' | 'date' | 'select' | 'checkbox';

/**
 * One committed (or about-to-be-committed) cell edit, passed to
 * `onCellEdit`/`onRangePaste` (spec §4.5). `value` is already parsed to the
 * editor's native type (number for 'number', boolean for 'checkbox', string
 * otherwise); `oldValue` is the raw value read via the column's accessor
 * before the edit.
 */
export interface CellEdit<TRow> {
	row: TRow;
	rowId: string | number;
	field: string;
	value: unknown;
	oldValue: unknown;
}

/**
 * Normalized, inclusive rectangular selection, expressed as row indices into
 * the current (filtered+sorted) row array and field indices into the
 * current column *display* order (spec §4.5). Shared by `CellSelection`
 * (src/selection.svelte.ts) and `core/clipboard.ts`.
 */
export interface CellRange {
	rowStart: number;
	rowEnd: number;
	fieldStart: number;
	fieldEnd: number;
}

export interface GridColumn<TRow> {
	/** Stable identifier; used as SortState.field / FilterState.field. */
	id: string;
	header: string;
	accessor: keyof TRow | ((row: TRow) => unknown);
	/** Width in px. Default 150. */
	width?: number;
	/** Default 60. */
	minWidth?: number;
	maxWidth?: number;
	/** Default true. */
	resizable?: boolean;
	/** Default true. */
	sortable?: boolean;
	/** Default false. */
	filterable?: boolean;
	/** Default 'text'; controls which ops FilterPopover offers. */
	filterType?: FilterType;
	align?: 'left' | 'right' | 'center';
	format?: (value: unknown, row: TRow) => string;
	comparator?: (a: unknown, b: unknown) => number;
	/** Default false. Function form lets editability depend on the row (spec §4.5). */
	editable?: boolean | ((row: TRow) => boolean);
	/** Default 'text'. */
	editor?: CellEditorType;
	/** Options for `editor: 'select'`. */
	editorOptions?: { value: string | number; label: string }[];
	/** Column-level validator; return a Japanese error message, or null when valid. */
	validate?: (value: unknown, row: TRow) => string | null;
	/**
	 * Minimal cellRenderer escape hatch (the `cellRenderer` mentioned in spec
	 * §4.1): returns display text and an optional link href, rendered as an
	 * `<a>` when `href` is present. Not evaluated for cells currently being
	 * edited.
	 */
	cell?: (row: TRow) => { text: string; href?: string };
}

/** Resolved defaults applied on top of a user-supplied GridColumn. */
export const DEFAULT_COLUMN_WIDTH = 150;
export const DEFAULT_MIN_WIDTH = 60;

/** Shape persisted by GridState.serialize() (spec §4.4). */
export interface SerializedGridState {
	sort: SortState[];
	filters: FilterState[];
	order: string[];
	widths: Record<string, number>;
}
