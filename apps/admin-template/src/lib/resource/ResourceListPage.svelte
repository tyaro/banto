<!--
	@component
	The list page of one resource (ADR-0030 §4, stage 4).

	`<ResourceListPage resource={definition}>` renders the whole page: the
	heading (`label` / `description`), the "View" menu (load mode, when the
	definition offers two; group-by, client grid only), the column menu, the
	"..." menu (CSV export and import with `csv.import` and its confirmation
	panel, plus the `actions` entries), "New" (the only button left in view, #555), the demo build's annotation, and the server /
	client grid with #215's restore (sort / filters / group-by per load mode,
	the last-opened row marker, the "saved row left the filter" notice), inline
	cell edits and range pastes through one per-row save queue (#284).

	What is offered follows `resourcePermissions` (ADR-0030 §5 - hidden, not
	disabled): "New" needs `create`, inline edits need `edit` (every column is
	read-only otherwise), CSV import needs `import` (create AND edit), export
	needs only `list`. The server's `RoleGuard` / Tauri's `require_role` stay the real
	check (conventions §1). A LAN viewer-public session is a `viewer`.

	Slots (snippets):
	- `actions`: extra `MenuItem`s at the start of the "..." menu (the items daily report).
	- `viewMenu`: extra entries at the end of the "View" menu.
	- `beforeGrid`: above the grid (KPIs etc.), below the import panel.
	- `annotation`: the demo annotation's paragraphs, instead of `demoNotes`.

	The definition is read ONCE, when the component is created (the (app)
	layout keys every page on its route).

	Like everything under `lib/resource/`, this must not import an optional
	asset (attachments, reports, ...; conventions §4, `verify:architecture`
	rule `resource-no-optional`): optional extras come in through the slots.
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import {
		ColumnsMenu,
		FilterChips,
		GridState,
		csvFilename,
		csvForExcel,
		filterRows,
		toCsv,
		type CellEdit,
		type GridColumn
	} from '@banto/grid-svelte';
	import {
		currentSessionScope,
		getDataProvider,
		invalidate,
		isProviderError,
		loadActiveListMode,
		loadLastOpenedId,
		loadListViewState,
		notify,
		saveActiveListMode,
		saveListViewState,
		takeLastEditedRecord
	} from '@banto/admin-core';
	import type { FormSchema } from '@banto/forms';
	import { goto } from '$app/navigation';
	import { Download, Ellipsis, Plus, SlidersHorizontal, Upload } from '@lucide/svelte';
	import { Menu, MenuGroup, MenuItem, PageHeader } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import { getBantoMode } from '#lib/banto/setup.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { resolveAppPath, type AppPath } from '#lib/appPath.js';
	import AnnotationButton from '#lib/components/AnnotationButton.svelte';
	import AnnotationDrawer from '#lib/components/AnnotationDrawer.svelte';
	import { detailHref, resourceColumns } from './columns';
	import {
		buildImportPreview,
		canRunImport,
		numericFields,
		previewImportFields,
		toImportPayload,
		withImportResult,
		type ImportPreviewState
	} from './csvImport';
	import {
		composeEditableValues,
		editableFieldNames,
		exportListParams,
		initialLoadMode,
		listLoadModes
	} from './listState';
	import { resourcePermissions } from './permissions';
	import { createRowSaveQueue } from './rowSaveQueue';
	import ResourceClientGrid from './ResourceClientGrid.svelte';
	import ResourceImportPanel from './ResourceImportPanel.svelte';
	import ResourceServerGrid from './ResourceServerGrid.svelte';
	import type { AppResourceDefinition, ListLoadMode, ResourceRow } from './types';

	interface Props {
		resource: AppResourceDefinition;
		actions?: Snippet;
		viewMenu?: Snippet;
		beforeGrid?: Snippet;
		annotation?: Snippet;
	}

	// `actions` is renamed: PageHeader's own `actions` snippet below shadows the name.
	let { resource, actions: extraActions, viewMenu, beforeGrid, annotation }: Props = $props();

	// Read once (see the component doc above); `untrack` says so explicitly.
	const def = untrack(() => resource);
	const name = def.name;
	const createHref = resolveAppPath(`${def.path}/new` as AppPath);

	// ADR-0030 §5 / spec M10 RBAC: a `viewer` gets a read-only list (no "New",
	// no inline cell editing below).
	const perms = $derived(resourcePermissions(def, sessionStore.role));

	// Issue #215: a list -> detail -> save/cancel -> list round trip must
	// restore the filter/sort the user had, not reset to the page's own
	// defaults. Persistence is `@banto/admin-core`'s `saveListViewState`/
	// `loadListViewState` (sessionStorage-backed, see that module's doc
	// comment) keyed per load mode - the client and server grids keep
	// independent GridStates/column sets (spec §4.1/§4.3), so their saved
	// sort/filters/groupBy must not bleed into each other.
	const CLIENT_VIEW_KEY = `${name}:client`;
	const SERVER_VIEW_KEY = `${name}:server`;

	// Issue #215/#255 (4th review): the session this page instance was built
	// for. Every list-state read/write below passes it: reads only return
	// state saved by this scope's owner (another account's - or the public
	// viewer's - search terms are never restored, however the identity
	// changed), and writes stop the moment the session ends or changes
	// owner, so this instance cannot save its (old session's) GridState back
	// on behalf of the next session. `(app)/+layout.svelte` rebuilds the page
	// for the new session, which captures a fresh scope.
	const scope = currentSessionScope();

	// M5 Phase A (spec §4.1, §10) / ADR-0030 decision 3: `server` only unless
	// the definition offers both (items does, as the demo of the switch).
	// Restored from the last mode the user had (#215) - without this,
	// `lastOpenedId`/the restored filters of whichever mode was actually
	// active on save would silently go unused. `initialLoadMode` never picks a
	// mode the resource does not offer.
	const loadModes = listLoadModes(def);
	const hasClient = loadModes.includes('client');
	const hasServer = loadModes.includes('server');
	let mode: ListLoadMode = $state(initialLoadMode(loadActiveListMode(scope, name), loadModes));
	$effect(() => {
		saveActiveListMode(scope, name, mode);
	});

	const MODE_LABELS: Record<ListLoadMode, () => string> = {
		client: () => m['resource.modeClient'](),
		server: () => m['resource.modeServer']()
	};

	const groupByOptions = hasClient ? (def.list?.groupBy ?? []) : [];

	const baseColumns = resourceColumns(def);

	/**
	 * Force every column's `editable` off without the `edit` permission (spec
	 * M10 RBAC): `editable: false` disables BantoGrid's inline cell editor for
	 * that column entirely, same mechanism already used for naturally
	 * read-only columns like `updatedAt`/`open`.
	 */
	function withWritePermission(cols: GridColumn<ResourceRow>[]): GridColumn<ResourceRow>[] {
		if (perms.edit) return cols;
		return cols.map((column) => (column.editable ? { ...column, editable: false } : column));
	}

	const columns = $derived(withWritePermission(baseColumns));

	// M5 Phase B (spec §4.3): the client grid may rework the column set (items
	// adds a derived grouping column and per-column aggregates) through
	// `list.client.columns`; the server grid keeps `columns` as-is (grouping
	// has no server-mode equivalent yet). The permission is applied again to
	// the callback's result: a column the callback adds (or re-enables) must
	// not hand a viewer an inline editor.
	const toClientRow = def.list?.client?.toRow;
	const clientColumns = $derived.by((): GridColumn<ResourceRow>[] => {
		const reworked = def.list?.client?.columns?.(columns);
		return reworked ? withWritePermission(reworked) : columns;
	});

	// Owned here (not inside the grids) so the group-by <select>, the column
	// menu and CSV export can read / drive them directly (spec §4.1/§4.3,
	// M15 Phase C).
	// svelte-ignore state_referenced_locally
	const clientGridState = new GridState<ResourceRow>(clientColumns);
	// svelte-ignore state_referenced_locally
	const serverGridState = new GridState<ResourceRow>(columns);

	// Issue #215: restore whatever sort/filters/groupBy this session last
	// left each mode with, BEFORE either grid's first render (plain
	// synchronous assignment, not inside an $effect - `state.svelte.ts`'s
	// setters below are perfectly ordinary property writes, no different
	// from the constructor's own seeding a few lines up). Deliberately NOT
	// `GridState.hydrate()`: that also restores column order/widths/hidden,
	// which is issue #168's scope, not this one's - mixing the two would
	// silently start persisting column layout as a side effect of this fix.
	// `knownFields` (#255 review): drop any restored sort/filter whose field
	// isn't one of THIS session's actual columns - a schema/column change
	// between sessions must not resurrect a filter/sort the current screen
	// has no column for (`loadListViewState`'s own doc comment has the full
	// reasoning). `groupBy` must also be one of the definition's candidates.
	if (hasClient) {
		// svelte-ignore state_referenced_locally
		const clientFieldIds = clientColumns.map((column) => column.id);
		const clientSnapshot = loadListViewState(scope, CLIENT_VIEW_KEY, clientFieldIds);
		if (clientSnapshot) {
			clientGridState.sort = clientSnapshot.sort;
			clientGridState.filters = clientSnapshot.filters;
			const groupBy = clientSnapshot.groupBy;
			if (
				groupBy &&
				clientFieldIds.includes(groupBy) &&
				groupByOptions.some((option) => option.field === groupBy)
			) {
				clientGridState.setGroupBy(groupBy);
			}
		}
	}
	if (hasServer) {
		// svelte-ignore state_referenced_locally
		const serverFieldIds = columns.map((column) => column.id);
		const serverSnapshot = loadListViewState(scope, SERVER_VIEW_KEY, serverFieldIds);
		if (serverSnapshot) {
			serverGridState.sort = serverSnapshot.sort;
			serverGridState.filters = serverSnapshot.filters;
		}
	}

	// Persist on every sort/filter/groupBy change - cheap (a small JSON blob
	// into sessionStorage) and keeps the saved snapshot live even if the user
	// never leaves this page instance before closing the tab mid-session.
	$effect(() => {
		if (!hasClient) return;
		saveListViewState(scope, CLIENT_VIEW_KEY, {
			sort: clientGridState.sort,
			filters: clientGridState.filters,
			groupBy: clientGridState.groupBy
		});
	});
	$effect(() => {
		if (!hasServer) return;
		saveListViewState(scope, SERVER_VIEW_KEY, {
			sort: serverGridState.sort,
			filters: serverGridState.filters
		});
	});

	// The row most recently opened for this RESOURCE (#215's "直前の作業位置
	// を見つけられるようにする" - via `rowClass` highlighting below, rather
	// than scroll restoration). Deliberately ONE value shared by both load
	// modes (admin-core's `saveLastOpenedId` doc comment explains why), and
	// deliberately NOT set from `handleRowClick` below: the "open" cell is a
	// plain link, so clicking it navigates via its own `href` and never runs
	// `onRowClick` at all once the grid has editable columns
	// (`packages/grid-svelte/src/BantoGrid.svelte`'s `handleCellClick` doc
	// comment). The one place every way of reaching the detail page actually
	// passes through is that page itself (ResourceDetail), so it calls
	// `saveLastOpenedId` on mount instead. Reading it once here is enough -
	// returning from the detail page always remounts this page.
	const lastOpenedId = loadLastOpenedId(scope, name);

	function handleRowClick(row: ResourceRow) {
		goto(detailHref(def, row.id));
	}

	/** Issue #215: highlight whichever row was last opened (any mode, any navigation path - see `lastOpenedId` above) - same `rowClass` mechanism audit-log's `+page.svelte` already uses for its selected-row accent. */
	function rowClass(row: ResourceRow): string | undefined {
		return lastOpenedId !== null && row.id === lastOpenedId
			? 'resource-row-last-opened'
			: undefined;
	}

	// Issue #215: "編集結果が絞り込みの条件から外れた場合も、フィルタを勝手に
	// 解除しない" - a detail page that just saved leaves a one-shot marker
	// (admin-core's `noteLastEditedRecord`/`takeLastEditedRecord`) with the
	// row's values AT SAVE TIME. Reusing `filterRows` (the exact function
	// BantoGrid's own client mode filters with) against the CURRENT mode's
	// restored filters answers "does this row still match?" without a round
	// trip - if not, explain it instead of silently clearing the filter.
	// Naturally one-shot and idempotent: `takeLastEditedRecord` clears the
	// marker on read, so a later re-run of this effect (e.g. `mode` toggled)
	// finds nothing and leaves `filterExclusionNotice` alone.
	let filterExclusionNotice: { id: string | number } | null = $state(null);
	$effect(() => {
		const record = takeLastEditedRecord(scope, name);
		if (!record) return;
		// #255 review: the CLIENT grid filters `toRow(row)`, which may add a
		// derived field a filter matches against (items' `category`). The
		// check must run through the exact same derivation the grid renders
		// and filters with, or such a filter always reports a false "excluded".
		const values = { ...record.values, id: record.id } as ResourceRow;
		const isClient = mode === 'client';
		const row = isClient && toClientRow ? toClientRow(values) : values;
		const activeColumns = isClient ? clientColumns : columns;
		const activeFilters = isClient ? clientGridState.filters : serverGridState.filters;
		if (filterRows([row], activeFilters, activeColumns).length === 0) {
			filterExclusionNotice = { id: record.id };
		}
	});

	// Issue #284: inline edits and range pastes share ONE per-row save queue.
	// Saves for the same row run in order, and each request body is composed at
	// send time from the previous save's confirmed row + only that save's
	// changed columns - never from the stale `edit.row` snapshot, which used to
	// make an overlapping save revert the earlier one's column.
	const editableFields = editableFieldNames(def.schema as FormSchema);
	let currentRowLookup: ((rowId: string | number) => ResourceRow | undefined) | undefined;
	const registerCurrentRow = (lookup: typeof currentRowLookup): void => {
		currentRowLookup = lookup;
	};
	const saveQueue = createRowSaveQueue<ResourceRow>({
		save: (rowId, values) => getDataProvider().update<ResourceRow>(name, rowId, values),
		compose: (row, changes) => composeEditableValues(editableFields, row, changes),
		currentRow: (rowId) => currentRowLookup?.(rowId)
	});

	// M3 (spec §4.5): commit a single inline cell edit. A validation error
	// from the provider is re-thrown as a plain Error so BantoGrid re-enters
	// edit mode on that cell and shows the message inline; any other
	// provider error is unexpected, so it's also toasted before rethrowing.
	//
	// BantoGrid's onCellEdit contract only understands `Error.message` - a
	// cell can display exactly one message, no structured shape - so when the
	// provider returns several field_errors (the full editable row is always
	// sent, so an edit to one field can surface a violation on another), we
	// must pick just one. Priority: the entry for the field the user actually
	// edited wins if present (that's the one they can see and fix inline);
	// only fall back to the first entry when the edited field itself has no
	// violation (rare - e.g. some other field was already invalid).
	//
	// Return the saved row to the resource-owning grid. It publishes that
	// row before invalidating, so the next edit merges against confirmed
	// values even while the follow-up list request is still in flight (spec §4.5).
	async function handleCellEdit(edit: CellEdit<ResourceRow>): Promise<ResourceRow> {
		try {
			return await saveQueue.enqueue(edit.rowId, edit.row, { [edit.field]: edit.value });
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				const fieldError =
					err.body.field_errors.find((fe) => fe.field === edit.field) ?? err.body.field_errors[0];
				throw new Error(fieldError?.message ?? err.message, { cause: err });
			}
			notify('error', isProviderError(err) ? err.message : String(err));
			throw err;
		}
	}

	// M3 (spec §4.5): a pasted TSV range can touch several rows/columns at
	// once. Group by row so multi-column pastes on one row become a single
	// queued save with all of that row's edited fields merged.
	async function handleRangePaste(
		edits: CellEdit<ResourceRow>[],
		info: { skipped: number }
	): Promise<ResourceRow[]> {
		const byRow = new Map<
			string | number,
			{ row: ResourceRow; changes: Record<string, unknown> }
		>();
		for (const edit of edits) {
			const entry = byRow.get(edit.rowId) ?? { row: edit.row, changes: {} };
			entry.changes[edit.field] = edit.value;
			byRow.set(edit.rowId, entry);
		}

		// Enqueue every row first (rows are independent lanes), then settle in
		// row order. A failed row only toasts; it never poisons later saves.
		const results = await Promise.allSettled(
			[...byRow].map(([rowId, entry]) => saveQueue.enqueue(rowId, entry.row, entry.changes))
		);
		const saved: ResourceRow[] = [];
		for (const result of results) {
			if (result.status === 'fulfilled') {
				saved.push(result.value);
			} else {
				const err = result.reason;
				notify('error', isProviderError(err) ? err.message : String(err));
			}
		}

		if (saved.length > 0) {
			notify('success', m['resource.updatedCount']({ count: saved.length }));
		}
		if (info.skipped > 0) {
			notify('info', m['resource.skippedCells']({ count: info.skipped }));
		}
		return saved;
	}

	// --- M15 Phase C: CSV export -------------------------------------------

	const exportOption = def.csv?.export;
	const toFolder = typeof exportOption === 'object' ? exportOption.toFolder : undefined;
	const canExport = $derived(perms.export && exportOption !== undefined && exportOption !== false);

	/** CSV columns: every real column except the synthetic "open" link column (its accessor is `() => ''` - a blank, useless CSV cell/header). The same set a re-import maps against, so a round-tripped export re-imports cleanly. */
	const csvColumns = $derived(columns.filter((column) => column.id !== 'open'));

	/** Trigger a browser download of `content` named `filename` via a temporary Blob object URL - same pattern as `packages/charts/src/core/export.ts`'s `downloadSvg`. */
	function downloadTextFile(content: string, filename: string, mimeType: string): void {
		const blob = new Blob([content], { type: mimeType });
		const url = URL.createObjectURL(blob);
		try {
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	let exporting = $state(false);

	// Export always reflects whichever grid is currently on screen: the
	// server grid's sort/filters are sent straight through to
	// getDataProvider().getList() (they ARE ListParams already); the client
	// grid instead applies sort/filters itself inside BantoGrid, so its
	// GridState is read the same way and forwarded through the same getList()
	// call - the DataProvider (InMemory/Tauri/REST) reproduces identical
	// filtering to what BantoGrid shows client-side (spec §4.1/§4.2 keep both
	// implementations in lockstep). Entries on a column that is not a real
	// resource column (a client-only derived field) are dropped
	// (`exportListParams`).
	async function handleExport(): Promise<void> {
		if (exporting) return;
		exporting = true;
		try {
			const active = mode === 'client' ? clientGridState : serverGridState;
			const validFields = new Set(csvColumns.map((column) => column.id));
			const { sort, filters } = exportListParams(active, validFields);

			const result = await getDataProvider().getList<ResourceRow>(name, {
				pagination: { offset: 0, limit: 20_000 },
				sort,
				filters
			});
			const csv = csvForExcel(toCsv(csvColumns, result.rows, { formulaSafe: true }));
			const filename = csvFilename(name);
			if (getBantoMode() === 'tauri' && toFolder) {
				// Desktop (finding⑤ Option A): WebView2 has no visible save
				// dialog for `<a download>`, so write into the app's
				// `exports/` folder and reveal it in Explorer instead - same
				// "no native save dialog in v1" fallback as
				// `openBackupsFolder`/backups' folder UX.
				const folderResult = await toFolder(csv, filename);
				// Always show the saved path (the folder opens on success, but
				// the toast makes the location explicit so the file is never
				// "missing"). `opened: false` = non-Windows, where no folder opens.
				notify(
					'success',
					folderResult.opened
						? m['resource.exportedToPath']({ count: result.rows.length, path: folderResult.path })
						: m['resource.exportedToPathClosed']({
								count: result.rows.length,
								path: folderResult.path
							})
				);
			} else {
				downloadTextFile(csv, filename, 'text/csv;charset=utf-8');
				notify('success', m['resource.exported']({ count: result.rows.length }));
			}
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			exporting = false;
		}
	}

	// --- M15 Phase C: CSV import (`csv.import`) -----------------------------

	const importOption = def.csv?.import;
	const canImport = $derived(perms.import && importOption !== undefined);
	const importPreviewFields = importOption ? previewImportFields(def, importOption) : [];
	const importNumericFields = numericFields(def);

	let importPreview: ImportPreviewState | null = $state(null);
	let importSubmitting = $state(false);
	let importFileInput: HTMLInputElement | undefined = $state();

	function handleImportButtonClick(): void {
		if (importOption?.available && !importOption.available()) {
			notify('info', m['resource.importUnavailable']());
			return;
		}
		importFileInput?.click();
	}

	async function handleImportFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file (e.g. after fixing it) later
		if (!file || !importOption) return;
		const text = await file.text();
		// Base columns, not the permission-narrowed ones: `editable` there marks
		// a writable schema field (the `import` permission implies `edit` anyway).
		const preview = buildImportPreview(def, importOption, baseColumns, file.name, text);
		if (!preview) notify('error', m['resource.csvEmpty']());
		importPreview = preview;
	}

	// Guarded a second time here (not just via the button's `disabled`, spec
	// M15: 実行ボタンを無効化) - items' server runs the whole batch
	// all-or-nothing, so sending it with known-bad rows would just get every
	// row rejected together.
	async function executeImport(): Promise<void> {
		const preview = importPreview;
		if (!preview || !importOption || !canRunImport(preview)) return;

		importSubmitting = true;
		try {
			// Same validated rows the preview table renders (issue #218).
			const result = await importOption.run(toImportPayload(preview.rows));
			if (result.errors.length > 0) {
				// Keep the panel open so the user sees exactly what to fix. A
				// partial apply (a `run` that is not all-or-nothing) still
				// changed rows: reload the list, and the run button stays off.
				importPreview = withImportResult(preview, result);
				if (result.created + result.updated > 0) {
					notify(
						'error',
						m['resource.importPartialCount']({
							count: result.errors.length,
							created: result.created,
							updated: result.updated
						})
					);
					invalidate(name);
				} else {
					notify('error', m['resource.importFailedCount']({ count: result.errors.length }));
				}
			} else {
				notify(
					'success',
					m['resource.importSucceeded']({ created: result.created, updated: result.updated })
				);
				// Both grids subscribe to `invalidate(<resource>)`: the server grid
				// refetches its blocks, the client grid its full list.
				invalidate(name);
				importPreview = null;
			}
		} catch (err) {
			notify('error', isProviderError(err) ? err.message : String(err));
		} finally {
			importSubmitting = false;
		}
	}

	const hasViewMenu = $derived(
		loadModes.length > 1 || groupByOptions.length > 0 || viewMenu !== undefined
	);
	const hasMoreMenu = $derived(
		canExport || (canImport && importOption !== undefined) || extraActions !== undefined
	);

	const demoNotes = def.demoNotes;
	const hasAnnotation = $derived(annotation !== undefined || demoNotes !== undefined);

	// FilterChips' last x / "clear all" removes the focused button itself;
	// hand focus to the grid instead of losing it to <body>.
	let pageEl: HTMLDivElement | undefined = $state();
	// Server mode only: chips change filters outside BantoGrid's header path.
	let serverGridRef: ReturnType<typeof ResourceServerGrid> | undefined = $state();
	function focusGrid() {
		pageEl?.querySelector<HTMLElement>('[role="grid"]')?.focus();
	}
</script>

<div class="page" bind:this={pageEl}>
	<PageHeader hideTitle title={def.label} description={def.description?.()}>
		{#snippet actions()}
			<!-- #555 (1): "New" is the only action left in view. Everything else is
			     in two menus: "View" (how the list looks) and "…" (what to do with
			     its data). The column manager stays a button next to "View": a
			     Menu item closes the menu on every pick, and a menu item has no
			     checkbox role, so a multi-toggle list does not fit one. -->
			{#if hasViewMenu}
				<Menu label={m['resource.viewMenu']()} placement="bottom-start">
					{#snippet trigger(props)}
						<button {...props} type="button" class="banto-btn banto-btn--ghost view-trigger">
							<SlidersHorizontal size={14} aria-hidden="true" />
							{m['resource.viewMenu']()}
						</button>
					{/snippet}
					{#if loadModes.length > 1}
						<MenuGroup label={m['resource.modeToggleAria']()}>
							{#each loadModes as option (option)}
								<MenuItem
									label={MODE_LABELS[option]()}
									checked={mode === option}
									onSelect={() => (mode = option)}
								/>
							{/each}
						</MenuGroup>
					{/if}
					{#if groupByOptions.length > 0}
						<!-- Grouping exists in the client grid only (spec §4.3): in server
						     mode the items stay visible but disabled, and the heading says why. -->
						<MenuGroup
							label={mode === 'client'
								? m['resource.groupByMenu']()
								: m['resource.groupByClientOnly']()}
						>
							<MenuItem
								label={m['resource.groupNone']()}
								checked={mode === 'client' && !clientGridState.groupBy}
								disabled={mode !== 'client'}
								onSelect={() => clientGridState.setGroupBy(null)}
							/>
							{#each groupByOptions as option (option.field)}
								<MenuItem
									label={option.label()}
									checked={mode === 'client' && clientGridState.groupBy === option.field}
									disabled={mode !== 'client'}
									onSelect={() => clientGridState.setGroupBy(option.field)}
								/>
							{/each}
						</MenuGroup>
					{/if}
					{@render viewMenu?.()}
				</Menu>
			{/if}
			<!-- Column manager (spec §4.4, issue #168): takes the SAME GridState
			     the active grid was handed, so hiding a column here immediately
			     drops it from that grid. Deliberately per-mode - the client and
			     server grids own separate GridStates (and separate column sets),
			     so one shared menu would show the wrong list for whichever mode
			     is not active. -->
			<ColumnsMenu
				state={mode === 'client' ? clientGridState : serverGridState}
				messages={gridMessages()}
			/>
			{#if hasMoreMenu}
				<Menu label={m['resource.moreMenu']()} placement="bottom-end">
					{#snippet trigger(props)}
						<button
							{...props}
							type="button"
							class={['banto-btn banto-btn--ghost more-trigger', exporting && 'banto-btn--loading']}
							aria-label={m['resource.moreMenu']()}
							aria-busy={exporting ? 'true' : undefined}
						>
							<!-- The menu closes on pick, so a running CSV export shows here
							     (same spinner as <Button loading>). -->
							{#if exporting}
								<span class="banto-btn__content"><Ellipsis size={16} aria-hidden="true" /></span>
								<span class="banto-btn__spinner" aria-hidden="true"></span>
							{:else}
								<Ellipsis size={16} aria-hidden="true" />
							{/if}
						</button>
					{/snippet}
					{@render extraActions?.()}
					{#if canExport}
						<MenuItem
							label={m['resource.exportCsv']()}
							icon={Download}
							disabled={exporting}
							onSelect={handleExport}
						/>
					{/if}
					{#if canImport && importOption}
						<MenuItem
							label={m['resource.importCsv']()}
							icon={Upload}
							onSelect={handleImportButtonClick}
						/>
					{/if}
				</Menu>
			{/if}
			{#if canImport && importOption}
				<input
					class="file-input"
					type="file"
					accept=".csv,.txt"
					aria-label={m['resource.importCsv']()}
					bind:this={importFileInput}
					onchange={handleImportFileChange}
				/>
			{/if}
			{#if perms.create}
				<button
					type="button"
					class="banto-btn banto-btn--primary create-btn"
					onclick={() => goto(createHref)}
				>
					<Plus size={16} aria-hidden="true" />
					{m['resource.create']()}
				</button>
			{/if}
			{#if hasAnnotation}
				<AnnotationButton />
			{/if}
		{/snippet}
	</PageHeader>

	<!-- At the page root, not in PageHeader's actions: the header is a
	     containing block for fixed descendants (annotation.svelte.ts). -->
	{#if hasAnnotation}
		<AnnotationDrawer>
			{#if annotation}
				{@render annotation()}
			{:else if demoNotes}
				{#each demoNotes() as note, i (i)}
					<p>{note}</p>
				{/each}
			{/if}
		</AnnotationDrawer>
	{/if}

	<!-- Issue #215: the row just saved may no longer match the filter the
	     user still has active (restored from this session, above). Never
	     clear that filter for them - explain the mismatch instead, and let
	     them dismiss the notice once they've seen it. -->
	{#if filterExclusionNotice}
		<div class="filter-exclusion-notice" role="status">
			<span>
				{m['resource.filterExcludedNotice']({ resource: def.label, id: filterExclusionNotice.id })}
			</span>
			<button
				type="button"
				class="banto-btn banto-btn--ghost"
				onclick={() => (filterExclusionNotice = null)}
			>
				{m['common.close']()}
			</button>
		</div>
	{/if}

	{#if importPreview && importOption && canImport}
		<ResourceImportPanel
			preview={importPreview}
			columns={baseColumns}
			rules={importOption.rules()}
			previewFields={importPreviewFields}
			numeric={importNumericFields}
			submitting={importSubmitting}
			onRun={executeImport}
			onCancel={() => (importPreview = null)}
		/>
	{/if}

	{@render beforeGrid?.()}

	<!-- #555 B-2: what the active mode's grid is filtered by, with x to remove.
	     Takes the same per-mode GridState as the grid below (and the Columns menu). -->
	<FilterChips
		state={mode === 'client' ? clientGridState : serverGridState}
		messages={gridMessages()}
		onEmpty={focusGrid}
		onchange={() => serverGridRef?.applyStateParams()}
	/>

	{#if mode === 'client'}
		<ResourceClientGrid
			resource={name}
			label={def.label}
			columns={clientColumns}
			state={clientGridState}
			toRow={toClientRow}
			onRowClick={handleRowClick}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			{rowClass}
			{registerCurrentRow}
		/>
	{:else}
		<ResourceServerGrid
			bind:this={serverGridRef}
			resource={name}
			{columns}
			state={serverGridState}
			onRowClick={handleRowClick}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			{rowClass}
			{registerCurrentRow}
		/>
	{/if}
</div>

<style>
	.page {
		height: calc(100vh - var(--banto-shell-header-height) - 2.5rem);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	/* Priority-ordered toolbar (design.md §Phase 4, #555): the "View" and "..."
	   menus stay ghost, "New" is the sole primary action.
	   DOM order is left as it always was; only "New" is pulled to the front
	   once the toolbar wraps under 768px, below. */
	.view-trigger,
	.more-trigger {
		height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
	}

	/* Visually hidden but still clickable through the import button's
	   importFileInput?.click() - a real file input, just not shown itself. */
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

	/* 768px 前後で折り返した際、主要操作（新規作成）を先頭に維持する
	   (design.md §Phase 4)。 */
	@media (max-width: 48rem) {
		.create-btn {
			order: -1;
		}
	}

	/* Issue #215: same info-tint idiom as the import panel's success/warning/
	   danger variants, but neutral - this isn't an error, just context the
	   user should know about before it's dismissed. */
	.filter-exclusion-notice {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-3);
		margin: 0 0 var(--banto-space-3);
		padding: var(--banto-space-2) var(--banto-space-3);
		border-left: 3px solid var(--banto-primary);
		border-radius: var(--banto-radius-sm);
		background: color-mix(in srgb, var(--banto-primary) 8%, transparent);
		font-size: var(--banto-font-size-md);
	}

	/* Issue #215: highlights whichever row was last opened/saved from
	   (`rowClass` -> BantoGrid's `.row` element,
	   packages/grid-svelte/src/BantoGrid.svelte) - same left-accent idiom and
	   `:global()` requirement as audit-log's `.audit-row-selected`
	   (apps/admin-template/src/routes/(app)/audit-log/+page.svelte). */
	:global(.row.resource-row-last-opened) {
		background: color-mix(in srgb, var(--banto-primary) 10%, transparent);
		border-left: 3px solid var(--banto-primary);
	}
</style>
