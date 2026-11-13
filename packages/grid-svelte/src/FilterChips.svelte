<script lang="ts" generics="TRow">
	/**
	 * Applied-filter chips (#555 B-2): one chip per entry of
	 * `GridState.filters`, written "列見出し 演算子 値" (e.g. 商品名 含む ねじ),
	 * each with an x button that calls `GridState.removeFilter(field)`. When
	 * two or more filters are applied a "clear all" button
	 * (`GridState.clearFilters()`) is offered too. Renders nothing at all
	 * while no filter is applied.
	 *
	 * Deliberately a SEPARATE component (like ColumnsMenu): the filters live
	 * in the grid header's popovers, where nothing says what the grid is
	 * filtered by. A page places this above the grid and hands it the SAME
	 * GridState instance. A chip body is plain text - editing a filter stays
	 * the header popover's job - so only the x buttons are focusable.
	 *
	 * Focus: after an x button removes a chip, focus moves to the chip that
	 * takes its place (or the previous one when the last was removed); when
	 * the last chip is gone, or "clear all" was used, `onEmpty` is called so
	 * the page can hand focus to the grid rather than lose it to <body>.
	 */
	import { tick } from 'svelte';
	import type { GridState } from './state.svelte';
	import type { FilterOp, FilterState } from './types';
	import { defaultGridMessages, type GridMessages } from './messages';
	import { isBetweenValue } from './core/dateRange';

	interface Props {
		/** The SAME GridState instance passed to BantoGrid - this component reads `filters` and calls `removeFilter` / `clearFilters`. */
		state: GridState<TRow>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<GridMessages>;
		/** Called after the last chip disappears (an x on the only chip, or "clear all") so the page can place focus somewhere stable. */
		onEmpty?: () => void;
	}

	// Aliased to avoid clashing with the `$state` rune.
	let { state: gridState, messages = {}, onEmpty }: Props = $props();

	// svelte-ignore state_referenced_locally
	const t = { ...defaultGridMessages, ...messages };

	let rootEl: HTMLDivElement | undefined = $state();

	const SYMBOLS: Partial<Record<FilterOp, string>> = {
		eq: '=',
		ne: '≠',
		gt: '>',
		gte: '≥',
		lt: '<',
		lte: '≤'
	};

	function headerOf(field: string): string {
		const column = gridState.allColumns.find((entry) => entry.id === field);
		if (!column) return field;
		return column.header.trim() === '' ? column.id : column.header;
	}

	function isNumeric(filter: FilterState): boolean {
		const column = gridState.allColumns.find((entry) => entry.id === filter.field);
		return column?.filterType === 'number' || typeof filter.value === 'number';
	}

	function opLabel(filter: FilterState): string {
		switch (filter.op) {
			case 'contains':
				return t.filterOpContains();
			case 'starts_with':
				return t.filterOpStartsWith();
			case 'is_null':
				return t.filterChipIsNull();
			case 'not_null':
				return t.filterChipNotNull();
			case 'between':
				return '';
			case 'in':
				return t.filterChipIn();
			case 'eq':
				return isNumeric(filter) ? '=' : t.filterOpEquals();
			default:
				return SYMBOLS[filter.op] ?? filter.op;
		}
	}

	function valueLabel(filter: FilterState): string {
		if (filter.op === 'is_null' || filter.op === 'not_null') return '';
		if (filter.op === 'between' && isBetweenValue(filter.value)) {
			const [from, to] = filter.value;
			return `${from ?? ''} ${t.filterChipRangeSeparator()} ${to ?? ''}`.trim();
		}
		if (Array.isArray(filter.value)) return filter.value.map(String).join(', ');
		return String(filter.value ?? '');
	}

	const chips = $derived(
		gridState.filters.map((filter) => ({
			field: filter.field,
			header: headerOf(filter.field),
			op: opLabel(filter),
			value: valueLabel(filter)
		}))
	);

	async function remove(index: number) {
		const field = chips[index]?.field;
		if (field === undefined) return;
		const remaining = chips.length - 1;
		gridState.removeFilter(field);
		if (remaining === 0) {
			onEmpty?.();
			return;
		}
		await tick();
		const buttons = rootEl?.querySelectorAll<HTMLButtonElement>('.remove');
		buttons?.[Math.min(index, remaining - 1)]?.focus();
	}

	function clearAll() {
		gridState.clearFilters();
		onEmpty?.();
	}
</script>

{#if chips.length > 0}
	<div class="filter-chips" role="group" aria-label={t.filterChipsLabel()} bind:this={rootEl}>
		{#each chips as chip, index (chip.field)}
			<span class="chip">
				<span class="text">
					<span class="header">{chip.header}</span>
					{#if chip.op}<span class="op">{chip.op}</span>{/if}
					{#if chip.value}<span class="value">{chip.value}</span>{/if}
				</span>
				<button
					type="button"
					class="remove"
					aria-label={t.filterChipRemove(chip.header)}
					onclick={() => remove(index)}
				>
					<span aria-hidden="true">×</span>
				</button>
			</span>
		{/each}
		{#if chips.length >= 2}
			<button type="button" class="clear-all" onclick={clearAll}>
				{t.filterChipsClearAll()}
			</button>
		{/if}
	</div>
{/if}

<style>
	.filter-chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
		margin-bottom: var(--banto-space-2);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
		max-width: 100%;
		box-sizing: border-box;
		min-height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-1) 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text);
		font-size: var(--banto-font-size-sm);
	}

	.text {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--banto-space-1);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.header,
	.op {
		color: var(--banto-text-muted);
	}

	.value {
		font-weight: 600;
	}

	.remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: var(--banto-control-height-sm);
		height: var(--banto-control-height-sm);
		padding: 0;
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-base);
		line-height: 1;
		cursor: pointer;
	}

	.remove:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.remove:focus-visible,
	.clear-all:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.clear-all {
		height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-2);
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-decoration: underline;
		cursor: pointer;
	}

	.clear-all:hover {
		color: var(--banto-text);
	}
</style>
