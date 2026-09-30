/**
 * SessionController - the single writer of this tab's session state
 * (Issue #260, docs/session-controller-design.md, ADR-0016).
 *
 * Before #260 four places decided "who is signed in" (`sessionGate`,
 * `sessionLifecycle`, `sessionEnded`, the app's logout), each capturing a
 * scope before an `await` and re-checking it afterwards - and every review
 * round of #255 found one of them checking in one continuation and writing
 * in another. This module replaces them with ONE state machine:
 *
 * - `commit()` is the only function that writes `status`/`owner`/
 *   `generation`/`identity`/`kind` (I-1). `epoch` advances on every commit
 *   (freshness), `generation` only when `(status, owner, kind)` changes
 *   (I-2, design §3.1).
 * - `resolve()` asks the provider ONE question at a time (single-flight,
 *   I-9) and decides - in the continuation that received the answer, with
 *   no `await` in between - whether the answer may be applied (design §5.1
 *   step 4: not abandoned, same epoch, no newer signal, the answer's
 *   `checked` is the revision the probe started with and the provider's
 *   revision is now the answer's `current`). Failures go through the SAME
 *   check (I-3), so a stale 500 never marks a newer session as failed.
 *   A caller never gets a rejection (I-8): `confirmed` / `unverified` /
 *   `superseded`.
 * - A credential change reported by the provider (`onCredentialChanged`),
 *   or found by comparing the provider's revision with the one last applied
 *   (step 0, a defense against a provider that did not report it), moves an
 *   `active` session to `unknown` (the "hold", I-5) so the old owner is not
 *   used while the new one is being confirmed. `none`/`unknown`/adopted
 *   sessions only record that a background confirmation is needed
 *   (`pendingBackground`).
 * - An answer that can no longer be applied is aborted right away (I-22) and,
 *   if anyone still needs an answer (a waiting caller or `pendingBackground`,
 *   I-9), a NEW probe is started - bounded by `maxStaleRetries`, except for
 *   the one free "catch-up" retry described at `onProbeSettled` (design §10,
 *   decision (a) of 実装-2).
 * - `adopt()`/`end()` let an app's own policy (banto-hub's commissioning mode)
 *   confirm a synthetic session the provider cannot answer for, and end it -
 *   both only with a current `SessionTicket` (I-13, I-18, I-21).
 *
 * The controller knows nothing about SvelteKit (I-14): a `load` awaits
 * `resolveSettled()` and returns the generation it confirmed; the layout
 * compares that with `snapshot.generation` (design §6.1 wiring ①).
 *
 * This file is `.svelte.ts` so `snapshot` can be `$state.raw`: components
 * that read `controller.snapshot.generation` re-render when it changes.
 */
import { isStaleAnswerError } from './errors';
import { clearAllListViewState, purgeListViewStateNotOwnedBy } from './listViewState';
import type {
	AuthProvider,
	CredentialRevision,
	Identity,
	LegacyAuthProvider,
	ResolvedAuth,
	SessionKind,
	StandardAuthProvider
} from './provider';
import { adaptLegacyAuthProvider } from './providers/legacyAdapter';

export type { SessionKind } from './provider';

/** One frozen view of the session (I-12). Read it whole; never assemble it from separate stores. */
export interface SessionSnapshot {
	/** `unknown` = right after start-up, or a credential switch is being confirmed (the hold, I-5). */
	readonly status: 'unknown' | 'none' | 'active';
	/** `sessionOwnerKey(identity, kind)`; `null` unless active with an identity that has an id. */
	readonly owner: string | null;
	/** +1 only when `(status, owner, kind)` changes (I-2). Monotonic. */
	readonly generation: number;
	readonly identity: Identity | null;
	readonly kind: SessionKind | null;
	/**
	 * The owner that was active right before the current state: set from the
	 * previous state when it was `active`, reset to `null` by a commit to
	 * `none` (kept across `unknown` only). S-76.
	 */
	readonly previousActiveOwner: string | null;
	/**
	 * A change of user not yet handled by the app (#257 notice /
	 * `ownerChangePolicy`). Set when `active(B)` is committed while
	 * `previousActiveOwner` is neither `null` nor `B`; kept across `unknown`
	 * and a re-confirmation of the same user; cleared by a commit to `none`
	 * (S-83) and by `acknowledgeOwnerChange()`. I-24.
	 */
	readonly pendingOwnerChange: { readonly from: string | null; readonly to: string | null } | null;
	/**
	 * The latest verification outcome, kept apart from the confirmed state
	 * (principle 2). `'failed'` after an applied failure (a `500`, a
	 * timeout); `'idle'` after an applied answer. `'verifying'` is reserved:
	 * this implementation does not publish in-flight probes (a probe that is
	 * later discarded must leave `verification` untouched, S-56).
	 */
	readonly verification: {
		readonly state: 'idle' | 'verifying' | 'failed';
		readonly lastError: unknown | null;
	};
}

/** `{ generation, owner }` - the key saved per-owner state (`listViewState.ts`) is checked against. */
export type SessionScope = { readonly generation: number; readonly owner: string | null };

/**
 * What an asynchronous policy carries across its `await`s (I-18): the
 * controller's `epoch` and - unless an adopted session is live - the
 * provider's credential revision. Opaque; compare with `isCurrent()`.
 */
export type SessionTicket = { readonly epoch: number; readonly revision?: CredentialRevision };

export type ResolveResult =
	| { outcome: 'confirmed'; snapshot: SessionSnapshot; ticket: SessionTicket }
	| { outcome: 'unverified'; error: unknown; snapshot: SessionSnapshot }
	| { outcome: 'superseded'; snapshot: SessionSnapshot };

