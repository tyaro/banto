/**
 * The app layer's resource definition (ADR-0030 §3).
 *
 * `AppResourceDefinition` extends admin-core's `ResourceDefinition` (which stays
 * unchanged, so no breaking change for consumers) with what the screens need.
 * Stage 1 added `path` and `nav`; stage 4 adds what `ResourceListPage` reads
 * (`description`, `list`, `csv.export`, `demoNotes`). CSV import and `canWrite`
 * arrive in stage 5.
 *
 * Text is a function (`label?: () => string`) for the same reason
 * `resources/items.ts` uses `get label()`: evaluating at module load would
 * freeze the default locale.
 */
import type { Component } from 'svelte';
import type { ResourceDefinition } from '@banto/admin-core';
import type { GridColumn } from '@banto/grid-svelte';
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

export interface ResourceCsvOptions {
	/**
	 * Offer "Export CSV" (a read: shown to every role when `capabilities.list`).
	 * `toFolder` is the desktop (Tauri) path; without it the desktop build
	 * falls back to a browser download.
	 */
	export?: boolean | { toFolder?: (csv: string, filename: string) => Promise<FolderExportResult> };
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
