<script lang="ts">
	import { page } from '$app/state';
	import { PageHeader } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { itemsResource } from '#lib/banto/resources/items.js';
	import ResourceDetail from '#lib/resource/ResourceDetail.svelte';
	// [scaffold:attachments] begin
	import ItemAttachments from '../ItemAttachments.svelte';
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
		<!-- M20 demo wiring (ItemAttachments.svelte has the details). -->
		{#snippet after({ id: recordId, canWrite }: { id: number; canWrite: boolean })}
			<ItemAttachments id={recordId} {canWrite} />
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
