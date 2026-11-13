<script lang="ts">
	/**
	 * Confirmation dialog (Issue #556, docs/adr/0018-shared-ui-package.md §10):
	 * the in-page replacement for `window.confirm`, built on the same
	 * OverlayPanel as Modal (variant `modal`), so Esc / the scrim / × / the focus
	 * trap / the exit motion / the opener's focus return follow the Modal
	 * contract (`OverlayProps`, overlay.ts) unchanged.
	 *
	 * What it adds:
	 *
	 * - `role="alertdialog"` with the title as its name and the body as its
	 *   description (`aria-describedby`).
	 * - Cancel and confirm buttons. `danger` gives the confirm button the
	 *   danger look. Esc, the scrim, × and Cancel all call `oncancel`.
	 * - `requireText`: a text box that must match exactly before the confirm
	 *   button is enabled (for the operations that cannot be undone, such as
	 *   deleting a user). Enter in the box confirms once it matches.
	 * - Focus on open goes to the safe choice: the text box when there is one,
	 *   otherwise Cancel - never the confirm button, so a stray Enter does not
	 *   confirm.
	 *
	 * Controlled like Modal: the parent owns `open`. For the `await confirm()`
	 * form, use `createConfirmStore()` + `ConfirmHost` (confirm.svelte.ts).
	 */
	import type { Snippet } from 'svelte';
	import OverlayPanel from './OverlayPanel.svelte';
	import { defaultUiMessages, type UiMessages } from './messages';

	interface Props {
		/** Whether the dialog is shown. Controlled by the parent. */
		open: boolean;
		/** Heading and the dialog's accessible name. */
		title: string;
		/** Body text (the dialog's description). Line breaks (`\n`) are kept. */
		message?: string;
		/** The confirm button's text. Default: `messages.confirmOk`. */
		confirmLabel?: string;
		/** The cancel button's text. Default: `messages.confirmCancel`. */
		cancelLabel?: string;
		/** A destructive action: the confirm button takes the danger look. Default `false`. */
		danger?: boolean;
		/** Text the user must type before confirming (e.g. the name of what is deleted). Omitted = no text box. */
		requireText?: string;
		/** Any CSS length. Default `28rem`. */
		width?: string;
		/** The confirm button was pressed (or Enter in a matching text box). */
		onconfirm: () => void;
		/** Cancel, Esc, the scrim or ×. */
		oncancel: () => void;
		/** Text overrides (layer 1 i18n): `confirmOk`, `confirmCancel`, `confirmTypeToConfirm`, `overlayClose`. */
		messages?: UiMessages;
		/** Extra body content under the message (e.g. a list of what is affected). */
		children?: Snippet;
	}

	let {
		open,
		title,
		message,
		confirmLabel,
		cancelLabel,
		danger = false,
		requireText,
		width = '28rem',
		onconfirm,
		oncancel,
		messages,
		children
	}: Props = $props();

	const t = $derived({ ...defaultUiMessages, ...messages });

	const uid = $props.id();
	const messageId = `${uid}-message`;
	const inputId = `${uid}-input`;

	let typed = $state('');

	// A fresh text box for every opening and every new question (ConfirmHost
	// reuses one instance, and a newer question can replace an open one).
	$effect.pre(() => {
		void requireText;
		if (open) typed = '';
	});

	const matches = $derived(requireText === undefined || typed === requireText);

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		if (!open || !matches) return;
		onconfirm();
	}

	function safeFocus(panel: HTMLElement): HTMLElement | null {
		return panel.querySelector<HTMLElement>('[data-confirm-initial]');
	}
</script>

<OverlayPanel
	variant="modal"
	role="alertdialog"
	{open}
	{title}
	{width}
	{messages}
	describedBy={message ? messageId : undefined}
	initialFocus={safeFocus}
	onclose={oncancel}
>
	<form class="confirm" onsubmit={handleSubmit}>
		{#if message}
			<p class="message" id={messageId}>{message}</p>
		{/if}
		{@render children?.()}
		{#if requireText !== undefined}
			<div class="field">
				<label class="label" for={inputId}>{t.confirmTypeToConfirm(requireText)}</label>
				<input
					id={inputId}
					class="input"
					type="text"
					autocomplete="off"
					spellcheck="false"
					data-confirm-initial
					bind:value={typed}
				/>
			</div>
		{/if}
		<div class="actions">
			<button
				type="button"
				class="button button--secondary"
				data-confirm-initial={requireText === undefined ? '' : undefined}
				onclick={oncancel}
			>
				{cancelLabel ?? t.confirmCancel()}
			</button>
			<button
				type="submit"
				class="button"
				class:button--danger={danger}
				class:button--primary={!danger}
				disabled={!matches}
			>
				{confirmLabel ?? t.confirmOk()}
			</button>
		</div>
	</form>
</OverlayPanel>

<style>
	.confirm {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		margin: 0;
	}

	.message {
		margin: 0;
		color: var(--banto-text);
		white-space: pre-line;
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
	}

	.label {
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
		overflow-wrap: anywhere;
	}

	.input {
		height: var(--banto-control-height);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
	}

	.input:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--banto-space-2);
	}

	/* The look of admin-template's `.banto-btn` (app.css), kept here because a
	   package cannot rely on the app's global classes. */
	.button {
		display: inline-flex;
		align-items: center;
		height: var(--banto-control-height);
		padding: 0 var(--banto-space-4);
		border: var(--banto-border-width) solid transparent;
		border-radius: var(--banto-radius-md);
		font: inherit;
		color: var(--banto-text);
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.button:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.button--secondary {
		background: var(--banto-surface);
		border-color: var(--banto-border-strong);
	}

	.button--secondary:hover {
		background: var(--banto-surface-hover);
	}

	.button--primary {
		background: var(--banto-primary-solid);
		color: var(--banto-on-solid);
	}

	.button--primary:hover:not(:disabled) {
		background: var(--banto-primary-solid-hover);
	}

	.button--danger {
		background: var(--banto-danger-solid);
		color: var(--banto-on-danger-solid);
	}

	.button--danger:hover:not(:disabled) {
		background: var(--banto-danger-solid-hover);
	}
</style>
