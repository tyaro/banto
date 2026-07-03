<script lang="ts">
	import { BantoGrid, type CellEdit, type GridColumn } from '@banto/grid-svelte';
	import {
		createListResource,
		getDataProvider,
		getResource,
		invalidate,
		isProviderError,
		notify
	} from '@banto/admin-core';
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
			id: 'open',
			header: '',
			accessor: () => '',
			width: 70,
			resizable: false,
			sortable: false,
			cell: (row) => ({ text: '開く', href: `/items/${row.id}` })
		},
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
			filterType: 'text',
			editable: true,
			editor: 'text',
			// Same rules/messages as itemsSchema.name (src/lib/banto/setup.ts).
			validate: (value) => {
				const str = String(value ?? '');
				if (str.length === 0) return '必須項目です';
				if (str.length > 40) return '40文字以内で入力してください';
				return null;
			}
		},
		{
			id: 'price',
			header: '価格',
			accessor: 'price',
			width: 120,
			align: 'right',
			filterable: true,
			filterType: 'number',
			format: (value) => `¥${(value as number).toLocaleString()}`,
			editable: true,
			editor: 'number',
			// Same rules/messages as itemsSchema.price (src/lib/banto/setup.ts).
			validate: (value) => {
				const num = Number(value);
				if (num < 0) return '0以上で入力してください';
				if (num > 99999) return '99999以下で入力してください';
				return null;
			}
		},
		{
			id: 'stock',
			header: '在庫',
			accessor: 'stock',
			width: 100,
			align: 'right',
			filterable: true,
			filterType: 'number',
			editable: true,
			editor: 'number',
			// Same rule/message as itemsSchema.stock (src/lib/banto/setup.ts).
			validate: (value) => {
				const num = Number(value);
				if (num < 0) return '0以上で入力してください';
				return null;
			}
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

	/** Merge one edited field onto the row's other current values (DataProvider.update expects the full editable value set). */
	function mergedValues(row: Item, field: string, value: unknown): Record<string, unknown> {
		return { name: row.name, price: row.price, stock: row.stock, [field]: value };
	}

	// M3 (spec §4.5): commit a single inline cell edit. A validation error
	// from the provider is re-thrown as a plain Error so BantoGrid re-enters
	// edit mode on that cell and shows the message inline (first field error
	// only - the grid can only display one message per cell); any other
	// provider error is unexpected, so it's also toasted before rethrowing.
	async function handleCellEdit(edit: CellEdit<Item>) {
		try {
			await getDataProvider().update('items', edit.rowId, mergedValues(edit.row, edit.field, edit.value));
			invalidate('items');
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				throw new Error(err.body.field_errors[0]?.message ?? err.message);
			}
			notify('error', isProviderError(err) ? err.message : String(err));
			throw err;
		}
	}

	// M3 (spec §4.5): a pasted TSV range can touch several rows/columns at
	// once. Group by row so multi-column pastes on one row become a single
	// `update()` call with all of that row's edited fields merged.
	async function handleRangePaste(edits: CellEdit<Item>[], info: { skipped: number }) {
		const byRow = new Map<string | number, { row: Item; values: Record<string, unknown> }>();
		for (const edit of edits) {
			const entry = byRow.get(edit.rowId) ?? {
				row: edit.row,
				values: { name: edit.row.name, price: edit.row.price, stock: edit.row.stock }
			};
			entry.values[edit.field] = edit.value;
			byRow.set(edit.rowId, entry);
		}

		let updated = 0;
		for (const [rowId, entry] of byRow) {
			try {
				await getDataProvider().update('items', rowId, entry.values);
				updated++;
			} catch (err) {
				notify('error', isProviderError(err) ? err.message : String(err));
			}
		}

		if (updated > 0) {
			invalidate('items');
			notify('success', `${updated}件更新しました`);
		}
		if (info.skipped > 0) {
			notify('info', `${info.skipped}セルはスキップされました`);
		}
	}
</script>

<div class="page">
	<div class="page-header">
		<h2>{resource.label}</h2>
		<button type="button" onclick={() => goto('/items/new')}>新規作成</button>
	</div>

	<p class="note">
		{list.totalCount.toLocaleString()}件のデータを表示しています。Tauri実行時はRust+SQLite（1,000件シード）、ブラウザ実行時はInMemoryDataProvider（10,000件）を使用（M2
		Phase B）。セル編集（ダブルクリック/Enter）・範囲選択・コピー&ペースト対応（M3）。
	</p>

	{#if list.loading && list.rows.length === 0}
		<p class="loading">読み込み中…</p>
	{:else}
		<div class="grid-wrap">
			<BantoGrid
				rows={list.rows}
				{columns}
				getRowId={(item) => item.id}
				onRowClick={handleRowClick}
				onCellEdit={handleCellEdit}
				onRangePaste={handleRangePaste}
			/>
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
