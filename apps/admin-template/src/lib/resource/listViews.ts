/**
 * List views (#555 (4)): the pure part of `ResourceListPage`'s "Views" menu,
 * kept out of the component so it can be unit-tested without a DOM.
 *
 * A view is the list's filters, sort, quick-search term and - for a saved
 * view - which columns are pinned to the left (#713). Not the columns'
 * visibility / order / widths, and not the load mode. Two sources:
 *  - views the definition ships (`list.views`, `ResourceListView`), e.g. items'
 *    `low-stock` that the dashboard's KPI card opens with `?view=low-stock`;
 *  - the user's own saved views, stored as ONE value per resource in the
 *    per-user UI settings (`UiSettingsProvider`, spec M12: the account's own
 *    rows of `ui_settings` on the server, localStorage in the demo build). Personal only - a view
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
	/**
	 * Ids of the columns pinned to the left (#713; the order has no meaning -
	 * the grid shows pinned columns in its own column order). Missing in a
	 * definition view and in a view saved before pinning: the column
	 * definitions' own `pinned` then applies ({@link definitionPinned}).
	 */
	pinned?: string[];
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

/** The URL prefix of a view argument (`?view=<id>&arg.<name>=<value>`, #882). */
export const VIEW_ARG_PREFIX = 'arg.';
/** A view argument's name. */
export const VIEW_ARG_NAME = /^[a-z][A-Za-z0-9]*$/;
/** A longer argument value is not accepted (same bound as the audit log query's values). */
const VIEW_ARG_VALUE_MAX = 200;

/** Is this a name a definition may declare as a view argument? */
export function isViewArgName(name: string): boolean {
	return VIEW_ARG_NAME.test(name);
}

/** The value trimmed, or `null` when it is empty, too long or has control characters. */
export function cleanViewArgValue(raw: string): string | null {
	const value = raw.trim();
	// eslint-disable-next-line no-control-regex
	if (value === '' || value.length > VIEW_ARG_VALUE_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
		return null;
	}
	return value;
}

/** Does the view have an argument the link must carry? (Such a view is not in the menu.) */
export function hasRequiredViewArg(view: ResourceListView): boolean {
	return Object.values(view.args ?? {}).includes('required');
}

/** The definition views the "Views" menu lists (those without a required argument). */
export function menuViews(views: readonly ResourceListView[]): ResourceListView[] {
	return views.filter((view) => !hasRequiredViewArg(view));
}

/** The query names a view link uses (`view`, `arg.*`): what applying the link removes. */
export function viewLinkParamNames(params: Pick<URLSearchParams, 'keys'>): string[] {
	return [...new Set([...params.keys()])].filter(
		(key) => key === 'view' || key.startsWith(VIEW_ARG_PREFIX)
	);
}

/**
 * What opening a definition view from a URL applies (#882).
 *  - `content`: the view's conditions, with the URL's arguments worked in;
 *  - `strict`: the link carried arguments, so every condition must fit the grid
 *    shown ({@link viewFitsFields}); nothing may be dropped silently.
 * `null`: the link's narrowing cannot be applied (a missing required argument, a
 * repeated one, an empty / invalid value, an `arg.*` name the view does not declare,
 * `filtersFor` said `null`). The caller then
 * applies nothing and says so; it never falls back to the plain view.
 * A view without arguments in the URL (an optional-only view, or one that declares
 * none) applies as it always did.
 */
