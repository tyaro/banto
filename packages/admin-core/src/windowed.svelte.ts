/**
 * `createWindowedListResource` composable (spec §4.1, §4.2, §10, M5 Phase A):
 * a sparse, block-fetched list resource for the grid's server mode. Unlike
 * `ListResource` (list.svelte.ts), which fetches one full page in a single
 * call, this resource fetches fixed-size blocks lazily as the caller's
 * visible row range moves (BantoGrid's row-virtualization window), so a
 * server-backed grid with a huge `totalCount` only ever fetches the rows
 * that have scrolled into view (+ overscan) instead of the whole table.
 *
 * Runes constraint: this class never creates an `$effect` itself (no effect
 * context in a plain module, same rule as ListResource); components wire
 * `$effect`/cleanup around `ensureRange()`/`dispose()`.
 */
import { isProviderError, ProviderError } from './errors';
import { onInvalidate } from './invalidate';
import { getDataProvider, notify } from './registry.svelte';
import type { FilterState, SortState } from './types';

export interface CreateWindowedListResourceOptions {
	/** Rows fetched per block. Default 200. */
	blockSize?: number;
}

export interface WindowedParams {
	sort: SortState[];
	filters: FilterState[];
}

export class WindowedListResource<T> {
	/** Sparse: index i holds row i once its covering block has loaded, `undefined` (a hole) otherwise. */
	rows: (T | undefined)[] = $state([]);
	totalCount = $state(0);
	/** True while any block is in flight. */
	loading = $state(false);
	error: ProviderError | null = $state(null);
	params: WindowedParams = $state({ sort: [], filters: [] });

	#resource: string;
	#blockSize: number;
	#unsubscribe: () => void;

	#loadedBlocks = new Set<number>();
	#inFlightBlocks = new Map<number, Promise<void>>();
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
	// Last range passed to ensureRange(), so refresh() can re-fetch it.
	#lastRange: { start: number; end: number } | null = null;

	constructor(resource: string, options: CreateWindowedListResourceOptions = {}) {
		this.#resource = resource;
		this.#blockSize = options.blockSize ?? 200;
		this.#unsubscribe = onInvalidate(resource, () => {
			void this.refresh();
		});
	}

	#blocksFor(start: number, end: number): number[] {
		if (end <= start) return [];
		const firstBlock = Math.floor(start / this.#blockSize);
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
	 * block).
	 */
	async ensureRange(start: number, end: number): Promise<void> {
		this.#lastRange = { start, end };
		const generation = this.#generation;
		const blocks = this.#blocksFor(start, end).filter(
			(block) => !this.#loadedBlocks.has(block) && !this.#inFlightBlocks.has(block)
		);
		if (blocks.length === 0) return;

		this.loading = true;
		const fetches = blocks.map((block) => this.#fetchBlock(block, generation));
		blocks.forEach((block, i) => this.#inFlightBlocks.set(block, fetches[i]));
		try {
			await Promise.all(fetches);
		} finally {
			// Only touch shared bookkeeping if no setParams()/refresh() ran
			// while we were in flight - otherwise it already cleared (and is
			// now tracking a newer generation's own in-flight blocks, which
			// this stale call must not delete out from under it).
			if (generation === this.#generation) {
				blocks.forEach((block) => this.#inFlightBlocks.delete(block));
				this.loading = this.#inFlightBlocks.size > 0;
				if (!this.loading && this.#refreshSnapshot) {
					this.rows = this.#refreshSnapshot.rows;
					this.totalCount = this.#refreshSnapshot.totalCount;
					this.#refreshSnapshot = null;
				}
			}
		}
	}

	async #fetchBlock(block: number, generation: number): Promise<void> {
		const offset = block * this.#blockSize;
		try {
			const result = await getDataProvider().getList<T>(this.#resource, {
				pagination: { offset, limit: this.#blockSize },
				sort: this.params.sort,
				filters: this.params.filters
			});
			if (generation !== this.#generation) return; // superseded by setParams()/refresh()

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
			this.error = null;
		} catch (err) {
			if (generation !== this.#generation) return;
			const providerError = isProviderError(err)
				? err
				: new ProviderError({ kind: 'other', message: String(err) });
			this.error = providerError;
			notify('error', providerError.message);
		}
	}

	/**
	 * Replace sort/filters. Clears all cached blocks/rows so stale data isn't
	 * shown under the new params, but deliberately keeps the previous
	 * `totalCount` (rather than resetting to 0) until the first response
	 * under the new params arrives - resetting to 0 immediately would make
	 * the virtual scroller collapse and jump the scroll position. Callers
	 * must re-`ensureRange()` the currently visible window after calling
	 * this (BantoGrid's `onParamsChange` does).
	 */
	setParams(partial: Partial<WindowedParams>): void {
		this.params = { ...this.params, ...partial };
		this.#bumpGeneration();
		this.rows = new Array(this.totalCount);
	}

	/**
	 * Re-fetch the last ensured range and publish its replacement atomically
	 * (spec §4.1 / #212). Initial loads and setParams still expose holes while
	 * loading; refresh alone preserves the prior snapshot until completion.
	 * Failed blocks become holes in the new snapshot and remain retryable.
	 */
	refresh(): Promise<void> {
		this.#bumpGeneration();
		if (!this.#lastRange || this.#lastRange.end <= this.#lastRange.start) {
			this.rows = new Array(this.totalCount);
			return Promise.resolve();
		}
		this.#refreshSnapshot = { rows: new Array(this.totalCount), totalCount: this.totalCount };
		return this.ensureRange(this.#lastRange.start, this.#lastRange.end);
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
