<script lang="ts">
	import { BantoGrid, type GridColumn } from '@banto/grid-svelte';
	import { createListResource, getResource } from '@banto/admin-core';
	import { goto } from '$app/navigation';
	import type { Item } from '$lib/banto/sampleData';

	const resource = getResource('items');

	// M2: fetch the whole dataset once (limit large enough to cover the demo
	// 10k-row set) and let the grid keep doing client-side sort/filter/paging,
	// same as M1. M5 moves sort/filter/paging into ListParams so
	// InMemoryDataProvider (and later TauriDataProvider) do the work
	// server-side instead.
	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const columns: GridColumn<Item>[] = [
		{
			id: 'id',
			header: 'ID',
			accessor: 'id',
			width: 80,
			align: 'right',
			filterable: true,
			filterType: 'number'
		},
		{
			id: 'name',
			header: '商品名',
			accessor: 'name',
			width: 260,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'price',
			header: '価格',
			accessor: 'price',
			width: 120,
			align: 'right',
			filterable: true,
			filterType: 'number',
			format: (value) => `¥${(value as number).toLocaleString()}`
		},
		{
			id: 'stock',
			header: '在庫',
			accessor: 'stock',
			width: 100,
			align: 'right',
			filterable: true,
			filterType: 'number'
		},
		{
			id: 'updatedAt',
			header: '更新日',
			accessor: 'updatedAt',
			width: 140
		}
	];

	function handleRowClick(item: Item) {
		goto(`/items/${item.id}`);
	}
</script>

<div class="page">
	<div class="page-header">
		<h2>{resource.label}</h2>
		<button type="button" onclick={() => goto('/items/new')}>新規作成</button>
	</div>

	<p class="note">
		M2デモ: InMemoryDataProvider経由（createListResource）で{list.totalCount.toLocaleString()}件のサンプルデータを
		表示しています。Phase BでTauri/Rustに接続します。
	</p>

	{#if list.loading && list.rows.length === 0}
		<p class="loading">読み込み中…</p>
	{:else}
		<div class="grid-wrap">
			<BantoGrid rows={list.rows} {columns} getRowId={(item) => item.id} onRowClick={handleRowClick} />
		</div>
	{/if}
</div>

<style>
	.page {
		height: calc(100vh - var(--banto-shell-header-height) - 2.5rem);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex: 0 0 auto;
		margin-bottom: 0.5rem;
	}

	.page-header h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.page-header button {
		padding: 0.5rem 1rem;
		border: none;
		border-radius: var(--banto-radius);
		background: var(--banto-primary);
		color: var(--banto-text-inverse);
		font-weight: 600;
		cursor: pointer;
	}

	.page-header button:hover {
		background: var(--banto-primary-hover);
	}

	.note {
		flex: 0 0 auto;
		margin: 0 0 0.75rem;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
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
