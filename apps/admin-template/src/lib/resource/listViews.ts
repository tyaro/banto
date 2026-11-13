/**
 * List views (#555 (4)): the pure part of `ResourceListPage`'s "Views" menu,
 * kept out of the component so it can be unit-tested without a DOM.
 *
 * A view is the list's filters, sort and quick-search term - not the columns
 * or the load mode. Two sources:
 *  - views the definition ships (`list.views`, `ResourceListView`), e.g. items'
 *    `low-stock` that the dashboard's KPI card opens with `?view=low-stock`;
 *  - the user's own saved views, stored as ONE value per resource in the
 *    per-user UI settings (`UiSettingsProvider`, spec M12: `ui.{username}.{key}`
 *    on the server, localStorage in the demo build). Personal only - a view
 *    shared with everyone is a later issue.
 */
import { isListViewSnapshot } from '@banto/admin-core';
import type { FilterState, SortState } from '@banto/grid-svelte';
import type { ResourceListView } from './types';

/** What applying a view sets (and what saving one records). */
export interface ListViewContent {
	sort: SortState[];
	filters: FilterState[];
	search: string;
}

/** One of the user's own saved views. */
export interface SavedListView extends ListViewContent {
	/** Generated when saved; never one of the definition's view ids in practice (`my-` prefix). */
	id: string;
	label: string;
}

/** At most this many saved views per resource (one UI setting value stays small). */
export const SAVED_VIEW_LIMIT = 50;
/** Longest view name accepted by the save dialog. */
export const VIEW_LABEL_MAX = 60;

/** The UI settings key wire contract (`[A-Za-z0-9._-]{1,64}`, spec M12). */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Format version of the stored value. */
const STORED_VERSION = 1;

/**
 * The UI settings key of a resource's saved views, or `null` when the
 * resource name cannot form a valid key (saving is then not offered).
 */
export function savedViewsKey(resourceName: string): string | null {
	const key = `list.views.${resourceName}`;
	return KEY_PATTERN.test(key) ? key : null;
}

/**
 * May this session save views? Only a real account (or the desktop's
 * login-not-required `local` session, or the demo build's session, which has
 * no kind). A credential-less grant session (the LAN public viewer,
 * ADR-0017) shares ONE settings namespace (`ui.public.*`) across every
 * screen it runs on, so a "personal" view there would show up on all of them.
 * The UI settings themselves need no role (any signed-in session reads and
 * writes its own keys), so a `viewer` may save views too.
 */
export function canSaveListViews(session: {
	status: string;
	kind?: string | null | undefined;
}): boolean {
	if (session.status !== 'active') return false;
	const kind = session.kind ?? null;
	return kind === null || kind === 'account' || kind === 'local';
}

/** A definition view as content (missing parts are empty). */
export function presetViewContent(view: ResourceListView): ListViewContent {
	return {
		sort: [...(view.sort ?? [])],
		filters: [...(view.filters ?? [])],
		search: view.search ?? ''
	};
}

/**
 * The part of `content` a grid with these columns can show: sort / filter
 * entries on a field the grid has no column for are dropped (the server
 * rejects an unknown filter field, the client grid would match nothing).
 */
export function viewForFields(
	content: ListViewContent,
	fields: readonly string[]
): ListViewContent {
	const known = new Set(fields);
	return {
		sort: content.sort.filter((entry) => known.has(entry.field)),
		filters: content.filters.filter((entry) => known.has(entry.field)),
		search: content.search
	};
}

/** Does the list currently show exactly this view (search compared trimmed)? */
export function sameViewContent(a: ListViewContent, b: ListViewContent): boolean {
	return (
		JSON.stringify(a.sort) === JSON.stringify(b.sort) &&
		JSON.stringify(a.filters) === JSON.stringify(b.filters) &&
		a.search.trim() === b.search.trim()
	);
}

function isSavedView(value: unknown): value is SavedListView {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'string' &&
		candidate.id !== '' &&
		typeof candidate.label === 'string' &&
		candidate.label.trim() !== '' &&
		typeof candidate.search === 'string' &&
		isListViewSnapshot(candidate)
	);
}

/**
 * The stored value -> the saved views, or `undefined` when it is not a
 * saved-views value at all (`createSavedSetting` then treats it as missing).
 * A stored value is untrusted input: a malformed entry is dropped on its own
 * (the others survive), and a repeated id keeps the first entry.
 */
export function parseSavedViews(raw: string): SavedListView[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') return undefined;
	const candidate = parsed as { version?: unknown; views?: unknown };
	if (candidate.version !== STORED_VERSION || !Array.isArray(candidate.views)) return undefined;
	const seen = new Set<string>();
	const views: SavedListView[] = [];
	for (const entry of candidate.views) {
		if (!isSavedView(entry) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		views.push({
			id: entry.id,
			label: entry.label,
			sort: entry.sort,
			filters: entry.filters,
			search: entry.search
		});
	}
	return views;
}

export function serializeSavedViews(views: readonly SavedListView[]): string {
	return JSON.stringify({ version: STORED_VERSION, views });
}

/** A fresh saved-view id: `my-` + time + random, not already in `views`. */
export function newSavedViewId(
	views: readonly SavedListView[],
	random: () => number = Math.random,
	now: () => number = Date.now
): string {
	const taken = new Set(views.map((view) => view.id));
	for (;;) {
		const id = `my-${now().toString(36)}${random().toString(36).slice(2, 8)}`;
		if (!taken.has(id)) return id;
	}
}

export type UpsertResult =
	{ kind: 'added' | 'replaced'; views: SavedListView[]; view: SavedListView } | { kind: 'limit' };

/**
 * Save `content` under `label` (trimmed). A view with the same name is
 * overwritten in place (same id and position); otherwise the view is added
 * at the end, unless that would pass {@link SAVED_VIEW_LIMIT}.
 */
export function upsertSavedView(
	views: readonly SavedListView[],
	label: string,
	content: ListViewContent,
	newId: () => string
): UpsertResult {
	const name = label.trim();
	const stored: ListViewContent = {
		sort: [...content.sort],
		filters: [...content.filters],
		search: content.search.trim()
	};
	const index = views.findIndex((view) => view.label === name);
	const existing = views[index];
	if (existing) {
		const view = { ...stored, id: existing.id, label: name };
		const next = [...views];
		next[index] = view;
		return { kind: 'replaced', views: next, view };
	}
	if (views.length >= SAVED_VIEW_LIMIT) return { kind: 'limit' };
	const view = { ...stored, id: newId(), label: name };
	return { kind: 'added', views: [...views, view], view };
}

export function removeSavedView(views: readonly SavedListView[], id: string): SavedListView[] {
	return views.filter((view) => view.id !== id);
}
