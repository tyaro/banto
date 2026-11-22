<script lang="ts">
	/**
	 * Centre pane, "list" tab of `/tree/workspace`: the selected target's rows.
	 * Free of the frame (see WorkspaceTree.svelte). The selected row is the
	 * page's state (`selectedRowId`); a pick goes out through `onSelectRow`.
	 * Each row's first cell is a real button, so the keyboard and a screen
	 * reader reach the same action as a click (the row itself is not clickable).
	 */
	import { StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import type { WorkspaceResult, WorkspaceRow } from './workspaceSample.js';

	interface Props {
		/** Name of the target the rows belong to (the table's caption). */
		targetName: string;
		rows: WorkspaceRow[];
		selectedRowId: string | null;
		onSelectRow: (id: string) => void;
	}

	let { targetName, rows, selectedRowId, onSelectRow }: Props = $props();

	const VARIANT: Record<WorkspaceResult, 'success' | 'warning' | 'danger'> = {
		ok: 'success',
		warn: 'warning',
		ng: 'danger'
	};
	const resultLabel = (result: WorkspaceResult): string =>
		result === 'ok'
			? m['tree.workspace.resultOk']()
			: result === 'warn'
				? m['tree.workspace.resultWarn']()
				: m['tree.workspace.resultNg']();
</script>

<div class="list">
	<p class="hint">{m['tree.workspace.listHint']()}</p>
	<div class="scroller">
		<table>
			<caption>{m['tree.workspace.listCaption']({ target: targetName, n: rows.length })}</caption>
			<thead>
				<tr>
					<th scope="col">{m['tree.workspace.colAt']()}</th>
					<th scope="col">{m['tree.workspace.colEquipment']()}</th>
					<th scope="col">{m['tree.workspace.colItem']()}</th>
					<th scope="col">{m['tree.workspace.colValue']()}</th>
					<th scope="col">{m['tree.workspace.colResult']()}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr class:selected={row.id === selectedRowId}>
						<td>
							<button
								type="button"
								class="pick"
								aria-pressed={row.id === selectedRowId}
								onclick={() => onSelectRow(row.id)}
							>
								{row.at}
							</button>
						</td>
						<td>{row.equipmentLabel}</td>
						<td>{row.item}</td>
						<td class="num">{row.value}</td>
						<td><StatusBadge variant={VARIANT[row.result]} label={resultLabel(row.result)} /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.list {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		min-height: 0;
	}

	.hint {
		margin: 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.scroller {
		overflow: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--banto-font-size-sm);
	}

	caption {
		padding-block: var(--banto-space-2);
		text-align: start;
		font-weight: 600;
	}

	th,
	td {
		padding: var(--banto-space-2) var(--banto-space-3);
		border-bottom: var(--banto-border-width, 1px) solid var(--banto-border);
		text-align: start;
		white-space: nowrap;
	}

	.num {
		font-variant-numeric: tabular-nums;
	}

	tr.selected {
		background: color-mix(in srgb, var(--banto-primary) 14%, transparent);
	}

	.pick {
		padding: 0;
		border: 0;
		background: none;
		color: var(--banto-primary);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
