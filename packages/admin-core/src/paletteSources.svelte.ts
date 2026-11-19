/**
 * Runs `PaletteSource`s for the command palette (#711): debounces the typed
 * query, starts one request per source, and keeps each source's state
 * (`pending` / `ready` / `error`) so a slow or failing source never holds the
 * others back. Headless: the palette (an option) feeds it the query and
 * renders `states`; this module imports nothing from any option (conventions §4).
 *
 * Overlapping input is handled by `createRequestOwner` (§8): a new query
 * aborts the sources' previous requests and drops whatever they still return,
 * so an old answer never overwrites a newer query's state.
 */
import type { PaletteCommand, PaletteSource } from './commands';
import { createRequestOwner } from './request.svelte';

export type PaletteSourceStatus = 'pending' | 'ready' | 'error';

export interface PaletteSourceState {
	id: string;
	/** Resolved heading. */
	group: string;
	status: PaletteSourceStatus;
	/** At most `limit` candidates; only meaningful while `ready`. */
	items: PaletteCommand[];
}

export interface PaletteSourceSearchOptions {
	/** Quiet time after the last keystroke before the sources run. Default 200ms. */
	debounceMs?: number;
	/** Candidates kept per source. Default 5. */
	limit?: number;
}

export interface PaletteSourceSearch {
	/** One entry per source that is visible, while the query is non-empty, in source order. Reactive. */
	readonly states: readonly PaletteSourceState[];
	/** Feed the palette's query. Empty/whitespace = nothing is searched and `states` is emptied. */
	setQuery(query: string): void;
	/** Stop everything (timer and requests). Idempotent. */
	dispose(): void;
}

export function createPaletteSourceSearch(
	sources: readonly PaletteSource[],
	options: PaletteSourceSearchOptions = {}
): PaletteSourceSearch {
	const debounceMs = options.debounceMs ?? 200;
	const limit = options.limit ?? 5;
	const owner = createRequestOwner();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let states: PaletteSourceState[] = $state([]);

	function groupOf(source: PaletteSource): string {
		return typeof source.group === 'function' ? source.group() : source.group;
	}

	function patch(id: string, next: Partial<PaletteSourceState>): void {
		states = states.map((state) => (state.id === id ? { ...state, ...next } : state));
	}

	function clearTimer(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	async function run(source: PaletteSource, query: string): Promise<void> {
		const handle = owner.begin(source.id);
		try {
			const found = await source.search(query, handle.signal);
			if (!handle.isCurrent()) return;
			patch(source.id, { status: 'ready', items: found.slice(0, limit) });
		} catch {
			// An aborted / superseded request is not a failure of the current one.
			if (!handle.isCurrent()) return;
			patch(source.id, { status: 'error', items: [] });
		} finally {
			handle.finish();
		}
	}

	return {
		get states() {
			return states;
		},
		setQuery(query: string): void {
			clearTimer();
			for (const source of sources) owner.invalidate(source.id);
			const trimmed = query.trim();
			if (owner.disposed || trimmed === '') {
				states = [];
				return;
			}
			const active = sources.filter((source) => source.visible?.() ?? true);
			states = active.map((source) => ({
				id: source.id,
				group: groupOf(source),
				status: 'pending',
				items: []
			}));
			timer = setTimeout(() => {
				timer = undefined;
				for (const source of active) void run(source, trimmed);
			}, debounceMs);
		},
		dispose(): void {
			clearTimer();
			owner.dispose();
			states = [];
		}
	};
}
