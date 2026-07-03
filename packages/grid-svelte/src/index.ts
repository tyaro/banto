/**
 * Public entry point for @banto/grid-svelte (spec §4).
 * M1 scope: client-mode data, row virtualization, multi-column sort,
 * per-column filters, column resize/reorder.
 * M3 (spec §4.5) adds cell navigation/range selection, inline editing with
 * built-in editors + validation, and TSV copy/paste. Still no grouping,
 * pinning, row reordering, or server mode (later milestones).
 */
export { default as BantoGrid } from './BantoGrid.svelte';
export { GridState, DEFAULT_ROW_HEIGHT, type GridStateOptions } from './state.svelte';
export { CellSelection, type CellPos } from './selection.svelte';

export { sortRows, getColumnValue } from './core/sort';
export { filterRows } from './core/filter';
export { computeWindow, type ComputeWindowParams, type WindowResult } from './core/virtual';
export { rangeToTsv, parseTsv, parseCellInput } from './core/clipboard';
export { prepareCommit, type PrepareCommitResult } from './core/edit';

export type {
	SortDirection,
	SortState,
	FilterOp,
	FilterState,
	FilterType,
	GridColumn,
	SerializedGridState,
	CellEditorType,
	CellEdit,
	CellRange
} from './types';
export { DEFAULT_COLUMN_WIDTH, DEFAULT_MIN_WIDTH } from './types';
