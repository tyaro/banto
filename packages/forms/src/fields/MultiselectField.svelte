<script lang="ts">
	/**
	 * Multiple choice (`type: 'multiselect'`): a group of checkboxes made from
	 * `def.options`. The value is an array of option values in `options` order
	 * (`[]` when nothing is chosen; `required` means at least one).
	 *
	 * Like `RadioField`: a `fieldset` + `legend`, `id` on the first checkbox,
	 * `aria-describedby` on the fieldset, no label drawn by `BantoForm`.
	 */
	import type { FieldDef } from '../types';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: Array<string | number>) => void;
		onBlur?: () => void;
	}

	let {
		def,
		id,
		class: className,
		'aria-describedby': describedBy,
		value,
		error,
		disabled = false,
		onInput,
		onBlur
	}: Props = $props();

	const isDisabled = $derived(disabled || !!def.readonly);
	const base = $derived(id ?? def.name);
	// Kept in their own type: `1` and `'1'` are different options.
	const chosen = $derived<Array<string | number>>(
		Array.isArray(value) ? (value as Array<string | number>) : []
	);

	function toggle(optionValue: string | number, on: boolean) {
		if (isDisabled) return;
		const next = chosen.filter((item) => item !== optionValue);
		if (on) next.push(optionValue);
		onInput((def.options ?? []).filter((o) => next.includes(o.value)).map((o) => o.value));
	}

	function handleFocusOut(event: FocusEvent & { currentTarget: HTMLFieldSetElement }) {
		if (isDisabled || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		onBlur?.();
	}
</script>

<fieldset
	class={['group', className]}
	class:muted={def.readonly}
	aria-describedby={describedBy}
	disabled={isDisabled}
	onfocusout={handleFocusOut}
>
	<legend class="legend">
		{def.label}
		{#if def.required}<span class="required">*</span>{/if}
	</legend>
	<div class="options">
		{#each def.options ?? [] as option, index (`${typeof option.value}:${option.value}`)}
			<label class="option">
				<input
					type="checkbox"
					id={index === 0 ? base : `${base}-opt-${index}`}
					value={String(option.value)}
					checked={chosen.includes(option.value)}
					aria-invalid={!!error}
					onchange={(event) => toggle(option.value, event.currentTarget.checked)}
				/>
				<span>{option.label}</span>
			</label>
		{/each}
	</div>
</fieldset>

<style>
	.group {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
	}

	.group:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.legend {
		padding: 0;
		font-size: var(--banto-font-size-md);
		color: var(--banto-text-muted);
	}

	.required {
		color: var(--banto-danger);
		margin-left: var(--banto-space-1);
	}

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2) var(--banto-space-4);
	}

	.option {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
		min-height: var(--banto-control-height);
		color: var(--banto-text);
	}

	.group.muted .option {
		color: var(--banto-text-muted);
	}

	input {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		margin: 0;
		flex-shrink: 0;
		accent-color: var(--banto-primary);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong, 2px) solid var(--banto-primary);
		outline-offset: var(--banto-border-width, 1px);
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-sm);
	}
</style>
