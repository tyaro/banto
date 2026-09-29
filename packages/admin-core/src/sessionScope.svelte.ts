/**
 * Who this tab's session belongs to, and which "generation" of it is live
 * (Issue #215/#255, 4th review - redesign).
 *
 * State saved on behalf of a signed-in identity (today: `listViewState.ts`'s
 * list filter/sort/last-opened-row memory) must never surface for a
 * DIFFERENT identity. Earlier rounds of #255 tried to guarantee that by
 * CLEARING the state at every authentication transition (wrapping
 * `AuthProvider.login`/`logout`/..., hooking the route guard and the
 * session-ended confirmation). Each review found another path that wrapper
 * never saw - another tab replacing the shared "Remember me" token, a page
 * that SvelteKit keeps alive across `invalidateAll()` writing the old state
 * back, a frozen `AuthProvider` the wrapping `Proxy` could not legally
 * wrap. "Clear on every path" fails open: one missed path leaks.
 *
 * This module is the fail-closed replacement. Two values describe the live
 * session:
 *
 * - `owner` - a stable key for the CONFIRMED identity (`sessionOwnerKey`),
 *   or `null` while no identity is confirmed (before the route guard's
 *   `getIdentity()` resolved, after the session ended, or when the provider
 *   could not say who is signed in). Saved state carries the owner it was
 *   saved for, and is only handed back to the SAME owner - whatever path
 *   changed the identity (this tab, another tab, a reload) is irrelevant.
 * - `generation` - bumped every time the session ends or its owner changes.
 *   A screen (or an async operation) captures `currentSessionScope()` when
 *   it starts and may only write while `isCurrentSessionScope()` still
 *   holds, so a screen that outlived its session cannot write the old
 *   session's state back under the new one - even for the SAME owner
 *   (logout then re-login as the same account starts a new generation).
 *
 * Only `sessionLifecycle.ts`'s `beginSession`/`endSession` move these; this
 * file has no imports so `listViewState.ts` can read it without a cycle.
 */
import type { Identity } from './provider';

/** A snapshot of the live session, taken when a screen/operation starts. Compare with `isCurrentSessionScope` before acting on its behalf. */
export interface SessionScope {
	readonly generation: number;
	/** `sessionOwnerKey()` of the confirmed identity, or `null` = no confirmed identity (nothing may be saved or restored for it). */
	readonly owner: string | null;
}

let generation = $state(0);
let owner: string | null = $state(null);
let established = $state(false);

/**
 * Stable owner key for `identity`: `null` when there is no identity or it
 * has no usable `id` (fail closed - unknown owners never match anything).
 *
 * The synthetic LAN viewer session (`identity.publicViewer === true`,
 * ADR-0012) gets its own namespace: a real account may share its `id`
 * (Issue #209 - an ordinary account named `public`), and the two must not
 * see each other's state.
 */
export function sessionOwnerKey(identity: Identity | null | undefined): string | null {
	if (!identity) return null;
	if (identity.publicViewer === true) return 'public-viewer';
	const id: unknown = identity.id;
	if ((typeof id !== 'string' && typeof id !== 'number') || id === '') return null;
	return `account:${String(id)}`;
}

/** Reactive (`$state`-backed): bumped whenever the session ends or its owner changes. */
export function sessionGeneration(): number {
	return generation;
}

/** Reactive: `true` between `beginSession` and the next `endSession`. */
export function isSessionEstablished(): boolean {
	return established;
}

/** The live session's `{ generation, owner }`, frozen. Capture it when a screen/operation starts. */
export function currentSessionScope(): SessionScope {
	return Object.freeze({ generation, owner });
}

/** Is `scope` still the live session (same generation AND same owner)? A screen or async operation that captured an older scope must not act on this session's behalf. */
export function isCurrentSessionScope(scope: SessionScope): boolean {
	return scope.generation === generation && scope.owner === owner;
}

/**
 * Internal (not exported from the package index): move the session to
 * `nextOwner`. Bumps the generation when the session ends, when a session
 * starts after having ended (or never started), and when the owner
 * changes; a repeated start for the SAME owner (a route guard re-running on
 * `invalidateAll()`) keeps it, so a guard re-run never invalidates the
 * screens of a session that did not change.
 */
export function transitionSessionScope(nextOwner: string | null, nextEstablished: boolean): void {
	const changed = !nextEstablished || !established || nextOwner !== owner;
	owner = nextOwner;
	established = nextEstablished;
	if (changed) generation += 1;
}
