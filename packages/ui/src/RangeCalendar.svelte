<script module lang="ts">
	import { createSubscriber } from 'svelte/reactivity';

	/**
	 * Below this width the extended calendar shows one month: two need about
	 * 14 day cells plus the gaps (a part's own shape, not a theme step).
	 */
	const ONE_MONTH_QUERY = '(max-width: 600px)';

	/** The query as reactive state (the `narrowViewport` pattern; `false` without `matchMedia`). */
	class OneMonthViewport {
		readonly #subscribe = createSubscriber((update) => {
			if (typeof window.matchMedia !== 'function') return;
			const query = window.matchMedia(ONE_MONTH_QUERY);
			query.addEventListener('change', update);
			return () => query.removeEventListener('change', update);
		});

		get current(): boolean {
			if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
			this.#subscribe();
			return window.matchMedia(ONE_MONTH_QUERY).matches;
		}
	}

	const oneMonthViewport = new OneMonthViewport();
</script>

<script lang="ts">
	/**
	 * The extended calendar (internal, not exported; Issue #910): the one
	 * calendar behind `DatePicker` (`mode="single"`) and `DateRangePicker`
	 * (`mode="range"`). The day grid, its keys (arrows, Home / End, PageUp /
	 * PageDown, Enter / Space), the roving focus, the aria, `min` / `max`, the
	 * heading's month / year views (#908) and Esc's `back()` are
	 * `MonthCalendar`'s - this component adds what is the extended one's own:
	 *
	 * - Two months side by side (`months`, default 2), one on a narrow screen
	 *   (600px or less).
	 * - The range: the first pick (click, Enter / Space) is the start
	 *   (`anchor`, bindable so the dialog can say what comes next), the second
	 *   the end; a second pick before the start swaps them (`orderedRange`).
	 *   Until the second pick the days from the start to the day under the
	 *   pointer - or, from the keyboard, the focused day - are painted as a
	 *   preview. A value with only one end shows that day.
	 *
	 * What a pick means is the parent's (`onSelect`, `onRangeSelect`): it sets
	 * the value and closes the dialog.
	 */
	import { isOutOfRange, orderedRange, type CalendarRange, type Weekday } from './datetime';
	import type { UiMessages } from './messages';
	import MonthCalendar from './MonthCalendar.svelte';

	interface Props {
		mode: 'single' | 'range';
		/** The tracked day (canonical `YYYY-MM-DD`, bindable). */
		focusDate: string;
		/** `single`: the value's day, or `null`. */
		selectedDate?: string | null;
		/** `range`: the value's start day, or `null`. */
		from?: string | null;
		/** `range`: the value's end day, or `null`. */
		to?: string | null;
		/** `range`: the start picked while the end is still to come (bindable), or `null`. */
		anchor?: string | null;
		/** Months side by side on a wide screen (default 2). */
		months?: 1 | 2;
		today: string;
		min?: string;
		max?: string;
		isDateDisabled?: (date: string) => boolean;
		locale: string;
		weekStart: Weekday;
		t: Required<UiMessages>;
		scroller?: HTMLElement;
		/** `single`: a selectable day was picked. */
		onSelect?: (date: string) => void;
		/** `range`: the second pick - the range's ends in date order. */
		onRangeSelect?: (from: string, to: string) => void;
	}

	let {
		mode,
		focusDate = $bindable(),
		selectedDate = null,
		from = null,
		to = null,
		anchor = $bindable(null),
		months = 2,
		today,
		min,
		max,
		isDateDisabled,
		locale,
		weekStart,
		t,
		scroller,
		onSelect,
		onRangeSelect
	}: Props = $props();

	let calendar: ReturnType<typeof MonthCalendar> | undefined = $state();
	/** The day under the pointer (the preview's end), or `null`. */
	let hover = $state<string | null>(null);

	const shown = $derived<1 | 2>(months === 2 && !oneMonthViewport.current ? 2 : 1);

	const range = $derived.by((): CalendarRange | null => {
		if (mode !== 'range') return null;
		if (anchor) return { start: anchor, end: hover ?? focusDate, preview: true };
		const start = from ?? to;
		const end = to ?? from;
		return start && end ? { start, end, preview: false } : null;
	});

	export function focusCell(): void {
		calendar?.focusCell();
	}

	/** Esc's first stop (`MonthCalendar.back`). */
	export function back(): boolean {
		return calendar?.back() ?? false;
	}

	function handlePick(date: string): void {
		if (mode === 'single') {
			onSelect?.(date);
			return;
		}
		// No start yet - or the start can no longer be an end (`min` / `max` /
		// `isDateDisabled` changed since it was picked): this pick is the start.
		if (anchor === null || isOutOfRange(anchor, min, max) || isDateDisabled?.(anchor)) {
			anchor = date;
			return;
		}
		const [start, end] = orderedRange(anchor, date);
		anchor = null;
		hover = null;
		onRangeSelect?.(start, end);
	}
</script>

<div class="range-calendar" class:range-calendar--two={shown === 2}>
	<MonthCalendar
		bind:this={calendar}
		bind:focusDate
		selectedDate={mode === 'single' ? selectedDate : (anchor ?? from ?? to)}
		{today}
		{min}
		{max}
		{isDateDisabled}
		{locale}
		{weekStart}
		{t}
		{scroller}
		months={shown}
		selectionMode={mode}
		{range}
		onHover={mode === 'range' ? (date) => (hover = date) : undefined}
		onPick={handlePick}
	/>
</div>

<style>
	/* Two months: 14 cells (and the gap between the months) share the width
	   that 7 have with one month (the dialog's own value). */
	.range-calendar--two {
		--banto-date-cell-size: min(
			2.25rem,
			calc((100vw - 2 * var(--banto-space-3) - 2 * var(--banto-space-4)) / 14)
		);
	}
</style>
