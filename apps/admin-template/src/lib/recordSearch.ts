/**
 * Records in the command palette (#711, 洗練案 B-5): the "search <resource>"
 * sources (`PaletteSource`, admin-core) and the recently opened records shown
 * for an empty query. Palette-only (scaffold removes it with the palette);
 * the recents are written by `ResourceDetail` through
 * `#lib/resource/recentRecords.ts`.
 *
 * Which resources may be offered follows the sidebar: the resource must be
 * listable (`capabilities.list`) and its nav entry visible to this session
 * (`navSections()`, the same function the sidebar, the dock and the palette's
 * page commands use), so a LAN viewer-public session and a role that cannot
 * open the page never see its records. A resource without a nav entry is not
 * offered to a viewer-public session (the allowlist lives on nav entries).
 * This only decides what is SHOWN: the data calls still pass the server's
 * guard (conventions §1).
 *
 * Opening a record goes to the list page with `?id=` - the right-hand drawer
 * of #591 (a narrow screen is redirected to the detail page by the list).
 */
import { goto } from '$app/navigation';
import * as m from '#lib/paraglide/messages.js';
import {
	currentSessionScope,
	getDataProvider,
	isCurrentSessionScope,
	type PaletteCommand,
	type PaletteSource
} from '@banto/admin-core';
import { resources } from './banto/resources';
import { isNavItemVisible } from './commands';
import { navItems, resolveAppPath } from './navigation';
import { loadRecentRecords, type RecentRecord } from './resource/recentRecords';
import { recordTitle } from './resource/recordTitle';
import type { AppResourceDefinition, ResourceRow } from './resource/types';
import { sessionStore } from './session.svelte';

/** Can the current session look at this resource's records? */
export function isResourceReadable(definition: AppResourceDefinition): boolean {
	if (definition.capabilities?.list !== true) return false;
	const item = navItems.find((entry) => entry.path === definition.path);
	return item ? isNavItemVisible(item) : !sessionStore.publicViewer;
}

function recordCommand(
	definition: AppResourceDefinition,
	record: { id: string | number; title: string },
	group: () => string
): PaletteCommand {
	return {
		id: `record.${definition.name}.${record.id}`,
		title: record.title,
		get group() {
			return group();
		},
		// Evaluated per call: a recent record of a resource this session may no longer read drops out.
		visible: () => isResourceReadable(definition),
		run: () => {
			void goto(`${resolveAppPath(definition.path)}?id=${encodeURIComponent(String(record.id))}`);
		}
	};
}

/** One "search <resource>" source per resource (recomputed per call: zero resources yields zero sources). */
export function recordSources(): PaletteSource[] {
	return resources.map((definition) => ({
		id: `records.${definition.name}`,
		group: () => definition.label,
		visible: () => isResourceReadable(definition),
		async search(query, signal) {
			const scope = currentSessionScope();
			const result = await getDataProvider().getList<ResourceRow>(definition.name, {
				pagination: { offset: 0, limit: 5 },
				sort: [],
				filters: [],
				search: query
			});
			// The provider takes no signal: a superseded or session-crossing answer is dropped here (the runner drops stale ones too).
			if (signal.aborted || !isCurrentSessionScope(scope)) return [];
			return result.rows.map((row) =>
				recordCommand(
					definition,
					{ id: row.id, title: recordTitle(definition, row) },
					() => definition.label
				)
			);
		}
	}));
}

/** The records this user opened last (most recent first) as palette commands, for the empty query. */
export function recentRecordCommands(): PaletteCommand[] {
	const byName = new Map(resources.map((definition) => [definition.name, definition]));
	return loadRecentRecords(currentSessionScope()).flatMap((entry: RecentRecord) => {
		const definition = byName.get(entry.resource);
		if (!definition) return [];
		return [recordCommand(definition, entry, () => m['commandPalette.groupRecentRecords']())];
	});
}
