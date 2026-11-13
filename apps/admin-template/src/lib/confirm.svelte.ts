/**
 * The app's confirm store: one `@banto/ui` store (Issue #556), shown by
 * `ConfirmHost` (components/ConfirmHost.svelte) in the root layout. Handlers
 * ask with
 *
 *     if (!(await confirmAction({ title, message, danger: true }))) return;
 *
 * in place of `window.confirm`. Two prompts stay on `window.confirm` because
 * they must answer synchronously: the unsaved-changes guard (`@banto/forms`
 * unsavedChanges.svelte.ts) and the window-close guard (banto/windowCloseGuard.ts).
 */
import { createConfirmStore, type ConfirmOptions } from '@banto/ui';

export const confirmStore = createConfirmStore();

/** Shows the in-page confirm dialog; `true` when the user confirmed. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	return confirmStore.confirm(options);
}