export interface SessionResolveOptions {
	/** `'signal'` advances the signal stamp: only a probe started after this call can answer it (I-9, S-58), and it starts the backoff loop (S-33). */
	cause?: 'navigation' | 'signal';
	/** This caller's own deadline (a waiter deadline, I-8): it gets `unverified` and leaves; the probe goes on. */
	timeoutMs?: number;
	/** Leave early (the caller no longer needs the answer). Same effect as `timeoutMs` expiring. */
	signal?: AbortSignal;
}

export interface SessionController {
	/** `$state.raw`-backed, frozen (I-12). */
	readonly snapshot: SessionSnapshot;
	/** Called synchronously after every snapshot change (only when something changed). Returns the unsubscribe function. */
	subscribe(listener: (snapshot: SessionSnapshot, previous: SessionSnapshot) => void): () => void;
	/** Confirm the session for this request. Never rejects (I-8). */
	resolve(options?: SessionResolveOptions): Promise<ResolveResult>;
	/** "The session may have ended" (an SSE `401`, a cleared token, ...): confirm it in the background with backoff (S-33). Synchronous. */
	signal(reason: string): void;
	/** The ticket for an asynchronous policy (I-18). Adopted sessions: epoch only (I-21). */
	ticket(): SessionTicket;
	isCurrent(ticket: SessionTicket | SessionScope): boolean;
	/** Confirm an app-synthesized session (commissioning). No-op `false` unless `ticket` is current (I-13, I-18). */
	adopt(identity: Identity, kind: SessionKind, ticket: SessionTicket): boolean;
	/** End an app-confirmed session (policy only - never after a logout, I-10). No-op `false` unless `ticket` is current. */
	end(reason: string, ticket: SessionTicket): boolean;
	/** Mark `snapshot.pendingOwnerChange` as handled. */
	acknowledgeOwnerChange(): void;
	/** `{ generation, owner }` for the saved-state API. */
	scope(): SessionScope;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface SessionControllerDeps {
	scheduler?: {
		setTimeout: (fn: () => void, ms: number) => TimerHandle;
		clearTimeout: (handle: TimerHandle) => void;
	};
	/** Monotonic stamps for ordering signals and probes. Default: an internal counter. */
	clock?: () => number;
	/** Probe deadline (default 10 s, the former `CONFIRM_TIMEOUT_MS`). */
	timeoutMs?: number;
	/** How many discarded answers one request tolerates before `unverified` with `SessionChangedError` (default 3). */
	maxStaleRetries?: number;
	/** Backoff of the background confirmation (default 1 s doubling to 30 s). */
	retry?: { initialMs: number; maxMs: number };
	/** Runs on every commit to `none` (I-6). Default: `clearAllListViewState`. */
	onNone?: () => void;
	/** Runs when an active session with an owner is committed. Default: drop saved state owned by anyone else. */
	onActive?: (owner: string) => void;
}

/** Thrown into `unverified` when the session kept changing under pending answers `maxStaleRetries` times. */
export class SessionChangedError extends Error {
	constructor() {
		super('The session changed repeatedly while its answer was pending.');
		this.name = 'SessionChangedError';
	}
}

/** A probe (`timeoutMs`) or a waiter (`resolveSettled`'s `deadlineMs`, `resolve`'s `timeoutMs`) ran out of time. */
export class SessionTimeoutError extends Error {
	constructor(message = 'The session could not be confirmed in time.') {
		super(message);
		this.name = 'SessionTimeoutError';
	}
}

/** `resolve()` before any `AuthProvider` was registered (`initBanto`). */
export class SessionProviderMissingError extends Error {
	constructor() {
		super('No AuthProvider is registered - call initBanto() first.');
		this.name = 'SessionProviderMissingError';
	}
}

export const DEFAULT_SESSION_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_STALE_RETRIES = 3;
export const DEFAULT_SESSION_RETRY = { initialMs: 1_000, maxMs: 30_000 } as const;

/**
 * Stable owner key for `identity` under `kind` (design §5.4, 統合修正 13):
 * the public viewer is `public-viewer`, the Tauri auth-disabled session is
 * `local` (never `account:0`), an adopted kind is `${kind}:${id}`, an
 * account is `account:${id}`. `null` when there is no identity or it has no
 * usable id (fail closed - unknown owners never match anything).
 */
export function sessionOwnerKey(
	identity: Identity | null | undefined,
	kind?: SessionKind | null
): string | null {
	if (!identity) return null;
	if (identity.publicViewer === true || kind === 'publicViewer') return 'public-viewer';
	if (kind === 'local') return 'local';
	const id: unknown = identity.id;
	if ((typeof id !== 'string' && typeof id !== 'number') || id === '') return null;
	if (kind && kind !== 'account') return `${kind}:${String(id)}`;
	return `account:${String(id)}`;
}

/**
 * The kind of a provider answer (design §10, decision (b) of 実装-2): the
 * issuer's `identity.publicViewer` marker wins (ADR-0012 - it is the only
 * reliable discriminator, and the HTTP provider does not send `kind`);
 * otherwise the provider's `kind` (Tauri: `'account' | 'local'`), and
 * `'account'` when the provider sent none (HTTP, the compatibility adapter).
 */
export function kindOfResolvedAuth(
	answer: Extract<ResolvedAuth, { status: 'active' }>
): SessionKind {
	if (answer.identity.publicViewer === true) return 'publicViewer';
	return answer.kind ?? 'account';
}

/** Field-by-field equality of two identities (a re-confirmation gets a new object each time). */
function sameIdentity(a: Identity | null, b: Identity | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (
			(a as unknown as Record<string, unknown>)[key] !==
			(b as unknown as Record<string, unknown>)[key]
		) {
			return false;
		}
	}
	return true;
}

