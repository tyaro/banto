<script lang="ts" generics="TRow">
	/**
	 * One column header: sort toggle, resize handle, drag-reorder source,
	 * and (if filterable) a filter icon that opens FilterPopover.
	 *
	 * Reorder and resize use pointer events only (no HTML5 DnD, per spec
	 * decision). Both gestures track the drag via window-level
	 * pointermove/pointerup listeners added on pointerdown and removed on
	 * pointerup, rather than element.setPointerCapture: capture is
	 * per-element, and a stray double-click on the resize handle (down/up,
	 * down/up with zero movement) was observed to leave the browser's
	 * pointer-capture bookkeeping in a state where an unrelated *later*
	 * drag on a sibling header cell stopped receiving pointermove/pointerup
	 * entirely. Global listeners sidestep that class of bug and are the
	 * more common pattern for drag interactions anyway.
	 *
	 * pointerdown on the cell body arms a drag candidate; once the pointer
	 * moves past a small threshold it becomes an actual drag and the parent
	 * BantoGrid is notified so it can render a drop indicator across the
	 * whole header row. A pointerup without crossing the threshold is
	 * treated as a plain (possibly shift-) click that toggles sort.
	 */
	import { DEFAULT_COLUMN_WIDTH, type FilterState, type GridColumn } from './types';
	import type { GridState } from './state.svelte';
	import FilterPopover from './FilterPopover.svelte';

	interface Props {
		column: GridColumn<TRow>;
		state: GridState<TRow>;
		width: number;
		showPriority: boolean;
		onDragStart: (columnId: string) => void;
		onDragMove: (clientX: number) => void;
		onDragEnd: () => void;
		/**
		 * Server mode (spec §4.1, M5): called right after a sort toggle or a
		 * filter apply/clear mutates `state`. BantoGrid uses this to call its
		 * own `onParamsChange` prop; client mode ignores it (GridState's own
		 * reactivity already drives the client-side filter/sort pipeline).
		 */
		onSortOrFilterChange?: () => void;
	}

	// Aliased to avoid clashing with the `$state` rune (a local binding named
	// exactly `state` makes the compiler treat `$state(...)` calls below as
	// store-subscription syntax instead of rune usage).
	let {
		column,
		state: gridState,
		width,
		showPriority,
		onDragStart,
		onDragMove,
		onDragEnd,
		onSortOrFilterChange
	}: Props = $props();

	const DRAG_THRESHOLD_PX = 4;

	const sortable = $derived(column.sortable !== false);
	const resizable = $derived(column.resizable !== false);
	const sortIndex = $derived(gridState.sort.findIndex((entry) => entry.field === column.id));
	const sortEntry = $derived(sortIndex === -1 ? undefined : gridState.sort[sortIndex]);
	const ariaSort = $derived(
		!sortEntry ? 'none' : sortEntry.direction === 'asc' ? 'ascending' : 'descending'
	);
	const activeFilter = $derived(gridState.filters.find((entry) => entry.field === column.id));

	let filterOpen = $state(false);

	function handleBodyPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		// Suppress native text-selection/drag-start so a fast double-click on a
		// neighboring resize handle can't leave the browser mid-selection when
		// this gesture starts (see the comment above).
		event.preventDefault();
		const start = { x: event.clientX, y: event.clientY };
		const pointerId = event.pointerId;
		let isDragging = false;

		function onMove(moveEvent: PointerEvent) {
			if (moveEvent.pointerId !== pointerId) return;
			const dx = moveEvent.clientX - start.x;
			const dy = moveEvent.clientY - start.y;
			if (!isDragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
				isDragging = true;
				onDragStart(column.id);
			}
			if (isDragging) {
				onDragMove(moveEvent.clientX);
			}
		}

		function onUp(upEvent: PointerEvent) {
			if (upEvent.pointerId !== pointerId) return;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			if (isDragging) {
				onDragEnd();
			} else if (sortable) {
				gridState.toggleSort(column.id, upEvent.shiftKey);
				onSortOrFilterChange?.();
			}
		}

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	function handleResizePointerDown(event: PointerEvent) {
		event.preventDefault();
		const resizeStartX = event.clientX;
		const resizeStartWidth = width;
		const pointerId = event.pointerId;

		function onMove(moveEvent: PointerEvent) {
			if (moveEvent.pointerId !== pointerId) return;
			gridState.resizeColumn(column.id, resizeStartWidth + (moveEvent.clientX - resizeStartX));
		}

		function onUp(upEvent: PointerEvent) {
			if (upEvent.pointerId !== pointerId) return;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		}

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	function handleResizeDoubleClick() {
		gridState.resizeColumn(column.id, column.width ?? DEFAULT_COLUMN_WIDTH);
	}

	/** Keyboard access for sort: Enter/Space toggles like a click (spec §4.7). */
	function handleBodyKeydown(event: KeyboardEvent) {
		if (!sortable) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			gridState.toggleSort(column.id, event.shiftKey);
			onSortOrFilterChange?.();
		}
	}

	function toggleFilter() {
		filterOpen = !filterOpen;
	}

	function applyFilter(filter: FilterState) {
		gridState.setFilter(filter);
		filterOpen = false;
		onSortOrFilterChange?.();
	}

	function clearFilter() {
		gridState.removeFilter(column.id);
		filterOpen = false;
		onSortOrFilterChange?.();
	}
