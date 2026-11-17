/**
 * `createFormResource` composable (spec §3.4): loads initial values for
 * create/edit, dispatches to `create`/`update` on submit, and surfaces
 * server-side field errors. Mirrors refine's `useForm`.
 */
import { isProviderError, ProviderError, type FieldError } from './errors';
import { invalidate } from './invalidate';
import type { DeleteOneOptions } from './provider';
import { getDataProvider, notify } from './registry.svelte';

export interface FormResourceOptions {
	/**
	 * The toast text for a failed `submit()` that is not a validation error
	 * (Issue #637: a lost connection says "could not save, save again when it
	 * is back" instead of the provider's bare message). Default
	 * `ProviderError.message`.
	 */
	submitErrorMessage?: (err: unknown) => string;
	/**
	 * Issue #638: the caller resolves an optimistic-lock `conflict` itself (a
	 * diff dialog): `submit()` returns it as `conflict` and `remove()` leaves
	 * it in `lastError`, with no toast. Default `false` - a conflict is toasted
	 * like any other failure (and still returned).
	 */
	handlesConflict?: boolean;
}

/**
 * Issue #638: a save or delete was refused because someone else changed the
 * record first. `current` is their latest record when the backend sent it
 * (the wire's `current` is optional).
 */
export interface FormConflict {
	current: Record<string, unknown> | undefined;
}

export type SubmitResult<T> =
	{ ok: true; row: T } | { ok: false; fieldErrors: FieldError[]; conflict?: FormConflict };

/** The `conflict` a failed operation carries (Issue #638), or `null`. */
export function conflictOf(err: unknown): FormConflict | null {
	if (!isProviderError(err) || err.body.kind !== 'conflict') return null;
	const current = err.body.current;
	return {
		current:
			typeof current === 'object' && current !== null && !Array.isArray(current)
				? (current as Record<string, unknown>)
				: undefined
	};
}

export class FormResource<T> {
	initialValues: Record<string, unknown> | null = $state(null);
	loading = $state(false);
	saving = $state(false);
	error: ProviderError | null = $state(null);
	/**
	 * The failure of the last `submit()` / `remove()` (cleared when either
	 * starts; `null` after a success). Issue #638: lets a caller tell a
	 * delete refused by the optimistic lock from any other failure.
	 */
	lastError: ProviderError | null = $state(null);

	#resource: string;
	#id: string | number | undefined;
	#options: FormResourceOptions;

	constructor(resource: string, id?: string | number, options: FormResourceOptions = {}) {
		this.#resource = resource;
		this.#id = id;
		this.#options = options;
	}

	/** Load initial values: `getOne` when editing, `{}` when creating. */
	async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			this.initialValues =
				this.#id !== undefined
					? await getDataProvider().getOne<Record<string, unknown>>(this.#resource, this.#id)
					: {};
		} catch (err) {
			this.initialValues = null;
			this.error = isProviderError(err)
				? err
				: new ProviderError({ kind: 'other', message: String(err) });
		} finally {
			this.loading = false;
		}
	}

	/** create when constructed without an id, update otherwise. */
	async submit(values: Record<string, unknown>): Promise<SubmitResult<T>> {
		this.saving = true;
		this.lastError = null;
		try {
			const row =
				this.#id !== undefined
					? await getDataProvider().update<T>(this.#resource, this.#id, values)
					: await getDataProvider().create<T>(this.#resource, values);
			notify('success', '保存しました');
			invalidate(this.#resource);
			return { ok: true, row };
		} catch (err) {
			this.lastError = toProviderError(err);
			if (isProviderError(err) && err.body.kind === 'validation') {
				return { ok: false, fieldErrors: err.body.field_errors };
			}
			const conflict = conflictOf(err);
			if (conflict && this.#options.handlesConflict) {
				return { ok: false, fieldErrors: [], conflict };
			}
			notify(
				'error',
				this.#options.submitErrorMessage?.(err) ??
					(isProviderError(err) ? err.message : String(err))
			);
			return conflict ? { ok: false, fieldErrors: [], conflict } : { ok: false, fieldErrors: [] };
		} finally {
			this.saving = false;
		}
	}

	/**
	 * Delete the current record. No-op (returns false) when there is no id.
	 * `options.version` (Issue #638) deletes only while the record is still at
	 * that version; a refusal is in `lastError` (`kind: 'conflict'`).
	 */
	async remove(options?: DeleteOneOptions): Promise<boolean> {
		if (this.#id === undefined) return false;
		this.lastError = null;
		try {
			await getDataProvider().deleteOne(this.#resource, this.#id, options);
			notify('success', '削除しました');
			invalidate(this.#resource);
			return true;
		} catch (err) {
			this.lastError = toProviderError(err);
			if (!(this.#options.handlesConflict && conflictOf(err))) {
				notify('error', isProviderError(err) ? err.message : String(err));
			}
			return false;
		}
	}
}

function toProviderError(err: unknown): ProviderError {
	return isProviderError(err) ? err : new ProviderError({ kind: 'other', message: String(err) });
}

export function createFormResource<T>(
	resource: string,
	id?: string | number,
	options?: FormResourceOptions
): FormResource<T> {
	return new FormResource<T>(resource, id, options);
}
