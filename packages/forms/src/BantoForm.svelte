<script lang="ts">
	/**
	 * Schema-driven form (spec §7.3): renders one field per `FieldDef` in a
	 * single column (default layout), wires value/blur to the FormStore, and
	 * runs full validation on submit before calling `onSubmit`.
	 */
	import type { Snippet } from 'svelte';
	import type { FieldDef, FormSchema } from './types';
	import type { FormStore } from './store.svelte';
	import TextField from './fields/TextField.svelte';
	import TextareaField from './fields/TextareaField.svelte';
	import NumberField from './fields/NumberField.svelte';
	import DateField from './fields/DateField.svelte';
	import SelectField from './fields/SelectField.svelte';
	import CheckboxField from './fields/CheckboxField.svelte';

	interface Props {
		schema: FormSchema;
		store: FormStore;
		onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
		submitting?: boolean;
		submitLabel?: string;
		/** Escape hatch for extra footer content (e.g. a delete button) next to the submit button. */
		children?: Snippet;
	}

	let { schema, store, onSubmit, submitting = false, submitLabel = '保存', children }: Props = $props();

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!store.validateAll()) return;
		await onSubmit(store.values);
	}

	function fieldComponent(def: FieldDef) {
		switch (def.type) {
			case 'textarea':
				return TextareaField;
			case 'number':
				return NumberField;
			case 'date':
				return DateField;
			case 'select':
				return SelectField;
			case 'checkbox':
				return CheckboxField;
			default:
				return TextField;
		}
	}
</script>

<form onsubmit={handleSubmit} novalidate>
	{#each schema.fields as def (def.name)}
		{@const Field = fieldComponent(def)}
		<div class="field">
			<label for={def.name}>
				{def.label}
				{#if def.required}<span class="required">*</span>{/if}
			</label>
			<Field
				{def}
				value={store.values[def.name]}
				error={store.errors[def.name]}
				disabled={submitting}
				onInput={(value: unknown) => store.setValue(def.name, value)}
				onBlur={() => store.touch(def.name)}
			/>
			{#if store.errors[def.name]}
				<p class="error">{store.errors[def.name]}</p>
			{/if}
		</div>
	{/each}

	<div class="footer">
		{#if children}
			{@render children()}
		{/if}
		<button type="submit" disabled={submitting}>{submitLabel}</button>
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	label {
		font-size: 0.875rem;
		color: var(--banto-text-muted);
	}

	.required {
		color: var(--banto-danger);
		margin-left: 0.15rem;
	}

	.error {
		margin: 0;
		font-size: 0.8rem;
		color: var(--banto-danger);
	}

	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 0.5rem;
	}

	button {
		padding: 0.55rem 1.25rem;
		border: none;
		border-radius: var(--banto-radius);
		background: var(--banto-primary);
		color: var(--banto-text-inverse);
		font-weight: 600;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		background: var(--banto-primary-hover);
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>
