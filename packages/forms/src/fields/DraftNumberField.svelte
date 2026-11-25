<script lang="ts">
	/**
	 * Numeric input bound to a `FormDraft` (spec §7.2 `type: 'number'`;
	 * shared-primitives-upstream-plan §3.5). Unlike `NumberField` it keeps the
	 * raw text - incomplete or invalid numbers such as `"1e"` or `"-"` - in the
	 * draft, so the text survives a pane re-mount (dock / undock).
	 *
	 * That needs `type="text"` + `inputmode="decimal"`: a `type="number"` input
	 * reports such text as `''` (HTML `validity.badInput`), so it cannot be kept.
	 * The cost is no spin buttons / arrow-key stepping, which is why this is a
	 * separate field and `NumberField` keeps its behaviour (plan §3.5 "未決",
	 * decided in Issue #432's forms PR). The value is committed on blur / Enter
	 * through `draft.commit`, exactly when `NumberField` users validate today. `change`
	 * commits too, so a programmatic confirm that fires `input` + `change` (a touch
	 * keypad) confirms the value; each text is committed (and `onCommit` notified) once, by whichever of
	 * `change` / blur / Enter comes first.
	 */
	import type { FieldDef } from '../types';
	import { formatDraftValue, type FormDraft } from '../draft.svelte';
	import AffixBox from './AffixBox.svelte';
	import { describedByWithAffix } from './affix';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		draft: FormDraft;
		disabled?: boolean;
		/** Called after each commit (blur / Enter / change) with whether the field is valid. */
		onCommit?: (valid: boolean) => void;
	}

	let {
		def,
		id,
		class: className,
		'aria-describedby': describedBy,
		draft,
		disabled = false,
		onCommit
	}: Props = $props();

	const text = $derived(draft.raw[def.name] ?? formatDraftValue(draft.values[def.name]));
	const error = $derived(draft.errors[def.name]);

	const inputId = $derived(id ?? def.name);
	const described = $derived(describedByWithAffix(def, inputId, describedBy));

	// Native edit + blur fires `change` and `blur`: notify once per text. Remember
	// which draft / field / text was committed last (not a DOM flag), so a
	// `setRaw()` from elsewhere or a swapped `draft` still commits next time.
	let last: { draft: FormDraft; name: string; text: string } | undefined;

	function commit() {
		if (disabled || def.readonly) return;
		if (last && last.draft === draft && last.name === def.name && last.text === text) return;
		const valid = draft.commit(def.name);
		last = { draft, name: def.name, text }; // text after the commit (e.g. "007" -> "7")
		onCommit?.(valid);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) commit();
	}
</script>

<AffixBox {def} id={inputId}>
	<input
		type="text"
		inputmode="decimal"
		autocomplete="off"
		class={className}
		id={inputId}
		value={text}
		placeholder={def.placeholder}
		{disabled}
		readonly={def.readonly}
		class:muted={def.readonly}
		aria-invalid={!!error}
		aria-describedby={described}
		oninput={(event) => {
			if (!disabled && !def.readonly) draft.setRaw(def.name, event.currentTarget.value);
		}}
		onchange={commit}
		onblur={commit}
		onkeydown={handleKeydown}
	/>
</AffixBox>

<style>
	input {
		height: var(--banto-control-height);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		width: 100%;
		box-sizing: border-box;
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	/* Keep numeric glyphs tabular when theme font shorthand is applied. */
	input,
	input.banto-field-control {
		font-variant-numeric: tabular-nums;
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
		color: var(--banto-text-muted);
	}
</style>
