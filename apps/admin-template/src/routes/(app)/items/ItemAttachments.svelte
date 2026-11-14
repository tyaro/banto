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
	import { AttachmentsPanel } from '@banto/attachments';
	import * as m from '#lib/paraglide/messages.js';
	import { isAttachmentsAvailable } from '#lib/banto/attachmentsAdmin.js';
	import { attachmentsClient } from '#lib/banto/attachmentsClient.js';
	import { confirmAction } from '#lib/confirm.svelte.js';

	interface Props {
		id: number;
		canWrite: boolean;
	}

	let { id, canWrite }: Props = $props();
</script>

{#if isAttachmentsAvailable()}
	<AttachmentsPanel
		client={attachmentsClient}
		resource="items"
		resourceId={String(id)}
		{canWrite}
		confirmDelete={(message) =>
			confirmAction({
				title: m['common.deleteConfirmTitle'](),
				message,
				confirmLabel: m['common.delete'](),
				danger: true
			})}
	/>
{/if}
