/**
 * #714 F2: a form's `file` field sends through the app's attachments client
 * (`FieldDef.file.client`). A file chosen by one session must never go out
 * with the credentials of the next one (logout, then another login, while the
 * file's bytes are still being read), so the client is told whether it may
 * still send - and asks at the last moment, see below.
 *
 * `sendingWhile(schema, canSend, …)` returns `schema` with its file client
 * wrapped: every upload the form starts - the automatic one after a create
 * (`uploadPendingFiles`) AND the field's own upload / retry buttons on the
 * edit form - passes `{ canSend }` to the client as a fourth argument.
 *
 * The check that matters is the CLIENT's: it must ask `canSend()` after it
 * read the file's bytes, in the same synchronous stretch as the request
 * (`attachmentsAdmin.ts`'s `uploadAttachment` does). A check made here, or in
 * anything the client awaits, is a different turn of the event loop from the
 * send. An app that swaps in its own client keeps that contract.
 */
import type { FileFieldMeta, FormSchema } from '@banto/forms';

/** The fourth argument a file client gets from a `sendingWhile` schema. */
export interface UploadGuard {
	/** `false`: do not send (the session that chose the file has ended). */
	canSend: () => boolean;
}

type GuardedUpload = (
	resource: string,
	resourceId: string,
	file: File,
	guard: UploadGuard
) => Promise<FileFieldMeta>;

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
			const send = file.client.upload as GuardedUpload;
			return {
				...field,
				file: {
					...file,
					client: {
						...file.client,
						upload: async (resource: string, resourceId: string, chosen: File) => {
							// Early out only (no bytes read for nothing): the client's
							// own check, right before the request, is the real one.
							if (!canSend()) throw new Error(refusedMessage());
							try {
								return await send(resource, resourceId, chosen, { canSend });
							} catch (err) {
								// The client's refusal, in the app's own words.
								if (!canSend()) throw new Error(refusedMessage(), { cause: err });
								throw err;
							}
						}
					}
				}
			};
		})
	};
}
