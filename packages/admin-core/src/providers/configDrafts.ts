/**
 * `ConfigDraftsProvider` (Issue #938, docs/design/config-draft-publish-design.md
 * §4.11 and §5): a thin client of the "draft -> publish -> revert" config API.
 * It maps the REST routes (`/api/config/*`) and the Tauri commands
 * (`config_*`) one-to-one and keeps NO state: no cache, no lock timer, no
 * queue. A screen decides when to extend a lock, when to read again (the
 * `resource_changed` event of `config:<target>`) and what to do with a
 * conflict.
 *
 * - `createHttpConfigDrafts()`  - REST. Same CSRF header + bearer-token
 *   conventions as `providers/http.ts` / `uiSettings.ts`. Needs the app to
 *   mount `banto_server::routes::config_drafts_router`.
 * - `createTauriConfigDrafts()` - the `config_*` Tauri commands (injected
 *   `invoke`, no `@tauri-apps/api` dependency). The commands are wired by the
 *   app (the template does it in step S4), so this works only in an app that
 *   registered them.
 *
 * Wire names are camelCase. A value is any JSON object (`unknown` here: the
 * app knows the shape of its own target). Every revision is an opaque string:
 * hand it back as `if...`, never compute with it.
 *
 * Errors are `ProviderError` like every other provider. A conflict is a
 * `conflict` whose `current.reason` tells what happened: read it with
 * {@link configDraftConflict}. A save that fails the target's validation is NOT
 * an error: it answers `validation` (empty = publishable) in the result.
 */
import { ProviderError, type ErrorBody, type FieldError } from '../errors';

/** The revision of "no draft" (what `draftDiscard` answers, and the `ifRevision` of a first save). */
export const CONFIG_DRAFT_ABSENT_REVISION = '0';

/** What the editing lock shows other people. A conflict's `current.lock` carries only this (never a lease). */
export interface ConfigLockInfo {
	holderName: string;
	acquiredAtMs: number;
	expiresAtMs: number;
}

/**
 * A lock as `lockAcquire` / `lockExtend` answer, and as `get` / `list` show it (also another person's valid lock).
 * `lease` names ONE acquire: send it back to `lockExtend` / `lockRelease` (your own lock), or as `unlock`'s
 * `ifLease` (the lock the screen saw). It is neither a permission nor a proof of the holder: the server checks both
 * separately.
 */
export interface ConfigLock extends ConfigLockInfo {
	lease: string;
}

export interface ConfigPublished {
	value: unknown;
	version: number;
	revision: string;
	publishedAt: string;
}

export interface ConfigDraft {
	value: unknown;
	/** The published version the draft was started from. */
	baseVersion: number;
	revision: string;
	updatedBy: string;
	updatedAt: string;
}

/** `get(target)`: published, draft and lock from one read. `lock` is the valid lock of anybody, with its lease (`lockIsMine`: yours). */
export interface ConfigState {
	target: string;
	published: ConfigPublished;
	draft: ConfigDraft | null;
	lock: ConfigLock | null;
	lockIsMine: boolean;
}

/** One row of `list()`: no values. `lock` is the valid lock with its lease (what `unlock` needs). */
export interface ConfigTargetSummary {
	target: string;
	version: number;
	revision: string;
	publishedAt: string;
	draft: { baseVersion: number; revision: string; updatedBy: string; updatedAt: string } | null;
	lock: ConfigLock | null;
}

/**
 * `changes` is the same shape as the audit log's (JSON Pointer `field`,
 * `before` / `after`, `masked` for secrets), so a template app can hand it to
 * `AuditChanges.svelte`.
 */
export type ConfigChange = Record<string, unknown>;

/**
 * `diff(target)`: published -> draft (`draftRevision`, `baseVersion` set).
 * `diff(target, { toVersion })`: published -> that version (`toVersion` set).
 * The revisions are the ones the compared values had: pass them back as
 * `ifPublishedRevision` / `ifDraftRevision` to act on exactly what was seen.
 */
export interface ConfigDiff {
	target: string;
	publishedVersion: number;
	publishedRevision: string;
	draftRevision?: string;
	baseVersion?: number;
	toVersion?: number;
	changes: ConfigChange[];
}

