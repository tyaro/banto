<script lang="ts">
	/**
	 * The month calendar inside the date pickers' dialog (internal, not
	 * exported): the month / year buttons, the heading and the day grid of
	 * docs/design/date-time-pickers.md §5.4 (APG Date Picker Dialog). Shared
	 * by `DateInput` (PR-1) and `DateTimeInput` (PR-5); the dialog itself -
	 * the popover, the focus trap, Esc, the footer - stays with them.
	 *
	 * - `focusDate` (bindable) is the tracked day: the one cell in the tab
	 *   order (roving tabindex), and the month shown. The parent sets it when
	 *   the dialog opens and calls `focusCell()` once the cells exist.
	 * - The grid's keys (arrows, Home / End, PageUp / PageDown with Shift for
	 *   a year, Enter / Space) are handled by a native listener on the grid,
	 *   so they run before the dialog's own native keydown listener (which
	 *   stops every key, §5.8 promise 1). Enter / Space and a click pick a
	 *   selectable day through `onPick`; what picking means is the parent's.
	 * - Month and year views (Issue #908): the heading's year and month are
	 *   buttons. The month button shows the year's 12 months, the year button
	 *   12 years (`CalendarPeriodView`); picking a year shows its months,
	 *   picking a month shows its days (moving `focusDate` there). Esc is the
	 *   parent's one path (`closeOnEscape`, with its IME / consumed-key /
	 *   layer checks): it first calls `back()`, which in the month / year view
	 *   goes back one view (year -> month -> day) so the dialog stays open, and
	 *   in the day view closes as before - wherever focus is in the dialog.
	 *   The view is not kept: the dialog opens on the day view.
	 * - A view switch removes the focused element (a heading button, a cell),
	 *   so focus is parked on this component's wrapper first: it never drops
	 *   to <body>, which the parent would read as "focus left" and close.
	 * - The extended calendar (Issue #910, `RangeCalendar`) reuses this one
	 *   through optional props, whose defaults keep the plain pickers as they
	 *   are: `months={2}` shows two months side by side (the days of the
	 *   neighbouring months are empty slots then, so a day is never shown
	 *   twice; focus moving past the shown months scrolls the view just far
	 *   enough), `selectionMode="range"` paints `range` (its ends and the days
	 *   between; `aria-selected` on all of them once both ends are chosen,
	 *   `aria-multiselectable` on the grid), `onHover` reports the day under
	 *   the pointer (the range preview).
	 */
	import { flushSync } from 'svelte';
	import { revealInPopover } from './anchoredPopover';
	import CalendarNavButton from './CalendarNavButton.svelte';
	import CalendarPeriodView from './CalendarPeriodView.svelte';
	import {
		addDays,
		addMonths,
		addYears,
		clampDate,
		clampPeriod,
		endOfWeek,
		firstShownMonth,
		formatFullDate,
		isOutOfRange,
		isSameMonth,
		monthGrid,
		monthOfPeriod,
		monthStartOfPeriod,
		monthYearParts,
		orderedRange,
		periodOf,
		periodPageStart,
		shownMonthOffset,
		startOfWeek,
		weekdayNames,
		withYearMonth,
		type CalendarRange,
		type Weekday
	} from './datetime';
	import ChevronLeft from './icons/ChevronLeft.svelte';
	import ChevronRight from './icons/ChevronRight.svelte';
	import ChevronsLeft from './icons/ChevronsLeft.svelte';
	import ChevronsRight from './icons/ChevronsRight.svelte';
	import type { UiMessages } from './messages';

	interface Props {
		/** The tracked day (canonical `YYYY-MM-DD`). */
		focusDate: string;
		/** The day shown as chosen (`aria-selected`), or `null`. */
		selectedDate: string | null;
		/** Today's date (`aria-current="date"`). */
		today: string;
		/** Earliest day that can be tracked and picked (canonical, inclusive). */
		min?: string;
		/** Latest day that can be tracked and picked (canonical, inclusive). */
		max?: string;
		/** Days that can be focused but not picked. */
		isDateDisabled?: (date: string) => boolean;
		locale: string;
		weekStart: Weekday;
		/** Resolved messages (the parent's defaults merged with its `messages`). */
		t: Required<UiMessages>;
		/** The dialog that scrolls when its height is capped (where a focused day is revealed). */
		scroller?: HTMLElement;
		/** A selectable day was picked (Enter / Space / click). */
		onPick: (date: string) => void;
		/** Months shown side by side in the day view (Issue #910). Default 1. */
		months?: 1 | 2;
		/** `'range'`: the days of `range` are the selection (Issue #910). Default `'single'` (`selectedDate`). */
		selectionMode?: 'single' | 'range';
		/** The range painted in `'range'` mode, or `null`. */
		range?: CalendarRange | null;
		/** The pointer moved onto a day, or left the calendar (`null`) - the range preview. */
		onHover?: (date: string | null) => void;
	}

	let {
		focusDate = $bindable(),
		selectedDate,
		today,
		min,
		max,
		isDateDisabled,
		locale,
		weekStart,
		t,
		scroller,
		onPick,
		months = 1,
		selectionMode = 'single',
		range = null,
		onHover
	}: Props = $props();

	const uid = $props.id();
	const headingId = `${uid}-heading`;

	let rootEl: HTMLDivElement | undefined = $state();
	let periodView: ReturnType<typeof CalendarPeriodView> | undefined = $state();

	/** Which view is shown: the days of a month, the months of a year, or 12 years. */
	let view = $state<'day' | 'month' | 'year'>('day');
	/** The month view's tracked month and first month (periods, `datetime.ts`). */
	let monthFocus = $state(0);
	let monthPage = $state(0);
	/** The year view's tracked year and first year. */
	let yearFocus = $state(0);
	let yearPage = $state(0);

	/** Where the tracked day's month sits among the shown months (0 with one month). */
	let offset = $state(0);

	const weekdays = $derived(weekdayNames(locale, weekStart));
	const firstMonth = $derived(focusDate ? firstShownMonth(focusDate, offset, months) : 0);
	/** `YYYY-MM-01` of each month shown in the day view, left to right. */
	const shownMonths = $derived(
		focusDate ? Array.from({ length: months }, (_, i) => monthStartOfPeriod(firstMonth + i)) : []
	);
	/** The range's ends in date order. */
	const rangeEnds = $derived(range ? orderedRange(range.start, range.end) : null);

	function headingIdOf(index: number): string {
		return index === 0 ? headingId : `${headingId}-${index}`;
	}

	/** `aria-selected` of a day: the value's day, or (range) the range - only its first day while the end is a preview. */
	function isSelected(date: string): boolean {
		if (selectionMode === 'single') return date === selectedDate;
		if (!range || !rangeEnds) return false;
		if (range.preview) return date === range.start;
		return date >= rangeEnds[0] && date <= rangeEnds[1];
	}

	function inRange(date: string): boolean {
		return !!rangeEnds && date >= rangeEnds[0] && date <= rangeEnds[1];
	}

	export function isSelectable(date: string): boolean {
		return !isOutOfRange(date, min, max) && !isDateDisabled?.(date);
	}

	/** Focus the tracked day's cell (after the cells were rendered). */
	export function focusCell(): void {
		const cell = rootEl?.querySelector<HTMLElement>(`td[data-date="${focusDate}"]`);
		if (!cell) return;
		// `preventScroll`: never scroll the page / ancestors (an ancestor scroll
		// would close the popover). But when `computeAnchoredPosition` capped the
		// dialog's height (a short viewport) the dialog scrolls inside, so bring
		// the focused day into its visible box by hand - `scrollIntoView` would
		// move the ancestors too.
		cell.focus({ preventScroll: true });
		if (scroller) revealInPopover(scroller, cell);
	}

	function moveFocus(date: string): void {
		const next = clampDate(date, min, max);
		if (months > 1) {
			const at = shownMonthOffset(next, firstMonth, months);
			// The shown months scroll: the focused cell may become an empty slot
			// (no longer focusable). Park focus on the wrapper first, as a view
			// switch does, so it never drops to <body>.
			if (firstShownMonth(next, at, months) !== firstMonth) parkFocus();
			offset = at;
		}
		focusDate = next;
		flushSync();
		focusCell();
	}

	/** Focus is in the calendar: hold it on the wrapper while its element goes away. */
	function parkFocus(): boolean {
		if (!rootEl?.contains(document.activeElement)) return false;
		rootEl.focus({ preventScroll: true });
		return true;
	}

	/**
	 * A click on a cell: move the tracked day there (the view follows into a
	 * neighbouring month) and focus it, then pick it if it can be picked. A
	 * cell that cannot be tracked (empty slot, outside [min, max]) only puts
	 * focus back on the tracked day. Either way focus ends on the focusDate
	 * cell (or wherever the parent's `onPick` moves it).
	 */
	function handleDayClick(date: string | null): void {
		if (date === null || isOutOfRange(date, min, max)) {
			focusCell();
			return;
		}
		moveFocus(date);
		if (isSelectable(date)) onPick(date);
	}

	/** Month / year buttons: the target moved into range; disabled when that stays in this month. */
	function navTarget(months: number): string {
		return clampDate(addMonths(focusDate, months), min, max);
	}

	function navDisabled(months: number): boolean {
		return isSameMonth(navTarget(months), focusDate);
	}

	function navigate(months: number): void {
		if (navDisabled(months)) return;
		focusDate = navTarget(months);
	}

	// --- month / year views (Issue #908) -------------------------------------

	function setMonthView(period: number): void {
		monthFocus = clampPeriod(period, 'month', min, max);
		monthPage = periodPageStart(monthFocus, 'month');
	}

	function setYearView(year: number): void {
		yearFocus = clampPeriod(year, 'year', min, max);
		yearPage = periodPageStart(yearFocus, 'year');
	}

	/**
	 * Show `next` and focus its tracked cell. Focus is parked on the wrapper
	 * first: the element that has it (a heading button, a cell) is removed
	 * with the old view, and a focus drop to <body> would close the dialog.
	 */
	function showView(next: 'day' | 'month' | 'year', { focus = true } = {}): void {
		// Focus was in the calendar: it follows to the new view's cell.
		if (parkFocus()) focus = true;
		view = next;
		flushSync();
		if (!focus) return;
		if (next === 'day') focusCell();
		else periodView?.focusCell();
	}

	/** `month`: the shown month whose heading was pressed (the tracked day's by default). */
	function openMonthView(month: string = focusDate): void {
		setMonthView(periodOf(month, 'month'));
		showView('month');
	}

	function openYearView(month: string = focusDate): void {
		// Escape from the year view lands on the month view: give it the
		// pressed heading's month when the year view is entered from the days.
		if (view === 'day') setMonthView(periodOf(month, 'month'));
		setYearView(view === 'month' ? Math.floor(monthPage / 12) : periodOf(month, 'year'));
		showView('year');
	}

	function pickYear(year: number): void {
		const month = monthOfPeriod(monthFocus).month;
		setMonthView(year * 12 + (month - 1));
		showView('month');
	}

	function pickMonth(period: number): void {
		const { year, month } = monthOfPeriod(period);
		focusDate = withYearMonth(focusDate, year, month, min, max);
		// Several months: the picked month is the first one shown.
		offset = 0;
		showView('day');
	}

	/**
	 * Esc's first stop (the parent's one Esc path calls it before closing,
	 * wherever focus is in the dialog - a cell, the footer, DateTimeInput's
	 * time list): in the month / year view go back one view and return
	 * `true` (the parent consumes the key and stays open); in the day view
	 * return `false` (the parent closes). Focus moves to the new view's cell
	 * only when it was in the calendar; from the footer / time list it stays.
	 */
	export function back(): boolean {
		if (view === 'day') return false;
		showView(view === 'year' ? 'month' : 'day', { focus: false });
		return true;
	}

	function handleGridKey(event: KeyboardEvent): void {
		// IME 変換中のキーは変換のもの。日を動かさない（#907 と同じ判定）。
		if (event.isComposing || event.keyCode === 229) return;
		const target = event.target;
		if (!(target instanceof HTMLElement) || !target.dataset.date) return;
		let next: string | undefined;
		switch (event.key) {
			case 'ArrowLeft':
				next = addDays(focusDate, -1);
				break;
			case 'ArrowRight':
				next = addDays(focusDate, 1);
				break;
			case 'ArrowUp':
				next = addDays(focusDate, -7);
				break;
			case 'ArrowDown':
				next = addDays(focusDate, 7);
				break;
			case 'Home':
				next = startOfWeek(focusDate, weekStart);
				break;
			case 'End':
				next = endOfWeek(focusDate, weekStart);
				break;
			case 'PageUp':
				next = event.shiftKey ? addYears(focusDate, -1) : addMonths(focusDate, -1);
				break;
			case 'PageDown':
				next = event.shiftKey ? addYears(focusDate, 1) : addMonths(focusDate, 1);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (isSelectable(focusDate)) onPick(focusDate);
				return;
			default:
				return;
		}
		event.preventDefault();
		moveFocus(next);
	}

	// A native listener on each grid: it runs before the dialog's own native
	// keydown listener, which stops every key (Svelte would delegate
	// `onkeydown` to the app root, past that listener).
	function gridKeys(grid: HTMLTableElement): () => void {
		grid.addEventListener('keydown', handleGridKey);
		return () => grid.removeEventListener('keydown', handleGridKey);
	}
