/**
 * `createSnapshotListResource` composable (spec §4.1, Issue #248): a sparse,
 * block-fetched list resource for a server-mode grid over a list that
 * **changes without change events** - an append-only log such as the audit
 * log, which grows on every login/denial and shrinks through retention
 * pruning, with no `invalidate()` to re-fetch on. Same block model as
 * `WindowedListResource` (windowed.svelte.ts), plus a per-generation
 * **snapshot boundary**.
 *
 * Why a separate class instead of an option on `WindowedListResource`
 * (Issue #248 design decision, recorded in CHANGELOG / spec §4.1):
 *
 * - The data source is an **injected fetcher**, not `getDataProvider()`:
 *   carrying the boundary through `DataProvider.getList` would change the
 *   provider contract every provider (InMemory/Tauri/HTTP) implements, while
 *   the lists that need a boundary are few and have dedicated APIs.
 * - The request pattern differs: until a generation has its boundary, only
 *   **one** block may be in flight (parallel first requests would each pick
 *   their own boundary, i.e. read different sets), and a changed count
 *   **stops** the generation instead of being absorbed. Folding that into
 *   the class every CRUD grid uses would change its behaviour (and its
 *   #212/#243 guarantees) for lists that do not need it.
 *
 * ### Generations and the snapshot boundary
 *
 * A generation starts at construction, `setParams()` (a new query) and
 * `refresh()` (the same query, re-read). Its **first answer fixes the
 * boundary** (`asOfId`, the largest id the server included) and the total
 * count; every later block of the generation sends that boundary, so the
 * server reads every block from the same set and rows **added** between two
 * block requests cannot shift `OFFSET` (no duplicate or gap at a block
 * edge). New rows appear on the next generation (`refresh()`).
 *
 * The boundary relies on the server's contract: ids grow monotonically and
 * are never reused, rows are not updated in ways that move them in the
 * order, and `totalCount` is counted inside the boundary.
 *
 * ### Deletions expire the generation
 *
 * A boundary cannot keep **deleted** rows (retention pruning) in the set.
 * Inside one boundary with the same query the count can only change through
 * a deletion, so an answer whose `totalCount` differs from the generation's
 * is not written: the block records an expiry, `expired` becomes `true` and
 * **the generation fetches nothing more** (every further block would shift
 * the same way). It is not restarted automatically - with the row cap
 * reached and entries still arriving, an automatic restart would never
 * finish reading. `refresh()` starts a new generation. An answer with a
 * different `asOfId` than the one sent (a server that ignored the boundary)
 * is recorded as an error, not written.
 *
 * ### Failures and recovery
 *
 * - **A failure belongs to its block** and stays (`failedBlocks`; `error`
 *   is the most recent non-expiry one) until that block loads or
 *   `setParams()` starts a new query. Another block's success does not
 *   clear it.
 * - **No silent retry**: a block that failed in the current generation is
 *   not requested again in that generation, even when a range covers it,
 *   and a failed first read does not move on to the next block (that would
 *   be the same read again). `refresh()` retries every block whose failure
 *   is still shown.
 * - **Recovery never depends on the visible range**: while a generation has
 *   no boundary yet, block 0 is requested even for an empty range (the grid
 *   reports `{0, 0}` whenever the count is 0 or unknown), so `refresh()` and
 *   `setParams()` always reach the server - after a failed first fetch and
 *   after a 0-row result alike.
 * - **A request cannot hang forever**: each block request fails after
 *   `requestTimeoutMs` and its `AbortSignal` is aborted. A new generation
 *   (and `dispose()`) aborts every request still in flight, so `loading`
 *   comes down at once and `refresh()` is never blocked by a hung request.
 * - **Answers from another generation are ignored**, and so is a late
 *   answer after a timeout.
 * - A fetcher that throws synchronously, rejects with anything, or answers
 *   with a malformed result (not an array, a count that is not a valid
 *   array length, rows beyond the array-length limit, an `asOfId` that is
 *   not a safe integer) records a failure for that block instead of
 *   throwing out of the resource.
 *
 * ### States the page can tell apart
 *
 * `totalCount` is `null` until the current query has been read once, so a
 * page can show "not read yet" (`null`, no failure), "could not read"
 * (`null`, `failedBlocks` non-empty) and "read, 0 rows" (`0`) separately.
 *
 * Runes constraint: like `WindowedListResource`, this class never creates an
 * `$effect`; the owning component calls `ensureRange()` / `dispose()`.
 * Internal decisions read private (non-reactive) copies of the params, so
 * calling `ensureRange()` inside an effect does not make that effect depend
 * on them.
 */
import { hasTimeLimit, isWritableList, timeoutError, toProviderError } from './blockFetch';
import { ProviderError } from './errors';
import { notify } from './registry.svelte';
import type { FilterState, ListResult, Pagination, SortState } from './types';
import { DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS, type WindowedParams } from './windowed.svelte';

