<script lang="ts">
	/**
	 * Radio group (`type: 'radio'`), options from `def.options`. A `fieldset`
	 * with a `legend` (the field's label) around native radios, so the arrow
	 * keys move the choice natively. `def.variant === 'segmented'` shows the
	 * same radios as a row of buttons: the inputs stay in the DOM (focusable,
	 * named) and the labels are drawn as the buttons.
	 *
	 * `id` goes on the first radio (what the form focuses); `aria-describedby`
	 * goes on the fieldset, so the help / error text is read once, with the
	 * group. `BantoForm` draws no label of its own for this type.
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
		onInput: (value: string | number) => void;
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

	// Native radios have no readonly state; preserve the disabled fallback.
	const isDisabled = $derived(disabled || !!def.readonly);
	const base = $derived(id ?? def.name);
	const segmented = $derived(def.variant === 'segmented');
	// The name only has to group these radios; one form can hold several groups.
	const groupName = $derived(`${base}-group`);

	function isChosen(optionValue: string | number): boolean {
		return value !== '' && value !== undefined && value !== null
			? String(value) === String(optionValue)
			: false;
	}

	function handleFocusOut(event: FocusEvent & { currentTarget: HTMLFieldSetElement }) {
		// Blur of the group, not of the move between its radios.
		if (isDisabled || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		onBlur?.();
	}
</script>

<fieldset
	class={['group', className]}
	role="radiogroup"
	aria-invalid={!!error}
	class:muted={def.readonly}
	aria-describedby={describedBy}
	disabled={isDisabled}
	onfocusout={handleFocusOut}
>
	<legend class="legend">
		{def.label}
		{#if def.required}<span class="required">*</span>{/if}
	</legend>
	<div class="options" class:segmented>
		{#each def.options ?? [] as option, index (option.value)}
			<label class="option" class:segment={segmented}>
				<input
					type="radio"
					name={groupName}
					id={index === 0 ? base : `${base}-opt-${index}`}
					value={String(option.value)}
					checked={isChosen(option.value)}
					onchange={() => {
						if (!isDisabled) onInput(option.value);
					}}
				/>
				<span class="text">{option.label}</span>
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
		margin: 0;
		accent-color: var(--banto-primary);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong) solid var(--banto-primary);
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
	}

	/* Segmented: one bordered strip. The radio covers its label, invisible but
	   still the focused, keyboard-operated control. */
	.options.segmented {
		display: inline-flex;
		align-self: flex-start;
		max-width: 100%;
		gap: 0;
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		overflow: hidden;
	}

	.segment {
		position: relative;
		justify-content: center;
		box-sizing: border-box;
		padding: 0 var(--banto-space-4);
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.segment + .segment {
		border-left: var(--banto-border-width) solid var(--banto-border-strong);
	}

	.segment input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: inherit;
	}

	.segment:hover {
		background: var(--banto-surface-hover);
	}

	/* The chosen segment differs by more than colour: a solid fill, bold text
	   and a check mark. */
	.segment:has(input:checked) {
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-weight: 700;
	}

	.segment:has(input:checked) .text::before {
		content: '\2713';
		margin-right: var(--banto-space-1);
	}

	.segment:has(input:focus-visible) {
		outline: var(--banto-border-width-strong) solid var(--banto-primary);
		outline-offset: calc(var(--banto-border-width-strong) * -1);
		box-shadow: var(--banto-focus-ring);
	}

	.group:disabled .segment {
		cursor: not-allowed;
	}
</style>
