/**
 * Issue #284: per-row save serialization for inline edits and range pastes.
 *
 * Root cause being fixed: each save used to build the full editable value set
 * from a stale row snapshot (`edit.row`, taken when the edit started), so two
 * overlapping saves to the same row - e.g. paste into `name`, then paste into
 * `stock` before the first response lands - sent `{name: <old>, stock: new}`
 * and the later write reverted the earlier one.
 *
 * Fix: saves for one row id run strictly one after another (a Promise chain),
 * and the request body is composed at the moment of SENDING from the latest
 * confirmed row (the previous save's response) plus only this save's changed
 * columns. Different rows do not block each other.
 *
 * Failure semantics: a failed save rejects only its own caller; the chain
 * continues, and the failed values are never folded into the confirmed row, so
 * later saves are based on the last confirmed values. Results are produced in
 * send order (the chain guarantees it).
 *
 * Issue #638: when `isConflict` says a save was refused by the optimistic
 * lock, the saves of that row still waiting in the same burst are refused
 * with the same error without being sent - they were composed against the
 * row the user had before the conflict, and the user re-enters them on the
 * latest row instead.
 *
 * The confirmed row for an id is dropped once its queue drains, so a later
 * edit is based on `currentRow` (the row as displayed at send time, already
 * updated with the saved result), falling back to the enqueue-time snapshot.
 *
 * Issue #638 (lock version): the VALUES are composed from the latest row, but
 * the optimistic-lock version sent is the one the user's edit was based on -
 * the `basisRow` (the row as displayed when a cell edit opened, or at paste
 * time) - not the version of the row displayed at send time. A list refetch
 * (SSE) can bring someone else's newer version while an editor is open; sending
 * that version would overwrite their change with a draft composed against the
 * older row. The basis version is only moved forward along the version steps
 * this queue's OWN successful saves made (`advanceLockVersion`), so consecutive
 * saves of one row (two cell edits in a row, a paste after an edit) do not
 * conflict with themselves, while a step made by anyone else makes the server
 * answer with a conflict.
 */
export interface LockVersionOptions<TRow> {
	/** The row's optimistic-lock version, or undefined for an unversioned row. */
	versionOf: (row: TRow) => number | undefined;
	/** Put `version` into the composed values sent to the server. */
	withVersion: (values: Record<string, unknown>, version: number) => Record<string, unknown>;
}

/**
 * Issue #638: follow the version steps our own successful saves made
 * (`ownSteps`: sent version -> returned version) from the version an edit was
 * based on. A version reached by someone else's save is never in `ownSteps`,
 * so the walk stops before it and the save is refused as a conflict.
 */
export function advanceLockVersion(
	basis: number,
	ownSteps: ReadonlyMap<number, number> | undefined
): number {
	let version = basis;
	const seen = new Set<number>();
	while (ownSteps?.has(version) && !seen.has(version)) {
		seen.add(version);
		version = ownSteps.get(version)!;
	}
	return version;
}

export interface RowSaveQueueOptions<TRow> {
	/** Send one update. `values` is the full editable value set. */
	save: (rowId: string | number, values: Record<string, unknown>) => Promise<TRow>;
	/** Build the full value set from a base row + this save's changed columns. */
	compose: (base: TRow, changes: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Latest row as currently displayed, called at SEND time. Base priority:
	 * in-burst confirmed result -> currentRow(rowId) -> the enqueue-time
	 * fallbackRow (which may predate an earlier save that already drained).
	 */
	currentRow?: (rowId: string | number) => TRow | undefined;
	/** Issue #638: whether a failed save was an optimistic-lock conflict (see above). */
	isConflict?: (err: unknown) => boolean;
	/** Issue #638: send the version the edit was based on (see above). */
	lock?: LockVersionOptions<TRow>;
}

export interface RowSaveQueue<TRow> {
	/**
	 * Queue `changes` for `rowId`. `fallbackRow` (the row as displayed when the
	 * edit started) is only used when no earlier save of this row has been
	 * confirmed within the current burst. `basisRow` (default `fallbackRow`)
	 * is the row the user's edit was based on; only its lock version is used.
	 */
	enqueue(
		rowId: string | number,
		fallbackRow: TRow,
		changes: Record<string, unknown>,
		basisRow?: TRow
	): Promise<TRow>;
}

export function createRowSaveQueue<TRow>(options: RowSaveQueueOptions<TRow>): RowSaveQueue<TRow> {
	interface Lane {
		tail: Promise<unknown>;
		pending: number;
		confirmed: TRow | undefined;
		/** The conflict that refused a save of this burst (Issue #638). */
		conflict: { error: unknown } | undefined;
	}
	const lanes = new Map<string | number, Lane>();
	// Issue #638: per row, the version steps our own saves made. Versions only
	// grow, so the map stays small; it lives as long as the page.
	const ownSteps = new Map<string | number, Map<number, number>>();

	function lockedValues(
		rowId: string | number,
		basisRow: TRow,
		values: Record<string, unknown>
	): { values: Record<string, unknown>; sent: number | undefined } {
		const basis = options.lock?.versionOf(basisRow);
		if (!options.lock || basis === undefined) return { values, sent: undefined };
		const sent = advanceLockVersion(basis, ownSteps.get(rowId));
		return { values: options.lock.withVersion(values, sent), sent };
	}

	function recordOwnStep(rowId: string | number, sent: number | undefined, saved: TRow): void {
		const returned = options.lock?.versionOf(saved);
		if (sent === undefined || returned === undefined || returned === sent) return;
		const steps = ownSteps.get(rowId) ?? new Map<number, number>();
		steps.set(sent, returned);
		ownSteps.set(rowId, steps);
	}

	return {
		enqueue(rowId, fallbackRow, changes, basisRow = fallbackRow) {
			const lane: Lane = lanes.get(rowId) ?? {
				tail: Promise.resolve(),
				pending: 0,
				confirmed: undefined,
				conflict: undefined
			};
			lanes.set(rowId, lane);
			lane.pending += 1;

			const run = async (): Promise<TRow> => {
				if (lane.conflict) throw lane.conflict.error;
				// Composed here, at send time - not when the edit was enqueued.
				const base = lane.confirmed ?? options.currentRow?.(rowId) ?? fallbackRow;
				const { values, sent } = lockedValues(rowId, basisRow, options.compose(base, changes));
				try {
					const saved = await options.save(rowId, values);
					recordOwnStep(rowId, sent, saved);
					lane.confirmed = saved;
					return saved;
				} catch (err) {
					if (options.isConflict?.(err)) lane.conflict = { error: err };
					throw err;
				}
			};
			const result = lane.tail.then(run, run);
			const settle = (): void => {
				lane.pending -= 1;
				if (lane.pending === 0) lanes.delete(rowId);
			};
			lane.tail = result.then(settle, settle);
			return result;
		}
	};
}
