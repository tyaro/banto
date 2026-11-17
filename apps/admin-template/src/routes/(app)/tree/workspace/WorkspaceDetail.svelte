<script lang="ts">
	/**
	 * Right pane of `/tree/workspace`: details of the row selected in the list.
	 * Free of the frame (see WorkspaceTree.svelte); empty state when no row is
	 * selected.
	 */
	import { EmptyState, StatusBadge } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import type { WorkspaceResult, WorkspaceRow } from './workspaceSample.js';

	interface Props {
		row: WorkspaceRow | null;
	}

	let { row }: Props = $props();

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

<div class="detail">
	{#if row}
		<dl>
			<dt>{m['tree.workspace.colEquipment']()}</dt>
			<dd>{row.equipmentLabel}</dd>
			<dt>{m['tree.workspace.colAt']()}</dt>
			<dd>{row.at}</dd>
			<dt>{m['tree.workspace.colItem']()}</dt>
			<dd>{row.item}</dd>
			<dt>{m['tree.workspace.colValue']()}</dt>
			<dd>{row.value}</dd>
			<dt>{m['tree.workspace.colResult']()}</dt>
			<dd><StatusBadge variant={VARIANT[row.result]} label={resultLabel(row.result)} /></dd>
		</dl>
	{:else}
		<EmptyState
			title={m['tree.workspace.detailEmptyTitle']()}
			description={m['tree.workspace.detailEmptyHint']()}
		/>
	{/if}
</div>

<style>
	.detail {
		padding: var(--banto-space-3);
	}

	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--banto-space-2) var(--banto-space-4);
		margin: 0;
		font-size: var(--banto-font-size-sm);
	}

	dt {
		color: var(--banto-text-muted);
	}

	dd {
		margin: 0;
	}
</style>
