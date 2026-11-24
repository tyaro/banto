<script lang="ts">
	/**
	 * Date picker with the extended calendar (Issue #910): one text box you can
	 * type into, a button that opens a dialog with two months side by side
	 * (one on a narrow screen). The value, the typing and the keys are
	 * `DateInput`'s (docs/design/date-time-pickers.md §5.1-§5.8): canonical
	 * `YYYY-MM-DD` or `null`, lenient parse on blur / Enter, Alt+ArrowDown
	 * opens, Esc goes back one calendar view and then closes, closing returns
	 * focus to the text box, and the host promises of §5.8 hold (keys inside
	 * the dialog and `pointerdown` stay inside, `onblur` only when focus
	 * leaves the whole component).
	 *
	 * Simple vs extended: `DateInput` stays the plain one-month picker; this
	 * one is for forms where seeing two months helps (bookings, deadlines
	 * near a month end). The calendar is `RangeCalendar` (`mode="single"`),
	 * the dialog `PickerDialog`.
	 */
	import { untrack } from 'svelte';
	import { createTextMirror } from './textMirror.svelte.js';
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

	interface Props {
		/** Canonical `YYYY-MM-DD`, or `null` (`''` is read as empty too). */
		value?: string | null;
		/** Called with the new value (canonical or `null`) when it changes. */
		onValueChange?: (value: string | null) => void;
		/** Every change of the typed text, including the canonical rewrite on commit. */
		onTextInput?: (text: string) => void;
		/** id of the text box. */
		id?: string;
		/** Accessible name of the text box (`aria-label`); omit when a `<label for={id}>` names it. */
		label?: string;
		/** Extra ids for the text box's `aria-describedby` (the format hint is always included). */
		describedBy?: string;
		invalid?: boolean;
		disabled?: boolean;
		readonly?: boolean;
		/** Earliest selectable day (canonical, inclusive). */
		min?: string;
		/** Latest selectable day (canonical, inclusive). */
		max?: string;
		/** Days that can be focused but not picked in the calendar (weekends, holidays). */
		isDateDisabled?: (date: string) => boolean;
		/** BCP 47 tag for the month / weekday names (default `'ja-JP'`). */
		locale?: string;
		/** First day of the week, 0 = Sunday ... 6 = Saturday. Default: the locale's, else Sunday. */
		weekStartsOn?: number;
		/** Months side by side on a wide screen (default 2; one at 600px or less). */
		months?: 1 | 2;
		messages?: UiMessages;
		/** Keys from the text box (after the picker handled its own). */
		onkeydown?: (event: KeyboardEvent) => void;
		/** Focus left the whole component. */
		onblur?: (event: FocusEvent) => void;
		/** The text box (bindable). */
		inputEl?: HTMLInputElement;
	}

	let {
		value = $bindable(null),
		onValueChange,
		onTextInput,
		id,
		label,
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
		inputEl = $bindable()
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });
	const uid = $props.id();
	const hintId = `${uid}-hint`;

	// --- text and value --------------------------------------------------

	const mirror = createTextMirror({ value: () => value });
	const selectedDate = $derived(value && isIsoDate(value) ? value : null);

	function setText(next: string): void {
		mirror.setText(next);
		onTextInput?.(next);
	}

	function setValue(next: string | null): void {
		const current = isBlankDateText(value) ? null : value;
		if (next === current) return;
		mirror.committed(next);
		value = next;
		onValueChange?.(next);
	}

	/** Parse the typed text (blur, Enter): canonical -> value, blank -> null, otherwise leave both alone. */
	function commit(): void {
		const raw = mirror.text;
		let next: string | null = null;
		if (!isBlankDateText(raw)) {
			next = parseDateText(raw);
			if (next === null) return;
		}
		if ((next ?? '') !== raw) setText(next ?? '');
		setValue(next);
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
	/** The dialog element while open: the calendar scrolls a focused day into it. */
	let panelEl: HTMLDivElement | undefined = $state();

	// Made disabled / read-only while open: close (nothing can be picked any more).
	$effect(() => {
		if ((disabled || readonly) && open) untrack(() => dialog?.close(true));
	});

	const weekStart = $derived(resolveWeekStart(locale, weekStartsOn));
	const buttonLabel = $derived(
		selectedDate ? t.datePickerChange(formatFullDate(selectedDate, locale)) : t.datePickerOpen()
	);

	function isSelectable(date: string): boolean {
		return !isOutOfRange(date, min, max) && !isDateDisabled?.(date);
	}

	function openPicker(): void {
		if (open || disabled || readonly) return;
		today = todayDate();
		const typed = isBlankDateText(mirror.text) ? null : parseDateText(mirror.text);
		focusDate = clampDate(typed ?? selectedDate ?? today, min, max);
		dialog?.show(() => calendar?.focusCell());
	}

	function select(date: string): void {
		if (disabled || readonly || !isSelectable(date)) return;
		setText(date);
		setValue(date);
		dialog?.close(true);
	}

	function clear(): void {
		if (disabled || readonly) return;
		setText('');
		setValue(null);
		dialog?.close(true);
	}

	function handleButtonClick(): void {
		if (open) dialog?.close(true);
		else openPicker();
	}

	function handleButtonMousedown(event: MouseEvent): void {
		// While open, keep focus in the dialog until the click closes it.
		if (open) event.preventDefault();
	}

	function handleInputKeydown(event: KeyboardEvent): void {
		if (!event.isComposing && event.keyCode !== 229) {
			if (event.key === 'ArrowDown' && event.altKey) {
				event.preventDefault();
				openPicker();
			} else if (event.key === 'Escape') {
				dialog?.closeOnEscape(event);
			} else if (event.key === 'Enter' && !open) {
				commit();
			}
		}
		onkeydown?.(event);
	}

	function handleFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget;
		if (next instanceof Node && rootEl?.contains(next)) return;
		dialog?.close(false);
		commit();
		onblur?.(event);
	}