/** One block request handed to the fetcher. */
export interface SnapshotListRequest {
	pagination: Pagination;
	sort: SortState[];
	filters: FilterState[];
	/**
	 * The generation's boundary, or `null` for the request that starts a
	 * generation (the server picks the boundary and returns it).
	 */
	asOfId: number | null;
}

/** One block answer: `ListResult` plus the boundary the server used. */
export interface SnapshotListResult<T> extends ListResult<T> {
	asOfId: number;
}

/**
 * Fetches one block. `signal` is aborted when the request times out or is
 * superseded (a new generation, `dispose()`); honouring it is optional.
 */
export type SnapshotListFetcher<T> = (
	request: SnapshotListRequest,
	signal: AbortSignal
) => Promise<SnapshotListResult<T>>;

export interface CreateSnapshotListResourceOptions {
	/** Rows fetched per block. Default 200. */
	blockSize?: number;
	/**
	 * Milliseconds after which a block request that has not answered is
	 * treated as failed. Default {@link DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS}.
	 * `0`, a negative number or `Infinity` disables the limit.
	 */
	requestTimeoutMs?: number;
	/** The initial sort/filters (no request is made until `ensureRange()`). */
	params?: Partial<WindowedParams>;
}

/** Why a block holds no rows. */
type BlockFailure = { kind: 'error'; error: ProviderError } | { kind: 'expired' };

interface FailureRecord {
	failure: BlockFailure;
	/** The generation the failure was recorded in. */
	generation: number;
	/** Recording order, so `error` can show the most recent failure. */
	seq: number;
}

interface InFlightRequest {
	controller: AbortController;
	timer: ReturnType<typeof setTimeout> | undefined;
}

type Outcome<T> = { ok: true; result: SnapshotListResult<T> } | { ok: false; error: ProviderError };

/** Message of the error recorded when an answer's `asOfId` is not the one sent. */
export const SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE = 'list snapshot boundary mismatch';

function isWritableSnapshot(result: unknown, offset: number): boolean {
	return (
		isWritableList(result, offset) && Number.isSafeInteger((result as { asOfId?: unknown }).asOfId)
	);
}

function errorFailure(error: ProviderError): BlockFailure {
	return { kind: 'error', error };
}

export class SnapshotListResource<T> {
	/** Sparse: index i holds row i once its block has loaded, a hole otherwise. */
	rows: (T | undefined)[] = $state([]);
	/**
	 * Row count of the current query at its generation's boundary; `null`
	 * until the current query has been read once (a failed or pending first
	 * read). Kept through `refresh()` until the new generation answers.
	 */
	totalCount: number | null = $state(null);
	/** True while any block request is in flight. */
	loading = $state(false);
	/** The most recent outstanding request failure (not an expiry), `null` when there is none. */
	error: ProviderError | null = $state(null);
	/** Blocks whose latest request failed or expired and that have not loaded since, ascending. */
	failedBlocks: number[] = $state([]);
	/**
	 * True when rows were deleted inside the current generation's boundary
	 * while it was being read: the generation fetches nothing more until
	 * `refresh()`.
	 */
	expired = $state(false);
	/** The current generation's boundary, `null` until its first answer. */
	asOfId: number | null = $state(null);
	params: WindowedParams = $state({ sort: [], filters: [] });

	readonly #fetcher: SnapshotListFetcher<T>;
	readonly #blockSize: number;
	readonly #requestTimeoutMs: number;

	// Private copy of `params`: read when building requests, so an
	// `ensureRange()` inside a caller's `$effect` does not track `params`.
	#params: WindowedParams = { sort: [], filters: [] };
	#generation = 0;
	#snapshot: { asOfId: number; totalCount: number } | null = null;
	#loaded = new Set<number>();
	#inFlight = new Map<number, InFlightRequest>();
	#failures = new Map<number, FailureRecord>();
	#failureSeq = 0;
	#range = { start: 0, end: 0 };
	// No request is made before the first ensureRange() (same as
	// WindowedListResource): setParams()/refresh() before it only reset state.
	#active = false;
	#disposed = false;

