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
	 * through `draft.commit`, exactly when `NumberField` users validate today.
	 */
	import type { FieldDef } from '../types';
	import { formatDraftValue, type FormDraft } from '../draft.svelte';

	interface Props {
		def: FieldDef;
		draft: FormDraft;
		disabled?: boolean;
		/** Called after each commit (blur / Enter) with whether the field is valid. */
		onCommit?: (valid: boolean) => void;
	}

	let { def, draft, disabled = false, onCommit }: Props = $props();

	const isDisabled = $derived(disabled || !!def.readonly);
	const text = $derived(draft.raw[def.name] ?? formatDraftValue(draft.values[def.name]));
	const error = $derived(draft.errors[def.name]);

	function commit() {
		const valid = draft.commit(def.name);
		onCommit?.(valid);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.isComposing) commit();
	}
</script>

<input
	type="text"
	inputmode="decimal"
	autocomplete="off"
	id={def.name}
	value={text}
	placeholder={def.placeholder}
	disabled={isDisabled}
	class:muted={def.readonly}
	aria-invalid={!!error}
	oninput={(event) => draft.setRaw(def.name, event.currentTarget.value)}
	onblur={commit}
	onkeydown={handleKeydown}
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
		outline: none;
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
