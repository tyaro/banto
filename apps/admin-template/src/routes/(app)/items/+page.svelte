<!--
	The items list (ADR-0030 stage 4): `ResourceListPage` renders the page from
	`itemsResource`; this route only adds what is specific to items - the daily
	report button (an optional asset; the report remover cuts it) and the CSV import
	(TEMPORARY here until stage 5 moves it into the component via `csv.import`).
-->
<script lang="ts">
	import { convertCsvRow, mapCsvHeader, parseCsv, type GridColumn } from '@banto/grid-svelte';
	import { invalidate, isProviderError, notify } from '@banto/admin-core';
	import { Upload } from '@lucide/svelte';
	import { StatusBadge, type StatusBadgeVariant } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import { itemsResource } from '#lib/banto/resources/items.js';
	import { importItems, isItemsImportAvailable } from '#lib/banto/itemsAdmin.js';
	import { resourceColumns } from '#lib/resource/columns.js';
	import ResourceListPage from '#lib/resource/ResourceListPage.svelte';
	// [scaffold:report] begin
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { FileText } from '@lucide/svelte';
	// [scaffold:report] end
	import {
		importRowKind,
		previewRows,
		toImportPayload,
		type ImportRowPreview
	} from './importPreview';

	// --- M15 Phase C: CSV import (moves into ResourceListPage in stage 5) ---

	/** The list's base columns (the same set ResourceListPage builds), for header mapping and labels. `Item` has the index signature `ResourceRow` needs, so the narrowing cast is sound. */
	const columns = resourceColumns(itemsResource) as unknown as GridColumn<Item>[];

	/** CSV columns: every real `items` column except the synthetic 「開く」 link column - the same set the export writes, so a round-tripped export re-imports cleanly. */
	const csvColumns = columns.filter((column) => column.id !== 'open');

	interface ImportPreviewState {
		fileName: string;
		/** Header cells that matched no known column - shown as "無視される列". */
		ignoredHeaders: string[];
		/** Required columns (name/price/stock) missing from the header entirely - fatal, `rows` is left empty. */
		missingRequired: string[];
		rows: ImportRowPreview[];
		/** Populated after a submitted import comes back with row errors (all-or-nothing rollback, spec M15) - null before the first submit attempt. */
		serverErrors: { row: number; message: string }[] | null;
	}

	let importPreview: ImportPreviewState | null = $state(null);
	let importSubmitting = $state(false);
	let importFileInput: HTMLInputElement | undefined = $state();

	// Display-only classification of the current import preview into the
	// success/warning/danger status-panel tokens (design.md §Phase 4 CSV
	// result panel). Purely derived from state that already drives the
	// existing conditional markup below - no import/validation logic changes.
	const importStatusVariant = $derived.by((): StatusBadgeVariant => {
		if (!importPreview) return 'neutral';
		if (importPreview.missingRequired.length > 0) return 'danger';
		if (importPreview.serverErrors && importPreview.serverErrors.length > 0) return 'danger';
		if (importPreview.rows.some((row) => row.errors.length > 0)) return 'warning';
		return 'success';
	});

	const importStatusLabel = $derived.by((): string => {
		if (!importPreview) return '';
		if (importPreview.missingRequired.length > 0) return m['items.importMissingRequired']();
		if (importPreview.serverErrors && importPreview.serverErrors.length > 0)
			return m['items.importFailedShort']();
		if (importPreview.rows.some((row) => row.errors.length > 0))
			return m['items.importNeedsReview']();
		return m['items.importReady']();
	});

	const REQUIRED_IMPORT_COLUMN_IDS = ['name', 'price', 'stock'] as const;

	/** Column header label for an error's `columnId`, falling back to the raw id if unrecognized (e.g. a synthetic 'id' entry - see parseIdCell below). */
	function columnLabel(columnId: string): string {
		return columns.find((column) => column.id === columnId)?.header || columnId;
	}

	/**
	 * `convertCsvRow`'s per-cell errors come in two shapes: a parse failure
	 * already embeds `"${column.header}: "` (core/csv.ts), a `column.validate`
	 * failure does not. Normalize both to the same `"label: message"` shape
	 * for display, without doubling up the label when it's already there.
	 */
	function formatCsvError(columnId: string, message: string): string {
		const label = columnLabel(columnId);
		const prefix = `${label}: `;
		return message.startsWith(prefix) ? message : `${prefix}${message}`;
	}

	/**
	 * The `id` column isn't run through `convertCsvRow` (see buildImportPreview
	 * below) - its editor defaults to 'text' (baseColumns sets no `editor` on
	 * it), which would pass an empty cell through as `ok:false` under 'number'
	 * semantics or as a literal string under 'text' semantics, neither of
	 * which is "no id -> INSERT" (spec M15: "id あり→UPDATE / なし→INSERT").
	 * Parsed by hand instead: blank means "no id", anything else must be an
	 * integer.
	 */
	function parseIdCell(raw: string): { id?: number; error?: string } {
		const trimmed = raw.trim();
		if (trimmed === '') return {};
		const num = Number(trimmed);
		if (!Number.isFinite(num) || !Number.isInteger(num)) {
			return { error: m['items.importIdInvalid']() };
		}
		return { id: num };
	}

	/**
	 * Parse `text` (a selected CSV file's contents) into a preview the user
	 * confirms before anything is sent to the server. `id`/`updatedAt` are
	 * deliberately pulled out of the mapping passed to `convertCsvRow`: `id`
	 * needs its own optional-integer handling (parseIdCell, above) and
	 * `updatedAt` is a read-only column that must never be written back - both
	 * still count as recognized columns though (mapCsvHeader sees the FULL
	 * `csvColumns` set), so a header that names them is never misreported as
	 * an unrecognized/"無視される列" column.
	 */
	function buildImportPreview(fileName: string, text: string): ImportPreviewState | null {
		const parsed = parseCsv(text);
		if (parsed.length === 0) {
			notify('error', m['items.csvEmpty']());
			return null;
		}
		const [header, ...dataRows] = parsed;
		const { mapped, unknown } = mapCsvHeader<Item>(header, csvColumns);

		const missingRequired = REQUIRED_IMPORT_COLUMN_IDS.filter(
			(id) => !mapped.some((entry) => entry.column.id === id)
		);

		const idMapping = mapped.find((entry) => entry.column.id === 'id');
		const valueMapping = mapped.filter(
			(entry) => entry.column.id !== 'id' && entry.column.id !== 'updatedAt'
		);

		const rows: ImportRowPreview[] =
			missingRequired.length > 0
				? []
				: dataRows.map((cells, index) => {
						const csvLine = index + 2;
						const { values, errors } = convertCsvRow<Item>(cells, valueMapping);
						const rowErrors = errors.map((e) => ({ columnId: e.columnId, message: e.message }));

						let id: number | undefined;
						if (idMapping) {
							const idResult = parseIdCell(cells[idMapping.index] ?? '');
							if (idResult.error) rowErrors.push({ columnId: 'id', message: idResult.error });
							id = idResult.id;
						}

						return {
							csvLine,
							id,
							name: values.name,
							price: values.price,
							stock: values.stock,
							errors: rowErrors
						};
					});

		return { fileName, ignoredHeaders: unknown, missingRequired, rows, serverErrors: null };
	}

	function handleImportButtonClick(): void {
		if (!isItemsImportAvailable()) {
			notify('info', m['items.demoImportUnavailable']());
			return;
		}
		importFileInput?.click();
	}

	async function handleImportFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file (e.g. after fixing it) later
		if (!file) return;
		const text = await file.text();
		importPreview = buildImportPreview(file.name, text);
	}

	function cancelImport(): void {
		importPreview = null;
	}

	// Guarded a second time here (not just via the button's `disabled`, spec
	// M15: 実行ボタンを無効化) - the server runs the whole batch
	// all-or-nothing, so sending it with known-bad rows would just get every
	// row rejected together.
	async function executeImport(): Promise<void> {
		if (!importPreview) return;
		if (importPreview.missingRequired.length > 0) return;
		if (importPreview.rows.some((row) => row.errors.length > 0)) return;

		// Same validated rows the preview table above renders (issue #218).
		const payload = toImportPayload(importPreview.rows);

		importSubmitting = true;
		try {
			const result = await importItems(payload);
			if (result.errors.length > 0) {
				// Rolled back server-side (all-or-nothing) - keep the preview open
				// so the user can see exactly what to fix and retry.
				importPreview = { ...importPreview, serverErrors: result.errors };
				notify('error', m['items.importFailedCount']({ count: result.errors.length }));
			} else {
				notify(
					'success',
					m['items.importSucceeded']({ created: result.created, updated: result.updated })
				);
				invalidate('items');
				importPreview = null;
			}
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			importSubmitting = false;
		}
	}
