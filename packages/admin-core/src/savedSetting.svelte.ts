/**
 * `createSavedSetting` (spec §12.1 UI settings, §3 headless composables;
 * shared-primitives-upstream-plan §3.4・§4.1・D8, Issue #437): keep a UI
 * setting's **current** value (what the user is editing) apart from its
 * **saved** value (the last value the provider confirmed), on top of an
 * existing {@link UiSettingsProvider}. The provider is not replaced.
 *
 * What it owns
 * - `current` / `saved` / `saving` / `error` / `dirty`, and the
 *   explicit-vs-immediate choice (`mode`).
 * - `saved` changes only after `provider.set` succeeds, and then to the
 *   snapshot that was **actually sent**. A failed save keeps `current` and
 *   the previous `saved`, and records `error` (cleared by the next success).
 * - Which old answers to drop: stale loads, and answers after `dispose()`
 *   (through {@link createRequestOwner}, keys `'load'` and `'save'`).
 *
 * Revisions (Issue #786): without `merge` this primitive writes
 * unconditionally (last write wins) and uses only the value of a read. A
 * `set` the provider answered as superseded (`{ revision: null,
 * superseded: true }` - another writer of the same key, through the same
 * provider, queued a later unconditional value) counts as saved, as it did
 * before the provider could tell the two apart. With `merge` it keeps the
 * revision of its last read / write and writes with `ifRevision`; a
 * `conflict` hands the stored value to `merge(server, current)` and the
 * merged value is written (again conditionally, from the revision the
 * conflict returned; at most {@link MAX_CONFLICT_ATTEMPTS} rounds).
 * When nothing was read yet the revision is `"0"` ("only while nothing is
 * stored"), so a first save over an existing value conflicts and is merged
 * instead of overwriting it.
 *
 * Re-sending (`retry`, opt-in: `retry: {}`): a send that failed *transiently* (by default: the
 * server never answered, `networkFailure`; see {@link SavedSettingRetry})
 * is sent again with a growing delay, up to a limit. Only the same snapshot
 * is re-sent (a `conflict` is never re-sent unmerged). The session is
 * captured when a send starts (`provider.sessionGuard()`): if it changed
 * during a wait, nothing is re-sent (`unauthorized`), so a value is never
 * written for another account. A `save()` made during a wait ends the
 * waiting send (it fails with its last error) and the follow-up sends the
 * latest value at once. In merge mode a re-sent write whose first copy had in
 * fact landed shows up as a `conflict` whose stored value is the one sent;
 * that counts as saved. Without `merge` a re-sent write is a plain repeat of
 * the same unconditional value.
 *
 * `onSettled` is called once per send (after its retries) so a result can
 * leave the runes (a toast, a log): see {@link SavedSettingSettled}.
 *
 * What the consumer owns: the wording of any notification (read `error` /
 * `save()`'s result), what the value applies to, the default value
 * (`fallback`), and how a raw string is validated (`parse`; corrupted or
 * unknown-version data is `undefined` / a throw, never an exception out of
 * `load()`).
 *
 * Concurrency contract (saves are **serialized and coalesced**)
 * - At most one `provider.set` is in flight. A `save()` (or an immediate-mode
 *   `set()`) during that send does not start a second one: it queues **one**
 *   follow-up save, and every `save()` call made meanwhile shares that
 *   follow-up's result (`Promise<boolean>`). So provider answers can never
 *   arrive out of order.
 * - The snapshot is taken when a send **starts** (for the queued follow-up:
 *   when the previous send settles), so a queued save carries the latest
 *   `current`. An edit made during a send is never marked saved; the setting
 *   stays `dirty` and the follow-up (if any) sends it.
 * - A failed send does not cancel the queued follow-up (it sends the latest
 *   value, which doubles as a retry).
 * - `save()` always sends, even when not `dirty` (it can overwrite a stored
 *   value that `load()` reported `'invalid'`). It never rejects: failure is
 *   `false` plus `error`.
 * - `save()` / `set()` in immediate mode, a save settling, and a newer
 *   `load()` all make an older in-flight `load()` stale (`'stale'`, its
 *   result is not applied): the stored value it read may predate the write.
 * - `dispose()` drops the queue (resolves `false`), ignores answers still in
 *   flight, and makes later `save()` / `load()` do nothing.
 *
 * Loading: `load()` never overwrites an edit made since it started. The
 * stored value (if usable) still becomes `saved` (so `dirty` is right), but
 * `current` is only replaced when untouched.
 *
 * Re-entrancy: callbacks (`provider.set`, `parse`, `serialize`, `fallback`)
 * may call back into the setting. State is committed before the provider is
 * called and again in one synchronous step after each callback returns, and
 * every re-check (`isCurrent()`, edit version) happens after the callbacks.
 *
 * Reactive state is bumped through one `$state` counter, read untracked, so
 * calling `set()` from an `$effect` cannot re-run that effect (conventions §8,
 * same pattern as `createRequestOwner`).
 */