export type ConfigHistoryKind = 'initial' | 'publish' | 'revert';

/** One history row (no value). Newest first in `historyList`. */
export interface ConfigHistoryEntry {
	version: number;
	kind: ConfigHistoryKind;
	revertedTo: number | null;
	actorUsername: string | null;
	actorId: number | null;
	actorKind: string | null;
	origin: string | null;
	comment: string | null;
	publishedAt: string;
}

export interface ConfigHistoryDetail extends ConfigHistoryEntry {
	value: unknown;
	previousValue: unknown;
	changes: ConfigChange[];
}

/** The answer of `draftPut` / `draftRebase`. `validation` empty = the draft can be published. */
export interface ConfigDraftSaved {
	revision: string;
	baseVersion: number;
	validation: FieldError[];
	lock: ConfigLock;
}

/** The answer of `draftDiscard`: `revision` is always `"0"`. */
export interface ConfigDraftDiscarded {
	revision: string;
}

/** The answer of `publish` / `revert`. */
export interface ConfigPublishOutcome {
	target: string;
	kind: ConfigHistoryKind;
	version: number;
	previousVersion: number;
	revision: string;
	publishedAt: string;
	revertedTo?: number;
	comment?: string;
	changes: ConfigChange[];
}

export interface ConfigDiffOptions {
	/** Compare the published value with this version instead of with the draft (what a revert would change). */
	toVersion?: number;
}

export interface ConfigHistoryListOptions {
	/** Only versions below this one: pass the last row's `version` for the next page. */
	before?: number;
	/** Page size (server default 50, at most 100). */
	limit?: number;
}

export interface ConfigDraftPutInput {
	value: unknown;
	/** The draft revision the editor has; `"0"` ({@link CONFIG_DRAFT_ABSENT_REVISION}) when there is none yet. */
	ifRevision: string;
	/** The published revision the editor saw. Required for the first save. */
	ifPublishedRevision?: string;
}

export interface ConfigDraftRebaseInput {
	ifRevision: string;
	ifPublishedRevision: string;
}

export interface ConfigPublishInput {
	/** The draft revision the screen showed. */
	ifDraftRevision: string;
	comment?: string;
}

export interface ConfigRevertInput {
	toVersion: number;
	/** The published revision the screen showed. */
	ifPublishedRevision: string;
	comment?: string;
}

export interface ConfigDraftsProvider {
	list(): Promise<ConfigTargetSummary[]>;
	get(target: string): Promise<ConfigState>;
	diff(target: string, options?: ConfigDiffOptions): Promise<ConfigDiff>;
	historyList(target: string, options?: ConfigHistoryListOptions): Promise<ConfigHistoryEntry[]>;
	historyGet(target: string, version: number): Promise<ConfigHistoryDetail>;
	/** Take the editing lock. `conflict` (`lock_held`) when somebody else has it. */
	lockAcquire(target: string): Promise<ConfigLock>;
	/** Extend your own lock. After it expired this is a `conflict` (`lock_required`): acquire again, do not retry. */
	lockExtend(target: string, lease: string): Promise<ConfigLock>;
	/** Give your lock back. Resolves also when nothing was removed (an old lease). */
	lockRelease(target: string, lease: string): Promise<void>;
	draftPut(target: string, input: ConfigDraftPutInput): Promise<ConfigDraftSaved>;
	draftRebase(target: string, input: ConfigDraftRebaseInput): Promise<ConfigDraftSaved>;
	draftDiscard(target: string, ifRevision: string): Promise<ConfigDraftDiscarded>;
	publish(target: string, input: ConfigPublishInput): Promise<ConfigPublishOutcome>;
	revert(target: string, input: ConfigRevertInput): Promise<ConfigPublishOutcome>;
	/** Remove the lock the screen showed (`ifLease`), whoever holds it. The draft stays. */
	unlock(target: string, ifLease: string): Promise<void>;
}

// --- conflict reasons --------------------------------------------------------

/** The published version and revision (never the value) a conflict reports. */
export interface ConfigPublishedStamp {
	version: number;
	revision: string;
}

