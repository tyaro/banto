<script lang="ts" generics="TRow">
	/** Column filter editor, opened from HeaderCell's filter icon (spec §4.3). */
	import type { FilterOp, FilterState, GridColumn } from './types';
	import { defaultGridMessages, type GridMessages } from './messages';

	interface Props {
		column: GridColumn<TRow>;
		current: FilterState | undefined;
		onApply: (filter: FilterState) => void;
		onClear: () => void;
		onClose: () => void;
		/** i18n layer 1 (docs/i18n-plan.md §3.2): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<GridMessages>;
	}

	let { column, current, onApply, onClear, onClose, messages = {} }: Props = $props();

	// `messages` is merged once (i18n layer 1: an override bundle, not
	// reactive state) rather than re-read per usage below.
	// svelte-ignore state_referenced_locally
	const t = { ...defaultGridMessages, ...messages };

	const filterType = $derived(column.filterType ?? 'text');

	const TEXT_OPS: { value: FilterOp; label: string }[] = [
		{ value: 'contains', label: t.filterOpContains() },
		{ value: 'starts_with', label: t.filterOpStartsWith() },
		{ value: 'eq', label: t.filterOpEquals() }
	];
	const NUMBER_OPS: { value: FilterOp; label: string }[] = [
		{ value: 'eq', label: '=' },
		{ value: 'ne', label: '≠' },
		{ value: 'gt', label: '>' },
		{ value: 'gte', label: '≥' },
		{ value: 'lt', label: '<' },
		{ value: 'lte', label: '≤' }
	];
	const ops = $derived(filterType === 'number' ? NUMBER_OPS : TEXT_OPS);

	// `op` / `value` are deliberately seeded from the initial `current` prop:
	// the popover unmounts on close, so a re-open re-reads the latest filter.
	// svelte-ignore state_referenced_locally
	let op: FilterOp = $state(current?.op ?? (filterType === 'number' ? 'eq' : 'contains'));
	// Typed string | number: Svelte's bind:value on <input type="number">
	// writes a NUMBER back into this state (or '' while the field is
	// empty/invalid), so treating it as string-only made apply()'s
	// .trim() throw for number columns.
	// svelte-ignore state_referenced_locally
	let value: string | number = $state(
		current?.value === undefined || current?.value === null ? '' : String(current.value)
	);

	let rootEl: HTMLDivElement | undefined = $state();

	$effect(() => {
		function handlePointerDown(event: PointerEvent) {
			if (rootEl && event.target instanceof Node && !rootEl.contains(event.target)) {
				onClose();
			}
		}
		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') onClose();
		}
		// Capture phase so this still sees the click even if a descendant stops propagation.
		window.addEventListener('pointerdown', handlePointerDown, true);
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('pointerdown', handlePointerDown, true);
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	function apply() {
		// An empty value means "no filter": applying it would be a no-op for
		// text and, worse, Number('') === 0 would silently filter by 0 for
		// number columns. Treat it as clearing the filter instead. `value`
		// may be a number here (bind:value on a number input), so normalize
		// to a string before trimming.
		const raw = typeof value === 'string' ? value : String(value);
		if (raw.trim() === '') {
			onClear();
			return;
		}
		const parsedValue: unknown = filterType === 'number' ? Number(raw) : raw;
		onApply({ field: column.id, op, value: parsedValue });
	}
</script>

<div
	class="filter-popover"
	bind:this={rootEl}
	role="dialog"
	aria-label={t.filterAriaLabel(column.header)}
>
	<select bind:value={op}>
		{#each ops as item (item.value)}
			<option value={item.value}>{item.label}</option>
		{/each}
	</select>
	<input
		type={filterType === 'number' ? 'number' : 'text'}
		bind:value
		placeholder={t.filterValuePlaceholder()}
		onkeydown={(event) => {
			if (event.key === 'Enter') apply();
		}}
	/>
	<div class="actions">
		<button type="button" class="apply" onclick={apply}>{t.filterApply()}</button>
		<button type="button" class="clear" onclick={onClear}>{t.filterClear()}</button>
	</div>
</div>

<style>
	.filter-popover {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		width: 190px;
		padding: 0.6rem;
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-shadow-lg);
		/* Standard preset: no-op (var(--banto-backdrop) is `none`). Glass
		   preset opts in by overriding --banto-backdrop (spec §9). */
		backdrop-filter: var(--banto-backdrop, none);
	}

	select,
	input {
		width: 100%;
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		padding: 0 0.4rem;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text);
		font-size: 0.8rem;
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	select:focus-visible,
	input:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.actions {
		display: flex;
		gap: 0.4rem;
		justify-content: flex-end;
	}

	button {
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		padding: 0 0.6rem;
		font-size: 0.75rem;
		cursor: pointer;
		background: var(--banto-surface);
		color: var(--banto-text);
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	button.apply {
		background: var(--banto-primary-solid);
		border-color: var(--banto-primary-solid);
		color: var(--banto-on-solid);
	}

	button.apply:hover {
		background: var(--banto-primary-solid-hover);
		border-color: var(--banto-primary-solid-hover);
	}
</style>
