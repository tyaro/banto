<script lang="ts">
	/**
	 * The calendar's month view and year view (internal, not exported; Issue
	 * #908): a heading with previous / next buttons and a 3 x 4 grid of 12
	 * months (one year) or 12 years. `MonthCalendar` switches to it from the
	 * day view's heading; it is kept apart so the extended pickers (#910) can
	 * use the same views.
	 *
	 * Both views count in "periods" (`datetime.ts`): a month is
	 * `year * 12 + (month - 1)`, a year is the year, so a page is always 12
	 * periods and the keys are the same.
	 *
	 * - `focus` (bindable) is the tracked period: the one cell in the tab order
	 *   (roving tabindex). `pageStart` (bindable) is the first period shown;
	 *   it follows `focus` by whole pages. The parent sets both before showing
	 *   the view and calls `focusCell()` once the cells exist.
	 * - Keys (a native listener on the grid, like the day grid's, so it runs
	 *   before the dialog's own listener): arrows move by 1 / a row of 3,
	 *   Home / End to the row's ends, PageUp / PageDown by a page (12), Enter /
	 *   Space pick through `onPick`. Escape is the parent's (back to the view
	 *   below). Keys during IME composition are left alone (#907).
	 * - A period wholly outside `[min, max]` is `aria-disabled` and cannot be
	 *   tracked or picked; years before 0001 / after 9999 are empty slots.
	 */
	import { flushSync } from 'svelte';
	import { revealInPopover } from './anchoredPopover';
	import CalendarNavButton from './CalendarNavButton.svelte';
	import {
		PERIODS_PER_PAGE,
		PERIODS_PER_ROW,
		clampPeriod,
		formatDate,
		formatMonthName,
		formatMonthYear,
		formatYear,
		isPeriodOutOfRange,
		isPeriodValid,
		monthOfPeriod,
		periodOf,
		type PeriodUnit
	} from './datetime';
	import ChevronLeft from './icons/ChevronLeft.svelte';
	import ChevronRight from './icons/ChevronRight.svelte';
	import type { UiMessages } from './messages';

	interface Props {
		/** `month`: the 12 months of a year; `year`: 12 years. */
		unit: PeriodUnit;
		/** The tracked period. */
		focus: number;
		/** The first period shown (a multiple of 12 for months). */
		pageStart: number;
		/** The day shown as chosen: its month / year is `aria-selected`. */
		selectedDate: string | null;
		/** Today's date: its month / year is `aria-current`. */
		today: string;
		/** Earliest day (canonical, inclusive): periods wholly before it are disabled. */
		min?: string;
		/** Latest day (canonical, inclusive): periods wholly after it are disabled. */
		max?: string;
		locale: string;
		/** Resolved messages. */
		t: Required<UiMessages>;
		/** The dialog that scrolls when its height is capped. */
		scroller?: HTMLElement;
		/** A period was picked (Enter / Space / click). */
		onPick: (period: number) => void;
		/** Given: the heading (the month view's year) is a button that calls it. */
		onHeading?: () => void;
	}

	let {
		unit,
		focus = $bindable(),
		pageStart = $bindable(),
		selectedDate,
		today,
		min,
		max,
		locale,
		t,
		scroller,
		onPick,
		onHeading
	}: Props = $props();

	const uid = $props.id();
	const headingId = `${uid}-heading`;

	let gridEl: HTMLTableElement | undefined = $state();

	const rows = $derived(
		Array.from({ length: PERIODS_PER_PAGE / PERIODS_PER_ROW }, (_, r) =>
			Array.from({ length: PERIODS_PER_ROW }, (_, c) => pageStart + r * PERIODS_PER_ROW + c)
		)
	);
	const selectedPeriod = $derived(selectedDate ? periodOf(selectedDate, unit) : null);
	const todayPeriod = $derived(today ? periodOf(today, unit) : null);

	const headingText = $derived(
		unit === 'month'
			? formatYear(Math.floor(pageStart / 12), locale)
			: t.datePickerYearRange(
					formatYear(Math.max(pageStart, 1), locale),
					formatYear(Math.min(pageStart + PERIODS_PER_PAGE - 1, 9999), locale)
				)
	);
	const prevLabel = $derived(unit === 'month' ? t.datePickerPrevYear() : t.datePickerPrevYears());
	const nextLabel = $derived(unit === 'month' ? t.datePickerNextYear() : t.datePickerNextYears());

	function isDisabled(period: number): boolean {
		return isPeriodOutOfRange(period, unit, min, max);
	}

	function cellText(period: number): string {
		return unit === 'month'
			? formatMonthName(monthOfPeriod(period).month, locale, 'short')
			: formatYear(period, locale);
	}

	function cellLabel(period: number): string {
		if (unit === 'year') return formatYear(period, locale);
		const { year, month } = monthOfPeriod(period);
		return formatMonthYear(formatDate({ year, month, day: 1 }), locale);
	}

	/** Focus the tracked period's cell (after the cells were rendered). */
	export function focusCell(): void {
		const cell = gridEl?.querySelector<HTMLElement>(`[data-period="${focus}"]`);
		if (!cell) return;
		// As the day grid: never scroll the page; reveal inside a height-capped dialog.
		cell.focus({ preventScroll: true });
		if (scroller) revealInPopover(scroller, cell);
	}

	/** Track `period` (moved into range), turning whole pages so it is shown. */
	function track(period: number): void {
		focus = clampPeriod(period, unit, min, max);
		const offset = focus - pageStart;
		if (offset < 0 || offset >= PERIODS_PER_PAGE) {
			pageStart += Math.floor(offset / PERIODS_PER_PAGE) * PERIODS_PER_PAGE;
		}
	}

	function moveFocus(period: number): void {
		track(period);
		flushSync();
		focusCell();
	}

	/** Previous / next page: disabled when every period of it is out of range. */
	function pageDisabled(pages: number): boolean {
		const start = pageStart + pages * PERIODS_PER_PAGE;
		for (let p = start; p < start + PERIODS_PER_PAGE; p++) {
			if (!isDisabled(p)) return false;
		}
		return true;
	}

	function turnPage(pages: number): void {
		if (pageDisabled(pages)) return;
		const step = pages * PERIODS_PER_PAGE;
		pageStart += step;
		// The page touches the range, so the clamped period stays on it.
		focus = clampPeriod(focus + step, unit, min, max);
	}

	function handleCellClick(period: number): void {
		if (isDisabled(period)) {
			focusCell();
			return;
		}
		moveFocus(period);
		onPick(period);
	}

	function handleGridKey(event: KeyboardEvent): void {
		// IME 変換中のキーは変換のもの。表示を動かさない（#907 と同じ判定）。
		if (event.isComposing || event.keyCode === 229) return;
		const target = event.target;
		if (!(target instanceof HTMLElement) || !target.dataset.period) return;
		const column = (((focus - pageStart) % PERIODS_PER_ROW) + PERIODS_PER_ROW) % PERIODS_PER_ROW;
		let next: number;
		switch (event.key) {
			case 'ArrowLeft':
				next = focus - 1;
				break;
			case 'ArrowRight':
				next = focus + 1;
				break;
			case 'ArrowUp':
				next = focus - PERIODS_PER_ROW;
				break;
			case 'ArrowDown':
				next = focus + PERIODS_PER_ROW;
				break;
			case 'Home':
				next = focus - column;
				break;
			case 'End':
				next = focus - column + PERIODS_PER_ROW - 1;
				break;
			case 'PageUp':
				next = focus - PERIODS_PER_PAGE;
				break;
			case 'PageDown':
				next = focus + PERIODS_PER_PAGE;
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (!isDisabled(focus)) onPick(focus);
				return;
			default:
				return;
		}
		event.preventDefault();
		moveFocus(next);
	}

	$effect(() => {
		const grid = gridEl;
		if (!grid) return;
		grid.addEventListener('keydown', handleGridKey);
		return () => grid.removeEventListener('keydown', handleGridKey);
	});
