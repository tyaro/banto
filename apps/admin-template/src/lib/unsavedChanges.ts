/**
 * App-side wiring for `@banto/forms`'s unsaved-changes guard (spec §7,
 * issue #214). Pages call `guardUnsavedChanges({ isDirty, isSaving })`
 * during component init; this binds the parts the package cannot know:
 * SvelteKit's `beforeNavigate`, the Paraglide prompt text (conventions §13)
 * and which navigations are forced.
 *
 * Forced = the target is the login screen. Every path there means the
 * session is ending or already gone - logout (`Header.svelte` /
 * `commands.ts` log out first, then `goto('/login')`), or a session the
 * `(app)` guard could not confirm being redirected by `resolveProtectedSession`
 * (#204) after an `invalidateAll()`. Holding the user on a page whose
 * session is gone would only strand them, so those never prompt. (A
 * redirect that happens INSIDE a navigation never reaches `beforeNavigate`
 * at all - SvelteKit skips it while navigating.)
 *
 * The desktop window close is not a router navigation; `(app)/+layout.svelte`
 * covers it with `guardWindowClose` (`$lib/banto/windowCloseGuard.ts`).
 */
import { beforeNavigate } from '$app/navigation';
import { base } from '$app/paths';
import {
	guardUnsavedChanges as guardWith,
	type LeaveNavigation,
	type UnsavedChangesGuard
} from '@banto/forms';
import * as m from '$lib/paraglide/messages';

/** True for navigations that must never be held back (see module doc comment). */
export function isForcedNavigation(navigation: LeaveNavigation): boolean {
	const pathname = navigation.to?.url.pathname;
	return pathname === `${base}/login` || pathname === `${base}/login/`;
}

export interface AppUnsavedChangesOptions {
	/** The draft differs from what was loaded or last saved. */
	isDirty: () => boolean;
	/** A save is in flight (leaving could drop it). */
	isSaving?: () => boolean;
}

/** Register the page's guard. Call during component initialisation. */
export function guardUnsavedChanges(options: AppUnsavedChangesOptions): UnsavedChangesGuard {
	return guardWith({
		...options,
		beforeNavigate,
		message: () => m['unsaved.confirmLeave'](),
		isForced: isForcedNavigation
	});
}
