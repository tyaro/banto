<script lang="ts" generics="TRow">
	/**
	 * Client-mode data grid (spec §4): filter -> sort -> virtualize -> render.
	 * Single scroll container for header + body; the header row is
	 * `position: sticky` so horizontal scroll stays in sync automatically
	 * and vertical scroll drives the virtualization window.
	 *
	 * M3 (spec §4.5) adds cell navigation/selection, inline editing, and
	 * TSV copy/paste on top of the M1/M2 read-only grid. All of it lives in
	 * this component (not `state.svelte.ts`) because it's UI-event-driven
	 * (pointer/keyboard/clipboard handlers), not derived reactive state; the
	 * pure decision logic it calls into (`prepareCommit`, TSV helpers) is
	 * factored into `core/*.ts` and unit-tested there.
	 */
	import { tick, untrack, type Snippet } from 'svelte';
	import {
		DEFAULT_COLUMN_WIDTH,
		type CellEdit,
		type CellRange,
		type FilterState,
		type GridBulkActionsContext,
		type GridColumn,
		type SortState
	} from './types';
	import CellEditor from './CellEditor.svelte';
	import { DEFAULT_ROW_HEIGHT, GridState } from './state.svelte';
	import { CellSelection } from './selection.svelte';
	import { EditController } from './edit.svelte';
	import { getColumnValue, sortRows } from './core/sort';
	import { filterRows } from './core/filter';
	import { computeWindow, parseRowHeightPx } from './core/virtual';
	import {
		clampDropIndex,
		contentXAt,
		fitPinnedCount,
		pinnedOffsets,
		scrollLeftToReveal
	} from './core/pinning';
	import { parseCellInput, parseTsv, rangeToTsv, resolveSelectValue } from './core/clipboard';
	import { prepareCommit, isColumnEditable } from './core/edit';
	import { cellText, resolveCellPresentation, resolveTone } from './core/cellView';
	import {
		allMatchingVerdict,
		canSelectAllMatching,
		retainSelected,
		selectAllState,
		toggleAll,
		toggleRowId,
		type RowId
	} from './core/rowSelection';
	import { buildGroupedView, type FlatEntry } from './core/group';
	import HeaderCell from './HeaderCell.svelte';
	import CellEditError from './CellEditError.svelte';
	import { defaultGridMessages, type GridMessages } from './messages';
	import { getCellEditors, type CellEditors } from './cellEditors';

	interface Props {
		/**
		 * Client mode: the full row set (filter/sort/paging happen in this
		 * component). Server mode (spec §4.1, M5): a SPARSE array aligned to
		 * ABSOLUTE row indices - `rows[i]` is row `i`'s data once loaded,
		 * `undefined` (a hole) otherwise; the caller (typically
		 * `@banto/admin-core`'s windowed list resource) owns fetching and
		 * writes into it as blocks arrive.
		 */
		rows: (TRow | undefined)[];
		columns: GridColumn<TRow>[];
		state?: GridState<TRow>;
		getRowId: (row: TRow) => string | number;
		/**
		 * Fixed row height in px (spec §4.2). Pass it to pin the height; omit it
		 * and rows follow the theme density through `--banto-grid-row-height`
		 * (standard 36 / compact 32 / touch 52). With an external `state`, the
		 * state's own `rowHeightFixed` decides and this prop is ignored.
		 */
		rowHeight?: number;
		/**
		 * Default 'client'. Row grouping (spec §4.3, `state.groupBy`/
		 * `setGroupBy`/`toggleGroup`) only runs in 'client' mode - a later
		 * milestone adds the server-mode SQL GROUP BY equivalent. If
		 * `state.groupBy` is set while `mode === 'server'`, it is ignored
		 * (rows render as a flat list) and a single `console.warn` fires as a
		 * dev aid.
		 */
		mode?: 'client' | 'server';
		/** Server mode only: total row count backing the virtual scroller (NOT `rows.length`, which is just the sparse array's current extent). */
		totalRows?: number;
		onRowClick?: (row: TRow) => void;
		/**
		 * Touch / pen only (grid-touch-edit-design §3): one tap on an editable
		 * cell starts editing it. Default `true`; `false` keeps the double tap.
		 * The mouse is not affected (click selects, double-click edits), nor is
		 * the keyboard (Enter / F2).
		 */
		editOnTap?: boolean;
		/**
		 * A data row's context menu was requested: mouse right-click on a cell, or
		 * (grid focused, active cell on a data row, not editing) the ContextMenu
		 * key / Shift+F10 - keyboard `x`/`y` = the active cell's left / bottom edge.
		 * When provided the browser's default menu is suppressed; when omitted it
		 * is left alone. Right-clicking inside a cell editor keeps the native text
		 * menu. Never called for group headers, placeholder (loading) rows or an
		 * empty grid. The row is passed as is: whether to act on it alone or on
		 * every selected row (`selectedRowIds`) is the caller's decision. Does NOT
		 * change the row selection. The active cell follows the click, before the
		 * callback: inside the current cell range the range is kept; outside it
		 * the range collapses to the clicked cell, as with a left click.
		 */
		onRowContextMenu?: (row: TRow, position: { x: number; y: number }) => void;
		onCellEdit?: (edit: CellEdit<TRow>) => void | Promise<void>;
		onRangePaste?: (edits: CellEdit<TRow>[], info: { skipped: number }) => void | Promise<void>;
		/**
		 * Optional extra class name(s) for a data row's outer `.row` element,
		 * computed per-row (spec M14: the audit-log viewer uses this to give
		 * `result: 'denied' | 'failed'` rows a subdued left border via a
		 * `:global()` selector in the caller's own stylesheet - see that
		 * page's doc comment). Returning `''`/`undefined` adds nothing. Not
		 * applied to placeholder (unloaded server-mode) rows or group header
		 * rows, since neither has a real `TRow` to compute a class from.
		 */
		rowClass?: (row: TRow) => string | undefined;
		/** Server mode: fires after a sort toggle / filter apply / filter clear so the caller can re-fetch. */
		onParamsChange?: (params: { sort: SortState[]; filters: FilterState[] }) => void;
		/** Server mode: fires when the virtualized window's [start, end) actually changes (not on every scroll tick). */
		onVisibleRangeChange?: (range: { start: number; end: number }) => void;
		/**
		 * i18n layer 1 (docs/conventions.md §13): overrides for this component's
		 * visible strings, threaded down to HeaderCell and (through it) to
		 * FilterPopover. Defaults reproduce today's Japanese output.
		 */
		messages?: Partial<GridMessages>;
		/**
		 * Injected cell editors (date-time-pickers §5.8, D1-a), per editor type,
		 * and the filter's day-range input (`dateRange`, §5.9); wins over
		 * `provideCellEditors` (context). A type with neither keeps the native
		 * input (D3-a).
		 */
		cellEditors?: CellEditors;
		/**
		 * Row selection (#713), off by default. Adds a checkbox column at the
		 * start (not a `GridColumn`: it never appears in the columns menu, cannot
		 * be dragged, resized, sorted or copied) whose header box selects or
		 * clears every row it names - the listed rows (after filters) in client
		 * mode, only the LOADED rows in server mode - and a bar under the grid
		 * while at least one row is selected. Space on the active cell toggles
		 * its row, except on a cell whose link or button takes the key (a
		 * `renderer: 'link'` / `cell` link, a `render` snippet's control) and on
		 * a group header. With `selectable`, Space no longer calls `onRowClick`
		 * on a read-only grid; Enter still does.
		 */
		selectable?: boolean;
		/**
		 * Ids (`getRowId`) of the selected rows, in the order they were selected;
		 * bindable. Not part of `GridState`, so a saved view never carries it.
		 * Rows that leave the list are deselected: in client mode whenever a row
		 * is no longer among the filtered `rows` (filter, reload, delete), in
		 * server mode when the grid's filters change (rows that merely scrolled
		 * out of the loaded window stay selected).
		 */
		selectedRowIds?: RowId[];
		/**
		 * Server mode only: `true` while "all M matching rows" is selected -
		 * every row the current filters match, loaded or not (the bulk bar
		 * offers it once every loaded row is selected and `totalRows` is
		 * larger). Bindable, for reading: the grid turns it on (the bar's
		 * button) and off. A host may write `false` to leave the mode (the
		 * selection is emptied, like `clear()`); a `true` the host writes is
		 * turned back off. While it is on, `selectedRowIds` stays what it was
		 * when the mode was entered (loaded rows only), so act on the filter
		 * conditions, not on the ids.
		 */
		allMatchingSelected?: boolean;
		/**
		 * Opt in to server mode's "all matching rows" selection (#713). Off by
		 * default: the bar then never offers "select all M matching rows",
		 * `allMatchingSelected` stays false and a selection is always the
		 * ids. Turn it on only when the bulk action can run on the filter
		 * conditions (`allMatching` / `matchingCount` in `bulkActions`), else
		 * the bar would say "all 100 selected" while the action only touches
		 * the loaded rows.
		 */
		selectAllMatching?: boolean;
		/**
		 * Fires with the new ids after every change the grid makes to the
		 * selection, entering "all matching" mode included (same ids;
		 * `allMatchingSelected` is already updated when it fires).
		 */
		onSelectionChange?: (ids: RowId[]) => void;
		/**
		 * Names a row for its checkbox's accessible name (`selectRowLabel`).
		 * Default: the text of the first visible column that is not a `render`
		 * snippet, else the row id.
		 */
		getRowLabel?: (row: TRow) => string;
		/**
		 * Extra controls for the bulk bar (#713), e.g. a "delete" button. Gets
		 * the selected ids, `clear()` (call it once the action is done) and, for
		 * server mode's "all matching" selection, `allMatching` /
		 * `matchingCount`. The grid runs no bulk operation itself.
		 */
		bulkActions?: Snippet<[GridBulkActionsContext]>;
	}

	// Aliased to avoid clashing with the `$state` rune (a local binding named
	// exactly `state` makes the compiler treat `$state(...)` calls below as
	// store-subscription syntax instead of rune usage).
	let {
		rows,
		columns,
		state: externalState,
		getRowId,
		rowHeight,
		mode = 'client',
		totalRows,
		onRowClick,
		editOnTap = true,
		onRowContextMenu,
		onCellEdit,
		onRangePaste,
		onParamsChange,
		onVisibleRangeChange,
		rowClass,
		messages = {},
		cellEditors,
		selectable = false,
		selectedRowIds = $bindable([]),
		allMatchingSelected = $bindable(false),
		selectAllMatching = false,
		onSelectionChange,
		getRowLabel,
		bulkActions
	}: Props = $props();

	const providedCellEditors = getCellEditors();
	const editors = $derived<CellEditors>({ ...providedCellEditors, ...cellEditors });

	// `messages` is an i18n layer 1 override bundle; merged reactively so a
	// parent that swaps it later (a locale switch) is followed.
	const t = $derived({ ...defaultGridMessages, ...messages });
	// Only one editor is mounted per grid; keep its error reference local to
	// this instance without deriving DOM IDs from row or column identifiers.
	const gridId = $props.id();
	const editErrorId = `${gridId}-edit-error`;

	// Created once per component instance. If the caller passes `state`, that
	// instance is the single source of truth (including whether its rowHeight is
	// fixed); otherwise we own one internally, seeded from the `rowHeight` prop
	// (passed = fixed, omitted = follows `--banto-grid-row-height`, see the
	// probe effect below).
	// Capturing only the initial prop values here is by design.
	// svelte-ignore state_referenced_locally
	const gridState: GridState<TRow> = externalState ?? new GridState(columns, { rowHeight });

	// #890: a `columns` prop that changes AFTER mount is handed to the state,
	// which keeps the user's widths / order / sort / filters / pins
	// (`GridState.setColumns`). The array given at mount is not pushed: a
	// caller's own `state` stays the source of truth for what it was built
	// with, as before. `$effect.pre` so the header and the cells never render
	// one frame with the old definitions; only `columns` is tracked
	// (conventions §8).
	// svelte-ignore state_referenced_locally
	let appliedColumns = columns;
	// The last `conditionsRevision` counters handled (see
	// `afterConditionsChanged`). Declared here: a pre-effect runs during this
	// script, before the code below.
	let handledConditions = untrack(() => gridState.conditionsRevision);
	$effect.pre(() => {
		const next = columns;
		if (next === appliedColumns) return;
		appliedColumns = next;
		untrack(() => {
			// Which record the active cell is on, and what each display index
			// shows, read before the swap can re-sort or re-filter the rows.
			const anchor = cellSelectionRecord();
			const before = anchor && mode === 'client' ? displayedOrder() : null;
			gridState.setColumns(next);
			afterConditionsChanged(anchor, before);
		});
	});
	// The same when the caller calls `state.setColumns` itself (no record to
	// follow then: the cell selection is cleared instead). Several calls in
	// one update are handled here once, with the latest conditions.
	$effect.pre(() => {
		void gridState.conditionsRevision;
		untrack(() => afterConditionsChanged(null, null));
	});

	const OVERSCAN = 8;

	let containerEl: HTMLDivElement | undefined = $state();
	let rowHeightProbeEl: HTMLDivElement | undefined = $state();
	let frameEl: HTMLDivElement | undefined = $state();
	let errorRegionEl: HTMLDivElement | undefined = $state();
	let headerRowEl: HTMLDivElement | undefined = $state();
	let editorEl: HTMLInputElement | HTMLSelectElement | undefined = $state();
	// An injected editor's wrapper (button and calendar included); the native
	// editors have none and are their own root.
	let editorRootEl: HTMLElement | null | undefined = $state();

	let scrollTop = $state(0);
	// Only pinned columns (#713) read the horizontal side: the boundary shadow
	// and the drop indicator follow `scrollLeft`, `fitPinnedCount` the width.
	let scrollLeft = $state(0);
	let viewportHeight = $state(0);
	let viewportWidth = $state(0);
	let headerHeight = $state(40);

	$effect(() => {
		if (!containerEl) return;
		viewportHeight = containerEl.clientHeight;
		viewportWidth = containerEl.clientWidth;
		const observer = new ResizeObserver(() => {
			viewportHeight = containerEl!.clientHeight;
			viewportWidth = containerEl!.clientWidth;
		});
		observer.observe(containerEl);
		return () => observer.disconnect();
	});

	// Theme density (spec §4.2): an invisible probe sized by
	// `--banto-grid-row-height` is measured (computed height, not offsetHeight)
	// and fed to the state whenever it resizes, i.e. when `data-banto-density`
	// changes the variable. A fixed `rowHeight` makes `followThemeRowHeight` a no-op.
	$effect(() => {
		const probe = rowHeightProbeEl;
		if (!probe) return;
		const measure = () =>
			untrack(() =>
				gridState.followThemeRowHeight(
					parseRowHeightPx(getComputedStyle(probe).height, DEFAULT_ROW_HEIGHT)
				)
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(probe);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!headerRowEl) return;
		headerHeight = headerRowEl.offsetHeight;
		const observer = new ResizeObserver(() => {
			headerHeight = headerRowEl!.offsetHeight;
		});
		observer.observe(headerRowEl);
		return () => observer.disconnect();
	});

	// spec §4.5 / #212: removing a saved editor can leave body focused.
	// Track explicit user intent separately from that incidental focus loss,
	// including clicks on non-focusable elements. Never reclaim abandoned focus.
	// The claim itself lives in the edit controller (`edit`, below).
	$effect(() => {
		const container = containerEl;
		if (!container) return;
		const document = container.ownerDocument;
		// The whole editor counts (date-time-pickers §5.8 promise 4): pressing
		// an injected editor's button or a calendar day, or focus moving into
		// its calendar, keeps the session's claim on focus.
		function insideEditor(target: EventTarget | null): boolean {
			const root = editorRootEl ?? editorEl;
			return !!root && target instanceof Node && root.contains(target);
		}
		// A press outside can make an injected editor park focus on its own text
		// box while it dismisses its popover (DateInput's light dismiss), in the
		// same pointerdown dispatch: that focusin is not the user coming back.
		let pressedOutside = false;
		let pressTimer: ReturnType<typeof setTimeout> | undefined;
		function relinquishFocus(event: Event) {
			if (!edit.tracksFocus) return;
			const inside = insideEditor(event.target);
			if (event.type === 'pointerdown') {
				if (inside) return;
				edit.setFocusOwned(false);
				pressedOutside = true;
				clearTimeout(pressTimer);
				pressTimer = setTimeout(() => (pressedOutside = false));
				return;
			}
			if (inside && pressedOutside) return;
			edit.setFocusOwned(inside);
		}
		function leaveWindow() {
			edit.setFocusOwned(false);
		}
		document.addEventListener('pointerdown', relinquishFocus, true);
		document.addEventListener('focusin', relinquishFocus, true);
		document.defaultView?.addEventListener('blur', leaveWindow);
		return () => {
			document.removeEventListener('pointerdown', relinquishFocus, true);
			document.removeEventListener('focusin', relinquishFocus, true);
			document.defaultView?.removeEventListener('blur', leaveWindow);
			clearTimeout(pressTimer);
			edit.setFocusOwned(false);
		};
	});

	// Focus a new editor or a failed draft only while this session still owns
	// focus. In particular, pending/error assignments must not steal it back.
	$effect(() => {
		const current = editing;
		const editor = editorEl;
		if (current && editor && !current.pending) {
			untrack(() => {
				if (!edit.ownsFocus(current.sessionId)) return;
				editor.focus();
				if (editor instanceof HTMLInputElement && editor.type !== 'checkbox') editor.select();
			});
		}
	});

	function handleScroll(event: Event) {
		const target = event.currentTarget as HTMLDivElement;
		scrollTop = target.scrollTop;
		scrollLeft = target.scrollLeft;
	}

	// Server mode (spec §4.1, M5): sort/filter already happened in the
	// DataProvider, so `rows` (sparse, absolute-index-aligned) is used
	// as-is - running it back through the client filter/sort pipeline would
	// be wrong (holes aren't real rows, and the order is already final).
	const sorted = $derived(
		mode === 'server'
			? rows
			: sortRows(
					filterRows(rows as TRow[], gridState.filters, gridState.columns),
					gridState.sort,
					gridState.columns,
					getRowId
				)
	);

	// Client-mode-only row grouping (spec §4.3): filter -> sort -> group ->
	// virtualize. `null` (not grouped, or server mode - see the console.warn
	// effect below) means the ungrouped `sorted`/`rows` array drives
	// rendering exactly as before M5 Phase B.
	const groupedEntries: FlatEntry<TRow>[] | null = $derived(
		mode === 'client' && gridState.groupBy
			? buildGroupedView(sorted as TRow[], gridState.columns, gridState.groupBy, (key) =>
					gridState.collapsedGroups.has(key)
				)
			: null
	);

	// Dev aid (spec §4.3): grouping has no server-mode equivalent yet, so a
	// `groupBy` set while `mode === 'server'` is silently ignored for
	// rendering - warn once per "entering" the misconfigured state (not on
	// every reactive recompute) so it doesn't spam the console.
	let warnedServerGroupBy = false;
	$effect(() => {
		if (mode === 'server' && gridState.groupBy) {
			if (!warnedServerGroupBy) {
				warnedServerGroupBy = true;
				console.warn(
					'[BantoGrid] state.groupBy is ignored in server mode (spec §4.3: grouping has no server-mode equivalent yet).'
				);
			}
		} else {
			warnedServerGroupBy = false;
		}
	});

	// Row count driving the virtual scroller: server mode sizes from
	// `totalRows` (the sparse array's current `.length` is just how much of
	// it has been fetched so far, not the true total); client mode from the
	// grouped flat-entry count when grouped, otherwise the actual
	// (filtered+sorted) row count.
	const effectiveRowCount = $derived(
		mode === 'server' ? (totalRows ?? 0) : (groupedEntries?.length ?? sorted.length)
	);

	const rowsViewportHeight = $derived(Math.max(0, viewportHeight - headerHeight));
	const effectiveScrollTop = $derived(Math.max(0, scrollTop - headerHeight));

	const windowResult = $derived(
		computeWindow({
			scrollTop: effectiveScrollTop,
			viewportHeight: rowsViewportHeight,
			rowHeight: gridState.rowHeight,
			rowCount: effectiveRowCount,
			overscan: OVERSCAN
		})
	);

	// In server mode, always render exactly (end - start) row slots even if
	// the sparse array hasn't been extended that far yet - those slots
	// render as placeholder ("loading") rows rather than being skipped.
	const visibleRows = $derived(
		mode === 'server'
			? Array.from(
					{ length: windowResult.end - windowResult.start },
					(_, i) => rows[windowResult.start + i]
				)
			: sorted.slice(windowResult.start, windowResult.end)
	);

	// Grouped-mode counterpart of `visibleRows`: the virtualized window
	// slices `groupedEntries` (group headers + rows) instead of `sorted`.
	const visibleEntries = $derived(
		groupedEntries ? groupedEntries.slice(windowResult.start, windowResult.end) : []
	);

	// Server mode only: notify the caller when the virtualized window
	// actually moves to a new [start, end) (not on every scroll tick -
	// `windowResult` only changes when the computed window changes, and this
	// guard further skips re-firing for an unchanged start/end pair).
	let lastReportedRange: { start: number; end: number } | null = null;
	$effect(() => {
		if (mode !== 'server' || !onVisibleRangeChange) return;
		const { start, end } = windowResult;
		if (lastReportedRange && lastReportedRange.start === start && lastReportedRange.end === end)
			return;
		lastReportedRange = { start, end };
		onVisibleRangeChange({ start, end });
	});

	/** Server mode: called after a header sort toggle or filter apply/clear (spec §4.1, §4.3). */
	function notifyParamsChange() {
		if (mode === 'server') {
			onParamsChange?.({ sort: gridState.sort, filters: gridState.filters });
		}
	}

	const showSortPriority = $derived(gridState.sort.length > 1);

	function widthOf(column: GridColumn<TRow>): number {
		return gridState.widths[column.id] ?? column.width ?? DEFAULT_COLUMN_WIDTH;
	}

	// Row selection (#713): the checkbox column is not a `GridColumn`, so every
	// horizontal computation over `orderedColumns` (the grid template, the drop
	// indicator, scrolling the active cell into view) is shifted by its width.
	// Part of the component's shape, like the column widths themselves.
	const SELECT_COLUMN_WIDTH = 40;
	const selectColumnWidth = $derived(selectable ? SELECT_COLUMN_WIDTH : 0);

	const templateColumns = $derived(
		(selectable ? `${SELECT_COLUMN_WIDTH}px ` : '') +
			gridState.orderedColumns.map((column) => `${widthOf(column)}px`).join(' ')
	);
	const totalColumnsWidth = $derived(
		gridState.orderedColumns.reduce((sum, column) => sum + widthOf(column), selectColumnWidth)
	);
	const orderedFieldIds = $derived(gridState.orderedColumns.map((column) => column.id));

	// --- Pinned columns (#713) ---
	// `gridState.orderedColumns` already leads with the pinned zone; here it is
	// only decided how many of those columns stick (`position: sticky`) and
	// where. The decisions are pure (`core/pinning.ts`). `stuckCount === 0`
	// means no pinning at all: the checkbox column then scrolls as before.
	const columnWidths = $derived(gridState.orderedColumns.map((column) => widthOf(column)));
	const stuckCount = $derived(
		fitPinnedCount({
			pinnedWidths: columnWidths.slice(0, gridState.pinnedCount),
			leading: selectColumnWidth,
			viewportWidth
		})
	);
	const pinActive = $derived(stuckCount > 0);
	const stuckOffsets = $derived(pinnedOffsets(columnWidths, stuckCount, selectColumnWidth));
	/** Width of the stuck block, checkbox column included; 0 when nothing sticks. */
	const pinnedWidth = $derived(
		pinActive ? stuckOffsets[stuckCount - 1] + columnWidths[stuckCount - 1] : 0
	);

	/** Keyed `{#each}` block key for a (possibly sparse-hole) visible row. */
	function rowKeyFor(row: TRow | undefined, rowIndex: number): string | number {
		return row === undefined ? `__hole_${rowIndex}` : getRowId(row);
	}

	/** Keyed `{#each}` block key for a grouped-mode flat entry (spec §4.3). */
	function entryKeyFor(entry: FlatEntry<TRow>): string | number {
		return entry.kind === 'group' ? `__group_${entry.key}` : getRowId(entry.row);
	}

	/**
	 * Resolve the concrete row at a "display" row index - i.e. an index into
	 * whichever list is currently driving rendering/selection (`groupedEntries`
	 * when grouped, `rows` in server mode, `sorted` otherwise). Every place
	 * that used to read `sorted[selection.active.rowIndex]` goes through this
	 * instead, so cell selection/editing/copy-paste keep working unchanged
	 * whether or not grouping is active (spec §4.3). Returns undefined for a
	 * group header row or an out-of-range index.
	 */
	function rowAtDisplayIndex(index: number): TRow | undefined {
		if (groupedEntries) {
			const entry = groupedEntries[index];
			return entry && entry.kind === 'row' ? entry.row : undefined;
		}
		return mode === 'server' ? rows[index] : sorted[index];
	}

	/** Whether the entry at this display row index is a group header (spec §4.3). */
	function isGroupHeaderAt(index: number): boolean {
		return groupedEntries?.[index]?.kind === 'group';
	}

	/** The group key at this display row index, or null when it's not a group header row. */
	function groupKeyAt(index: number): string | null {
		const entry = groupedEntries?.[index];
		return entry && entry.kind === 'group' ? entry.key : null;
	}

	/** Click (or Enter/Space via the container's keydown handler) toggles a group header's collapsed state (spec §4.3). */
	function handleGroupHeaderClick(rowIndex: number, key: string) {
		containerEl?.focus();
		selection.setActive(rowIndex, selection.active?.field ?? orderedFieldIds[0], false);
		gridState.toggleGroup(key);
	}

	// .cell is a flex container with a single text node, so horizontal
	// alignment must go through justify-content (text-align has no effect
	// on flex layout).
	function justifyFor(align: GridColumn<TRow>['align']): string {
		if (align === 'right') return 'flex-end';
		if (align === 'center') return 'center';
		return 'flex-start';
	}

	// --- Column drag-reorder (pointer events, driven from HeaderCell) ---
	let dragColumnId: string | null = $state(null);
	let dropIndex: number | null = $state(null);

	function handleDragStart(columnId: string) {
		dragColumnId = columnId;
		// A VISIBLE-order index, like the one handleDragMove computes below
		// and the one `moveColumn` expects - `gridState.order` also carries
		// hidden ids (spec §4.4), so an index into it would point at the
		// wrong drop slot as soon as a column is hidden.
		dropIndex = orderedFieldIds.indexOf(columnId);
	}

	function handleDragMove(clientX: number) {
		if (!headerRowEl) return;
		const rect = headerRowEl.getBoundingClientRect();
		// The header row scrolls with the content, so `clientX - rect.left` is a
		// content coordinate - except over the stuck block (#713), which is
		// drawn at its unscrolled place whatever `scrollLeft` is.
		const contentX = contentXAt({
			viewX: clientX - rect.left - scrollLeft,
			scrollLeft,
			pinnedWidth
		});
		const x = contentX - selectColumnWidth;
		let cumulative = 0;
		const cols = gridState.orderedColumns;
		let index = cols.length;
		for (let i = 0; i < cols.length; i++) {
			const w = widthOf(cols[i]);
			if (x < cumulative + w / 2) {
				index = i;
				break;
			}
			cumulative += w;
		}
		// A column is only reordered inside its own zone (pinned / unpinned).
		const fromIndex = dragColumnId === null ? -1 : orderedFieldIds.indexOf(dragColumnId);
		dropIndex =
			fromIndex === -1
				? index
				: clampDropIndex(fromIndex, index, gridState.pinnedCount, cols.length);
	}

	function handleDragEnd() {
		if (dragColumnId !== null && dropIndex !== null) {
			gridState.moveColumn(dragColumnId, dropIndex);
		}
		dragColumnId = null;
		dropIndex = null;
	}

	const dropIndicatorX = $derived.by(() => {
		if (dropIndex === null) return null;
		let x = selectColumnWidth;
		const cols = gridState.orderedColumns;
		for (let i = 0; i < dropIndex && i < cols.length; i++) {
			x += widthOf(cols[i]);
		}
		if (!pinActive) return x;
		// Pinned columns (#713): a slot inside the stuck block is drawn where the
		// block is (it does not scroll), and a slot of the other zone never under it.
		const draggingPinned =
			dragColumnId !== null && orderedFieldIds.indexOf(dragColumnId) < gridState.pinnedCount;
		if (draggingPinned && dropIndex <= stuckCount) return scrollLeft + x;
		return Math.max(x, scrollLeft + pinnedWidth);
	});

	// --- Row selection (#713) ---
	// Separate from the cell selection below: that one is a rectangle of cells
	// by display index (copy / paste), this one a set of row ids for bulk
	// actions. The decisions are pure (`core/rowSelection.ts`).
	const selectedSet = $derived(new Set<RowId>(selectable ? selectedRowIds : []));

	// The rows "select all" acts on: the listed (filtered) rows in client mode -
	// rows inside a collapsed group included - and only the loaded rows in
	// server mode (`Object.keys`: `rows.length` can span millions of holes).
	const selectAllTargets = $derived.by((): RowId[] => {
		if (!selectable) return [];
		if (mode === 'server') {
			const ids: RowId[] = [];
			for (const key of Object.keys(rows)) {
				const row = rows[Number(key)];
				if (row !== undefined) ids.push(getRowId(row));
			}
			return ids;
		}
		return (sorted as TRow[]).map(getRowId);
	});
	// "All matching" mode (server mode, #713): every row the filters match is
	// selected, loaded or not. The loaded rows are all drawn selected - rows
	// that load later too - while `selectedRowIds` stays what it was on entry.
	// `allMatchingIds` is that entry snapshot (null = the grid is not in the
	// mode); a plain variable, compared against the prop to notice a write
	// from outside.
	let allMatchingIds: readonly RowId[] | null = null;
	const allMatching = $derived(
		selectable && selectAllMatching && mode === 'server' && allMatchingSelected
	);
	// How many rows the current filters match.
	const matchingCount = $derived(
		mode === 'server' ? (totalRows ?? selectAllTargets.length) : selectAllTargets.length
	);
	const selectAll = $derived(allMatching ? 'all' : selectAllState(selectedSet, selectAllTargets));
	const offerAllMatching = $derived(
		selectable &&
			canSelectAllMatching({
				mode,
				selectAll,
				loadedCount: selectAllTargets.length,
				totalRows,
				allMatching,
				enabled: selectAllMatching
			})
	);
	const selectAllLabel = $derived(
		mode === 'server'
			? t.selectAllLoadedRows(selectAllTargets.length, totalRows ?? selectAllTargets.length)
			: t.selectAllRows(selectAllTargets.length)
	);
	const bulkBarVisible = $derived(selectable && selectedRowIds.length > 0);

	// Text of the polite live region: set only when the grid itself changes
	// the selection, so nothing is read when the grid mounts.
	let selectionAnnouncement = $state('');

	// The bar goes away with the last selected row, however that happens (clear
	// button, a reload that drops the rows, a server filter change, the host
	// assigning `[]` to the bound `selectedRowIds`): a control inside it that
	// has focus would drop focus to <body>. By the time any effect runs the bar
	// is already out of the DOM, so whether focus was inside it is tracked from
	// focusin / focusout (a plain variable, not state). Focus that moved to
	// another element is left alone: only focus that fell to <body> is brought
	// back to the grid.
	let bulkBarHadFocus = false;
	let bulkBarWasVisible = false;
	function handleBulkBarFocusIn() {
		bulkBarHadFocus = true;
	}
	function handleBulkBarFocusOut(event: FocusEvent) {
		if (event.relatedTarget) {
			bulkBarHadFocus = false;
			return;
		}
		// A null relatedTarget is what removal and a click on blank space both
		// report. Decide one task later: if the bar is still in the document and
		// focus is not inside it, the user left it (blank-space click), so the
		// flag drops. If the bar was removed, the effect below has already
		// restored focus and there is nothing to do.
		const bar = event.currentTarget as HTMLElement;
		setTimeout(() => {
			if (bar.isConnected && !bar.contains(bar.ownerDocument.activeElement)) {
				bulkBarHadFocus = false;
			}
		}, 0);
	}
	$effect(() => {
		const visible = bulkBarVisible;
		if (bulkBarWasVisible && !visible && bulkBarHadFocus) {
			const doc = containerEl?.ownerDocument;
			if (doc && (!doc.activeElement || doc.activeElement === doc.body)) {
				containerEl?.focus({ preventScroll: true });
			}
		}
		if (!visible) bulkBarHadFocus = false;
		bulkBarWasVisible = visible;
	});

	// Every write of the selection goes through here, and every one of them
	// leaves "all matching" mode (only `enterAllMatching` turns it on).
	function setSelectedRowIds(next: RowId[]) {
		allMatchingIds = null;
		if (allMatchingSelected) allMatchingSelected = false;
		selectedRowIds = next;
		selectionAnnouncement = t.selectionStatus(next.length);
		onSelectionChange?.(next);
	}

	function isRowSelected(row: TRow): boolean {
		return allMatching || selectedSet.has(getRowId(row));
	}

	// In "all matching" mode every row is drawn selected, so a toggle is always
	// an uncheck; there is no "all but these", so it empties the selection.
	function toggleRowSelected(row: TRow) {
		setSelectedRowIds(allMatching ? [] : toggleRowId(selectedRowIds, getRowId(row)));
	}

	function toggleAllSelected() {
		setSelectedRowIds(allMatching ? [] : toggleAll(selectedRowIds, selectAllTargets));
	}

	function clearSelectedRows() {
		if (selectedRowIds.length === 0 && !allMatchingSelected) return;
		setSelectedRowIds([]);
	}

	let bulkBarEl = $state<HTMLElement | null>(null);

	function enterAllMatching() {
		if (!offerAllMatching) return;
		// The button goes away with the click: keep focus in the bar (on the
		// bar itself, so the next Tab reaches its actions) instead of letting
		// it drop to <body>.
		const active = bulkBarEl?.ownerDocument.activeElement;
		if (bulkBarEl && active && bulkBarEl.contains(active)) {
			bulkBarEl.focus({ preventScroll: true });
		}
		allMatchingIds = [...selectedRowIds];
		allMatchingSelected = true;
		selectionAnnouncement = t.allMatchingStatus(matchingCount);
		onSelectionChange?.(selectedRowIds);
	}

	// "All matching" mode ends when the host touches it from outside. If it
	// wrote `selectedRowIds`, only the mode is left and the value the host
	// wrote stays. If it turned the flag off, or the grid is no longer a
	// selectable server grid, the selection is emptied, as with every other
	// way out. A flag the host turned on itself is turned back off. Writes run
	// in `untrack` (conventions §8).
	$effect(() => {
		const verdict = allMatchingVerdict({
			flag: allMatchingSelected,
			enteredWith: allMatchingIds,
			selected: selectedRowIds,
			usable: selectable && selectAllMatching && mode === 'server'
		});
		if (verdict === 'keep') return;
		untrack(() => {
			if (verdict === 'reject') allMatchingSelected = false;
			else if (verdict === 'leave-keep') {
				allMatchingIds = null;
				allMatchingSelected = false;
				selectionAnnouncement = t.selectionStatus(selectedRowIds.length);
			} else setSelectedRowIds([]);
		});
	});

	function rowLabelFor(row: TRow): string {
		const custom = getRowLabel?.(row);
		if (custom) return custom;
		const column = gridState.orderedColumns.find((candidate) => !candidate.render);
		const text = column ? (column.cell ? column.cell(row).text : cellText(column, row)) : '';
		return text.trim() || String(getRowId(row));
	}

	// A press on the checkbox column behaves like one on a cell of that row:
	// focus stays on the grid (the `mousedown` default that would move it to
	// the checkbox is prevented in the markup) so the arrow keys keep working,
	// and the row becomes the active one. The click itself toggles the box.
	function handleSelectPointerDown(event: PointerEvent, rowIndex: number) {
		if (event.button !== 0) return;
		containerEl?.focus({ preventScroll: true });
		const field = selection.active?.field ?? orderedFieldIds[0];
		if (field !== undefined) selection.setActive(rowIndex, field, false);
	}

	// Client mode: a selected row that is no longer listed (filtered out,
	// deleted, replaced by a reload) is deselected, so a bulk action never
	// reaches a row the user cannot see in the list. Writes run in `untrack`
	// (conventions §8); `retainSelected` returns the same array when nothing
	// was dropped, which ends the loop.
	$effect(() => {
		if (!selectable || mode !== 'client') return;
		const current = selectedRowIds;
		if (current.length === 0) return;
		const kept = retainSelected(current, new Set(selectAllTargets));
		if (kept !== current) untrack(() => setSelectedRowIds([...kept]));
	});

	// Server mode: the grid cannot tell which selected rows a new filter
	// still matches (only a window of rows is loaded), so a filter change
	// clears the selection. A sort change or scrolling keeps it.
	let lastFilterKey: string | null = null;
	$effect(() => {
		const key = JSON.stringify(gridState.filters);
		const changed = lastFilterKey !== null && lastFilterKey !== key;
		lastFilterKey = key;
		if (changed && selectable && mode === 'server') untrack(clearSelectedRows);
	});

	// --- Cell selection / navigation (spec §4.5) ---
	const selection = new CellSelection();

	/**
	 * Hiding a column (spec §4.4) can strand cell state that names it: the
	 * active/anchor cell and an open editor are stored by FIELD ID, so a
	 * column leaving `orderedColumns` would otherwise leave `getRange`
	 * returning null (copy/paste silently stops) and Enter/F2 acting on a
	 * cell with no DOM node. Drop whatever points at a now-invisible column.
	 * Only `orderedFieldIds` is a tracked dependency - the writes read and
	 * mutate the very state they touch, so they run inside `untrack`
	 * (conventions §8).
	 */
	$effect(() => {
		const visible = new Set(orderedFieldIds);
		untrack(() => {
			const stale = (pos: { field: string } | null) => pos !== null && !visible.has(pos.field);
			if (stale(selection.active)) {
				selection.clear();
			} else if (stale(selection.anchor) || stale(selection.rangeEnd)) {
				// The active cell survived but a range corner did not: collapse
				// to the single active cell rather than keep a rectangle whose
				// edge no longer exists.
				if (selection.active) {
					selection.setActive(selection.active.rowIndex, selection.active.field, false);
				} else {
					selection.clear();
				}
			}
			if (editing && !visible.has(editing.field)) edit.cancel();
		});
	});

	/**
	 * #890: `setColumns` dropped a sort / filter / group-by whose column went
	 * away, or gave the column under one a new definition (see
	 * `GridState.conditionsRevision`). When the sort / filters changed the
	 * server is asked for them once (as after a header change), however many
	 * `setColumns` calls led here. The cell selection - display indices -
	 * stays when the display order did not change; otherwise it moves with
	 * the record it was on: the active cell follows that row id, a range
	 * (which cannot be kept over re-ordered rows) collapses to it, and with no
	 * record to follow (the caller's own `setColumns`, a row no longer shown)
	 * the selection is cleared. Server mode clears it when the sort / filters
	 * changed (the rows are fetched again).
	 */
	function afterConditionsChanged(
		anchor: { rowId: string | number; field: string } | null,
		before: unknown[] | null
	) {
		const current = gridState.conditionsRevision;
		if (current.revision === handledConditions.revision) return;
		const paramsChanged = current.paramsRevision !== handledConditions.paramsRevision;
		handledConditions = current;
		if (paramsChanged) notifyParamsChange();
		if (!selection.active) return;
		if (mode === 'server') {
			if (paramsChanged) selection.clear();
			return;
		}
		if (before && sameOrder(before, displayedOrder())) return;
		const rowIndex = anchor ? displayIndexOfRowId(anchor.rowId) : -1;
		if (anchor && rowIndex >= 0) selection.setActive(rowIndex, anchor.field, false);
		else selection.clear();
	}

	/** Client mode: what each display index shows - a row, or a group's key. */
	function displayedOrder(): unknown[] {
		return groupedEntries
			? groupedEntries.map((entry) => (entry.kind === 'row' ? entry.row : `__group_${entry.key}`))
			: sorted;
	}

	function sameOrder(a: unknown[], b: unknown[]): boolean {
		return a.length === b.length && a.every((item, index) => item === b[index]);
	}

	function cellSelectionRecord(): { rowId: string | number; field: string } | null {
		const active = selection.active;
		if (!active) return null;
		const row = rowAtDisplayIndex(active.rowIndex);
		return row === undefined ? null : { rowId: getRowId(row), field: active.field };
	}

	/** Client mode: the display index of the row with `rowId`, or -1. */
	function displayIndexOfRowId(rowId: string | number): number {
		const index = groupedEntries
			? groupedEntries.findIndex((entry) => entry.kind === 'row' && getRowId(entry.row) === rowId)
			: sorted.findIndex((row) => row !== undefined && getRowId(row) === rowId);
		return index < effectiveRowCount ? index : -1;
	}

	/**
	 * #890: the definition of the column being edited can change under the
	 * open editor (`columns` swapped: an edit mode switched off). When the
	 * cell is no longer editable the edit is cancelled - the draft is dropped,
	 * the same as when the column is hidden or removed (the effect above); a
	 * save already on its way is not waited for. Only the DEFINITION is
	 * tracked: a row whose own values change during an edit does not close it.
	 */
	const editingColumn = $derived.by(() => {
		const field = editingField;
		return field === undefined
			? undefined
			: gridState.orderedColumns.find((candidate) => candidate.id === field);
	});
	$effect(() => {
		const column = editingColumn;
		if (!column) return;
		untrack(() => {
			const row = rowAtDisplayIndex(editingRowIndex);
			if (row !== undefined && !isColumnEditable(column, row)) edit.cancel();
		});
	});

	/**
	 * Any VISIBLE column that could ever be editable switches the row-open
	 * interaction (see handleCellClick/handleCellDoubleClick below). Read off
	 * `orderedColumns`, not the `columns` prop: with every editable column
	 * hidden (spec §4.4) the grid on screen is read-only, and single click
	 * should open the row again instead of being reserved for cell selection.
	 */
	const hasEditableColumns = $derived(
		gridState.orderedColumns.some((column) => Boolean(column.editable))
	);

	// Pre-merge review fix (deferred): delegates to the pure, unit-tested
	// `isColumnEditable` (core/edit.ts), whose whole point is that a column
	// with a `cell` renderer is never editable - see its doc comment for why.
	function isEditable(column: GridColumn<TRow>, row: TRow): boolean {
		return isColumnEditable(column, row);
	}

	/**
	 * Bring the active cell into view. Computed directly from row-height
	 * math / column widths rather than `Element.scrollIntoView` because the
	 * active row may not exist in the DOM yet (row virtualization) at the
	 * moment a keyboard move happens; columns are never virtualized (spec
	 * §4.2), so the horizontal computation can safely assume every column's
	 * DOM width equals `widthOf(column)`.
	 */
	function scrollActiveIntoView() {
		if (!containerEl || !selection.active) return;
		const { rowIndex, field } = selection.active;

		const rowTop = rowIndex * gridState.rowHeight;
		const rowBottom = rowTop + gridState.rowHeight;
		if (rowTop < effectiveScrollTop) {
			containerEl.scrollTop = rowTop + headerHeight;
		} else if (rowBottom > effectiveScrollTop + rowsViewportHeight) {
			containerEl.scrollTop = rowBottom - rowsViewportHeight + headerHeight;
		}

		const fieldIndex = orderedFieldIds.indexOf(field);
		if (fieldIndex === -1) return;
		let x = selectColumnWidth;
		for (let i = 0; i < fieldIndex; i++) x += widthOf(gridState.orderedColumns[i]);
		const w = widthOf(gridState.orderedColumns[fieldIndex]);
		// Pinned columns (#713) cover the left of the viewport: a cell behind
		// them counts as out of view, and a pinned cell is always in view.
		const next = scrollLeftToReveal({
			cellLeft: x,
			cellWidth: w,
			scrollLeft: containerEl.scrollLeft,
			viewportWidth: containerEl.clientWidth,
			pinnedWidth,
			cellPinned: fieldIndex < stuckCount
		});
		if (next !== containerEl.scrollLeft) containerEl.scrollLeft = next;
	}

	/**
	 * Tab / Shift+Tab stays native (#713). A link or header button inside a
	 * column that is not pinned can land under the stuck block; pull it out
	 * from under it. Cell selection moves have their own path
	 * (`scrollActiveIntoView`).
	 */
	function handleFocusIn(event: FocusEvent) {
		if (!containerEl || !pinActive) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		const cell = target.closest('.cell, .header-cell');
		if (!cell || !containerEl.contains(cell) || cell.classList.contains('pinned')) return;
		// Judge by the focused element, not its (possibly very wide) cell: the
		// cell only decides whether this is a pinned column.
		const rect = target.getBoundingClientRect();
		const containerRect = containerEl.getBoundingClientRect();
		const next = scrollLeftToReveal({
			cellLeft: rect.left - containerRect.left + containerEl.scrollLeft,
			cellWidth: rect.width,
			scrollLeft: containerEl.scrollLeft,
			viewportWidth: containerEl.clientWidth,
			pinnedWidth,
			cellPinned: false
		});
		if (next !== containerEl.scrollLeft) containerEl.scrollLeft = next;
	}

	function activeCellHasRendererLink(column: GridColumn<TRow>): boolean {
		// Only a `renderer: 'link'` cell that really drew its <a> (not the
		// text fallback, not `cell` / `render`): that link wins over the row action.
		if (column.render || column.cell || column.renderer !== 'link' || !selection.active)
			return false;
		const { rowIndex, field } = selection.active;
		return !!containerEl?.querySelector(
			`[data-cell-row="${rowIndex}"][data-cell-field="${CSS.escape(field)}"] a.cell-link`
		);
	}

	/**
	 * A11y fix (spec §4.7; known regression confirmed in the M3 review):
	 * Enter/Space on the active cell previously did nothing useful when the
	 * grid has editable columns and the active column is not editable - a
	 * link column (e.g. the items page's "open" column, rendered via
	 * `column.cell`) could only be reached with the mouse. Rather than
	 * reimplementing routing here (BantoGrid doesn't own it), this finds the
	 * `<a>` DOM node BantoGrid itself already rendered for the active cell
	 * and issues a real click on it, so the browser's native anchor
	 * navigation (or an app router that intercepts link clicks) takes it
	 * from there - identical to what a mouse click on that link does. Only
	 * ever finds an anchor for a currently-rendered row (guaranteed for the
	 * active cell, since every navigation keeps it in view via
	 * `scrollActiveIntoView`). Returns whether a link was found and clicked.
	 */
	function navigateActiveLink(): boolean {
		if (!containerEl || !selection.active) return false;
		const { rowIndex, field } = selection.active;
		const cellEl = containerEl.querySelector<HTMLElement>(
			`[data-cell-row="${rowIndex}"][data-cell-field="${CSS.escape(field)}"]`
		);
		// A `render` cell (#591): its first enabled button or link is the
		// control the keyboard reaches, same as a click on it.
		const column = gridState.orderedColumns.find((candidate) => candidate.id === field);
		const anchor = column?.render
			? cellEl?.querySelector<HTMLElement>('button:not([disabled]), a[href]')
			: cellEl?.querySelector<HTMLAnchorElement>('a.cell-link');
		if (!anchor) return false;
		anchor.click();
		return true;
	}

	/**
	 * The row `delta` places away from the row with id `rowId`, in the order
	 * on screen (#591: an app's "previous / next record"): client mode follows
	 * the filtered + sorted rows (and, when grouped, the rows of the expanded
	 * groups), server mode the loaded rows of the windowed array - a neighbour
	 * that is not loaded yet is `undefined`, the same as one past either end
	 * or a `rowId` that is not on screen. Reading it in an effect / `$derived`
	 * tracks the rows it read.
	 */
	export function adjacentRow(rowId: string | number, delta: number): TRow | undefined {
		if (mode === 'server') {
			// Only enumerate loaded slots; `rows.length` can span millions of holes.
			for (const key of Object.keys(rows)) {
				const index = Number(key);
				const row = rows[index];
				if (row !== undefined && getRowId(row) === rowId) return rows[index + delta];
			}
			return undefined;
		}
		const ordered = groupedEntries
			? groupedEntries.flatMap((entry) => (entry.kind === 'row' ? [entry.row] : []))
			: (sorted as TRow[]);
		const index = ordered.findIndex((row) => getRowId(row) === rowId);
		return index === -1 ? undefined : ordered[index + delta];
	}

	// grid-touch-edit-design §3: a touch / pen press does nothing by itself -
	// the browser may still turn it into a scroll (`pointercancel`, no
	// `click`). Only the cell it landed on is remembered here; focus, the
	// active cell and the start of editing all wait for the `click`.
	// Never reactive: only event handlers read these.
	let pendingTap: {
		pointerId: number;
		pointerType: string;
		/** Its `pointerup` arrived, over the pressed cell: a `click` may follow. */
		released: boolean;
		rowIndex: number;
		field: string;
	} | null = null;
	/** The tap the capture-phase `click` accepted, for the bubbling `click` on the same cell. */
	let acceptedTap: { rowIndex: number; field: string } | null = null;

	// A cell whose save is pending is not "being edited" here: a double-click
	// or a tap on it opens a new session over the one waiting (#210; the
	// earlier save's result stays with the earlier session).
	function isCellBeingEdited(row: TRow, field: string): boolean {
		return (
			editing !== null &&
			!editing.pending &&
			editing.rowId === getRowId(row) &&
			editing.field === field
		);
	}

	function handleCellPointerDown(event: PointerEvent, rowIndex: number, field: string) {
		pendingTap = null;
		acceptedTap = null;
		if (event.button !== 0) return;
		if (event.pointerType === 'touch' || event.pointerType === 'pen') {
			const tap = {
				pointerId: event.pointerId,
				pointerType: event.pointerType,
				released: false,
				rowIndex,
				field
			};
			const cellEl = event.currentTarget as HTMLElement;
			pendingTap = tap;
			// A press that is cancelled (a pan), or released away from its cell,
			// gets no `click` here: drop it, so that a later click that is not a
			// pointer's (a keyboard, assistive technology) cannot pass for its tap.
			// On window: a touch `pointerup` goes to the pressed element wherever
			// the finger is, a mouse-like one to whatever is under it.
			const onTapEnd = (endEvent: PointerEvent) => {
				if (endEvent.pointerId !== tap.pointerId) return;
				window.removeEventListener('pointerup', onTapEnd, true);
				window.removeEventListener('pointercancel', onTapEnd, true);
				if (pendingTap !== tap) return;
				if (endEvent.type === 'pointercancel' || !pointerEndedOn(cellEl, endEvent)) {
					pendingTap = null;
				} else {
					tap.released = true;
				}
			};
			window.addEventListener('pointerup', onTapEnd, true);
			window.addEventListener('pointercancel', onTapEnd, true);
			return;
		}
		// Move real DOM focus to the grid container so keyboard navigation
		// keeps working after a click. This synchronously blurs whatever was
		// previously focused (e.g. another cell's editor <input>), which is
		// exactly the "blur commits" behavior we want (spec §4.5).
		//
		// #236: `preventScroll` is load-bearing. A plain focus() scrolls the page
		// (every scrolling ancestor) to bring the container into view, so when the
		// grid sits partly below the fold (e.g. right after a page loads, before
		// the content above it settles) the page moves between pointerdown and
		// pointerup. The pointer is then released over a different element, the
		// browser dispatches `click` to their common ancestor instead of this
		// cell, and onRowClick never runs although the cell was selected here.
		// The clicked cell is already under the pointer, so nothing needs to
		// be scrolled into view; keyboard moves scroll via scrollActiveIntoView.
		containerEl?.focus({ preventScroll: true });
		selection.setActive(rowIndex, field, event.shiftKey);

		const pointerId = event.pointerId;
		function onMove(moveEvent: PointerEvent) {
			if (moveEvent.pointerId !== pointerId) return;
			// Dragging beyond the visible viewport does not auto-scroll in v1
			// (spec-noted limitation) — elementFromPoint only ever resolves to
			// cells currently rendered in the DOM.
			const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
			const cellEl = (target as HTMLElement | null)?.closest<HTMLElement>('[data-cell-row]');
			if (!cellEl?.dataset.cellField) return;
			const r = Number(cellEl.dataset.cellRow);
			if (Number.isNaN(r)) return;
			selection.setActive(r, cellEl.dataset.cellField, true);
		}
		// `pointercancel` too: a press the browser takes over (a pan, a drag
		// out of the window) never gets its `pointerup`.
		function onEnd(endEvent: PointerEvent) {
			if (endEvent.pointerId !== pointerId) return;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onEnd);
			window.removeEventListener('pointercancel', onEnd);
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onEnd);
		window.addEventListener('pointercancel', onEnd);
	}

	// A tap's compatibility `mousedown` comes after its `pointerdown` and
	// before its `click`, and its default action moves focus to the nearest
	// focusable ancestor - the grid container. On the room around the editor
	// of the cell being edited (a checkbox editor does not fill its cell) that
	// would blur, and so commit, the draft before the `click` guard below can
	// keep it. The mouse is left alone: its press on that room commits, as before.
	function handleCellMouseDown(event: MouseEvent, rowIndex: number, field: string, row: TRow) {
		if (pendingTap?.rowIndex !== rowIndex || pendingTap.field !== field) return;
		if (!isCellBeingEdited(row, field)) return;
		const editorRoot = editorRootEl ?? editorEl;
		if (editorRoot && event.target instanceof Node && editorRoot.contains(event.target)) return;
		event.preventDefault();
	}

	function pointerEndedOn(cellEl: HTMLElement, event: PointerEvent): boolean {
		if (!(event.target instanceof Node) || !cellEl.contains(event.target)) return false;
		// jsdom has no hit testing; there the target above is all there is.
		const document = cellEl.ownerDocument;
		if (typeof document.elementFromPoint !== 'function') return true;
		const under = document.elementFromPoint(event.clientX, event.clientY);
		return under !== null && cellEl.contains(under);
	}

	/**
	 * Whether `click` is the one `tap`'s pointer produced. Never before the
	 * press was released on its cell: a click during a held press is someone
	 * else's. A pointer's click carries its `pointerId` / `pointerType`
	 * (Pointer Events 3); a click that no pointer made has `-1` / `''`. Where
	 * `click` is still a plain MouseEvent there is nothing to compare, and
	 * only a click known to be synthetic (`detail` 0: `element.click()`, a
	 * keyboard, assistive technology) can be told apart.
	 */
	function clickIsOfTap(click: MouseEvent, tap: NonNullable<typeof pendingTap>): boolean {
		if (!tap.released) return false;
		const pointer = click as Partial<PointerEvent>;
		if (typeof pointer.pointerId !== 'number' || typeof pointer.pointerType !== 'string') {
			return click.detail !== 0;
		}
		return pointer.pointerId === tap.pointerId && pointer.pointerType === tap.pointerType;
	}

	// The tap's deferred half of `handleCellPointerDown` (focus + active cell).
	// Capture phase: a link or a `render` control in the cell stops its click
	// from bubbling, and the active cell follows a press on those too.
	function handleCellClickCapture(event: MouseEvent, rowIndex: number, field: string, row: TRow) {
		const tap = pendingTap;
		pendingTap = null;
		acceptedTap = null;
		if (!tap || tap.rowIndex !== rowIndex || tap.field !== field) return;
		if (!clickIsOfTap(event, tap)) return;
		// The cell being edited belongs to its editor: focusing the container
		// here would blur (commit) it.
		if (isCellBeingEdited(row, field)) return;
		const cellEl = event.currentTarget as HTMLElement;
		// A control inside the cell that took focus from this tap keeps it, as
		// it does after a mouse press.
		const focused = cellEl.ownerDocument.activeElement;
		if (!focused || focused === cellEl || !cellEl.contains(focused)) {
			containerEl?.focus({ preventScroll: true });
		}
		selection.setActive(rowIndex, field, event.shiftKey);
		acceptedTap = { rowIndex, field };
	}

	// Single click: select the cell (already done on pointerdown above); for
	// grids with no editable columns at all, also preserve the M2 row-click
	// behavior. For grids with editable columns, opening a record needs a
	// dedicated affordance instead (see the items page's `cell` link column
	// and the double-click handler below), so a plain click never fires
	// onRowClick there.
	//
	// A touch / pen tap (grid-touch-edit-design §3.3) on an editable cell
	// starts editing instead, unless `editOnTap` is off.
	function handleCellClick(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		const tap = acceptedTap;
		acceptedTap = null;
		if (
			editOnTap &&
			tap?.rowIndex === rowIndex &&
			tap.field === column.id &&
			isEditable(column, row)
		) {
			startEditing(rowIndex, column, row);
			return;
		}
		if (!hasEditableColumns) onRowClick?.(row);
	}

	// Right-click on a data cell (#784). Same contract as BantoTree's
	// `onContextMenu`: no callback -> the browser's own menu; the cell editor
	// keeps the native text menu; focus follows the click BEFORE the callback;
	// the row selection and the cell range are left alone.
	function handleCellContextMenu(event: MouseEvent, rowIndex: number, field: string, row: TRow) {
		// A long press ends here, not in a `click`: it is not a tap.
		pendingTap = null;
		if (!onRowContextMenu) return;
		// The whole injected editor (calendar buttons, popover) keeps its own menu,
		// not just its text box.
		const editorRoot = editorRootEl ?? editorEl;
		if (
			editing?.rowId === getRowId(row) &&
			event.target instanceof Node &&
			((editorRoot && editorRoot.contains(event.target)) ||
				(event.target instanceof HTMLElement && event.target.closest('input, select, textarea')))
		)
			return;
		event.preventDefault();
		containerEl?.focus({ preventScroll: true });
		// Inside an existing range only the active cell moves (the range, and so
		// any copy target, stays); anywhere else it collapses to the clicked cell
		// like a left click.
		const range = selection.getRange(orderedFieldIds);
		const fieldIndex = orderedFieldIds.indexOf(field);
		const inRange =
			selection.rangeEnd !== null &&
			range !== null &&
			rowIndex >= range.rowStart &&
			rowIndex <= range.rowEnd &&
			fieldIndex >= range.fieldStart &&
			fieldIndex <= range.fieldEnd;
		if (inRange) selection.active = { rowIndex, field };
		else selection.setActive(rowIndex, field, false);
		onRowContextMenu(row, { x: event.clientX, y: event.clientY });
	}

	function handleCellDoubleClick(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		// A double-click (or the second tap of a double tap) inside the open
		// editor selects a word there; restarting the session would throw the
		// draft away.
		if (isCellBeingEdited(row, column.id)) return;
		if (isEditable(column, row)) {
			startEditing(rowIndex, column, row);
		} else if (hasEditableColumns) {
			onRowClick?.(row);
		}
	}

	// --- Keyboard navigation (grid container; spec §4.5, §4.7) ---
	const ENTER_CELL_KEYS = new Set([
		'ArrowUp',
		'ArrowDown',
		'ArrowLeft',
		'ArrowRight',
		'Home',
		'End',
		'PageUp',
		'PageDown'
	]);

	/**
	 * No active cell yet (grid reached by Tab, no pointer): the first navigation
	 * key only "enters" the grid - the first data row in view, first column -
	 * without moving further (#784). With no data row in view (e.g. the visible
	 * window is still loading), a navigation key falls back to the first data
	 * row in display order and scrolls to it; the ContextMenu / Shift+F10 keys
	 * (when wired) open the row menu only on a data row in view, so the menu is
	 * never anchored to a row that is not on screen.
	 */
	function enterFirstCellFromKeyboard(event: KeyboardEvent) {
		const isMenuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
		if (isMenuKey ? !onRowContextMenu : !ENTER_CELL_KEYS.has(event.key)) return;
		const field = orderedFieldIds[0];
		if (field === undefined) return;
		const count = effectiveRowCount;
		if (count === 0) return;
		const rowHeight = gridState.rowHeight;
		const firstInView = Math.min(
			count - 1,
			Math.max(0, Math.floor(effectiveScrollTop / rowHeight))
		);
		const lastInView = Math.min(
			count - 1,
			Math.max(firstInView, Math.ceil((effectiveScrollTop + rowsViewportHeight) / rowHeight) - 1)
		);
		// [first data row in view, first data row in display order]
		let inView = -1;
		let first = -1;
		if (mode === 'server') {
			// Only enumerate loaded slots (integer keys come in ascending order);
			// `totalRows` can span millions of holes, as in `adjacentRow`.
			for (const key of Object.keys(rows)) {
				const index = Number(key);
				if (!Number.isInteger(index) || index >= count || rows[index] === undefined) continue;
				if (first === -1) first = index;
				if (index > lastInView) break;
				if (index >= firstInView) {
					inView = index;
					break;
				}
			}
		} else {
			for (let i = firstInView; i <= lastInView && inView === -1; i++) {
				if (rowAtDisplayIndex(i)) inView = i;
			}
			if (inView !== -1) first = inView;
			for (let i = 0; i < count && first === -1; i++) {
				if (rowAtDisplayIndex(i)) first = i;
			}
		}
		const rowIndex = isMenuKey ? inView : inView !== -1 ? inView : first;
		if (rowIndex === -1) return;
		event.preventDefault();
		selection.setActive(rowIndex, field, false);
		scrollActiveIntoView();
		if (!isMenuKey) return;
		const row = rowAtDisplayIndex(rowIndex)!;
		void tick().then(() => {
			const cellEl = containerEl?.querySelector<HTMLElement>(
				`[data-cell-row="${rowIndex}"][data-cell-field="${CSS.escape(field)}"]`
			);
			const rect = cellEl?.getBoundingClientRect();
			onRowContextMenu?.(row, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
		});
	}

	function handleContainerKeydown(event: KeyboardEvent) {
		// Header controls, filter inputs and row links own their keyboard
		// actions. A retained cell selection must not intercept bubbled keys.
		if (event.target !== event.currentTarget) return;
		// While editing, the editor input/select's own onkeydown owns Escape/
		// Enter/Tab/typing and stops propagation for every key, so this never
		// runs; the guard is a defensive no-op if that ever changes.
		if (editing) return;
		// Outside an editor, Tab/Shift+Tab follow the browser's focus order,
		// including header controls and row links, so focus can leave the grid.
		if (event.key === 'Tab') return;
		if (!selection.active) {
			enterFirstCellFromKeyboard(event);
			return;
		}

		const rowCount = effectiveRowCount;
		const activeColumn = gridState.orderedColumns.find((c) => c.id === selection.active!.field);
		const activeRow = rowAtDisplayIndex(selection.active!.rowIndex);

		switch (event.key) {
			case 'ContextMenu':
			case 'F10': {
				if (event.key === 'F10' && !event.shiftKey) break;
				if (!onRowContextMenu || !activeRow) break;
				event.preventDefault();
				const cellEl = containerEl?.querySelector<HTMLElement>(
					`[data-cell-row="${selection.active.rowIndex}"][data-cell-field="${CSS.escape(selection.active.field)}"]`
				);
				const rect = cellEl?.getBoundingClientRect();
				onRowContextMenu(activeRow, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
				break;
			}
			case 'ArrowUp':
				event.preventDefault();
				// Group headers are just another row slot in `groupedEntries`, so
				// up/down "moves through them" for free - no special-casing
				// needed (spec §4.3).
				selection.moveActive(-1, 0, event.shiftKey, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			case 'ArrowDown':
				event.preventDefault();
				selection.moveActive(1, 0, event.shiftKey, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			case 'ArrowLeft':
				event.preventDefault();
				// A group header renders as one full-width unit with no
				// per-column cells (spec §4.3), so there is no field to move
				// between while active sits on one - simplification: left/right
				// are a no-op there instead of trying to model a "field" concept
				// that doesn't visually exist.
				if (!isGroupHeaderAt(selection.active.rowIndex)) {
					selection.moveActive(0, -1, event.shiftKey, rowCount, orderedFieldIds);
					scrollActiveIntoView();
				}
				break;
			case 'ArrowRight':
				event.preventDefault();
				if (!isGroupHeaderAt(selection.active.rowIndex)) {
					selection.moveActive(0, 1, event.shiftKey, rowCount, orderedFieldIds);
					scrollActiveIntoView();
				}
				break;
			case 'Home':
				event.preventDefault();
				selection.setActive(selection.active.rowIndex, orderedFieldIds[0], false);
				scrollActiveIntoView();
				break;
			case 'End':
				event.preventDefault();
				selection.setActive(
					selection.active.rowIndex,
					orderedFieldIds[orderedFieldIds.length - 1],
					false
				);
				scrollActiveIntoView();
				break;
			case 'PageDown': {
				event.preventDefault();
				const step = Math.max(1, Math.round(rowsViewportHeight / gridState.rowHeight));
				selection.moveActive(step, 0, false, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			}
			case 'PageUp': {
				event.preventDefault();
				const step = Math.max(1, Math.round(rowsViewportHeight / gridState.rowHeight));
				selection.moveActive(-step, 0, false, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			}
			case 'Enter': {
				event.preventDefault();
				const enterGroupKey = groupKeyAt(selection.active.rowIndex);
				if (enterGroupKey !== null) {
					gridState.toggleGroup(enterGroupKey);
					break;
				}
				if (!activeColumn || !activeRow) break;
				if (isEditable(activeColumn, activeRow)) {
					startEditing(selection.active.rowIndex, activeColumn, activeRow);
				} else if (activeCellHasRendererLink(activeColumn) && navigateActiveLink()) {
					// #713: a `renderer: 'link'` cell's own link beats the row action.
				} else if (!hasEditableColumns && onRowClick) {
					onRowClick(activeRow);
				} else if (navigateActiveLink()) {
					// A11y fix (spec §4.7, M3 review regression): the active
					// column isn't editable but renders a link (e.g. the items
					// page's "open" column) - navigate it, same as a mouse
					// click on the rendered <a> would.
				} else {
					selection.moveActive(1, 0, false, rowCount, orderedFieldIds);
					scrollActiveIntoView();
				}
				break;
			}
			case 'F2':
				if (activeColumn && activeRow && isEditable(activeColumn, activeRow)) {
					event.preventDefault();
					startEditing(selection.active.rowIndex, activeColumn, activeRow);
				}
				break;
			case ' ': {
				const spaceGroupKey = groupKeyAt(selection.active.rowIndex);
				if (spaceGroupKey !== null) {
					event.preventDefault();
					gridState.toggleGroup(spaceGroupKey);
					break;
				}
				if (selectable && activeRow) {
					// #713: Space selects the row. A cell that owns a link or a
					// button keeps the key for it (`renderer: 'link'` as in the
					// branch below, plus `cell` links and `render` controls);
					// opening the row is Enter's job in a selectable grid.
					event.preventDefault();
					const onControl =
						!!activeColumn && !isEditable(activeColumn, activeRow) && navigateActiveLink();
					if (!onControl) toggleRowSelected(activeRow);
					break;
				}
				if (
					activeColumn &&
					activeRow &&
					!isEditable(activeColumn, activeRow) &&
					activeCellHasRendererLink(activeColumn) &&
					navigateActiveLink()
				) {
					event.preventDefault();
				} else if (!hasEditableColumns && onRowClick && activeRow) {
					event.preventDefault();
					onRowClick(activeRow);
				} else if (
					activeColumn &&
					activeRow &&
					!isEditable(activeColumn, activeRow) &&
					navigateActiveLink()
				) {
					// Same a11y fix as Enter above; editable columns are
					// deliberately left alone (Space starts nothing for them
					// today, unchanged).
					event.preventDefault();
				}
				break;
			}
			default:
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
					event.preventDefault();
					void copySelection();
				}
				break;
		}
	}

	// --- Inline editing (spec §4.5) ---
	// The session's state transitions (start / draft / commit / save / cancel)
	// and its focus claim live in `EditController` (edit.svelte.ts, #822). This
	// component keeps what needs the DOM or the displayed rows: focus moves,
	// following the edited row, and the post-commit navigation.
	// The controller reads these props when it needs them, never at creation.
	const edit = new EditController<TRow>({
		getRowId: (row) => getRowId(row),
		currentRow: () => rowAtDisplayIndex(editingRowIndex),
		save: () => onCellEdit,
		invalidMessage: () => t.inlineEditInvalid()
	});
	const editing = $derived(edit.session);
	// Saving/validation replaces `editing`; keep those state changes from
	// invalidating the row lookup or taking over a user's newer selection.
	const editingRowId = $derived.by(() => editing?.rowId);
	const editingField = $derived.by(() => editing?.field);
	let previousEditingPosition: { rowId: string | number; field: string; rowIndex: number } | null =
		null;

	// spec §4.1 / #205: a server array's extent includes unloaded holes.
	// Enumerate present slots only; findIndex/forEach would visit or test
	// every index and create reactive dependencies on the missing rows.
	// Object.keys also tracks additions/deletions in a caller's $state array.
	const serverRowIndexById = $derived.by(() => {
		const indices = new Map<string | number, number>();
		const rowCount = effectiveRowCount;
		for (const key of Object.keys(rows)) {
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= rowCount) continue;
			const row = rows[index];
			if (row !== undefined) indices.set(getRowId(row), index);
		}
		return indices;
	});

	// spec §4.5 / #205: an edit belongs to a record, not a display slot.
	// Resolve against the full displayed dataset (including loaded server
	// rows), so virtualization alone does not cancel an off-screen edit.
	const editingRowIndex: number = $derived.by(() => {
		const rowId = editingRowId;
		if (rowId === undefined) return -1;
		if (mode === 'server') return serverRowIndexById.get(rowId) ?? -1;
		const index = groupedEntries
			? groupedEntries.findIndex((entry) => entry.kind === 'row' && getRowId(entry.row) === rowId)
			: sorted.findIndex((row) => row !== undefined && getRowId(row) === rowId);
		return index < effectiveRowCount ? index : -1;
	});

	$effect(() => {
		const rowId = editingRowId;
		const rowIndex = editingRowIndex;
		const field = editingField;
		untrack(() => {
			const previous = previousEditingPosition;
			previousEditingPosition =
				rowId === undefined || field === undefined ? null : { rowId, field, rowIndex };
			if (rowId === undefined || field === undefined) return;
			// Follow an edit only while its previous cell is still selected.
			// A click elsewhere during blur-save owns the new selection.
			const followsEdit =
				previous !== null &&
				previous.rowId === rowId &&
				previous.field === field &&
				selection.active?.rowIndex === previous.rowIndex &&
				selection.active.field === field;
			if (rowIndex < 0) {
				// Deleted, filtered out, collapsed, or unloaded: never leave a
				// draft waiting to attach to a replacement row at the old index.
				edit.cancel();
				if (followsEdit) selection.clear();
			} else if (followsEdit && previous.rowIndex !== rowIndex) {
				selection.setActive(rowIndex, field, false);
			}
		});
	});

	function startEditing(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		const session = edit.start(column, row);
		if (!session) return;
		selection.setActive(rowIndex, column.id, false);
		previousEditingPosition = { rowId: session.rowId, field: column.id, rowIndex };
	}

	/** Parse the current draft text and commit; optionally move the active cell afterward on success. */
	async function commitFromEditor(
		column: GridColumn<TRow>,
		row: TRow,
		moveAfter?: 'down' | 'left' | 'right'
	) {
		if (!editing || editing.pending) return;
		const sessionId = editing.sessionId;
		const draft = edit.resolveDraft(column);
		if (!draft.ok) {
			if (moveAfter === 'left' || moveAfter === 'right') await focusEditError(sessionId);
			return;
		}
		const closed = await edit.commitValue(column, row, draft.value);
		if (!closed && (moveAfter === 'left' || moveAfter === 'right')) {
			await focusEditError(sessionId);
		}
		// A newer session may start between commitValue closing this one
		// and this continuation running, including after a synchronous save.
		if (
			closed &&
			moveAfter &&
			edit.isLatest(sessionId) &&
			edit.ownsFocus(sessionId) &&
			containerEl?.isConnected
		) {
			const rowCount = effectiveRowCount;
			if (moveAfter === 'down') selection.moveActive(1, 0, false, rowCount, orderedFieldIds);
			else if (moveAfter === 'left') selection.moveActive(0, -1, false, rowCount, orderedFieldIds);
			else selection.moveActive(0, 1, false, rowCount, orderedFieldIds);
			scrollActiveIntoView();
			containerEl.focus({ preventScroll: true });
		}
	}

	function handleCheckboxToggle(column: GridColumn<TRow>, row: TRow, checked: boolean) {
		if (!editing || editing.pending) return;
		void edit.commitValue(column, row, checked);
	}

	function canFocusEditError(sessionId: number) {
		return (
			editing?.sessionId === sessionId &&
			!!editing.error &&
			edit.ownsFocus(sessionId) &&
			editorEl?.isConnected &&
			editorEl.ownerDocument.activeElement === editorEl
		);
	}

	async function focusEditError(sessionId: number) {
		if (!canFocusEditError(sessionId)) return;
		// The error/position must be rendered first. A newer edit, outside click
		// or focus departure during that wait owns the focus instead.
		await tick();
		if (
			canFocusEditError(sessionId) &&
			errorRegionEl?.isConnected &&
			!errorRegionEl.hidden &&
			errorRegionEl.dataset.editSession === String(sessionId)
		) {
			errorRegionEl.focus({ preventScroll: true });
		}
	}

	function returnFromEditError(sessionId: number): boolean {
		if (editing?.sessionId !== sessionId || !editing.error || !editorEl?.isConnected) return false;
		editorEl.focus({ preventScroll: true });
		return true;
	}

	function handleEditorKeydown(event: KeyboardEvent, column: GridColumn<TRow>, row: TRow) {
		// Stop every key from bubbling to the container's navigation handler
		// (typing "5", moving the text cursor with arrow keys, etc. must not
		// move the active cell).
		event.stopPropagation();
		if (!editing || editing.pending) {
			event.preventDefault();
			return;
		}
		// IME confirmation/cancellation and keys already handled elsewhere do
		// not own a grid edit command. Some engines report composition as 229
		// even when isComposing is false. Native blur keeps its existing contract.
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
		// Returning from another window need not emit focusin on the editor.
		// A fresh key action on the focused, non-pending draft renews ownership.
		if (editorEl?.ownerDocument.activeElement === event.currentTarget)
			edit.renewFocus(editing.sessionId);
		if (event.key === 'Escape') {
			event.preventDefault();
			const restoreFocus = edit.focusOwned;
			edit.cancel();
			if (restoreFocus) containerEl?.focus({ preventScroll: true });
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			void commitFromEditor(column, row, 'down');
			return;
		}
		if (event.key === 'Tab') {
			event.preventDefault();
			// Reading an existing failure must not retry a rejected API request,
			// even if the user has since changed the draft. Enter retries it.
			if (editing.error) void focusEditError(editing.sessionId);
			else void commitFromEditor(column, row, event.shiftKey ? 'left' : 'right');
			return;
		}
	}

	function handleEditorBlur(event: FocusEvent, column: GridColumn<TRow>, row: TRow) {
		if (!editing || editing.rowId !== getRowId(row) || editing.field !== column.id) return;
		if (
			event.relatedTarget instanceof Node &&
			errorRegionEl?.contains(event.relatedTarget) &&
			errorRegionEl.dataset.editSession === String(editing.sessionId)
		)
			return;
		void commitFromEditor(column, row);
	}

	/**
	 * Grouped-mode counterpart of `rangeToTsv` (spec §4.3): a range spanning a
	 * group header simply skips that line entirely (not an empty TSV line,
	 * unlike a server-mode sparse-array hole) - simplification documented in
	 * the spec itself ("TSV copy of a range spanning a header just skips
	 * that line").
	 */
	function groupedRangeToTsv(range: CellRange): string {
		const entries = groupedEntries!;
		const lines: string[] = [];
		for (let r = range.rowStart; r <= range.rowEnd; r++) {
			const entry = entries[r];
			if (!entry || entry.kind === 'group') continue;
			const cells: string[] = [];
			for (let f = range.fieldStart; f <= range.fieldEnd; f++) {
				const column = gridState.orderedColumns[f];
				if (!column) {
					cells.push('');
					continue;
				}
				const raw = getColumnValue(entry.row, column);
				cells.push(raw === null || raw === undefined ? '' : String(raw));
			}
			lines.push(cells.join('\t'));
		}
		return lines.join('\n');
	}

	// --- Copy / paste (TSV; spec §4.5) ---
	async function copySelection() {
		const range = selection.getRange(orderedFieldIds);
		if (!range) return;
		const text = groupedEntries
			? groupedRangeToTsv(range)
			: rangeToTsv(sorted, gridState.orderedColumns, range, getColumnValue);

		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(text);
				return;
			} catch {
				// fall through to the execCommand fallback below
			}
		}
		// Fallback for webviews without navigator.clipboard (or a rejected
		// write permission): a hidden textarea + execCommand('copy'), which
		// works synchronously with no clipboard-write permission prompt.
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		try {
			document.execCommand('copy');
		} finally {
			document.body.removeChild(textarea);
		}
	}

	// We deliberately use the DOM 'paste' event instead of
	// `navigator.clipboard.readText()`: readText requires a clipboard-read
	// permission grant that isn't available (or is inconsistent) across every
	// target webview (WebView2 / WKWebView / WebKitGTK) and remote-browser
	// mode, whereas the 'paste' event fires on the focused element for a
	// plain Ctrl/Cmd+V with no extra permission.
	function handlePaste(event: ClipboardEvent) {
		if (editing) return; // let the focused editor input's native paste behavior run instead
		// A paste into a header control - the filter popover's value or date
		// boxes - is that control's own, like a bubbled key (handleContainerKeydown).
		if (event.target !== event.currentTarget) return;
		if (!onRangePaste) return;
		if (!selection.active) return;
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (!text) return;
		event.preventDefault();

		const grid = parseTsv(text);
		const orderedColumns = gridState.orderedColumns;
		const startRowIndex = selection.active.rowIndex;
		const startFieldIndex = orderedFieldIds.indexOf(selection.active.field);
		if (startFieldIndex === -1) return;

		const edits: CellEdit<TRow>[] = [];
		let skipped = 0;

		grid.forEach((lineCells, rOffset) => {
			// Grouped mode (spec §4.3): a pasted line landing on a group header
			// row resolves to `undefined` here too (same as a server-mode
			// sparse-array hole), so it falls into the existing skip branch
			// below - consistent with copy's "skip group header lines" rule.
			const row = rowAtDisplayIndex(startRowIndex + rOffset);
			if (!row) {
				skipped += lineCells.length;
				return;
			}
			lineCells.forEach((cellText, fOffset) => {
				const column = orderedColumns[startFieldIndex + fOffset];
				if (!column || !isEditable(column, row)) {
					skipped += 1;
					return;
				}
				const parsed = parseCellInput(cellText, column.editor ?? 'text');
				if (!parsed.ok) {
					skipped += 1;
					return;
				}
				// parseCellInput's 'select' case is a string pass-through (it has
				// no access to column.editorOptions), so a pasted select-column
				// cell needs the same value-type reconciliation the interactive
				// onchange handler gets (see commitFromEditor above) - otherwise a
				// numeric editorOptions value would be committed as a string.
				const value =
					column.editor === 'select'
						? resolveSelectValue(String(parsed.value), column.editorOptions)
						: parsed.value;
				const result = prepareCommit(column, row, getRowId(row), value);
				if (result.kind === 'invalid') {
					skipped += 1;
					return;
				}
				if (result.kind === 'commit') edits.push(result.edit);
				// 'noop' (unchanged value): nothing to do, and not counted as skipped.
			});
		});

		if (edits.length > 0 || skipped > 0) {
			void onRangePaste(edits, { skipped });
		}
	}
</script>

<div class="banto-grid-frame" class:with-bulk-bar={bulkBarVisible} bind:this={frameEl}>
	<div class="row-height-probe" aria-hidden="true" bind:this={rowHeightProbeEl}></div>
	<div
		class="banto-grid"
		class:scrolled-x={scrollLeft > 0}
		bind:this={containerEl}
		role="grid"
		tabindex="0"
		aria-rowcount={effectiveRowCount + 1}
		aria-colcount={gridState.orderedColumns.length + (selectable ? 1 : 0)}
		onscroll={handleScroll}
		onkeydown={handleContainerKeydown}
		onfocusin={handleFocusIn}
		onpaste={handlePaste}
	>
		<div class="scroll-content" role="presentation" style:width={`${totalColumnsWidth}px`}>
			<div
				class="header-row"
				role="row"
				aria-rowindex={1}
				bind:this={headerRowEl}
				style:grid-template-columns={templateColumns}
			>
				{#if selectable}
					<!-- The label and tooltip say which rows the box acts on (#713). -->
					<div class="select-cell select-header" class:pinned={pinActive} role="columnheader">
						<label class="select-hit">
							<input
								type="checkbox"
								class="select-box"
								checked={selectAll === 'all'}
								indeterminate={selectAll === 'some'}
								disabled={selectAllTargets.length === 0}
								aria-label={selectAllLabel}
								title={selectAllLabel}
								onchange={toggleAllSelected}
							/>
						</label>
					</div>
				{/if}
				{#each gridState.orderedColumns as column, fieldIndex (column.id)}
					<HeaderCell
						{column}
						state={gridState}
						width={widthOf(column)}
						pinnedLeft={fieldIndex < stuckCount ? stuckOffsets[fieldIndex] : undefined}
						pinnedEdge={fieldIndex === stuckCount - 1}
						showPriority={showSortPriority}
						onDragStart={handleDragStart}
						onDragMove={handleDragMove}
						onDragEnd={handleDragEnd}
						onSortOrFilterChange={notifyParamsChange}
						{messages}
						dateRangeInput={editors.dateRange}
					/>
				{/each}
			</div>

			{#if dropIndicatorX !== null}
				<div
					class="drop-indicator"
					style:left={`${dropIndicatorX}px`}
					style:height={`${headerHeight + windowResult.totalHeight}px`}
				></div>
			{/if}

			{#snippet dataRow(row: TRow, rowIndex: number)}
				<div
					class="row {rowClass?.(row) ?? ''}"
					class:selected={selectable && isRowSelected(row)}
					role="row"
					aria-rowindex={rowIndex + 2}
					style:grid-template-columns={templateColumns}
					style:height={`${gridState.rowHeight}px`}
					style:--banto-grid-editor-height={`min(var(--banto-control-height), calc(${gridState.rowHeight}px - var(--banto-border-width)))`}
				>
					{#if selectable}
						<!--
						Row selection (#713). The row's selected state is the checkbox's
						checked state, not `aria-selected`: on this grid `aria-selected`
						belongs to the cells of the copy / paste range, and a second
						meaning on the row would contradict it. The box is a real tab
						stop (like a row link), so it works without an active cell;
						Space on the active cell is the other keyboard path.
						-->
						<!-- svelte-ignore a11y_interactive_supports_focus -->
						<div
							class="select-cell"
							class:pinned={pinActive}
							role="gridcell"
							onpointerdown={(event) => handleSelectPointerDown(event, rowIndex)}
							onmousedown={(event) => event.preventDefault()}
						>
							<label class="select-hit">
								<input
									type="checkbox"
									class="select-box"
									checked={isRowSelected(row)}
									aria-label={t.selectRowLabel(rowLabelFor(row))}
									onchange={() => toggleRowSelected(row)}
								/>
							</label>
						</div>
					{/if}
					{#each gridState.orderedColumns as column, fieldIndex (column.id)}
						{@const isActiveCell =
							selection.active?.rowIndex === rowIndex && selection.active?.field === column.id}
						{@const isInRange = selection.isSelected(rowIndex, fieldIndex, orderedFieldIds)}
						{@const isEditingCell =
							editing?.rowId === getRowId(row) && editing?.field === column.id}
						{@const linkInfo = column.cell?.(row)}
						<!-- `render` draws its own content; `cell` and an editing cell never use the
						     view, so only the tone is resolved (no format / href call). Only the
						     `{:else}` branch below reads `presentation!`. -->
						{@const viewless = !!column.render || !!linkInfo || isEditingCell}
						{@const presentation = viewless ? null : resolveCellPresentation(column, row)}
						{@const tone = presentation
							? presentation.tone
							: column.render
								? null
								: resolveTone(column, row)}
						<!--
						Keyboard focus/activation for cells is handled at the grid
						container level (roving "virtual" focus via `selection.active`
						+ handleContainerKeydown), not per-cell DOM focus/tabindex:
						row/cell DOM nodes come and go under virtualization, so a
						literal per-cell tabindex would be meaningless as soon as a
						row scrolls out. Mouse users still get click/dblclick here.
					-->
						<!-- svelte-ignore a11y_interactive_supports_focus -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div
							class="cell"
							role="gridcell"
							aria-selected={isInRange}
							aria-busy={isEditingCell ? !!editing?.pending : undefined}
							data-cell-row={rowIndex}
							data-cell-field={column.id}
							data-tone={tone ?? undefined}
							style:justify-content={justifyFor(column.align)}
							style:left={fieldIndex < stuckCount ? `${stuckOffsets[fieldIndex]}px` : undefined}
							class:pinned={fieldIndex < stuckCount}
							class:pinned-edge={fieldIndex === stuckCount - 1}
							class:active={isActiveCell}
							class:in-range={isInRange && !isActiveCell}
							class:editing={isEditingCell}
							class:error={isEditingCell && !!editing?.error}
							onpointerdown={(event) => handleCellPointerDown(event, rowIndex, column.id)}
							onmousedown={(event) => handleCellMouseDown(event, rowIndex, column.id, row)}
							onclickcapture={(event) => handleCellClickCapture(event, rowIndex, column.id, row)}
							onclick={() => handleCellClick(rowIndex, column, row)}
							oncontextmenu={(event) => handleCellContextMenu(event, rowIndex, column.id, row)}
							ondblclick={() => handleCellDoubleClick(rowIndex, column, row)}
						>
							{#if column.render}
								{@render column.render(row)}
							{:else if linkInfo}
								{#if linkInfo.href}
									<a
										class="cell-link"
										href={linkInfo.href}
										onclick={(event) => event.stopPropagation()}
										ondblclick={(event) => event.stopPropagation()}
									>
										{linkInfo.text}
									</a>
								{:else}
									{linkInfo.text}
								{/if}
							{:else if isEditingCell && editing}
								<!-- `editing?.`: Esc / a commit can end the session and move focus
								     synchronously, before this block is removed - an injected editor
								     reads its props in its own blur (date-time-pickers §5.8). -->
								<CellEditor
									editor={column.editor}
									label={column.header.trim() || column.id}
									invalid={!!editing?.error}
									describedBy={editing?.error ? editErrorId : undefined}
									pending={!!editing?.pending}
									draft={editing?.draft}
									options={column.editorOptions}
									dateEditor={editors.date}
									timeEditor={editors.time}
									dateTimeEditor={editors.datetime}
									min={column.editorMin}
									max={column.editorMax}
									isDateDisabled={column.isDateDisabled}
									step={column.editorStep}
									bind:editorEl
									bind:editorRootEl
									onDraftChange={(value) => {
										edit.setDraft(value);
									}}
									onToggle={(checked) => handleCheckboxToggle(column, row, checked)}
									onKeydown={(event) => handleEditorKeydown(event, column, row)}
									onBlur={(event) => handleEditorBlur(event, column, row)}
								/>
							{:else}
								{@const view = presentation!.view}
								{#if view.kind === 'badge'}
									<span class="cell-badge">{view.text}</span>
								{:else if view.kind === 'progress'}
									<span class="cell-progress">
										<span
											class="cell-progress-track"
											role="progressbar"
											aria-label={column.header.trim() || column.id}
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={Math.round(view.ratio * 100)}
											aria-valuetext={view.text}
										>
											<span class="cell-progress-bar" style:width={`${view.ratio * 100}%`}></span>
										</span>
										<span class="cell-progress-text" aria-hidden="true">{view.text}</span>
									</span>
								{:else if view.kind === 'boolean'}
									<span class="cell-boolean">
										<span aria-hidden="true">{view.checked ? '✓' : ''}</span>
										<span class="cell-sr-only">
											{view.checked ? t.booleanTrue() : t.booleanFalse()}
										</span>
									</span>
								{:else if view.kind === 'link'}
									<a
										class="cell-link"
										href={view.href}
										onclick={(event) => event.stopPropagation()}
										ondblclick={(event) => event.stopPropagation()}
									>
										{view.text}
									</a>
								{:else}
									{view.text}
								{/if}
							{/if}
						</div>
					{/each}
				</div>
			{/snippet}

			{#if effectiveRowCount === 0}
				<div class="empty-row">{t.emptyState()}</div>
			{:else}
				<div
					class="rows-viewport"
					role="presentation"
					style:height={`${windowResult.totalHeight}px`}
				>
					<div
						class="rows-block"
						role="rowgroup"
						style:transform={`translateY(${windowResult.offsetY}px)`}
					>
						{#if groupedEntries}
							<!-- Client mode, grouped (spec §4.3): group headers + rows flattened by buildGroupedView. -->
							{#each visibleEntries as entry, i (entryKeyFor(entry))}
								{@const rowIndex = windowResult.start + i}
								{#if entry.kind === 'group'}
									<!--
									role="row" (not "button"): this is still a grid row
									semantically (spec §4.3 asks for role="row" +
									aria-expanded), just one that toggles on click/Enter/
									Space. Keyboard activation goes through the container's
									existing roving-focus keydown handler (same pattern as
									the per-cell divs above), not a per-element tabindex, so
									the interactive-role a11y lint is suppressed rather than
									"fixed" by adding a real tabindex here.
								-->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_interactive_supports_focus -->
									<div
										class="row group-header-row"
										role="row"
										aria-rowindex={rowIndex + 2}
										aria-expanded={!entry.collapsed}
										style:height={`${gridState.rowHeight}px`}
										onclick={() => handleGroupHeaderClick(rowIndex, entry.key)}
									>
										<!-- With pinned columns (#713) the heading stays at the left edge
										     while the rows scroll sideways, like the pinned cells do. -->
										<span class="group-header-content" class:stuck={pinActive}>
											<span class="disclosure" aria-hidden="true">
												{entry.collapsed ? '▸' : '▾'}
											</span>
											<span class="group-label">
												{entry.label}{t.groupCountSuffix(entry.count.toLocaleString())}
											</span>
											{#each gridState.orderedColumns.filter((c) => c.aggregate) as aggColumn (aggColumn.id)}
												<span class="agg-chip">
													{aggColumn.header}: {entry.aggregates[aggColumn.id] ?? ''}
												</span>
											{/each}
										</span>
									</div>
								{:else}
									{@render dataRow(entry.row, rowIndex)}
								{/if}
							{/each}
						{:else}
							{#each visibleRows as row, i (rowKeyFor(row, windowResult.start + i))}
								{@const rowIndex = windowResult.start + i}
								{#if row === undefined}
									<!--
									Server mode (spec §4.1, M5): this absolute row
									index hasn't been fetched yet (a hole in the
									sparse `rows` array) - render an inert
									placeholder at the right height so the
									scrollbar/virtualization math stays correct,
									with no click/edit interactions and its content
									hidden from assistive tech (there's nothing
									meaningful to announce yet).
								-->
									<div
										class="row placeholder-row"
										role="row"
										aria-rowindex={rowIndex + 2}
										aria-hidden="true"
										style:grid-template-columns={templateColumns}
										style:height={`${gridState.rowHeight}px`}
									>
										{#if selectable}<div class="select-cell" class:pinned={pinActive}></div>{/if}
										{#each gridState.orderedColumns as column, fieldIndex (column.id)}
											<div
												class="cell placeholder-cell"
												class:pinned={fieldIndex < stuckCount}
												class:pinned-edge={fieldIndex === stuckCount - 1}
												style:justify-content={justifyFor(column.align)}
												style:left={fieldIndex < stuckCount
													? `${stuckOffsets[fieldIndex]}px`
													: undefined}
											>
												{#if fieldIndex === 0}…{/if}
											</div>
										{/each}
									</div>
								{:else}
									{@render dataRow(row, rowIndex)}
								{/if}
							{/each}
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
	{#if editing?.error}
		<CellEditError
			frame={frameEl}
			grid={containerEl}
			editor={editorEl}
			bind:element={errorRegionEl}
			sessionId={editing.sessionId}
			anchorLayout={`${editingRowIndex}:${orderedFieldIds.indexOf(editing.field)}:${templateColumns}:${headerHeight}`}
			errorId={editErrorId}
			message={editing.error}
			label={t.inlineEditErrorLabel(
				gridState.columns.find((column) => column.id === editing?.field)?.header.trim() ||
					editing.field
			)}
			hint={t.inlineEditErrorHint()}
			onReturn={returnFromEditError}
		/>
	{/if}
	{#if selectable}
		<div class="cell-sr-only" role="status" aria-live="polite">{selectionAnnouncement}</div>
		{#if bulkBarVisible}
			<!-- Under the grid, so the rows do not move when it appears (#713). -->
			<div
				class="bulk-bar"
				role="group"
				aria-label={t.bulkBarLabel()}
				tabindex="-1"
				bind:this={bulkBarEl}
				onfocusin={handleBulkBarFocusIn}
				onfocusout={handleBulkBarFocusOut}
			>
				<span class="bulk-count">
					{allMatching
						? t.allMatchingStatus(matchingCount)
						: t.selectionStatus(selectedRowIds.length)}
				</span>
				{#if offerAllMatching}
					<!-- Server mode: widen "every loaded row" to every row the filters match. -->
					<button type="button" class="bulk-all" onclick={enterAllMatching}>
						{t.selectAllMatching(matchingCount)}
					</button>
				{/if}
				{#if bulkActions}
					<span class="bulk-actions">
						{@render bulkActions({
							ids: selectedRowIds,
							clear: clearSelectedRows,
							allMatching,
							matchingCount
						})}
					</span>
				{/if}
				<button type="button" class="bulk-clear" onclick={clearSelectedRows}>
					{t.selectionClear()}
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.banto-grid-frame {
		position: relative;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	/* Row selection (#713): only while the bulk bar is shown does the frame
	   stack the grid and the bar; without it the layout is untouched. */
	.banto-grid-frame.with-bulk-bar {
		display: flex;
		flex-direction: column;
	}
	.banto-grid-frame.with-bulk-bar > .banto-grid {
		flex: 1 1 auto;
		height: auto;
		min-height: 0;
	}
	.row-height-probe {
		position: absolute;
		inset-block-start: 0;
		inset-inline-start: 0;
		width: 0;
		height: var(--banto-grid-row-height);
		visibility: hidden;
		pointer-events: none;
	}
	.banto-grid {
		position: relative;
		height: 100%;
		width: 100%;
		overflow: auto;
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
		font-size: var(--banto-font-size-md);
	}

	.banto-grid:focus {
		outline: none;
	}

	.banto-grid:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: calc(-1 * var(--banto-border-width-strong, 2px));
	}

	@media (forced-colors: active) {
		.banto-grid:focus-visible {
			outline-color: Highlight;
		}

		.cell.in-range {
			outline: var(--banto-border-width-strong, 2px) dashed Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong, 2px));
		}

		/* Shadows are dropped in forced colours: mark the pinned boundary with a line. */
		.banto-grid.scrolled-x .cell.pinned-edge {
			border-right: var(--banto-border-width) solid CanvasText;
		}
	}

	.scroll-content {
		min-width: 100%;
		position: relative;
	}

	.header-row {
		position: sticky;
		top: 0;
		z-index: 10;
		display: grid;
		height: var(--banto-grid-header-height);
		background: var(--banto-surface-subtle);
		border-bottom: var(--banto-border-width) solid var(--banto-border-strong);
	}

	.drop-indicator {
		position: absolute;
		top: 0;
		/* Above the header row and the pinned cells (#713), which are opaque. */
		z-index: 11;
		width: 2px;
		background: var(--banto-primary);
		pointer-events: none;
	}

	.rows-viewport {
		position: relative;
	}

	.rows-block {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
	}

	.row {
		display: grid;
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		box-sizing: border-box;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* `--row-overlay` repeats the row's state colour for the pinned cells
	   (#713), which are opaque and would otherwise hide it. */
	.row:hover {
		--row-overlay: var(--banto-surface-hover);
		background: var(--row-overlay);
	}

	.row.selected {
		--row-overlay: color-mix(in srgb, var(--banto-primary) 8%, transparent);
		background: var(--row-overlay);
	}

	.row.selected:hover {
		--row-overlay: color-mix(in srgb, var(--banto-primary) 14%, transparent);
		background: var(--row-overlay);
	}

	/* Server mode (spec §4.1, M5): a not-yet-fetched sparse-array hole. */
	.placeholder-row:hover {
		--row-overlay: transparent;
		background: none;
	}

	/* Row selection (#713): the checkbox column (header, rows, placeholders). */
	.select-cell {
		display: flex;
		align-items: stretch;
		justify-content: center;
		min-width: 0;
	}

	.select-hit {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		cursor: pointer;
	}

	/* Native checkbox styling remains local for standalone package consumers. */
	.select-box {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		margin: 0;
		flex-shrink: 0;
		accent-color: var(--banto-primary);
		cursor: pointer;
	}

	.select-box:disabled {
		cursor: default;
	}

	.select-box:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: var(--banto-border-width, 1px);
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-sm);
	}

	.bulk-bar {
		display: flex;
		flex: none;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
		box-sizing: border-box;
		min-height: var(--banto-control-height);
		margin-top: var(--banto-space-1);
		padding: var(--banto-space-1) var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: calc(var(--banto-radius) * 2);
		background: var(--banto-surface-subtle);
		color: var(--banto-text);
		font-size: var(--banto-font-size-sm);
	}

	.bulk-count {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.bulk-actions {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.bulk-all,
	.bulk-clear {
		height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-2);
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		font-size: var(--banto-font-size-sm);
		text-decoration: underline;
		cursor: pointer;
	}

	.bulk-all {
		color: var(--banto-primary-text);
	}

	.bulk-clear {
		margin-inline-start: auto;
		color: var(--banto-text-muted);
	}

	.bulk-clear:hover {
		color: var(--banto-text);
	}

	.bulk-bar:focus-visible,
	.bulk-all:focus-visible,
	.bulk-clear:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.placeholder-cell {
		display: flex;
		align-items: center;
		padding: 0 var(--banto-space-2);
		color: var(--banto-text-muted);
		user-select: none;
	}

	/* Client-mode grouping (spec §4.3): a collapsible group header row, spanning full width (overrides .row's `display: grid`). */
	.group-header-row {
		display: flex;
		align-items: center;
		padding: 0 var(--banto-space-2);
		background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
		font-weight: 600;
		cursor: pointer;
		user-select: none;
	}

	.group-header-row:hover {
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
	}

	.group-header-content {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		min-width: 0;
	}

	/* Pinned columns (#713): keep the heading in view during a sideways scroll
	   (the offset is the row's own padding). */
	.group-header-content.stuck {
		position: sticky;
		left: var(--banto-space-2);
	}

	.disclosure {
		width: 1em;
		flex: 0 0 auto;
		text-align: center;
		color: var(--banto-primary-text);
	}

	.group-label {
		flex: 0 0 auto;
	}

	.agg-chip {
		font-weight: 400;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: 999px;
		padding: var(--banto-space-1) var(--banto-space-2);
		white-space: nowrap;
	}

	.cell {
		position: relative;
		padding: 0 var(--banto-space-2);
		display: flex;
		align-items: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--banto-text);
		font-variant-numeric: tabular-nums;
	}

	.cell.active {
		outline: var(--banto-border-width-strong) solid var(--banto-primary);
		outline-offset: calc(-1 * var(--banto-border-width-strong));
		z-index: 1;
	}

	.cell.in-range {
		background: color-mix(in srgb, var(--banto-primary) 12%, transparent);
	}

	/* Editing uses the solid primary (vs. active's text-toned primary) so the
	   two states stay visually distinct within the same primary family. */
	.cell.editing {
		padding: 0;
		overflow: visible;
		z-index: 2;
		outline: var(--banto-border-width-strong) solid var(--banto-primary-solid);
		outline-offset: calc(-1 * var(--banto-border-width-strong));
		background: var(--banto-surface);
	}

	.cell.editing.error {
		outline: var(--banto-border-width-strong) solid var(--banto-danger-solid);
		outline-offset: calc(-1 * var(--banto-border-width-strong));
	}

	/*
	 * Pinned columns (#713). A pinned cell sticks to the left edge (`left` is
	 * set inline, from `pinnedOffsets`) and is opaque, so the cells scrolling
	 * under it do not show through: the grid surface, plus the row's and the
	 * cell's own state colours as layers. Stacking inside the rows: unpinned
	 * cell < active (1) < editing (2) < pinned (3) < pinned + editing (4), so
	 * an editor or an outline of a scrolled cell never covers the pinned block.
	 * After the rules above on purpose: same specificity, later wins.
	 */
	.cell.pinned,
	.select-cell.pinned {
		position: sticky;
		z-index: 3;
		background:
			linear-gradient(var(--cell-overlay, transparent), var(--cell-overlay, transparent)),
			linear-gradient(var(--row-overlay, transparent), var(--row-overlay, transparent)),
			var(--banto-surface);
	}

	.select-cell.pinned {
		left: 0;
	}

	/* The header row is its own stacking context (above the rows) and has the
	   subtle surface; 2 clears the neighbours' resize handles (1). */
	.select-header.pinned {
		z-index: 2;
		background: var(--banto-surface-subtle);
	}

	.cell.pinned.in-range {
		--cell-overlay: color-mix(in srgb, var(--banto-primary) 12%, transparent);
	}

	.cell.pinned.editing {
		z-index: 4;
		background: var(--banto-surface);
	}

	/* The boundary shadow, only while the grid is scrolled sideways. */
	.banto-grid.scrolled-x .cell.pinned-edge {
		box-shadow: var(--banto-grid-pinned-shadow);
	}

	.cell-link {
		/* --banto-primary text on the cell background falls short of 4.5:1 on
		   the dark theme (~4.38:1). --banto-primary-hover is the same
		   already-defined token used for this exact contrast bump elsewhere
		   (e.g. Sidebar.svelte's active nav-item text): light #1d4ed8 = 6.7:1,
		   dark #60a5fa = 6.3:1. */
		color: var(--banto-primary-hover);
		text-decoration: none;
	}

	.cell-link:hover {
		text-decoration: underline;
	}

	/* Conditional format (#713): state tokens only. --banto-<state> are the
	   text-grade hues; a badge swaps to the -tint pair. */
	.cell[data-tone='success'] {
		--cell-tone: var(--banto-success);
		--cell-tint: var(--banto-success-tint);
		--cell-tint-text: var(--banto-success-tint-text);
	}
	.cell[data-tone='warning'] {
		--cell-tone: var(--banto-warning);
		--cell-tint: var(--banto-warning-tint);
		--cell-tint-text: var(--banto-warning-tint-text);
	}
	.cell[data-tone='danger'] {
		--cell-tone: var(--banto-danger);
		--cell-tint: var(--banto-danger-tint);
		--cell-tint-text: var(--banto-danger-tint-text);
	}
	.cell[data-tone='info'] {
		--cell-tone: var(--banto-info);
		--cell-tint: var(--banto-info-tint);
		--cell-tint-text: var(--banto-info-tint-text);
	}
	.cell[data-tone='neutral'] {
		--cell-tone: var(--banto-text-muted);
		--cell-tint: var(--banto-surface-subtle);
		--cell-tint-text: var(--banto-text-muted);
	}
	.cell[data-tone] {
		color: var(--cell-tone);
	}

	.cell-badge {
		display: inline-block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 0 var(--banto-space-2);
		border-radius: 999px;
		font-size: var(--banto-font-size-xs);
		line-height: 1.5;
		background: var(--cell-tint, var(--banto-surface-subtle));
		color: var(--cell-tint-text, var(--banto-text-muted));
	}

	.cell-progress {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		width: 100%;
	}
	.cell-progress-track {
		flex: 1;
		min-width: 2rem;
		height: 0.5rem;
		border-radius: 999px;
		overflow: hidden;
		background: var(--banto-surface-subtle);
	}
	.cell-progress-bar {
		display: block;
		height: 100%;
		background: var(--cell-tone, var(--banto-primary));
	}
	.cell-progress-text {
		flex: none;
		font-size: var(--banto-font-size-xs);
	}

	.cell-boolean {
		font-weight: 600;
	}
	/* Visually hidden, still read (the boolean's yes / no). */
	.cell-sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.empty-row {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 8rem;
		padding: var(--banto-space-6);
		text-align: center;
		color: var(--banto-text-muted);
	}
</style>