function isStandard(provider: AuthProvider): provider is StandardAuthProvider {
	return (
		typeof provider.resolve === 'function' &&
		typeof provider.credentialRevision === 'function' &&
		typeof provider.onCredentialChanged === 'function'
	);
}

/** A provider with the three #260 methods as is; any other is wrapped in the compatibility adapter (統合修正 15). */
export function toStandardAuthProvider(provider: AuthProvider): StandardAuthProvider {
	if (isStandard(provider)) return provider;
	return adaptLegacyAuthProvider(provider as LegacyAuthProvider);
}

const EMPTY_VERIFICATION = Object.freeze({ state: 'idle' as const, lastError: null });

const INITIAL_SNAPSHOT: SessionSnapshot = Object.freeze({
	status: 'unknown',
	owner: null,
	generation: 0,
	identity: null,
	kind: null,
	previousActiveOwner: null,
	pendingOwnerChange: null,
	verification: EMPTY_VERIFICATION
});

interface Waiter {
	requestedAt: number;
	probe: Probe | null;
	timer: TimerHandle | null;
	cleanup: (() => void) | null;
	settle(result: ResolveResult): void;
}

interface Probe {
	provider: StandardAuthProvider;
	startedAt: number;
	epochAtStart: number;
	revisionAtStart: CredentialRevision;
	/** Timed out (`timeoutMs`, I-15). */
	abandoned: boolean;
	/** No longer adoptable: applied, discarded, abandoned or retired. Late answers only feed `pendingBackground`. */
	done: boolean;
	waiters: Set<Waiter>;
	abort: AbortController;
	timer: TimerHandle | null;
	/** Discards so far on behalf of these waiters (`maxStaleRetries`). */
	staleCount: number;
	/** The one free catch-up retry of this chain was used (§10 (a)). */
	catchUpUsed: boolean;
}

type ProbeOutcome = { ok: true; answer: ResolvedAuth } | { ok: false; error: unknown };

/** Internal operations the pre-#260 API delegates to (removed with it in v2.0.0). Not exported from the package. */
export interface SessionControllerInternals {
	readonly controller: SessionController;
	/** The raw provider currently bound (before adaptation), or `null`. */
	boundProvider(): AuthProvider | null;
	/** Bind `provider` (no-op for the same one). Treated as "not a credential change". */
	bind(provider: AuthProvider): void;
	/** `beginSession(identity)`: an external commit of `active`. */
	legacyBegin(identity: Identity | null): void;
	/** `endSession()`: an external commit of `none`. */
	legacyEnd(): void;
	/** `confirmSessionEnded`'s request: a signal-caused resolve that does not start the controller's own backoff loop (the legacy confirmation has its own). */
	legacyResolveSignal(): Promise<ResolveResult>;
	scheduler: Required<SessionControllerDeps>['scheduler'];
	defaultTimeoutMs: number;
}

const internalsByController = new WeakMap<SessionController, SessionControllerInternals>();

/** The internals behind `controller` (only controllers made by this module have them). */
export function controllerInternals(
	controller: SessionController
): SessionControllerInternals | undefined {
	return internalsByController.get(controller);
}

const DEFAULT_SCHEDULER = {
	// Resolved at call time so test fake timers installed later still apply.
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (handle: TimerHandle) => clearTimeout(handle)
};

