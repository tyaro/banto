<script lang="ts">
	/**
	 * Date range picker with the extended calendar (Issue #910): two text
	 * boxes - the start day and the end day, both inclusive - and ONE calendar
	 * in which the range is picked: the first pick is the start, the second
	 * the end (a second pick before the start swaps them). Until the second
	 * pick the days up to the one under the pointer (or the focused day) are
	 * painted as a preview. Two months side by side, one on a narrow screen.
	 *
	 * The boxes are `DateRangeInput`'s: in a `role="group"` named by `label` /
	 * `labelledBy`, named `dateRangeStart` / `dateRangeEnd`, typed into
	 * leniently (each end parsed on its blur / Enter, as `DateInput`), and
	 * the value is the same `{ from, to }` (canonical or `null`, an open end).
	 * Typed ends are not checked against each other - the host decides how to
	 * show `from > to` (date-time-pickers D14); the calendar always gives them
	 * in order.
	 *
	 * The dialog (`PickerDialog`) opens from the button or Alt+ArrowDown in
	 * either box, on the typed / current start; Esc goes back one calendar
	 * view and then closes (a start picked but no end is dropped), focus
	 * returns to the box it opened from (the start box from the button).
	 * Host promises as DateInput's (§5.8): keys inside the dialog and
	 * `pointerdown` stay inside; `onblur` fires only when focus leaves the
	 * whole group.
	 *
	 * Simple vs extended: `DateRangeInput` stays two `DateInput`s with a
	 * calendar each; this one picks both ends in one calendar.
	 */
	import { untrack } from 'svelte';
	import { createTextMirror, type TextMirror } from './textMirror.svelte.js';
	import {
		clampDate,
		formatFullDate,
		isBlankDateText,
		isIsoDate,
		isOutOfRange,
		parseDateText,
		resolveWeekStart,
		todayDate
	} from './datetime';
	import Calendar from './icons/Calendar.svelte';
	import { defaultUiMessages, type UiMessages } from './messages';
	import PickerDialog from './PickerDialog.svelte';
	import RangeCalendar from './RangeCalendar.svelte';
	import { stopPointerdown } from './stopPointerdown';

	/** A day range: inclusive canonical `YYYY-MM-DD` ends, `null` when open. */
	interface DateRange {
		from: string | null;
		to: string | null;
	}

	type End = 'from' | 'to';

	interface Props {
		/** The range (bindable). */
		value?: DateRange;
		/** Called with the new range when either end's value changes. */
		onValueChange?: (value: DateRange) => void;
		/** Every change of either box's typed text, including the canonical rewrite. */
		onTextInput?: (end: End, text: string) => void;
		/** id of the group. */
		id?: string;
		/** Accessible name of the group (`aria-label`); `labelledBy` wins. */
		label?: string;
		/** id of the element that names the group (`aria-labelledby`). */
		labelledBy?: string;
		/** Extra ids for both text boxes' `aria-describedby` (an error message). */
		describedBy?: string;
		invalid?: boolean;
		disabled?: boolean;
		readonly?: boolean;
		/** Earliest selectable day for both ends (canonical, inclusive). */
		min?: string;
		/** Latest selectable day for both ends (canonical, inclusive). */
		max?: string;
		/** Days that cannot be an end (the days between may be any). */
		isDateDisabled?: (date: string) => boolean;
		/** BCP 47 tag for the month / weekday names (default `'ja-JP'`). */
		locale?: string;
		weekStartsOn?: number;
		/** Months side by side on a wide screen (default 2; one at 600px or less). */
		months?: 1 | 2;
		messages?: UiMessages;
		/** Keys from either text box (after the picker handled its own). */
		onkeydown?: (event: KeyboardEvent) => void;
		/** Focus left the whole range. */
		onblur?: (event: FocusEvent) => void;
		/** The start day's text box (bindable). */
		fromInputEl?: HTMLInputElement;
		/** The end day's text box (bindable). */
		toInputEl?: HTMLInputElement;
	}

	let {
		value = $bindable({ from: null, to: null }),
		onValueChange,
		onTextInput,
		id,
		label,
		labelledBy,
		describedBy,
		invalid = false,
		disabled = false,
		readonly = false,
		min,
		max,
		isDateDisabled,
		locale = 'ja-JP',
		weekStartsOn,
		months = 2,
		messages,
		onkeydown,
		onblur,
		fromInputEl = $bindable(),
		toInputEl = $bindable()
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });
	const uid = $props.id();
	const hintId = `${uid}-hint`;
	const statusId = `${uid}-status`;
	const describedIds = $derived(describedBy ? `${hintId} ${describedBy}` : hintId);

	// --- text and value --------------------------------------------------

	const mirrors: Record<End, TextMirror> = {
		from: createTextMirror({ value: () => value?.from }),
		to: createTextMirror({ value: () => value?.to })
	};

	const valueFrom = $derived(value?.from && isIsoDate(value.from) ? value.from : null);
	const valueTo = $derived(value?.to && isIsoDate(value.to) ? value.to : null);

	function setText(end: End, next: string): void {
		mirrors[end].setText(next);
		onTextInput?.(end, next);
	}

	/** Set both ends at once (one `onValueChange`). */
	function setRange(next: DateRange): void {
		const current = value ?? { from: null, to: null };
		const same = (a: string | null, b: string | null) => (isBlankDateText(a) ? null : a) === b;
		if (same(current.from, next.from) && same(current.to, next.to)) return;
		mirrors.from.committed(next.from);
		mirrors.to.committed(next.to);
		value = next;
		onValueChange?.(next);
	}

	/** Parse one box's typed text (its blur, Enter): canonical -> that end, blank -> null, otherwise leave it. */
	function commit(end: End): void {
		const raw = mirrors[end].text;
		let next: string | null = null;
		if (!isBlankDateText(raw)) {
			next = parseDateText(raw);
			if (next === null) return;
		}
		if ((next ?? '') !== raw) setText(end, next ?? '');
		const current = value ?? { from: null, to: null };
		setRange({ from: current.from ?? null, to: current.to ?? null, [end]: next });
	}

	// --- dialog ----------------------------------------------------------

	let rootEl: HTMLDivElement | undefined = $state();
	let fieldEl: HTMLDivElement | undefined = $state();
	let buttonEl: HTMLButtonElement | undefined = $state();
	let dialog: ReturnType<typeof PickerDialog> | undefined = $state();
	let calendar: ReturnType<typeof RangeCalendar> | undefined = $state();
	let open = $state(false);
	let focusDate = $state('');
	let today = $state('');
	/** The start picked in the calendar while the end is still to come. */
	let anchor = $state<string | null>(null);
	/** The box focus returns to when the dialog closes. */
	let openedFrom: End = 'from';
	/** The dialog element while open: the calendar scrolls a focused day into it. */
	let panelEl: HTMLDivElement | undefined = $state();

	// Made disabled / read-only while open: close (nothing can be picked any more).
	$effect(() => {
		if ((disabled || readonly) && open) untrack(() => dialog?.close(true));
	});

	const weekStart = $derived(resolveWeekStart(locale, weekStartsOn));
	const buttonLabel = $derived(
		valueFrom && valueTo
			? t.dateRangePickerChange(formatFullDate(valueFrom, locale), formatFullDate(valueTo, locale))
			: t.dateRangePickerOpen()
	);

	function typedOrValue(end: End): string | null {
		const text = mirrors[end].text;
		const typed = isBlankDateText(text) ? null : parseDateText(text);
		return typed ?? (end === 'from' ? valueFrom : valueTo);
	}

	function openPicker(from: End): void {
		if (open || disabled || readonly) return;
		openedFrom = from;
		today = todayDate();
		anchor = null;
		focusDate = clampDate(typedOrValue('from') ?? typedOrValue('to') ?? today, min, max);
		dialog?.show(() => calendar?.focusCell());
	}

	/** Can `date` be an end under the current props (they may change while open)? */
	function isSelectable(date: string): boolean {
		return !isOutOfRange(date, min, max) && !isDateDisabled?.(date);
	}

	function pickRange(from: string, to: string): void {
		// Both ends against the latest bounds (RangeCalendar checks them too).
		if (disabled || readonly || !isSelectable(from) || !isSelectable(to)) return;
		setText('from', from);
		setText('to', to);
		setRange({ from, to });
		dialog?.close(true);
	}

	function clear(): void {
		if (disabled || readonly) return;
		anchor = null;
		setText('from', '');
		setText('to', '');
		setRange({ from: null, to: null });
		dialog?.close(true);
	}

	function handleButtonClick(): void {
		if (open) dialog?.close(true);
		else openPicker('from');
	}

	function handleButtonMousedown(event: MouseEvent): void {
		// While open, keep focus in the dialog until the click closes it.
		if (open) event.preventDefault();
	}

	function handleInputKeydown(end: End, event: KeyboardEvent): void {
		if (!event.isComposing && event.keyCode !== 229) {
			if (event.key === 'ArrowDown' && event.altKey) {
				event.preventDefault();
				openPicker(end);
			} else if (event.key === 'Escape') {
				dialog?.closeOnEscape(event);
			} else if (event.key === 'Enter' && !open) {
				commit(end);
			}
		}
		onkeydown?.(event);
	}

	function handleFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget;
		// Leaving a box commits it, wherever focus goes (the other box, the
		// button, the dialog) - as two DateInputs would.
		if (event.target === fromInputEl) commit('from');
		else if (event.target === toInputEl) commit('to');
		if (next instanceof Node && rootEl?.contains(next)) return;
		dialog?.close(false);
		onblur?.(event);
	}
