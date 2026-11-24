/**
 * Inline-edit session state machine (Svelte 5 runes), spec §4.5.
 *
 * One session at a time: `start` opens it on a (row id, field) pair, the
 * draft is parsed (`resolveDraft`) and committed (`commitValue`), and the
 * session ends by a no-op / successful save / `cancel`, or stays open with an
 * `error` (validation, a rejected save) for another try.
 *
 *   closed --start--> editing --commitValue--> pending --save ok--> closed
 *                        ^  |                     |
 *                        |  +--noop / no save-----+------------> closed
 *                        +--invalid / save rejected (error set)--+
 *
 * No DOM access and no dependency on BantoGrid's rows: the host passes what
 * changes over time (row identity, the row as currently displayed, the save
 * callback, the invalid-input message) as functions read at call time, so
 * swapped props are picked up without rebuilding the controller.
 *
 * Columns are never stored - a session names its column by FIELD ID and every
 * call takes the column as it is now. A column whose `editable` (or whole
 * definition) changes later is therefore seen on the next call, and the host
 * decides what an open session does about it (`cancel`).
 *
 * Focus is the host's job, but WHO may take it is session state (#212): the
 * claim below records whether this session still owns focus, so a late
 * continuation of an older session can never pull it back.
 */
import type { CellEdit, GridColumn } from './types';
import { parseCellInput, resolveSelectDraft } from './core/clipboard';
import { isColumnEditable, prepareCommit } from './core/edit';
import { getColumnValue } from './core/sort';

export interface EditSession {
	/** Unique per `start`, also when the same cell is reopened (#210). */
	sessionId: number;
	rowId: string | number;
	field: string;
	draft: unknown;
	error: string | null;
	/** A save (`onCellEdit`) is in flight; the editor is locked until it settles. */
	pending: boolean;
}

export interface EditHost<TRow> {
	getRowId: (row: TRow) => string | number;
	/**
	 * The session's row as displayed right now, or undefined when it is gone
	 * (deleted, filtered out, collapsed, unloaded). Read at the commit boundary.
	 */
	currentRow: () => TRow | undefined;
	/** The caller's `onCellEdit`, read when a commit is about to be saved. */
	save: () => ((edit: CellEdit<TRow>) => void | Promise<void>) | undefined;
	/** Message for a draft the column's editor type cannot parse. */
	invalidMessage: () => string;
}

export type ResolvedDraft = { ok: true; value: unknown } | { ok: false };

export class EditController<TRow> {
	session: EditSession | null = $state(null);

	// spec §4.5 / conventions §8 / #210: even reopening the same cell
	// starts a new session. Keep the counter after a session closes so a
	// delayed post-commit navigation cannot move a newer selection.
	#lastSessionId = 0;
	// The row as displayed when the session opened (`CellEdit.baseRow`). Kept
	// outside `session` so it stays the caller's object, not a $state proxy.
	#base: { sessionId: number; row: TRow } | null = null;
	// spec §4.5 / #212: explicit user intent, tracked separately from
	// incidental focus loss. Never reactive: only event handlers read it.
	#focus: { sessionId: number; owned: boolean } | null = null;
	readonly #host: EditHost<TRow>;

	constructor(host: EditHost<TRow>) {
		this.#host = host;
	}

	/** Whether the open session accepts input (open and not saving). */
	get interactive(): boolean {
		return this.session !== null && !this.session.pending;
	}

	/**
	 * Open a session on `row` / `column`, replacing any open one. Returns the
	 * new session, or null when the column is not editable for this row.
	 */
	start(column: GridColumn<TRow>, row: TRow): EditSession | null {
		if (!isColumnEditable(column, row)) return null;
		const sessionId = ++this.#lastSessionId;
		this.#focus = { sessionId, owned: true };
		this.#base = { sessionId, row };
		this.session = {
			sessionId,
			rowId: this.#host.getRowId(row),
			field: column.id,
			draft: getColumnValue(row, column),
			error: null,
			pending: false
		};
		return this.session;
	}

	/** Close the session without saving (Esc, the row or column going away). */
	cancel(): void {
		this.session = null;
	}

	setDraft(value: unknown): void {
		if (this.session) this.session.draft = value;
	}