</script>

<div class="date-picker-header">
	<CalendarNavButton label={prevLabel} disabled={pageDisabled(-1)} onclick={() => turnPage(-1)}>
		<ChevronLeft size={16} aria-hidden="true" />
	</CalendarNavButton>
	<h2 id={headingId} class="date-picker-heading" aria-live="polite">
		{#if onHeading}
			<button
				type="button"
				class="date-picker-heading-button"
				title={t.datePickerChooseYear()}
				onclick={onHeading}
			>
				{headingText}
			</button>
		{:else}
			{headingText}
		{/if}
	</h2>
	<CalendarNavButton label={nextLabel} disabled={pageDisabled(1)} onclick={() => turnPage(1)}>
		<ChevronRight size={16} aria-hidden="true" />
	</CalendarNavButton>
</div>

<table class="date-picker-period-grid" role="grid" aria-labelledby={headingId} bind:this={gridEl}>
	<tbody>
		<!-- Keyed by position, as the day grid: the focused cell is reused across pages. -->
		{#each rows as row, r (r)}
			<tr>
				{#each row as period, c (c)}
					{@const valid = isPeriodValid(period, unit)}
					<td
						data-period={valid ? period : undefined}
						tabindex={valid ? (period === focus ? 0 : -1) : undefined}
						aria-label={valid ? cellLabel(period) : undefined}
						aria-selected={valid ? (period === selectedPeriod ? 'true' : 'false') : undefined}
						aria-current={valid && period === todayPeriod ? 'true' : undefined}
						aria-disabled={valid && !isDisabled(period) ? undefined : 'true'}
						class:date-picker-period--empty={!valid}
						onmousedown={(event) => {
							// A period that cannot be tracked keeps focus on the tracked one.
							if (isDisabled(period)) event.preventDefault();
						}}
						onclick={() => {
							if (valid) handleCellClick(period);
							else focusCell();
						}}
					>
						{valid ? cellText(period) : ''}
					</td>
				{/each}
			</tr>
		{/each}
	</tbody>
</table>

<style>
	.date-picker-header {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		margin-block-end: var(--banto-space-2);
	}

	.date-picker-heading {
		flex: 1 1 0;
		min-inline-size: 0;
		margin: 0;
		font-size: var(--banto-font-size-md);
		font-weight: 600;
		text-align: center;
		overflow-wrap: break-word;
	}

	.date-picker-heading-button {
		max-inline-size: 100%;
		padding-block: 0;
		padding-inline: var(--banto-space-1);
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: inherit;
		font: inherit;
		overflow-wrap: inherit;
		cursor: pointer;
	}

	.date-picker-heading-button:hover {
		background: var(--banto-surface-hover);
	}

	.date-picker-heading-button:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* The same box as the day grid (7 cells wide; a header row + 6 weeks = 7
	   cells tall), so the dialog keeps its size between the views. */
	.date-picker-period-grid {
		table-layout: fixed;
		inline-size: calc(7 * var(--banto-date-cell-size));
		block-size: calc(7 * var(--banto-date-cell-size));
		border-collapse: separate;
		border-spacing: var(--banto-space-1);
		margin-inline: auto;
	}

	.date-picker-period-grid td {
		/* 4 rows and 5 gaps of border-spacing fill the 7-cell height. */
		block-size: calc((7 * var(--banto-date-cell-size) - 5 * var(--banto-space-1)) / 4);
		padding: 0;
		border-radius: var(--banto-radius-sm);
		font-size: min(1em, calc(var(--banto-date-cell-size) / 1.4));
		font-variant-numeric: tabular-nums;
		text-align: center;
		overflow-wrap: anywhere;
		cursor: pointer;
	}

	.date-picker-period-grid td.date-picker-period--empty {
		cursor: default;
	}

	.date-picker-period-grid td:hover:not([aria-disabled='true']) {
		background: var(--banto-surface-hover);
	}

	.date-picker-period-grid td[aria-current='true'] {
		box-shadow: inset 0 0 0 var(--banto-border-width) var(--banto-border-strong);
		font-weight: 600;
	}

	.date-picker-period-grid td[aria-selected='true'] {
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
	}

	.date-picker-period-grid td[aria-disabled='true']:not(.date-picker-period--empty) {
		color: var(--banto-text-muted);
		text-decoration: line-through;
		opacity: 0.55;
		cursor: not-allowed;
	}

	.date-picker-period-grid td:focus {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.date-picker-period-grid td[aria-current='true']:focus {
		box-shadow:
			inset 0 0 0 var(--banto-border-width) var(--banto-border-strong),
			var(--banto-focus-ring);
	}

	@media (forced-colors: active) {
		.date-picker-period-grid td[aria-selected='true'] {
			forced-color-adjust: none;
			background: Highlight;
			color: HighlightText;
		}

		.date-picker-period-grid td[aria-current='true'] {
			outline: var(--banto-border-width) solid CanvasText;
			outline-offset: calc(-1 * var(--banto-border-width));
		}

		.date-picker-period-grid td[aria-disabled='true'] {
			color: GrayText;
		}

		.date-picker-period-grid td:focus,
		.date-picker-heading-button:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