</script>

{#snippet yearButton(month: string, text: string)}<button
		type="button"
		class="date-picker-heading-button"
		title={t.datePickerChooseYear()}
		onclick={() => openYearView(month)}
	>
		{text}
	</button>{/snippet}
{#snippet monthButton(month: string, text: string)}<button
		type="button"
		class="date-picker-heading-button"
		title={t.datePickerChooseMonth()}
		onclick={() => openMonthView(month)}
	>
		{text}
	</button>{/snippet}

<!-- The wrapper takes focus only for a moment, while a view switch removes the focused element.
     Its mouseleave only ends the range preview (pointer-only feedback; the
     keyboard previews to the focused day). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="date-picker-calendar"
	tabindex="-1"
	bind:this={rootEl}
	onmouseleave={onHover ? () => onHover(null) : undefined}
>
	{#if view === 'day'}
		{#if months === 1}
			{@render monthHeader(shownMonths[0], 0)}
			{@render dayGrid(shownMonths[0], 0)}
		{:else}
			<div class="date-picker-months">
				{#each shownMonths as month, i (i)}
					<div class="date-picker-month">
						{@render monthHeader(month, i)}
						{@render dayGrid(month, i)}
					</div>
				{/each}
			</div>
		{/if}
	{:else if view === 'month'}
		<CalendarPeriodView
			bind:this={periodView}
			unit="month"
			bind:focus={monthFocus}
			bind:pageStart={monthPage}
			{selectedDate}
			{today}
			{min}
			{max}
			{locale}
			{t}
			{scroller}
			onPick={pickMonth}
			onHeading={openYearView}
		/>
	{:else}
		<CalendarPeriodView
			bind:this={periodView}
			unit="year"
			bind:focus={yearFocus}
			bind:pageStart={yearPage}
			{selectedDate}
			{today}
			{min}
			{max}
			{locale}
			{t}
			{scroller}
			onPick={pickYear}
		/>
	{/if}
</div>

<!-- The heading of one shown month: the previous buttons before the first
     month, the next buttons after the last (all four with one month). With
     two months a spacer as wide as the missing buttons keeps each heading
     centred over its grid. -->
{#snippet monthHeader(month: string, index: number)}
	{@const parts = monthYearParts(month, locale)}
	<div class="date-picker-header">
		{#if index === 0}
			<CalendarNavButton
				label={t.datePickerPrevYear()}
				disabled={navDisabled(-12)}
				onclick={() => navigate(-12)}
			>
				<ChevronsLeft size={16} aria-hidden="true" />
			</CalendarNavButton>
			<CalendarNavButton
				label={t.datePickerPrevMonth()}
				disabled={navDisabled(-1)}
				onclick={() => navigate(-1)}
			>
				<ChevronLeft size={16} aria-hidden="true" />
			</CalendarNavButton>
		{:else}
			<span class="date-picker-nav-spacer" aria-hidden="true"></span>
		{/if}
		<!-- The year and the month in the locale's order ("2026年11月", "November 2026"). -->
		<h2 id={headingIdOf(index)} class="date-picker-heading" aria-live="polite">
			{#if parts.yearFirst}{@render yearButton(
					month,
					parts.year
				)}{parts.separator}{@render monthButton(month, parts.month)}{:else}{@render monthButton(
					month,
					parts.month
				)}{parts.separator}{@render yearButton(month, parts.year)}{/if}
		</h2>
		{#if index === months - 1}
			<CalendarNavButton
				label={t.datePickerNextMonth()}
				disabled={navDisabled(1)}
				onclick={() => navigate(1)}
			>
				<ChevronRight size={16} aria-hidden="true" />
			</CalendarNavButton>
			<CalendarNavButton
				label={t.datePickerNextYear()}
				disabled={navDisabled(12)}
				onclick={() => navigate(12)}
			>
				<ChevronsRight size={16} aria-hidden="true" />
			</CalendarNavButton>
		{:else}
			<span class="date-picker-nav-spacer" aria-hidden="true"></span>
		{/if}
	</div>
{/snippet}

{#snippet dayGrid(month: string, index: number)}
	{@const weeks = monthGrid(month, weekStart)}
	<table
		class="date-picker-grid"
		role="grid"
		aria-labelledby={headingIdOf(index)}
		aria-multiselectable={selectionMode === 'range' ? 'true' : undefined}
		{@attach gridKeys}
	>
		<thead>
			<tr>
				{#each weekdays as day (day.weekday)}
					<th scope="col" abbr={day.long}>{day.short}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			<!-- Keyed by position on purpose: the cells are reused across months,
		     so the focused one is never removed mid-move (a removed focus target
		     would read as "focus left the component"). -->
			{#each weeks as week, w (w)}
				<tr>
					{#each week as slot, d (d)}
						<!-- One <td> per position whether it holds a day or an empty slot
					     (before 0001-01-01 / after 9999-12-31, or - with several months -
					     a day of a neighbouring month), so a month change never
					     replaces the element that has focus. -->
						{@const date = slot !== null && months > 1 && !isSameMonth(slot, month) ? null : slot}
						{@const ranged = date !== null && selectionMode === 'range' && inRange(date)}
						<td
							data-date={date ?? undefined}
							tabindex={date === null ? undefined : date === focusDate ? 0 : -1}
							aria-label={date === null ? undefined : formatFullDate(date, locale)}
							aria-selected={date === null ? undefined : isSelected(date) ? 'true' : 'false'}
							aria-current={date !== null && date === today ? 'date' : undefined}
							aria-disabled={date === null || isSelectable(date) ? undefined : 'true'}
							class:date-picker-day--outside={date !== null && !isSameMonth(date, month)}
							class:date-picker-day--empty={date === null}
							class:date-picker-day--in-range={ranged}
							class:date-picker-day--range-start={ranged && date === rangeEnds?.[0]}
							class:date-picker-day--range-end={ranged && date === rangeEnds?.[1]}
							class:date-picker-day--preview={ranged && !!range?.preview}
							onmouseenter={onHover && date !== null ? () => onHover(date) : undefined}
							onmousedown={(event) => {
								// An empty slot or a day outside [min, max] cannot be focused:
								// keep focus on the tracked day, so focusDate and the focused
								// cell never part ways.
								if (date === null || isOutOfRange(date, min, max)) event.preventDefault();
							}}
							onclick={() => handleDayClick(date)}
						>
							{date === null ? '' : Number(date.slice(8))}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
{/snippet}

<style>
	.date-picker-calendar:focus {
		outline: none;
	}

	.date-picker-header {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		margin-block-end: var(--banto-space-2);
	}

	.date-picker-heading {
		flex: 1 1 0;
		/* Shrinkable below its text width, and wraps: at 200% text the month label
		   must not push the prev/next buttons out of the popover. */
		min-inline-size: 0;
		margin: 0;
		font-size: var(--banto-font-size-md);
		font-weight: 600;
		text-align: center;
		overflow-wrap: break-word;
	}

	/* The heading's year and month: they read as the heading, and show they
	   can be pressed on hover / focus (Issue #908). */
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

	/* The grid is exactly seven cells wide, and on a narrow screen with large
	   text the labels shrink with the cell: a wide font's "30" at 200% is wider
	   than the cell and would push the table out of its popover. */
	.date-picker-grid {
		table-layout: fixed;
		inline-size: calc(7 * var(--banto-date-cell-size));
		border-collapse: collapse;
		margin-inline: auto;
	}

	.date-picker-grid th {
		block-size: var(--banto-date-cell-size);
		padding: 0;
		color: var(--banto-text-muted);
		font-size: min(var(--banto-font-size-sm), calc(var(--banto-date-cell-size) / 2.4));
		font-weight: 500;
		text-align: center;
	}

	.date-picker-grid td {
		inline-size: var(--banto-date-cell-size);
		block-size: var(--banto-date-cell-size);
		padding: 0;
		border-radius: var(--banto-radius-sm);
		font-size: min(1em, calc(var(--banto-date-cell-size) / 1.4));
		font-variant-numeric: tabular-nums;
		text-align: center;
		cursor: pointer;
	}

	.date-picker-grid td.date-picker-day--outside {
		color: var(--banto-text-muted);
	}

	.date-picker-grid td.date-picker-day--empty {
		cursor: default;
	}

	.date-picker-grid td:hover:not([aria-disabled='true'], .date-picker-day--empty) {
		background: var(--banto-surface-hover);
	}

	.date-picker-grid td[aria-current='date'] {
		box-shadow: inset 0 0 0 var(--banto-border-width) var(--banto-border-strong);
		font-weight: 600;
	}

	.date-picker-grid td[aria-selected='true'] {
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
	}

	/* The extended calendar's range (Issue #910): the days between the ends
	   on a tint of the primary colour, the ends solid (aria-selected above).
	   While the end is a preview, the day under the pointer / focus is
	   outlined instead. */
	.date-picker-grid
		td.date-picker-day--in-range:not(.date-picker-day--range-start, .date-picker-day--range-end) {
		border-radius: 0;
		background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
		color: var(--banto-text);
	}

	.date-picker-grid
		td.date-picker-day--preview:not([aria-selected='true']):is(
			.date-picker-day--range-start,
			.date-picker-day--range-end
		) {
		background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
		box-shadow: inset 0 0 0 var(--banto-border-width-strong) var(--banto-primary);
	}

	.date-picker-grid td[aria-disabled='true'] {
		color: var(--banto-text-muted);
		text-decoration: line-through;
		opacity: 0.55;
		cursor: not-allowed;
	}

	.date-picker-grid td:focus {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.date-picker-grid td[aria-current='date']:focus {
		box-shadow:
			inset 0 0 0 var(--banto-border-width) var(--banto-border-strong),
			var(--banto-focus-ring);
	}

	/* Two months side by side (Issue #910). */
	.date-picker-months {
		display: flex;
		align-items: flex-start;
		gap: var(--banto-space-4);
	}

	.date-picker-month {
		flex: 0 0 auto;
	}

	/* As wide as the two buttons it stands in for (with the gap between them). */
	.date-picker-nav-spacer {
		flex: 0 0 auto;
		inline-size: calc(2 * var(--banto-control-height-sm) + var(--banto-space-1));
	}

	@media (forced-colors: active) {
		.date-picker-grid td[aria-selected='true'] {
			forced-color-adjust: none;
			background: Highlight;
			color: HighlightText;
		}

		.date-picker-grid td[aria-current='date'] {
			outline: var(--banto-border-width) solid CanvasText;
			outline-offset: calc(-1 * var(--banto-border-width));
		}

		.date-picker-grid td[aria-disabled='true'] {
			color: GrayText;
		}

		.date-picker-grid
			td.date-picker-day--in-range:not(.date-picker-day--range-start, .date-picker-day--range-end),
		.date-picker-grid
			td.date-picker-day--preview:not([aria-selected='true']):is(
				.date-picker-day--range-start,
				.date-picker-day--range-end
			) {
			forced-color-adjust: none;
			background: Canvas;
			color: CanvasText;
			outline: var(--banto-border-width) dashed Highlight;
			outline-offset: calc(-1 * var(--banto-border-width));
		}

		.date-picker-grid td:focus,
		.date-picker-heading-button:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
