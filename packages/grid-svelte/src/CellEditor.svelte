<script lang="ts">
	/**
	 * Inline cell editor markup (select / checkbox / text-number-date input).
	 * Template only: edit state transitions, key/blur handling and focus
	 * management stay in `BantoGrid.svelte` and arrive here as callbacks. The
	 * draft is never written here; `onDraftChange` lets the grid own it.
	 *
	 * A date editor injected by the app (`dateEditor`, date-time-pickers §5.8,
	 * `cellEditors.ts`) replaces the native `<input type="date">`. It gets the
	 * draft as its text and reports every text change back, so the grid's
	 * Enter / Tab / blur commit stays the one path. Its wrapper is the
	 * editor's root for the grid (`editorRootEl`): pointerdown, click and
	 * dblclick inside it - the button, the calendar (a top-layer popover that
	 * is still a DOM child of the cell) - stop here, so they never reach the
	 * cell's selection / row click / start-editing handlers (§5.8 promise 4),
	 * and neither do keys from anything but the text box (whose keys the grid
	 * handles through `onKeydown`).
	 */
	import type { Component } from 'svelte';
	import type { CellEditorType } from './types';
	import type { CellDateEditorProps } from './cellEditors';
	import { resolveSelectValue } from './core/clipboard';
	import { isIsoDate } from './core/date';

	let {
		editor,
		label,
		invalid,
		describedBy,
		pending,
		draft,
		options,
		dateEditor,
		min,
		max,
		isDateDisabled,
		editorEl = $bindable(),
		editorRootEl = $bindable(),
		onDraftChange,
		onToggle,
		onKeydown,
		onBlur
	}: {
		editor: CellEditorType | undefined;
		label: string;
		invalid: boolean;
		describedBy: string | undefined;
		pending: boolean;
		draft: unknown;
		options: { value: string | number; label: string }[] | undefined;
		/** Injected date editor (`CellEditors.date`); omitted: the native input. */
		dateEditor?: Component<CellDateEditorProps>;
		min?: string;
		max?: string;
		isDateDisabled?: (date: string) => boolean;
		editorEl: HTMLInputElement | HTMLSelectElement | undefined;
		/** The injected editor's wrapper (unset for the native inputs, whose root is `editorEl`). */
		editorRootEl?: HTMLElement | null;
		onDraftChange: (value: unknown) => void;
		onToggle: (checked: boolean) => void;
		onKeydown: (event: KeyboardEvent) => void;
		onBlur: (event: FocusEvent) => void;
	} = $props();

	const DateEditor = $derived(editor === 'date' ? dateEditor : undefined);
	const draftText = $derived(String(draft ?? ''));

	function stop(event: Event) {
		event.stopPropagation();
	}

	const common = $derived({
		'aria-label': label,
		'aria-invalid': invalid,
		'aria-describedby': describedBy,
		class: 'cell-editor',
		onpointerdown: (event: PointerEvent) => event.stopPropagation(),
		onkeydown: onKeydown,
		onblur: onBlur
	});
</script>

{#if (editor ?? 'text') === 'select'}
	<select
		bind:this={editorEl}
		{...common}
		class:pending
		value={String(draft ?? '')}
		onchange={(event) => onDraftChange(resolveSelectValue(event.currentTarget.value, options))}
	>
		{#each options ?? [] as option (option.value)}
			<option value={String(option.value)}>{option.label}</option>
		{/each}
	</select>
{:else if (editor ?? 'text') === 'checkbox'}
	<input
		type="checkbox"
		bind:this={editorEl}
		{...common}
		class:pending
		checked={!!draft}
		onclick={(event) => event.stopPropagation()}
		onchange={(event) => onToggle(event.currentTarget.checked)}
	/>
{:else if DateEditor}
	<!-- Not a control itself: it only keeps the editor's pointer and key events
	     away from the cell (see the module doc). -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="cell-editor-host"
		class:pending
		bind:this={editorRootEl}
		onpointerdown={stop}
		onclick={stop}
		ondblclick={stop}
		onkeydown={stop}
	>
		<DateEditor
			bind:inputEl={() => editorEl as HTMLInputElement | undefined, (el) => (editorEl = el)}
			value={isIsoDate(draft) ? draft : null}
			text={draftText}
			onTextInput={onDraftChange}
			{label}
			{describedBy}
			{invalid}
			readonly={pending}
			{min}
			{max}
			{isDateDisabled}
			onkeydown={onKeydown}
			onblur={onBlur}
		/>
	</div>
{:else}
	<input
		type={editor === 'number' ? 'number' : editor === 'date' ? 'date' : 'text'}
		bind:this={editorEl}
		{...common}
		class:pending
		value={String(draft ?? '')}
		oninput={(event) => onDraftChange(event.currentTarget.value)}
	/>
{/if}

<style>
	.cell-editor {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		padding: 0 var(--banto-space-2);
		border: none;
		outline: none;
		background: var(--banto-surface);
		color: var(--banto-text);
		font: inherit;
	}

	/* Keep the native checkbox compact instead of stretching the editor box. */
	.cell-editor[type='checkbox'] {
		width: var(--banto-checkbox-size, 1.1rem);
		height: var(--banto-checkbox-size, 1.1rem);
		flex-shrink: 0;
		padding: 0;
		margin-inline: var(--banto-space-2);
		accent-color: var(--banto-primary);
	}

	/* The injected editor fills the cell. `--banto-date-input-width` is the
	   width hook `@banto/ui`'s DateInput reads (its default is a fixed width
	   for forms); another component simply ignores it. */
	.cell-editor-host {
		display: flex;
		align-items: center;
		width: 100%;
		height: 100%;
		min-width: 0;
		--banto-date-input-width: 100%;
	}

	.cell-editor.pending,
	.cell-editor-host.pending {
		opacity: 0.5;
		pointer-events: none;
	}
</style>
