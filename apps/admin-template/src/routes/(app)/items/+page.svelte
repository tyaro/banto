<!--
	The items list (ADR-0030): `ResourceListPage` renders the page from
	`itemsResource` (CSV import included, through `csv.import`); this route only
	adds the daily report button and the attachments panel of the detail drawer
	(#591) - optional assets the report / attachments removers cut.
-->
<script lang="ts">
	import { itemsResource } from '#lib/banto/resources/items.js';
	import ResourceListPage from '#lib/resource/ResourceListPage.svelte';
	// [scaffold:report] begin
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { FileText } from '@lucide/svelte';
	import { MenuItem } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	// [scaffold:report] end
	// [scaffold:attachments] begin
	import ItemAttachments from './ItemAttachments.svelte';
	// [scaffold:attachments] end
</script>

<ResourceListPage resource={itemsResource}>
	<!-- [scaffold:report] begin -->
	<!-- M19 report demo (docs/design/report-plan.md §3.5, deletable per
	     docs/template-scope.md §3): an entry of the list's "..." menu next to
	     the CSV export (#555) - no permission check, a `viewer` can read a
	     report same as they can export CSV. -->
	{#snippet actions()}
		<MenuItem
			label={m['items.report']()}
			icon={FileText}
			onSelect={() => goto(resolve(`items/report`))}
		/>
	{/snippet}
	<!-- [scaffold:report] end -->
	<!-- [scaffold:attachments] begin -->
	<!-- M20 demo wiring (ItemAttachments.svelte has the details), below the
	     form in the list's detail drawer. -->
	{#snippet detailAfter({ id, canWrite }: { id: number; canWrite: boolean })}
		<ItemAttachments {id} {canWrite} />
	{/snippet}
	<!-- [scaffold:attachments] end -->
</ResourceListPage>
