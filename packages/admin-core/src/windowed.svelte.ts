/**
 * `createWindowedListResource` composable (spec §4.1, §4.2, §10, M5 Phase A):
 * a sparse, block-fetched list resource for the grid's server mode. Unlike
 * `ListResource` (list.svelte.ts), which fetches one full page in a single
 * call, this resource fetches fixed-size blocks lazily as the caller's
 * visible row range moves (BantoGrid's row-virtualization window), so a
 * server-backed grid with a huge `totalCount` only ever fetches the rows
 * that have scrolled into view (+ overscan) instead of the whole table.
 *
 * Failures and recovery (Issue #243):
 *
 * - **A failure belongs to its block.** It stays in `failedBlocks` (and
 *   `error` shows the most recent one) until that block is fetched
 *   successfully or `setParams()` starts a new query; another block's
 *   success does not clear it.
 * - **Recovery never depends on the visible range.** While the current
 *   generation has no `totalCount` yet (a failed first fetch, or a new
 *   query/refresh), a load with nothing else to fetch requests block 0, so
 *   `setParams()`/`refresh()` still reach the server when the grid reports
 *   an empty window `{0, 0}` (it does whenever `totalCount` is 0). A block
 *   that already failed in the current generation is not requested this
 *   way again (no silent retry loop); `refresh()` (a new generation) and an
 *   `ensureRange()` that explicitly covers it do retry it.
 * - **A request cannot hang forever.** Each block request fails after
 *   `requestTimeoutMs` (default {@link DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS});
 *   its late answer is ignored, so `loading` always comes down.
 *
 * Not included on purpose: a per-generation snapshot boundary (an "as of"
 * id every block of a generation is read from). Rows added or removed
 * between two block requests can still shift `OFFSET` by the change; fixing
 * that needs `DataProvider.getList` to carry the boundary (an API change),
 * and ordinary CRUD screens re-fetch anyway on the `invalidate()` their own
 * change events trigger. The server side guarantees a total order
 * (`banto-storage` appends the unique key to `ORDER BY`), so with unchanged
 * data the blocks tile the list exactly.
 *
 * Runes constraint: this class never creates an `$effect` itself (no effect
 * context in a plain module, same rule as ListResource); components wire
 * `$effect`/cleanup around `ensureRange()`/`dispose()`.
 */
import { isProviderError, ProviderError } from './errors';
import { onInvalidate } from './invalidate';
import { getDataProvider, notify } from './registry.svelte';
import type { FilterState, ListResult, SortState } from './types';

/** Default for {@link CreateWindowedListResourceOptions.requestTimeoutMs}: 30 s. */
export const DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS = 30_000;

export interface CreateWindowedListResourceOptions {
	/** Rows fetched per block. Default 200. */
	blockSize?: number;
	/**
	 * Milliseconds after which a block request that has not answered is
	 * treated as failed (its late answer is ignored). Default
	 * {@link DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS}. `0`, a negative number or
	 * `Infinity` disables the limit.
	 */
	requestTimeoutMs?: number;
}

export interface WindowedParams {
	sort: SortState[];
	filters: FilterState[];
}

interface InFlightBlock {
	promise: Promise<void>;
	/** Distinguishes two requests for the same block (a retry after a timeout). */
	attempt: number;
}

interface BlockFailure {
	error: ProviderError;
	/** The generation the failure was recorded in (see `#implicitFirstBlock`). */
	generation: number;
	/** Recording order, so `error` can show the most recent failure. */
	seq: number;
}

export class WindowedListResource<T> {
	/** Sparse: index i holds row i once its covering block has loaded, `undefined` (a hole) otherwise. */
	rows: (T | undefined)[] = $state([]);
	totalCount = $state(0);
	/** True while any block is in flight. */
	loading = $state(false);
	/**
	 * The most recent failure still outstanding (see `failedBlocks`), `null`
	 * when every block that was requested has loaded.
	 */
	error: ProviderError | null = $state(null);
	/**
	 * Indexes of the blocks whose latest request failed and that have not
	 * loaded since, ascending. Emptied by `setParams()`; kept through
	 * `refresh()` until the retried block loads.
	 */
	failedBlocks: number[] = $state([]);
	params: WindowedParams = $state({ sort: [], filters: [] });

	#resource: string;
	#blockSize: number;
	#requestTimeoutMs: number;
	#unsubscribe: () => void;

