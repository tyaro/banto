<script lang="ts">
	// #1036: the smallest grid for a real browser's layout of the sticky header
	// row (e2e/visual/grid-sticky-header.spec.ts). jsdom has no layout: only here
	// does a row really sit behind the header, and only here does a held key
	// send real auto-repeat keydowns.
	import { BantoGrid, type GridColumn } from '../../../src/index';

	type Row = { id: number; name: string; note: string };
	const rows: Row[] = Array.from({ length: 200 }, (_, i) => ({
		id: i + 1,
		name: `Name ${i + 1}`,
		note: `Note ${i + 1}`
	}));
	const columns: GridColumn<Row>[] = [
		{ id: 'name', header: 'Name', accessor: 'name', width: 160 },
		{ id: 'note', header: 'Note', accessor: 'note', width: 160 }
	];
	let opened = $state<number[]>([]);
</script>

<main>
	<p data-testid="opened">{opened.join(',')}</p>
	<div class="frame">
		<BantoGrid
			{rows}
			{columns}
			getRowId={(row) => row.id}
			onRowClick={(row) => (opened = [...opened, row.id])}
		/>
	</div>
</main>

<style>
	main {
		padding: var(--banto-space-4);
	}

	.frame {
		height: 20rem;
	}
</style>