/**
 * Why a write was refused with `conflict` (`current.reason`), with what the
 * server reports as the state now. What a screen does:
 * - `stale_base`: the draft was started from an older published version ->
 *   show `diff`, then `draftRebase`.
 * - `draft_changed`: somebody saved in between -> read again (`draft` is the
 *   draft as it is now, `null` when it is gone, e.g. already published).
 * - `published_changed`: the published value moved on -> read again.
 * - `lock_held`: somebody else is editing -> show `lock.holderName`.
 * - `lock_required`: you do not hold the lock (it expired) -> acquire again.
 */
export type ConfigDraftConflict =
	| { reason: 'stale_base'; baseVersion: number; published: ConfigPublishedStamp }
	| { reason: 'draft_changed'; revision: string; draft: ConfigDraft | null }
	| { reason: 'published_changed'; published: ConfigPublishedStamp }
	| { reason: 'lock_held'; lock: ConfigLockInfo | null }
	| { reason: 'lock_required'; lock: ConfigLockInfo | null };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStamp(value: unknown): ConfigPublishedStamp | null {
	if (!isObject(value)) return null;
	const { version, revision } = value;
	return typeof version === 'number' && typeof revision === 'string' ? { version, revision } : null;
}

function asLockInfo(value: unknown): ConfigLockInfo | null | undefined {
	if (value === null) return null;
	if (!isObject(value)) return undefined;
	const { holderName, acquiredAtMs, expiresAtMs } = value;
	if (
		typeof holderName !== 'string' ||
		typeof acquiredAtMs !== 'number' ||
		typeof expiresAtMs !== 'number'
	) {
		return undefined;
	}
	return { holderName, acquiredAtMs, expiresAtMs };
}

/**
 * Tell why a config write failed: when `error` is a `conflict` of this API
 * (`current.reason` one of the five), returns the reason and the state the
 * server reported, otherwise `null` (not a conflict, or a conflict of
 * something else).
 */
export function configDraftConflict(error: unknown): ConfigDraftConflict | null {
	if (!(error instanceof ProviderError) || error.body.kind !== 'conflict') return null;
	const current = error.body.current;
	if (!isObject(current)) return null;
	switch (current.reason) {
		case 'stale_base': {
			const published = asStamp(current.published);
			if (typeof current.baseVersion !== 'number' || !published) return null;
			return { reason: 'stale_base', baseVersion: current.baseVersion, published };
		}
		case 'draft_changed': {
			if (typeof current.revision !== 'string') return null;
			const draft = current.draft;
			if (draft !== null && !isObject(draft)) return null;
			return {
				reason: 'draft_changed',
				revision: current.revision,
				draft: draft as ConfigDraft | null
			};
		}
		case 'published_changed': {
			const published = asStamp(current.published);
			return published ? { reason: 'published_changed', published } : null;
		}
		case 'lock_held':
		case 'lock_required': {
			const lock = asLockInfo(current.lock);
			return lock === undefined ? null : { reason: current.reason, lock };
		}
		default:
			return null;
	}
}

// --- shared helpers ----------------------------------------------------------

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'conflict',
	'storage',
	'other'
]);
const UNEXPECTED_RESPONSE_MESSAGE = 'unexpected config response';
const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

