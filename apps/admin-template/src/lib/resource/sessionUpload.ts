/**
 * #714 F2: a form's `file` field sends through the app's attachments client
 * (`FieldDef.file.client`). A file chosen by one session must never go out
 * with the credentials of the next one (logout, then another login, while the
 * file's bytes are still being read), so the client is told whether it may
 * still send - and asks at the last moment.
 *
 * ## The contract: `uploadWhile`
 *
 * A file client used on a resource form (`ResourceDetail`) must say so
 * explicitly, by having `uploadWhile(resource, resourceId, file, guard)`
 * (`SessionGuardedUpload`). It must ask `guard.canSend()` AFTER it read the
 * file's bytes, in the same synchronous stretch as the request (no `await`
 * between the check and `fetch` / `invoke`), and send nothing on `false`.
 * `attachmentsAdmin.ts`'s `uploadAttachment` does; `attachmentsClient.ts`
 * exposes it as `uploadWhile`.
 *
 * `sendingWhile(schema, canSend, …)` returns `schema` with its file client
 * replaced by one whose `upload` goes through `uploadWhile`: every upload the
 * form starts - the automatic one after a create (`uploadPendingFiles`) AND
 * the field's own upload / retry buttons on the edit form.
 *
 * A client WITHOUT `uploadWhile` (a plain `FileFieldClient`) cannot give that
 * guarantee - its `upload` has nowhere to take the check. It is not run as if
 * it were protected: every upload through it is refused, with a message that
 * names what is missing. (Listing and deleting are unaffected.)
 */
import type { FileFieldClient, FileFieldMeta, FormSchema } from '@banto/forms';

/** What `uploadWhile` is handed besides the file. */
export interface UploadGuard {
	/** `false`: do not send (the session that chose the file has ended). */
	canSend: () => boolean;
}

/** The part of a file client that makes it usable on a resource form - see the module comment. */
export interface SessionGuardedUpload {
	uploadWhile(
		resource: string,
		resourceId: string,
		file: File,
		guard: UploadGuard
	): Promise<FileFieldMeta>;
}

export const UNGUARDED_CLIENT_MESSAGE =
	'This file client has no `uploadWhile` (see lib/resource/sessionUpload.ts): nothing was sent.';

/**
 * `client.upload` made to send only while `canSend()` holds (see the module
 * comment). Used for every upload a form starts (`sendingWhile`) and for the
 * attachments panel of an existing record (`ItemAttachments.svelte`).
 * `refusedMessage`: what a refused upload shows.
 */
export function guardUpload<M>(
	client: {
		upload(resource: string, resourceId: string, file: File): Promise<M>;
	},
	canSend: () => boolean,
	refusedMessage: () => string
): (resource: string, resourceId: string, file: File) => Promise<M> {
	return async (resource, resourceId, chosen) => {
		const target = client as unknown as Partial<SessionGuardedUpload>;
		if (typeof target.uploadWhile !== 'function') throw new Error(UNGUARDED_CLIENT_MESSAGE);
		// Early out only (no bytes read for nothing): the client's own check,
		// right before the request, is the real one.
		if (!canSend()) throw new Error(refusedMessage());
		try {
			return (await target.uploadWhile.call(client, resource, resourceId, chosen, {
				canSend
			})) as M;
		} catch (err) {
			// The client's refusal, in the app's own words.
			if (!canSend()) throw new Error(refusedMessage(), { cause: err });
			throw err;
		}
	};
}

/**
 * `fn` that does nothing once `canSend()` no longer holds: a panel mounted for
 * a session that has ended must not start the follow-up calls (the reload
 * after an upload that was already on its way, the delete the user confirmed
 * after the switch, thumbnails, downloads) with the NEXT session's credentials.
 */
export function whileLive<Args extends unknown[], R>(
	fn: (...args: Args) => Promise<R>,
	canSend: () => boolean,
	refusedMessage: () => string
): (...args: Args) => Promise<R> {
	return async (...args) => {
		if (!canSend()) throw new Error(refusedMessage());
		return fn(...args);
	};
}

/**
 * `schema` whose file client only sends while `canSend()` holds.
 * `refusedMessage`: what a refused upload shows on the file's row.
 */
export function sendingWhile(
	schema: FormSchema,
	canSend: () => boolean,
	refusedMessage: () => string
): FormSchema {
	if (!schema.fields.some((field) => field.type === 'file' && field.file)) return schema;
	return {
		...schema,
		fields: schema.fields.map((field) => {
			const file = field.file;
			if (field.type !== 'file' || !file) return field;
			const client = file.client;
			// Every call is made ON `client` (a client written with methods keeps its `this`).
			const guarded: FileFieldClient = {
				list: (resource, resourceId) => client.list(resource, resourceId),
				remove: (id) => client.remove(id),
				upload: guardUpload(client, canSend, refusedMessage)
			};
			return { ...field, file: { ...file, client: guarded } };
		})
	};
}