</script>

<!-- Promise 4: pointerdown stays inside the group (the dialog is inside too). -->
<div
	bind:this={rootEl}
	{@attach stopPointerdown}
	{id}
	class="date-range-picker"
	role="group"
	aria-label={labelledBy ? undefined : label}
	aria-labelledby={labelledBy}
	onfocusout={handleFocusOut}
>
	<div
		class="date-range-picker-field"
		class:date-range-picker-field--invalid={invalid}
		bind:this={fieldEl}
	>
		<input
			bind:this={fromInputEl}
			class="date-range-picker-text"
			type="text"
			autocomplete="off"
			spellcheck="false"
			aria-label={t.dateRangeStart()}
			aria-describedby={describedIds}
			aria-invalid={invalid ? 'true' : undefined}
			{disabled}
			{readonly}
			value={mirrors.from.text}
			oninput={(event) => setText('from', event.currentTarget.value)}
			onkeydown={(event) => handleInputKeydown('from', event)}
		/>
		<span class="date-range-picker-dash" aria-hidden="true">–</span>
		<input
			bind:this={toInputEl}
			class="date-range-picker-text"
			type="text"
			autocomplete="off"
			spellcheck="false"
			aria-label={t.dateRangeEnd()}
			aria-describedby={describedIds}
			aria-invalid={invalid ? 'true' : undefined}
			{disabled}
			{readonly}
			value={mirrors.to.text}
			oninput={(event) => setText('to', event.currentTarget.value)}
			onkeydown={(event) => handleInputKeydown('to', event)}
		/>
		<button
			bind:this={buttonEl}
			type="button"
			class="date-range-picker-button"
			aria-label={buttonLabel}
			title={buttonLabel}
			aria-haspopup="dialog"
			aria-expanded={open}
			disabled={disabled || readonly}
			onmousedown={handleButtonMousedown}
			onclick={handleButtonClick}
		>
			<Calendar size={16} aria-hidden="true" />
		</button>
	</div>
	<span id={hintId} class="date-range-picker-hint">{t.dateFormatHint()}</span>

	<PickerDialog
		bind:this={dialog}
		bind:open
		bind:panel={panelEl}
		label={t.dateRangePickerDialog()}
		anchor={fieldEl}
		toggle={buttonEl}
		returnFocus={() => (openedFrom === 'to' ? toInputEl : fromInputEl)}
		back={() => calendar?.back() ?? false}
	>
		{#if focusDate}
			<RangeCalendar
				bind:this={calendar}
				mode="range"
				bind:focusDate
				bind:anchor
				from={valueFrom}
				to={valueTo}
				{months}
				{today}
				{min}
				{max}
				{isDateDisabled}
				{locale}
				{weekStart}
				{t}
				scroller={panelEl}
				onRangeSelect={pickRange}
			/>
			<div class="date-picker-footer">
				<!-- What the next pick sets, read as it changes. -->
				<span id={statusId} class="date-range-picker-status" aria-live="polite">
					{anchor
						? t.dateRangePickerPickEnd(formatFullDate(anchor, locale))
						: t.dateRangePickerPickStart()}
				</span>
				<button type="button" class="date-picker-action" onclick={clear}>
					{t.datePickerClear()}
				</button>
			</div>
		{/if}
	</PickerDialog>
</div>

<style>
	.date-range-picker {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		inline-size: var(--banto-date-range-picker-width, 18em);
		max-inline-size: 100%;
	}

	/* One field: the two boxes, the dash and the button share a border. */
	.date-range-picker-field {
		display: flex;
		align-items: stretch;
		min-inline-size: 0;
		block-size: var(--banto-control-height);
		box-sizing: border-box;
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
	}

	.date-range-picker-field--invalid {
		border-color: var(--banto-danger);
	}

	.date-range-picker-text {
		flex: 1 1 0;
		min-inline-size: 0;
		box-sizing: border-box;
		padding: 0 var(--banto-space-2);
		border: none;
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		font-variant-numeric: tabular-nums;
	}

	.date-range-picker-dash {
		align-self: center;
		color: var(--banto-text-muted);
	}

	.date-range-picker-button {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		inline-size: var(--banto-control-height);
		box-sizing: border-box;
		padding: 0;
		border: none;
		border-inline-start: var(--banto-border-width) solid var(--banto-border-strong);
		border-start-end-radius: var(--banto-radius-md);
		border-end-end-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
	}

	.date-range-picker-field--invalid .date-range-picker-button {
		border-color: var(--banto-danger);
	}

	.date-range-picker-button:hover:not(:disabled) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.date-range-picker-text:focus-visible,
	.date-range-picker-button:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.date-range-picker-text:disabled,
	.date-range-picker-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Read with the text boxes only (aria-describedby). */
	.date-range-picker-hint {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.date-range-picker-status {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	@media (forced-colors: active) {
		.date-range-picker-text:focus-visible,
		.date-range-picker-button:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