function toProviderError(err: unknown): ProviderError {
	if (err instanceof ProviderError) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

function unexpected(): ProviderError {
	return new ProviderError({ kind: 'other', message: UNEXPECTED_RESPONSE_MESSAGE });
}

/** A target is a non-empty string; the server decides which ones exist (`not_found`). */
function assertTarget(target: string): void {
	if (typeof target !== 'string' || target === '') {
		throw new ProviderError({ kind: 'other', message: 'invalid config target' });
	}
}

function object<T>(body: unknown): T {
	if (isObject(body)) return body as T;
	throw unexpected();
}

function array<T>(body: unknown): T[] {
	if (Array.isArray(body)) return body as T[];
	throw unexpected();
}

type QueryParams = Record<string, string | number | undefined>;

/** The given params only (a query string for REST, extra arguments for Tauri). */
function definedOnly(params: QueryParams | undefined): Record<string, string | number> {
	const result: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function queryString(params: QueryParams | undefined): string {
	const parts = Object.entries(definedOnly(params)).map(
		([key, value]) => `${key}=${encodeURIComponent(String(value))}`
	);
	return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * One call both transports make, written once. REST uses `method`, `path`,
 * `body` (POST / PUT only) and `params` (the query); Tauri uses `command`
 * with `target` + `body` + `params` as its arguments (§4.11).
 */
interface Call {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	path: string;
	command: string;
	/** The route's JSON body (also arguments of the Tauri command). */
	body?: Record<string, unknown>;
	/** The query (REST) / extra arguments (Tauri): `toVersion`, `before`, `limit`, `lease`, `ifRevision`. */
	params?: QueryParams;
	/** The Tauri command's `target` / `version` arguments (in the path for REST). */
	args?: Record<string, unknown>;
	/** `true` when the REST answer is a 204 without a body. */
	empty?: boolean;
}

function build(send: (call: Call) => Promise<unknown>): ConfigDraftsProvider {
	const base = (target: string): string => {
		assertTarget(target);
		return `/api/config/${encodeURIComponent(target)}`;
	};
	return {
		async list() {
			return array(await send({ method: 'GET', path: '/api/config', command: 'config_list' }));
		},
		async get(target) {
			return object(
				await send({
					method: 'GET',
					path: base(target),
					command: 'config_get',
					args: { target }
				})
			);
		},
		async diff(target, options) {
			return object(
				await send({
					method: 'GET',
					path: `${base(target)}/diff`,
					command: 'config_diff',
					args: { target },
					params: { toVersion: options?.toVersion }
				})
			);
		},
		async historyList(target, options) {
			return array(
				await send({
					method: 'GET',
					path: `${base(target)}/history`,
					command: 'config_history_list',
					args: { target },
					params: { before: options?.before, limit: options?.limit }
				})
			);
		},
		async historyGet(target, version) {
			return object(
				await send({
					method: 'GET',
					path: `${base(target)}/history/${encodeURIComponent(String(version))}`,
					command: 'config_history_get',
					args: { target, version }
				})
			);
		},
		async lockAcquire(target) {
			return object(
				await send({
					method: 'POST',
					path: `${base(target)}/lock`,
					command: 'config_lock_acquire',
					args: { target }
				})
			);
		},
		async lockExtend(target, lease) {
			return object(
				await send({
					method: 'PUT',
					path: `${base(target)}/lock`,
					command: 'config_lock_extend',
					args: { target },
					body: { lease }
				})
			);
		},
		async lockRelease(target, lease) {
			await send({
				method: 'DELETE',
				path: `${base(target)}/lock`,
				command: 'config_lock_release',
				args: { target },
				params: { lease },
				empty: true
			});
		},
		async draftPut(target, input) {
			const { value, ifRevision, ifPublishedRevision } = input;
			return object(
				await send({
					method: 'PUT',
					path: `${base(target)}/draft`,
					command: 'config_draft_put',
					args: { target },
					body: {
						value,
						ifRevision,
						...(ifPublishedRevision === undefined ? {} : { ifPublishedRevision })
					}
				})
			);
		},
		async draftRebase(target, input) {
			return object(
				await send({
					method: 'POST',
					path: `${base(target)}/draft/rebase`,
					command: 'config_draft_rebase',
					args: { target },
					body: {
						ifRevision: input.ifRevision,
						ifPublishedRevision: input.ifPublishedRevision
					}
				})
			);
		},
		async draftDiscard(target, ifRevision) {
			return object(
				await send({
					method: 'DELETE',
					path: `${base(target)}/draft`,
					command: 'config_draft_discard',
					args: { target },
					params: { ifRevision }
				})
			);
		},
		async publish(target, input) {
			return object(
				await send({
					method: 'POST',
					path: `${base(target)}/publish`,
					command: 'config_publish',
					args: { target },
					body: {
						ifDraftRevision: input.ifDraftRevision,
						...(input.comment === undefined ? {} : { comment: input.comment })
					}
				})
			);
		},
		async revert(target, input) {
			return object(
				await send({
					method: 'POST',
					path: `${base(target)}/revert`,
					command: 'config_revert',
					args: { target },
					body: {
						toVersion: input.toVersion,
						ifPublishedRevision: input.ifPublishedRevision,
						...(input.comment === undefined ? {} : { comment: input.comment })
					}
				})
			);
		},
		async unlock(target, ifLease) {
			await send({
				method: 'POST',
				path: `${base(target)}/unlock`,
				command: 'config_unlock',
				args: { target },
				body: { ifLease },
				empty: true
			});
		}
	};
}

// --- Tauri invoke ------------------------------------------------------------

export interface TauriConfigDraftsOptions {
	/** Injected so this module has no `@tauri-apps/api` dependency of its own (same as `TauriInvokeOptions`). */
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * `ConfigDraftsProvider` over the `config_*` Tauri commands (design §4.11).
 * The arguments are `target` plus the REST body / query fields (camelCase).
 * The commands exist only in an app that wired them (the template: step S4
 * of #938); without them every call rejects.
 */
export function createTauriConfigDrafts(options: TauriConfigDraftsOptions): ConfigDraftsProvider {
	return build(async (call) => {
		const args = { ...call.args, ...call.body, ...definedOnly(call.params) };
		try {
			return await options.invoke(call.command, args);
		} catch (err) {
			throw toProviderError(err);
		}
	});
}

// --- REST (embedded server) --------------------------------------------------

const CLIENT_HEADER_NAME = 'X-Banto-Client';
const CLIENT_HEADER_VALUE = 'banto';

export interface HttpConfigDraftsOptions {
	/** Prefixed to every request path, e.g. `http://192.168.1.5:8721`. Defaults to `''` (same-origin). */
	baseUrl?: string;
	/** Shares the bearer token with whichever `AuthProvider` logged in (typically `createHttpAuthProvider`'s `getToken`). */
	getToken: () => string | null;
	fetchFn?: typeof fetch;
}

/**
 * `ConfigDraftsProvider` over `/api/config/*` (design §4.11): the same CSRF
 * header (`X-Banto-Client: banto`) and `Authorization: Bearer` conventions as
 * `createHttpUiSettings`. A `fetch` that never got an answer is a
 * `ProviderError` with `networkFailure: 'network'` (`isNetworkError`); for a
 * write it may or may not have been applied. Nothing is queued or retried.
 * The DELETE routes take their condition from the query string (`?lease=`,
 * `?ifRevision=`), and the lock release / unlock answer 204.
 */
export function createHttpConfigDrafts(options: HttpConfigDraftsOptions): ConfigDraftsProvider {
	const baseUrl = options.baseUrl ?? '';
	const fetchFn = options.fetchFn ?? fetch;

	function headers(hasBody: boolean): Record<string, string> {
		const result: Record<string, string> = { [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE };
		if (hasBody) result['Content-Type'] = 'application/json';
		const token = options.getToken();
		if (token) result.Authorization = `Bearer ${token}`;
		return result;
	}

	async function errorFromResponse(response: Response): Promise<ProviderError> {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return new ProviderError({
				kind: 'other',
				message: `${response.status} ${response.statusText}`
			});
		}
		if (isErrorBody(body)) return new ProviderError(body);
		return new ProviderError({
			kind: 'other',
			message: `${response.status} ${response.statusText}`
		});
	}

	return build(async (call) => {
		// Prepare the body first: a value JSON cannot hold (a `bigint`, a cycle) is the
		// caller's input, not a lost connection - nothing was sent.
		let body: string | undefined;
		if (call.body !== undefined) {
			try {
				body = JSON.stringify(call.body);
			} catch {
				throw new ProviderError({
					kind: 'bad_request',
					message: '送る内容を JSON にできません'
				});
			}
			if (body === undefined) {
				throw new ProviderError({
					kind: 'bad_request',
					message: '送る内容を JSON にできません'
				});
			}
		}
		let response: Response;
		try {
			response = await fetchFn(`${baseUrl}${call.path}${queryString(call.params)}`, {
				method: call.method,
				headers: headers(body !== undefined),
				...(body !== undefined ? { body } : {})
			});
		} catch {
			throw new ProviderError(
				{ kind: 'other', message: NETWORK_ERROR_MESSAGE },
				{ networkFailure: 'network' }
			);
		}
		if (!response.ok) throw await errorFromResponse(response);
		if (call.empty) return null;
		try {
			return await response.json();
		} catch {
			throw unexpected();
		}
	});
}
