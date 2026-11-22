/**
 * #714 F2: a `file` field is not a column of the record, so the optimistic-lock
 * conflict check ignores it - and `store.reset(record)` would wipe its value
 * (files still waiting to upload, with their reasons). `resetKeepingFile`
 * resets the store to `record` and puts the field's current value back.
 */
export interface ResettableStore {
	values: Record<string, unknown>;
	reset(values?: Record<string, unknown>): void;
}

export function resetKeepingFile(
	store: ResettableStore,
	fileFieldName: string | null,
	record: Record<string, unknown>
): void {
	const files = fileFieldName === null ? undefined : store.values[fileFieldName];
	store.reset(record);
	if (fileFieldName !== null && files !== undefined) {
		store.values = { ...store.values, [fileFieldName]: files };
	}
}