function createCore(
	initialProvider: AuthProvider | null,
	deps: SessionControllerDeps = {}
): SessionControllerInternals {
	const scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
	let counter = 0;
	const clock = deps.clock ?? (() => ++counter);
	const timeoutMs = deps.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
	const maxStaleRetries = deps.maxStaleRetries ?? DEFAULT_MAX_STALE_RETRIES;
	const retry = deps.retry ?? DEFAULT_SESSION_RETRY;
	const onNone = deps.onNone ?? (() => clearAllListViewState());
	const onActive = deps.onActive ?? ((owner: string) => purgeListViewStateNotOwnedBy(owner));

	let rawProvider: AuthProvider | null = null;
	let provider: StandardAuthProvider | null = null;
	let unsubscribeProvider: (() => void) | null = null;

	let snap: SessionSnapshot = $state.raw(INITIAL_SNAPSHOT);
	let epoch = 0;
	/** The provider revision the confirmed state was last applied from (step 0, I-5). */
	let appliedRevision: CredentialRevision | undefined;
	/** The live session was confirmed by `adopt()` (I-13). */
	let adopted = false;
	/**
	 * The owner of the last committed active session WITH an owner (cleared by
	 * `none` and by a switch of provider). An ownerless active (S-10: an
	 * identity without an id) is not a change of user and does not move it,
	 * so `A -> ownerless -> B` raises `{ A -> B }` and `A -> ownerless -> A`
	 * raises nothing (owner review of #265 P2; design §6.1 lifetime table).
	 */
	let lastConcreteOwner: string | null = null;
	let inflight: Probe | null = null;
	let latestSignalAt = 0;
	/** A background confirmation is needed (I-9, decision 6). */
	let pendingBackground = false;
	let backgroundTimer: TimerHandle | null = null;
	let backgroundDelay = retry.initialMs;
	const listeners = new Set<(snapshot: SessionSnapshot, previous: SessionSnapshot) => void>();

	function stamp(): number {
		return clock();
	}

	function currentRevision(): CredentialRevision | undefined {
		return provider?.credentialRevision();
	}

	function sameVerification(
		a: SessionSnapshot['verification'],
		b: SessionSnapshot['verification']
	) {
		return a.state === b.state && a.lastError === b.lastError;
	}

	function sameOwnerChange(
		a: SessionSnapshot['pendingOwnerChange'],
		b: SessionSnapshot['pendingOwnerChange']
	): boolean {
		if (a === b) return true;
		if (!a || !b) return false;
		return a.from === b.from && a.to === b.to;
	}

	/** Publish `next` if anything differs from the current snapshot; notify listeners only then. */
	function publish(next: SessionSnapshot): void {
		const prev = snap;
		if (
			prev.status === next.status &&
			prev.owner === next.owner &&
			prev.generation === next.generation &&
			prev.identity === next.identity &&
			prev.kind === next.kind &&
			prev.previousActiveOwner === next.previousActiveOwner &&
			sameOwnerChange(prev.pendingOwnerChange, next.pendingOwnerChange) &&
			sameVerification(prev.verification, next.verification)
		) {
			return;
		}
		snap = Object.freeze({ ...next });
		for (const listener of [...listeners]) {
			try {
				listener(snap, prev);
			} catch {
				// One broken listener must not stop the others.
			}
		}
	}

	function setVerification(state: 'idle' | 'failed', lastError: unknown): void {
		publish({
			...snap,
			verification: state === 'idle' ? EMPTY_VERIFICATION : Object.freeze({ state, lastError })
		});
	}

	function superseded(): ResolveResult {
		return { outcome: 'superseded', snapshot: snap };
	}

	function unverified(error: unknown): ResolveResult {
		return { outcome: 'unverified', error, snapshot: snap };
	}

	function confirmed(): ResolveResult {
		return { outcome: 'confirmed', snapshot: snap, ticket: ticket() };
	}

	/**
	 * THE writer (I-1). Synchronous. `external` = a transition the pending
	 * requests did not ask for (a hold, `adopt`, `end`, the legacy
	 * begin/end): their waiters get `superseded` right here (I-20, S-14) and
	 * the in-flight probe is aborted (it can no longer be applied, I-22).
	 */
	function commit(
		next: {
			status: SessionSnapshot['status'];
			owner: string | null;
			identity: Identity | null;
			kind: SessionKind | null;
		},
		options: {
			external: boolean;
			verification?: SessionSnapshot['verification'];
			/** A switch of provider: owners of another authentication source are not compared (no history carried over). */
			forgetOwners?: boolean;
		}
	): void {
		epoch += 1;
		const prev = snap;
		const changed =
			prev.status !== next.status || prev.owner !== next.owner || prev.kind !== next.kind;
		const previousActiveOwner =
			next.status === 'none' || options.forgetOwners
				? null
				: prev.status === 'active'
					? prev.owner
					: prev.previousActiveOwner;
		let pendingOwnerChange = prev.pendingOwnerChange;
		if (next.status === 'none' || options.forgetOwners) {
			// S-83: not carried across the end of a session, nor across a switch
			// of provider (owners of different authentication sources).
			pendingOwnerChange = null;
			lastConcreteOwner = null;
		} else if (next.status === 'active' && next.owner !== null) {
			if (lastConcreteOwner !== null && lastConcreteOwner !== next.owner) {
				// Keep the first `from` while unhandled (design §6.1 lifetime table).
				// A -> B -> A before it is handled nets out to "no change of user":
				// the pending change is dropped (null), not reported as A -> A.
				const from = prev.pendingOwnerChange?.from ?? lastConcreteOwner;
				pendingOwnerChange = from === next.owner ? null : Object.freeze({ from, to: next.owner });
			}
			lastConcreteOwner = next.owner;
		}
		// `unknown` and an ownerless active keep both (S-10, S-81).
		const waiters = options.external && inflight ? retire(inflight) : [];
		publish({
			status: next.status,
			owner: next.owner,
			identity: next.identity,
			kind: next.kind,
			generation: prev.generation + (changed ? 1 : 0),
			previousActiveOwner,
			pendingOwnerChange,
			verification: options.verification ?? prev.verification
		});
		if (next.status === 'none') onNone();
		else if (next.status === 'active' && next.owner !== null) onActive(next.owner);
		for (const waiter of waiters) waiter.settle(superseded());
	}

	/** Stop `probe` from ever being applied (abort it, I-22) and hand back its waiters. */
	function retire(probe: Probe): Waiter[] {
		if (probe.done) return [];
		probe.done = true;
		if (probe.timer !== null) scheduler.clearTimeout(probe.timer);
		probe.timer = null;
		probe.abort.abort();
		if (inflight === probe) inflight = null;
		const waiters = [...probe.waiters];
		probe.waiters.clear();
		for (const waiter of waiters) waiter.probe = null;
		return waiters;
	}

	function isJoinable(probe: Probe): boolean {
		return (
			!probe.done &&
			!probe.abandoned &&
			probe.provider === provider &&
			probe.epochAtStart === epoch &&
			probe.startedAt > latestSignalAt &&
			probe.revisionAtStart === currentRevision()
		);
	}

	function startProbe(waiters: Waiter[], staleCount: number, catchUpUsed: boolean): void {
		if (!provider) {
			for (const waiter of waiters) waiter.settle(unverified(new SessionProviderMissingError()));
			return;
		}
		if (adopted) {
			for (const waiter of waiters) waiter.settle(confirmed());
			return;
		}
		const probe: Probe = {
			provider,
			startedAt: stamp(),
			epochAtStart: epoch,
			revisionAtStart: provider.credentialRevision(),
			abandoned: false,
			done: false,
			waiters: new Set(),
			abort: new AbortController(),
			timer: null,
			staleCount,
			catchUpUsed
		};
		for (const waiter of waiters) {
			waiter.probe = probe;
			probe.waiters.add(waiter);
		}
		inflight = probe;
		probe.timer = scheduler.setTimeout(() => onProbeTimeout(probe), timeoutMs);
		let answer: Promise<ResolvedAuth>;
		try {
			answer = provider.resolve({ signal: probe.abort.signal });
		} catch (error) {
			answer = Promise.reject(error);
		}
		answer.then(
			(value) => onProbeSettled(probe, { ok: true, answer: value }),
			(error: unknown) => onProbeSettled(probe, { ok: false, error })
		);
	}

	/**
	 * Hand `waiters` to a probe that can still answer them: the in-flight one
	 * when joinable, else a new one (retiring a stale in-flight probe and
	 * taking over its waiters). `staleCount` is checked against the limit.
	 */
	function reissue(waiters: Waiter[], staleCount: number, catchUpUsed: boolean): void {
		if (inflight && isJoinable(inflight)) {
			for (const waiter of waiters) {
				waiter.probe = inflight;
				inflight.waiters.add(waiter);
			}
			return;
		}
		let all = waiters;
		let count = staleCount;
		if (inflight) {
			count = Math.max(count, inflight.staleCount + 1);
			all = [...retire(inflight), ...waiters];
		}
		if (count > maxStaleRetries) {
			for (const waiter of all) waiter.settle(unverified(new SessionChangedError()));
			if (pendingBackground) scheduleBackground();
			return;
		}
		if (all.length === 0 && !pendingBackground) return;
		startProbe(all, count, catchUpUsed);
	}

	/** The hold (I-5): `active` -> `unknown`, and confirm what the credential is now. */
	function hold(): void {
		commit({ status: 'unknown', owner: null, identity: null, kind: null }, { external: true });
		pendingBackground = true;
		kickBackground();
	}

	/**
	 * Step 0 (and the same check after a discarded answer): the provider's
	 * revision moved away from the one last applied without a report. Active
	 * and not adopted: hold (returns `true`). Otherwise only
	 * `pendingBackground` (I-5, I-13, S-63, S-69).
	 */
	function detectDrift(): boolean {
		if (!provider) return false;
		if (provider.credentialRevision() === appliedRevision) return false;
		if (snap.status === 'active' && !adopted) {
			hold();
			return true;
		}
		pendingBackground = true;
		return false;
	}

	function onCredentialChanged(): void {
		if (snap.status === 'active' && !adopted) {
			hold();
			return;
		}
		pendingBackground = true;
		kickBackground();
	}

	/** Start the background confirmation now unless a joinable probe will serve it (or the session is adopted). */
	function kickBackground(): void {
		if (adopted || !provider || !pendingBackground) return;
		if (inflight && isJoinable(inflight)) return;
		replaceInflight([]);
	}

	/**
	 * Replace an in-flight probe that became unusable because of a NEW event
	 * (a signal, a credential change, `end()`, a request that cannot join)
	 * with a fresh probe, moving its waiters over. One counting rule for every
	 * such path (`kickBackground` and `resolve()` step 2 alike): the chain's
	 * `staleCount` and `catchUpUsed` are carried over unchanged - a new event
	 * is not a discarded answer, so it does not count against
	 * `maxStaleRetries`, and it does not grant another free catch-up (§10 (a)).
	 * Only a discarded ANSWER (`onProbeSettled`/`onProbeTimeout` -> `reissue`)
	 * adds 1.
	 */
	function replaceInflight(waiters: Waiter[]): void {
		if (backgroundTimer !== null) {
			scheduler.clearTimeout(backgroundTimer);
			backgroundTimer = null;
		}
		const old = inflight;
		const moved = old ? retire(old) : [];
		startProbe([...moved, ...waiters], old?.staleCount ?? 0, old?.catchUpUsed ?? false);
	}

	function scheduleBackground(): void {
		if (adopted || !pendingBackground || backgroundTimer !== null) return;
		const delay = backgroundDelay;
		backgroundDelay = Math.min(backgroundDelay * 2, retry.maxMs);
		backgroundTimer = scheduler.setTimeout(() => {
			backgroundTimer = null;
			kickBackground();
		}, delay);
	}

	function stopBackground(): void {
		pendingBackground = false;
		backgroundDelay = retry.initialMs;
		if (backgroundTimer !== null) scheduler.clearTimeout(backgroundTimer);
		backgroundTimer = null;
	}

	/**
	 * Step 5: apply an accepted answer.
	 *
	 * A pure re-confirmation - same `(status, owner, kind)`, an identity with
	 * the same fields, and the same revision as the one last applied - is NOT
	 * a commit: the epoch stays, so `SessionTicket`s taken for this state stay
	 * current (only `verification` may go back to `idle`). Found in the E2E
	 * logout flow of 実装-2: two concurrent loads (the logout's navigation and
	 * wiring ①'s `invalidateAll()`) each re-confirmed `none` while the other
	 * awaited `status()`, so each confirmation invalidated the other's ticket
	 * and both public-viewer policies ran out of retries (a livelock). The
	 * premise of a ticket - "the session is still what I decided on, for this
	 * credential" - is unchanged by such a re-confirmation (I-18).
	 */
	function applyAnswer(answer: ResolvedAuth): void {
		const kind = answer.status === 'active' ? kindOfResolvedAuth(answer) : null;
		const identity = answer.status === 'active' ? answer.identity : null;
		const owner = answer.status === 'active' ? sessionOwnerKey(answer.identity, kind) : null;
		if (
			snap.status === answer.status &&
			snap.owner === owner &&
			snap.kind === kind &&
			sameIdentity(snap.identity, identity) &&
			appliedRevision === answer.current
		) {
			setVerification('idle', null);
			return;
		}
		commit(
			{ status: answer.status, owner, identity, kind },
			{ external: false, verification: EMPTY_VERIFICATION }
		);
		appliedRevision = answer.current;
	}

	/**
	 * Steps 4-6: every settlement - fulfilment or rejection - goes through
	 * the same acceptance check, in this one continuation (I-3, I-18).
	 *
	 * §10 decision (a) of 実装-2 - a `seq` advance the provider had not
	 * observed (the Tauri webview reloaded, so `observedSeq` restarted at 0;
	 * or an ordinary data command cleared a revoked session in Rust): the
	 * answer's `checked` differs from `revisionAtStart`, so it is discarded as
	 * usual - but the provider has observed the answer's `seq` meanwhile, so
	 * its revision now equals the answer's `current`. That discard is the
	 * provider catching up, not the session changing under the request, so
	 * the next probe does NOT count against `maxStaleRetries` - once per
	 * chain (`catchUpUsed`), so a revision that keeps moving still ends in
	 * `SessionChangedError`. The answer itself is never applied (I-3, I-23
	 * unchanged), and the drift check below still holds an active session
	 * first (I-5), so a failure of the next probe cannot leave the old owner
	 * active.
	 */
	function onProbeSettled(probe: Probe, outcome: ProbeOutcome): void {
		if (probe.done) {
			// Already abandoned / retired. Its answer is never applied, but a
			// `none` that cleared the credential must still be confirmed (S-31).
			if (
				outcome.ok &&
				outcome.answer.current !== outcome.answer.checked &&
				probe.provider === provider
			) {
				pendingBackground = true;
				kickBackground();
			}
			return;
		}
		if (probe.timer !== null) scheduler.clearTimeout(probe.timer);
		probe.timer = null;
		const revisionNow = probe.provider.credentialRevision();
		const sameRound =
			probe.provider === provider &&
			probe.epochAtStart === epoch &&
			latestSignalAt <= probe.startedAt;
		const acceptable =
			sameRound &&
			(outcome.ok
				? outcome.answer.checked === probe.revisionAtStart && revisionNow === outcome.answer.current
				: !isStaleAnswerError(outcome.error) && revisionNow === probe.revisionAtStart);

		if (acceptable) {
			probe.done = true;
			if (inflight === probe) inflight = null;
			const waiters = [...probe.waiters];
			probe.waiters.clear();
			for (const waiter of waiters) waiter.probe = null;
			if (outcome.ok) {
				stopBackground();
				applyAnswer(outcome.answer);
				const result = confirmed();
				for (const waiter of waiters) waiter.settle(result);
			} else {
				// Step 6: only `verification` changes (I-4). No hold here.
				setVerification('failed', outcome.error);
				const result = unverified(outcome.error);
				for (const waiter of waiters) waiter.settle(result);
				if (pendingBackground) scheduleBackground();
			}
			return;
		}

		// Discard (I-3): no state, no `verification` (S-56).
		const catchUp =
			outcome.ok &&
			sameRound &&
			!probe.catchUpUsed &&
			outcome.answer.checked !== probe.revisionAtStart &&
			revisionNow === outcome.answer.current;
		const waiters = retire(probe);
		if (outcome.ok && outcome.answer.current !== outcome.answer.checked) pendingBackground = true;
		if (detectDrift()) {
			// The hold superseded the pending requests (an external transition).
			for (const waiter of waiters) waiter.settle(superseded());
			return;
		}
		if (probe.epochAtStart !== epoch) {
			// Only reachable for a probe retired late; its waiters were superseded at the commit.
			for (const waiter of waiters) waiter.settle(superseded());
			kickBackground();
			return;
		}
		reissue(
			waiters,
			catchUp ? probe.staleCount : probe.staleCount + 1,
			probe.catchUpUsed || catchUp
		);
	}

	/** Step 7: the probe deadline. The same acceptance check decides discard vs. failure. */
	function onProbeTimeout(probe: Probe): void {
		probe.timer = null;
		if (probe.done) return;
		probe.abandoned = true;
		const drifted =
			probe.provider !== provider || probe.revisionAtStart !== probe.provider.credentialRevision();
		const waiters = retire(probe);
		if (drifted) {
			if (detectDrift()) {
				for (const waiter of waiters) waiter.settle(superseded());
				return;
			}
			reissue(waiters, probe.staleCount + 1, probe.catchUpUsed);
			return;
		}
		const error = new SessionTimeoutError('The session provider did not answer in time.');
		setVerification('failed', error);
		for (const waiter of waiters) waiter.settle(unverified(error));
		if (pendingBackground) scheduleBackground();
	}

	function makeWaiter(resolveFn: (result: ResolveResult) => void, requestedAt: number): Waiter {
		let settled = false;
		const waiter: Waiter = {
			requestedAt,
			probe: null,
			timer: null,
			cleanup: null,
			settle(result) {
				if (settled) return;
				settled = true;
				if (waiter.timer !== null) scheduler.clearTimeout(waiter.timer);
				waiter.timer = null;
				waiter.cleanup?.();
				waiter.cleanup = null;
				waiter.probe?.waiters.delete(waiter);
				waiter.probe = null;
				resolveFn(result);
			}
		};
		return waiter;
	}

	/** A waiter's own deadline / abort: it leaves; the probe goes on unless nobody needs it (I-22). */
	function leave(waiter: Waiter, error: unknown): void {
		const probe = waiter.probe;
		waiter.settle(unverified(error));
		if (probe && !probe.done && probe.waiters.size === 0 && !pendingBackground) retire(probe);
	}

	function resolveInternal(
		options: SessionResolveOptions | undefined,
		background: boolean
	): Promise<ResolveResult> {
		return new Promise<ResolveResult>((resolveFn) => {
			// Step 0.
			detectDrift();
			// Step 1.
			const requestedAt = stamp();
			if (options?.cause === 'signal') {
				latestSignalAt = requestedAt;
				if (background) pendingBackground = true;
			}
			if (adopted) {
				resolveFn(confirmed());
				return;
			}
			if (!provider) {
				resolveFn(unverified(new SessionProviderMissingError()));
				return;
			}
			const waiter = makeWaiter(resolveFn, requestedAt);
			const signal = options?.signal;
			if (signal?.aborted) {
				waiter.settle(unverified(new SessionTimeoutError('The request was abandoned.')));
				return;
			}
			if (signal) {
				const onAbort = () => leave(waiter, new SessionTimeoutError('The request was abandoned.'));
				signal.addEventListener('abort', onAbort, { once: true });
				waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
			}
			if (options?.timeoutMs !== undefined) {
				waiter.timer = scheduler.setTimeout(() => {
					waiter.timer = null;
					leave(waiter, new SessionTimeoutError());
				}, options.timeoutMs);
			}
			// Step 2.
			if (inflight && isJoinable(inflight)) {
				waiter.probe = inflight;
				inflight.waiters.add(waiter);
				return;
			}
			// A signal (or a revision/epoch change) made the in-flight probe
			// unusable: abort it and move its waiters to the new probe.
			replaceInflight([waiter]);
		});
	}

	function ticket(): SessionTicket {
		if (adopted || !provider) return Object.freeze({ epoch });
		return Object.freeze({ epoch, revision: provider.credentialRevision() });
	}

	function isCurrent(value: SessionTicket | SessionScope): boolean {
		if ('epoch' in value) {
			if (value.epoch !== epoch) return false;
			return value.revision === undefined || value.revision === currentRevision();
		}
		return value.generation === snap.generation && value.owner === snap.owner;
	}

	const controller: SessionController = {
		get snapshot() {
			return snap;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		resolve(options) {
			return resolveInternal(options, true);
		},
		signal() {
			latestSignalAt = stamp();
			pendingBackground = true;
			if (adopted) return; // P3-10: stamp only; `end()` starts the probe.
			kickBackground();
		},
		ticket,
		isCurrent,
		adopt(identity, kind, t) {
			if (!isCurrent(t)) return false;
			adopted = true;
			commit(
				{ status: 'active', owner: sessionOwnerKey(identity, kind), identity, kind },
				{ external: true }
			);
			return true;
		},
		end(_reason, t) {
			if (!isCurrent(t)) return false;
			adopted = false;
			commit({ status: 'none', owner: null, identity: null, kind: null }, { external: true });
			kickBackground();
			return true;
		},
		acknowledgeOwnerChange() {
			if (snap.pendingOwnerChange === null) return;
			publish({ ...snap, pendingOwnerChange: null });
		},
		scope() {
			return Object.freeze({ generation: snap.generation, owner: snap.owner });
		}
	};

	/**
	 * Bind the provider the session is confirmed against.
	 * - The same provider again: no-op.
	 * - The first provider (none bound yet): not a transition - nothing was
	 *   confirmed against any provider (a legacy `beginSession` before
	 *   `initBanto` stays).
	 * - A DIFFERENT provider (owner review of #265 P1): an external transition.
	 *   The session confirmed against the old provider says nothing about the
	 *   new one: the in-flight probe is retired (its waiters get `superseded`,
	 *   I-20; a late answer from the old provider is never applied - it fails
	 *   the provider check), the old subscription is dropped, `commit(unknown)`
	 *   advances the epoch (old tickets go stale) and - from `active`/`none` -
	 *   the generation, and the new provider is asked (`pendingBackground`).
	 *   Owner history (`previousActiveOwner`/`pendingOwnerChange`) is not
	 *   carried over: owners of different authentication sources are not
	 *   compared.
	 */
	function bind(next: AuthProvider): void {
		if (next === rawProvider) return;
		const switching = rawProvider !== null;
		rawProvider = next;
		unsubscribeProvider?.();
		provider = toStandardAuthProvider(next);
		unsubscribeProvider = provider.onCredentialChanged(onCredentialChanged);
		appliedRevision = provider.credentialRevision();
		if (!switching) {
			if (inflight) {
				const moved = retire(inflight);
				if (moved.length > 0) startProbe(moved, 0, false);
			}
			return;
		}
		adopted = false;
		commit(
			{ status: 'unknown', owner: null, identity: null, kind: null },
			{ external: true, forgetOwners: true }
		);
		pendingBackground = true;
		kickBackground();
	}

	if (initialProvider) bind(initialProvider);

	const internals: SessionControllerInternals = {
		controller,
		boundProvider: () => rawProvider,
		bind,
		legacyBegin(identity) {
			adopted = false;
			const kind: SessionKind = identity?.publicViewer === true ? 'publicViewer' : 'account';
			commit(
				{
					status: 'active',
					owner: sessionOwnerKey(identity, kind),
					identity,
					kind: identity ? kind : null
				},
				{ external: true }
			);
			appliedRevision = currentRevision();
		},
		legacyEnd() {
			adopted = false;
			commit({ status: 'none', owner: null, identity: null, kind: null }, { external: true });
			kickBackground();
		},
		legacyResolveSignal() {
			return resolveInternal({ cause: 'signal' }, false);
		},
		scheduler,
		defaultTimeoutMs: timeoutMs
	};
	internalsByController.set(controller, internals);
	return internals;
}

/** A controller over `provider` (a provider without `resolve`/`credentialRevision`/`onCredentialChanged` is wrapped in `adaptLegacyAuthProvider`). */
export function createSessionController(
	provider: AuthProvider,
	deps?: SessionControllerDeps
): SessionController {
	return createCore(provider, deps).controller;
}

let defaultCore: SessionControllerInternals | null = null;

function ensureDefaultCore(): SessionControllerInternals {
	defaultCore ??= createCore(null);
	return defaultCore;
}

/** The app-wide controller `initBanto({ authProvider })` binds. Apps normally use this one. */
export function getSessionController(): SessionController {
	return ensureDefaultCore().controller;
}

/** Internal: bind the default controller to `provider` (`initBanto`, and the pre-#260 API that takes a provider). */
export function bindDefaultSessionProvider(provider: AuthProvider): SessionControllerInternals {
	const core = ensureDefaultCore();
	core.bind(provider);
	return core;
}

/** Internal: the default controller's internals (the pre-#260 API delegates here). */
export function defaultSessionInternals(): SessionControllerInternals {
	return ensureDefaultCore();
}

/** Test support (not exported from the package): start the next test with a fresh default controller. */
export function resetDefaultSessionController(): void {
	defaultCore = null;
}

/**
 * For a `load` (design §5.1, I-16): request again while `superseded`, and
 * return only `confirmed` or `unverified`. `deadlineMs` (default: the
 * controller's `timeoutMs`, 10 s) bounds the whole call; past it the caller
 * gets `unverified` with a `SessionTimeoutError` and leaves (the probe goes
 * on, I-8). The generation in a `confirmed` result is one this call actually
 * confirmed - never "whatever is current now".
 */
export async function resolveSettled(
	controller: SessionController,
	options?: { cause?: 'navigation' | 'signal'; deadlineMs?: number }
): Promise<Exclude<ResolveResult, { outcome: 'superseded' }>> {
	const internals = controllerInternals(controller);
	const scheduler = internals?.scheduler ?? DEFAULT_SCHEDULER;
	const deadlineMs =
		options?.deadlineMs ?? internals?.defaultTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
	const leave = new AbortController();
	let expired = false;
	const timer = scheduler.setTimeout(() => {
		expired = true;
		leave.abort();
	}, deadlineMs);
	try {
		let cause = options?.cause;
		for (;;) {
			const result = await controller.resolve({ cause, signal: leave.signal });
			// A re-request after `superseded` needs no new signal stamp: the
			// probe it gets started after the transition anyway.
			cause = 'navigation';
			if (result.outcome !== 'superseded') {
				if (result.outcome === 'unverified' && expired) {
					return {
						outcome: 'unverified',
						error: new SessionTimeoutError(),
						snapshot: result.snapshot
					};
				}
				return result;
			}
			if (expired) {
				return {
					outcome: 'unverified',
					error: new SessionTimeoutError(),
					snapshot: result.snapshot
				};
			}
		}
	} finally {
		scheduler.clearTimeout(timer);
	}
}

/** How many times `publicViewerFallback` re-runs its policy after a credential change (design §6.1). */
export const DEFAULT_PUBLIC_VIEWER_RETRIES = 3;

type EnterResult = { success: boolean; superseded?: boolean };

function normalizeEntered(value: unknown): EnterResult {
	if (typeof value === 'boolean') return { success: value };
	if (value && typeof value === 'object') {
		const v = value as { success?: unknown; superseded?: unknown };
		return { success: v.success === true, superseded: v.superseded === true };
	}
	return { success: false };
}

/** Internal: `publicViewerFallback` that also reports whether it gave up on its retry limit (the pre-#260 gate throws then). */
export async function runPublicViewerFallback(
	controller: SessionController,
	provider: Pick<AuthProvider, 'status' | 'enterPublicViewer'>,
	initialTicket: SessionTicket,
	maxRetries: number
): Promise<{ result: ResolveResult; exhausted: boolean }> {
	let ticket = initialTicket;
	for (let retries = 0; ; retries++) {
		let status: { initialized: boolean; viewerPublic?: boolean } | undefined;
		try {
			status = await provider.status?.();
		} catch {
			status = undefined; // A failed read only means "do not mint" (S-52/S-66).
		}
		let result: ResolveResult;
		if (!controller.isCurrent(ticket)) {
			// Synchronous check, no `await` until the confirmation below.
			result = await resolveSettled(controller);
		} else if (!status?.viewerPublic || !provider.enterPublicViewer) {
			return {
				result: { outcome: 'confirmed', snapshot: controller.snapshot, ticket },
				exhausted: false
			};
		} else {
			const entered = normalizeEntered(
				await provider.enterPublicViewer({ expectRevision: ticket.revision })
			);
			if (!entered.success && !entered.superseded && controller.isCurrent(ticket)) {
				// Minting failed (403 / network) and nothing changed since the
				// `none` was confirmed: that `none` still stands (no retry).
				return {
					result: { outcome: 'confirmed', snapshot: controller.snapshot, ticket },
					exhausted: false
				};
			}
			result = await resolveSettled(controller);
			if (!entered.superseded) return { result, exhausted: false };
		}
		// The credential changed after `ticket`. Re-run the policy only when
		// that change was confirmed to be `none` again (a revoked token that
		// appeared and was cleared); anything else is the answer.
		if (result.outcome !== 'confirmed' || result.snapshot.status !== 'none') {
			return { result, exhausted: false };
		}
		if (retries >= maxRetries) return { result, exhausted: true };
		ticket = result.ticket;
	}
}

/**
 * The public-viewer entry as an app policy outside the controller (design
 * §6.1, S-42/S-52/S-66): given the `ticket` of a confirmed `none`, mint a
 * public-viewer session when `status().viewerPublic` is on - bound to that
 * ticket (`expectRevision`) - and confirm the result. Returns a
 * `ResolveResult`: callers handle `unverified` first (503), and only a
 * confirmed `none` goes to /login. Re-runs itself (up to `maxRetries`,
 * default `DEFAULT_PUBLIC_VIEWER_RETRIES`) when the credential changed after
 * the ticket and was confirmed `none` again.
 */
export async function publicViewerFallback(
	controller: SessionController,
	provider: Pick<AuthProvider, 'status' | 'enterPublicViewer'>,
	ticket: SessionTicket,
	options?: { maxRetries?: number }
): Promise<ResolveResult> {
	const { result } = await runPublicViewerFallback(
		controller,
		provider,
		ticket,
		options?.maxRetries ?? DEFAULT_PUBLIC_VIEWER_RETRIES
	);
	return result;
}
