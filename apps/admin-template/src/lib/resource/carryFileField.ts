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

/**
 * The values a form starts from when its record was (re)read from the server.
 *
 * - First load (`current === null`): the record, plus the files handed over
 *   from the create form (`leftovers`, the uploads that failed there) - used
 *   this once only.
 * - Reading the same record again (`current`: the store's values now): the
 *   record, plus the `file` field AS IT IS NOW. `leftovers` is ignored: a file
 *   retried (uploaded) or cancelled since the first load must not come back.
 */
export function valuesOnLoad(args: {
	record: Record<string, unknown>;
	fileFieldName: string | null;
	current: Record<string, unknown> | null;
	leftovers: readonly unknown[] | null;
}): Record<string, unknown> {
	const { record, fileFieldName, current, leftovers } = args;
	if (fileFieldName === null) return record;
	if (current !== null) {
		const files = current[fileFieldName];
		return files === undefined ? record : { ...record, [fileFieldName]: files };
	}
	return leftovers
		? { ...record, [fileFieldName]: { existing: null, pending: leftovers } }
		: record;
}