	#loadedBlocks = new Set<number>();
	#inFlightBlocks = new Map<number, InFlightBlock>();
	#failures = new Map<number, BlockFailure>();
	#attempts = 0;
	#failureSeq = 0;
	// Bumped by setParams()/refresh(). A block response only writes state
	// (rows/totalCount/error) if its generation still matches - the same
	// stale-response guard as ListResource's request token (list.svelte.ts),
	// applied per block instead of per whole-list load().
	#generation = 0;
	// Whether a response in the *current* generation has already supplied
	// totalCount/resized `rows`; only the first one per generation should.
	#hasTotalCountForGeneration = false;
	// Refreshes replace one dataset snapshot with another. Keep the published
	// rows until all current-generation requests settle, so grids do not lose
	// their edit/selection to temporary holes or mix old and reordered rows.
	#refreshSnapshot: { rows: (T | undefined)[]; totalCount: number } | null = null;
	// Last range passed to ensureRange(), so refresh()/setParams() can re-fetch it.
	#lastRange: { start: number; end: number } | null = null;

	constructor(resource: string, options: CreateWindowedListResourceOptions = {}) {
		this.#resource = resource;
		this.#blockSize = options.blockSize ?? 200;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS;
		this.#unsubscribe = onInvalidate(resource, () => {
			void this.refresh();
		});
	}

	#blocksFor(start: number, end: number): number[] {
		if (end <= start) return [];
		const firstBlock = Math.floor(Math.max(start, 0) / this.#blockSize);
		const lastBlock = Math.floor((end - 1) / this.#blockSize);
		const blocks: number[] = [];
		for (let b = firstBlock; b <= lastBlock; b++) blocks.push(b);
		return blocks;
	}

	/**
	 * Fetch whatever blocks covering `[start, end)` aren't already loaded or
	 * in flight. Safe to call repeatedly (e.g. on every virtualization
	 * window move) - already-covered blocks are skipped, and overlapping
	 * calls dedup per block (the in-flight bookkeeping below is populated
	 * synchronously before this function's first `await`, so two calls made
	 * back-to-back without awaiting the first never double-fetch the same
	 * block). The returned promise settles once every covering block that
	 * is (or was already) in flight has settled.
	 *
	 * A block that failed is requested again when a range covers it. While
	 * the generation has no `totalCount` yet and nothing else is being
	 * fetched, block 0 is requested even for an empty range (see the module
	 * doc comment).
	 */
	ensureRange(start: number, end: number): Promise<void> {
		this.#lastRange = { start, end };
		return this.#load(this.#blocksFor(start, end));
	}

	#load(wanted: number[]): Promise<void> {
		const generation = this.#generation;
		const blocks = [...new Set(wanted)].sort((a, b) => a - b);
		const toFetch = blocks.filter(
			(block) => !this.#loadedBlocks.has(block) && !this.#inFlightBlocks.has(block)
		);
		if (toFetch.length === 0 && this.#implicitFirstBlock(generation)) {
			toFetch.push(0);
			blocks.push(0);
		} else if (
			blocks.length === 0 &&
			!this.#hasTotalCountForGeneration &&
			this.#inFlightBlocks.has(0)
		) {
			// An empty range while the implicit block 0 is already in flight
			// (e.g. setParams() then the grid's `ensureRange(0, 0)`): wait for it.
			blocks.push(0);
		}

		for (const block of toFetch) {
			const attempt = ++this.#attempts;
			const promise = this.#fetchBlock(block, generation, attempt);
			this.#inFlightBlocks.set(block, { promise, attempt });
		}
		this.#settleLoading();

		const pending = blocks
			.map((block) => this.#inFlightBlocks.get(block)?.promise)
			.filter((promise): promise is Promise<void> => promise !== undefined);
		return Promise.all(pending).then(() => undefined);
	}

	/**
	 * Whether a load that fetches nothing else should request block 0: the
	 * generation has no `totalCount` yet, nothing in flight will supply it,
	 * and block 0 has not already failed in this generation.
	 */
	#implicitFirstBlock(generation: number): boolean {
		return (
			!this.#hasTotalCountForGeneration &&
			this.#inFlightBlocks.size === 0 &&
			!this.#loadedBlocks.has(0) &&
			this.#failures.get(0)?.generation !== generation
		);
	}

	async #fetchBlock(block: number, generation: number, attempt: number): Promise<void> {
		const offset = block * this.#blockSize;
		let outcome: { ok: true; result: ListResult<T> } | { ok: false; error: ProviderError };
		try {
			const result = await this.#withTimeout(
				getDataProvider().getList<T>(this.#resource, {
					pagination: { offset, limit: this.#blockSize },
					sort: this.params.sort,
					filters: this.params.filters
				})
			);
			outcome = { ok: true, result };
		} catch (err) {
			outcome = {
				ok: false,
				error: isProviderError(err)
					? err
					: new ProviderError({ kind: 'other', message: String(err) })
			};
		}

		// Superseded by setParams()/refresh() (which also dropped this block
		// from the in-flight map), or by a newer request for the same block.
		if (generation !== this.#generation) return;
		if (this.#inFlightBlocks.get(block)?.attempt !== attempt) return;
		this.#inFlightBlocks.delete(block);

		if (outcome.ok) {
			const { result } = outcome;
			const snapshot = this.#refreshSnapshot;
			const targetRows = snapshot ? snapshot.rows : this.rows;
			if (!this.#hasTotalCountForGeneration) {
				this.#hasTotalCountForGeneration = true;
				if (snapshot) snapshot.totalCount = result.totalCount;
				else this.totalCount = result.totalCount;
				targetRows.length = result.totalCount;
			}
			if (targetRows.length < offset + result.rows.length) {
				targetRows.length = offset + result.rows.length;
			}
			for (let i = 0; i < result.rows.length; i++) {
				targetRows[offset + i] = result.rows[i];
			}
			this.#loadedBlocks.add(block);
			this.#failures.delete(block);
		} else {
			this.#failures.set(block, { error: outcome.error, generation, seq: ++this.#failureSeq });
			notify('error', outcome.error.message);
		}
		this.#publishFailures();
		this.#settleLoading();
	}

	#withTimeout<R>(request: Promise<R>): Promise<R> {
		const ms = this.#requestTimeoutMs;
		if (!(ms > 0) || !Number.isFinite(ms)) return request;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new ProviderError({
							kind: 'other',
							message: `list request timed out after ${ms} ms`
						})
					),
				ms
			);
		});
		return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
	}

	/** Recompute `loading`; when the generation has settled, publish a staged refresh. */
	#settleLoading(): void {
		// Decide from the private map, never by reading `this.loading` back:
		// ensureRange() runs this synchronously, often inside a caller's
		// `$effect`, which must not start depending on `loading`.
		const loading = this.#inFlightBlocks.size > 0;
		this.loading = loading;
		if (!loading && this.#refreshSnapshot) {
			this.rows = this.#refreshSnapshot.rows;
			this.totalCount = this.#refreshSnapshot.totalCount;
			this.#refreshSnapshot = null;
		}
	}

	#publishFailures(): void {
		let latest: BlockFailure | null = null;
		for (const failure of this.#failures.values()) {
			if (!latest || failure.seq > latest.seq) latest = failure;
		}
		this.error = latest?.error ?? null;
		this.failedBlocks = [...this.#failures.keys()].sort((a, b) => a - b);
	}

	/**
	 * Replace sort/filters. Clears all cached blocks/rows (and the previous
	 * query's failures) so stale data isn't shown under the new params, but
	 * deliberately keeps the previous `totalCount` (rather than resetting to
	 * 0) until the first response under the new params arrives - resetting
	 * to 0 immediately would make the virtual scroller collapse and jump the
	 * scroll position. Re-fetches the last ensured range itself (block 0
	 * when that range is empty); callers that re-`ensureRange()` the visible
	 * window afterwards (BantoGrid's `onParamsChange` does) just join those
	 * requests.
	 */
	setParams(partial: Partial<WindowedParams>): void {
		this.params = { ...this.params, ...partial };
		this.#bumpGeneration();
		this.#failures.clear();
		this.#publishFailures();
		this.rows = new Array(this.totalCount);
		if (this.#lastRange) {
			void this.#load(this.#blocksFor(this.#lastRange.start, this.#lastRange.end));
		} else {
			this.#settleLoading();
		}
	}

	/**
	 * Re-fetch the last ensured range and publish its replacement atomically
	 * (spec §4.1 / #212). Initial loads and setParams still expose holes while
	 * loading; refresh alone preserves the prior snapshot until completion.
	 * Failed blocks become holes in the new snapshot and remain retryable.
	 *
	 * Also re-requests every block whose failure is still outstanding (even
	 * outside the last range), and block 0 when the last range is empty
	 * (Issue #243: the "reload" after a failed first fetch or a 0-row result
	 * must reach the server). Before the first `ensureRange()` it fetches
	 * nothing.
	 */
	refresh(): Promise<void> {
		this.#bumpGeneration();
		if (!this.#lastRange) {
			this.rows = new Array(this.totalCount);
			this.#settleLoading();
			return Promise.resolve();
		}
		this.#refreshSnapshot = { rows: new Array(this.totalCount), totalCount: this.totalCount };
		return this.#load([
			...this.#blocksFor(this.#lastRange.start, this.#lastRange.end),
			...this.#failures.keys()
		]);
	}

	#bumpGeneration(): void {
		this.#generation++;
		this.#refreshSnapshot = null;
		this.#loadedBlocks.clear();
		this.#inFlightBlocks.clear();
		this.#hasTotalCountForGeneration = false;
	}

	/** Stop reacting to invalidate() calls for this resource. Call from the owning component's cleanup. */
	dispose(): void {
		this.#unsubscribe();
	}
}

export function createWindowedListResource<T>(
	resource: string,
	options?: CreateWindowedListResourceOptions
): WindowedListResource<T> {
	return new WindowedListResource<T>(resource, options);
}
