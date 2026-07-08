/**
 * Mirrors `crates/banto-core/src/error.rs` `ErrorBody` exactly: a `kind` tag
 * field with snake_case variant names, so provider errors can flow to/from
 * Rust unchanged once `TauriDataProvider` lands in Phase B.
 */

export interface FieldError {
	field: string;
	message: string;
}

export type ErrorBody =
	| { kind: 'not_found'; resource: string; id: string }
	| { kind: 'validation'; field_errors: FieldError[] }
	| { kind: 'unauthorized' }
	/**
	 * Spec M10 RBAC: the caller is authenticated but their role does not
	 * permit this action (e.g. a `viewer` calling a mutating endpoint, or a
	 * non-`admin` calling a `/api/users`/`users_*` route). Mirrors
	 * `crates/banto-core/src/error.rs`'s `BantoError::Forbidden` /
	 * `ErrorBody::Forbidden` exactly (no extra fields) - distinct from
	 * `unauthorized` (no/invalid session at all).
	 */
	| { kind: 'forbidden' }
	| { kind: 'storage'; message: string }
	| { kind: 'other'; message: string };

function describe(body: ErrorBody): string {
	switch (body.kind) {
		case 'not_found':
			return `resource not found: ${body.resource}/${body.id}`;
		case 'validation':
			return 'validation failed';
		case 'unauthorized':
			return 'unauthorized';
		// Same convention as 'unauthorized' above (a plain describe() string,
		// not necessarily what a UI shows directly) except this one IS the
		// user-facing message the RBAC-gated pages/usersAdmin.ts toast
		// verbatim via `ProviderError.message` — a `forbidden` is always the
		// direct result of a role check the user can understand ("you're not
		// allowed to do that"), unlike 'unauthorized', which normally never
		// reaches a toast at all (it triggers a redirect to /login instead).
		case 'forbidden':
			return 'この操作を行う権限がありません';
		case 'storage':
			return `storage error: ${body.message}`;
		case 'other':
			return body.message;
	}
}

/** Thrown by DataProvider/AuthProvider implementations; carries the wire-shaped `ErrorBody`. */
export class ProviderError extends Error {
	readonly body: ErrorBody;

	constructor(body: ErrorBody) {
		super(describe(body));
		this.name = 'ProviderError';
		this.body = body;
	}
}

export function isProviderError(error: unknown): error is ProviderError {
	return error instanceof ProviderError;
}

export function notFound(resource: string, id: string | number): ProviderError {
	return new ProviderError({ kind: 'not_found', resource, id: String(id) });
}

export function validation(fieldErrors: FieldError[]): ProviderError {
	return new ProviderError({ kind: 'validation', field_errors: fieldErrors });
}
