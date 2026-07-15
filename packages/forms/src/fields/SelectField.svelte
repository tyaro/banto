<script lang="ts">
	/** Select field (spec §7.2 `type: 'select'`), options from `def.options`. */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: string | number) => void;
		onBlur?: () => void;
	}

	let { def, value, error, disabled = false, onInput, onBlur }: Props = $props();

	const isDisabled = $derived(disabled || !!def.readonly);

	function handleChange(event: Event & { currentTarget: HTMLSelectElement }) {
		const option = def.options?.find((entry) => String(entry.value) === event.currentTarget.value);
		onInput(option ? option.value : event.currentTarget.value);
	}
</script>

<select
	id={def.name}
	value={value === undefined || value === null ? '' : String(value)}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	onchange={handleChange}
	onblur={onBlur}
>
	<option value="" disabled hidden>{def.placeholder ?? '選択してください'}</option>
	{#each def.options ?? [] as option (option.value)}
		<option value={String(option.value)}>{option.label}</option>
	{/each}
</select>

<style>
	select {
		height: var(--banto-control-height);
		padding: 0 0.6rem;
		border: 1px solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: var(--banto-bg);
		color: var(--banto-text);
		font: inherit;
		width: 100%;
		box-sizing: border-box;
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	select:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	select:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	select.muted {
		background: var(--banto-surface);
		color: var(--banto-text-muted);
	}
</style>
