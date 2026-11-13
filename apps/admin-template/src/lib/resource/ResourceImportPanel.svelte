<!--
	@component
	The CSV import confirmation panel of `ResourceListPage` (spec M15 Phase C,
	ADR-0030 stage 5). Shows what the selected file would do - the header check,
	the rules (`csv.import.rules`; production builds too, #565), the create /
	update / error counts, the first rows (#218) and every row error - and runs
	or cancels it. The page owns the state (`csvImport.ts` builds it); this only
	renders it.
-->
<script lang="ts">
	import { StatusBadge } from '@banto/ui';
	import type { GridColumn } from '@banto/grid-svelte';
	import * as m from '#lib/paraglide/messages.js';
	import {
		canRunImport,
		importRowKind,
		importStatusVariant,
		previewRows,
		type ImportPreviewState
	} from './csvImport';
	import type { ResourceRow } from './types';

	interface Props {
		preview: ImportPreviewState;
		/** The list's base columns: header labels for field names. */
		columns: GridColumn<ResourceRow>[];
		/** `csv.import.rules`. */
		rules: string;
		/** Fields of the preview table, after line / action / ID. */
		previewFields: string[];
		/** Right-aligned preview fields (schema `number`). */
		numeric: Set<string>;
		submitting: boolean;
		onRun: () => void;
		onCancel: () => void;
	}

	let { preview, columns, rules, previewFields, numeric, submitting, onRun, onCancel }: Props =
		$props();

	const ERROR_LIST_LIMIT = 20;

	/** Column header label for a field / error `columnId`, falling back to the raw id. */
	function columnLabel(columnId: string): string {
		return columns.find((column) => column.id === columnId)?.header || columnId;
	}

	function joinLabels(labels: string[]): string {
		return labels.join(m['resource.listSeparator']());
	}

	/**
	 * `convertCsvRow`'s per-cell errors come in two shapes: a parse failure
	 * already embeds `"${column.header}: "`, a `column.validate` failure does
	 * not. Normalize both to `"label: message"` without doubling the label.
	 */
	function formatCsvError(columnId: string, message: string): string {
		const prefix = `${columnLabel(columnId)}: `;
		return message.startsWith(prefix) ? message : `${prefix}${message}`;
	}

	const variant = $derived(importStatusVariant(preview));
	const statusLabel = $derived.by((): string => {
		if (preview.missingRequired.length > 0) return m['resource.importMissingRequired']();
		if (preview.serverErrors && preview.serverErrors.length > 0)
			return m['resource.importFailedShort']();
		if (preview.rows.some((row) => row.errors.length > 0)) return m['resource.importNeedsReview']();
		return m['resource.importReady']();
	});
</script>

<section class="import-panel import-panel--{variant}">
	<header class="import-panel-header">
		<StatusBadge {variant} label={statusLabel} />
		<h3>{preview.fileName}</h3>
	</header>
	{#if preview.missingRequired.length > 0}
		<p class="panel-text">
			{m['resource.importMissingRequiredDetail']({
				columns: joinLabels(preview.missingRequired.map(columnLabel))
			})}
		</p>
	{:else}
		{@const errorRows = preview.rows.filter((row) => row.errors.length > 0)}
		<p class="panel-text muted" data-testid="import-rules">{rules}</p>
		{@const createCount = preview.rows.filter((row) => row.id === undefined).length}
		{@const updateCount = preview.rows.filter((row) => row.id !== undefined).length}
		<p class="panel-text summary">
			{m['resource.importSummary']({
				create: createCount,
				update: updateCount,
				error: errorRows.length,
				total: preview.rows.length
			})}
		</p>
		{#if preview.ignoredHeaders.length > 0}
			<p class="panel-text muted">
				{m['resource.importIgnored']({ columns: joinLabels(preview.ignoredHeaders) })}
			</p>
		{/if}
		{#if preview.rows.length > 0}
			{@const shown = previewRows(preview.rows)}
			<p class="panel-text muted">
				{m['resource.importPreviewShown']({ shown: shown.length, total: preview.rows.length })}
			</p>
			<div class="preview-table-wrap">
				<table class="preview-table">
					<caption class="sr-only">{m['resource.importPreviewCaption']()}</caption>
					<thead>
						<tr>
							<th scope="col">{m['resource.importPreviewLine']()}</th>
							<th scope="col">{m['resource.importPreviewKind']()}</th>
							<th scope="col">ID</th>
							{#each previewFields as field (field)}
								<th scope="col" class={numeric.has(field) ? 'num' : undefined}>
									{columnLabel(field)}
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each shown as row (row.csvLine)}
							<tr class:has-error={row.errors.length > 0}>
								<td>{row.csvLine}</td>
								<td>
									<span class="kind kind--{importRowKind(row)}">
										{importRowKind(row) === 'update'
											? m['resource.importKindUpdate']()
											: m['resource.importKindCreate']()}
									</span>
								</td>
								<td>{row.id ?? '—'}</td>
								{#each previewFields as field (field)}
									<td class={numeric.has(field) ? 'num' : undefined}>
										{row.values[field] ?? '—'}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if updateCount > 0}
				<p class="panel-text muted">
					{m['resource.importUpdateNote']({
						count: updateCount,
						columns: joinLabels(preview.writtenFields.map(columnLabel))
					})}
				</p>
			{/if}
		{/if}
		{#if errorRows.length > 0}
			<ul class="error-list">
				{#each errorRows.slice(0, ERROR_LIST_LIMIT) as row (row.csvLine)}
					<li>
						{m['resource.importErrorLine']({
							line: row.csvLine,
							message: row.errors.map((e) => formatCsvError(e.columnId, e.message)).join(' / ')
						})}
					</li>
				{/each}
			</ul>
			{#if errorRows.length > ERROR_LIST_LIMIT}
				<p class="panel-text muted">
					{m['resource.importMore']({ count: errorRows.length - ERROR_LIST_LIMIT })}
				</p>
			{/if}
		{/if}
		{#if preview.serverErrors}
			<p class="panel-text">
				{preview.applied
					? m['resource.importServerPartial'](preview.applied)
					: m['resource.importServerRollback']()}
			</p>
			<ul class="error-list">
				{#each preview.serverErrors.slice(0, ERROR_LIST_LIMIT) as serverError, i (i)}
					<li>
						{m['resource.importErrorLine']({
							line: preview.rows[serverError.row]?.csvLine ?? serverError.row + 2,
							message: serverError.message
						})}
					</li>
				{/each}
			</ul>
			{#if preview.serverErrors.length > ERROR_LIST_LIMIT}
				<p class="panel-text muted">
					{m['resource.importMore']({ count: preview.serverErrors.length - ERROR_LIST_LIMIT })}
				</p>
			{/if}
		{/if}
	{/if}
	<div class="actions">
		<button
			type="button"
			class="banto-btn banto-btn--primary"
			onclick={onRun}
			disabled={submitting || !canRunImport(preview)}
		>
			{submitting ? m['resource.importRunning']() : m['resource.importRun']()}
		</button>
		<button
			type="button"
			class="banto-btn banto-btn--ghost"
			onclick={onCancel}
			disabled={submitting}
		>
			{preview.applied ? m['common.close']() : m['common.cancel']()}
		</button>
	</div>
</section>

<style>
	/* CSV import result panel (design.md §Phase 4): success/warning/danger
	   distinguishable via the tint token pairs, StatusBadge carries the
	   variant icon so the state never depends on color alone. */
	.import-panel {
		flex: 0 0 auto;
		margin: 0 0 var(--banto-space-3);
		padding: var(--banto-space-3) var(--banto-space-4);
		border-radius: var(--banto-radius-lg);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
	}

	.import-panel--success {
		background: var(--banto-success-tint);
		border-color: transparent;
	}

	.import-panel--warning {
		background: var(--banto-warning-tint);
		border-color: transparent;
	}

	.import-panel--danger {
		background: var(--banto-danger-tint);
		border-color: transparent;
	}

	.import-panel-header {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		margin: 0 0 var(--banto-space-2);
	}

	.import-panel-header h3 {
		margin: 0;
		font-size: var(--banto-font-size-md);
		color: var(--banto-text-muted);
	}

	.panel-text {
		margin: 0 0 var(--banto-space-2);
		font-size: var(--banto-font-size-md);
	}

	.panel-text.summary {
		font-weight: 600;
	}

	.panel-text.muted {
		color: var(--banto-text-muted);
	}

	.import-panel--success .panel-text {
		color: var(--banto-success-tint-text);
	}

	.import-panel--warning .panel-text {
		color: var(--banto-warning-tint-text);
	}

	.import-panel--danger .panel-text {
		color: var(--banto-danger-tint-text);
	}

	.error-list {
		margin: 0 0 var(--banto-space-2);
		padding-left: var(--banto-space-5);
		max-height: 220px;
		overflow-y: auto;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text);
	}

	.error-list li {
		margin-bottom: var(--banto-space-1);
	}

	.preview-table-wrap {
		margin: 0 0 var(--banto-space-2);
		overflow-x: auto;
	}

	.preview-table {
		border-collapse: collapse;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text);
		background: var(--banto-surface);
	}

	.preview-table th,
	.preview-table td {
		padding: var(--banto-space-1) var(--banto-space-2);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		text-align: left;
		white-space: nowrap;
	}

	.preview-table .num {
		text-align: right;
	}

	.preview-table tr.has-error td {
		background: var(--banto-danger-tint);
	}

	/* 新規/更新は文字ラベル + 枠線の形（更新は破線）で区別し、色だけに依存しない。 */
	.kind {
		display: inline-block;
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		font-weight: 600;
	}

	.kind--update {
		border-style: dashed;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.actions {
		display: flex;
		gap: var(--banto-space-3);
	}
</style>
