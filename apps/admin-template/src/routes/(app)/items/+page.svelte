<!--
	The items list (ADR-0030): `ResourceListPage` renders the page from
	`itemsResource` (CSV import included, through `csv.import`); this route only
	adds the daily report button - an optional asset the report remover cuts.
-->
<script lang="ts">
	import { itemsResource } from '#lib/banto/resources/items.js';
	import ResourceListPage from '#lib/resource/ResourceListPage.svelte';
	// [scaffold:report] begin
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { FileText } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	// [scaffold:report] end
</script>

<ResourceListPage resource={itemsResource}>
	<!-- [scaffold:report] begin -->
	<!-- M19 report demo (docs/design/report-plan.md §3.5, deletable per
	     docs/template-scope.md §3): ghost so it reads as a secondary,
	     non-mutating action alongside CSVエクスポート - no permission check, a
	     `viewer` can read a report same as they can export CSV. -->
	{#snippet actions()}
		<button
			type="button"
			class="banto-btn banto-btn--ghost"
			onclick={() => goto(resolve(`items/report`))}
		>
			<FileText size={16} aria-hidden="true" />
			{m['items.report']()}
		</button>
	{/snippet}
	<!-- [scaffold:report] end -->
</ResourceListPage>
