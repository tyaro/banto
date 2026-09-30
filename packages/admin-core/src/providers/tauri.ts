/**
 * `TauriDataProvider`/`TauriAuthProvider` (spec §3.2, §3.3, §10): map
 * `DataProvider`/`AuthProvider` calls onto Tauri `invoke()` using the
 * command naming convention `${resource}_list` / `_get` / `_create` /
 * `_update` / `_delete`, and `auth_login` / `auth_logout` / `auth_check` /
 * `auth_identity` / `auth_resolve` for auth.
 *
 * No dependency on `@tauri-apps/api` here — the app injects its own
 * `invoke` function, so this module (and its tests) work without a Tauri
 * runtime present. Errors thrown by a Tauri command arrive as the
 * serialized `ErrorBody` shape (`crates/banto-core/src/error.rs`'s
 * `ErrorBody`, `Serialize`d directly since Tauri rejects with whatever
 * value the command's `Err` carries); these are rethrown as
 * `ProviderError` so callers only ever deal with one error shape,
 * regardless of which `DataProvider` implementation is active.
 */
import type {
	AuthOperationResult,
	CredentialRevision,
	DataProvider,
	Identity,
	ResolvedAuth,
	SessionKind,
	StandardAuthProvider
} from '../provider';
import type { ListParams, ListResult } from '../types';
import { ProviderError, StaleAnswerError, type ErrorBody } from '../errors';

export interface TauriInvokeOptions {
	/** Injected so this module has no `@tauri-apps/api` dependency of its own. */
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'storage',
	'other'
]);

/** Type guard: does `value` look like a wire `ErrorBody` (spec §3.2/§10)? */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

/** Normalize anything a rejected `invoke()` might throw into a `ProviderError`. */
function toProviderError(err: unknown): ProviderError {
	if (err instanceof ProviderError) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

/**
 * `auth_setup`/`auth_change_password` reject with `BantoError::Validation`
 * (spec §8.2) when the backend rejects a field (short password, wrong
 * current password, ...); `setup`/`changePassword` below surface the FIRST
 * field error's message as a plain `{ success: false, error }` result
 * (rather than rethrowing) so the login/settings forms can show it without
 * a try/catch of their own - other error kinds still rethrow, since those
 * are unexpected failures, not "form said no".
 */
function firstValidationMessage(err: ProviderError): string {
	if (err.body.kind === 'validation' && err.body.field_errors.length > 0) {
		return err.body.field_errors[0].message;
	}
	return err.message;
}

function makeCaller(invoke: TauriInvokeOptions['invoke']) {
	return async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		try {
			return (await invoke(cmd, args)) as T;
		} catch (err) {
			throw toProviderError(err);
		}
	};
}

/**
 * Standard `DataProvider` for the Tauri webview (spec §3.2): commands
 * follow the `${resource}_list` / `_get` / `_create` / `_update` / `_delete`
 * naming convention. Tauri v2 auto-converts JS camelCase invoke args to
 * snake_case Rust parameter names, so arg keys here are chosen to match
 * both sides without any conversion needed (`params`, `id`, `values`).
 */
export function createTauriDataProvider(options: TauriInvokeOptions): DataProvider {
	const call = makeCaller(options.invoke);

	return {
		getList<T>(resource: string, params: ListParams): Promise<ListResult<T>> {
			return call<ListResult<T>>(`${resource}_list`, { params });
		},

		getOne<T>(resource: string, id: string | number): Promise<T> {
			return call<T>(`${resource}_get`, { id });
		},

		create<T>(resource: string, values: Record<string, unknown>): Promise<T> {
			return call<T>(`${resource}_create`, { values });
		},

		update<T>(resource: string, id: string | number, values: Record<string, unknown>): Promise<T> {
			return call<T>(`${resource}_update`, { id, values });
		},

		deleteOne(resource: string, id: string | number): Promise<void> {
			return call<void>(`${resource}_delete`, { id });
		}
	};
}

/** Options of `createTauriAuthProvider`. */
export interface TauriAuthProviderOptions extends TauriInvokeOptions {
	/**
	 * Issue #260 (design §5.3, S-78): how long a state-changing auth command
	 * (login/logout/setup/changePassword) may stay unanswered before the
	 * provider stops waiting for it - it then treats the outcome as unknown
	 * (advances the revision and notifies) and no longer reports `resolve()`
	 * answers as stale because of it. Default 10 000 ms.
	 */
	opPendingTimeoutMs?: number;
}

