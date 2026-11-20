<script lang="ts" generics="TRow">
	/**
	 * Column manager (spec §4.4 "列の表示/非表示切り替え（列マネージャーUI）"):
	 * a trigger button plus a popover of one checkbox per column, writing
	 * through to `GridState.setColumnHidden`. Each row also has a pin toggle
	 * (#713) that writes through to `GridState.toggleColumnPinned`: a button
	 * with `aria-pressed`, so its name (`pinColumn`) is the same in both
	 * states. `allColumns` lists pinned columns first, so a row moves when its
	 * pin flips; focus is put back on the button it was on.
	 *
	 * Deliberately a SEPARATE component rather than a menu inside
	 * BantoGrid's header row: the header is a CSS grid whose
	 * `grid-template-columns` is computed from the visible columns' widths,
	 * so an extra always-present affordance in that row would have to be
	 * excluded from every width/field-index calculation. Placing the menu in
	 * the page's own toolbar (next to the group-by select, the CSV buttons,
	 * ...) keeps the grid's layout math untouched, and lets a page that
	 * doesn't want column management simply not render it. It takes the same
	 * `GridState` instance the grid was handed - the externally-owned-state
	 * pattern that the group-by <select> already uses (spec §4.3).
	 *
	 * Dismiss model mirrors FilterPopover: Escape or a pointer-down outside
	 * the root closes it; there is no Tab-cycling focus trap.
	 */
	import { tick } from 'svelte';
	import type { GridState } from './state.svelte';
	import { defaultGridMessages, type GridMessages } from './messages';

	interface Props {
		/** The SAME GridState instance passed to BantoGrid - this menu mutates its `hidden` and `pinned` lists. */
		state: GridState<TRow>;
		/** i18n layer 1 (docs/conventions.md §13): overrides for this component's visible strings. Defaults reproduce today's Japanese output. */
		messages?: Partial<GridMessages>;
	}

	// Aliased to avoid clashing with the `$state` rune (a local binding named
	// exactly `state` makes the compiler treat `$state(...)` calls below as
	// store-subscription syntax instead of rune usage).
	let { state: gridState, messages = {} }: Props = $props();

	// `messages` is an i18n layer 1 override bundle; merged reactively so a
	// parent that swaps it later (a locale switch) is followed.
	const t = $derived({ ...defaultGridMessages, ...messages });

	let open = $state(false);
	let rootEl: HTMLDivElement | undefined = $state();

	const columns = $derived(gridState.allColumns);
	const visibleCount = $derived(gridState.orderedColumns.length);
	/**
	 * The one column whose checkbox is disabled while it is the only visible
	 * one left (`setColumnHidden` refuses to hide it anyway - this just makes
	 * the refusal visible instead of a dead click).
	 */
	const lockedId = $derived(visibleCount === 1 ? gridState.orderedColumns[0]?.id : undefined);

	$effect(() => {
		if (!open) return;
		function handlePointerDown(event: PointerEvent) {
			if (rootEl && event.target instanceof Node && !rootEl.contains(event.target)) {
				open = false;
			}
		}
		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') open = false;
		}
		// Capture phase so this still sees the click even if a descendant stops propagation.
		window.addEventListener('pointerdown', handlePointerDown, true);
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('pointerdown', handlePointerDown, true);
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	/** A column with no header text (an actions/link column) still needs a label in the list. */
	function labelOf(header: string, id: string): string {
		return header.trim() === '' ? id : header;
	}

	/**
	 * Flip a column's pin. The row then moves (pinned columns are listed
	 * first), and a moved DOM node loses focus - so focus returns to the same
	 * button once the list has been redrawn.
	 */
	async function togglePinned(id: string, event: MouseEvent): Promise<void> {
		const button = event.currentTarget;
		gridState.toggleColumnPinned(id);
		await tick();
		if (button instanceof HTMLElement && button.isConnected) button.focus();
	}
</script>

<div class="columns-menu" bind:this={rootEl}>
	<button
		type="button"
		class="trigger"
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{t.columnsMenuButton()}
		<span class="count">{t.columnsMenuCount(visibleCount, columns.length)}</span>
	</button>

	{#if open}
		<div class="popover" role="dialog" aria-label={t.columnsMenuTitle()}>
			{#each columns as column (column.id)}
				{@const locked = column.id === lockedId}
				{@const label = labelOf(column.header, column.id)}
				{@const pinned = gridState.isPinned(column.id)}
				<div class="row">
					<label class="item" title={locked ? t.columnsMenuLastColumn() : undefined}>
						<input
							type="checkbox"
							checked={!gridState.isHidden(column.id)}
							disabled={locked}
							onchange={() => gridState.toggleColumnHidden(column.id)}
						/>
						<span class="label">{label}</span>
					</label>
					<button
						type="button"
						class="pin"
						aria-label={t.pinColumn(label)}
						aria-pressed={pinned}
						title={pinned ? t.unpinColumn(label) : t.pinColumn(label)}
						onclick={(event) => togglePinned(column.id, event)}
					>
						<!-- A pushpin, drawn here: packages import nothing but svelte (conventions §5). -->
						<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path d="M12 17v5" />
							<path
								d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
							/>
						</svg>
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.columns-menu {
		position: relative;
		display: inline-flex;
	}

	.trigger {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
		box-sizing: border-box;
		height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
		color: var(--banto-text);
		font-size: var(--banto-font-size-sm);
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.trigger:hover {
		background: var(--banto-surface-hover);
	}

	.trigger:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.count {
		font-size: var(--banto-font-size-xs);
		color: var(--banto-text-muted);
	}

	.popover {
		position: absolute;
		top: calc(100% + var(--banto-space-1));
		right: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		min-width: 180px;
		max-height: 60vh;
		overflow-y: auto;
		padding: var(--banto-space-2);
		background: var(--banto-surface-overlay);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		box-shadow: var(--banto-shadow-lg);
		/* Standard preset: no-op (var(--banto-backdrop) is `none`). Glass
		   preset opts in by overriding --banto-backdrop (spec §9). */
		backdrop-filter: var(--banto-backdrop, none);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
	}

	.item {
		box-sizing: border-box;
		display: flex;
		flex: 1;
		min-width: 0;
		min-height: var(--banto-control-height-sm, 28px);
		align-items: center;
		gap: var(--banto-space-2);
		padding: var(--banto-space-1) var(--banto-space-1);
		border-radius: var(--banto-radius-md);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text);
		cursor: pointer;
	}

	.item:hover {
		background: var(--banto-surface-hover);
	}

	.item:has(input:disabled) {
		color: var(--banto-text-muted);
		cursor: default;
	}

	/* Native checkbox styling remains local for standalone package consumers. */
	input {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		flex-shrink: 0;
		accent-color: var(--banto-primary);
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: var(--banto-border-width, 1px);
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-sm);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* Pin toggle (#713). Quiet until pinned; the pressed state is carried by
	   colour and a filled glyph, plus a border that survives forced colours. */
	.pin {
		box-sizing: border-box;
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: var(--banto-control-height-sm, 28px);
		height: var(--banto-control-height-sm, 28px);
		padding: 0;
		border: var(--banto-border-width) solid transparent;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.pin svg {
		width: 1em;
		height: 1em;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.pin:hover {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.pin[aria-pressed='true'] {
		border-color: var(--banto-border-strong);
		color: var(--banto-primary-text, var(--banto-primary));
	}

	.pin[aria-pressed='true'] svg {
		fill: currentColor;
	}

	.pin:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	@media (forced-colors: active) {
		.pin[aria-pressed='true'] {
			border-color: Highlight;
		}

		.pin:focus-visible {
			outline: var(--banto-border-width-strong, 2px) solid Highlight;
		}
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
