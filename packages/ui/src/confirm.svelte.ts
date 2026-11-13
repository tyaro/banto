/**
 * Confirm store (Issue #556, docs/adr/0018-shared-ui-package.md §10): the
 * `await confirm(...)` way to ask with `ConfirmDialog`, shaped like the toast
 * store (`createToastStore` + `ToastHost`): the app creates one store, mounts
 * one `ConfirmHost` in its root layout, and any handler asks
 *
 *     if (!(await confirmStore.confirm({ title, message, danger: true }))) return;
 *
 * in place of `if (!window.confirm(message)) return;` - the call site keeps
 * its shape, and needs no dialog markup or `open` state of its own.
 *
 * Svelte 5 runes, so this is a `.svelte.ts` source: consumers list
 * `@banto/ui` in Vite's `optimizeDeps.exclude` (ADR-0007, conventions §14).
 *
 * One question at a time: asking while another is open answers the open one
 * `false` (as if cancelled) and shows the new one. A confirm is a modal
 * interruption, so a queue would only stack questions the user did not see
 * being asked.
 */

export interface ConfirmOptions {
	/** Heading and the dialog's accessible name. */
	title: string;
	/** Body text (`aria-describedby`). Line breaks (`\n`) are kept. */
	message?: string;
	/** The confirm button's text. Default: `UiMessages.confirmOk`. */
	confirmLabel?: string;
	/** The cancel button's text. Default: `UiMessages.confirmCancel`. */
	cancelLabel?: string;
	/** A destructive action: the confirm button takes the danger look. Default `false`. */
	danger?: boolean;
	/**
	 * Ask the user to type this exact text (e.g. the user name to delete);
	 * the confirm button stays disabled until the text box matches. Omitted =
	 * no text box.
	 */
	requireText?: string;
}

export interface ConfirmRequest extends ConfirmOptions {
	/** Identifies the question, so a late answer to an earlier one is ignored. */
	readonly id: number;
}

export interface ConfirmStore {
	/** The question on screen, or `null`. Read by `ConfirmHost`. */
	readonly current: ConfirmRequest | null;
	/** Shows the question; resolves `true` on confirm, `false` on cancel / Esc / × / a newer question. */
	confirm(options: ConfirmOptions): Promise<boolean>;
	/** Answers the question `id` (ConfirmHost's buttons). Unknown or already answered ids are ignored. */
	settle(id: number, confirmed: boolean): void;
	/**
	 * Answers the open question `false` (no-op when none is open). Call it when
	 * the page that asked goes away - e.g. from SvelteKit's `beforeNavigate` -
	 * so a handler awaiting a destructive confirm cannot carry on from a page
	 * the user has already left.
	 */
	cancel(): void;
}

class ConfirmStoreImpl implements ConfirmStore {
	current: ConfirmRequest | null = $state(null);
	#nextId = 1;
	#resolve: ((confirmed: boolean) => void) | null = null;

	confirm(options: ConfirmOptions): Promise<boolean> {
		if (this.current) this.settle(this.current.id, false);
		const id = this.#nextId++;
		return new Promise<boolean>((resolve) => {
			this.#resolve = resolve;
			this.current = { ...options, id };
		});
	}

	settle(id: number, confirmed: boolean): void {
		if (!this.current || this.current.id !== id) return;
		const resolve = this.#resolve;
		this.#resolve = null;
		this.current = null;
		resolve?.(confirmed);
	}

	cancel(): void {
		if (this.current) this.settle(this.current.id, false);
	}
}

export function createConfirmStore(): ConfirmStore {
	return new ConfirmStoreImpl();
}