const DEFAULT_OP_PENDING_TIMEOUT_MS = 10_000;

/** Wire shape of `auth_login`/`auth_setup` (`LoginResult` in the Rust crate). */
interface LoginResultWire {
	success: boolean;
	error?: string | null;
	superseded?: boolean;
	seq?: number;
}

/** Wire shape of `auth_resolve` (`AuthResolveResult` in the Rust crate). */
interface AuthResolveWire {
	identity: Identity | null;
	kind: SessionKind | null;
	checked: number;
	current: number;
	stale: boolean;
}

/** `{ seq }` of `auth_logout`/`auth_change_password`; `null`/absent from an older backend. */
function seqOf(value: unknown): number | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const seq = (value as { seq?: unknown }).seq;
	return typeof seq === 'number' ? seq : undefined;
}

/**
 * Standard `AuthProvider` for the Tauri webview (spec §3.3), backed by the
 * `auth_login` / `auth_logout` / `auth_check` / `auth_identity` /
 * `auth_resolve` / `auth_status` / `auth_setup` / `auth_change_password`
 * commands (spec §8.2).
 *
 * Issue #260 (docs/session-controller-design.md §5.3, I-19/I-23): the
 * revision is the pair `(observedSeq, local)`, handed out as the opaque
 * `${observedSeq}.${local}`:
 * - `observedSeq` is the max Rust session-slot `seq` observed - from a
 *   state-changing command's response and from `auth_resolve`'s `current`.
 *   It never goes back, so a response that arrives out of order cannot
 *   rewind it;
 * - `local` advances only when a state-changing command's `invoke` rejected
 *   (no response: the slot may have changed) or stayed unanswered past
 *   `opPendingTimeoutMs`.
 * Listeners hear a change only when the pair changed (not for a logout
 * no-op or a superseded login that left `seq` where it was), and never from
 * `resolve()`. A `resolve()` answer that arrives while any state-changing
 * command is still pending - whether it started before or after the
 * `resolve()` - is rejected with `StaleAnswerError`, as is one the backend
 * reports stale.
 */
