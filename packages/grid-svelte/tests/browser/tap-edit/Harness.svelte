<script lang="ts">
	// #964 G1: the smallest editable grid for a real browser's touch input
	// (e2e/visual/grid-tap-edit.spec.ts). The checkbox editor does not fill its
	// cell, so the cell being edited has room around the editor to tap.
	//
	// #964 G2: `write-and-blur` stands in for an on-screen keypad wired by the
	// app (grid-touch-edit-design §5.1). Its press leaves focus on the editor;
	// its click writes into the focused editor (`input`, `change`) and then
	// blurs it, as the app's `onconfirm` does. `plain` is page that takes focus
	// away for real. A name of `refuse` is rejected by the save.
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
		if (edit.value === 'refuse') throw new Error('Refused');
		edits += 1;
		rows = rows.map((row) => (row.id === edit.rowId ? { ...row, [edit.field]: edit.value } : row));
	}

	function writeAndBlur() {
		const field = document.activeElement;
		if (!(field instanceof HTMLInputElement) || !field.closest('[data-grid-editor]')) return;
		field.value = writeText;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		field.dispatchEvent(new Event('change', { bubbles: true }));
		field.blur();
	}
	let writeText = $state('Written');
</script>

<main>
	<output data-testid="edits">{edits}</output>
	<div class="tools">
		<!-- Not a button: nothing here can take focus, like a keypad's key. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="key"
			data-testid="write-and-blur"
			onmousedown={(event) => event.preventDefault()}
			onclick={writeAndBlur}
		>
			Write
		</div>
		<label>Text to write <input data-testid="write-text" bind:value={writeText} /></label>
		<p data-testid="plain">Plain page</p>
	</div>
	<div class="frame">
		<BantoGrid {rows} {columns} getRowId={(row) => row.id} {onCellEdit} />
	</div>
</main>

<style>
	main {
		padding: var(--banto-space-4);
	}

	.tools {
		display: flex;
		gap: var(--banto-space-4);
		align-items: center;
	}

	.key {
		padding: var(--banto-space-2) var(--banto-space-4);
		border: 1px solid var(--banto-border);
		user-select: none;
	}

	.frame {
		height: 20rem;
	}
</style>
