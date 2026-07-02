<script lang="ts">
	/** Text input field (spec §7.2 `type: 'text'`). Shared style baseline for all field components. */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: string) => void;
		onBlur?: () => void;
	}

	let { def, value, error, disabled = false, onInput, onBlur }: Props = $props();

	const isDisabled = $derived(disabled || !!def.readonly);
</script>

<input
	type="text"
	id={def.name}
	value={(value as string | undefined) ?? ''}
	placeholder={def.placeholder}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	oninput={(event) => onInput(event.currentTarget.value)}
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