</script>

<div class="date-input" bind:this={rootEl} {@attach stopPointerdown} onfocusout={handleFocusOut}>
	<div class="date-input-field" class:date-input-field--invalid={invalid} bind:this={fieldEl}>
		<input
			bind:this={inputEl}
			{id}
			class="date-input-text"
			type="text"
			autocomplete="off"
			spellcheck="false"
			aria-label={label}
			aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}
			aria-invalid={invalid ? 'true' : undefined}
			{disabled}
			{readonly}
			value={mirror.text}
			oninput={(event) => setText(event.currentTarget.value)}
			onkeydown={handleInputKeydown}
		/>
		<button
			bind:this={buttonEl}
			type="button"
			class="date-input-button"
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
	<span id={hintId} class="date-input-hint">{t.dateFormatHint()}</span>

	<PickerDialog
		bind:this={dialog}
		bind:open
		bind:panel={panelEl}
		label={t.datePickerDialog()}
		anchor={fieldEl}
		toggle={buttonEl}
		returnFocus={() => inputEl}
		back={() => calendar?.back() ?? false}
	>
		{#if focusDate}
			<RangeCalendar
				bind:this={calendar}
				mode="single"
				bind:focusDate
				{selectedDate}
				{months}
				{today}
				{min}
				{max}
				{isDateDisabled}
				{locale}
				{weekStart}
				{t}
				scroller={panelEl}
				onSelect={select}
			/>
			<div class="date-picker-footer">
				<button
					type="button"
					class="date-picker-action"
					aria-disabled={isSelectable(today) ? undefined : 'true'}
					onclick={() => select(today)}
				>
					{t.datePickerToday()}
				</button>
				<button type="button" class="date-picker-action" onclick={clear}>
					{t.datePickerClear()}
				</button>
			</div>
		{/if}
	</PickerDialog>
</div>

<style>
	.date-input {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		inline-size: var(--banto-date-input-width, 11em);
		max-inline-size: 100%;
	}

	.date-input-field {
		display: flex;
		align-items: stretch;
		min-inline-size: 0;
	}

	.date-input-text {
		flex: 1 1 auto;
		min-inline-size: 0;
		block-size: var(--banto-control-height);
		box-sizing: border-box;
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-inline-end: none;
		border-start-start-radius: var(--banto-radius-md);
		border-end-start-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		font-variant-numeric: tabular-nums;
	}

	.date-input-button {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		inline-size: var(--banto-control-height);
		block-size: var(--banto-control-height);
		box-sizing: border-box;
		padding: 0;
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-start-end-radius: var(--banto-radius-md);
		border-end-end-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
	}

	.date-input-field--invalid .date-input-text,
	.date-input-field--invalid .date-input-button {
		border-color: var(--banto-danger);
	}

	.date-input-button:hover:not(:disabled) {
		background: var(--banto-surface-hover);
		color: var(--banto-text);
	}

	.date-input-text:focus-visible,
	.date-input-button:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.date-input-text:disabled,
	.date-input-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Read with the text box only (aria-describedby). */
	.date-input-hint {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	@media (forced-colors: active) {
		.date-input-text:focus-visible,
		.date-input-button:focus-visible {
			outline: var(--banto-border-width-strong) solid Highlight;
			outline-offset: calc(-1 * var(--banto-border-width-strong));
		}
	}
</style>