import { untrack } from 'svelte';
import { isNetworkError, ProviderError } from './errors';
import {
	UI_SETTING_ABSENT_REVISION,
	uiSettingConflict,
	type UiSettingsProvider
} from './providers/uiSettings';
import { createRequestOwner } from './request.svelte';

/** `'explicit'` sends only on `save()`; `'immediate'` also sends after every `set()` (coalesced). */
export type SavedSettingMode = 'explicit' | 'immediate';

/**
 * Outcome of `load()`:
 * - `'loaded'`: a usable stored value (now `saved`; `current` too unless edited meanwhile)
 * - `'missing'`: nothing stored (`saved` undefined, `current` = `fallback()` unless edited)
 * - `'invalid'`: stored but `parse` refused it (corrupt / unknown version); same as `'missing'`
 * - `'failed'`: the provider failed (`error` is set; `current` and `saved` untouched)
 * - `'stale'`: a newer load / a save / `dispose()` made this answer obsolete; nothing applied
 */
export type SavedSettingLoad = 'loaded' | 'missing' | 'invalid' | 'failed' | 'stale';

/** The most `merge` rounds one send makes before it gives up with the `conflict`. */
export const MAX_CONFLICT_ATTEMPTS = 5;

/** What a send settled with (the argument of `onSettled`). */
export interface SavedSettingSettled<T> {
	/** The snapshot was saved. */
	ok: boolean;
	/**
	 * When `ok`: the value that is now stored (the merged value when `merge`
	 * changed it). Otherwise the snapshot that could not be saved. A copy the
	 * caller may keep.
	 */
	value: T;
	/** `null` when `ok`; otherwise the last failure. */
	error: unknown;
	/** How many times the provider was asked to write (1 = no re-send). */
	attempts: number;
}

/** Re-sending after a transient failure. */
export interface SavedSettingRetry {
	/** The most sends for one snapshot, the first included. Default 3. `1` = never re-send. */
	maxAttempts?: number;
	/** Wait before the first re-send, in ms; doubles each time. Default 500. */
	baseDelayMs?: number;
	/** Upper bound of a wait, in ms. Default 5000. */
	maxDelayMs?: number;
	/**
	 * Is this failure worth sending again? Default: {@link isNetworkError}
	 * (the server never answered: unreachable or timed out). A 4xx/5xx the
	 * server gave, a Tauri failure and `conflict` are not re-sent by default:
	 * the bundled Tauri provider cannot tell a transient failure from a
	 * lasting one, and a 5xx is not known to be harmless to repeat.
	 */
	isTransient?: (error: unknown) => boolean;
}

