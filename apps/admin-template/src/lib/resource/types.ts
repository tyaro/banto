/**
 * The app layer's resource definition (ADR-0030 §3).
 *
 * `AppResourceDefinition` extends admin-core's `ResourceDefinition` (which stays
 * unchanged, so no breaking change for consumers) with what the screens need.
 * Stage 1 added `path` and `nav`; stage 4 added what `ResourceListPage` reads
 * (`description`, `list`, `csv.export`, `demoNotes`); stage 5 adds the CSV
 * import (`csv.import`).
 *
 * Text is a function (`label?: () => string`) for the same reason
 * `resources/items.ts` uses `get label()`: evaluating at module load would
 * freeze the default locale.
 */
import type { Component } from 'svelte';
import type { ResourceDefinition } from '@banto/admin-core';
import type { FilterState, GridColumn, SortState } from '@banto/grid-svelte';
import type { AppPath } from '#lib/appPath.js';

export interface ResourceNav {
	/** lucide component held directly by the definition file. */
	icon: Component;
	/** Sidebar / palette label. Defaults to the resource `label`. */
	label?: () => string;
	/** Allowlist for the LAN viewer-public session (ADR-0012; not an authorization check). */
	publicViewer?: boolean;
	/** Show the unseen-change badge (navBadges) for this resource. */
	badge?: boolean;
	/** Only shown to the `admin` role. */
	adminOnly?: boolean;
}

/**
 * A row as the list screens see it. Deliberately not generic: a resource's own
 * row type (e.g. `Item`) needs an index signature to fit, and callbacks that
 * want the narrow type cast inside (a generic definition would not fit the
 * `resources` array under strictFunctionTypes).
 */
export type ResourceRow = { id: string | number } & Record<string, unknown>;

/**
 * How the list fetches rows (spec §4.1): `server` = sort / filter / paging in
 * the DataProvider, rows fetched block by block as the user scrolls; `client`
 * = everything fetched once, sorted / filtered / grouped in the browser.
 */
export type ListLoadMode = 'server' | 'client';

/**
 * A named list view the definition ships (#555 (4)): the "Views" menu lists
 * it, and `<path>?view=<id>` opens the list with it (a KPI card links there).
 * A view holds the filters, sort and quick-search term - not the columns or
 * the load mode. Applying it replaces what the list had. Entries on a field
 * the active grid has no column for are dropped when applied.
 */
export interface ResourceListView {
	/** URL-safe id (`?view=<id>`), unique among the resource's views. */
	id: string;
	label: () => string;
	sort?: SortState[];
	filters?: FilterState[];
	search?: string;
}

export interface ResourceListOptions {
	/**
	 * Which load modes the list offers. Default `['server']` (ADR-0030 decision
	 * 3: the side that stays fast as the data grows). With two, the "View" menu
	 * offers the switch; the first visit uses `server` when it is offered.
	 */
	loadModes?: readonly ListLoadMode[];
	/** `columnsFromSchema` overrides (widths, `format`, ...), keyed by schema field name. */
	columns?: Record<string, Partial<GridColumn<ResourceRow>>>;
	/**
	 * Group-by candidates for the client grid (spec §4.3), in select order.
	 * Shown only when `client` is one of `loadModes`; disabled while the
	 * server grid is on screen.
	 */
	groupBy?: readonly { field: string; label: () => string }[];
	/**
	 * Views shipped with the resource (#555 (4)), listed first in the "Views"
	 * menu, before the user's own saved views.
	 */
	views?: readonly ResourceListView[];
	/** Client grid only. */
	client?: {
		/**
		 * Derive the row the client grid renders AND filters (e.g. a synthetic
		 * grouping field). The "saved row left the filter" check runs through
		 * it too, so it must be pure.
		 */
		toRow?: (row: ResourceRow) => ResourceRow;
		/** Rework the column set for the client grid (extra columns, aggregates). */
		columns?: (columns: GridColumn<ResourceRow>[]) => GridColumn<ResourceRow>[];
	};
}

/** Where the desktop build writes an exported CSV (WebView2 has no save dialog for `<a download>`). */
export interface FolderExportResult {
	path: string;
	/** `false` on non-Windows, where no folder opens. */
	opened: boolean;
}

/** One row handed to `csv.import.run`: `id` absent = create, present = update; then the editable columns the CSV names. */
export type ResourceImportRow = { id?: string | number } & Record<string, unknown>;

/**
 * What `csv.import.run` resolves with. `errors[].row` is the 0-based index into
 * the rows passed to `run` (not a CSV line number). Ideally all-or-nothing
 * (items' server rolls the whole batch back, so `created` / `updated` are then
 * 0); a `run` that applies part of a batch reports what it did apply, and the
 * page reloads the list and keeps the run button off for that file.
 */
export interface ResourceImportResult {
	created: number;
	updated: number;
	errors: { row: number; message: string }[];
}

/**
 * CSV import (ADR-0030 §4, stage 5). `DataProvider` has no import entry point,
 * so the definition passes the call itself (`run`). Offered only with the
 * `import` permission (`capabilities.create` AND `edit`, plus a writing role).
 */
export interface ResourceCsvImport {
	/**
	 * Is the import backed by a real server right now (provider layer,
	 * conventions §10)? When false, the button explains it instead of opening
	 * the file picker. Default: always available.
	 */
	available?: () => boolean;
	/** The import rules, shown as the button's title and in the confirmation panel (production builds too). */
	rules: () => string;
	/** Send the confirmed rows. Map them to the resource's own request type here. */
	run: (rows: ResourceImportRow[]) => Promise<ResourceImportResult>;
	/** Fields the CSV header must contain. Default: the schema's `required`, non-`readonly` fields. */
	required?: readonly string[];
	/** Fields the preview table shows, after line / action / ID. Default: `required`. */
	preview?: readonly string[];
	/** How a non-blank `id` cell is read. Default `'integer'` (anything else is a row error). */
	idType?: 'integer' | 'string';
}

export interface ResourceCsvOptions {
	/**
	 * Offer "Export CSV" (a read: shown to every role when `capabilities.list`).
	 * `toFolder` is the desktop (Tauri) path; without it the desktop build
	 * falls back to a browser download.
	 */
	export?: boolean | { toFolder?: (csv: string, filename: string) => Promise<FolderExportResult> };
	/** "Import CSV" and its confirmation panel. Omit for no import. */
	import?: ResourceCsvImport;
}

export interface AppResourceDefinition extends ResourceDefinition {
	/** Route of the resource's list page, e.g. `'/items'`. */
	path: AppPath;
	/** `false` or omitted = not listed in the navigation. */
	nav?: false | ResourceNav;
	/** One line under the list's heading. */
	description?: () => string;
	/** The list page (`ResourceListPage`). */
	list?: ResourceListOptions;
	csv?: ResourceCsvOptions;
	/**
	 * Paragraphs of the demo build's annotation drawer on the list page
	 * (ADR-0030 §7). Omit for no annotation; production builds never show it.
	 */
	demoNotes?: () => string[];
}

/** Type inference helper only - an identity function with no runtime machinery. */
export function defineResource<T extends AppResourceDefinition>(definition: T): T {
	return definition;
}