export function createTauriAuthProvider(options: TauriAuthProviderOptions): StandardAuthProvider {
	const call = makeCaller(options.invoke);
	const opPendingTimeoutMs = options.opPendingTimeoutMs ?? DEFAULT_OP_PENDING_TIMEOUT_MS;

	let observedSeq = 0;
	let local = 0;
	const listeners = new Set<() => void>();
	/** State-changing commands still awaiting their response (and not yet timed out). */
	const pendingOps = new Set<object>();

	function revision(seq = observedSeq, l = local): CredentialRevision {
		return `${seq}.${l}` as CredentialRevision;
	}

	function emitCredentialChanged(): void {
		for (const listener of [...listeners]) listener();
	}

	/** Record a `seq` from an operation's response; notify only if the pair changed. */
	function observe(seq: number | undefined): void {
		if (seq === undefined) return;
		const before = revision();
		observedSeq = Math.max(observedSeq, seq);
		if (revision() !== before) emitCredentialChanged();
	}

	function bumpLocal(): void {
		local += 1;
		emitCredentialChanged();
	}

	/**
	 * Invoke a state-changing command, tracking it as pending until it
	 * answers or `opPendingTimeoutMs` passes. A rejection that may have
	 * changed the session slot (`rejectionMayHaveChangedSlot`) advances
	 * `local` (the outcome is unknown); the error is rethrown either way.
	 * An op that already timed out has advanced `local` for that same
	 * unknown outcome, so its late rejection does not advance it again
	 * (PR #264 review P3); a late success is still `observe`d by the caller.
	 */
	async function runOp<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		const op = {};
		pendingOps.add(op);
		const timer = setTimeout(() => {
			if (pendingOps.delete(op)) bumpLocal();
		}, opPendingTimeoutMs);
		try {
			return (await options.invoke(cmd, args)) as T;
		} catch (raw) {
			const wasPending = pendingOps.delete(op);
			if (wasPending && rejectionMayHaveChangedSlot(raw)) bumpLocal();
			throw toProviderError(raw);
		} finally {
			clearTimeout(timer);
			pendingOps.delete(op);
		}
	}

	return {
		async login(params: Record<string, unknown>): Promise<AuthOperationResult> {
			const result = await runOp<LoginResultWire>('auth_login', params);
			observe(result.seq);
			return loginOutcome(result);
		},

		async logout(): Promise<void> {
			const result = await runOp<unknown>('auth_logout');
			observe(seqOf(result));
		},

		async check(): Promise<boolean> {
			return call<boolean>('auth_check');
		},

		async getIdentity(): Promise<Identity | null> {
			const identity = await call<Identity | null>('auth_identity');
			return identity ?? null;
		},

		/**
		 * Issue #260: `auth_resolve` once. Rejects with the `ProviderError` of a
		 * failed invoke (revision unchanged, I-19), or with `StaleAnswerError`
		 * when a state-changing command is pending as the answer arrives
		 * (S-75/S-82) or the backend reports the slot re-bound (S-77). The
		 * `invoke` cannot be aborted; `signal` is ignored.
		 */
		async resolve(): Promise<ResolvedAuth> {
			const l = local;
			const answer = await call<AuthResolveWire>('auth_resolve');
			if (pendingOps.size > 0 || answer.stale) throw new StaleAnswerError();
			// The advance (if this call cleared a revoked session) is carried
			// by `current`, not notified (S-65).
			observedSeq = Math.max(observedSeq, answer.current);
			const checked = revision(answer.checked, l);
			const current = revision(answer.current, l);
			if (!answer.identity) return { status: 'none', checked, current };
			return {
				status: 'active',
				checked,
				current,
				identity: answer.identity,
				...(answer.kind ? { kind: answer.kind } : {})
			};
		},

		credentialRevision(): CredentialRevision {
			return revision();
		},

		onCredentialChanged(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		async status(): Promise<{ initialized: boolean }> {
			return call<{ initialized: boolean }>('auth_status');
		},

		async setup(params: Record<string, unknown>): Promise<AuthOperationResult> {
			let result: LoginResultWire;
			try {
				result = await runOp<LoginResultWire>('auth_setup', params);
			} catch (err) {
				return { success: false, error: firstValidationMessage(toProviderError(err)) };
			}
			observe(result.seq);
			return loginOutcome(result);
		},

		async changePassword(
			current: string,
			next: string
		): Promise<{ success: boolean; error?: string }> {
			try {
				const result = await runOp<unknown>('auth_change_password', {
					currentPassword: current,
					newPassword: next
				});
				observe(seqOf(result));
				return { success: true };
			} catch (err) {
				return { success: false, error: firstValidationMessage(toProviderError(err)) };
			}
		}
	};
}

/**
 * Issue #260 (design I-19): may this rejection of a state-changing auth
 * command (login/logout/setup/change_password) have changed the Rust session
 * slot? Decided on the RAW rejection, before `toProviderError`:
 * - not a wire `ErrorBody` (an IPC failure, a string, an `Error`, anything
 *   unrecognizable): no response from the command - unknown, so yes;
 * - `{ kind: 'unauthorized' }`: yes. It is the one error kind the Rust side
 *   can return AFTER writing the slot - `change_own_password`'s session check
 *   clears a revoked session (advancing `seq`) and then fails `Unauthorized`
 *   (see the "Slot-clearing errors" line on each `*_body` /
 *   `change_own_password` in `apps/admin-template/src-tauri/src/lib.rs`);
 * - any other `ErrorBody` (`validation` - e.g. a wrong current password -,
 *   `forbidden`, `storage`, `other`, ...): the command answered and returned
 *   before writing the slot, so no.
 */
function rejectionMayHaveChangedSlot(raw: unknown): boolean {
	return !isErrorBody(raw) || raw.kind === 'unauthorized';
}

function loginOutcome(result: LoginResultWire): AuthOperationResult {
	const outcome: AuthOperationResult = { success: result.success };
	if (result.error != null) outcome.error = result.error;
	if (result.superseded) outcome.superseded = true;
	return outcome;
}