export interface SavedSettingOptions<T> {
	provider: UiSettingsProvider;
	key: string;
	/** Interpret a stored string. Return `undefined` (or throw) for corrupted / unknown-version data. */
	parse: (raw: string) => T | undefined;
	/** Value → string. Equal strings mean equal values (drives `dirty`). Must be deterministic. */
	serialize: (value: T) => string;
	/** The value when nothing usable is stored. Wording and defaults belong to the consumer. */
	fallback: () => T;
	/** Default `'explicit'`. */
	mode?: SavedSettingMode;
	/**
	 * Settle a `conflict`: `server` is the value stored now (parsed; a stored
	 * value `parse` refuses, or a deleted one, is not merged), `current` a copy
	 * of the snapshot being saved. Return the value to store. Giving `merge`
	 * turns on conditional writes (`ifRevision`); without it the write is
	 * unconditional and nothing can conflict. It may be called more than once
	 * per save (another writer may win again), so keep it pure. When the user
	 * has not edited since the send started, `current` becomes the merged value.
	 * Throwing fails the save with that error.
	 */
	merge?: (server: T, current: T) => T;
	/**
	 * Re-send after a transient failure (see {@link SavedSettingRetry}). Off
	 * unless given: `retry: {}` turns it on with the defaults. A re-sent
	 * unconditional write is a plain repeat of the old snapshot, so a caller
	 * chooses it knowing another writer's newer value may be overwritten
	 * (give `merge` to make the re-sent write conditional).
	 */
	retry?: SavedSettingRetry | false;
	/**
	 * Called after every send settles (saved or not, after its retries, after
	 * the state is updated). Not called once `dispose()` was called. A throw
	 * is swallowed.
	 */
	onSettled?: (result: SavedSettingSettled<T>) => void;
}

export interface SavedSetting<T> {
	/** The value being edited. */
	readonly current: T;
	/** The last value saved (or loaded) successfully; `undefined` while none. */
	readonly saved: T | undefined;
	/** A `provider.set` is in flight. */
	readonly saving: boolean;
	/** A `load()` is in flight. */
	readonly loading: boolean;
	/** Last provider failure (load or save); `null` after the next success. */
	readonly error: unknown;
	/** `serialize(current)` differs from the saved (or, with none, the default) value. */
	readonly dirty: boolean;
	/** Change `current`. In immediate mode this also queues a save. */
	set(value: T): void;
	load(): Promise<SavedSettingLoad>;
	/** Send a snapshot of `current` (see the concurrency contract). Resolves `true` iff that snapshot was saved. */
	save(): Promise<boolean>;
	/** `current` back to `saved` (or `fallback()` when nothing is saved). Does not save. */
	revert(): void;
	/** `current` to `fallback()`. Does not save (call `save()` to persist the standard value). */
	resetToDefault(): void;
	/** Drop pending work and ignore answers in flight. Call on unmount. */
	dispose(): void;
}

interface Deferred {
	promise: Promise<boolean>;
	resolve: (ok: boolean) => void;
}

function deferred(): Deferred {
	let resolve!: (ok: boolean) => void;
	const promise = new Promise<boolean>((r) => (resolve = r));
	return { promise, resolve };
}

class Impl<T> implements SavedSetting<T> {
	readonly #options: SavedSettingOptions<T>;
	readonly #owner = createRequestOwner();
	// Bumped on every observable change; getters read it, mutators never do.
	#rev = $state(0);

	#value: T;
	#raw: string;
	#saved: T | undefined = undefined;
	#hasSaved = false;
	/** Serialized baseline `dirty` compares against. */
	#baseRaw: string;
	#saving = false;
	#error: unknown = null;
	/** Bumped by user edits (not by load/save); lets `load()` tell "untouched". Not reactive. */
	#editVersion = 0;
	#inflight = false;
	#queued: Deferred | null = null;
	/** The session the queued follow-up was accepted under (`null` = none / no sessions). */
	#queuedGuard: (() => boolean) | null = null;
	/** Revision of the stored value as last read / written (merge mode). */
	#revision = UI_SETTING_ABSENT_REVISION;
	/** Session `#revision` was obtained in (`null` = the provider has no sessions). */
	#revisionGuard: (() => boolean) | null = null;
	/** Ends a retry wait early (a follow-up is queued, or disposed). */
	#wake: (() => void) | null = null;

	constructor(options: SavedSettingOptions<T>) {
		this.#options = options;
		const value = options.fallback();
		this.#value = value;
		this.#raw = options.serialize(value);
		this.#baseRaw = this.#raw;
	}

