/**
 * The apply / discard / cancel question of a `DraftCoordinator.settle`
 * (shared-primitives-upstream-plan §3.5, Issue #432 PR-10) as reactive
 * state for a dialog (`DraftSettleDialog.svelte`, built on `@banto/ui`'s
 * `Modal`). `ask` is the `settle` callback: it opens the dialog and resolves
 * with the user's answer.
 *
 * - One question at a time: a new `ask` while one is open answers the old one
 *   `'cancel'` (its settle keeps everything) and shows the new one.
 * - Closing the dialog any other way (Esc, scrim, ×) is `'cancel'`.
 * - `dispose()` (page unmount) answers an open question `'cancel'`.
 * - Asking closes every open ui `Menu` first (`closeOpenMenus`): a checkbox
 *   item keeps its menu open on select (the dashboard's View menu hiding the
 *   memo pane, #663 ①-C), and the menu is a top-layer popover that would
 *   stay above the dialog's scrim, usable, and - for `layering.ts` - the
 *   layer above it, so the dialog's Esc and focus pull-back would yield to
 *   it. Closing it before the dialog renders keeps the question the only
 *   active layer, and the order keeps focus right: `hidePopover()` (popover
 *   "auto") puts focus back on the menu's trigger, the dialog then records
 *   that trigger as its opener and takes focus, and on its close gives it
 *   back to the trigger. Menu's own queued toggle handler leaves focus alone
 *   since it is no longer on <body> or in the menu by then.
 *
 * State is written in `untrack` so calling `ask` from inside an `$effect`
 * cannot make the effect re-run itself (conventions §8).
 */
import { untrack } from 'svelte';
import type { DraftSettleChoice } from '@banto/forms';
import { closeOpenMenus } from '@banto/ui';

export interface SettlePrompt {
	/** A question is showing. Reactive. */
	readonly open: boolean;
	/** The dirty draft keys the open question is about. Reactive. */
	readonly dirtyKeys: readonly string[];
	ask(dirtyKeys: readonly string[]): Promise<DraftSettleChoice>;
	answer(choice: DraftSettleChoice): void;
	dispose(): void;
}

class Prompt implements SettlePrompt {
	#keys = $state<readonly string[] | null>(null);
	#resolve: ((choice: DraftSettleChoice) => void) | null = null;
	#disposed = false;

	get open(): boolean {
		return this.#keys !== null;
	}

	get dirtyKeys(): readonly string[] {
		return this.#keys ?? [];
	}

	ask(dirtyKeys: readonly string[]): Promise<DraftSettleChoice> {
		if (this.#disposed) return Promise.resolve('cancel');
		this.answer('cancel');
		closeOpenMenus();
		return new Promise<DraftSettleChoice>((resolve) => {
			this.#resolve = resolve;
			untrack(() => (this.#keys = [...dirtyKeys]));
		});
	}

	answer(choice: DraftSettleChoice): void {
		const resolve = this.#resolve;
		this.#resolve = null;
		untrack(() => (this.#keys = null));
		resolve?.(choice);
	}

	dispose(): void {
		this.answer('cancel');
		this.#disposed = true;
	}
}

export function createSettlePrompt(): SettlePrompt {
	return new Prompt();
}