	constructor(fetcher: SnapshotListFetcher<T>, options: CreateSnapshotListResourceOptions = {}) {
		this.#fetcher = fetcher;
		this.#blockSize = options.blockSize ?? 200;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS;
		this.#params = {
			sort: options.params?.sort ?? [],
			filters: options.params?.filters ?? []
		};
		this.params = this.#params;
	}

	/**
	 * Fetch the blocks covering `[start, end)` that the current generation
	 * still needs. Safe to call on every virtualization window move: loaded,
	 * in-flight and (in this generation) failed blocks are skipped. Requests
	 * are issued before this returns; answers are applied asynchronously.
	 */
	ensureRange(start: number, end: number): void {
		this.#range = { start, end };
		this.#active = true;
		this.#pump();
	}

	/**
	 * Replace sort/filters: a new query. Nothing of the previous query is
	 * kept (rows, count, failures), since block numbers now address another
	 * set; `totalCount` returns to `null` until the new query answers.
	 */
	setParams(partial: Partial<WindowedParams>): void {
		this.#params = { ...this.#params, ...partial };
		this.params = this.#params;
		this.#newGeneration();
		this.#failures.clear();
		this.rows = [];
		this.totalCount = null;
		this.#publish();
		this.#pump();
	}

	/**
	 * Re-read the same query as a new generation (new rows come in here).
	 * Requests still in flight are aborted, so this works even while a
	 * request hangs. The current rows and count stay shown until the new
	 * generation's first answer replaces them; failures stay shown until
	 * their block loads, and every failed block is requested again.
	 */
	refresh(): void {
		this.#newGeneration();
		this.#publish();
		this.#pump();
	}

	/** Abort every request and stop. Call from the owning component's cleanup. */
	dispose(): void {
		this.#disposed = true;
		this.#abandonInFlight();
		this.loading = false;
	}

	#newGeneration(): void {
		this.#generation++;
		this.#snapshot = null;
		this.#loaded.clear();
		this.#abandonInFlight();
	}

	#abandonInFlight(): void {
		for (const request of this.#inFlight.values()) {
			clearTimeout(request.timer);
			request.controller.abort();
		}
		this.#inFlight.clear();
	}

	#blocksFor(start: number, end: number): number[] {
		if (!(end > start)) return [];
		const firstBlock = Math.floor(Math.max(start, 0) / this.#blockSize);
		const lastBlock = Math.floor((end - 1) / this.#blockSize);
		const blocks: number[] = [];
		for (let b = firstBlock; b <= lastBlock; b++) blocks.push(b);
		return blocks;
	}

	/** Whether the current generation has recorded an expiry (it fetches nothing more). */
	#isHalted(): boolean {
		for (const record of this.#failures.values()) {
			if (record.generation === this.#generation && record.failure.kind === 'expired') {
				return true;
			}
		}
		return false;
	}

	#hasFailedInThisGeneration(): boolean {
		for (const record of this.#failures.values()) {
			if (record.generation === this.#generation) return true;
		}
		return false;
	}

	/**
	 * The single predicate deciding what to request (on range moves, after
	 * each answer, on `refresh()`/`setParams()`): the visible blocks, block 0
	 * while the generation has no boundary, and blocks that failed in an
	 * earlier generation - minus loaded, in-flight and failed-in-this-
	 * generation blocks, and blocks past the boundary's count. Before the
	 * boundary is known, at most one request, and none after a failure in
	 * this generation.
	 */
	#blocksToFetch(): number[] {
		if (!this.#active || this.#disposed || this.#isHalted()) return [];
		const wanted = new Set(this.#blocksFor(this.#range.start, this.#range.end));
		if (this.#snapshot === null) wanted.add(0);
		for (const [block, record] of this.#failures) {
			if (record.generation !== this.#generation) wanted.add(block);
		}
		const candidates = [...wanted]
			.sort((a, b) => a - b)
			.filter(
				(block) =>
					!this.#loaded.has(block) &&
					!this.#inFlight.has(block) &&
					this.#failures.get(block)?.generation !== this.#generation
			);
		const snapshot = this.#snapshot;
		// Blocks past the boundary's count hold no rows: nothing to request.
		if (snapshot !== null) {
			return candidates.filter((block) => block * this.#blockSize < snapshot.totalCount);
		}
		// No boundary yet: one request at a time, and none once a request of
		// this generation has failed - another block would only be a retry
		// of the same first read in disguise (a failed first block must not
		// cascade through every block of the range). refresh() retries.
		if (this.#inFlight.size > 0 || this.#hasFailedInThisGeneration()) return [];
		return candidates.slice(0, 1);
	}

	#pump(): void {
		const blocks = this.#blocksToFetch();
		if (blocks.length === 0) {
			this.#publish();
			return;
		}
		const generation = this.#generation;
		const asOfId = this.#snapshot?.asOfId ?? null;
		// Bookkeeping first, requests second: every block of this pump is in
		// the in-flight map before any fetcher runs.
		const started = blocks.map((block) => {
			const request: InFlightRequest = { controller: new AbortController(), timer: undefined };
			this.#inFlight.set(block, request);
			return { block, request };
		});
		this.#publish();
		for (const { block, request } of started) {
			this.#start(block, request, generation, asOfId);
		}
	}

	#start(block: number, entry: InFlightRequest, generation: number, asOfId: number | null): void {
		const offset = block * this.#blockSize;
		const ms = this.#requestTimeoutMs;
		const outcome = new Promise<Outcome<T>>((resolve) => {
			if (hasTimeLimit(ms)) {
				entry.timer = setTimeout(() => {
					entry.controller.abort();
					resolve({ ok: false, error: timeoutError(ms) });
				}, ms);
			}
			// The fetcher is called synchronously (the request is issued
			// before ensureRange() returns); a synchronous throw becomes this
			// block's failure, applied asynchronously like any other answer.
			let request: Promise<SnapshotListResult<T>>;
			try {
				request = Promise.resolve(
					this.#fetcher(
						{
							pagination: { offset, limit: this.#blockSize },
							sort: this.#params.sort,
							filters: this.#params.filters,
							asOfId
						},
						entry.controller.signal
					)
				);
			} catch (err) {
				request = Promise.reject(err);
			}
			request.then(
				(result) => resolve({ ok: true, result }),
				(err: unknown) => resolve({ ok: false, error: toProviderError(err) })
			);
		});
		void outcome.then((settled) => {
			clearTimeout(entry.timer);
			this.#settle(block, entry, generation, settled);
		});
	}

	#settle(block: number, entry: InFlightRequest, generation: number, outcome: Outcome<T>): void {
		// Superseded (another generation, dispose()) or not this request.
		if (this.#disposed || generation !== this.#generation) return;
		if (this.#inFlight.get(block) !== entry) return;
		this.#inFlight.delete(block);

		const failure = this.#apply(block, outcome);
		if (failure) {
			this.#failures.set(block, { failure, generation, seq: ++this.#failureSeq });
		}
		this.#publish();
		// The notifier is app code and may throw; that must not stop the
		// pump below (the rest of the range after the boundary is fixed).
		if (failure?.kind === 'error') {
			try {
				notify('error', failure.error.message);
			} catch {
				// Ignored on purpose (see above).
			}
		}
		this.#pump();
	}

	/** Write one answer, or say why it cannot be written. Never throws. */
	#apply(block: number, outcome: Outcome<T>): BlockFailure | null {
		if (!outcome.ok) return errorFailure(outcome.error);
		const offset = block * this.#blockSize;
		const result = outcome.result;
		if (!isWritableSnapshot(result, offset)) {
			return errorFailure(new ProviderError({ kind: 'other', message: 'malformed list result' }));
		}
		const snapshot = this.#snapshot;
		if (snapshot !== null) {
			if (result.asOfId !== snapshot.asOfId) {
				return errorFailure(
					new ProviderError({ kind: 'other', message: SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE })
				);
			}
			if (result.totalCount !== snapshot.totalCount) return { kind: 'expired' };
		}
		try {
			this.#write(block, offset, result);
		} catch (err) {
			return errorFailure(toProviderError(err));
		}
		return null;
	}

	/**
	 * The generation's first answer builds a fresh array off-state (the only
	 * step that can throw) and then publishes it with the boundary; later
	 * answers write into the published array.
	 */
	#write(block: number, offset: number, result: SnapshotListResult<T>): void {
		const end = offset + result.rows.length;
		if (this.#snapshot === null) {
			const rows = new Array<T | undefined>(result.totalCount);
			if (rows.length < end) rows.length = end;
			for (let i = 0; i < result.rows.length; i++) rows[offset + i] = result.rows[i];
			this.#snapshot = { asOfId: result.asOfId, totalCount: result.totalCount };
			this.rows = rows;
			this.totalCount = result.totalCount;
			// A failure recorded for a block past the new count addresses no
			// rows any more (the list shrank): drop it rather than show it
			// forever.
			for (const failed of [...this.#failures.keys()]) {
				if (failed * this.#blockSize >= result.totalCount) this.#failures.delete(failed);
			}
		} else {
			const rows = this.rows;
			if (rows.length < end) rows.length = end;
			for (let i = 0; i < result.rows.length; i++) rows[offset + i] = result.rows[i];
		}
		this.#loaded.add(block);
		this.#failures.delete(block);
	}

	/** Publish the derived state. Decides from private fields only (never reads `$state` back). */
	#publish(): void {
		this.loading = this.#inFlight.size > 0;
		let latest: FailureRecord | null = null;
		for (const record of this.#failures.values()) {
			if (record.failure.kind === 'error' && (!latest || record.seq > latest.seq)) latest = record;
		}
		this.error = latest?.failure.kind === 'error' ? latest.failure.error : null;
		this.failedBlocks = [...this.#failures.keys()].sort((a, b) => a - b);
		this.expired = this.#isHalted();
		this.asOfId = this.#snapshot?.asOfId ?? null;
	}
}

export function createSnapshotListResource<T>(
	fetcher: SnapshotListFetcher<T>,
	options?: CreateSnapshotListResourceOptions
): SnapshotListResource<T> {
	return new SnapshotListResource<T>(fetcher, options);
}