export function presetViewFromUrl(
	view: ResourceListView,
	params: Pick<URLSearchParams, 'getAll' | 'keys'>
): { content: ListViewContent; strict: boolean } | null {
	const declared = Object.entries(view.args ?? {});
	// A name this view does not declare (a typo such as `arg.afetr`) means the link asks for
	// something we cannot honour: refuse it whole rather than drop the condition silently.
	for (const key of params.keys()) {
		if (key.startsWith(VIEW_ARG_PREFIX) && !declared.some(([n]) => VIEW_ARG_PREFIX + n === key)) {
			return null;
		}
	}
	const anyPresent = declared.some(
		([argName]) => params.getAll(VIEW_ARG_PREFIX + argName).length > 0
	);
	if (!anyPresent && !hasRequiredViewArg(view)) {
		return { content: presetViewContent(view), strict: false };
	}
	const args: Record<string, string> = {};
	for (const [argName, need] of declared) {
		const all = params.getAll(VIEW_ARG_PREFIX + argName);
		if (all.length > 1) return null;
		const only = all[0];
		if (only === undefined) {
			if (need === 'required') return null;
			continue;
		}
		const value = cleanViewArgValue(only);
		if (value === null) return null;
		args[argName] = value;
	}
	const extra = view.filtersFor ? view.filtersFor(args) : [];
	if (extra === null) return null;
	const base = presetViewContent(view);
	return { content: { ...base, filters: [...base.filters, ...extra] }, strict: true };
}

/** Does every sort / filter entry of `content` have a column in a grid with these fields? */
export function viewFitsFields(content: ListViewContent, fields: readonly string[]): boolean {
	const known = new Set(fields);
	return (
		content.sort.every((entry) => known.has(entry.field)) &&
		content.filters.every((entry) => known.has(entry.field))
	);
}

/** The ids of the columns a definition pins to the left (`pinned: 'left'`, #713). */
export function definitionPinned(
	columns: readonly { id: string; pinned?: string | undefined }[]
): string[] {
	return columns.filter((column) => column.pinned === 'left').map((column) => column.id);
}

/**
 * The part of `content` a grid with these columns can show: sort / filter
 * entries on a field the grid has no column for are dropped (the server
 * rejects an unknown filter field, the client grid would match nothing), and
 * so are pinned ids of columns it does not have.
 *
 * `defaultPinned` (the grid's {@link definitionPinned}) stands in when the
 * view has no `pinned` - a definition view, or one saved before pinning
 * (#713) - so the result always says which columns are pinned. Without it a
 * missing `pinned` stays missing.
 */
export function viewForFields(
	content: ListViewContent,
	fields: readonly string[],
	defaultPinned?: readonly string[]
): ListViewContent {
	const known = new Set(fields);
	const pinned = content.pinned ?? defaultPinned;
	return {
		sort: content.sort.filter((entry) => known.has(entry.field)),
		filters: content.filters.filter((entry) => known.has(entry.field)),
		search: content.search,
		...(pinned ? { pinned: [...new Set(pinned)].filter((id) => known.has(id)) } : {})
	};
}

/** Pinned ids as a comparable value: a set (order and repeats do not matter). */
function pinnedKey(pinned: readonly string[] | undefined): string {
	return pinned ? JSON.stringify([...new Set(pinned)].sort()) : 'none';
}

/**
 * Does the list currently show exactly this view (search compared trimmed,
 * pinned ids as a set)? Give both sides a `pinned` first
 * ({@link viewForFields} with `defaultPinned`): a missing one only equals
 * another missing one.
 */
export function sameViewContent(a: ListViewContent, b: ListViewContent): boolean {
	return (
		JSON.stringify(a.sort) === JSON.stringify(b.sort) &&
		JSON.stringify(a.filters) === JSON.stringify(b.filters) &&
		a.search.trim() === b.search.trim() &&
		pinnedKey(a.pinned) === pinnedKey(b.pinned)
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
		// Missing in a view saved before pinning (#713).
		(candidate.pinned === undefined ||
			(Array.isArray(candidate.pinned) &&
				candidate.pinned.every((id) => typeof id === 'string'))) &&
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
			search: entry.search,
			...(entry.pinned ? { pinned: [...new Set(entry.pinned)] } : {})
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
		search: content.search.trim(),
		...(content.pinned ? { pinned: [...content.pinned] } : {})
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