	/** Whether `sessionId` is the most recently started session, open or not. */
	isLatest(sessionId: number): boolean {
		return this.#lastSessionId === sessionId;
	}

	/**
	 * Turn the draft into the value to commit, by the column's editor type.
	 * An unparsable draft marks the session invalid and returns `ok: false`.
	 */
	resolveDraft(column: GridColumn<TRow>): ResolvedDraft {
		const session = this.session;
		if (!session) return { ok: false };
		const editorType = column.editor ?? 'text';
		if (editorType === 'select') {
			// Never round-trip a select's draft through parseCellInput: it only
			// passes strings through unchanged, which would undo the onchange
			// handler's editorOptions resolution. Re-resolving here is
			// idempotent (and also covers the paste path never reaching this
			// function at all), and is what makes `prepareCommit`'s `draft ===
			// oldValue` no-op check work for select columns with non-string
			// (e.g. numeric) option values.
			// A draft that already is an option value keeps its type (`2` vs `'2'`).
			return { ok: true, value: resolveSelectDraft(session.draft, column.editorOptions) };
		}
		// Typed: a year-less date is this year's (the injected date input's
		// rule); a paste or CSV cell never guesses it (date-time-pickers §5.10).
		const parsed = parseCellInput(String(session.draft ?? ''), editorType, { typed: true });
		if (!parsed.ok) {
			this.session = { ...session, error: this.#host.invalidMessage() };
			return { ok: false };
		}
		return { ok: true, value: parsed.value };
	}

	/**
	 * Runs prepareCommit and, if it decides to commit, awaits the host's save.
	 * Returns whether the edit session closed. `row` is the row the editor was
	 * rendered for; a session that has since moved to another cell ignores it.
	 */
	async commitValue(column: GridColumn<TRow>, row: TRow, value: unknown): Promise<boolean> {
		const session = this.session;
		if (!session || session.rowId !== this.#host.getRowId(row) || session.field !== column.id)
			return false;
		const { sessionId, rowId } = session;
		// Re-resolve at the commit boundary too: a removed editor can emit
		// blur before the cancellation effect runs, carrying its old row.
		const currentRow = this.#host.currentRow();
		if (currentRow === undefined || this.#host.getRowId(currentRow) !== rowId) return false;
		const result = prepareCommit(column, currentRow, rowId, value);
		const baseRow = this.#base?.sessionId === sessionId ? this.#base.row : currentRow;

		if (result.kind === 'noop') {
			this.session = null;
			return true;
		}
		const settled = (error: string | null, pending: boolean): EditSession => ({
			sessionId,
			rowId,
			field: column.id,
			draft: value,
			error,
			pending
		});
		if (result.kind === 'invalid') {
			this.session = settled(result.message, false);
			return false;
		}

		const save = this.#host.save();
		if (!save) {
			this.session = null;
			return true;
		}
		this.session = settled(null, true);
		try {
			await save({ ...result.edit, baseRow });
			// The caller's save still completes, but only the session that
			// submitted it owns these UI updates (including the failure path).
			if (this.session?.sessionId !== sessionId) return false;
			this.session = null;
			return true;
		} catch (err) {
			if (this.session?.sessionId !== sessionId) return false;
			this.session = settled(err instanceof Error ? err.message : String(err), false);
			return false;
		}
	}

	// --- Focus claim (#212) ---

	/** Whether any session, open or closed, still has a claim to track. */
	get tracksFocus(): boolean {
		return this.#focus !== null;
	}

	/** Whether the latest session's claim is currently held. */
	get focusOwned(): boolean {
		return this.#focus?.owned ?? false;
	}

	/** Whether `sessionId` is the session holding the claim. */
	ownsFocus(sessionId: number): boolean {
		return this.#focus?.sessionId === sessionId && this.#focus.owned;
	}

	/** Record where the user's focus intent went; a no-op before the first session. */
	setFocusOwned(owned: boolean): void {
		if (this.#focus) this.#focus.owned = owned;
	}

	/** Take the claim back for `sessionId` (a fresh key action on its editor). */
	renewFocus(sessionId: number): void {
		if (this.#focus?.sessionId === sessionId) this.#focus.owned = true;
	}
}
