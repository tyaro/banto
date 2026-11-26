<script lang="ts">
	import BantoGrid from '../src/BantoGrid.svelte';
	import { GridState } from '../src/state.svelte';
	import type { GridColumn } from '../src/types';

	interface Row {
		id: number;
		name: string;
	}
	const columns: GridColumn<Row>[] = [{ id: 'name', header: '商品名', accessor: 'name' }];
	const state = new GridState<Row>(columns);
</script>

<BantoGrid
	rows={[]}
	{columns}
	{state}
	getRowId={(row: Row) => row.id}
	messages={{ emptyState: () => 'Plain text' }}
>
	{#snippet empty()}<button type="button">Custom empty</button>{/snippet}
</BantoGrid>
