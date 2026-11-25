<script lang="ts">
	/**
	 * A password `<input>` with a show / hide button at its right end (Issue #944).
	 * The one place a password box is drawn: `PasswordField` (schema forms) and the
	 * app's own password inputs (login, settings, users) all use it, so they look
	 * and behave alike.
	 *
	 * - Starts hidden (`type="password"`). Each press of the button swaps
	 *   `type="password"` <-> `type="text"`; it is a toggle, not "while held".
	 * - The button is `type="button"` (never submits), `aria-pressed`, and its
	 *   `aria-label` follows the state (`messages.show` / `messages.hide`).
	 * - Value and caret survive a toggle; a pointer press keeps focus in the input.
	 * - Goes back to hidden when the owning form is submitted or reset, and when the
	 *   component unmounts (the state is local, so leaving the page forgets it).
	 * - `disabled` / `readonly` disable the button too. Nothing here can turn the
	 *   button off: every password box gets it (owner decision, #944).
	 * - `autocomplete` is given by the caller (`new-password` / `current-password`).
	 *
	 * Layout: a wrapper `.banto-affix` carries the box, so inside a
	 * `.banto-field` it takes the theme's underline look (see banto.css); `class` is
	 * for the `<input>`. The wrapper is a sibling-compatible replacement for a bare
	 * input, so pair it with `<label class="banto-field-label" for={id}>`, never a
	 * wrapping `<label>` (the button's name would join the input's).
	 */
	import { untrack } from 'svelte';
	import { defaultPasswordInputMessages, type PasswordInputMessages } from './password';
	import Eye from '../icons/Eye.svelte';
	import EyeOff from '../icons/EyeOff.svelte';

	interface Props {
		id?: string;
		name?: string;
		/** Classes of the `<input>` (e.g. `banto-field-control`). Without it the wrapper draws the box. */
		class?: string;
		value?: string;
		placeholder?: string;
		autocomplete?: 'new-password' | 'current-password' | 'off';
		disabled?: boolean;
		readonly?: boolean;
		required?: boolean;
		'aria-invalid'?: boolean;
		'aria-describedby'?: string;
		messages?: Partial<PasswordInputMessages>;
		/** The input's own `input` event (after `value` is updated). */
		oninput?: (event: Event & { currentTarget: HTMLInputElement }) => void;
		onblur?: (event: FocusEvent & { currentTarget: HTMLInputElement }) => void;
	}

	let {
		id,
		name,
		class: className,
		value = $bindable(''),
		placeholder,
		autocomplete = 'new-password',
		disabled = false,
		readonly = false,
		required = false,
		'aria-invalid': ariaInvalid,
		'aria-describedby': describedBy,
		messages,
		oninput,
		onblur
	}: Props = $props();

	const t = $derived({ ...defaultPasswordInputMessages, ...messages });

	let revealed = $state(false);
	let inputEl: HTMLInputElement | undefined = $state();

	// The caret / selection is read before the type changes and put back after, so
	// toggling does not jump to the end (Chromium and Firefox reset it otherwise).
	async function toggle() {
		const el = inputEl;
		const start = el?.selectionStart ?? null;
		const end = el?.selectionEnd ?? null;
		const direction = el?.selectionDirection ?? undefined;
		revealed = !revealed;
		if (!el) return;
		await Promise.resolve();
		if (start !== null && end !== null && el.isConnected) {
			try {
				el.setSelectionRange(start, end, direction);
			} catch {
				// not supported on this input state: keep whatever the browser did
			}
		}
	}

	// Back to hidden when the owning form is sent or cleared.
	$effect(() => {
		const form = inputEl?.form;
		if (!form) return;
		const hide = () => {
			untrack(() => (revealed = false));
		};
		form.addEventListener('submit', hide);
		form.addEventListener('reset', hide);
		return () => {
			form.removeEventListener('submit', hide);
			form.removeEventListener('reset', hide);
		};
	});

	const buttonDisabled = $derived(disabled || readonly);
</script>

<span class="box banto-affix banto-password" class:plain={!className} class:is-disabled={disabled}>
	<input
		bind:this={inputEl}
		bind:value
		{id}
		{name}
		class={className}
		type={revealed ? 'text' : 'password'}
		{placeholder}
		{autocomplete}
		{disabled}
		{readonly}
		{required}
		class:muted={readonly}
		aria-invalid={ariaInvalid}
		aria-describedby={describedBy}
		{oninput}
		{onblur}
	/>
	<button
		type="button"
		class="reveal"
		disabled={buttonDisabled}
		aria-pressed={revealed}
		aria-label={revealed ? t.hide() : t.show()}
		onmousedown={(event) => {
			// Keep focus (and the on-screen keyboard) in the input while pressing with a pointer.
			if (document.activeElement === inputEl) event.preventDefault();
		}}
		onclick={toggle}
	>
		{#if revealed}<EyeOff size={18} />{:else}<Eye size={18} />{/if}
	</button>
</span>

<style>
	.box {
		display: flex;
		align-items: center;
		min-width: 0;
		box-sizing: border-box;
	}

	.box input {
		flex: 1 1 auto;
		min-width: 0;
	}

	/* Edge / WebView2 draw their own reveal and clear buttons; ours replaces them. */
	.box input::-ms-reveal,
	.box input::-ms-clear {
		display: none;
	}

	/* No class given: the wrapper draws the box, as TextField's input would. */
	.box.plain {
		height: var(--banto-control-height);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	.box.plain:has(input:focus-visible) {
		box-shadow: var(--banto-focus-ring);
	}

	.box.plain.is-disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.plain input {
		height: 100%;
		padding: 0 var(--banto-space-2);
		border: none;
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		box-sizing: border-box;
	}

	.plain input:focus-visible {
		outline: none;
	}

	.plain input:disabled {
		cursor: not-allowed;
	}

	.plain input.muted {
		color: var(--banto-text-muted);
	}

	.reveal {
		flex: none;
		align-self: stretch;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		inline-size: var(--banto-control-height);
		padding: 0;
		border: none;
		border-radius: var(--banto-radius-sm);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
	}

	.reveal:hover:not(:disabled) {
		color: var(--banto-text);
	}

	.reveal[aria-pressed='true'] {
		color: var(--banto-text);
	}

	.reveal:focus-visible {
		outline: var(--banto-border-width-strong) solid transparent;
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
	}

	.reveal:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
