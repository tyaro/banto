<script lang="ts">
	import { page } from '$app/state';
	import { PageHeader } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { itemsResource } from '#lib/banto/resources/items.js';
	import ResourceDetail from '#lib/resource/ResourceDetail.svelte';
	// [scaffold:attachments] begin
	import { AttachmentsPanel } from '@banto/attachments';
	import { isAttachmentsAvailable } from '#lib/banto/attachmentsAdmin.js';
	import { attachmentsClient } from '#lib/banto/attachmentsClient.js';
	import { confirmAction } from '#lib/confirm.svelte.js';
	// [scaffold:attachments] end

	// SvelteKit REUSES a page component between two [id] values (Issue #290);
	// the (app) layout keys the page on its route params, so reading the param
	// once is enough here and in ResourceDetail. Do not move this page out from
	// under that layout without re-checking it (e2e smoke scenario 3f).
	const id = page.params.id ?? '';
</script>

<div class="page">
	<PageHeader hideTitle title={m['resource.editTitle']({ resource: itemsResource.label })} />

	<ResourceDetail resource={itemsResource} {id}>
		<!-- [scaffold:attachments] begin -->
		<!--
			M20 demo wiring (docs/design/attachments-plan.md §3.8, deletable per
			docs/template-scope.md §3): `after` renders only once the record has
			loaded, so the panel never lists attachments for a not-found or
			errored record. Hidden entirely in demo mode
			(`isAttachmentsAvailable()` false) rather than showing an
			"unavailable" placeholder: below an otherwise complete form, an inert
			placeholder reads as more broken than simply absent.
		-->
		{#snippet after({ id: recordId, canWrite }: { id: number; canWrite: boolean })}
			{#if isAttachmentsAvailable()}
				<AttachmentsPanel
					client={attachmentsClient}
					resource="items"
					resourceId={String(recordId)}
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
		{/snippet}
		<!-- [scaffold:attachments] end -->
	</ResourceDetail>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		/* Readable form width (design.md §Phase 4), not the full page width. */
		max-width: 720px;
	}
</style>
