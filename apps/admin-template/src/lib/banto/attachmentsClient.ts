/**
 * Adapts `attachmentsAdmin.ts`'s free functions into the `AttachmentsClient`
 * shape `@banto/attachments`'s `AttachmentsPanel` expects (spec
 * `docs/design/attachments-plan.md` §3.7-§3.8, M20 unit C). This is the one place
 * app code and the transport-agnostic UI package meet - the package itself
 * never imports `attachmentsAdmin.ts` (spec: "アプリ固有 import なし"), and
 * this file is intentionally thin: it just renames/regroups the exports
 * below into the interface's method names, with no extra logic of its own.
 *
 * `isAttachmentsAvailable()` is exported from `attachmentsAdmin.ts`
 * directly (not wrapped here) - callers check it before ever mounting
 * `AttachmentsPanel` (see `items/[id]/+page.svelte`), since a demo-mode
 * mount would have nothing but rejected promises to show.
 */
import type { AttachmentsClient } from '@banto/attachments';
import type { SessionGuardedUpload } from '#lib/resource/sessionUpload.js';
import {
	listAttachments,
	uploadAttachment,
	deleteAttachment,
	getThumbnailUrl,
	getDownloadUrl
} from './attachmentsAdmin';

export const attachmentsClient: AttachmentsClient & SessionGuardedUpload = {
	list: listAttachments,
	upload: uploadAttachment,
	// #714 F2: what a resource form's `file` field sends through
	// (`lib/resource/sessionUpload.ts`) - the adapter asks `guard.canSend()`
	// right before the request leaves.
	uploadWhile: (resource, resourceId, file, guard) =>
		uploadAttachment(resource, resourceId, file, guard),
	remove: deleteAttachment,
	thumbnailUrl: getThumbnailUrl,
	downloadUrl: getDownloadUrl
};
