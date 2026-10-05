/**
 * "No navigation in progress" for the layouts' `invalidateAll()` (Issue
 * #326, first met in #321).
 *
 * An `invalidateAll()` that starts while SvelteKit is still running a
 * navigation makes that navigation abort without clearing its internal
 * "navigating" flag (@sveltejs/kit 2.70 `client.js`: `navigate()` returns on
 * `token !== nav_token` with `is_navigating` still true). Two things follow:
 * the move the user asked for is lost (the re-run reloads the URL the
 * navigation started from), and `beforeNavigate` - the unsaved-changes
 * guard (`#lib/unsavedChanges.ts`) - is skipped for the next navigation, so
 * leaving a form with unsaved input no longer asks.
 *
 * So the layouts start their re-runs only when {@link isNavigationSettled}:
 * - the root layout's startup re-run (`routes/+layout.svelte`, #321), and
 * - wiring ① of `(app)/+layout.svelte` (#326: the generation can move while
 *   a navigation is in flight - another tab's login, a revocation confirmed
 *   in the background).
 * A navigation that is still running re-runs the guard itself; whatever it
 * could not see is caught by the deferred re-run once it has completed.
 *
 * `navigating.to` alone is not enough: SvelteKit does not publish the FIRST
 * navigation (`type === 'enter'`) in `navigating`, so until that one has
 * finished it reads `null` while the flag is set. The end of the first
 * navigation is recorded app-wide by the root layout
 * ({@link trackFirstNavigation}) - not per component: a layout mounted by an
 * `invalidateAll()` (no navigation) never gets an `afterNavigate` call of
 * its own.
 */
import { afterNavigate } from '$app/navigation';
import { navigating } from '$app/state';

let firstNavigationDone = $state(false);

/**
 * Records the end of the first navigation. Call once, during the root
 * layout's initialisation (it is mounted by that navigation).
 */
export function trackFirstNavigation(): void {
	afterNavigate(({ shallow }) => {
		if (shallow) return;

		firstNavigationDone = true;
	});
}

/** True when no SvelteKit navigation is in progress. Reactive (read it in an `$effect`). */
export function isNavigationSettled(): boolean {
	return firstNavigationDone && navigating.to === null;
}
