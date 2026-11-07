<script lang="ts">
	/**
	 * Date input bound to a `FormDraft` (spec §7.2 `type: 'date'`;
	 * date-time-pickers §5.3 / §5.7; the `DraftNumberField` pattern of
	 * shared-primitives-upstream-plan §3.5). Typed text - lenient forms such as
	 * `2026/11/7` and text that does not parse yet - lives in `draft.raw`, so it
	 * survives a pane re-mount; `draft.commit` normalises it to `YYYY-MM-DD`
	 * (blank -> `null`, D6) and validates it.
	 *
	 * - The picker comes from `provideFieldInputs` or the `input` prop (D1-a),
	 *   which gets the draft's text (`text` / `onTextInput`). A day picked in
	 *   the calendar is committed at once; typed text on blur / Enter (the
	 *   component commits it first, then hands over the blur / key).
	 * - Without one, the native `<input type="date">` (D3-a), committed on blur
	 *   / Enter like `DraftNumberField`.
	 */
	import type { Component } from 'svelte';
	import { formatDraftValue, type FormDraft } from '../draft.svelte';
	import { getFieldInputs, type DateFieldInputProps } from '../fieldInputs';
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		draft: FormDraft;
		disabled?: boolean;
		/** Called after each commit (blur / Enter / a picked day) with whether the field is valid. */
		onCommit?: (valid: boolean) => void;
		/** Overrides the date input from `provideFieldInputs` for this field. */
		input?: Component<DateFieldInputProps>;
	}

	let {
		def,
		id,
		class: className,
		'aria-describedby': describedBy,
		draft,
		disabled = false,
		onCommit,
		input
	}: Props = $props();

	const provided = getFieldInputs();
	const Input = $derived(input ?? provided.date);

	const editable = $derived(!disabled && !def.readonly);
	const text = $derived(draft.raw[def.name] ?? formatDraftValue(draft.values[def.name]));
	const error = $derived(draft.errors[def.name]);
	// The committed value (not the typed text): a picked day or a committed
	// text differs from it, so the component reports it and it is committed.
	const committed = $derived.by(() => {
		const value = draft.values[def.name];
		return typeof value === 'string' && value !== '' ? value : null;
	});
	const min = $derived(typeof def.min === 'string' ? def.min : undefined);
	const max = $derived(typeof def.max === 'string' ? def.max : undefined);

	function setText(next: string) {
		if (editable) draft.setRaw(def.name, next);
	}

	function commit() {
		if (!editable) return;
		const valid = draft.commit(def.name);
		onCommit?.(valid);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.isComposing) commit();
	}
</script>

{#if Input}
	<Input
		id={id ?? def.name}
		value={committed}
		{text}
		{describedBy}
		invalid={!!error}
		{disabled}
		readonly={def.readonly}
		{min}
		{max}
		isDateDisabled={def.isDateDisabled}
		onTextInput={setText}
		onValueChange={commit}
		onkeydown={handleKeydown}
		onblur={commit}
	/>
{:else}
	<input
		type="date"
		class={className}
		id={id ?? def.name}
		value={text}
		{min}
		{max}
		{disabled}
		readonly={def.readonly}
		class:muted={def.readonly}
		aria-invalid={!!error}
		aria-describedby={describedBy}
		oninput={(event) => setText(event.currentTarget.value)}
		onblur={commit}
		onkeydown={handleKeydown}
	/>
{/if}

<style>
	input {
		height: var(--banto-control-height);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		width: 100%;
		box-sizing: border-box;
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong) solid transparent;
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	input.muted {
		color: var(--banto-text-muted);
	}
</style>
