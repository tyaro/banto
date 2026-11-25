<script lang="ts">
	/**
	 * Schema-driven form (spec §7.3): renders one field per `FieldDef` in a
	 * single column (default layout), wires value/blur to the FormStore, and
	 * runs full validation on submit before calling `onSubmit`.
	 *
	 * Date / time / datetime fields render the input of their type injected
	 * by `provideFieldInputs` (context) or the `fieldInputs` prop (which wins,
	 * per type), else the native input (date-time-pickers §5.7, D1-a / D3-a).
	 */
	import { tick, untrack, type Snippet } from 'svelte';
	import { isTemporalType, type FieldDef, type FormSchema, type FormAppearance } from './types';
	import type { FormStore } from './store.svelte';
	import { focusCandidateNames, layoutOf } from './layout';
	import { getFieldInputs, type FieldInputs } from './fieldInputs';
	import TextField from './fields/TextField.svelte';
	import PasswordField from './fields/PasswordField.svelte';
	import TextareaField from './fields/TextareaField.svelte';
	import NumberField from './fields/NumberField.svelte';
	import DateField from './fields/DateField.svelte';
	import SelectField from './fields/SelectField.svelte';
	import CheckboxField from './fields/CheckboxField.svelte';
	import RadioField from './fields/RadioField.svelte';
	import MultiselectField from './fields/MultiselectField.svelte';
	import ReferenceField from './fields/ReferenceField.svelte';
	import type { ReferenceFieldMessages } from './fields/reference';
	import FileField from './fields/FileField.svelte';
	import type { FileFieldMessages } from './fields/file';
	import type { PasswordInputMessages } from './fields/password';

	interface Props {
		schema: FormSchema;
		store: FormStore;
		onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
		submitting?: boolean;
		submitLabel?: string;
		/** Underline keeps labels above controls; requires matching theme CSS. */
		appearance?: FormAppearance;
		/** Escape hatch for extra footer content (e.g. a delete button) next to the submit button. */
		children?: Snippet;
		/** Field inputs for this form; each type given here overrides `provideFieldInputs`. */
		fieldInputs?: FieldInputs;
		/** Texts of the `reference` fields (loading, nothing found, the search failed); defaults are Japanese. */
		referenceMessages?: Partial<ReferenceFieldMessages>;
		/**
		 * The record the `file` field's files belong to (§4.12). Given (edit):
		 * the field lists them, uploads a chosen file at once and deletes at
		 * once. `null` / omitted (a new record): chosen files wait in the field
		 * until the app sends them with `uploadPendingFiles` after the create.
		 */
		fileParentId?: string | number | null;
		/** Texts of the `file` field; defaults are Japanese. */
		fileMessages?: Partial<FileFieldMessages>;
		/** Texts of the show / hide button of `password` fields; defaults are Japanese. */
		passwordMessages?: Partial<PasswordInputMessages>;
	}

	let {
		schema,
		store,
		onSubmit,
		submitting = false,
		submitLabel = '保存',
		appearance = 'default',
		children,
		fieldInputs,
		referenceMessages,
		fileParentId = null,
		fileMessages,
		passwordMessages
	}: Props = $props();

	const providedInputs = getFieldInputs();
	const inputs = $derived<FieldInputs>({ ...providedInputs, ...fieldInputs });

	// Svelte keeps this namespace stable across SSR/hydration. Field names stay
	// store keys; indices avoid whitespace and input/error ID collisions.
	const formId = $props.id();

	const groups = $derived(layoutOf(schema, store.values));

	// A field that `visibleWhen` hides takes its focused control out of the
	// DOM, which would drop focus to <body>. Remember which field holds focus
	// and, if it goes away, move focus to a neighbour instead.
	let formEl: HTMLFormElement | undefined;
	let focusedName: string | null = null;

	function trackFocus(event: FocusEvent) {
		const field = (event.target as Element | null)?.closest<HTMLElement>('[data-field]');
		focusedName = field?.dataset.field ?? null;
	}

	function releaseFocus(event: FocusEvent) {
		if (!focusedName) return;
		// Focus leaving for good: the field is still in the DOM afterwards.
		// A field removed while it had focus is gone by then; keep its name.
		const field = (event.target as Element | null)?.closest<HTMLElement>('[data-field]');
		const name = field?.dataset.field;
		queueMicrotask(() => {
			// Moving A -> B runs B's focusin before this: only clear A's own record.
			// A move inside one field (a date input's text box -> its calendar
			// button) keeps the record: focus has not left the field.
			if (!field?.isConnected || focusedName !== name) return;
			if (field.contains(document.activeElement)) return;
			focusedName = null;
		});
	}

	$effect(() => {
		const visible = new Set(groups.flatMap((group) => group.fields.map((f) => f.def.name)));
		untrack(() => {
			const lost = focusedName;
			if (!lost || visible.has(lost)) return;
			focusedName = null;
			if (document.activeElement && document.activeElement !== document.body) return;
			const candidates = focusCandidateNames(schema, store.values, lost);
			void tick().then(() => {
				// Try the neighbours in display order until one takes the focus
				// (a disabled field does not); then the submit button.
				for (const name of candidates) {
					const at = schema.fields.findIndex((d) => d.name === name);
					const el = at >= 0 ? document.getElementById(`${formId}-field-${at}`) : null;
					el?.focus();
					if (el && document.activeElement === el) return;
				}
				formEl?.querySelector<HTMLElement>('button[type="submit"]')?.focus();
			});
		});
	});

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!store.validateAll()) return;
		// Hidden (`visibleWhen`) fields are not part of what is submitted.
		await onSubmit(store.submitValues);
	}

	/** A group of inputs: it draws its own `fieldset` + `legend`, so the form adds no label (and no underline look). */
	function isGroupType(def: FieldDef): boolean {
		return def.type === 'radio' || def.type === 'multiselect' || def.type === 'file';
	}

	function fieldComponent(def: FieldDef) {
		switch (def.type) {
			case 'password':
				return PasswordField;
			case 'textarea':
				return TextareaField;
			case 'number':
				return NumberField;
			case 'select':
				return SelectField;
			case 'checkbox':
				return CheckboxField;
			case 'radio':
				return RadioField;
			case 'multiselect':
				return MultiselectField;
			default:
				return TextField;
		}
	}
