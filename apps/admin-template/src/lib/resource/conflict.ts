/**
 * Issue #638 (optimistic lock): the pure part of resolving a save that the
 * backend refused with `conflict` - which fields the other person changed,
 * what the dialog proposes for each, and the values a re-send carries.
 * `ResourceDetail` / `ConflictDialog` only draw and wire these.
 *
 * Three snapshots of one record:
 * - `base`: the record as this form loaded it (or last saved / resolved it);
 * - `current`: the other person's latest record (the conflict's `current`);
 * - `draft`: what this form would send now.
 */

/** The optimistic-lock version key a versioned record carries (Issue #638 PR-1). */
export const LOCK_VERSION_FIELD = 'version';

/** Which side a field of the re-sent record takes. */
export type ConflictChoice = 'theirs' | 'mine';

/** One field the other person changed, as the dialog shows it. */
export interface ConflictField {
	field: string;
	theirs: unknown;
	mine: unknown;
	/** `true` when this form also changed the field (the draft differs from `base`). */
	mineChanged: boolean;
}

/** Value equality for record values (numbers, strings, `null`, plain JSON). */
export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The record's lock version, or `undefined` when it is not a versioned record. */
export function lockVersionOf(row: Record<string, unknown> | null | undefined): number | undefined {
	const version = row?.[LOCK_VERSION_FIELD];
	return typeof version === 'number' && Number.isFinite(version) ? version : undefined;
}

/**
 * The fields (of `fields`, in that order) the other person changed: `current`
 * differs from what this form loaded. Fields only this form changed are not
 * conflicts - they are re-sent as they are.
 */
export function conflictFields(
	fields: readonly string[],
	base: Record<string, unknown>,
	current: Record<string, unknown>,
	draft: Record<string, unknown>
): ConflictField[] {
	return fields
		.filter((field) => !sameValue(base[field], current[field]))
		.map((field) => ({
			field,
			theirs: current[field],
			mine: draft[field],
			mineChanged: !sameValue(base[field], draft[field])
		}));
}

/**
 * The choice the "choose per field" view starts with: this form's value where
 * it changed the field too, the other person's where it did not (taking
 * "mine" there would silently revert their change to a value nobody chose).
 */
export function defaultConflictChoices(
	conflicts: readonly ConflictField[]
): Record<string, ConflictChoice> {
	const choices: Record<string, ConflictChoice> = {};
	for (const conflict of conflicts)
		choices[conflict.field] = conflict.mineChanged ? 'mine' : 'theirs';
	return choices;
}

/**
 * The values to re-send after a conflict: the draft, with each conflicting
 * field taken from the side `choices` names (missing = mine), and the lock
 * version of `current` - so the re-send is checked against the record the
 * user has just seen, and conflicts again if it changed once more.
 */
export function resolvedValues(
	draft: Record<string, unknown>,
	current: Record<string, unknown>,
	conflicts: readonly ConflictField[],
	choices: Readonly<Record<string, ConflictChoice>>
): Record<string, unknown> {
	const values: Record<string, unknown> = { ...draft };
	for (const { field } of conflicts) {
		if (choices[field] === 'theirs') values[field] = current[field];
	}
	const version = lockVersionOf(current);
	if (version !== undefined) values[LOCK_VERSION_FIELD] = version;
	return values;
}

/**
 * "Take theirs": the form becomes `current` (the new clean baseline), and only
 * this form's edits to fields the other person did NOT change stay on top, as
 * unsaved edits.
 */
export function keptEditsOverTheirs(
	fields: readonly string[],
	base: Record<string, unknown>,
	current: Record<string, unknown>,
	draft: Record<string, unknown>
): Record<string, unknown> {
	const kept: Record<string, unknown> = {};
	for (const field of fields) {
		const mineChanged = !sameValue(base[field], draft[field]);
		const theirsChanged = !sameValue(base[field], current[field]);
		if (mineChanged && !theirsChanged) kept[field] = draft[field];
	}
	return kept;
}

/**
 * The input typed while a save was in flight: the fields where the form's
 * current values differ from what was sent. The lock `version` is never input -
 * it is the server's metadata, and a stale one here would be put back on top
 * of the saved record's new version (the form would stay dirty and every
 * following save would conflict).
 */
export function inputTypedDuringSave(
	current: Readonly<Record<string, unknown>>,
	sent: Readonly<Record<string, unknown>>
): Record<string, unknown> {
	const typed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(current)) {
		if (key === LOCK_VERSION_FIELD) continue;
		if (JSON.stringify(value) !== JSON.stringify(sent[key])) typed[key] = value;
	}
	return typed;
}