</script>

<div
	class="header-cell"
	role="columnheader"
	aria-sort={sortable ? ariaSort : undefined}
	style:width={`${width}px`}
>
	<div
		class="cell-body"
		class:sortable
		role="button"
		tabindex={sortable ? 0 : -1}
		onpointerdown={handleBodyPointerDown}
		onkeydown={handleBodyKeydown}
	>
		<span class="label" style:text-align={column.align ?? 'left'}>{column.header}</span>
		{#if sortEntry}
			<span class="sort-arrow">{sortEntry.direction === 'asc' ? '▲' : '▼'}</span>
			{#if showPriority}
				<span class="sort-priority">{sortIndex + 1}</span>
			{/if}
		{/if}
	</div>

	{#if column.filterable}
		<button
			type="button"
			class="filter-button"
			class:active={!!activeFilter}
			aria-label={`${column.header}の絞り込み`}
			onclick={toggleFilter}
		>
			▾
		</button>
		{#if filterOpen}
			<FilterPopover
				{column}
				current={activeFilter}
				onApply={applyFilter}
				onClear={clearFilter}
				onClose={() => (filterOpen = false)}
			/>
		{/if}
	{/if}

	{#if resizable}
		<div
			class="resize-handle"
			onpointerdown={handleResizePointerDown}
			ondblclick={handleResizeDoubleClick}
			role="separator"
			aria-orientation="vertical"
		></div>
	{/if}
</div>

<style>
	.header-cell {
		position: relative;
		display: flex;
		align-items: center;
		height: 100%;
		border-right: 1px solid var(--banto-border);
		box-sizing: border-box;
		user-select: none;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* Sorted or filtered column: tint the whole header cell in the primary
	   family so the active column reads at a glance (spec: sort/filter state
	   uses --banto-primary). Keyed off the aria-sort attribute and the
	   filter button's existing .active class - no extra markup needed. */
	.header-cell[aria-sort='ascending'],
	.header-cell[aria-sort='descending'],
	.header-cell:has(.filter-button.active) {
		background: color-mix(in srgb, var(--banto-primary) 8%, transparent);
	}

	.cell-body {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		height: 100%;
		padding: 0 0.6rem;
		min-width: 0;
		user-select: none;
		touch-action: none;
	}

	.cell-body.sortable {
		cursor: pointer;
	}

	.cell-body:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-md);
	}

	.label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		color: var(--banto-text-muted);
	}

	.header-cell[aria-sort='ascending'] .label,
	.header-cell[aria-sort='descending'] .label {
		color: var(--banto-primary);
	}

	.sort-arrow {
		font-size: 0.7rem;
		color: var(--banto-primary);
	}

	.sort-priority {
		font-size: 0.65rem;
		color: var(--banto-text-inverse);
		background: var(--banto-primary);
		border-radius: 999px;
		min-width: 1rem;
		height: 1rem;
		line-height: 1rem;
		text-align: center;
		padding: 0 0.15rem;
	}

	.filter-button {
		border: none;
		background: none;
		color: var(--banto-text-muted);
		cursor: pointer;
		padding: 0 0.4rem;
		font-size: 0.7rem;
		flex-shrink: 0;
	}

	.filter-button.active {
		color: var(--banto-primary);
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: -3px;
		width: 6px;
		height: 100%;
		cursor: col-resize;
		z-index: 1;
		touch-action: none;
	}
</style>