</script>

<ResourceListPage resource={itemsResource}>
	<!-- [scaffold:report] begin -->
	<!-- M19 report demo (docs/design/report-plan.md §3.5, deletable per
	     docs/template-scope.md §3): ghost so it reads as a secondary,
	     non-mutating action alongside CSVエクスポート - no permission check, a
	     `viewer` can read a report same as they can export CSV. -->
	{#snippet actions()}
		<button
			type="button"
			class="banto-btn banto-btn--ghost"
			onclick={() => goto(resolve(`items/report`))}
		>
			<FileText size={16} aria-hidden="true" />
			{m['items.report']()}
		</button>
	{/snippet}
	<!-- [scaffold:report] end -->

	<!-- Rendered by ResourceListPage only with the `import` permission. -->
	{#snippet csvImport()}
		<button
			type="button"
			class="banto-btn banto-btn--secondary"
			title={m['items.importRules']()}
			onclick={handleImportButtonClick}
		>
			<Upload size={16} aria-hidden="true" />
			{m['items.importCsv']()}
		</button>
		<input
			class="file-input"
			type="file"
			accept=".csv,.txt"
			aria-label={m['items.importCsv']()}
			bind:this={importFileInput}
			onchange={handleImportFileChange}
		/>
	{/snippet}

	{#snippet beforeGrid()}
		{#if importPreview}
			<section class="import-panel import-panel--{importStatusVariant}">
				<header class="import-panel-header">
					<StatusBadge variant={importStatusVariant} label={importStatusLabel} />
					<h3>{importPreview.fileName}</h3>
				</header>
				{#if importPreview.missingRequired.length > 0}
					<p class="panel-text">
						{m['items.importMissingRequiredDetail']({
							columns: importPreview.missingRequired.map(columnLabel).join('、')
						})}
					</p>
				{:else}
					{@const errorRows = importPreview.rows.filter((row) => row.errors.length > 0)}
					<p class="panel-text muted" data-testid="import-rules">{m['items.importRules']()}</p>
					{@const createCount = importPreview.rows.filter((row) => row.id === undefined).length}
					{@const updateCount = importPreview.rows.filter((row) => row.id !== undefined).length}
					<p class="panel-text summary">
						{m['items.importSummary']({
							create: createCount,
							update: updateCount,
							error: errorRows.length,
							total: importPreview.rows.length
						})}
					</p>
					{#if importPreview.ignoredHeaders.length > 0}
						<p class="panel-text muted">
							{m['items.importIgnored']({ columns: importPreview.ignoredHeaders.join('、') })}
						</p>
					{/if}
					{#if importPreview.rows.length > 0}
						{@const shown = previewRows(importPreview.rows)}
						<p class="panel-text muted">
							{m['items.importPreviewShown']({
								shown: shown.length,
								total: importPreview.rows.length
							})}
						</p>
						<div class="preview-table-wrap">
							<table class="preview-table">
								<caption class="sr-only">{m['items.importPreviewCaption']()}</caption>
								<thead>
									<tr>
										<th scope="col">{m['items.importPreviewLine']()}</th>
										<th scope="col">{m['items.importPreviewKind']()}</th>
										<th scope="col">ID</th>
										<th scope="col">{columnLabel('name')}</th>
										<th scope="col" class="num">{columnLabel('price')}</th>
										<th scope="col" class="num">{columnLabel('stock')}</th>
									</tr>
								</thead>
								<tbody>
									{#each shown as row (row.csvLine)}
										<tr class:has-error={row.errors.length > 0}>
											<td>{row.csvLine}</td>
											<td>
												<span class="kind kind--{importRowKind(row)}">
													{importRowKind(row) === 'update'
														? m['items.importKindUpdate']()
														: m['items.importKindCreate']()}
												</span>
											</td>
											<td>{row.id ?? '—'}</td>
											<td>{row.name ?? '—'}</td>
											<td class="num">{row.price ?? '—'}</td>
											<td class="num">{row.stock ?? '—'}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						{#if updateCount > 0}
							<p class="panel-text muted">{m['items.importUpdateNote']({ count: updateCount })}</p>
						{/if}
					{/if}
					{#if errorRows.length > 0}
						<ul class="error-list">
							{#each errorRows.slice(0, 20) as row (row.csvLine)}
								<li>
									{m['items.importErrorLine']({
										line: row.csvLine,
										message: row.errors
											.map((e) => formatCsvError(e.columnId, e.message))
											.join(' / ')
									})}
								</li>
							{/each}
						</ul>
						{#if errorRows.length > 20}
							<p class="panel-text muted">
								{m['items.importMore']({ count: errorRows.length - 20 })}
							</p>
						{/if}
					{/if}
					{#if importPreview.serverErrors}
						<p class="panel-text">{m['items.importServerRollback']()}</p>
						<ul class="error-list">
							{#each importPreview.serverErrors.slice(0, 20) as serverError, i (i)}
								<li>
									{m['items.importErrorLine']({
										line: importPreview.rows[serverError.row]?.csvLine ?? serverError.row + 2,
										message: serverError.message
									})}
								</li>
							{/each}
						</ul>
						{#if importPreview.serverErrors.length > 20}
							<p class="panel-text muted">
								{m['items.importMore']({ count: importPreview.serverErrors.length - 20 })}
							</p>
						{/if}
					{/if}
				{/if}
				<div class="actions">
					<button
						type="button"
						class="banto-btn banto-btn--primary"
						onclick={executeImport}
						disabled={importSubmitting ||
							importPreview.missingRequired.length > 0 ||
							importPreview.rows.some((row) => row.errors.length > 0)}
					>
						{importSubmitting ? m['items.importRunning']() : m['items.importRun']()}
					</button>
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						onclick={cancelImport}
						disabled={importSubmitting}
					>
						{m['common.cancel']()}
					</button>
				</div>
			</section>
		{/if}
	{/snippet}
</ResourceListPage>

<style>
	/* Visually hidden but still focusable/clickable via the CSVインポート
	   button's importFileInput?.click() - same "real file input, no fake
	   input" approach as a plain native file picker, just not shown itself. */
	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

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

	.import-panel .actions {
		display: flex;
		gap: var(--banto-space-3);
	}
</style>
