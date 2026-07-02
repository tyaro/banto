<script lang="ts">
	/** Checkbox field (spec §7.2 `type: 'checkbox'`). */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: boolean) => void;
		onBlur?: () => void;
	}

	let { def, value, error, disabled = false, onInput, onBlur }: Props = $props();

	const isDisabled = $derived(disabled || !!def.readonly);
</script>

<input
	type="checkbox"
	id={def.name}
	checked={!!value}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	onchange={(event) => onInput(event.currentTarget.checked)}
	onblur={onBlur}
/>

<style>
	input {
		width: 1.1rem;
		height: 1.1rem;
		accent-color: var(--banto-primary);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.7;
	}
</style>
