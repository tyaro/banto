<script lang="ts">
	import { PageHeader } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { itemsResource } from '#lib/banto/resources/items.js';
	import ResourceDetail from '#lib/resource/ResourceDetail.svelte';
</script>

<div class="page">
	<PageHeader hideTitle title={m['resource.createTitle']({ resource: itemsResource.label })} />

	<ResourceDetail resource={itemsResource} id={null} />
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
