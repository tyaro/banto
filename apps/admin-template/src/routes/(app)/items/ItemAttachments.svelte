<!--
	M20 demo wiring (docs/design/attachments-plan.md §3.8, deletable per
	docs/template-scope.md §3): the attachments panel of one item, rendered in
	`ResourceDetail`'s `after` - by the detail page (`[id]/+page.svelte`) and by
	the list's drawer (`+page.svelte`, #591). `after` renders only once the
	record has loaded, so the panel never lists attachments for a not-found or
	errored record. Hidden entirely in demo mode (`isAttachmentsAvailable()`
	false) rather than showing an "unavailable" placeholder: below an otherwise
	complete form, an inert placeholder reads as more broken than simply absent.

	The scaffold's attachments remover deletes this file and the marked places
	that use it.
-->
<script lang="ts">
	import { AttachmentsPanel, type AttachmentsClient } from '@banto/attachments';
	import { currentSessionScope, isCurrentSessionScope } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { isAttachmentsAvailable } from '#lib/banto/attachmentsAdmin.js';
	import { attachmentsClient } from '#lib/banto/attachmentsClient.js';
	import { confirmAction } from '#lib/confirm.svelte.js';
	import { guardUpload, whileLive } from '#lib/resource/sessionUpload.js';

	interface Props {
		id: number;
		canWrite: boolean;
	}

	let { id, canWrite }: Props = $props();

	// #714: an upload goes out only while the session this panel was mounted
	// for is the live one (logout, or another user logging in, while the
	// file's bytes are still being read, sends nothing). The same check
	// `ResourceDetail`'s `file` field uses (`lib/resource/sessionUpload.ts`).
	// The calls that follow (the reload after an upload that was already on
	// its way, a confirmed delete, thumbnails, downloads) stop the same way.
	const scope = currentSessionScope();
	const live = () => isCurrentSessionScope(scope);
	const refused = () => m['connection.saveFailed']();
	const client: AttachmentsClient = {
		list: whileLive(attachmentsClient.list, live, refused),
		upload: guardUpload(attachmentsClient, live, refused),
		remove: whileLive(attachmentsClient.remove, live, refused),
		thumbnailUrl: whileLive(attachmentsClient.thumbnailUrl, live, refused),
		// The fetch can finish after the session changed (and after this panel
		// went away): the file is not saved then, the object URL is freed.
		downloadUrl: async (item) => {
			const url = await whileLive(attachmentsClient.downloadUrl, live, refused)(item);
			if (!live()) {
				URL.revokeObjectURL(url);
				throw new Error(refused());
			}
			return url;
		}
	};
</script>

{#if isAttachmentsAvailable()}
	<AttachmentsPanel
		{client}
		resource="items"
		resourceId={String(id)}
		{canWrite}
		canSave={live}
		confirmDelete={(message) =>
			confirmAction({
				title: m['common.deleteConfirmTitle'](),
				message,
				confirmLabel: m['common.delete'](),
				danger: true
			})}
	/>
{/if}
