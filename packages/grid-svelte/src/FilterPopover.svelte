<script lang="ts" generics="TRow">
	/** Column filter editor, opened from HeaderCell's filter icon (spec §4.3). */
	import type { FilterOp, FilterState, GridColumn } from './types';

	interface Props {
		column: GridColumn<TRow>;
		current: FilterState | undefined;
		onApply: (filter: FilterState) => void;
		onClear: () => void;
		onClose: () => void;
	}

	let { column, current, onApply, onClear, onClose }: Props = $props();

	const filterType = $derived(column.filterType ?? 'text');

	const TEXT_OPS: { value: FilterOp; label: string }[] = [
		{ value: 'contains', label: '含む' },
		{ value: 'starts_with', label: 'で始まる' },
		{ value: 'eq', label: '一致する' }
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
	aria-label={`${column.header}の絞り込み`}
>
	<select bind:value={op}>
		{#each ops as item (item.value)}
			<option value={item.value}>{item.label}</option>
		{/each}
	</select>
	<input
		type={filterType === 'number' ? 'number' : 'text'}
		bind:value
		placeholder="値を入力"
		onkeydown={(event) => {
			if (event.key === 'Enter') apply();
		}}
	/>
	<div class="actions">
		<button type="button" class="apply" onclick={apply}>適用</button>
		<button type="button" class="clear" onclick={onClear}>クリア</button>
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
		background: var(--banto-surface-raised, var(--banto-surface));
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
	}

	select,
	input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.3rem 0.4rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		background: var(--banto-surface);
		color: var(--banto-text);
		font-size: 0.8rem;
	}

	.actions {
		display: flex;
		gap: 0.4rem;
		justify-content: flex-end;
	}

	button {
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		padding: 0.25rem 0.6rem;
		font-size: 0.75rem;
		cursor: pointer;
		background: var(--banto-surface);
		color: var(--banto-text);
	}

	button.apply {
		background: var(--banto-primary);
		border-color: var(--banto-primary);
		color: var(--banto-text-inverse);
	}
</style>
