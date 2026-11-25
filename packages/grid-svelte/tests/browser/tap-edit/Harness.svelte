<script lang="ts">
	// #964 G1: the smallest editable grid for a real browser's touch input
	// (e2e/visual/grid-tap-edit.spec.ts). The checkbox editor does not fill its
	// cell, so the cell being edited has room around the editor to tap.
	import { BantoGrid, type CellEdit, type GridColumn } from '../../../src/index';

	type Row = { id: number; name: string; done: boolean; note: string };
	let rows = $state<Row[]>(
		Array.from({ length: 40 }, (_, i) => ({
			id: i + 1,
			name: `Name ${i + 1}`,
			done: false,
			note: `Note ${i + 1}`
		}))
	);
	let edits = $state(0);
	const columns: GridColumn<Row>[] = [
		{ id: 'name', header: 'Name', accessor: 'name', editable: true, width: 160 },
		{
			id: 'done',
			header: 'Done',
			accessor: 'done',
			editable: true,
			editor: 'checkbox',
			width: 240
		},
		{ id: 'note', header: 'Note', accessor: 'note', width: 160 }
	];

	function onCellEdit(edit: CellEdit<Row>) {
		edits += 1;
		rows = rows.map((row) => (row.id === edit.rowId ? { ...row, [edit.field]: edit.value } : row));
	}
</script>

<main>
	<output data-testid="edits">{edits}</output>
	<div class="frame">
		<BantoGrid {rows} {columns} getRowId={(row) => row.id} {onCellEdit} />
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
