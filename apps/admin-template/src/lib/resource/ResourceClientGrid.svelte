<script lang="ts">
	/**
	 * クライアントモード (spec §4.1, M2-M4): fetch the whole dataset once
	 * (limit large enough to cover the demo) and let BantoGrid do client-side
	 * sort/filter/paging/grouping under virtualization.
	 *
	 * Rendered by ResourceListPage (ADR-0030 stage 4; formerly items'
	 * ItemsClientGrid) as one side of an `{#if}`, so the load-mode switch can
	 * fully mount/unmount whichever side is inactive: `createListResource`
	 * subscribes to `onInvalidate(<resource>)` in its constructor, so keeping
	 * both this and ResourceServerGrid always alive at the parent level would
	 * leave two live subscriptions (and two in-flight resources) at once.
	 * A plain `{#if}` in the parent already destroys this component (running
	 * the `$effect` cleanup below) when the switch flips to server.
	 */
	import { BantoGrid, GridState, type CellEdit, type GridColumn } from '@banto/grid-svelte';
	import { createListResource, invalidate } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import { LoadingState } from '@banto/ui';
	import type { ResourceRow } from './types';

	interface Props {
		/** The resource name (`createListResource` / `invalidate`). */
		resource: string;
		/** The resource's label, for the loading message. */
		label: string;
		columns: GridColumn<ResourceRow>[];
		/**
		 * Owned by the parent page (ResourceListPage) so its shared group-by
		 * <select> can call `state.setGroupBy(...)` directly (spec §4.3
		 * wiring pattern, same as ResourceServerGrid's own externally-owned
		 * GridState for reading sort/filters).
		 */
		state: GridState<ResourceRow>;
		/**
		 * The definition's `list.client.toRow` (e.g. a synthetic grouping
		 * field): every fetched row goes through it before BantoGrid sees it.
		 * Saves are still published as the raw rows, so it re-derives.
		 */
		toRow?: (row: ResourceRow) => ResourceRow;
		onRowClick: (row: ResourceRow) => void;
		onCellEdit: (edit: CellEdit<ResourceRow>) => Promise<ResourceRow>;
		onRangePaste: (
			edits: CellEdit<ResourceRow>[],
			info: { skipped: number }
		) => Promise<ResourceRow[]>;
		/**
		 * Issue #215: forwarded straight to BantoGrid's own `rowClass` prop so
		 * the parent page can highlight the row it was last opened/saved from
		 * (the round trip's "work position" marker) - same passthrough as
		 * `columns`/`state` above, no grid-mode-specific logic here.
		 */
		rowClass?: (row: ResourceRow) => string | undefined;
		/**
		 * Issue #284: lets the page's save queue read the row as currently
		 * displayed (publishSaved-updated) at SEND time. Called with a lookup on
		 * mount and `undefined` on teardown.
		 */
		registerCurrentRow?: (
			lookup: ((rowId: string | number) => ResourceRow | undefined) | undefined
		) => void;
	}

	let {
		resource,
		label,
		columns,
		state: gridState,
		toRow,
		onRowClick,
		onCellEdit,
		onRangePaste,
		rowClass,
		registerCurrentRow
	}: Props = $props();

	// The resource name is fixed for this instance (the page remounts per route).
	// svelte-ignore state_referenced_locally
	const name = resource;

	const list = createListResource<ResourceRow>(name, {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const rows = $derived(toRow ? list.rows.map(toRow) : list.rows);

	// Publish confirmed saves before allowing another edit (spec §4.5).
	// Replace by ID only: a changed query may have removed or moved the row.
	// Invalidation is synchronous with publication, superseding older GETs.
	function publishSaved(saved: ResourceRow[]): void {
		if (saved.length === 0) return;
		const byId = new Map(saved.map((row) => [row.id, row]));
		list.rows = list.rows.map((row) => byId.get(row.id) ?? row);
		invalidate(name);
	}

	$effect(() => {
		registerCurrentRow?.((rowId) => list.rows.find((row) => row.id === rowId));
		return () => registerCurrentRow?.(undefined);
	});

	async function handleCellEdit(edit: CellEdit<ResourceRow>): Promise<void> {
		publishSaved([await onCellEdit(edit)]);
	}

	async function handleRangePaste(
		edits: CellEdit<ResourceRow>[],
		info: { skipped: number }
	): Promise<void> {
		publishSaved(await onRangePaste(edits, info));
	}
</script>

<p class="note">{m['resource.rowCount']({ count: list.totalCount.toLocaleString() })}</p>

{#if list.loading && list.rows.length === 0}
	<div class="loading">
		<LoadingState label={m['resource.loadingData']({ resource: label })} />
	</div>
{:else}
	<div class="grid-wrap">
		<BantoGrid
			{rows}
			{columns}
			state={gridState}
			messages={gridMessages()}
			getRowId={(row) => row.id}
			{onRowClick}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			{rowClass}
		/>
	</div>
{/if}

<style>
	.note {
		flex: 0 0 auto;
		margin: 0 0 var(--banto-space-3);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.loading {
		flex: 1;
		display: grid;
		place-items: center;
		color: var(--banto-text-muted);
	}

	.grid-wrap {
		flex: 1;
		min-height: 0;
	}
</style>
