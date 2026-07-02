<script lang="ts">
	/** Numeric input field (spec §7.2 `type: 'number'`). */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: number | '') => void;
		onBlur?: () => void;
	}

	let { def, value, error, disabled = false, onInput, onBlur }: Props = $props();

	const isDisabled = $derived(disabled || !!def.readonly);

	function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
		const raw = event.currentTarget.value;
		onInput(raw === '' ? '' : Number(raw));
	}
</script>

<input
	type="number"
	id={def.name}
	value={value === '' || value === undefined || value === null ? '' : (value as number)}
	placeholder={def.placeholder}
	min={def.min}
	max={def.max}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	oninput={handleInput}
	onblur={onBlur}
/>

<style>
	input {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius);
		background: var(--banto-bg);
		color: var(--banto-text);
		font: inherit;
		width: 100%;
		box-sizing: border-box;
	}

	input:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.7;
	}

	input.muted {
		background: var(--banto-surface);
		color: var(--banto-text-muted);
	}
</style>
