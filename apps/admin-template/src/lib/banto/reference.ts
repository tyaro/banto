/**
 * Search another resource for a `reference` form field (Issue #714): the
 * bridge between @banto/forms (which holds no data contract - a field takes
 * `search` / `resolve` functions) and the app's `DataProvider`. The
 * `DataProvider` contract is not widened: `search` is `getList` with its
 * quick search (`ListParams.search`, Issue #555 - which columns match is the
 * backend's call), `resolve` is `getOne`.
 *
 *     { name: 'ownerId', label: '担当者', type: 'reference',
 *       ...referenceFrom(getDataProvider, 'users', { labelOf: (u: User) => u.name }) }
 *
 * The result is a plain `{ search, resolve }` of `ReferenceOption`s, so
 * anything that looks records up by text (the command palette's record
 * search, B-5 / #711) can take the same source.
 */
import {
	isProviderError,
	type DataProvider,
	type FilterState,
	type SortState
} from '@banto/admin-core';
import type { ReferenceOption } from '@banto/forms';

/** How many candidates one search asks for when `limit` is not given. */
export const REFERENCE_SEARCH_LIMIT = 20;

export interface ReferenceFromOptions<TRow> {
	/** The name shown for a row. */
	labelOf: (row: TRow) => string;
	/**
	 * The value stored for a row. Default: its `id`. The type is kept (`2` and
	 * `'2'` differ). Not named `valueOf`: every object already has one
	 * (`Object.prototype.valueOf`), so an optional `valueOf` neither type-checks
	 * nor can be told from "not given".
	 */
	idOf?: (row: TRow) => string | number;
	/** Second line under the name (a code, a category). */
	descriptionOf?: (row: TRow) => string | undefined;
	/** Candidates per search (default {@link REFERENCE_SEARCH_LIMIT}). */
	limit?: number;
	/** Order of the candidates (default: the backend's). */
	sort?: SortState[];
	/** Conditions every candidate must meet (only the active ones, say); ANDed with the search. */
	filters?: FilterState[];
}

/** What a `reference` field (or any record lookup) needs. Spread it into the field definition. */
export interface ReferenceSource {
	/** Candidates for `query` (`''`: the first `limit` rows). */
	search: (query: string, signal: AbortSignal) => Promise<ReferenceOption[]>;
	/** The option of a stored value; `null` when there is no such record. */
	resolve: (value: string | number, signal: AbortSignal) => Promise<ReferenceOption | null>;
}

/**
 * Build `search` / `resolve` over one resource of a `DataProvider`.
 *
 * `provider` may be a getter (`getDataProvider`): resource definitions are
 * built at module load, before `initBanto` ran.
 *
 * `DataProvider` takes no `AbortSignal`, so an aborted request still runs to
 * its end; its answer is thrown away here (the promise rejects with the
 * signal's reason) and the field drops it either way.
 */
export function referenceFrom<TRow>(
	provider: DataProvider | (() => DataProvider),
	resource: string,
	options: ReferenceFromOptions<TRow>
): ReferenceSource {
	const source = () => (typeof provider === 'function' ? provider() : provider);
	const idOf = options.idOf ?? ((row: TRow) => (row as { id: string | number }).id);
	const toOption = (row: TRow): ReferenceOption => {
		const description = options.descriptionOf?.(row);
		return {
			value: idOf(row),
			label: options.labelOf(row),
			...(description ? { description } : {})
		};
	};

	return {
		async search(query, signal) {
			const term = query.trim();
			const result = await source().getList<TRow>(resource, {
				pagination: { offset: 0, limit: options.limit ?? REFERENCE_SEARCH_LIMIT },
				sort: options.sort ?? [],
				filters: options.filters ?? [],
				...(term ? { search: term } : {})
			});
			signal.throwIfAborted();
			return result.rows.map(toOption);
		},
		async resolve(value, signal) {
			let row: TRow;
			try {
				row = await source().getOne<TRow>(resource, value);
			} catch (error) {
				// The record is gone: the field shows the stored value itself.
				if (isProviderError(error) && error.body.kind === 'not_found') return null;
				throw error;
			}
			signal.throwIfAborted();
			return toOption(row);
		}
	};
}
