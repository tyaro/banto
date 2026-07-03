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
	import { DEFAULT_COLUMN_WIDTH, type CellEdit, type GridColumn } from './types';
	import { GridState } from './state.svelte';
	import { CellSelection } from './selection.svelte';
	import { getColumnValue, sortRows } from './core/sort';
	import { filterRows } from './core/filter';
	import { computeWindow } from './core/virtual';
	import { parseCellInput, parseTsv, rangeToTsv } from './core/clipboard';
	import { prepareCommit } from './core/edit';
	import HeaderCell from './HeaderCell.svelte';

	interface Props {
		rows: TRow[];
		columns: GridColumn<TRow>[];
		state?: GridState<TRow>;
		getRowId: (row: TRow) => string | number;
		rowHeight?: number;
		onRowClick?: (row: TRow) => void;
		onCellEdit?: (edit: CellEdit<TRow>) => void | Promise<void>;
		onRangePaste?: (edits: CellEdit<TRow>[], info: { skipped: number }) => void | Promise<void>;
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
		onRowClick,
		onCellEdit,
		onRangePaste
	}: Props = $props();

	// Created once per component instance. If the caller passes `state`, that
	// instance is the single source of truth (including its own rowHeight);
	// otherwise we own one internally, seeded from the `rowHeight` prop.
	// Capturing only the initial prop values here is by design.
	// svelte-ignore state_referenced_locally
	const gridState: GridState<TRow> = externalState ?? new GridState(columns, { rowHeight });

	const OVERSCAN = 8;

	let containerEl: HTMLDivElement | undefined = $state();
	let headerRowEl: HTMLDivElement | undefined = $state();
	let editorEl: HTMLInputElement | HTMLSelectElement | undefined = $state();

	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	let headerHeight = $state(40);

	$effect(() => {
		if (!containerEl) return;
		viewportHeight = containerEl.clientHeight;
		const observer = new ResizeObserver(() => {
			viewportHeight = containerEl!.clientHeight;
		});
		observer.observe(containerEl);
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

	// Focus the editor input/select whenever an edit session (re)starts, or
	// re-enters after a failed commit (a new `editing` object is assigned in
	// both cases). Re-selecting text on every reassignment (including the
	// error path) is intentional: it keeps the invalid input selected so the
	// user can immediately retype.
	$effect(() => {
		if (editing && editorEl) {
			editorEl.focus();
			if (editorEl instanceof HTMLInputElement && editorEl.type !== 'checkbox') {
				editorEl.select();
			}
		}
	});

	function handleScroll(event: Event) {
		scrollTop = (event.currentTarget as HTMLDivElement).scrollTop;
	}

	const filtered = $derived(filterRows(rows, gridState.filters, columns));
	const sorted = $derived(sortRows(filtered, gridState.sort, columns));

	const rowsViewportHeight = $derived(Math.max(0, viewportHeight - headerHeight));
	const effectiveScrollTop = $derived(Math.max(0, scrollTop - headerHeight));

	const windowResult = $derived(
		computeWindow({
			scrollTop: effectiveScrollTop,
			viewportHeight: rowsViewportHeight,
			rowHeight: gridState.rowHeight,
			rowCount: sorted.length,
			overscan: OVERSCAN
		})
	);

	const visibleRows = $derived(sorted.slice(windowResult.start, windowResult.end));

	const showSortPriority = $derived(gridState.sort.length > 1);

	function widthOf(column: GridColumn<TRow>): number {
		return gridState.widths[column.id] ?? column.width ?? DEFAULT_COLUMN_WIDTH;
	}

	const templateColumns = $derived(
		gridState.orderedColumns.map((column) => `${widthOf(column)}px`).join(' ')
	);
	const totalColumnsWidth = $derived(
		gridState.orderedColumns.reduce((sum, column) => sum + widthOf(column), 0)
	);
	const orderedFieldIds = $derived(gridState.orderedColumns.map((column) => column.id));

	function renderCell(column: GridColumn<TRow>, row: TRow): string {
		const raw = getColumnValue(row, column);
		if (column.format) return column.format(raw, row);
		if (raw === null || raw === undefined) return '';
		return String(raw);
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
		dropIndex = gridState.order.indexOf(columnId);
	}

	function handleDragMove(clientX: number) {
		if (!headerRowEl) return;
		const rect = headerRowEl.getBoundingClientRect();
		const x = clientX - rect.left;
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
		dropIndex = index;
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
		let x = 0;
		const cols = gridState.orderedColumns;
		for (let i = 0; i < dropIndex && i < cols.length; i++) {
			x += widthOf(cols[i]);
		}
		return x;
	});

	// --- Cell selection / navigation (spec §4.5) ---
	const selection = new CellSelection();

	/** Any column that could ever be editable switches the row-open interaction (see handleCellClick/handleCellDoubleClick below). */
	const hasEditableColumns = $derived(columns.some((column) => Boolean(column.editable)));

	function isEditable(column: GridColumn<TRow>, row: TRow): boolean {
		return typeof column.editable === 'function' ? column.editable(row) : column.editable === true;
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
		let x = 0;
		for (let i = 0; i < fieldIndex; i++) x += widthOf(gridState.orderedColumns[i]);
		const w = widthOf(gridState.orderedColumns[fieldIndex]);
		if (x < containerEl.scrollLeft) {
			containerEl.scrollLeft = x;
		} else if (x + w > containerEl.scrollLeft + containerEl.clientWidth) {
			containerEl.scrollLeft = x + w - containerEl.clientWidth;
		}
	}

	function handleCellPointerDown(event: PointerEvent, rowIndex: number, field: string) {
		if (event.button !== 0) return;
		// Move real DOM focus to the grid container so keyboard navigation
		// keeps working after a click. This synchronously blurs whatever was
		// previously focused (e.g. another cell's editor <input>), which is
		// exactly the "blur commits" behavior we want (spec §4.5).
		containerEl?.focus();
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
		function onUp(upEvent: PointerEvent) {
			if (upEvent.pointerId !== pointerId) return;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// Single click: select the cell (already done on pointerdown above); for
	// grids with no editable columns at all, also preserve the M2 row-click
	// behavior. For grids with editable columns, opening a record needs a
	// dedicated affordance instead (see the items page's `cell` link column
	// and the double-click handler below), so a plain click never fires
	// onRowClick there.
	function handleCellClick(row: TRow) {
		if (!hasEditableColumns) onRowClick?.(row);
	}

	function handleCellDoubleClick(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		if (isEditable(column, row)) {
			startEditing(rowIndex, column, row);
		} else if (hasEditableColumns) {
			onRowClick?.(row);
		}
	}

	// --- Keyboard navigation (grid container; spec §4.5, §4.7) ---
	function handleContainerKeydown(event: KeyboardEvent) {
		// While editing, the editor input/select's own onkeydown owns Escape/
		// Enter/Tab/typing and stops propagation for every key, so this never
		// runs; the guard is a defensive no-op if that ever changes.
		if (editing) return;
		if (!selection.active) return;

		const rowCount = sorted.length;
		const activeColumn = gridState.orderedColumns.find((c) => c.id === selection.active!.field);
		const activeRow = sorted[selection.active!.rowIndex];

		switch (event.key) {
			case 'ArrowUp':
				event.preventDefault();
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
				selection.moveActive(0, -1, event.shiftKey, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			case 'ArrowRight':
				event.preventDefault();
				selection.moveActive(0, 1, event.shiftKey, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			case 'Tab':
				event.preventDefault();
				selection.moveActive(0, event.shiftKey ? -1 : 1, false, rowCount, orderedFieldIds);
				scrollActiveIntoView();
				break;
			case 'Home':
				event.preventDefault();
				selection.setActive(selection.active.rowIndex, orderedFieldIds[0], false);
				scrollActiveIntoView();
				break;
			case 'End':
				event.preventDefault();
				selection.setActive(selection.active.rowIndex, orderedFieldIds[orderedFieldIds.length - 1], false);
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
				if (!activeColumn || !activeRow) break;
				if (isEditable(activeColumn, activeRow)) {
					startEditing(selection.active.rowIndex, activeColumn, activeRow);
				} else if (!hasEditableColumns && onRowClick) {
					onRowClick(activeRow);
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
			case ' ':
				if (!hasEditableColumns && onRowClick && activeRow) {
					event.preventDefault();
					onRowClick(activeRow);
				}
				break;
			default:
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
					event.preventDefault();
					void copySelection();
				}
				break;
		}
	}

	// --- Inline editing (spec §4.5) ---
	interface EditingState {
		rowIndex: number;
		field: string;
		draft: unknown;
		error: string | null;
		pending: boolean;
	}

	let editing: EditingState | null = $state(null);

	function startEditing(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		if (!isEditable(column, row)) return;
		editing = { rowIndex, field: column.id, draft: getColumnValue(row, column), error: null, pending: false };
	}

	/** Runs prepareCommit and, if it decides to commit, awaits onCellEdit. Returns whether the edit session should close. */
	async function commitValue(
		rowIndex: number,
		column: GridColumn<TRow>,
		row: TRow,
		value: unknown
	): Promise<boolean> {
		const rowId = getRowId(row);
		const result = prepareCommit(column, row, rowId, value);

		if (result.kind === 'noop') {
			editing = null;
			return true;
		}
		if (result.kind === 'invalid') {
			editing = { rowIndex, field: column.id, draft: value, error: result.message, pending: false };
			return false;
		}

		if (!onCellEdit) {
			editing = null;
			return true;
		}
		editing = { rowIndex, field: column.id, draft: value, error: null, pending: true };
		try {
			await onCellEdit(result.edit);
			editing = null;
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			editing = { rowIndex, field: column.id, draft: value, error: message, pending: false };
			return false;
		}
	}

	/** Parse the current draft text and commit; optionally move the active cell afterward on success. */
	async function commitFromEditor(
		rowIndex: number,
		column: GridColumn<TRow>,
		row: TRow,
		moveAfter?: 'down' | 'left' | 'right'
	) {
		if (!editing || editing.pending) return;
		const editorType = column.editor ?? 'text';
		const parsed = parseCellInput(String(editing.draft ?? ''), editorType);
		if (!parsed.ok) {
			editing = { ...editing, error: '入力値が不正です' };
			return;
		}
		const closed = await commitValue(rowIndex, column, row, parsed.value);
		if (closed && moveAfter) {
			const rowCount = sorted.length;
			if (moveAfter === 'down') selection.moveActive(1, 0, false, rowCount, orderedFieldIds);
			else if (moveAfter === 'left') selection.moveActive(0, -1, false, rowCount, orderedFieldIds);
			else selection.moveActive(0, 1, false, rowCount, orderedFieldIds);
			scrollActiveIntoView();
		}
	}

	function handleCheckboxToggle(rowIndex: number, column: GridColumn<TRow>, row: TRow, checked: boolean) {
		if (!editing || editing.pending) return;
		void commitValue(rowIndex, column, row, checked);
	}

	function handleEditorKeydown(event: KeyboardEvent, rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		// Stop every key from bubbling to the container's navigation handler
		// (typing "5", moving the text cursor with arrow keys, etc. must not
		// move the active cell).
		event.stopPropagation();
		if (!editing || editing.pending) {
			event.preventDefault();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			editing = null;
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			void commitFromEditor(rowIndex, column, row, 'down');
			return;
		}
		if (event.key === 'Tab') {
			event.preventDefault();
			void commitFromEditor(rowIndex, column, row, event.shiftKey ? 'left' : 'right');
			return;
		}
	}

	function handleEditorBlur(rowIndex: number, column: GridColumn<TRow>, row: TRow) {
		if (!editing || editing.rowIndex !== rowIndex || editing.field !== column.id) return;
		void commitFromEditor(rowIndex, column, row);
	}

	// --- Copy / paste (TSV; spec §4.5) ---
	async function copySelection() {
		const range = selection.getRange(orderedFieldIds);
		if (!range) return;
		const text = rangeToTsv(sorted, gridState.orderedColumns, range, getColumnValue);

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
			const row = sorted[startRowIndex + rOffset];
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
				const result = prepareCommit(column, row, getRowId(row), parsed.value);
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

<div
	class="banto-grid"
	bind:this={containerEl}
	role="grid"
	tabindex="0"
	aria-rowcount={sorted.length + 1}
	aria-colcount={gridState.orderedColumns.length}
	onscroll={handleScroll}
	onkeydown={handleContainerKeydown}
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
			{#each gridState.orderedColumns as column (column.id)}
				<HeaderCell
					{column}
					state={gridState}
					width={widthOf(column)}
					showPriority={showSortPriority}
					onDragStart={handleDragStart}
					onDragMove={handleDragMove}
					onDragEnd={handleDragEnd}
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

		{#if sorted.length === 0}
			<div class="empty-row">データがありません</div>
		{:else}
			<div class="rows-viewport" role="presentation" style:height={`${windowResult.totalHeight}px`}>
				<div
					class="rows-block"
					role="rowgroup"
					style:transform={`translateY(${windowResult.offsetY}px)`}
				>
					{#each visibleRows as row, i (getRowId(row))}
						{@const rowIndex = windowResult.start + i}
						<div
							class="row"
							role="row"
							aria-rowindex={rowIndex + 2}
							style:grid-template-columns={templateColumns}
							style:height={`${gridState.rowHeight}px`}
						>
							{#each gridState.orderedColumns as column, fieldIndex (column.id)}
								{@const isActiveCell = selection.active?.rowIndex === rowIndex && selection.active?.field === column.id}
								{@const isInRange = selection.isSelected(rowIndex, fieldIndex, orderedFieldIds)}
								{@const isEditingCell = editing?.rowIndex === rowIndex && editing?.field === column.id}
								{@const linkInfo = column.cell?.(row)}
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
									data-cell-row={rowIndex}
									data-cell-field={column.id}
									style:justify-content={justifyFor(column.align)}
									class:active={isActiveCell}
									class:in-range={isInRange && !isActiveCell}
									class:editing={isEditingCell}
									class:error={isEditingCell && !!editing?.error}
									onpointerdown={(event) => handleCellPointerDown(event, rowIndex, column.id)}
									onclick={() => handleCellClick(row)}
									ondblclick={() => handleCellDoubleClick(rowIndex, column, row)}
								>
									{#if linkInfo}
										{#if linkInfo.href}
											<a
												class="cell-link"
												href={linkInfo.href}
												onclick={(event) => event.stopPropagation()}
												ondblclick={(event) => event.stopPropagation()}
											>{linkInfo.text}</a>
										{:else}
											{linkInfo.text}
										{/if}
									{:else if isEditingCell && editing}
										{#if (column.editor ?? 'text') === 'select'}
											<select
												bind:this={editorEl}
												class="cell-editor"
												class:pending={editing.pending}
												value={String(editing.draft ?? '')}
												onpointerdown={(event) => event.stopPropagation()}
												onchange={(event) => {
													if (editing) editing.draft = event.currentTarget.value;
												}}
												onkeydown={(event) => handleEditorKeydown(event, rowIndex, column, row)}
												onblur={() => handleEditorBlur(rowIndex, column, row)}
											>
												{#each column.editorOptions ?? [] as option (option.value)}
													<option value={String(option.value)}>{option.label}</option>
												{/each}
											</select>
										{:else if (column.editor ?? 'text') === 'checkbox'}
											<input
												type="checkbox"
												bind:this={editorEl}
												class="cell-editor"
												class:pending={editing.pending}
												checked={!!editing.draft}
												onpointerdown={(event) => event.stopPropagation()}
												onclick={(event) => event.stopPropagation()}
												onchange={(event) =>
													handleCheckboxToggle(rowIndex, column, row, event.currentTarget.checked)}
												onkeydown={(event) => handleEditorKeydown(event, rowIndex, column, row)}
												onblur={() => handleEditorBlur(rowIndex, column, row)}
											/>
										{:else}
											<input
												type={column.editor === 'number'
													? 'number'
													: column.editor === 'date'
														? 'date'
														: 'text'}
												bind:this={editorEl}
												class="cell-editor"
												class:pending={editing.pending}
												value={String(editing.draft ?? '')}
												onpointerdown={(event) => event.stopPropagation()}
												oninput={(event) => {
													if (editing) editing.draft = event.currentTarget.value;
												}}
												onkeydown={(event) => handleEditorKeydown(event, rowIndex, column, row)}
												onblur={() => handleEditorBlur(rowIndex, column, row)}
											/>
										{/if}
										{#if editing.error}
											<div class="cell-error" role="alert">{editing.error}</div>
										{/if}
									{:else}
										{renderCell(column, row)}
									{/if}
								</div>
							{/each}
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.banto-grid {
		position: relative;
		height: 100%;
		width: 100%;
		overflow: auto;
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
		font-size: 0.875rem;
	}

	.banto-grid:focus {
		outline: none;
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
		background: var(--banto-surface);
		border-bottom: 1px solid var(--banto-border);
	}

	.drop-indicator {
		position: absolute;
		top: 0;
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
		border-bottom: 1px solid var(--banto-border);
		box-sizing: border-box;
	}

	.row:hover {
		background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
	}

	.cell {
		position: relative;
		padding: 0 0.6rem;
		display: flex;
		align-items: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--banto-text);
	}

	.cell.active {
		outline: 2px solid var(--banto-primary);
		outline-offset: -2px;
		z-index: 1;
	}

	.cell.in-range {
		background: color-mix(in srgb, var(--banto-primary) 12%, transparent);
	}

	.cell.editing {
		padding: 0;
		overflow: visible;
		z-index: 2;
	}

	.cell.editing.error {
		outline: 2px solid var(--banto-danger);
		outline-offset: -2px;
	}

	.cell-link {
		color: var(--banto-primary);
		text-decoration: none;
	}

	.cell-link:hover {
		text-decoration: underline;
	}

	.cell-editor {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		padding: 0 0.6rem;
		border: none;
		outline: none;
		background: var(--banto-surface);
		color: var(--banto-text);
		font: inherit;
	}

	.cell-editor.pending {
		opacity: 0.5;
		pointer-events: none;
	}

	.cell-error {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 30;
		margin-top: 2px;
		padding: 0.25rem 0.5rem;
		background: var(--banto-danger);
		color: var(--banto-text-inverse);
		border-radius: var(--banto-radius);
		font-size: 0.7rem;
		white-space: nowrap;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	}

	.empty-row {
		padding: 1.5rem;
		text-align: center;
		color: var(--banto-text-muted);
	}
</style>
