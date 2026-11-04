<script lang="ts">
	/** Checkbox field (spec §7.2 `type: 'checkbox'`). */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: boolean) => void;
		onBlur?: () => void;
	}

	let {
		def,
		id,
		'aria-describedby': describedBy,
		value,
		error,
		disabled = false,
		onInput,
		onBlur
	}: Props = $props();

	// Native checkboxes have no readonly state; preserve their disabled fallback.
	const isDisabled = $derived(disabled || !!def.readonly);
</script>

<input
	type="checkbox"
	id={id ?? def.name}
	checked={!!value}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	onchange={(event) => {
		if (!isDisabled) onInput(event.currentTarget.checked);
	}}
	onblur={() => {
		if (!isDisabled) onBlur?.();
	}}
/>

<style>
	/* Note: --banto-control-height (36px) is not applied to the checkbox
	   itself - a checkbox is a small square control, not a text-input-height
	   control; the native 1.1rem box is kept and only gains the shared
	   focus-ring/disabled/transition treatment. */
	input {
		width: 1.1rem;
		height: 1.1rem;
		accent-color: var(--banto-primary);
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong) solid transparent;
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-sm);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