	#bump(): void {
		this.#rev = untrack(() => this.#rev) + 1;
	}

	get current(): T {
		void this.#rev;
		return this.#value;
	}
	get saved(): T | undefined {
		void this.#rev;
		return this.#saved;
	}
	get saving(): boolean {
		void this.#rev;
		return this.#saving;
	}
	get loading(): boolean {
		return this.#owner.busy('load');
	}
	get error(): unknown {
		void this.#rev;
		return this.#error;
	}
	get dirty(): boolean {
		void this.#rev;
		return this.#raw !== this.#baseRaw;
	}

	#edit(value: T, raw: string): void {
		this.#value = value;
		this.#raw = raw;
		this.#editVersion++;
		this.#bump();
	}

	set(value: T): void {
		const raw = this.#options.serialize(value);
		this.#edit(value, raw);
		if (this.#options.mode !== 'immediate') return;
		// Nothing to send when it equals what is saved and nothing is in flight.
		if (this.#hasSaved && raw === this.#baseRaw && !this.#inflight && !this.#queued) return;
		void this.save();
	}

	revert(): void {
		if (this.#hasSaved) {
			// current gets its own copy: editing it must not change `saved`.
			this.#edit(this.#independent(this.#baseRaw, this.#saved as T), this.#baseRaw);
			return;
		}
		const value = this.#options.fallback();
		this.#edit(value, this.#options.serialize(value));
	}

	resetToDefault(): void {
		const value = this.#options.fallback();
		this.#edit(value, this.#options.serialize(value));
	}

	save(): Promise<boolean> {
		if (this.#owner.disposed) return Promise.resolve(false);
		if (this.#inflight) {
			// The follow-up belongs to the session it was accepted under. A save
			// accepted under a newer session does not share its result: the older
			// callers are told `false` and the queue starts over for the new one.
			if (this.#queued && this.#queuedGuard && !this.#queuedGuard()) {
				this.#queued.resolve(false);
				this.#queued = null;
			}
			if (!this.#queued) {
				this.#queued = deferred();
				this.#queuedGuard = this.#options.provider.sessionGuard?.() ?? null;
			}
			this.#wake?.();
			return this.#queued.promise;
		}
		return this.#send(this.#options.provider.sessionGuard?.() ?? null);
	}

	/** A copy of the sent value that the caller cannot mutate: parse the sent text again. */
	#independent(raw: string, value: T): T {
		try {
			const copy = this.#options.parse(raw);
			return copy === undefined ? value : copy;
		} catch {
			return value;
		}
	}

	#wait(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				if (this.#wake === done) this.#wake = null;
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.#wake = done;
		});
	}

	#parseSafe(raw: string): T | undefined {
		try {
			return this.#options.parse(raw);
		} catch {
			return undefined;
		}
	}

	async #send(guard: (() => boolean) | null): Promise<boolean> {
		// Everything below up to the first `await` is synchronous: the snapshot
		// and the in-flight flag are fixed before the provider can re-enter.
		const options = this.#options;
		const provider = options.provider;
		const mergeFn = options.merge;
		const retry = options.retry ? options.retry : null;
		const maxAttempts = Math.max(1, Math.floor(retry?.maxAttempts ?? 3));
		const baseDelay = Math.max(0, retry?.baseDelayMs ?? 500);
		const maxDelay = Math.max(baseDelay, retry?.maxDelayMs ?? 5000);
		const isTransient = retry?.isTransient ?? isNetworkError;
		const editVersion = this.#editVersion;
		let target = { value: this.#value, raw: this.#raw };
		// The snapshot as the user edited it: every conflict is merged against this,
		// never against an earlier merge candidate (`target`).
		const original = target;
		const sentRaw = original.raw;
		this.#inflight = true;
		this.#saving = true;
		this.#owner.invalidate('load');
		const request = this.#owner.begin('save');
		this.#bump();
		// `guard` is the session this send was accepted under (see `save()`).
		if (mergeFn && this.#revisionGuard && !this.#revisionGuard()) {
			// The revision was read for another session ("0" is the same for every account).
			this.#revision = UI_SETTING_ABSENT_REVISION;
		}
		let ifRevision: string | undefined = mergeFn ? this.#revision : undefined;
		let ok = false;
		let failure: unknown = null;
		let attempts = 0;
		let transientFailures = 0;
		let conflicts = 0;
		let newRevision: string | null = null;
		let completed = false;
		try {
			for (;;) {
				attempts++;
				try {
					const answer = await provider.set(
						options.key,
						target.raw,
						ifRevision === undefined ? undefined : { ifRevision }
					);
					ok = true;
					newRevision = answer.revision;
					break;
				} catch (error) {
					failure = error;
					if (!request.isCurrent()) break;
					if (guard && !guard()) {
						// The answer belongs to a session that has ended: never hand it to the caller.
						failure = new ProviderError({ kind: 'unauthorized' });
						break;
					}
					const conflict = mergeFn ? uiSettingConflict(error) : null;
					if (mergeFn && conflict) {
						if (conflict.value === target.raw) {
							// An earlier copy of this very write had landed (its answer was lost).
							ok = true;
							newRevision = conflict.revision;
							break;
						}
						if (++conflicts >= MAX_CONFLICT_ATTEMPTS) break;
						let merged = target;
						if (conflict.value !== null) {
							const server = this.#parseSafe(conflict.value);
							if (server !== undefined) {
								try {
									const value = mergeFn(server, this.#independent(original.raw, original.value));
									merged = { value, raw: options.serialize(value) };
								} catch (mergeError) {
									failure = mergeError;
									break;
								}
							}
						}
						if (!request.isCurrent()) break;
						if (guard && !guard()) {
							failure = new ProviderError({ kind: 'unauthorized' });
							break;
						}
						target = merged;
						ifRevision = conflict.revision;
						if (merged.raw === conflict.value) {
							// Already what is stored: nothing to write.
							ok = true;
							newRevision = conflict.revision;
							break;
						}
						continue;
					}
					let transient = false;
					try {
						transient = retry !== null && isTransient(error);
					} catch {
						transient = false; // a throwing classifier means "not transient"
					}
					if (!transient || ++transientFailures >= maxAttempts) break;
					if (this.#queued === null) {
						await this.#wait(Math.min(maxDelay, baseDelay * 2 ** (transientFailures - 1)));
					}
					// A follow-up save carries the latest value and is the retry now.
					if (!request.isCurrent() || this.#queued !== null) break;
					if (guard && !guard()) {
						failure = new ProviderError({ kind: 'unauthorized' });
						break;
					}
					// No `await` between the check above and the next `provider.set`.
				}
			}
			completed = true;
			if (ok && guard && !guard()) {
				// Saved for a session that has since ended: its value is not this session's.
				ok = false;
				failure = new ProviderError({ kind: 'unauthorized' });
			}
			if (ok && request.isCurrent()) {
				// Expose what was actually sent, not the caller's object: a mutable
				// value may have been changed while the provider call was pending.
				// Every copy runs the consumer's parse, which may re-enter (set /
				// save / dispose): make all of them first, then check the request,
				// the session and the edit version right before writing state.
				const sent = this.#independent(target.raw, target.value);
				const mergedCurrent =
					target.raw !== sentRaw
						? { value: this.#independent(target.raw, target.value) }
						: undefined;
				if (!request.isCurrent()) {
					ok = false;
				} else if (guard && !guard()) {
					ok = false;
					failure = new ProviderError({ kind: 'unauthorized' });
					this.#error = failure;
				} else {
					this.#saved = sent;
					this.#hasSaved = true;
					this.#baseRaw = target.raw;
					if (mergedCurrent !== undefined && this.#editVersion === editVersion) {
						// A merge changed what was saved and the user has not edited since.
						this.#value = mergedCurrent.value;
						this.#raw = target.raw;
					}
					// The user edited during a send whose value `merge` changed: their
					// edit does not contain what the merge kept from the server, so the
					// revision stays the old one. The next save conflicts and goes
					// through `merge` instead of silently dropping that data.
					const unmergedEdit = target.raw !== sentRaw && this.#editVersion !== editVersion;
					if (mergeFn && newRevision !== null && !unmergedEdit) {
						this.#revision = newRevision;
						this.#revisionGuard = guard;
					}
					this.#error = null;
					failure = null;
				}
			} else {
				ok = false;
				if (request.isCurrent()) this.#error = failure;
			}
		} finally {
			request.finish();
			if (!completed) this.#inflight = false;
			this.#saving = false;
			this.#owner.invalidate('load');
			this.#bump();
		}
		// `#inflight` stays set while `onSettled` runs, so a `save()` / `set()`
		// it makes joins the queue like any other instead of starting a send
		// that would overlap the follow-up below.
		if (!this.#owner.disposed) this.#notify(ok, target, failure, attempts);
		const queued = this.#queued;
		const queuedGuard = this.#queuedGuard;
		this.#queued = null;
		this.#queuedGuard = null;
		this.#inflight = false;
		if (queued) {
			if (this.#owner.disposed) {
				queued.resolve(false);
			} else if (queuedGuard && !queuedGuard()) {
				// Accepted under another session: not sent (nothing is written for the new one).
				this.#error = new ProviderError({ kind: 'unauthorized' });
				this.#bump();
				queued.resolve(false);
			} else {
				void this.#send(queuedGuard).then(queued.resolve);
			}
		}
		return ok;
	}

	#notify(ok: boolean, target: { value: T; raw: string }, error: unknown, attempts: number): void {
		const onSettled = this.#options.onSettled;
		if (!onSettled) return;
		try {
			onSettled({ ok, value: this.#independent(target.raw, target.value), error, attempts });
		} catch {
			// A throwing observer must not break the queue.
		}
	}

	async load(): Promise<SavedSettingLoad> {
		if (this.#owner.disposed) return 'stale';
		// A read started while a save is in flight may return the value from
		// before that write and roll `current` back; the save's own result is
		// authoritative. (A save that starts during a load invalidates it.)
		if (this.#inflight) return 'stale';
		const request = this.#owner.begin('load');
		const editVersion = this.#editVersion;
		try {
			let stored: string | null;
			let revision = UI_SETTING_ABSENT_REVISION;
			const guard = this.#options.provider.sessionGuard?.() ?? null;
			try {
				const snapshot = await this.#options.provider.get(this.#options.key);
				stored = snapshot.value;
				revision = snapshot.revision;
			} catch (error) {
				if (!request.isCurrent()) return 'stale';
				if (guard && !guard()) return 'stale';
				this.#error = error;
				this.#bump();
				return 'failed';
			}
			if (!request.isCurrent()) return 'stale';
			if (guard && !guard()) return 'stale'; // read for a session that has ended

			let parsed: { value: T; raw: string; current: T } | undefined;
			if (stored !== null) {
				try {
					const value = this.#options.parse(stored);
					if (value !== undefined) {
						const text = this.#options.serialize(value);
						// current gets its own copy so editing it cannot change `saved`.
						parsed = { value, raw: text, current: this.#independent(text, value) };
					}
				} catch {
					parsed = undefined; // a throwing validator means "corrupted"
				}
			}
			let fallback: { value: T; raw: string } | undefined;
			if (!parsed) {
				const value = this.#options.fallback();
				fallback = { value, raw: this.#options.serialize(value) };
			}
			// Callbacks above may have re-entered (set / save / dispose): decide now.
			if (!request.isCurrent()) return 'stale';
			if (guard && !guard()) return 'stale';
			const untouched = this.#editVersion === editVersion;
			this.#error = null;
			this.#revision = revision;
			this.#revisionGuard = guard;
			if (parsed) {
				this.#saved = parsed.value;
				this.#hasSaved = true;
				this.#baseRaw = parsed.raw;
				if (untouched) {
					this.#value = parsed.current;
					this.#raw = parsed.raw;
				}
				this.#bump();
				return 'loaded';
			}
			const standard = fallback as { value: T; raw: string };
			this.#saved = undefined;
			this.#hasSaved = false;
			this.#baseRaw = standard.raw;
			if (untouched) {
				this.#value = standard.value;
				this.#raw = standard.raw;
			}
			this.#bump();
			return stored === null ? 'missing' : 'invalid';
		} finally {
			request.finish();
		}
	}

	dispose(): void {
		if (this.#owner.disposed) return;
		this.#owner.dispose();
		this.#wake?.();
		const queued = this.#queued;
		this.#queued = null;
		queued?.resolve(false);
		this.#bump();
	}
}

/** Create a saved setting on an existing provider (shared-primitives-upstream-plan §3.4). */
export function createSavedSetting<T>(options: SavedSettingOptions<T>): SavedSetting<T> {
	return new Impl(options);
}