</script>

<form
	bind:this={formEl}
	class="banto-form"
	onsubmit={handleSubmit}
	novalidate
	onfocusin={trackFocus}
	onfocusout={releaseFocus}
>
	{#each groups as group, groupIndex (group.section?.id ?? '')}
		{#snippet fieldsGrid()}
			<div class="grid" data-columns={group.columns}>
				{#each group.fields as { def, index } (def.name)}
					{@const Field = fieldComponent(def)}
					{@const inputId = `${formId}-field-${index}`}
					{@const errorId = `${formId}-error-${index}`}
					{@const helpId = `${formId}-help-${index}`}
					{@const describedBy =
						[def.help ? helpId : '', store.errors[def.name] ? errorId : '']
							.filter(Boolean)
							.join(' ') || undefined}
					{@const grouped = isGroupType(def)}
					{@const underline = appearance === 'underline' && def.type !== 'checkbox' && !grouped}
					{@const temporalInput = isTemporalType(def.type) ? inputs[def.type] : undefined}
					<!-- A reference is a composite too (text box + list of candidates). -->
					{@const injected = !!temporalInput || def.type === 'reference' || def.type === 'password'}
					{#snippet control()}
						{#if isTemporalType(def.type)}
							<DateField
								{def}
								class={underline ? 'banto-field-control' : undefined}
								id={inputId}
								aria-describedby={describedBy}
								value={store.values[def.name]}
								error={store.errors[def.name]}
								disabled={submitting}
								onInput={(value: unknown) => store.setValue(def.name, value)}
								onBlur={() => store.touch(def.name)}
								input={temporalInput}
							/>
						{:else if def.type === 'reference'}
							<ReferenceField
								{def}
								class={underline ? 'banto-field-control' : undefined}
								id={inputId}
								aria-describedby={describedBy}
								value={store.values[def.name]}
								error={store.errors[def.name]}
								disabled={submitting}
								messages={referenceMessages}
								onInput={(value: unknown) => store.setValue(def.name, value)}
								onBlur={() => store.touch(def.name)}
							/>
						{:else if def.type === 'password'}
							<PasswordField
								{def}
								class={underline ? 'banto-field-control' : undefined}
								id={inputId}
								aria-describedby={describedBy}
								value={store.values[def.name]}
								error={store.errors[def.name]}
								disabled={submitting}
								messages={passwordMessages}
								onInput={(value: unknown) => store.setValue(def.name, value)}
								onBlur={() => store.touch(def.name)}
							/>
						{:else if def.type === 'file'}
							<FileField
								{def}
								id={inputId}
								aria-describedby={describedBy}
								value={store.values[def.name]}
								error={store.errors[def.name]}
								disabled={submitting}
								parentId={fileParentId}
								messages={fileMessages}
								validationMessages={store.messages}
								onInput={(value: unknown) => store.setValue(def.name, value)}
								onBlur={() => store.touch(def.name)}
							/>
						{:else}
							<Field
								{def}
								class={underline ? 'banto-field-control' : undefined}
								id={inputId}
								aria-describedby={describedBy}
								value={store.values[def.name]}
								error={store.errors[def.name]}
								disabled={submitting}
								onInput={(value: unknown) => store.setValue(def.name, value)}
								onBlur={() => store.touch(def.name)}
							/>
						{/if}
					{/snippet}
					<div class="field" class:field--full={def.fullWidth} data-field={def.name}>
						{#if underline && injected}
							<!-- An injected input is a composite (text box, button, popover):
							     the stacked look with a sibling <label for>, never a wrapping
							     <label> - a click inside the calendar would be re-targeted to
							     the text box and its text would join the accessible name. -->
							<div class="banto-field banto-field--stacked">
								{@render control()}
								<label class="banto-field-label" for={inputId}>
									{def.label}
									{#if def.required}<span class="required">*</span>{/if}
								</label>
							</div>
						{:else if underline}
							<label class="banto-field banto-field--stacked" for={inputId}>
								{@render control()}
								<span class="banto-field-label">
									{def.label}
									{#if def.required}<span class="required">*</span>{/if}
								</span>
							</label>
						{:else if grouped}
							{@render control()}
						{:else}
							<label class="label" for={inputId}>
								{def.label}
								{#if def.required}<span class="required">*</span>{/if}
							</label>
							{@render control()}
						{/if}
						{#if def.help}
							<p id={helpId} class="help">{def.help}</p>
						{/if}
						{#if store.errors[def.name]}
							<p id={errorId} class="error">{store.errors[def.name]}</p>
						{/if}
					</div>
				{/each}
			</div>
		{/snippet}
		{#if group.section}
			{@const sectionDescId = `${formId}-section-${groupIndex}-desc`}
			<fieldset
				class="section"
				data-section={group.section.id}
				aria-describedby={group.section.description ? sectionDescId : undefined}
			>
				<legend class="section-title">{group.section.title}</legend>
				{#if group.section.description}
					<p id={sectionDescId} class="section-desc">{group.section.description}</p>
				{/if}
				{@render fieldsGrid()}
			</fieldset>
		{:else}
			{@render fieldsGrid()}
		{/if}
	{/each}

	<div class="footer" class:footer--underline={appearance === 'underline'}>
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
		gap: var(--banto-space-4);
		/* Columns follow the form's own width (a drawer is narrow on a wide screen). */
		container-type: inline-size;
	}

	.section {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
	}

	.section-title {
		padding: 0;
		font-size: var(--banto-font-size-lg);
		font-weight: 600;
		color: var(--banto-text);
	}

	.section-desc {
		margin: 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	/* One column until the form is wide enough; DOM order = reading and tab order. */
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--banto-space-4);
	}

	@container (min-width: 36rem) {
		.grid[data-columns='2'],
		.grid[data-columns='3'] {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@container (min-width: 54rem) {
		.grid[data-columns='3'] {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	.field--full {
		grid-column: 1 / -1;
	}

	.help {
		margin: 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
	}

	.label {
		font-size: var(--banto-font-size-md);
		color: var(--banto-text-muted);
	}

	.required {
		color: var(--banto-danger);
		margin-left: var(--banto-space-1);
	}

	.error {
		margin: 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-danger);
	}

	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--banto-space-3);
		margin-top: var(--banto-space-2);
	}

	.footer--underline {
		flex-wrap: wrap;
	}

	.footer--underline > button,
	.footer--underline > :global(.banto-btn) {
		box-sizing: border-box;
		max-width: 100%;
		min-height: var(--banto-control-height);
		height: auto;
		padding: var(--banto-space-2) var(--banto-space-3);
		white-space: normal;
		text-align: center;
	}

	.footer--underline > button:focus-visible,
	.footer--underline > :global(.banto-btn:focus-visible) {
		outline: var(--banto-border-width-strong) solid var(--banto-primary-hover);
		outline-offset: var(--banto-border-width);
	}

	button {
		height: var(--banto-control-height);
		box-sizing: border-box;
		padding: 0 var(--banto-space-5);
		border: none;
		border-radius: var(--banto-radius-md);
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	button:hover:not(:disabled) {
		background: var(--banto-primary-solid-hover);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
