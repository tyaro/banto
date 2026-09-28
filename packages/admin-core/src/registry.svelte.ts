/**
 * Module-level registry for the running Banto app: data/auth providers,
 * notifier, and resource definitions (spec §3.1, §3.4). A single admin app
 * runs one instance of this registry, so a module singleton is sufficient;
 * `initBanto` may be called again (e.g. between tests) to fully replace it.
 */
import { clearAllListViewState, withListViewStateClearing } from './listViewState';
import type { AuthProvider, DataProvider, NotificationKind, Notifier } from './provider';

export interface ResourceDefinition {
	name: string;
	label: string;
	icon?: string;
	/**
	 * Schema-driven form definition (spec §7). Typed as `unknown` so
	 * admin-core has no dependency on @banto/forms; apps pass a `FormSchema`
	 * from @banto/forms here and cast when reading it back (see
	 * apps/admin-template's resource setup).
	 */
	schema?: unknown;
	capabilities?: { list?: boolean; create?: boolean; edit?: boolean; delete?: boolean };
}

export interface InitBantoConfig {
	dataProvider: DataProvider;
	authProvider: AuthProvider;
	notifier?: Notifier;
	resources: ResourceDefinition[];
}

let dataProvider: DataProvider | null = $state(null);
let authProvider: AuthProvider | null = $state(null);
let notifier: Notifier | null = $state(null);
let resources: ResourceDefinition[] = $state([]);
let sessionGenerationCounter = $state(0);

const NOT_INITIALIZED_MESSAGE =
	'initBanto() has not been called yet — call it once at app startup before using admin-core composables.';

/**
 * Bumped every time this tab's signed-in identity changes: a successful
 * `login`/`setup`/`enterPublicViewer`, a `logout`, a background session end
 * confirmed by `sessionEnded.ts`, or a route guard (`resolveProtectedSession`)
 * finding no valid session at all (`endSession` below is the one place all
 * of these funnel through).
 *
 * Issue #215/#255 review (fix 2): capture this BEFORE starting an async
 * operation whose result should be discarded if the identity changes before
 * it resolves - e.g. a detail screen's save is still in flight when the user
 * logs out and someone else logs in before the response arrives. Compare
 * the captured value to `sessionGeneration()` once the operation settles; a
 * mismatch means the screen that started it no longer belongs to the
 * CURRENT session, so its result must not be applied (written to storage
 * shared across identities, re-used to update UI state, ...) - as if the
 * screen had already been torn down. `apps/admin-template`'s items detail
 * page (`routes/(app)/items/[id]/+page.svelte`) is the reference use.
 */
export function sessionGeneration(): number {
	return sessionGenerationCounter;
}

/**
 * Ends the current session's admin-core-owned state: bumps
 * `sessionGeneration()` and clears saved list view state
 * (`clearAllListViewState`, `listViewState.ts`). This is the single funnel
 * every identity-transition point admin-core owns calls into - `initBanto`
 * passes it to `withListViewStateClearing` as its `login`/`setup`/
 * `enterPublicViewer`/`logout` hook below, `sessionGate.ts`'s
 * `resolveProtectedSession` calls it directly when a guard finds no valid
 * session at all (the one transition with no `AuthProvider` method call to
 * hook), and `sessionEnded.ts` calls it the moment a background revocation
 * is confirmed.
 */
export function endSession(): void {
	sessionGenerationCounter += 1;
	clearAllListViewState();
}

/**
 * Register providers/resources for the app. Safe to call again (e.g. in
 * tests) to fully replace state.
 *
 * Issue #215/#255 review: `config.authProvider` is wrapped
 * (`withListViewStateClearing`, `listViewState.ts`, given `endSession` above
 * as its transition hook) before it's stored, so `getAuthProvider()` below
 * returns that wrapper, NOT the exact object the caller passed in - every
 * `login`/`setup`/`enterPublicViewer` success and every `logout` also ends
 * the session (bumps `sessionGeneration()`, clears this session's saved
 * list view state - Issue #215's sort/filters/last-opened-row memory), so a
 * second identity signing into the same tab never inherits the first one's.
 * This needs no cooperation from the app beyond calling `initBanto` as
 * already documented. The wrap preserves `provider`'s own `this` for every
 * method (a `Proxy`, not a shallow copy - see its doc comment) so a class-
 * based or otherwise stateful `AuthProvider` implementation keeps working
 * exactly as it would unwrapped.
 */
export function initBanto(config: InitBantoConfig): void {
	dataProvider = config.dataProvider;
	authProvider = withListViewStateClearing(config.authProvider, endSession);
	notifier = config.notifier ?? null;
	resources = config.resources;
}

export function getDataProvider(): DataProvider {
	if (!dataProvider) throw new Error(NOT_INITIALIZED_MESSAGE);
	return dataProvider;
}

/** Returns the `AuthProvider` passed to `initBanto`, wrapped (see its doc comment) - not the exact same object reference. */
export function getAuthProvider(): AuthProvider {
	if (!authProvider) throw new Error(NOT_INITIALIZED_MESSAGE);
	return authProvider;
}

export function getResource(name: string): ResourceDefinition {
	const found = resources.find((entry) => entry.name === name);
	if (!found) {
		throw new Error(`Unknown resource "${name}". Did you register it in initBanto({ resources })?`);
	}
	return found;
}

export function listResources(): ResourceDefinition[] {
	return resources;
}

/** No-op when no notifier was registered. */
export function notify(kind: NotificationKind, message: string): void {
	notifier?.notify(kind, message);
}
