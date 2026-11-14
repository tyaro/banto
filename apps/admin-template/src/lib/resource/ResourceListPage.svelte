<!--
	@component
	The list page of one resource (ADR-0030 §4, stage 4).

	`<ResourceListPage resource={definition}>` renders the whole page: the
	heading (`label` / `description`), the "Views" menu (#555 (4): the
	definition's `list.views` and the user's saved views - filters, sort and
	search term - with "save the current view" / delete; `?view=<id>` opens the
	list with one), the "View" menu (load mode, when the
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
	- `detailAfter`: below the form in the detail drawer (`ResourceDetail`'s
	  `after`; the items attachments panel).

	Detail drawer (#591, B-3): the small button at the start of each row (and
	a read-only grid's row click / a double-click on a read-only cell) opens
	the record in a right-hand `Drawer` with `ResourceDetail`, next to the list.
	The URL carries `?id=<id>` (replaceState: opening does not add history
	entries), so the link can be shared; a URL with `?id=` opens the drawer;
	closing removes it. The header has previous / next (also Alt+Up / Alt+Down
	while focus is in the drawer) in the order on screen - within the rows the
	grid has (server mode: the loaded ones) - and "open as a page" to the
	`/<path>/[id]` route, which stays (direct links, and the create page).
	Under 768px the drawer is not used: opening goes to that page. Closing,
	moving and expanding with unsaved edits go through a confirmation.

	The definition is read ONCE, when the component is created (the (app)
	layout keys every page on its route).

	Like everything under `lib/resource/`, this must not import an optional
	asset (attachments, reports, ...; conventions §4, `verify:architecture`
	rule `resource-no-optional`): optional extras come in through the slots.
-->
<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import {
		ColumnsMenu,
		FilterChips,
		GridState,
		csvFilename,
		csvForExcel,
		filterRows,
		searchRows,
		toCsv,
		type CellEdit,
		type GridColumn
	} from '@banto/grid-svelte';
	import {
		createSavedSetting,
		currentSessionScope,
		getDataProvider,
		getSessionController,
		invalidate,
		isProviderError,
		loadActiveListMode,
		loadLastOpenedId,
		loadListViewState,
		notify,
		saveActiveListMode,
		saveListViewState,
		takeLastEditedRecord,
		type SavedSetting
	} from '@banto/admin-core';
	import type { FormSchema } from '@banto/forms';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Bookmark,
		ChevronDown,
		ChevronUp,
		Download,
		Ellipsis,
		Maximize2,
		PanelRightOpen,
		Plus,
		Search,
		SlidersHorizontal,
		Upload
	} from '@lucide/svelte';
	import {
		Button,
		Drawer,
		IconButton,
		Menu,
		MenuGroup,
		MenuItem,
		MenuSeparator,
		Modal,
		PageHeader
	} from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { gridMessages } from '#lib/banto/i18n.js';
	import { getBantoMode, getUiSettings } from '#lib/banto/setup.js';
	import { confirmAction } from '#lib/confirm.svelte.js';
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
	import {
		SAVED_VIEW_LIMIT,
		VIEW_LABEL_MAX,
		canSaveListViews,
		newSavedViewId,
		parseSavedViews,
		presetViewContent,
		removeSavedView,
		sameViewContent,
		savedViewsKey,
		serializeSavedViews,
		upsertSavedView,
		viewForFields,
		type ListViewContent,
		type SavedListView
	} from './listViews';
	import { resourcePermissions } from './permissions';
	import { createRowSaveQueue } from './rowSaveQueue';
	import ResourceClientGrid from './ResourceClientGrid.svelte';
	import ResourceDetail from './ResourceDetail.svelte';
	import ResourceImportPanel from './ResourceImportPanel.svelte';
	import ResourceServerGrid from './ResourceServerGrid.svelte';
	import type { AppResourceDefinition, ListLoadMode, ResourceRow } from './types';

	interface Props {
		resource: AppResourceDefinition;
		actions?: Snippet;
		viewMenu?: Snippet;
		beforeGrid?: Snippet;
		annotation?: Snippet;
		detailAfter?: Snippet<[{ id: number; canWrite: boolean }]>;
	}

	// `actions` is renamed: PageHeader's own `actions` snippet below shadows the name.
	let {
		resource,
		actions: extraActions,
		viewMenu,
		beforeGrid,
		annotation,
		detailAfter
	}: Props = $props();

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

	// `openCell` is the row's "open" button (#591, the snippet at the end of the markup).
	const baseColumns = resourceColumns(def, openCell);

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
	// #555 (3): the quick-search term is ONE value for the page (the box sits
	// in the toolbar, above whichever grid is shown), saved into both modes'
	// snapshots; the active mode's saved term wins on restore.
	// The column ids each grid has (fixed for the page's life: the definition
	// is read once). Also what a list view is narrowed to when applied.
	// svelte-ignore state_referenced_locally
	const clientFieldIds = clientColumns.map((column) => column.id);
	// svelte-ignore state_referenced_locally
	const serverFieldIds = columns.map((column) => column.id);
	const restoredSearch: Partial<Record<ListLoadMode, string>> = {};
	if (hasClient) {
		const clientSnapshot = loadListViewState(scope, CLIENT_VIEW_KEY, clientFieldIds);
		if (clientSnapshot) {
			restoredSearch.client = clientSnapshot.search;
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
		const serverSnapshot = loadListViewState(scope, SERVER_VIEW_KEY, serverFieldIds);
		if (serverSnapshot) {
			restoredSearch.server = serverSnapshot.search;
			serverGridState.sort = serverSnapshot.sort;
			serverGridState.filters = serverSnapshot.filters;
		}
	}

	// #555 (3): quick search across the resource's text columns
	// (`ListParams.search`). `searchInput` follows the box keystroke by
	// keystroke; `search` - what the grids, the CSV export and the saved
	// snapshot use - follows it SEARCH_DEBOUNCE_MS after the last keystroke,
	// so typing a word is one query, not one per letter. Not a filter chip:
	// the box itself shows the term and clears it.
	const SEARCH_DEBOUNCE_MS = 300;
	// svelte-ignore state_referenced_locally
	let searchInput = $state(
		restoredSearch[mode] ?? restoredSearch.server ?? restoredSearch.client ?? ''
	);
	// svelte-ignore state_referenced_locally
	let search = $state(searchInput);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function handleSearchInput(): void {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			search = searchInput;
		}, SEARCH_DEBOUNCE_MS);
	}
	$effect(() => () => clearTimeout(searchTimer));

	// --- #555 (4): list views -------------------------------------------------
	//
	// A view = filters + sort + quick-search term (`listViews.ts`). Applying one
	// REPLACES what both grids had (each keeps only the entries it has a
	// column for), so the chips, the search box and - in server mode - the
	// fetched rows follow. Sources: the definition's `list.views`, then the
	// user's own saved views in the per-user UI settings. `?view=<id>` opens
	// the list with either; the parameter is then removed from the URL (a
	// reload must not re-apply it over what the user changed since).

	const presetViews = def.list?.views ?? [];
	const savedViewsSettingKey = savedViewsKey(name);
	// A grant session (LAN public viewer) shares one settings namespace across
	// every screen it runs on, so it gets the views but no "Save".
	const canSaveViews = $derived(
		savedViewsSettingKey !== null && canSaveListViews(getSessionController().snapshot)
	);
	const savedViewsSetting = savedViewsSettingKey
		? createSavedSetting<SavedListView[]>({
				provider: getUiSettings(),
				key: savedViewsSettingKey,
				parse: parseSavedViews,
				serialize: serializeSavedViews,
				fallback: () => []
			})
		: null;
	// `idle` until the first load starts. Saving waits for `ready`: a save
	// before the load answered would overwrite the views stored meanwhile.
	let savedViewsLoad: 'idle' | 'loading' | 'ready' | 'failed' = $state('idle');
	const savedViews = $derived(canSaveViews ? (savedViewsSetting?.saved ?? []) : []);
	const hasViewsMenu = $derived(presetViews.length > 0 || canSaveViews);

	/** A `?view=` id that names a saved view, waiting for the saved views to load. */
	let pendingViewId: string | null = null;

	$effect(() => {
		if (!canSaveViews || !savedViewsSetting) return;
		untrack(() => {
			if (savedViewsLoad === 'idle') void loadSavedViews(savedViewsSetting);
		});
	});
	$effect(() => () => savedViewsSetting?.dispose());

	async function loadSavedViews(setting: SavedSetting<SavedListView[]>): Promise<void> {
		savedViewsLoad = 'loading';
		const result = await setting.load();
		if (result === 'stale') return;
		savedViewsLoad = result === 'failed' ? 'failed' : 'ready';
		const pending = pendingViewId;
		pendingViewId = null;
		if (pending) resolveViewRequest(pending, true);
	}

	function setGridView(state: GridState<ResourceRow>, content: ListViewContent): void {
		state.sort = [...content.sort];
		state.filters = [...content.filters];
	}

	/** Apply a view to both grids and the search box. `refetch`: the server grid already exists. */
	function applyView(content: ListViewContent, refetch: boolean): void {
		// A newer choice supersedes a `?view=` still waiting for the saved
		// views to load: it must not land over this one afterwards.
		pendingViewId = null;
		if (hasClient) setGridView(clientGridState, viewForFields(content, clientFieldIds));
		if (hasServer) setGridView(serverGridState, viewForFields(content, serverFieldIds));
		clearTimeout(searchTimer);
		searchInput = content.search;
		search = content.search;
		if (refetch && mode === 'server') serverGridRef?.applyStateParams();
	}

	/** `?view=<id>`: a definition view, else a saved one (once loaded), else a notice. */
	function resolveViewRequest(id: string, refetch: boolean): void {
		const preset = presetViews.find((view) => view.id === id);
		if (preset) {
			applyView(presetViewContent(preset), refetch);
			return;
		}
		if (canSaveViews && (savedViewsLoad === 'idle' || savedViewsLoad === 'loading')) {
			pendingViewId = id;
			return;
		}
		const own = savedViews.find((view) => view.id === id);
		if (own) applyView(own, refetch);
		else notify('info', m['resource.viewNotFound']({ id }));
	}

	// The URL this page was created with: a definition view in it is applied
	// right here, before either grid exists (so the server grid's first fetch
	// already carries it). The effect below handles a later `?view=` (a link
	// to the same list while it is open) and removes the parameter.
	const initialUrl = page.url;
	const initialViewId = initialUrl.searchParams.get('view');
	if (initialViewId) resolveViewRequest(initialViewId, false);

	$effect(() => {
		const url = page.url;
		const id = url.searchParams.get('view');
		if (id === null) return;
		untrack(() => {
			if (url !== initialUrl) resolveViewRequest(id, true);
			const next = new URL(url.href);
			next.searchParams.delete('view');
			try {
				replaceState(next, page.state);
			} catch {
				// Router not ready yet: the parameter stays, which only means a
				// reload applies the view again.
			}
		});
	});

	/** What the active grid shows now, as a view (for the menu's check mark and "Save"). */
	function currentViewContent(): ListViewContent {
		const state = mode === 'client' ? clientGridState : serverGridState;
		return {
			sort: $state.snapshot(state.sort),
			filters: $state.snapshot(state.filters),
			search
		};
	}

	function isShownView(content: ListViewContent): boolean {
		const fields = mode === 'client' ? clientFieldIds : serverFieldIds;
		return sameViewContent(viewForFields(content, fields), currentViewContent());
	}

	/**
	 * Store the saved views `build` derives from the stored ones; on failure
	 * the menu keeps the stored ones. The whole read-modify-write runs one at
	 * a time: two deletes confirmed back to back must each start from what the
	 * previous one stored, or the second would write the first's view back.
	 * `build` returning `null` skips the write (resolves `null`).
	 */
	let savedViewsMutation: Promise<unknown> = Promise.resolve();
	function mutateSavedViews(
		build: (stored: SavedListView[]) => SavedListView[] | null
	): Promise<boolean | null> {
		const run = savedViewsMutation.then(async () => {
			const setting = savedViewsSetting;
			if (!setting) return false;
			const previous = setting.saved ?? [];
			const next = build(previous);
			if (next === null) return null;
			setting.set(next);
			const ok = await setting.save();
			if (!ok) setting.set(previous);
			return ok;
		});
		savedViewsMutation = run.catch(() => undefined);
		return run;
	}

	let saveViewOpen = $state(false);
	let saveViewName = $state('');
	let saveViewBusy = $state(false);

	function openSaveView(): void {
		if (savedViewsLoad !== 'ready') {
			notify('error', m['resource.viewSaveFailed']());
			return;
		}
		saveViewName = '';
		saveViewOpen = true;
	}

	async function submitSaveView(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const label = saveViewName.trim();
		if (!savedViewsSetting || saveViewBusy || label === '') return;
		const content = { ...currentViewContent(), search: searchInput };
		saveViewBusy = true;
		try {
			const ok = await mutateSavedViews((stored) => {
				const result = upsertSavedView(stored, label, content, () => newSavedViewId(stored));
				return result.kind === 'limit' ? null : result.views;
			});
			if (ok === null) {
				notify('error', m['resource.viewLimit']({ count: SAVED_VIEW_LIMIT }));
			} else if (ok) {
				notify('success', m['resource.viewSaved']({ name: label }));
				saveViewOpen = false;
			} else {
				notify('error', m['resource.viewSaveFailed']());
			}
		} finally {
			saveViewBusy = false;
		}
	}

	async function deleteSavedView(view: SavedListView): Promise<void> {
		const confirmed = await confirmAction({
			title: m['resource.viewDeleteTitle'](),
			message: m['resource.viewDeleteMessage']({ name: view.label }),
			confirmLabel: m['common.delete'](),
			danger: true
		});
		if (!confirmed || !savedViewsSetting) return;
		if (await mutateSavedViews((stored) => removeSavedView(stored, view.id))) {
			notify('success', m['resource.viewDeleted']({ name: view.label }));
		} else {
			notify('error', m['resource.viewDeleteFailed']());
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
			groupBy: clientGridState.groupBy,
			search
		});
	});
	$effect(() => {
		if (!hasServer) return;
		saveListViewState(scope, SERVER_VIEW_KEY, {
			sort: serverGridState.sort,
			filters: serverGridState.filters,
			search
		});
	});

	// The row most recently opened for this RESOURCE (#215's "直前の作業位置
	// を見つけられるようにする" - via `rowClass` highlighting below, rather
	// than scroll restoration). Deliberately ONE value shared by both load
	// modes (admin-core's `saveLastOpenedId` doc comment explains why), and
	// stored by ResourceDetail itself (`saveLastOpenedId` on mount), the one
	// place every way of opening a record passes through - the detail page and
	// the drawer below (#591) alike. Read from storage once (returning from the
	// detail page remounts this page); the drawer then updates it as it shows
	// a record, so the highlight follows previous / next too.
	let lastOpenedId: string | number | null = $state(loadLastOpenedId(scope, name));

	// --- #591 (B-3): the detail drawer ---------------------------------------

	/** Below this width the drawer is not used: opening goes to the detail page. */
	const NARROW_DETAIL_QUERY = '(max-width: 767.98px)';
	const DRAWER_PARAM = 'id';
	const drawerMessages = { overlayClose: () => m['common.close']() };

	/** The record the drawer shows (`null` = none). A `?id=` value stays a string until it parses. */
	let drawerId: string | number | null = $state(null);
	let drawerOpen = $state(false);
	/** The id the drawer was opened with, to put focus back on another row's button when it moved. */
	let drawerOpenedWith: string | number | null = null;
	/** Bumped by every show / close: an answer to a confirmation that is no longer current is dropped. */
	let drawerGeneration = 0;
	/** A discard confirmation is on screen: a second request waits for it instead of asking twice. */
	let drawerConfirming = false;
	let detailRef: ReturnType<typeof ResourceDetail> | undefined = $state();
	let drawerBodyEl: HTMLDivElement | undefined = $state();

	// The active grid's "row next to this one" (BantoGrid's `adjacentRow`).
	let adjacentLookup:
		((rowId: string | number, delta: number) => ResourceRow | undefined) | undefined = $state.raw();
	const registerAdjacentRow = (lookup: typeof adjacentLookup): void => {
		adjacentLookup = lookup;
	};

	/** A `?id=` value as the rows hold ids (integers), so it matches `row.id`. */
	function normalizeId(id: string | number): string | number {
		if (typeof id === 'number') return id;
		return /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : id;
	}

	const drawerRowId = $derived(drawerId === null ? null : normalizeId(drawerId));
	const previousRow = $derived(
		drawerOpen && drawerRowId !== null ? adjacentLookup?.(drawerRowId, -1) : undefined
	);
	const nextRow = $derived(
		drawerOpen && drawerRowId !== null ? adjacentLookup?.(drawerRowId, 1) : undefined
	);

	function isNarrowViewport(): boolean {
		return typeof window !== 'undefined' && window.matchMedia(NARROW_DETAIL_QUERY).matches;
	}

	/** Put the shown record into the URL (or take it out) without a history entry or a navigation. */
	function writeDrawerParam(id: string | number | null): void {
		// From the address bar, not `page.url`: SvelteKit's shallow
		// `replaceState` leaves `page.url` as it was, so after opening the
		// drawer `page.url` still lacks `?id=` and closing would see nothing
		// to remove.
		const current = window.location.href;
		const next = new URL(current);
		if (id === null) next.searchParams.delete(DRAWER_PARAM);
		else next.searchParams.set(DRAWER_PARAM, String(id));
		if (next.href === current) return;
		try {
			replaceState(next, page.state);
		} catch {
			// Router not ready yet: the URL keeps its old value; the drawer is right.
		}
	}

	function showInDrawer(id: string | number): void {
		drawerGeneration++;
		if (!drawerOpen) drawerOpenedWith = id;
		drawerId = id;
		drawerOpen = true;
		lastOpenedId = normalizeId(id);
		writeDrawerParam(id);
	}

	function closeDrawerNow(): void {
		if (!drawerOpen) return;
		drawerGeneration++;
		const shown = drawerRowId;
		const openedWith = drawerOpenedWith === null ? null : normalizeId(drawerOpenedWith);
		drawerOpen = false;
		drawerId = null;
		drawerOpenedWith = null;
		writeDrawerParam(null);
		// The Drawer gives focus back to the button that opened it. After a
		// move to another record, that record's button is the better place -
		// after the Drawer's own restore (a microtask), when it is on screen.
		if (shown !== null && shown !== openedWith) {
			setTimeout(() => {
				const button = pageEl?.querySelector<HTMLElement>(
					`[data-resource-open="${CSS.escape(String(shown))}"] button`
				);
				// Scrolled out of the virtualised grid: back to the grid itself.
				(button ?? pageEl?.querySelector<HTMLElement>('[role="grid"]'))?.focus();
			}, 0);
		}
	}

	/**
	 * `true` when the drawer may leave its record now: nothing unsaved, or
	 * the user chose to discard it. `false` also while another confirmation
	 * of this drawer is open, and when the drawer changed while asking.
	 */
	async function confirmLeaveRecord(): Promise<boolean> {
		if (!drawerOpen || !detailRef?.hasPendingChanges()) return true;
		// A save in flight cannot be called off: "discard" would be a lie (the
		// change still lands). Stay until it finishes; then nothing is pending.
		if (detailRef.isSaving()) return false;
		if (drawerConfirming) return false;
		const generation = drawerGeneration;
		drawerConfirming = true;
		try {
			const discard = await confirmAction({
				title: m['resource.discardTitle'](),
				message: m['resource.discardMessage'](),
				confirmLabel: m['unsaved.discard'](),
				danger: true
			});
			return discard && generation === drawerGeneration;
		} finally {
			drawerConfirming = false;
		}
	}

	/** Open a record from the list: the drawer, or the detail page on a narrow screen. */
	async function openRecord(id: string | number): Promise<void> {
		if (isNarrowViewport()) {
			void goto(detailHref(def, id));
			return;
		}
		if (drawerOpen && drawerRowId === normalizeId(id)) return;
		if (!(await confirmLeaveRecord())) return;
		showInDrawer(id);
	}

	/** Previous (-1) / next (+1) row in the list's order. Nothing at either end. */
	async function moveDrawer(delta: -1 | 1): Promise<void> {
		const target = delta < 0 ? previousRow : nextRow;
		if (!target) return;
		if (!(await confirmLeaveRecord())) return;
		// `{#key drawerId}` replaces the form, so a focused field goes away and
		// focus would fall to <body> - out of the drawer, where Alt+Up / Down
		// no longer reach `handleDrawerKeydown`. Keep it in the drawer body.
		const focusWasInBody = drawerBodyEl?.contains(document.activeElement) ?? false;
		showInDrawer(target.id);
		if (!focusWasInBody) return;
		await tick();
		if (drawerBodyEl && !drawerBodyEl.contains(document.activeElement)) drawerBodyEl.focus();
	}

	/** The Drawer's Esc / scrim / × (sync): ask first when something would be lost. */
	function handleDrawerRequestClose(): boolean {
		if (!detailRef?.hasPendingChanges()) return true;
		void (async () => {
			if (await confirmLeaveRecord()) closeDrawerNow();
		})();
		return false;
	}

	/** The form's own "close" button: the same as the ×. */
	function closeDrawerFromDetail(): void {
		if (handleDrawerRequestClose()) closeDrawerNow();
	}

	/** "Open as a page": a real navigation, so the detail's unsaved guard asks. */
	function expandDrawer(): void {
		if (drawerId === null) return;
		void goto(detailHref(def, drawerId));
	}

	function handleDrawerSaved(row: ResourceRow): void {
		// The list refreshes itself (`createFormResource` invalidates the
		// resource); only the #215 "left the filter" check is ours.
		checkFilterExclusion(row);
	}

	// Alt+Up / Alt+Down: previous / next, only while focus is in the drawer
	// (the grid's own arrows are not touched). Not on a <select>, where
	// Alt+Down opens the list of options.
	function handleDrawerKeydown(event: KeyboardEvent): void {
		if (!drawerOpen || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		const dialog = drawerBodyEl?.closest('[role="dialog"]');
		const target = event.target;
		if (!dialog || !(target instanceof Node) || !dialog.contains(target)) return;
		if (target instanceof HTMLSelectElement) return;
		event.preventDefault();
		void moveDrawer(event.key === 'ArrowUp' ? -1 : 1);
	}

	// `?id=` in the URL: opening the page with it, or a later navigation to
	// the same list with another value (a link, the browser's address bar).
	// A navigation already went through the detail's unsaved guard, so this
	// follows it without asking again. Our own replaceState lands here too,
	// with the value the drawer already has - nothing to do then.
	$effect(() => {
		const raw = page.url.searchParams.get(DRAWER_PARAM);
		untrack(() => {
			if (raw === null || raw === '') {
				closeDrawerNow();
				return;
			}
			if (drawerOpen && drawerId !== null && String(drawerId) === raw) return;
			if (isNarrowViewport()) {
				void goto(detailHref(def, raw), { replaceState: true });
				return;
			}
			showInDrawer(raw);
		});
	});

	function handleRowClick(row: ResourceRow) {
		void openRecord(row.id);
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
		checkFilterExclusion({ ...record.values, id: record.id } as ResourceRow);
	});

	/** Show the notice when `values` (a row just saved) no longer matches the active filter / search. #591: the drawer's saves come here directly. */
	function checkFilterExclusion(values: ResourceRow): void {
		// #255 review: the CLIENT grid filters `toRow(row)`, which may add a
		// derived field a filter matches against (items' `category`). The
		// check must run through the exact same derivation the grid renders
		// and filters with, or such a filter always reports a false "excluded".
		const isClient = mode === 'client';
		const row = isClient && toClientRow ? toClientRow(values) : values;
		const activeColumns = isClient ? clientColumns : columns;
		const activeFilters = isClient ? clientGridState.filters : serverGridState.filters;
		// #555 (3): the quick search narrows the list too.
		const term = untrack(() => search);
		if (
			searchRows(filterRows([row], activeFilters, activeColumns), term, activeColumns).length === 0
		) {
			filterExclusionNotice = { id: values.id };
		}
	}

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
				filters,
				// #555 (3): the rows on screen are also narrowed by the quick search.
				search
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
			<!-- #555 (3): quick search across the text columns. A real <label>
			     (its text visually hidden; the icon and placeholder show what the
			     box is for). -->
			<label class="search">
				<Search size={14} aria-hidden="true" />
				<span class="search-label">{m['resource.searchLabel']({ resource: def.label })}</span>
				<input
					class="banto-input search-input"
					type="search"
					placeholder={m['resource.searchPlaceholder']()}
					bind:value={searchInput}
					oninput={handleSearchInput}
				/>
			</label>
			<!-- #555 (4): named views (filters + sort + search term). The one
			     the list shows right now carries the check mark. -->
			{#if hasViewsMenu}
				<Menu label={m['resource.savedViewsMenu']()} placement="bottom-start">
					{#snippet trigger(props)}
						<button {...props} type="button" class="banto-btn banto-btn--ghost views-trigger">
							<Bookmark size={14} aria-hidden="true" />
							{m['resource.savedViewsMenu']()}
						</button>
					{/snippet}
					{#if presetViews.length > 0}
						<MenuGroup label={m['resource.viewsPreset']()}>
							{#each presetViews as view (view.id)}
								<MenuItem
									label={view.label()}
									checked={isShownView(presetViewContent(view))}
									onSelect={() => applyView(presetViewContent(view), true)}
								/>
							{/each}
						</MenuGroup>
					{/if}
					{#if savedViews.length > 0}
						<MenuGroup label={m['resource.viewsSaved']()}>
							{#each savedViews as view (view.id)}
								<MenuItem
									label={view.label}
									checked={isShownView(view)}
									onSelect={() => applyView(view, true)}
								/>
							{/each}
						</MenuGroup>
					{/if}
					{#if canSaveViews}
						{#if presetViews.length > 0 || savedViews.length > 0}
							<MenuSeparator />
						{/if}
						<MenuItem
							label={m['resource.viewSave']()}
							disabled={savedViewsLoad !== 'ready'}
							onSelect={openSaveView}
						/>
						{#if savedViews.length > 0}
							<MenuGroup label={m['resource.viewDeleteGroup']()}>
								{#each savedViews as view (view.id)}
									<MenuItem
										label={m['resource.viewDeleteItem']({ name: view.label })}
										danger
										onSelect={() => void deleteSavedView(view)}
									/>
								{/each}
							</MenuGroup>
						{/if}
					{/if}
				</Menu>
			{/if}
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

	<!-- #555 (4): name the current view and save it (personal UI settings). -->
	{#if canSaveViews}
		<Modal
			open={saveViewOpen}
			title={m['resource.viewSaveTitle']()}
			width="28rem"
			messages={{ overlayClose: () => m['common.close']() }}
			onRequestClose={() => !saveViewBusy}
			onclose={() => (saveViewOpen = false)}
		>
			<form class="save-view" onsubmit={submitSaveView}>
				<p class="save-view-hint">{m['resource.viewSaveHint']()}</p>
				<label class="save-view-field">
					<span>{m['resource.viewName']()}</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="banto-input"
						type="text"
						required
						autofocus
						maxlength={VIEW_LABEL_MAX}
						bind:value={saveViewName}
					/>
				</label>
				<div class="save-view-actions">
					<Button
						variant="secondary"
						disabled={saveViewBusy}
						onclick={() => (saveViewOpen = false)}
					>
						{m['common.cancel']()}
					</Button>
					<Button
						variant="primary"
						type="submit"
						loading={saveViewBusy}
						disabled={saveViewName.trim() === ''}
					>
						{m['common.save']()}
					</Button>
				</div>
			</form>
		</Modal>
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
			{search}
			toRow={toClientRow}
			onRowClick={handleRowClick}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			{rowClass}
			{registerCurrentRow}
			{registerAdjacentRow}
		/>
	{:else}
		<ResourceServerGrid
			bind:this={serverGridRef}
			resource={name}
			{columns}
			state={serverGridState}
			{search}
			onRowClick={handleRowClick}
			onCellEdit={handleCellEdit}
			onRangePaste={handleRangePaste}
			{rowClass}
			{registerCurrentRow}
			{registerAdjacentRow}
		/>
	{/if}
</div>

<svelte:window onkeydown={handleDrawerKeydown} />

<!-- #591: the row's "open" button (the `open` column's `render`, `columns.ts`).
     The wrapper stops the click / double-click from reaching the cell: a
     read-only grid opens the row on a cell click, which would open it twice. -->
{#snippet openCell(row: ResourceRow)}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<span
		class="open-cell"
		data-resource-open={row.id}
		onclick={(event) => event.stopPropagation()}
		ondblclick={(event) => event.stopPropagation()}
	>
		<IconButton
			size="sm"
			icon={PanelRightOpen}
			label={m['resource.openRecord']({ id: String(row.id) })}
			onclick={() => void openRecord(row.id)}
		/>
	</span>
{/snippet}

{#snippet drawerActions()}
	<IconButton
		size="sm"
		icon={ChevronUp}
		label={m['resource.previousRecord']()}
		disabled={!previousRow}
		onclick={() => void moveDrawer(-1)}
	/>
	<IconButton
		size="sm"
		icon={ChevronDown}
		label={m['resource.nextRecord']()}
		disabled={!nextRow}
		onclick={() => void moveDrawer(1)}
	/>
	<IconButton
		size="sm"
		icon={Maximize2}
		label={m['resource.openFullPage']()}
		onclick={expandDrawer}
	/>
{/snippet}

<Drawer
	open={drawerOpen}
	title={drawerId === null
		? undefined
		: m['resource.drawerTitle']({ resource: def.label, id: String(drawerId) })}
	width="40rem"
	messages={drawerMessages}
	headerActions={drawerActions}
	onRequestClose={handleDrawerRequestClose}
	onclose={closeDrawerNow}
	focusFallback={() => pageEl?.querySelector<HTMLElement>('[role="grid"]')}
>
	{#if drawerId !== null}
		<div class="drawer-body" tabindex="-1" bind:this={drawerBodyEl}>
			{#key drawerId}
				<ResourceDetail
					bind:this={detailRef}
					resource={def}
					id={drawerId}
					after={detailAfter}
					onClose={closeDrawerFromDetail}
					onSaved={handleDrawerSaved}
					onDeleted={closeDrawerNow}
				/>
			{/key}
		</div>
	{/if}
</Drawer>

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
	.views-trigger,
	.view-trigger,
	.more-trigger {
		height: var(--banto-control-height-sm);
		padding: 0 var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
	}

	/* #555 (4): the "save the current view" dialog. */
	.save-view {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.save-view-hint {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}

	.save-view-field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
	}

	.save-view-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--banto-space-2);
	}

	/* #555 (3): the quick-search box, first in the toolbar. */
	.search {
		position: relative;
		display: inline-flex;
		align-items: center;
		color: var(--banto-text-muted);
	}

	.search :global(svg) {
		position: absolute;
		left: var(--banto-space-2);
		pointer-events: none;
	}

	.search-input {
		height: var(--banto-control-height-sm);
		width: 14em;
		max-width: 100%;
		padding-left: calc(var(--banto-space-2) * 2 + 14px);
		font-size: var(--banto-font-size-sm);
	}

	/* The label's text, for assistive technology only (same clip as .file-input). */
	.search-label {
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

	/* #591: the row's "open" button, centred in its narrow column. */
	.open-cell {
		display: inline-flex;
		align-items: center;
	}

	/* Focus lands here only by script (after previous / next replaced the form). */
	.drawer-body:focus {
		outline: none;
	}

	.drawer-body {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
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
