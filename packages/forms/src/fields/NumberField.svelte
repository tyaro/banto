<script lang="ts">
	/** Numeric input field (spec §7.2 `type: 'number'`). */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: number | '') => void;
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

	function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
		if (disabled || def.readonly) return;
		const raw = event.currentTarget.value;
		onInput(raw === '' ? '' : Number(raw));
	}
</script>

<input
	type="number"
	id={id ?? def.name}
	value={value === '' || value === undefined || value === null ? '' : (value as number)}
	placeholder={def.placeholder}
	min={def.min}
	max={def.max}
	{disabled}
	readonly={def.readonly}
	class:muted={def.readonly}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	oninput={handleInput}
	onblur={() => {
		if (!disabled && !def.readonly) onBlur?.();
	}}
/>

<style>
	input {
		height: var(--banto-control-height);
		padding: 0 0.6rem;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-bg);
		color: var(--banto-text);
		font: inherit;
		font-variant-numeric: tabular-nums;
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
		background: var(--banto-surface);
		color: var(--banto-text-muted);
	}
</style>
